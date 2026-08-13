'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildSyncPlan,
    canonicalizePlaceholderPath,
    convertManifestFilePath,
    convertManifestRegistryPath
} = require('../scripts/sync-ludusavi-manifest');

function makeRow(overrides = {}) {
    return {
        title: 'Example Game',
        wiki_page_id: 1234,
        install_folder: 'ExampleGame',
        steam_id: 5678,
        gog_id: null,
        save_location: JSON.stringify({ win: ['{{p|localappdata}}\\Existing'], reg: [], linux: [], mac: [] }),
        platform: JSON.stringify(['Steam']),
        ...overrides
    };
}

test('converts Xbox PGS paths to the OpenGameSave placeholder format', () => {
    const converted = convertManifestFilePath(
        'C:/XboxGames/GameSave/pgs/u_<storeUserId>_16D460',
        'win',
        { os: 'windows', store: 'microsoft' }
    );
    assert.equal(
        converted,
        '{{p|systemdrive}}\\XboxGames\\GameSave\\pgs\\u_{{p|xbox_uid}}_16D460'
    );
});

test('converts WGS and registry paths without leaving Ludusavi tokens', () => {
    assert.equal(
        convertManifestFilePath(
            '<winLocalAppData>/Packages/Publisher.Game_abcd/SystemAppData/wgs/<storeUserId>',
            'win',
            { os: 'windows', store: 'microsoft' }
        ),
        '{{p|localappdata}}\\Packages\\Publisher.Game_abcd\\SystemAppData\\wgs\\{{p|uid}}'
    );
    assert.equal(
        convertManifestFilePath('<winDocuments>/Example/Saves', 'win', { os: 'windows' }),
        '{{p|userprofile/documents}}\\Example\\Saves'
    );
    assert.equal(
        convertManifestRegistryPath('HKEY_CURRENT_USER/Software/Studio/Game'),
        '{{p|hkcu}}\\Software\\Studio\\Game'
    );
});

test('rejects traversal and protected registry locations from upstream data', () => {
    assert.equal(convertManifestFilePath('<winLocalAppData>/../Secrets', 'win', { os: 'windows' }), null);
    assert.equal(convertManifestRegistryPath('HKEY_CURRENT_USER/Software/Microsoft/Windows/CurrentVersion'), null);
});

test('matches by stable store ID and merges paths additively', () => {
    const manifest = {
        'Different Upstream Title': {
            steam: { id: 5678 },
            files: {
                '<winLocalAppData>/Example/Saves': {
                    tags: ['save'],
                    when: [{ os: 'windows', store: 'steam' }]
                },
                'C:/XboxGames/GameSave/pgs/u_<storeUserId>_ABC123': {
                    tags: ['save'],
                    when: [{ os: 'windows', store: 'microsoft' }]
                }
            }
        },
        'Unmatched Game': {
            files: {
                '<winDocuments>/Unmatched': { tags: ['save'] }
            }
        }
    };

    const first = buildSyncPlan(manifest, [makeRow()]);
    assert.equal(first.counters.matchedGames, 1);
    assert.equal(first.counters.unmatchedGames, 1);
    assert.equal(first.counters.updatedGames, 1);
    assert.equal(first.counters.addedPaths, 2);
    assert.equal(first.counters.addedXboxPgsPaths, 1);
    assert.deepEqual(JSON.parse(first.updates[0].platform), ['Steam', 'Xbox']);

    const merged = JSON.parse(first.updates[0].save_location);
    assert.ok(merged.win.includes('{{p|localappdata}}\\Example\\Saves'));
    assert.ok(merged.win.includes('{{p|systemdrive}}\\XboxGames\\GameSave\\pgs\\u_{{p|xbox_uid}}_ABC123'));

    const second = buildSyncPlan(manifest, [makeRow({
        save_location: first.updates[0].save_location,
        platform: first.updates[0].platform
    })]);
    assert.equal(second.counters.updatedGames, 0);
    assert.equal(second.counters.addedPaths, 0);
});

test('canonical path comparison treats current aliases as equivalent', () => {
    assert.equal(
        canonicalizePlaceholderPath('{{p|userprofile}}\\Documents\\Game\\'),
        canonicalizePlaceholderPath('{{p|userprofile/documents}}/Game')
    );
    assert.equal(
        canonicalizePlaceholderPath('C:\\XboxGames\\GameSave\\pgs\\u_1_ABC'),
        canonicalizePlaceholderPath('{{p|systemdrive}}\\XboxGames\\GameSave\\pgs\\u_1_ABC')
    );
});

test('normalizes a legacy hard-coded PGS system drive without duplicating the path', () => {
    const row = makeRow({
        title: 'Forza Horizon 6',
        steam_id: 2483190,
        save_location: JSON.stringify({
            win: ['C:\\XboxGames\\GameSave\\pgs\\u_{{p|xbox_uid}}_16D460'],
            reg: [],
            linux: [],
            mac: []
        })
    });
    const manifest = {
        'Forza Horizon 6': {
            steam: { id: 2483190 },
            files: {
                'C:/XboxGames/GameSave/pgs/u_<storeUserId>_16D460': {
                    when: [{ os: 'windows', store: 'microsoft' }]
                }
            }
        }
    };

    const plan = buildSyncPlan(manifest, [row]);
    assert.equal(plan.counters.addedPaths, 0);
    assert.equal(plan.counters.normalizedXboxPgsPaths, 1);
    assert.equal(plan.updates.length, 1);
    assert.deepEqual(JSON.parse(plan.updates[0].save_location).win, [
        '{{p|systemdrive}}\\XboxGames\\GameSave\\pgs\\u_{{p|xbox_uid}}_16D460'
    ]);
});

test('combines multiple upstream entries that resolve to the same local game', () => {
    const manifest = {
        'Example Game': {
            steam: { id: 5678 },
            files: {
                '<winLocalAppData>/Example/First': { when: [{ os: 'windows' }] }
            }
        },
        'Example Game Deluxe': {
            steam: { id: 5678 },
            files: {
                '<winLocalAppData>/Example/Second': { when: [{ os: 'windows' }] }
            }
        }
    };

    const plan = buildSyncPlan(manifest, [makeRow()]);
    assert.equal(plan.updates.length, 1);
    assert.equal(plan.counters.updatedGames, 1);
    assert.deepEqual(JSON.parse(plan.updates[0].save_location).win, [
        '{{p|localappdata}}\\Existing',
        '{{p|localappdata}}\\Example\\First',
        '{{p|localappdata}}\\Example\\Second'
    ]);
});
