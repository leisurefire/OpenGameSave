const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const fse = require('fs-extra');
const { format, parse } = require('date-fns');
const { isPathInside, normalizeBackupDate, validateBackupMetadata } = require('./validation');

const directorySizeCaches = new WeakMap();
const DIRECTORY_SIZE_CACHE_TTL_MS = 2000;
const DIRECTORY_SIZE_CACHE_MAX_ENTRIES = 256;

function getDirectorySizeCache(fsAdapter) {
    let cache = directorySizeCaches.get(fsAdapter);
    if (!cache) {
        cache = new Map();
        directorySizeCaches.set(fsAdapter, cache);
    }
    return cache;
}

function getCachedDirectorySize(directorySizeCache, cacheKey, mtimeMs) {
    const cached = directorySizeCache.get(cacheKey);
    if (!cached || cached.mtimeMs !== mtimeMs || Date.now() - cached.timestamp >= DIRECTORY_SIZE_CACHE_TTL_MS) {
        return null;
    }
    directorySizeCache.delete(cacheKey);
    directorySizeCache.set(cacheKey, cached);
    return cached.size;
}

function cacheDirectorySize(directorySizeCache, cacheKey, mtimeMs, size) {
    directorySizeCache.set(cacheKey, { mtimeMs, size, timestamp: Date.now() });
    while (directorySizeCache.size > DIRECTORY_SIZE_CACHE_MAX_ENTRIES) {
        directorySizeCache.delete(directorySizeCache.keys().next().value);
    }
}

function calculateDirectorySize(directoryPath, ignoreConfig = true, fsAdapter = fs) {
    try {
        const stats = fsAdapter.lstatSync(directoryPath);
        if (stats.isSymbolicLink()) return 0;
        if (stats.isFile()) return stats.size;
        const directorySizeCache = getDirectorySizeCache(fsAdapter);
        const cacheKey = `${ignoreConfig ? '1' : '0'}:${path.resolve(directoryPath)}`;
        const cachedSize = getCachedDirectorySize(directorySizeCache, cacheKey, stats.mtimeMs);
        if (cachedSize !== null) return cachedSize;

        let totalSize = stats.isFile() ? stats.size : 0;
        const pendingDirectories = stats.isDirectory() ? [directoryPath] : [];
        while (pendingDirectories.length > 0) {
            const currentDirectory = pendingDirectories.pop();
            const entries = fsAdapter.readdirSync(currentDirectory, { withFileTypes: true });
            for (const entry of entries) {
                if (ignoreConfig && entry.name === 'backup_info.json') continue;
                const filePath = path.join(currentDirectory, entry.name);
                if (entry.isDirectory()) {
                    pendingDirectories.push(filePath);
                } else if (entry.isFile()) {
                    totalSize += fsAdapter.lstatSync(filePath).size;
                }
            }
        }

        cacheDirectorySize(directorySizeCache, cacheKey, stats.mtimeMs, totalSize);
        return totalSize;
    } catch (error) {
        console.error(`Error calculating directory size for ${directoryPath}:`, error);
    }

    return 0;
}

async function calculateDirectorySizeAsync(directoryPath, ignoreConfig = true, fsAdapter = fs) {
    try {
        const stats = await fsAdapter.promises.lstat(directoryPath);
        if (stats.isSymbolicLink()) return 0;
        if (stats.isFile()) return stats.size;
        const directorySizeCache = getDirectorySizeCache(fsAdapter);
        const cacheKey = `${ignoreConfig ? '1' : '0'}:${path.resolve(directoryPath)}`;
        const cachedSize = getCachedDirectorySize(directorySizeCache, cacheKey, stats.mtimeMs);
        if (cachedSize !== null) return cachedSize;

        let totalSize = stats.isFile() ? stats.size : 0;
        const pendingDirectories = stats.isDirectory() ? [directoryPath] : [];
        while (pendingDirectories.length > 0) {
            const currentDirectory = pendingDirectories.pop();
            const entries = await fsAdapter.promises.readdir(currentDirectory, { withFileTypes: true });
            for (const entry of entries) {
                if (ignoreConfig && entry.name === 'backup_info.json') continue;
                const filePath = path.join(currentDirectory, entry.name);
                if (entry.isDirectory()) {
                    pendingDirectories.push(filePath);
                } else if (entry.isFile()) {
                    totalSize += (await fsAdapter.promises.lstat(filePath)).size;
                }
            }
        }

        cacheDirectorySize(directorySizeCache, cacheKey, stats.mtimeMs, totalSize);
        return totalSize;
    } catch (error) {
        console.error(`Error calculating directory size for ${directoryPath}:`, error);
        return 0;
    }
}

