const fs = require('fs');
const fsOriginal = fs;
const path = require('path');

const fse = require('fs-extra');

const { getNewestBackup: getNewestBackupFromPath } = require('../fileSystemUtils');
const { closeDb, dbAll, openDb, stmtAll } = require('../sqliteUtils');
const { mergeXgpEntriesIntoGameRow, normalizeTitleKey } = require('../xgpSourceFormat');
const {
    getContext,
    getSettings,
    getXgpEntryIndex,
    reportProgress
} = require('./backupWorkerContext');
const { processGame } = require('./backupWorkerGameProcessor');

function getGameDisplayName(gameObj) {
    return getSettings().language === 'zh_CN' ? gameObj.zh_CN || gameObj.title : gameObj.title;
}

function getNewestBackup(wikiPageId) {
    return getNewestBackupFromPath(wikiPageId, {
        backupPath: getSettings().backupPath,
        noBackupsLabel: getContext().labels.noBackups,
        fsAdapter: fsOriginal
    });
}

async function ensureDatabase() {
    const dbPath = getContext().dbPath;
    if (fs.existsSync(dbPath)) {
        return true;
    }

    if (!fs.existsSync(getContext().installedDbPath)) {
        return false;
    }

    await fse.ensureDir(path.dirname(dbPath));
    await fse.copy(getContext().installedDbPath, dbPath);
    return true;
}

function parseDbRow(row) {
    row.wiki_page_id = row.wiki_page_id.toString();
    row.platform = JSON.parse(row.platform);
    row.save_location = JSON.parse(row.save_location);
    mergeXgpEntriesIntoGameRow(row, getXgpEntryIndex());
    row.latest_backup = getNewestBackup(row.wiki_page_id);
}

function findInstallPath(row, gameInstallPaths) {
    if (!row.install_folder) return false;

    for (const installPath of gameInstallPaths) {
        const potentialPath = path.join(installPath, row.install_folder);
        if (fsOriginal.existsSync(potentialPath)) {
            row.install_path = potentialPath;
            return true;
        }
    }
    return false;
}

async function processAndPushGame(row, games) {
    const processed = await processGame(row);
    if (processed.resolved_paths.length !== 0) {
        games.push(processed);
    }
}

async function processXgpCandidateGames(db, games, errors) {
    if (getXgpEntryIndex().size === 0) return;

    const processedWikiIds = new Set(games.map(game => game.wiki_page_id));
    const rows = await dbAll(db, 'SELECT * FROM games');
    for (const row of rows) {
        const wikiPageId = String(row.wiki_page_id);
        if (processedWikiIds.has(wikiPageId) || !getXgpEntryIndex().has(normalizeTitleKey(row.title))) continue;

        try {
            parseDbRow(row);
            const previousLength = games.length;
            await processAndPushGame(row, games);
            if (games.length > previousLength) processedWikiIds.add(wikiPageId);
        } catch (error) {
            console.error(`Error processing experimental XgpSaveTools game ${row.title}: ${error.stack}`);
            errors.push(`Error processing ${row.title}: ${error.message}`);
        }
    }
}

