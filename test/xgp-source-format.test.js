const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeXgpEntries,
    parseXgpGamesJson
} = require('../src/main/xgpSourceFormat');
const { buildSyncPlan, validateMitLicense } = require('../scripts/sync-xgp-save-tools');

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

test('XgpSaveTools mappings merge conservatively into existing database rows', () => {
    const entries = normalizeXgpEntries([{
        name: 'Hi-Fi RUSH',
        package: 'BethesdaSoftworks.Hibiki_3275kfvn8vcwc'
    }]);
    const rows = [{
        wiki_page_id: 123,
        title: 'Hi Fi RUSH™',
        platform: JSON.stringify(['Steam']),
        save_location: JSON.stringify({ win: ['{{p|userprofile}}/Saved Games/HiFi'] })
    }];

    const plan = buildSyncPlan(entries, rows);
    assert.equal(plan.updates.length, 1);
    assert.equal(JSON.parse(plan.updates[0].save_location).win.length, 2);
    assert.deepEqual(JSON.parse(plan.updates[0].platform), ['Steam', 'Xbox']);
    assert.equal(plan.counters.addedWgsPaths, 1);
    assert.equal(buildSyncPlan(entries, [{ ...rows[0], title: 'Hi Fi Rush 2' }]).updates.length, 0);
});

test('XgpSaveTools sync does not delete paths and reports ambiguous title matches', () => {
    const entries = normalizeXgpEntries([{
        name: 'Shared Game',
        package: 'Publisher.SharedGame_123'
    }]);
    const location = JSON.stringify({ win: ['{{p|localappdata}}/existing'] });
    const rows = [
        { wiki_page_id: 1, title: 'Shared Game', platform: '[]', save_location: location },
        { wiki_page_id: 2, title: 'Shared Game™', platform: '[]', save_location: location }
    ];

    const plan = buildSyncPlan(entries, rows);
    assert.equal(plan.updates.length, 0);
    assert.equal(plan.conflicts.length, 1);
    assert.equal(JSON.parse(rows[0].save_location).win[0], '{{p|localappdata}}/existing');
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

test('XgpSaveTools notice must retain its MIT grant and copyright', () => {
    assert.doesNotThrow(() => validateMitLicense(`MIT License
Copyright (c) 2026 Bruno Rodrigues
Permission is hereby granted, free of charge
THE SOFTWARE IS PROVIDED "AS IS"`));
    assert.throws(() => validateMitLicense('MIT License'));
});
