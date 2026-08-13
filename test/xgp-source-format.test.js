const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildXgpEntryIndex,
    mergeXgpEntriesIntoGameRow,
    normalizeXgpEntries,
    parseXgpGamesJson
} = require('../src/main/xgpSourceFormat');

test('XgpSaveTools JSON-with-comments is parsed into bounded WGS and PGS paths', () => {
    const entries = parseXgpGamesJson(`{
        // Full-line comments are used by the upstream registry.
        "games": [
            {
                "name": "Atomic Heart",
                "package": "FocusHomeInteractiveSA.579645D26CFD_4hny5m903y3g0",
                "handler": "1c1f",
                "note": "https://example.invalid/path//still-a-string"
            },
            {
                "name": "Forza Horizon 6",
                "package": "Microsoft.ForteBaseGame_8wekyb3d8bbwe",
                "source": "pgs",
                "source_args": { "game_id": "16d460" },
                "handler": "pgs-forza"
            }
        ]
    }`);

    assert.equal(entries.length, 2);
    assert.equal(entries[0].savePath, '{{p|localappdata}}/Packages/FocusHomeInteractiveSA.579645D26CFD_4hny5m903y3g0/SystemAppData/wgs');
    assert.equal(entries[1].savePath, '{{p|systemdrive}}/XboxGames/GameSave/pgs/u_{{p|xbox_uid}}_16D460');
    assert.equal(normalizeXgpEntries(entries)[1].gameId, '16D460');
});

test('XgpSaveTools mappings merge conservatively by normalized full title', () => {
    const entries = normalizeXgpEntries([{
        name: 'Hi-Fi RUSH',
        package: 'BethesdaSoftworks.Hibiki_3275kfvn8vcwc'
    }]);
    const index = buildXgpEntryIndex(entries);
    const row = {
        title: 'Hi Fi RUSH™',
        platform: ['Steam'],
        save_location: { win: ['{{p|userprofile}}/Saved Games/HiFi'] }
    };

    assert.equal(mergeXgpEntriesIntoGameRow(row, index), true);
    assert.equal(row.save_location.win.length, 2);
    assert.deepEqual(row.platform, ['Steam', 'Xbox']);
    assert.deepEqual(row.experimental_sources, ['XgpSaveTools']);
    assert.equal(mergeXgpEntriesIntoGameRow({ title: 'Hi Fi Rush 2', platform: [], save_location: {} }, index), false);
});

test('XgpSaveTools parser rejects unsupported sources and unsafe package names', () => {
    assert.throws(() => normalizeXgpEntries([{ name: 'Game', package: '../escape' }]));
    assert.throws(() => normalizeXgpEntries([{ name: 'Game', package: 'Safe.Package_123', source: 'unknown' }]));
    assert.throws(() => normalizeXgpEntries([{
        name: 'Game',
        package: 'Safe.Package_123',
        source: 'pgs',
        source_args: { game_id: '../escape' }
    }]));
});
