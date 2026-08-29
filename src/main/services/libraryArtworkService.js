const fs = require('fs');
const path = require('path');

const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_ART_BYTES = 8 * 1024 * 1024;
const MAX_BATTLENET_CACHE_FILES = 4096;
const MAX_BATTLENET_INDEX_ENTRIES = 50000;
const MAX_BATTLENET_CATALOG_BYTES = 64 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 7000;
const MAX_REDIRECTS = 3;
const MAX_METADATA_CACHE_ENTRIES = 32;
const MAX_MEMORY_CACHE_BYTES = 24 * 1024 * 1024;
const MAX_ACTIVE_ARTWORK_OPERATIONS = 4;
const MAX_QUEUED_ARTWORK_OPERATIONS = 64;

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const EPIC_METADATA_URL = 'https://store-content.ak.epicgames.com/api/content/productmapping';
const OFFICIAL_HOSTS = Object.freeze({
    Steam: Object.freeze({
        metadata: [],
        artwork: ['cdn.akamai.steamstatic.com']
    }),
    Epic: Object.freeze({
        metadata: ['store-content.ak.epicgames.com', 'store-content-ipv4.ak.epicgames.com'],
        artwork: [
            'cdn1.unrealengine.com',
            'cdn2.unrealengine.com',
            'cdn1-unrealengine-1251447533.file.myqcloud.com',
            'cdn2-unrealengine-1251447533.file.myqcloud.com',
            'static-assets-prod.epicgames.com',
            'store-site-backend-static.ak.epicgames.com'
        ]
    }),
    GOG: Object.freeze({
        metadata: ['api.gog.com'],
        artwork: [/^images(?:-\d+)?\.gog-statics\.com$/]
    }),
    Blizzard: Object.freeze({
        metadata: [/(?:^|\.)blizzard\.com$/, /(?:^|\.)battle\.net$/],
        artwork: [
            'blz-contentstack-images.akamaized.net',
            'images.blz-contentstack.com',
            'bnetcmsus-a.akamaihd.net',
            'd39zum0jwvcigt.cloudfront.net'
        ]
    })
});

const metadataCache = new Map();
const assetCache = new Map();
const inFlightAssets = new Map();
let assetCacheBytes = 0;
let battleNetIndexCache = null;

function createBoundedOperationRunner(maximumActive, maximumQueued) {
    if (!Number.isSafeInteger(maximumActive) || maximumActive < 1
        || !Number.isSafeInteger(maximumQueued) || maximumQueued < 0) {
        throw new Error('Invalid bounded operation limits');
    }
    let active = 0;
    const queue = [];
    const start = ({ operation, resolve, reject }) => {
        active += 1;
        Promise.resolve().then(operation).then(resolve, reject).finally(() => {
            active -= 1;
            const next = queue.shift();
            if (next) start(next);
        });
    };
    return (operation) => {
        if (typeof operation !== 'function') return Promise.reject(new Error('Operation must be a function'));
        return new Promise((resolve, reject) => {
            const task = { operation, resolve, reject };
            if (active < maximumActive) start(task);
            else if (queue.length < maximumQueued) queue.push(task);
            else reject(new Error('Artwork operation queue is full'));
        });
    };
}

const runBoundedArtworkOperation = createBoundedOperationRunner(
    MAX_ACTIVE_ARTWORK_OPERATIONS,
    MAX_QUEUED_ARTWORK_OPERATIONS
);

function mimeTypeFromBytes(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 3) return null;
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'image/png';
    }
    if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
        return 'image/webp';
    }
    return null;
}

function isPathWithin(rootPath, targetPath) {
    const relative = path.relative(rootPath, targetPath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function existingRealPath(candidate) {
    try {
        return fs.realpathSync(candidate);
    } catch {
        return null;
    }
}

function readFileHeader(filePath, length) {
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, 'r');
        const header = Buffer.alloc(length);
        const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
        return header.subarray(0, bytesRead);
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
    }
}

