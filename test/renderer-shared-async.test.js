const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function deferred() {
    let resolve, reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function element(attributes = {}) {
    const values = new Map(Object.entries(attributes));
    const classes = new Set();
    return {
        dataset: {},
        children: [],
        isConnected: true,
        style: { setProperty() {} },
        getAttribute: name => values.get(name) ?? null,
        setAttribute: (name, value) => { values.set(name, String(value)); },
        classList: {
            contains: name => classes.has(name),
            toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }
        },
        querySelector: () => null,
        addEventListener() {},
        focus() { this.focused = true; }
    };
}

function loadUtility(overrides = {}) {
    const received = new Map();
    const listeners = new Map();
    const sent = [];
    const translations = [];
    const window = {
        api: {
            can: () => true,
            receive: (channel, callback) => received.set(channel, callback),
            send: (...args) => sent.push(args)
        },
        i18n: { translate(key) {
            const request = { key, ...deferred() };
            translations.push(request);
            return request.promise;
        } }
    };
    const document = {
        addEventListener: (name, callback) => listeners.set(name, callback),
        getElementById: () => null,
        querySelectorAll: () => []
    };
    const context = vm.createContext({ console, window, document, renderIcon() {}, ...overrides });
    const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/utility.js'), 'utf8')
        .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(source, context);
    return { context, received, listeners, sent, translations, window, document };
}

test('shared translations retain the latest language across text and accessible attributes', async () => {
    const harness = loadUtility();
    const target = element({
        'data-i18n': 'label',
        'data-i18n-placeholder': 'placeholder',
        'data-i18n-title': 'title',
        'data-i18n-aria-label': 'accessible',
        'data-i18n-alt': 'alternative'
    });
    const root = {
        documentElement: {},
        querySelectorAll: () => [target]
    };
    const first = harness.context.updateTranslations(root);
    const second = harness.context.updateTranslations(root);
    const requestsPerRender = harness.translations.length / 2;
    harness.translations.slice(requestsPerRender).forEach(request => {
        request.resolve(request.key === 'meta.locale' ? 'en-US' : `new:${request.key}`);
    });
    await second;
    harness.translations.slice(0, requestsPerRender).forEach(request => {
        request.resolve(request.key === 'meta.locale' ? 'zh-CN' : `old:${request.key}`);
    });
    await first;
    assert.equal(root.documentElement.lang, 'en-US');
    assert.equal(target.innerText, 'new:label');
    assert.equal(target.getAttribute('placeholder'), 'new:placeholder');
    assert.equal(target.getAttribute('title'), 'new:title');
    assert.equal(target.getAttribute('aria-label'), 'new:accessible');
    assert.equal(target.getAttribute('alt'), 'new:alternative');

    const third = harness.context.updateTranslations(root);
    target.setAttribute('data-i18n', 'busy');
    target.innerText = 'current action';
    harness.translations.slice(requestsPerRender * 2).forEach(request => request.resolve('obsolete'));
    await third;
    assert.equal(target.innerText, 'current action', 'a changed action key invalidates the old translation');
});

test('application update progress applies immediately and ignores stale labels and initial snapshots', async () => {
    const harness = loadUtility();
    const button = element();
    const icon = element();
    harness.document.getElementById = id => id === 'app-update-download' ? button : icon;
    const snapshot = deferred();
    harness.window.api.invoke = () => snapshot.promise;
    harness.context.setupAppUpdateButton();
    const available = harness.context.applyAppUpdateState({ canAutoUpdate: true, availableVersion: '1.0', status: 'available' });
    const downloading = harness.context.applyAppUpdateState({ canAutoUpdate: true, availableVersion: '1.0', status: 'downloading', percent: 42 });
    assert.equal(button.disabled, true, 'progress must disable the button before the label IPC returns');
    assert.equal(button.dataset.state, 'downloading');
    harness.translations[1].resolve('Downloading 42%');
    await downloading;
    harness.translations[0].resolve('Download 1.0');
    await available;
    snapshot.resolve({ canAutoUpdate: true, availableVersion: '0.9', status: 'available' });
    await new Promise(resolve => { setImmediate(resolve); });
    assert.equal(harness.translations.length, 2, 'late initial state cannot overwrite a progress event');
    assert.equal(button.disabled, true);
    assert.equal(button.title, 'Downloading 42%');
    assert.equal(button.getAttribute('aria-label'), 'Downloading 42%');
});

test('popup preparation respects newer triggers, dismissal, detached rows and hidden request identities', async () => {
    const harness = loadUtility();
    const firstButton = element();
    const secondButton = element();
    const firstPayload = deferred();
    const secondPayload = deferred();
    const first = harness.context.requestPopupMenu(firstButton, () => firstPayload.promise);
    const second = harness.context.requestPopupMenu(secondButton, () => secondPayload.promise);
    secondPayload.resolve({ items: ['new'] });
    await second;
    firstPayload.resolve({ items: ['old'] });
    await first;
    const shown = harness.sent.filter(([channel]) => channel === 'show-popup-menu');
    assert.equal(shown.length, 1);
    assert.deepEqual(shown[0][1].items, ['new']);
    const token = shown[0][1].rendererRequestId;
    harness.received.get('menu-hidden')({ rendererRequestId: token - 1, restoreFocus: true });
    assert.equal(harness.window.activeMenuTrigger, secondButton);
    assert.equal(secondButton.focused, undefined);
    harness.received.get('menu-hidden')({ rendererRequestId: token, restoreFocus: true });
    assert.equal(harness.window.activeMenuTrigger, null);
    assert.equal(secondButton.focused, true);

    const cancelledPayload = deferred();
    const cancelled = harness.context.requestPopupMenu(firstButton, () => cancelledPayload.promise);
    await harness.context.requestPopupMenu(firstButton, () => { throw new Error('must not run'); });
    cancelledPayload.resolve({ items: ['cancelled'] });
    await cancelled;
    assert.equal(harness.sent.filter(([channel]) => channel === 'show-popup-menu').length, 1);

    const dismissedPayload = deferred();
    const dismissed = harness.context.requestPopupMenu(secondButton, () => dismissedPayload.promise);
    harness.listeners.get('click')({ target: { closest: () => null } });
    dismissedPayload.resolve({ items: ['dismissed'] });
    await dismissed;
    assert.equal(harness.window.activeMenuTrigger, null);
    assert.equal(harness.sent.filter(([channel]) => channel === 'show-popup-menu').length, 1);

    const detachedPayload = deferred();
    const detached = harness.context.requestPopupMenu(firstButton, () => detachedPayload.promise);
    firstButton.isConnected = false;
    detachedPayload.resolve({ items: ['detached'] });
    await detached;
    assert.equal(harness.window.activeMenuTrigger, null);
    assert.equal(harness.sent.filter(([channel]) => channel === 'show-popup-menu').length, 1);
});

test('action button labels cannot revert to an earlier busy state', async () => {
    const pending = [];
    const context = vm.createContext({
        renderIcon() {},
        window: { i18n: { translate() {
            const translation = deferred();
            pending.push(translation);
            return translation.promise;
        } } }
    });
    const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/tableUi.js'), 'utf8')
        .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(source, context);
    const controls = { button: element(), icon: element(), text: element(), iconName: 'download' };
    const busy = context.setActionButtonState({ ...controls, i18nKey: 'busy', busy: true });
    const ready = context.setActionButtonState({ ...controls, i18nKey: 'ready', busy: false });
    pending[1].resolve('Ready');
    await ready;
    pending[0].resolve('Busy');
    await busy;
    assert.equal(controls.button.disabled, false);
    assert.equal(controls.text.textContent, 'Ready');
});
