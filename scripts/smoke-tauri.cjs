// Run against an already-built binary: npm run smoke:desktop -- --binary <exe>
// Add --conflict-close to repeat shutdown with an unanswered restore dialog.
// Add --watcher for a separate automatic-backup and restore/rebind instance.
// Fixtures, logs and summary.json are retained under dist/native-smoke-*.
/* global window, document, innerWidth, innerHeight, KeyboardEvent, MouseEvent */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const GAME_ID = '999999990';
const ORIGINAL_SAVE = 'OpenGameSave isolated native smoke save\n';
const sleep = milliseconds => new Promise(resolve => { setTimeout(resolve, milliseconds); });

function inside(root, candidate) {
    const normalized = candidate.replace(/^\\\\\?\\/, '');
    const relative = path.relative(root, path.resolve(normalized));
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `Path escaped fixture: ${candidate}`);
    return candidate;
}

function createFixture() {
    const dist = path.join(ROOT, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    assert.equal(fs.realpathSync.native(dist).toLowerCase(), dist.toLowerCase(), 'dist must not redirect outside the workspace');
    const root = fs.mkdtempSync(path.join(dist, 'native-smoke-'));
    const appData = inside(root, path.join(root, 'appdata'));
    const games = inside(root, path.join(root, 'games'));
    const save = inside(root, path.join(games, 'Smoke Game', 'save', 'slot.dat'));
    const backups = inside(root, path.join(root, 'backups'));
    const exports = inside(root, path.join(root, 'exports'));
    const databasePath = inside(root, path.join(appData, 'OGS Database', 'database.db'));
    const settingsPath = inside(root, path.join(appData, 'OGS Settings', 'settings.json'));
    for (const directory of [path.dirname(save), path.dirname(databasePath), path.dirname(settingsPath), backups, exports]) {
        fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(save, ORIGINAL_SAVE);
    const database = new Database(databasePath);
    try {
        database.exec(`
            CREATE TABLE games (
                wiki_page_id INTEGER PRIMARY KEY, title TEXT NOT NULL, zh_CN TEXT,
                install_folder TEXT, steam_id INTEGER, gog_id INTEGER,
                platform TEXT, save_location TEXT NOT NULL
            );
            CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
            INSERT INTO metadata VALUES ('database_variant', 'standard');
            PRAGMA user_version = 1;
        `);
        database.prepare('INSERT INTO games VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)').run(
            Number(GAME_ID), 'Tauri Smoke Game', 'Tauri Smoke Game', 'Smoke Game',
            JSON.stringify(['Steam']), JSON.stringify({ win: ['{{p|game}}/save'] })
        );
    } finally {
        database.close();
    }
    fs.writeFileSync(settingsPath, JSON.stringify({
        language: 'en_US', backupPath: backups, exportPath: exports, gameInstalls: [games],
        maxBackups: 5, autoAppUpdate: false, autoDbUpdate: false, appUpdatePrerelease: false,
        launchAtStartup: false, syncAccentColor: false, autoBackupGames: {},
        firstLaunchFullScanTipShown: true, saveUninstalledGames: false,
        pinnedGames: [], blockedGames: [], uninstalledGames: [],
        visibleSidebarItems: ['library', 'guides', 'backup', 'sync']
    }, null, 2));
    return { root, appData, games, save, backups, exports };
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); });
    return port;
}

async function deadline(promise, milliseconds, label) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds); })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function diagnosticPageUrl(page) {
    try {
        const url = new URL(page.url);
        // Never include URL credentials, search parameters or fragments.
        return `${url.origin === 'null' ? url.protocol : url.origin}${url.pathname}`.slice(0, 180);
    } catch { return '<unknown page>'; }
}

function expressionSummary(fn) {
    // Summarize only the function's structure. Invocation arguments and literal
    // strings can contain settings or credentials and must never enter logs.
    return fn.toString()
        .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '"<literal>"')
        .replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '')
        .replace(/\s+/g, ' ').trim().slice(0, 160);
}

