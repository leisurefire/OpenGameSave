const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function readRenderer(name) {
    return fs.readFileSync(path.join(__dirname, '../src/renderer/js', name), 'utf8')
        .replace(/^import .*;\r?\n/gm, '');
}

function createElements() {
    const elements = new Map();
    return {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, {
                value: '',
                textContent: '',
                dataset: {},
                setAttribute() {},
                classList: { add() {}, remove() {}, toggle() {} }
            });
            return elements.get(id);
        }
    };
}

test('switching sync providers discards a late status response from the previous provider', async () => {
    const requests = [];
    const document = createElements();
    const context = vm.createContext({
        console,
        document,
        runWhenDomReady() {},
        window: {
            api: {
                receive() {},
                invoke(channel, provider) {
                    if (channel === 'get-settings') return Promise.resolve({ backupPath: 'saves' });
                    return new Promise(resolve => { requests.push({ provider, resolve }); });
                }
            },
            i18n: { translate: key => Promise.resolve(`${key}: `) }
        }
    });
    vm.runInContext(readRenderer('syncTab.js'), context);
    const first = vm.runInContext('refreshSyncStatus()', context);
    await new Promise(resolve => { setImmediate(resolve); });
    const second = vm.runInContext("activeProvider = 'webdav'; refreshSyncStatus()", context);
    await new Promise(resolve => { setImmediate(resolve); });
    assert.equal(requests[0].provider, 'github');
    assert.equal(requests[1].provider, 'webdav');
    requests[1].resolve({ ready: true, message: 'WebDAV ready', endpoint: 'https://dav.example', remotePath: '/saves' });
    await second;
    requests[0].resolve({ isGitRepo: false, hasRemote: false, message: 'GitHub unavailable' });
    await first;
    assert.equal(document.getElementById('sync-status-message').textContent, 'WebDAV ready');
    assert.equal(document.getElementById('sync-status-message').dataset.ready, 'true');
    assert.match(document.getElementById('sync-status-details').textContent, /https:\/\/dav\.example\/saves/);
});

test('guide selection ignores older requests and catalog refresh preserves non-catalog selections', async () => {
    const guideRequests = [];
    const catalogRequests = [];
    const document = createElements();
    const context = vm.createContext({
        document,
        console,
        window: {
            api: {
                invoke(channel, id) {
                    if (channel === 'get-settings') return Promise.resolve({ language: 'en_US' });
                    return new Promise(resolve => {
                        (channel === 'get-game-guide' ? guideRequests : catalogRequests).push({ id, resolve });
                    });
                }
            }
        }
    });
    vm.runInContext(readRenderer('guidesPage.js').replace(/initializeGuides\(\);\s*$/, ''), context);
    vm.runInContext(`
        renderHero = () => {};
        renderCategoryFilters = () => {};
        renderSources = () => {};
        hideSearchResults = () => {};
    `, context);
    const first = vm.runInContext('selectGuideByWikiId(1)', context);
    const second = vm.runInContext('selectGuideByWikiId(2)', context);
    guideRequests[1].resolve({ wiki_page_id: 2, title: 'Latest game' });
    await second;
    guideRequests[0].resolve({ wiki_page_id: 1, title: 'Old game' });
    await first;
    assert.equal(vm.runInContext('guideGame.wiki_page_id', context), 2);
    assert.equal(document.getElementById('guides-search').value, 'Latest game');

    const refresh = vm.runInContext('loadGuides()', context);
    catalogRequests[0].resolve({ games: [{ wiki_page_id: 3, title: 'Catalog default' }] });
    await refresh;
    assert.equal(vm.runInContext('guideGame.wiki_page_id', context), 2);

    const pending = vm.runInContext('selectGuideByWikiId(4)', context);
    vm.runInContext("selectGuideGame({ wiki_page_id: 5, title: 'Direct choice' })", context);
    guideRequests[2].resolve({ wiki_page_id: 4, title: 'Stale requested game' });
    await pending;
    assert.equal(vm.runInContext('guideGame.wiki_page_id', context), 5);

    vm.runInContext('guideGame = null', context);
    const oldCatalog = vm.runInContext('loadGuides()', context);
    const latestCatalog = vm.runInContext('loadGuides()', context);
    catalogRequests[2].resolve({ games: [{ wiki_page_id: 7, title: 'Current catalog' }] });
    await latestCatalog;
    catalogRequests[1].resolve({ games: [{ wiki_page_id: 7, title: 'Stale catalog' }] });
    await oldCatalog;
    assert.equal(vm.runInContext('guideGame.title', context), 'Current catalog');
});

