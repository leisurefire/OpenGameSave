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

async function mergeLocalFiles(remoteFiles, localFiles, deviceId) {
    const mergedFiles = new Map(remoteFiles.map(file => [file.path, file]));
    const localGroups = new Map();
    for (const file of localFiles) {
        const backupKey = file.path.split('/').slice(0, 2).join('/');
        if (!localGroups.has(backupKey)) localGroups.set(backupKey, []);
        localGroups.get(backupKey).push(file);
    }
    const reservedKeys = new Set([...remoteFiles, ...localFiles]
        .map(file => file.path.split('/').slice(0, 2).join('/')));
    const conflicts = [];
    const uploadFiles = [];

    for (const [backupKey, groupFiles] of localGroups) {
        const hasConflict = groupFiles.some(file => {
            const remoteFile = mergedFiles.get(file.path);
            return remoteFile && remoteFile.sha256 !== file.sha256;
        });
        const destinationKey = hasConflict ? allocateConflictBackupKey(backupKey, reservedKeys) : backupKey;
        if (hasConflict) conflicts.push({ originalBackup: backupKey, conflictBackup: destinationKey, deviceId });
        for (const originalFile of groupFiles) {
            let file = originalFile;
            if (hasConflict && originalFile.path.endsWith('/backup_info.json')) {
                file = await makeConflictMetadataFile(originalFile, deviceId);
            }
            const suffix = file.path.split('/').slice(2).join('/');
            const destinationPath = hasConflict ? `${destinationKey}/${suffix}` : file.path;
            mergedFiles.set(destinationPath, {
                path: normalizeManifestPath(destinationPath),
                size: file.size,
                mtimeMs: file.mtimeMs,
                sha256: file.sha256
            });
            uploadFiles.push({ ...file, path: destinationPath });
        }
    }
    return { files: [...mergedFiles.values()], uploadFiles, conflicts };
}

module.exports = {
    allocateConflictBackupKey,
    createConflictMetadataBuffer,
    mergeLocalFiles
};