async function getGameDataFromDB({ ignoreUninstalled = false, wikiId = null }) {
    const games = [];
    const errors = [];
    const dbReady = await ensureDatabase();
    if (!dbReady) {
        return { games, errors: [getContext().labels.missingDatabase] };
    }

    const db = await openDb(getContext().dbPath, { readonly: true, fileMustExist: true });
    const gameInstallPaths = Array.isArray(getSettings().gameInstalls) ? getSettings().gameInstalls : [];

    if (wikiId) {
        try {
            const rows = await dbAll(db, 'SELECT * FROM games WHERE wiki_page_id = ?', [wikiId]);
            if (rows && rows.length > 0) {
                const row = rows[0];
                parseDbRow(row);
                const isInstalled = findInstallPath(row, gameInstallPaths);

                if (!isInstalled) {
                    if (ignoreUninstalled || !getSettings().saveUninstalledGames) {
                        return { games, errors };
                    }
                    const uninstalledWikiIds = (getSettings().uninstalledGames || []).map(String);
                    if (!uninstalledWikiIds.includes(row.wiki_page_id)) {
                        return { games, errors };
                    }
                }

                await processAndPushGame(row, games);
            }
        } catch (error) {
            console.error(`Error fetching single game data for ${wikiId}: ${error.stack}`);
            errors.push(`Error processing ${wikiId}: ${error.message}`);
        } finally {
            await closeDb(db);
        }
        return { games, errors };
    }

    const processedInstallPaths = new Set();
    let stmtInstallFolder;

    try {
        stmtInstallFolder = db.prepare('SELECT * FROM games WHERE install_folder = ?');

        for (const installPath of gameInstallPaths) {
            if (!fsOriginal.existsSync(installPath)) continue;
            const directories = fsOriginal.readdirSync(installPath, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory())
                .map(dirent => dirent.name);

            for (const dir of directories) {
                if (processedInstallPaths.has(dir)) continue;
                processedInstallPaths.add(dir);

                const rows = await stmtAll(stmtInstallFolder, dir);
                if (rows && rows.length > 0) {
                    for (const row of rows) {
                        try {
                            parseDbRow(row);
                            row.install_path = path.join(installPath, dir);
                            await processAndPushGame(row, games);
                        } catch (err) {
                            console.error(`Error processing installed game ${getGameDisplayName(row)}: ${err.stack}`);
                            errors.push(`Error processing ${getGameDisplayName(row)}: ${err.message}`);
                        }
                    }
                }
            }
        }

        stmtInstallFolder = null;

        await processXgpCandidateGames(db, games, errors);

        if (!ignoreUninstalled && getSettings().saveUninstalledGames) {
            const uninstalledWikiIds = getSettings().uninstalledGames || [];
            const processedWikiIds = new Set(games.map(game => game.wiki_page_id));
            const remainingUninstalledWikiIds = uninstalledWikiIds.filter(id => !processedWikiIds.has(id));

            for (const remainingWikiId of remainingUninstalledWikiIds) {
                const rows = await dbAll(db, 'SELECT * FROM games WHERE wiki_page_id = ?', [remainingWikiId]);
                if (rows && rows.length > 0) {
                    for (const row of rows) {
                        try {
                            parseDbRow(row);
                            await processAndPushGame(row, games);
                        } catch (err) {
                            console.error(`Error processing uninstalled game ${getGameDisplayName(row)}: ${err.stack}`);
                            errors.push(`Error processing ${getGameDisplayName(row)}: ${err.message}`);
                        }
                    }
                }
            }

            return { games, errors, remainingUninstalledWikiIds };
        }
    } catch (error) {
        console.error(`Error displaying backup table: ${error.stack}`);
        errors.push(`Error displaying backup table: ${error.message}`);
        stmtInstallFolder = null;
    } finally {
        await closeDb(db);
    }

    return { games, errors };
}

async function getAllGameDataFromDB() {
    const games = [];
    const errors = [];
    const dbReady = await ensureDatabase();
    if (!dbReady) {
        return { games, errors: [getContext().labels.missingDatabase] };
    }

    const db = await openDb(getContext().dbPath, { readonly: true, fileMustExist: true });

    try {
        const rows = await dbAll(db, 'SELECT * FROM games');
        const totalRows = rows.length;
        let processedRows = 0;

        for (const row of rows) {
            try {
                parseDbRow(row);
                await processAndPushGame(row, games);
            } catch (err) {
                console.error(`Error processing database game ${getGameDisplayName(row)}: ${err.stack}`);
                errors.push(`Error processing ${getGameDisplayName(row)}: ${err.message}`);
            }

            processedRows += 1;
            const dbProgress = totalRows ? Math.floor((processedRows / totalRows) * 95) : 95;
            reportProgress(dbProgress);
        }

        reportProgress(100);
    } catch (error) {
        console.error(`Error displaying backup table: ${error.stack}`);
        errors.push(`Error displaying backup table: ${error.message}`);
    } finally {
        await closeDb(db);
    }

    return { games, errors };
}

module.exports = { getAllGameDataFromDB, getGameDataFromDB };
