const { BrowserWindow, ipcMain } = require('electron');

const { randomUUID } = require('crypto');

const fsOriginal = require('original-fs');
const os = require('os');
const path = require('path');

const i18next = require('i18next');
const { format } = require('date-fns');

const { getGameData } = require('./gameData');
const {
    getGameDisplayName, placeholder_mapping, getSettings
} = require('./global');
const { runWorkerTask } = require('./backup');
const { assertNoSymlinkAncestors, isPathInside, isXboxPgsPath, normalizeBackupDate, normalizeRegistryKeyPath, normalizeWikiId, resolveInside } = require('./validation');

const RESTORE_CONFLICT_RESPONSE_TIMEOUT_MS = 30000;

async function getGameDataForRestore(wikiId = null) {
    try {
        const result = await runWorkerTask('getGameDataForRestore', { wikiId });
        return { games: result.games || [], errors: result.errors || [] };
    } catch (error) {
        console.error(`Restore worker scan failed: ${error.stack || error.message}`);
        return { games: [], errors: [error.message] };
    }
}

async function restoreGame(wikiId, requestedBackupDate, userActionForAll) {
    let localActionForAll = userActionForAll;
    const pathsToCheck = [];
    let gameNotInstalled = false;
    let steamNotInstalled = false;
    let ubisoftNotInstalled = false;
    let gameObj = null;

    try {
        const safeWikiId = normalizeWikiId(wikiId);
        const { games, errors } = await getGameDataForRestore(safeWikiId);
        if (errors.length > 0) throw new Error(errors.join('; '));
        gameObj = games[0];
        if (!gameObj || !Array.isArray(gameObj.backups) || gameObj.backups.length === 0) {
            throw new Error('No valid backups are available for this game');
        }

        const backupRoot = path.resolve(getSettings().backupPath);
        const gameBackupPath = resolveInside(backupRoot, safeWikiId);

        const selectedBackupDate = requestedBackupDate == null
            ? null
            : normalizeBackupDate(requestedBackupDate);
        const latestBackupFolder = selectedBackupDate
            ? gameObj.backups.find(backup => backup.date === selectedBackupDate)
            : [...gameObj.backups].sort((a, b) => b.date.localeCompare(a.date))[0];
        if (!latestBackupFolder) throw new Error('The requested backup no longer exists');
        const latestBackupPath = resolveInside(gameBackupPath, normalizeBackupDate(latestBackupFolder.date));

        for (const backupPath of latestBackupFolder.backup_paths) {
            const sourcePath = resolveInside(latestBackupPath, backupPath.folder_name);
            const destinationPath = resolveTemplatedRestorePath(backupPath.template, backupPath.install_folder);

            if (!fsOriginal.existsSync(sourcePath)) {
                console.warn(`Source path does not exist: ${sourcePath}`);
                continue;
            }
            const sourceStats = fsOriginal.lstatSync(sourcePath);
            if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
                throw new Error('Backup source is not a regular directory');
            }

            if (backupPath.type === 'reg' && !isAllowedRegistryRestorePath(destinationPath)) {
                throw new Error('Backup contains an invalid registry destination');
            }

            // PGS metadata and the active snapshot are managed transactionally by Xbox
            // Gaming Services. A raw folder copy is useful as a backup, but writing it
            // back while cloud synchronization is active can corrupt or overwrite saves.
            if (backupPath.type !== 'reg' && isXboxPgsPath(destinationPath)) {
                console.warn(`Automatic Xbox PGS restore is blocked: ${destinationPath}`);
                throw Error(i18next.t('alert.xbox_pgs_restore_blocked'));
            }

            const allowedRoot = backupPath.type === 'reg' ? null : getAllowedRestoreRoot(destinationPath);
            if (backupPath.type !== 'reg' && (!path.isAbsolute(destinationPath) || !allowedRoot)) {
                const normalizedTemplate = backupPath.template.toLowerCase();

                if (normalizedTemplate.includes('{{p|game}}')) {
                    gameNotInstalled = true;
                } else if (normalizedTemplate.includes('{{p|steam}}')) {
                    steamNotInstalled = true;
                } else if (normalizedTemplate.includes('{{p|ubisoftconnect}}') || normalizedTemplate.includes('{{p|uplay}}')) {
                    ubisoftNotInstalled = true;
                } else if (normalizedTemplate.includes('{{p|xbox_uid}}')) {
                    // Xbox UID not found - this will be caught below
                    console.warn(`Xbox UID not found for restore path: ${destinationPath}`);
                }

                console.warn(`Destination path is outside the allowed save roots: ${destinationPath}`);
                continue;
            }

            if (allowedRoot) await assertNoSymlinkAncestors(allowedRoot, destinationPath, fsOriginal);

            pathsToCheck.push({ sourcePath, destinationPath, backupType: backupPath.type });
        }

        if (pathsToCheck.length === 0) {
            if (gameNotInstalled) throw Error(i18next.t('alert.game_not_installed'));
            if (steamNotInstalled) throw Error(i18next.t('alert.steam_not_installed'));
            if (ubisoftNotInstalled) throw Error(i18next.t('alert.ubisoft_not_installed'));
            throw new Error('Backup does not contain any restorable paths');
        }

        // Check for any conflicts before proceeding with the restore
        const shouldProceed = await shouldSkip(pathsToCheck, getGameDisplayName(gameObj), localActionForAll);

        if (shouldProceed.actionForAll) {
            localActionForAll = shouldProceed.actionForAll;
        }
        if (shouldProceed.skip) {
            return { action: localActionForAll, error: `${i18next.t('alert.restore_game_error', { game_name: getGameDisplayName(gameObj) })}: ${i18next.t('alert.manually_skipped')}` };
        }

        await runWorkerTask('restorePaths', { pathsToRestore: pathsToCheck });

        if (gameNotInstalled) {
            throw Error(i18next.t('alert.game_not_installed'));
        } else if (steamNotInstalled) {
            throw Error(i18next.t('alert.steam_not_installed'));
        } else if (ubisoftNotInstalled) {
            throw Error(i18next.t('alert.ubisoft_not_installed'));
        }

        return { action: localActionForAll, error: null };

    } catch (error) {
        const gameDisplayName = gameObj ? getGameDisplayName(gameObj) : String(wikiId || '');
        console.error(`Error during restore for game: ${gameDisplayName}`, error.stack);
        return { action: localActionForAll, error: `${i18next.t('alert.restore_game_error', { game_name: gameDisplayName })}: ${error.message}` };
    }
}

