#!/usr/bin/env node
/**
 * generate-db-patch.js
 * 
 * CI/CD 脚本：比较两个 SQLite 数据库的 games 表差异，生成增量补丁 JSON 文件。
 * 
 * 用法：
 *   node scripts/generate-db-patch.js --from <旧db路径> --to <新db路径> --output <输出目录>
 * 
 * 说明：
 *   --from  旧版本数据库路径（若为空字符串或文件不存在，则视为首次发布，所有记录作为 upsert）
 *   --to    新版本数据库路径
 *   --output 输出目录（补丁文件写入此目录）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// ─── Promise 封装 ────────────────────────────────────────────────────────────

function openDb(dbPath, mode) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, mode, (err) => {
            if (err) reject(err);
            else resolve(db);
        });
    });
}

function closeDb(db) {
    return new Promise((resolve, reject) => {
        db.close((err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

function dbRun(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

// ─── 参数解析 ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        if (argv[i].startsWith('--')) {
            const key = argv[i].slice(2);
            args[key] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')
                ? argv[++i]
                : true;
        }
    }
    return args;
}

// ─── 核心逻辑 ─────────────────────────────────────────────────────────────────

/**
 * 从数据库读取所有 games 行，以 wiki_page_id 为键返回 Map
 */
async function loadGamesMap(db) {
    const rows = await dbAll(db, 'SELECT * FROM games');
    const map = new Map();
    for (const row of rows) {
        map.set(row.wiki_page_id, row);
    }
    return map;
}

/**
 * 读取 PRAGMA user_version
 */
async function getUserVersion(db) {
    const row = await dbGet(db, 'PRAGMA user_version');
    return row ? row.user_version : 0;
}

/**
 * 设置 PRAGMA user_version（不能用参数绑定，必须字符串拼接）
 */
async function setUserVersion(db, version) {
    await dbRun(db, `PRAGMA user_version = ${parseInt(version, 10)}`);
}

/**
 * 比较两行记录是否相同（字段级比较）
 */
function rowsAreEqual(oldRow, newRow) {
    const fields = ['title', 'zh_CN', 'install_folder', 'steam_id', 'gog_id', 'platform', 'save_location'];
    for (const field of fields) {
        // 统一转换为字符串比较，处理 null/undefined
        const oldVal = oldRow[field] === null || oldRow[field] === undefined ? null : String(oldRow[field]);
        const newVal = newRow[field] === null || newRow[field] === undefined ? null : String(newRow[field]);
        if (oldVal !== newVal) return false;
    }
    return true;
}

async function main() {
    const args = parseArgs(process.argv);

    const fromPath = args['from'] || '';
    const toPath = args['to'];
    const outputDir = args['output'];

    // 参数校验
    if (!toPath) {
        console.error('错误：必须指定 --to <新db路径>');
        process.exit(1);
    }
    if (!outputDir) {
        console.error('错误：必须指定 --output <输出目录>');
        process.exit(1);
    }
    if (!fs.existsSync(toPath)) {
        console.error(`错误：新数据库文件不存在：${toPath}`);
        process.exit(1);
    }

    // 确保输出目录存在
    fs.mkdirSync(outputDir, { recursive: true });

    // 判断是否为首次发布
    const isFirstRelease = !fromPath || !fs.existsSync(fromPath);

    // 打开新数据库
    const newDb = await openDb(toPath, sqlite3.OPEN_READWRITE);
    const newVersion = await getUserVersion(newDb);
    const newGamesMap = await loadGamesMap(newDb);

    let fromVersion = 0;
    let upsertRows = [];
    let deleteIds = [];

    if (isFirstRelease) {
        console.log('首次发布模式：将所有记录作为 upsert，from_version = 0');
        fromVersion = 0;
        upsertRows = Array.from(newGamesMap.values());
        deleteIds = [];
    } else {
        // 打开旧数据库
        const oldDb = await openDb(fromPath, sqlite3.OPEN_READONLY);
        fromVersion = await getUserVersion(oldDb);
        const oldGamesMap = await loadGamesMap(oldDb);
        await closeDb(oldDb);

        // 找出新增和修改的记录（upsert）
        for (const [id, newRow] of newGamesMap) {
            const oldRow = oldGamesMap.get(id);
            if (!oldRow || !rowsAreEqual(oldRow, newRow)) {
                upsertRows.push(newRow);
            }
        }

        // 找出删除的记录
        for (const [id] of oldGamesMap) {
            if (!newGamesMap.has(id)) {
                deleteIds.push(id);
            }
        }
    }

    // 计算新版本号
    const patchVersion = fromVersion + 1;

    // 将新数据库的 user_version 更新为新版本号
    await setUserVersion(newDb, patchVersion);
    await closeDb(newDb);

    console.log(`旧版本：${fromVersion}，新版本：${patchVersion}`);
    console.log(`upsert 记录数：${upsertRows.length}，delete 记录数：${deleteIds.length}`);

    // 构建补丁对象
    const patch = {
        version: patchVersion,
        from_version: fromVersion,
        timestamp: new Date().toISOString(),
        upsert: upsertRows,
        delete: deleteIds
    };

    // 输出补丁文件
    const patchFileName = `db_patch_v${patchVersion}.json`;
    const patchFilePath = path.join(outputDir, patchFileName);
    fs.writeFileSync(patchFilePath, JSON.stringify(patch, null, 2), 'utf8');

    console.log(`补丁文件已生成：${patchFilePath}`);
}

main().catch((err) => {
    console.error('生成补丁时发生错误：', err);
    process.exit(1);
});
