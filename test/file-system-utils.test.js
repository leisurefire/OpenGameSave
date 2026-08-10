const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    calculateDirectorySize,
    copyFolderAsync,
    getLatestModificationTime,
    getLatestModificationTimeAsync
} = require('../src/main/fileSystemUtils');
const { assertNoSymlinkAncestors } = require('../src/main/validation');

test('iterative filesystem helpers copy nested trees and ignore backup metadata in size totals', async (t) => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-test-'));
    t.after(() => fs.promises.rm(tempRoot, { recursive: true, force: true }));
    const source = path.join(tempRoot, 'source');
    const destination = path.join(tempRoot, 'destination');
    await fs.promises.mkdir(path.join(source, 'nested'), { recursive: true });
    await fs.promises.writeFile(path.join(source, 'save.dat'), '12345');
    await fs.promises.writeFile(path.join(source, 'nested', 'state.bin'), '123');
    await fs.promises.writeFile(path.join(source, 'backup_info.json'), 'metadata');

    assert.equal(calculateDirectorySize(source), 8);
    assert.ok(getLatestModificationTime(source) > 0);
    assert.ok(await getLatestModificationTimeAsync(source) > 0);
    assert.equal(getLatestModificationTime(path.join(tempRoot, 'missing')), 0);
    await assertNoSymlinkAncestors(source, path.join(source, 'nested', 'state.bin'), fs);
    await assert.rejects(() => assertNoSymlinkAncestors(source, tempRoot, fs));

    await copyFolderAsync(source, destination);
    assert.equal(await fs.promises.readFile(path.join(destination, 'nested', 'state.bin'), 'utf8'), '123');
});