function ensureWritable(pathToCheck, fsAdapter = fs) {
    if (!fsAdapter.existsSync(pathToCheck)) return;

    const pendingPaths = [pathToCheck];
    while (pendingPaths.length > 0) {
        const currentPath = pendingPaths.pop();
        const stats = fsAdapter.lstatSync(currentPath);
        if (stats.isSymbolicLink()) continue;
        if (stats.isDirectory()) {
            const items = fsAdapter.readdirSync(currentPath);
            for (const item of items) {
                pendingPaths.push(path.join(currentPath, item));
            }
        } else if (!(stats.mode & 0o200)) {
            fsAdapter.chmodSync(currentPath, 0o666);
        }
    }
}

function copyFolder(source, target, fsAdapter = fs) {
    if (isPathInside(source, target)) {
        throw new Error('Copy destination must be outside the source directory');
    }
    const sourceStats = fsAdapter.lstatSync(source);
    if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
        throw new Error(`Refusing to copy a non-directory or symbolic link: ${source}`);
    }
    fsAdapter.mkdirSync(target, { recursive: true });
    if (isPathInside(fsAdapter.realpathSync(source), fsAdapter.realpathSync(target))) {
        throw new Error('Copy destination must be outside the source directory');
    }
    const pendingDirectories = [[source, target]];
    while (pendingDirectories.length > 0) {
        const [currentSource, currentTarget] = pendingDirectories.pop();
        fsAdapter.mkdirSync(currentTarget, { recursive: true });
        if (fsAdapter.lstatSync(currentSource).isSymbolicLink()
            || fsAdapter.lstatSync(currentTarget).isSymbolicLink()) {
            throw new Error('Refusing to copy through a symbolic link');
        }
        const entries = fsAdapter.readdirSync(currentSource, { withFileTypes: true });
        for (const entry of entries) {
            const sourcePath = path.join(currentSource, entry.name);
            const destinationPath = path.join(currentTarget, entry.name);
            if (entry.isSymbolicLink()) {
                throw new Error(`Refusing to copy symbolic link: ${sourcePath}`);
            }
            if (entry.isDirectory()) {
                pendingDirectories.push([sourcePath, destinationPath]);
            } else if (entry.isFile()) {
                fsAdapter.copyFileSync(sourcePath, destinationPath);
            } else {
                throw new Error(`Refusing to copy unsupported file type: ${sourcePath}`);
            }
        }
    }
}

async function copyFolderAsync(source, target, fsAdapter = fs) {
    if (isPathInside(source, target)) {
        throw new Error('Copy destination must be outside the source directory');
    }
    const sourceStats = await fsAdapter.promises.lstat(source);
    if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
        throw new Error(`Refusing to copy a non-directory or symbolic link: ${source}`);
    }
    await fsAdapter.promises.mkdir(target, { recursive: true });
    if (isPathInside(await fsAdapter.promises.realpath(source), await fsAdapter.promises.realpath(target))) {
        throw new Error('Copy destination must be outside the source directory');
    }
    const pendingDirectories = [[source, target]];
    while (pendingDirectories.length > 0) {
        const [currentSource, currentTarget] = pendingDirectories.pop();
        await fsAdapter.promises.mkdir(currentTarget, { recursive: true });
        if ((await fsAdapter.promises.lstat(currentSource)).isSymbolicLink()
            || (await fsAdapter.promises.lstat(currentTarget)).isSymbolicLink()) {
            throw new Error('Refusing to copy through a symbolic link');
        }
        const entries = await fsAdapter.promises.readdir(currentSource, { withFileTypes: true });
        for (const entry of entries) {
            const sourcePath = path.join(currentSource, entry.name);
            const destinationPath = path.join(currentTarget, entry.name);
            if (entry.isSymbolicLink()) {
                throw new Error(`Refusing to copy symbolic link: ${sourcePath}`);
            }
            if (entry.isDirectory()) {
                pendingDirectories.push([sourcePath, destinationPath]);
            } else if (entry.isFile()) {
                await fsAdapter.promises.copyFile(sourcePath, destinationPath);
            } else {
                throw new Error(`Refusing to copy unsupported file type: ${sourcePath}`);
            }
        }
    }
}

async function copyFolderAtomically(source, target, fsAdapter = fs) {
    const targetParent = path.dirname(target);
    const targetName = path.basename(target);
    const stagingPath = path.join(targetParent, `.${targetName}.import-${randomUUID()}`);

    const existingTarget = await fsAdapter.promises.lstat(target).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
    });
    if (existingTarget) throw new Error(`Refusing to overwrite an existing directory: ${target}`);

    try {
        await copyFolderAsync(source, stagingPath, fsAdapter);
        const stagingStats = await fsAdapter.promises.lstat(stagingPath);
        if (!stagingStats.isDirectory() || stagingStats.isSymbolicLink()) {
            throw new Error('The staged backup is not a regular directory');
        }

        const racedTarget = await fsAdapter.promises.lstat(target).catch((error) => {
            if (error?.code === 'ENOENT') return null;
            throw error;
        });
        if (racedTarget) throw new Error(`Refusing to overwrite an existing directory: ${target}`);
        await fsAdapter.promises.rename(stagingPath, target);
    } finally {
        await fsAdapter.promises.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    }
}

