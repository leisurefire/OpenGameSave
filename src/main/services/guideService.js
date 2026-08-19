const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const { closeDb, dbAll, dbGet, openDb } = require('../sqliteUtils');

const bundledCatalog = require('../../data/gameGuides.json');

const GUIDE_CATALOG_METADATA_KEY = 'game_guide_catalog';
const GUIDE_SEARCH_LIMIT = 24;
const LIBRARY_MATCH_LIMIT = 250;
const GUIDE_CATEGORIES = new Set(['official', 'wiki', 'esports']);
const TRUSTED_GUIDE_HOSTS = new Set([
    'github.com',
    'liquipedia.net',
    'overlab.cn',
    'ow.blizzard.cn',
    'pcgamingwiki.com',
    'www.pcgamingwiki.com'
]);

let databaseCatalogCache = null;
let normalizedBundledCatalog = null;

function getUserDatabasePath() {
    return path.join(app.getPath('userData'), 'OGS Database', 'database.db');
}

function validateGuideUrl(rawUrl) {
    const guideUrl = new URL(String(rawUrl || ''));
    if (guideUrl.protocol !== 'https:'
        || guideUrl.username
        || guideUrl.password
        || (guideUrl.port && guideUrl.port !== '443')
        || !TRUSTED_GUIDE_HOSTS.has(guideUrl.hostname.toLowerCase())) {
        throw new Error('Guide source is not trusted');
    }
    return guideUrl.toString();
}

function normalizeCatalog(rawCatalog) {
    if (!rawCatalog || rawCatalog.version !== 1 || !Array.isArray(rawCatalog.games)) {
        throw new Error('Guide catalog has an unsupported format');
    }
    return {
        version: 1,
        games: rawCatalog.games.slice(0, 100).map((game) => ({
            id: String(game.id || '').slice(0, 80),
            title: String(game.title || '').slice(0, 200),
            title_zh_CN: String(game.title_zh_CN || '').slice(0, 200),
            platform_ids: Object.fromEntries(Object.entries(game.platform_ids || {})
                .slice(0, 10)
                .map(([platform, platformId]) => [String(platform).slice(0, 40), String(platformId).slice(0, 256)])),
            sources: Array.isArray(game.sources) ? game.sources.slice(0, 40).map((source) => {
                const category = String(source.category || '');
                if (!GUIDE_CATEGORIES.has(category)) throw new Error('Guide source category is not supported');
                return {
                    id: String(source.id || '').slice(0, 80),
                    name: String(source.name || '').slice(0, 200),
                    name_zh_CN: String(source.name_zh_CN || '').slice(0, 200),
                    category,
                    language: String(source.language || '').slice(0, 20),
                    url: validateGuideUrl(source.url),
                    description: String(source.description || '').slice(0, 1000),
                    description_zh_CN: String(source.description_zh_CN || '').slice(0, 1000),
                    trust_reason: String(source.trust_reason || '').slice(0, 500),
                    trust_reason_zh_CN: String(source.trust_reason_zh_CN || '').slice(0, 500),
                    verified_at: normalizeVerifiedDate(source.verified_at)
                };
            }) : []
        }))
    };
}

