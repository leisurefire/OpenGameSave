const ROLE_FILES = Object.freeze({
    main: 'index.html',
    settings: 'settings.html',
    about: 'about.html',
    menu: 'menu.html',
    export: 'modal.html',
    import: 'modal.html',
    account: 'modal.html',
    'auto-backup': 'modal.html',
    'manage-backups': 'modal.html',
    'local-save': 'modal.html',
    'scan-full': 'modal.html',
    confirm: 'modal.html',
    dialog: 'modal.html'
});

const RENDERER_ROLE_ARGUMENT_PREFIX = '--ogs-window-role=';

const THEME_INVOKE = ['get-window-accent-color'];
const THEME_RECEIVE = ['accent-color-changed'];
const MODAL_SEND = ['close-current-modal-window', 'resize-current-modal-window'];
const MODAL_INVOKE = ['translate', 'get-modal-window-data'];

function createCapabilities({ send = [], invoke = [], receive = [] }) {
    return Object.freeze({
        send: Object.freeze([...send]),
        invoke: Object.freeze([...THEME_INVOKE, ...invoke]),
        receive: Object.freeze([...THEME_RECEIVE, ...receive])
    });
}

function createModalCapabilities({ send = [], invoke = [], receive = [] } = {}) {
    return createCapabilities({
        send: [...MODAL_SEND, ...send],
        invoke: [...MODAL_INVOKE, ...invoke],
        receive
    });
}

const ROLE_CAPABILITIES = Object.freeze({
    main: createCapabilities({
        send: [
            'hide-popup-menu',
            'show-popup-menu',
            'save-settings',
            'update-status',
            'open-settings-window',
            'open-about-window',
            'open-modal-window',
            'view-account-ids',
            'scan-full',
            'selected-wiki-ids-response'
        ],
        invoke: [
            'translate',
            'save-settings',
            'get-settings',
            'open-url',
            'open-backup-dialog',
            'open-directory',
            'get-icon-map',
            'get-library-games',
            'get-library-game-art',
            'get-game-guide-catalog',
            'search-game-guides',
            'get-game-guide',
            'launch-library-game',
            'open-library-game-directory',
            'get-table-view-model',
            'fetch-backup-table-data',
            'backup-game',
            'fetch-restore-table-data',
            'restore-game',
            'get-status',
            'get-app-update-state',
            'download-app-update',
            'update-database',
            'sync-provider-list',
            'sync-provider-config',
            'sync-provider-save-config',
            'sync-provider-status',
            'sync-provider-run',
            'start-scan-full',
            'get-auto-backup-state',
            'migrate-backups',
            'show-dialog-modal-window'
        ],
        receive: [
            'menu-hidden',
            'execute-menu-action',
            'open-import-modal',
            'show-alert',
            'run-scan-full',
            'update-backup-table',
            'update-restore-table',
            'collect-selected-wiki-ids',
            'update-progress',
            'apply-language',
            'sidebar-visibility-changed',
            'auto-backup-started',
            'auto-backup-stopped',
            'auto-backup-performed',
            'app-update-state'
        ]
    }),
    settings: createCapabilities({
        send: ['apply-accent-color-setting', 'update-backup-table', 'update-restore-table'],
        invoke: [
            'translate',
            'change-language',
            'save-settings',
            'get-settings',
            'get-detected-game-paths',
            'open-dialog',
            'get-status',
            'update-database',
            'show-dialog-modal-window'
        ],
        receive: ['apply-language', 'show-alert', 'update-progress']
    }),
    about: createCapabilities({
        invoke: [
            'translate',
            'open-url',
            'get-current-version',
            'download-app-update',
            'get-repository-url',
            'get-latest-version',
            'is-newer-version'
        ],
        receive: ['apply-language']
    }),
    menu: createCapabilities({
        send: ['resize-and-show-menu', 'menu-item-click'],
        receive: ['set-menu-items']
    }),
    export: createModalCapabilities({
        send: ['save-settings', 'export-backups'],
        invoke: ['get-settings', 'select-path', 'get-main-selected-wiki-ids', 'get-status']
    }),
    import: createModalCapabilities({
        send: ['import-backups'],
        invoke: ['select-path', 'get-status']
    }),
    account: createModalCapabilities({
        send: ['show-main-alert', 'update-backup-table'],
        invoke: ['get-account-data', 'get-settings', 'save-settings']
    }),
    'auto-backup': createModalCapabilities({
        send: ['show-main-alert'],
        invoke: [
            'get-settings',
            'fetch-backup-table-data',
            'fetch-restore-table-data',
            'get-auto-backup-state',
            'start-auto-backup',
            'stop-auto-backup'
        ]
    }),
    'manage-backups': createModalCapabilities({
        send: [
            'show-main-alert',
            'update-backup-table',
            'update-restore-table',
            'open-backup-folder',
            'update-status'
        ],
        invoke: [
            'get-settings',
            'fetch-backup-table-data',
            'fetch-restore-table-data',
            'delete-backup',
            'update-backup-info',
            'restore-game',
            'get-status',
            'show-confirm-modal-window'
        ]
    }),
    'local-save': createModalCapabilities({
        send: [
            'show-main-alert',
            'update-backup-table',
            'update-restore-table',
            'browse-local-save'
        ],
        invoke: ['get-settings', 'get-local-save-data', 'delete-local-save', 'show-confirm-modal-window']
    }),
    'scan-full': createModalCapabilities({
        send: ['run-scan-full'],
        invoke: ['get-status']
    }),
    confirm: createModalCapabilities({
        send: ['modal-window-confirm-response']
    }),
    dialog: createModalCapabilities({
        send: ['modal-window-dialog-response']
    })
});

const EMPTY_CAPABILITIES = Object.freeze({
    send: Object.freeze([]),
    invoke: Object.freeze([]),
    receive: Object.freeze([])
});

function getRoleCapabilities(role) {
    return ROLE_CAPABILITIES[role] || EMPTY_CAPABILITIES;
}

function isRoleAllowed(role, direction, channel) {
    const channels = getRoleCapabilities(role)[direction];
    return Array.isArray(channels) && channels.includes(channel);
}

module.exports = {
    RENDERER_ROLE_ARGUMENT_PREFIX,
    ROLE_CAPABILITIES,
    ROLE_FILES,
    getRoleCapabilities,
    isRoleAllowed
};
