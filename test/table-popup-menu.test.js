const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/tablePopupMenu.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/^export /gm, '');

function createHarness({
    tabName = 'backup',
    bounds = { top: 300, bottom: 334, right: 520 },
    viewportHeight = 900,
    hasMenuButton = true
} = {}) {
    const listeners = new Map();
    const requests = [];
    const invocations = [];
    const tab = { id: tabName };
    const row = {
        getAttribute: name => name === 'data-wiki-id' ? '123' : null,
        querySelector: selector => selector === '.dropdown-menu-button' && hasMenuButton ? button : null
    };
    const button = {
        closest: selector => selector === 'tr' ? row : selector === '#backup, #restore, #custom' ? tab : null,
        getBoundingClientRect: () => bounds
    };
    const cell = {
        closest: selector => selector === 'tr[data-wiki-id]' ? row : null
    };
    const icon = {
        closest: selector => selector === '.dropdown-menu-button' ? button : cell.closest(selector)
    };
    const outside = { closest: () => null };
    const context = vm.createContext({
        ACTION_ICONS: { manageLocalData: 'folder-open' },
        document: {
            addEventListener: (name, callback) => { listeners.set(name, callback); },
            querySelector: () => null
        },
        window: {
            innerHeight: viewportHeight,
            api: {
                invoke: async channel => {
                    invocations.push(channel);
                    return { pinnedGames: [], blockedGames: [] };
                }
            },
            i18n: { translate: async key => key }
        },
        requestPopupMenu: (trigger, buildPayload, options) => {
            const request = { trigger, options };
            request.pending = Promise.resolve().then(buildPayload).then(payload => { request.payload = payload; });
            requests.push(request);
            return request.pending;
        }
    });
    vm.runInContext(source, context);
    context.setDropDownAction();

    const dispatch = async (type, target, clientX = 0, clientY = 0) => {
        const event = {
            type, target, clientX, clientY,
            defaultPrevented: false,
            propagationStopped: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.propagationStopped = true; }
        };
        assert.equal(typeof listeners.get(type), 'function', `${type} listener is registered`);
        listeners.get(type)(event);
        await Promise.all(requests.map(request => request.pending));
        return event;
    };
    return { dispatch, requests, invocations, button, cell, icon, outside };
}

test('row context menus use the native popup request at pointer coordinates without toggling', async () => {
    for (const [x, y] of [[210, 330], [0, 330], [210, 0]]) {
        const harness = createHarness();
        const event = await harness.dispatch('contextmenu', harness.cell, x, y);
        assert.equal(event.defaultPrevented, true);
        assert.equal(event.propagationStopped, true);
        assert.equal(harness.requests.length, 1);
        const request = harness.requests[0];
        assert.equal(request.trigger, harness.button);
        assert.equal(request.options.toggle, false);
        assert.equal(request.payload.x, x);
        assert.equal(request.payload.y, y);
        assert.equal(request.payload.direction, 'down');
        assert.deepEqual(harness.invocations, ['get-settings']);
        assert.equal(request.payload.items.find(item => item.action === 'manage-backups').data, '123');
    }
});

test('keyboard context menus use button bounds and choose a direction that fits the viewport', async () => {
    for (const [viewportHeight, expectedY, direction] of [[900, 338, 'down'], [480, 296, 'up']]) {
        const harness = createHarness({ viewportHeight });
        const event = await harness.dispatch('contextmenu', harness.cell);
        assert.equal(event.defaultPrevented, true);
        const request = harness.requests[0];
        assert.equal(request.trigger, harness.button);
        assert.equal(request.options.toggle, false);
        assert.equal(request.payload.x, 524);
        assert.equal(request.payload.y, expectedY);
        assert.equal(request.payload.direction, direction);
    }
});

test('more-button clicks preserve native popup toggling and anchor to the button', async () => {
    const harness = createHarness();
    for (let click = 0; click < 2; click += 1) {
        const event = await harness.dispatch('click', harness.icon, 100, 150);
        assert.equal(event.defaultPrevented, false);
        assert.equal(event.propagationStopped, true);
        const request = harness.requests[click];
        assert.equal(request.trigger, harness.button);
        assert.equal(request.options.toggle, true);
        assert.equal(request.payload.x, 524);
        assert.equal(request.payload.y, 338);
        assert.equal(request.payload.direction, 'down');
    }
    assert.equal(harness.requests.length, 2);
});

test('restore row menus omit automatic backup while backup and custom rows retain it', async () => {
    for (const tabName of ['restore', 'backup', 'custom']) {
        const harness = createHarness({ tabName });
        await harness.dispatch('contextmenu', harness.cell, 140, 280);
        const items = harness.requests[0].payload.items;
        assert.equal(items.some(item => item.action === 'auto-backup'), tabName !== 'restore');
        assert.equal(items.some(item => item.action === 'manage-backups'), true);
        assert.equal(items.some(item => item.action === 'manage-local-data'), true);
    }
});

test('context menus outside actionable table rows leave the browser event untouched', async () => {
    for (const hasMenuButton of [true, false]) {
        const harness = createHarness({ hasMenuButton });
        const target = hasMenuButton ? harness.outside : harness.cell;
        const event = await harness.dispatch('contextmenu', target, 140, 280);
        assert.equal(event.defaultPrevented, false);
        assert.equal(event.propagationStopped, false);
        assert.equal(harness.requests.length, 0);
        assert.equal(harness.invocations.length, 0);
    }
});

test('ordinary row clicks leave selection handling untouched', async () => {
    const harness = createHarness();
    const event = await harness.dispatch('click', harness.cell, 140, 280);
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.propagationStopped, false);
    assert.equal(harness.requests.length, 0);
});
