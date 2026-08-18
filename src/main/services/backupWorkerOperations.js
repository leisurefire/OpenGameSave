const { execFile } = require('child_process');
const fsOriginal = require('fs');
const path = require('path');
const util = require('util');

const fse = require('fs-extra');
const { format } = require('date-fns');

const {
    copyFolder: fsOriginalCopyFolder,
    ensureWritable,
    getLatestModificationTime,
    readBackupFolder
} = require('../fileSystemUtils');
const {
    normalizeBackupDate,
    normalizeRegistryKeyPath,
    normalizeWikiId,
    resolveInside,
    validateBackupMetadata
} = require('../validation');
const { getSettings } = require('./backupWorkerContext');

const execFilePromise = util.promisify(execFile);

function getGameDisplayName(gameObject) {
    return getSettings().language === 'zh_CN' ? gameObject.zh_CN || gameObject.title : gameObject.title;
}

async function backupGame(gameObj) {
    const backupRoot = path.resolve(getSettings().backupPath);
    const wikiId = normalizeWikiId(gameObj.wiki_page_id);
    const gameBackupPath = resolveInside(backupRoot, wikiId);
    let backupTime = new Date();
    let backupInstanceFolder = format(backupTime, 'yyyy-MM-dd_HH-mm-ss');
    while (fsOriginal.existsSync(resolveInside(gameBackupPath, backupInstanceFolder))) {
        backupTime = new Date(backupTime.getTime() + 1000);
        backupInstanceFolder = format(backupTime, 'yyyy-MM-dd_HH-mm-ss');
    }
    const backupInstancePath = resolveInside(gameBackupPath, backupInstanceFolder);
    let backupInstanceCreated = false;

    try {
        fsOriginal.mkdirSync(backupRoot, { recursive: true });
        const backupRootStats = fsOriginal.lstatSync(backupRoot);
        if (!backupRootStats.isDirectory() || backupRootStats.isSymbolicLink()) {
            throw new Error('Backup root is not a regular directory');
        }
        fsOriginal.mkdirSync(gameBackupPath, { recursive: true });
        const gameBackupStats = fsOriginal.lstatSync(gameBackupPath);
        if (!gameBackupStats.isDirectory() || gameBackupStats.isSymbolicLink()) {
            throw new Error('Game backup path is not a regular directory');
        }
        fsOriginal.mkdirSync(backupInstancePath);
        backupInstanceCreated = true;
        const backupConfig = {
            title: gameObj.title,
            zh_CN: gameObj.zh_CN || null,
            backup_paths: []
        };

        for (const [index, resolvedPathObj] of gameObj.resolved_paths.entries()) {
            const resolvedPath = path.normalize(resolvedPathObj.resolved);
            const pathFolderName = `path${index + 1}`;
            const targetPath = path.join(backupInstancePath, pathFolderName);
            fsOriginal.mkdirSync(targetPath, { recursive: true });

            if (resolvedPathObj.type === 'reg') {
                const registryFilePath = path.join(targetPath, 'registry_backup.reg');
                const registryPath = normalizeRegistryKeyPath(resolvedPath);
                await execFilePromise('reg.exe', ['export', registryPath, registryFilePath, '/y'], { windowsHide: true });
                backupConfig.backup_paths.push({
                    folder_name: pathFolderName,
                    template: resolvedPathObj.finalTemplate,
                    type: 'reg',
                    install_folder: gameObj.install_folder || null
                });
            } else {
                const stats = fsOriginal.lstatSync(resolvedPath);
                if (stats.isSymbolicLink()) throw new Error(`Refusing to back up symbolic link: ${resolvedPath}`);
                let dataType;

                if (stats.isDirectory()) {
                    dataType = 'folder';
                    fsOriginalCopyFolder(resolvedPath, targetPath);
                } else {
                    dataType = 'file';
                    const targetFilePath = path.join(targetPath, path.basename(resolvedPath));
                    fsOriginal.copyFileSync(resolvedPath, targetFilePath);
                }

                backupConfig.backup_paths.push({
                    folder_name: pathFolderName,
                    template: resolvedPathObj.finalTemplate,
                    type: dataType,
                    install_folder: gameObj.install_folder || null
                });
            }
        }

        await fse.writeJson(resolveInside(backupInstancePath, 'backup_info.json'), validateBackupMetadata(backupConfig), { spaces: 4, mode: 0o600 });

        const nonPermanentBackups = [];
        const backupFolders = fsOriginal.readdirSync(gameBackupPath, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .filter((backupDate) => {
                try {
                    normalizeBackupDate(backupDate);
                    return true;
                } catch (_) {
                    return false;
                }
            })
            .sort((a, b) => a.localeCompare(b));
        for (const backup of backupFolders) {
            const backupConfigPath = resolveInside(gameBackupPath, backup, 'backup_info.json');
            if (fsOriginal.existsSync(backupConfigPath)) {
                const existingConfig = validateBackupMetadata(await fse.readJson(backupConfigPath));
                if (!existingConfig.is_permanent) {
                    nonPermanentBackups.push(backup);
                }
            } else {
                nonPermanentBackups.push(backup);
            }
        }

        const maxBackups = getSettings().maxBackups;
        if (nonPermanentBackups.length > maxBackups) {
            const backupsToDelete = nonPermanentBackups.slice(0, nonPermanentBackups.length - maxBackups);
            for (const backup of backupsToDelete) {
                fsOriginal.rmSync(path.join(gameBackupPath, backup), { recursive: true, force: true });
            }
        }
    } catch (error) {
        if (backupInstanceCreated) {
            await fsOriginal.promises.rm(backupInstancePath, { recursive: true, force: true }).catch(() => undefined);
        }
        console.error(`Error during backup for game ${getGameDisplayName(gameObj)}: ${error.stack}`);
        return `Error during backup for ${getGameDisplayName(gameObj)}: ${error.message}`;
    }

    return null;
}

async function getGameDataForRestore({ wikiId = null }) {
    const backupPath = path.resolve(getSettings().backupPath);
    fsOriginal.mkdirSync(backupPath, { recursive: true });
    const errors = [];
    const backupRootStats = fsOriginal.lstatSync(backupPath);
    if (!backupRootStats.isDirectory() || backupRootStats.isSymbolicLink()) {
        throw new Error('Backup root is not a regular directory');
    }

    if (wikiId) {
        const safeWikiId = normalizeWikiId(wikiId);
        const wikiIdFolderPath = resolveInside(backupPath, safeWikiId);
        const { gameData, errors: fetchErrors } = await readBackupFolder(wikiIdFolderPath, safeWikiId, { fsAdapter: fsOriginal });
        errors.push(...fetchErrors);
        return { games: gameData ? [gameData] : [], errors };
    }

    const gameFolders = fsOriginal.readdirSync(backupPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name)
        .filter((gameFolder) => {
            try {
                normalizeWikiId(gameFolder);
                return true;
            } catch (_) {
                return false;
            }
        });
    const games = [];

    for (const gameFolder of gameFolders) {
        const wikiIdFolderPath = path.join(backupPath, gameFolder);
        const { gameData, errors: fetchErrors } = await readBackupFolder(wikiIdFolderPath, gameFolder, { fsAdapter: fsOriginal });
        errors.push(...fetchErrors);
        if (gameData) {
            games.push(gameData);
        }
    }

    return { games, errors };
}

async function restorePaths(pathsToRestore) {
    for (const { sourcePath, destinationPath, backupType } of pathsToRestore) {
        ensureWritable(destinationPath);

        if (backupType === 'folder') {
            fsOriginal.mkdirSync(destinationPath, { recursive: true });
            fsOriginalCopyFolder(sourcePath, destinationPath);
        } else if (backupType === 'file') {
            fsOriginal.mkdirSync(path.dirname(destinationPath), { recursive: true });
            fsOriginal.copyFileSync(path.join(sourcePath, path.basename(destinationPath)), destinationPath);
        } else if (backupType === 'reg') {
            const registryFilePath = path.join(sourcePath, 'registry_backup.reg');
            validateRegistryBackupFile(registryFilePath, destinationPath);
            await execFilePromise('reg.exe', ['import', registryFilePath], { windowsHide: true });
        } else {
            console.warn(`Unknown backup type: ${backupType}`);
        }
    }

    return null;
}

function validateRegistryBackupFile(registryFilePath, destinationPath) {
    const stats = fsOriginal.lstatSync(registryFilePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 10 * 1024 * 1024) {
        throw new Error('Registry backup file is invalid');
    }
    const buffer = fsOriginal.readFileSync(registryFilePath);
    const text = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
        ? buffer.subarray(2).toString('utf16le')
        : buffer.toString('utf8');
    const expectedKey = String(destinationPath || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    const headerPattern = /^\s*\[(-?)(HKEY_[^\]]+)\]\s*$/gim;
    let headerCount = 0;
    let match;
    while ((match = headerPattern.exec(text)) !== null) {
        headerCount += 1;
        const actualKey = match[2].replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
        if (match[1] === '-' || (actualKey !== expectedKey && !actualKey.startsWith(`${expectedKey}\\`))) {
            throw new Error('Registry backup targets an unexpected key');
        }
    }
    if (headerCount === 0) throw new Error('Registry backup has no key headers');
}

async function getRestoreConflictTimes(pathsToCheck) {
    let latestSourceModTime = 0;
    let latestDestModTime = 0;

    for (const { sourcePath, destinationPath } of pathsToCheck) {
        const srcModTime = getLatestModificationTime(sourcePath);
        const destModTime = getLatestModificationTime(destinationPath);

        if (srcModTime > latestSourceModTime) {
            latestSourceModTime = srcModTime;
        }
        if (destModTime > latestDestModTime) {
            latestDestModTime = destModTime;
        }
    }

    return { latestSourceModTime, latestDestModTime };
}
module.exports = {
    backupGame,
    getGameDataForRestore,
    getRestoreConflictTimes,
    restorePaths
};

