const { ipcMain } = require('electron');

const {
    checkSyncProviderStatus,
    getSyncProviderConfig,
    listSyncProviders,
    runSyncProviderAction,
    saveSyncProviderConfig
} = require('../syncProviders');
const {
    getCurrentVersion,
    getLatestVersion,
    getMainWin,
    getRepositoryUrl,
    getStatus,
    isNewerAppVersion,
    updateApp,
    updateStatus
} = require('../global');
const { acquireGlobalOperation } = require('../gameOperationLock');

function registerApplicationIpc() {
    ipcMain.handle('get-status', getStatus);
    ipcMain.on('update-status', (event, statusKey, statusValue) => {
        try {
            updateStatus(statusKey, statusValue);
        } catch (error) {
            console.error('Rejected invalid status update:', error.message);
        }
    });
    ipcMain.handle('get-current-version', getCurrentVersion);
    ipcMain.handle('get-repository-url', getRepositoryUrl);
    ipcMain.handle('get-latest-version', () => getLatestVersion('OpenGameSave'));
    ipcMain.handle('is-newer-version', (event, candidateVersion, currentVersion) => (
        isNewerAppVersion(candidateVersion, currentVersion)
    ));
    ipcMain.handle('sync-provider-list', listSyncProviders);
    ipcMain.handle('sync-provider-config', (event, providerId) => getSyncProviderConfig(providerId));
    ipcMain.handle('sync-provider-save-config', (event, providerId, config) => (
        saveSyncProviderConfig(providerId, config)
    ));
    ipcMain.handle('sync-provider-status', (event, providerId, syncPath) => (
        checkSyncProviderStatus(providerId, syncPath)
    ));
    ipcMain.handle('sync-provider-run', async (event, providerId, direction, syncPath) => {
        if (getStatus().syncing) throw new Error('Synchronization is already running');
        const releaseOperation = acquireGlobalOperation(`${direction} backups with ${providerId}`);
        updateStatus('syncing', true);
        try {
            return await runSyncProviderAction(providerId, direction, syncPath);
        } finally {
            updateStatus('syncing', false);
            releaseOperation();
            if (direction === 'download') {
                const mainWindow = getMainWin();
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('update-restore-table');
                    mainWindow.webContents.send('update-backup-table');
                }
            }
        }
    });
    ipcMain.on('update-app', updateApp);
}

module.exports = { registerApplicationIpc };