function normalizeVerifiedDate(value) {
    const normalized = String(value || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return '';
    const [year, month, day] = normalized.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
        ? normalized
        : '';
}

function normalizeWikiPageId(rawWikiPageId) {
    const wikiPageId = Number(rawWikiPageId);
    if (!Number.isSafeInteger(wikiPageId) || wikiPageId <= 0) throw new Error('Invalid wiki page id');
    return wikiPageId;
}

function createPcGamingWikiSource(rawWikiPageId) {
    const wikiPageId = normalizeWikiPageId(rawWikiPageId);
    return {
        id: 'pcgamingwiki',
        name: 'PCGamingWiki',
        name_zh_CN: 'PCGamingWiki 技术百科',
        category: 'wiki',
        language: 'en',
        url: validateGuideUrl(`https://www.pcgamingwiki.com/wiki/index.php?curid=${wikiPageId}`),
        description: 'Game-specific fixes, save locations, configuration details, known issues, and PC compatibility notes.',
        description_zh_CN: '面向该游戏的故障修复、存档位置、配置说明、已知问题与 PC 兼容性资料。',
        trust_reason: 'Matched by the stable PCGamingWiki page ID stored in the OpenGameSave database.',
        trust_reason_zh_CN: '通过 OpenGameSave 数据库保存的 PCGamingWiki 稳定页面 ID 精确匹配。',
        verified_at: '2026-08-20'
    };
}

function normalizeTitle(value) {
    return String(value || '').trim().toLocaleLowerCase();
}

function findCuratedGame(catalog, row) {
    const steamId = String(row.steam_id || '');
    const gogId = String(row.gog_id || '');
    const platformMatch = catalog.games.find(game => (
        (steamId && String(game.platform_ids?.Steam || '') === steamId)
        || (gogId && String(game.platform_ids?.GOG || '') === gogId)
    ));
    if (platformMatch) return platformMatch;
    const rowTitles = new Set([normalizeTitle(row.title), normalizeTitle(row.zh_CN)].filter(Boolean));
    const titleMatches = catalog.games.filter(game => (
        rowTitles.has(normalizeTitle(game.title)) || rowTitles.has(normalizeTitle(game.title_zh_CN))
    ));
    return titleMatches.length === 1 ? titleMatches[0] : null;
}

function toGuideGame(row, catalog) {
    const wikiPageId = normalizeWikiPageId(row.wiki_page_id);
    const curated = findCuratedGame(catalog, row);
    const sources = [createPcGamingWikiSource(wikiPageId), ...(curated?.sources || [])]
        .filter((source, index, all) => all.findIndex(candidate => candidate.url === source.url) === index);
    return {
        id: curated?.id || `pcgamingwiki-${wikiPageId}`,
        title: curated?.title || String(row.title || '').slice(0, 200),
        title_zh_CN: curated?.title_zh_CN || String(row.zh_CN || '').slice(0, 200),
        wiki_page_id: String(wikiPageId),
        platform_ids: curated?.platform_ids || Object.fromEntries([
            row.steam_id ? ['Steam', String(row.steam_id)] : null,
            row.gog_id ? ['GOG', String(row.gog_id)] : null
        ].filter(Boolean)),
        sources
    };
}

function openUserDatabase() {
    const databasePath = getUserDatabasePath();
    if (!fs.existsSync(databasePath)) return null;
    try {
        return openDb(databasePath, { readonly: true, fileMustExist: true });
    } catch (error) {
        console.warn('Could not open the game database:', error.message);
        return null;
    }
}

async function readDatabaseCatalog() {
    const databasePath = getUserDatabasePath();
    let fingerprint;
    try {
        const stats = fs.statSync(databasePath);
        fingerprint = `${databasePath}:${stats.size}:${stats.mtimeMs}`;
    } catch {
        return null;
    }
    if (databaseCatalogCache?.fingerprint === fingerprint) return databaseCatalogCache.catalog;
    const database = openUserDatabase();
    if (!database) return null;
    try {
        const row = dbGet(database, 'SELECT value FROM metadata WHERE key = ?', [GUIDE_CATALOG_METADATA_KEY]);
        const catalog = row?.value ? normalizeCatalog(JSON.parse(row.value)) : null;
        databaseCatalogCache = { fingerprint, catalog };
        return catalog;
    } catch (error) {
        console.warn('Could not load guide catalog from the game database:', error.message);
        return null;
    } finally {
        closeDb(database);
    }
}

async function loadGuideCatalog() {
    const databaseCatalog = await readDatabaseCatalog();
    if (databaseCatalog) return databaseCatalog;
    if (!normalizedBundledCatalog) normalizedBundledCatalog = normalizeCatalog(bundledCatalog);
    return normalizedBundledCatalog;
}

function escapeLike(value) {
    return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function searchDatabaseRows(query) {
    const database = openUserDatabase();
    if (!database) return [];
    const escapedQuery = escapeLike(query);
    const pattern = `%${escapedQuery}%`;
    try {
        return dbAll(database, `
            SELECT wiki_page_id, title, zh_CN,
                CAST(steam_id AS TEXT) AS steam_id, CAST(gog_id AS TEXT) AS gog_id
            FROM games
            WHERE title LIKE ? ESCAPE '\\' OR COALESCE(zh_CN, '') LIKE ? ESCAPE '\\'
            ORDER BY
                CASE
                    WHEN LOWER(title) = LOWER(?) OR LOWER(COALESCE(zh_CN, '')) = LOWER(?) THEN 0
                    WHEN title LIKE ? ESCAPE '\\' OR COALESCE(zh_CN, '') LIKE ? ESCAPE '\\' THEN 1
                    ELSE 2
                END,
                title COLLATE NOCASE
            LIMIT ?
        `, [pattern, pattern, query, query, `${escapedQuery}%`, `${escapedQuery}%`, GUIDE_SEARCH_LIMIT]);
    } finally {
        closeDb(database);
    }
}

function findDatabaseRowsByTitles(titles) {
    const normalizedTitles = [...new Set(titles.map(String).map(value => value.trim()).filter(Boolean))].slice(0, 200);
    if (normalizedTitles.length === 0) return [];
    const database = openUserDatabase();
    if (!database) return [];
    const placeholders = normalizedTitles.map(() => '?').join(',');
    try {
        return dbAll(database, `
            SELECT wiki_page_id, title, zh_CN,
                CAST(steam_id AS TEXT) AS steam_id, CAST(gog_id AS TEXT) AS gog_id
            FROM games
            WHERE LOWER(title) IN (${placeholders}) OR LOWER(COALESCE(zh_CN, '')) IN (${placeholders})
        `, [...normalizedTitles.map(normalizeTitle), ...normalizedTitles.map(normalizeTitle)]);
    } finally {
        closeDb(database);
    }
}

async function getGameGuideCatalog() {
    const catalog = await loadGuideCatalog();
    const titles = catalog.games.flatMap(game => [game.title, game.title_zh_CN]);
    const rows = findDatabaseRowsByTitles(titles);
    const matchedCuratedIds = new Set();
    const enrichedGames = rows.map((row) => {
        const game = toGuideGame(row, catalog);
        matchedCuratedIds.add(game.id);
        return game;
    }).filter((game, index, games) => games.findIndex(candidate => candidate.id === game.id) === index);
    return {
        version: catalog.version,
        games: [
            ...enrichedGames,
            ...catalog.games.filter(game => !matchedCuratedIds.has(game.id))
        ]
    };
}

async function searchGameGuides(rawQuery) {
    const query = String(rawQuery || '').trim().slice(0, 100);
    const catalog = await loadGuideCatalog();
    if (!query) return (await getGameGuideCatalog()).games.slice(0, GUIDE_SEARCH_LIMIT);

    const rows = searchDatabaseRows(query);
    const games = rows.map(row => toGuideGame(row, catalog));
    const normalizedQuery = normalizeTitle(query);
    for (const curated of catalog.games) {
        const searchable = `${curated.title} ${curated.title_zh_CN}`.toLocaleLowerCase();
        if (!searchable.includes(normalizedQuery) || games.some(game => game.id === curated.id)) continue;
        games.push(curated);
    }
    return games.slice(0, GUIDE_SEARCH_LIMIT);
}

async function getGameGuideByWikiId(rawWikiPageId) {
    const wikiPageId = normalizeWikiPageId(rawWikiPageId);
    const database = openUserDatabase();
    if (!database) return null;
    try {
        const row = dbGet(database, `
            SELECT wiki_page_id, title, zh_CN,
                CAST(steam_id AS TEXT) AS steam_id, CAST(gog_id AS TEXT) AS gog_id
            FROM games WHERE wiki_page_id = ?
        `, [wikiPageId]);
        if (!row) return null;
        const catalog = await loadGuideCatalog();
        return toGuideGame(row, catalog);
    } finally {
        closeDb(database);
    }
}

function createLibraryMatchQuery(games) {
    const steamIds = [];
    const gogIds = [];
    const titles = [];
    for (const game of games.slice(0, LIBRARY_MATCH_LIMIT)) {
        const platformId = String(game.platformId || '').trim();
        if (game.platform === 'Steam' && /^\d{1,12}$/.test(platformId) && !/^0+$/.test(platformId)) {
            steamIds.push(platformId);
        }
        if (game.platform === 'GOG' && /^\d{1,20}$/.test(platformId) && !/^0+$/.test(platformId)) {
            gogIds.push(platformId);
        }
        const title = String(game.title || '').trim().slice(0, 200);
        if (title) titles.push(normalizeTitle(title));
    }
    const conditions = [];
    const params = [];
    for (const [column, values] of [['steam_id', steamIds], ['gog_id', gogIds]]) {
        const uniqueValues = [...new Set(values)];
        if (uniqueValues.length === 0) continue;
        conditions.push(`${column} IN (${uniqueValues.map(() => '?').join(',')})`);
        params.push(...uniqueValues);
    }
    const uniqueTitles = [...new Set(titles)];
    if (uniqueTitles.length) {
        const placeholders = uniqueTitles.map(() => '?').join(',');
        conditions.push(`(LOWER(title) IN (${placeholders}) OR LOWER(COALESCE(zh_CN, '')) IN (${placeholders}))`);
        params.push(...uniqueTitles, ...uniqueTitles);
    }
    if (conditions.length === 0) return null;

    return {
        sql: `
            SELECT wiki_page_id, title, zh_CN,
                CAST(steam_id AS TEXT) AS steam_id, CAST(gog_id AS TEXT) AS gog_id
            FROM games WHERE ${conditions.join(' OR ')}
            ORDER BY wiki_page_id
        `,
        params
    };
}

function selectLibraryMatchRows(games) {
    const database = openUserDatabase();
    if (!database) return [];
    try {
        const rows = [];
        const seenWikiIds = new Set();
        for (let start = 0; start < games.length; start += LIBRARY_MATCH_LIMIT) {
            const query = createLibraryMatchQuery(games.slice(start, start + LIBRARY_MATCH_LIMIT));
            if (!query) continue;
            for (const row of dbAll(database, query.sql, query.params)) {
                const wikiPageId = String(row.wiki_page_id);
                if (seenWikiIds.has(wikiPageId)) continue;
                seenWikiIds.add(wikiPageId);
                rows.push(row);
            }
        }
        return rows;
    } finally {
        closeDb(database);
    }
}

function createUniqueTitleMap(rows) {
    const candidates = new Map();
    const ambiguous = new Set();
    for (const row of rows) {
        for (const title of [row.title, row.zh_CN].map(normalizeTitle).filter(Boolean)) {
            const existing = candidates.get(title);
            if (existing && String(existing.wiki_page_id) !== String(row.wiki_page_id)) ambiguous.add(title);
            else if (!existing) candidates.set(title, row);
        }
    }
    for (const title of ambiguous) candidates.delete(title);
    return candidates;
}

function matchLibraryGamesToGuideRows(games, rows) {
    const bySteamId = new Map(rows.filter(row => row.steam_id).map(row => [String(row.steam_id), row]));
    const byGogId = new Map(rows.filter(row => row.gog_id).map(row => [String(row.gog_id), row]));
    const byTitle = createUniqueTitleMap(rows);
    return games.map((game) => {
        const platformId = String(game.platformId || '');
        const titleMatch = byTitle.get(normalizeTitle(game.title));
        const row = game.platform === 'Steam' ? bySteamId.get(platformId) || titleMatch
            : game.platform === 'GOG' ? byGogId.get(platformId) || titleMatch
                : titleMatch;
        if (!row) return game;
        return {
            ...game,
            guide: {
                wikiPageId: String(row.wiki_page_id),
                title: String(row.title || ''),
                titleZhCN: String(row.zh_CN || '')
            }
        };
    });
}

function enrichLibraryGamesWithGuides(games) {
    if (!Array.isArray(games) || games.length === 0) return [];
    const rows = selectLibraryMatchRows(games);
    return matchLibraryGamesToGuideRows(games, rows);
}

module.exports = {
    GUIDE_CATALOG_METADATA_KEY,
    TRUSTED_GUIDE_HOSTS,
    createPcGamingWikiSource,
    enrichLibraryGamesWithGuides,
    getGameGuideByWikiId,
    getGameGuideCatalog,
    matchLibraryGamesToGuideRows,
    normalizeCatalog,
    normalizeVerifiedDate,
    searchGameGuides,
    validateGuideUrl
};
