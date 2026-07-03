const { app } = require('electron');
const { Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const axios = require('axios');
const i18next = require('i18next');

const {
    getMainWin, getStatus, updateStatus,
    placeholder_mapping, osKeyMap, getSettings, saveSettings, showBackgroundNotification
} = require('./global');
const { getGameData, getAllUserIds } = require('./gameData');
const { sqlite3, dbRun, dbGet, openDb, closeDb } = require('./sqliteUtils');

const DB_RELEASE_API_URL = 'https://api.github.com/repos/leisurefire/OpenGameSave/releases/latest';

function createBackupWorkerContext() {
    const currentGameData = getGameData();

    return {
        settings: getSettings(),
        gameData: {
            steamPath: currentGameData.steamPath,
            ubisoftPath: currentGameData.ubisoftPath,
            currentSteamUserId3: currentGameData.currentSteamUserId3,
            currentUbisoftUserId: currentGameData.currentUbisoftUserId
        },
        allUserIds: getAllUserIds(),
        dbPath: path.join(app.getPath("userData"), "OGS Database", "database.db"),
        installedDbPath: path.join(process.cwd(), 'database', 'database.db'),
        placeholderMapping: placeholder_mapping,
        osKeyMap,
        labels: {
            noBackups: i18next.t('main.no_backups'),
            missingDatabase: i18next.t('alert.missing_database_file_message')
        }
    };
}

function runBackupWorkerTask(task, payload = {}, onMessage = null) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'backupWorker.js'));
        let settled = false;

        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            worker.terminate().catch(() => { });
            callback(value);
        };

        worker.once('error', (error) => {
            finish(reject, error);
        });
        worker.once('exit', (code) => {
            if (!settled && code !== 0) {
                finish(reject, new Error(`Backup worker stopped with exit code ${code}`));
            }
        });

        worker.on('message', (message) => {
            if (message.type === 'done') {
                finish(resolve, message.result);
            } else if (message.type === 'error') {
                const error = new Error(message.error?.message || 'Backup worker failed');
                error.stack = message.error?.stack || error.stack;
                finish(reject, error);
            } else if (typeof onMessage === 'function') {
                onMessage(message);
            }
        });

        worker.postMessage({
            task,
            payload,
            context: createBackupWorkerContext()
        });
    });
}

/**
 * 读取本地数据库的 PRAGMA user_version
 */
async function getLocalDbVersion(dbPath) {
    if (!fs.existsSync(dbPath)) return 0;
    const db = await openDb(dbPath, sqlite3.OPEN_READONLY);
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
async function applyPatch(dbPath, patch) {
    const db = await openDb(dbPath, sqlite3.OPEN_READWRITE);
    try {
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

        // 更新版本号（不能用参数绑定）
        await dbRun(db, `PRAGMA user_version = ${parseInt(patch.version, 10)}`);

        await dbRun(db, 'COMMIT');
    } catch (err) {
        await dbRun(db, 'ROLLBACK').catch(() => { });
        throw err;
    } finally {
        await closeDb(db);
    }
}

/**
 * 下载整个 database.db 文件（首次发布或无补丁时的回退方案）
 */
async function downloadFullDatabase(assetUrl, dbPath, progressId, progressTitle) {
    const { data, headers } = await axios({
        method: 'get',
        url: assetUrl,
        responseType: 'stream',
        timeout: 60000,
        headers: { 'User-Agent': 'OpenGameSave' }
    });

    const totalSize = parseInt(headers['content-length'], 10);
    let downloadedSize = 0;

    await new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(dbPath);
        data.on('data', (chunk) => {
            downloadedSize += chunk.length;
            const pct = Number.isFinite(totalSize) && totalSize > 0
                ? Math.round((downloadedSize / totalSize) * 100)
                : 0;
            getMainWin().webContents.send('update-progress', progressId, progressTitle, pct);
        });
        data.on('error', reject);
        fileStream.on('finish', () => fileStream.close(resolve));
        fileStream.on('error', reject);
        data.pipe(fileStream);
    });
}

