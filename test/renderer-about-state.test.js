const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createElement() {
    const classes = new Set();
    return {
        dataset: {}, innerText: '', textContent: '', disabled: false, listeners: {},
        classList: {
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            contains: name => classes.has(name),
            toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
        },
        setAttribute(name, value) { this.dataset[name] = value; if (name === 'data-i18n') this.dataset.i18n = value; },
        removeAttribute(name) { delete this.dataset[name]; if (name === 'data-i18n') delete this.dataset.i18n; },
        addEventListener(name, listener) { this.listeners[name] = listener; }
    };
}

async function loadAbout({ latestVersion = '2.0.0', updateResult = { status: 'up-to-date' } } = {}) {
    const ids = ['latest-version', 'current-version', 'github-link', 'author-link', 'update-button', 'app-license-link', 'notices-toggle', 'about-notices'];
    const elements = Object.fromEntries(ids.map(id => [id, createElement()]));
    elements['latest-version'].dataset.i18n = 'main.loading';
    let language = 'en';
    let ready;
    let applyLanguage;
    const alerts = [];
    const document = {
        body: { style: { visibility: 'hidden' } },
        getElementById: id => elements[id],
        querySelectorAll: () => [],
        addEventListener: (event, listener) => { ready = listener; }
    };
    const window = {
        api: {
            receive: (event, listener) => { applyLanguage = listener; },
            invoke: async (channel) => {
                if (channel === 'get-current-version') return '1.0.0';
                if (channel === 'get-latest-version') {
                    if (latestVersion instanceof Error) throw latestVersion;
                    return latestVersion;
                }
                if (channel === 'is-newer-version') return true;
                if (channel === 'download-app-update') return updateResult;
            }
        },
        i18n: { translate: async key => `${language}:${key}` }
    };
    const context = vm.createContext({
        document, window, console: { error() {} },
        showAlert: async (...args) => { alerts.push(args); },
        updateTranslations: async () => {
            for (const element of Object.values(elements)) {
                if (element.dataset.i18n) element.innerText = await window.i18n.translate(element.dataset.i18n);
            }
        }
    });
    const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/aboutPage.js'), 'utf8').replace(/^import .*;\r?\n/gm, '');
    vm.runInContext(source, context);
    await ready();
    await new Promise(resolve => { setImmediate(resolve); });
    return { elements, alerts, document, changeLanguage: async () => { language = 'zh'; await applyLanguage(); } };
}

test('about version values survive language changes and available updates are not errors', async () => {
    const { elements, changeLanguage, document } = await loadAbout();
    assert.equal(elements['latest-version'].innerText, '2.0.0');
    assert.equal(elements['current-version'].classList.contains('version-status-error'), false);
    await changeLanguage();
    assert.equal(elements['latest-version'].innerText, '2.0.0');
    assert.equal(document.body.style.visibility, 'visible');
});

test('about version lookup errors replace loading state with a translatable failure', async () => {
    const { elements, changeLanguage } = await loadAbout({ latestVersion: new Error('network offline') });
    assert.equal(elements['latest-version'].innerText, 'en:about.load_failed');
    assert.equal(elements['latest-version'].classList.contains('version-status-error'), true);
    await changeLanguage();
    assert.equal(elements['latest-version'].innerText, 'zh:about.load_failed');
});

test('about update controls leave busy state when an update cannot start', async () => {
    const { elements, alerts } = await loadAbout({ updateResult: { status: 'error', error: 'app-busy' } });
    const button = elements['update-button'];
    await button.listeners.click();
    assert.equal(button.disabled, false);
    assert.equal(button.dataset.i18n, 'about.update');
    assert.deepEqual(alerts, [['error', 'en:settings.app_update_busy']]);
});
