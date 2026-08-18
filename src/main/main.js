const { BrowserWindow, app, dialog, ipcMain, session, shell, systemPreferences } = require('electron');

const { randomUUID } = require('crypto');
const fs = require('fs');
const fsOriginal = require('original-fs');
const os = require('os');
const path = require('path');

const fse = require('fs-extra');
const i18next = require('i18next');
const Backend = require('i18next-fs-backend');

const {
    windowVisualEffect, applyWindowsMicaEffect,
    createMainWindow, getMainWin, getStatus, updateStatus, checkAppUpdate, exportBackups,
    importBackups, browseLocalSave, deleteLocalSave, osKeyMap, loadSettings, saveSettings, getSettings,
    moveFilesWithProgress, getCurrentVersion, getRepositoryUrl, getLatestVersion, isNewerAppVersion, updateApp,
    setLaunchAtStartup
} = require('./global');
const { getGameData, initializeGameData, detectGamePaths, getAllUserIds } = require('./gameData');
const { getGameDataFromDB, getAllGameDataFromDB, backupGame, initializeDatabaseStorage, updateDatabase } = require('./backup');
const { getGameDataForRestore, restoreGame } = require("./restore");
const {
    startAutoBackup, stopAutoBackup, getAutoBackupState, refreshAutoBackupWatchers,
    restoreAutoBackups, stopAllAutoBackups
} = require('./autoBackup');
const {
    checkSyncProviderStatus,
    getSyncProviderConfig,
    listSyncProviders,
    runSyncProviderAction,
    saveSyncProviderConfig
} = require('./syncProviders');
const {
    assertNoSymlinkAncestors,
    isPathInside,
    isXboxPgsPath,
    normalizeBackupDate,
    normalizeRegistryKeyPath,
    normalizeWikiId,
    resolveInside,
    validateBackupMetadata
} = require('./validation');
const { denyUnexpectedPermissions, hardenBrowserWindow } = require('./windowSecurity');
const { acquireGameOperation, acquireGlobalOperation } = require('./gameOperationLock');
const {
    clearExperimentalXgpCache,
    refreshExperimentalXgpSource
} = require('./xgpExperimentalSource');


function logFatalError(error) {
    const message = error && error.stack ? error.stack : String(error);
    console.error(message);

    try {
        const logDir = path.join(app.getPath('userData'), 'logs');
        fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
        const logPath = path.join(logDir, 'main-error.log');
        const payload = `[${new Date().toISOString()}] ${message}\n\n`;
        const shouldRotate = fs.existsSync(logPath) && fs.statSync(logPath).size > 5 * 1024 * 1024;
        fs[shouldRotate ? 'writeFileSync' : 'appendFileSync'](logPath, payload, { encoding: 'utf8', mode: 0o600 });
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
app.enableSandbox();
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
        const mainWin = getMainWin();
        if (gsmPath && mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send('open-import-modal', gsmPath);
        }
        else if (uriPath) {
            const action = uriPath.slice('gamesavemanager://'.length).replace(/^\/+|\/+$/g, '').toLowerCase();
            if (action === 'yes' || action === 'no') ipcMain.emit('notification-action', null, action);
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
// Includes the transparent shadow gutter reported by menu.entry.js.
const MENU_MAX_WIDTH = 400;
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
            webviewTag: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            spellcheck: false,
            backgroundThrottling: false,
        },
    });

    hardenBrowserWindow(newMenuWindow, path.join(__dirname, '../renderer'));
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

