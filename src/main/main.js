const { BrowserWindow, app, dialog, ipcMain, shell, systemPreferences } = require('electron');

const { randomUUID } = require('crypto');
const fs = require('fs');
const fsOriginal = require('original-fs');
const os = require('os');
const path = require('path');

const fse = require('fs-extra');
const i18next = require('i18next');
const Backend = require('i18next-fs-backend');
const { pinyin } = require('pinyin-pro');

const {
    windowVisualEffect, applyWindowsMicaEffect,
    createMainWindow, getMainWin, getStatus, updateStatus, checkAppUpdate, exportBackups,
    importBackups, browseLocalSave, deleteLocalSave, osKeyMap, loadSettings, saveSettings, getSettings,
    moveFilesWithProgress, getCurrentVersion, getRepositoryUrl, getLatestVersion, isNewerAppVersion, updateApp
} = require('./global');
const { getGameData, initializeGameData, detectGamePaths, getAllUserIds } = require('./gameData');
const { getGameDataFromDB, getAllGameDataFromDB, backupGame, updateDatabase } = require('./backup');
const { getGameDataForRestore, restoreGame } = require("./restore");
const { startAutoBackup, stopAutoBackup, getAutoBackupState, restoreAutoBackups, stopAllAutoBackups } = require('./autoBackup');
const { checkGitSyncStatus, uploadBackupsToGitHub, downloadBackupsFromGitHub } = require('./githubSync');


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
let isQuitting = false;
let gameDataInitializationPromise = null;
let iconMapCache = null;
let iconMapCachePromise = null;
let startupIdleQueueStarted = false;
const startupIdleTasks = [];

function startGameDataInitialization() {
    if (!gameDataInitializationPromise) {
        gameDataInitializationPromise = (async () => {
            await initializeGameData();

            if (getSettings().gameInstalls === 'uninitialized') {
                await detectGamePaths();
                await saveSettings('gameInstalls', getGameData().detectedGamePaths);
            }

            return getGameData();
        })().catch((error) => {
            gameDataInitializationPromise = null;
            throw error;
        });
    }

    return gameDataInitializationPromise;
}

async function ensureGameDataReady() {
    return startGameDataInitialization();
}

function reportBackgroundStartupError(error) {
    logFatalError(error);

    const mainWin = getMainWin();
    if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('show-alert', 'modal', i18next.t('alert.backup_process_error_display'), error.message || String(error));
    }
}

async function getCachedIconMap() {
    if (iconMapCache) {
        return iconMapCache;
    }

    if (!iconMapCachePromise) {
        const iconPaths = {
            'Steam': path.join(__dirname, '../assets/steam.svg'),
            'Ubisoft': path.join(__dirname, '../assets/ubisoft.svg'),
            'EA': path.join(__dirname, '../assets/ea.svg'),
            'Epic': path.join(__dirname, '../assets/epic.svg'),
            'GOG': path.join(__dirname, '../assets/gog.svg'),
            'Xbox': path.join(__dirname, '../assets/xbox.svg'),
            'Blizzard': path.join(__dirname, '../assets/battlenet.svg'),
        };

        iconMapCachePromise = Promise.all(
            Object.entries(iconPaths).map(async ([platform, iconPath]) => {
                return [platform, await fs.promises.readFile(iconPath, 'utf-8')];
            })
        ).then((entries) => {
            iconMapCache = Object.fromEntries(entries);
            return iconMapCache;
        }).catch((error) => {
            iconMapCache = null;
            iconMapCachePromise = null;
            throw error;
        });
    }

    return iconMapCachePromise;
}

function enqueueStartupIdleTask(name, task, delayMs = 0) {
    startupIdleTasks.push({ name, task, delayMs });
}

