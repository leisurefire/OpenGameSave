const { createHash, randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

const {
    assertNoSymlinkAncestors,
    isPathInside,
    resolveInside
} = require('./validation');
const { normalizeManifestPath } = require('./webdavManifest');

const JOURNAL_VERSION = 1;
const JOURNAL_NAME = 'journal.json';
const MAX_JOURNAL_SIZE = 32 * 1024 * 1024;

function getTransactionBase(syncRoot) {
    const resolvedRoot = path.resolve(syncRoot);
    const comparisonRoot = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
    const rootKey = createHash('sha256').update(comparisonRoot).digest('hex').slice(0, 16);
    const transactionBase = path.join(path.dirname(resolvedRoot), `.OpenGameSave-transactions-${rootKey}`);
    if (isPathInside(resolvedRoot, transactionBase)) {
        throw new Error('WebDAV transaction storage must be outside the backup root');
    }
    return transactionBase;
}

async function ensureRegularDirectory(directoryPath) {
    await fs.promises.mkdir(directoryPath, { recursive: true, mode: 0o700 });
    const stats = await fs.promises.lstat(directoryPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Unsafe WebDAV transaction directory');
}

async function writeJournal(transaction) {
    const journalPath = path.join(transaction.transactionRoot, JOURNAL_NAME);
    const temporaryPath = `${journalPath}.${randomUUID()}.tmp`;
    const payload = JSON.stringify({
        version: JOURNAL_VERSION,
        syncRoot: transaction.syncRoot,
        state: transaction.state,
        entries: transaction.entries
    }, null, 2);
    try {
        const fileHandle = await fs.promises.open(temporaryPath, 'wx', 0o600);
        try {
            await fileHandle.writeFile(payload, 'utf8');
            await fileHandle.sync();
        } finally {
            await fileHandle.close();
        }
        await fs.promises.rename(temporaryPath, journalPath);
    } finally {
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
}

async function assertDiskSpace(directoryPath, requiredBytes) {
    if (typeof fs.promises.statfs !== 'function') return;
    const stats = await fs.promises.statfs(directoryPath);
    const availableBytes = BigInt(stats.bavail) * BigInt(stats.bsize);
    const reserveBytes = 64n * 1024n * 1024n;
    if (availableBytes < BigInt(requiredBytes) + reserveBytes) {
        throw new Error('Not enough free disk space for a transactional WebDAV download');
    }
}

function getStagedPath(transaction, relativePath) {
    const normalizedPath = normalizeManifestPath(relativePath);
    return resolveInside(transaction.transactionRoot, 'staged', ...normalizedPath.split('/'));
}

function getPreviousPath(transaction, relativePath) {
    const normalizedPath = normalizeManifestPath(relativePath);
    return resolveInside(transaction.transactionRoot, 'previous', ...normalizedPath.split('/'));
}

async function beginWebDAVTransaction(syncRoot, files) {
    const resolvedRoot = path.resolve(syncRoot);
    const transactionBase = getTransactionBase(resolvedRoot);
    await recoverWebDAVTransactions(resolvedRoot);
    await ensureRegularDirectory(transactionBase);
    await assertDiskSpace(transactionBase, files.reduce((total, file) => total + file.size, 0));

    const transactionRoot = resolveInside(transactionBase, randomUUID());
    await ensureRegularDirectory(transactionRoot);
    await ensureRegularDirectory(path.join(transactionRoot, 'staged'));
    await ensureRegularDirectory(path.join(transactionRoot, 'previous'));
    const transaction = {
        transactionRoot,
        syncRoot: resolvedRoot,
        state: 'downloading',
        entries: files.map(file => ({
            path: normalizeManifestPath(file.path),
            mtimeMs: file.mtimeMs,
            state: 'pending',
            hadOriginal: null
        }))
    };
    await writeJournal(transaction);
    return transaction;
}

async function pathStats(filePath) {
    return fs.promises.lstat(filePath).catch(error => {
        if (error?.code === 'ENOENT') return null;
        throw error;
    });
}

async function rollbackTransaction(transaction) {
    for (const entry of [...transaction.entries].reverse()) {
        const destinationPath = resolveInside(transaction.syncRoot, ...entry.path.split('/'));
        const stagedPath = getStagedPath(transaction, entry.path);
        const previousPath = getPreviousPath(transaction, entry.path);
        const previousStats = await pathStats(previousPath);
        if (previousStats) {
            if (!previousStats.isFile() || previousStats.isSymbolicLink()) {
                throw new Error('Invalid previous file in WebDAV transaction');
            }
            await fs.promises.rm(destinationPath, { force: true });
            await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
            await fs.promises.rename(previousPath, destinationPath);
            continue;
        }
        const stagedStats = await pathStats(stagedPath);
        if (!stagedStats && entry.state !== 'pending' && entry.hadOriginal === false) {
            await fs.promises.rm(destinationPath, { force: true });
        }
    }
    await fs.promises.rm(transaction.transactionRoot, { recursive: true, force: true });
}

async function installWebDAVTransaction(transaction) {
    await fs.promises.mkdir(transaction.syncRoot, { recursive: true });
    const rootStats = await fs.promises.lstat(transaction.syncRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new Error('The backup path is not a regular directory');
    }
    transaction.state = 'installing';
    await writeJournal(transaction);

    try {
        for (const entry of transaction.entries) {
            const stagedPath = getStagedPath(transaction, entry.path);
            const destinationPath = resolveInside(transaction.syncRoot, ...entry.path.split('/'));
            const previousPath = getPreviousPath(transaction, entry.path);
            const stagedStats = await fs.promises.lstat(stagedPath);
            if (!stagedStats.isFile() || stagedStats.isSymbolicLink()) {
                throw new Error(`Invalid staged WebDAV file: ${entry.path}`);
            }

            await assertNoSymlinkAncestors(transaction.syncRoot, destinationPath, fs);
            await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
            await assertNoSymlinkAncestors(transaction.syncRoot, destinationPath, fs);
            const existingStats = await pathStats(destinationPath);
            if (existingStats && (!existingStats.isFile() || existingStats.isSymbolicLink())) {
                throw new Error(`Refusing to replace non-file backup path: ${destinationPath}`);
            }

            entry.hadOriginal = Boolean(existingStats);
            entry.state = existingStats ? 'moving-previous' : 'installing';
            await writeJournal(transaction);
            if (existingStats) {
                await fs.promises.mkdir(path.dirname(previousPath), { recursive: true });
                await fs.promises.rename(destinationPath, previousPath);
                entry.state = 'previous-moved';
                await writeJournal(transaction);
                entry.state = 'installing';
                await writeJournal(transaction);
            }
            await fs.promises.rename(stagedPath, destinationPath);
            await fs.promises.utimes(destinationPath, new Date(entry.mtimeMs), new Date(entry.mtimeMs));
            entry.state = 'installed';
            await writeJournal(transaction);
        }
        transaction.state = 'committed';
        await writeJournal(transaction);
        await fs.promises.rm(transaction.transactionRoot, { recursive: true, force: true });
    } catch (error) {
        try {
            await rollbackTransaction(transaction);
        } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'WebDAV install failed and rollback needs recovery');
        }
        throw error;
    }
}

function validateJournal(rawJournal, expectedRoot, transactionRoot) {
    const journalRoot = typeof rawJournal?.syncRoot === 'string' ? path.resolve(rawJournal.syncRoot) : '';
    const rootsMatch = process.platform === 'win32'
        ? journalRoot.toLowerCase() === expectedRoot.toLowerCase()
        : journalRoot === expectedRoot;
    if (!rawJournal || typeof rawJournal !== 'object' || Array.isArray(rawJournal)
        || rawJournal.version !== JOURNAL_VERSION || !rootsMatch
        || !['downloading', 'installing', 'committed'].includes(rawJournal.state)
        || !Array.isArray(rawJournal.entries) || rawJournal.entries.length > 100000) {
        throw new Error('Invalid WebDAV transaction journal');
    }
    const seenPaths = new Set();
    const entries = rawJournal.entries.map(entry => {
        const relativePath = normalizeManifestPath(entry.path);
        const mtimeMs = Number(entry.mtimeMs);
        const state = String(entry.state || 'pending');
        if (seenPaths.has(relativePath) || !Number.isFinite(mtimeMs) || mtimeMs < 0
            || !['pending', 'moving-previous', 'previous-moved', 'installing', 'installed'].includes(state)
            || ![null, true, false].includes(entry.hadOriginal)) {
            throw new Error('Invalid WebDAV transaction journal entry');
        }
        seenPaths.add(relativePath);
        return {
            path: relativePath,
            mtimeMs,
            state,
            hadOriginal: entry.hadOriginal
        };
    });
    return {
        transactionRoot,
        syncRoot: expectedRoot,
        state: rawJournal.state,
        entries
    };
}

async function readJournal(transactionRoot, expectedRoot) {
    const journalPath = resolveInside(transactionRoot, JOURNAL_NAME);
    const stats = await fs.promises.lstat(journalPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_JOURNAL_SIZE) {
        throw new Error('Invalid WebDAV transaction journal');
    }
    let parsed;
    try {
        parsed = JSON.parse(await fs.promises.readFile(journalPath, 'utf8'));
    } catch (_) {
        throw new Error('Invalid WebDAV transaction journal');
    }
    return validateJournal(parsed, expectedRoot, transactionRoot);
}

async function recoverWebDAVTransactions(syncRoot) {
    const resolvedRoot = path.resolve(syncRoot);
    const transactionBase = getTransactionBase(resolvedRoot);
    const baseStats = await pathStats(transactionBase);
    if (!baseStats) return;
    if (!baseStats.isDirectory() || baseStats.isSymbolicLink()) throw new Error('Unsafe WebDAV transaction directory');

    const entries = await fs.promises.readdir(transactionBase, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe item in WebDAV transaction directory');
        const transactionRoot = resolveInside(transactionBase, entry.name);
        const transaction = await readJournal(transactionRoot, resolvedRoot);
        if (transaction.state === 'committed') {
            await fs.promises.rm(transactionRoot, { recursive: true, force: true });
        } else {
            await rollbackTransaction(transaction);
        }
    }
    await fs.promises.rmdir(transactionBase).catch(error => {
        if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error;
    });
}

async function abandonWebDAVTransaction(transaction) {
    if (!transaction) return;
    await rollbackTransaction(transaction);
}

module.exports = {
    abandonWebDAVTransaction,
    assertDiskSpace,
    beginWebDAVTransaction,
    getStagedPath,
    getTransactionBase,
    installWebDAVTransaction,
    recoverWebDAVTransactions
};
