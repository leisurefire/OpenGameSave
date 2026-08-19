const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createEpicLaunchUri,
    createSteamArtUrls,
    createSteamLaunchUri
} = require('../src/main/services/libraryService');

test('library launch URIs are built only from constrained provider identifiers', () => {
    assert.equal(createSteamLaunchUri('570'), 'steam://rungameid/570');
    assert.equal(
        createEpicLaunchUri('Fortnite.Release'),
        'com.epicgames.launcher://apps/Fortnite.Release?action=launch&silent=true'
    );
    assert.throws(() => createSteamLaunchUri('570?open=https://example.com'), /Invalid Steam app id/);
    assert.throws(() => createEpicLaunchUri('../unsafe'), /Invalid Epic app name/);
    assert.throws(() => createEpicLaunchUri('game?action=install'), /Invalid Epic app name/);
});

test('Steam artwork fallback is constrained to official static asset URLs', () => {
    assert.deepEqual(createSteamArtUrls('322330', 'cover'), [
        'https://cdn.akamai.steamstatic.com/steam/apps/322330/library_600x900_2x.jpg',
        'https://cdn.akamai.steamstatic.com/steam/apps/322330/library_600x900.jpg'
    ]);
    assert.deepEqual(createSteamArtUrls('322330', 'hero'), [
        'https://cdn.akamai.steamstatic.com/steam/apps/322330/library_hero.jpg'
    ]);
    assert.throws(() => createSteamArtUrls('322330/path', 'cover'), /Invalid Steam app id/);
    assert.throws(() => createSteamArtUrls('322330', 'logo'), /Invalid Steam artwork type/);
});
