const { BrowserWindow, app, dialog, ipcMain, shell } = require('electron');

const { randomUUID } = require('crypto');
const fs = require('fs');
const fsOriginal = require('original-fs');
const os = require('os');
const path = require('path');

const fse = require('fs-extra');
const i18next = require('i18next');
const Backend = require('i18next-fs-backend');
const moment = require('moment');
const { pinyin } = require('pinyin');

const {
    createMainWindow, getMainWin, getStatus, updateStatus, checkAppUpdate, exportBackups,
    importBackups, browseLocalSave, deleteLocalSave, osKeyMap, loadSettings, saveSettings, getSettings,
    moveFilesWithProgress, getCurrentVersion, getLatestVersion, updateApp
} = require('./global');
const { getGameData, initializeGameData, detectGamePaths, getAllUserIds } = require('./gameData');
const { getGameDataFromDB, getAllGameDataFromDB, backupGame, updateDatabase } = require('./backup');
const { getGameDataForRestore, restoreGame } = require("./restore");
const { startAutoBackup, stopAutoBackup, getAutoBackupState, restoreAutoBackups, stopAllAutoBackups } = require('./autoBackup');

function logFatalError(error) {
    const message = error && error.stack ? error.stack : String(error);
    console.error(message);

    try {
        const logDir = path.join(app.getPath('userData'), 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(
            path.join(logDir, 'main-error.log'),
            `[${new Date().toISOString()}] ${message}\n\n`,
            'utf8'
        );
    } catch (logError) {
        console.error('Failed to write fatal error log:', logError);
    }
}

process.on('uncaughtException', (error) => {
    logFatalError(error);
});

process.on('unhandledRejection', (reason) => {
    logFatalError(reason);
});


// Setup hot reload for development
if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV) {
    try {
        const setupHotReload = require('./hotReload');
        setupHotReload();
    } catch (err) {
        console.error('Failed to setup hot reload:', err.message);
    }
}

app.commandLine.appendSwitch("lang", "en");
const gotTheLock = app.requestSingleInstanceLock();
let pendingGSMPath = null;

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, argv) => {
        const gsmPath = argv.find(arg => arg.toLowerCase().endsWith('.gsmr'));
        const uriPath = argv.find(arg => arg.startsWith('gamesavemanager://'));
        if (gsmPath) {
            getMainWin().webContents.send('open-import-modal', gsmPath);
        }
        else if (uriPath) {
            const action = uriPath.replace('gamesavemanager://', '').replace('/', '');
            ipcMain.emit('notification-action', null, action);
        }
    });

    app.on('will-quit', () => {
        stopAllAutoBackups();
    });

    if (process.platform === 'win32') {
        const gsmPath = process.argv.find(arg => arg.toLowerCase().endsWith('.gsmr'));
        if (gsmPath) {
            pendingGSMPath = gsmPath;
        }
    }
}

let menuWindow = null;
let menuParentWindow = null;
let isMenuOpen = false;

const MENU_WIDTH = 180;
const MENU_POSITION_OFFSET_X = 6;
const MENU_POSITION_OFFSET_Y = 6;
const MENU_HIDDEN_BOUNDS = { x: -10000, y: -10000, width: 1, height: 1 };

function detachMenuParentListeners() {
    if (!menuParentWindow || menuParentWindow.isDestroyed()) {
        menuParentWindow = null;
        return;
    }

    menuParentWindow.removeListener('blur', hideMenuWindowAfterBlur);
    menuParentWindow.removeListener('move', hideMenuWindow);
    menuParentWindow = null;
}

function hideMenuWindow() {
    const wasMenuOpen = isMenuOpen;
    isMenuOpen = false;
    detachMenuParentListeners();

    if (wasMenuOpen && menuWindow && !menuWindow.isDestroyed()) {
        // Keep the popup BrowserWindow alive and visible off-screen. Do not use
        // hide()/show() or destroy()/create() here: both can trigger Windows'
        // native window animations. Shrinking to 1x1 off-screen prevents the
        // invisible always-on-top popup from stealing hit-tests after closing.
        menuWindow.setBounds(MENU_HIDDEN_BOUNDS, false);
    }

    const mainWin = getMainWin();
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('menu-hidden');
}

function hideMenuWindowAfterBlur() {
    setTimeout(() => {
        if (!isMenuOpen || !menuWindow || menuWindow.isDestroyed()) {
            return;
        }
        hideMenuWindow();
    }, 150);
}

ipcMain.on('hide-popup-menu', () => {
    hideMenuWindow();
});

function destroyMenuWindow() {
    detachMenuParentListeners();

    if (menuWindow && !menuWindow.isDestroyed()) {
        menuWindow.destroy();
    }
    menuWindow = null;
    isMenuOpen = false;
}

