const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function readProjectFile(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('titlebar menus expose OpenGameSave workflows without the removed friends feature', () => {
    const indexHtml = readProjectFile('src/renderer/index.html');
    const utility = readProjectFile('src/renderer/js/utility.js');

    assert.doesNotMatch(indexHtml, /data-titlebar-menu="friends"/);
    assert.match(indexHtml, /img-src 'self' data: blob:;/);
    assert.doesNotMatch(indexHtml, /img-src[^;]*https:/);
    assert.match(utility, /item\('main\.view_account_ids'.*'view-account-ids'/);
    assert.match(utility, /item\('main\.import'.*'import'/);
    assert.match(utility, /item\('main\.export'.*'export'/);
    assert.match(utility, /item\('main\.scan_full'.*'scan-full'/);
    assert.match(indexHtml, /data-tauri-drag-region/);
    for (const control of ['window-minimize', 'window-maximize', 'window-close']) {
        assert.match(indexHtml, new RegExp(`id="${control}"[^>]*type="button"[^>]*aria-label=`));
    }
});

test('about notice toggle uses fixed-window scrolling rather than cumulative auto-resize', () => {
    const aboutPage = readProjectFile('src/renderer/js/aboutPage.js');
    const aboutCss = readProjectFile('src/renderer/css/about.css');

    assert.doesNotMatch(aboutPage, /autoResizeWindow/);
    assert.match(aboutCss, /height:\s*100vh/);
    assert.match(aboutCss, /overflow:\s*hidden auto/);
});

test('library artwork remains lazy, bounded, and renderer-network independent', () => {
    const indexHtml = readProjectFile('src/renderer/index.html');
    const libraryPage = readProjectFile('src/renderer/js/libraryPage.js');
    const artworkService = readProjectFile('src-tauri/src/library/artwork.rs');

    assert.match(libraryPage, /new IntersectionObserver/);
    assert.match(libraryPage, /ART_LOAD_CONCURRENCY = 2/);
    assert.match(libraryPage, /image\.loading = 'lazy'/);
    assert.match(libraryPage, /requestAnimationFrame/);
    assert.match(artworkService, /MAX_ART_BYTES:\s*u64\s*=\s*8 \* 1024 \* 1024/);
    assert.match(artworkService, /redirect\(reqwest::redirect::Policy::none\(\)\)/);
    assert.match(artworkService, /\.take\(max \+ 1\)/);
    assert.match(libraryPage, /Array\.isArray\(asset\.data\)/);
    assert.doesNotMatch(libraryPage, /\bfetch\(/);
    assert.match(indexHtml, /img-src 'self' data: blob:/);
    assert.doesNotMatch(indexHtml, /connect-src[^;]*https:/);
});

test('library scans run off the UI thread and actions resolve only registered game identities', () => {
    const libraryService = readProjectFile('src-tauri/src/library/mod.rs');
    const providers = readProjectFile('src-tauri/src/library/providers.rs');
    assert.match(libraryService, /spawn_blocking\(/);
    assert.match(libraryService, /Mutex<LibraryCache>/);
    assert.match(libraryService, /Game is not present in the scanned library/);
    assert.match(libraryService, /find_game\(&text\(first\)\)/);
    assert.match(providers, /executable\.starts_with\(base\)/);
    assert.match(providers, /\.spawn\(\)[\s\S]*?map_err/);
});

test('library and guide interactions expose keyboard and assistive-technology state', () => {
    const indexHtml = readProjectFile('src/renderer/index.html');
    const libraryPage = readProjectFile('src/renderer/js/libraryPage.js');
    const guidesPage = readProjectFile('src/renderer/js/guidesPage.js');
    const mainCss = readProjectFile('src/renderer/css/main.css');

    assert.match(indexHtml, /id="guides-search"[^>]*role="combobox"[^>]*aria-expanded="false"/);
    assert.match(indexHtml, /id="library-count"[^>]*aria-live="polite"/);
    assert.match(indexHtml, /data-library-view="grid"[^>]*aria-pressed="true"/);
    assert.match(libraryPage, /if \(event\.target !== card\) return;/);
    assert.match(libraryPage, /activeGameActions\.has\(actionKey\)/);
    assert.match(guidesPage, /\['ArrowDown', 'ArrowUp', 'Home', 'End'\]/);
    assert.match(guidesPage, /setSearchResultsExpanded/);
    assert.match(readProjectFile('src/renderer/css/common.css'), /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(mainCss, /@media \(forced-colors: active\)/);
    assert.match(mainCss, /\.guide-open-button:focus-visible/);
});

test('popup menus are keyboard operable and restore focus without stealing it after app switches', () => {
    const menuService = readProjectFile('src-tauri/src/windows.rs');
    const menuEntry = readProjectFile('src/renderer/menu.entry.js');
    const menuCss = readProjectFile('src/renderer/menu.css');
    const tablePopupMenu = readProjectFile('src/renderer/js/tablePopupMenu.js');
    const tableRows = readProjectFile('src/renderer/js/tableRows.js');
    const libraryPage = readProjectFile('src/renderer/js/libraryPage.js');
    const utility = readProjectFile('src/renderer/js/utility.js');

    assert.match(menuService, /WindowEvent::Focused\(false\)/);
    assert.match(menuService, /WindowEvent::Focused\(false\)[\s\S]*?hide_menu_matching\([^;]*false\)/);
    assert.match(menuService, /"restoreFocus"\s*:\s*restore_focus/);
    assert.match(menuService, /state\.translate\("meta\.locale",\s*Value::Null\)/);
    assert.match(menuService, /"requestId"/);
    assert.match(menuEntry, /document\.createElement\('button'\)/);
    assert.match(menuEntry, /setAttribute\('role', 'menuitem'\)/);
    assert.match(menuEntry, /\['ArrowDown', 'ArrowUp', 'Home', 'End'\]/);
    assert.match(menuEntry, /event\.key === 'Escape'/);
    assert.match(menuEntry, /document\.documentElement\.lang = locale/);
    assert.match(menuCss, /\.menu-item:focus-visible/);
    assert.match(tableRows, /aria-haspopup="menu" aria-expanded="false"/);
    assert.match(tablePopupMenu, /requestPopupMenu\(button,/);
    assert.match(utility, /button\.setAttribute\('aria-expanded', 'true'\)/);
    assert.match(libraryPage, /setAttribute\('aria-haspopup', 'menu'\)/);
    assert.match(utility, /state\.restoreFocus === true.*trigger\.focus\(\)/s);
});

test('scrollable popup menus reveal keyboard focus and include their scrollbar when sizing', async () => {
    const vm = require('node:vm');
    const source = readProjectFile('src/renderer/menu.entry.js').replace(/^import .*;\r?\n/gm, '');
    const document = { activeElement: null, body: {} };
    const revealed = [];
    const sentMessages = [];
    const items = Array.from({ length: 3 }, (_, index) => ({
        tabIndex: -1,
        focus() { document.activeElement = this; },
        scrollIntoView() { revealed.push(index); }
    }));
    const menu = {
        style: {},
        querySelectorAll: () => items,
        offsetWidth: 360,
        scrollWidth: 350,
        offsetHeight: 966
    };
    const context = vm.createContext({
        document,
        window: {
            innerHeight: 1000,
            getComputedStyle: () => ({ paddingTop: '16px', paddingRight: '16px', paddingBottom: '16px', paddingLeft: '16px' }),
            api: {
                receive() {},
                send: (...args) => sentMessages.push(args)
            }
        },
        requestAnimationFrame: () => { throw new Error('Hidden WebViews do not render animation frames'); },
        startRenderer: callback => callback(),
        menu
    });
    vm.runInContext(source, context);
    vm.runInContext('acceptingActions = true;', context);
    document.activeElement = items[0];
    vm.runInContext("handleMenuKeyDown({ key: 'End', currentTarget: menu, preventDefault() {} });", context);
    assert.equal(document.activeElement, items[2]);
    assert.deepEqual(revealed, [2]);
    assert.equal(items[2].tabIndex, 0);

    vm.runInContext("handleMenuKeyDown({ key: 'ArrowDown', currentTarget: menu, preventDefault() {} });", context);
    assert.equal(document.activeElement, items[0], 'ArrowDown wraps to the first enabled item');
    vm.runInContext("handleMenuKeyDown({ key: 'ArrowUp', currentTarget: menu, preventDefault() {} });", context);
    assert.equal(document.activeElement, items[2], 'ArrowUp wraps to the last enabled item');
    vm.runInContext("handleMenuKeyDown({ key: 'Home', currentTarget: menu, preventDefault() {} });", context);
    assert.equal(document.activeElement, items[0]);

    await vm.runInContext('measureAndShowMenu(menu, null);', context);
    assert.equal(sentMessages[0][0], 'resize-and-show-menu');
    assert.equal(sentMessages[0][1].width, 392);
    vm.runInContext("handleMenuKeyDown({ key: 'Escape', currentTarget: menu, preventDefault() {}, stopPropagation() {} });", context);
    assert.equal(sentMessages[1][0], 'resize-and-show-menu');
    assert.equal(sentMessages[1][1].dismiss, true);
    assert.equal(sentMessages[1][1].requestId, null);
});

test('hidden popup menus show without animation frames and disabled actions cannot fire', async () => {
    const vm = require('node:vm');
    const source = readProjectFile('src/renderer/menu.entry.js').replace(/^import .*;\r?\n/gm, '');
    const messages = [], children = [];
    let receive;
    const document = { body: {}, documentElement: {}, activeElement: null };
    const menu = { dataset: {}, style: {}, setAttribute() {}, offsetWidth: 180, scrollWidth: 176, offsetHeight: 76,
        querySelectorAll: () => children.filter(item => !item.disabled) };
    const wrapper = { replaceChildren() { children.length = 0; }, appendChild: item => children.push(item) };
    document.getElementById = id => id === 'menu' ? menu : wrapper;
    document.createElement = () => ({
        events: {}, setAttribute() {}, appendChild() {},
        addEventListener(name, handler) { this.events[name] = handler; },
        focus() { document.activeElement = this; }, scrollIntoView() {}
    });
    const context = vm.createContext({
        document,
        startRenderer: callback => callback(),
        requestAnimationFrame: () => { throw new Error('No frames while hidden'); },
        window: { innerHeight: 110, getComputedStyle: () => ({}), api: {
            receive: (_channel, callback) => { receive = callback; },
            send: (...args) => messages.push(args)
        } }
    });
    vm.runInContext(source, context);
    await receive({ requestId: 'menu-1', items: [{ label: 'Unavailable', disabled: true }, { label: 'Export', action: 'export' }] });
    assert.equal(messages[0][0], 'resize-and-show-menu');
    assert.equal(children[0].disabled, true);
    assert.equal(document.activeElement, children[1]);
    children[0].events.pointerenter();
    children[0].events.click();
    assert.equal(document.activeElement, children[1]);
    assert.equal(messages.length, 1);
    children[1].events.click();
    assert.equal(messages[1][0], 'menu-item-click');
    children[1].events.click();
    assert.equal(messages.length, 2, 'a reused menu submits each visible request only once');
});

test('a reused native menu ignores stale display acknowledgements and stale buttons', async () => {
    const vm = require('node:vm');
    const source = readProjectFile('src/renderer/menu.entry.js').replace(/^import .*;\r?\n/gm, '');
    const children = [], requests = [], acknowledgements = [];
    let receive;
    const document = { body: {}, documentElement: {}, activeElement: null };
    const menu = { dataset: {}, style: {}, setAttribute() {}, offsetWidth: 180, scrollWidth: 176, offsetHeight: 76, scrollTop: 80,
        querySelectorAll: () => children.filter(item => !item.disabled) };
    const wrapper = { replaceChildren() { children.length = 0; }, appendChild: item => children.push(item) };
    document.getElementById = id => id === 'menu' ? menu : wrapper;
    document.createElement = () => ({
        events: {}, setAttribute() {}, appendChild() {},
        addEventListener(name, handler) { this.events[name] = handler; },
        focus() { document.activeElement = this; }, scrollIntoView() {}
    });
    const context = vm.createContext({
        document, startRenderer: callback => callback(),
        window: { innerHeight: 110, getComputedStyle: () => ({}), api: {
            receive: (_channel, callback) => { receive = callback; },
            send: (...args) => {
                requests.push(args);
                if (args[0] === 'resize-and-show-menu') return new Promise(resolve => { acknowledgements.push(resolve); });
                return Promise.resolve();
            }
        } }
    });
    vm.runInContext(source, context);
    const first = receive({ requestId: 'first', items: [{ label: 'Old', action: 'old' }] });
    const oldButton = children[0];
    const second = receive({ requestId: 'second', items: [{ label: 'New', action: 'new' }] });
    assert.equal(menu.scrollTop, 0);
    acknowledgements[0]();
    await first;
    assert.equal(document.activeElement, null, 'old native acknowledgements must not focus the new payload');
    assert.equal(menu.style.maxHeight, '', 'old acknowledgements must not constrain the next display');
    oldButton.events.click();
    assert.equal(requests.length, 2);
    acknowledgements[1]();
    await second;
    assert.equal(document.activeElement, children[0]);
    children[0].events.click();
    assert.deepEqual(requests[2], ['menu-item-click', 'new', undefined, 'second']);
});

test('native monitor height clamps leave menus scrollable and later payloads can grow again', async () => {
    const vm = require('node:vm');
    const source = readProjectFile('src/renderer/menu.entry.js').replace(/^import .*;\r?\n/gm, '');
    const requests = [];
    let naturalHeight = 900;
    let availableHeight = 300;
    const menu = {
        style: { maxHeight: '72px' },
        offsetWidth: 180, scrollWidth: 176,
        get offsetHeight() { return Math.min(naturalHeight, parseFloat(this.style.maxHeight) || 966); },
        querySelectorAll: () => []
    };
    const window = {
        innerHeight: 106,
        getComputedStyle: () => ({ paddingTop: '16px', paddingBottom: '16px' }),
        api: {
            receive() {},
            async send(channel, size) {
                assert.equal(channel, 'resize-and-show-menu');
                requests.push(size);
                window.innerHeight = Math.min(size.height, availableHeight);
            }
        }
    };
    const context = vm.createContext({ window, document: { body: {} }, menu, startRenderer: callback => callback() });
    vm.runInContext(source, context);
    vm.runInContext('acceptingActions = true;', context);
    await vm.runInContext('measureAndShowMenu(menu, null);', context);
    assert.equal(requests[0].height, 934, 'the old short display must not constrain natural measurement');
    assert.equal(menu.style.maxHeight, '266px', 'the scroller must fit the native viewport after monitor clamping');
    assert.ok(menu.offsetHeight < naturalHeight, 'overflow stays inside the scroll container');

    naturalHeight = 76;
    availableHeight = 1000;
    await vm.runInContext('measureAndShowMenu(menu, null);', context);
    assert.equal(requests[1].height, 110);
    assert.equal(menu.style.maxHeight, '76px');

    naturalHeight = 700;
    await vm.runInContext('measureAndShowMenu(menu, null);', context);
    assert.equal(requests[2].height, 734, 'a long payload after a short payload must expand again');
    assert.equal(menu.style.maxHeight, '700px');
});
