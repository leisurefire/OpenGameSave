const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    isXboxPgsPath,
    normalizeAutoBackupGames,
    normalizeBackupRoot,
    normalizeBackupDate,
    normalizeRegistryKeyPath,
    resolveInside,
    sanitizeSettingValue,
    validateArchiveEntryPath,
    validateBackupMetadata,
    validateDatabasePatch
} = require('../src/main/validation');

test('Xbox PGS paths are identified for backup-only handling', () => {
    assert.equal(isXboxPgsPath('C:\\XboxGames\\GameSave\\pgs\\u_1_ABC'), true);
    assert.equal(isXboxPgsPath('{{p|systemdrive}}/XboxGames/GameSave/pgs/u_1_ABC'), true);
    assert.equal(isXboxPgsPath('C:\\XboxGames\\SomeGame\\Content'), false);
    assert.equal(isXboxPgsPath('{{p|localappdata}}\\Packages\\Game\\SystemAppData\\wgs'), false);
});

test('backup dates are calendar-valid and support second precision', () => {
    assert.equal(normalizeBackupDate('2026-08-10_12-34'), '2026-08-10_12-34');
    assert.equal(normalizeBackupDate('2024-02-29_23-59-58'), '2024-02-29_23-59-58');
    assert.throws(() => normalizeBackupDate('2025-02-29_12-00'));
    assert.throws(() => normalizeBackupDate('../2026-08-10_12-00'));
});

test('resolved paths cannot escape their configured root', () => {
    const root = path.resolve('C:\\backups');
    assert.equal(resolveInside(root, '123', '2026-08-10_12-00'), path.join(root, '123', '2026-08-10_12-00'));
    assert.throws(() => resolveInside(root, '..', 'outside'));
    assert.throws(() => normalizeBackupRoot(path.parse(root).root));
});

test('registry operations reject broad or operating-system keys', () => {
    assert.equal(normalizeRegistryKeyPath('HKEY_CURRENT_USER\\Software\\Game Studio'), 'HKEY_CURRENT_USER\\Software\\Game Studio');
    assert.equal(normalizeRegistryKeyPath('HKEY_CURRENT_USER\\Software\\Microsoft\\Games\\Age of Empires'), 'HKEY_CURRENT_USER\\Software\\Microsoft\\Games\\Age of Empires');
    assert.equal(normalizeRegistryKeyPath('HKEY_LOCAL_MACHINE\\SOFTWARE\\Game Studio'), 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Game Studio');
    assert.throws(() => normalizeRegistryKeyPath('HKEY_CURRENT_USER\\Software'));
    assert.throws(() => normalizeRegistryKeyPath('HKEY_CURRENT_USER\\Software\\Microsoft\\Windows'));
    assert.throws(() => normalizeRegistryKeyPath('HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet'));
});

test('auto-backup settings discard malformed jobs and zero-delay intervals', () => {
    const normalized = normalizeAutoBackupGames({
        123: { mode: 'interval', intervalMinutes: 15 },
        zero: { mode: 'interval', intervalMinutes: 0 },
        watcher: { mode: 'watcher', intervalMinutes: 0 },
        '../escape': { mode: 'watcher' }
    });
    assert.deepEqual(Object.keys(normalized).sort(), ['123', 'watcher']);
    assert.equal(normalized['123'].intervalMinutes, 15);
    assert.equal(normalized.watcher.intervalMinutes, null);
    assert.throws(() => sanitizeSettingValue('__proto__', true, false));
    assert.equal(sanitizeSettingValue('launchAtStartup', true, false), true);
    assert.equal(sanitizeSettingValue('launchAtStartup', 'yes', false), false);
    assert.equal(sanitizeSettingValue('experimentalXgpSource', true, false), true);
    assert.equal(sanitizeSettingValue('experimentalXgpSource', 'yes', false), false);
});

test('backup metadata and archive paths reject traversal or forged folder names', () => {
    const metadata = validateBackupMetadata({
        title: 'Game',
        backup_paths: [{ folder_name: 'path1', template: '{{p|userprofile}}\\save', type: 'folder' }]
    });
    assert.equal(metadata.title, 'Game');
    assert.equal(validateArchiveEntryPath('123/2026-08-10_12-34-56/path1/save.dat'), '123/2026-08-10_12-34-56/path1/save.dat');
    assert.throws(() => validateBackupMetadata({ title: 'Game', backup_paths: [{ folder_name: '../path1', template: 'x', type: 'file' }] }));
    assert.throws(() => validateArchiveEntryPath('123/2026-08-10_12-34/../../secret'));
});

test('database patches are bounded, typed and tied to the asset version', () => {
    const patch = validateDatabasePatch({
        version: 7,
        from_version: 6,
        upsert: [{
            wiki_page_id: 123,
            title: 'Game',
            zh_CN: null,
            install_folder: null,
            steam_id: null,
            gog_id: null,
            platform: null,
            save_location: JSON.stringify({ win: ['C:\\Save'], reg: [], linux: [], mac: [] })
        }],
        delete: [456, 456]
    }, 7, 6);
    assert.equal(patch.upsert[0].wiki_page_id, 123);
    assert.deepEqual(patch.delete, [456]);
    assert.throws(() => validateDatabasePatch({ version: 8, from_version: 7, upsert: [], delete: [] }, 7));
    assert.throws(() => validateDatabasePatch({ version: 7, from_version: 5, upsert: [], delete: [] }, 7, 6));
    assert.throws(() => validateDatabasePatch({ version: 7, from_version: 6, upsert: [{ wiki_page_id: 1, title: 'x', save_location: '{' }], delete: [] }, 7));
});
