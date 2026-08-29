const test = require('node:test');
const assert = require('node:assert/strict');

const {
    authorizeRestoreDestination,
    isForbiddenRestorePayloadPath
} = require('../src/main/restoreAuthorization');

const APPDATA = String.raw`C:\Users\Alice\AppData\Roaming`;
const USERPROFILE = String.raw`C:\Users\Alice`;
const GAME = String.raw`D:\Games\Example Game`;
const BASE_OPTIONS = {
    pathFlavor: 'win32',
    trustedInstallFolder: GAME,
    placeholderValues: {
        appdata: APPDATA,
        userprofile: USERPROFILE,
        hkcu: 'HKEY_CURRENT_USER'
    },
    allowedRoots: [APPDATA, USERPROFILE],
    dynamicValues: {
        uid: ['76561198000000000'],
        xbox_uid: ['A1B2C3D4']
    }
};

function authorize(currentTemplates, template, type = 'folder', overrides = {}) {
    return authorizeRestoreDestination({
        ...BASE_OPTIONS,
        ...overrides,
        currentTemplates,
        metadata: { template, type }
    });
}

test('authorizes a concrete backup destination only when it matches a current database template', () => {
    const result = authorize(
        { file: [String.raw`{{p|appdata}}\Vendor\Game\profiles\{{p|uid}}\slot*.sav`], registry: [] },
        String.raw`{{p|appdata}}\Vendor\Game\profiles\76561198000000000\slot01.sav`,
        'file'
    );
    assert.equal(result.destination, String.raw`C:\Users\Alice\AppData\Roaming\Vendor\Game\profiles\76561198000000000\slot01.sav`);
    assert.equal(result.allowedRoot, APPDATA);
    assert.equal(result.type, 'file');
});

test('rejects the imported Startup-folder overwrite PoC', () => {
    assert.throws(() => authorize(
        { file: [String.raw`{{p|appdata}}\Vendor\Game\Saves`], registry: [] },
        String.raw`{{p|appdata}}\Microsoft\Windows\Start Menu\Programs\Startup`
    ), /not authorized/);
});

test('rejects unknown placeholders, traversal, device paths, ADS, and trailing-dot aliases', () => {
    const templates = { file: [String.raw`{{p|appdata}}\Vendor\Game\save.dat`], registry: [] };
    assert.throws(() => authorize(templates, String.raw`{{p|evil}}\Vendor\Game\save.dat`), /Unknown restore placeholder/);
    assert.throws(() => authorize(templates, String.raw`{{p|appdata}}\Vendor\Game\..\..\Startup`), /traversal/);
    assert.throws(() => authorize(templates, String.raw`\\?\C:\Users\Alice\AppData\Roaming\Vendor\Game\save.dat`), /device paths/);
    assert.throws(() => authorize(templates, String.raw`{{p|appdata}}\Vendor\Game\save.dat:payload.exe`), /ADS/);
    assert.throws(() => authorize(templates, String.raw`{{p|appdata}}\Vendor\Game\save.dat. `), /trailing dot or space/);
});

test('keeps UID and ordinary glob matches inside one safe path segment', () => {
    const templates = {
        file: [String.raw`{{p|appdata}}\Vendor\Game\profiles\{{p|uid}}\slot-?.dat`],
        registry: []
    };
    assert.doesNotThrow(() => authorize(
        templates,
        String.raw`{{p|appdata}}\Vendor\Game\profiles\76561198000000000\slot-1.dat`,
        'file'
    ));
    assert.throws(() => authorize(
        templates,
        String.raw`{{p|appdata}}\Vendor\Game\profiles\untrusted-user\slot-1.dat`,
        'file'
    ), /not authorized/);
    assert.throws(() => authorize(
        templates,
        String.raw`{{p|appdata}}\Vendor\Game\profiles\76561198000000000\nested\slot-1.dat`,
        'file'
    ), /not authorized/);
});

test('requires trusted UID values and supports placeholders embedded in one segment', () => {
    const templates = {
        file: [String.raw`{{p|appdata}}\Vendor\Game\profiles\SteamID_{{p|uid}}\{{p|uid}}.sav`],
        registry: []
    };
    assert.doesNotThrow(() => authorize(
        templates,
        String.raw`{{p|appdata}}\Vendor\Game\profiles\SteamID_76561198000000000\76561198000000000.sav`,
        'file'
    ));
    assert.throws(() => authorize(
        templates,
        String.raw`{{p|appdata}}\Vendor\Game\profiles\SteamID_ATTACKER\ATTACKER.sav`,
        'file',
        { dynamicValues: {} }
    ), /not authorized/);
});

