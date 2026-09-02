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
    const libraryService = readProjectFile('src/main/services/libraryService.js');

    assert.doesNotMatch(indexHtml, /data-titlebar-menu="friends"/);
    assert.match(indexHtml, /img-src 'self' data: blob:;/);
    assert.doesNotMatch(indexHtml, /img-src[^;]*https:/);
    assert.doesNotMatch(libraryService, /ld5\.res\.netease\.com/);
    assert.doesNotMatch(libraryService, /steam:\/\/open\/friends/);
    assert.match(utility, /item\('main\.view_account_ids'.*'view-account-ids'/);
    assert.match(utility, /item\('main\.import'.*'import'/);
    assert.match(utility, /item\('main\.export'.*'export'/);
    assert.match(utility, /item\('main\.scan_full'.*'scan-full'/);
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
    const artworkService = readProjectFile('src/main/services/libraryArtworkService.js');

    assert.match(libraryPage, /new IntersectionObserver/);
    assert.match(libraryPage, /ART_LOAD_CONCURRENCY = 2/);
    assert.match(libraryPage, /image\.loading = 'lazy'/);
    assert.match(libraryPage, /requestAnimationFrame/);
    assert.match(artworkService, /MAX_ART_BYTES = 8 \* 1024 \* 1024/);
    assert.match(artworkService, /redirect: 'manual'/);
    assert.match(artworkService, /data:\s*response\.buffer/);
    assert.doesNotMatch(artworkService, /toString\('base64'\)/);
    assert.match(artworkService, /await response\.body\?\.cancel\(\)/);
    assert.match(indexHtml, /img-src 'self' data: blob:/);
    assert.doesNotMatch(indexHtml, /connect-src[^;]*https:/);
});

test('library scans are coalesced, provider-isolated, and surface detached launch errors', () => {
    const libraryService = readProjectFile('src/main/services/libraryService.js');
    assert.match(libraryService, /if \(libraryScanPromise\) return libraryScanPromise/);
    assert.match(libraryService, /Could not scan the \$\{provider\} library/);
    assert.match(libraryService, /child\.once\('error', reject\)/);
    assert.match(libraryService, /isExistingDirectory\(game\.installPath\)/);
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
    assert.match(mainCss, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(mainCss, /@media \(forced-colors: active\)/);
    assert.match(mainCss, /\.guide-open-button:focus-visible/);
});

test('popup menus are keyboard operable and restore focus without stealing it after app switches', () => {
    const menuService = readProjectFile('src/main/services/menuWindowService.js');
    const menuEntry = readProjectFile('src/renderer/menu.entry.js');
    const menuCss = readProjectFile('src/renderer/menu.css');
    const tablePopupMenu = readProjectFile('src/renderer/js/tablePopupMenu.js');
    const tableRows = readProjectFile('src/renderer/js/tableRows.js');
    const libraryPage = readProjectFile('src/renderer/js/libraryPage.js');
    const utility = readProjectFile('src/renderer/js/utility.js');

    assert.match(menuService, /focusable:\s*true/);
    assert.match(menuService, /!menuParentWindow\.isFocused\(\)/);
    assert.match(menuService, /menuWindow\.isFocused\(\)/);
    assert.match(menuService, /hideMenuWindow\(\{ restoreFocus: true \}\)/);
    assert.match(menuService, /locale:\s*i18next\.t\('meta\.locale'\)/);
    assert.match(menuEntry, /document\.createElement\('button'\)/);
    assert.match(menuEntry, /setAttribute\('role', 'menuitem'\)/);
    assert.match(menuEntry, /\['ArrowDown', 'ArrowUp', 'Home', 'End'\]/);
    assert.match(menuEntry, /event\.key === 'Escape'/);
    assert.match(menuEntry, /document\.documentElement\.lang = locale/);
    assert.match(menuCss, /\.menu-item:focus-visible/);
    assert.match(tableRows, /aria-haspopup="menu" aria-expanded="false"/);
    assert.match(tablePopupMenu, /button\.setAttribute\('aria-expanded', 'true'\)/);
    assert.match(libraryPage, /setAttribute\('aria-haspopup', 'menu'\)/);
    assert.match(utility, /state\.restoreFocus === true.*trigger\.focus\(\)/s);
});
