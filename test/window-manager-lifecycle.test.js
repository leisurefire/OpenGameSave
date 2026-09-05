const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const flush = () => new Promise(resolve => { setImmediate(resolve); });

function createHarness(context) {
    const windows = [];
    const delayed = [];
    const ipcMain = new EventEmitter();
    ipcMain.handle = (channel, handler) => ipcMain.on(channel, handler);
    class FakeWindow extends EventEmitter {
        constructor(options) {
            super();
            this.options = options;
            this.visible = false;
            this.destroyed = false;
            this.loads = [];
            this.webContents = { parent: this };
            windows.push(this);
        }
        static fromWebContents(contents) { return contents.parent; }
        isDestroyed() { return this.destroyed; }
        isVisible() { return this.visible; }
        show() { assert.equal(this.destroyed, false); this.visible = true; }
        hide() { this.visible = false; }
        focus() { assert.equal(this.destroyed, false); }
        moveTop() { assert.equal(this.destroyed, false); }
        setMinimumSize() {}
        setSize() {}
        setResizable() {}
        setMenuBarVisibility() {}
        setBackgroundMaterial() {}
        setBackgroundColor() {}
        loadFile(file) {
            assert.equal(this.destroyed, false);
            return new Promise((resolve, reject) => { this.loads.push({ file, resolve, reject }); });
        }
        close() {
            let prevented = false;
            this.emit('close', { preventDefault: () => { prevented = true; } });
            if (!prevented) this.destroy();
        }
        destroy() {
            if (this.destroyed) return;
            this.destroyed = true;
            this.emit('closed');
            for (const load of this.loads) load.reject(new Error('Window destroyed'));
        }
    }
    const errors = [];
    const mocks = {
        electron: { BrowserWindow: FakeWindow, Menu: {}, app: {}, ipcMain, nativeTheme: {} },
        '../ipcAuthorization': { registerRendererWindow() {} },
        '../windowSecurity': { hardenBrowserWindow() {} }
    };
    const servicePath = path.join(__dirname, '../src/main/services/windowManager.js');
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(servicePath, 'utf8'), {
        module,
        require: id => mocks[id] || (id.startsWith('.') ? require(path.resolve(path.dirname(servicePath), id)) : require(id)),
        __dirname: path.dirname(servicePath),
        process,
        console: { error: (...args) => errors.push(args) },
        setTimeout: callback => { delayed.push(callback); }
    });
    const open = (page = 'settings', wikiId = '1') => {
        if (page === 'settings') ipcMain.emit('open-settings-window');
        else ipcMain.emit('open-modal-window', {}, page, { wikiId });
    };
    const data = window => {
        const handler = ipcMain.listeners('get-modal-window-data')[0];
        return handler({ sender: window.webContents });
    };
    context.after(async () => {
        for (const window of windows) window.destroy();
        await flush();
    });
    return { windows, delayed, errors, open, data };
}

test('repeated opens while a modal loads share one BrowserWindow', async (context) => {
    const { windows, open, errors } = createHarness(context);
    for (let index = 0; index < 1000; index += 1) open();
    await flush();
    assert.equal(windows.length, 1);
    assert.equal(windows[0].loads.length, 1);
    windows[0].loads[0].resolve();
    await flush();
    assert.equal(windows[0].visible, true);
    assert.equal(errors.length, 0);
});

test('dynamic modal reloads retain only the latest pending selection', async (context) => {
    const { windows, open, data, errors } = createHarness(context);
    open('local-save', '1');
    await flush();
    const window = windows[0];
    for (let index = 2; index <= 1000; index += 1) open('local-save', String(index));
    await flush();
    assert.equal(windows.length, 1);
    assert.equal(window.loads.length, 1);
    window.loads[0].resolve();
    await flush();
    assert.equal(window.loads.length, 2);
    assert.equal(data(window).wikiId, '1000');
    window.loads[1].resolve();
    await flush();
    assert.equal(window.loads.length, 2);
    assert.equal(window.visible, true);
    assert.equal(errors.length, 0);
});

test('reopening during delayed modal teardown uses a live owner and a new window', async (context) => {
    const { windows, delayed, open, errors } = createHarness(context);
    open('local-save');
    await flush();
    const first = windows[0];
    first.loads[0].resolve();
    await flush();
    first.close();
    open('local-save', '2');
    await flush();
    assert.equal(windows.length, 2);
    const replacement = windows[1];
    assert.notEqual(replacement.options.parent, first);
    for (const callback of delayed.splice(0)) callback();
    replacement.loads[0].resolve();
    await flush();
    assert.equal(replacement.visible, true);
    assert.equal(replacement.destroyed, false);
    assert.equal(errors.length, 0);
});

test('failed initial modal loads release the reusable window and allow reopening', async (context) => {
    const { windows, open } = createHarness(context);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        open();
        await flush();
        assert.equal(windows.length, attempt + 1);
        const window = windows[attempt];
        assert.equal(windows.filter(candidate => !candidate.destroyed).length, 1);
        window.loads[0].reject(new Error('Initial page load failed'));
        await flush();
        assert.equal(window.destroyed, true);
    }
    open();
    await flush();
    const replacement = windows.at(-1);
    replacement.loads[0].resolve();
    await flush();
    assert.equal(replacement.visible, true);
    assert.equal(windows.filter(candidate => !candidate.destroyed).length, 1);
});

for (const initiallyVisible of [false, true]) {
    test(`a failed ${initiallyVisible ? 'visible' : 'initial'} navigation still loads the latest pending modal data`, async (context) => {
        const { windows, open, data } = createHarness(context);
        open('local-save', '1');
        await flush();
        const window = windows[0];
        if (initiallyVisible) {
            window.loads[0].resolve();
            await flush();
            open('local-save', '2');
            await flush();
        }
        const currentLoad = window.loads.at(-1);
        for (let index = 3; index <= 1000; index += 1) open('local-save', String(index));
        currentLoad.reject(new Error('Superseded navigation failed'));
        await flush();
        assert.equal(window.destroyed, false);
        assert.equal(windows.length, 1);
        assert.equal(window.loads.length, initiallyVisible ? 3 : 2);
        assert.equal(data(window).wikiId, '1000');
        window.loads.at(-1).resolve();
        await flush();
        assert.equal(window.visible, true);
    });
}
