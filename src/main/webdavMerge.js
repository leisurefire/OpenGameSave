const { createHash } = require('crypto');
const fs = require('fs');

const { validateBackupMetadata } = require('./validation');
const { normalizeManifestPath } = require('./webdavManifest');

function hashBuffer(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

function getBufferForFile(file) {
    if (Buffer.isBuffer(file.data)) return Promise.resolve(file.data);
    return fs.promises.readFile(file.localPath);
}

function formatConflictBackupDate(rawBackupDate, offsetSeconds) {
    const [datePart, timePart] = rawBackupDate.split('_');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute, second = 0] = timePart.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second + offsetSeconds));
    const pad = value => String(value).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
        + `_${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}`;
}

function allocateConflictBackupKey(originalKey, reservedKeys) {
    const [gameId, backupDate] = originalKey.split('/');
    for (let offset = 1; offset <= 86400; offset += 1) {
        const candidate = `${gameId}/${formatConflictBackupDate(backupDate, offset)}`;
        if (!reservedKeys.has(candidate)) {
            reservedKeys.add(candidate);
            return candidate;
        }
    }
    throw new Error(`Unable to allocate a conflict backup for ${originalKey}`);
}

function createConflictMetadataBuffer(sourceBuffer, conflictDeviceId) {
    const metadata = validateBackupMetadata(JSON.parse(sourceBuffer.toString('utf8')));
    const baseName = metadata.custom_name || metadata.title;
    metadata.custom_name = `${baseName} [Conflict ${conflictDeviceId.slice(0, 8)}]`.slice(0, 120);
    metadata.is_permanent = true;
    return Buffer.from(JSON.stringify(validateBackupMetadata(metadata), null, 4), 'utf8');
}

async function makeConflictMetadataFile(file, conflictDeviceId) {
    const data = createConflictMetadataBuffer(await getBufferForFile(file), conflictDeviceId);
    return {
        ...file,
        data,
        localPath: null,
        size: data.length,
        mtimeMs: Date.now(),
        sha256: hashBuffer(data)
    };
}

function indexFiles(files) {
    return new Map((files || []).map(file => [file.path, file]));
}

function getBackupKey(relativePath) {
    return relativePath.split('/').slice(0, 2).join('/');
}

function getBackupSuffix(relativePath) {
    return relativePath.split('/').slice(2).join('/');
}

function groupFilesByBackup(files) {
    const groups = new Map();
    for (const file of files) {
        const backupKey = getBackupKey(file.path);
        if (!groups.has(backupKey)) groups.set(backupKey, []);
        groups.get(backupKey).push(file);
    }
    return groups;
}

function findConflictingBackupKeys(remoteFiles, localFiles, syncState = null) {
    const remoteByPath = indexFiles(remoteFiles);
    const previousLocalByPath = indexFiles(syncState?.localFiles);
    const previousRemoteByPath = indexFiles(syncState?.remoteFiles);
    const conflicts = new Set();

    for (const localFile of localFiles) {
        const remoteFile = remoteByPath.get(localFile.path);
        if (!remoteFile || remoteFile.sha256 === localFile.sha256) continue;
        const backupKey = getBackupKey(localFile.path);
        if (!syncState) {
            conflicts.add(backupKey);
            continue;
        }
        const localChanged = previousLocalByPath.get(localFile.path)?.sha256 !== localFile.sha256;
        const remoteChanged = previousRemoteByPath.get(remoteFile.path)?.sha256 !== remoteFile.sha256;
        if (localChanged && remoteChanged) conflicts.add(backupKey);
    }
    return conflicts;
}

function mapRemoteConflictFiles(remoteFiles, conflictDestinations, remoteDeviceId) {
    return remoteFiles.map(file => {
        const backupKey = getBackupKey(file.path);
        const conflictBackup = conflictDestinations.get(backupKey);
        if (!conflictBackup) return file;
        return {
            ...file,
            path: normalizeManifestPath(`${conflictBackup}/${getBackupSuffix(file.path)}`),
            remotePath: file.path,
            conflictDeviceId: remoteDeviceId
        };
    });
}

async function makeLocalConflictFiles(localFiles, conflictDestinations, localDeviceId) {
    const conflictFiles = [];
    for (const originalFile of localFiles) {
        const conflictBackup = conflictDestinations.get(getBackupKey(originalFile.path));
        if (!conflictBackup) continue;
        const file = originalFile.path.endsWith('/backup_info.json')
            ? await makeConflictMetadataFile(originalFile, localDeviceId)
            : originalFile;
        conflictFiles.push({
            ...file,
            path: normalizeManifestPath(`${conflictBackup}/${getBackupSuffix(originalFile.path)}`),
            localConflictFile: true
        });
    }
    return conflictFiles;
}

async function mergeLocalFiles(remoteFiles, localFiles, deviceId, syncState = null, remoteDeviceId = 'legacy') {
    const mergedFiles = new Map(remoteFiles.map(file => [file.path, file]));
    const localGroups = groupFilesByBackup(localFiles);
    const remoteGroups = groupFilesByBackup(remoteFiles);
    const reservedKeys = new Set([...remoteFiles, ...localFiles]
        .map(file => getBackupKey(file.path)));
    const conflicts = [];
    const uploadFiles = [];
    const conflictingBackups = findConflictingBackupKeys(remoteFiles, localFiles, syncState);

    for (const [backupKey, groupFiles] of localGroups) {
        const hasConflict = conflictingBackups.has(backupKey);
        if (hasConflict) {
            const conflictBackup = allocateConflictBackupKey(backupKey, reservedKeys);
            for (const remoteFile of remoteGroups.get(backupKey) || []) {
                mergedFiles.delete(remoteFile.path);
                const conflictPath = normalizeManifestPath(
                    `${conflictBackup}/${getBackupSuffix(remoteFile.path)}`
                );
                mergedFiles.set(conflictPath, { ...remoteFile, path: conflictPath });
            }
            conflicts.push({
                originalBackup: backupKey,
                conflictBackup,
                localDeviceId: deviceId,
                remoteDeviceId,
                direction: 'upload',
                originalVersion: 'local',
                conflictVersion: 'remote'
            });
        }
        for (const originalFile of groupFiles) {
            mergedFiles.set(originalFile.path, {
                path: normalizeManifestPath(originalFile.path),
                size: originalFile.size,
                mtimeMs: originalFile.mtimeMs,
                sha256: originalFile.sha256
            });
            uploadFiles.push(originalFile);
        }
    }
    return { files: [...mergedFiles.values()], uploadFiles, conflicts };
}

module.exports = {
    allocateConflictBackupKey,
    createConflictMetadataBuffer,
    findConflictingBackupKeys,
    makeConflictMetadataFile,
    makeLocalConflictFiles,
    mapRemoteConflictFiles,
    mergeLocalFiles
};
