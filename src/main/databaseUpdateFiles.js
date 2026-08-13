'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function getBackupPath(dbPath) {
    return `${dbPath}.bak`;
}

function getNewFilePrefix(dbPath) {
    return `${path.basename(dbPath)}.new-`;
}

function createNewDatabasePath(dbPath) {
    return `${dbPath}.new-${crypto.randomUUID()}`;
}

async function fsyncFile(filePath) {
    const handle = await fs.promises.open(filePath, 'r+');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function fsyncDirectory(directoryPath) {
    let handle;
    try {
        handle = await fs.promises.open(directoryPath, 'r');
        await handle.sync();
    } catch (error) {
        // Windows does not consistently allow directory handles to be flushed.
        if (process.platform !== 'win32') throw error;
    } finally {
        await handle?.close();
    }
}

async function calculateFileSha256(filePath) {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
}

function normalizeSha256(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.toLowerCase().replace(/^sha256:/, '');
    return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

async function verifyFileDescriptor(filePath, descriptor, { maxBytes } = {}) {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile() || stats.size <= 0 || (maxBytes && stats.size > maxBytes)) {
        throw new Error('Downloaded asset has an invalid size');
    }
    if (descriptor?.size !== undefined && stats.size !== descriptor.size) {
        throw new Error('Downloaded asset size does not match the manifest');
    }
    const expectedSha256 = normalizeSha256(descriptor?.sha256 || descriptor?.digest);
    if (!expectedSha256) throw new Error('Published asset is missing a valid SHA-256 digest');
    const actualSha256 = await calculateFileSha256(filePath);
    if (actualSha256 !== expectedSha256) throw new Error('Downloaded asset SHA-256 digest does not match');
    return { size: stats.size, sha256: actualSha256 };
}

async function atomicInstallDatabase(newPath, dbPath, validateDatabase, faultInjector = null) {
    const bakPath = getBackupPath(dbPath);
    const directoryPath = path.dirname(dbPath);
    await fsyncFile(newPath);
    await validateDatabase(newPath);
    await fsyncDirectory(directoryPath);

    // A valid active database means an older .bak is no longer needed. Recovery is
    // always run before this function, so deleting it cannot discard the sole copy.
    if (fs.existsSync(bakPath)) await fs.promises.rm(bakPath, { force: true });

    let movedActive = false;
    try {
        await faultInjector?.('before-backup-rename');
        if (fs.existsSync(dbPath)) {
            await fs.promises.rename(dbPath, bakPath);
            movedActive = true;
            await fsyncDirectory(directoryPath);
        }
        await faultInjector?.('before-activate-rename');
        await fs.promises.rename(newPath, dbPath);
        await fsyncDirectory(directoryPath);
        await validateDatabase(dbPath);
        await faultInjector?.('before-backup-delete');
        if (movedActive) await fs.promises.rm(bakPath, { force: true });
        await fsyncDirectory(directoryPath);
    } catch (error) {
        if (movedActive && fs.existsSync(bakPath)) {
            const failedPath = `${dbPath}.failed-${crypto.randomUUID()}`;
            if (fs.existsSync(dbPath)) await fs.promises.rename(dbPath, failedPath).catch(() => undefined);
            if (!fs.existsSync(dbPath)) await fs.promises.rename(bakPath, dbPath).catch(() => undefined);
            await fs.promises.rm(failedPath, { force: true }).catch(() => undefined);
            await fsyncDirectory(directoryPath).catch(() => undefined);
        }
        throw error;
    }
}

async function listRecoveryCandidates(dbPath) {
    const directoryPath = path.dirname(dbPath);
    const baseName = path.basename(dbPath);
    const names = await fs.promises.readdir(directoryPath).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    const accepted = new Set([baseName, `${baseName}.bak`, `${baseName}.temp`]);
    return names
        .filter(name => accepted.has(name) || name.startsWith(getNewFilePrefix(dbPath)))
        .map(name => path.join(directoryPath, name));
}

async function recoverDatabaseFiles(dbPath, inspectDatabase) {
    await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });
    const candidates = await listRecoveryCandidates(dbPath);
    const inspected = [];
    for (const candidatePath of candidates) {
        try {
            const result = await inspectDatabase(candidatePath);
            inspected.push({ path: candidatePath, version: result.version });
        } catch (_) {
            // Invalid partial files are removed only after a valid candidate is active.
        }
    }
    if (inspected.length === 0) {
        for (const candidatePath of candidates) await fs.promises.rm(candidatePath, { force: true });
        return { recovered: false, version: 0 };
    }

    const priority = candidatePath => candidatePath === dbPath ? 2 : candidatePath === getBackupPath(dbPath) ? 1 : 0;
    inspected.sort((left, right) => right.version - left.version || priority(right.path) - priority(left.path));
    const selected = inspected[0];
    if (selected.path !== dbPath) {
        const displacedPath = `${dbPath}.invalid-${crypto.randomUUID()}`;
        if (fs.existsSync(dbPath)) await fs.promises.rename(dbPath, displacedPath);
        try {
            await fs.promises.rename(selected.path, dbPath);
            await fsyncDirectory(path.dirname(dbPath));
            await inspectDatabase(dbPath);
        } catch (error) {
            if (!fs.existsSync(dbPath) && fs.existsSync(displacedPath)) {
                await fs.promises.rename(displacedPath, dbPath).catch(() => undefined);
            }
            throw error;
        }
    }
    for (const candidatePath of await listRecoveryCandidates(dbPath)) {
        if (candidatePath !== dbPath) await fs.promises.rm(candidatePath, { force: true });
    }
    for (const name of await fs.promises.readdir(path.dirname(dbPath))) {
        if (name.startsWith(`${path.basename(dbPath)}.invalid-`)) {
            await fs.promises.rm(path.join(path.dirname(dbPath), name), { force: true });
        }
    }
    return { recovered: selected.path !== dbPath, version: selected.version };
}

module.exports = {
    atomicInstallDatabase,
    calculateFileSha256,
    createNewDatabasePath,
    getBackupPath,
    normalizeSha256,
    recoverDatabaseFiles,
    verifyFileDescriptor
};