function inspectTrustedArtFile(filePath, trustedRoots) {
    if (typeof filePath !== 'string' || !filePath || filePath.length > 4096) return null;
    const resolvedPath = path.resolve(filePath);
    try {
        if (fs.lstatSync(resolvedPath).isSymbolicLink()) return null;
        const stats = fs.statSync(resolvedPath);
        if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_ART_BYTES) return null;
        const realPath = existingRealPath(resolvedPath);
        const allowed = realPath && trustedRoots.some((root) => {
            const realRoot = existingRealPath(root);
            return realRoot && isPathWithin(realRoot, realPath);
        });
        if (!allowed) return null;
        const mimeType = mimeTypeFromBytes(readFileHeader(realPath, 16));
        return mimeType ? { path: realPath, mimeType, size: stats.size, modified: stats.mtimeMs } : null;
    } catch {
        return null;
    }
}

function findTrustedArtFile(candidates, trustedRoots) {
    for (const candidate of candidates.filter(Boolean)) {
        const inspected = inspectTrustedArtFile(candidate, trustedRoots);
        if (inspected) return inspected.path;
    }
    return null;
}

function expandManifestPaths(values, roots) {
    return values.filter(value => typeof value === 'string' && value.trim()).flatMap((value) => {
        const trimmed = value.trim();
        return path.isAbsolute(trimmed) ? [trimmed] : roots.map(root => path.join(root, trimmed));
    });
}

function namedImageCandidates(root, names) {
    if (!root) return [];
    return names.flatMap(name => ['.jpg', '.jpeg', '.png', '.webp'].map(extension => path.join(root, `${name}${extension}`)));
}

function findEpicManifestArt(manifest, manifestPath, installPath) {
    const manifestRoot = path.dirname(manifestPath);
    const roots = [manifestRoot, installPath].filter(Boolean);
    const baseName = path.basename(manifestPath, path.extname(manifestPath));
    const coverFields = ['CoverImagePath', 'CoverPath', 'PortraitImagePath', 'ThumbnailPath', 'ImagePath'];
    const heroFields = ['HeroImagePath', 'BackgroundImagePath', 'BannerImagePath', 'WideImagePath'];
    const fieldValues = fields => fields.map(field => manifest?.[field]);
    const coverCandidates = [
        ...expandManifestPaths(fieldValues(coverFields), roots),
        ...namedImageCandidates(manifestRoot, [`${baseName}.cover`, `${baseName}-cover`, baseName]),
        ...namedImageCandidates(installPath, ['cover', 'poster', path.join('.egstore', 'cover')])
    ];
    const heroCandidates = [
        ...expandManifestPaths(fieldValues(heroFields), roots),
        ...namedImageCandidates(manifestRoot, [`${baseName}.hero`, `${baseName}-hero`, `${baseName}.background`]),
        ...namedImageCandidates(installPath, ['hero', 'background', 'banner', path.join('.egstore', 'hero')])
    ];
    return {
        coverPath: findTrustedArtFile(coverCandidates, roots),
        heroPath: findTrustedArtFile(heroCandidates, roots),
        artRoots: roots
    };
}

function findGogLocalArt(registryData, platformId, installPath, cacheRoots = []) {
    const roots = [installPath, ...cacheRoots].filter(Boolean);
    const coverValues = ['cover', 'coverimage', 'coverpath', 'image', 'imagepath'].map(key => registryData?.[key]);
    const heroValues = ['background', 'backgroundimage', 'backgroundpath', 'hero', 'heropath'].map(key => registryData?.[key]);
    return {
        coverPath: findTrustedArtFile([
            ...expandManifestPaths(coverValues, roots),
            ...namedImageCandidates(installPath, [`goggame-${platformId}`, 'cover', 'poster'])
        ], roots),
        heroPath: findTrustedArtFile([
            ...expandManifestPaths(heroValues, roots),
            ...namedImageCandidates(installPath, ['background', 'hero', 'banner'])
        ], roots),
        artRoots: roots
    };
}

