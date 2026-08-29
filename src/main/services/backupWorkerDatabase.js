const fs = require('fs');
const fsOriginal = fs;
const path = require('path');

const fse = require('fs-extra');

const { getNewestBackup: getNewestBackupFromPath } = require('../fileSystemUtils');
const { closeDb, dbAll, dbGet, openDb } = require('../sqliteUtils');
const { assertNoSymlinkAncestors, isPathInside, normalizeWikiId } = require('../validation');
const { XGP_WIKI_IDS_METADATA_KEY } = require('../xgpSourceFormat');
const {
    getContext,
    getSettings,
    reportProgress
} = require('./backupWorkerContext');
const { processGame } = require('./backupWorkerGameProcessor');
const { getPlatformSaveLocations, getSavePlatformKey } = require('./platformService');

const MAX_SQLITE_QUERY_PARAMETERS = 500;

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

async function getRowsByWikiIds(db, wikiIds) {
    const rows = [];
    for (let offset = 0; offset < wikiIds.length; offset += MAX_SQLITE_QUERY_PARAMETERS) {
        const chunk = wikiIds.slice(offset, offset + MAX_SQLITE_QUERY_PARAMETERS);
        const placeholders = chunk.map(() => '?').join(',');
        rows.push(...await dbAll(db, `SELECT * FROM games WHERE wiki_page_id IN (${placeholders})`, chunk));
    }
    return rows;
}

async function processAndPushGame(row, games) {
    const processed = await processGame(row);
    if (processed.resolved_paths.length !== 0) {
        games.push(processed);
    }
}

async function processXboxCandidateGames(db, games, errors) {
    const metadata = await dbGet(db, 'SELECT value FROM metadata WHERE key = ?', [XGP_WIKI_IDS_METADATA_KEY]);
    let wikiIds;
    try {
        wikiIds = JSON.parse(metadata?.value || '[]');
    } catch (_) {
        return;
    }
    if (!Array.isArray(wikiIds) || wikiIds.length === 0 || wikiIds.length > 1000
        || wikiIds.some(value => !Number.isSafeInteger(Number(value)) || Number(value) < 0)) {
        return;
    }

    const processedWikiIds = new Set(games.map(game => game.wiki_page_id));
    const placeholders = wikiIds.map(() => '?').join(',');
    const rows = await dbAll(db, `SELECT * FROM games WHERE wiki_page_id IN (${placeholders})`, wikiIds);
    for (const row of rows) {
        const wikiPageId = String(row.wiki_page_id);
        if (processedWikiIds.has(wikiPageId)) continue;

        try {
            parseDbRow(row);
            const previousLength = games.length;
            await processAndPushGame(row, games);
            if (games.length > previousLength) processedWikiIds.add(wikiPageId);
        } catch (error) {
            console.error(`Error processing Xbox candidate game ${row.title}: ${error.stack}`);
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

    try {
        const rowsByInstallFolder = new Map();
        const installedRows = await dbAll(db, 'SELECT * FROM games WHERE install_folder IS NOT NULL');
        for (const row of installedRows) {
            const installFolderRows = rowsByInstallFolder.get(row.install_folder);
            if (installFolderRows) {
                installFolderRows.push(row);
            } else {
                rowsByInstallFolder.set(row.install_folder, [row]);
            }
        }

        for (const installPath of gameInstallPaths) {
            if (!fsOriginal.existsSync(installPath)) continue;
            const directories = fsOriginal.readdirSync(installPath, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory())
                .map(dirent => dirent.name);

            for (const dir of directories) {
                if (processedInstallPaths.has(dir)) continue;
                processedInstallPaths.add(dir);

                const rows = rowsByInstallFolder.get(dir);
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

        await processXboxCandidateGames(db, games, errors);

        if (!ignoreUninstalled && getSettings().saveUninstalledGames) {
            const uninstalledWikiIds = getSettings().uninstalledGames || [];
            const processedWikiIds = new Set(games.map(game => game.wiki_page_id));
            const remainingUninstalledWikiIds = uninstalledWikiIds.filter(id => !processedWikiIds.has(id));

            const remainingRows = await getRowsByWikiIds(db, remainingUninstalledWikiIds);
            for (const row of remainingRows) {
                try {
                    parseDbRow(row);
                    await processAndPushGame(row, games);
                } catch (err) {
                    console.error(`Error processing uninstalled game ${getGameDisplayName(row)}: ${err.stack}`);
                    errors.push(`Error processing ${getGameDisplayName(row)}: ${err.message}`);
                }
            }

            return { games, errors, remainingUninstalledWikiIds };
        }
    } catch (error) {
        console.error(`Error displaying backup table: ${error.stack}`);
        errors.push(`Error displaying backup table: ${error.message}`);
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
        let lastReportedProgress = -1;

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
            if (dbProgress !== lastReportedProgress) {
                reportProgress(dbProgress);
                lastReportedProgress = dbProgress;
            }
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

async function getTrustedRestoreDefinition({ wikiId }) {
    const safeWikiId = normalizeWikiId(wikiId);
    if (!await ensureDatabase()) throw new Error(getContext().labels.missingDatabase);
    const db = await openDb(getContext().dbPath, { readonly: true, fileMustExist: true });
    try {
        const row = await dbGet(
            db,
            'SELECT install_folder, save_location FROM games WHERE wiki_page_id = ?',
            [safeWikiId]
        );
        if (!row) throw new Error('Game is not present in the current database');
        const saveLocation = JSON.parse(row.save_location);
        if (!saveLocation || typeof saveLocation !== 'object' || Array.isArray(saveLocation)) {
            throw new Error('Game has an invalid save-location definition');
        }
        const fileTemplates = getPlatformSaveLocations(saveLocation);
        const registryTemplates = getSavePlatformKey() === 'win' && Array.isArray(saveLocation.reg)
            ? saveLocation.reg.filter(template => typeof template === 'string')
            : [];

        let trustedInstallPath = null;
        if (typeof row.install_folder === 'string' && row.install_folder.length > 0) {
            const installRoots = Array.isArray(getSettings().gameInstalls) ? getSettings().gameInstalls : [];
            for (const installRoot of installRoots) {
                if (typeof installRoot !== 'string' || !path.isAbsolute(installRoot)) continue;
                const resolvedRoot = path.resolve(installRoot);
                const candidate = path.resolve(resolvedRoot, row.install_folder);
                if (candidate !== resolvedRoot && isPathInside(resolvedRoot, candidate)
                    && fsOriginal.existsSync(candidate)) {
                    try {
                        await assertNoSymlinkAncestors(resolvedRoot, candidate, fsOriginal);
                        const stats = fsOriginal.lstatSync(candidate);
                        if (stats.isDirectory() && !stats.isSymbolicLink()) {
                            trustedInstallPath = candidate;
                            break;
                        }
                    } catch (_) {
                        // A broken or linked candidate must not prevent a later
                        // configured install root from providing the real game path.
                    }
                }
            }
        }

        return {
            fileTemplates,
            registryTemplates,
            trustedInstallPath
        };
    } finally {
        await closeDb(db);
    }
}

module.exports = { getAllGameDataFromDB, getGameDataFromDB, getTrustedRestoreDefinition };
