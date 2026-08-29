const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function loadSyncBackupUtils(settings) {
    const modulePath = path.resolve(__dirname, '../src/main/syncBackupUtils.js');
    const originalLoad = Module._load;
    Module._load = function loadWithMocks(request, parent, isMain) {
        if (request === 'original-fs') return fs;
        if (request === './global') return { getSettings: () => settings };
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve(modulePath)];
    try {
        return require(modulePath);
    } finally {
        Module._load = originalLoad;
    }
}

async function writeBackup(root, gameId, backupId, metadata) {
    const backupPath = path.join(root, gameId, backupId);
    await fs.promises.mkdir(backupPath, { recursive: true });
    await fs.promises.writeFile(
        path.join(backupPath, 'backup_info.json'),
        typeof metadata === 'string' ? metadata : JSON.stringify(metadata),
        'utf8'
    );
    return backupPath;
}

test('retention is asynchronous and never deletes a backup with invalid metadata', async (context) => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-sync-retention-'));
    context.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const gameId = '123';
    const metadata = { title: 'Game', backup_paths: [] };
    const oldBackup = await writeBackup(root, gameId, '2025-01-01_00-00-00', metadata);
    const newBackup = await writeBackup(root, gameId, '2025-01-02_00-00-00', metadata);
    const damagedBackup = await writeBackup(root, gameId, '2025-01-03_00-00-00', '{broken');
    const service = loadSyncBackupUtils({ backupPath: root, maxBackups: 1 });

    assert.deepEqual(await service.listGameBackupFolders(root), [gameId]);
    await service.pruneBackups(root);

    assert.equal(await fs.promises.lstat(oldBackup).catch(() => null), null);
    assert.equal((await fs.promises.lstat(newBackup)).isDirectory(), true);
    assert.equal((await fs.promises.lstat(damagedBackup)).isDirectory(), true);
});
