const fsOriginal = require('original-fs');
const path = require('path');

const fse = require('fs-extra');

const { getSettings } = require('./global');
const { normalizeAbsolutePath, validateBackupMetadata } = require('./validation');

function normalizeSyncPath(inputPath) {
    const configuredPath = normalizeAbsolutePath(getSettings().backupPath);
    const requestedPath = normalizeAbsolutePath(inputPath || configuredPath);
    const normalizeForComparison = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalizeForComparison(requestedPath) !== normalizeForComparison(configuredPath)) {
        throw new Error('Sync is limited to the configured backup directory');
    }
    return configuredPath;
}

async function isBackupInstanceFolder(folderPath) {
    try {
        const stats = await fsOriginal.promises.lstat(path.join(folderPath, 'backup_info.json'));
        return stats.isFile() && !stats.isSymbolicLink() && stats.size <= 1024 * 1024;
    } catch (_) {
        return false;
    }
}

async function listDirectoryFolders(rootPath) {
    if (!rootPath) return [];
    try {
        return (await fsOriginal.promises.readdir(rootPath, { withFileTypes: true }))
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name);
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
}

async function listGameBackupFolders(rootPath) {
    const games = [];
    for (const item of await listDirectoryFolders(rootPath)) {
        const gamePath = path.join(rootPath, item);
        for (const backup of await listDirectoryFolders(gamePath)) {
            if (await isBackupInstanceFolder(path.join(gamePath, backup))) {
                games.push(item);
                break;
            }
        }
    }
    return games;
}

async function listBackupInstanceFolders(gamePath) {
    const backups = [];
    for (const backup of await listDirectoryFolders(gamePath)) {
        if (await isBackupInstanceFolder(path.join(gamePath, backup))) backups.push(backup);
    }
    return backups;
}

async function pruneBackups(rootPath) {
    const maxBackups = Number(getSettings().maxBackups) || 5;
    if (!rootPath) return;

    for (const gameId of await listGameBackupFolders(rootPath)) {
        const gamePath = path.join(rootPath, gameId);
        const permanentBackups = [];
        const nonPermanentBackups = [];
        const protectedBackups = [];

        for (const backup of await listBackupInstanceFolders(gamePath)) {
            const infoPath = path.join(gamePath, backup, 'backup_info.json');
            try {
                const info = validateBackupMetadata(await fse.readJson(infoPath));
                if (info.is_permanent) {
                    permanentBackups.push(backup);
                    continue;
                }
            } catch (error) {
                protectedBackups.push(backup);
                console.warn(`Skipping retention cleanup for invalid backup ${infoPath}: ${error.message}`);
                continue;
            }
            nonPermanentBackups.push(backup);
        }

        nonPermanentBackups.sort((a, b) => b.localeCompare(a));
        const backupsToDelete = nonPermanentBackups.slice(maxBackups);
        for (const backup of backupsToDelete) {
            await fsOriginal.promises.rm(path.join(gamePath, backup), { recursive: true, force: true });
        }

        const remaining = [...protectedBackups, ...permanentBackups, ...nonPermanentBackups.slice(0, maxBackups)];
        if (remaining.length === 0) {
            await fsOriginal.promises.rm(gamePath, { recursive: true, force: true });
        }
    }
}

module.exports = {
    listBackupInstanceFolders,
    listGameBackupFolders,
    normalizeSyncPath,
    pruneBackups
};
