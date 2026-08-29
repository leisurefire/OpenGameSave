const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function temporaryDirectory(context, prefix) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function requireWithMocks(relativePath, mocks) {
    const modulePath = path.join(PROJECT_ROOT, relativePath);
    const originalLoad = Module._load;
    Module._load = function loadWithTestMocks(request, parent, isMain) {
        if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve(modulePath)];
    try {
        return require(modulePath);
    } finally {
        Module._load = originalLoad;
    }
}

function createElectronMock(root) {
    return {
        app: {
            getLocale: () => 'en-US',
            getPath: (name) => path.join(root, name),
            getPreferredSystemLanguages: () => ['en-US'],
            isPackaged: false,
            setLoginItemSettings: () => {}
        },
        BrowserWindow: { getAllWindows: () => [] },
        Menu: { setApplicationMenu: () => {} }
    };
}

test('a failed settings replacement leaves memory and disk committed to the old value and permits retry', async (context) => {
    const root = temporaryDirectory(context, 'ogs-settings-reliability-');
    const settingsService = requireWithMocks('src/main/services/settingsService.js', {
        electron: createElectronMock(root),
        i18next: { changeLanguage: async () => {} },
        './windowManager': { getMainWin: () => null }
    });
    settingsService.loadSettings();

    const settingsPath = path.join(root, 'userData', 'OGS Settings', 'settings.json');
    assert.equal(settingsService.getSettings().maxBackups, 5);

    const originalRename = fs.promises.rename;
    let shouldFail = true;
    fs.promises.rename = async (...args) => {
        if (shouldFail) {
            shouldFail = false;
            throw Object.assign(new Error('injected settings rename failure'), { code: 'EACCES' });
        }
        return originalRename(...args);
    };

    try {
        const failedSave = settingsService.saveSettings('maxBackups', 6);
        assert.equal(settingsService.getSettings().maxBackups, 5);
        await assert.rejects(failedSave, /injected settings rename failure/);
        assert.equal(settingsService.getSettings().maxBackups, 5);
        assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).maxBackups, 5);

        assert.deepEqual(await settingsService.saveSettings('maxBackups', 6), ['maxBackups']);
        assert.equal(settingsService.getSettings().maxBackups, 6);
        assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).maxBackups, 6);
    } finally {
        fs.promises.rename = originalRename;
    }
});

test('a committed setting retries a failed runtime side effect without rewriting the value', async (context) => {
    const root = temporaryDirectory(context, 'ogs-settings-side-effect-');
    let languageAttempts = 0;
    const settingsService = requireWithMocks('src/main/services/settingsService.js', {
        electron: createElectronMock(root),
        i18next: {
            changeLanguage: async () => {
                languageAttempts += 1;
                if (languageAttempts === 1) throw new Error('injected language failure');
            }
        },
        './windowManager': { getMainWin: () => null }
    });
    settingsService.loadSettings();
    const settingsPath = path.join(root, 'userData', 'OGS Settings', 'settings.json');
    const originalConsoleError = console.error;
    console.error = () => {};

    try {
        assert.deepEqual(await settingsService.saveSettings('language', 'zh_CN'), ['language']);
        assert.equal(settingsService.getSettings().language, 'zh_CN');
        assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).language, 'zh_CN');
        assert.equal(languageAttempts, 1);

        assert.deepEqual(await settingsService.saveSettings('language', 'zh_CN'), []);
        assert.equal(languageAttempts, 2);
    } finally {
        console.error = originalConsoleError;
    }
});

test('a failed library refresh notification remains pending until delivery succeeds', async (context) => {
    const root = temporaryDirectory(context, 'ogs-settings-library-side-effect-');
    let deliveryAvailable = false;
    const deliveredChannels = [];
    const mainWindow = {
        isDestroyed: () => false,
        webContents: {
            isDestroyed: () => false,
            send: (channel) => {
                if (!deliveryAvailable) throw new Error('injected delivery failure');
                deliveredChannels.push(channel);
            }
        }
    };
    const settingsService = requireWithMocks('src/main/services/settingsService.js', {
        electron: createElectronMock(root),
        i18next: { changeLanguage: async () => {} },
        './windowManager': { getMainWin: () => mainWindow }
    });
    settingsService.loadSettings();
    const originalConsoleError = console.error;
    console.error = () => {};

    try {
        assert.deepEqual(await settingsService.saveSettings('saveUninstalledGames', false), ['saveUninstalledGames']);
        deliveryAvailable = true;
        assert.deepEqual(await settingsService.saveSettings('saveUninstalledGames', false), []);
        assert.deepEqual(deliveredChannels, ['update-backup-table', 'update-restore-table']);
    } finally {
        console.error = originalConsoleError;
    }
});

