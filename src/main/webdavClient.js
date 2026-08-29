const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { Transform } = require('stream');
const { Writable } = require('stream');
const { pipeline } = require('stream/promises');

const { joinRemotePath } = require('./webdavManifest');

const METADATA_TIMEOUT_MS = 30000;
const TRANSFER_TIMEOUT_MS = 10 * 60 * 1000;
const IDLE_TIMEOUT_MS = 30000;
const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CAPABILITY_CACHE_ENTRIES = 32;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const capabilityCache = new Map();
let secureFetchInstalled = false;
let secureFetchInstallPromise = null;

function webDAVIntegrityError(message) {
    return Object.assign(new Error(message), { code: 'WEBDAV_INTEGRITY' });
}

function isWebDAVIntegrityError(error) {
    return error?.code === 'WEBDAV_INTEGRITY';
}

function pruneCapabilityCache(cache = capabilityCache, now = Date.now()) {
    for (const [key, cachedAt] of cache) {
        if (!Number.isFinite(cachedAt) || now - cachedAt >= CAPABILITY_CACHE_TTL_MS) cache.delete(key);
    }
    while (cache.size > MAX_CAPABILITY_CACHE_ENTRIES) {
        cache.delete(cache.keys().next().value);
    }
}

function cacheCapability(cacheKey, now = Date.now()) {
    capabilityCache.delete(cacheKey);
    capabilityCache.set(cacheKey, now);
    pruneCapabilityCache(capabilityCache, now);
}

function createCapabilityCacheKey(config) {
    const credentialFingerprint = createHash('sha256')
        .update(`${config.username || ''}\0${config.password || ''}`, 'utf8')
        .digest('hex');
    return `${config.url}\n${config.remotePath}\n${credentialFingerprint}`;
}

function getErrorStatus(error) {
    return Number(error?.status || error?.response?.status || 0);
}

function isNotFound(error) {
    return getErrorStatus(error) === 404;
}

function isPreconditionFailed(error) {
    return getErrorStatus(error) === 412;
}

function isRetryableError(error) {
    const status = getErrorStatus(error);
    return RETRYABLE_STATUS_CODES.has(status) || error?.name === 'AbortError'
        || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENETDOWN', 'ENETUNREACH', 'EAI_AGAIN']
            .includes(error?.code);
}

function delay(milliseconds) {
    return new Promise(resolve => {
        setTimeout(resolve, milliseconds);
    });
}

async function withTimeout(label, timeoutMs, operation) {
    const controller = new AbortController();
    let timeoutTriggered = false;
    const timer = setTimeout(() => {
        timeoutTriggered = true;
        controller.abort();
    }, timeoutMs);
    try {
        return await operation(controller.signal, controller);
    } catch (error) {
        if (timeoutTriggered || (controller.signal.aborted && error?.name === 'AbortError')) {
            const timeoutError = new Error(`${label} timed out`);
            timeoutError.code = 'ETIMEDOUT';
            throw timeoutError;
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function retryWebDAV(label, operation, { attempts = 3, timeoutMs = METADATA_TIMEOUT_MS } = {}) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            return await withTimeout(label, timeoutMs, operation);
        } catch (error) {
            lastError = error;
            if (attempt === attempts - 1 || !isRetryableError(error)) throw error;
            await delay(250 * (2 ** attempt));
        }
    }
    throw lastError;
}

async function installSecureFetch(webdavModule) {
    if (secureFetchInstalled) return;
    if (!secureFetchInstallPromise) {
        secureFetchInstallPromise = (async () => {
            const { fetch } = await import('@buttercup/fetch');
            const patcher = webdavModule.getPatcher();
            patcher.patch('fetch', async (requestUrl, options = {}) => {
                let currentUrl = new URL(requestUrl);
                for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
                    const response = await fetch(currentUrl, { ...options, redirect: 'manual' });
                    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
                    const location = response.headers.get('location');
                    if (!location) return response;
                    const nextUrl = new URL(location, currentUrl);
                    if (nextUrl.origin !== currentUrl.origin || nextUrl.protocol !== currentUrl.protocol) {
                        response.body?.destroy();
                        throw new Error('WebDAV refused a cross-origin or protocol-changing redirect');
                    }
                    if (options.body) {
                        response.body?.destroy();
                        throw new Error('WebDAV redirected a request body and cannot replay it safely');
                    }
                    response.body?.destroy();
                    currentUrl = nextUrl;
                }
                throw new Error('WebDAV returned too many redirects');
            });
            secureFetchInstalled = true;
        })().catch((error) => {
            secureFetchInstallPromise = null;
            throw error;
        });
    }
    await secureFetchInstallPromise;
}

