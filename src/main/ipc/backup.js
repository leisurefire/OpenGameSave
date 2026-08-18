const { ipcMain, shell } = require('electron');

const { randomUUID } = require('crypto');
const fsOriginal = require('original-fs');

const fse = require('fs-extra');
const i18next = require('i18next');

const { startAutoBackup, stopAutoBackup, getAutoBackupState } = require('../autoBackup');
const { backupGame, getGameDataFromDB } = require('../backup');
const {
    browseLocalSave,
    deleteLocalSave,
    exportBackups,
    getMainWin,
    getSettings,
    importBackups,
    moveFilesWithProgress
} = require('../global');
const { acquireGameOperation } = require('../gameOperationLock');
const { isXboxPgsPath, normalizeWikiId, resolveInside, validateBackupMetadata } = require('../validation');
const { getVerifiedBackupPath, getVerifiedLocalSavePaths } = require('../services/backupPathService');

function sendMainAlert(type, message, details) {
    const mainWindow = getMainWin();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('show-alert', type, message, details);
    }
}

async function updateBackupInfo(wikiId, backupDate, key, value) {
    let releaseOperation;
    try {
        releaseOperation = acquireGameOperation(wikiId, 'update backup metadata');
        if (!new Set(['is_permanent', 'custom_name']).has(key)) {
            throw new Error('Invalid backup metadata key');
        }

        const backupInstancePath = await getVerifiedBackupPath(wikiId, backupDate);
        const configFilePath = resolveInside(backupInstancePath, 'backup_info.json');
        const configStats = await fsOriginal.promises.lstat(configFilePath).catch(() => null);
        if (!configStats?.isFile() || configStats.isSymbolicLink() || configStats.size > 1024 * 1024) {
            throw new Error('Backup config file not found');
        }

        const backupConfig = await fse.readJson(configFilePath);
        if (key === 'is_permanent') {
            if (typeof value !== 'boolean') throw new Error('Invalid permanent flag');
            backupConfig.is_permanent = value;
        } else {
            if (typeof value !== 'string' || value.length > 120) throw new Error('Invalid backup name');
            backupConfig.custom_name = value;
        }

        const tempConfigPath = `${configFilePath}.${randomUUID()}.tmp`;
        try {
            const normalizedConfig = validateBackupMetadata(backupConfig);
            await fsOriginal.promises.writeFile(tempConfigPath, `${JSON.stringify(normalizedConfig, null, 4)}\n`, {
                encoding: 'utf8',
                mode: 0o600,
                flag: 'wx'
            });
            await fsOriginal.promises.rename(tempConfigPath, configFilePath);
        } catch (error) {
            await fsOriginal.promises.rm(tempConfigPath, { force: true }).catch(() => {});
            throw error;
        }
        return true;
    } catch (error) {
        console.error(`Error updating backup info for ${backupDate}/${wikiId}:`, error.message);
        sendMainAlert('error', i18next.t('alert.backup_update_failed'));
        return false;
    } finally {
        releaseOperation?.();
    }
}

async function deleteBackup(wikiId, backupDate) {
    let releaseOperation;
    try {
        releaseOperation = acquireGameOperation(wikiId, 'delete backup');
        await fsOriginal.promises.rm(await getVerifiedBackupPath(wikiId, backupDate), {
            recursive: true,
            force: true
        });
        return true;
    } catch (error) {
        console.error(`Error deleting backup ${backupDate}/${wikiId}:`, error.message);
        sendMainAlert('error', i18next.t('alert.backup_delete_failed'));
        return false;
    } finally {
        releaseOperation?.();
    }
}

function registerBackupIpc({ ensureGameDataReady }) {
    ipcMain.handle('fetch-backup-table-data', async (event, ignoreUninstalled, wikiId = null) => {
        await ensureGameDataReady();
        const safeWikiId = wikiId == null ? null : normalizeWikiId(wikiId);
        const { games, errors } = await getGameDataFromDB(ignoreUninstalled === true, safeWikiId);
        if (errors.length > 0) sendMainAlert('modal', i18next.t('alert.backup_process_error_display'), errors);
        return games;
    });
    ipcMain.handle('backup-game', async (event, gameObj) => {
        await ensureGameDataReady();
        const wikiId = normalizeWikiId(gameObj?.wiki_page_id);
        const { games } = await getGameDataFromDB(false, wikiId);
        if (!games?.[0]) throw new Error('Game data is no longer available');
        return backupGame(games[0]);
    });
    ipcMain.handle('delete-backup', (event, wikiId, backupDate) => deleteBackup(wikiId, backupDate));
    ipcMain.handle('update-backup-info', (event, wikiId, backupDate, key, value) => (
        updateBackupInfo(wikiId, backupDate, key, value)
    ));
    ipcMain.on('open-backup-folder', async (event, wikiId) => {
        const backupPath = await getVerifiedBackupPath(wikiId).catch(() => null);
        const entries = backupPath ? await fsOriginal.promises.readdir(backupPath).catch(() => []) : [];
        if (entries.length > 0) await shell.openPath(backupPath);
        else sendMainAlert('warning', i18next.t('alert.no_backups_found'));
    });
    ipcMain.on('browse-local-save', async (event, wikiId, selectedIndexes = null) => {
        try {
            await browseLocalSave(await getVerifiedLocalSavePaths(wikiId, selectedIndexes));
        } catch (error) {
            console.error('Error validating local save browse request:', error.message);
            sendMainAlert('error', error.message);
        }
    });
    ipcMain.handle('delete-local-save', async (event, wikiId) => {
        let releaseOperation;
        try {
            releaseOperation = acquireGameOperation(wikiId, 'delete local save');
            const resolvedPaths = await getVerifiedLocalSavePaths(wikiId);
            if (resolvedPaths.some(item => item.type !== 'reg' && isXboxPgsPath(item.resolved))) {
                throw new Error(i18next.t('alert.xbox_pgs_delete_blocked'));
            }
            return await deleteLocalSave(resolvedPaths);
        } catch (error) {
            console.error('Error validating local save delete request:', error.message);
            sendMainAlert('error', error.message);
            return false;
        } finally {
            releaseOperation?.();
        }
    });
    ipcMain.handle('migrate-backups', (event, newBackupPath) => (
        moveFilesWithProgress(getSettings().backupPath, newBackupPath)
    ));
    ipcMain.on('export-backups', (event, count, exportPath, wikiIds) => exportBackups(count, exportPath, wikiIds));
    ipcMain.on('import-backups', (event, gsmPath) => importBackups(gsmPath));
    ipcMain.handle('start-auto-backup', async (event, wikiId, mode, intervalMinutes) => {
        await ensureGameDataReady();
        const releaseOperation = acquireGameOperation(wikiId, 'configure auto backup');
        try {
            return await startAutoBackup(wikiId, mode, intervalMinutes);
        } finally {
            releaseOperation();
        }
    });
    ipcMain.handle('stop-auto-backup', async (event, wikiId) => {
        const releaseOperation = acquireGameOperation(wikiId, 'configure auto backup');
        try {
            return await stopAutoBackup(wikiId, true);
        } finally {
            releaseOperation();
        }
    });
    ipcMain.handle('get-auto-backup-state', getAutoBackupState);
}

module.exports = { registerBackupIpc };
