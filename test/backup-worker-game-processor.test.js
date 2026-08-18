const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');

const { setWorkerContext } = require('../src/main/services/backupWorkerContext');
const { getGameDataFromDB } = require('../src/main/services/backupWorkerDatabase');
const { processGame } = require('../src/main/services/backupWorkerGameProcessor');
const { getSavePlatformKey } = require('../src/main/services/platformService');
const { XGP_WIKI_IDS_METADATA_KEY } = require('../src/main/xgpSourceFormat');

test('backup worker recognizes a real save file for the current platform', async (context) => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-worker-platform-'));
    context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

    const savePath = path.join(temporaryDirectory, 'save.dat');
    const saveContents = Buffer.from('OpenGameSave platform regression test');
    fs.writeFileSync(savePath, saveContents);

    setWorkerContext({
        allUserIds: {},
        gameData: {},
        placeholderMapping: {},
        settings: {
            backupAllAccounts: false,
            language: 'en_US'
        }
    });

    const platformKey = getSavePlatformKey();
    assert.notEqual(platformKey, null, `Unsupported test platform: ${process.platform}`);
    const saveLocation = { win: [], mac: [], linux: [], reg: [] };
    saveLocation[platformKey] = [savePath];

    const game = await processGame({
        install_path: null,
        save_location: saveLocation,
        title: 'Platform Regression Test'
    });

    assert.equal(game.resolved_paths.length, 1);
    assert.equal(path.resolve(game.resolved_paths[0].resolved), path.resolve(savePath));
    assert.equal(game.backup_size, saveContents.byteLength);
});

test('database-backed worker query returns an installed game with a current-platform save', async (context) => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-worker-database-'));
    context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

    const installRoot = path.join(temporaryDirectory, 'installed');
    const installFolder = 'Regression Game';
    const savePath = path.join(temporaryDirectory, 'saves', 'save.dat');
    const backupPath = path.join(temporaryDirectory, 'backups');
    fs.mkdirSync(path.join(installRoot, installFolder), { recursive: true });
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.mkdirSync(path.join(backupPath, '501', '2026-01-01_12-00-00'), { recursive: true });
    fs.mkdirSync(path.join(backupPath, '501', '2026-01-02_12-00-00'), { recursive: true });
    fs.writeFileSync(savePath, 'database worker regression save');

    const platformKey = getSavePlatformKey();
    assert.notEqual(platformKey, null, `Unsupported test platform: ${process.platform}`);
    const saveLocation = { win: [], mac: [], linux: [], reg: [] };
    saveLocation[platformKey] = [savePath];

    const databasePath = path.join(temporaryDirectory, 'database.db');
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
        )
    `);
    database.prepare(`
        INSERT INTO games
            (wiki_page_id, title, zh_CN, install_folder, steam_id, gog_id, platform, save_location)
        VALUES
            (?, ?, NULL, ?, NULL, NULL, ?, ?)
    `).run(501, 'Database Worker Regression', installFolder, JSON.stringify(['Steam']), JSON.stringify(saveLocation));
    database.close();

    setWorkerContext({
        allUserIds: {},
        dbPath: databasePath,
        gameData: {},
        installedDbPath: path.join(temporaryDirectory, 'missing-installed-database.db'),
        labels: {
            missingDatabase: 'missing database',
            noBackups: 'no backups'
        },
        placeholderMapping: {},
        settings: {
            backupAllAccounts: false,
            backupPath,
            gameInstalls: [installRoot],
            language: 'en_US',
            saveUninstalledGames: false,
            uninstalledGames: []
        }
    });

    const result = await getGameDataFromDB({ wikiId: '501' });

    assert.deepEqual(result.errors, []);
    assert.equal(result.games.length, 1);
    assert.equal(result.games[0].wiki_page_id, '501');
    assert.equal(result.games[0].resolved_paths.length, 1);
    assert.ok(result.games[0].backup_size > 0);
    assert.equal(result.games[0].latest_backup, '2026/01/02 12:00:00');
});

test('database metadata mounts only reviewed XgpSaveTools candidates without an install path', async (context) => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-worker-xgp-mount-'));
    context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

    const savePath = path.join(temporaryDirectory, 'xbox-save', 'save.dat');
    const backupPath = path.join(temporaryDirectory, 'backups');
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.mkdirSync(backupPath, { recursive: true });
    fs.writeFileSync(savePath, 'reviewed Xbox mapping');

    const platformKey = getSavePlatformKey();
    assert.notEqual(platformKey, null, `Unsupported test platform: ${process.platform}`);
    const saveLocation = { win: [], mac: [], linux: [], reg: [] };
    saveLocation[platformKey] = [savePath];

    const databasePath = path.join(temporaryDirectory, 'database.db');
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
    const insertGame = database.prepare(`
        INSERT INTO games
            (wiki_page_id, title, zh_CN, install_folder, steam_id, gog_id, platform, save_location)
        VALUES
            (?, ?, NULL, NULL, NULL, NULL, ?, ?)
    `);
    insertGame.run(701, 'Mounted Xbox Game', JSON.stringify(['Xbox']), JSON.stringify(saveLocation));
    insertGame.run(702, 'Unreviewed Xbox Game', JSON.stringify(['Xbox']), JSON.stringify(saveLocation));
    database.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)')
        .run(XGP_WIKI_IDS_METADATA_KEY, JSON.stringify(['701']));
    database.close();

    setWorkerContext({
        allUserIds: {},
        dbPath: databasePath,
        gameData: {},
        installedDbPath: path.join(temporaryDirectory, 'missing-installed-database.db'),
        labels: {
            missingDatabase: 'missing database',
            noBackups: 'no backups'
        },
        placeholderMapping: {},
        settings: {
            backupAllAccounts: false,
            backupPath,
            gameInstalls: [],
            language: 'en_US',
            saveUninstalledGames: false,
            uninstalledGames: []
        }
    });

    const result = await getGameDataFromDB({});
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.games.map(game => game.wiki_page_id), ['701']);
    assert.equal(result.games[0].resolved_paths.length, 1);
});
