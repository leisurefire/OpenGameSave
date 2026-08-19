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
    assert.match(indexHtml, /img-src 'self' data:;/);
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
    assert.match(libraryPage, /ART_LOAD_CONCURRENCY = 4/);
    assert.match(libraryPage, /image\.loading = 'lazy'/);
    assert.match(libraryPage, /requestAnimationFrame/);
    assert.match(artworkService, /MAX_ART_BYTES = 12 \* 1024 \* 1024/);
    assert.match(artworkService, /redirect: 'manual'/);
    assert.match(artworkService, /Buffer\.byteLength\(dataUrl, 'utf8'\)/);
    assert.match(artworkService, /await response\.body\?\.cancel\(\)/);
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
