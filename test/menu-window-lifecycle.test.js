const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createHarness() {
    const windows = [];
    const ipcMain = new EventEmitter();
    class FakeWindow extends EventEmitter {
        constructor() {
            super();
            windows.push(this);
            this.destroyed = false;
            this.visible = true;
            this.focused = true;
            this.bounds = { x: 100, y: 200 };
            this.webContents = new EventEmitter();
            this.webContents.parent = this;
            this.webContents.loading = true;
            this.webContents.messages = [];
            this.webContents.isLoading = () => this.webContents.loading;
            this.webContents.send = (...args) => { this.webContents.messages.push(args); };
        }
        static fromWebContents(contents) { return contents.parent; }
        isDestroyed() { return this.destroyed; }
        isVisible() { return this.visible; }
        isFocused() { return this.focused; }
        hide() { this.visible = false; }
        showInactive() { this.visible = true; }
        focus() { this.focused = true; }
        setBounds(bounds) { this.bounds = bounds; }
        setOpacity() {}
        getContentBounds() { return this.bounds; }
        loadFile() {}
        destroy() {
            this.destroyed = true;
            this.emit('closed');
        }
    }
    const parent = new FakeWindow();
    const mocks = {
        electron: { BrowserWindow: FakeWindow, ipcMain },
        i18next: { t: () => 'en-US' },
        '../../shared/ipcPolicy': { RENDERER_ROLE_ARGUMENT_PREFIX: '--renderer-role=' },
        '../global': { getMainWin: () => parent },
        '../ipcAuthorization': { registerRendererWindow() {} },
        '../windowSecurity': { hardenBrowserWindow() {} }
    };
    const servicePath = path.join(__dirname, '../src/main/services/menuWindowService.js');
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(servicePath, 'utf8'), {
        module,
        require: id => mocks[id] || require(id),
        __dirname: path.dirname(servicePath),
        setTimeout,
        clearTimeout
    });
    module.exports.registerMenuWindowIpc();
    const show = (label, rendererRequestId) => ipcMain.emit('show-popup-menu', { sender: parent.webContents }, {
        items: [{ label, action: 'test-action', data: 'shared-data' }],
        x: 20,
        y: 30,
        rendererRequestId
    });
    const finishLoad = window => {
        window.webContents.loading = false;
        window.webContents.emit('did-finish-load');
    };
    return { windows, ipcMain, parent, show, finishLoad, service: module.exports };
}

test('popup requests queued during loading share one listener and publish only the latest items', () => {
    const { windows, parent, show, finishLoad } = createHarness();
    for (let index = 0; index < 1000; index += 1) show(String(index));
    const menu = windows[1];
    assert.equal(menu.webContents.listenerCount('did-finish-load'), 1);
    assert.equal(parent.listenerCount('blur'), 1);
    assert.equal(parent.listenerCount('move'), 1);
    assert.equal(parent.listenerCount('closed'), 1);
    finishLoad(menu);
    assert.equal(menu.webContents.messages.length, 1);
    assert.equal(menu.webContents.messages[0][1].items[0].label, '999');
});

test('hiding or destroying a loading menu invalidates delayed delivery and releases parent listeners', () => {
    const { windows, ipcMain, parent, show, finishLoad } = createHarness();
    show('cancelled');
    const first = windows[1];
    ipcMain.emit('hide-popup-menu');
    finishLoad(first);
    assert.equal(first.webContents.messages.length, 0);
    show('closing');
    const delayedLoad = first.webContents.listeners('did-finish-load')[0];
    first.destroy();
    assert.equal(parent.listenerCount('blur'), 0);
    assert.equal(parent.listenerCount('move'), 0);
    assert.equal(parent.listenerCount('closed'), 0);
    assert.equal(first.webContents.listenerCount('did-finish-load'), 0);
    show('replacement');
    const replacement = windows[2];
    assert.doesNotThrow(delayedLoad);
    assert.equal(replacement.webContents.messages.length, 0);
    finishLoad(replacement);
    assert.equal(replacement.webContents.messages[0][1].items[0].label, 'replacement');
    parent.destroy();
    assert.equal(parent.listenerCount('blur'), 0);
    assert.equal(parent.listenerCount('move'), 0);
    assert.equal(replacement.visible, false);
});

test('stale dismiss, click, and resize events cannot affect a newer menu request', () => {
    const { windows, ipcMain, parent, show, finishLoad } = createHarness();
    show('first');
    const menu = windows[1];
    finishLoad(menu);
    const firstId = menu.webContents.messages.at(-1)[1].requestId;
    show('second');
    const secondId = menu.webContents.messages.at(-1)[1].requestId;
    const event = { sender: menu.webContents };
    ipcMain.emit('resize-and-show-menu', event, { dismiss: true, requestId: firstId });
    ipcMain.emit('menu-item-click', event, 'test-action', 'shared-data', firstId);
    assert.equal(parent.webContents.messages.length, 0);
    ipcMain.emit('resize-and-show-menu', event, { width: 'invalid', height: 'invalid', requestId: secondId });
    assert.ok(Object.values(menu.bounds).every(Number.isFinite));
    assert.equal(menu.bounds.x, 120);
    const currentBounds = menu.bounds;
    menu.emit('ready-to-show');
    assert.equal(menu.bounds, currentBounds, 'late ready event must not move an open menu off screen');
    ipcMain.emit('resize-and-show-menu', event, { width: 400, height: 900, requestId: firstId });
    assert.equal(menu.bounds, currentBounds);
    ipcMain.emit('menu-item-click', event, 'test-action', 'shared-data', secondId);
    assert.equal(parent.webContents.messages.filter(([channel]) => channel === 'execute-menu-action').length, 1);

    show('third');
    const thirdId = menu.webContents.messages.at(-1)[1].requestId;
    ipcMain.emit('resize-and-show-menu', event, { dismiss: true, requestId: thirdId });
    assert.equal(menu.visible, false);
    assert.equal(parent.webContents.messages.at(-1)[0], 'menu-hidden');
});

test('menu hidden notifications preserve the originating renderer token and clear it on hide', () => {
    const { windows, ipcMain, parent, show, finishLoad } = createHarness();
    show('first', 41);
    finishLoad(windows[1]);
    ipcMain.emit('hide-popup-menu');
    const firstNotification = parent.webContents.messages.at(-1);
    show('second', 42);
    assert.equal(firstNotification[1].rendererRequestId, 41);
    ipcMain.emit('hide-popup-menu');
    assert.equal(parent.webContents.messages.at(-1)[1].rendererRequestId, 42);
    const notificationCount = parent.webContents.messages.length;
    ipcMain.emit('hide-popup-menu');
    assert.equal(parent.webContents.messages.length, notificationCount);

    show('legacy');
    ipcMain.emit('hide-popup-menu');
    assert.equal(Object.hasOwn(parent.webContents.messages.at(-1)[1], 'rendererRequestId'), false);
    show('invalid', { unexpected: 'value' });
    ipcMain.emit('hide-popup-menu');
    assert.equal(Object.hasOwn(parent.webContents.messages.at(-1)[1], 'rendererRequestId'), false);
});
