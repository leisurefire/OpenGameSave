const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const {
    createConflictMetadataBuffer,
    findConflictingBackupKeys,
    makeLocalConflictFiles,
    mapRemoteConflictFiles,
    mergeLocalFiles
} = require('../src/main/webdavMerge');

const BACKUP_KEY = '123/2026-08-18_10-00-00';
const DEVICE_ID = '32345678-1234-4234-9234-123456789abc';

function digest(data) {
    return createHash('sha256').update(data).digest('hex');
}

function makeFile(relativePath, content, overrides = {}) {
    const data = Buffer.from(content);
    return {
        path: `${BACKUP_KEY}/${relativePath}`,
        data,
        size: data.length,
        mtimeMs: 1,
        sha256: digest(data),
        ...overrides
    };
}

function makeSyncState(localFiles, remoteFiles) {
    return {
        localFiles: localFiles.map(({ path, sha256 }) => ({ path, sha256 })),
        remoteFiles: remoteFiles.map(({ path, sha256 }) => ({ path, sha256 }))
    };
}

test('upload conflicts keep local canonical and preserve the complete remote backup', async () => {
    const metadataBuffer = Buffer.from(JSON.stringify({
        title: 'Example Game',
        backup_paths: [{
            folder_name: 'path1',
            template: '{{p|userprofile}}\\save',
            type: 'folder',
            install_folder: null
        }]
    }));
    const localSave = Buffer.from('local-save');
    const remoteFiles = [
        {
            path: `${BACKUP_KEY}/backup_info.json`,
            size: metadataBuffer.length,
            mtimeMs: 1,
            sha256: digest(metadataBuffer)
        },
        {
            path: `${BACKUP_KEY}/path1/save.dat`,
            size: 11,
            mtimeMs: 1,
            sha256: digest('remote-save')
        }
    ];
    const localFiles = [
        {
            path: `${BACKUP_KEY}/backup_info.json`,
            data: metadataBuffer,
            size: metadataBuffer.length,
            mtimeMs: 2,
            sha256: digest(metadataBuffer)
        },
        {
            path: `${BACKUP_KEY}/path1/save.dat`,
            data: localSave,
            size: localSave.length,
            mtimeMs: 2,
            sha256: digest(localSave)
        }
    ];

    const result = await mergeLocalFiles(remoteFiles, localFiles, DEVICE_ID);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].conflictBackup, '123/2026-08-18_10-00-01');
    assert.equal(result.conflicts[0].direction, 'upload');
    assert.equal(result.conflicts[0].originalVersion, 'local');
    assert.equal(result.conflicts[0].conflictVersion, 'remote');
    assert.equal(result.files.some(file => file.path === `${BACKUP_KEY}/path1/save.dat`
        && file.sha256 === digest(localSave)), true);
    assert.equal(result.files.some(file => file.path === '123/2026-08-18_10-00-01/path1/save.dat'
        && file.sha256 === digest('remote-save')), true);
    assert.equal(result.files.some(file =>
        file.path === '123/2026-08-18_10-00-01/backup_info.json'), true);
    assert.equal(result.uploadFiles.every(file => file.path.startsWith(`${BACKUP_KEY}/`)), true);

    const nextSyncState = makeSyncState(localFiles, result.files);
    const repeated = await mergeLocalFiles(result.files, localFiles, DEVICE_ID, nextSyncState);
    assert.equal(repeated.conflicts.length, 0);
    assert.equal(repeated.files.some(file => file.path === '123/2026-08-18_10-00-01/path1/save.dat'
        && file.sha256 === digest('remote-save')), true);
});

test('only one side changing since the last sync does not create a false conflict', async () => {
    const baseLocal = makeFile('path1/save.dat', 'base');
    const baseRemote = { ...baseLocal, data: undefined };
    const localChanged = makeFile('path1/save.dat', 'local-change');
    const remoteChanged = makeFile('path1/save.dat', 'remote-change', { data: undefined });
    const syncState = makeSyncState([baseLocal], [baseRemote]);

    assert.deepEqual([...findConflictingBackupKeys([baseRemote], [localChanged], syncState)], []);
    assert.deepEqual([...findConflictingBackupKeys([remoteChanged], [baseLocal], syncState)], []);

    const uploadResult = await mergeLocalFiles([baseRemote], [localChanged], DEVICE_ID, syncState);
    assert.equal(uploadResult.conflicts.length, 0);
    assert.equal(uploadResult.files[0].sha256, localChanged.sha256);
});

