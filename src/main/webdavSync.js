const { app } = require('electron');
const { createHash, randomUUID } = require('crypto');
const fsOriginal = require('original-fs');
const path = require('path');

const i18next = require('i18next');

const { getSettings } = require('./global');
const {
    assertNoSymlinkAncestors,
    normalizeBackupDate,
    normalizeWebDAVRemotePath,
    normalizeWebDAVUrl,
    normalizeWebDAVUsername,
    normalizeWikiId,
    resolveInside,
    validateBackupMetadata
} = require('./validation');
const {
    persistWebDAVProviderConfig,
    readWebDAVProviderConfig
} = require('./webdavCredentials');
const {
    createHardenedWebDAVClient,
    downloadResource,
    ensureDirectory,
    isPreconditionFailed,
    probeWebDAVCapabilities,
    putConditionalResource,
    putImmutableResource,
    readRemoteJson,
    resourceExists,
    verifyRemoteResource
} = require('./webdavClient');
const {
    listBackupInstanceFolders,
    listGameBackupFolders,
    normalizeSyncPath,
    pruneBackups
} = require('./syncBackupUtils');
const {
    CURRENT_NAME,
    MANIFEST_NAME,
    MANIFEST_VERSION,
    MAX_MANIFEST_SIZE,
    MAX_SYNC_FILES,
    MAX_SYNC_FILE_SIZE,
    getObjectPath,
    getSnapshotPath,
    joinRemotePath,
    normalizeManifestPath,
    validateCurrentPointer,
    validateLegacyManifest,
    validateManifestPathsAgainstMetadata,
    validateSnapshot
} = require('./webdavManifest');
const {
    allocateConflictBackupKey,
    createConflictMetadataBuffer,
    findConflictingBackupKeys,
    makeLocalConflictFiles,
    mapRemoteConflictFiles,
    mergeLocalFiles
} = require('./webdavMerge');
const {
    persistWebDAVSyncState,
    readWebDAVSyncState
} = require('./webdavSyncState');
const {
    abandonWebDAVTransaction,
    assertDiskSpace,
    beginWebDAVTransaction,
    getStagedPath,
    installWebDAVTransaction,
    recoverWebDAVTransactions
} = require('./webdavTransaction');

function getFallbackWebDAVSettings() {
    const settings = getSettings();
    return {
        url: normalizeWebDAVUrl(settings.webdavUrl, { allowEmpty: true }),
        username: normalizeWebDAVUsername(settings.webdavUsername || ''),
        remotePath: normalizeWebDAVRemotePath(settings.webdavRemotePath || '/OpenGameSave')
    };
}

function normalizeProviderConfig(config) {
    if (typeof config.password !== 'string') throw new Error('Invalid WebDAV password');
    const normalized = {
        url: normalizeWebDAVUrl(config.url, { allowEmpty: true }),
        username: normalizeWebDAVUsername(config.username || ''),
        remotePath: normalizeWebDAVRemotePath(config.remotePath || '/OpenGameSave'),
        deviceId: config.deviceId,
        password: config.password
    };
    if (Boolean(normalized.username) !== Boolean(normalized.password)) {
        throw new Error('WebDAV username and password must either both be provided or both be empty');
    }
    if (!normalized.url && (normalized.username || normalized.password)) {
        throw new Error('A WebDAV URL is required when credentials are configured');
    }
    return normalized;
}

async function getConfiguredWebDAVSettings() {
    return normalizeProviderConfig(await readWebDAVProviderConfig(getFallbackWebDAVSettings()));
}

async function getWebDAVPublicConfig() {
    const config = await getConfiguredWebDAVSettings();
    return {
        url: config.url,
        username: config.username,
        remotePath: config.remotePath,
        hasPassword: Boolean(config.password)
    };
}

async function saveWebDAVProviderConfig(input = {}) {
    const currentConfig = await readWebDAVProviderConfig(getFallbackWebDAVSettings());
    const hasPasswordUpdate = Object.prototype.hasOwnProperty.call(input, 'password');
    const url = normalizeWebDAVUrl(input.url, { allowEmpty: true });
    const username = normalizeWebDAVUsername(input.username || '');
    const remotePath = normalizeWebDAVRemotePath(input.remotePath || '/OpenGameSave');
    const password = !url && !username && !hasPasswordUpdate ? ''
        : (hasPasswordUpdate ? input.password : currentConfig.password);
    const config = normalizeProviderConfig({
        url,
        username,
        remotePath,
        password,
        deviceId: currentConfig.deviceId
    });
    await persistWebDAVProviderConfig(config);
    return getWebDAVPublicConfig();
}

