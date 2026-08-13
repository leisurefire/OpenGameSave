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

function createDatabase(filePath, version, rows) {
    const db = new Database(filePath);
    db.exec(GAME_COLUMNS);
    const insert = db.prepare(`
        INSERT INTO games
            (wiki_page_id, title, zh_CN, install_folder, steam_id, gog_id, platform, save_location)
        VALUES
            (@wiki_page_id, @title, NULL, NULL, NULL, NULL, '[]', @save_location)
    `);
    for (const row of rows) {
        insert.run({ ...row, save_location: JSON.stringify({ win: row.paths || [] }) });
    }
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
        ]);
        createDatabase(newPath, 0, [
            { wiki_page_id: 1, title: 'Existing', paths: ['C:/new'] },
            { wiki_page_id: 3, title: 'Added', paths: ['C:/added'] }
        ]);

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

        const publishedDb = new Database(newPath, { readonly: true });
        assert.equal(publishedDb.pragma('user_version', { simple: true }), 5);
        assert.equal(publishedDb.pragma('quick_check', { simple: true }), 'ok');
        publishedDb.close();
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('database publication workflow runs automatically and targets a dedicated release', () => {
    const workflowPath = path.join(PROJECT_ROOT, '.github', 'workflows', 'db-patch.yml');
    const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8'));
    assert.ok(workflow.on.push.paths.includes('database/database.db'));
    assert.ok(workflow.on.workflow_dispatch !== undefined);
    assert.equal(workflow.permissions.contents, 'write');
    assert.equal(workflow.jobs.publish.env.DATABASE_TAG, 'database');

    const updaterSource = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'main', 'backup.js'), 'utf8');
    assert.match(updaterSource, /releases\/tags\/database/);
    assert.doesNotMatch(updaterSource, /repos\/leisurefire\/OpenGameSave\/releases\/latest/);
});
