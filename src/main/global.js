const { BrowserWindow, Menu, Notification, app, ipcMain, shell, nativeTheme } = require('electron');

const fs = require('fs');
const fsOriginal = require('original-fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { pipeline } = require('stream/promises');

const axios = require('axios');
const fse = require('fs-extra');
const i18next = require('i18next');
const { format } = require('date-fns');
const Seven = require('node-7z');
const sevenBin = require('7zip-bin');

const {
    calculateDirectorySizeAsync,
    copyFolderAsync
} = require('./fileSystemUtils');
const {
    ALLOWED_SETTING_KEYS,
    isPathInside,
    normalizeAbsolutePath,
    normalizeBackupDate,
    normalizeBoundedInteger,
    normalizeLanguage,
    normalizeRegistryKeyPath,
    normalizeWikiId,
    normalizeWikiIdArray,
    resolveInside,
    sanitizeSettings,
    sanitizeSettingValue,
    validateArchiveEntryPath,
    validateBackupMetadata
} = require('./validation');
const { hardenBrowserWindow } = require('./windowSecurity');
const { acquireGlobalOperation } = require('./gameOperationLock');



let win;
let settings;
let writeQueue = Promise.resolve();
const activeModalWindows = [];
const modalWindowPages = new WeakMap();
const modalWindowData = new WeakMap();
const modalWindowLoadPromises = new WeakMap();

const appVersion = app.getVersion();
const appRepositoryUrl = 'https://github.com/leisurefire/OpenGameSave';
const appReleaseUrl = 'https://github.com/leisurefire/OpenGameSave/releases';
const appRepositoryApiLatestReleaseUrl = 'https://api.github.com/repos/leisurefire/OpenGameSave/releases/latest';
const isWindows = process.platform === 'win32';
const rendererRoot = path.join(__dirname, '../renderer');
const STATUS_KEYS = new Set([
    'backuping', 'scanning_full', 'restoring', 'migrating', 'updating_db',
    'exporting', 'importing', 'updating_backup', 'updating_restore', 'github_syncing'
]);
const PUBLIC_MODAL_PAGES = new Set(['export', 'import', 'account', 'auto-backup', 'manage-backups', 'local-save', 'scan-full']);
const MAX_ARCHIVE_ENTRIES = 100000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 20 * 1024 * 1024 * 1024;

nativeTheme.themeSource = 'dark';

const windowVisualEffect = isWindows ? {
    backgroundMaterial: 'mica',
    backgroundColor: '#00000000'
} : {};

const applyWindowsMicaEffect = (browserWindow) => {
    if (!isWindows || !browserWindow) {
        return;
    }

    if (typeof browserWindow.setBackgroundMaterial === 'function') {
        browserWindow.setBackgroundMaterial('mica');
    }

    browserWindow.setBackgroundColor('#00000000');
};

let status = {
    backuping: false,
    scanning_full: false,
    restoring: false,
    migrating: false,
    updating_db: false,
    exporting: false,
    importing: false,
    updating_backup: false,
    updating_restore: false,
    github_syncing: false
}

const dynamicModalPages = new Set(['export', 'import', 'account', 'auto-backup', 'manage-backups', 'local-save', 'scan-full', 'confirm', 'dialog']);

const modalWindowDefinitions = {
    settings: {
        file: 'settings.html',
        width: 620,
        height: 600,
        minWidth: 620,
        minHeight: 400,
        resizable: true,
        icon: 'setting.ico'
    },
    about: {
        file: 'about.html',
        width: 620,
        height: 380,
        minWidth: 620,
        minHeight: 250,
        resizable: false,
        icon: 'logo.ico'
    },
    export: {
        file: 'modal.html',
        width: 520,
        height: 360,
        minWidth: 520,
        minHeight: 300,
        resizable: false,
        icon: 'logo.ico'
    },
    import: {
        file: 'modal.html',
        width: 520,
        height: 220,
        minWidth: 520,
        minHeight: 200,
        resizable: false,
        icon: 'logo.ico'
    },
    account: {
        file: 'modal.html',
        width: 620,
        height: 500,
        minWidth: 620,
        minHeight: 300,
        resizable: false,
        icon: 'logo.ico'
    },
    'auto-backup': {
        file: 'modal.html',
        width: 620,
        height: 400,
        minWidth: 620,
        minHeight: 300,
        resizable: false,
        icon: 'logo.ico'
    },
    'manage-backups': {
        file: 'modal.html',
        width: 960,
        height: 680,
        minWidth: 960,
        minHeight: 680,
        resizable: false,
        icon: 'logo.ico'
    },
    'local-save': {
        file: 'modal.html',
        width: 760,
        height: 560,
        minWidth: 760,
        minHeight: 560,
        resizable: true,
        icon: 'logo.ico'
    },
    'scan-full': {
        file: 'modal.html',
        width: 520,
        height: 200,
        minWidth: 520,
        minHeight: 200,
        resizable: false,
        icon: 'logo.ico'
    },
    confirm: {
        file: 'modal.html',
        width: 520,
        height: 200,
        minWidth: 520,
        minHeight: 200,
        resizable: false,
        icon: 'logo.ico'
    },
    dialog: {
        file: 'modal.html',
        width: 520,
        height: 200,
        minWidth: 520,
        minHeight: 200,
        resizable: true,
        icon: 'logo.ico'
    }
};

const getTopModalOwner = () => {
    for (let index = activeModalWindows.length - 1; index >= 0; index -= 1) {
        const candidate = activeModalWindows[index];
        if (candidate && !candidate.isDestroyed()) {
            return candidate;
        }
    }

    return win;
};



const registerActiveModalWindow = (browserWindow) => {
    if (!browserWindow || browserWindow.isDestroyed() || activeModalWindows.includes(browserWindow)) {
        return;
    }

    activeModalWindows.push(browserWindow);
};

const unregisterActiveModalWindow = (browserWindow) => {
    const index = activeModalWindows.indexOf(browserWindow);
    if (index === -1) {
        return;
    }

    activeModalWindows.splice(index, 1);

    const nextTop = getTopModalOwner();

    if (nextTop && !nextTop.isDestroyed()) {
        nextTop.focus();
    }
};

const showModalWindow = (browserWindow) => {
    if (!browserWindow || browserWindow.isDestroyed()) {
        return;
    }

    registerActiveModalWindow(browserWindow);
    browserWindow.show();
    browserWindow.focus();
};

const applyModalWindowDefinition = (browserWindow, definition) => {
    browserWindow.setMinimumSize(definition.minWidth || definition.width, definition.minHeight || definition.height);
    browserWindow.setSize(definition.width, definition.height, false);
    browserWindow.setResizable(definition.resizable !== false);
};



const loadModalWindowPage = async (browserWindow, pageName, initialData = {}) => {
    const definition = modalWindowDefinitions[pageName];
    if (!definition) {
        throw new Error(`Unknown modal window page: ${pageName}`);
    }

    // Do not run executeJavaScript() before loadFile(). On a newly-created
    // hidden BrowserWindow, that can hang indefinitely and prevent the window
    // from ever being shown when launched via npm start.
    applyModalWindowDefinition(browserWindow, definition);
    modalWindowPages.set(browserWindow, pageName);
    modalWindowData.set(browserWindow, { ...initialData, modalType: pageName });
    return browserWindow.loadFile(path.join(__dirname, `../renderer/${definition.file}`));
};

const startModalWindowLoad = (browserWindow, pageName, initialData = {}) => {
    const previousLoad = modalWindowLoadPromises.get(browserWindow) || Promise.resolve();
    const loadPromise = previousLoad
        .catch(() => {
            // Keep the per-window load queue moving even if an earlier preload
            // was interrupted or failed.
        })
        .then(() => loadModalWindowPage(browserWindow, pageName, initialData))
        .catch((error) => {
            console.error(`Failed to load modal window page "${pageName}":`, error);
            throw error;
        });
    modalWindowLoadPromises.set(browserWindow, loadPromise);
    return loadPromise;
};

const waitForModalWindowLoad = async (browserWindow) => {
    const loadPromise = modalWindowLoadPromises.get(browserWindow);
    if (loadPromise) {
        await loadPromise;
    }
};

const createModalWindow = (pageName, { showWhenReady = true, initialData = {} } = {}) => {
    const definition = modalWindowDefinitions[pageName];
    if (!definition) {
        throw new Error(`Unknown modal window page: ${pageName}`);
    }
    const parentWindow = getTopModalOwner();
    const browserWindow = new BrowserWindow({
        width: definition.width,
        height: definition.height,
        minWidth: definition.minWidth || definition.width,
        minHeight: definition.minHeight || definition.height,
        resizable: definition.resizable !== false,
        minimizable: definition.resizable !== false, // 禁用最小化按钮
        maximizable: definition.resizable !== false, // 禁用最大化按钮
        show: false,
        icon: path.join(__dirname, `../assets/${definition.icon}`),
        parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : win,
        modal: true,
        ...windowVisualEffect,
        webPreferences: {
            preload: path.join(__dirname, "../preload/preload.js"),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webviewTag: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            spellcheck: false,
        },
    });

    hardenBrowserWindow(browserWindow, rendererRoot);
    applyWindowsMicaEffect(browserWindow);
    browserWindow.setMenuBarVisibility(false);
    startModalWindowLoad(browserWindow, pageName, initialData);

    browserWindow.once('ready-to-show', () => {
        if (showWhenReady) {
            showModalWindow(browserWindow);
        }
    });

    // Intercept close to hide first, then destroy after a short delay.
    // This prevents the Mica material from flashing a white/black frame
    // during the DWM teardown, which happens faster than Chromium's renderer
    // can finish its own cleanup.
    let _isClosing = false;
    browserWindow.on('close', (e) => {
        if (!_isClosing && !browserWindow.isDestroyed() && browserWindow.isVisible()) {
            e.preventDefault();
            _isClosing = true;
            browserWindow.hide();
            setTimeout(() => {
                if (!browserWindow.isDestroyed()) {
                    browserWindow.destroy();
                }
            }, 50);
        }
    });

    browserWindow.on("closed", () => {
        unregisterActiveModalWindow(browserWindow);
    });

    return browserWindow;
};

const openModalWindow = async (pageName, initialData = {}) => {
    const existingVisibleWindow = activeModalWindows.find((browserWindow) => {
        return browserWindow && !browserWindow.isDestroyed() && modalWindowPages.get(browserWindow) === pageName;
    });

    if (existingVisibleWindow) {
        if (dynamicModalPages.has(pageName)) {
            await startModalWindowLoad(existingVisibleWindow, pageName, initialData);
        } else {
            await waitForModalWindowLoad(existingVisibleWindow);
        }
        existingVisibleWindow.focus();
        return;
    }

    const modalWindow = createModalWindow(pageName, { showWhenReady: false, initialData });
    await waitForModalWindowLoad(modalWindow);
    showModalWindow(modalWindow);
    modalWindow.moveTop();
};

const requestConfirmModalWindow = (prompt) => {
    return new Promise((resolve) => {
        const requestId = randomUUID();
        const confirmWindow = createModalWindow('confirm', {
            showWhenReady: true,
            initialData: {
                requestId,
                title: prompt?.title || '',
                message: prompt?.message || '',
                confirmText: prompt?.confirmText || '',
                cancelText: prompt?.cancelText || ''
            }
        });
        let resolved = false;

        const finish = (value) => {
            if (resolved) return;
            resolved = true;
            ipcMain.removeListener('modal-window-confirm-response', handleResponse);
            if (confirmWindow && !confirmWindow.isDestroyed()) {
                confirmWindow.close();
            }
            resolve(!!value);
        };

        const handleResponse = (event, responseId, value) => {
            if (event.sender !== confirmWindow.webContents || responseId !== requestId) return;
            finish(value);
        };

        ipcMain.on('modal-window-confirm-response', handleResponse);
        confirmWindow.on('closed', () => finish(false));
    });
};

const requestDialogModalWindow = (dialogData = {}) => {
    return new Promise((resolve) => {
        const requestId = randomUUID();
        const dialogWindow = createModalWindow('dialog', {
            showWhenReady: true,
            initialData: {
                ...dialogData,
                requestId
            }
        });
        let resolved = false;

        const finish = (value) => {
            if (resolved) return;
            resolved = true;
            ipcMain.removeListener('modal-window-dialog-response', handleResponse);
            if (dialogWindow && !dialogWindow.isDestroyed()) {
                dialogWindow.close();
            }
            resolve(value);
        };

        const handleResponse = (event, responseId, value) => {
            if (event.sender !== dialogWindow.webContents || responseId !== requestId) return;
            finish(value);
        };

        ipcMain.on('modal-window-dialog-response', handleResponse);
        dialogWindow.on('closed', () => finish({ value: dialogData.closeValue ?? true, checked: false }));
    });
};

const openSettingsWindow = () => {
    openModalWindow('settings');
};

const openAboutWindow = () => {
    openModalWindow('about');
};



// Main window
const createMainWindow = async () => {
    const mainWindowSize = [1080, 680];
    win = new BrowserWindow({
        width: mainWindowSize[0],
        height: mainWindowSize[1],
        minWidth: 780,
        minHeight: 540,
        icon: path.join(__dirname, "../assets/logo.ico"),
        ...windowVisualEffect,
        webPreferences: {
            preload: path.join(__dirname, "../preload/preload.js"),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webviewTag: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            spellcheck: false,
        },
    });

    hardenBrowserWindow(win, rendererRoot);
    applyWindowsMicaEffect(win);

    if (!app.isPackaged) {
        win.webContents.openDevTools({ mode: "detach" });
    }
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
    win.setMenuBarVisibility(false);
    Menu.setApplicationMenu(null);

    win.on("closed", () => {
        BrowserWindow.getAllWindows().forEach((window) => {
            if (window !== win) {
                window.close();
            }
        });

        if (process.platform !== "darwin") {
            app.quit();
        }
    });
};

function resource_path(resource_name) {
    if (!app.isPackaged) {
        return path.join(__dirname, "../assets_export", resource_name);
    } else {
        return path.join(process.resourcesPath, "assets_export", resource_name);
    }
}

async function getLatestVersion(appName) {
    try {
        const response = await axios.get(appRepositoryApiLatestReleaseUrl, {
            headers: {
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'OpenGameSave'
            },
            timeout: 15000,
            maxContentLength: 1024 * 1024
        });

        const latestVersion = normalizeAppVersion(response.data?.tag_name) || normalizeAppVersion(response.data?.name);
        if (latestVersion) {
            return latestVersion;
        } else {
            console.error('Error: release version not found in GitHub response');
            return null;
        }
    } catch (error) {
        console.error(`Error retrieving latest version from GitHub for ${appName}: ${error.message}`);
        return null;
    }
}

function normalizeAppVersion(version) {
    const match = String(version || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
    return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}

function compareAppVersions(left, right) {
    const leftVersion = normalizeAppVersion(left);
    const rightVersion = normalizeAppVersion(right);

    if (!leftVersion || !rightVersion) {
        return 0;
    }

    const leftParts = leftVersion.split('.').map(Number);
    const rightParts = rightVersion.split('.').map(Number);

    for (let index = 0; index < 3; index += 1) {
        if (leftParts[index] !== rightParts[index]) {
            return leftParts[index] - rightParts[index];
        }
    }

    return 0;
}

function isNewerAppVersion(candidateVersion, currentVersion = appVersion) {
    return compareAppVersions(candidateVersion, currentVersion) > 0;
}


async function checkAppUpdate() {
    try {
        const latestVersion = await getLatestVersion('OpenGameSave');

        if (latestVersion && isNewerAppVersion(latestVersion, appVersion)) {
            showNotification(
                "app",
                i18next.t('alert.update_available'),
                `${i18next.t('alert.new_version_found', { old_version: appVersion, new_version: latestVersion })}\n` +
                `${i18next.t('alert.new_version_found_text')}`,
                latestVersion
            );
        }

    } catch (error) {
        console.error("Error checking for update:", error.stack);
        showNotification(
            "app",
            i18next.t('alert.update_check_failed'),
            i18next.t('alert.update_check_failed_text')
        );
    }
}

function showNotification(type, title, body, latest_version = 0) {
    const icon_map = {
        'app': resource_path('logo.png'),
        'info': resource_path('information.png'),
        'warning': resource_path('warning.png'),
        'critical': resource_path('critical.png'),
    }

    if (process.platform === 'win32') {
        const escapeXml = (value) => String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
        const actionsXml = latest_version ? `
                <actions>
                    <action content="${escapeXml(i18next.t("alert.yes"))}" activationType="protocol" arguments="gamesavemanager://yes"/>
                    <action content="${escapeXml(i18next.t("alert.no"))}" activationType="protocol" arguments="gamesavemanager://no"/>
                </actions>` : '';

        const toastXml = `
            <toast launch="gamesavemanager://default-click">
                <visual>
                    <binding template="ToastImageAndText04">
                        <image id="1" src="${escapeXml(icon_map[type] || icon_map.info)}" placement="appLogoOverride"/>
                        <text id="1">${escapeXml(title)}</text>
                        <text id="2">${escapeXml(body)}</text>
                    </binding>
                </visual>${actionsXml}
            </toast>
        `;

        app.setAppUserModelId('com.leisurefire.opengamesave');
        const notification = new Notification({
            toastXml: toastXml
        });
        notification.show();

        if (latest_version) {
            const handleAction = (event, action) => {
                if (action === 'yes') {
                    updateApp();
                }
                ipcMain.removeListener('notification-action', handleAction);
            };
            ipcMain.on('notification-action', handleAction);
            notification.once('close', () => ipcMain.removeListener('notification-action', handleAction));
        }

    } else {
        const notification = new Notification({
            title: title,
            body: body,
            icon: icon_map[type]
        });
        notification.show();
    }
}

function showBackgroundNotification(type, title, body) {
    if (!win || win.isDestroyed()) {
        return;
    }

    const isInBackground = !win.isFocused() || win.isMinimized() || !win.isVisible();
    if (isInBackground) {
        showNotification(type, title, body);
    }
}

function updateApp() {
    shell.openExternal(appReleaseUrl).catch((error) => {
        console.error('An error occurred while opening the release page:', error);
    });
}

function getGameDisplayName(gameObj) {
    if (settings.language === "en_US") {
        return gameObj.title;
    } else if (settings.language === "zh_CN") {
        return gameObj.zh_CN || gameObj.title;
    }
}

function updateStatus(statusKey, statusValue) {
    if (!STATUS_KEYS.has(statusKey) || typeof statusValue !== 'boolean') {
        throw new Error('Invalid status update');
    }
    status[statusKey] = statusValue;
}

function getSevenZipOptions() {
    return {
        yes: true,
        recursive: true,
        $bin: sevenBin.path7za.replace('app.asar', 'app.asar.unpacked'),
        $progress: true,
        $raw: []
    };
}

async function inspectImportArchive(gsmPath) {
    const archivePath = normalizeAbsolutePath(gsmPath);
    if (path.extname(archivePath).toLowerCase() !== '.gsmr') {
        throw new Error('Only .gsmr backup archives can be imported');
    }
    const archiveStats = await fsOriginal.promises.lstat(archivePath);
    if (!archiveStats.isFile() || archiveStats.isSymbolicLink() || archiveStats.size > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
        throw new Error('The selected import path is not a regular file');
    }

    const listStream = Seven.list(archivePath, {
        ...getSevenZipOptions(),
        techInfo: true,
        $progress: false
    });
    let entryCount = 0;
    let totalSize = 0;
    listStream.on('data', (entry) => {
        if (!entry?.file) return;
        validateArchiveEntryPath(entry.file);
        entryCount += 1;
        if (entryCount > MAX_ARCHIVE_ENTRIES) {
            listStream.destroy(new Error('Archive contains too many entries'));
            return;
        }

        const technicalInfo = entry.techInfo instanceof Map ? entry.techInfo : new Map();
        const attributes = String(entry.attributes || technicalInfo.get('Attributes') || '');
        if (/\bL\b|reparse|symbolic/i.test(attributes)
            || technicalInfo.has('Symbolic Link')
            || technicalInfo.has('Hard Link')) {
            listStream.destroy(new Error('Archive contains links, which are not allowed'));
            return;
        }
        const size = Number(entry.size ?? technicalInfo.get('Size') ?? 0);
        if (Number.isFinite(size) && size > 0) totalSize += size;
        if (totalSize > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
            listStream.destroy(new Error('Archive expands beyond the allowed size'));
        }
    });
    await new Promise((resolve, reject) => {
        listStream.once('end', resolve);
        listStream.once('error', reject);
    });
    if (entryCount === 0) throw new Error('Archive is empty');
    return archivePath;
}

async function collectExtractedBackups(extractRoot) {
    const pendingPaths = [extractRoot];
    let entryCount = 0;
    let totalSize = 0;
    while (pendingPaths.length > 0) {
        const currentPath = pendingPaths.pop();
        const entries = await fsOriginal.promises.readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            entryCount += 1;
            if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error('Extracted archive contains too many entries');
            const entryPath = resolveInside(extractRoot, path.relative(extractRoot, currentPath), entry.name);
            const stats = await fsOriginal.promises.lstat(entryPath);
            if (stats.isSymbolicLink()) throw new Error('Extracted archive contains a symbolic link');
            if (stats.isDirectory()) pendingPaths.push(entryPath);
            else if (stats.isFile()) {
                totalSize += stats.size;
                if (totalSize > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new Error('Extracted archive is too large');
            } else throw new Error('Extracted archive contains an unsupported file type');
        }
    }

    const backups = [];
    const gameEntries = await fsOriginal.promises.readdir(extractRoot, { withFileTypes: true });
    for (const gameEntry of gameEntries) {
        if (!gameEntry.isDirectory()) throw new Error('Archive root may only contain game folders');
        const gameId = normalizeWikiId(gameEntry.name);
        const gamePath = resolveInside(extractRoot, gameId);
        const backupEntries = await fsOriginal.promises.readdir(gamePath, { withFileTypes: true });
        for (const backupEntry of backupEntries) {
            if (!backupEntry.isDirectory()) throw new Error('Game folders may only contain backup folders');
            const backupDate = normalizeBackupDate(backupEntry.name);
            const backupPath = resolveInside(gamePath, backupDate);
            const metadataPath = resolveInside(backupPath, 'backup_info.json');
            const metadataStats = await fsOriginal.promises.lstat(metadataPath);
            if (!metadataStats.isFile() || metadataStats.isSymbolicLink() || metadataStats.size > 1024 * 1024) {
                throw new Error('Backup metadata is invalid');
            }
            const metadata = validateBackupMetadata(await fse.readJson(metadataPath));
            const allowedEntries = new Set(['backup_info.json', ...metadata.backup_paths.map(item => item.folder_name)]);
            const contentEntries = await fsOriginal.promises.readdir(backupPath, { withFileTypes: true });
            for (const contentEntry of contentEntries) {
                if (!allowedEntries.has(contentEntry.name)) throw new Error('Backup contains undeclared content');
            }
            for (const backupItem of metadata.backup_paths) {
                const itemPath = resolveInside(backupPath, backupItem.folder_name);
                const itemStats = await fsOriginal.promises.lstat(itemPath);
                if (!itemStats.isDirectory() || itemStats.isSymbolicLink()) {
                    throw new Error('Backup data folder is invalid');
                }
            }
            backups.push({ gameId, backupDate, sourcePath: backupPath });
        }
    }
    if (backups.length === 0) throw new Error('Archive does not contain any backups');
    return backups;
}

async function exportBackups(count, exportPath, wikiIds = null) {
    if (status.exporting || status.importing) return;
    let releaseOperation;
    try {
        releaseOperation = acquireGlobalOperation('export backups');
    } catch (_) {
        return;
    }
    status.exporting = true;
    const progressId = 'export';
    const progressTitle = i18next.t('alert.exporting');
    const sourcePath = settings.backupPath;
    let progressStarted = false;
    let finalDestPath = null;
    let archiveListDirectory = null;

    try {
        const sourceStats = await fsOriginal.promises.lstat(sourcePath);
        if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
            throw new Error('The backup source is not a regular directory');
        }
        const destinationDirectory = normalizeAbsolutePath(exportPath);
        const destinationStats = await fsOriginal.promises.lstat(destinationDirectory);
        if (!destinationStats.isDirectory() || destinationStats.isSymbolicLink()) {
            throw new Error('The export destination is not a regular directory');
        }
        const exportCount = normalizeBoundedInteger(count, 1, getSettings().maxBackups);
        const selectedWikiIds = wikiIds == null ? null : new Set(normalizeWikiIdArray(wikiIds));

        win.webContents.send('update-progress', progressId, progressTitle, 'start');
        progressStarted = true;

        const itemsToArchive = [];
        let gameFolders = (await fsOriginal.promises.readdir(sourcePath, { withFileTypes: true }))
            .filter(item => item.isDirectory())
            .map(item => item.name)
            .filter((gameId) => {
                try {
                    normalizeWikiId(gameId);
                    return true;
                } catch (_) {
                    return false;
                }
            });

        if (selectedWikiIds) gameFolders = gameFolders.filter(folder => selectedWikiIds.has(folder));

        for (const gameId of gameFolders) {
            const gameFolderPath = resolveInside(sourcePath, gameId);
            const backups = (await fsOriginal.promises.readdir(gameFolderPath, { withFileTypes: true }))
                .filter(item => item.isDirectory())
                .map(item => item.name)
                .filter((backupDate) => {
                    try {
                        normalizeBackupDate(backupDate);
                        return true;
                    } catch (_) {
                        return false;
                    }
                });

            const permanentBackups = [];
            const nonPermanentBackups = [];
            for (const backup of backups) {
                const infoPath = resolveInside(gameFolderPath, backup, 'backup_info.json');
                if (fsOriginal.existsSync(infoPath)) {
                    const infoStats = await fsOriginal.promises.lstat(infoPath);
                    if (!infoStats.isFile() || infoStats.isSymbolicLink() || infoStats.size > 1024 * 1024) {
                        throw new Error('Backup metadata is not a regular bounded file');
                    }
                    const info = validateBackupMetadata(await fse.readJson(infoPath));
                    if (info.is_permanent) {
                        permanentBackups.push(backup);
                        continue;
                    }
                }
                nonPermanentBackups.push(backup);
            }

            nonPermanentBackups.sort((a, b) => b.localeCompare(a));
            const selected = nonPermanentBackups.slice(0, exportCount);

            for (const backupFolder of [...permanentBackups, ...selected]) {
                itemsToArchive.push(path.join(gameId, backupFolder));
            }
        }
        if (itemsToArchive.length === 0) throw new Error('No backups matched the export selection');

        const timestamp = format(new Date(), 'yyyy-MM-dd_HH-mm-ss');
        const finalFileName = `GSMBackup-${timestamp}-${randomUUID().slice(0, 8)}.gsmr`;
        finalDestPath = resolveInside(destinationDirectory, finalFileName);
        archiveListDirectory = await fsOriginal.promises.mkdtemp(path.join(os.tmpdir(), 'GSMExportList-'));
        const archiveListPath = path.join(archiveListDirectory, 'files.txt');
        await fsOriginal.promises.writeFile(archiveListPath, itemsToArchive.join('\n'), { encoding: 'utf8', mode: 0o600 });
        await new Promise((resolve, reject) => {
            execFile(
                sevenBin.path7za.replace('app.asar', 'app.asar.unpacked'),
                ['a', finalDestPath, `@${archiveListPath}`, '-scsUTF-8', '-y', '-r', '-bso0', '-bsp0'],
                { cwd: sourcePath, windowsHide: true, timeout: 6 * 60 * 60 * 1000, maxBuffer: 1024 * 1024 },
                (error) => error ? reject(error) : resolve()
            );
        });

        win.webContents.send('show-alert', 'success', i18next.t('alert.export_success'));

    } catch (error) {
        if (finalDestPath) await fsOriginal.promises.rm(finalDestPath, { force: true }).catch(() => { });
        console.error(`An error occurred while exporting backups: ${error.message}`);
        win.webContents.send('show-alert', 'modal', i18next.t('alert.error_during_export'), error.message);
    } finally {
        if (archiveListDirectory) {
            await fsOriginal.promises.rm(archiveListDirectory, { recursive: true, force: true }).catch(() => { });
        }
        status.exporting = false;
        releaseOperation?.();
        if (progressStarted) win.webContents.send('update-progress', progressId, progressTitle, 'end');
    }
}

async function importBackups(gsmPath) {
    if (status.importing || status.exporting) return;
    let releaseOperation;
    try {
        releaseOperation = acquireGlobalOperation('import backups');
    } catch (_) {
        return;
    }
    status.importing = true;
    const progressId = 'import';
    const progressTitle = i18next.t('alert.importing');
    const destinationPath = settings.backupPath;
    let tempExtractPath = null;
    let progressStarted = false;

    try {
        const archivePath = await inspectImportArchive(gsmPath);
        await fsOriginal.promises.mkdir(destinationPath, { recursive: true });
        const destinationStats = await fsOriginal.promises.lstat(destinationPath);
        if (!destinationStats.isDirectory() || destinationStats.isSymbolicLink()) {
            throw new Error('The backup destination is not a regular directory');
        }
        win.webContents.send('update-progress', progressId, progressTitle, 'start');
        progressStarted = true;

        tempExtractPath = await fsOriginal.promises.mkdtemp(path.join(os.tmpdir(), 'GSMImportTemp-'));
        const extractStream = Seven.extractFull(archivePath, tempExtractPath, getSevenZipOptions());

        extractStream.on('progress', (progress) => {
            if (Number.isFinite(progress.percent)) {
                win.webContents.send('update-progress', progressId, progressTitle, Math.floor(progress.percent * 0.5));
            }
        });

        await new Promise((resolve, reject) => {
            extractStream.once('end', resolve);
            extractStream.once('error', reject);
        });

        const extractedBackups = await collectExtractedBackups(tempExtractPath);
        await fsOriginal.promises.mkdir(destinationPath, { recursive: true });
        let processedBackups = 0;
        for (const backup of extractedBackups) {
            const destGameFolder = resolveInside(destinationPath, backup.gameId);
            const destBackupPath = resolveInside(destGameFolder, backup.backupDate);
            await fsOriginal.promises.mkdir(destGameFolder, { recursive: true });
            const gameFolderStats = await fsOriginal.promises.lstat(destGameFolder);
            if (!gameFolderStats.isDirectory() || gameFolderStats.isSymbolicLink()) {
                throw new Error('Destination game folder is invalid');
            }
            const existingBackupStats = await fsOriginal.promises.lstat(destBackupPath).catch((error) => {
                if (error?.code === 'ENOENT') return null;
                throw error;
            });
            if (existingBackupStats && (!existingBackupStats.isDirectory() || existingBackupStats.isSymbolicLink())) {
                throw new Error('Destination backup path is invalid');
            }
            if (!existingBackupStats) {
                await copyFolderAsync(backup.sourcePath, destBackupPath, fsOriginal);
            }
            processedBackups += 1;
            const movingProgress = Math.floor((processedBackups / extractedBackups.length) * 50);
            win.webContents.send('update-progress', progressId, progressTitle, 50 + movingProgress);
        }

        win.webContents.send('show-alert', 'success', i18next.t('alert.import_success'));

    } catch (error) {
        console.error(`An error occurred while importing backups: ${error.message}`);
        win.webContents.send('show-alert', 'modal', i18next.t('alert.error_during_import'), error.message);
    } finally {
        if (tempExtractPath) {
            await fsOriginal.promises.rm(tempExtractPath, { recursive: true, force: true }).catch(() => { });
        }
        status.importing = false;
        releaseOperation?.();
        if (progressStarted) win.webContents.send('update-progress', progressId, progressTitle, 'end');
        win.webContents.send('update-backup-table');
        win.webContents.send('update-restore-table');
    }
}

async function openRegistryAtKey(keyPath) {
    const normalizedKey = normalizeRegistryKeyPath(keyPath);
    const safeKey = normalizedKey.replace(/^HKEY_/, 'Computer\\HKEY_');
    const args = [
        'add',
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Applets\\Regedit',
        '/v', 'LastKey',
        '/t', 'REG_SZ',
        '/d', safeKey,
        '/f'
    ];

    await new Promise((resolve, reject) => {
        execFile('reg.exe', args, { windowsHide: true }, (error) => error ? reject(error) : resolve());
    });
    const regedit = spawn('regedit.exe', [], { detached: true, stdio: 'ignore', shell: false, windowsHide: true });
    regedit.unref();
}

function deleteRegistryKey(keyPath) {
    return new Promise((resolve, reject) => {
        let normalizedKey;
        try {
            normalizedKey = normalizeRegistryKeyPath(keyPath);
        } catch (error) {
            reject(error);
            return;
        }
        const args = ['delete', normalizedKey, '/f'];
        execFile('reg.exe', args, { windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Failed to delete registry key: ${normalizedKey}`, stderr);
                resolve(false);
            } else {
                resolve(true);
            }
        });
    });
}

async function browseLocalSave(resolvedPaths) {
    try {
        const foldersToOpen = new Set();
        let registryKeyToOpen = null;

        // 1. Sort paths into Folders vs Registry
        for (const pathObj of resolvedPaths) {
            if (pathObj.type === 'reg') {
                // Only picking the first registry key to open the editor
                if (!registryKeyToOpen) {
                    registryKeyToOpen = pathObj.resolved;
                }
            } else {
                const fullPath = pathObj.resolved;
                if (!fullPath) continue;
                try {
                    const stats = await fsOriginal.promises.lstat(fullPath);
                    if (stats.isSymbolicLink()) continue;
                    if (stats.isFile()) foldersToOpen.add(path.dirname(fullPath));
                    else if (stats.isDirectory()) foldersToOpen.add(fullPath);
                } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                }
            }
        }

        const folders = Array.from(foldersToOpen);
        const hasRegistry = !!registryKeyToOpen;

        if (folders.length === 0 && !hasRegistry) {
            win.webContents.send('show-alert', 'warning', i18next.t('alert.no_local_save_found'));
            return;
        }

        // Open directories
        for (const folder of folders) {
            const errorMessage = await shell.openPath(folder);
            if (errorMessage) throw new Error(errorMessage);
        }

        // Open Registry
        if (hasRegistry && registryKeyToOpen) {
            await openRegistryAtKey(registryKeyToOpen);
        }

    } catch (error) {
        console.error('Error browsing local saves:', error);
    }
}

async function deleteLocalSave(resolvedPaths) {
    try {
        let success = true;

        for (const pathObj of resolvedPaths) {
            // Case A: Registry
            if (pathObj.type === 'reg') {
                if (pathObj.resolved) {
                    const regResult = await deleteRegistryKey(pathObj.resolved);
                    if (!regResult) success = false;
                }
            }
            // Case B: Files/Folders
            else {
                const fullPath = pathObj.resolved;
                if (fullPath) {
                    try {
                        const stats = await fsOriginal.promises.lstat(fullPath);
                        if (stats.isSymbolicLink()) {
                            throw new Error('Refusing to delete a symbolic link');
                        }
                        await fsOriginal.promises.rm(fullPath, { recursive: true, force: true });
                    } catch (err) {
                        if (err.code === 'ENOENT') continue;
                        console.error(`Failed to delete file path: ${fullPath}`, err);
                        success = false;
                    }
                }
            }
        }

        if (!success) {
            win.webContents.send('show-alert', 'error', i18next.t('alert.delete_partial_failure'));
        }
        return success;

    } catch (error) {
        console.error('Error deleting local saves:', error);
        win.webContents.send('show-alert', 'error', i18next.t('alert.delete_failed'));
        return false;
    }
}

const placeholder_mapping = {
    // Windows
    '{{p|systemdrive}}': process.env.SystemDrive || path.parse(process.env.WINDIR || 'C:\\Windows').root.replace(/[\\/]$/, '') || 'C:',
    '{{p|username}}': os.userInfo().username,
    '{{p|userprofile}}': process.env.USERPROFILE || os.homedir(),
    '{{p|userprofile/documents}}': path.join(process.env.USERPROFILE || os.homedir(), 'Documents'),
    '{{p|userprofile/appdata/locallow}}': path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'LocalLow'),
    '{{p|appdata}}': process.env.APPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Roaming'),
    '{{p|localappdata}}': process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local'),
    '{{p|programfiles}}': process.env.PROGRAMFILES || 'C:\\Program Files',
    '{{p|programdata}}': process.env.PROGRAMDATA || 'C:\\ProgramData',
    '{{p|public}}': path.join(process.env.PUBLIC || 'C:\\Users\\Public'),
    '{{p|windir}}': process.env.WINDIR || 'C:\\Windows',

    // Registry
    '{{p|hkcu}}': 'HKEY_CURRENT_USER',
    '{{p|hklm}}': 'HKEY_LOCAL_MACHINE',
    '{{p|wow64}}': 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node',

    // Mac
    '{{p|osxhome}}': os.homedir(),

    // Linux
    '{{p|linuxhome}}': os.homedir(),
    '{{p|xdgdatahome}}': process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    '{{p|xdgconfighome}}': process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
};

const osKeyMap = {
    win32: 'win',
    darwin: 'mac',
    linux: 'linux'
};

// ======================================================================
// Settings
// ======================================================================
const loadSettings = () => {
    const userDataPath = app.getPath("userData");
    const appDataPath = app.getPath("appData");
    const settingsPath = path.join(userDataPath, "OGS Settings", "settings.json");

    const locale_mapping = {
        'en': 'en_US',
        'en-US': 'en_US',
        'zh': 'zh_CN',
        'zh-CN': 'zh_CN',
        'zh-SG': 'zh_CN',
        'zh-Hans': 'zh_CN',
        'zh-Hans-CN': 'zh_CN',
        'zh-Hans-SG': 'zh_CN',
    };

    const detectLanguage = () => {
        const locales = [app.getLocale(), ...app.getPreferredSystemLanguages()];
        const detectedLocale = locales.find(locale => {
            if (!locale) return false;
            return Boolean(locale_mapping[locale]) || locale.toLowerCase().startsWith('zh');
        });

        if (detectedLocale && detectedLocale.toLowerCase().startsWith('zh')) {
            return 'zh_CN';
        }

        return normalizeLanguage(locale_mapping[detectedLocale]);
    };

    const detectedLanguage = detectLanguage();
    const isFirstLaunch = !fs.existsSync(settingsPath);

    // Default settings
    const defaultSettings = {
        language: detectedLanguage,
        backupPath: path.join(appDataPath, "OGS Backups"),
        exportPath: "",
        maxBackups: 5,
        autoAppUpdate: true,
        autoDbUpdate: false,
        syncAccentColor: false,
        experimentalXgpSource: false,
        backupAllAccounts: false,
        saveUninstalledGames: true,
        gameInstalls: 'uninitialized',
        pinnedGames: [],
        blockedGames: [],
        blockedGameTipDismissed: false,
        uninstalledGames: [],
        autoBackupGames: {},
        firstLaunchFullScanTipShown: !isFirstLaunch
    };

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });

    try {
        const data = fs.readFileSync(settingsPath, 'utf8');
        const loadedSettings = JSON.parse(data);
        settings = sanitizeSettings(loadedSettings, defaultSettings);

    } catch (err) {
        if (err.code !== 'ENOENT') console.error("Error loading settings, using defaults:", err);
        settings = sanitizeSettings({}, defaultSettings);
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    }
};

function saveSettings(key, value) {
    const userDataPath = app.getPath('userData');
    const settingsPath = path.join(userDataPath, 'OGS Settings', 'settings.json');

    if (!ALLOWED_SETTING_KEYS.has(key)) throw new Error(`Unknown setting: ${key}`);
    settings[key] = sanitizeSettingValue(key, value, settings[key]);
    const settingsSnapshot = JSON.stringify(settings, null, 2);

    writeQueue = writeQueue.catch(() => undefined).then(async () => {
        const tempPath = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
            await fs.promises.writeFile(tempPath, settingsSnapshot, { encoding: 'utf8', mode: 0o600 });
            await fs.promises.rename(tempPath, settingsPath);
        } finally {
            await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
        }

        if ((key === 'gameInstalls' || key === 'saveUninstalledGames' || key === 'experimentalXgpSource') && win && !win.isDestroyed()) {
            win.webContents.send('update-backup-table');
            win.webContents.send('update-restore-table');
        }

        if (key === 'language') {
            await i18next.changeLanguage(settings[key]);
            BrowserWindow.getAllWindows().forEach((window) => {
                if (!window.isDestroyed()) window.webContents.send('apply-language');
            });
            if (win && !win.isDestroyed()) {
                win.webContents.send('update-backup-table');
                win.webContents.send('update-restore-table');
            }
            Menu.setApplicationMenu(null);
        }
    });
    return writeQueue;
}

async function performBackupMigration(sourceDir, destinationDir) {
    const sourcePath = normalizeAbsolutePath(sourceDir);
    const destinationPath = normalizeAbsolutePath(destinationDir);
    const normalizedSource = process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath;
    const normalizedDestination = process.platform === 'win32' ? destinationPath.toLowerCase() : destinationPath;
    if (normalizedSource === normalizedDestination
        || isPathInside(sourcePath, destinationPath)
        || isPathInside(destinationPath, sourcePath)
        || path.parse(sourcePath).root === sourcePath) {
        throw new Error('Backup migration paths must be separate, non-root directories');
    }

    const sourceStats = await fsOriginal.promises.lstat(sourcePath);
    if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
        throw new Error('The current backup path is not a regular directory');
    }
    try {
        const destinationStats = await fsOriginal.promises.lstat(destinationPath);
        if (!destinationStats.isDirectory() || destinationStats.isSymbolicLink()) {
            throw new Error('The migration destination is not a regular directory');
        }
        if ((await fsOriginal.promises.readdir(destinationPath)).length > 0) {
            throw new Error('The migration destination must be empty');
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await fsOriginal.promises.mkdir(destinationPath, { recursive: true });
    }

    const totalSize = await calculateDirectorySizeAsync(sourcePath, false, fsOriginal);
    let movedSize = 0;
    let lastProgress = -1;
    const progressId = 'migrate-backups';
    const progressTitle = i18next.t('alert.migrate_backups');
    win.webContents.send('update-progress', progressId, progressTitle, 'start');

    try {
        const pendingDirectories = [[sourcePath, destinationPath]];
        while (pendingDirectories.length > 0) {
            const [currentSource, currentDestination] = pendingDirectories.pop();
            await fsOriginal.promises.mkdir(currentDestination, { recursive: true });
            const entries = await fsOriginal.promises.readdir(currentSource, { withFileTypes: true });
            for (const entry of entries) {
                const sourceEntry = path.join(currentSource, entry.name);
                const destinationEntry = path.join(currentDestination, entry.name);
                if (entry.isSymbolicLink()) throw new Error(`Refusing to migrate symbolic link: ${sourceEntry}`);
                if (entry.isDirectory()) {
                    pendingDirectories.push([sourceEntry, destinationEntry]);
                    continue;
                }
                if (!entry.isFile()) throw new Error(`Unsupported file type in backup folder: ${sourceEntry}`);

                const fileStats = await fsOriginal.promises.lstat(sourceEntry);
                const readStream = fsOriginal.createReadStream(sourceEntry);
                const writeStream = fsOriginal.createWriteStream(destinationEntry, { flags: 'wx' });
                readStream.on('data', (chunk) => {
                    movedSize += chunk.length;
                    const progressPercentage = totalSize > 0 ? Math.min(100, Math.floor((movedSize / totalSize) * 100)) : 100;
                    if (progressPercentage !== lastProgress) {
                        lastProgress = progressPercentage;
                        win.webContents.send('update-progress', progressId, progressTitle, progressPercentage);
                    }
                });
                await pipeline(readStream, writeStream);
                await fsOriginal.promises.utimes(destinationEntry, fileStats.atime, fileStats.mtime);
            }
        }

        const copiedSize = await calculateDirectorySizeAsync(destinationPath, false, fsOriginal);
        if (copiedSize !== totalSize) throw new Error('Backup migration verification failed');
        await fsOriginal.promises.rm(sourcePath, { recursive: true });
        await saveSettings('backupPath', destinationPath);
        win.webContents.send('update-restore-table');
        win.webContents.send('show-alert', 'success', i18next.t('alert.backup_migration_success'));
        return true;
    } catch (error) {
        console.error('Backup migration failed:', error);
        win.webContents.send('show-alert', 'modal', i18next.t('alert.error_during_backup_migration'), error.message);
        return false;
    } finally {
        win.webContents.send('update-progress', progressId, progressTitle, 'end');
    }
}

async function moveFilesWithProgress(sourceDir, destinationDir) {
    if (status.migrating) return false;
    let releaseOperation;
    try {
        releaseOperation = acquireGlobalOperation('migrate backups');
    } catch (_) {
        return false;
    }
    status.migrating = true;
    try {
        return await performBackupMigration(sourceDir, destinationDir);
    } finally {
        status.migrating = false;
        releaseOperation?.();
    }
}

ipcMain.on('open-settings-window', () => {
    openSettingsWindow();
});

ipcMain.on('open-about-window', () => {
    openAboutWindow();
});

function sanitizePublicModalData(pageName, initialData) {
    if (pageName === 'import') {
        const gsmPath = typeof initialData?.gsmPath === 'string' && initialData.gsmPath.length <= 32767
            ? initialData.gsmPath
            : '';
        return { gsmPath };
    }
    if (pageName === 'auto-backup' || pageName === 'manage-backups' || pageName === 'local-save') {
        return { wikiId: normalizeWikiId(initialData?.wikiId) };
    }
    return {};
}

ipcMain.on('open-modal-window', (event, pageName, initialData = {}) => {
    if (!PUBLIC_MODAL_PAGES.has(pageName)) return;
    try {
        openModalWindow(pageName, sanitizePublicModalData(pageName, initialData));
    } catch (error) {
        console.error('Failed to open modal window:', error);
    }
});

ipcMain.on('close-current-modal-window', (event) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    if (browserWindow && browserWindow !== win && modalWindowPages.has(browserWindow) && !browserWindow.isDestroyed()) {
        browserWindow.close();
    }
});

ipcMain.on('resize-current-modal-window', (event, width, height) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    if (browserWindow && browserWindow !== win && modalWindowPages.has(browserWindow) && !browserWindow.isDestroyed()) {
        const [currentWidth, currentHeight] = browserWindow.getContentSize();
        const nextWidth = width == null ? currentWidth : normalizeBoundedInteger(width, 320, 1920, currentWidth);
        const nextHeight = height == null ? currentHeight : normalizeBoundedInteger(height, 120, 1200, currentHeight);
        browserWindow.setContentSize(nextWidth, nextHeight, false);
    }
});

ipcMain.on('show-main-alert', (event, type, message, detailContent) => {
    if (win && !win.isDestroyed()) {
        const safeType = new Set(['success', 'info', 'warning', 'error', 'modal']).has(type) ? type : 'info';
        const safeMessage = String(message ?? '').slice(0, 2000);
        const safeDetails = Array.isArray(detailContent)
            ? detailContent.slice(0, 200).map(item => String(item).slice(0, 4000))
            : String(detailContent ?? '').slice(0, 10000);
        win.webContents.send('show-alert', safeType, safeMessage, safeDetails);
    }
});

ipcMain.handle('show-confirm-modal-window', async (event, prompt) => {
    return await requestConfirmModalWindow({
        title: String(prompt?.title ?? '').slice(0, 500),
        message: String(prompt?.message ?? '').slice(0, 10000),
        confirmText: String(prompt?.confirmText ?? '').slice(0, 200),
        cancelText: String(prompt?.cancelText ?? '').slice(0, 200)
    });
});

ipcMain.handle('show-dialog-modal-window', async (event, dialogData) => {
    const sourceButtons = Array.isArray(dialogData?.buttons) ? dialogData.buttons.slice(-2) : [];
    const buttons = sourceButtons.map((button) => ({
        value: ['string', 'number', 'boolean'].includes(typeof button?.value) ? button.value : null,
        text: String(button?.text ?? '').slice(0, 200),
        i18n: String(button?.i18n ?? '').slice(0, 200),
        primary: button?.primary === true
    }));
    const rawContent = dialogData?.content;
    const content = Array.isArray(rawContent)
        ? rawContent.slice(0, 200).map(item => Array.isArray(item)
            ? item.slice(0, 200).map(value => String(value).slice(0, 4000))
            : String(item).slice(0, 4000))
        : String(rawContent ?? '').slice(0, 20000);
    return await requestDialogModalWindow({
        title: String(dialogData?.title ?? '').slice(0, 500),
        content,
        iconType: dialogData?.iconType === 'warning' ? 'warning' : 'info',
        buttons,
        closeValue: ['string', 'number', 'boolean'].includes(typeof dialogData?.closeValue) ? dialogData.closeValue : true,
        checkbox: dialogData?.checkbox ? { label: String(dialogData.checkbox.label ?? '').slice(0, 500) } : null
    });
});

ipcMain.handle('get-modal-window-data', (event) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    return modalWindowData.get(browserWindow) || {};
});

ipcMain.on('view-account-ids', () => {
    openModalWindow('account');
});

ipcMain.on('scan-full', () => {
    openModalWindow('scan-full');
});

module.exports = {
    windowVisualEffect,
    applyWindowsMicaEffect,
    createMainWindow,
    getMainWin: () => win,
    getStatus: () => ({ ...status }),
    updateStatus,

    getCurrentVersion: () => appVersion,
    getRepositoryUrl: () => appRepositoryUrl,
    getLatestVersion,
    isNewerAppVersion,
    checkAppUpdate,
    showBackgroundNotification,
    updateApp,
    getGameDisplayName,
    exportBackups,
    importBackups,
    browseLocalSave,
    deleteLocalSave,
    placeholder_mapping,
    osKeyMap,
    loadSettings,
    saveSettings,
    getSettings: () => settings,
    moveFilesWithProgress,
};
