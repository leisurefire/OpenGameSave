const test = require('node:test');
const assert = require('node:assert/strict');

const {
    getStateTargetKey,
    normalizeHashList,
    validateWebDAVSyncState
} = require('../src/main/webdavSyncState');

const BACKUP_ROOT = '123/2026-08-18_10-00-00';
const REVISION = '12345678-1234-4234-9234-123456789abc';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

test('WebDAV sync state stores only sorted path hashes', () => {
    assert.deepEqual(normalizeHashList([
        { path: `${BACKUP_ROOT}/path1/z.dat`, sha256: HASH_B, size: 123, localPath: 'ignored' },
        { path: `${BACKUP_ROOT}/backup_info.json`, sha256: HASH_A, mtimeMs: 456 }
    ]), [
        { path: `${BACKUP_ROOT}/backup_info.json`, sha256: HASH_A },
        { path: `${BACKUP_ROOT}/path1/z.dat`, sha256: HASH_B }
    ]);
});

test('WebDAV sync state rejects ambiguous paths and malformed revisions', () => {
    assert.throws(() => normalizeHashList([
        { path: `${BACKUP_ROOT}/path1/SAVE.dat`, sha256: HASH_A },
        { path: `${BACKUP_ROOT}/path1/save.dat`, sha256: HASH_B }
    ]));
    assert.throws(() => validateWebDAVSyncState({
        version: 1,
        targetKey: 'target',
        remoteRevision: '../snapshot',
        localFiles: [],
        remoteFiles: []
    }, 'target'));
});

test('WebDAV sync state is isolated by local root and remote target', () => {
    const config = {
        url: 'https://dav.example.com',
        username: 'player',
        remotePath: '/OpenGameSave'
    };
    const targetKey = getStateTargetKey('C:\\Backups', config);
    assert.equal(targetKey, getStateTargetKey('C:\\Backups', config));
    assert.notEqual(targetKey, getStateTargetKey('C:\\OtherBackups', config));
    assert.notEqual(targetKey, getStateTargetKey('C:\\Backups', {
        ...config,
        remotePath: '/Other'
    }));

    const state = validateWebDAVSyncState({
        version: 1,
        targetKey,
        remoteRevision: REVISION.toUpperCase(),
        localFiles: [],
        remoteFiles: []
    }, targetKey);
    assert.equal(state.remoteRevision, REVISION);
});
