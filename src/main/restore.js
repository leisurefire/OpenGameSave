const { BrowserWindow, ipcMain } = require('electron');

const { randomUUID } = require('crypto');

const fsOriginal = require('original-fs');
const path = require('path');

const i18next = require('i18next');
const { format } = require('date-fns');

const { getGameData } = require('./gameData');
const {
    getGameDisplayName, placeholder_mapping, getSettings
} = require('./global');
const { runWorkerTask } = require('./backup');

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

async function restoreGame(gameObj, userActionForAll) {
    let localActionForAll = userActionForAll;
    const pathsToCheck = [];
    let gameNotInstalled = false;
    let steamNotInstalled = false;
    let ubisoftNotInstalled = false;

    try {
        const gameBackupPath = path.join(getSettings().backupPath, gameObj.wiki_page_id.toString());

        // Find the latest backup folder based on the backup date
        const latestBackupFolder = gameObj.backups.sort((a, b) => b.date.localeCompare(a.date))[0];
        const latestBackupPath = path.join(gameBackupPath, latestBackupFolder.date);

        for (const backupPath of latestBackupFolder.backup_paths) {
            const sourcePath = path.join(latestBackupPath, backupPath.folder_name);
            const destinationPath = resolveTemplatedRestorePath(backupPath.template, backupPath.install_folder);

            if (!fsOriginal.existsSync(sourcePath)) {
                console.warn(`Source path does not exist: ${sourcePath}`);
                continue;
            }

            if (backupPath.type !== 'reg' && !path.isAbsolute(destinationPath.replace(/^[/\\]+/, ''))) {
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

                console.warn(`Destination path is not absolute: ${destinationPath}`);
                continue;
            }

            pathsToCheck.push({ sourcePath, destinationPath, backupType: backupPath.type });
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
        console.error(`Error during restore for game: ${getGameDisplayName(gameObj)}`, error.stack);
        return { action: localActionForAll, error: `${i18next.t('alert.restore_game_error', { game_name: getGameDisplayName(gameObj) })}: ${error.message}` };
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
            if (responseId !== requestId) return;
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
    let basePath = templatedPath.replace(/\{\{p\|[^\}]+\}\}/gi, match => {
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

    return basePath;
}

function getGameInstallPath(installFolder) {
    const gameInstallPaths = getSettings().gameInstalls;

    for (const installPath of gameInstallPaths) {
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
