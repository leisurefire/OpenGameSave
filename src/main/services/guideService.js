const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const { closeDb, dbGet, openDb } = require('../sqliteUtils');

const bundledCatalog = require('../../data/gameGuides.json');

const GUIDE_CATALOG_METADATA_KEY = 'game_guide_catalog';
const TRUSTED_GUIDE_HOSTS = new Set(['liquipedia.net', 'overlab.cn', 'ow.blizzard.cn']);

function getUserDatabasePath() {
    return path.join(app.getPath('userData'), 'OGS Database', 'database.db');
}

function validateGuideUrl(rawUrl) {
    const guideUrl = new URL(String(rawUrl || ''));
    if (guideUrl.protocol !== 'https:' || !TRUSTED_GUIDE_HOSTS.has(guideUrl.hostname.toLowerCase())) {
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
            sources: Array.isArray(game.sources) ? game.sources.slice(0, 40).map(source => ({
                id: String(source.id || '').slice(0, 80),
                name: String(source.name || '').slice(0, 200),
                name_zh_CN: String(source.name_zh_CN || '').slice(0, 200),
                category: String(source.category || '').slice(0, 40),
                language: String(source.language || '').slice(0, 20),
                url: validateGuideUrl(source.url),
                description: String(source.description || '').slice(0, 1000),
                description_zh_CN: String(source.description_zh_CN || '').slice(0, 1000)
            })) : []
        }))
    };
}

async function readDatabaseCatalog() {
    const databasePath = getUserDatabasePath();
    if (!fs.existsSync(databasePath)) return null;
    const database = await openDb(databasePath, { readonly: true, fileMustExist: true });
    try {
        const row = await dbGet(database, 'SELECT value FROM metadata WHERE key = ?', [GUIDE_CATALOG_METADATA_KEY]);
        return row?.value ? normalizeCatalog(JSON.parse(row.value)) : null;
    } catch (error) {
        console.warn('Could not load guide catalog from the game database:', error.message);
        return null;
    } finally {
        await closeDb(database);
    }
}

async function getGameGuideCatalog() {
    return await readDatabaseCatalog() || normalizeCatalog(bundledCatalog);
}

module.exports = {
    GUIDE_CATALOG_METADATA_KEY,
    getGameGuideCatalog,
    normalizeCatalog,
    validateGuideUrl
};