async function createHardenedWebDAVClient(config) {
    const webdavModule = await import('webdav');
    await installSecureFetch(webdavModule);
    const hasCredentials = Boolean(config.username && config.password);
    return webdavModule.createClient(config.url, {
        authType: hasCredentials ? webdavModule.AuthType.Auto : webdavModule.AuthType.None,
        username: config.username,
        password: config.password
    });
}

async function resourceExists(client, remotePath) {
    return retryWebDAV('WebDAV PROPFIND', signal => client.stat(remotePath, { signal })
        .then(() => true)
        .catch(error => {
            if (isNotFound(error)) return false;
            throw error;
        }));
}

async function statResource(client, remotePath) {
    return retryWebDAV('WebDAV PROPFIND', signal => client.stat(remotePath, { signal }));
}

async function ensureDirectory(client, remotePath, { recursive = false } = {}) {
    return withTimeout('WebDAV MKCOL', METADATA_TIMEOUT_MS,
        signal => client.createDirectory(remotePath, { recursive, signal }));
}

async function ensureRemoteRoot(client, remotePath) {
    if (await resourceExists(client, remotePath)) {
        const stats = await statResource(client, remotePath);
        if (stats.type !== 'directory') throw new Error('The configured WebDAV remote path is not a directory');
        return;
    }
    await ensureDirectory(client, remotePath, { recursive: true });
}

async function readResponseWithLimit(response, maximumBytes, label) {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        response.body?.destroy();
        throw new Error(`${label} is too large`);
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > maximumBytes) {
            response.body.destroy();
            throw new Error(`${label} is too large`);
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks, total);
}

async function readRemoteResource(client, remotePath, maximumBytes, label = 'WebDAV resource') {
    return retryWebDAV(`Read ${label}`, async signal => {
        const response = await client.customRequest(remotePath, { method: 'GET', signal });
        return {
            data: await readResponseWithLimit(response, maximumBytes, label),
            etag: response.headers.get('etag') || ''
        };
    });
}

async function readRemoteJson(client, remotePath, maximumBytes, validator, { required = true } = {}) {
    try {
        const resource = await readRemoteResource(client, remotePath, maximumBytes, 'WebDAV JSON resource');
        let parsed;
        try {
            parsed = JSON.parse(resource.data.toString('utf8'));
        } catch (_) {
            throw new Error('Invalid JSON in WebDAV resource');
        }
        return { value: validator(parsed), etag: resource.etag };
    } catch (error) {
        if (!required && isNotFound(error)) return null;
        throw error;
    }
}

function makeUploadSource(data, onActivity) {
    if (Buffer.isBuffer(data)) {
        onActivity();
        return data;
    }
    if (typeof data === 'string') {
        const activityTransform = new Transform({
            transform(chunk, encoding, callback) {
                onActivity();
                callback(null, chunk);
            }
        });
        return fs.createReadStream(data, {
            flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
        }).pipe(activityTransform);
    }
    if (typeof data === 'function') return data(onActivity);
    throw new Error('Unsupported WebDAV upload source');
}

async function verifyUploadSource(data, expectedSize, expectedSha256) {
    let actualSize;
    const hash = createHash('sha256');
    if (Buffer.isBuffer(data)) {
        actualSize = data.length;
        hash.update(data);
    } else if (typeof data === 'string') {
        const noFollow = fs.constants.O_NOFOLLOW || 0;
        const fileHandle = await fs.promises.open(data, fs.constants.O_RDONLY | noFollow);
        try {
            const before = await fileHandle.stat();
            if (!before.isFile()) throw new Error('WebDAV upload source is not a regular file');
            actualSize = before.size;
            for await (const chunk of fileHandle.createReadStream({ autoClose: false })) hash.update(chunk);
            const after = await fileHandle.stat();
            const pathAfter = await fs.promises.lstat(data);
            if (!pathAfter.isFile() || pathAfter.isSymbolicLink()
                || before.dev !== after.dev || before.ino !== after.ino
                || before.size !== after.size || before.mtimeMs !== after.mtimeMs
                || after.dev !== pathAfter.dev || after.ino !== pathAfter.ino
                || after.size !== pathAfter.size || after.mtimeMs !== pathAfter.mtimeMs) {
                throw new Error('A local backup changed while it was being verified for WebDAV');
            }
        } finally {
            await fileHandle.close();
        }
    } else {
        throw new Error('Unsupported WebDAV upload source');
    }
    if (actualSize !== expectedSize || hash.digest('hex') !== expectedSha256) {
        throw new Error('A local backup changed before its WebDAV object could be repaired; retry safely');
    }
}