ipcMain.on('show-popup-menu', (event, payload = {}) => {
    const items = Array.isArray(payload.items) ? payload.items.slice(0, 30) : [];
    const x = Number(payload.x);
    const y = Number(payload.y);
    const direction = payload.direction === 'up' ? 'up' : 'down';
    if (!Number.isFinite(x) || !Number.isFinite(y) || items.length === 0) return;
    if (!menuWindow || menuWindow.isDestroyed()) createMenuWindow();

    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    if (!parentWindow || parentWindow.isDestroyed()) {
        return;
    }

    // getBoundingClientRect() is relative to the renderer's content area, not
    // the outer BrowserWindow frame. Using getPosition() here omitted the
    // native title-bar inset and shifted every popup upward by roughly one
    // title-bar height on Windows.
    const parentContentBounds = parentWindow.getContentBounds();

    // Ensure we hide menu if main window loses focus or starts moving. Remove
    // these listeners on hide so later window dragging does not repeatedly run
    // popup cleanup work.
    detachMenuParentListeners();
    menuParentWindow = parentWindow;
    menuParentWindow.on('blur', hideMenuWindowAfterBlur);
    menuParentWindow.on('move', hideMenuWindow);

    // Store target coordinates in a property so the resize event can use them
    menuWindow.targetScreenX = Math.round(parentContentBounds.x + x);
    menuWindow.targetScreenY = Math.round(parentContentBounds.y + y);
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
    if (menuWindow && !menuWindow.isDestroyed() && event.sender === menuWindow.webContents) {
        const width = Math.min(Math.max(Math.ceil(size?.width || MENU_MIN_WIDTH), MENU_MIN_WIDTH), MENU_MAX_WIDTH);
        const height = Math.min(Math.max(Math.ceil(size?.height || 1), 1), 1000);
        const clampInset = (value) => Math.min(Math.max(Math.ceil(Number(value) || 0), 0), 48);
        const inset = {
            top: clampInset(size?.inset?.top),
            right: clampInset(size?.inset?.right),
            bottom: clampInset(size?.inset?.bottom),
            left: clampInset(size?.inset?.left)
        };
        // targetScreenX/Y describe the menu content edge. The transparent
        // BrowserWindow extends beyond it only to give the CSS shadow room to
        // paint, so its gutter must not shift the visible menu away from the
        // trigger.
        const x = Math.round(menuWindow.targetScreenX - inset.left);
        const y = menuWindow.menuDirection === 'up'
            ? Math.round(menuWindow.targetScreenY - height + inset.bottom)
            : Math.round(menuWindow.targetScreenY - inset.top);
        isMenuOpen = true;
        menuWindow.setBounds({
            x,
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
    if (!menuWindow || event.sender !== menuWindow.webContents) return;
    hideMenuWindow();

    const mainWin = getMainWin();
    if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('execute-menu-action', action, data);
    }
});

app.whenReady().then(async () => {
    denyUnexpectedPermissions(session.defaultSession);
    app.setAsDefaultProtocolClient('gamesavemanager');

    loadSettings();
    setLaunchAtStartup(getSettings().launchAtStartup);
    await initializeI18next(getSettings().language);
    await initializeDatabaseStorage();

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

        if (getSettings().experimentalXgpSource) {
            enqueueStartupIdleTask('refresh-experimental-xgp-source', async () => {
                try {
                    const result = await refreshExperimentalXgpSource();
                    if (result.refreshed && mainWin && !mainWin.isDestroyed()) {
                        mainWin.webContents.send('update-backup-table');
                        mainWin.webContents.send('update-restore-table');
                    }
                } catch (error) {
                    console.warn(`Unable to refresh experimental XgpSaveTools source: ${error.message}`);
                }
            }, 1800);
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

function getValidatedBackupPath(wikiId, backupDate = null) {
    const backupRoot = path.resolve(getSettings().backupPath);
    const safeWikiId = normalizeWikiId(wikiId);
    return backupDate === null
        ? resolveInside(backupRoot, safeWikiId)
        : resolveInside(backupRoot, safeWikiId, normalizeBackupDate(backupDate));
}

async function getVerifiedBackupPath(wikiId, backupDate = null) {
    const backupRoot = path.resolve(getSettings().backupPath);
    const gamePath = getValidatedBackupPath(wikiId);
    const targetPath = backupDate === null ? gamePath : getValidatedBackupPath(wikiId, backupDate);
    const pathsToVerify = backupDate === null
        ? [backupRoot, gamePath]
        : [backupRoot, gamePath, targetPath];
    for (const candidatePath of pathsToVerify) {
        const stats = await fsOriginal.promises.lstat(candidatePath);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new Error('Backup path is not a regular directory');
        }
    }
    return targetPath;
}

async function getVerifiedLocalSavePaths(wikiId, selectedIndexes = null) {
    const safeWikiId = normalizeWikiId(wikiId);
    const { games } = await getGameDataFromDB(false, safeWikiId);
    const resolvedPaths = games?.[0]?.resolved_paths || [];

    const selectedPaths = !Array.isArray(selectedIndexes)
        ? resolvedPaths
        : selectedIndexes
            .map(index => Number(index))
            .filter(index => Number.isInteger(index) && index >= 0 && index < resolvedPaths.length)
            .map(index => resolvedPaths[index]);

    const currentGameData = getGameData();
    const configuredInstallPaths = Array.isArray(getSettings().gameInstalls) ? getSettings().gameInstalls : [];
    const systemDrive = process.env.SystemDrive || path.parse(process.env.WINDIR || 'C:\\Windows').root.replace(/[\\/]$/, '') || 'C:';
    const xboxPgsRoot = path.join(systemDrive, 'XboxGames', 'GameSave', 'pgs');
    const allowedRoots = [
        os.homedir(), process.env.APPDATA, process.env.LOCALAPPDATA, process.env.PROGRAMDATA,
        process.env.PUBLIC, currentGameData.steamPath, currentGameData.ubisoftPath, xboxPgsRoot,
        ...configuredInstallPaths
    ].filter(root => typeof root === 'string' && path.isAbsolute(root));

    const verifiedPaths = [];
    for (const pathObject of selectedPaths) {
        if (pathObject?.type === 'reg') {
            verifiedPaths.push({ ...pathObject, resolved: normalizeRegistryKeyPath(pathObject.resolved) });
            continue;
        }
        const resolvedPath = typeof pathObject?.resolved === 'string' && path.isAbsolute(pathObject.resolved)
            ? path.resolve(pathObject.resolved)
            : null;
        const comparisonPath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
        const allowedRoot = resolvedPath
            ? allowedRoots
                .filter(root => isPathInside(root, resolvedPath) && comparisonPath(root) !== comparisonPath(resolvedPath))
                .sort((left, right) => right.length - left.length)[0]
            : null;
        if (!allowedRoot) throw new Error('Local save path is outside the allowed roots');
        await assertNoSymlinkAncestors(allowedRoot, resolvedPath, fsOriginal);
        verifiedPaths.push({ ...pathObject, resolved: resolvedPath });
    }
    return verifiedPaths;
}

function isAllowedExternalUrl(url) {
    try {
        const value = String(url || '');
        if (value.length === 0 || value.length > 2048) return false;
        const parsedUrl = new URL(value);
        const allowedHosts = new Set(['github.com', 'www.pcgamingwiki.com']);
        return parsedUrl.protocol === 'https:'
            && !parsedUrl.username
            && !parsedUrl.password
            && (!parsedUrl.port || parsedUrl.port === '443')
            && allowedHosts.has(parsedUrl.hostname.toLowerCase());
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
    const color = syncEnabled === true ? getSystemAccentColor() : '#16c60c';
    BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
            win.webContents.send('accent-color-changed', color);
        }
    });
});

ipcMain.handle("translate", async (event, key, options) => {
    const safeKey = String(key ?? '');
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(safeKey)) throw new Error('Invalid translation key');
    return i18next.t(safeKey, options && typeof options === 'object' && !Array.isArray(options) ? options : {});
});

