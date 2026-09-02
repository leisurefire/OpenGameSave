const { BrowserWindow, ipcMain } = require('electron');
const i18next = require('i18next');
const path = require('path');
const { isDeepStrictEqual } = require('util');

const { RENDERER_ROLE_ARGUMENT_PREFIX } = require('../../shared/ipcPolicy');
const { getMainWin } = require('../global');
const { registerRendererWindow } = require('../ipcAuthorization');
const { hardenBrowserWindow } = require('../windowSecurity');

const MENU_MIN_WIDTH = 196;
const MENU_MAX_WIDTH = 400;
const MENU_HIDDEN_BOUNDS = { x: -10000, y: -10000, width: 1, height: 1 };

let menuWindow = null;
let menuParentWindow = null;
let isMenuOpen = false;
let activeMenuItems = [];
let activeMenuRequestId = null;
let nextMenuRequestId = 0;

function detachMenuParentListeners() {
    if (!menuParentWindow || menuParentWindow.isDestroyed()) {
        menuParentWindow = null;
        return;
    }
    menuParentWindow.removeListener('blur', hideMenuWindowAfterParentBlur);
    menuParentWindow.removeListener('move', hideMenuWindowAfterParentMove);
    menuParentWindow = null;
}

function hideMenuWindow({ restoreFocus = false } = {}) {
    const hadActiveMenu = isMenuOpen || activeMenuItems.length > 0;
    const parentWindow = menuParentWindow;
    isMenuOpen = false;
    activeMenuItems = [];
    activeMenuRequestId = null;
    detachMenuParentListeners();
    if (menuWindow && !menuWindow.isDestroyed()) {
        if (menuWindow.isVisible()) menuWindow.hide();
        menuWindow.setBounds(MENU_HIDDEN_BOUNDS, false);
    }

    if (!hadActiveMenu) return;

    const notificationWindow = parentWindow && !parentWindow.isDestroyed()
        ? parentWindow
        : getMainWin();
    if (!notificationWindow || notificationWindow.isDestroyed()) return;

    if (restoreFocus && notificationWindow.isVisible()) notificationWindow.focus();
    notificationWindow.webContents.send('menu-hidden', { restoreFocus });
}

function hideMenuWindowAfterParentBlur() {
    const requestId = activeMenuRequestId;
    setTimeout(() => {
        if (requestId !== activeMenuRequestId) return;
        if (!isMenuOpen || !menuWindow || menuWindow.isDestroyed()) return;
        if (!menuWindow.isFocused()) hideMenuWindow();
    }, 150);
}

function hideMenuWindowAfterMenuBlur() {
    const requestId = activeMenuRequestId;
    setTimeout(() => {
        if (requestId !== activeMenuRequestId) return;
        if (isMenuOpen && menuWindow && !menuWindow.isDestroyed() && !menuWindow.isFocused()) {
            hideMenuWindow();
        }
    }, 150);
}

function hideMenuWindowAfterParentMove() {
    hideMenuWindow();
}

function destroyMenuWindow() {
    detachMenuParentListeners();
    if (menuWindow && !menuWindow.isDestroyed()) menuWindow.destroy();
    menuWindow = null;
    isMenuOpen = false;
    activeMenuItems = [];
    activeMenuRequestId = null;
}

function createMenuWindow() {
    if (menuWindow && !menuWindow.isDestroyed()) return;

    const newMenuWindow = new BrowserWindow({
        ...MENU_HIDDEN_BOUNDS,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        show: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        type: 'toolbar',
        hasShadow: true,
        focusable: true,
        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.js'),
            additionalArguments: [`${RENDERER_ROLE_ARGUMENT_PREFIX}menu`],
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webviewTag: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            spellcheck: false,
            backgroundThrottling: false
        }
    });

    const rendererRoot = path.join(__dirname, '../renderer');
    registerRendererWindow(newMenuWindow, 'menu', rendererRoot);
    hardenBrowserWindow(newMenuWindow, rendererRoot);
    menuWindow = newMenuWindow;
    newMenuWindow.loadFile(path.join(__dirname, '../renderer/menu.html'));
    newMenuWindow.once('ready-to-show', () => {
        if (newMenuWindow.isDestroyed()) return;
        newMenuWindow.setBounds(MENU_HIDDEN_BOUNDS, false);
        newMenuWindow.showInactive();
    });
    newMenuWindow.on('blur', hideMenuWindowAfterMenuBlur);
    newMenuWindow.on('closed', () => {
        if (menuWindow === newMenuWindow) {
            menuWindow = null;
            isMenuOpen = false;
        }
    });
}