async function putImmutableResource(client, remotePath, data, size) {
    return retryWebDAV('WebDAV immutable PUT', async (signal, controller) => {
        let idleTimer;
        const resetIdleTimer = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
        };
        resetIdleTimer();
        try {
            return await client.putFileContents(remotePath, makeUploadSource(data, resetIdleTimer), {
                contentLength: size,
                headers: {
                    'Content-Length': String(size),
                    'If-None-Match': '*'
                },
                overwrite: false,
                signal
            });
        } finally {
            clearTimeout(idleTimer);
        }
    }, { attempts: 4, timeoutMs: TRANSFER_TIMEOUT_MS });
}

async function putConditionalResource(client, remotePath, data, size, etag) {
    const headers = {
        'Content-Length': String(size),
        'Content-Type': 'application/json; charset=utf-8'
    };
    if (etag) headers['If-Match'] = etag;
    else headers['If-None-Match'] = '*';
    return withTimeout('WebDAV conditional PUT', METADATA_TIMEOUT_MS, signal => client.customRequest(remotePath, {
        method: 'PUT',
        data,
        headers,
        signal
    }));
}

class BoundedDownloadTransform extends Transform {
    constructor(expectedSize, controller, remotePath) {
        super();
        this.expectedSize = expectedSize;
        this.controller = controller;
        this.remotePath = remotePath;
        this.received = 0;
        this.idleTimer = null;
        this.resetIdleTimer();
    }

    resetIdleTimer() {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            this.controller.abort();
            this.destroy(new Error(`WebDAV download stalled: ${this.remotePath}`));
        }, IDLE_TIMEOUT_MS);
    }

    _transform(chunk, encoding, callback) {
        this.received += chunk.length;
        if (this.received > this.expectedSize) {
            clearTimeout(this.idleTimer);
            this.controller.abort();
            callback(webDAVIntegrityError(`WebDAV response exceeded its declared size: ${this.remotePath}`));
            return;
        }
        this.resetIdleTimer();
        callback(null, chunk);
    }

    _flush(callback) {
        clearTimeout(this.idleTimer);
        if (this.received !== this.expectedSize) {
            callback(webDAVIntegrityError(`WebDAV response size mismatch: ${this.remotePath}`));
            return;
        }
        callback();
    }

    _destroy(error, callback) {
        clearTimeout(this.idleTimer);
        callback(error);
    }
}

async function requestDownloadResponse(client, remotePath, signal, controller) {
    const connectionTimer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
    try {
        return await client.customRequest(remotePath, { method: 'GET', signal });
    } finally {
        clearTimeout(connectionTimer);
    }
}

async function downloadResource(client, remotePath, destinationPath, expectedSize) {
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    const operation = async (signal, controller) => {
        const response = await requestDownloadResponse(client, remotePath, signal, controller);
        const declaredLengthHeader = response.headers.get('content-length');
        if (declaredLengthHeader !== null) {
            const declaredLength = Number(declaredLengthHeader);
            if (!Number.isSafeInteger(declaredLength) || declaredLength !== expectedSize) {
                response.body?.destroy();
                throw webDAVIntegrityError(`Invalid Content-Length for WebDAV object: ${remotePath}`);
            }
        }
        const limiter = new BoundedDownloadTransform(expectedSize, controller, remotePath);
        await pipeline(response.body, limiter, fs.createWriteStream(destinationPath, { flags: 'wx' }));
    };

    return retryWebDAV('WebDAV object download', async (signal, controller) => {
        await fs.promises.rm(destinationPath, { force: true }).catch(() => undefined);
        return operation(signal, controller);
    }, { attempts: 3, timeoutMs: TRANSFER_TIMEOUT_MS });
}

