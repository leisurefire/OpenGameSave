const { app } = require('electron');
const { createHash, randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

const {
    MAX_MANIFEST_SIZE,
    MAX_SYNC_FILES,
    SHA256_PATTERN,
    caseFoldPath,
    normalizeManifestPath
} = require('./webdavManifest');

const SYNC_STATE_VERSION = 1;
const MAX_SYNC_STATE_SIZE = (MAX_MANIFEST_SIZE * 2) + (1024 * 1024);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let stateWriteQueue = Promise.resolve();

function normalizeLocalRoot(syncRoot) {
    const resolvedRoot = path.resolve(syncRoot);
    return process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
}

function getStateTargetKey(syncRoot, config) {
    return createHash('sha256').update(JSON.stringify([
        normalizeLocalRoot(syncRoot),
        config.url,
        config.username,
        config.remotePath
    ])).digest('hex');
}

function getWebDAVSyncStatePath(syncRoot, config) {
    const targetKey = getStateTargetKey(syncRoot, config);
    return path.join(app.getPath('userData'), 'OGS Settings', `webdav-sync-${targetKey}.json`);
}

function normalizeHashList(rawFiles) {
    if (!Array.isArray(rawFiles) || rawFiles.length > MAX_SYNC_FILES) {
        throw new Error('Invalid WebDAV sync hash list');
    }
    const seenPaths = new Set();
    const files = rawFiles.map(file => {
        const relativePath = normalizeManifestPath(file?.path);
        const foldedPath = caseFoldPath(relativePath);
        const sha256 = String(file?.sha256 || '').toLowerCase();
        if (seenPaths.has(foldedPath) || !SHA256_PATTERN.test(sha256)) {
            throw new Error('Invalid WebDAV sync hash list');
        }
        seenPaths.add(foldedPath);
        return { path: relativePath, sha256 };
    });
    files.sort((left, right) => left.path.localeCompare(right.path));
    return files;
}

function validateWebDAVSyncState(rawState, targetKey) {
    if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)
        || rawState.version !== SYNC_STATE_VERSION || rawState.targetKey !== targetKey
        || (rawState.remoteRevision !== null && !UUID_PATTERN.test(rawState.remoteRevision))) {
        throw new Error('Invalid WebDAV sync state');
    }
    return {
        version: SYNC_STATE_VERSION,
        targetKey,
        remoteRevision: rawState.remoteRevision?.toLowerCase() || null,
        localFiles: normalizeHashList(rawState.localFiles),
        remoteFiles: normalizeHashList(rawState.remoteFiles)
    };
}

async function readWebDAVSyncState(syncRoot, config) {
    const targetKey = getStateTargetKey(syncRoot, config);
    const statePath = getWebDAVSyncStatePath(syncRoot, config);
    try {
        const stats = await fs.promises.lstat(statePath);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_SYNC_STATE_SIZE) {
            throw new Error('Invalid WebDAV sync state');
        }
        const rawState = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
        return validateWebDAVSyncState(rawState, targetKey);
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            console.warn('Ignoring unusable WebDAV sync state; conflicts will be handled conservatively:', error.message);
        }
        return null;
    }
}

async function writeStateFile(statePath, state) {
    const payload = JSON.stringify(state, null, 2);
    if (Buffer.byteLength(payload) > MAX_SYNC_STATE_SIZE) throw new Error('WebDAV sync state is too large');
    const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.promises.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
    try {
        const fileHandle = await fs.promises.open(temporaryPath, 'wx', 0o600);
        try {
            await fileHandle.writeFile(payload, 'utf8');
            await fileHandle.sync();
        } finally {
            await fileHandle.close();
        }
        await fs.promises.rename(temporaryPath, statePath);
    } finally {
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
}

async function persistWebDAVSyncState(syncRoot, config, { localFiles, remoteFiles, remoteRevision }) {
    const targetKey = getStateTargetKey(syncRoot, config);
    const state = validateWebDAVSyncState({
        version: SYNC_STATE_VERSION,
        targetKey,
        remoteRevision: remoteRevision || null,
        localFiles,
        remoteFiles
    }, targetKey);
    const statePath = getWebDAVSyncStatePath(syncRoot, config);
    stateWriteQueue = stateWriteQueue.catch(() => undefined).then(() => writeStateFile(statePath, state));
    return stateWriteQueue;
}

module.exports = {
    getStateTargetKey,
    normalizeHashList,
    persistWebDAVSyncState,
    readWebDAVSyncState,
    validateWebDAVSyncState
};
