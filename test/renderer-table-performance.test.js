const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
    return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

test('table population uses constant-time settings membership checks', () => {
    const tableDisplay = readProjectFile('src/renderer/js/tableDisplay.js');
    const commonTabs = readProjectFile('src/renderer/js/commonTabs.js');
    const populateStart = commonTabs.indexOf('export function populateGameTable');
    const populateEnd = commonTabs.indexOf('export function showOperationSummary', populateStart);
    const populateSource = commonTabs.slice(populateStart, populateEnd);

    assert.match(tableDisplay, /favoriteWikiIds = new Set/);
    assert.match(tableDisplay, /favoriteWikiIds\.has/);
    assert.doesNotMatch(tableDisplay, /favoriteWikiIds\.includes/);
    assert.match(populateSource, /blockedGamesWikiIds = new Set/);
    assert.match(populateSource, /uninstalledGamesWikiIds = new Set/);
    assert.match(populateSource, /blockedGamesWikiIds\.has/);
    assert.match(populateSource, /uninstalledGamesWikiIds\.has/);
    assert.doesNotMatch(populateSource, /(?:blocked|uninstalled)GamesWikiIds\.includes/);
});

test('table population releases old virtual rows before clearing and rebuilding the DOM', () => {
    const commonTabs = readProjectFile('src/renderer/js/commonTabs.js');
    const populateStart = commonTabs.indexOf('export function populateGameTable');
    const populateEnd = commonTabs.indexOf('export function showOperationSummary', populateStart);
    const populateSource = commonTabs.slice(populateStart, populateEnd);
    const releaseIndex = populateSource.indexOf('disableVirtualRows(tableBody);');
    const clearIndex = populateSource.indexOf("tableBody.innerHTML = '';");
    const recordBuildIndex = populateSource.indexOf('const records = [];');

    assert.ok(releaseIndex >= 0);
    assert.ok(releaseIndex < clearIndex);
    assert.ok(clearIndex < recordBuildIndex);
    assert.doesNotMatch(populateSource, /const row = createRow/);
    assert.match(populateSource, /materializeRow: record => materializeGameTableRecord/);
});
