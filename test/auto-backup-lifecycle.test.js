const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function loadAutoBackup({ backupGame, getGameDataFromDB = null, persistSettings = null }) {
    const modulePath = path.resolve(__dirname, '../src/main/autoBackup.js');
    const watchers = [];
    const settings = { autoBackupGames: {} };

    class FakeWatcher {
        constructor() {
            this.listeners = new Map();
            this.closed = false;
        }

        on(eventName, listener) {
            this.listeners.set(eventName, listener);
            return this;
        }

        emit(eventName, ...args) {
            this.listeners.get(eventName)?.(...args);
        }

        async close() {
            this.closed = true;
        }
    }

    const game = {
        wiki_page_id: '123',
        resolved_paths: [{ type: 'folder', resolved: __dirname }]
    };
    const mocks = {
        'original-fs': fs,
        chokidar: {
            watch: () => {
                const watcher = new FakeWatcher();
                watchers.push(watcher);
                return watcher;
            }
        },
        i18next: { t: key => key },
        './global': {
            getSettings: () => settings,
            saveSettings: async (key, value) => {
                if (persistSettings) await persistSettings(key, value, settings);
                else settings[key] = value;
            },
            getMainWin: () => null
        },
        './backup': {
            getGameDataFromDB: getGameDataFromDB || (async () => ({ games: [game] })),
            backupGame
        }
    };

    const originalLoad = Module._load;
    Module._load = function loadWithMocks(request, parent, isMain) {
        if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve(modulePath)];
    try {
        return { service: require(modulePath), watchers, settings };
    } finally {
        Module._load = originalLoad;
    }
}

test('stopping an auto backup waits for its in-flight snapshot before returning', async () => {
    const backupResult = deferred();
    const backupStarted = deferred();
    const { service, watchers } = loadAutoBackup({
        backupGame: async () => {
            backupStarted.resolve();
            return backupResult.promise;
        }
    });

    await service.startAutoBackup('123', 'watcher', null);
    watchers[0].emit('all', 'change');
    await backupStarted.promise;

    let stopped = false;
    const stopping = service.stopAutoBackup('123', false).then(() => { stopped = true; });
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.equal(stopped, false);
    assert.equal(watchers[0].closed, true);

    backupResult.resolve(null);
    await stopping;
    assert.equal(stopped, true);
    assert.deepEqual(service.getAutoBackupState(), {});
});

test('an old generation cannot mutate or disable a concurrent replacement', async () => {
    const oldBackupResult = deferred();
    const oldBackupStarted = deferred();
    let backupCalls = 0;
    const { service, watchers, settings } = loadAutoBackup({
        backupGame: async () => {
            backupCalls += 1;
            if (backupCalls === 1) {
                oldBackupStarted.resolve();
                return oldBackupResult.promise;
            }
            return null;
        }
    });

    await service.startAutoBackup('123', 'watcher', null);
    watchers[0].emit('all', 'change');
    await oldBackupStarted.promise;
    const stoppingOldGeneration = service.stopAutoBackup('123', false);
    await new Promise((resolve) => { setImmediate(resolve); });
    await service.startAutoBackup('123', 'watcher', null);

    oldBackupResult.resolve(null);
    await stoppingOldGeneration;
    assert.equal(service.getAutoBackupState()['123'].logCount, 0);
    assert.equal(settings.autoBackupGames['123'].mode, 'watcher');

    watchers[1].emit('all', 'change');
    await new Promise((resolve) => { setImmediate(resolve); });
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.equal(service.getAutoBackupState()['123'].logCount, 1);
    await service.stopAllAutoBackups();
});

test('concurrent games persist one current auto-backup snapshot without lost updates', async () => {
    const firstWriteStarted = deferred();
    const releaseFirstWrite = deferred();
    let writeCount = 0;
    const { service, settings } = loadAutoBackup({
        backupGame: async () => null,
        persistSettings: async (key, value, currentSettings) => {
            writeCount += 1;
            if (writeCount === 1) {
                firstWriteStarted.resolve();
                await releaseFirstWrite.promise;
            }
            currentSettings[key] = value;
        }
    });

    const firstStart = service.startAutoBackup('123', 'interval', 5);
    await firstWriteStarted.promise;
    const secondStart = service.startAutoBackup('456', 'interval', 10);
    await new Promise((resolve) => { setImmediate(resolve); });
    releaseFirstWrite.resolve();
    await Promise.all([firstStart, secondStart]);

    assert.deepEqual(settings.autoBackupGames, {
        123: { mode: 'interval', intervalMinutes: 5 },
        456: { mode: 'interval', intervalMinutes: 10 }
    });
    await service.stopAllAutoBackups();
});

test('the newest concurrent start for one game wins without leaking the older generation', async () => {
    const firstLookup = deferred();
    let lookupCount = 0;
    const game = { wiki_page_id: '123', resolved_paths: [] };
    const { service, settings } = loadAutoBackup({
        backupGame: async () => null,
        getGameDataFromDB: async () => {
            lookupCount += 1;
            if (lookupCount === 1) return firstLookup.promise;
            return { games: [game] };
        }
    });

    const olderStart = service.startAutoBackup('123', 'interval', 5);
    const olderRejected = assert.rejects(olderStart, /superseded/);
    const newerStart = service.startAutoBackup('123', 'interval', 10);
    await newerStart;
    firstLookup.resolve({ games: [game] });
    await olderRejected;

    assert.equal(service.getAutoBackupState()['123'].intervalMinutes, 10);
    assert.deepEqual(settings.autoBackupGames, {
        123: { mode: 'interval', intervalMinutes: 10 }
    });
    await service.stopAllAutoBackups();
});

test('startup restoration persists its final auto-backup snapshot only once', async () => {
    let writeCount = 0;
    const { service, settings } = loadAutoBackup({
        backupGame: async () => null,
        persistSettings: async (key, value, currentSettings) => {
            writeCount += 1;
            currentSettings[key] = value;
        }
    });
    settings.autoBackupGames = {
        123: { mode: 'interval', intervalMinutes: 5 },
        456: { mode: 'interval', intervalMinutes: 10 }
    };

    await service.restoreAutoBackups();

    assert.equal(writeCount, 1);
    assert.equal(Object.keys(service.getAutoBackupState()).length, 2);
    await service.stopAllAutoBackups();
});
