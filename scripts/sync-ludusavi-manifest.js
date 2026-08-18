#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const yaml = require('js-yaml');

const { normalizeRegistryKeyPath } = require('../src/main/validation');

const DEFAULT_MANIFEST_URL = 'https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml';
const LUDUSAVI_LICENSE_URL = 'https://github.com/mtkennerly/ludusavi-manifest/blob/master/LICENSE';
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_GAMES = 100000;
const DEFAULT_MAX_UPDATES = 10000;
const DEFAULT_MAX_ADDED_PATHS = 50000;
const PROJECT_PLATFORM_KEYS = ['win', 'reg', 'linux', 'mac'];
const FILE_PLATFORM_KEYS = ['win', 'linux', 'mac'];

function parseArgs(argv) {
    const args = {};
    for (let index = 2; index < argv.length; index++) {
        const argument = argv[index];
        if (!argument.startsWith('--')) continue;
        const key = argument.slice(2);
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
            args[key] = next;
            index++;
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

function normalizeTitle(value) {
    return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function canonicalizePlaceholderPath(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/\{\{p\|userprofile\}\}\/appdata\/locallow/gi, '{{p|userprofile/appdata/locallow}}')
        .replace(/\{\{p\|userprofile\}\}\/documents/gi, '{{p|userprofile/documents}}')
        .replace(/^c:\/xboxgames\/gamesave\/pgs/gi, '{{p|systemdrive}}/XboxGames/GameSave/pgs')
        .replace(/\/+$/, '')
        .toLocaleLowerCase('en-US');
}

function hasUnsafeSegments(value) {
    const normalized = String(value || '').replace(/\\/g, '/');
    return normalized.split('/').some(segment => segment === '.' || segment === '..');
}

function getConditions(details) {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return [{}];
    if (!Array.isArray(details.when) || details.when.length === 0) return [{}];
    const conditions = details.when.filter(condition => condition && typeof condition === 'object' && !Array.isArray(condition));
    return conditions.length > 0 ? conditions : [{}];
}

function inferOperatingSystems(manifestPath, condition) {
    const explicitOs = condition.os;
    if (explicitOs !== undefined) {
        if (explicitOs === 'windows') return ['win'];
        if (explicitOs === 'linux') return ['linux'];
        if (explicitOs === 'mac') return ['mac'];
        return [];
    }

    const normalized = manifestPath.replace(/\\/g, '/').toLocaleLowerCase('en-US');
    if (normalized.startsWith('<win') || /^[a-z]:\//.test(normalized)) return ['win'];
    if (normalized.startsWith('<xdg')) return ['linux'];
    if (normalized.startsWith('<home>/appdata/') || normalized.startsWith('<home>/documents/')) return ['win'];
    if (normalized.startsWith('<home>/library/')) return ['mac'];
    if (normalized.startsWith('<home>/.')) return ['linux'];
    if (normalized.startsWith('<root>')) return condition.store === 'steam' ? ['win'] : [];

    if (condition.store && ['microsoft', 'epic', 'gog', 'uplay'].includes(condition.store)) {
        return ['win'];
    }
    if (normalized.startsWith('<home>') || normalized.startsWith('<base>')) {
        return ['win', 'linux', 'mac'];
    }
    return [];
}

function replaceToken(value, token, replacement) {
    return value.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), replacement);
}

function convertManifestFilePath(manifestPath, platformKey, condition = {}) {
    if (typeof manifestPath !== 'string'
        || manifestPath.length === 0
        || manifestPath.length > 32767
        || manifestPath.includes('\0')
        || /[\r\n]/.test(manifestPath)
        || hasUnsafeSegments(manifestPath)) {
        return null;
    }

    let converted = manifestPath.replace(/\\/g, '/');
    const lowerPath = converted.toLocaleLowerCase('en-US');
    const isPgs = lowerPath.includes('/xboxgames/gamesave/pgs/')
        || lowerPath.startsWith('c:/xboxgames/gamesave/pgs/');

    if (platformKey === 'win') {
        converted = converted
            .replace(/^<home>\/AppData\/LocalLow(?=\/|$)/i, '{{p|userprofile/appdata/locallow}}')
            .replace(/^<home>\/AppData\/Local(?=\/|$)/i, '{{p|localappdata}}')
            .replace(/^<home>\/AppData\/Roaming(?=\/|$)/i, '{{p|appdata}}')
            .replace(/^<home>\/Documents(?=\/|$)/i, '{{p|userprofile/documents}}');
    }

    const homePlaceholder = platformKey === 'win'
        ? '{{p|userprofile}}'
        : platformKey === 'linux'
            ? '{{p|linuxhome}}'
            : '{{p|osxhome}}';

    const replacements = new Map([
        ['<home>', homePlaceholder],
        ['<base>', '{{p|game}}'],
        ['<storeUserId>', isPgs && condition.store === 'microsoft' ? '{{p|xbox_uid}}' : '{{p|uid}}'],
        ['<osUserName>', '{{p|username}}']
    ]);

    if (platformKey === 'win') {
        replacements.set('<winLocalAppData>', '{{p|localappdata}}');
        replacements.set('<winAppData>', '{{p|appdata}}');
        replacements.set('<winDocuments>', '{{p|userprofile/documents}}');
        replacements.set('<winProgramData>', '{{p|programdata}}');
        replacements.set('<winPublic>', '{{p|public}}');
        replacements.set('<winDir>', '{{p|windir}}');
    } else if (platformKey === 'linux') {
        replacements.set('<xdgConfig>', '{{p|xdgconfighome}}');
        replacements.set('<xdgData>', '{{p|xdgdatahome}}');
    }

    if (platformKey === 'win' && condition.store === 'steam') {
        replacements.set('<root>', '{{p|steam}}');
    } else if (platformKey === 'win' && condition.store === 'uplay') {
        replacements.set('<root>', '{{p|uplay}}');
    }

    for (const [token, replacement] of replacements) {
        converted = replaceToken(converted, token, replacement);
    }

    if (isPgs) {
        converted = converted.replace(/^C:\/XboxGames(?=\/|$)/i, '{{p|systemdrive}}/XboxGames');
    }

    if (/<[^>]+>/.test(converted)) return null;
    if (!converted.startsWith('{{p|')) return null;

    converted = converted.replace(/\/+/g, '/').replace(/\/+$/, '');
    if (platformKey === 'win') {
        converted = converted.replace(/\{\{p\|[^}]+\}\}|\/+/g, match => (
            match.startsWith('{{p|') ? match : '\\'
        ));
    }
    return converted;
}

