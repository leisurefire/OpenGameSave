const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const { getMainWin } = require('../global');
const { hardenBrowserWindow } = require('../windowSecurity');

const MENU_MIN_WIDTH = 196;
const MENU_MAX_WIDTH = 400;
const MENU_HIDDEN_BOUNDS = { x: -10000, y: -10000, width: 1, height: 1 };

let menuWindow = null;
let menuParentWindow = null;
let isMenuOpen = false;

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
        menuWindow.setBounds(MENU_HIDDEN_BOUNDS, false);
    }

    const mainWindow = getMainWin();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu-hidden');
}

function hideMenuWindowAfterBlur() {
    setTimeout(() => {
        if (isMenuOpen && menuWindow && !menuWindow.isDestroyed()) hideMenuWindow();
    }, 150);
}

function destroyMenuWindow() {
    detachMenuParentListeners();
    if (menuWindow && !menuWindow.isDestroyed()) menuWindow.destroy();
    menuWindow = null;
    isMenuOpen = false;
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
        focusable: false,
        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.js'),
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

    hardenBrowserWindow(newMenuWindow, path.join(__dirname, '../renderer'));
    menuWindow = newMenuWindow;
    newMenuWindow.loadFile(path.join(__dirname, '../renderer/menu.html'));
    newMenuWindow.once('ready-to-show', () => {
        if (newMenuWindow.isDestroyed()) return;
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
    menuParentWindow.on('blur', hideMenuWindowAfterBlur);
    menuParentWindow.on('move', hideMenuWindow);

    menuWindow.targetScreenX = Math.round(parentContentBounds.x + x);
    menuWindow.targetScreenY = Math.round(parentContentBounds.y + y);
    menuWindow.menuDirection = direction;
    const sendItems = () => {
        if (!menuWindow?.isDestroyed()) {
            menuWindow.webContents.send('set-menu-items', { items, direction: menuWindow.menuDirection });
        }
    };
    if (menuWindow.webContents.isLoading()) menuWindow.webContents.once('did-finish-load', sendItems);
    else sendItems();
}

function resizeAndShowMenu(event, size) {
    if (!menuWindow || menuWindow.isDestroyed() || event.sender !== menuWindow.webContents) return;
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
    isMenuOpen = true;
    menuWindow.setBounds({ x, y, width, height }, false);
    menuWindow.setOpacity(1);
    if (!menuWindow.isVisible()) menuWindow.showInactive();
}

function registerMenuWindowIpc() {
    ipcMain.on('hide-popup-menu', hideMenuWindow);
    ipcMain.on('show-popup-menu', showPopupMenu);
    ipcMain.on('resize-and-show-menu', resizeAndShowMenu);
    ipcMain.on('menu-item-click', (event, action, data) => {
        if (!menuWindow || event.sender !== menuWindow.webContents) return;
        hideMenuWindow();
        const mainWindow = getMainWin();
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('execute-menu-action', action, data);
        }
    });
}

module.exports = {
    createMenuWindow,
    destroyMenuWindow,
    registerMenuWindowIpc
};