function listBattleNetCacheFiles(cacheRoot) {
    const files = [];
    try {
        for (const first of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
            if (!first.isDirectory() || !/^[a-f0-9]{2}$/i.test(first.name)) continue;
            const firstRoot = path.join(cacheRoot, first.name);
            for (const second of fs.readdirSync(firstRoot, { withFileTypes: true })) {
                if (!second.isDirectory() || !/^[a-f0-9]{2}$/i.test(second.name)) continue;
                const secondRoot = path.join(firstRoot, second.name);
                for (const entry of fs.readdirSync(secondRoot, { withFileTypes: true })) {
                    if (entry.isFile()) files.push(path.join(secondRoot, entry.name));
                    if (files.length >= MAX_BATTLENET_CACHE_FILES) return files;
                }
            }
        }
    } catch {
        return files;
    }
    return files;
}

function battleNetHashedPath(cacheRoot, hash) {
    if (!/^[a-f0-9]{32}$/i.test(String(hash || ''))) return null;
    return path.join(cacheRoot, hash.slice(0, 2), hash.slice(2, 4), hash);
}

function addBattleNetFiles(index, cacheRoot, files, localeRank, budget = { remaining: MAX_BATTLENET_INDEX_ENTRIES }) {
    if (!files || typeof files !== 'object') return true;
    for (const assetKey in files) {
        if (!Object.prototype.hasOwnProperty.call(files, assetKey)) continue;
        if (budget.remaining <= 0) return false;
        const descriptor = files[assetKey];
        const candidate = battleNetHashedPath(cacheRoot, descriptor?.hash);
        if (!candidate || !/\.(?:jpe?g|png|webp)$/i.test(String(descriptor?.name || ''))) continue;
        const normalizedKey = assetKey.toUpperCase();
        const candidates = index.get(normalizedKey) || [];
        candidates.push({ path: candidate, localeRank });
        index.set(normalizedKey, candidates);
        budget.remaining -= 1;
    }
    return budget.remaining > 0;
}

function buildBattleNetArtIndex(cacheRoot, locale = 'default') {
    const now = Date.now();
    if (battleNetIndexCache?.root === cacheRoot && battleNetIndexCache.locale === locale
        && now - battleNetIndexCache.createdAt < 30000) {
        return battleNetIndexCache.index;
    }
    const index = new Map();
    const indexBudget = { remaining: MAX_BATTLENET_INDEX_ENTRIES };
    let remainingCatalogBytes = MAX_BATTLENET_CATALOG_BYTES;
    const localeOrder = [...new Set([locale, 'default'])];
    for (const filePath of listBattleNetCacheFiles(cacheRoot)) {
        let stats;
        try {
            stats = fs.statSync(filePath);
            if (!stats.isFile() || stats.size <= 2 || stats.size > MAX_MANIFEST_BYTES) continue;
            const firstByte = readFileHeader(filePath, 1);
            if (firstByte[0] !== 0x7b) continue;
            if (stats.size > remainingCatalogBytes) break;
            remainingCatalogBytes -= stats.size;
            const catalog = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            for (let localeRank = 0; localeRank < localeOrder.length; localeRank += 1) {
                if (!addBattleNetFiles(
                    index,
                    cacheRoot,
                    catalog?.files?.[localeOrder[localeRank]],
                    localeRank,
                    indexBudget
                )) break;
            }
            if (indexBudget.remaining <= 0) break;
        } catch {
            // Battle.net updates this cache in place; partial entries are ignored.
        }
    }
    battleNetIndexCache = { root: cacheRoot, locale, createdAt: now, index };
    return index;
}

function battleNetAssetScore(assetKey, artType) {
    const ranks = artType === 'cover'
        ? [['KEY_ART', 50], ['INSTALL_BACKGROUND', 40], ['BACKGROUND', 30], ['ICON_MASSIVE', 20]]
        : [['BACKGROUND', 50], ['INSTALL_BACKGROUND', 40], ['KEY_ART', 30]];
    return ranks.find(([token]) => assetKey.includes(token))?.[1] || 0;
}

