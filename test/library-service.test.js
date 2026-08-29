const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    createEpicLaunchUri,
    createSteamArtUrls,
    createSteamLaunchUri,
    resolveSteamInstallPath
} = require('../src/main/services/libraryService');
const {
    EPIC_METADATA_URL,
    MAX_BATTLENET_INDEX_ENTRIES,
    addBattleNetFiles,
    createBoundedOperationRunner,
    createEpicProductUrl,
    createGogMetadataUrl,
    extractEpicArtUrls,
    extractGogArtUrls,
    extractOpenGraphImageUrls,
    findBattleNetLocalArt,
    findEpicManifestArt,
    findGogLocalArt,
    inspectTrustedArtFile,
    isAllowedOfficialUrl
} = require('../src/main/services/libraryArtworkService');

const MINIMAL_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const MINIMAL_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function temporaryDirectory(context) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-library-art-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function writeFixture(filePath, contents = MINIMAL_JPEG) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
    return filePath;
}

test('artwork I/O concurrency and queued work remain bounded', async () => {
    const run = createBoundedOperationRunner(2, 1);
    let active = 0;
    let peakActive = 0;
    const releases = [];
    const operation = () => run(async () => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await new Promise((resolve) => {
            releases.push(resolve);
        });
        active -= 1;
    });

    const first = operation();
    const second = operation();
    const queued = operation();
    await assert.rejects(operation(), /queue is full/);
    assert.equal(peakActive, 2);

    releases.shift()();
    await new Promise((resolve) => {
        setImmediate(resolve);
    });
    assert.equal(peakActive, 2);
    releases.shift()();
    releases.shift()();
    await Promise.all([first, second, queued]);
});

test('Battle.net artwork indexing stops at its explicit descriptor budget', () => {
    const index = new Map();
    const files = Object.fromEntries(Array.from({ length: 5 }, (_, indexValue) => [
        `GAME_KEY_ART_${indexValue}`,
        { hash: String(indexValue).padStart(32, 'a'), name: `${indexValue}.jpg` }
    ]));
    const budget = { remaining: 2 };

    assert.equal(addBattleNetFiles(index, 'cache', files, 0, budget), false);
    assert.equal([...index.values()].flat().length, 2);
    assert.equal(budget.remaining, 0);
    assert.ok(MAX_BATTLENET_INDEX_ENTRIES >= 2);
});

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

