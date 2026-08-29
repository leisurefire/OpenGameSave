const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { restoreFileSystemPathsTransactionally } = require('../src/main/services/restoreFileSystemTransaction');

async function createFixture(t) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-restore-transaction-'));
    const backupRoot = path.join(root, 'backups');
    const allowedRoot = path.join(root, 'saves');
    await Promise.all([
        fs.promises.mkdir(backupRoot, { recursive: true }),
        fs.promises.mkdir(allowedRoot, { recursive: true })
    ]);
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    return { root, backupRoot, allowedRoot };
}

async function writeTree(root, files) {
    for (const [relativePath, value] of Object.entries(files)) {
        const targetPath = path.join(root, relativePath);
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.promises.writeFile(targetPath, value);
    }
}

test('folder restore replaces the snapshot and removes stale destination files', async (t) => {
    const { backupRoot, allowedRoot } = await createFixture(t);
    const sourcePath = path.join(backupRoot, 'game', 'snapshot', 'path1');
    const destinationPath = path.join(allowedRoot, 'Game', 'Save');
    await writeTree(sourcePath, { 'current.sav': 'new' });
    await writeTree(destinationPath, { 'current.sav': 'old', 'stale.sav': 'stale' });

    await restoreFileSystemPathsTransactionally([
        { sourcePath, destinationPath, allowedRoot, backupType: 'folder' }
    ], { backupRoot, idFactory: () => 'replace-test' });

    assert.equal(await fs.promises.readFile(path.join(destinationPath, 'current.sav'), 'utf8'), 'new');
    assert.equal(await fs.promises.lstat(path.join(destinationPath, 'stale.sav')).catch(() => null), null);
    assert.deepEqual((await fs.promises.readdir(allowedRoot)).filter(name => name.startsWith('.ogs-restore-')), []);
});

test('a later commit failure rolls every earlier destination back', async (t) => {
    const { backupRoot, allowedRoot } = await createFixture(t);
    const sourceOne = path.join(backupRoot, 'game', 'snapshot', 'path1');
    const sourceTwo = path.join(backupRoot, 'game', 'snapshot', 'path2');
    const destinationOne = path.join(allowedRoot, 'GameOne', 'Save');
    const destinationTwo = path.join(allowedRoot, 'GameTwo', 'Save');
    await writeTree(sourceOne, { 'state.sav': 'new-one' });
    await writeTree(sourceTwo, { 'state.sav': 'new-two' });
    await writeTree(destinationOne, { 'state.sav': 'old-one' });
    await writeTree(destinationTwo, { 'state.sav': 'old-two' });

    let renameCount = 0;
    let injected = false;
    const failingPromises = new Proxy(fs.promises, {
        get(target, property, receiver) {
            if (property === 'rename') {
                return async (...args) => {
                    renameCount += 1;
                    if (renameCount === 4 && !injected) {
                        injected = true;
                        const error = new Error('simulated activation failure');
                        error.code = 'EIO';
                        throw error;
                    }
                    return target.rename(...args);
                };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
    const failingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'promises') return failingPromises;
            return Reflect.get(target, property, receiver);
        }
    });

    await assert.rejects(
        () => restoreFileSystemPathsTransactionally([
            { sourcePath: sourceOne, destinationPath: destinationOne, allowedRoot, backupType: 'folder' },
            { sourcePath: sourceTwo, destinationPath: destinationTwo, allowedRoot, backupType: 'folder' }
        ], { backupRoot, fsAdapter: failingFs, idFactory: () => 'rollback-test' }),
        /simulated activation failure/
    );

    assert.equal(await fs.promises.readFile(path.join(destinationOne, 'state.sav'), 'utf8'), 'old-one');
    assert.equal(await fs.promises.readFile(path.join(destinationTwo, 'state.sav'), 'utf8'), 'old-two');
    assert.deepEqual((await fs.promises.readdir(allowedRoot)).filter(name => name.startsWith('.ogs-restore-')), []);
});

test('restore rejects overlapping destinations before changing either one', async (t) => {
    const { backupRoot, allowedRoot } = await createFixture(t);
    const sourceOne = path.join(backupRoot, 'game', 'snapshot', 'path1');
    const sourceTwo = path.join(backupRoot, 'game', 'snapshot', 'path2');
    await writeTree(sourceOne, { 'state.sav': 'one' });
    await writeTree(sourceTwo, { 'state.sav': 'two' });

    await assert.rejects(
        () => restoreFileSystemPathsTransactionally([
            { sourcePath: sourceOne, destinationPath: path.join(allowedRoot, 'Game'), allowedRoot, backupType: 'folder' },
            { sourcePath: sourceTwo, destinationPath: path.join(allowedRoot, 'Game', 'nested'), allowedRoot, backupType: 'folder' }
        ], { backupRoot }),
        /overlap/
    );
});

test('external folder payloads cannot smuggle executable content into an authorized save directory', async (t) => {
    const { backupRoot, allowedRoot } = await createFixture(t);
    const sourcePath = path.join(backupRoot, 'game', 'snapshot', 'path1');
    const destinationPath = path.join(allowedRoot, 'Game', 'Save');
    await writeTree(sourcePath, { 'slot.sav': 'save', 'plugins/payload.DLL': 'not-a-library' });
    await writeTree(destinationPath, { 'slot.sav': 'original' });

    await assert.rejects(
        () => restoreFileSystemPathsTransactionally([
            { sourcePath, destinationPath, allowedRoot, backupType: 'folder', untrusted: true }
        ], { backupRoot, idFactory: () => 'external-payload-test' }),
        /executable or script payload/
    );
    assert.equal(await fs.promises.readFile(path.join(destinationPath, 'slot.sav'), 'utf8'), 'original');
    assert.deepEqual((await fs.promises.readdir(allowedRoot)).filter(name => name.startsWith('.ogs-restore-')), []);
});
