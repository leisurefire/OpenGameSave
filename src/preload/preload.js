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
  'migrate-backups',
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
  'get-settings',
  'get-detected-game-paths',
  'open-url',
  'open-backup-dialog',
  'open-directory',
  'open-dialog',
  'select-path',
  'sort-games',
  'get-account-data',
  'get-platform',
  'get-uuid',
  'get-icon-map',
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
  'get-repository-url',
  'get-latest-version',
  'update-database',
  'github-sync-status',
  'github-sync-upload',
  'github-sync-download',
  'start-scan-full',
  'start-auto-backup',
  'stop-auto-backup',
  'get-auto-backup-state',
  'get-accent-color',
  'show-confirm-modal-window',
  'show-dialog-modal-window',
  'get-modal-window-data'
]);

const ALLOWED_RECEIVE = new Set([
  'accent-color-changed',
  'menu-hidden',
  'set-menu-items',
  'execute-menu-action',
  'open-export-modal',
  'open-import-modal',
  'show-alert',
  'run-scan-full',
  'update-backup-table',
  'update-restore-table',
  'collect-selected-wiki-ids',
  'update-progress',
  'apply-language',
  'view_account_ids',
  'auto-backup-started',
  'auto-backup-stopped',
  'auto-backup-performed',
  'restore-conflict-prompt'
]);

function setAccentColor(color) {
  if (document.documentElement) {
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
const _earlyColorPromise = applyAccentColor();

// Re-apply once the DOM is ready in case the variable was set before
// the <html> element was available (edge case on very fast loads).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => _earlyColorPromise);
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
    return ipcRenderer.on(channel, (event, ...args) => func(...args));
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