class Cdp {
    constructor(page) {
        this.page = page;
        this.socket = new WebSocket(page.webSocketDebuggerUrl);
        this.pending = new Map();
        this.sequence = 0;
        this.opened = new Promise((resolve, reject) => {
            this.socket.addEventListener('open', resolve, { once: true });
            this.socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
        });
        this.socket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            const request = this.pending.get(message.id);
            if (!request) return;
            this.pending.delete(message.id);
            if (message.error) request.reject(new Error(message.error.message));
            else request.resolve(message.result);
        });
        this.socket.addEventListener('close', () => {
            for (const request of this.pending.values()) request.reject(new Error('CDP target closed'));
            this.pending.clear();
        });
    }

    async call(method, params, timeout = 10000, summary = '') {
        const id = ++this.sequence;
        const context = `${method} page=${diagnosticPageUrl(this.page)}${summary ? ` expression=${summary}` : ''}`;
        try {
            await deadline(this.opened, timeout, 'CDP connection');
            const response = new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
            this.socket.send(JSON.stringify({ id, method, params }));
            return await deadline(response, timeout, method);
        } catch (error) {
            throw new Error(`${context}: ${error.message}`, { cause: error });
        } finally {
            this.pending.delete(id);
        }
    }

    async evaluate(fn, args = [], timeout = 10000, summary = expressionSummary(fn)) {
        const result = await this.call('Runtime.evaluate', {
            expression: `(${fn.toString()})(...${JSON.stringify(args)})`,
            awaitPromise: true, returnByValue: true, userGesture: true
        }, timeout, summary);
        if (result.exceptionDetails) {
            const message = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
            throw new Error(`Runtime.evaluate page=${diagnosticPageUrl(this.page)} expression=${summary}: ${message}`);
        }
        return result.result?.value;
    }

    api(direction, channel, args = [], timeout = 10000) {
        const summary = ['send', 'invoke'].includes(direction) && /^[a-z0-9-]{1,80}$/.test(channel)
            ? `window.api.${direction}(${channel}; ${args.length} arguments)` : 'window.api operation';
        return this.evaluate((direction, channel, args) => window.api[direction](channel, ...args), [direction, channel, args], timeout, summary);
    }

    close() {
        this.socket.close();
    }
}

class SmokeRun {
    constructor(binary, fixture, mode) {
        this.binary = binary;
        this.fixture = fixture;
        this.clients = [];
        this.report = { mode, fixture: fixture.root, binary, startedAt: new Date().toISOString(), passed: false, steps: [] };
    }

    async step(name, run, timeout = 30000) {
        const started = performance.now();
        const item = { name, passed: false };
        this.report.steps.push(item);
        try {
            item.detail = await deadline(Promise.resolve().then(run), timeout, name);
            item.passed = true;
            return item.detail;
        } catch (error) {
            item.error = String(error.stack || error);
            throw error;
        } finally {
            item.durationMs = Math.round((performance.now() - started) * 100) / 100;
            console.log(`${item.passed ? 'PASS' : 'FAIL'} ${name}: ${item.durationMs} ms`);
        }
    }

