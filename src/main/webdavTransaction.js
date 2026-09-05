const { createHash, randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

const {
    assertNoSymlinkAncestors,
    isPathInside,
    normalizeBackupDate,
    normalizeWikiId,
    resolveInside
} = require('./validation');
const { normalizeManifestPath } = require('./webdavManifest');

const JOURNAL_VERSION = 2;
const JOURNAL_NAME = 'journal.json';
const JOURNAL_UPDATES_NAME = 'journal-updates.jsonl';
const MAX_JOURNAL_SIZE = 32 * 1024 * 1024;
const MAX_JOURNAL_UPDATES_SIZE = 64 * 1024 * 1024;

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

async function writeJournal(transaction, entryIndex = null) {
    if (transaction.journalCreated) {
        // Persist only the changed entry. Rewriting the complete file list for
        // every rename turns a large restore into quadratic I/O and allocation.
        const entry = entryIndex === null ? null : transaction.entries[entryIndex];
        const update = entry
            ? { index: entryIndex, state: entry.state, hadOriginal: entry.hadOriginal }
            : { state: transaction.state };
        const handle = await fs.promises.open(path.join(transaction.transactionRoot, JOURNAL_UPDATES_NAME), 'a', 0o600);
        try {
            await handle.writeFile(`${JSON.stringify(update)}\n`, 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        return;
    }
    const journalPath = path.join(transaction.transactionRoot, JOURNAL_NAME);
    const temporaryPath = `${journalPath}.${randomUUID()}.tmp`;
    const payload = JSON.stringify({
        version: JOURNAL_VERSION,
        syncRoot: transaction.syncRoot,
        state: transaction.state,
        entries: transaction.entries
    }, null, 2);
    if (Buffer.byteLength(payload, 'utf8') > MAX_JOURNAL_SIZE) {
        throw new Error('WebDAV transaction journal is too large');
    }
    try {
        const fileHandle = await fs.promises.open(temporaryPath, 'wx', 0o600);
        try {
            await fileHandle.writeFile(payload, 'utf8');
            await fileHandle.sync();
        } finally {
            await fileHandle.close();
        }
        await fs.promises.rename(temporaryPath, journalPath);
        transaction.journalCreated = true;
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
    const normalizedPath = normalizeTransactionPath(relativePath);
    return resolveInside(transaction.transactionRoot, 'previous', ...normalizedPath.split('/'));
}

function getStagedTreePath(transaction, relativePath) {
    const normalizedPath = normalizeTransactionPath(relativePath);
    if (normalizedPath.split('/').length !== 2) throw new Error('Invalid WebDAV replacement tree');
    return resolveInside(transaction.transactionRoot, 'staged', ...normalizedPath.split('/'));
}

function normalizeTransactionPath(relativePath) {
    if (typeof relativePath !== 'string') throw new Error('Invalid WebDAV transaction path');
    const segments = relativePath.split('/');
    if (segments.length === 2) {
        return `${normalizeWikiId(segments[0])}/${normalizeBackupDate(segments[1])}`;
    }
    return normalizeManifestPath(relativePath);
}

async function beginWebDAVTransaction(syncRoot, files, { replaceTreePaths = [] } = {}) {
    const resolvedRoot = path.resolve(syncRoot);
    const transactionBase = getTransactionBase(resolvedRoot);
    await recoverWebDAVTransactions(resolvedRoot);
    await ensureRegularDirectory(transactionBase);
    await assertDiskSpace(transactionBase, files.reduce((total, file) => total + file.size, 0));

    const transactionRoot = resolveInside(transactionBase, randomUUID());
    const normalizedTreePaths = new Set(replaceTreePaths.map((relativePath) => {
        const normalizedPath = normalizeTransactionPath(relativePath);
        if (normalizedPath.split('/').length !== 2) throw new Error('Invalid WebDAV replacement tree');
        return normalizedPath;
    }));
    const transaction = {
        transactionRoot,
        syncRoot: resolvedRoot,
        state: 'downloading',
        entries: files.filter(file => !normalizedTreePaths.has(file.path.split('/').slice(0, 2).join('/')))
            .map(file => ({
                path: normalizeManifestPath(file.path),
                mtimeMs: file.mtimeMs,
                operation: 'replace',
                state: 'pending',
                hadOriginal: null
            })).concat([...normalizedTreePaths].map(relativePath => ({
                path: relativePath,
                mtimeMs: 0,
                operation: 'replace-tree',
                state: 'pending',
                hadOriginal: null
            })))
    };
    try {
        await ensureRegularDirectory(transactionRoot);
        await ensureRegularDirectory(path.join(transactionRoot, 'staged'));
        await ensureRegularDirectory(path.join(transactionRoot, 'previous'));
        await writeJournal(transaction);
    } catch (error) {
        await fs.promises.rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
    return transaction;
}

async function pathStats(filePath) {
    return fs.promises.lstat(filePath).catch(error => {
        if (error?.code === 'ENOENT') return null;
        throw error;
    });
}

async function rollbackTransaction(transaction) {
    for (let index = transaction.entries.length - 1; index >= 0; index -= 1) {
        const entry = transaction.entries[index];
        const destinationPath = resolveInside(transaction.syncRoot, ...entry.path.split('/'));
        const stagedPath = entry.operation === 'replace-tree'
            ? getStagedTreePath(transaction, entry.path)
            : getStagedPath(transaction, entry.path);
        const previousPath = getPreviousPath(transaction, entry.path);
        await assertNoSymlinkAncestors(transaction.syncRoot, destinationPath, fs);
        await assertNoSymlinkAncestors(transaction.transactionRoot, previousPath, fs);
        await assertNoSymlinkAncestors(transaction.transactionRoot, stagedPath, fs);
        const previousStats = await pathStats(previousPath);
        if (previousStats) {
            const isExpectedType = entry.operation === 'replace-tree'
                ? previousStats.isDirectory()
                : previousStats.isFile();
            if (!isExpectedType || previousStats.isSymbolicLink()) {
                throw new Error('Invalid previous file in WebDAV transaction');
            }
            await fs.promises.rm(destinationPath, {
                recursive: entry.operation === 'replace-tree',
                force: true
            });
            await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
            await fs.promises.rename(previousPath, destinationPath);
            continue;
        }
        const stagedStats = await pathStats(stagedPath);
        if (!stagedStats && entry.state !== 'pending' && entry.hadOriginal === false) {
            await fs.promises.rm(destinationPath, {
                recursive: entry.operation === 'replace-tree',
                force: true
            });
        }
    }
    await fs.promises.rm(transaction.transactionRoot, { recursive: true, force: true });
}

async function cleanupCommittedTransaction(transaction) {
    // The directory name remains a durable commit marker even if cleanup
    // removes the journal and then fails halfway through removing old files.
    const cleanupRoot = `${transaction.transactionRoot}.committed`;
    await fs.promises.rename(transaction.transactionRoot, cleanupRoot);
    await fs.promises.rm(cleanupRoot, { recursive: true, force: true });
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
        for (const [entryIndex, entry] of transaction.entries.entries()) {
            const destinationPath = resolveInside(transaction.syncRoot, ...entry.path.split('/'));
            const previousPath = getPreviousPath(transaction, entry.path);
            await assertNoSymlinkAncestors(transaction.syncRoot, destinationPath, fs);
            const existingStats = await pathStats(destinationPath);
            const isTreeReplacement = entry.operation === 'replace-tree';
            if (existingStats && (existingStats.isSymbolicLink()
                || (isTreeReplacement ? !existingStats.isDirectory() : !existingStats.isFile()))) {
                throw new Error(`Refusing to replace non-file backup path: ${destinationPath}`);
            }

            entry.hadOriginal = Boolean(existingStats);
            entry.state = existingStats ? 'moving-previous' : 'installing';
            await writeJournal(transaction, entryIndex);
            if (existingStats) {
                await fs.promises.mkdir(path.dirname(previousPath), { recursive: true });
                await fs.promises.rename(destinationPath, previousPath);
                entry.state = 'previous-moved';
                await writeJournal(transaction, entryIndex);
            }
            if (isTreeReplacement) {
                const stagedTreePath = getStagedTreePath(transaction, entry.path);
                const stagedTreeStats = await fs.promises.lstat(stagedTreePath);
                if (!stagedTreeStats.isDirectory() || stagedTreeStats.isSymbolicLink()) {
                    throw new Error(`Invalid staged WebDAV backup tree: ${entry.path}`);
                }
                await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
                await assertNoSymlinkAncestors(transaction.syncRoot, destinationPath, fs);
                entry.state = 'installing';
                await writeJournal(transaction, entryIndex);
                await fs.promises.rename(stagedTreePath, destinationPath);
                entry.state = 'installed';
                await writeJournal(transaction, entryIndex);
                continue;
            }
            const stagedPath = getStagedPath(transaction, entry.path);
            const stagedStats = await fs.promises.lstat(stagedPath);
            if (!stagedStats.isFile() || stagedStats.isSymbolicLink()) {
                throw new Error(`Invalid staged WebDAV file: ${entry.path}`);
            }
            await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
            await assertNoSymlinkAncestors(transaction.syncRoot, destinationPath, fs);
            entry.state = 'installing';
            await writeJournal(transaction, entryIndex);
            await fs.promises.rename(stagedPath, destinationPath);
            await fs.promises.utimes(destinationPath, new Date(entry.mtimeMs), new Date(entry.mtimeMs));
            entry.state = 'installed';
            await writeJournal(transaction, entryIndex);
        }
        transaction.state = 'committed';
        await writeJournal(transaction);
    } catch (error) {
        try {
            await rollbackTransaction(transaction);
        } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'WebDAV install failed and rollback needs recovery');
        }
        throw error;
    }
    // Once committed, cleanup must never roll back an installation: removal may
    // already have deleted part of the previous data. Recovery retries cleanup.
    await cleanupCommittedTransaction(transaction).catch(() => undefined);
}

function validateJournal(rawJournal, expectedRoot, transactionRoot) {
    const journalRoot = typeof rawJournal?.syncRoot === 'string' ? path.resolve(rawJournal.syncRoot) : '';
    const rootsMatch = process.platform === 'win32'
        ? journalRoot.toLowerCase() === expectedRoot.toLowerCase()
        : journalRoot === expectedRoot;
    if (!rawJournal || typeof rawJournal !== 'object' || Array.isArray(rawJournal)
        || ![1, JOURNAL_VERSION].includes(rawJournal.version) || !rootsMatch
        || !['downloading', 'installing', 'committed'].includes(rawJournal.state)
        || !Array.isArray(rawJournal.entries) || rawJournal.entries.length > 100000) {
        throw new Error('Invalid WebDAV transaction journal');
    }
    const seenPaths = new Set();
    const entries = rawJournal.entries.map(entry => {
        const operation = entry.operation || 'replace';
        if (!['replace', 'replace-tree'].includes(operation)) {
            throw new Error('Invalid WebDAV transaction journal entry');
        }
        const relativePath = operation === 'replace-tree'
            ? normalizeTransactionPath(entry.path)
            : normalizeManifestPath(entry.path);
        if ((operation === 'replace-tree') !== (relativePath.split('/').length === 2)) {
            throw new Error('Invalid WebDAV transaction journal entry');
        }
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
            operation,
            state,
            hadOriginal: entry.hadOriginal
        };
    });
    const replacementTrees = new Set(entries
        .filter(entry => entry.operation === 'replace-tree')
        .map(entry => entry.path));
    if (entries.some(entry => entry.operation !== 'replace-tree'
        && replacementTrees.has(entry.path.split('/').slice(0, 2).join('/')))) {
        throw new Error('Invalid overlapping WebDAV transaction journal entries');
    }
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
    const updatesPath = resolveInside(transactionRoot, JOURNAL_UPDATES_NAME);
    const updateStats = await pathStats(updatesPath);
    if (updateStats) {
        if (!updateStats.isFile() || updateStats.isSymbolicLink() || updateStats.size > MAX_JOURNAL_UPDATES_SIZE) {
            throw new Error('Invalid WebDAV transaction updates');
        }
        const updates = await fs.promises.readFile(updatesPath, 'utf8');
        // A crash may leave an incomplete final append. Its operation could not
        // have started because each complete record is synced before mutation.
        const completeUpdates = updates.slice(0, updates.lastIndexOf('\n') + 1);
        for (const line of completeUpdates.split('\n')) {
            if (!line) continue;
            let update;
            try { update = JSON.parse(line); } catch (_) {
                throw new Error('Invalid WebDAV transaction updates');
            }
            if (!update || typeof update !== 'object' || Array.isArray(update)) {
                throw new Error('Invalid WebDAV transaction updates');
            }
            if (Object.hasOwn(update, 'index')) {
                if (!Number.isInteger(update.index) || !parsed.entries?.[update.index]) {
                    throw new Error('Invalid WebDAV transaction update index');
                }
                parsed.entries[update.index].state = update.state;
                parsed.entries[update.index].hadOriginal = update.hadOriginal;
            } else {
                parsed.state = update.state;
            }
        }
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
        if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.committed$/i.test(entry.name)) {
            await fs.promises.rm(transactionRoot, { recursive: true, force: true });
            continue;
        }
        const transaction = await readJournal(transactionRoot, resolvedRoot);
        if (transaction.state === 'committed') {
            await cleanupCommittedTransaction(transaction);
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
