const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('better-sqlite3');
const yaml = require('js-yaml');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const GAME_COLUMNS = `
    CREATE TABLE games (
        wiki_page_id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        zh_CN TEXT,
        install_folder TEXT,
        steam_id INTEGER,
        gog_id INTEGER,
        platform TEXT,
        save_location TEXT NOT NULL
    )`;

function createDatabase(filePath, version, rows, metadata = []) {
    const db = new Database(filePath);
    db.exec(GAME_COLUMNS);
    db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)');
    const insert = db.prepare(`
        INSERT INTO games
            (wiki_page_id, title, zh_CN, install_folder, steam_id, gog_id, platform, save_location)
        VALUES
            (@wiki_page_id, @title, NULL, NULL, NULL, NULL, '[]', @save_location)
    `);
    for (const row of rows) {
        insert.run({ ...row, save_location: JSON.stringify({ win: row.paths || [] }) });
    }
    const insertMetadata = db.prepare('INSERT INTO metadata (key, value) VALUES (@key, @value)');
    for (const row of metadata) insertMetadata.run(row);
    db.pragma(`user_version = ${version}`);
    db.close();
}

test('database patch publisher advances the previous published version sequentially', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-db-patch-'));
    try {
        const oldPath = path.join(tempDir, 'old.db');
        const newPath = path.join(tempDir, 'new.db');
        const outputPath = path.join(tempDir, 'output');
        createDatabase(oldPath, 4, [
            { wiki_page_id: 1, title: 'Existing', paths: ['C:/old'] },
            { wiki_page_id: 2, title: 'Removed', paths: ['C:/removed'] }
        ], [{ key: 'source', value: 'old' }]);
        createDatabase(newPath, 0, [
            { wiki_page_id: 1, title: 'Existing', paths: ['C:/new'] },
            { wiki_page_id: 3, title: 'Added', paths: ['C:/added'] }
        ], [{ key: 'source', value: 'new' }, { key: 'added', value: 'yes' }]);

        execFileSync(process.execPath, [
            path.join(PROJECT_ROOT, 'scripts', 'generate-db-patch.js'),
            '--from', oldPath,
            '--to', newPath,
            '--output', outputPath
        ], { cwd: PROJECT_ROOT, stdio: 'pipe' });

        const patch = JSON.parse(fs.readFileSync(path.join(outputPath, 'db_patch_v5.json'), 'utf8'));
        assert.equal(patch.from_version, 4);
        assert.equal(patch.version, 5);
        assert.deepEqual(patch.upsert.map(row => row.wiki_page_id).sort(), [1, 3]);
        assert.deepEqual(patch.delete, [2]);
        assert.deepEqual(patch.metadata_upsert.map(row => row.key).sort(), ['added', 'source']);

        const publishedDb = new Database(newPath, { readonly: true });
        assert.equal(publishedDb.pragma('user_version', { simple: true }), 5);
        assert.equal(publishedDb.pragma('quick_check', { simple: true }), 'ok');
        publishedDb.close();
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('an empty semantic diff does not advance user_version or create a patch', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-db-no-change-'));
    try {
        const oldPath = path.join(tempDir, 'old.db');
        const newPath = path.join(tempDir, 'new.db');
        const outputPath = path.join(tempDir, 'output');
        const rows = [{ wiki_page_id: 1, title: 'Same', paths: ['C:/same'] }];
        createDatabase(oldPath, 9, rows, [{ key: 'source', value: 'same' }]);
        createDatabase(newPath, 0, rows, [{ key: 'source', value: 'same' }]);
        execFileSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'generate-db-patch.js'), '--from', oldPath, '--to', newPath, '--output', outputPath]);
        const result = JSON.parse(fs.readFileSync(path.join(outputPath, 'generation-result.json')));
        assert.equal(result.changed, false);
        assert.equal(result.version, 9);
        assert.equal(fs.readdirSync(outputPath).some(name => name.startsWith('db_patch_')), false);
        const db = new Database(newPath, { readonly: true });
        assert.equal(db.pragma('user_version', { simple: true }), 0);
        db.close();
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('Xbox publication uses an independent immutable asset namespace', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-db-xbox-'));
    try {
        const oldPath = path.join(tempDir, 'old.db');
        const newPath = path.join(tempDir, 'new.db');
        const generatedPath = path.join(tempDir, 'generated');
        const publishedPath = path.join(tempDir, 'published');
        const metadata = [{ key: 'database_variant', value: 'xbox' }];
        createDatabase(oldPath, 3, [{ wiki_page_id: 1, title: 'Game', paths: ['C:/old'] }], metadata);
        createDatabase(newPath, 0, [{ wiki_page_id: 1, title: 'Game', paths: ['C:/new'] }], metadata);
        execFileSync(process.execPath, [
            path.join(PROJECT_ROOT, 'scripts', 'generate-db-patch.js'),
            '--from', oldPath, '--to', newPath, '--output', generatedPath,
            '--source-sha', 'a'.repeat(64), '--variant', 'xbox'
        ]);
        execFileSync(process.execPath, [
            path.join(PROJECT_ROOT, 'scripts', 'build-db-release.js'),
            '--database', newPath,
            '--result', path.join(generatedPath, 'generation-result.json'),
            '--output', publishedPath,
            '--source-sha', 'a'.repeat(64), '--variant', 'xbox'
        ]);

        assert.deepEqual(fs.readdirSync(publishedPath).sort(), [
            'current_xbox.json',
            'database_xbox_v4.db',
            'db_patch_xbox_v4.json',
            'manifest_xbox_v4.json'
        ]);
        const pointer = JSON.parse(fs.readFileSync(path.join(publishedPath, 'current_xbox.json'), 'utf8'));
        const manifest = JSON.parse(fs.readFileSync(path.join(publishedPath, pointer.manifest), 'utf8'));
        assert.equal(pointer.variant, 'xbox');
        assert.equal(manifest.variant, 'xbox');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('schema changes require a full database instead of a data patch', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-db-schema-'));
    try {
        const oldPath = path.join(tempDir, 'old.db');
        const newPath = path.join(tempDir, 'new.db');
        const outputPath = path.join(tempDir, 'output');
        createDatabase(oldPath, 2, [{ wiki_page_id: 1, title: 'Game', paths: [] }]);
        createDatabase(newPath, 0, [{ wiki_page_id: 1, title: 'Game', paths: [] }]);
        const db = new Database(newPath);
        db.exec('CREATE INDEX games_title_index ON games(title)');
        db.close();
        execFileSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'generate-db-patch.js'), '--from', oldPath, '--to', newPath, '--output', outputPath]);
        const result = JSON.parse(fs.readFileSync(path.join(outputPath, 'generation-result.json')));
        assert.equal(result.changed, true);
        assert.equal(result.requires_full_database, true);
        assert.equal(result.version, 3);
        assert.equal(fs.readdirSync(outputPath).some(name => name.startsWith('db_patch_')), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('retrying the same source commit generates byte-identical immutable patches', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-db-retry-'));
    try {
        const oldPath = path.join(tempDir, 'old.db');
        createDatabase(oldPath, 6, [{ wiki_page_id: 1, title: 'Old', paths: [] }]);
        const outputs = [];
        for (const suffix of ['one', 'two']) {
            const newPath = path.join(tempDir, `${suffix}.db`);
            const outputPath = path.join(tempDir, suffix);
            createDatabase(newPath, 0, [{ wiki_page_id: 1, title: 'New', paths: [] }]);
            execFileSync(process.execPath, [
                path.join(PROJECT_ROOT, 'scripts', 'generate-db-patch.js'), '--from', oldPath,
                '--to', newPath, '--output', outputPath, '--source-sha', 'a'.repeat(40)
            ]);
            outputs.push(fs.readFileSync(path.join(outputPath, 'db_patch_v7.json')));
        }
        assert.deepEqual(outputs[0], outputs[1]);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('database publication workflow runs automatically and targets a dedicated release', () => {
    const workflowPath = path.join(PROJECT_ROOT, '.github', 'workflows', 'db-patch.yml');
    const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8'));
    assert.ok(workflow.on.push.paths.includes('database/database.db'));
    assert.ok(Array.isArray(workflow.on.schedule));
    assert.ok(workflow.on.workflow_dispatch !== undefined);
    assert.equal(workflow.permissions.contents, 'write');
    assert.equal(workflow.jobs.publish.env.DATABASE_TAG, 'database');
    const workflowSource = fs.readFileSync(workflowPath, 'utf8');
    assert.match(workflowSource, /pointer="current\$\{suffix\}\.json"/);
    assert.match(workflowSource, /suffix='_xbox'/);
    assert.match(workflowSource, /database-xbox-source/);
    assert.doesNotMatch(workflowSource, /pull-requests:/);
    const releaseBuilderSource = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'build-db-release.js'), 'utf8');
    assert.match(releaseBuilderSource, /getDatabaseAssetNames/);
    assert.doesNotMatch(workflowSource, /db_patch[^\n]*--clobber/);

    const updaterSource = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'main', 'backup.js'), 'utf8');
    assert.match(updaterSource, /releases\/tags\/database/);
    assert.doesNotMatch(updaterSource, /repos\/leisurefire\/OpenGameSave\/releases\/latest/);
});
