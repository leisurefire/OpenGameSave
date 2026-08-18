const { BrowserWindow, app, dialog, ipcMain, session } = require('electron');

const fs = require('fs');
const path = require('path');

const i18next = require('i18next');
const Backend = require('i18next-fs-backend');

const {
    checkAppUpdate,
    createMainWindow,
    getMainWin,
    getSettings,
    loadSettings,
    saveSettings,
    setLaunchAtStartup
} = require('./global');
const { initializeDatabaseStorage } = require('./backup');
const { restoreAutoBackups, stopAllAutoBackups } = require('./autoBackup');
const { detectGamePaths, getGameData, initializeGameData } = require('./gameData');
const { registerIpcHandlers } = require('./ipc');
const {
    createMenuWindow,
    destroyMenuWindow,
    registerMenuWindowIpc
} = require('./services/menuWindowService');
const { denyUnexpectedPermissions } = require('./windowSecurity');
const { refreshExperimentalXgpSource } = require('./xgpExperimentalSource');

function logFatalError(error) {
    const message = error?.stack || String(error);
    console.error(message);
    try {
        const logDirectory = path.join(app.getPath('userData'), 'logs');
        fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
        const logPath = path.join(logDirectory, 'main-error.log');
        const payload = `[${new Date().toISOString()}] ${message}\n\n`;
        const shouldRotate = fs.existsSync(logPath) && fs.statSync(logPath).size > 5 * 1024 * 1024;
        fs[shouldRotate ? 'writeFileSync' : 'appendFileSync'](logPath, payload, {
            encoding: 'utf8',
            mode: 0o600
        });
    } catch (logError) {
        console.error('Failed to write fatal error log:', logError);
    }
}

process.on('uncaughtException', logFatalError);
process.on('unhandledRejection', logFatalError);

if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV) {
    try {
        require('./hotReload')();
    } catch (error) {
        console.error('Failed to set up hot reload:', error.message);
    }
}

app.commandLine.appendSwitch('lang', 'en');
app.enableSandbox();

let pendingGsmPath = null;
let isQuitting = false;
let gameDataInitializationPromise = null;
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
    const mainWindow = getMainWin();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(
            'show-alert',
            'modal',
            i18next.t('alert.backup_process_error_display'),
            error.message || String(error)
        );
    }
}

function enqueueStartupIdleTask(name, task, delayMs = 0) {
    startupIdleTasks.push({ name, task, delayMs });
}

function startStartupIdleQueue(initialDelayMs = 0) {
    if (startupIdleQueueStarted) return;
    startupIdleQueueStarted = true;

    const runNext = () => {
        const nextTask = startupIdleTasks.shift();
        if (!nextTask) return;
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

function initializeI18next(language) {
    return i18next.use(Backend).init({
        lng: language,
        fallbackLng: 'en_US',
        backend: { loadPath: path.join(__dirname, '../locale/{{lng}}.json') }
    });
}

function queuePostRenderStartup(mainWindow) {
    if (pendingGsmPath) {
        mainWindow.webContents.send('open-import-modal', pendingGsmPath);
        pendingGsmPath = null;
    }
    enqueueStartupIdleTask('preload-menu-window', createMenuWindow, 150);
    enqueueStartupIdleTask('initialize-game-data-and-auto-backup', async () => {
        await startGameDataInitialization();
        await restoreAutoBackups();
    }, 350);
    if (getSettings().autoAppUpdate) {
        enqueueStartupIdleTask('check-app-update', checkAppUpdate, 2500);
    }
    if (getSettings().experimentalXgpSource) {
        enqueueStartupIdleTask('refresh-experimental-xgp-source', async () => {
            try {
                const result = await refreshExperimentalXgpSource();
                if (result.refreshed && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('update-backup-table');
                    mainWindow.webContents.send('update-restore-table');
                }
            } catch (error) {
                console.warn(`Unable to refresh experimental XgpSaveTools source: ${error.message}`);
            }
        }, 1800);
    }
    startStartupIdleQueue(250);
}

function registerApplicationLifecycle() {
    if (!app.requestSingleInstanceLock()) {
        app.quit();
        return false;
    }

    app.on('second-instance', (event, argv) => {
        const gsmPath = argv.find(argument => argument.toLowerCase().endsWith('.gsmr'));
        const uriPath = argv.find(argument => argument.startsWith('gamesavemanager://'));
        const mainWindow = getMainWin();
        if (gsmPath && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('open-import-modal', gsmPath);
        } else if (uriPath) {
            const action = uriPath.slice('gamesavemanager://'.length).replace(/^\/+|\/+$/g, '').toLowerCase();
            if (action === 'yes' || action === 'no') ipcMain.emit('notification-action', null, action);
        }
    });

    app.on('before-quit', async (event) => {
        if (isQuitting) return;
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
        pendingGsmPath = process.argv.find(argument => argument.toLowerCase().endsWith('.gsmr')) || null;
    }
    return true;
}

async function startApplication() {
    denyUnexpectedPermissions(session.defaultSession);
    app.setAsDefaultProtocolClient('gamesavemanager');
    loadSettings();
    setLaunchAtStartup(getSettings().launchAtStartup);
    await initializeI18next(getSettings().language);
    await initializeDatabaseStorage();
    await createMainWindow();
    const mainWindow = getMainWin();
    mainWindow.webContents.once('did-finish-load', () => queuePostRenderStartup(mainWindow));
    app.setAppUserModelId(i18next.t('main.title'));
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
}

registerIpcHandlers({ ensureGameDataReady });
registerMenuWindowIpc();
if (registerApplicationLifecycle()) {
    app.whenReady().then(startApplication).catch((error) => {
        logFatalError(error);
        dialog.showErrorBox('OpenGameSave startup failed', error?.stack || String(error));
        app.quit();
    });
}