async function createWebDAVClient(config = null) {
    const resolvedConfig = config || await getConfiguredWebDAVSettings();
    if (!resolvedConfig.url) throw new Error(i18next.t('alert.webdav_config_required'));
    return createHardenedWebDAVClient(resolvedConfig);
}

function sanitizeWebDAVError(error, config) {
    const status = Number(error?.status || error?.response?.status || 0);
    if (status === 401 || status === 403) return i18next.t('alert.webdav_auth_failed');
    let message = String(error?.message || error || i18next.t('alert.webdav_connection_failed'));
    message = message.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, '[redacted]');
    if (config?.username) message = message.replaceAll(config.username, '[user]');
    return message.slice(0, 2000);
}

async function hashFile(filePath) {
    const hash = createHash('sha256');
    const stream = fsOriginal.createReadStream(filePath);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
}

async function readLocalBackupMetadata(metadataPath) {
    const stats = await fsOriginal.promises.lstat(metadataPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 1024 * 1024) {
        throw new Error(`Invalid backup metadata file: ${metadataPath}`);
    }
    try {
        return validateBackupMetadata(JSON.parse(await fsOriginal.promises.readFile(metadataPath, 'utf8')));
    } catch (error) {
        if (error instanceof SyntaxError) throw new Error(`Invalid JSON in backup metadata: ${metadataPath}`);
        throw error;
    }
}

