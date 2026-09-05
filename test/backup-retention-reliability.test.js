const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { setWorkerContext } = require('../src/main/services/backupWorkerContext');
const { backupGame } = require('../src/main/services/backupWorkerOperations');

async function createFixture(t, previousDate = '2020-01-01_00-00-00') {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-retention-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const backupPath = path.join(root, 'backups');
    const previousPath = path.join(backupPath, '123', previousDate);
    await fs.promises.mkdir(previousPath, { recursive: true });
    await fs.promises.writeFile(path.join(previousPath, 'old.sav'), 'old recovery data');
    const source = path.join(root, 'save.dat');
    await fs.promises.writeFile(source, 'new recovery data');
    setWorkerContext({ settings: { backupPath, maxBackups: 1, language: 'en_US' } });
    return {
        backupPath,
        previousPath,
        game: {
            wiki_page_id: '123', title: 'Retention Regression',
            resolved_paths: [{ resolved: source, finalTemplate: '{{p|appdata}}/Game/save.dat' }]
        }
    };
}

test('retention failure keeps the completed new snapshot and reports backup success', async (t) => {
    const { backupPath, previousPath, game } = await createFixture(t);
    const originalRmSync = fs.rmSync;
    const originalWarn = console.warn;
    const warnings = [];
    fs.rmSync = (target, options) => {
        if (target === previousPath) throw new Error('historical snapshot is locked');
        return originalRmSync(target, options);
    };
    console.warn = message => warnings.push(message);
    try {
        assert.equal(await backupGame(game), null);
    } finally {
        fs.rmSync = originalRmSync;
        console.warn = originalWarn;
    }
    const snapshots = await fs.promises.readdir(path.join(backupPath, '123'));
    assert.equal(snapshots.length, 2);
    const latest = snapshots.find(name => name !== path.basename(previousPath));
    assert.equal(await fs.promises.readFile(path.join(backupPath, '123', latest, 'path1', 'save.dat'), 'utf8'), 'new recovery data');
    assert.match(warnings.join('\n'), /historical snapshot is locked/);
});

test('retention preserves the new snapshot when the system clock moves backwards', async (t) => {
    const { backupPath, previousPath, game } = await createFixture(t, '2099-01-01_00-00-00');
    assert.equal(await backupGame(game), null);
    const snapshots = await fs.promises.readdir(path.join(backupPath, '123'));
    assert.equal(snapshots.length, 1);
    assert.notEqual(snapshots[0], path.basename(previousPath));
    assert.equal(await fs.promises.readFile(path.join(backupPath, '123', snapshots[0], 'path1', 'save.dat'), 'utf8'), 'new recovery data');
});