    async launch({ useDefaultData = false, verifyFixture = true, electron = false } = {}) {
        this.port = await freePort();
        this.report.port = this.port;
        const log = fs.openSync(path.join(this.fixture.root, 'native.log'), 'a');
        try {
            const args = electron ? [`--remote-debugging-port=${this.port}`, '--remote-debugging-address=127.0.0.1'] : [];
            this.child = spawn(this.binary, args, {
                cwd: this.fixture.root, windowsHide: true, stdio: ['ignore', log, log],
                env: {
                    ...process.env,
                    OGS_DATA_DIR: useDefaultData ? undefined : this.fixture.appData,
                    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${this.port} --remote-debugging-address=127.0.0.1`
                }
            });
        } finally {
            fs.closeSync(log);
        }
        this.report.pid = this.child.pid;
        this.exited = new Promise(resolve => {
            this.child.once('error', error => { this.exit = { error: error.message }; resolve(this.exit); });
            this.child.once('exit', (code, signal) => { this.exit = { code, signal }; resolve(this.exit); });
        });
        this.onInterrupt = () => this.stopOwnProcess();
        process.once('SIGINT', this.onInterrupt);
        process.once('SIGTERM', this.onInterrupt);
        const page = await this.poll('main WebView', async () => (await this.pages()).find(page => this.isPage(page, 'index.html')), 30000);
        this.main = this.connect(page);
        await this.waitForApi(this.main);
        const settings = await this.main.api('invoke', 'get-settings');
        if (verifyFixture) {
            assert.equal(settings.backupPath, this.fixture.backups, 'The fixture settings must be selected before any save operation');
            assert.deepEqual(settings.gameInstalls, [this.fixture.games]);
            assert.equal(settings.autoAppUpdate, false);
            assert.equal(settings.autoDbUpdate, false);
            assert.deepEqual(settings.autoBackupGames, {});
        }
        if (!electron) assert.ok(fs.existsSync(path.join(this.fixture.appData, 'WebView2')), 'WebView2 profile must also be isolated');
        return { pid: this.child.pid, port: this.port, isolatedSettings: true, isolatedWebView: true };
    }

    isPage(page, file) {
        try {
            const url = new URL(page.url);
            return page.type === 'page' && url.hostname === 'tauri.localhost'
                && (url.pathname === `/${file}` || (file === 'index.html' && url.pathname === '/'));
        } catch { return false; }
    }

    async pages() {
        const response = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(2000) });
        if (!response.ok) throw new Error(`CDP page list returned ${response.status}`);
        return await response.json();
    }

    connect(page) {
        const client = new Cdp(page);
        this.clients.push(client);
        return client;
    }

    async poll(label, query, timeout = 10000) {
        const start = performance.now();
        let lastError;
        while (performance.now() - start < timeout) {
            if (this.exit) throw new Error(`Application exited during ${label}: ${JSON.stringify(this.exit)}`);
            try {
                const value = await query();
                if (value) return value;
            } catch (error) { lastError = error; }
            await sleep(100);
        }
        throw new Error(`${label} timed out after ${timeout} ms${lastError ? `: ${lastError.message}` : ''}`);
    }

    waitForApi(client) {
        return this.poll('renderer API ready', () => client.evaluate(() => !!window.api && document.readyState === 'complete'));
    }

    async newPage(file, previous = new Set()) {
        const page = await this.poll(`${file} creation`, async () => (await this.pages()).find(page => !previous.has(page.id) && this.isPage(page, file)));
        const client = this.connect(page);
        await this.waitForApi(client);
        return client;
    }

    async gone(client) {
        await this.poll(`${client.page.id} close`, async () => !(await this.pages()).some(page => page.id === client.page.id));
        client.close();
    }

    async assertAuthorization(client) {
        const result = await client.evaluate(async id => {
            const can = window.api.can('invoke', 'backup-game');
            try {
                await window.__TAURI_INTERNALS__.invoke('dispatch', { channel: 'backup-game', direction: 'invoke', args: [{ wiki_page_id: id }] });
                return { can, denied: false };
            } catch (error) { return { can, denied: true, reason: String(error) }; }
        }, [GAME_ID]);
        assert.equal(result.can, false, 'the renderer role should reject a main-window command');
        assert.equal(result.denied, true, 'Rust must independently reject the forged main-window command');
        assert.match(result.reason, /denied for this window/i);
        return result;
    }

    async closeNormally() {
        await this.main.evaluate(() => {
            const button = document.getElementById('window-close');
            if (!button) throw new Error('Missing native close control');
            setTimeout(() => button.click(), 0);
            return true;
        });
        const exit = await deadline(this.exited, 10000, 'normal application shutdown');
        assert.equal(exit.code, 0, `Application failed to shut down normally: ${JSON.stringify(exit)}`);
        return exit;
    }

    stopOwnProcess() {
        if (this.child?.pid && !this.exit) {
            this.report.forcedCleanup = true;
            // Never terminate a process by image name, a discovered CDP PID,
            // or a process tree: this is only the ChildProcess we spawned.
            this.child.kill();
        }
    }

    async finish(error) {
        if (error) this.report.error = String(error.stack || error);
        for (const client of this.clients) client.close();
        this.stopOwnProcess();
        if (this.child) await deadline(this.exited, 10000, 'own-process cleanup').catch(cleanupError => { this.report.cleanupError = cleanupError.message; });
        if (this.onInterrupt) {
            process.removeListener('SIGINT', this.onInterrupt);
            process.removeListener('SIGTERM', this.onInterrupt);
        }
        this.report.finishedAt = new Date().toISOString();
        this.report.exit = this.exit;
        fs.writeFileSync(path.join(this.fixture.root, 'summary.json'), JSON.stringify(this.report, null, 2));
        console.log(`Report: ${path.join(this.fixture.root, 'summary.json')}`);
    }
}

async function backupFixture(run) {
    const view = await run.main.api('invoke', 'get-table-view-model', ['backup'], 30000);
    assert.equal(view.games.length, 1, 'the fixture database must be the only save definition');
    const game = view.games.find(game => String(game.wiki_page_id) === GAME_ID);
    assert.ok(game, 'the fixture game must be detected');
    assert.equal(game.title, 'Tauri Smoke Game');
    assert.ok(game.resolved_paths.length > 0);
    for (const item of game.resolved_paths) inside(run.fixture.root, item.resolved);
    const result = await run.main.api('invoke', 'backup-game', [game], 30000);
    assert.equal(result, null, `Backup failed: ${result}`);
    const restored = await run.main.api('invoke', 'fetch-restore-table-data', [GAME_ID]);
    assert.equal(restored.length, 1);
    assert.equal(restored[0].backups.length, 1);
    run.snapshot = restored[0];
    const snapshot = inside(run.fixture.root, path.join(run.fixture.backups, GAME_ID, run.snapshot.backups[0].date));
    const metadata = JSON.parse(fs.readFileSync(path.join(snapshot, 'backup_info.json'), 'utf8'));
    assert.equal(metadata.title, 'Tauri Smoke Game');
    assert.ok(metadata.backup_paths.every(item => item.template === '{{p|game}}/save'));
    assert.equal(fs.readFileSync(path.join(snapshot, metadata.backup_paths[0].folder_name, 'slot.dat'), 'utf8'), ORIGINAL_SAVE);
    return { gameId: GAME_ID, resolvedPaths: game.resolved_paths.length, snapshots: 1, fixtureBytesVerified: true };
}

async function menus(run) {
    let menu;
    let previousRequestId = '';
    const assertReused = async () => {
        const pages = (await run.pages()).filter(page => run.isPage(page, 'menu.html'));
        assert.equal(pages.length, 1, 'all popup menus must share exactly one independent native WebView');
        assert.equal(pages[0].id, menu.page.id, 'menu hide/show must retain the prewarmed WebView');
    };
    const waitUntilHidden = async () => {
        await run.poll('reused menu hidden', () => menu.evaluate(async () => !await window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', {
            label: window.__TAURI_INTERNALS__.metadata.currentWindow.label
        })));
        await assertReused();
    };
    const escape = async () => {
        await menu.evaluate(() => {
            document.getElementById('menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return true;
        });
        await waitUntilHidden();
    };
    const waitUntilVisible = async (count, started) => {
        const state = await run.poll('new payload fully displayed in the reused native menu', async () => {
            const state = await menu.evaluate(async (count, previousRequestId) => {
                const root = document.getElementById('menu');
                const items = [...document.querySelectorAll('button[role="menuitem"]')];
                const requestId = root.dataset.requestId;
                if (!requestId || requestId === previousRequestId || items.length !== count) return null;
                const visible = await window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', {
                    label: window.__TAURI_INTERNALS__.metadata.currentWindow.label
                });
                // Native visibility, the new payload, and focus acknowledgement are
                // all required: hidden WebViews can keep their DOM marked visible.
                if (!visible || document.activeElement !== items.find(item => !item.disabled)) return null;
                // Measure final layout, not the opening animation's scaled bounds.
                if (root.getAnimations().some(animation => animation.playState === 'running')) return null;
                const bounds = root.getBoundingClientRect();
                const style = window.getComputedStyle(root);
                const bodyStyle = window.getComputedStyle(document.body);
                const verticalBorder = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
                const verticalInset = parseFloat(bodyStyle.paddingTop) + parseFloat(bodyStyle.paddingBottom);
                const requiredWindowHeight = root.scrollHeight + verticalBorder + verticalInset + 2;
                const availableScreenHeight = window.screen.availHeight;
                const allItemsVisible = root.scrollHeight <= root.clientHeight + 1 && items.every(item => {
                    const itemBounds = item.getBoundingClientRect();
                    return itemBounds.top >= bounds.top - 1 && itemBounds.bottom <= bounds.bottom + 1;
                });
                return {
                    requestId, width: bounds.width, height: bounds.height, windowWidth: innerWidth, windowHeight: innerHeight,
                    role: root.getAttribute('role'), disabled: items.map(item => item.disabled),
                    labels: items.map(item => item.textContent.trim()),
                    requiredWindowHeight, availableScreenHeight, allItemsVisible,
                    contentHeight: root.scrollHeight, visibleContentHeight: root.clientHeight,
                    maxHeight: style.maxHeight
                };
            }, [count, previousRequestId]);
            if (state && state.availableScreenHeight >= state.requiredWindowHeight
                && (!state.allItemsVisible || state.windowHeight + 1 < state.requiredWindowHeight)) {
                // Native resize delivery may lag its acknowledgement. Allow it
                // to settle within the ordinary timeout, but never accept a
                // permanently short scroller merely because six buttons exist.
                throw new Error(`Menu is clipped despite sufficient monitor space: ${JSON.stringify(state)}`);
            }
            return state;
        });
        state.displayMs = Math.round((performance.now() - started) * 100) / 100;
        previousRequestId = state.requestId;
        assert.equal(state.role, 'menu');
        assert.ok(state.width >= 180 && state.width <= 400 && state.height > 0);
        assert.ok(state.windowWidth >= state.width && state.windowHeight >= state.height);
        if (state.availableScreenHeight >= state.requiredWindowHeight) assert.equal(state.allItemsVisible, true);
        await assertReused();
        return state;
    };

    await run.step('one independent native menu WebView is prewarmed and hidden', async () => {
        menu = await run.newPage('menu.html');
        assert.notEqual(menu.page.id, run.main.page.id);
        assert.equal(await menu.evaluate(() => window.__TAURI_INTERNALS__.metadata.currentWindow.label), 'menu-popup');
        await waitUntilHidden();
        return { targetId: menu.page.id, hidden: true, reused: true };
    });
    for (let index = 0; index < 5; index++) {
        await run.step(`reused native menu open/size/disabled/Escape ${index + 1}`, async () => {
            const started = performance.now();
            await run.main.api('send', 'show-popup-menu', [{
                items: [{ label: 'Smoke enabled', action: 'smoke-noop' }, { label: 'Smoke disabled', action: 'smoke-disabled', disabled: true }],
                direction: 'down', x: 150, y: 90, rendererRequestId: `smoke-${index}`
            }]);
            const state = await waitUntilVisible(2, started);
            assert.deepEqual(state.disabled, [false, true]);
            await escape();
            assert.equal(typeof await run.main.api('invoke', 'get-status'), 'object');
            return state;
        });
    }
    for (const [name, count] of [['view', 6], ['games', 4]]) {
        await run.step(`the ${name} titlebar dropdown reuses the native menu`, async () => {
            const started = performance.now();
            await run.main.evaluate(name => document.querySelector(`[data-titlebar-menu="${name}"]`).click(), [name]);
            const state = await waitUntilVisible(count, started);
            await escape();
            const trigger = await run.poll('focus restored to titlebar trigger', () => run.main.evaluate(name => {
                const button = document.querySelector(`[data-titlebar-menu="${name}"]`);
                const expanded = button.getAttribute('aria-expanded');
                const focused = document.activeElement === button;
                return expanded === 'false' && focused ? { expanded, focused } : null;
            }, [name]));
            assert.equal(trigger.expanded, 'false');
            assert.equal(trigger.focused, true, 'Escape must restore focus to the titlebar trigger');
            return state;
        });
    }
    await run.step('the Help dropdown opens Settings through a real menu action', async () => {
        const started = performance.now();
        await run.main.evaluate(() => document.querySelector('[data-titlebar-menu="help"]').click());
        const state = await waitUntilVisible(2, started);
        await menu.evaluate(() => {
            setTimeout(() => document.querySelector('button[role="menuitem"]').click(), 0);
            return true;
        });
        const settings = await run.newPage('settings.html');
        await run.assertAuthorization(settings);
        await settings.evaluate(() => {
            setTimeout(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', {
                label: window.__TAURI_INTERNALS__.metadata.currentWindow.label
            }), 0);
            return true;
        });
        await run.gone(settings);
        await waitUntilHidden();
        return { ...state, actionDelivered: true, settingsOpened: true };
    });
    await run.step('save list right-click and more actions reuse the same independent native menu', async () => {
        await run.main.evaluate(() => document.getElementById('saves-tab').click());
        await run.poll('fixture save row displayed', () => run.main.evaluate(id => {
            const row = document.querySelector(`#backup tr[data-wiki-id="${id}"]`);
            return row?.querySelector('.dropdown-menu-button') && row.getBoundingClientRect().height > 0;
        }, [GAME_ID]));
        const timings = [];
        for (const interaction of ['contextmenu', 'click']) {
            const started = performance.now();
            await run.main.evaluate((id, interaction) => {
                const row = document.querySelector(`#backup tr[data-wiki-id="${id}"]`);
                const button = row.querySelector('.dropdown-menu-button');
                if (interaction === 'click') button.click();
                else {
                    const bounds = row.getBoundingClientRect();
                    const cancelled = !row.dispatchEvent(new MouseEvent('contextmenu', {
                        bubbles: true, cancelable: true, button: 2,
                        clientX: bounds.left + 40, clientY: bounds.top + bounds.height / 2
                    }));
                    if (!cancelled) throw new Error('The save row did not handle its context menu');
                }
                return true;
            }, [GAME_ID, interaction]);
            const state = await waitUntilVisible(6, started);
            assert.ok(state.disabled.every(disabled => !disabled));
            timings.push({ interaction, displayMs: state.displayMs });
            await escape();
        }
        return { targetId: menu.page.id, timings, allMenusReused: true };
    });
}