test('sync locks controls before preflight and retains its selected provider and path', async () => {
    const calls = [];
    const preflightRequests = [];
    const document = createElements();
    document.querySelectorAll = () => [];
    document.getElementById('backup-path').value = 'original-saves';
    document.getElementById('cloud-sync').remove = () => {};
    const context = vm.createContext({
        console,
        document,
        runWhenDomReady() {},
        operationStartCheck: () => new Promise(resolve => { preflightRequests.push(resolve); }),
        showAlert() {},
        formatSize: String,
        window: {
            api: {
                receive() {},
                async invoke(...args) {
                    calls.push(args);
                    return { games: 1, size: 100 };
                }
            },
            i18n: { translate: key => Promise.resolve(key) }
        }
    });
    vm.runInContext(readRenderer('syncTab.js'), context);
    vm.runInContext('refreshSyncStatus = async () => {};', context);
    const first = vm.runInContext("runSync('upload')", context);
    assert.equal(document.getElementById('sync-download').disabled, true);
    assert.equal(document.getElementById('webdav-save').disabled, true);
    await vm.runInContext("runSync('download')", context);
    await vm.runInContext('saveWebDAVConfig()', context);
    await vm.runInContext("selectProvider('webdav')", context);
    assert.equal(preflightRequests.length, 1);
    assert.equal(vm.runInContext('activeProvider', context), 'github');
    assert.equal(calls.length, 0);

    vm.runInContext("activeProvider = 'webdav'", context);
    document.getElementById('backup-path').value = 'changed-saves';
    preflightRequests[0](true);
    await first;
    assert.deepEqual(calls, [['sync-provider-run', 'github', 'upload', 'original-saves']]);
    assert.equal(document.getElementById('sync-download').disabled, false);

    const denied = vm.runInContext("runSync('download')", context);
    preflightRequests[1](false);
    await denied;
    assert.equal(document.getElementById('sync-upload').disabled, false);
    assert.equal(calls.length, 1, 'a denied operation releases its lock without starting sync');
});

test('a sync provider chosen during initialization survives the late saved-settings response', async () => {
    for (const [savedProvider, chosenProvider] of [['github', 'webdav'], ['webdav', 'github']]) {
        const document = createElements();
        const getElementById = document.getElementById;
        document.getElementById = id => {
            const element = getElementById(id);
            element.listeners ||= new Map();
            element.attributes ||= new Map();
            element.addEventListener = (event, listener) => element.listeners.set(event, listener);
            element.setAttribute = (name, value) => element.attributes.set(name, value);
            return element;
        };
        const buttons = ['github', 'webdav'].map(provider => {
            const button = document.getElementById(`provider-${provider}`);
            button.dataset.syncProvider = provider;
            return button;
        });
        document.querySelectorAll = selector => selector === '[data-sync-provider]' ? buttons : [];
        let resolveInitialSettings;
        let settingsRequests = 0;
        const savedSelections = [];
        const context = vm.createContext({
            console,
            document,
            runWhenDomReady() {},
            window: {
                api: {
                    receive() {},
                    async invoke(channel, key, value) {
                        if (channel === 'sync-provider-list') return [{ id: 'github' }, { id: 'webdav' }];
                        if (channel === 'save-settings') savedSelections.push([key, value]);
                        if (channel === 'get-settings') {
                            settingsRequests += 1;
                            if (settingsRequests === 1) return new Promise(resolve => { resolveInitialSettings = resolve; });
                            return { syncProvider: chosenProvider, backupPath: 'saves' };
                        }
                        if (channel === 'sync-provider-config') return {};
                        return { ready: true, isGitRepo: true, hasRemote: true };
                    }
                },
                i18n: { translate: key => Promise.resolve(key) }
            }
        });
        vm.runInContext(readRenderer('syncTab.js'), context);
        const initialized = vm.runInContext('setupSyncTab()', context);
        await new Promise(resolve => { setImmediate(resolve); });
        const chosenButton = buttons.find(button => button.dataset.syncProvider === chosenProvider);
        await chosenButton.listeners.get('click')();
        resolveInitialSettings({ syncProvider: savedProvider, backupPath: 'saves' });
        await initialized;
        assert.equal(vm.runInContext('activeProvider', context), chosenProvider);
        assert.equal(chosenButton.attributes.get('aria-checked'), 'true');
        assert.deepEqual(savedSelections, [['syncProvider', chosenProvider]]);
    }
});
