const path = require('path');
const { fileURLToPath } = require('url');

const { ROLE_FILES, isRoleAllowed } = require('../shared/ipcPolicy');
const { isRendererFileUrl } = require('./windowSecurity');

const senderRoles = new WeakMap();
const INSTALL_MARKER = Symbol.for('OpenGameSave.ipcAuthorizationInstalled');
const SETTINGS_KEYS_BY_ROLE = Object.freeze({
    main: new Set([
        'blockedGameTipDismissed',
        'blockedGames',
        'firstLaunchFullScanTipShown',
        'pinnedGames',
        'syncProvider',
        'uninstalledGames'
    ]),
    settings: new Set([
        'appUpdatePrerelease',
        'autoAppUpdate',
        'autoDbUpdate',
        'databaseVariant',
        'gameInstalls',
        'launchAtStartup',
        'maxBackups',
        'saveUninstalledGames',
        'syncAccentColor',
        'visibleSidebarItems'
    ]),
    export: new Set(['exportPath']),
    account: new Set(['backupAllAccounts'])
});
const SETTINGS_READ_KEYS_BY_ROLE = Object.freeze({
    export: Object.freeze(['exportPath', 'maxBackups']),
    account: Object.freeze(['backupAllAccounts']),
    'auto-backup': Object.freeze(['language']),
    'manage-backups': Object.freeze(['language']),
    'local-save': Object.freeze(['language'])
});

