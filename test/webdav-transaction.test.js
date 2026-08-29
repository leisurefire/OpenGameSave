const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    beginWebDAVTransaction,
    getStagedPath,
    getTransactionBase,
    installWebDAVTransaction,
    recoverWebDAVTransactions
} = require('../src/main/webdavTransaction');

const RELATIVE_PATH = '123/2026-08-18_10-00-00/path1/save.dat';

test('WebDAV downloads commit as an external recoverable transaction', async (context) => {
    const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-webdav-transaction-'));
    context.after(() => fs.promises.rm(temporaryDirectory, { recursive: true, force: true }));
    const syncRoot = path.join(temporaryDirectory, 'backups');
    const destinationPath = path.join(syncRoot, ...RELATIVE_PATH.split('/'));
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.promises.writeFile(destinationPath, 'old');

    const transaction = await beginWebDAVTransaction(syncRoot, [{
        path: RELATIVE_PATH,
        size: 3,
        mtimeMs: Date.now()
    }]);
    assert.equal(path.relative(syncRoot, transaction.transactionRoot).startsWith('..'), true);
    const stagedPath = getStagedPath(transaction, RELATIVE_PATH);
    await fs.promises.mkdir(path.dirname(stagedPath), { recursive: true });
    await fs.promises.writeFile(stagedPath, 'new');
    await installWebDAVTransaction(transaction);

    assert.equal(await fs.promises.readFile(destinationPath, 'utf8'), 'new');
    assert.equal(fs.existsSync(transaction.transactionRoot), false);
});

test('startup recovery restores a file moved before a transaction was committed', async (context) => {
    const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-webdav-recovery-'));
    context.after(() => fs.promises.rm(temporaryDirectory, { recursive: true, force: true }));
    const syncRoot = path.join(temporaryDirectory, 'backups');
    const destinationPath = path.join(syncRoot, ...RELATIVE_PATH.split('/'));
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.promises.writeFile(destinationPath, 'original');

    const transaction = await beginWebDAVTransaction(syncRoot, [{
        path: RELATIVE_PATH,
        size: 3,
        mtimeMs: Date.now()
    }]);
    const stagedPath = getStagedPath(transaction, RELATIVE_PATH);
    await fs.promises.mkdir(path.dirname(stagedPath), { recursive: true });
    await fs.promises.writeFile(stagedPath, 'new');
    const previousPath = path.join(transaction.transactionRoot, 'previous', ...RELATIVE_PATH.split('/'));
    await fs.promises.mkdir(path.dirname(previousPath), { recursive: true });
    await fs.promises.rename(destinationPath, previousPath);

    await recoverWebDAVTransactions(syncRoot);
    assert.equal(await fs.promises.readFile(destinationPath, 'utf8'), 'original');
    assert.equal(fs.existsSync(getTransactionBase(syncRoot)), false);
});

test('remote-authoritative backups replace the complete tree through the journal', async (context) => {
    const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-webdav-replace-tree-'));
    context.after(() => fs.promises.rm(temporaryDirectory, { recursive: true, force: true }));
    const syncRoot = path.join(temporaryDirectory, 'backups');
    const backupKey = '123/2026-08-18_10-00-00';
    const backupPath = path.join(syncRoot, ...backupKey.split('/'));
    await fs.promises.mkdir(path.join(backupPath, 'path1'), { recursive: true });
    await fs.promises.writeFile(path.join(backupPath, 'backup_info.json'), '{"old":true}');
    await fs.promises.writeFile(path.join(backupPath, 'path1', 'stale.dat'), 'stale');

    const replacementFiles = [{
        path: `${backupKey}/backup_info.json`, size: 2, mtimeMs: Date.now()
    }, {
        path: `${backupKey}/path1/save.dat`, size: 3, mtimeMs: Date.now()
    }];
    const transaction = await beginWebDAVTransaction(syncRoot, replacementFiles, {
        replaceTreePaths: [backupKey]
    });
    for (const [file, content] of [[replacementFiles[0], '{}'], [replacementFiles[1], 'new']]) {
        const stagedPath = getStagedPath(transaction, file.path);
        await fs.promises.mkdir(path.dirname(stagedPath), { recursive: true });
        await fs.promises.writeFile(stagedPath, content);
    }
    await installWebDAVTransaction(transaction);

    assert.equal(await fs.promises.readFile(path.join(backupPath, 'path1', 'save.dat'), 'utf8'), 'new');
    assert.equal(fs.existsSync(path.join(backupPath, 'path1', 'stale.dat')), false);
    assert.equal(fs.existsSync(transaction.transactionRoot), false);
});

test('startup recovery restores a backup tree moved for replacement before commit', async (context) => {
    const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-webdav-tree-recovery-'));
    context.after(() => fs.promises.rm(temporaryDirectory, { recursive: true, force: true }));
    const syncRoot = path.join(temporaryDirectory, 'backups');
    const backupKey = '123/2026-08-18_10-00-00';
    const backupPath = path.join(syncRoot, ...backupKey.split('/'));
    await fs.promises.mkdir(path.join(backupPath, 'path1'), { recursive: true });
    await fs.promises.writeFile(path.join(backupPath, 'path1', 'save.dat'), 'save');

    const transaction = await beginWebDAVTransaction(syncRoot, [], { replaceTreePaths: [backupKey] });
    const previousPath = path.join(transaction.transactionRoot, 'previous', ...backupKey.split('/'));
    await fs.promises.mkdir(path.dirname(previousPath), { recursive: true });
    await fs.promises.rename(backupPath, previousPath);

    await recoverWebDAVTransactions(syncRoot);
    assert.equal(await fs.promises.readFile(path.join(backupPath, 'path1', 'save.dat'), 'utf8'), 'save');
});