async function requestRestoreConflictDecision(prompt) {
    const targetWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!targetWindow || targetWindow.isDestroyed()) {
        return { choice: 'skip', doForAll: false };
    }

    return new Promise((resolve) => {
        const requestId = randomUUID();
        let resolved = false;

        const finish = (response) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timeoutId);
            ipcMain.removeListener('restore-conflict-response', handleResponse);
            targetWindow.removeListener('closed', handleWindowClosed);
            resolve(response || { choice: 'skip', doForAll: false });
        };

        const handleResponse = (event, responseId, response) => {
            if (event.sender !== targetWindow.webContents || responseId !== requestId) return;
            finish(response);
        };
        const handleWindowClosed = () => finish({ choice: 'skip', doForAll: false });
        const timeoutId = setTimeout(() => finish({ choice: 'skip', doForAll: false }), RESTORE_CONFLICT_RESPONSE_TIMEOUT_MS);

        ipcMain.on('restore-conflict-response', handleResponse);
        targetWindow.once('closed', handleWindowClosed);
        try {
            if (targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
                finish({ choice: 'skip', doForAll: false });
                return;
            }
            targetWindow.webContents.send('restore-conflict-prompt', requestId, prompt);
        } catch (error) {
            console.error('Failed to send restore conflict prompt:', error);
            finish({ choice: 'skip', doForAll: false });
        }
    });
}