function findBattleNetLocalArt(cacheRoot, artTokens, rejectTokens = [], locale = 'default') {
    const index = buildBattleNetArtIndex(cacheRoot, locale);
    const normalizedTokens = artTokens.map(token => token.toUpperCase());
    const normalizedRejects = rejectTokens.map(token => token.toUpperCase());
    const matches = [...index.entries()].filter(([assetKey]) => (
        normalizedTokens.some(token => assetKey.includes(token))
        && !normalizedRejects.some(token => assetKey.includes(token))
    )).flatMap(([assetKey, descriptors]) => descriptors.map(descriptor => ({
        ...descriptor,
        assetKey
    })));
    const pick = (artType) => {
        const candidates = matches
            .map(entry => ({ ...entry, score: battleNetAssetScore(entry.assetKey, artType) }))
            .filter(entry => entry.score > 0)
            .sort((left, right) => right.score - left.score || left.localeRank - right.localeRank);
        for (const candidate of candidates) {
            const inspected = inspectTrustedArtFile(candidate.path, [cacheRoot]);
            if (inspected) return inspected.path;
        }
        return null;
    };
    return {
        coverPath: pick('cover'),
        heroPath: pick('hero'),
        artRoots: [cacheRoot]
    };
}

function normalizeOfficialUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const normalized = value.trim().startsWith('//') ? `https:${value.trim()}` : value.trim();
    try {
        return new URL(normalized).toString();
    } catch {
        return null;
    }
}

function hostMatches(hostname, patterns) {
    return patterns.some(pattern => typeof pattern === 'string' ? hostname === pattern : pattern.test(hostname));
}

function isAllowedOfficialUrl(provider, purpose, value) {
    try {
        const parsed = new URL(value);
        const patterns = OFFICIAL_HOSTS[provider]?.[purpose] || [];
        return parsed.protocol === 'https:' && !parsed.username && !parsed.password
            && (!parsed.port || parsed.port === '443') && hostMatches(parsed.hostname.toLowerCase(), patterns);
    } catch {
        return false;
    }
}

function uniqueAllowedUrls(provider, values) {
    return [...new Set(values.map(normalizeOfficialUrl).filter(url => url && isAllowedOfficialUrl(provider, 'artwork', url)))];
}

function createSteamArtUrls(appId, artType) {
    const normalizedAppId = String(appId || '').trim();
    if (!/^\d{1,12}$/.test(normalizedAppId)) throw new Error('Invalid Steam app id');
    const baseUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${normalizedAppId}`;
    if (artType === 'cover') return [`${baseUrl}/library_600x900_2x.jpg`, `${baseUrl}/library_600x900.jpg`];
    if (artType === 'hero') return [`${baseUrl}/library_hero.jpg`];
    throw new Error('Invalid Steam artwork type');
}

function createGogMetadataUrl(productId) {
    const normalizedId = String(productId || '').trim();
    if (!/^\d{1,20}$/.test(normalizedId)) throw new Error('Invalid GOG product id');
    return `https://api.gog.com/products/${normalizedId}?locale=en-US`;
}

function createEpicProductUrl(slug) {
    const normalizedSlug = String(slug || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,199}$/.test(normalizedSlug)) throw new Error('Invalid Epic product slug');
    return `https://store-content.ak.epicgames.com/api/en-US/content/products/${normalizedSlug}`;
}