async function auxiliaryWindows(run) {
    await run.step('settings authorization and close', async () => {
        await run.main.api('send', 'open-settings-window');
        const settings = await run.newPage('settings.html');
        const permission = await run.assertAuthorization(settings);
        await settings.evaluate(() => {
            setTimeout(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', {
                label: window.__TAURI_INTERNALS__.metadata.currentWindow.label
            }), 0);
            return true;
        });
        await run.gone(settings);
        return permission;
    });
    await run.step('dialog authorization and response', async () => {
        await run.main.evaluate(() => {
            window.__smokeDialog = { done: false };
            window.api.invoke('show-dialog-modal-window', { title: 'Smoke dialog', content: 'Isolated native smoke',
                buttons: [{ value: false, text: 'Cancel' }, { value: true, text: 'Accept', primary: true }], closeValue: false
            }).then(value => { window.__smokeDialog = { done: true, value }; }, error => { window.__smokeDialog = { done: true, error: String(error) }; });
            return true;
        });
        const dialog = await run.newPage('modal.html');
        const permission = await run.assertAuthorization(dialog);
        await run.poll('dialog actions ready', () => dialog.evaluate(() => document.querySelectorAll('.modal-dialog-action').length === 2));
        await dialog.evaluate(() => { setTimeout(() => document.querySelector('.modal-dialog-action').click(), 0); return true; });
        await run.gone(dialog);
        const response = await run.poll('dialog response', () => run.main.evaluate(() => window.__smokeDialog?.done && window.__smokeDialog));
        assert.equal(response.error, undefined);
        assert.equal(response.value.value, false);
        return permission;
    });
    await run.step('export UI creates a legacy archive with numeric count', async () => {
        await run.main.api('send', 'open-modal-window', ['export']);
        const modal = await run.newPage('modal.html');
        await run.poll('export form ready', () => modal.evaluate(() => !!document.getElementById('modal-export-confirm')));
        await modal.evaluate(() => {
            document.getElementById('modal-export-count').value = '1';
            setTimeout(() => document.getElementById('modal-export-confirm').click(), 0);
            return true;
        });
        await run.gone(modal);
        const archives = fs.readdirSync(run.fixture.exports).filter(name => name.endsWith('.gsmr'));
        assert.equal(archives.length, 1, 'export UI must produce exactly one archive');
        const archive = fs.readFileSync(inside(run.fixture.root, path.join(run.fixture.exports, archives[0])));
        assert.equal(archive.subarray(0, 6).toString('hex'), '377abcaf271c', 'legacy export must retain the 7z signature');
        return { archive: archives[0], bytes: archive.length };
    });
}

