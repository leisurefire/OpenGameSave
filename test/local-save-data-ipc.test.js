const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function loadLocalSaveHandler(game, fsAdapter = fs) {
    const handlers = new Map();
    let readinessChecks = 0;
    const filename = path.join(__dirname, '../src/main/ipc/database.js');
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    const originalRequire = loaded.require.bind(loaded);
    const mocks = {
        electron: {
            ipcMain: {
                handle: (channel, handler) => handlers.set(channel, handler),
                on() {}
            }
        },
        'original-fs': fsAdapter,
        i18next: {},
        '../backup': {
            async getGameDataFromDB(ignoreUninstalled, wikiId) {
                assert.equal(ignoreUninstalled, false);
                assert.equal(wikiId, '123');
                assert.equal(readinessChecks, 1);
                return { games: game ? [game] : [] };
            }
        },
        '../global': {},
        '../autoBackup': {},
        '../restore': {},
        '../services/iconService': {}
    };
    loaded.require = request => Object.hasOwn(mocks, request) ? mocks[request] : originalRequire(request);
    loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
    loaded.exports.registerDatabaseIpc({ ensureGameDataReady: async () => { readinessChecks += 1; } });
    return () => handlers.get('get-local-save-data')({}, 123);
}

test('local save data identifies real files and folders without changing registry paths, source data or indexes', async t => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-local-save-types-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'slot.sav');
    const folder = path.join(root, 'profiles');
    const removedFile = path.join(root, 'removed.sav');
    await fs.promises.writeFile(file, 'save');
    await fs.promises.mkdir(folder);
    await fs.promises.writeFile(removedFile, 'removed');
    const game = {
        wiki_page_id: 123,
        title: 'Example',
        resolved_paths: [
            { template: '{{p|appdata}}/slot.sav', finalTemplate: '{{p|appdata}}/slot.sav', resolved: file },
            { resolved: 'HKEY_CURRENT_USER\\Software\\Example', type: 'reg' },
            { resolved: removedFile, type: 'folder' },
            { resolved: folder },
            { resolved: null, type: 'folder' },
            null
        ]
    };
    const before = structuredClone(game);
    await fs.promises.unlink(removedFile);
    const result = await loadLocalSaveHandler(game)();
    assert.notEqual(result, game);
    assert.notEqual(result.resolved_paths, game.resolved_paths);
    assert.deepEqual(result.resolved_paths.map(entry => entry?.type), ['file', 'reg', undefined, 'folder', undefined, undefined]);
    assert.deepEqual(result.resolved_paths.map(entry => entry?.resolved), before.resolved_paths.map(entry => entry?.resolved));
    assert.equal(result.resolved_paths[0].finalTemplate, before.resolved_paths[0].finalTemplate);
    assert.deepEqual(result.resolved_paths[1], before.resolved_paths[1]);
    assert.deepEqual(game, before);
});

test('local save type inspection remains asynchronous and bounds filesystem concurrency', async t => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-local-save-concurrency-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const game = { resolved_paths: Array.from({ length: 65 }, (_, index) => ({ resolved: path.join(root, `${index}.sav`) })) };
    await Promise.all(game.resolved_paths.map(entry => fs.promises.writeFile(entry.resolved, 'save')));
    let active = 0;
    let maximum = 0;
    const fsAdapter = {
        promises: {
            async lstat(filePath) {
                active += 1;
                maximum = Math.max(maximum, active);
                try {
                    await new Promise(resolve => { setImmediate(resolve); });
                    return await fs.promises.lstat(filePath);
                } finally {
                    active -= 1;
                }
            }
        }
    };
    const result = await loadLocalSaveHandler(game, fsAdapter)();
    assert.ok(maximum > 1 && maximum <= 16);
    assert.equal(active, 0);
    assert.equal(result.resolved_paths.length, 65);
    assert.ok(result.resolved_paths.every(entry => entry.type === 'file'));
    assert.deepEqual(result.resolved_paths.map(entry => entry.resolved), game.resolved_paths.map(entry => entry.resolved));
});

test('local save inspection keeps unknown filesystem entries untyped and absent games null', async () => {
    const game = { resolved_paths: [{ resolved: 'link', type: 'folder' }, { resolved: 'unreadable', type: 'file' }] };
    const result = await loadLocalSaveHandler(game, {
        promises: {
            async lstat(filePath) {
                if (filePath === 'unreadable') throw Object.assign(new Error('Access denied'), { code: 'EACCES' });
                return { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true };
            }
        }
    })();
    assert.ok(result.resolved_paths.every(entry => !Object.hasOwn(entry, 'type')));
    assert.equal(await loadLocalSaveHandler(null)(), null);
});
