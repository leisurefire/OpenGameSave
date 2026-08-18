const fsOriginal = require('original-fs');
const path = require('path');

const fse = require('fs-extra');

const { getSettings } = require('./global');
const { normalizeAbsolutePath } = require('./validation');

function normalizeSyncPath(inputPath) {
    const configuredPath = normalizeAbsolutePath(getSettings().backupPath);
    const requestedPath = normalizeAbsolutePath(inputPath || configuredPath);
    const normalizeForComparison = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalizeForComparison(requestedPath) !== normalizeForComparison(configuredPath)) {
        throw new Error('Sync is limited to the configured backup directory');
    }
    return configuredPath;
}

function isBackupInstanceFolder(folderPath) {
    try {
        const stats = fsOriginal.lstatSync(path.join(folderPath, 'backup_info.json'));
        return stats.isFile() && !stats.isSymbolicLink() && stats.size <= 1024 * 1024;
    } catch (_) {
        return false;
    }
}

function listDirectoryFolders(rootPath) {
    if (!rootPath || !fsOriginal.existsSync(rootPath)) return [];
    return fsOriginal.readdirSync(rootPath, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
}

function listGameBackupFolders(rootPath) {
    return listDirectoryFolders(rootPath).filter(item => {
        const gamePath = path.join(rootPath, item);
        return listDirectoryFolders(gamePath).some(backup => isBackupInstanceFolder(path.join(gamePath, backup)));
    });
}

function listBackupInstanceFolders(gamePath) {
    return listDirectoryFolders(gamePath).filter(backup => isBackupInstanceFolder(path.join(gamePath, backup)));
}

async function pruneBackups(rootPath) {
    const maxBackups = Number(getSettings().maxBackups) || 5;
    if (!rootPath || !fsOriginal.existsSync(rootPath)) return;

    for (const gameId of listGameBackupFolders(rootPath)) {
        const gamePath = path.join(rootPath, gameId);
        const permanentBackups = [];
        const nonPermanentBackups = [];

        for (const backup of listBackupInstanceFolders(gamePath)) {
            const infoPath = path.join(gamePath, backup, 'backup_info.json');
            if (fsOriginal.existsSync(infoPath)) {
                try {
                    const info = await fse.readJson(infoPath);
                    if (info.is_permanent) {
                        permanentBackups.push(backup);
                        continue;
                    }
                } catch (_) {
                    // Treat unreadable metadata as non-permanent so it follows normal retention.
                }
            }
            nonPermanentBackups.push(backup);
        }

        nonPermanentBackups.sort((a, b) => b.localeCompare(a));
        const backupsToDelete = nonPermanentBackups.slice(maxBackups);
        for (const backup of backupsToDelete) {
            fsOriginal.rmSync(path.join(gamePath, backup), { recursive: true, force: true });
        }

        const remaining = [...permanentBackups, ...nonPermanentBackups.slice(0, maxBackups)];
        if (remaining.length === 0) {
            fsOriginal.rmSync(gamePath, { recursive: true, force: true });
        }
    }
}

module.exports = {
    listBackupInstanceFolders,
    listGameBackupFolders,
    normalizeSyncPath,
    pruneBackups
};
