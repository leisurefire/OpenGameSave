const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

async function loadEntry(loaders) {
    const received = new Map();
    const listeners = new Map();
    let start;
    const document = {
        addEventListener(name, callback) {
            const subscribers = listeners.get(name) || [];
            subscribers.push(callback);
            listeners.set(name, subscribers);
        },
        dispatchEvent(event) {
            for (const callback of [...(listeners.get(event.type) || [])]) callback(event);
        }
    };
    const source = fs.readFileSync(path.join(__dirname, '../src/renderer/index.entry.js'), 'utf8')
        .replace(/^import .*;\r?\n/gm, '')
        .replace(/    await import\('\.\/js\/(?:commonTabs|windowControls)\.js'\);/g, '');
    const context = vm.createContext({
        console, document, loaders,
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
        window: { api: { receive: (channel, callback) => received.set(channel, callback) } },
        startRenderer: callback => { start = callback; }
    });
    vm.runInContext(source, context);
    vm.runInContext('Object.assign(tabModuleLoaders, loaders);', context);
    await start();
    return { document, received, context };
}

test('a scan request from the library loads the backup page before starting the scan', async () => {
    const loading = deferred();
    let loaded = 0;
    let scans = 0;
    const entry = await loadEntry({
        library: async () => ({}),
        backup: () => { loaded++; return loading.promise; }
    });
    const scan = entry.received.get('run-scan-full')();
    assert.equal(loaded, 1);
    assert.equal(scans, 0);
    loading.resolve({ runFullScan: async () => { scans++; } });
    await scan;
    assert.equal(scans, 1);
});

test('the first guide selection survives loading the guides page and is not replayed twice', async () => {
    const loading = deferred();
    let loaded = 0;
    const entry = await loadEntry({ library: async () => ({}), guides: () => { loaded++; return loading.promise; } });
    const selected = [];
    entry.document.dispatchEvent({ type: 'ogs:select-game-guide', detail: { wikiPageId: '42' } });
    entry.document.dispatchEvent({ type: 'ogs:navigate', detail: { route: 'guides' } });
    assert.equal(loaded, 1);
    entry.document.addEventListener('ogs:select-game-guide', event => selected.push(event.detail.wikiPageId));
    loading.resolve({});
    await new Promise(resolve => { setImmediate(resolve); });
    assert.deepEqual(selected, ['42']);
    entry.document.dispatchEvent({ type: 'ogs:select-game-guide', detail: { wikiPageId: '43' } });
    await new Promise(resolve => { setImmediate(resolve); });
    assert.deepEqual(selected, ['42', '43']);
});