async function automaticBackups(run) {
    let modal;
    await run.step('interval backup starts with an integer setting and stops', async () => {
        await run.main.api('send', 'open-modal-window', ['auto-backup', { wikiId: GAME_ID }]);
        modal = await run.newPage('modal.html');
        await run.poll('automatic backup controls ready', () => modal.evaluate(() => !!document.getElementById('modal-auto-backup-confirm')));
        const context = await modal.api('invoke', 'get-modal-window-data');
        assert.equal(context.modalType, 'auto-backup');
        assert.equal(context.wikiId, GAME_ID);
        assert.equal(await modal.api('invoke', 'start-auto-backup', [GAME_ID, 'interval', 1]), null);
        const state = await run.main.api('invoke', 'get-auto-backup-state');
        assert.equal(state[GAME_ID].mode, 'interval');
        assert.equal(state[GAME_ID].intervalMinutes, 1);
        const settings = JSON.parse(fs.readFileSync(inside(run.fixture.root, path.join(run.fixture.appData, 'OGS Settings', 'settings.json')), 'utf8'));
        assert.equal(settings.autoBackupGames[GAME_ID].intervalMinutes, 1, 'a valid integer interval must persist successfully');
        const logs = await modal.api('invoke', 'stop-auto-backup', [GAME_ID]);
        assert.ok(Array.isArray(logs));
        const stopped = await run.main.api('invoke', 'get-auto-backup-state');
        assert.equal(stopped[GAME_ID], undefined);
        return { intervalMinutes: 1, persisted: true, stopped: true };
    });
    await run.step('watcher starts through the authorized automatic-backup window', async () => {
        assert.equal(await modal.api('invoke', 'start-auto-backup', [GAME_ID, 'watcher', null]), null);
        const state = await run.main.api('invoke', 'get-auto-backup-state');
        assert.equal(state[GAME_ID].mode, 'watcher');
        await modal.evaluate(() => {
            setTimeout(() => window.api.send('close-current-modal-window'), 0);
            return true;
        });
        await run.gone(modal);
        return { watcherActive: true, configurationWindowClosed: true };
    });
    await run.step('restore replaces the watched directory and rebinds the watcher', async () => {
        const result = await run.main.api('invoke', 'restore-game', [run.snapshot, 'replace'], 30000);
        assert.equal(result.error, null, `Restore failed: ${JSON.stringify(result)}`);
        assert.equal(fs.readFileSync(run.fixture.save, 'utf8'), ORIGINAL_SAVE);
        const state = await run.main.api('invoke', 'get-auto-backup-state');
        assert.equal(state[GAME_ID].mode, 'watcher', 'the watcher must remain active after replacing its watched directory');
        return { restoredBytesVerified: true, watcherStillActive: true };
    });
    await run.step('a write after directory replacement produces an automatic snapshot within ten seconds', async () => {
        const gameDirectory = inside(run.fixture.root, path.join(run.fixture.backups, GAME_ID));
        const before = new Set(fs.readdirSync(gameDirectory));
        const changed = `watcher after restore ${Date.now()}\n`;
        const started = performance.now();
        fs.writeFileSync(inside(run.fixture.root, run.fixture.save), changed);
        const created = await run.poll('automatic snapshot of the newly installed save directory', () => {
            for (const date of fs.readdirSync(gameDirectory)) {
                if (before.has(date) || !/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}(?:-\d{2})?$/.test(date)) continue;
                const snapshot = inside(run.fixture.root, path.join(gameDirectory, date));
                const infoPath = inside(run.fixture.root, path.join(snapshot, 'backup_info.json'));
                if (!fs.existsSync(infoPath)) continue;
                const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
                for (const entry of info.backup_paths) {
                    assert.match(entry.folder_name, /^path[1-9]\d*$/);
                    const slot = inside(run.fixture.root, path.join(snapshot, entry.folder_name, 'slot.dat'));
                    if (fs.existsSync(slot) && fs.readFileSync(slot, 'utf8') === changed) return date;
                }
            }
            return null;
        }, 10000);
        const elapsedMs = Math.round(performance.now() - started);
        const backups = await run.main.api('invoke', 'fetch-restore-table-data', [GAME_ID]);
        assert.ok(backups[0].backups.some(backup => backup.date === created));
        assert.ok(backups[0].backups.length > run.snapshot.backups.length);
        return { snapshot: created, elapsedMs, changedBytesVerified: true, snapshots: backups[0].backups.length };
    });
    await run.step('watcher stops, removes its persisted job and closes its window', async () => {
        await run.main.api('send', 'open-modal-window', ['auto-backup', { wikiId: GAME_ID }]);
        modal = await run.newPage('modal.html');
        await run.poll('automatic backup stop control ready', () => modal.evaluate(() => !!document.getElementById('modal-auto-backup-confirm')));
        const logs = await modal.api('invoke', 'stop-auto-backup', [GAME_ID]);
        assert.ok(Array.isArray(logs) && logs.some(log => log.success === true), 'the watcher must record a successful automatic backup');
        assert.ok(logs.every(log => log.success === true), 'the watcher must not log failed backups');
        const state = await run.main.api('invoke', 'get-auto-backup-state');
        assert.equal(state[GAME_ID], undefined);
        const settings = JSON.parse(fs.readFileSync(inside(run.fixture.root, path.join(run.fixture.appData, 'OGS Settings', 'settings.json')), 'utf8'));
        assert.equal(settings.autoBackupGames[GAME_ID], undefined);
        await modal.evaluate(() => {
            setTimeout(() => window.api.send('close-current-modal-window'), 0);
            return true;
        });
        await run.gone(modal);
        return { successfulBackups: logs.length, persistedJobRemoved: true, windowClosed: true };
    });
    await run.step('normal close after stopping automatic backups', () => run.closeNormally());
}