function extractEpicArtUrls(product, namespace, appName) {
    const pages = Array.isArray(product?.pages) ? product.pages : [];
    const exactPage = pages.find(page => (
        String(page?.item?.namespace || '') === String(namespace || '')
        && (!appName || String(page?.item?.appName || '') === String(appName))
    ));
    const page = exactPage || pages.find(entry => entry?.type === 'productHome') || pages[0];
    const hero = page?.data?.hero || {};
    const allImages = Array.isArray(page?._images_) ? page._images_ : [];
    const portrait = allImages.find(url => /(?:1200x1600|portrait|vertical)/i.test(String(url)));
    const landscape = allImages.find(url => /(?:2560x1440|1920x1080|landscape|background)/i.test(String(url)));
    return {
        cover: uniqueAllowedUrls('Epic', [hero.portraitBackgroundImageUrl, portrait, hero.backgroundImageUrl]),
        hero: uniqueAllowedUrls('Epic', [hero.backgroundImageUrl, landscape, hero.portraitBackgroundImageUrl])
    };
}

function extractGogArtUrls(product) {
    const images = product?.images || {};
    return {
        cover: uniqueAllowedUrls('GOG', [images.coverVertical, images.productCard, images.background, images.icon]),
        hero: uniqueAllowedUrls('GOG', [images.background, images.coverHorizontal, images.coverVertical])
    };
}

function decodeHtmlAttribute(value) {
    return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
        .replace(/&#(\d+);/g, (match, code) => String.fromCodePoint(Number(code)));
}

function extractOpenGraphImageUrls(html, baseUrl) {
    if (typeof html !== 'string') return [];
    const results = [];
    for (const tagMatch of html.matchAll(/<meta\b[^>]*>/gi)) {
        const attributes = {};
        for (const attribute of tagMatch[0].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gis)) {
            attributes[attribute[1].toLowerCase()] = decodeHtmlAttribute(attribute[3]);
        }
        if ((attributes.property || attributes.name || '').toLowerCase() !== 'og:image' || !attributes.content) continue;
        try {
            results.push(new URL(attributes.content, baseUrl).toString());
        } catch {
            // Invalid metadata is ignored and never reaches the network boundary.
        }
    }
    return uniqueAllowedUrls('Blizzard', results);
}

async function readResponseBounded(response, maximumBytes) {
    const rawLength = response.headers.get('content-length');
    const declaredLength = Number(rawLength || 0);
    if ((rawLength && (!Number.isSafeInteger(declaredLength) || declaredLength < 0))
        || declaredLength > maximumBytes) {
        await response.body?.cancel();
        throw new Error('Official resource has an invalid or excessive size');
    }
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maximumBytes) {
            await reader.cancel();
            throw new Error('Official resource exceeds the size limit');
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
}

async function fetchBoundedImmediately(initialUrl, provider, purpose, maximumBytes, accept) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
    let currentUrl = initialUrl;
    try {
        for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
            if (!isAllowedOfficialUrl(provider, purpose, currentUrl)) throw new Error('Official resource host is not allowed');
            const response = await fetch(currentUrl, {
                redirect: 'manual',
                signal: controller.signal,
                headers: { Accept: accept, 'User-Agent': 'OpenGameSave artwork resolver' }
            });
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                if (!location || redirect === MAX_REDIRECTS) throw new Error('Official resource redirect was rejected');
                await response.body?.cancel();
                currentUrl = new URL(location, currentUrl).toString();
                continue;
            }
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error(`Official resource returned HTTP ${response.status}`);
            }
            return {
                buffer: await readResponseBounded(response, maximumBytes),
                contentType: String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
                finalUrl: currentUrl
            };
        }
        throw new Error('Official resource redirect was rejected');
    } finally {
        clearTimeout(timeout);
    }
}

async function cachedMetadata(key, loader) {
    if (metadataCache.has(key)) {
        const cached = metadataCache.get(key);
        metadataCache.delete(key);
        metadataCache.set(key, cached);
        return await cached;
    }
    const promise = loader().catch((error) => {
        metadataCache.delete(key);
        throw error;
    });
    metadataCache.set(key, promise);
    while (metadataCache.size > MAX_METADATA_CACHE_ENTRIES) {
        metadataCache.delete(metadataCache.keys().next().value);
    }
    return await promise;
}

