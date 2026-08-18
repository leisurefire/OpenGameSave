const { contextBridge, ipcRenderer } = require('electron');

const DEFAULT_ACCENT_COLOR = '#16c60c';

// ===== 安全增强：IPC 信道白名单 =====
const ALLOWED_SEND = new Set([
    'hide-popup-menu',
    'show-popup-menu',
    'resize-and-show-menu',
    'menu-item-click',
    'apply-accent-color-setting',
    'save-settings',
    'update-backup-table',
    'update-restore-table',
    'run-scan-full',
    'open-backup-folder',
    'browse-local-save',
    'update-status',
    'export-backups',
    'import-backups',
    'update-app',
    'open-settings-window',
    'open-about-window',
    'open-modal-window',
    'close-current-modal-window',
    'resize-current-modal-window',
    'show-main-alert',
    'view-account-ids',
    'scan-full',
    'modal-window-confirm-response',
    'modal-window-dialog-response',
    'selected-wiki-ids-response',
    'restore-conflict-response'
]);

const ALLOWED_INVOKE = new Set([
    'translate',
    'change-language',
    'save-settings',
    'get-settings',
    'set-experimental-xgp-source',
    'get-detected-game-paths',
    'open-url',
    'open-backup-dialog',
    'open-directory',
    'open-dialog',
    'select-path',
    'get-account-data',
    'get-platform',
    'get-icon-map',
    'get-table-view-model',
    'get-local-save-data',
    'fetch-backup-table-data',
    'get-main-selected-wiki-ids',
    'backup-game',
    'fetch-restore-table-data',
    'restore-game',
    'delete-backup',
    'update-backup-info',
    'delete-local-save',
    'get-status',
    'get-current-version',
    'get-app-update-state',
    'check-app-update',
    'download-app-update',
    'get-repository-url',
    'get-latest-version',
    'is-newer-version',
    'update-database',
    'sync-provider-list',
    'sync-provider-config',
    'sync-provider-save-config',
    'sync-provider-status',
    'sync-provider-run',
    'start-scan-full',
    'start-auto-backup',
    'stop-auto-backup',
    'get-auto-backup-state',
    'get-accent-color',
    'migrate-backups',
    'show-confirm-modal-window',
    'show-dialog-modal-window',
    'get-modal-window-data'
]);

const ALLOWED_RECEIVE = new Set([
    'accent-color-changed',
    'menu-hidden',
    'set-menu-items',
    'execute-menu-action',
    'open-import-modal',
    'show-alert',
    'run-scan-full',
    'update-backup-table',
    'update-restore-table',
    'collect-selected-wiki-ids',
    'update-progress',
    'apply-language',
    'auto-backup-started',
    'auto-backup-stopped',
    'auto-backup-performed',
    'restore-conflict-prompt',
    'app-update-state'
]);

function setAccentColor(color) {
    if (document.documentElement && /^#[0-9a-f]{6}$/i.test(color)) {
        document.documentElement.style.setProperty('--system-accent', color);
    }
}

async function applyAccentColor() {
    const settings = await ipcRenderer.invoke('get-settings');
    if (settings && settings.syncAccentColor) {
        const color = await ipcRenderer.invoke('get-accent-color');
        setAccentColor(color);
    } else {
        setAccentColor(DEFAULT_ACCENT_COLOR);
    }
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

ipcRenderer.on('accent-color-changed', (event, color) => {
    setAccentColor(color);
});

contextBridge.exposeInMainWorld('api', {
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
        if (!ALLOWED_INVOKE.has(channel)) {
            throw new Error(`Blocked IPC invoke channel: ${channel}`);
        }
        return ipcRenderer.invoke(channel, ...args);
    }
});

contextBridge.exposeInMainWorld('i18n', {
    changeLanguage: (lng) => ipcRenderer.invoke('change-language', lng),
    translate: (key, options) => ipcRenderer.invoke('translate', key, options)
});
