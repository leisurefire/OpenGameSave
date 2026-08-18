const { BrowserWindow, dialog, ipcMain, systemPreferences } = require('electron');

const i18next = require('i18next');

const { detectGamePaths, getGameData } = require('../gameData');
const { getMainWin, getSettings, saveSettings } = require('../global');
const { refreshAutoBackupWatchers } = require('../autoBackup');
const { clearExperimentalXgpCache, refreshExperimentalXgpSource } = require('../xgpExperimentalSource');

function getSystemAccentColor() {
    let accent = '16c60c';
    try {
        if (process.platform === 'win32' || process.platform === 'darwin') {
            accent = systemPreferences.getAccentColor();
        }
    } catch (error) {
        console.error('Failed to get accent color', error);
    }
    return `#${accent.substring(0, 6)}`;
}

function broadcastAccentColor(color) {
    BrowserWindow.getAllWindows().forEach((window) => {
        if (!window.isDestroyed()) window.webContents.send('accent-color-changed', color);
    });
}

async function persistRendererSettings(keyOrUpdates, value) {
    const updateKeys = keyOrUpdates && typeof keyOrUpdates === 'object' && !Array.isArray(keyOrUpdates)
        ? Object.keys(keyOrUpdates)
        : [keyOrUpdates];
    if (updateKeys.includes('experimentalXgpSource')) {
        throw new Error('Experimental XgpSaveTools source must be changed through its consent prompt');
    }

    const changedKeys = await saveSettings(keyOrUpdates, value);
    const watcherFailures = changedKeys.includes('backupAllAccounts')
        ? await refreshAutoBackupWatchers()
        : [];
    return { success: true, changedKeys, watcherFailures };
}

async function setExperimentalXgpSource(event, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Expected a boolean');

    if (!enabled) {
        await saveSettings('experimentalXgpSource', false);
        await clearExperimentalXgpCache().catch((error) => {
            console.warn(`Unable to remove experimental XgpSaveTools cache: ${error.message}`);
        });
        return { enabled: false, accepted: true, available: false };
    }

    if (!getSettings().experimentalXgpSource) {
        const parentWindow = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
        const promptResult = await dialog.showMessageBox(parentWindow, {
            type: 'warning',
            title: i18next.t('settings.xgp_source_consent_title'),
            message: i18next.t('settings.xgp_source_consent_message'),
            detail: i18next.t('settings.xgp_source_consent_detail'),
            buttons: [i18next.t('settings.xgp_source_cancel'), i18next.t('settings.xgp_source_accept')],
            defaultId: 0,
            cancelId: 0,
            noLink: true
        });
        if (promptResult.response !== 1) {
            return { enabled: false, accepted: false, available: false };
        }
    }

    await saveSettings('experimentalXgpSource', true);
    try {
        const result = await refreshExperimentalXgpSource({ force: true });
        return { enabled: true, accepted: true, ...result };
    } catch (error) {
        console.warn(`Unable to enable experimental XgpSaveTools source immediately: ${error.message}`);
        return { enabled: true, accepted: true, available: false, error: 'fetch-failed' };
    }
}

function registerSettingsIpc({ ensureGameDataReady }) {
    systemPreferences.on('accent-color-changed', (event, newColor) => {
        if (getSettings().syncAccentColor) broadcastAccentColor(`#${newColor.substring(0, 6)}`);
    });

    ipcMain.handle('get-accent-color', getSystemAccentColor);
    ipcMain.on('apply-accent-color-setting', (event, syncEnabled) => {
        broadcastAccentColor(syncEnabled === true ? getSystemAccentColor() : '#16c60c');
    });
    ipcMain.handle('translate', (event, key, options) => {
        const safeKey = String(key ?? '');
        if (!/^[A-Za-z0-9_.-]{1,200}$/.test(safeKey)) throw new Error('Invalid translation key');
        const safeOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
        return i18next.t(safeKey, safeOptions);
    });
    ipcMain.handle('change-language', async (event, language) => {
        await saveSettings('language', language);
        return getSettings().language;
    });
    ipcMain.handle('save-settings', (event, keyOrUpdates, value) => persistRendererSettings(keyOrUpdates, value));
    ipcMain.on('save-settings', async (event, keyOrUpdates, value) => {
        try {
            await persistRendererSettings(keyOrUpdates, value);
        } catch (error) {
            console.error('Failed to save setting:', error);
            const mainWindow = getMainWin();
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('show-alert', 'error', error.message);
            }
        }
    });
    ipcMain.handle('get-settings', getSettings);
    ipcMain.handle('set-experimental-xgp-source', setExperimentalXgpSource);
    ipcMain.handle('get-detected-game-paths', async () => {
        await ensureGameDataReady();
        await detectGamePaths();
        return getGameData().detectedGamePaths;
    });
}

module.exports = { registerSettingsIpc };
