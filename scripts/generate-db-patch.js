#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SUPPORTED_TABLES = ['games', 'metadata'];

function parseArgs(argv) {
    const args = {};
    for (let index = 2; index < argv.length; index++) {
        if (!argv[index].startsWith('--')) continue;
        const key = argv[index].slice(2);
        args[key] = argv[index + 1] !== undefined && !argv[index + 1].startsWith('--') ? argv[++index] : true;
    }
    return args;
}

function normalizeSql(sql) {
    return String(sql || '').replace(/\s+/g, ' ').trim();
}

function canonicalValue(value) {
    if (Buffer.isBuffer(value)) return { $blob: value.toString('base64') };
    return value;
}

function canonicalRows(db, table) {
    return db.prepare(`SELECT * FROM "${table}"`).all()
        .map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, canonicalValue(value)])))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function databaseSnapshot(db) {
    const integrity = db.pragma('quick_check', { simple: true });
    if (integrity !== 'ok') throw new Error('Database failed quick_check');
    const schema = db.prepare(`
        SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
    `).all().map(row => ({ ...row, sql: normalizeSql(row.sql) }));
    const tableNames = new Set(schema.filter(row => row.type === 'table').map(row => row.name));
    for (const table of SUPPORTED_TABLES) {
        if (!tableNames.has(table)) throw new Error(`Database is missing supported table: ${table}`);
    }
    const rows = Object.fromEntries(SUPPORTED_TABLES.map(table => [table, canonicalRows(db, table)]));
    return { schema, rows };
}

function snapshotsEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function mapBy(rows, key) {
    return new Map(rows.map(row => [row[key], row]));
}

function diffRows(oldRows, newRows, key) {
    const oldMap = mapBy(oldRows, key);
    const newMap = mapBy(newRows, key);
    const upsert = [];
    const deleted = [];
    for (const [id, row] of newMap) {
        if (!oldMap.has(id) || JSON.stringify(oldMap.get(id)) !== JSON.stringify(row)) upsert.push(row);
    }
    for (const id of oldMap.keys()) if (!newMap.has(id)) deleted.push(id);
    return { upsert, delete: deleted };
}

function applyPatchForVerification(db, patch) {
    const gameColumns = Object.keys(patch.upsert[0] || {});
    const transaction = db.transaction(() => {
        if (gameColumns.length > 0) {
            const columns = gameColumns.map(column => `"${column}"`).join(', ');
            const values = gameColumns.map(column => `@${column}`).join(', ');
            const statement = db.prepare(`INSERT OR REPLACE INTO games (${columns}) VALUES (${values})`);
            for (const row of patch.upsert) statement.run(row);
        }
        const deleteGame = db.prepare('DELETE FROM games WHERE wiki_page_id = ?');
        for (const id of patch.delete) deleteGame.run(id);
        const upsertMetadata = db.prepare('INSERT INTO metadata (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
        for (const row of patch.metadata_upsert) upsertMetadata.run(row);
        const deleteMetadata = db.prepare('DELETE FROM metadata WHERE key = ?');
        for (const key of patch.metadata_delete) deleteMetadata.run(key);
        db.pragma(`user_version = ${patch.version}`);
    });
    transaction();
}

function verifyPatchEquivalence(fromPath, targetSnapshot, patch, outputDir) {
    const verificationPath = path.join(outputDir, `.verify-${crypto.randomUUID()}.db`);
    fs.copyFileSync(fromPath, verificationPath, fs.constants.COPYFILE_EXCL);
    try {
        const db = new Database(verificationPath);
        applyPatchForVerification(db, patch);
        const rebuiltSnapshot = databaseSnapshot(db);
        const rebuiltVersion = db.pragma('user_version', { simple: true });
        db.close();
        if (rebuiltVersion !== patch.version || !snapshotsEqual(rebuiltSnapshot, targetSnapshot)) {
            throw new Error('Generated patch does not rebuild a database equivalent to the target');
        }
    } finally {
        fs.rmSync(verificationPath, { force: true });
    }
}

function generate({ fromPath, toPath, outputDir, sourceSha = '' }) {
    if (!toPath || !fs.existsSync(toPath)) throw new Error('A valid --to database is required');
    if (!outputDir) throw new Error('--output is required');
    fs.mkdirSync(outputDir, { recursive: true });

    const targetDb = new Database(toPath);
    const targetSnapshot = databaseSnapshot(targetDb);
    const firstRelease = !fromPath || !fs.existsSync(fromPath);
    let fromVersion = 0;
    let oldSnapshot = null;
    if (!firstRelease) {
        const oldDb = new Database(fromPath, { readonly: true, fileMustExist: true });
        fromVersion = oldDb.pragma('user_version', { simple: true });
        oldSnapshot = databaseSnapshot(oldDb);
        oldDb.close();
    }

    const changed = firstRelease || !snapshotsEqual(oldSnapshot, targetSnapshot);
    const result = { changed, source_sha: sourceSha || null, from_version: fromVersion };
    if (!changed) {
        targetDb.close();
        result.version = fromVersion;
        fs.writeFileSync(path.join(outputDir, 'generation-result.json'), JSON.stringify(result, null, 2));
        return result;
    }

    const version = fromVersion + 1;
    targetDb.pragma(`user_version = ${version}`);
    targetDb.close();
    result.version = version;
    result.requires_full_database = firstRelease || JSON.stringify(oldSnapshot.schema) !== JSON.stringify(targetSnapshot.schema);

    if (!result.requires_full_database) {
        const gameDiff = diffRows(oldSnapshot.rows.games, targetSnapshot.rows.games, 'wiki_page_id');
        const metadataDiff = diffRows(oldSnapshot.rows.metadata, targetSnapshot.rows.metadata, 'key');
        const patch = {
            version,
            from_version: fromVersion,
            source_sha: sourceSha || null,
            upsert: gameDiff.upsert,
            delete: gameDiff.delete,
            metadata_upsert: metadataDiff.upsert,
            metadata_delete: metadataDiff.delete
        };
        const patchName = `db_patch_v${version}.json`;
        fs.writeFileSync(path.join(outputDir, patchName), JSON.stringify(patch, null, 2));
        verifyPatchEquivalence(fromPath, targetSnapshot, patch, outputDir);
        result.patch = patchName;
    }
    fs.writeFileSync(path.join(outputDir, 'generation-result.json'), JSON.stringify(result, null, 2));
    return result;
}

function main() {
    const args = parseArgs(process.argv);
    const result = generate({
        fromPath: args.from || '',
        toPath: args.to,
        outputDir: args.output,
        sourceSha: args['source-sha'] || ''
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`Failed to generate database update: ${error.stack || error.message}`);
        process.exit(1);
    }
}

module.exports = { databaseSnapshot, generate, snapshotsEqual };
