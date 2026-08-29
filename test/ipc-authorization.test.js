const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
    areAuthorizedIpcArguments,
    filterSettingsForRole,
    getAuthorizedSenderRole,
    installIpcAuthorization,
    isAuthorizedIpcEvent,
    registerRendererWebContents
} = require('../src/main/ipcAuthorization');
const { isRoleAllowed } = require('../src/shared/ipcPolicy');

const rendererRoot = path.resolve('src', 'renderer');

function createWebContents(fileName) {
    let url = pathToFileURL(path.join(rendererRoot, fileName)).href;
    return {
        getURL: () => url,
        isDestroyed: () => false,
        setURL: value => { url = value; }
    };
}

function createEvent(webContents) {
    const frame = { parent: null, url: webContents.getURL() };
    frame.top = frame;
    return { sender: webContents, senderFrame: frame, preventDefault() {} };
}

class FakeIpcMain extends EventEmitter {
    constructor() {
        super();
        this.handlers = new Map();
    }

    handle(channel, handler) {
        this.handlers.set(channel, handler);
    }

    invoke(channel, event, ...args) {
        return Promise.resolve().then(() => this.handlers.get(channel)(event, ...args));
    }
}

test('IPC policy gives low-privilege pages only their required capabilities', () => {
    for (const role of ['about', 'settings', 'menu']) {
        assert.equal(isRoleAllowed(role, 'invoke', 'delete-backup'), false);
        assert.equal(isRoleAllowed(role, 'invoke', 'migrate-backups'), false);
        assert.equal(isRoleAllowed(role, 'send', 'export-backups'), false);
        assert.equal(isRoleAllowed(role, 'send', 'import-backups'), false);
    }
    assert.equal(isRoleAllowed('about', 'invoke', 'save-settings'), false);
    assert.equal(isRoleAllowed('menu', 'send', 'save-settings'), false);
    assert.equal(isRoleAllowed('settings', 'invoke', 'save-settings'), true);
    assert.equal(isRoleAllowed('manage-backups', 'invoke', 'delete-backup'), true);
    assert.equal(isRoleAllowed('import', 'send', 'import-backups'), true);
    assert.equal(areAuthorizedIpcArguments('settings', 'save-settings', ['maxBackups']), true);
    assert.equal(areAuthorizedIpcArguments('settings', 'save-settings', ['backupPath']), false);
    assert.equal(areAuthorizedIpcArguments('settings', 'save-settings', [{ maxBackups: 5, backupPath: 'C:\\' }]), false);
    assert.equal(areAuthorizedIpcArguments('export', 'select-path', ['folder']), true);
    assert.equal(areAuthorizedIpcArguments('export', 'select-path', ['gsmr']), false);
    assert.deepEqual(
        filterSettingsForRole('export', { backupPath: 'secret', exportPath: 'export', maxBackups: 5 }),
        { exportPath: 'export', maxBackups: 5 }
    );
    assert.deepEqual(filterSettingsForRole('about', { backupPath: 'secret' }), {});
});

test('authorization requires a main-process registration and the exact role page', () => {
    const mainContents = createWebContents('index.html');
    registerRendererWebContents(mainContents, 'main', rendererRoot);
    const mainEvent = createEvent(mainContents);
    assert.equal(getAuthorizedSenderRole(mainEvent), 'main');
    assert.equal(isAuthorizedIpcEvent(mainEvent, 'invoke', 'migrate-backups'), true);

    const forgedContents = createWebContents('index.html');
    assert.equal(getAuthorizedSenderRole(createEvent(forgedContents)), null);

    mainContents.setURL(pathToFileURL(path.join(rendererRoot, 'settings.html')).href);
    assert.equal(getAuthorizedSenderRole(createEvent(mainContents)), null);

    mainContents.setURL(pathToFileURL(path.resolve('package.json')).href);
    assert.equal(getAuthorizedSenderRole(createEvent(mainContents)), null);
});

test('authorization rejects subframes even when their URL looks trusted', () => {
    const contents = createWebContents('index.html');
    registerRendererWebContents(contents, 'main', rendererRoot);
    const top = { parent: null, url: contents.getURL() };
    top.top = top;
    const frame = { parent: top, top, url: contents.getURL() };
    assert.equal(getAuthorizedSenderRole({ sender: contents, senderFrame: frame }), null);
});

