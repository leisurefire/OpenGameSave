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
    assert.doesNotMatch(indexHtml, /connect-src[^;]*https:/);
});