async function execute(binary, mode = 'standard') {
    const fixture = createFixture();
    const run = new SmokeRun(binary, fixture, mode);
    let failure;
    try {
        await run.step('isolated native startup', () => run.launch());
        await run.step('pure JavaScript CDP round-trip baseline ten sequential calls', async () => {
            const durations = [];
            for (let index = 0; index < 10; index++) {
                const started = performance.now();
                assert.equal(await run.main.evaluate(() => true), true);
                durations.push(Math.round((performance.now() - started) * 100) / 100);
            }
            return { measurement: 'Node to CDP to renderer round trip; no native IPC', samplesMs: durations, maxMs: Math.max(...durations) };
        });
        await run.step('get-status ten native IPC calls measured inside one renderer evaluation', async () => {
            const result = await run.main.evaluate(async () => {
                const durations = [];
                for (let index = 0; index < 10; index++) {
                    const started = window.performance.now();
                    let timer;
                    try {
                        const status = await Promise.race([
                            window.api.invoke('get-status'),
                            new Promise((_, reject) => {
                                timer = window.setTimeout(() => reject(new Error(`get-status IPC sample ${index + 1} timed out after 10000 ms`)), 10000);
                            })
                        ]);
                        if (!status || typeof status !== 'object' || status.backuping !== false) {
                            throw new Error(`Invalid isolated get-status response at sample ${index + 1}`);
                        }
                        durations.push(Math.round((window.performance.now() - started) * 100) / 100);
                    } finally {
                        window.clearTimeout(timer);
                    }
                }
                return { samplesMs: durations, maxMs: Math.max(...durations) };
            }, [], 30000, 'ten sequential window.api.invoke(get-status) calls; per-IPC timeout=10000ms');
            // Preserve the previous 10-second individual IPC limit and the
            // 30-second batch step limit while excluding ten CDP round trips.
            assert.equal(result.samplesMs.length, 10);
            return { measurement: 'Renderer performance.now around native IPC; excludes CDP round trip', ...result };
        });
        await run.step('isolated backup view and snapshot bytes', () => backupFixture(run));
        fs.writeFileSync(inside(fixture.root, fixture.save), 'newer isolated save\n');
        const future = new Date(Date.now() + 60000);
        fs.utimesSync(fixture.save, future, future);
        if (mode === 'watcher') {
            await automaticBackups(run);
        } else if (mode === 'conflict-close') {
            await run.step('pending restore conflict is cancelled by main-window shutdown', async () => {
                await run.main.evaluate(snapshot => {
                    window.__smokeRestore = window.api.invoke('restore-game', snapshot).catch(error => String(error));
                    return true;
                }, [run.snapshot]);
                const dialog = await run.newPage('modal.html');
                await run.poll('restore conflict dialog ready', () => dialog.evaluate(() => document.querySelectorAll('.modal-dialog-action').length === 2));
                const exit = await run.closeNormally();
                assert.equal(fs.readFileSync(fixture.save, 'utf8'), 'newer isolated save\n', 'unanswered restore must not overwrite the save');
                return { ...exit, unansweredConflictCancelled: true };
            });
        } else {
            await run.step('restore replaces only the fixture slot', async () => {
                const result = await run.main.api('invoke', 'restore-game', [run.snapshot, 'replace'], 30000);
                assert.equal(result.error, null, `Restore failed: ${JSON.stringify(result)}`);
                assert.equal(fs.readFileSync(fixture.save, 'utf8'), ORIGINAL_SAVE);
                return { restoredBytesVerified: true };
            });
            await run.step('installed library request returns without blocking the UI', async () => {
                const games = await run.main.api('invoke', 'get-library-games', [{ force: true }], 30000);
                assert.ok(Array.isArray(games));
                return { games: games.length };
            });
            await menus(run);
            await auxiliaryWindows(run);
            await run.step('normal main-window close', () => run.closeNormally());
        }
        run.report.passed = true;
    } catch (error) {
        failure = error;
    } finally {
        await run.finish(failure);
    }
    if (failure) throw failure;
    return run.report;
}