function loadMigrationService(saveSettings, alerts = [], fsAdapter = fs) {
    return requireWithMocks('src/main/services/backupMigrationService.js', {
        i18next: { t: (key) => key },
        'original-fs': fsAdapter,
        '../gameOperationLock': { acquireGlobalOperation: () => () => {} },
        './settingsService': { saveSettings },
        './statusService': {
            getStatus: () => ({ migrating: false }),
            updateStatus: () => {}
        },
        './windowManager': {
            getMainWin: () => ({ webContents: { send: (...args) => alerts.push(args) } })
        }
    });
}

function createMigrationRaceFs(sourceFile, racePoint, replacementContent) {
    let sourceReadCount = 0;
    let injected = false;
    return {
        ...fs,
        constants: fs.constants,
        promises: { ...fs.promises },
        createReadStream(filePath, options) {
            const normalizedPath = path.resolve(filePath);
            if (normalizedPath === path.resolve(sourceFile)) {
                sourceReadCount += 1;
                if (racePoint === 'before-copy' && sourceReadCount === 2) {
                    fs.writeFileSync(sourceFile, replacementContent);
                    injected = true;
                }
            } else if (racePoint === 'after-copy'
                && path.basename(path.dirname(normalizedPath)).startsWith('.destination.ogs-migration-')) {
                fs.writeFileSync(sourceFile, replacementContent);
                injected = true;
            }
            return fs.createReadStream(filePath, options);
        },
        wasInjected: () => injected
    };
}

function stagingEntries(root, destinationName = 'destination') {
    return fs.readdirSync(root).filter(name => name.startsWith(`.${destinationName}.ogs-migration-`));
}

test('migration installs a verified staging tree atomically before committing and clearing the source', async (context) => {
    const root = temporaryDirectory(context, 'ogs-migration-success-');
    const source = path.join(root, 'source');
    const destination = path.join(root, 'destination');
    fs.mkdirSync(path.join(source, 'nested', 'empty'), { recursive: true });
    fs.writeFileSync(path.join(source, 'save.dat'), 'save data');
    fs.writeFileSync(path.join(source, 'nested', 'slot.bin'), Buffer.from([0, 1, 2, 3]));
    fs.mkdirSync(destination);

    let committedPath = null;
    const service = loadMigrationService(async (key, value) => {
        assert.equal(key, 'backupPath');
        assert.equal(fs.existsSync(source), true);
        assert.equal(fs.readFileSync(path.join(value, 'save.dat'), 'utf8'), 'save data');
        committedPath = value;
    });

    assert.equal(await service.moveFilesWithProgress(source, destination), true);
    assert.equal(committedPath, destination);
    assert.equal(fs.existsSync(source), false);
    assert.deepEqual(fs.readFileSync(path.join(destination, 'nested', 'slot.bin')), Buffer.from([0, 1, 2, 3]));
    assert.equal(fs.statSync(path.join(destination, 'nested', 'empty')).isDirectory(), true);
    assert.deepEqual(stagingEntries(root), []);
});

for (const [label, racePoint] of [
    ['same-size content changes before copy', 'before-copy'],
    ['source changes after a file was copied', 'after-copy']
]) {
    test(`migration rejects ${label} and leaves no target or staging data`, async (context) => {
        const root = temporaryDirectory(context, `ogs-migration-race-${racePoint}-`);
        const source = path.join(root, 'source');
        const destination = path.join(root, 'destination');
        const sourceFile = path.join(source, 'save.dat');
        fs.mkdirSync(source);
        fs.writeFileSync(sourceFile, 'AAAA');
        const raceFs = createMigrationRaceFs(sourceFile, racePoint, 'BBBB');
        let settingsCommitted = false;
        const service = loadMigrationService(async () => {
            settingsCommitted = true;
        }, [], raceFs);
        const originalConsoleError = console.error;
        console.error = () => {};

        try {
            assert.equal(await service.moveFilesWithProgress(source, destination), false);
        } finally {
            console.error = originalConsoleError;
        }
        assert.equal(raceFs.wasInjected(), true);
        assert.equal(settingsCommitted, false);
        assert.equal(fs.existsSync(source), true);
        assert.equal(fs.existsSync(destination), false);
        assert.deepEqual(stagingEntries(root), []);
    });
}

