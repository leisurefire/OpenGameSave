const path = require('path');
const { fileURLToPath } = require('url');

function isRendererFileUrl(url, rendererRoot) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'file:') return false;
        const targetPath = path.resolve(fileURLToPath(parsed));
        const relativePath = path.relative(path.resolve(rendererRoot), targetPath);
        return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
    } catch (_) {
        return false;
    }
}

function hardenBrowserWindow(browserWindow, rendererRoot) {
    browserWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    browserWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
    browserWindow.webContents.on('will-navigate', (event, url) => {
        if (!isRendererFileUrl(url, rendererRoot)) {
            event.preventDefault();
        }
    });
}

function denyUnexpectedPermissions(electronSession) {
    electronSession.setPermissionCheckHandler(() => false);
    electronSession.setPermissionRequestHandler((webContents, permission, callback) => callback(false));
}

module.exports = {
    denyUnexpectedPermissions,
    hardenBrowserWindow,
    isRendererFileUrl
};
