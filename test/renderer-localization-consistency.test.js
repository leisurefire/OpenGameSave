const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
    return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('renderer language metadata and visible shell labels remain localized', () => {
    const english = JSON.parse(readProjectFile('src/locale/en_US.json'));
    const chinese = JSON.parse(readProjectFile('src/locale/zh_CN.json'));
    const utility = readProjectFile('src/renderer/js/utility.js');
    const indexHtml = readProjectFile('src/renderer/index.html');
    const aboutHtml = readProjectFile('src/renderer/about.html');

    assert.equal(english.meta.locale, 'en-US');
    assert.equal(chinese.meta.locale, 'zh-CN');
    assert.ok(english.about.tagline);
    assert.ok(chinese.about.tagline);
    assert.match(utility, /translate\('meta\.locale'\)/);
    assert.match(utility, /documentElement\.lang = locale/);
    assert.match(indexHtml, /id="sync-tab"[\s\S]*?data-i18n="main\.sync"/);
    assert.equal((indexHtml.match(/data-i18n="summary\.done"/g) || []).length, 2);
    assert.match(aboutHtml, /data-i18n="about\.tagline"/);
    assert.match(aboutHtml, /<button id="github-link"[^>]*type="button"/);
    assert.match(aboutHtml, /<button id="author-link"[^>]*type="button"/);
});

test('dynamic icon-only controls receive localized accessible names', () => {
    const settingsPage = readProjectFile('src/renderer/js/settingsPage.js');
    const tableRows = readProjectFile('src/renderer/js/tableRows.js');

    assert.match(settingsPage, /data-i18n-aria-label="settings\.select_path"/);
    assert.match(settingsPage, /data-i18n-aria-label="main\.delete"/);
    assert.match(settingsPage, /updateTranslations\(newPath\)/);
    assert.match(tableRows, /data-i18n-aria-label="main\.more"/);
    assert.match(tableRows, /setAttribute\('aria-label', moreLabel\)/);
});

test('shared UI primitives keep loading, table, and select states consistent', () => {
    const styles = readProjectFile('src/renderer/styles.css');
    const mainCss = readProjectFile('src/renderer/css/main.css');
    const indexHtml = readProjectFile('src/renderer/index.html');
    const settingsHtml = readProjectFile('src/renderer/settings.html');
    const dropdownSelect = readProjectFile('src/renderer/js/components/DropdownSelect.js');

    assert.match(styles, /--color-text-primary:/);
    assert.match(styles, /--color-text-emphasis:/);
    assert.match(styles, /--color-focus-ring:/);
    assert.match(styles, /--color-card-surface-subtle:/);
    assert.match(styles, /--color-card-surface-raised:/);
    assert.match(styles, /--radius-card:/);
    assert.match(styles, /--control-height:/);
    assert.match(indexHtml, /id="library-loading" class="library-state"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(indexHtml, /id="guides-loading" class="library-state"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(indexHtml, /id="backup-loading" class="flex justify-center p-20 opacity-40"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(indexHtml, /id="restore-loading" class="flex justify-center p-20 opacity-40"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.equal((indexHtml.match(/class="table-semantic-head"/g) || []).length, 2);
    assert.match(mainCss, /input\.search-input:focus/);
    assert.match(mainCss, /input\.search-input:focus\s*\{[\s\S]*?border-width:\s*1px !important;/);
    assert.match(mainCss, /\.table-semantic-head\s*\{[\s\S]*?clip:\s*rect\(0, 0, 0, 0\)/);
    assert.match(mainCss, /\.table-container table th,[\s\S]*?height:\s*60px/);
    assert.match(mainCss, /input\[type="text"\]\.search-input::placeholder\s*\{[\s\S]*?var\(--color-text-faint\)/);
    assert.match(mainCss, /\.sync-card,[\s\S]*?background:\s*var\(--color-card-surface-raised\)/);
    assert.match(settingsHtml, /data-i18n="settings\.database_variant_standard"/);
    assert.match(settingsHtml, /data-i18n="settings\.database_variant_xbox"/);
    assert.match(dropdownSelect, /new MutationObserver\(\(\) => this\._readOptions\(\)\)/);
    assert.match(dropdownSelect, /aria-controls="\$\{this\._listboxId\}"/);
    assert.match(dropdownSelect, /setAttribute\('aria-activedescendant', activeOption\.id\)/);
});
