const { BrowserWindow, Menu, app, ipcMain, nativeTheme } = require('electron');
const { randomUUID } = require('crypto');
const path = require('path');

const { normalizeBoundedInteger, normalizeWikiId } = require('../validation');
const { hardenBrowserWindow } = require('../windowSecurity');

let win;
const activeModalWindows = [];
const modalWindowPages = new WeakMap();
const modalWindowData = new WeakMap();
const modalWindowLoadPromises = new WeakMap();
const isWindows = process.platform === 'win32';
const rendererRoot = path.join(__dirname, '../renderer');
const PUBLIC_MODAL_PAGES = new Set(['export', 'import', 'account', 'auto-backup', 'manage-backups', 'local-save', 'scan-full']);

nativeTheme.themeSource = 'dark';

/** @type {import('electron').BrowserWindowConstructorOptions} */
const windowVisualEffect = isWindows ? {
    backgroundMaterial: 'mica',
    backgroundColor: '#00000000'
} : {};

const applyWindowsMicaEffect = (browserWindow) => {
    if (!isWindows || !browserWindow || browserWindow.isDestroyed()) {
        return;
    }

    if (typeof browserWindow.setBackgroundMaterial === 'function') {
        browserWindow.setBackgroundMaterial('mica');
    }

    browserWindow.setBackgroundColor('#00000000');
};
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

    // The native owner is re-enabled after Electron finishes tearing down the
    // modal HWND. Focusing it synchronously from the child's `closed` event can
    // be ignored by Windows, especially after shell.openExternal() temporarily
    // moved activation to another application. Wait one event-loop turn, then
    // resolve the current top owner again so a newly opened modal is not skipped.
    setTimeout(() => {
        const nextTop = getTopModalOwner();
        if (!nextTop || nextTop.isDestroyed() || !nextTop.isVisible()) {
            return;
        }

        nextTop.focus();
        applyWindowsMicaEffect(nextTop);
    }, 0);
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
            preload: path.join(__dirname, '../preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webviewTag: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            spellcheck: false
        }
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

    browserWindow.on('closed', () => {
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
        icon: path.join(__dirname, '../assets/logo.ico'),
        ...windowVisualEffect,
        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webviewTag: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            spellcheck: false
        }
    });

    hardenBrowserWindow(win, rendererRoot);
    applyWindowsMicaEffect(win);

    if (!app.isPackaged) {
        win.webContents.openDevTools({ mode: 'detach' });
    }
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
    win.setMenuBarVisibility(false);
    Menu.setApplicationMenu(null);

    win.on('closed', () => {
        BrowserWindow.getAllWindows().forEach((window) => {
            if (window !== win) {
                window.close();
            }
        });

        if (process.platform !== 'darwin') {
            app.quit();
        }
    });
};

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
    applyWindowsMicaEffect,
    createMainWindow,
    getMainWin: () => win,
    windowVisualEffect
};
