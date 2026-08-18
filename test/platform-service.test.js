const assert = require('node:assert/strict');
const test = require('node:test');

const {
    getPlatformSaveLocations,
    getSavePlatformKey
} = require('../src/main/services/platformService');

test('Node platforms map to database save-location keys', () => {
    assert.equal(getSavePlatformKey('win32'), 'win');
    assert.equal(getSavePlatformKey('darwin'), 'mac');
    assert.equal(getSavePlatformKey('linux'), 'linux');
    assert.equal(getSavePlatformKey('freebsd'), null);
});

test('platform save locations ignore other operating systems and malformed values', () => {
    const saveLocation = {
        win: ['C:/save'],
        mac: ['/Users/example/save'],
        linux: ['/home/example/save']
    };

    assert.deepEqual(getPlatformSaveLocations(saveLocation, 'win32'), ['C:/save']);
    assert.deepEqual(getPlatformSaveLocations(saveLocation, 'darwin'), ['/Users/example/save']);
    assert.deepEqual(getPlatformSaveLocations(saveLocation, 'linux'), ['/home/example/save']);
    assert.deepEqual(getPlatformSaveLocations(saveLocation, 'freebsd'), []);
    assert.deepEqual(getPlatformSaveLocations({ win: 'C:/save' }, 'win32'), []);
    assert.deepEqual(getPlatformSaveLocations(null, 'win32'), []);
});
