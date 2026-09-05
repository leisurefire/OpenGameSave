const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const Database = require('better-sqlite3');

function loadPatchApplier() {
    const filename = path.resolve(__dirname, '../src/main/backup.js');
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    const originalRequire = loaded.require.bind(loaded);
    loaded.require = request => ['electron', './global', './gameData'].includes(request)
        ? {} : originalRequire(request);
    // Exercise the internal patch operation with its real SQLite and validation
    // dependencies without constructing Electron windows or network requests.
    loaded._compile(`${fs.readFileSync(filename, 'utf8')}\nmodule.exports.applyPatch = applyPatch;`, filename);
    return loaded.exports.applyPatch;
}

test('large database patch deletions stay within SQLite parameter limits and yield to the event loop', async (t) => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-patch-batch-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const dbPath = path.join(root, 'database.db');
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE games (wiki_page_id INTEGER PRIMARY KEY);
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO games VALUES (1), (40000);
        INSERT INTO metadata VALUES ('key1', 'one'), ('key40000', 'last');
        PRAGMA user_version = 1;
    `);
    db.close();
    const applyPatch = loadPatchApplier();
    let completed = false;
    let yieldedBeforeCompletion = false;
    setImmediate(() => { yieldedBeforeCompletion = !completed; });
    await applyPatch(dbPath, {
        from_version: 1, version: 2,
        delete: Array.from({ length: 40000 }, (_, index) => index + 1),
        metadata_delete: Array.from({ length: 40000 }, (_, index) => `key${index + 1}`)
    }, 2, 1);
    completed = true;
    const updated = new Database(dbPath, { readonly: true });
    try {
        assert.equal(updated.prepare('SELECT COUNT(*) AS count FROM games').get().count, 0);
        assert.equal(updated.prepare('SELECT COUNT(*) AS count FROM metadata').get().count, 0);
        assert.equal(updated.pragma('user_version', { simple: true }), 2);
        assert.equal(yieldedBeforeCompletion, true);
    } finally {
        updated.close();
    }
});