test('authorizes the resolver-compatible extra single-directory wildcard fallback only under a fixed prefix', () => {
    assert.doesNotThrow(() => authorize(
        { file: [String.raw`{{p|appdata}}\Vendor\Game\save*.dat`], registry: [] },
        String.raw`{{p|appdata}}\Vendor\Game\profile\save01.dat`,
        'file'
    ));
    assert.throws(() => authorize(
        { file: [String.raw`{{p|game}}\save*.dat`], registry: [] },
        String.raw`{{p|game}}\profile\save01.dat`,
        'file'
    ), /not authorized/);
});

test('allows scoped globstar but rejects globstar without a fixed game-specific prefix', () => {
    assert.doesNotThrow(() => authorize(
        { file: [String.raw`{{p|game}}\saves\**\slot.dat`], registry: [] },
        String.raw`{{p|game}}\saves\profile\chapter\slot.dat`,
        'file'
    ));
    assert.throws(() => authorize(
        { file: [String.raw`{{p|game}}\**\slot.dat`], registry: [] },
        String.raw`{{p|game}}\profile\slot.dat`,
        'file'
    ), /not authorized/);
});

test('rejects broad whole-segment game-root wildcards and executable wildcard matches', () => {
    assert.throws(() => authorize(
        { file: [String.raw`{{p|game}}\********`], registry: [] },
        String.raw`{{p|game}}\version.dll`,
        'file'
    ), /not authorized/);
    assert.throws(() => authorize(
        { file: [String.raw`{{p|game}}\saves\*.cmd`], registry: [] },
        String.raw`{{p|game}}\saves\launch.cmd`,
        'file'
    ), /not authorized/);
    assert.doesNotThrow(() => authorize(
        { file: [String.raw`{{p|game}}\GameSetup.exe`], registry: [] },
        String.raw`{{p|game}}\GameSetup.exe`,
        'file'
    ));
    assert.doesNotThrow(() => authorize(
        { file: [String.raw`{{p|game}}\renpy\config.py`], registry: [] },
        String.raw`{{p|game}}\renpy\config.py`,
        'file'
    ));
});

test('exposes the same dangerous-extension policy for recursive external payload scans', () => {
    assert.equal(isForbiddenRestorePayloadPath(String.raw`nested\version.DLL`, 'win32'), true);
    assert.equal(isForbiddenRestorePayloadPath('nested/config.py', 'posix'), true);
    assert.equal(isForbiddenRestorePayloadPath(String.raw`nested\slot.sav`, 'win32'), false);
});

test('requires every filesystem destination to be a strict descendant of a non-root allowed directory', () => {
    assert.throws(() => authorize(
        { file: [String.raw`{{p|userprofile}}`], registry: [] },
        String.raw`{{p|userprofile}}`
    ), /outside the allowed roots/);
    assert.throws(() => authorize(
        { file: [String.raw`C:\*.sav`], registry: [] },
        String.raw`C:\save.sav`,
        'file',
        { allowedRoots: ['C:\\'] }
    ), /Filesystem roots/);
});

test('isolates file templates from registry metadata and normalizes authorized registry keys', () => {
    const templates = {
        file: [String.raw`{{p|appdata}}\Vendor\Game\save.dat`],
        registry: [String.raw`{{p|hkcu}}\Software\Vendor\Game\profiles\{{p|uid}}`]
    };
    assert.throws(() => authorize(
        templates,
        String.raw`{{p|hkcu}}\Software\Vendor\Game\profiles\76561198000000000`,
        'file'
    ), /absolute|not authorized/);
    assert.throws(() => authorize(
        templates,
        String.raw`{{p|appdata}}\Vendor\Game\save.dat`,
        'reg'
    ), /registry|not authorized/i);

    const result = authorize(
        templates,
        String.raw`{{p|hkcu}}\Software\Vendor\Game\profiles\76561198000000000`,
        'reg'
    );
    assert.equal(result.destination, String.raw`HKEY_CURRENT_USER\Software\Vendor\Game\profiles\76561198000000000`);
    assert.equal(result.allowedRoot, null);
    assert.equal(result.type, 'reg');
});
