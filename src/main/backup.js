const { app } = require('electron');
const { Worker } = require('worker_threads');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const axios = require('axios');
const i18next = require('i18next');

const {
    getMainWin, getStatus, updateStatus,
    placeholder_mapping, getSettings, saveSettings, showBackgroundNotification
} = require('./global');
const { getGameData, getAllUserIds } = require('./gameData');
const { dbRun, dbGet, dbAll, openDb, closeDb } = require('./sqliteUtils');
const { acquireGameOperation } = require('./gameOperationLock');
const { acquireDatabaseWrite, runWithDatabaseRead } = require('./databaseOperationLock');
const { WorkerTaskPool } = require('./services/workerTaskPool');
const { validateDatabasePatch } = require('./validation');
const {
    atomicInstallDatabase,
    createNewDatabasePath,
    normalizeSha256,
    recoverDatabaseFiles,
    verifyFileDescriptor
} = require('./databaseUpdateFiles');
const {
    MAX_DATABASE_DOWNLOAD_BYTES,
    MAX_PATCH_DOWNLOAD_BYTES,
    DATABASE_VARIANT_METADATA_KEY,
    getDatabaseAssetNames,
    normalizeDatabaseVariant,
    validateAssetDescriptor,
    validateDatabaseManifest
} = require('./databaseManifest');

const DB_RELEASE_API_URL = 'https://api.github.com/repos/leisurefire/OpenGameSave/releases/tags/database';
const DATABASE_READ_WORKER_TASKS = new Set([
    'getGameDataFromDB',
    'getAllGameDataFromDB',
    'getGameDataForRestore',
    'getTrustedRestoreDefinition'
]);
const backupWorkerPool = new WorkerTaskPool({
    createWorker: () => new Worker(path.join(__dirname, 'backupWorker.js')),
    maxWorkers: 2,
    maxQueue: 64,
    name: 'Backup worker'
});

function getInstalledDatabasePath() {
    return app.isPackaged
        ? path.join(path.dirname(app.getPath('exe')), 'database', 'database.db')
        : path.join(app.getAppPath(), 'database', 'database.db');
}

function getUserDatabasePath() {
    return path.join(app.getPath('userData'), 'OGS Database', 'database.db');
}

function validateReleaseAssetUrl(rawUrl) {
    const url = new URL(rawUrl);
    const expectedPrefix = '/leisurefire/OpenGameSave/releases/download/';
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith(expectedPrefix)) {
        throw new Error('Release contains an untrusted asset URL');
    }
    return url.toString();
}

function createBackupWorkerContext() {
    const currentGameData = getGameData();
    const currentSettings = getSettings();

    return {
        settings: currentSettings,
        gameData: {
            steamPath: currentGameData.steamPath,
            ubisoftPath: currentGameData.ubisoftPath,
            currentSteamUserId3: currentGameData.currentSteamUserId3,
            currentUbisoftUserId: currentGameData.currentUbisoftUserId
        },
        allUserIds: getAllUserIds(),
        dbPath: getUserDatabasePath(),
        installedDbPath: getInstalledDatabasePath(),
        placeholderMapping: placeholder_mapping,
        labels: {
            noBackups: i18next.t('main.no_backups'),
            missingDatabase: i18next.t('alert.missing_database_file_message')
        }
    };
}

function runBackupWorkerTask(task, payload = {}, onMessage = null) {
    return backupWorkerPool.run({
        task,
        payload,
        context: createBackupWorkerContext()
    }, onMessage);
}

function shutdownBackupWorkers() {
    return backupWorkerPool.shutdown();
}

/**
 * 读取本地数据库的 PRAGMA user_version
 */
async function getLocalDbVersion(dbPath) {
    if (!fs.existsSync(dbPath)) return 0;
    const db = await openDb(dbPath, { readonly: true, fileMustExist: true });
    try {
        const row = await dbGet(db, 'PRAGMA user_version');
        return row ? row.user_version : 0;
    } finally {
        await closeDb(db);
    }
}

/**
 * 将一个补丁 JSON 应用到数据库
 */