function createMenuWindow() {
    if (menuWindow && !menuWindow.isDestroyed()) {
        return;
    }

    const newMenuWindow = new BrowserWindow({
        width: MENU_HIDDEN_BOUNDS.width,
        height: MENU_HIDDEN_BOUNDS.height,
        x: MENU_HIDDEN_BOUNDS.x,
        y: MENU_HIDDEN_BOUNDS.y,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        show: false, // Initially false, shown right after creation
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        type: 'toolbar',
        hasShadow: false,
        focusable: false, // Critical: Prevent stealing focus from main window
        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false,
        },
    });

    menuWindow = newMenuWindow;
    newMenuWindow.loadFile(path.join(__dirname, '../renderer/menu.html'));

    newMenuWindow.once('ready-to-show', () => {
        if (newMenuWindow.isDestroyed()) {
            return;
        }
        // Show once while off-screen so later opens only move/resize the warm
        // native window and never trigger the Windows show animation.
        newMenuWindow.setBounds(MENU_HIDDEN_BOUNDS, false);
        newMenuWindow.showInactive();
    });

    newMenuWindow.on('closed', () => {
        if (menuWindow === newMenuWindow) {
            menuWindow = null;
            isMenuOpen = false;
        }
    });
}

ipcMain.on('show-popup-menu', (event, { items, x, y }) => {
    if (!menuWindow || menuWindow.isDestroyed()) createMenuWindow();

    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    if (!parentWindow || parentWindow.isDestroyed()) {
        return;
    }

    const [winX, winY] = parentWindow.getPosition();

    // Ensure we hide menu if main window loses focus or starts moving. Remove
    // these listeners on hide so later window dragging does not repeatedly run
    // popup cleanup work.
    detachMenuParentListeners();
    menuParentWindow = parentWindow;
    menuParentWindow.on('blur', hideMenuWindowAfterBlur);
    menuParentWindow.on('move', hideMenuWindow);

    // Store target coordinates in a property so the resize event can use them
    menuWindow.targetScreenX = Math.round(winX + x + MENU_POSITION_OFFSET_X);
    menuWindow.targetScreenY = Math.round(winY + y + MENU_POSITION_OFFSET_Y);

    if (menuWindow.webContents.isLoading()) {
        const targetMenuWindow = menuWindow;
        menuWindow.webContents.once('did-finish-load', () => {
            if (!targetMenuWindow.isDestroyed()) {
                targetMenuWindow.webContents.send('set-menu-items', items);
            }
        });
    } else {
        menuWindow.webContents.send('set-menu-items', items);
    }
});

ipcMain.on('resize-and-show-menu', (event, height) => {
    if (menuWindow && !menuWindow.isDestroyed()) {
        isMenuOpen = true;
        menuWindow.setBounds({
            x: menuWindow.targetScreenX,
            y: menuWindow.targetScreenY,
            width: MENU_WIDTH,
            height
        }, false);
        menuWindow.setOpacity(1);

        if (!menuWindow.isVisible()) {
            menuWindow.showInactive();
        }
    }
});

ipcMain.on('menu-item-click', (event, action, data) => {
    hideMenuWindow();

    const mainWin = getMainWin();
    if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('execute-menu-action', action, data);
    }
});

app.whenReady().then(async () => {
    app.setAsDefaultProtocolClient('gamesavemanager');

    loadSettings();
    await initializeI18next(getSettings().language);
    await initializeGameData();

    if (getSettings().gameInstalls === 'uninitialized') {
        await detectGamePaths();
        saveSettings('gameInstalls', getGameData().detectedGamePaths);
    }

    await createMainWindow();
    createMenuWindow(); // Pre-load menu
    app.setAppUserModelId(i18next.t('main.title'));

    if (getSettings().autoAppUpdate) {
        checkAppUpdate();
    }

    await restoreAutoBackups();

    getMainWin().webContents.once('did-finish-load', () => {
        if (pendingGSMPath) {
            getMainWin().webContents.send('open-import-modal', pendingGSMPath);
            pendingGSMPath = null;
        }
    });

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
}).catch((error) => {
    logFatalError(error);
    dialog.showErrorBox('Game Save Manager startup failed', error && error.stack ? error.stack : String(error));
    app.quit();
});

// Language settings
const initializeI18next = (language) => {
    return i18next
        .use(Backend)
        .init({
            lng: language,
            fallbackLng: "en_US",
            backend: {
                loadPath: path.join(__dirname, "../locale/{{lng}}.json"),
            },
        });
};

// ======================================================================
// Listeners
// ======================================================================
ipcMain.handle("translate", async (event, key, options) => {
    return i18next.t(key, options);
});

ipcMain.on('save-settings', async (event, key, value) => {
    saveSettings(key, value);
});