function convertManifestRegistryPath(manifestPath, condition = {}) {
    if (typeof manifestPath !== 'string'
        || manifestPath.length === 0
        || manifestPath.length > 16384
        || manifestPath.includes('\0')
        || /[\r\n]/.test(manifestPath)
        || hasUnsafeSegments(manifestPath)) {
        return null;
    }

    let converted = manifestPath.replace(/\//g, '\\');
    converted = replaceToken(converted, '<storeUserId>', condition.store === 'microsoft' ? '{{p|xbox_uid}}' : '{{p|uid}}');
    converted = replaceToken(converted, '<osUserName>', '{{p|username}}');
    if (/<[^>]+>/.test(converted)) return null;

    converted = converted
        .replace(/^HKEY_CURRENT_USER(?=\\|$)/i, '{{p|hkcu}}')
        .replace(/^HKEY_LOCAL_MACHINE(?=\\|$)/i, '{{p|hklm}}');

    const expanded = converted
        .replace(/^\{\{p\|hkcu\}\}/i, 'HKEY_CURRENT_USER')
        .replace(/^\{\{p\|hklm\}\}/i, 'HKEY_LOCAL_MACHINE');
    try {
        normalizeRegistryKeyPath(expanded);
    } catch (_) {
        return null;
    }
    return converted.replace(/\\+$/, '');
}

function convertManifestEntry(entry) {
    const candidates = [];
    let unsupportedPaths = 0;

    for (const [manifestPath, details] of Object.entries(entry.files || {})) {
        let convertedAny = false;
        for (const condition of getConditions(details)) {
            for (const platformKey of inferOperatingSystems(manifestPath, condition)) {
                if (!FILE_PLATFORM_KEYS.includes(platformKey)) continue;
                const converted = convertManifestFilePath(manifestPath, platformKey, condition);
                if (!converted) continue;
                convertedAny = true;
                candidates.push({
                    platformKey,
                    path: converted,
                    store: typeof condition.store === 'string' ? condition.store : null,
                    xboxPgs: canonicalizePlaceholderPath(converted).includes('/xboxgames/gamesave/pgs/')
                });
            }
        }
        if (!convertedAny) unsupportedPaths++;
    }

    for (const [manifestPath, details] of Object.entries(entry.registry || {})) {
        let convertedAny = false;
        for (const condition of getConditions(details)) {
            if (condition.os && condition.os !== 'windows') continue;
            const converted = convertManifestRegistryPath(manifestPath, condition);
            if (!converted) continue;
            convertedAny = true;
            candidates.push({
                platformKey: 'reg',
                path: converted,
                store: typeof condition.store === 'string' ? condition.store : null,
                xboxPgs: false
            });
        }
        if (!convertedAny) unsupportedPaths++;
    }

    const deduplicated = new Map();
    for (const candidate of candidates) {
        const key = `${candidate.platformKey}:${canonicalizePlaceholderPath(candidate.path)}`;
        const previous = deduplicated.get(key);
        if (!previous || (!previous.store && candidate.store)) deduplicated.set(key, candidate);
    }

    return { candidates: [...deduplicated.values()], unsupportedPaths };
}

function addToIndex(index, key, row) {
    if (key === null || key === undefined || key === '') return;
    const normalized = String(key);
    if (!index.has(normalized)) index.set(normalized, []);
    index.get(normalized).push(row);
}

function createGameIndexes(rows) {
    const indexes = {
        steam: new Map(),
        gog: new Map(),
        title: new Map()
    };
    for (const row of rows) {
        addToIndex(indexes.steam, row.steam_id, row);
        addToIndex(indexes.gog, row.gog_id, row);
        addToIndex(indexes.title, normalizeTitle(row.title), row);
    }
    return indexes;
}

function getUniqueIndexMatch(index, key) {
    if (key === null || key === undefined || key === '') return null;
    const matches = index.get(String(key)) || [];
    return matches.length === 1 ? matches[0] : null;
}

function resolveManifestGame(name, entry, indexes) {
    const stableMatches = [];
    const steamMatch = getUniqueIndexMatch(indexes.steam, entry.steam?.id);
    const gogMatch = getUniqueIndexMatch(indexes.gog, entry.gog?.id);
    if (steamMatch) stableMatches.push({ method: 'steam', row: steamMatch });
    if (gogMatch) stableMatches.push({ method: 'gog', row: gogMatch });

    const stableWikiIds = new Set(stableMatches.map(match => String(match.row.wiki_page_id)));
    if (stableWikiIds.size > 1) {
        return {
            conflict: true,
            reason: 'Steam and GOG identifiers point to different OpenGameSave rows',
            evidence: stableMatches.map(match => ({ method: match.method, wiki_page_id: match.row.wiki_page_id }))
        };
    }
    if (stableMatches.length > 0) {
        return {
            row: stableMatches[0].row,
            method: [...new Set(stableMatches.map(match => match.method))].join('+')
        };
    }

    const titleMatch = getUniqueIndexMatch(indexes.title, normalizeTitle(name));
    return titleMatch ? { row: titleMatch, method: 'title' } : null;
}

function parseSaveLocation(row) {
    let parsed;
    try {
        parsed = JSON.parse(row.save_location);
    } catch (_) {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const normalized = {};
    for (const key of PROJECT_PLATFORM_KEYS) {
        if (parsed[key] !== undefined && !Array.isArray(parsed[key])) return null;
        normalized[key] = [...(parsed[key] || [])];
        if (normalized[key].some(item => typeof item !== 'string' || !item)) return null;
    }
    return normalized;
}

function addXboxPlatform(platformValue) {
    let platforms;
    try {
        platforms = JSON.parse(platformValue || '[]');
    } catch (_) {
        return platformValue;
    }
    if (!Array.isArray(platforms) || platforms.some(item => typeof item !== 'string')) return platformValue;
    if (!platforms.some(item => item.toLocaleLowerCase('en-US') === 'xbox')) platforms.push('Xbox');
    return JSON.stringify(platforms);
}

function serializeSaveLocation(location) {
    return JSON.stringify({
        win: location.win,
        reg: location.reg,
        linux: location.linux,
        mac: location.mac
    });
}

function buildSyncPlan(manifest, rows) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error('Ludusavi manifest must be a mapping of game titles');
    }
    const manifestEntries = Object.entries(manifest);
    if (manifestEntries.length > MAX_MANIFEST_GAMES) {
        throw new Error(`Ludusavi manifest contains too many games: ${manifestEntries.length}`);
    }

    const indexes = createGameIndexes(rows);
    let updates = [];
    const updatesByWikiId = new Map();
    const conflicts = [];
    const counters = {
        manifestGames: manifestEntries.length,
        manifestGamesWithBackupData: 0,
        matchedGames: 0,
        unmatchedGames: 0,
        invalidLocalRows: 0,
        unsupportedPaths: 0,
        addedPaths: 0,
        addedXboxPgsPaths: 0,
        normalizedPaths: 0,
        normalizedXboxPgsPaths: 0,
        updatedGames: 0
    };

    for (const [name, entry] of manifestEntries) {
        if (typeof name !== 'string'
            || !entry
            || typeof entry !== 'object'
            || Array.isArray(entry)
            || (!entry.files && !entry.registry)) {
            continue;
        }
        counters.manifestGamesWithBackupData++;

        const match = resolveManifestGame(name, entry, indexes);
        if (match?.conflict) {
            conflicts.push({ name, ...match });
            continue;
        }
        if (!match) {
            counters.unmatchedGames++;
            continue;
        }
        counters.matchedGames++;

        const location = parseSaveLocation(match.row);
        if (!location) {
            counters.invalidLocalRows++;
            continue;
        }

        const converted = convertManifestEntry(entry);
        counters.unsupportedPaths += converted.unsupportedPaths;
        const existing = Object.fromEntries(PROJECT_PLATFORM_KEYS.map(key => [
            key,
            new Set(location[key].map(canonicalizePlaceholderPath))
        ]));
        const added = { win: [], reg: [], linux: [], mac: [] };
        const normalized = [];
        let addsXboxPlatform = false;

        for (const candidate of converted.candidates) {
            const comparisonKey = canonicalizePlaceholderPath(candidate.path);
            if (existing[candidate.platformKey].has(comparisonKey)) {
                if (candidate.xboxPgs) {
                    const existingIndex = location[candidate.platformKey].findIndex(item => (
                        canonicalizePlaceholderPath(item) === comparisonKey && item !== candidate.path
                    ));
                    if (existingIndex !== -1) {
                        const previousPath = location[candidate.platformKey][existingIndex];
                        location[candidate.platformKey][existingIndex] = candidate.path;
                        normalized.push({
                            platform: candidate.platformKey,
                            from: previousPath,
                            to: candidate.path
                        });
                        counters.normalizedPaths++;
                        counters.normalizedXboxPgsPaths++;
                    }
                }
                continue;
            }
            existing[candidate.platformKey].add(comparisonKey);
            added[candidate.platformKey].push(candidate.path);
            counters.addedPaths++;
            if (candidate.xboxPgs) counters.addedXboxPgsPaths++;
            if (candidate.store === 'microsoft' || candidate.xboxPgs) addsXboxPlatform = true;
        }

        const addedCount = PROJECT_PLATFORM_KEYS.reduce((total, key) => total + added[key].length, 0);
        if (addedCount === 0 && normalized.length === 0) continue;

        for (const key of PROJECT_PLATFORM_KEYS) {
            added[key].sort((left, right) => left.localeCompare(right, 'en'));
            location[key].push(...added[key]);
        }
        const updatedPlatform = addsXboxPlatform ? addXboxPlatform(match.row.platform) : match.row.platform;
        const serializedLocation = serializeSaveLocation(location);
        match.row.save_location = serializedLocation;
        match.row.platform = updatedPlatform;
        const update = {
            wiki_page_id: match.row.wiki_page_id,
            title: match.row.title,
            matched_by: match.method,
            save_location: serializedLocation,
            platform: updatedPlatform,
            added,
            normalized
        };
        const updateKey = String(match.row.wiki_page_id);
        const previousUpdate = updatesByWikiId.get(updateKey);
        if (previousUpdate) {
            previousUpdate.save_location = update.save_location;
            previousUpdate.platform = update.platform;
            previousUpdate.matched_by = [...new Set(`${previousUpdate.matched_by}+${update.matched_by}`.split('+'))].join('+');
            for (const key of PROJECT_PLATFORM_KEYS) previousUpdate.added[key].push(...update.added[key]);
            previousUpdate.normalized.push(...update.normalized);
        } else {
            updatesByWikiId.set(updateKey, update);
        }
    }

    updates = [...updatesByWikiId.values()];
    updates.sort((left, right) => String(left.title).localeCompare(String(right.title), 'en'));
    counters.updatedGames = updates.length;
    return { updates, conflicts, counters };
}

