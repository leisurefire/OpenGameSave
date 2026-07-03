const fs = require('fs');
const path = require('path');

const fse = require('fs-extra');
const { format, parse } = require('date-fns');

const directorySizeCache = new Map();
const DIRECTORY_SIZE_CACHE_TTL_MS = 2000;

function calculateDirectorySize(directoryPath, ignoreConfig = true, fsAdapter = fs) {
    try {
        const stats = fsAdapter.statSync(directoryPath);
        const cacheKey = `${ignoreConfig ? '1' : '0'}:${directoryPath}`;
        const cached = directorySizeCache.get(cacheKey);
        const now = Date.now();
        if (cached && cached.mtimeMs === stats.mtimeMs && now - cached.timestamp < DIRECTORY_SIZE_CACHE_TTL_MS) {
            return cached.size;
        }

        let totalSize = 0;
        if (stats.isDirectory()) {
            const entries = fsAdapter.readdirSync(directoryPath, { withFileTypes: true });
            for (const entry of entries) {
                if (ignoreConfig && entry.name === 'backup_info.json') continue;

                const filePath = path.join(directoryPath, entry.name);
                if (entry.isDirectory()) {
                    totalSize += calculateDirectorySize(filePath, ignoreConfig, fsAdapter);
                } else if (entry.isFile()) {
                    totalSize += fsAdapter.statSync(filePath).size;
                }
            }
        } else {
            totalSize = stats.size;
        }

        directorySizeCache.set(cacheKey, {
            mtimeMs: stats.mtimeMs,
            size: totalSize,
            timestamp: now
        });
        return totalSize;
    } catch (error) {
        console.error(`Error calculating directory size for ${directoryPath}:`, error);
    }

    return 0;
}

function ensureWritable(pathToCheck, fsAdapter = fs) {
    if (!fsAdapter.existsSync(pathToCheck)) return;

    const stats = fsAdapter.statSync(pathToCheck);
    if (stats.isDirectory()) {
        const items = fsAdapter.readdirSync(pathToCheck);
        for (const item of items) {
            ensureWritable(path.join(pathToCheck, item), fsAdapter);
        }
    } else if (!(stats.mode & 0o200)) {
        fsAdapter.chmodSync(pathToCheck, 0o666);
    }
}

function copyFolder(source, target, fsAdapter = fs) {
    fsAdapter.mkdirSync(target, { recursive: true });

    const items = fsAdapter.readdirSync(source);
    for (const item of items) {
        const sourcePath = path.join(source, item);
        const destinationPath = path.join(target, item);
        const stats = fsAdapter.statSync(sourcePath);

        if (stats.isDirectory()) {
            copyFolder(sourcePath, destinationPath, fsAdapter);
        } else {
            fsAdapter.copyFileSync(sourcePath, destinationPath);
        }
    }
}

function getLatestModificationTime(targetPath, fsAdapter = fs) {
    let latestTime = 0;

    try {
        if (!fsAdapter.existsSync(targetPath)) {
            return latestTime;
        }

        const stats = fsAdapter.statSync(targetPath);
        latestTime = stats.mtimeMs;

        if (stats.isDirectory()) {
            const entries = fsAdapter.readdirSync(targetPath, { withFileTypes: true });
            for (const entry of entries) {
                const entryLatestTime = getLatestModificationTime(path.join(targetPath, entry.name), fsAdapter);
                if (entryLatestTime > latestTime) {
                    latestTime = entryLatestTime;
                }
            }
        }
    } catch (error) {
        console.error(`Error getting latest modification time for ${targetPath}:`, error);
    }

    return latestTime;
}

function getNewestBackup(wikiPageId, { backupPath, noBackupsLabel, fsAdapter = fs }) {
    const backupDir = path.join(backupPath, wikiPageId.toString());
    if (!fsAdapter.existsSync(backupDir)) {
        return noBackupsLabel;
    }

    const backups = fsAdapter.readdirSync(backupDir)
        .filter(file => fsAdapter.statSync(path.join(backupDir, file)).isDirectory());

    if (backups.length === 0) {
        return noBackupsLabel;
    }

    const latestBackup = backups.sort((a, b) => b.localeCompare(a))[0];
    return format(parse(latestBackup, 'yyyy-MM-dd_HH-mm', new Date()), 'yyyy/MM/dd HH:mm');
}

async function readBackupFolder(wikiIdFolderPath, wikiId, { fsAdapter = fs, readJson = fse.readJson } = {}) {
    const backups = [];
    const errors = [];

    try {
        if (wikiId && !fsAdapter.existsSync(wikiIdFolderPath)) return { gameData: null, errors };
        const stats = fsAdapter.statSync(wikiIdFolderPath);
        if (!stats.isDirectory()) return { gameData: null, errors };

        const backupFolders = fsAdapter.readdirSync(wikiIdFolderPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        for (const backupFolder of backupFolders) {
            const backupFolderPath = path.join(wikiIdFolderPath, backupFolder);
            const configFilePath = path.join(backupFolderPath, 'backup_info.json');
            const backupSize = calculateDirectorySize(backupFolderPath, true, fsAdapter);

            if (fsAdapter.existsSync(configFilePath)) {
                try {
                    const backupConfig = await readJson(configFilePath);
                    backups.push({
                        date: backupFolder,
                        title: backupConfig.title,
                        zh_CN: backupConfig.zh_CN,
                        backup_size: backupSize,
                        backup_paths: backupConfig.backup_paths,
                        is_permanent: backupConfig.is_permanent || false,
                        custom_name: backupConfig.custom_name || ''
                    });
                } catch (error) {
                    console.error(`Error reading backup config file at ${configFilePath}: ${error.stack}`);
                    errors.push(`Error reading backup config ${configFilePath}: ${error.message}`);
                }
            }
        }

        if (backups.length === 0) return { gameData: null, errors };

        const latestBackup = backups.sort((a, b) => b.date.localeCompare(a.date))[0];
        const latestBackupFormatted = format(parse(latestBackup.date, 'yyyy-MM-dd_HH-mm', new Date()), 'yyyy/MM/dd HH:mm');

        return {
            gameData: {
                wiki_page_id: wikiId,
                latest_backup: latestBackupFormatted,
                title: latestBackup.title,
                zh_CN: latestBackup.zh_CN,
                backup_size: latestBackup.backup_size,
                backups
            },
            errors
        };
    } catch (error) {
        console.error(`Error processing ${wikiIdFolderPath} for restore table display: ${error.stack}`);
        errors.push(`Error processing restore path ${wikiIdFolderPath}: ${error.message}`);
        return { gameData: null, errors };
    }
}

module.exports = {
    calculateDirectorySize,
    ensureWritable,
    copyFolder,
    getLatestModificationTime,
    getNewestBackup,
    readBackupFolder
};