async function updateDatabase() {
    const progressId = 'update-db';
    const progressTitle = i18next.t('alert.updating_database');
    const dbPath = path.join(app.getPath("userData"), "OGS Database", "database.db");
    const dbTempPath = `${dbPath}.temp`;

    const win = getMainWin();
    win.webContents.send('update-progress', progressId, progressTitle, 'start');

    // 备份当前数据库
    try {
        if (!fs.existsSync(path.dirname(dbPath))) {
            fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        }
        if (fs.existsSync(dbPath)) {
            fs.copyFileSync(dbPath, dbTempPath);
        }
    } catch (error) {
        console.error(`备份数据库失败：${error.message}`);
        win.webContents.send('show-alert', 'modal', i18next.t('alert.error_during_db_update'), error.message);
        win.webContents.send('update-progress', progressId, progressTitle, 'end');
        return { success: false, error: error.message };
    }

    try {
        // ── 步骤1：获取 latest release 的所有 assets ──────────────────────────
        let releaseData;
        try {
            const releaseResp = await axios.get(DB_RELEASE_API_URL, {
                timeout: 15000,
                headers: { 'User-Agent': 'OpenGameSave', 'Accept': 'application/vnd.github+json' }
            });
            releaseData = releaseResp.data;
        } catch (error) {
            throw new Error(`无法获取 Release 信息：${error.message}`);
        }

        const assets = releaseData.assets || [];
        const releaseTag = releaseData.tag_name || 'latest';

        // ── 步骤2：筛选并解析补丁文件信息 ────────────────────────────────────
        const patchAssets = assets
            .filter(a => a.name.startsWith('db_patch_v') && a.name.endsWith('.json'))
            .map(a => {
                const match = a.name.match(/^db_patch_v(\d+)\.json$/);
                return match ? { version: parseInt(match[1], 10), url: a.browser_download_url, name: a.name } : null;
            })
            .filter(Boolean)
            .sort((a, b) => a.version - b.version);

        // ── 步骤3：读取本地数据库版本 ─────────────────────────────────────────
        const localVersion = await getLocalDbVersion(dbPath);
        console.log(`本地数据库版本：${localVersion}`);

        // ── 步骤4：确定需要应用的补丁 ────────────────────────────────────────
        const pendingPatches = patchAssets.filter(p => p.version > localVersion);

        // ── 步骤5：判断是否无需更新 ──────────────────────────────────────────
        if (pendingPatches.length === 0 && patchAssets.length > 0) {
            console.log('数据库已是最新版本');
            win.webContents.send('update-progress', progressId, progressTitle, 'end');
            // 清理临时备份文件（不需要恢复）
            if (fs.existsSync(dbTempPath)) fs.unlinkSync(dbTempPath);
            return { success: true, alreadyLatest: true };
        }

        // ── 步骤6a：无补丁文件 → 回退到整库下载 ─────────────────────────────
        if (patchAssets.length === 0) {
            console.log('Release 中未找到补丁文件，尝试整库下载 database.db');
            const dbAsset = assets.find(a => a.name === 'database.db');
            if (!dbAsset) {
                throw new Error(`Release ${releaseTag} 中既无补丁文件，也无 database.db`);
            }
            // 下载到临时文件后替换
            const downloadTempPath = `${dbPath}.download`;
            await downloadFullDatabase(dbAsset.browser_download_url, downloadTempPath, progressId, progressTitle);
            fs.copyFileSync(downloadTempPath, dbPath);
            fs.unlinkSync(downloadTempPath);

            // 清理旧备份
            if (fs.existsSync(dbTempPath)) fs.unlinkSync(dbTempPath);
            win.webContents.send('update-progress', progressId, progressTitle, 'end');
            win.webContents.send('show-alert', 'success', i18next.t('alert.update_db_success'));
            return { success: true };
        }

        // ── 步骤6b：依次下载并应用补丁 ───────────────────────────────────────
        const total = pendingPatches.length;
        for (let i = 0; i < total; i++) {
            const patchInfo = pendingPatches[i];
            console.log(`正在应用补丁 ${patchInfo.name}（${i + 1}/${total}）`);

            // 下载补丁 JSON
            const patchResp = await axios.get(patchInfo.url, {
                timeout: 30000,
                headers: { 'User-Agent': 'OpenGameSave' }
            });
            const patch = patchResp.data;

            // 应用补丁到数据库
            await applyPatch(dbPath, patch);

            // 报告进度
            const pct = Math.round(((i + 1) / total) * 100);
            win.webContents.send('update-progress', progressId, progressTitle, pct);
        }

        // 清理旧备份
        if (fs.existsSync(dbTempPath)) fs.unlinkSync(dbTempPath);

        win.webContents.send('update-progress', progressId, progressTitle, 'end');
        win.webContents.send('show-alert', 'success', i18next.t('alert.update_db_success'));
        return { success: true };

    } catch (error) {
        console.error(`更新数据库时发生错误：${error.message}`);
        win.webContents.send('show-alert', 'modal', i18next.t('alert.error_during_db_update'), error.message);

        // 从备份恢复
        if (fs.existsSync(dbTempPath)) {
            try {
                fs.copyFileSync(dbTempPath, dbPath);
                fs.unlinkSync(dbTempPath);
                console.log('已从备份恢复数据库');
            } catch (restoreErr) {
                console.error(`恢复数据库失败：${restoreErr.message}`);
            }
        }

        win.webContents.send('update-progress', progressId, progressTitle, 'end');
        return { success: false, error: error.message };
    }
}

async function getGameDataFromDBWorkerBacked(ignoreUninstalled = false, wikiId = null) {
    try {
        const result = await runBackupWorkerTask('getGameDataFromDB', { ignoreUninstalled, wikiId });
        if (Array.isArray(result.remainingUninstalledWikiIds)) {
            const currentUninstalledWikiIds = getSettings().uninstalledGames || [];
            if (JSON.stringify([...result.remainingUninstalledWikiIds].sort()) !== JSON.stringify([...currentUninstalledWikiIds].sort())) {
                saveSettings('uninstalledGames', result.remainingUninstalledWikiIds);
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
        const result = await runBackupWorkerTask('getAllGameDataFromDB', {}, (message) => {
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
    try {
        return await runBackupWorkerTask('backupGame', { gameObj });
    } catch (error) {
        console.error(`Backup worker backup failed: ${error.stack || error.message}`);
        return error.message;
    }
}

async function runWorkerTask(task, payload = {}, onMessage = null) {
    return await runBackupWorkerTask(task, payload, onMessage);
}

module.exports = {
    getGameDataFromDB: getGameDataFromDBWorkerBacked,
    getAllGameDataFromDB: getAllGameDataFromDBWorkerBacked,
    backupGame: backupGameWorkerBacked,
    updateDatabase,
    runWorkerTask
};
