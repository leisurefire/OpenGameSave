#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
    MAX_XGP_SOURCE_BYTES,
    XGP_WIKI_IDS_METADATA_KEY,
    normalizeTitleKey,
    parseXgpGamesJson
} = require('../src/main/xgpSourceFormat');
const { DATABASE_VARIANT_METADATA_KEY } = require('../src/main/databaseManifest');

const DEFAULT_REGISTRY_URL = 'https://raw.githubusercontent.com/brodrigz/XgpSaveTools/master/XgpSaveTools/games.json';
const XGP_PROJECT_URL = 'https://github.com/brodrigz/XgpSaveTools';
const XGP_LICENSE_URL = 'https://github.com/brodrigz/XgpSaveTools/blob/master/LICENSE';
const MAX_LICENSE_BYTES = 64 * 1024;
const DEFAULT_MAX_UPDATES = 1000;
const DEFAULT_MAX_ADDED_PATHS = 2000;

function parseArgs(argv) {
    const args = {};
    for (let index = 2; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument.startsWith('--')) continue;
        const key = argument.slice(2);
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
            args[key] = next;
            index += 1;
        } else {
            args[key] = true;
        }
    }
    return args;
}

function parsePositiveInteger(value, fallback, name) {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}

function addToIndex(index, key, row) {
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row);
}

function createTitleIndex(rows) {
    const index = new Map();
    for (const row of rows) addToIndex(index, normalizeTitleKey(row.title), row);
    return index;
}

function parseJsonArray(value) {
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) && parsed.every(item => typeof item === 'string')
            ? parsed
            : null;
    } catch (_) {
        return null;
    }
}

function parseSaveLocation(value) {
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        if (parsed.win !== undefined
            && (!Array.isArray(parsed.win) || parsed.win.some(item => typeof item !== 'string' || !item))) {
            return null;
        }
        return { ...parsed, win: [...(parsed.win || [])] };
    } catch (_) {
        return null;
    }
}

function canonicalizeWindowsPath(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/\/+$/, '')
        .toLocaleLowerCase('en-US');
}

function buildSyncPlan(entries, rows) {
    const titleIndex = createTitleIndex(rows);
    const updatesByWikiId = new Map();
    const unmatched = [];
    const conflicts = [];
    const invalidLocalRows = new Set();
    const matchedGames = new Set();
    const mountedGames = new Set();
    const counters = {
        sourceEntries: entries.length,
        matchedEntries: 0,
        matchedGames: 0,
        mountedGames: 0,
        unmatchedEntries: 0,
        ambiguousEntries: 0,
        invalidLocalRows: 0,
        alreadyPresentPaths: 0,
        addedPaths: 0,
        addedWgsPaths: 0,
        addedPgsPaths: 0,
        updatedGames: 0
    };

    for (const entry of entries) {
        const matches = titleIndex.get(entry.titleKey) || [];
        if (matches.length === 0) {
            unmatched.push({ name: entry.name, source: entry.source, package: entry.package });
            counters.unmatchedEntries += 1;
            continue;
        }
        if (matches.length !== 1) {
            conflicts.push({
                name: entry.name,
                reason: 'Normalized title matches multiple OpenGameSave rows',
                wiki_page_ids: matches.map(row => row.wiki_page_id)
            });
            counters.ambiguousEntries += 1;
            continue;
        }

        counters.matchedEntries += 1;
        const row = matches[0];
        matchedGames.add(String(row.wiki_page_id));
        const updateKey = String(row.wiki_page_id);
        let update = updatesByWikiId.get(updateKey);
        if (!update) {
            const saveLocation = parseSaveLocation(row.save_location);
            const platforms = parseJsonArray(row.platform);
            if (!saveLocation || !platforms) {
                invalidLocalRows.add(updateKey);
                continue;
            }
            update = {
                wiki_page_id: row.wiki_page_id,
                title: row.title,
                saveLocation,
                platforms,
                existingPaths: new Set(saveLocation.win.map(canonicalizeWindowsPath)),
                added: [],
                platformAdded: false
            };
            updatesByWikiId.set(updateKey, update);
        }
        mountedGames.add(updateKey);

        if (!update.platforms.some(platform => platform.toLocaleLowerCase('en-US') === 'xbox')) {
            update.platforms.push('Xbox');
            update.platformAdded = true;
        }

        const comparisonPath = canonicalizeWindowsPath(entry.savePath);
        if (update.existingPaths.has(comparisonPath)) {
            counters.alreadyPresentPaths += 1;
            continue;
        }
        update.existingPaths.add(comparisonPath);
        update.saveLocation.win.push(entry.savePath);
        update.added.push({ source: entry.source, path: entry.savePath });
        counters.addedPaths += 1;
        if (entry.source === 'pgs') counters.addedPgsPaths += 1;
        else counters.addedWgsPaths += 1;
    }

    const updates = [];
    for (const update of updatesByWikiId.values()) {
        if (update.added.length === 0 && !update.platformAdded) continue;
        updates.push({
            wiki_page_id: update.wiki_page_id,
            title: update.title,
            save_location: JSON.stringify(update.saveLocation),
            platform: JSON.stringify(update.platforms),
            added: update.added,
            platform_added: update.platformAdded
        });
    }
    updates.sort((left, right) => String(left.title).localeCompare(String(right.title), 'en'));
    counters.matchedGames = matchedGames.size;
    counters.mountedGames = mountedGames.size;
    counters.invalidLocalRows = invalidLocalRows.size;
    counters.updatedGames = updates.length;
    const mountedWikiIds = [...mountedGames].sort((left, right) => Number(left) - Number(right));
    return { updates, unmatched, conflicts, counters, mountedWikiIds };
}

