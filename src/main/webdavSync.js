const { app } = require('electron');
const { createHash, randomUUID } = require('crypto');
const fsOriginal = require('original-fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const i18next = require('i18next');

const { getSettings, saveSettings } = require('./global');
const { assertNoSymlinkAncestors } = require('./validation');
const {
    normalizeWebDAVRemotePath,
    normalizeWebDAVUrl,
    normalizeWebDAVUsername
} = require('./validation');
const {
    hasStoredWebDAVPassword,
    persistWebDAVPassword,
    readWebDAVPassword
} = require('./webdavCredentials');
const {
    listBackupInstanceFolders,
    listGameBackupFolders,
    normalizeSyncPath,
    pruneBackups
} = require('./syncBackupUtils');
const {
    MANIFEST_NAME,
    MANIFEST_VERSION,
    MAX_MANIFEST_SIZE,
    MAX_SYNC_FILES,
    MAX_SYNC_FILE_SIZE,
    joinRemotePath,
    validateManifest
} = require('./webdavManifest');

function getConfiguredWebDAVSettings() {
    const settings = getSettings();
    return {
        url: normalizeWebDAVUrl(settings.webdavUrl, { allowEmpty: true }),
        username: normalizeWebDAVUsername(settings.webdavUsername || ''),
        remotePath: normalizeWebDAVRemotePath(settings.webdavRemotePath || '/OpenGameSave')
    };
}

async function getWebDAVPublicConfig() {
    const config = getConfiguredWebDAVSettings();
    return { ...config, hasPassword: await hasStoredWebDAVPassword() };
}

async function saveWebDAVProviderConfig(input = {}) {
    const url = normalizeWebDAVUrl(input.url, { allowEmpty: true });
    const username = normalizeWebDAVUsername(input.username || '');
    const remotePath = normalizeWebDAVRemotePath(input.remotePath || '/OpenGameSave');
    const hasPasswordUpdate = Object.prototype.hasOwnProperty.call(input, 'password');

    if (hasPasswordUpdate) await persistWebDAVPassword(input.password);
    await saveSettings({
        webdavUrl: url,
        webdavUsername: username,
        webdavRemotePath: remotePath
    });
    return getWebDAVPublicConfig();
}

async function createWebDAVClient(config = getConfiguredWebDAVSettings()) {
    if (!config.url) throw new Error(i18next.t('alert.webdav_config_required'));
    const password = await readWebDAVPassword();
    const { AuthType, createClient } = await import('webdav');
    const hasCredentials = Boolean(config.username || password);
    return createClient(config.url, {
        authType: hasCredentials ? AuthType.Auto : AuthType.None,
        username: config.username,
        password
    });
}

function sanitizeWebDAVError(error, config) {
    const status = Number(error?.status || error?.response?.status || 0);
    if (status === 401 || status === 403) return i18next.t('alert.webdav_auth_failed');
    let message = String(error?.message || error || i18next.t('alert.webdav_connection_failed'));
    const passwordPatterns = [/Basic\s+[A-Za-z0-9+/=]+/gi];
    for (const pattern of passwordPatterns) message = message.replace(pattern, '[redacted]');
    if (config?.username) message = message.replaceAll(config.username, '[user]');
    return message.slice(0, 2000);
}

async function readStreamWithLimit(stream, maximumBytes) {
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maximumBytes) {
            stream.destroy();
            throw new Error('WebDAV manifest is too large');
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
}

async function readRemoteManifest(client, remoteRoot, { required = false } = {}) {
    const remoteManifestPath = joinRemotePath(remoteRoot, MANIFEST_NAME);
    if (!await client.exists(remoteManifestPath)) {
        if (required) throw new Error(i18next.t('alert.webdav_remote_empty'));
        return null;
    }
    const payload = await readStreamWithLimit(client.createReadStream(remoteManifestPath), MAX_MANIFEST_SIZE);
    try {
        return validateManifest(JSON.parse(payload.toString('utf8')));
    } catch (error) {
        if (error instanceof SyntaxError) throw new Error('Invalid WebDAV backup manifest');
        throw error;
    }
}

async function hashFile(filePath) {
    const hash = createHash('sha256');
    const stream = fsOriginal.createReadStream(filePath);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
}

async function collectLocalBackupFiles(syncRoot) {
    const rootStats = await fsOriginal.promises.lstat(syncRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new Error('The backup path is not a regular directory');
    }

    const files = [];
    for (const gameId of listGameBackupFolders(syncRoot).sort()) {
        const gamePath = path.join(syncRoot, gameId);
        for (const backupId of listBackupInstanceFolders(gamePath).sort()) {
            const backupPath = path.join(gamePath, backupId);
            const pending = [backupPath];
            while (pending.length > 0) {
                const currentPath = pending.pop();
                const entries = await fsOriginal.promises.readdir(currentPath, { withFileTypes: true });
                entries.sort((left, right) => right.name.localeCompare(left.name));
                for (const entry of entries) {
                    const entryPath = path.join(currentPath, entry.name);
                    if (entry.isSymbolicLink()) throw new Error(`Refusing to sync symbolic link: ${entryPath}`);
                    if (entry.isDirectory()) {
                        pending.push(entryPath);
                        continue;
                    }
                    if (!entry.isFile()) throw new Error(`Unsupported file type in backup folder: ${entryPath}`);
                    const stats = await fsOriginal.promises.lstat(entryPath);
                    if (stats.size > MAX_SYNC_FILE_SIZE) throw new Error(`Backup file is too large: ${entryPath}`);
                    files.push({
                        path: path.relative(syncRoot, entryPath).split(path.sep).join('/'),
                        localPath: entryPath,
                        size: stats.size,
                        mtimeMs: stats.mtimeMs,
                        sha256: await hashFile(entryPath)
                    });
                    if (files.length > MAX_SYNC_FILES) throw new Error('Too many files to synchronize');
                }
            }
        }
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    return files;
}

async function ensureRemoteParent(client, remoteFilePath, createdDirectories) {
    const parent = path.posix.dirname(remoteFilePath);
    if (createdDirectories.has(parent)) return;
    await client.createDirectory(parent, { recursive: true });
    createdDirectories.add(parent);
}

async function writeRemoteFileAtomically(client, remoteRoot, destinationPath, data, size, createdDirectories) {
    await ensureRemoteParent(client, destinationPath, createdDirectories);
    const temporaryPath = joinRemotePath(remoteRoot, `.opengamesave-upload-${randomUUID()}.tmp`);
    try {
        const source = Buffer.isBuffer(data) ? data : fsOriginal.createReadStream(data);
        await client.putFileContents(temporaryPath, source, { overwrite: true, contentLength: size });
        await client.moveFile(temporaryPath, destinationPath, { overwrite: true });
    } finally {
        if (await client.exists(temporaryPath).catch(() => false)) {
            await client.deleteFile(temporaryPath).catch(() => undefined);
        }
    }
}

async function checkWebDAVSyncStatus() {
    const config = getConfiguredWebDAVSettings();
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
        await client.stat('/');
        const remoteExists = await client.exists(config.remotePath);
        const manifest = remoteExists ? await readRemoteManifest(client, config.remotePath) : null;
        return {
            ...baseStatus,
            ready: true,
            remoteInitialized: Boolean(manifest),
            fileCount: manifest?.files.length || 0,
            message: i18next.t(manifest ? 'alert.webdav_ready' : 'alert.webdav_ready_new')
        };
    } catch (error) {
        return { ...baseStatus, message: sanitizeWebDAVError(error, config) };
    }
}

async function uploadBackupsToWebDAV(syncPathSetting = null) {
    const syncPath = normalizeSyncPath(syncPathSetting || getSettings().backupPath || '');
    const config = getConfiguredWebDAVSettings();
    const client = await createWebDAVClient(config);

    await pruneBackups(syncPath);
    const localFiles = await collectLocalBackupFiles(syncPath);
    await client.createDirectory(config.remotePath, { recursive: true });
    const remoteManifest = await readRemoteManifest(client, config.remotePath);
    const remoteFiles = new Map((remoteManifest?.files || []).map(file => [file.path, file]));
    const mergedFiles = new Map(remoteFiles);
    const createdDirectories = new Set([config.remotePath]);
    let uploadedFiles = 0;
    let uploadedBytes = 0;

    for (const file of localFiles) {
        const remoteFile = remoteFiles.get(file.path);
        if (!remoteFile || remoteFile.sha256 !== file.sha256 || remoteFile.size !== file.size) {
            await writeRemoteFileAtomically(
                client,
                config.remotePath,
                joinRemotePath(config.remotePath, file.path),
                file.localPath,
                file.size,
                createdDirectories
            );
            uploadedFiles += 1;
            uploadedBytes += file.size;
        }
        mergedFiles.set(file.path, {
            path: file.path,
            size: file.size,
            mtimeMs: file.mtimeMs,
            sha256: file.sha256
        });
    }

    const manifest = validateManifest({
        version: MANIFEST_VERSION,
        generatedAt: new Date().toISOString(),
        files: [...mergedFiles.values()]
    });
    const manifestPayload = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    if (manifestPayload.length > MAX_MANIFEST_SIZE) throw new Error('WebDAV manifest is too large');
    await writeRemoteFileAtomically(
        client,
        config.remotePath,
        joinRemotePath(config.remotePath, MANIFEST_NAME),
        manifestPayload,
        manifestPayload.length,
        createdDirectories
    );

    return {
        syncPath,
        games: listGameBackupFolders(syncPath).length,
        size: localFiles.reduce((total, file) => total + file.size, 0),
        uploadedFiles,
        uploadedBytes
    };
}

async function downloadRemoteFile(client, remotePath, stagingPath, expectedFile) {
    await fsOriginal.promises.mkdir(path.dirname(stagingPath), { recursive: true });
    await pipeline(client.createReadStream(remotePath), fsOriginal.createWriteStream(stagingPath, { flags: 'wx' }));
    const stats = await fsOriginal.promises.stat(stagingPath);
    if (stats.size !== expectedFile.size || await hashFile(stagingPath) !== expectedFile.sha256) {
        throw new Error(`WebDAV download verification failed: ${expectedFile.path}`);
    }
}

async function replaceLocalFileAtomically(syncRoot, stagedPath, destinationPath, mtimeMs) {
    await assertNoSymlinkAncestors(syncRoot, destinationPath, fsOriginal);
    await fsOriginal.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    await assertNoSymlinkAncestors(syncRoot, destinationPath, fsOriginal);
    const temporaryPath = `${destinationPath}.${randomUUID()}.download`;
    const previousPath = `${destinationPath}.${randomUUID()}.previous`;
    let previousMoved = false;
    try {
        await fsOriginal.promises.copyFile(stagedPath, temporaryPath, fsOriginal.constants.COPYFILE_EXCL);
        const existingStats = await fsOriginal.promises.lstat(destinationPath).catch(error => {
            if (error?.code === 'ENOENT') return null;
            throw error;
        });
        if (existingStats) {
            if (!existingStats.isFile() || existingStats.isSymbolicLink()) {
                throw new Error(`Refusing to replace non-file backup path: ${destinationPath}`);
            }
            await fsOriginal.promises.rename(destinationPath, previousPath);
            previousMoved = true;
        }
        await fsOriginal.promises.rename(temporaryPath, destinationPath);
        await fsOriginal.promises.utimes(destinationPath, new Date(mtimeMs), new Date(mtimeMs));
        if (previousMoved) await fsOriginal.promises.rm(previousPath, { force: true });
    } catch (error) {
        if (previousMoved) {
            await fsOriginal.promises.rm(destinationPath, { force: true }).catch(() => undefined);
            await fsOriginal.promises.rename(previousPath, destinationPath).catch(() => undefined);
        }
        throw error;
    } finally {
        await fsOriginal.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
}

async function downloadBackupsFromWebDAV(syncPathSetting = null) {
    const syncPath = normalizeSyncPath(syncPathSetting || getSettings().backupPath || '');
    const config = getConfiguredWebDAVSettings();
    const client = await createWebDAVClient(config);
    const manifest = await readRemoteManifest(client, config.remotePath, { required: true });
    const stagingRoot = await fsOriginal.promises.mkdtemp(path.join(app.getPath('temp'), 'OpenGameSave-webdav-'));

    try {
        for (const file of manifest.files) {
            const stagingPath = path.join(stagingRoot, ...file.path.split('/'));
            await downloadRemoteFile(client, joinRemotePath(config.remotePath, file.path), stagingPath, file);
        }

        await fsOriginal.promises.mkdir(syncPath, { recursive: true });
        const rootStats = await fsOriginal.promises.lstat(syncPath);
        if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
            throw new Error('The backup path is not a regular directory');
        }
        for (const file of manifest.files) {
            const stagedPath = path.join(stagingRoot, ...file.path.split('/'));
            const destinationPath = path.join(syncPath, ...file.path.split('/'));
            await replaceLocalFileAtomically(syncPath, stagedPath, destinationPath, file.mtimeMs);
        }
        await pruneBackups(syncPath);
    } finally {
        await fsOriginal.promises.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }

    return {
        syncPath,
        games: listGameBackupFolders(syncPath).length,
        size: manifest.files.reduce((total, file) => total + file.size, 0),
        downloadedFiles: manifest.files.length
    };
}

module.exports = {
    checkWebDAVSyncStatus,
    collectLocalBackupFiles,
    downloadBackupsFromWebDAV,
    getWebDAVPublicConfig,
    saveWebDAVProviderConfig,
    uploadBackupsToWebDAV
};