async function fetchManifestText(url) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);
        try {
            const response = await fetch(url, {
                headers: {
                    'Accept': 'application/yaml, text/yaml, text/plain',
                    'User-Agent': 'OpenGameSave-Ludusavi-Sync'
                },
                redirect: 'follow',
                signal: controller.signal
            });
            if (!response.ok) throw new Error(`Manifest download failed: HTTP ${response.status}`);
            const contentLength = Number(response.headers.get('content-length') || 0);
            if (contentLength > MAX_MANIFEST_BYTES) throw new Error('Manifest download is too large');
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
                throw new Error('Manifest download has an invalid size');
            }
            return bytes.toString('utf8');
        } catch (error) {
            lastError = error;
            if (attempt < 3) {
                await new Promise((resolve) => {
                    setTimeout(resolve, attempt * 1000);
                });
            }
        } finally {
            clearTimeout(timeout);
        }
    }
    const cause = lastError?.cause?.message || lastError?.message || 'unknown network error';
    throw new Error(`Unable to download Ludusavi manifest after 3 attempts: ${cause}`);
}

function loadManifestTextFromFile(filePath) {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_MANIFEST_BYTES) {
        throw new Error('Manifest file has an invalid size');
    }
    return fs.readFileSync(filePath, 'utf8');
}