async function collectFile(files, syncRoot, filePath) {
    const stats = await fsOriginal.promises.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Unsupported backup file: ${filePath}`);
    if (stats.size > MAX_SYNC_FILE_SIZE) throw new Error(`Backup file is too large: ${filePath}`);
    const relativePath = normalizeManifestPath(path.relative(syncRoot, filePath).split(path.sep).join('/'));
    files.push({
        path: relativePath,
        localPath: filePath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        sha256: await hashFile(filePath)
    });
    if (files.length > MAX_SYNC_FILES) throw new Error('Too many files to synchronize');
}

async function collectBackupItem(files, syncRoot, itemPath) {
    const pending = [itemPath];
    while (pending.length > 0) {
        const currentPath = pending.pop();
        const stats = await fsOriginal.promises.lstat(currentPath);
        if (stats.isSymbolicLink()) throw new Error(`Refusing to sync symbolic link: ${currentPath}`);
        if (stats.isFile()) {
            await collectFile(files, syncRoot, currentPath);
            continue;
        }
        if (!stats.isDirectory()) throw new Error(`Unsupported item in backup folder: ${currentPath}`);
        normalizeManifestPath(path.relative(syncRoot, currentPath).split(path.sep).join('/'));
        const entries = await fsOriginal.promises.readdir(currentPath, { withFileTypes: true });
        entries.sort((left, right) => right.name.localeCompare(left.name));
        for (const entry of entries) pending.push(resolveInside(currentPath, entry.name));
    }
}

async function collectLocalBackupFiles(syncRoot) {
    const rootStats = await fsOriginal.promises.lstat(syncRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new Error('The backup path is not a regular directory');
    }

    const files = [];
    const metadataByBackup = new Map();
    for (const rawGameId of listGameBackupFolders(syncRoot).sort()) {
        const gameId = normalizeWikiId(rawGameId);
        const gamePath = resolveInside(syncRoot, gameId);
        for (const rawBackupId of listBackupInstanceFolders(gamePath).sort()) {
            const backupId = normalizeBackupDate(rawBackupId);
            const backupPath = resolveInside(gamePath, backupId);
            const metadataPath = resolveInside(backupPath, 'backup_info.json');
            const metadata = await readLocalBackupMetadata(metadataPath);
            const backupKey = `${gameId}/${backupId}`;
            metadataByBackup.set(backupKey, metadata);
            const allowedEntries = new Set(['backup_info.json', ...metadata.backup_paths.map(item => item.folder_name)]);
            const actualEntries = await fsOriginal.promises.readdir(backupPath, { withFileTypes: true });
            for (const entry of actualEntries) {
                if (!allowedEntries.has(entry.name)) {
                    throw new Error(`Backup contains an item not declared by backup_info.json: ${backupKey}/${entry.name}`);
                }
            }
            await collectFile(files, syncRoot, metadataPath);
            for (const backupItem of metadata.backup_paths) {
                const itemPath = resolveInside(backupPath, backupItem.folder_name);
                if (await fsOriginal.promises.lstat(itemPath).catch(error => {
                    if (error?.code === 'ENOENT') return null;
                    throw error;
                })) {
                    await collectBackupItem(files, syncRoot, itemPath);
                }
            }
        }
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    validateManifestPathsAgainstMetadata(files, metadataByBackup);
    return files;
}

async function readRemoteState(client, config, { required = false } = {}) {
    const currentPath = joinRemotePath(config.remotePath, CURRENT_NAME);
    const current = await readRemoteJson(client, currentPath, 64 * 1024, validateCurrentPointer, { required: false });
    if (current) {
        if (!current.etag) throw new Error('WebDAV current.json has no ETag; safe synchronization is unavailable');
        const snapshotPath = getSnapshotPath(config.remotePath, current.value.revision);
        const snapshot = (await readRemoteJson(client, snapshotPath, MAX_MANIFEST_SIZE, validateSnapshot)).value;
        if (snapshot.revision !== current.value.revision
            || snapshot.parentRevision !== current.value.parentRevision
            || snapshot.deviceId !== current.value.deviceId) {
            throw new Error('WebDAV current.json does not match its immutable snapshot');
        }
        return { snapshot, etag: current.etag, legacy: false };
    }

    const legacy = await readRemoteJson(
        client,
        joinRemotePath(config.remotePath, MANIFEST_NAME),
        MAX_MANIFEST_SIZE,
        validateLegacyManifest,
        { required: false }
    );
    if (legacy) return { snapshot: legacy.value, etag: '', legacy: true };
    if (required) throw new Error(i18next.t('alert.webdav_remote_empty'));
    return null;
}

function getRemoteFilePath(config, state, file) {
    return state?.legacy
        ? joinRemotePath(config.remotePath, file.remotePath || file.path)
        : getObjectPath(config.remotePath, file.sha256);
}

async function ensureContentObject(client, config, file, createdDirectories, verifiedObjects) {
    if (verifiedObjects.has(file.sha256)) return false;
    const objectPath = getObjectPath(config.remotePath, file.sha256);
    const parentPath = path.posix.dirname(objectPath);
    if (!createdDirectories.has(parentPath)) {
        await ensureDirectory(client, parentPath, { recursive: true });
        createdDirectories.add(parentPath);
    }
    const source = Buffer.isBuffer(file.data) ? file.data : file.localPath;
    const created = await putImmutableResource(client, objectPath, source, file.size);
    await verifyRemoteResource(client, objectPath, file.size, file.sha256);
    verifiedObjects.add(file.sha256);
    return created;
}

async function migrateLegacyObjects(client, config, state, createdDirectories, verifiedObjects) {
    if (!state?.legacy) return;
    const migrationRoot = await fsOriginal.promises.mkdtemp(path.join(app.getPath('temp'), 'OpenGameSave-webdav-migrate-'));
    try {
        await assertDiskSpace(
            migrationRoot,
            state.snapshot.files.reduce((total, file) => total + file.size, 0)
        );
        for (const file of state.snapshot.files) {
            if (verifiedObjects.has(file.sha256)) continue;
            const objectPath = getObjectPath(config.remotePath, file.sha256);
            if (await resourceExists(client, objectPath)) {
                await verifyRemoteResource(client, objectPath, file.size, file.sha256);
                verifiedObjects.add(file.sha256);
                continue;
            }
            const temporaryPath = resolveInside(migrationRoot, randomUUID());
            await downloadResource(client, joinRemotePath(config.remotePath, file.path), temporaryPath, file.size);
            if (await hashFile(temporaryPath) !== file.sha256) {
                throw new Error(`Legacy WebDAV file failed verification: ${file.path}`);
            }
            await ensureContentObject(
                client,
                config,
                { ...file, localPath: temporaryPath },
                createdDirectories,
                verifiedObjects
            );
            await fsOriginal.promises.rm(temporaryPath, { force: true });
        }
    } finally {
        await fsOriginal.promises.rm(migrationRoot, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function checkWebDAVSyncStatus() {
    let config;
    try {
        config = await getConfiguredWebDAVSettings();
    } catch (error) {
        return {
            configured: false,
            ready: false,
            remoteInitialized: false,
            endpoint: '',
            remotePath: '',
            message: sanitizeWebDAVError(error)
        };
    }
    const baseStatus = {
        configured: Boolean(config.url),
        ready: false,
        remoteInitialized: false,
        endpoint: config.url,
        remotePath: config.remotePath,
        message: ''
    };
    if (!config.url) {
        baseStatus.message = i18next.t('alert.webdav_config_required');
        return baseStatus;
    }

    try {
        const client = await createWebDAVClient(config);
        await probeWebDAVCapabilities(client, config);
        const state = await readRemoteState(client, config);
        return {
            ...baseStatus,
            ready: true,
            remoteInitialized: Boolean(state),
            fileCount: state?.snapshot.files.length || 0,
            legacy: state?.legacy === true,
            message: i18next.t(state ? 'alert.webdav_ready' : 'alert.webdav_ready_new')
        };
    } catch (error) {
        return { ...baseStatus, message: sanitizeWebDAVError(error, config) };
    }
}

async function uploadBackupsToWebDAV(syncPathSetting = null) {
    const syncPath = normalizeSyncPath(syncPathSetting || getSettings().backupPath || '');
    await recoverWebDAVTransactions(syncPath);
    const config = await getConfiguredWebDAVSettings();
    const client = await createWebDAVClient(config);
    await probeWebDAVCapabilities(client, config);
    await pruneBackups(syncPath);
    const localFiles = await collectLocalBackupFiles(syncPath);
    let state = await readRemoteState(client, config);
    const syncState = await readWebDAVSyncState(syncPath, config);
    const createdDirectories = new Set([config.remotePath]);
    const verifiedObjects = new Set(state && !state.legacy
        ? state.snapshot.files.map(file => file.sha256)
        : []);
    let uploadedFiles = 0;
    let uploadedBytes = 0;
    for (let publishAttempt = 0; publishAttempt < 5; publishAttempt += 1) {
        await migrateLegacyObjects(client, config, state, createdDirectories, verifiedObjects);
        const mergeResult = await mergeLocalFiles(
            state?.snapshot.files || [],
            localFiles,
            config.deviceId,
            syncState,
            state?.snapshot.deviceId || 'legacy'
        );
        for (const file of mergeResult.uploadFiles) {
            if (await ensureContentObject(client, config, file, createdDirectories, verifiedObjects)) {
                uploadedFiles += 1;
                uploadedBytes += file.size;
            }
        }

        const revision = randomUUID();
        const snapshot = validateSnapshot({
            version: MANIFEST_VERSION,
            revision,
            parentRevision: state?.snapshot.revision || null,
            deviceId: config.deviceId,
            generatedAt: new Date().toISOString(),
            files: mergeResult.files
        });
        const snapshotPayload = Buffer.from(JSON.stringify(snapshot, null, 2), 'utf8');
        if (snapshotPayload.length > MAX_MANIFEST_SIZE) throw new Error('WebDAV snapshot is too large');
        const snapshotsRoot = joinRemotePath(config.remotePath, 'snapshots');
        if (!createdDirectories.has(snapshotsRoot)) {
            await ensureDirectory(client, snapshotsRoot, { recursive: true });
            createdDirectories.add(snapshotsRoot);
        }
        if (!await putImmutableResource(client, getSnapshotPath(config.remotePath, revision), snapshotPayload, snapshotPayload.length)) {
            throw new Error('WebDAV snapshot revision collision');
        }

        const pointer = {
            version: MANIFEST_VERSION,
            revision,
            parentRevision: snapshot.parentRevision,
            deviceId: config.deviceId,
            generatedAt: snapshot.generatedAt
        };
        const pointerPayload = Buffer.from(JSON.stringify(pointer, null, 2), 'utf8');
        try {
            await putConditionalResource(
                client,
                joinRemotePath(config.remotePath, CURRENT_NAME),
                pointerPayload,
                pointerPayload.length,
                state?.etag || ''
            );
            await persistWebDAVSyncState(syncPath, config, {
                localFiles,
                remoteFiles: mergeResult.files,
                remoteRevision: revision
            });
            return {
                syncPath,
                games: listGameBackupFolders(syncPath).length,
                size: localFiles.reduce((total, file) => total + file.size, 0),
                uploadedFiles,
                uploadedBytes,
                conflicts: mergeResult.conflicts
            };
        } catch (error) {
            if (!isPreconditionFailed(error)) throw error;
            state = await readRemoteState(client, config, { required: true });
            if (!state.legacy) {
                for (const file of state.snapshot.files) verifiedObjects.add(file.sha256);
            }
        }
    }
    throw new Error('WebDAV current snapshot changed repeatedly; retry synchronization later');
}

async function localPathStats(filePath) {
    return fsOriginal.promises.lstat(filePath).catch(error => {
        if (error?.code === 'ENOENT') return null;
        throw error;
    });
}

async function allocateLocalConflictBackup(syncPath, originalKey, reservedKeys) {
    while (true) {
        const candidate = allocateConflictBackupKey(originalKey, reservedKeys);
        const candidatePath = resolveInside(syncPath, ...candidate.split('/'));
        if (!await localPathStats(candidatePath)) return candidate;
    }
}

async function prepareDownloadFiles(
    syncPath,
    remoteFiles,
    localFiles,
    localDeviceId,
    remoteDeviceId,
    syncState
) {
    const conflictingBackups = findConflictingBackupKeys(remoteFiles, localFiles, syncState);
    const remoteFallbackBackups = new Set();
    const localFilesByPath = new Map(localFiles.map(file => [file.path, file]));
    const reservedKeys = new Set([...remoteFiles, ...localFiles]
        .map(file => file.path.split('/').slice(0, 2).join('/')));
    for (const file of remoteFiles) {
        const destinationPath = resolveInside(syncPath, ...file.path.split('/'));
        await assertNoSymlinkAncestors(syncPath, destinationPath, fsOriginal);
        const stats = await localPathStats(destinationPath);
        if (!stats) continue;
        const backupKey = file.path.split('/').slice(0, 2).join('/');
        const collectedFile = localFilesByPath.get(file.path);
        if (!collectedFile || !stats.isFile() || stats.isSymbolicLink()) {
            conflictingBackups.add(backupKey);
            remoteFallbackBackups.add(backupKey);
            continue;
        }
        if (stats.size !== collectedFile.size || await hashFile(destinationPath) !== collectedFile.sha256) {
            throw new Error('A local backup changed while WebDAV reconciliation was being prepared; retry safely');
        }
    }

    const localConflictDestinations = new Map();
    const remoteConflictDestinations = new Map();
    const conflicts = [];
    for (const backupKey of conflictingBackups) {
        const conflictBackup = await allocateLocalConflictBackup(syncPath, backupKey, reservedKeys);
        const preserveRemote = remoteFallbackBackups.has(backupKey);
        (preserveRemote ? remoteConflictDestinations : localConflictDestinations)
            .set(backupKey, conflictBackup);
        conflicts.push({
            originalBackup: backupKey,
            conflictBackup,
            localDeviceId,
            remoteDeviceId,
            direction: 'download',
            originalVersion: preserveRemote ? 'local' : 'remote',
            conflictVersion: preserveRemote ? 'remote' : 'local'
        });
    }
    const files = mapRemoteConflictFiles(remoteFiles, remoteConflictDestinations, remoteDeviceId);
    files.push(...await makeLocalConflictFiles(localFiles, localConflictDestinations, localDeviceId));
    return { files, conflicts };
}

async function captureDownloadPreconditions(syncPath, files) {
    const preconditions = new Map();
    for (const file of files) {
        if (preconditions.has(file.path)) continue;
        const destinationPath = resolveInside(syncPath, ...file.path.split('/'));
        await assertNoSymlinkAncestors(syncPath, destinationPath, fsOriginal);
        const stats = await localPathStats(destinationPath);
        if (!stats) {
            preconditions.set(file.path, null);
            continue;
        }
        if (!stats.isFile() || stats.isSymbolicLink()) {
            throw new Error(`Refusing to replace non-file backup path: ${destinationPath}`);
        }
        preconditions.set(file.path, await hashFile(destinationPath));
    }
    return preconditions;
}

async function assertDownloadPreconditions(syncPath, preconditions) {
    for (const [relativePath, expectedHash] of preconditions) {
        const destinationPath = resolveInside(syncPath, ...relativePath.split('/'));
        await assertNoSymlinkAncestors(syncPath, destinationPath, fsOriginal);
        const stats = await localPathStats(destinationPath);
        const actualHash = stats?.isFile() && !stats.isSymbolicLink()
            ? await hashFile(destinationPath)
            : null;
        if (actualHash !== expectedHash) {
            throw new Error('A local backup changed while WebDAV files were downloading; retry to reconcile it safely');
        }
    }
}

async function downloadAndVerifyFile(client, config, state, transaction, file) {
    const stagedPath = getStagedPath(transaction, file.path);
    if (file.localConflictFile) {
        await fsOriginal.promises.mkdir(path.dirname(stagedPath), { recursive: true });
        if (Buffer.isBuffer(file.data)) {
            await fsOriginal.promises.writeFile(stagedPath, file.data, { flag: 'wx', mode: 0o600 });
        } else {
            await fsOriginal.promises.copyFile(file.localPath, stagedPath, fsOriginal.constants.COPYFILE_EXCL);
        }
    } else {
        await downloadResource(client, getRemoteFilePath(config, state, file), stagedPath, file.size);
    }
    if (await hashFile(stagedPath) !== file.sha256) {
        throw new Error(`WebDAV staged file hash verification failed: ${file.path}`);
    }
    if (file.conflictDeviceId && file.path.endsWith('/backup_info.json')) {
        const sourceMetadata = await fsOriginal.promises.readFile(stagedPath);
        await fsOriginal.promises.writeFile(
            stagedPath,
            createConflictMetadataBuffer(sourceMetadata, file.conflictDeviceId),
            { mode: 0o600 }
        );
    }
}

async function validateDownloadedMetadata(transaction, manifestFiles) {
    const metadataByBackup = new Map();
    for (const file of manifestFiles.filter(item => item.path.endsWith('/backup_info.json'))) {
        const backupKey = file.path.split('/').slice(0, 2).join('/');
        metadataByBackup.set(backupKey, await readLocalBackupMetadata(getStagedPath(transaction, file.path)));
    }
    validateManifestPathsAgainstMetadata(manifestFiles, metadataByBackup);
}

async function downloadBackupsFromWebDAV(syncPathSetting = null) {
    const syncPath = normalizeSyncPath(syncPathSetting || getSettings().backupPath || '');
    await recoverWebDAVTransactions(syncPath);
    const config = await getConfiguredWebDAVSettings();
    const client = await createWebDAVClient(config);
    await probeWebDAVCapabilities(client, config);
    const state = await readRemoteState(client, config, { required: true });
    const localFiles = await collectLocalBackupFiles(syncPath);
    const syncState = await readWebDAVSyncState(syncPath, config);
    const preparedDownload = await prepareDownloadFiles(
        syncPath,
        state.snapshot.files,
        localFiles,
        config.deviceId,
        state.snapshot.deviceId || 'legacy',
        syncState
    );
    const manifestFiles = preparedDownload.files;
    const downloadPreconditions = await captureDownloadPreconditions(syncPath, manifestFiles);
    let transaction = await beginWebDAVTransaction(syncPath, manifestFiles);

    try {
        const metadataFiles = manifestFiles.filter(file => file.path.endsWith('/backup_info.json'));
        for (const file of metadataFiles) await downloadAndVerifyFile(client, config, state, transaction, file);
        await validateDownloadedMetadata(transaction, manifestFiles);
        for (const file of manifestFiles) {
            if (!file.path.endsWith('/backup_info.json')) {
                await downloadAndVerifyFile(client, config, state, transaction, file);
            }
        }
        await assertDownloadPreconditions(syncPath, downloadPreconditions);
        await installWebDAVTransaction(transaction);
        transaction = null;
        await pruneBackups(syncPath);
    } finally {
        if (transaction) await abandonWebDAVTransaction(transaction).catch(() => undefined);
    }

    const reconciledLocalFiles = await collectLocalBackupFiles(syncPath);
    await persistWebDAVSyncState(syncPath, config, {
        localFiles: reconciledLocalFiles,
        remoteFiles: state.snapshot.files,
        remoteRevision: state.snapshot.revision || null
    });

    return {
        syncPath,
        games: listGameBackupFolders(syncPath).length,
        size: state.snapshot.files.reduce((total, file) => total + file.size, 0),
        downloadedFiles: state.snapshot.files.length,
        conflicts: preparedDownload.conflicts
    };
}

module.exports = {
    checkWebDAVSyncStatus,
    collectLocalBackupFiles,
    downloadBackupsFromWebDAV,
    getWebDAVPublicConfig,
    recoverWebDAVTransactions,
    saveWebDAVProviderConfig,
    uploadBackupsToWebDAV
};
