const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertClean, treeHashes, quote } = require('../scripts/verify-windows-installer.cjs');

test('installer verification refuses existing installations or data before mutations', () => {
    assert.throws(() => assertClean({ installs: [{ version: '0.7.2' }] }, []), /Existing OpenGameSave install/);
    assert.throws(() => assertClean({ installs: [] }, ['OGS Backups']), /Existing app data/);
    assert.doesNotThrow(() => assertClean({ installs: [] }, []));
});

test('preservation evidence detects changed bytes, additions and deletions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-installer-hash-'));
    try {
        fs.mkdirSync(path.join(root, 'nested'));
        const file = path.join(root, 'nested', 'save.dat');
        fs.writeFileSync(file, 'original');
        const before = treeHashes(root);
        assert.equal(Object.keys(before).length, 1);
        assert.deepEqual(treeHashes(root), before);
        fs.writeFileSync(file, 'changed');
        assert.notDeepEqual(treeHashes(root), before);
        fs.writeFileSync(file, 'original');
        fs.writeFileSync(path.join(root, 'extra'), 'unexpected');
        assert.notDeepEqual(treeHashes(root), before);
        fs.unlinkSync(path.join(root, 'extra'));
        fs.unlinkSync(file);
        assert.notDeepEqual(treeHashes(root), before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('PowerShell literal quoting preserves paths with apostrophes and shell syntax', () => {
    assert.equal(quote("C:\\Test's $data\\$(literal)"), "'C:\\Test''s $data\\$(literal)'");
});
