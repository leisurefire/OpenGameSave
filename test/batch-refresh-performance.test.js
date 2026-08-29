const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function readRendererSource(fileName) {
    return fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'renderer', 'js', fileName), 'utf8');
}

test('batch backup and restore refresh each table once instead of updating every selected row', () => {
    for (const fileName of ['backupTab.js', 'restoreTab.js']) {
        const source = readRendererSource(fileName);
        assert.doesNotMatch(source, /for \(const wikiId of selectedGames\)[\s\S]*addOrUpdateTableRow/);
        assert.doesNotMatch(source, /import \{[^}]*addOrUpdateTableRow/);
        assert.equal(source.match(/window\.api\.send\('update-backup-table'\)/g)?.length, 1);
        assert.equal(source.match(/window\.api\.send\('update-restore-table'\)/g)?.length, 1);
    }
});