async function verifyRemoteResource(client, remotePath, expectedSize, expectedSha256) {
    return retryWebDAV('WebDAV object verification', async (signal, controller) => {
        const response = await requestDownloadResponse(client, remotePath, signal, controller);
        const declaredLengthHeader = response.headers.get('content-length');
        if (declaredLengthHeader !== null && Number(declaredLengthHeader) !== expectedSize) {
            response.body?.destroy();
            throw webDAVIntegrityError(`Invalid Content-Length for WebDAV object: ${remotePath}`);
        }
        const hash = createHash('sha256');
        const sink = new Writable({
            write(chunk, encoding, callback) {
                hash.update(chunk);
                callback();
            }
        });
        await pipeline(response.body, new BoundedDownloadTransform(expectedSize, controller, remotePath), sink);
        if (hash.digest('hex') !== expectedSha256) {
            throw webDAVIntegrityError(`WebDAV object hash verification failed: ${remotePath}`);
        }
    }, { attempts: 3, timeoutMs: TRANSFER_TIMEOUT_MS });
}

async function deleteResource(client, remotePath) {
    return withTimeout('WebDAV DELETE', METADATA_TIMEOUT_MS,
        signal => client.deleteFile(remotePath, { signal }));
}

async function moveResource(client, sourcePath, destinationPath) {
    return withTimeout('WebDAV MOVE', METADATA_TIMEOUT_MS,
        signal => client.moveFile(sourcePath, destinationPath, { overwrite: false, signal }));
}

function formatProbeEtag(rawEtag) {
    if (!rawEtag) throw new Error('WebDAV server did not return an ETag required for safe synchronization');
    return rawEtag.startsWith('W/') || rawEtag.startsWith('"') ? rawEtag : `"${rawEtag}"`;
}

async function probeWebDAVCapabilities(client, config) {
    const cacheKey = createCapabilityCacheKey(config);
    pruneCapabilityCache();
    const cachedAt = capabilityCache.get(cacheKey);
    if (cachedAt) {
        capabilityCache.delete(cacheKey);
        capabilityCache.set(cacheKey, cachedAt);
        return;
    }

    await ensureRemoteRoot(client, config.remotePath);
    await withTimeout('WebDAV OPTIONS', METADATA_TIMEOUT_MS,
        signal => client.customRequest(config.remotePath, { method: 'OPTIONS', signal }));

    const probeRoot = joinRemotePath(config.remotePath, `.opengamesave-capability-${randomUUID()}`);
    const sourcePath = joinRemotePath(probeRoot, 'source.bin');
    const movedPath = joinRemotePath(probeRoot, 'moved.bin');
    const payload = Buffer.from('OpenGameSave WebDAV capability probe', 'utf8');
    try {
        await ensureDirectory(client, probeRoot);
        if (!await putImmutableResource(client, sourcePath, payload, payload.length)) {
            throw new Error('WebDAV capability probe path unexpectedly exists');
        }
        if (await putImmutableResource(client, sourcePath, payload, payload.length)) {
            throw new Error('WebDAV server ignored If-None-Match; safe synchronization is unavailable');
        }
        const resource = await readRemoteResource(client, sourcePath, payload.length, 'WebDAV capability probe');
        if (!resource.data.equals(payload)) throw new Error('WebDAV capability probe payload was altered');
        const etag = formatProbeEtag(resource.etag);
        await putConditionalResource(client, sourcePath, payload, payload.length, etag);
        try {
            await putConditionalResource(client, sourcePath, payload, payload.length, '"opengamesave-stale-etag"');
            throw new Error('WebDAV server ignored If-Match; safe synchronization is unavailable');
        } catch (error) {
            if (!isPreconditionFailed(error)) throw error;
        }
        await moveResource(client, sourcePath, movedPath);
        await statResource(client, movedPath);
        await deleteResource(client, movedPath);
        cacheCapability(cacheKey);
    } catch (error) {
        throw new Error(`WebDAV server lacks a required safe-sync capability: ${error.message}`);
    } finally {
        if (await resourceExists(client, probeRoot).catch(() => false)) {
            await deleteResource(client, probeRoot).catch(() => undefined);
        }
    }
}

module.exports = {
    createHardenedWebDAVClient,
    createCapabilityCacheKey,
    deleteResource,
    downloadResource,
    ensureDirectory,
    ensureRemoteRoot,
    isNotFound,
    isPreconditionFailed,
    isWebDAVIntegrityError,
    pruneCapabilityCache,
    probeWebDAVCapabilities,
    putConditionalResource,
    putImmutableResource,
    readRemoteJson,
    readRemoteResource,
    resourceExists,
    statResource,
    verifyRemoteResource,
    verifyUploadSource
};
