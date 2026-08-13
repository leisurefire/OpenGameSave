const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const axios = require('axios');

const {
    MAX_XGP_SOURCE_BYTES,
    normalizeXgpEntries,
    parseXgpGamesJson
} = require('./xgpSourceFormat');

const XGP_SOURCE_URL = 'https://raw.githubusercontent.com/brodrigz/XgpSaveTools/master/XgpSaveTools/games.json';
const XGP_PROJECT_URL = 'https://github.com/brodrigz/XgpSaveTools';
const XGP_CACHE_SCHEMA_VERSION = 1;
const XGP_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let refreshPromise = null;

function getXgpCachePath() {
    return path.join(app.getPath('userData'), 'OGS Database', 'sources', 'xgp-save-tools.json');
}

function validateCachePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || payload.schemaVersion !== XGP_CACHE_SCHEMA_VERSION
        || payload.sourceUrl !== XGP_SOURCE_URL
        || typeof payload.fetchedAt !== 'string'
        || !Number.isFinite(Date.parse(payload.fetchedAt))
        || typeof payload.sourceSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(payload.sourceSha256)) {
        throw new Error('XgpSaveTools cache metadata is invalid');
    }
    return {
        schemaVersion: XGP_CACHE_SCHEMA_VERSION,
        sourceUrl: XGP_SOURCE_URL,
        projectUrl: XGP_PROJECT_URL,
        fetchedAt: payload.fetchedAt,
        sourceSha256: payload.sourceSha256,
        entries: normalizeXgpEntries(payload.entries)
    };
}

function readXgpCache() {
    try {
        const cachePath = getXgpCachePath();
        const stats = fs.statSync(cachePath);
        if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_XGP_SOURCE_BYTES) return null;
        return validateCachePayload(JSON.parse(fs.readFileSync(cachePath, 'utf8')));
    } catch (error) {
        if (error?.code !== 'ENOENT') console.warn(`Ignoring invalid XgpSaveTools cache: ${error.message}`);
        return null;
    }
}

function getExperimentalXgpEntries(enabled) {
    if (enabled !== true) return [];
    return readXgpCache()?.entries || [];
}

async function writeXgpCache(payload) {
    const cachePath = getXgpCachePath();
    const tempPath = `${cachePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        await fs.promises.mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
        await fs.promises.writeFile(tempPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
        await fs.promises.rename(tempPath, cachePath);
    } finally {
        await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    }
}

async function refreshExperimentalXgpSource({ force = false } = {}) {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
        const cached = readXgpCache();
        if (!force && cached && Date.now() - Date.parse(cached.fetchedAt) < XGP_CACHE_MAX_AGE_MS) {
            return { available: true, refreshed: false, entryCount: cached.entries.length };
        }

        const response = await axios.get(XGP_SOURCE_URL, {
            timeout: 20000,
            maxContentLength: MAX_XGP_SOURCE_BYTES,
            maxBodyLength: MAX_XGP_SOURCE_BYTES,
            responseType: 'text',
            transformResponse: value => value,
            headers: {
                'Accept': 'application/json, text/plain;q=0.9',
                'User-Agent': 'OpenGameSave-XgpSaveTools-Experimental-Source'
            }
        });
        const rawJson = typeof response.data === 'string' ? response.data : String(response.data ?? '');
        const entries = parseXgpGamesJson(rawJson);
        if (entries.length === 0) throw new Error('XgpSaveTools registry is empty');

        const payload = {
            schemaVersion: XGP_CACHE_SCHEMA_VERSION,
            sourceUrl: XGP_SOURCE_URL,
            projectUrl: XGP_PROJECT_URL,
            fetchedAt: new Date().toISOString(),
            sourceSha256: crypto.createHash('sha256').update(rawJson, 'utf8').digest('hex'),
            entries
        };
        await writeXgpCache(payload);
        return { available: true, refreshed: true, entryCount: entries.length };
    })();

    try {
        return await refreshPromise;
    } finally {
        refreshPromise = null;
    }
}

async function clearExperimentalXgpCache() {
    await fs.promises.rm(getXgpCachePath(), { force: true });
}

module.exports = {
    XGP_PROJECT_URL,
    XGP_SOURCE_URL,
    clearExperimentalXgpCache,
    getExperimentalXgpEntries,
    readXgpCache,
    refreshExperimentalXgpSource
};