function writeJsonFile(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function applyUpdates(database, updates) {
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
    });
    transaction();
}

async function main() {
    const args = parseArgs(process.argv);
    const databasePath = path.resolve(args.database || path.join(__dirname, '..', 'database', 'database.db'));
    const reportPath = path.resolve(args.report || path.join(__dirname, '..', 'dist', 'ludusavi-sync-report.json'));
    const statePath = path.resolve(args.state || path.join(__dirname, '..', 'database', 'sources', 'ludusavi.json'));
    const manifestUrl = args['manifest-url'] || DEFAULT_MANIFEST_URL;
    const maxUpdates = parsePositiveInteger(args['max-updates'], DEFAULT_MAX_UPDATES, '--max-updates');
    const maxAddedPaths = parsePositiveInteger(args['max-added-paths'], DEFAULT_MAX_ADDED_PATHS, '--max-added-paths');
    const shouldApply = args.apply === true;

    const manifestText = args['manifest-file']
        ? loadManifestTextFromFile(path.resolve(args['manifest-file']))
        : await fetchManifestText(manifestUrl);
    const manifestSha256 = crypto.createHash('sha256').update(manifestText).digest('hex');
    const manifest = yaml.load(manifestText);

    // Load the native dependency only for the CLI. Unit tests can exercise the converter
    // with plain JavaScript objects on machines that use a different Node ABI.
    const Database = require('better-sqlite3');
    const database = new Database(databasePath, { fileMustExist: true, timeout: 10000 });
    let plan;
    try {
        const integrity = database.prepare('PRAGMA quick_check').get();
        if (!integrity || integrity.quick_check !== 'ok') throw new Error('Database failed PRAGMA quick_check');
        const gamesTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'games'").get();
        if (!gamesTable) throw new Error('Database does not contain the games table');
        const rows = database.prepare(`
            SELECT title, wiki_page_id, install_folder, steam_id, gog_id, save_location, platform
            FROM games
        `).all();
        plan = buildSyncPlan(manifest, rows);

        if (plan.updates.length > maxUpdates) {
            throw new Error(`Refusing to update ${plan.updates.length} games; limit is ${maxUpdates}`);
        }
        if (plan.counters.addedPaths > maxAddedPaths) {
            throw new Error(`Refusing to add ${plan.counters.addedPaths} paths; limit is ${maxAddedPaths}`);
        }

        if (shouldApply && plan.updates.length > 0) {
            applyUpdates(database, plan.updates);
            const afterIntegrity = database.prepare('PRAGMA quick_check').get();
            if (!afterIntegrity || afterIntegrity.quick_check !== 'ok') {
                throw new Error('Database failed PRAGMA quick_check after the sync');
            }
        }
    } finally {
        database.close();
    }

    const source = {
        name: 'mtkennerly/ludusavi-manifest',
        url: args['source-url'] || (args['manifest-file'] ? path.resolve(args['manifest-file']) : manifestUrl),
        license: 'MIT',
        license_url: LUDUSAVI_LICENSE_URL,
        sha256: manifestSha256
    };
    const report = {
        schema_version: 1,
        applied: shouldApply,
        source,
        summary: plan.counters,
        conflicts: plan.conflicts,
        updates: plan.updates.map(update => ({
            wiki_page_id: update.wiki_page_id,
            title: update.title,
            matched_by: update.matched_by,
            added: update.added,
            normalized: update.normalized
        }))
    };
    writeJsonFile(reportPath, report);

    if (shouldApply && plan.updates.length > 0) {
        writeJsonFile(statePath, {
            schema_version: 1,
            source,
            mode: 'merge-existing-games-only'
        });
    }

    console.log(JSON.stringify({
        applied: shouldApply,
        database: databasePath,
        report: reportPath,
        source_sha256: manifestSha256,
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
    DEFAULT_MANIFEST_URL,
    addXboxPlatform,
    buildSyncPlan,
    canonicalizePlaceholderPath,
    convertManifestEntry,
    convertManifestFilePath,
    convertManifestRegistryPath,
    inferOperatingSystems,
    normalizeTitle,
    resolveManifestGame,
    serializeSaveLocation
};