async function fetchOfficialJson(url, provider) {
    const response = await fetchBounded(url, provider, 'metadata', MAX_METADATA_BYTES, 'application/json');
    if (response.contentType !== 'application/json' && !response.contentType.endsWith('+json')) {
        throw new Error('Official metadata did not return JSON');
    }
    return JSON.parse(response.buffer.toString('utf8'));
}

async function resolveEpicOfficialArt(game) {
    const namespace = String(game.artMetadata?.namespace || '').trim();
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(namespace)) return { cover: [], hero: [] };
    const mapping = await cachedMetadata('epic:mapping', () => fetchOfficialJson(EPIC_METADATA_URL, 'Epic'));
    const slug = mapping?.[namespace];
    if (!slug) return { cover: [], hero: [] };
    const product = await cachedMetadata(`epic:product:${slug}`, () => (
        fetchOfficialJson(createEpicProductUrl(slug), 'Epic')
    ));
    return extractEpicArtUrls(product, namespace, game.artMetadata?.appName);
}

async function resolveGogOfficialArt(game) {
    const url = createGogMetadataUrl(game.platformId);
    const product = await cachedMetadata(`gog:${game.platformId}`, () => fetchOfficialJson(url, 'GOG'));
    return extractGogArtUrls(product);
}

async function resolveBattleNetOfficialArt(game) {
    const pageUrl = game.artMetadata?.officialPage;
    if (!isAllowedOfficialUrl('Blizzard', 'metadata', pageUrl)) return { cover: [], hero: [] };
    const metadata = await cachedMetadata(`blizzard:${pageUrl}`, async () => {
        const response = await fetchBounded(pageUrl, 'Blizzard', 'metadata', MAX_METADATA_BYTES, 'text/html');
        if (response.contentType !== 'text/html') throw new Error('Official product page did not return HTML');
        return { html: response.buffer.toString('utf8'), finalUrl: response.finalUrl };
    });
    const urls = extractOpenGraphImageUrls(metadata.html, metadata.finalUrl);
    return { cover: urls, hero: urls };
}

function hasOfficialArtFallback(game) {
    if (game.platform === 'Steam') return /^\d{1,12}$/.test(String(game.platformId || ''));
    if (game.platform === 'Epic') return /^[A-Za-z0-9._-]{1,128}$/.test(String(game.artMetadata?.namespace || ''));
    if (game.platform === 'GOG') return /^\d{1,20}$/.test(String(game.platformId || ''));
    if (game.platform === 'Blizzard') return isAllowedOfficialUrl('Blizzard', 'metadata', game.artMetadata?.officialPage);
    return false;
}

async function resolveOfficialArt(game) {
    try {
        if (game.platform === 'Steam') {
            return { cover: createSteamArtUrls(game.platformId, 'cover'), hero: createSteamArtUrls(game.platformId, 'hero') };
        }
        if (game.platform === 'Epic') return await resolveEpicOfficialArt(game);
        if (game.platform === 'GOG') return await resolveGogOfficialArt(game);
        if (game.platform === 'Blizzard') return await resolveBattleNetOfficialArt(game);
    } catch (error) {
        console.warn(`Could not resolve official ${game.platform} artwork for ${game.id}:`, error.message);
    }
    return { cover: [], hero: [] };
}

function readCachedAsset(cacheKey) {
    const cached = assetCache.get(cacheKey);
    if (!cached) return null;
    assetCache.delete(cacheKey);
    assetCache.set(cacheKey, cached);
    return cached.asset;
}

function fetchBounded(initialUrl, provider, purpose, maximumBytes, accept) {
    return runBoundedArtworkOperation(() => (
        fetchBoundedImmediately(initialUrl, provider, purpose, maximumBytes, accept)
    ));
}

function writeCachedAsset(cacheKey, asset) {
    const bytes = asset?.data?.byteLength || 0;
    const existing = assetCache.get(cacheKey);
    if (existing) {
        assetCacheBytes -= existing.bytes;
        assetCache.delete(cacheKey);
    }
    while (assetCache.size && assetCacheBytes + bytes > MAX_MEMORY_CACHE_BYTES) {
        const oldestKey = assetCache.keys().next().value;
        assetCacheBytes -= assetCache.get(oldestKey).bytes;
        assetCache.delete(oldestKey);
    }
    if (bytes <= MAX_MEMORY_CACHE_BYTES) {
        assetCache.set(cacheKey, { asset, bytes });
        assetCacheBytes += bytes;
    }
}

