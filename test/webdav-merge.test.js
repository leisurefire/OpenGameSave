const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const { mergeLocalFiles } = require('../src/main/webdavMerge');

const BACKUP_KEY = '123/2026-08-18_10-00-00';
const DEVICE_ID = '32345678-1234-4234-9234-123456789abc';

function digest(data) {
    return createHash('sha256').update(data).digest('hex');
}

test('same-path content conflicts preserve both complete backups with a device label', async () => {
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
    assert.equal(result.files.some(file => file.path === `${BACKUP_KEY}/path1/save.dat`
        && file.sha256 === digest('remote-save')), true);
    assert.equal(result.files.some(file => file.path === '123/2026-08-18_10-00-01/path1/save.dat'
        && file.sha256 === digest(localSave)), true);
    const conflictMetadata = result.uploadFiles.find(file =>
        file.path === '123/2026-08-18_10-00-01/backup_info.json');
    assert.match(JSON.parse(conflictMetadata.data.toString('utf8')).custom_name, /Conflict 32345678/);
});