function startStartupIdleQueue(initialDelayMs = 0) {
    if (startupIdleQueueStarted) {
        return;
    }

    startupIdleQueueStarted = true;

    const runNext = () => {
        const nextTask = startupIdleTasks.shift();
        if (!nextTask) {
            return;
        }

        setTimeout(async () => {
            try {
                await nextTask.task();
            } catch (error) {
                console.error(`Startup idle task failed: ${nextTask.name}`, error);
                reportBackgroundStartupError(error);
            } finally {
                runNext();
            }
        }, nextTask.delayMs);
    };

    setTimeout(runNext, initialDelayMs);
}

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

    app.on('before-quit', async (event) => {
        if (isQuitting) {
            return;
        }

        event.preventDefault();
        isQuitting = true;

        try {
            destroyMenuWindow();
            await stopAllAutoBackups();
        } catch (error) {
            logFatalError(error);
        } finally {
            app.quit();
        }
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

const MENU_MIN_WIDTH = 196;
const MENU_MAX_WIDTH = 376;
const MENU_POSITION_OFFSET_X = 2;
const MENU_POSITION_OFFSET_Y = 2;
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
        hasShadow: true,
        focusable: false, // Critical: Prevent stealing focus from main window
        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
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

ipcMain.on('show-popup-menu', (event, { items, x, y, direction = 'down' }) => {
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
    menuWindow.menuDirection = direction === 'up' ? 'up' : 'down';

    if (menuWindow.webContents.isLoading()) {
        const targetMenuWindow = menuWindow;
        menuWindow.webContents.once('did-finish-load', () => {
            if (!targetMenuWindow.isDestroyed()) {
                targetMenuWindow.webContents.send('set-menu-items', {
                    items,
                    direction: targetMenuWindow.menuDirection
                });
            }
        });
    } else {
        menuWindow.webContents.send('set-menu-items', {
            items,
            direction: menuWindow.menuDirection
        });
    }
});

ipcMain.on('resize-and-show-menu', (event, size) => {
    if (menuWindow && !menuWindow.isDestroyed()) {
        const width = Math.min(Math.max(Math.ceil(size?.width || MENU_MIN_WIDTH), MENU_MIN_WIDTH), MENU_MAX_WIDTH);
        const height = Math.ceil(size?.height || 0);
        const y = menuWindow.menuDirection === 'up'
            ? Math.round(menuWindow.targetScreenY - height)
            : menuWindow.targetScreenY;
        isMenuOpen = true;
        menuWindow.setBounds({
            x: menuWindow.targetScreenX,
            y,
            width,
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

    await createMainWindow();
    const mainWin = getMainWin();
    mainWin.webContents.once('did-finish-load', () => {
        if (pendingGSMPath) {
            mainWin.webContents.send('open-import-modal', pendingGSMPath);
            pendingGSMPath = null;
        }

        enqueueStartupIdleTask('preload-menu-window', () => createMenuWindow(), 150);
        enqueueStartupIdleTask('initialize-game-data-and-auto-backup', async () => {
            await startGameDataInitialization();
            await restoreAutoBackups();
        }, 350);

        if (getSettings().autoAppUpdate) {
            enqueueStartupIdleTask('check-app-update', () => checkAppUpdate(), 2500);
        }

        startStartupIdleQueue(250);
    });

    app.setAppUserModelId(i18next.t('main.title'));

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
}).catch((error) => {
    logFatalError(error);
    dialog.showErrorBox('OpenGameSave startup failed', error && error.stack ? error.stack : String(error));
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

function getSystemAccentColor() {
    let accent = '16c60c'; // default fallback
    try {
        if (process.platform === 'win32' || process.platform === 'darwin') {
            accent = systemPreferences.getAccentColor();
        }
    } catch (e) {
        console.error('Failed to get accent color', e);
    }
    return `#${accent.substring(0, 6)}`;
}

function isSafeRelativePath(rootPath, targetPath) {
    const relativePath = path.relative(rootPath, targetPath);
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function resolveInside(rootPath, ...segments) {
    const resolvedRoot = path.resolve(rootPath);
    const resolvedTarget = path.resolve(resolvedRoot, ...segments.map(segment => String(segment)));

    if (!isSafeRelativePath(resolvedRoot, resolvedTarget)) {
        throw new Error('Path escapes the expected root');
    }

    return resolvedTarget;
}

function normalizeWikiId(wikiId) {
    const normalized = String(wikiId || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
        throw new Error('Invalid wiki id');
    }
    return normalized;
}

function normalizeBackupDate(backupDate) {
    const normalized = String(backupDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/.test(normalized)) {
        throw new Error('Invalid backup date');
    }
    return normalized;
}

function getValidatedBackupPath(wikiId, backupDate = null) {
    const backupRoot = path.resolve(getSettings().backupPath);
    const safeWikiId = normalizeWikiId(wikiId);
    return backupDate === null
        ? resolveInside(backupRoot, safeWikiId)
        : resolveInside(backupRoot, safeWikiId, normalizeBackupDate(backupDate));
}

async function getVerifiedLocalSavePaths(wikiId, selectedIndexes = null) {
    const safeWikiId = normalizeWikiId(wikiId);
    const { games } = await getGameDataFromDB(false, safeWikiId);
    const resolvedPaths = games?.[0]?.resolved_paths || [];

    if (!Array.isArray(selectedIndexes)) {
        return resolvedPaths;
    }

    return selectedIndexes
        .map(index => Number(index))
        .filter(index => Number.isInteger(index) && index >= 0 && index < resolvedPaths.length)
        .map(index => resolvedPaths[index]);
}

function isAllowedExternalUrl(url) {
    try {
        const parsedUrl = new URL(String(url || ''));
        return parsedUrl.protocol === 'https:';
    } catch (error) {
        return false;
    }
}

systemPreferences.on('accent-color-changed', (event, newColor) => {
    if (getSettings().syncAccentColor) {
        const color = `#${newColor.substring(0, 6)}`;
        BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) {
                win.webContents.send('accent-color-changed', color);
            }
        });
    }
});

ipcMain.handle('get-accent-color', () => {
    return getSystemAccentColor();
});

ipcMain.on('apply-accent-color-setting', (event, syncEnabled) => {
    const color = syncEnabled ? getSystemAccentColor() : '#16c60c';
    BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
            win.webContents.send('accent-color-changed', color);
        }
    });
});

ipcMain.handle("translate", async (event, key, options) => {
    return i18next.t(key, options);
});

ipcMain.handle('change-language', async (event, language) => {
    await saveSettings('language', language);
    return getSettings().language;
});

ipcMain.on('save-settings', async (event, key, value) => {
    saveSettings(key, value);
});

ipcMain.handle("get-settings", () => {
    return getSettings();
});

ipcMain.handle("get-detected-game-paths", async () => {
    await ensureGameDataReady();
    await detectGamePaths();
    return getGameData().detectedGamePaths;
});

ipcMain.handle('open-url', async (event, url) => {
    if (!isAllowedExternalUrl(url)) {
        throw new Error('Blocked external URL');
    }

    await shell.openExternal(url);
});

function isDriveRoot(directoryPath) {
    const parsedPath = path.parse(path.resolve(directoryPath));
    return path.resolve(directoryPath) === parsedPath.root;
}

ipcMain.handle('open-backup-dialog', async () => {
    const focusedWindow = BrowserWindow.getFocusedWindow();

    const result = await dialog.showOpenDialog(focusedWindow, {
        title: i18next.t('settings.select_backup_path'),
        properties: ['openDirectory'],
        modal: true
    });

    if (result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0];
        return isDriveRoot(selectedPath) ? path.join(selectedPath, 'OGS Backups') : selectedPath;
    }

    return null;
});




ipcMain.handle('open-directory', async (event, directoryPath) => {
    let isDirectory = false;
    if (directoryPath) {
        try {
            const stats = await fsOriginal.promises.stat(directoryPath);
            isDirectory = stats.isDirectory();
        } catch (error) {
            isDirectory = false;
        }
    }

    if (!isDirectory) {
        return {
            success: false,
            message: i18next.t('alert.github_sync_repo_missing')
        };
    }

    const errorMessage = await shell.openPath(directoryPath);
    return {
        success: !errorMessage,
        message: errorMessage
    };
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
                ? pinyin(game.titleToSort, { toneType: 'none' })
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

ipcMain.handle('get-account-data', async () => {
    await ensureGameDataReady();
    return getAllUserIds();
});

ipcMain.handle('get-platform', () => {
    return osKeyMap[os.platform()];
});

ipcMain.handle('get-uuid', () => {
    return randomUUID();
});

ipcMain.handle('get-icon-map', async () => {
    return getCachedIconMap();
});

ipcMain.handle('get-table-view-model', async (event, tableName, options = {}) => {
    await ensureGameDataReady();

    const wikiId = options?.wikiId || null;
    const ignoreUninstalled = options?.ignoreUninstalled;
    const settings = getSettings();
    const autoBackupState = getAutoBackupState();
    let games = [];
    let errors = [];

    if (tableName === 'backup') {
        const result = await getGameDataFromDB(ignoreUninstalled, wikiId);
        games = result.games;
        errors = result.errors;
    } else if (tableName === 'restore') {
        const result = await getGameDataForRestore(wikiId);
        games = result.games;
        errors = result.errors;
    } else {
        throw new Error(`Unknown table view model: ${tableName}`);
    }

    if (errors.length > 0) {
        getMainWin().webContents.send('show-alert', 'modal', i18next.t('alert.backup_process_error_display'), errors);
    }

    return {
        games,
        settings,
        autoBackupState,
        iconMap: tableName === 'backup' ? await getCachedIconMap() : null
    };
});

ipcMain.handle('get-local-save-data', async (event, wikiId) => {
    await ensureGameDataReady();
    const { games } = await getGameDataFromDB(false, wikiId);
    return games && games.length > 0 ? games[0] : null;
});

ipcMain.on('run-scan-full', () => {
    const mainWin = getMainWin();
    if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('run-scan-full');
    }
});

ipcMain.handle('fetch-backup-table-data', async (event, ignoreUninstalled, wikiId = null) => {
    await ensureGameDataReady();
    const { games, errors } = await getGameDataFromDB(ignoreUninstalled, wikiId);

    if (errors.length > 0) {
        getMainWin().webContents.send('show-alert', 'modal', i18next.t('alert.backup_process_error_display'), errors);
    }

    return games;
});

ipcMain.on('update-backup-table', async (event) => {
    getMainWin().webContents.send('update-backup-table');
});

ipcMain.on('update-restore-table', async (event) => {
    getMainWin().webContents.send('update-restore-table');
});

ipcMain.handle('get-main-selected-wiki-ids', async (event, tableId) => {
    const mainWin = getMainWin();
    if (!mainWin || mainWin.isDestroyed()) {
        return [];
    }

    return await new Promise((resolve) => {
        const requestId = randomUUID();
        const timeout = setTimeout(() => {
            ipcMain.removeListener('selected-wiki-ids-response', handleResponse);
            resolve([]);
        }, 3000);

        const handleResponse = (responseEvent, responseId, wikiIds) => {
            if (responseId !== requestId) return;
            clearTimeout(timeout);
            ipcMain.removeListener('selected-wiki-ids-response', handleResponse);
            resolve(Array.isArray(wikiIds) ? wikiIds : []);
        };

        ipcMain.on('selected-wiki-ids-response', handleResponse);
        mainWin.webContents.send('collect-selected-wiki-ids', requestId, tableId);
    });
});

ipcMain.handle('backup-game', async (event, gameObj) => {
    await ensureGameDataReady();
    return await backupGame(gameObj);
});

ipcMain.handle('fetch-restore-table-data', async (event, wikiId = null) => {
    await ensureGameDataReady();
    const { games, errors } = await getGameDataForRestore(wikiId);

    if (errors.length > 0) {
        getMainWin().webContents.send('show-alert', 'modal', i18next.t('alert.backup_process_error_display'), errors);
    }

    return games;
});

ipcMain.handle('restore-game', async (event, gameObj, userActionForAll) => {
    await ensureGameDataReady();
    return await restoreGame(gameObj, userActionForAll);
});

ipcMain.handle('delete-backup', async (event, wikiId, backupDate) => {
    try {
        const backupPath = getValidatedBackupPath(wikiId, backupDate);
        await fsOriginal.promises.rm(backupPath, { recursive: true, force: true });
        return true;

    } catch (error) {
        console.error(`Error deleting backup ${backupDate} for id ${wikiId}:`, error.message);
        getMainWin().webContents.send('show-alert', 'error', i18next.t('alert.backup_delete_failed'));
        return false;
    }
});

ipcMain.handle('update-backup-info', async (event, wikiId, backupDate, key, value) => {
    try {
        const allowedBackupInfoKeys = new Set(['is_permanent', 'custom_name']);
        if (!allowedBackupInfoKeys.has(key)) {
            throw new Error('Invalid backup metadata key');
        }

        const backupInstancePath = getValidatedBackupPath(wikiId, backupDate);
        const configFilePath = resolveInside(backupInstancePath, 'backup_info.json');

        try {
            await fsOriginal.promises.access(configFilePath, fs.constants.F_OK);
        } catch (error) {
            throw new Error('Backup config file not found');
        }

        const backupConfig = await fse.readJson(configFilePath);
        backupConfig[key] = key === 'is_permanent' ? Boolean(value) : String(value || '').slice(0, 120);
        await fse.writeJson(configFilePath, backupConfig, { spaces: 4 });

        return true;

    } catch (error) {
        console.error(`Error updating backup info for backup ${backupDate} for id ${wikiId}:`, error.message);
        getMainWin().webContents.send('show-alert', 'error', i18next.t('alert.backup_update_failed'));
        return false;
    }
});

ipcMain.on('open-backup-folder', async (event, wikiId) => {
    let backupPath;
    let hasBackups = false;
    try {
        backupPath = getValidatedBackupPath(wikiId);
        const entries = await fsOriginal.promises.readdir(backupPath);
        hasBackups = entries.length > 0;
    } catch (error) {
        hasBackups = false;
    }

    if (hasBackups) {
        await shell.openPath(backupPath);
    } else {
        getMainWin().webContents.send('show-alert', 'warning', i18next.t('alert.no_backups_found'));
    }
});

ipcMain.on('browse-local-save', async (event, wikiId, selectedIndexes = null) => {
    try {
        const resolvedPaths = await getVerifiedLocalSavePaths(wikiId, selectedIndexes);
        browseLocalSave(resolvedPaths);
    } catch (error) {
        console.error('Error validating local save browse request:', error.message);
        getMainWin().webContents.send('show-alert', 'error', error.message);
    }
});

ipcMain.handle('delete-local-save', async (event, wikiId) => {
    try {
        const resolvedPaths = await getVerifiedLocalSavePaths(wikiId);
        return await deleteLocalSave(resolvedPaths);
    } catch (error) {
        console.error('Error validating local save delete request:', error.message);
        getMainWin().webContents.send('show-alert', 'error', error.message);
        return false;
    }
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

ipcMain.handle('get-repository-url', () => {
    return getRepositoryUrl();
});

ipcMain.handle('get-latest-version', () => {
    return getLatestVersion('OpenGameSave');
});

ipcMain.handle('is-newer-version', (event, candidateVersion, currentVersion) => {
    return isNewerAppVersion(candidateVersion, currentVersion);
});

ipcMain.handle('update-database', async () => {
    await updateDatabase();
    return;
});

ipcMain.handle('github-sync-status', async (event, syncPath) => {
    return await checkGitSyncStatus(syncPath);
});

ipcMain.handle('github-sync-upload', async (event, syncPath) => {
    updateStatus('github_syncing', true);
    try {
        return await uploadBackupsToGitHub(syncPath);
    } finally {
        updateStatus('github_syncing', false);
    }
});

ipcMain.handle('github-sync-download', async (event, syncPath) => {
    updateStatus('github_syncing', true);
    try {
        return await downloadBackupsFromGitHub(syncPath);
    } finally {
        updateStatus('github_syncing', false);
        getMainWin().webContents.send('update-restore-table');
        getMainWin().webContents.send('update-backup-table');
    }
});


ipcMain.on('export-backups', (event, count, exportPath, wikiIds) => {
    exportBackups(count, exportPath, wikiIds);
});

ipcMain.on('import-backups', (event, gsmPath) => {
    importBackups(gsmPath);
});

ipcMain.handle('start-scan-full', async () => {
    await ensureGameDataReady();
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
    await ensureGameDataReady();
    await startAutoBackup(wikiId, mode, intervalMinutes);
});

ipcMain.handle('stop-auto-backup', (event, wikiId) => {
    return stopAutoBackup(wikiId, true);
});

ipcMain.handle('get-auto-backup-state', () => {
    return getAutoBackupState();
});