async function fetchText(url, maximumBytes, label) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);
        try {
            const response = await fetch(url, {
                headers: {
                    'Accept': 'application/json, text/plain;q=0.9',
                    'User-Agent': 'OpenGameSave-XgpSaveTools-Sync'
                },
                redirect: 'follow',
                signal: controller.signal
            });
            if (!response.ok) throw new Error(`${label} download failed: HTTP ${response.status}`);
            const contentLength = Number(response.headers.get('content-length') || 0);
            if (contentLength > maximumBytes) throw new Error(`${label} download is too large`);
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length === 0 || bytes.length > maximumBytes) {
                throw new Error(`${label} download has an invalid size`);
            }
            return bytes.toString('utf8');
        } catch (error) {
            lastError = error;
            if (attempt < 3) {
                await new Promise(resolve => {
                    setTimeout(resolve, attempt * 1000);
                });
            }
        } finally {
            clearTimeout(timeout);
        }
    }
    const cause = lastError?.cause?.message || lastError?.message || 'unknown network error';
    throw new Error(`Unable to download ${label} after 3 attempts: ${cause}`);
}

function loadTextFile(filePath, maximumBytes, label) {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size === 0 || stats.size > maximumBytes) {
        throw new Error(`${label} file has an invalid size`);
    }
    return fs.readFileSync(filePath, 'utf8');
}

function validateMitLicense(licenseText) {
    const requiredPhrases = [
        'MIT License',
        'Copyright (c) 2026 Bruno Rodrigues',
        'Permission is hereby granted, free of charge',
        'THE SOFTWARE IS PROVIDED "AS IS"'
    ];
    if (requiredPhrases.some(phrase => !licenseText.includes(phrase))) {
        throw new Error('XgpSaveTools license is not the expected MIT license');
    }
}

