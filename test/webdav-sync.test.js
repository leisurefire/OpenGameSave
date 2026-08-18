const test = require('node:test');
const assert = require('node:assert/strict');

const {
    MANIFEST_VERSION,
    joinRemotePath,
    normalizeManifestPath,
    validateManifest
} = require('../src/main/webdavManifest');

const DIGEST = 'a'.repeat(64);

test('WebDAV remote paths are normalized without allowing manifest traversal', () => {
    assert.equal(joinRemotePath('/OpenGameSave/', '123/save.dat'), '/OpenGameSave/123/save.dat');
    assert.equal(normalizeManifestPath('123/2026-08-18_10-00/path1/save.dat'), '123/2026-08-18_10-00/path1/save.dat');
    assert.throws(() => normalizeManifestPath('../secrets.txt'));
    assert.throws(() => normalizeManifestPath('/absolute/path'));
    assert.throws(() => normalizeManifestPath('123\\save.dat'));
});

test('WebDAV manifests are bounded, sorted and cryptographically described', () => {
    const manifest = validateManifest({
        version: MANIFEST_VERSION,
        generatedAt: '2026-08-18T00:00:00.000Z',
        files: [
            { path: 'b/file.dat', size: 2, mtimeMs: 2, sha256: DIGEST.toUpperCase() },
            { path: 'a/file.dat', size: 1, mtimeMs: 1, sha256: DIGEST }
        ]
    });
    assert.deepEqual(manifest.files.map(file => file.path), ['a/file.dat', 'b/file.dat']);
    assert.equal(manifest.files[1].sha256, DIGEST);
    assert.throws(() => validateManifest({
        version: MANIFEST_VERSION,
        files: [
            { path: 'same.dat', size: 1, mtimeMs: 1, sha256: DIGEST },
            { path: 'same.dat', size: 1, mtimeMs: 1, sha256: DIGEST }
        ]
    }));
    assert.throws(() => validateManifest({
        version: MANIFEST_VERSION,
        files: [{ path: 'bad.dat', size: -1, mtimeMs: 1, sha256: DIGEST }]
    }));
});
