const {
    checkAppUpdate,
    downloadAppUpdate,
    getAppUpdateState,
    getCurrentVersion,
    getLatestVersion,
    getRepositoryUrl,
    isAppUpdateQuitPending,
    isNewerAppVersion,
    showBackgroundNotification,
    updateApp
} = require('./services/appUpdateService');
const { exportBackups, importBackups } = require('./services/backupArchiveService');
const { moveFilesWithProgress } = require('./services/backupMigrationService');
const { browseLocalSave, deleteLocalSave } = require('./services/localSaveService');
const {
    getSettings,
    loadSettings,
    placeholder_mapping,
    saveSettings,
    setLaunchAtStartup
} = require('./services/settingsService');
const { getGameDisplayName, getStatus, updateStatus } = require('./services/statusService');
const {
    applyWindowsMicaEffect,
    createMainWindow,
    getMainWin,
    windowVisualEffect
} = require('./services/windowManager');

module.exports = {
    applyWindowsMicaEffect,
    browseLocalSave,
    checkAppUpdate,
    createMainWindow,
    deleteLocalSave,
    downloadAppUpdate,
    exportBackups,
    getCurrentVersion,
    getAppUpdateState,
    getGameDisplayName,
    getLatestVersion,
    getMainWin,
    getRepositoryUrl,
    getSettings,
    getStatus,
    importBackups,
    isAppUpdateQuitPending,
    isNewerAppVersion,
    loadSettings,
    moveFilesWithProgress,
    placeholder_mapping,
    saveSettings,
    setLaunchAtStartup,
    showBackgroundNotification,
    updateApp,
    updateStatus,
    windowVisualEffect
};
