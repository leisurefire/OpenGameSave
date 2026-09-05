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
    const journalPath = path.join(transaction.transactionRoot, 'journal.json');
    const legacyJournal = JSON.parse(await fs.promises.readFile(journalPath, 'utf8'));
    legacyJournal.version = 1;
    await fs.promises.writeFile(journalPath, JSON.stringify(legacyJournal));

    await recoverWebDAVTransactions(syncRoot);
    assert.equal(await fs.promises.readFile(destinationPath, 'utf8'), 'original');
    assert.equal(fs.existsSync(getTransactionBase(syncRoot)), false);
});

test('recovery refuses a replaced backup ancestor without changing files outside the root', async (context) => {
    const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-webdav-recovery-link-'));
    context.after(() => fs.promises.rm(temporaryDirectory, { recursive: true, force: true }));
    const syncRoot = path.join(temporaryDirectory, 'backups');
    const externalRoot = path.join(temporaryDirectory, 'external');
    const externalFile = path.join(externalRoot, ...RELATIVE_PATH.split('/').slice(1));
    await fs.promises.mkdir(path.dirname(externalFile), { recursive: true });
    await fs.promises.writeFile(externalFile, 'external');
    await fs.promises.mkdir(syncRoot);
    const transaction = await beginWebDAVTransaction(syncRoot, [{ path: RELATIVE_PATH, size: 3, mtimeMs: Date.now() }]);
    const previousPath = path.join(transaction.transactionRoot, 'previous', ...RELATIVE_PATH.split('/'));
    await fs.promises.mkdir(path.dirname(previousPath), { recursive: true });
    await fs.promises.writeFile(previousPath, 'old');
    try {
        await fs.promises.symlink(externalRoot, path.join(syncRoot, '123'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (['EPERM', 'EACCES'].includes(error.code)) return context.skip('Creating directory links requires permission');
        throw error;
    }

    await assert.rejects(recoverWebDAVTransactions(syncRoot), /symbolic link/);
    assert.equal(await fs.promises.readFile(externalFile, 'utf8'), 'external');
    assert.equal(await fs.promises.readFile(previousPath, 'utf8'), 'old');
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

test('transaction journal writes grow linearly with the installed file list', async (context) => {
    const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-webdav-journal-cost-'));
    context.after(() => fs.promises.rm(temporaryDirectory, { recursive: true, force: true }));
    const syncRoot = path.join(temporaryDirectory, 'backups');
    const files = Array.from({ length: 12 }, (_, index) => ({
        path: `123/2026-08-18_10-00-00/path1/save-${index}.dat`, size: 3, mtimeMs: Date.now()
    }));
    let writtenBytes = 0;
    const realOpen = fs.promises.open;
    context.mock.method(fs.promises, 'open', async (...args) => {
        const handle = await realOpen(...args);
        const realWrite = handle.writeFile.bind(handle);
        handle.writeFile = async (data, ...writeArgs) => {
            writtenBytes += Buffer.byteLength(data);
            return realWrite(data, ...writeArgs);
        };
        return handle;
    });
    const transaction = await beginWebDAVTransaction(syncRoot, files);
    const initialBytes = writtenBytes;
    for (const file of files) {
        const stagedPath = getStagedPath(transaction, file.path);
        await fs.promises.mkdir(path.dirname(stagedPath), { recursive: true });
        await fs.promises.writeFile(stagedPath, 'new');
    }
    await installWebDAVTransaction(transaction);
    assert.ok(writtenBytes < initialBytes * 3, `journal wrote ${writtenBytes} bytes for a ${initialBytes}-byte file list`);
});

test('recovery replays durable progress and ignores a torn final append', async (context) => {
    const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-webdav-progress-recovery-'));
    context.after(() => fs.promises.rm(temporaryDirectory, { recursive: true, force: true }));
    const syncRoot = path.join(temporaryDirectory, 'backups');
    const transaction = await beginWebDAVTransaction(syncRoot, [{ path: RELATIVE_PATH, size: 3, mtimeMs: Date.now() }]);
    const destinationPath = path.join(syncRoot, ...RELATIVE_PATH.split('/'));
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.promises.writeFile(destinationPath, 'new');
    await fs.promises.writeFile(path.join(transaction.transactionRoot, 'journal-updates.jsonl'),
        '{"state":"installing"}\n{"index":0,"state":"installing","hadOriginal":false}\n{"index":');

    await recoverWebDAVTransactions(syncRoot);

    assert.equal(fs.existsSync(destinationPath), false);
    assert.equal(fs.existsSync(transaction.transactionRoot), false);
});

test('cleanup failure after commit preserves installed data and is retried at recovery', async (context) => {
    const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-webdav-committed-'));
    context.after(() => fs.promises.rm(temporaryDirectory, { recursive: true, force: true }));
    const syncRoot = path.join(temporaryDirectory, 'backups');
    const destinationPath = path.join(syncRoot, ...RELATIVE_PATH.split('/'));
    const transaction = await beginWebDAVTransaction(syncRoot, [{ path: RELATIVE_PATH, size: 3, mtimeMs: Date.now() }]);
    const stagedPath = getStagedPath(transaction, RELATIVE_PATH);
    await fs.promises.mkdir(path.dirname(stagedPath), { recursive: true });
    await fs.promises.writeFile(stagedPath, 'new');
    const realRemove = fs.promises.rm;
    const cleanupRoot = `${transaction.transactionRoot}.committed`;
    const removal = context.mock.method(fs.promises, 'rm', async (target, ...args) => {
        if (target === cleanupRoot) {
            await realRemove(path.join(cleanupRoot, 'journal.json'), { force: true });
            throw Object.assign(new Error('cleanup busy'), { code: 'EBUSY' });
        }
        return realRemove(target, ...args);
    });

    await installWebDAVTransaction(transaction);
    assert.equal(await fs.promises.readFile(destinationPath, 'utf8'), 'new');
    assert.equal(fs.existsSync(cleanupRoot), true);
    removal.mock.restore();
    await recoverWebDAVTransactions(syncRoot);
    assert.equal(await fs.promises.readFile(destinationPath, 'utf8'), 'new');
    assert.equal(fs.existsSync(cleanupRoot), false);
});