async function executeFresh(binary) {
    const fixture = createFixture();
    fs.renameSync(fixture.appData, inside(fixture.root, path.join(fixture.root, 'unused-seed-data')));
    const run = new SmokeRun(binary, fixture, 'fresh-profile');
    let failure;
    try {
        await run.step('first launch with an empty isolated profile', () => run.launch({ verifyFixture: false }));
        await run.step('default settings and packaged catalog initialized', async () => {
            const settings = await run.main.api('invoke', 'get-settings');
            assert.equal(settings.backupPath, path.join(fixture.root, 'OGS Backups'));
            assert.equal(settings.maxBackups, 5);
            assert.ok(['en_US', 'zh_CN'].includes(settings.language));
            assert.deepEqual(fs.readFileSync(path.join(fixture.appData, 'OGS Database', 'database.db')),
                fs.readFileSync(path.join(ROOT, 'database', 'database.db')));
            return { defaultBackupPath: settings.backupPath, bundledDatabaseBytesVerified: true };
        });
        await run.step('first-launch normal shutdown', () => run.closeNormally());
        run.report.passed = true;
    } catch (error) { failure = error; } finally { await run.finish(failure); }
    if (failure) throw failure;
}

async function main() {
    assert.equal(process.platform, 'win32', 'The desktop smoke test currently supports Windows only');
    const options = process.argv.slice(2);
    const binaryIndex = options.indexOf('--binary');
    assert.ok(options.every((value, index) => ['--binary', '--fresh', '--conflict-close', '--watcher'].includes(value) || index === binaryIndex + 1 && binaryIndex >= 0), 'Usage: node scripts/smoke-tauri.cjs [--binary path] [--fresh] [--conflict-close] [--watcher]');
    if (binaryIndex >= 0) assert.ok(options[binaryIndex + 1] && !options[binaryIndex + 1].startsWith('--'), '--binary requires an executable path');
    const binary = path.resolve(binaryIndex >= 0 ? options[binaryIndex + 1] : path.join(ROOT, 'src-tauri', 'target', 'debug', 'opengamesave.exe'));
    assert.ok(fs.statSync(binary).isFile(), `Build the native application before smoke testing: ${binary}`);
    if (options.includes('--fresh')) await executeFresh(binary);
    await execute(binary);
    if (options.includes('--conflict-close')) await execute(binary, 'conflict-close');
    if (options.includes('--watcher')) await execute(binary, 'watcher');
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.stack || error);
        process.exitCode = 1;
    });
}

module.exports = { SmokeRun, Cdp, createFixture, backupFixture, execute, GAME_ID, ORIGINAL_SAVE };