function writeJsonFile(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function applyUpdates(database, updates, mountedWikiIds, sourceMetadata = {}) {
    const updateRow = database.prepare(`
        UPDATE games
        SET save_location = ?, platform = ?
        WHERE wiki_page_id = ? AND title = ?
    `);
    const transaction = database.transaction(() => {
        for (const update of updates) {
            const result = updateRow.run(update.save_location, update.platform, update.wiki_page_id, update.title);
            if (result.changes !== 1) {
                throw new Error(`Database row changed while syncing: ${update.title}`);
            }
        }
        const metadataValue = JSON.stringify(mountedWikiIds);
        if (metadataValue.length > 4096) throw new Error('XgpSaveTools mounted game metadata is too large');
        const upsertMetadata = database.prepare(`
            INSERT INTO metadata (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `);
        upsertMetadata.run(XGP_WIKI_IDS_METADATA_KEY, metadataValue);
        upsertMetadata.run(DATABASE_VARIANT_METADATA_KEY, 'xbox');
        for (const [key, value] of Object.entries(sourceMetadata)) {
            if (typeof value !== 'string' || value.length > 4096) {
                throw new Error(`XgpSaveTools metadata is invalid: ${key}`);
            }
            upsertMetadata.run(key, value);
        }
    });
    transaction();
}

function readMountedWikiIds(database) {
    const metadata = database.prepare('SELECT value FROM metadata WHERE key = ?').get(XGP_WIKI_IDS_METADATA_KEY);
    if (!metadata) return [];
    let parsed;
    try {
        parsed = JSON.parse(metadata.value);
    } catch (_) {
        throw new Error('Existing XgpSaveTools mounted game metadata is invalid');
    }
    if (!Array.isArray(parsed) || parsed.length > 1000
        || parsed.some(value => !Number.isSafeInteger(Number(value)) || Number(value) < 0)) {
        throw new Error('Existing XgpSaveTools mounted game metadata is invalid');
    }
    return parsed.map(String);
}

async function main() {
    const args = parseArgs(process.argv);
    const databasePath = path.resolve(args.database || path.join(__dirname, '..', 'database', 'database.db'));
    const reportPath = path.resolve(args.report || path.join(__dirname, '..', 'dist', 'xgp-save-tools-sync-report.json'));
    const statePath = args.state ? path.resolve(args.state) : null;
    const licensePath = path.resolve(args['license-file'] || path.join(__dirname, '..', 'database', 'licenses', 'XGPSAVETOOLS-LICENSE.txt'));
    const registryUrl = args['registry-url'] || DEFAULT_REGISTRY_URL;
    const maxUpdates = parsePositiveInteger(args['max-updates'], DEFAULT_MAX_UPDATES, '--max-updates');
    const maxAddedPaths = parsePositiveInteger(args['max-added-paths'], DEFAULT_MAX_ADDED_PATHS, '--max-added-paths');
    const shouldApply = args.apply === true;

    const registryText = args['registry-file']
        ? loadTextFile(path.resolve(args['registry-file']), MAX_XGP_SOURCE_BYTES, 'Registry')
        : await fetchText(registryUrl, MAX_XGP_SOURCE_BYTES, 'registry');
    const licenseText = loadTextFile(licensePath, MAX_LICENSE_BYTES, 'License');
    validateMitLicense(licenseText);
    const registrySha256 = crypto.createHash('sha256').update(registryText).digest('hex');
    const licenseSha256 = crypto.createHash('sha256').update(licenseText).digest('hex');
    const entries = parseXgpGamesJson(registryText);
    if (entries.length === 0) throw new Error('XgpSaveTools registry is empty');

    const Database = require('better-sqlite3');
    const database = new Database(databasePath, { fileMustExist: true, timeout: 10000 });
    let plan;
    try {
        const integrity = database.prepare('PRAGMA quick_check').get();
        if (!integrity || integrity.quick_check !== 'ok') throw new Error('Database failed PRAGMA quick_check');
        const rows = database.prepare(`
            SELECT title, wiki_page_id, save_location, platform
            FROM games
        `).all();
        plan = buildSyncPlan(entries, rows);
        plan.persistedMountedWikiIds = [...new Set([
            ...readMountedWikiIds(database),
            ...plan.mountedWikiIds
        ])].sort((left, right) => Number(left) - Number(right));
        plan.counters.persistedMountedGames = plan.persistedMountedWikiIds.length;
        if (plan.updates.length > maxUpdates) {
            throw new Error(`Refusing to update ${plan.updates.length} games; limit is ${maxUpdates}`);
        }
        if (plan.counters.addedPaths > maxAddedPaths) {
            throw new Error(`Refusing to add ${plan.counters.addedPaths} paths; limit is ${maxAddedPaths}`);
        }
        if (shouldApply) {
            applyUpdates(database, plan.updates, plan.persistedMountedWikiIds, {
                xgp_save_tools_registry_sha256: registrySha256,
                xgp_save_tools_license_sha256: licenseSha256,
                xgp_save_tools_license_notice: licenseText.trim()
            });
            const afterIntegrity = database.prepare('PRAGMA quick_check').get();
            if (!afterIntegrity || afterIntegrity.quick_check !== 'ok') {
                throw new Error('Database failed PRAGMA quick_check after the sync');
            }
        }
    } finally {
        database.close();
    }

    const source = {
        name: 'brodrigz/XgpSaveTools',
        project_url: XGP_PROJECT_URL,
        registry_url: args['source-url'] || DEFAULT_REGISTRY_URL,
        license: 'MIT',
        license_url: args['license-url'] || XGP_LICENSE_URL,
        revision: args['upstream-sha'] || null,
        registry_sha256: registrySha256,
        license_sha256: licenseSha256
    };
    const report = {
        schema_version: 1,
        applied: shouldApply,
        source,
        summary: plan.counters,
        conflicts: plan.conflicts,
        unmatched: plan.unmatched,
        updates: plan.updates.map(update => ({
            wiki_page_id: update.wiki_page_id,
            title: update.title,
            added: update.added,
            platform_added: update.platform_added
        }))
    };
    writeJsonFile(reportPath, report);
    if (shouldApply && statePath) {
        writeJsonFile(statePath, {
            schema_version: 1,
            source,
            mode: 'additive-merge-existing-games-only',
            restore_policy: 'pgs-backup-only'
        });
    }

    console.log(JSON.stringify({
        applied: shouldApply,
        database: databasePath,
        report: reportPath,
        ...plan.counters,
        conflicts: plan.conflicts.length
    }, null, 2));
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    DEFAULT_REGISTRY_URL,
    buildSyncPlan,
    canonicalizeWindowsPath,
    createTitleIndex,
    parseSaveLocation,
    readMountedWikiIds,
    validateMitLicense,
    XGP_WIKI_IDS_METADATA_KEY
};