function showPopupMenu(event, payload = {}) {
    const items = Array.isArray(payload.items) ? payload.items.slice(0, 30) : [];
    const x = Number(payload.x);
    const y = Number(payload.y);
    const direction = payload.direction === 'up' ? 'up' : 'down';
    if (!Number.isFinite(x) || !Number.isFinite(y) || items.length === 0) return;
    if (!menuWindow || menuWindow.isDestroyed()) createMenuWindow();

    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    if (!parentWindow || parentWindow.isDestroyed()) return;
    const parentContentBounds = parentWindow.getContentBounds();
    detachMenuParentListeners();
    menuParentWindow = parentWindow;
    menuParentWindow.on('blur', hideMenuWindowAfterParentBlur);
    menuParentWindow.on('move', hideMenuWindowAfterParentMove);

    menuWindow.targetScreenX = Math.round(parentContentBounds.x + x);
    menuWindow.targetScreenY = Math.round(parentContentBounds.y + y);
    menuWindow.menuDirection = direction;
    activeMenuItems = items;
    activeMenuRequestId = ++nextMenuRequestId;
    const requestId = activeMenuRequestId;
    const sendItems = () => {
        if (!menuWindow?.isDestroyed()) {
            menuWindow.webContents.send('set-menu-items', {
                items,
                direction: menuWindow.menuDirection,
                locale: i18next.t('meta.locale'),
                requestId
            });
        }
    };
    if (menuWindow.webContents.isLoading()) menuWindow.webContents.once('did-finish-load', sendItems);
    else sendItems();
}

function resizeAndShowMenu(event, size) {
    if (!menuWindow || menuWindow.isDestroyed() || event.sender !== menuWindow.webContents) return;
    if (size?.dismiss === true) {
        hideMenuWindow({ restoreFocus: true });
        return;
    }
    if (size?.requestId !== activeMenuRequestId || activeMenuItems.length === 0) return;
    const width = Math.min(Math.max(Math.ceil(size?.width || MENU_MIN_WIDTH), MENU_MIN_WIDTH), MENU_MAX_WIDTH);
    const height = Math.min(Math.max(Math.ceil(size?.height || 1), 1), 1000);
    const clampInset = value => Math.min(Math.max(Math.ceil(Number(value) || 0), 0), 48);
    const inset = {
        top: clampInset(size?.inset?.top),
        bottom: clampInset(size?.inset?.bottom),
        left: clampInset(size?.inset?.left)
    };
    const x = Math.round(menuWindow.targetScreenX - inset.left);
    const y = menuWindow.menuDirection === 'up'
        ? Math.round(menuWindow.targetScreenY - height + inset.bottom)
        : Math.round(menuWindow.targetScreenY - inset.top);
    if (!menuParentWindow || menuParentWindow.isDestroyed() || !menuParentWindow.isFocused()) {
        hideMenuWindow();
        return;
    }
    isMenuOpen = true;
    menuWindow.setBounds({ x, y, width, height }, false);
    menuWindow.setOpacity(1);
    if (!menuWindow.isVisible()) menuWindow.showInactive();
    if (menuParentWindow.isFocused()) menuWindow.focus();
    else hideMenuWindow();
}

function registerMenuWindowIpc() {
    ipcMain.on('hide-popup-menu', () => hideMenuWindow());
    ipcMain.on('show-popup-menu', showPopupMenu);
    ipcMain.on('resize-and-show-menu', resizeAndShowMenu);
    ipcMain.on('menu-item-click', (event, action, data) => {
        if (!menuWindow || event.sender !== menuWindow.webContents) return;
        const authorizedItem = activeMenuItems.find(item => (
            item?.action === action && isDeepStrictEqual(item?.data, data)
        ));
        if (!authorizedItem) return;
        hideMenuWindow({ restoreFocus: true });
        const mainWindow = getMainWin();
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('execute-menu-action', authorizedItem.action, authorizedItem.data);
        }
    });
}

module.exports = {
    createMenuWindow,
    destroyMenuWindow,
    registerMenuWindowIpc
};