async function loadLocalArtDataUrl(filePath, trustedRoots) {
    const inspected = inspectTrustedArtFile(filePath, trustedRoots);
    if (!inspected) return null;
    const cacheKey = `file:${inspected.path}:${inspected.modified}:${inspected.size}`;
    const cached = readCachedAsset(cacheKey);
    if (cached) return cached;
    if (inFlightAssets.has(cacheKey)) return await inFlightAssets.get(cacheKey);
    const promise = runBoundedArtworkOperation(async () => {
        const buffer = await fs.promises.readFile(inspected.path);
        const current = inspectTrustedArtFile(inspected.path, trustedRoots);
        if (!current || current.size !== inspected.size || current.modified !== inspected.modified
            || buffer.length !== inspected.size || mimeTypeFromBytes(buffer) !== inspected.mimeType) return null;
        const asset = { mimeType: inspected.mimeType, data: buffer };
        writeCachedAsset(cacheKey, asset);
        return asset;
    }).finally(() => inFlightAssets.delete(cacheKey));
    inFlightAssets.set(cacheKey, promise);
    return await promise;
}

async function downloadOfficialArt(provider, url) {
    const cacheKey = `url:${url}`;
    const cached = readCachedAsset(cacheKey);
    if (cached) return cached;
    if (inFlightAssets.has(cacheKey)) return await inFlightAssets.get(cacheKey);
    const promise = (async () => {
        const response = await fetchBounded(url, provider, 'artwork', MAX_ART_BYTES, 'image/avif,image/webp,image/png,image/jpeg');
        const detectedMime = mimeTypeFromBytes(response.buffer);
        if (!IMAGE_MIME_TYPES.has(response.contentType) || response.contentType !== detectedMime) {
            throw new Error('Official artwork MIME type is invalid');
        }
        const asset = { mimeType: detectedMime, data: response.buffer };
        writeCachedAsset(cacheKey, asset);
        return asset;
    })().finally(() => inFlightAssets.delete(cacheKey));
    inFlightAssets.set(cacheKey, promise);
    return await promise;
}

async function getGameArtwork(game, artType) {
    if (!['cover', 'hero'].includes(artType)) throw new Error('Invalid artwork type');
    const localPath = artType === 'hero' ? game?.heroPath : game?.coverPath;
    if (localPath) {
        try {
            const localArt = await loadLocalArtDataUrl(localPath, game.artRoots || []);
            if (localArt) return localArt;
        } catch (error) {
            console.warn(`Could not load local artwork ${localPath}:`, error.message);
        }
    }
    const official = await resolveOfficialArt(game);
    for (const url of official[artType] || []) {
        try {
            return await downloadOfficialArt(game.platform, url);
        } catch (error) {
            console.warn(`Could not load official artwork ${url}:`, error.message);
        }
    }
    return null;
}

module.exports = {
    EPIC_METADATA_URL,
    MAX_ART_BYTES,
    MAX_BATTLENET_CATALOG_BYTES,
    MAX_BATTLENET_INDEX_ENTRIES,
    MAX_MANIFEST_BYTES,
    addBattleNetFiles,
    createBoundedOperationRunner,
    createEpicProductUrl,
    createGogMetadataUrl,
    createSteamArtUrls,
    extractEpicArtUrls,
    extractGogArtUrls,
    extractOpenGraphImageUrls,
    findBattleNetLocalArt,
    findEpicManifestArt,
    findGogLocalArt,
    findTrustedArtFile,
    getGameArtwork,
    hasOfficialArtFallback,
    inspectTrustedArtFile,
    isAllowedOfficialUrl,
    mimeTypeFromBytes
};
