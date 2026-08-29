const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');
const glob = require('glob');

const { setWorkerContext } = require('../src/main/services/backupWorkerContext');
const {
    getAllGameDataFromDB,
    getGameDataFromDB
} = require('../src/main/services/backupWorkerDatabase');
const { resolveTemplatedBackupPath } = require('../src/main/services/backupWorkerPathResolver');
const { getSavePlatformKey } = require('../src/main/services/platformService');

function createGamesDatabase(databasePath) {
    const database = new Database(databasePath);
    database.exec(`
        CREATE TABLE games (
            wiki_page_id INTEGER PRIMARY KEY,
            title TEXT NOT NULL,
            zh_CN TEXT,
            install_folder TEXT,
            steam_id INTEGER,
            gog_id INTEGER,
            platform TEXT,
            save_location TEXT NOT NULL
        );
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)
    `);
    return database;
}

function setTestWorkerContext({ databasePath, backupPath, gameInstalls = [], settings = {} }, progressReporter) {
    setWorkerContext({
        allUserIds: {},
        dbPath: databasePath,
        gameData: {},
        installedDbPath: path.join(path.dirname(databasePath), 'missing-installed-database.db'),
        labels: {
            missingDatabase: 'missing database',
            noBackups: 'no backups'
        },
        placeholderMapping: {},
        settings: {
            backupAllAccounts: false,
            backupPath,
            gameInstalls,
            language: 'en_US',
            saveUninstalledGames: false,
            uninstalledGames: [],
            ...settings
        }
    }, progressReporter);
}

test('installed-folder index preserves every database row sharing a directory', async (context) => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-worker-index-'));
    context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

    const platformKey = getSavePlatformKey();
    assert.notEqual(platformKey, null, `Unsupported test platform: ${process.platform}`);

    const installRoot = path.join(temporaryDirectory, 'installed');
    const installFolder = 'Shared Install Folder';
    const backupPath = path.join(temporaryDirectory, 'backups');
    fs.mkdirSync(path.join(installRoot, installFolder), { recursive: true });
    fs.mkdirSync(backupPath, { recursive: true });

    const databasePath = path.join(temporaryDirectory, 'database.db');
    const database = createGamesDatabase(databasePath);
    const insertGame = database.prepare(`
        INSERT INTO games
            (wiki_page_id, title, zh_CN, install_folder, steam_id, gog_id, platform, save_location)
        VALUES
            (?, ?, NULL, ?, NULL, NULL, ?, ?)
    `);

    for (const wikiId of [801, 802]) {
        const savePath = path.join(temporaryDirectory, 'saves', `${wikiId}.dat`);
        fs.mkdirSync(path.dirname(savePath), { recursive: true });
        fs.writeFileSync(savePath, `save-${wikiId}`);
        const saveLocation = { win: [], mac: [], linux: [], reg: [] };
        saveLocation[platformKey] = [savePath];
        insertGame.run(
            wikiId,
            `Indexed Game ${wikiId}`,
            installFolder,
            JSON.stringify(['Steam']),
            JSON.stringify(saveLocation)
        );
    }
    database.close();

    setTestWorkerContext({ databasePath, backupPath, gameInstalls: [installRoot] });
    const result = await getGameDataFromDB({});

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.games.map(game => game.wiki_page_id).sort(), ['801', '802']);
    assert.ok(result.games.every(game => game.install_path === path.join(installRoot, installFolder)));
});

test('uninstalled games are fetched in bounded batches instead of one query per game', async (context) => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-worker-uninstalled-batch-'));
    context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

    const platformKey = getSavePlatformKey();
    const backupPath = path.join(temporaryDirectory, 'backups');
    const savePath = path.join(temporaryDirectory, 'shared-save.dat');
    fs.mkdirSync(backupPath, { recursive: true });
    fs.writeFileSync(savePath, 'save');

    const databasePath = path.join(temporaryDirectory, 'database.db');
    const database = createGamesDatabase(databasePath);
    const insertGame = database.prepare(`
        INSERT INTO games
            (wiki_page_id, title, zh_CN, install_folder, steam_id, gog_id, platform, save_location)
        VALUES
            (?, ?, NULL, NULL, NULL, NULL, ?, ?)
    `);
    const wikiIds = Array.from({ length: 501 }, (_, index) => String(index + 1000));
    const saveLocation = { win: [], mac: [], linux: [], reg: [] };
    saveLocation[platformKey] = [savePath];
    database.transaction(() => {
        for (const wikiId of wikiIds) {
            insertGame.run(wikiId, `Uninstalled Game ${wikiId}`, '[]', JSON.stringify(saveLocation));
        }
    })();
    database.close();

    setTestWorkerContext({
        databasePath,
        backupPath,
        settings: { saveUninstalledGames: true, uninstalledGames: wikiIds }
    });
    const result = await getGameDataFromDB({});

    assert.deepEqual(result.errors, []);
    assert.equal(result.games.length, wikiIds.length);
    assert.deepEqual(new Set(result.games.map(game => game.wiki_page_id)), new Set(wikiIds));
});

