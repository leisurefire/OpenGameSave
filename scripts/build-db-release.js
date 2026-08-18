#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {
    DATABASE_VARIANT_METADATA_KEY,
    getDatabaseAssetNames,
    normalizeDatabaseVariant,
    validateDatabaseManifest
} = require('../src/main/databaseManifest');

function parseArgs(argv) {
    const result = {};
    for (let index = 2; index < argv.length; index++) {
        if (!argv[index].startsWith('--')) continue;
        const key = argv[index].slice(2);
        result[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
    }
    return result;
}

function sha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function describe(filePath, extra = {}) {
    return { name: path.basename(filePath), size: fs.statSync(filePath).size, sha256: sha256(filePath), ...extra };
}

function build({ databasePath, resultPath, outputDir, sourceSha, previousManifestPath = '', variant = 'standard' }) {
    const normalizedVariant = normalizeDatabaseVariant(variant);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    if (normalizeDatabaseVariant(result.variant ?? 'standard') !== normalizedVariant) {
        throw new Error('Generation result variant differs from publication variant');
    }
    if (!result.changed) return { changed: false, version: result.version };
    if (result.source_sha && result.source_sha !== sourceSha) throw new Error('Generation result source SHA differs from publication SHA');
    fs.mkdirSync(outputDir, { recursive: true });
    const version = result.version;
    const names = getDatabaseAssetNames(normalizedVariant, version);
    const databaseName = names.database;
    const versionedDatabasePath = path.join(outputDir, databaseName);
    fs.copyFileSync(databasePath, versionedDatabasePath, fs.constants.COPYFILE_EXCL);
    const db = new Database(versionedDatabasePath, { readonly: true });
    if (db.pragma('quick_check', { simple: true }) !== 'ok' || db.pragma('user_version', { simple: true }) !== version) {
        db.close();
        throw new Error('Versioned database failed validation');
    }
    const storedVariant = normalizeDatabaseVariant(
        db.prepare('SELECT value FROM metadata WHERE key = ?').get(DATABASE_VARIANT_METADATA_KEY)?.value ?? 'standard'
    );
    if (storedVariant !== normalizedVariant) {
        db.close();
        throw new Error('Versioned database edition marker differs from publication variant');
    }
    const schema = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
    db.close();

    let patches = [];
    if (!result.requires_full_database && previousManifestPath && fs.existsSync(previousManifestPath)) {
        const previous = validateDatabaseManifest(
            JSON.parse(fs.readFileSync(previousManifestPath, 'utf8')),
            normalizedVariant
        );
        if (previous.latest_version !== result.from_version) throw new Error('Previous manifest version is not the patch source version');
        patches = Array.isArray(previous.patches) ? previous.patches.slice() : [];
    }
    if (result.patch) {
        const patchSource = path.join(path.dirname(resultPath), result.patch);
        const patchTarget = path.join(outputDir, result.patch);
        if (path.resolve(patchSource) !== path.resolve(patchTarget)) fs.copyFileSync(patchSource, patchTarget, fs.constants.COPYFILE_EXCL);
        patches.push(describe(patchTarget, { from: result.from_version, to: version }));
    }
    const seen = new Set();
    for (const patch of patches) {
        if (patch.to !== patch.from + 1 || seen.has(patch.to)) throw new Error('Patch sequence contains a gap or duplicate');
        seen.add(patch.to);
    }
    patches.sort((left, right) => left.to - right.to);
    for (let index = 1; index < patches.length; index++) {
        if (patches[index].from !== patches[index - 1].to) throw new Error('Patch sequence is not contiguous');
    }

    const manifest = {
        variant: normalizedVariant,
        latest_version: version,
        data_version: version,
        schema_version: crypto.createHash('sha256').update(JSON.stringify(schema)).digest('hex'),
        source_sha: sourceSha,
        database: describe(versionedDatabasePath, { user_version: version }),
        patches
    };
    const manifestPath = path.join(outputDir, names.manifest);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const current = {
        variant: normalizedVariant,
        latest_version: version,
        manifest: path.basename(manifestPath),
        size: fs.statSync(manifestPath).size,
        sha256: sha256(manifestPath)
    };
    fs.writeFileSync(path.join(outputDir, names.pointer), JSON.stringify(current, null, 2));
    return { changed: true, version, database: databaseName, manifest: path.basename(manifestPath), patch: result.patch || null };
}

if (require.main === module) {
    try {
        const args = parseArgs(process.argv);
        process.stdout.write(`${JSON.stringify(build({
            databasePath: args.database,
            resultPath: args.result,
            outputDir: args.output,
            sourceSha: args['source-sha'],
            previousManifestPath: args['previous-manifest'] || '',
            variant: args.variant || 'standard'
        }))}\n`);
    } catch (error) {
        console.error(error.stack || error.message);
        process.exit(1);
    }
}

module.exports = { build, describe, sha256 };