ipcMain.handle("get-settings", () => {
    return getSettings();
});

ipcMain.handle("get-detected-game-paths", async () => {
    await detectGamePaths();
    return getGameData().detectedGamePaths;
});

ipcMain.handle('open-url', async (event, url) => {
    await shell.openExternal(url);
});

ipcMain.handle('open-backup-dialog', async () => {
    const focusedWindow = BrowserWindow.getFocusedWindow();

    const result = await dialog.showOpenDialog(focusedWindow, {
        title: i18next.t('settings.select_backup_path'),
        properties: ['openDirectory'],
        modal: true
    });

    if (result.filePaths.length > 0) {
        return path.join(result.filePaths[0], 'GSM Backups');
    }

    return null;
});

ipcMain.handle('open-dialog', async () => {
    const focusedWindow = BrowserWindow.getFocusedWindow();

    const result = await dialog.showOpenDialog(focusedWindow, {
        title: i18next.t('settings.select_path'),
        properties: ['openDirectory'],
        modal: true
    });

    return result;
});

ipcMain.handle('select-path', async (event, fileType) => {
    const focusedWindow = BrowserWindow.getFocusedWindow();

    let dialogOptions = {
        title: i18next.t('settings.select_path'),
        properties: []
    };

    switch (fileType) {
        case 'file':
            dialogOptions.properties = ['openFile'];
            break;
        case 'folder':
            dialogOptions.properties = ['openDirectory'];
            break;
        case 'registry':
            return null;
        case 'gsmr':
            dialogOptions.properties = ['openFile'];
            dialogOptions.filters = [
                { name: i18next.t('main.gsmr-file-type'), extensions: ['gsmr'] }
            ];
            break;
    }

    const result = await dialog.showOpenDialog(focusedWindow, {
        ...dialogOptions,
        modal: true
    });

    if (result.filePaths.length > 0) {
        return result.filePaths[0];
    }

    return null;
});

// Sort objects using object.titleToSort
ipcMain.handle('sort-games', (event, games) => {
    const gamesWithSortedTitles = games.map((game) => {
        try {
            const isChinese = /[\u4e00-\u9fff]/.test(game.titleToSort);
            const titleToSort = isChinese
                ? pinyin(game.titleToSort, { style: pinyin.STYLE_NORMAL }).join(' ')
                : game.titleToSort.toLowerCase();
            return { ...game, titleToSort };

        } catch (error) {
            console.error(`Error sorting game ${game.titleToSort}: ${error.stack}`);
            getMainWin().webContents.send('show-alert', 'modal', `${i18next.t('alert.sort_failed', { game_name: game.titleToSort })}`, error.message);
            return { ...game, titleToSort: '' };
        }
    });

    return gamesWithSortedTitles.sort((a, b) => {
        return a.titleToSort.localeCompare(b.titleToSort);
    });
});

ipcMain.handle('get-account-data', () => {
    return getAllUserIds();
});

ipcMain.handle('get-platform', () => {
    return osKeyMap[os.platform()];
});

ipcMain.handle('get-uuid', () => {
    return randomUUID();
});

ipcMain.handle('get-icon-map', async () => {
    return {
        'Steam': fs.readFileSync(path.join(__dirname, '../assets/steam.svg'), 'utf-8'),
        'Ubisoft': fs.readFileSync(path.join(__dirname, '../assets/ubisoft.svg'), 'utf-8'),
        'EA': fs.readFileSync(path.join(__dirname, '../assets/ea.svg'), 'utf-8'),
        'Epic': fs.readFileSync(path.join(__dirname, '../assets/epic.svg'), 'utf-8'),
        'GOG': fs.readFileSync(path.join(__dirname, '../assets/gog.svg'), 'utf-8'),
        'Xbox': fs.readFileSync(path.join(__dirname, '../assets/xbox.svg'), 'utf-8'),
        'Blizzard': fs.readFileSync(path.join(__dirname, '../assets/battlenet.svg'), 'utf-8'),
    };
});

ipcMain.handle('fetch-backup-table-data', async (event, ignoreUninstalled, wikiId = null) => {
    const { games, errors } = await getGameDataFromDB(ignoreUninstalled, wikiId);

    if (errors.length > 0) {
        getMainWin().webContents.send('show-alert', 'modal', i18next.t('alert.backup_process_error_display'), errors);
    }

    return games;
});

ipcMain.on('update-backup-table', async (event) => {
    getMainWin().webContents.send('update-backup-table');
});

ipcMain.handle('backup-game', async (event, gameObj) => {
    return await backupGame(gameObj);
});

ipcMain.handle('fetch-restore-table-data', async (event, wikiId = null) => {
    const { games, errors } = await getGameDataForRestore(wikiId);

    if (errors.length > 0) {
        getMainWin().webContents.send('show-alert', 'modal', i18next.t('alert.backup_process_error_display'), errors);
    }

    return games;
});