function getLatestModificationTime(targetPath, fsAdapter = fs) {
    let latestTime = 0;

    try {
        const pendingPaths = [targetPath];
        while (pendingPaths.length > 0) {
            const currentPath = pendingPaths.pop();
            const stats = fsAdapter.lstatSync(currentPath);
            if (stats.isSymbolicLink()) continue;
            if (stats.mtimeMs > latestTime) latestTime = stats.mtimeMs;
            if (stats.isDirectory()) {
                const entries = fsAdapter.readdirSync(currentPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isSymbolicLink()) pendingPaths.push(path.join(currentPath, entry.name));
                }
            }
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            console.error(`Error getting latest modification time for ${targetPath}:`, error);
        }
    }

    return latestTime;
}

async function getLatestModificationTimeAsync(targetPath, fsAdapter = fs) {
    let latestTime = 0;
    try {
        const pendingPaths = [targetPath];
        while (pendingPaths.length > 0) {
            const currentPath = pendingPaths.pop();
            const stats = await fsAdapter.promises.lstat(currentPath);
            if (stats.isSymbolicLink()) continue;
            if (stats.mtimeMs > latestTime) latestTime = stats.mtimeMs;
            if (stats.isDirectory()) {
                const entries = await fsAdapter.promises.readdir(currentPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isSymbolicLink()) pendingPaths.push(path.join(currentPath, entry.name));
                }
            }
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            console.error(`Error getting latest modification time for ${targetPath}:`, error);
        }
    }
    return latestTime;
}

function getNewestBackup(wikiPageId, { backupPath, noBackupsLabel, fsAdapter = fs }) {
    const backupDir = path.join(backupPath, wikiPageId.toString());
    if (!fsAdapter.existsSync(backupDir)) {
        return noBackupsLabel;
    }

    const backups = fsAdapter.readdirSync(backupDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .filter((backupDate) => {
            try {
                normalizeBackupDate(backupDate);
                return true;
            } catch (_) {
                return false;
            }
        });

    if (backups.length === 0) {
        return noBackupsLabel;
    }

    let latestBackup = backups[0];
    for (let index = 1; index < backups.length; index += 1) {
        if (backups[index] > latestBackup) latestBackup = backups[index];
    }
    const backupFormat = latestBackup.length === 19 ? 'yyyy-MM-dd_HH-mm-ss' : 'yyyy-MM-dd_HH-mm';
    return format(parse(latestBackup, backupFormat, new Date()), 'yyyy/MM/dd HH:mm:ss');
}

async function readBackupFolder(wikiIdFolderPath, wikiId, { fsAdapter = fs, readJson = fse.readJson } = {}) {
    const backups = [];
    const errors = [];

    try {
        if (wikiId && !fsAdapter.existsSync(wikiIdFolderPath)) return { gameData: null, errors };
        const stats = fsAdapter.lstatSync(wikiIdFolderPath);
        if (!stats.isDirectory() || stats.isSymbolicLink()) return { gameData: null, errors };

        const backupFolders = fsAdapter.readdirSync(wikiIdFolderPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name)
            .filter((backupDate) => {
                try {
                    normalizeBackupDate(backupDate);
                    return true;
                } catch (_) {
                    return false;
                }
            });

        for (const backupFolder of backupFolders) {
            const backupFolderPath = path.join(wikiIdFolderPath, backupFolder);
            const configFilePath = path.join(backupFolderPath, 'backup_info.json');
            const backupSize = calculateDirectorySize(backupFolderPath, true, fsAdapter);

            if (fsAdapter.existsSync(configFilePath)) {
                try {
                    const configStats = fsAdapter.lstatSync(configFilePath);
                    if (!configStats.isFile() || configStats.isSymbolicLink() || configStats.size > 1024 * 1024) {
                        throw new Error('Backup metadata is not a regular bounded file');
                    }
                    const backupConfig = validateBackupMetadata(await readJson(configFilePath));
                    backups.push({
                        date: backupFolder,
                        title: backupConfig.title,
                        zh_CN: backupConfig.zh_CN,
                        backup_size: backupSize,
                        backup_paths: backupConfig.backup_paths,
                        provenance: backupConfig.provenance,
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
        const backupFormat = latestBackup.date.length === 19 ? 'yyyy-MM-dd_HH-mm-ss' : 'yyyy-MM-dd_HH-mm';
        const latestBackupFormatted = format(parse(latestBackup.date, backupFormat, new Date()), 'yyyy/MM/dd HH:mm:ss');

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
    calculateDirectorySizeAsync,
    ensureWritable,
    copyFolder,
    copyFolderAsync,
    copyFolderAtomically,
    getLatestModificationTime,
    getLatestModificationTimeAsync,
    getNewestBackup,
    readBackupFolder
};
