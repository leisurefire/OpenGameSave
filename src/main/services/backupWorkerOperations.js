const { execFile } = require('child_process');
const fsOriginal = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const fse = require('fs-extra');
const { format } = require('date-fns');
const WinReg = require('winreg');

const {
    copyFolder: fsOriginalCopyFolder,
    getLatestModificationTime,
    readBackupFolder
} = require('../fileSystemUtils');
const {
    assertNoSymlinkAncestors,
    isPathInside,
    normalizeBackupDate,
    normalizeRegistryKeyPath,
    normalizeWikiId,
    resolveInside,
    validateBackupMetadata
} = require('../validation');
const { getSettings } = require('./backupWorkerContext');
const { restoreFileSystemPathsTransactionally } = require('./restoreFileSystemTransaction');

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
            provenance: 'local',
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
                try {
                    const existingConfig = validateBackupMetadata(await fse.readJson(backupConfigPath));
                    if (!existingConfig.is_permanent) {
                        nonPermanentBackups.push(backup);
                    }
                } catch (error) {
                    // Preserve a damaged historical snapshot for manual recovery. It
                    // must not make this newly completed backup look like a failure.
                    console.warn(`Skipping retention cleanup for invalid backup ${backup}: ${error.message}`);
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
    const backupRoot = path.resolve(getSettings().backupPath);
    const fileSystemPaths = [];
    const registryPaths = [];
    for (const restorePath of pathsToRestore) {
        if (restorePath.backupType === 'reg') {
            registryPaths.push(restorePath);
        } else if (restorePath.backupType === 'file' || restorePath.backupType === 'folder') {
            fileSystemPaths.push(restorePath);
        } else {
            throw new Error(`Unknown backup type: ${restorePath.backupType}`);
        }
    }

    const registryTransaction = await applyRegistryRestoreTransaction(registryPaths, backupRoot);
    try {
        await restoreFileSystemPathsTransactionally(fileSystemPaths, { backupRoot, fsAdapter: fsOriginal });
        await registryTransaction.commit();
        return null;
    } catch (error) {
        try {
            await registryTransaction.rollback();
        } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Restore failed and registry rollback was incomplete');
        }
        throw error;
    }
}

function registryPathsOverlap(left, right) {
    const normalizedLeft = normalizeRegistryKeyPath(left).toLowerCase();
    const normalizedRight = normalizeRegistryKeyPath(right).toLowerCase();
    return normalizedLeft === normalizedRight
        || normalizedLeft.startsWith(`${normalizedRight}\\`)
        || normalizedRight.startsWith(`${normalizedLeft}\\`);
}

function parseRegistryDestination(registryPath) {
    const segments = normalizeRegistryKeyPath(registryPath).split('\\');
    const hiveName = segments.shift();
    const hives = {
        HKEY_CURRENT_USER: WinReg.HKCU,
        HKEY_LOCAL_MACHINE: WinReg.HKLM,
        HKEY_CLASSES_ROOT: WinReg.HKCR
    };
    return { hive: hives[hiveName], key: `\\${segments.join('\\')}` };
}

function registryKeyExists(registryPath) {
    const { hive, key } = parseRegistryDestination(registryPath);
    return new Promise((resolve, reject) => {
        new WinReg({ hive, key }).keyExists((error, exists) => {
            if (error) reject(error);
            else resolve(exists);
        });
    });
}

async function rollbackRegistryChanges(applied, rollbackRoot) {
    const errors = [];
    for (const restorePath of [...applied].reverse()) {
        try {
            if (restorePath.hadPreviousValue) {
                await execFilePromise('reg.exe', ['import', restorePath.previousPath], { windowsHide: true });
            } else if (await registryKeyExists(restorePath.destinationPath)) {
                await execFilePromise('reg.exe', ['delete', restorePath.destinationPath, '/f'], { windowsHide: true });
            }
        } catch (error) {
            errors.push(error);
        }
    }
    if (errors.length === 0) {
        await fsOriginal.promises.rm(rollbackRoot, { recursive: true, force: true });
    }
    if (errors.length > 0) {
        throw new AggregateError(errors, `Registry rollback data retained at ${rollbackRoot}`);
    }
}

async function applyRegistryRestoreTransaction(registryPaths, backupRoot) {
    if (registryPaths.length === 0) {
        return { commit: async () => undefined, rollback: async () => undefined };
    }
    if (process.platform !== 'win32') throw new Error('Registry restore is only supported on Windows');

    const normalizedPaths = [];
    for (const restorePath of registryPaths) {
        if (restorePath.untrusted) {
            throw new Error('Registry restore from an external backup is not allowed');
        }
        const sourcePath = path.resolve(restorePath.sourcePath);
        if (sourcePath === backupRoot || !isPathInside(backupRoot, sourcePath)) {
            throw new Error('Registry restore source escapes the backup root');
        }
        await assertNoSymlinkAncestors(backupRoot, sourcePath, fsOriginal);
        const destinationPath = normalizeRegistryKeyPath(restorePath.destinationPath);
        if (normalizedPaths.some(item => registryPathsOverlap(item.destinationPath, destinationPath))) {
            throw new Error('Registry restore destinations overlap');
        }
        const registryFilePath = path.join(sourcePath, 'registry_backup.reg');
        validateRegistryBackupFile(registryFilePath, destinationPath);
        normalizedPaths.push({ destinationPath, registryFilePath });
    }

    const rollbackRoot = await fsOriginal.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-reg-restore-'));
    const applied = [];
    let finished = false;
    try {
        for (const [index, restorePath] of normalizedPaths.entries()) {
            const previousPath = path.join(rollbackRoot, `previous-${index}.reg`);
            const hadPreviousValue = await registryKeyExists(restorePath.destinationPath);
            if (hadPreviousValue) {
                await execFilePromise('reg.exe', ['export', restorePath.destinationPath, previousPath, '/y'], { windowsHide: true });
            }
            applied.push({ ...restorePath, previousPath, hadPreviousValue });
            await execFilePromise('reg.exe', ['import', restorePath.registryFilePath], { windowsHide: true });
        }
    } catch (error) {
        try {
            await rollbackRegistryChanges(applied, rollbackRoot);
        } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Registry restore failed and rollback was incomplete');
        }
        throw error;
    }

    return {
        async commit() {
            if (finished) return;
            finished = true;
            await fsOriginal.promises.rm(rollbackRoot, { recursive: true, force: true });
        },
        async rollback() {
            if (finished) return;
            finished = true;
            await rollbackRegistryChanges(applied, rollbackRoot);
        }
    };
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