ipcMain.handle('restore-game', async (event, gameObj, userActionForAll) => {
    return await restoreGame(gameObj, userActionForAll);
});

ipcMain.handle('confirm-delete-backup', async (event, wikiId, backupDate) => {
    try {
        const backupPath = path.join(getSettings().backupPath, wikiId.toString(), backupDate);
        const formattedDate = moment(backupDate, 'YYYY-MM-DD_HH-mm').format('YYYY/MM/DD HH:mm');

        const confirmTitle = i18next.t('alert.confirm_delete_backup_title');
        const baseMessage = i18next.t('alert.confirm_delete_backup_message');
        const confirmMessage = baseMessage.replace('{{backup_date}}', formattedDate);

        const response = await dialog.showMessageBox(getMainWin(), {
            type: 'warning',
            title: confirmTitle,
            message: confirmMessage,
            buttons: [i18next.t('alert.yes'), i18next.t('alert.no')],
            defaultId: 1,
            cancelId: 1
        });

        // If user clicked "Yes"
        if (response.response === 0) {
            fsOriginal.rmSync(backupPath, { recursive: true, force: true });
            return true;
        }

        return false;

    } catch (error) {
        console.error(`Error deleting backup ${backupDate} for id ${wikiId}:`, error.message);
        getMainWin().webContents.send('show-alert', 'error', i18next.t('alert.backup_delete_failed'));
        return false;
    }
});

ipcMain.handle('update-backup-info', async (event, wikiId, backupDate, key, value) => {
    try {
        const configFilePath = path.join(getSettings().backupPath, wikiId.toString(), backupDate, 'backup_info.json');

        if (!fsOriginal.existsSync(configFilePath)) {
            throw new Error('Backup config file not found');
        }

        const backupConfig = await fse.readJson(configFilePath);
        backupConfig[key] = value;
        await fse.writeJson(configFilePath, backupConfig, { spaces: 4 });

        return true;

    } catch (error) {
        console.error(`Error updating backup info for backup ${backupDate} for id ${wikiId}:`, error.message);
        getMainWin().webContents.send('show-alert', 'error', i18next.t('alert.backup_update_failed'));
        return false;
    }
});

ipcMain.on('open-backup-folder', async (event, wikiId) => {
    const backupPath = path.join(getSettings().backupPath, wikiId.toString());
    if (fsOriginal.existsSync(backupPath) && fsOriginal.readdirSync(backupPath).length > 0) {
        await shell.openPath(backupPath);
    } else {
        getMainWin().webContents.send('show-alert', 'warning', i18next.t('alert.no_backups_found'));
    }
});

ipcMain.on('browse-local-save', async (event, resolvedPaths) => {
    browseLocalSave(resolvedPaths);
});

ipcMain.handle('confirm-delete-local-save', async (event, resolvedPaths) => {
    return await deleteLocalSave(resolvedPaths);
});

ipcMain.on('migrate-backups', (event, newBackupPath) => {
    const currentBackupPath = getSettings().backupPath;
    moveFilesWithProgress(currentBackupPath, newBackupPath);
});

ipcMain.handle('get-status', () => {
    return getStatus();
});

ipcMain.on('update-status', (event, statusKey, statusValue) => {
    console.log(`Updating status: ${statusKey} = ${statusValue}`);
    updateStatus(statusKey, statusValue);
});

ipcMain.handle('get-current-version', () => {
    return getCurrentVersion();
});

ipcMain.handle('get-latest-version', () => {
    return getLatestVersion('GSM');
});

ipcMain.handle('update-database', async () => {
    await updateDatabase();
    return;
});

ipcMain.on('export-backups', (event, count, exportPath, wikiIds) => {
    exportBackups(count, exportPath, wikiIds);
});

ipcMain.on('import-backups', (event, gsmPath) => {
    importBackups(gsmPath);
});

ipcMain.handle('start-scan-full', async () => {
    if (!getStatus().scanning_full) {
        const { games, errors } = await getAllGameDataFromDB();

        if (errors.length > 0) {
            getMainWin().webContents.send('show-alert', 'modal', i18next.t('alert.backup_process_error_display'), errors);
        }

        return games;
    }
});

ipcMain.on('update-app', (event, latest_version) => {
    updateApp(latest_version);
});

// Auto backup IPC handlers
ipcMain.handle('start-auto-backup', async (event, wikiId, mode, intervalMinutes) => {
    await startAutoBackup(wikiId, mode, intervalMinutes);
});

ipcMain.handle('stop-auto-backup', (event, wikiId) => {
    return stopAutoBackup(wikiId, true);
});

ipcMain.handle('get-auto-backup-state', () => {
    return getAutoBackupState();
});