test('installed invoke and send guards reject forged roles and pass legal roles', async () => {
    const ipcMain = new FakeIpcMain();
    installIpcAuthorization(ipcMain);

    let deletedWikiId = null;
    ipcMain.handle('delete-backup', (event, wikiId) => {
        deletedWikiId = wikiId;
        return true;
    });

    const manageContents = createWebContents('modal.html');
    registerRendererWebContents(manageContents, 'manage-backups', rendererRoot);
    assert.equal(await ipcMain.invoke('delete-backup', createEvent(manageContents), '42'), true);
    assert.equal(deletedWikiId, '42');

    const settingsContents = createWebContents('settings.html');
    registerRendererWebContents(settingsContents, 'settings', rendererRoot);
    await assert.rejects(
        ipcMain.invoke('delete-backup', createEvent(settingsContents), '42'),
        /Unauthorized IPC invocation/
    );

    ipcMain.handle('save-settings', (event, key) => key);
    assert.equal(
        await ipcMain.invoke('save-settings', createEvent(settingsContents), 'maxBackups', 5),
        'maxBackups'
    );
    await assert.rejects(
        ipcMain.invoke('save-settings', createEvent(settingsContents), 'backupPath', 'C:\\forged'),
        /Unauthorized IPC invocation/
    );

    let importedPath = null;
    const importListener = (event, importPath) => { importedPath = importPath; };
    ipcMain.on('import-backups', importListener);
    ipcMain.emit('import-backups', createEvent(settingsContents), 'forged.gsmr');
    assert.equal(importedPath, null);

    const importContents = createWebContents('modal.html');
    registerRendererWebContents(importContents, 'import', rendererRoot);
    ipcMain.emit('import-backups', createEvent(importContents), 'trusted.gsmr');
    assert.equal(importedPath, 'trusted.gsmr');

    ipcMain.removeListener('import-backups', importListener);
    importedPath = null;
    ipcMain.emit('import-backups', createEvent(importContents), 'ignored.gsmr');
    assert.equal(importedPath, null);
});

test('an unauthorized send cannot consume a guarded once listener', () => {
    const ipcMain = new FakeIpcMain();
    installIpcAuthorization(ipcMain);
    let calls = 0;
    ipcMain.once('modal-window-confirm-response', () => { calls += 1; });

    const aboutContents = createWebContents('about.html');
    registerRendererWebContents(aboutContents, 'about', rendererRoot);
    ipcMain.emit('modal-window-confirm-response', createEvent(aboutContents));
    assert.equal(calls, 0);

    const confirmContents = createWebContents('modal.html');
    registerRendererWebContents(confirmContents, 'confirm', rendererRoot);
    ipcMain.emit('modal-window-confirm-response', createEvent(confirmContents));
    ipcMain.emit('modal-window-confirm-response', createEvent(confirmContents));
    assert.equal(calls, 1);
});

test('authorized send listeners cannot leak synchronous or asynchronous errors to the main process', async () => {
    const ipcMain = new FakeIpcMain();
    installIpcAuthorization(ipcMain);
    const manageContents = createWebContents('modal.html');
    const localSaveContents = createWebContents('modal.html');
    registerRendererWebContents(manageContents, 'manage-backups', rendererRoot);
    registerRendererWebContents(localSaveContents, 'local-save', rendererRoot);
    const errors = [];
    const originalConsoleError = console.error;
    console.error = (...args) => errors.push(args);

    try {
        ipcMain.on('open-backup-folder', () => {
            throw new Error('synchronous failure');
        });
        ipcMain.on('browse-local-save', async () => {
            throw new Error('asynchronous failure');
        });

        assert.doesNotThrow(() => {
            ipcMain.emit('open-backup-folder', createEvent(manageContents), '42');
            ipcMain.emit('browse-local-save', createEvent(localSaveContents), '42');
        });
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    } finally {
        console.error = originalConsoleError;
    }

    assert.equal(errors.length, 2);
    assert.match(errors[0][0], /open-backup-folder/);
    assert.match(errors[1][0], /browse-local-save/);
});
