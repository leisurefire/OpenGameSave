const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    calculateDirectorySize,
    calculateDirectorySizeAsync,
    copyFolder,
    copyFolderAtomically,
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

test('atomic folder copy publishes only complete directory trees', async (t) => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-atomic-copy-test-'));
    t.after(() => fs.promises.rm(tempRoot, { recursive: true, force: true }));
    const source = path.join(tempRoot, 'source');
    const destination = path.join(tempRoot, 'destination');
    await fs.promises.mkdir(source);
    await fs.promises.writeFile(path.join(source, 'save.dat'), 'complete');

    await copyFolderAtomically(source, destination);

    assert.equal(await fs.promises.readFile(path.join(destination, 'save.dat'), 'utf8'), 'complete');
    assert.deepEqual(
        (await fs.promises.readdir(tempRoot)).filter(name => name.startsWith('.destination.import-')),
        []
    );
});

test('atomic folder copy removes staging data and leaves no final directory after failure', async (t) => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-atomic-copy-failure-test-'));
    t.after(() => fs.promises.rm(tempRoot, { recursive: true, force: true }));
    const source = path.join(tempRoot, 'source');
    const destination = path.join(tempRoot, 'destination');
    await fs.promises.mkdir(source);
    await fs.promises.writeFile(path.join(source, 'save.dat'), 'partial');

    const failingPromises = new Proxy(fs.promises, {
        get(target, property, receiver) {
            if (property === 'copyFile') {
                return async (sourcePath, destinationPath) => {
                    await target.copyFile(sourcePath, destinationPath);
                    throw new Error('simulated copy failure');
                };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
    const failingFs = new Proxy(fs, {
        get(target, property, receiver) {
            if (property === 'promises') return failingPromises;
            return Reflect.get(target, property, receiver);
        }
    });

    await assert.rejects(
        () => copyFolderAtomically(source, destination, failingFs),
        /simulated copy failure/
    );
    assert.equal(await fs.promises.lstat(destination).catch(() => null), null);
    assert.deepEqual(
        (await fs.promises.readdir(tempRoot)).filter(name => name.startsWith('.destination.import-')),
        []
    );
});

test('folder copying rejects self-copy and descendants before creating nested data', async (t) => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-copy-overlap-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    await fs.promises.writeFile(path.join(root, 'save.dat'), 'original');
    assert.throws(() => copyFolder(root, root), /outside the source/);
    assert.throws(() => copyFolder(root, path.join(root, 'nested')), /outside the source/);
    await assert.rejects(copyFolderAsync(root, path.join(root, 'nested')), /outside the source/);
    await assert.rejects(copyFolderAtomically(root, path.join(root, 'snapshot')), /outside the source/);
    assert.deepEqual(await fs.promises.readdir(root), ['save.dat']);
});

test('folder copying detects a source alias through a linked destination ancestor', async (t) => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-copy-alias-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    const alias = path.join(root, 'alias');
    await fs.promises.mkdir(source);
    await fs.promises.writeFile(path.join(source, 'save.dat'), 'original');
    await fs.promises.symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(copyFolderAsync(source, path.join(alias, 'nested')), /outside the source/);
    assert.equal(await fs.promises.readFile(path.join(source, 'save.dat'), 'utf8'), 'original');
    assert.deepEqual(await fs.promises.readdir(path.join(source, 'nested')), []);
});

test('directory-size caches stay isolated across filesystem adapters', async () => {
    const root = path.join(os.tmpdir(), 'ogs-cache-adapter');
    const createAdapter = size => {
        const lstatSync = target => ({
            isSymbolicLink: () => false,
            isDirectory: () => target === root,
            isFile: () => target !== root,
            mtimeMs: 1,
            size: target === root ? 0 : size
        });
        const readdirSync = () => [{ name: 'save.dat', isDirectory: () => false, isFile: () => true }];
        return { lstatSync, readdirSync, promises: { lstat: lstatSync, readdir: readdirSync } };
    };
    const firstAdapter = createAdapter(3);
    const secondAdapter = createAdapter(17);
    assert.equal(calculateDirectorySize(root, true, firstAdapter), 3);
    assert.equal(await calculateDirectorySizeAsync(root, true, secondAdapter), 17);
    assert.equal(calculateDirectorySize(root, true, secondAdapter), 17);
});

test('file sizes reflect a replacement even when its modification time is preserved', async (t) => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-size-replacement-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'save.dat');
    const timestamp = new Date('2026-01-01T00:00:00Z');
    await fs.promises.writeFile(file, 'one');
    await fs.promises.utimes(file, timestamp, timestamp);
    assert.equal(calculateDirectorySize(file), 3);
    await fs.promises.writeFile(file, 'longer replacement');
    await fs.promises.utimes(file, timestamp, timestamp);
    assert.equal(await calculateDirectorySizeAsync(file), 18);
});