async function validateDatabaseFile(dbPath, expectedVersion, expectedSchemaVersion, expectedVariant) {
    const stats = await fs.promises.stat(dbPath);
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_DATABASE_DOWNLOAD_BYTES) {
        throw new Error('Downloaded database has an invalid size');
    }
    const db = await openDb(dbPath, { readonly: true, fileMustExist: true });
    try {
        const integrity = await dbGet(db, 'PRAGMA quick_check');
        if (!integrity || integrity.quick_check !== 'ok') {
            throw new Error('Downloaded database failed its integrity check');
        }
        const requiredTables = await dbGet(db, `
            SELECT COUNT(*) AS count FROM sqlite_master
            WHERE type = 'table' AND name IN ('games', 'metadata')
        `);
        if (!requiredTables || requiredTables.count !== 2) {
            throw new Error('Downloaded database is missing a required table');
        }
        const gameColumns = await dbAll(db, 'PRAGMA table_info(games)');
        const metadataColumns = await dbAll(db, 'PRAGMA table_info(metadata)');
        const requiredGameColumns = ['wiki_page_id', 'title', 'zh_CN', 'install_folder', 'steam_id', 'gog_id', 'platform', 'save_location'];
        const gameColumnNames = new Set(gameColumns.map(column => column.name));
        if (requiredGameColumns.some(column => !gameColumnNames.has(column))
            || !metadataColumns.some(column => column.name === 'key')
            || !metadataColumns.some(column => column.name === 'value')) {
            throw new Error('Downloaded database has an unsupported table structure');
        }
        const schemaRows = await dbAll(db, `
            SELECT type, name, tbl_name, sql FROM sqlite_master
            WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
        `);
        const schemaVersion = crypto.createHash('sha256').update(JSON.stringify(schemaRows)).digest('hex');
        if (expectedSchemaVersion !== undefined && schemaVersion !== expectedSchemaVersion) {
            throw new Error('Downloaded database schema does not match the manifest');
        }
        const versionRow = await dbGet(db, 'PRAGMA user_version');
        const version = versionRow?.user_version || 0;
        if (expectedVersion !== undefined && version !== expectedVersion) {
            throw new Error('Downloaded database user_version does not match the manifest');
        }
        const variantRow = await dbGet(db, 'SELECT value FROM metadata WHERE key = ?', [DATABASE_VARIANT_METADATA_KEY]);
        const variant = normalizeDatabaseVariant(variantRow?.value ?? 'standard');
        if (expectedVariant !== undefined && variant !== normalizeDatabaseVariant(expectedVariant)) {
            throw new Error('Downloaded database variant does not match the selected variant');
        }
        return { version, schemaVersion, variant };
    } finally {
        await closeDb(db);
    }
}

