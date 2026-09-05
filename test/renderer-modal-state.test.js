const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function element() {
    return {
        value: '', checked: false, disabled: false, dataset: {}, innerHTML: '', children: [], listeners: {},
        classList: { add() {}, remove() {}, replace() {}, contains: () => false },
        addEventListener(name, listener) { this.listeners[name] = listener; },
        setAttribute(name, value) { this[name] = value; },
        removeAttribute(name) { delete this[name]; },
        appendChild(child) { this.children.push(child); },
        setColumns() {}, appendRows() {}, contains: () => true
    };
}

function loadModal({ rejectStart = false } = {}) {
    const controls = new Map();
    const get = id => {
        if (!controls.has(id)) controls.set(id, element());
        return controls.get(id);
    };
    const root = get('modal-root');
    root.querySelectorAll = () => [];
    root.querySelector = selector => selector.startsWith('#') ? get(selector.slice(1)) : get('selected-mode');
    const alerts = [];
    const sent = [];
    const invoked = [];
    const window = {
        api: {
            invoke: async (channel, ...args) => {
                invoked.push([channel, ...args]);
                if (channel === 'get-settings') return { language: 'en_US', maxBackups: 10 };
                if (channel === 'fetch-backup-table-data') return [{ title: 'Game', wiki_page_id: '1' }];
                if (channel === 'fetch-restore-table-data') return [];
                if (channel === 'get-auto-backup-state') return {};
                if (channel === 'start-auto-backup' && rejectStart) throw new Error('busy');
                if (channel === 'get-modal-window-data') return { modalType: 'missing' };
            },
            send: (...args) => { sent.push(args); }
        },
        i18n: { translate: async key => `translated:${key}` }
    };
    const context = vm.createContext({
        window,
        document: {
            getElementById: get, querySelector: () => get('export-scope'),
            addEventListener() {}, createElement: element
        },
        console: { error() {} },
        operationStartCheck: async () => true,
        showAlert: async (...args) => { alerts.push(args); },
        updateTranslations: async () => {}, wrapNumberInput() {}, autoResizeWindow() {},
        createLoadingIndicator: text => text, formatSize: String, formatBackupDate: String,
        getLocalSaveOpenIconRole: () => 'openDirectory'
    });
    const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/modalWindowPage.js'), 'utf8')
        .replace(/^import .*;\r?\n/gm, '');
    vm.runInContext(source, context);
    return { context, root, get, alerts, sent, invoked };
}

test('import and export keep the dialog open and explain an empty path', async () => {
    for (const kind of ['Import', 'Export']) {
        const { context, root, get, alerts, sent } = loadModal();
        get('export-scope').value = 'all';
        await context[`render${kind}Modal`](root, {});
        await get(`modal-${kind.toLowerCase()}-confirm`).listeners.click();
        assert.equal(alerts[0][0], 'warning');
        assert.equal(alerts[0][1], `translated:alert.empty_${kind.toLowerCase()}_path`);
        assert.deepEqual(sent, []);
    }
});

test('the backup manager announces its empty state and disables the missing-folder action', async () => {
    const { context, root, get } = loadModal();
    await context.renderManageBackupsModal(root, { wikiId: '1' });
    assert.equal(get('modal-open-backup-folder').disabled, true);
    const emptyState = get('manage-backups-table-container').children.at(-1);
    assert.equal(emptyState.textContent, 'translated:main.no_backups');
    assert.equal(emptyState.role, 'status');
});

test('automatic backup rejects out-of-range input and releases the busy control', async () => {
    const { context, root, get, alerts, invoked, sent } = loadModal();
    await context.renderAutoBackupModal(root, { wikiId: '1' });
    get('selected-mode').value = 'interval';
    get('auto-backup-interval').value = '1441';
    const button = get('modal-auto-backup-confirm');
    await button.listeners.click({ currentTarget: button });
    assert.equal(button.disabled, false);
    assert.deepEqual(alerts, [['warning', 'translated:alert.invalid_auto_backup_interval']]);
    assert.equal(invoked.some(([channel]) => channel === 'start-auto-backup'), false);
    assert.deepEqual(sent, []);
});

test('automatic backup failures leave the dialog usable and report a localized error', async () => {
    const { context, root, get, alerts, sent } = loadModal({ rejectStart: true });
    await context.renderAutoBackupModal(root, { wikiId: '1' });
    get('selected-mode').value = 'interval';
    get('auto-backup-interval').value = '30';
    const button = get('modal-auto-backup-confirm');
    await button.listeners.click({ currentTarget: button });
    assert.equal(button.disabled, false);
    assert.deepEqual(alerts, [['error', 'translated:alert.auto_backup_change_failed']]);
    assert.deepEqual(sent, []);
});

test('unsupported modal types display a localized accessible error state', async () => {
    const { context, root } = loadModal();
    await context.initModalWindowPage();
    assert.match(root.innerHTML, /role="alert"/);
    assert.match(root.innerHTML, /translated:alert.modal_unavailable/);
    assert.doesNotMatch(root.innerHTML, /Unknown modal/);
});
