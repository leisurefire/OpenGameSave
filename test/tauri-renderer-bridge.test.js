const assert = require('node:assert/strict');
const test = require('node:test');
const { createTauriBridge } = require('../src/renderer/tauriBridgeCore');
const { getRoleCapabilities } = require('../src/shared/ipcPolicy');
const fs = require('node:fs');
const path = require('node:path');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function harness({ role = 'main', subscription, context, dispatch } = {}) {
    const calls = [], errors = [], styles = [], lifecycle = new Map();
    let eventHandler, unlistened = 0;
    const targetWindow = {
        addEventListener: (name, callback) => lifecycle.set(name, callback),
        removeEventListener: name => lifecycle.delete(name)
    };
    const targetDocument = { documentElement: { style: { setProperty: (...args) => styles.push(args) } } };
    const bridge = createTauriBridge({
        targetWindow, targetDocument,
        reportError: (...args) => errors.push(args),
        invoke: async (command, args) => {
            calls.push({ command, args });
            if (command === 'get_window_context') return context ? context.promise : { role };
            if (command === 'dispatch') return dispatch ? dispatch(args) : '#123456';
        },
        listen: async (name, handler) => {
            assert.equal(name, 'ogs:event');
            eventHandler = handler;
            if (subscription) await subscription.promise;
            return () => { unlistened++; };
        }
    });
    return { bridge, targetWindow, calls, errors, styles, lifecycle,
        event: payload => eventHandler({ payload }), unlistened: () => unlistened };
}

test('the bridge awaits the native listener before exposing the role-scoped API', async () => {
    const subscription = deferred();
    const h = harness({ role: 'about', subscription });
    await new Promise(resolve => { setImmediate(resolve); });
    assert.equal(h.targetWindow.api, undefined);
    subscription.resolve();
    const api = await h.bridge.ready;
    assert.equal(api.can('invoke', 'open-url'), true);
    assert.equal(api.can('send', 'save-settings'), false);
    assert.equal(api.can('__proto__', 'get-settings'), false);
    assert.equal(api.can('constructor', 'get-settings'), false);
    assert.throws(() => api.invoke('delete-backup'), /Blocked IPC/);
    assert.throws(() => api.send('save-settings'), /Blocked IPC/);
    assert.throws(() => api.receive('update-backup-table', () => {}), /Blocked IPC/);
    await api.invoke('open-url', 'https://example.com');
    assert.deepEqual(h.calls.at(-1), { command: 'dispatch', args: {
        direction: 'invoke', channel: 'open-url', args: ['https://example.com']
    } });
    assert.equal(Object.isFrozen(api), true);
    assert.equal(Object.getOwnPropertyDescriptor(h.targetWindow, 'api').writable, false);
    h.bridge.dispose();
});

test('initial menu events wait for page handlers and readiness is acknowledged only once', async () => {
    const h = harness({ role: 'menu' });
    await h.bridge.ready;
    const received = [];
    h.event({ channel: 'set-menu-items', args: [{ requestId: 'first' }] });
    h.event({ channel: 'show-alert', args: ['forbidden'] });
    h.event({ channel: 'set-menu-items', args: 'malformed' });
    const unsubscribe = h.targetWindow.api.receive('set-menu-items', payload => received.push(payload));
    assert.deepEqual(received, []);
    await Promise.all([h.bridge.notifyReady(), h.bridge.notifyReady()]);
    assert.deepEqual(received, [{ requestId: 'first' }]);
    assert.equal(h.calls.filter(call => call.command === 'renderer_ready').length, 1);
    unsubscribe();
    unsubscribe();
    h.event({ channel: 'set-menu-items', args: [{ requestId: 'second' }] });
    assert.equal(received.length, 1);
    h.bridge.dispose();
});

test('closing during asynchronous subscription releases the eventual native listener', async () => {
    const subscription = deferred();
    const h = harness({ subscription });
    const closed = assert.rejects(h.bridge.ready, /Window closed/);
    await new Promise(resolve => { setImmediate(resolve); });
    h.lifecycle.get('pagehide')();
    subscription.resolve();
    await closed;
    assert.equal(h.unlistened(), 1);
    assert.equal(h.targetWindow.api, undefined);
    assert.equal(h.lifecycle.size, 0);
    h.bridge.dispose();
    assert.equal(h.unlistened(), 1);
});

test('unknown and inherited roles never get a channel API', async () => {
    for (const role of ['unknown', 'constructor', '__proto__', null]) {
        const h = harness({ role });
        await assert.rejects(h.bridge.ready, /valid window role/);
        assert.equal(h.targetWindow.api, undefined);
        assert.equal(h.calls.length, 1);
    }
});

