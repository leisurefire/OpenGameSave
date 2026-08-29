const { contextBridge, ipcRenderer } = require('electron');

const {
    RENDERER_ROLE_ARGUMENT_PREFIX,
    ROLE_FILES,
    getRoleCapabilities
} = require('../shared/ipcPolicy');

const DEFAULT_ACCENT_COLOR = '#16c60c';

function getRegisteredRendererRole() {
    const roleArguments = process.argv.filter(argument => argument.startsWith(RENDERER_ROLE_ARGUMENT_PREFIX));
    if (roleArguments.length !== 1) return null;
    const role = roleArguments[0].slice(RENDERER_ROLE_ARGUMENT_PREFIX.length);
    const expectedFile = ROLE_FILES[role];
    if (!expectedFile) return null;
    try {
        const pageUrl = new URL(window.location.href);
        const actualFile = decodeURIComponent(pageUrl.pathname).split('/').pop();
        return pageUrl.protocol === 'file:' && actualFile === expectedFile ? role : null;
    } catch (error) {
        return null;
    }
}

const rendererRole = getRegisteredRendererRole();
const roleCapabilities = getRoleCapabilities(rendererRole);
const ALLOWED_SEND = new Set(roleCapabilities.send);
const ALLOWED_INVOKE = new Set(roleCapabilities.invoke);
const ALLOWED_RECEIVE = new Set(roleCapabilities.receive);

function invokeAuthorized(channel, ...args) {
    if (!ALLOWED_INVOKE.has(channel)) {
        throw new Error(`Blocked IPC invoke channel for renderer role "${rendererRole || 'unknown'}": ${channel}`);
    }
    return ipcRenderer.invoke(channel, ...args);
}

function setAccentColor(color) {
    if (document.documentElement && /^#[0-9a-f]{6}$/i.test(color)) {
        document.documentElement.style.setProperty('--system-accent', color);
    }
}

async function applyAccentColor() {
    if (!rendererRole) return setAccentColor(DEFAULT_ACCENT_COLOR);
    setAccentColor(await invokeAuthorized('get-window-accent-color'));
}

// Apply accent color as early as possible, before the window is shown,
// to prevent a flash of the wrong color on modal windows (e.g. settings)
// that are pre-loaded hidden and shown only after content is ready.
const _earlyColorPromise = applyAccentColor().catch((error) => {
    console.error('Failed to apply accent color:', error);
});

// Re-apply once the DOM is ready in case the variable was set before
// the <html> element was available (edge case on very fast loads).
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        void _earlyColorPromise.then(() => applyAccentColor()).catch((error) => {
            console.error('Failed to reapply accent color:', error);
        });
    }, { once: true });
}

if (ALLOWED_RECEIVE.has('accent-color-changed')) {
    ipcRenderer.on('accent-color-changed', (event, color) => {
        setAccentColor(color);
    });
}

contextBridge.exposeInMainWorld('api', {
    can: (direction, channel) => {
        if (direction === 'send') return ALLOWED_SEND.has(channel);
        if (direction === 'invoke') return ALLOWED_INVOKE.has(channel);
        if (direction === 'receive') return ALLOWED_RECEIVE.has(channel);
        return false;
    },
    send: (channel, ...args) => {
        if (!ALLOWED_SEND.has(channel)) {
            throw new Error(`Blocked IPC send channel: ${channel}`);
        }
        return ipcRenderer.send(channel, ...args);
    },
    receive: (channel, func) => {
        if (!ALLOWED_RECEIVE.has(channel)) {
            throw new Error(`Blocked IPC receive channel: ${channel}`);
        }
        if (typeof func !== 'function') {
            throw new TypeError('IPC receive callback must be a function');
        }
        const listener = (event, ...args) => func(...args);
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
    },
    invoke: (channel, ...args) => {
        return invokeAuthorized(channel, ...args);
    }
});

contextBridge.exposeInMainWorld('i18n', {
    changeLanguage: (lng) => invokeAuthorized('change-language', lng),
    translate: (key, options) => invokeAuthorized('translate', key, options)
});