test('full database scan reports progress only when the integer percentage changes', async (context) => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-worker-progress-'));
    context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

    const backupPath = path.join(temporaryDirectory, 'backups');
    fs.mkdirSync(backupPath, { recursive: true });
    const databasePath = path.join(temporaryDirectory, 'database.db');
    const database = createGamesDatabase(databasePath);
    const insertGame = database.prepare(`
        INSERT INTO games
            (wiki_page_id, title, zh_CN, install_folder, steam_id, gog_id, platform, save_location)
        VALUES
            (?, ?, NULL, NULL, NULL, NULL, ?, ?)
    `);
    const emptySaveLocations = JSON.stringify({ win: [], mac: [], linux: [], reg: [] });
    const insertMany = database.transaction(() => {
        for (let index = 1; index <= 250; index += 1) {
            insertGame.run(index, `Progress Game ${index}`, '[]', emptySaveLocations);
        }
    });
    insertMany();
    database.close();

    const progressValues = [];
    setTestWorkerContext({ databasePath, backupPath }, message => progressValues.push(message.value));
    const result = await getAllGameDataFromDB();

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.games, []);
    assert.equal(progressValues.at(-1), 100);
    assert.equal(progressValues.length, new Set(progressValues).size);
    assert.ok(progressValues.every((value, index) => index === 0 || value > progressValues[index - 1]));
    assert.ok(progressValues.length <= 97);
});

test('exact save paths bypass glob traversal', async (context) => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-worker-exact-'));
    context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
    const exactPath = path.join(temporaryDirectory, 'save.dat');
    fs.writeFileSync(exactPath, 'exact save path');

    setWorkerContext({
        allUserIds: {},
        gameData: {},
        placeholderMapping: {},
        settings: { backupAllAccounts: false }
    });

    const originalGlobIterateSync = glob.globIterateSync;
    let globCalls = 0;
    glob.globIterateSync = () => {
        globCalls += 1;
        return [];
    };

    try {
        const resolvedPaths = await resolveTemplatedBackupPath(exactPath, null, false);
        assert.equal(globCalls, 0);
        assert.equal(resolvedPaths.length, 1);
        assert.equal(path.resolve(resolvedPaths[0].resolved), path.resolve(exactPath));
    } finally {
        glob.globIterateSync = originalGlobIterateSync;
    }
});

test('UID expansion has a total combination budget before wildcard fallback', async () => {
    setWorkerContext({
        allUserIds: {
            first: 'uid-1',
            second: 'uid-2',
            third: 'uid-3',
            fourth: 'uid-4',
            fifth: 'uid-5',
            sixth: 'uid-6'
        },
        gameData: {},
        placeholderMapping: {},
        settings: { backupAllAccounts: false }
    });

    const originalGlobIterateSync = glob.globIterateSync;
    const originalLstatSync = fs.lstatSync;
    let exactChecks = 0;
    let globCalls = 0;
    glob.globIterateSync = () => {
        globCalls += 1;
        return [];
    };
    fs.lstatSync = () => {
        exactChecks += 1;
        const error = new Error('missing test path');
        error.code = 'ENOENT';
        throw error;
    };

    try {
        const templatedPath = path.join(
            os.tmpdir(),
            'ogs-uid-budget',
            '{{p|uid}}',
            '{{p|uid}}',
            '{{p|uid}}',
            '{{p|uid}}',
            'save.dat'
        );
        const resolvedPaths = await resolveTemplatedBackupPath(templatedPath, null, false);
        assert.deepEqual(resolvedPaths, []);
        assert.equal(exactChecks, 256);
        assert.equal(globCalls, 1);
    } finally {
        fs.lstatSync = originalLstatSync;
        glob.globIterateSync = originalGlobIterateSync;
    }
});