async function shouldSkip(pathsToCheck, gameDisplayName, userActionForAll) {
    const { latestSourceModTime, latestDestModTime } = await runWorkerTask('getRestoreConflictTimes', { pathsToCheck });

    // If the destination files are newer than the source (backup), prompt the user
    if (latestSourceModTime < latestDestModTime) {
        if (userActionForAll) {
            return { skip: userActionForAll === 'skip', actionForAll: userActionForAll };
        }

        const response = await requestRestoreConflictDecision({
            title: i18next.t('alert.save_conflict'),
            message: `${i18next.t('alert.save_conflict_detected', { game: gameDisplayName })}\n\n` +
                `${i18next.t('alert.machine_save_date', { machineTime: format(new Date(latestDestModTime), 'yyyy-MM-dd HH:mm') })}\n` +
                `${i18next.t('alert.backup_save_date', { backupTime: format(new Date(latestSourceModTime), 'yyyy-MM-dd HH:mm') })}\n\n` +
                `${i18next.t('alert.overwrite_prompt')}`,
            checkboxLabel: i18next.t('alert.do_this_for_all')
        });

        const userChoice = response.choice === 'replace' ? 'replace' : 'skip';
        const doForAll = response.doForAll;

        return {
            skip: userChoice === 'skip',
            actionForAll: doForAll ? userChoice : null
        };
    }

    return { skip: false, actionForAll: null };
}

function resolveTemplatedRestorePath(templatedPath, installFolder) {
    const basePath = String(templatedPath || '').replace(/\{\{p\|[^\}]+\}\}/gi, match => {
        const normalizedMatch = match.toLowerCase().replace(/\\/g, '/');

        if (normalizedMatch === '{{p|game}}') {
            return getGameInstallPath(installFolder);
        } else if (normalizedMatch === '{{p|steam}}') {
            return getGameData().steamPath;
        } else if (normalizedMatch === '{{p|uplay}}' || normalizedMatch === '{{p|ubisoftconnect}}') {
            return getGameData().ubisoftPath;
        } else if (normalizedMatch === '{{p|xbox_uid}}') {
            // Xbox UID placeholder: resolve to actual Xbox UID
            // Note: finalTemplate normally already contains the resolved path after backup,
            // but this handles edge cases where the raw placeholder appears.
            // The full path pattern (including Game ID) is provided by the database.
            const xboxUid = getGameData().currentXboxUserId;
            if (xboxUid) {
                return xboxUid;
            }
            // If no Xbox UID found, return empty string to fail the absolute path check gracefully
            return '';
        }

        return placeholder_mapping[normalizedMatch] || match;
    });

    if (/\{\{p\|[^\}]+\}\}/i.test(basePath) || basePath.includes('\0')) return '';
    return path.normalize(basePath);
}

function getAllowedRestoreRoot(destinationPath) {
    const currentGameData = getGameData();
    const configuredInstallPaths = Array.isArray(getSettings().gameInstalls) ? getSettings().gameInstalls : [];
    const allowedRoots = [
        os.homedir(),
        process.env.APPDATA,
        process.env.LOCALAPPDATA,
        process.env.PROGRAMDATA,
        process.env.PUBLIC,
        currentGameData.steamPath,
        currentGameData.ubisoftPath,
        ...configuredInstallPaths
    ].filter(root => typeof root === 'string' && path.isAbsolute(root));
    return allowedRoots
        .filter(root => isPathInside(root, destinationPath))
        .sort((left, right) => right.length - left.length)[0] || null;
}

function isAllowedRegistryRestorePath(registryPath) {
    try {
        normalizeRegistryKeyPath(registryPath);
        return true;
    } catch (_) {
        return false;
    }
}

function getGameInstallPath(installFolder) {
    const gameInstallPaths = getSettings().gameInstalls;
    if (!Array.isArray(gameInstallPaths)) return 'gameNotInstalled';

    for (const installPath of gameInstallPaths) {
        if (!fsOriginal.existsSync(installPath)) continue;
        const directories = fsOriginal.readdirSync(installPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        for (const dir of directories) {
            if (dir === installFolder) {
                return path.join(installPath, dir);
            }
        }
    }

    return 'gameNotInstalled';
}

module.exports = {
    getGameDataForRestore,
    restoreGame,
};