test('a failing event subscriber does not prevent other subscribers and async sends are handled', async () => {
    const h = harness({ dispatch: async ({ channel }) => {
        if (channel === 'save-settings') throw new Error('disk full');
        return '#abcdef';
    } });
    await h.bridge.ready;
    await h.bridge.notifyReady();
    let calls = 0;
    h.targetWindow.api.receive('apply-language', () => { throw new Error('render failed'); });
    const callback = () => { calls++; };
    const removeFirst = h.targetWindow.api.receive('apply-language', callback);
    h.targetWindow.api.receive('apply-language', callback);
    removeFirst();
    h.event({ channel: 'apply-language', args: [] });
    assert.equal(calls, 1);
    h.targetWindow.api.send('save-settings', 'language', 'en_US');
    await new Promise(resolve => { setImmediate(resolve); });
    assert.equal(h.errors.length, 2);
    h.bridge.dispose();
    assert.equal(h.targetWindow.api.can('invoke', 'get-settings'), false);
    assert.throws(() => h.targetWindow.api.invoke('get-settings'), /disposed/);
    h.event({ channel: 'apply-language', args: [] });
    assert.equal(calls, 1);
    assert.equal(h.unlistened(), 1);
});

test('accent changes are validated and events during bootstrap supersede the initial lookup', async () => {
    const h = harness();
    await h.bridge.ready;
    h.event({ channel: 'accent-color-changed', args: ['#fedcba'] });
    h.event({ channel: 'accent-color-changed', args: ['red; background:url(x)'] });
    await h.bridge.notifyReady();
    assert.deepEqual(h.styles.at(-1), ['--system-accent', '#fedcba']);
    h.bridge.dispose();
});

test('page channel calls are covered by the shared Rust and renderer capability contract', () => {
    const pages = {
        main: ['backupTab', 'restoreTab', 'commonTabs', 'libraryPage', 'guidesPage', 'syncTab'],
        settings: ['settingsPage'], about: ['aboutPage']
    };
    for (const [role, modules] of Object.entries(pages)) {
        const capabilities = getRoleCapabilities(role);
        for (const name of modules) {
            const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js', `${name}.js`), 'utf8');
            for (const [, direction, channel] of source.matchAll(/window\.api\.(send|invoke|receive)\('([^']+)'/g)) {
                assert.ok(capabilities[direction].includes(channel), `${role}/${name} requires ${direction} ${channel}`);
            }
        }
    }
});

test('send exposes completion for modal actions while preserving ignored-return error handling', async () => {
    const operation = deferred();
    const h = harness({ role: 'import', dispatch: ({ channel }) => channel === 'import-backups' ? operation.promise : '#16c60c' });
    await h.bridge.ready;
    const sent = h.targetWindow.api.send('import-backups', 'C:\\saves.gsmr');
    let completed = false;
    sent.then(() => { completed = true; });
    await new Promise(resolve => { setImmediate(resolve); });
    assert.equal(completed, false);
    operation.resolve(true);
    assert.equal(await sent, true);
    assert.equal(completed, true);
    h.bridge.dispose();
});

test('bundled translations avoid IPC and switch language before event subscribers run', async () => {
    const context = { promise: Promise.resolve({ role: 'main', language: 'en_US' }) };
    const h = harness({ context });
    await h.bridge.ready;
    await h.bridge.notifyReady();
    const translate = h.targetWindow.i18n.translate;
    const requests = Array.from({ length: 200 }, () => translate('main.export'));
    assert.equal(requests[0], requests[199], 'repeated labels share one cached result');
    assert.ok((await Promise.all(requests)).every(label => label === 'Export'));
    assert.equal(await translate('main.library_game_count', { count: 2, total: 3 }), 'Showing 2 of 3 games');
    assert.equal(await translate('main.guide_for_game_title', { game: '$&' }), 'Trusted references for $&');
    assert.equal(await translate('constructor.name'), 'constructor.name', 'catalog traversal excludes inherited properties');
    let afterChange;
    h.targetWindow.api.receive('apply-language', () => { afterChange = translate('main.export'); });
    h.event({ channel: 'apply-language', args: ['zh_CN'] });
    assert.equal(await afterChange, '导出');
    assert.equal(h.calls.filter(call => call.args?.channel === 'translate').length, 0);
    h.bridge.dispose();
});

test('translation fallback deduplicates pending calls and discards old-language results', async () => {
    const first = deferred();
    const h = harness({ dispatch: ({ channel }) => channel === 'translate' ? first.promise : '#123456' });
    await h.bridge.ready;
    await h.bridge.notifyReady();
    const pending = h.targetWindow.i18n.translate('main.export');
    assert.equal(pending, h.targetWindow.i18n.translate('main.export'));
    h.event({ channel: 'apply-language', args: ['zh_CN'] });
    first.resolve('Export');
    assert.equal(await pending, '导出');
    assert.equal(await h.targetWindow.i18n.translate('main.export'), '导出');
    assert.equal(h.calls.filter(call => call.args?.channel === 'translate').length, 1);
    h.bridge.dispose();
});
