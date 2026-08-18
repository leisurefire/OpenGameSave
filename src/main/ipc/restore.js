const { ipcMain } = require('electron');

const i18next = require('i18next');

const { getMainWin } = require('../global');
const { acquireGameOperation } = require('../gameOperationLock');
const { getGameDataForRestore, restoreGame } = require('../restore');
const { normalizeBackupDate, normalizeWikiId } = require('../validation');

function registerRestoreIpc({ ensureGameDataReady }) {
    ipcMain.handle('fetch-restore-table-data', async (event, wikiId = null) => {
        await ensureGameDataReady();
        const safeWikiId = wikiId == null ? null : normalizeWikiId(wikiId);
        const { games, errors } = await getGameDataForRestore(safeWikiId);
        if (errors.length > 0) {
            const mainWindow = getMainWin();
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(
                    'show-alert',
                    'modal',
                    i18next.t('alert.backup_process_error_display'),
                    errors
                );
            }
        }
        return games;
    });

    ipcMain.handle('restore-game', async (event, gameObj, userActionForAll) => {
        await ensureGameDataReady();
        const wikiId = normalizeWikiId(gameObj?.wiki_page_id);
        const requestedBackupDate = gameObj?.backups?.[0]?.date == null
            ? null
            : normalizeBackupDate(gameObj.backups[0].date);
        const actionForAll = userActionForAll === 'replace' || userActionForAll === 'skip'
            ? userActionForAll
            : null;
        let releaseOperation;
        try {
            releaseOperation = acquireGameOperation(wikiId, 'restore');
            return await restoreGame(wikiId, requestedBackupDate, actionForAll);
        } catch (error) {
            console.error(`Restore failed for game ${wikiId}:`, error.message);
            return { action: null, error: error.message };
        } finally {
            releaseOperation?.();
        }
    });
}

module.exports = { registerRestoreIpc };
