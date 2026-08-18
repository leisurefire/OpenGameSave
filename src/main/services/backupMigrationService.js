const fsOriginal = require('original-fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const i18next = require('i18next');

const { calculateDirectorySizeAsync } = require('../fileSystemUtils');
const { acquireGlobalOperation } = require('../gameOperationLock');
const { isPathInside, normalizeAbsolutePath } = require('../validation');
const { saveSettings } = require('./settingsService');
const { getStatus, updateStatus } = require('./statusService');
const { getMainWin } = require('./windowManager');

async function performBackupMigration(sourceDir, destinationDir) {
    const sourcePath = normalizeAbsolutePath(sourceDir);
    const destinationPath = normalizeAbsolutePath(destinationDir);
    const normalizedSource = process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath;
    const normalizedDestination = process.platform === 'win32' ? destinationPath.toLowerCase() : destinationPath;
    if (normalizedSource === normalizedDestination
        || isPathInside(sourcePath, destinationPath)
        || isPathInside(destinationPath, sourcePath)
        || path.parse(sourcePath).root === sourcePath) {
        throw new Error('Backup migration paths must be separate, non-root directories');
    }

    const sourceStats = await fsOriginal.promises.lstat(sourcePath);
    if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
        throw new Error('The current backup path is not a regular directory');
    }
    try {
        const destinationStats = await fsOriginal.promises.lstat(destinationPath);
        if (!destinationStats.isDirectory() || destinationStats.isSymbolicLink()) {
            throw new Error('The migration destination is not a regular directory');
        }
        if ((await fsOriginal.promises.readdir(destinationPath)).length > 0) {
            throw new Error('The migration destination must be empty');
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await fsOriginal.promises.mkdir(destinationPath, { recursive: true });
    }

    const totalSize = await calculateDirectorySizeAsync(sourcePath, false, fsOriginal);
    let movedSize = 0;
    let lastProgress = -1;
    const progressId = 'migrate-backups';
    const progressTitle = i18next.t('alert.migrate_backups');
    getMainWin().webContents.send('update-progress', progressId, progressTitle, 'start');

    try {
        const pendingDirectories = [[sourcePath, destinationPath]];
        while (pendingDirectories.length > 0) {
            const [currentSource, currentDestination] = pendingDirectories.pop();
            await fsOriginal.promises.mkdir(currentDestination, { recursive: true });
            const entries = await fsOriginal.promises.readdir(currentSource, { withFileTypes: true });
            for (const entry of entries) {
                const sourceEntry = path.join(currentSource, entry.name);
                const destinationEntry = path.join(currentDestination, entry.name);
                if (entry.isSymbolicLink()) throw new Error(`Refusing to migrate symbolic link: ${sourceEntry}`);
                if (entry.isDirectory()) {
                    pendingDirectories.push([sourceEntry, destinationEntry]);
                    continue;
                }
                if (!entry.isFile()) throw new Error(`Unsupported file type in backup folder: ${sourceEntry}`);

                const fileStats = await fsOriginal.promises.lstat(sourceEntry);
                const readStream = fsOriginal.createReadStream(sourceEntry);
                const writeStream = fsOriginal.createWriteStream(destinationEntry, { flags: 'wx' });
                readStream.on('data', (chunk) => {
                    movedSize += chunk.length;
                    const progressPercentage = totalSize > 0 ? Math.min(100, Math.floor((movedSize / totalSize) * 100)) : 100;
                    if (progressPercentage !== lastProgress) {
                        lastProgress = progressPercentage;
                        getMainWin().webContents.send('update-progress', progressId, progressTitle, progressPercentage);
                    }
                });
                await pipeline(readStream, writeStream);
                await fsOriginal.promises.utimes(destinationEntry, fileStats.atime, fileStats.mtime);
            }
        }

        const copiedSize = await calculateDirectorySizeAsync(destinationPath, false, fsOriginal);
        if (copiedSize !== totalSize) throw new Error('Backup migration verification failed');
        await fsOriginal.promises.rm(sourcePath, { recursive: true });
        await saveSettings('backupPath', destinationPath);
        getMainWin().webContents.send('update-restore-table');
        getMainWin().webContents.send('show-alert', 'success', i18next.t('alert.backup_migration_success'));
        return true;
    } catch (error) {
        console.error('Backup migration failed:', error);
        getMainWin().webContents.send('show-alert', 'modal', i18next.t('alert.error_during_backup_migration'), error.message);
        return false;
    } finally {
        getMainWin().webContents.send('update-progress', progressId, progressTitle, 'end');
    }
}

async function moveFilesWithProgress(sourceDir, destinationDir) {
    if (getStatus().migrating) return false;
    let releaseOperation;
    try {
        releaseOperation = acquireGlobalOperation('migrate backups');
    } catch (_) {
        return false;
    }
    updateStatus('migrating', true);
    try {
        return await performBackupMigration(sourceDir, destinationDir);
    } finally {
        updateStatus('migrating', false);
        releaseOperation?.();
    }
}
module.exports = { moveFilesWithProgress };