ipcMain.handle('change-language', async (event, language) => {
    await saveSettings('language', language);
    return getSettings().language;
});

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

ipcMain.handle('save-settings', async (event, keyOrUpdates, value) => {
    return persistRendererSettings(keyOrUpdates, value);
});

ipcMain.on('save-settings', async (event, keyOrUpdates, value) => {
    try {
        await persistRendererSettings(keyOrUpdates, value);
    } catch (error) {
        console.error('Failed to save setting:', error);
        const mainWin = getMainWin();
        if (mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send('show-alert', 'error', error.message);
        }
    }
});

ipcMain.handle("get-settings", () => {
    return getSettings();
});

ipcMain.handle('set-experimental-xgp-source', async (event, enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('Expected a boolean');

    if (!enabled) {
        await saveSettings('experimentalXgpSource', false);
        await clearExperimentalXgpCache().catch(error => {
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
            buttons: [
                i18next.t('settings.xgp_source_cancel'),
                i18next.t('settings.xgp_source_accept')
            ],
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
    const configuredBackupPath = path.resolve(getSettings().backupPath);
    const requestedPath = typeof directoryPath === 'string' ? path.resolve(directoryPath) : '';
    const comparisonPath = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (!requestedPath || comparisonPath(requestedPath) !== comparisonPath(configuredBackupPath)) {
        return { success: false, message: i18next.t('alert.github_sync_repo_missing') };
    }
    let isDirectory = false;
    if (requestedPath) {
        try {
            const stats = await fsOriginal.promises.lstat(requestedPath);
            isDirectory = stats.isDirectory() && !stats.isSymbolicLink();
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

    const errorMessage = await shell.openPath(requestedPath);
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
        default:
            throw new Error('Invalid path selection type');
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

ipcMain.handle('get-account-data', async () => {
    await ensureGameDataReady();
    return getAllUserIds();
});

ipcMain.handle('get-platform', () => {
    return osKeyMap[os.platform()];
});

ipcMain.handle('get-icon-map', async () => {
    return getCachedIconMap();
});

ipcMain.handle('get-table-view-model', async (event, tableName, options = {}) => {
    await ensureGameDataReady();

    const wikiId = options?.wikiId == null ? null : normalizeWikiId(options.wikiId);
    const ignoreUninstalled = options?.ignoreUninstalled === true;
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
    const { games } = await getGameDataFromDB(false, normalizeWikiId(wikiId));
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
    const safeWikiId = wikiId == null ? null : normalizeWikiId(wikiId);
    const { games, errors } = await getGameDataFromDB(ignoreUninstalled === true, safeWikiId);

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
    if (tableId !== 'backup' && tableId !== 'restore') return [];
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
            if (responseEvent.sender !== mainWin.webContents || responseId !== requestId) return;
            clearTimeout(timeout);
            ipcMain.removeListener('selected-wiki-ids-response', handleResponse);
            const safeWikiIds = [];
            for (const wikiId of Array.isArray(wikiIds) ? wikiIds.slice(0, 10000) : []) {
                try {
                    safeWikiIds.push(normalizeWikiId(wikiId));
                } catch (_) {
                    // Ignore malformed row identifiers from stale renderer state.
                }
            }
            resolve(safeWikiIds);
        };

        ipcMain.on('selected-wiki-ids-response', handleResponse);
        mainWin.webContents.send('collect-selected-wiki-ids', requestId, tableId);
    });
});

ipcMain.handle('backup-game', async (event, gameObj) => {
    await ensureGameDataReady();
    const wikiId = normalizeWikiId(gameObj?.wiki_page_id);
    const { games } = await getGameDataFromDB(false, wikiId);
    if (!games?.[0]) throw new Error('Game data is no longer available');
    return await backupGame(games[0]);
});

ipcMain.handle('fetch-restore-table-data', async (event, wikiId = null) => {
    await ensureGameDataReady();
    const safeWikiId = wikiId == null ? null : normalizeWikiId(wikiId);
    const { games, errors } = await getGameDataForRestore(safeWikiId);

    if (errors.length > 0) {
        getMainWin().webContents.send('show-alert', 'modal', i18next.t('alert.backup_process_error_display'), errors);
    }

    return games;
});

ipcMain.handle('restore-game', async (event, gameObj, userActionForAll) => {
    await ensureGameDataReady();
    const wikiId = normalizeWikiId(gameObj?.wiki_page_id);
    const requestedBackupDate = gameObj?.backups?.[0]?.date == null
        ? null
        : normalizeBackupDate(gameObj.backups[0].date);
    const actionForAll = userActionForAll === 'replace' || userActionForAll === 'skip' ? userActionForAll : null;
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

ipcMain.handle('delete-backup', async (event, wikiId, backupDate) => {
    let releaseOperation;
    try {
        releaseOperation = acquireGameOperation(wikiId, 'delete backup');
        const backupPath = await getVerifiedBackupPath(wikiId, backupDate);
        await fsOriginal.promises.rm(backupPath, { recursive: true, force: true });
        return true;

    } catch (error) {
        console.error(`Error deleting backup ${backupDate} for id ${wikiId}:`, error.message);
        getMainWin().webContents.send('show-alert', 'error', i18next.t('alert.backup_delete_failed'));
        return false;
    } finally {
        releaseOperation?.();
    }
});

ipcMain.handle('update-backup-info', async (event, wikiId, backupDate, key, value) => {
    let releaseOperation;
    try {
        releaseOperation = acquireGameOperation(wikiId, 'update backup metadata');
        const allowedBackupInfoKeys = new Set(['is_permanent', 'custom_name']);
        if (!allowedBackupInfoKeys.has(key)) {
            throw new Error('Invalid backup metadata key');
        }

        const backupInstancePath = await getVerifiedBackupPath(wikiId, backupDate);
        const configFilePath = resolveInside(backupInstancePath, 'backup_info.json');

        try {
            const configStats = await fsOriginal.promises.lstat(configFilePath);
            if (!configStats.isFile() || configStats.isSymbolicLink() || configStats.size > 1024 * 1024) {
                throw new Error('Backup config file is invalid');
            }
        } catch (error) {
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
        const normalizedConfig = validateBackupMetadata(backupConfig);
        const tempConfigPath = `${configFilePath}.${randomUUID()}.tmp`;
        try {
            await fsOriginal.promises.writeFile(tempConfigPath, `${JSON.stringify(normalizedConfig, null, 4)}\n`, {
                encoding: 'utf8',
                mode: 0o600,
                flag: 'wx'
            });
            await fsOriginal.promises.rename(tempConfigPath, configFilePath);
        } catch (error) {
            await fsOriginal.promises.rm(tempConfigPath, { force: true }).catch(() => { });
            throw error;
        }

        return true;

    } catch (error) {
        console.error(`Error updating backup info for backup ${backupDate} for id ${wikiId}:`, error.message);
        getMainWin().webContents.send('show-alert', 'error', i18next.t('alert.backup_update_failed'));
        return false;
    } finally {
        releaseOperation?.();
    }
});

ipcMain.on('open-backup-folder', async (event, wikiId) => {
    let backupPath;
    let hasBackups = false;
    try {
        backupPath = await getVerifiedBackupPath(wikiId);
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
    let releaseOperation;
    try {
        releaseOperation = acquireGameOperation(wikiId, 'delete local save');
        const resolvedPaths = await getVerifiedLocalSavePaths(wikiId);
        if (resolvedPaths.some(pathObject => pathObject.type !== 'reg' && isXboxPgsPath(pathObject.resolved))) {
            throw new Error(i18next.t('alert.xbox_pgs_delete_blocked'));
        }
        return await deleteLocalSave(resolvedPaths);
    } catch (error) {
        console.error('Error validating local save delete request:', error.message);
        getMainWin().webContents.send('show-alert', 'error', error.message);
        return false;
    } finally {
        releaseOperation?.();
    }
});

ipcMain.handle('migrate-backups', async (event, newBackupPath) => {
    const currentBackupPath = getSettings().backupPath;
    return await moveFilesWithProgress(currentBackupPath, newBackupPath);
});

ipcMain.handle('get-status', () => {
    return getStatus();
});

ipcMain.on('update-status', (event, statusKey, statusValue) => {
    try {
        updateStatus(statusKey, statusValue);
    } catch (error) {
        console.error('Rejected invalid status update:', error.message);
    }
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
    return await updateDatabase();
});

ipcMain.handle('sync-provider-list', () => {
    return listSyncProviders();
});

ipcMain.handle('sync-provider-config', async (event, providerId) => {
    return await getSyncProviderConfig(providerId);
});

ipcMain.handle('sync-provider-save-config', async (event, providerId, config) => {
    return await saveSyncProviderConfig(providerId, config);
});

ipcMain.handle('sync-provider-status', async (event, providerId, syncPath) => {
    return await checkSyncProviderStatus(providerId, syncPath);
});

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
            getMainWin().webContents.send('update-restore-table');
            getMainWin().webContents.send('update-backup-table');
        }
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

ipcMain.on('update-app', () => {
    updateApp();
});

// Auto backup IPC handlers
ipcMain.handle('start-auto-backup', async (event, wikiId, mode, intervalMinutes) => {
    await ensureGameDataReady();
    const releaseOperation = acquireGameOperation(wikiId, 'configure auto backup');
    try {
        await startAutoBackup(wikiId, mode, intervalMinutes);
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

ipcMain.handle('get-auto-backup-state', () => {
    return getAutoBackupState();
});