test('both sides changing the same path since the last sync creates one backup-level conflict', async () => {
    const baseFile = makeFile('path1/save.dat', 'base');
    const localFile = makeFile('path1/save.dat', 'local-change');
    const remoteFile = makeFile('path1/save.dat', 'remote-change', { data: undefined });
    const syncState = makeSyncState([baseFile], [baseFile]);

    assert.deepEqual(
        [...findConflictingBackupKeys([remoteFile], [localFile], syncState)],
        [BACKUP_KEY]
    );
});

test('matching changes on both sides converge without a conflict', () => {
    const baseFile = makeFile('path1/save.dat', 'base');
    const matchingLocal = makeFile('path1/save.dat', 'same-change');
    const matchingRemote = { ...matchingLocal, data: undefined };
    const syncState = makeSyncState([baseFile], [baseFile]);

    assert.deepEqual([...findConflictingBackupKeys([matchingRemote], [matchingLocal], syncState)], []);
});

test('download conflicts remap the complete remote backup and retain source object paths', () => {
    const remoteFiles = [
        makeFile('backup_info.json', '{}', { data: undefined }),
        makeFile('path1/save.dat', 'remote', { data: undefined })
    ];
    const conflictBackup = '123/2026-08-18_10-00-01';
    const remapped = mapRemoteConflictFiles(
        remoteFiles,
        new Map([[BACKUP_KEY, conflictBackup]]),
        DEVICE_ID
    );

    assert.deepEqual(remapped.map(file => file.path), [
        `${conflictBackup}/backup_info.json`,
        `${conflictBackup}/path1/save.dat`
    ]);
    assert.deepEqual(remapped.map(file => file.remotePath), remoteFiles.map(file => file.path));
    assert.equal(remapped.every(file => file.conflictDeviceId === DEVICE_ID), true);
});

test('download reconciliation preserves the complete local backup as a permanent conflict copy', async () => {
    const metadata = JSON.stringify({
        title: 'Example Game',
        backup_paths: [{
            folder_name: 'path1',
            template: '{{p|userprofile}}\\save',
            type: 'folder',
            install_folder: null
        }]
    });
    const localFiles = [
        makeFile('backup_info.json', metadata, { localPath: 'metadata-source' }),
        makeFile('path1/save.dat', 'local-save', { localPath: 'save-source', data: undefined })
    ];
    const conflictBackup = '123/2026-08-18_10-00-01';
    const conflictFiles = await makeLocalConflictFiles(
        localFiles,
        new Map([[BACKUP_KEY, conflictBackup]]),
        DEVICE_ID
    );

    assert.deepEqual(conflictFiles.map(file => file.path), [
        `${conflictBackup}/backup_info.json`,
        `${conflictBackup}/path1/save.dat`
    ]);
    assert.equal(conflictFiles.every(file => file.localConflictFile), true);
    assert.equal(conflictFiles[1].localPath, 'save-source');
    const conflictMetadata = JSON.parse(conflictFiles[0].data.toString('utf8'));
    assert.match(conflictMetadata.custom_name, /Conflict 32345678/);
    assert.equal(conflictMetadata.is_permanent, true);
});

test('conflict metadata is visibly labeled and protected from retention pruning', () => {
    const source = Buffer.from(JSON.stringify({
        title: 'Example Game',
        backup_paths: [],
        is_permanent: false
    }));
    const metadata = JSON.parse(createConflictMetadataBuffer(source, DEVICE_ID).toString('utf8'));

    assert.match(metadata.custom_name, /Conflict 32345678/);
    assert.equal(metadata.is_permanent, true);
});