test('migration refuses to overwrite a non-empty destination', async (context) => {
    const root = temporaryDirectory(context, 'ogs-migration-nonempty-');
    const source = path.join(root, 'source');
    const destination = path.join(root, 'destination');
    fs.mkdirSync(source);
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(source, 'save.dat'), 'new save');
    fs.writeFileSync(path.join(destination, 'keep.dat'), 'existing save');
    let settingsCommitted = false;
    const service = loadMigrationService(async () => {
        settingsCommitted = true;
    });
    const originalConsoleError = console.error;
    console.error = () => {};

    try {
        assert.equal(await service.moveFilesWithProgress(source, destination), false);
    } finally {
        console.error = originalConsoleError;
    }
    assert.equal(settingsCommitted, false);
    assert.equal(fs.readFileSync(path.join(source, 'save.dat'), 'utf8'), 'new save');
    assert.equal(fs.readFileSync(path.join(destination, 'keep.dat'), 'utf8'), 'existing save');
    assert.deepEqual(stagingEntries(root), []);
});

test('migration warns and keeps the verified destination when old-source cleanup fails', async (context) => {
    const root = temporaryDirectory(context, 'ogs-migration-cleanup-warning-');
    const source = path.join(root, 'source');
    const destination = path.join(root, 'destination');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'save.dat'), 'save data');
    const cleanupFailureFs = {
        ...fs,
        constants: fs.constants,
        promises: {
            ...fs.promises,
            async rm(targetPath, options) {
                if (path.resolve(targetPath) === path.resolve(source)) {
                    throw Object.assign(new Error('injected source cleanup failure'), { code: 'EACCES' });
                }
                return fs.promises.rm(targetPath, options);
            }
        }
    };
    const alerts = [];
    const service = loadMigrationService(async () => {}, alerts, cleanupFailureFs);
    const originalConsoleError = console.error;
    console.error = () => {};

    try {
        assert.equal(await service.moveFilesWithProgress(source, destination), true);
    } finally {
        console.error = originalConsoleError;
    }
    assert.equal(fs.readFileSync(path.join(source, 'save.dat'), 'utf8'), 'save data');
    assert.equal(fs.readFileSync(path.join(destination, 'save.dat'), 'utf8'), 'save data');
    assert.equal(alerts.some(args => args[0] === 'show-alert' && args[1] === 'warning'), true);
    assert.deepEqual(stagingEntries(root), []);
});

test('migration keeps the source intact and can resume when committing the destination setting fails', async (context) => {
    const root = temporaryDirectory(context, 'ogs-migration-reliability-');
    const source = path.join(root, 'source');
    const destination = path.join(root, 'destination');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'save.dat'), 'save data');

    let commitAttempts = 0;
    const service = loadMigrationService(async () => {
        commitAttempts += 1;
        if (commitAttempts === 1) throw new Error('injected settings failure');
    });
    const originalConsoleError = console.error;
    console.error = () => {};
    const result = await service.moveFilesWithProgress(source, destination).finally(() => {
        console.error = originalConsoleError;
    });
    assert.equal(result, false);
    assert.equal(fs.readFileSync(path.join(source, 'save.dat'), 'utf8'), 'save data');
    assert.equal(fs.readFileSync(path.join(destination, 'save.dat'), 'utf8'), 'save data');

    assert.equal(await service.moveFilesWithProgress(source, destination), true);
    assert.equal(commitAttempts, 2);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(path.join(destination, 'save.dat'), 'utf8'), 'save data');
});

test('invalid migration paths resolve to false instead of rejecting the IPC contract', async (context) => {
    const source = temporaryDirectory(context, 'ogs-migration-invalid-');
    const service = loadMigrationService(async () => {});
    const originalConsoleError = console.error;
    console.error = () => {};
    const result = await service.moveFilesWithProgress(source, source).finally(() => {
        console.error = originalConsoleError;
    });
    assert.equal(result, false);
});

test('renderer and Git reliability contracts remain explicit', () => {
    const readSource = (relativePath) => fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
    const settingsPage = readSource('src/renderer/js/settingsPage.js');
    const syncTab = readSource('src/renderer/js/syncTab.js');
    const modalWindowPage = readSource('src/renderer/js/modalWindowPage.js');
    const githubSync = readSource('src/main/githubSync.js');

    assert.match(settingsPage, /Array\.isArray\(settings\.gameInstalls\)/);
    assert.match(settingsPage, /finally\s*\{[\s\S]*document\.body\.style\.visibility\s*=\s*'visible'/);
    assert.match(syncTab, /catch \(error\)[\s\S]*backupPathInput\.value\s*=\s*settings\.backupPath/);
    assert.match(modalWindowPage, /result\?\.watcherFailures/);
    assert.match(githubSync, /\['push', 'origin', 'HEAD:main'\]/);
    assert.doesNotMatch(githubSync, /:\s*\['push'\]\s*\)/);
});
