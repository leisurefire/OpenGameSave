const {
    checkAppUpdate,
    getCurrentVersion,
    getLatestVersion,
    getRepositoryUrl,
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
    exportBackups,
    getCurrentVersion,
    getGameDisplayName,
    getLatestVersion,
    getMainWin,
    getRepositoryUrl,
    getSettings,
    getStatus,
    importBackups,
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
