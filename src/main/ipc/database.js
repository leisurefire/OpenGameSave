const { ipcMain } = require('electron');

const i18next = require('i18next');

const { getAllGameDataFromDB, getGameDataFromDB, updateDatabase } = require('../backup');
const { getMainWin, getSettings, getStatus } = require('../global');
const { getAutoBackupState } = require('../autoBackup');
const { getGameDataForRestore } = require('../restore');
const { normalizeWikiId } = require('../validation');
const { getCachedIconMap } = require('../services/iconService');

function reportDataErrors(errors) {
    if (errors.length === 0) return;
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

async function getTableViewModel(tableName, options, ensureGameDataReady) {
    await ensureGameDataReady();
    const wikiId = options?.wikiId == null ? null : normalizeWikiId(options.wikiId);
    const ignoreUninstalled = options?.ignoreUninstalled === true;
    let result;

    if (tableName === 'backup') result = await getGameDataFromDB(ignoreUninstalled, wikiId);
    else if (tableName === 'restore') result = await getGameDataForRestore(wikiId);
    else throw new Error(`Unknown table view model: ${tableName}`);

    reportDataErrors(result.errors);
    return {
        games: result.games,
        settings: getSettings(),
        autoBackupState: getAutoBackupState(),
        iconMap: tableName === 'backup' ? await getCachedIconMap() : null
    };
}

function relayToMainWindow(channel) {
    const mainWindow = getMainWin();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel);
}

function registerDatabaseIpc({ ensureGameDataReady }) {
    ipcMain.handle('get-table-view-model', (event, tableName, options = {}) => (
        getTableViewModel(tableName, options, ensureGameDataReady)
    ));
    ipcMain.handle('get-local-save-data', async (event, wikiId) => {
        await ensureGameDataReady();
        const { games } = await getGameDataFromDB(false, normalizeWikiId(wikiId));
        return games?.[0] || null;
    });
    ipcMain.on('run-scan-full', () => relayToMainWindow('run-scan-full'));
    ipcMain.on('update-backup-table', () => relayToMainWindow('update-backup-table'));
    ipcMain.on('update-restore-table', () => relayToMainWindow('update-restore-table'));
    ipcMain.handle('start-scan-full', async () => {
        await ensureGameDataReady();
        if (getStatus().scanning_full) return undefined;
        const result = await getAllGameDataFromDB();
        reportDataErrors(result.errors);
        return result.games;
    });
    ipcMain.handle('update-database', updateDatabase);
}

module.exports = { registerDatabaseIpc };
