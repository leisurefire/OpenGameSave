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
    assert.match(indexHtml, /img-src[^;]*https:\/\/cdn\.akamai\.steamstatic\.com[^;]*https:\/\/ld5\.res\.netease\.com/);
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