function normalizePathForComparison(filePath) {
    const resolvedPath = path.resolve(filePath);
    return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

function isExpectedRoleUrl(url, registration) {
    if (!isRendererFileUrl(url, registration.rendererRoot)) return false;
    try {
        const actualPath = normalizePathForComparison(fileURLToPath(new URL(url)));
        const expectedPath = normalizePathForComparison(path.join(registration.rendererRoot, registration.file));
        return actualPath === expectedPath;
    } catch (error) {
        return false;
    }
}

function registerRendererWebContents(webContents, role, rendererRoot) {
    const expectedFile = ROLE_FILES[role];
    if (!webContents || typeof webContents.getURL !== 'function') {
        throw new TypeError('A valid webContents instance is required');
    }
    if (!expectedFile) throw new Error(`Unknown renderer role: ${role}`);
    senderRoles.set(webContents, {
        role,
        file: expectedFile,
        rendererRoot: path.resolve(rendererRoot)
    });
}

function registerRendererWindow(browserWindow, role, rendererRoot) {
    if (!browserWindow?.webContents) throw new TypeError('A valid BrowserWindow is required');
    registerRendererWebContents(browserWindow.webContents, role, rendererRoot);
}

function getAuthorizedSenderRole(event) {
    const sender = event?.sender;
    const registration = sender && senderRoles.get(sender);
    if (!registration || sender.isDestroyed?.()) return null;

    const senderUrl = sender.getURL();
    if (!isExpectedRoleUrl(senderUrl, registration)) return null;

    const senderFrame = event.senderFrame;
    if (!senderFrame) return null;
    if (senderFrame.parent || (senderFrame.top && senderFrame.top !== senderFrame)) return null;
    if (!isExpectedRoleUrl(senderFrame.url, registration)) return null;
    return registration.role;
}

function getRequestedSettingKeys(keyOrUpdates) {
    if (typeof keyOrUpdates === 'string') return [keyOrUpdates];
    if (!keyOrUpdates || typeof keyOrUpdates !== 'object' || Array.isArray(keyOrUpdates)) return [];
    return Object.keys(keyOrUpdates);
}

function areAuthorizedIpcArguments(role, channel, args) {
    if (channel === 'save-settings') {
        const requestedKeys = getRequestedSettingKeys(args[0]);
        const allowedKeys = SETTINGS_KEYS_BY_ROLE[role];
        return requestedKeys.length > 0 && !!allowedKeys
            && requestedKeys.every(key => allowedKeys.has(key));
    }
    if (channel === 'select-path') {
        return (role === 'export' && args[0] === 'folder')
            || (role === 'import' && args[0] === 'gsmr');
    }
    return true;
}

function filterSettingsForRole(role, settings) {
    if (role === 'main' || role === 'settings') return settings;
    const allowedKeys = SETTINGS_READ_KEYS_BY_ROLE[role] || [];
    return Object.fromEntries(allowedKeys.map(key => [key, settings[key]]));
}

function isAuthorizedIpcEvent(event, direction, channel, args = []) {
    const role = getAuthorizedSenderRole(event);
    return role != null
        && isRoleAllowed(role, direction, channel)
        && areAuthorizedIpcArguments(role, channel, args);
}

function rejectUnauthorizedSend(event) {
    if (typeof event?.preventDefault === 'function') event.preventDefault();
}

function reportRendererIpcListenerError(channel, error) {
    console.error(`Renderer IPC listener failed (${channel}):`, error);
}

function installIpcAuthorization(ipcMain) {
    if (!ipcMain || ipcMain[INSTALL_MARKER]) return;

    const originalHandle = ipcMain.handle.bind(ipcMain);
    const originalHandleOnce = typeof ipcMain.handleOnce === 'function'
        ? ipcMain.handleOnce.bind(ipcMain)
        : null;
    const originalOn = ipcMain.on.bind(ipcMain);
    const originalPrependListener = ipcMain.prependListener.bind(ipcMain);
    const originalRemoveListener = ipcMain.removeListener.bind(ipcMain);
    const originalRemoveAllListeners = ipcMain.removeAllListeners.bind(ipcMain);
    const listenerWrappers = new Map();

    const wrapInvokeHandler = (channel, handler) => (event, ...args) => {
        if (!isAuthorizedIpcEvent(event, 'invoke', channel, args)) {
            throw new Error(`Unauthorized IPC invocation: ${channel}`);
        }
        return handler(event, ...args);
    };

    ipcMain.handle = (channel, handler) => originalHandle(channel, wrapInvokeHandler(channel, handler));
    if (originalHandleOnce) {
        ipcMain.handleOnce = (channel, handler) => (
            originalHandleOnce(channel, wrapInvokeHandler(channel, handler))
        );
    }

    const forgetWrappedListener = (channel, listener, wrappedListener) => {
        const channelListeners = listenerWrappers.get(channel);
        const wrappers = channelListeners?.get(listener);
        if (!wrappers) return;
        const index = wrappers.indexOf(wrappedListener);
        if (index !== -1) wrappers.splice(index, 1);
        if (wrappers.length === 0) channelListeners.delete(listener);
        if (channelListeners.size === 0) listenerWrappers.delete(channel);
    };

    const addAuthorizedListener = (channel, listener, addListener, once = false) => {
        const wrappedListener = (event, ...args) => {
            // Main-process-only EventEmitter calls are not renderer IPC and keep
            // their existing behavior. Renderer events always have a sender.
            if (event?.sender && !isAuthorizedIpcEvent(event, 'send', channel, args)) {
                rejectUnauthorizedSend(event);
                return undefined;
            }
            if (once) {
                originalRemoveListener(channel, wrappedListener);
                forgetWrappedListener(channel, listener, wrappedListener);
            }
            try {
                const result = listener(event, ...args);
                if (event?.sender && result && typeof result.then === 'function') {
                    Promise.resolve(result).catch(error => reportRendererIpcListenerError(channel, error));
                }
                return result;
            } catch (error) {
                if (!event?.sender) throw error;
                reportRendererIpcListenerError(channel, error);
                return undefined;
            }
        };
        let channelListeners = listenerWrappers.get(channel);
        if (!channelListeners) {
            channelListeners = new Map();
            listenerWrappers.set(channel, channelListeners);
        }
        const wrappers = channelListeners.get(listener) || [];
        wrappers.push(wrappedListener);
        channelListeners.set(listener, wrappers);
        addListener(channel, wrappedListener);
        return ipcMain;
    };

    ipcMain.on = (channel, listener) => addAuthorizedListener(channel, listener, originalOn);
    ipcMain.addListener = ipcMain.on;
    ipcMain.prependListener = (channel, listener) => (
        addAuthorizedListener(channel, listener, originalPrependListener)
    );
    ipcMain.once = (channel, listener) => addAuthorizedListener(channel, listener, originalOn, true);
    ipcMain.prependOnceListener = (channel, listener) => (
        addAuthorizedListener(channel, listener, originalPrependListener, true)
    );

    ipcMain.removeListener = (channel, listener) => {
        const channelListeners = listenerWrappers.get(channel);
        const wrappers = channelListeners?.get(listener);
        if (!wrappers?.length) {
            originalRemoveListener(channel, listener);
            return ipcMain;
        }
        for (const wrapper of wrappers) originalRemoveListener(channel, wrapper);
        channelListeners.delete(listener);
        if (channelListeners.size === 0) listenerWrappers.delete(channel);
        return ipcMain;
    };
    ipcMain.off = ipcMain.removeListener;

    ipcMain.removeAllListeners = (channel) => {
        if (channel == null) {
            listenerWrappers.clear();
            originalRemoveAllListeners();
        } else {
            listenerWrappers.delete(channel);
            originalRemoveAllListeners(channel);
        }
        return ipcMain;
    };

    Object.defineProperty(ipcMain, INSTALL_MARKER, { value: true });
}

module.exports = {
    areAuthorizedIpcArguments,
    filterSettingsForRole,
    getAuthorizedSenderRole,
    installIpcAuthorization,
    isAuthorizedIpcEvent,
    isExpectedRoleUrl,
    registerRendererWebContents,
    registerRendererWindow
};
