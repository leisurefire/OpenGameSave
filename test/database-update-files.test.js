'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
    atomicInstallDatabase,
    createNewDatabasePath,
    recoverDatabaseFiles,
    verifyFileDescriptor
} = require('../src/main/databaseUpdateFiles');
const { validateDatabaseManifest } = require('../src/main/databaseManifest');

function createDb(filePath, version, title = `v${version}`) {
    const db = new Database(filePath);
    db.exec('CREATE TABLE games (wiki_page_id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO games VALUES (1, ?)').run(title);
    db.pragma(`user_version = ${version}`);
    db.close();
}

function inspect(filePath) {
    const db = new Database(filePath, { readonly: true, fileMustExist: true });
    try {
        if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('invalid');
        for (const table of ['games', 'metadata']) {
            if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error('invalid schema');
        }
        return { version: db.pragma('user_version', { simple: true }) };
    } finally {
        db.close();
    }
}

test('atomic replacement restores .bak when activation rename fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-atomic-'));
    try {
        const active = path.join(dir, 'database.db');
        const next = createNewDatabasePath(active);
        createDb(active, 1);
        createDb(next, 2);
        await assert.rejects(atomicInstallDatabase(next, active, inspect, stage => {
            if (stage === 'before-activate-rename') throw new Error('injected failure');
        }), /injected failure/);
        assert.equal(inspect(active).version, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('startup recovery selects the highest valid active, backup, new or legacy temp database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-recover-'));
    try {
        const active = path.join(dir, 'database.db');
        createDb(active, 2);
        createDb(`${active}.bak`, 3);
        createDb(`${active}.temp`, 4);
        createDb(createNewDatabasePath(active), 5);
        fs.writeFileSync(`${active}.new-partial`, Buffer.from('truncated'));
        const result = await recoverDatabaseFiles(active, inspect);
        assert.equal(result.version, 5);
        assert.equal(inspect(active).version, 5);
        assert.deepEqual(fs.readdirSync(dir), ['database.db']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('asset verification rejects digest mismatches and truncated downloads before parsing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-digest-'));
    try {
        const file = path.join(dir, 'asset');
        fs.writeFileSync(file, 'complete payload');
        const good = crypto.createHash('sha256').update('complete payload').digest('hex');
        await verifyFileDescriptor(file, { size: 16, sha256: good });
        await assert.rejects(verifyFileDescriptor(file, { size: 16, sha256: '0'.repeat(64) }), /SHA-256/);
        await assert.rejects(verifyFileDescriptor(file, { size: 100, sha256: good }), /size/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function manifestWithPatches(patches, variant = 'standard') {
    const suffix = variant === 'xbox' ? '_xbox' : '';
    return {
        variant,
        latest_version: 5,
        source_sha: 'a'.repeat(40),
        schema_version: 'b'.repeat(64),
        database: { name: `database${suffix}_v5.db`, size: 100, sha256: 'c'.repeat(64), user_version: 5 },
        patches: patches.map(({ from, to }) => ({
            name: `db_patch${suffix}_v${to}.json`, from, to, size: 10, sha256: 'd'.repeat(64)
        }))
    };
}

test('manifest validation rejects wrong, duplicate and missing patch versions', () => {
    const valid = validateDatabaseManifest(manifestWithPatches([{ from: 3, to: 4 }, { from: 4, to: 5 }]));
    assert.deepEqual(valid.patches.map(patch => patch.to), [4, 5]);
    assert.throws(() => validateDatabaseManifest(manifestWithPatches([{ from: 3, to: 5 }])), /range/);
    assert.throws(() => validateDatabaseManifest(manifestWithPatches([{ from: 3, to: 4 }, { from: 3, to: 4 }])), /duplicate/);
    assert.throws(() => validateDatabaseManifest(manifestWithPatches([{ from: 1, to: 2 }, { from: 3, to: 4 }])), /gap/);
});

test('manifest validation keeps standard and Xbox publication chains separate', () => {
    const xbox = validateDatabaseManifest(manifestWithPatches([{ from: 4, to: 5 }], 'xbox'), 'xbox');
    assert.equal(xbox.variant, 'xbox');
    assert.equal(xbox.database.name, 'database_xbox_v5.db');
    assert.throws(() => validateDatabaseManifest(manifestWithPatches([], 'xbox'), 'standard'), /variant/);
    const legacyStandard = manifestWithPatches([]);
    delete legacyStandard.variant;
    assert.equal(validateDatabaseManifest(legacyStandard).variant, 'standard');
});