test('Steam install paths cannot escape the library or reference missing content', (context) => {
    const root = temporaryDirectory(context);
    const steamAppsRoot = path.join(root, 'steamapps');
    const installed = path.join(steamAppsRoot, 'common', 'Installed Game');
    fs.mkdirSync(installed, { recursive: true });
    assert.equal(resolveSteamInstallPath(steamAppsRoot, 'Installed Game'), path.resolve(installed));
    assert.equal(resolveSteamInstallPath(steamAppsRoot, '..\\escape'), null);
    assert.equal(resolveSteamInstallPath(steamAppsRoot, 'Missing Game'), null);
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

test('Epic artwork prefers trusted manifest paths and constrains official fallback metadata', (context) => {
    const root = temporaryDirectory(context);
    const installPath = path.join(root, 'Game');
    const manifestPath = path.join(root, 'Manifests', 'sample.item');
    const coverPath = writeFixture(path.join(root, 'Manifests', 'cached-cover.jpg'));
    const outsidePath = writeFixture(path.join(root, 'outside-hero.jpg'));
    fs.mkdirSync(installPath, { recursive: true });
    writeFixture(manifestPath, Buffer.from('{}'));

    const localArt = findEpicManifestArt({
        CoverImagePath: 'cached-cover.jpg',
        HeroImagePath: outsidePath
    }, manifestPath, installPath);
    assert.equal(localArt.coverPath, fs.realpathSync(coverPath));
    assert.equal(localArt.heroPath, null);

    const official = extractEpicArtUrls({ pages: [{
        type: 'productHome',
        item: { namespace: 'sample', appName: 'Sample.Release' },
        data: { hero: {
            portraitBackgroundImageUrl: 'https://cdn2.unrealengine.com/sample-1200x1600.jpg',
            backgroundImageUrl: 'https://cdn1.unrealengine.com/sample-2560x1440.jpg'
        } },
        _images_: ['https://attacker.example/escape.jpg']
    }] }, 'sample', 'Sample.Release');
    assert.deepEqual(official.cover, [
        'https://cdn2.unrealengine.com/sample-1200x1600.jpg',
        'https://cdn1.unrealengine.com/sample-2560x1440.jpg'
    ]);
    assert.deepEqual(official.hero, [
        'https://cdn1.unrealengine.com/sample-2560x1440.jpg',
        'https://cdn2.unrealengine.com/sample-1200x1600.jpg'
    ]);
    assert.equal(EPIC_METADATA_URL, 'https://store-content.ak.epicgames.com/api/content/productmapping');
    assert.equal(isAllowedOfficialUrl(
        'Epic',
        'artwork',
        'https://cdn2-unrealengine-1251447533.file.myqcloud.com/official.jpg'
    ), true);
    assert.equal(
        createEpicProductUrl('sample-game'),
        'https://store-content.ak.epicgames.com/api/en-US/content/products/sample-game'
    );
    assert.throws(() => createEpicProductUrl('../escape'), /Invalid Epic product slug/);
});

test('GOG artwork prefers installation metadata and accepts only GOG official image hosts', (context) => {
    const root = temporaryDirectory(context);
    const installPath = path.join(root, 'GOG Game');
    const coverPath = writeFixture(path.join(installPath, 'goggame-1207664643.jpg'));
    const outsidePath = writeFixture(path.join(root, 'outside.png'), MINIMAL_PNG);
    const localArt = findGogLocalArt({
        cover: coverPath,
        background: outsidePath
    }, '1207664643', installPath);
    assert.equal(localArt.coverPath, fs.realpathSync(coverPath));
    assert.equal(localArt.heroPath, null);

    const official = extractGogArtUrls({ images: {
        coverVertical: '//images.gog-statics.com/cover.jpg',
        background: 'https://images-4.gog-statics.com/background.webp',
        icon: 'https://example.com/not-gog.png'
    } });
    assert.deepEqual(official.cover, [
        'https://images.gog-statics.com/cover.jpg',
        'https://images-4.gog-statics.com/background.webp'
    ]);
    assert.deepEqual(official.hero, [
        'https://images-4.gog-statics.com/background.webp',
        'https://images.gog-statics.com/cover.jpg'
    ]);
    assert.equal(createGogMetadataUrl('1207664643'), 'https://api.gog.com/products/1207664643?locale=en-US');
    assert.throws(() => createGogMetadataUrl('120/escape'), /Invalid GOG product id/);
});

test('Battle.net artwork resolves hashed local catalog assets and audits official page fallback', (context) => {
    const cacheRoot = temporaryDirectory(context);
    const manifestHash = '00112233445566778899aabbccddeeff';
    const coverHash = '112233445566778899aabbccddeeff00';
    const heroHash = '2233445566778899aabbccddeeff0011';
    writeFixture(path.join(cacheRoot, coverHash.slice(0, 2), coverHash.slice(2, 4), coverHash));
    writeFixture(path.join(cacheRoot, heroHash.slice(0, 2), heroHash.slice(2, 4), heroHash), MINIMAL_PNG);
    const manifestPath = path.join(cacheRoot, manifestHash.slice(0, 2), manifestHash.slice(2, 4), manifestHash);
    writeFixture(manifestPath, Buffer.from(JSON.stringify({ files: { default: {
        'overwatch#PRO_KEY_ART': { hash: coverHash, name: 'resources/pro/key_art.jpg' },
        'overwatch#PRO_BACKGROUND': { hash: heroHash, name: 'resources/pro/background.png' },
        'overwatch#OTHER_BACKGROUND': { hash: '../escape', name: 'resources/other/background.png' }
    } } })));

    const localArt = findBattleNetLocalArt(cacheRoot, ['#PRO_']);
    assert.equal(localArt.coverPath, fs.realpathSync(path.join(
        cacheRoot, coverHash.slice(0, 2), coverHash.slice(2, 4), coverHash
    )));
    assert.equal(localArt.heroPath, fs.realpathSync(path.join(
        cacheRoot, heroHash.slice(0, 2), heroHash.slice(2, 4), heroHash
    )));

    const official = extractOpenGraphImageUrls(`
        <meta content="https://blz-contentstack-images.akamaized.net/v3/assets/official.webp"
              property="og:image">
        <meta property="og:image" content="https://attacker.example/escape.jpg">
    `, 'https://overwatch.blizzard.com/');
    assert.deepEqual(official, [
        'https://blz-contentstack-images.akamaized.net/v3/assets/official.webp'
    ]);
    assert.equal(isAllowedOfficialUrl('Blizzard', 'metadata', 'https://overwatch.blizzard.com/'), true);
    assert.equal(isAllowedOfficialUrl('Blizzard', 'metadata', 'https://blizzard.com.attacker.example/'), false);
});

test('local artwork validation rejects symlinks, non-images and oversized files', (context) => {
    const root = temporaryDirectory(context);
    const imagePath = writeFixture(path.join(root, 'cover.bin'));
    const textPath = writeFixture(path.join(root, 'cover.jpg'), Buffer.from('not an image'));
    assert.equal(inspectTrustedArtFile(imagePath, [root]).mimeType, 'image/jpeg');
    assert.equal(inspectTrustedArtFile(textPath, [root]), null);

    const linkPath = path.join(root, 'linked.jpg');
    try {
        fs.symlinkSync(imagePath, linkPath, 'file');
        assert.equal(inspectTrustedArtFile(linkPath, [root]), null);
    } catch (error) {
        if (error.code !== 'EPERM') throw error;
    }
});
