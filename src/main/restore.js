const fsOriginal = require('original-fs');
const os = require('os');
const path = require('path');

const i18next = require('i18next');
const { format } = require('date-fns');

const { getAllUserIds, getGameData } = require('./gameData');
const {
    getGameDisplayName, placeholder_mapping, getSettings
} = require('./global');
const { runWorkerTask } = require('./backup');
const { authorizeRestoreDestination } = require('./restoreAuthorization');
const { requestDialogModalWindow } = require('./services/windowManager');
const { assertNoSymlinkAncestors, isPathInside, isXboxPgsPath, normalizeBackupDate, normalizeWikiId, resolveInside } = require('./validation');

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
        const trustedDefinition = await runWorkerTask('getTrustedRestoreDefinition', { wikiId: safeWikiId });
        const currentGameData = getGameData();
        const currentUserIds = getAllUserIds();
        const trustedUserIds = [...new Set(Object.values(currentUserIds)
            .filter(value => typeof value === 'string' && value && value !== 'N/A'))];
        const placeholderValues = { ...placeholder_mapping };
        if (typeof currentGameData.steamPath === 'string' && currentGameData.steamPath) {
            placeholderValues.steam = currentGameData.steamPath;
        }
        if (typeof currentGameData.ubisoftPath === 'string' && currentGameData.ubisoftPath) {
            placeholderValues.uplay = currentGameData.ubisoftPath;
            placeholderValues.ubisoftconnect = currentGameData.ubisoftPath;
        }
        const allowedRoots = getConfiguredRestoreRoots();

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
            const authorization = authorizeRestoreDestination({
                currentTemplates: {
                    file: trustedDefinition.fileTemplates,
                    registry: trustedDefinition.registryTemplates
                },
                trustedInstallFolder: trustedDefinition.trustedInstallPath,
                placeholderValues,
                allowedRoots,
                dynamicValues: {
                    uid: trustedUserIds,
                    xbox_uid: typeof currentUserIds.xboxId === 'string' && currentUserIds.xboxId
                        ? [currentUserIds.xboxId]
                        : []
                },
                metadata: { template: backupPath.template, type: backupPath.type },
                pathFlavor: process.platform === 'win32' ? 'win32' : 'posix'
            });
            const destinationPath = authorization.destination;

            if (!fsOriginal.existsSync(sourcePath)) {
                console.warn(`Source path does not exist: ${sourcePath}`);
                continue;
            }
            const sourceStats = fsOriginal.lstatSync(sourcePath);
            if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
                throw new Error('Backup source is not a regular directory');
            }

            // PGS metadata and the active snapshot are managed transactionally by Xbox
            // Gaming Services. A raw folder copy is useful as a backup, but writing it
            // back while cloud synchronization is active can corrupt or overwrite saves.
            if (backupPath.type !== 'reg' && isXboxPgsPath(destinationPath)) {
                console.warn(`Automatic Xbox PGS restore is blocked: ${destinationPath}`);
                throw Error(i18next.t('alert.xbox_pgs_restore_blocked'));
            }

            const allowedRoot = authorization.allowedRoot;
            if (allowedRoot) await assertNoSymlinkAncestors(allowedRoot, destinationPath, fsOriginal);

            pathsToCheck.push({
                sourcePath,
                destinationPath,
                backupType: backupPath.type,
                allowedRoot,
                untrusted: latestBackupFolder.provenance !== 'local'
            });
        }

        const independentPaths = collapseOverlappingRestorePaths(pathsToCheck);
        pathsToCheck.splice(0, pathsToCheck.length, ...independentPaths);

        if (pathsToCheck.length === 0) {
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

        return { action: localActionForAll, error: null };

    } catch (error) {
        const gameDisplayName = gameObj ? getGameDisplayName(gameObj) : String(wikiId || '');
        console.error(`Error during restore for game: ${gameDisplayName}`, error.stack);
        return { action: localActionForAll, error: `${i18next.t('alert.restore_game_error', { game_name: gameDisplayName })}: ${error.message}` };
    }
}

async function requestRestoreConflictDecision(prompt) {
    const result = await requestDialogModalWindow({
        title: prompt.title,
        content: prompt.message,
        iconType: 'warning',
        buttons: [
            { value: 'skip', text: i18next.t('alert.no') },
            { value: 'replace', text: i18next.t('alert.yes'), primary: true }
        ],
        closeValue: 'skip',
        checkbox: { label: prompt.checkboxLabel }
    });
    return {
        choice: result?.value === 'replace' ? 'replace' : 'skip',
        doForAll: result?.checked === true
    };
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

function getConfiguredRestoreRoots() {
    const currentGameData = getGameData();
    const configuredInstallPaths = Array.isArray(getSettings().gameInstalls) ? getSettings().gameInstalls : [];
    return [
        os.homedir(),
        process.env.APPDATA,
        process.env.LOCALAPPDATA,
        process.env.PROGRAMDATA,
        process.env.PUBLIC,
        currentGameData.steamPath,
        currentGameData.ubisoftPath,
        ...configuredInstallPaths
    ].filter(root => typeof root === 'string' && path.isAbsolute(root));
}

function collapseOverlappingRestorePaths(pathsToRestore) {
    const registryPaths = pathsToRestore.filter(item => item.backupType === 'reg');
    const fileSystemPaths = pathsToRestore
        .filter(item => item.backupType !== 'reg')
        .sort((left, right) => left.destinationPath.length - right.destinationPath.length);
    const independentPaths = [];
    for (const candidate of fileSystemPaths) {
        const parent = independentPaths.find(item => isPathInside(item.destinationPath, candidate.destinationPath));
        if (!parent) {
            independentPaths.push(candidate);
            continue;
        }
        if (parent.destinationPath === candidate.destinationPath || parent.backupType === 'folder') {
            continue;
        }
        throw new Error('Restore destinations overlap in an unsupported way');
    }
    return [...independentPaths, ...registryPaths];
}

module.exports = {
    getGameDataForRestore,
    restoreGame
};