async function applyPatch(dbPath, rawPatch, expectedVersion, expectedFromVersion, expectedVariant) {
    const patch = validateDatabasePatch(rawPatch, expectedVersion, expectedFromVersion, expectedVariant);
    const db = await openDb(dbPath, { fileMustExist: true });
    try {
        const currentVersion = (await dbGet(db, 'PRAGMA user_version'))?.user_version || 0;
        if (currentVersion !== patch.from_version) {
            throw new Error('Database patch source version does not match the staged database');
        }
        await dbRun(db, 'BEGIN TRANSACTION');

        // upsert
        if (patch.upsert && patch.upsert.length > 0) {
            for (const row of patch.upsert) {
                await dbRun(db,
                    `INSERT OR REPLACE INTO games
                        (wiki_page_id, title, zh_CN, install_folder, steam_id, gog_id, platform, save_location)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        row.wiki_page_id,
                        row.title,
                        row.zh_CN !== undefined ? row.zh_CN : null,
                        row.install_folder,
                        row.steam_id !== undefined ? row.steam_id : null,
                        row.gog_id !== undefined ? row.gog_id : null,
                        row.platform,
                        row.save_location
                    ]
                );
            }
        }

        // delete
        if (patch.delete && patch.delete.length > 0) {
            const placeholders = patch.delete.map(() => '?').join(',');
            await dbRun(db,
                `DELETE FROM games WHERE wiki_page_id IN (${placeholders})`,
                patch.delete
            );
        }

        for (const row of patch.metadata_upsert || []) {
            await dbRun(db, 'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [row.key, row.value]);
        }
        if (patch.metadata_delete?.length > 0) {
            const placeholders = patch.metadata_delete.map(() => '?').join(',');
            await dbRun(db, `DELETE FROM metadata WHERE key IN (${placeholders})`, patch.metadata_delete);
        }

        // 更新版本号（不能用参数绑定）
        await dbRun(db, `PRAGMA user_version = ${patch.version}`);

        await dbRun(db, 'COMMIT');
    } catch (err) {
        try {
            await dbRun(db, 'ROLLBACK');
        } catch { }
        throw err;
    } finally {
        await closeDb(db);
    }
}

/**
 * 下载整个 database.db 文件（首次发布或无补丁时的回退方案）
 */
function findReleaseAsset(assets, name) {
    const matches = assets.filter(asset => asset?.name === name);
    if (matches.length !== 1) throw new Error(`Release must contain exactly one ${name} asset`);
    return matches[0];
}

function verifyReleaseAssetMetadata(asset, descriptor) {
    if (asset.size !== descriptor.size) throw new Error(`${descriptor.name} size differs from the Release API`);
    const releaseDigest = normalizeSha256(asset.digest);
    if (!releaseDigest || releaseDigest !== descriptor.sha256) {
        throw new Error(`${descriptor.name} digest differs from the Release API`);
    }
    return validateReleaseAssetUrl(asset.browser_download_url);
}

async function downloadJsonAsset(asset, descriptor, maxBytes) {
    const url = verifyReleaseAssetMetadata(asset, descriptor);
    const response = await axios.get(url, {
        responseType: 'arraybuffer', timeout: 30000,
        maxContentLength: maxBytes, maxBodyLength: maxBytes,
        headers: { 'User-Agent': 'OpenGameSave' }
    });
    const buffer = Buffer.from(response.data);
    if (buffer.length !== descriptor.size || calculateBufferSha256(buffer) !== descriptor.sha256) {
        throw new Error(`${descriptor.name} failed its size or SHA-256 check`);
    }
    try {
        return JSON.parse(buffer.toString('utf8'));
    } catch (_) {
        throw new Error(`${descriptor.name} is not valid JSON`);
    }
}

function calculateBufferSha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function loadPublishedManifest(assets, variant = 'standard') {
    const normalizedVariant = normalizeDatabaseVariant(variant);
    const names = getDatabaseAssetNames(normalizedVariant);
    const currentAsset = findReleaseAsset(assets, names.pointer);
    const currentDescriptor = {
        name: names.pointer,
        size: currentAsset.size,
        sha256: normalizeSha256(currentAsset.digest)
    };
    if (!currentDescriptor.sha256) throw new Error(`${names.pointer} is missing a Release digest`);
    const current = await downloadJsonAsset(currentAsset, currentDescriptor, 64 * 1024);
    const pointerVariant = normalizeDatabaseVariant(current?.variant ?? 'standard');
    if (pointerVariant !== normalizedVariant || !Number.isInteger(current?.latest_version)
        || current.latest_version < 1
        || current.manifest !== getDatabaseAssetNames(normalizedVariant, current.latest_version).manifest) {
        throw new Error('Invalid current database pointer');
    }
    const manifestAsset = findReleaseAsset(assets, current.manifest);
    const manifestDescriptor = validateAssetDescriptor({
        name: current.manifest,
        size: current.size,
        sha256: current.sha256
    }, current.manifest, 1024 * 1024);
    const manifest = validateDatabaseManifest(
        await downloadJsonAsset(manifestAsset, manifestDescriptor, 1024 * 1024),
        normalizedVariant
    );
    if (current.latest_version !== manifest.latest_version
        || current.manifest !== getDatabaseAssetNames(normalizedVariant, manifest.latest_version).manifest) {
        throw new Error('Current pointer and database manifest versions differ');
    }
    return manifest;
}

function sendDatabaseUpdateEvent(targetWebContents, channel, ...args) {
    const mainWindow = getMainWin();
    const fallbackWebContents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
    const webContents = targetWebContents && !targetWebContents.isDestroyed()
        ? targetWebContents
        : fallbackWebContents;
    if (webContents && !webContents.isDestroyed()) {
        try {
            webContents.send(channel, ...args);
        } catch (error) {
            // Progress delivery is observational. A renderer can disappear
            // between the liveness check and send while the download stream
            // must remain under pipeline error handling.
            console.warn(`Could not deliver database update event ${channel}:`, error.message);
        }
    }
}

async function downloadFullDatabase(asset, descriptor, dbPath, progressId, progressTitle,
    expectedSchemaVersion, expectedVariant, targetWebContents) {
    const assetUrl = verifyReleaseAssetMetadata(asset, descriptor);
    const { data, headers } = await axios({
        method: 'get',
        url: assetUrl,
        responseType: 'stream',
        timeout: 60000,
        maxContentLength: MAX_DATABASE_DOWNLOAD_BYTES,
        maxBodyLength: MAX_DATABASE_DOWNLOAD_BYTES,
        headers: { 'User-Agent': 'OpenGameSave' }
    });

    const totalSize = parseInt(headers['content-length'], 10);
    if (Number.isFinite(totalSize) && (totalSize <= 0 || totalSize > MAX_DATABASE_DOWNLOAD_BYTES)) {
        data.destroy();
        throw new Error('Database download is outside the allowed size');
    }
    let downloadedSize = 0;
    let lastPercentage = -1;

    data.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (downloadedSize > MAX_DATABASE_DOWNLOAD_BYTES) {
            data.destroy(new Error('Database download exceeded the allowed size'));
            return;
        }
        const percentage = Number.isFinite(totalSize) && totalSize > 0
            ? Math.min(100, Math.round((downloadedSize / totalSize) * 100))
            : 0;
        if (percentage !== lastPercentage) {
            lastPercentage = percentage;
            sendDatabaseUpdateEvent(targetWebContents, 'update-progress', progressId, progressTitle, percentage);
        }
    });

    await pipeline(data, fs.createWriteStream(dbPath, { flags: 'wx', mode: 0o600 }));
    await verifyFileDescriptor(dbPath, descriptor, { maxBytes: MAX_DATABASE_DOWNLOAD_BYTES });
    await validateDatabaseFile(dbPath, descriptor.user_version, expectedSchemaVersion, expectedVariant);
}

async function performDatabaseUpdate(targetWebContents) {
    const progressId = 'update-db';
    const progressTitle = i18next.t('alert.updating_database');
    const dbPath = getUserDatabasePath();
    const requestedVariant = normalizeDatabaseVariant(getSettings().databaseVariant, 'standard');
    let stagedPath = null;

    sendDatabaseUpdateEvent(targetWebContents, 'update-progress', progressId, progressTitle, 'start');

    try {
        await recoverDatabaseFiles(dbPath, validateDatabaseFile);

        let releaseData;
        try {
            const releaseResp = await axios.get(DB_RELEASE_API_URL, {
                timeout: 15000,
                maxContentLength: 2 * 1024 * 1024,
                headers: { 'User-Agent': 'OpenGameSave', 'Accept': 'application/vnd.github+json' }
            });
            releaseData = releaseResp.data;
        } catch (error) {
            throw new Error(`无法获取 Release 信息：${error.message}`);
        }

        if (!releaseData || !Array.isArray(releaseData.assets)) {
            throw new Error('Release information is malformed');
        }
        const assets = releaseData.assets.slice(0, 1000);
        const manifest = await loadPublishedManifest(assets, requestedVariant);
        const localVersion = await getLocalDbVersion(dbPath);
        let localVariant = 'standard';
        if (fs.existsSync(dbPath)) {
            localVariant = (await validateDatabaseFile(dbPath)).variant;
        }
        const sameVariant = localVariant === requestedVariant;
        console.log(`本地数据库版本：${localVersion}（${localVariant}），请求版本：${requestedVariant}`);
        if (sameVariant && localVersion === manifest.latest_version) {
            try {
                await validateDatabaseFile(dbPath, manifest.latest_version, manifest.schema_version, requestedVariant);
                console.log('数据库已是最新版本');
                sendDatabaseUpdateEvent(targetWebContents, 'update-progress', progressId, progressTitle, 'end');
                return { success: true, alreadyLatest: true };
            } catch (error) {
                console.warn(`本地数据库版本相同但内容无效，将下载完整数据库：${error.message}`);
            }
        }
        if (sameVariant && localVersion > manifest.latest_version) {
            throw new Error('Local database is newer than the published manifest');
        }

        const pendingPatches = [];
        let nextVersion = sameVariant ? localVersion + 1 : manifest.latest_version + 1;
        while (nextVersion <= manifest.latest_version) {
            const patch = manifest.patches.find(item => item.from === nextVersion - 1 && item.to === nextVersion);
            if (!patch) break;
            pendingPatches.push(patch);
            nextVersion += 1;
        }
        let localSchemaMatches = false;
        if (sameVariant && fs.existsSync(dbPath)) {
            try {
                await validateDatabaseFile(dbPath, localVersion, manifest.schema_version, requestedVariant);
                localSchemaMatches = true;
            } catch (_) { }
        }
        const canPatch = localSchemaMatches && localVersion < manifest.latest_version && nextVersion === manifest.latest_version + 1;
        const newPath = createNewDatabasePath(dbPath);
        stagedPath = newPath;

        if (!canPatch) {
            console.log('本地数据库不存在或补丁链不完整，下载完整数据库');
            const databaseAsset = findReleaseAsset(assets, manifest.database.name);
            await downloadFullDatabase(databaseAsset, manifest.database, newPath, progressId, progressTitle,
                manifest.schema_version, requestedVariant, targetWebContents);
        } else {
            await fs.promises.copyFile(dbPath, newPath, fs.constants.COPYFILE_EXCL);
            for (let i = 0; i < pendingPatches.length; i++) {
                const descriptor = pendingPatches[i];
                const patchAsset = findReleaseAsset(assets, descriptor.name);
                const patch = await downloadJsonAsset(patchAsset, descriptor, MAX_PATCH_DOWNLOAD_BYTES);
                await applyPatch(newPath, patch, descriptor.to, descriptor.from, requestedVariant);
                sendDatabaseUpdateEvent(targetWebContents, 'update-progress', progressId, progressTitle, Math.round(((i + 1) / pendingPatches.length) * 100));
            }
            await validateDatabaseFile(newPath, manifest.latest_version, manifest.schema_version, requestedVariant);
        }

        await atomicInstallDatabase(newPath, dbPath,
            candidate => validateDatabaseFile(candidate, manifest.latest_version, manifest.schema_version, requestedVariant));
        stagedPath = null;

        sendDatabaseUpdateEvent(targetWebContents, 'update-progress', progressId, progressTitle, 'end');
        sendDatabaseUpdateEvent(targetWebContents, 'show-alert', 'success', i18next.t('alert.update_db_success'));
        return { success: true, variant: requestedVariant };

    } catch (error) {
        console.error(`更新数据库时发生错误：${error.message}`);
        sendDatabaseUpdateEvent(targetWebContents, 'show-alert', 'modal', i18next.t('alert.error_during_db_update'), error.message);
        if (stagedPath) await fs.promises.rm(stagedPath, { force: true }).catch(() => undefined);

        sendDatabaseUpdateEvent(targetWebContents, 'update-progress', progressId, progressTitle, 'end');
        return { success: false, error: error.message };
    }
}

async function updateDatabase(targetWebContents) {
    if (getStatus().updating_db) {
        return { success: false, busy: true };
    }
    updateStatus('updating_db', true);
    let releaseDatabase;
    try {
        releaseDatabase = await acquireDatabaseWrite();
        return await performDatabaseUpdate(targetWebContents);
    } finally {
        updateStatus('updating_db', false);
        releaseDatabase?.();
    }
}

async function initializeDatabaseStorage() {
    const releaseDatabase = await acquireDatabaseWrite();
    try {
        const dbPath = getUserDatabasePath();
        const recovered = await recoverDatabaseFiles(dbPath, validateDatabaseFile);
        const installedPath = getInstalledDatabasePath();
        if (!fs.existsSync(dbPath) && fs.existsSync(installedPath)) {
            const newPath = createNewDatabasePath(dbPath);
            try {
                await fs.promises.copyFile(installedPath, newPath, fs.constants.COPYFILE_EXCL);
                await atomicInstallDatabase(newPath, dbPath, validateDatabaseFile);
            } catch (error) {
                await fs.promises.rm(newPath, { force: true }).catch(() => undefined);
                throw error;
            }
        }
        return recovered;
    } finally {
        releaseDatabase();
    }
}

async function getGameDataFromDBWorkerBacked(ignoreUninstalled = false, wikiId = null) {
    try {
        const result = await runWorkerTask('getGameDataFromDB', { ignoreUninstalled, wikiId });
        if (Array.isArray(result.remainingUninstalledWikiIds)) {
            const currentUninstalledWikiIds = getSettings().uninstalledGames || [];
            if (JSON.stringify([...result.remainingUninstalledWikiIds].sort()) !== JSON.stringify([...currentUninstalledWikiIds].sort())) {
                await saveSettings('uninstalledGames', result.remainingUninstalledWikiIds);
            }
        }
        return { games: result.games || [], errors: result.errors || [] };
    } catch (error) {
        console.error(`Backup worker scan failed: ${error.stack || error.message}`);
        return { games: [], errors: [error.message] };
    }
}

async function getAllGameDataFromDBWorkerBacked() {
    if (getStatus().scanning_full) {
        return;
    }

    const progressId = 'scan-full';
    const progressTitle = i18next.t('alert.scanning_full');
    const mainWin = getMainWin();

    mainWin.webContents.send('update-progress', progressId, progressTitle, 'start');
    updateStatus('scanning_full', true);
    try {
        const result = await runWorkerTask('getAllGameDataFromDB', {}, (message) => {
            if (message.type === 'progress') {
                mainWin.webContents.send('update-progress', progressId, progressTitle, message.value);
            }
        });

        mainWin.webContents.send('show-alert', 'success', i18next.t('alert.scan_full_complete'));
        showBackgroundNotification(
            'info',
            i18next.t('alert.scan_full_complete'),
            i18next.t('alert.scan_full_background_notification')
        );

        return { games: result.games || [], errors: result.errors || [] };
    } catch (error) {
        console.error(`Backup worker full scan failed: ${error.stack || error.message}`);
        return { games: [], errors: [error.message] };
    } finally {
        updateStatus('scanning_full', false);
        mainWin.webContents.send('update-progress', progressId, progressTitle, 'end');
    }
}

async function backupGameWorkerBacked(gameObj) {
    let releaseOperation;
    try {
        releaseOperation = acquireGameOperation(gameObj?.wiki_page_id, 'backup');
        return await runBackupWorkerTask('backupGame', { gameObj });
    } catch (error) {
        console.error(`Backup worker backup failed: ${error.stack || error.message}`);
        return error.message;
    } finally {
        releaseOperation?.();
    }
}

async function runWorkerTask(task, payload = {}, onMessage = null) {
    const operation = () => runBackupWorkerTask(task, payload, onMessage);
    return DATABASE_READ_WORKER_TASKS.has(task) ? await runWithDatabaseRead(operation) : await operation();
}

module.exports = {
    getGameDataFromDB: getGameDataFromDBWorkerBacked,
    getAllGameDataFromDB: getAllGameDataFromDBWorkerBacked,
    backupGame: backupGameWorkerBacked,
    initializeDatabaseStorage,
    updateDatabase,
    runWorkerTask,
    shutdownBackupWorkers
};
