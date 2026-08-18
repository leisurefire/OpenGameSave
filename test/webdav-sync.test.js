const test = require('node:test');
const assert = require('node:assert/strict');

const {
    MANIFEST_VERSION,
    joinRemotePath,
    normalizeManifestPath,
    validateCurrentPointer,
    validateManifest,
    validateManifestPathsAgainstMetadata
} = require('../src/main/webdavManifest');

const DIGEST = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const REVISION = '12345678-1234-4234-9234-123456789abc';
const PARENT_REVISION = '22345678-1234-4234-9234-123456789abc';
const DEVICE_ID = '32345678-1234-4234-9234-123456789abc';
const BACKUP_ROOT = '123/2026-08-18_10-00-00';

function makeSnapshot(files) {
    return {
        version: MANIFEST_VERSION,
        revision: REVISION,
        parentRevision: PARENT_REVISION,
        deviceId: DEVICE_ID,
        generatedAt: '2026-08-18T00:00:00.000Z',
        files
    };
}

test('WebDAV manifest paths are restricted to portable backup structures', () => {
    assert.equal(joinRemotePath('/OpenGameSave/', `${BACKUP_ROOT}/path1/save.dat`),
        `/OpenGameSave/${BACKUP_ROOT}/path1/save.dat`);
    assert.equal(normalizeManifestPath(`${BACKUP_ROOT}/path1/save.dat`), `${BACKUP_ROOT}/path1/save.dat`);
    assert.equal(normalizeManifestPath(`${BACKUP_ROOT}/backup_info.json`), `${BACKUP_ROOT}/backup_info.json`);
    assert.throws(() => normalizeManifestPath('../secrets.txt'));
    assert.throws(() => normalizeManifestPath('.git/config'));
    assert.throws(() => normalizeManifestPath(`${BACKUP_ROOT}/path1/.git/config`));
    assert.throws(() => normalizeManifestPath(`${BACKUP_ROOT}/path1/save.dat:payload`));
    assert.throws(() => normalizeManifestPath(`${BACKUP_ROOT}/path1/CON.txt`));
    assert.throws(() => normalizeManifestPath(`CON/2026-08-18_10-00-00/path1/save.dat`));
    assert.throws(() => normalizeManifestPath(`${BACKUP_ROOT}/other/save.dat`));
    assert.throws(() => normalizeManifestPath('/absolute/path'));
    assert.throws(() => normalizeManifestPath('123\\save.dat'));
});

test('WebDAV snapshots are bounded, sorted and cryptographically described', () => {
    const manifest = validateManifest(makeSnapshot([
        { path: `${BACKUP_ROOT}/path1/b.dat`, size: 2, mtimeMs: 2, sha256: DIGEST_B.toUpperCase() },
        { path: `${BACKUP_ROOT}/backup_info.json`, size: 1, mtimeMs: 1, sha256: DIGEST }
    ]));
    assert.deepEqual(manifest.files.map(file => file.path), [
        `${BACKUP_ROOT}/backup_info.json`,
        `${BACKUP_ROOT}/path1/b.dat`
    ]);
    assert.equal(manifest.files[1].sha256, DIGEST_B);
    assert.throws(() => validateManifest(makeSnapshot([
        { path: `${BACKUP_ROOT}/path1/SAVE.dat`, size: 1, mtimeMs: 1, sha256: DIGEST },
        { path: `${BACKUP_ROOT}/path1/save.dat`, size: 1, mtimeMs: 1, sha256: DIGEST }
    ])));
    assert.throws(() => validateManifest(makeSnapshot([
        { path: `${BACKUP_ROOT}/path1/bad.dat`, size: -1, mtimeMs: 1, sha256: DIGEST }
    ])));
});

test('WebDAV paths must be declared by the verified backup metadata', () => {
    const files = validateManifest(makeSnapshot([
        { path: `${BACKUP_ROOT}/backup_info.json`, size: 1, mtimeMs: 1, sha256: DIGEST },
        { path: `${BACKUP_ROOT}/path1/save.dat`, size: 1, mtimeMs: 1, sha256: DIGEST }
    ])).files;
    const metadata = new Map([[BACKUP_ROOT, {
        backup_paths: [{ folder_name: 'path1' }]
    }]]);
    assert.equal(validateManifestPathsAgainstMetadata(files, metadata), files);
    metadata.set(BACKUP_ROOT, { backup_paths: [{ folder_name: 'path2' }] });
    assert.throws(() => validateManifestPathsAgainstMetadata(files, metadata));
});

test('current pointer revisions are typed and cannot be ambiguous', () => {
    assert.equal(validateCurrentPointer({
        version: MANIFEST_VERSION,
        revision: REVISION,
        parentRevision: PARENT_REVISION,
        deviceId: DEVICE_ID,
        generatedAt: '2026-08-18T00:00:00.000Z'
    }).revision, REVISION);
    assert.throws(() => validateCurrentPointer({
        version: MANIFEST_VERSION,
        revision: '../snapshot',
        parentRevision: null,
        deviceId: DEVICE_ID
    }));
});
