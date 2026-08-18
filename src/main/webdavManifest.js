const path = require('path');

const MANIFEST_VERSION = 1;
const MANIFEST_NAME = '.opengamesave-manifest.json';
const MAX_MANIFEST_SIZE = 20 * 1024 * 1024;
const MAX_SYNC_FILES = 100000;
const MAX_SYNC_FILE_SIZE = 20 * 1024 * 1024 * 1024;
const MAX_SYNC_TOTAL_SIZE = 200 * 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function joinRemotePath(...parts) {
    const segments = parts
        .flatMap(part => String(part || '').replace(/\\/g, '/').split('/'))
        .filter(Boolean);
    return `/${segments.join('/')}`;
}

function normalizeManifestPath(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096
        || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)) {
        throw new Error('Invalid path in WebDAV manifest');
    }
    const segments = value.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
        throw new Error('Invalid path in WebDAV manifest');
    }
    return segments.join('/');
}

function validateManifest(rawManifest) {
    if (!rawManifest || typeof rawManifest !== 'object' || Array.isArray(rawManifest)
        || rawManifest.version !== MANIFEST_VERSION || !Array.isArray(rawManifest.files)
        || rawManifest.files.length > MAX_SYNC_FILES) {
        throw new Error('Invalid WebDAV backup manifest');
    }

    const seen = new Set();
    let totalSize = 0;
    const files = rawManifest.files.map((file) => {
        const relativePath = normalizeManifestPath(file?.path);
        if (seen.has(relativePath)) throw new Error('Duplicate path in WebDAV manifest');
        seen.add(relativePath);

        const size = Number(file?.size);
        const mtimeMs = Number(file?.mtimeMs);
        const sha256 = String(file?.sha256 || '').toLowerCase();
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SYNC_FILE_SIZE
            || !Number.isFinite(mtimeMs) || mtimeMs < 0 || mtimeMs > 8640000000000000
            || !SHA256_PATTERN.test(sha256)) {
            throw new Error('Invalid file metadata in WebDAV manifest');
        }
        totalSize += size;
        if (totalSize > MAX_SYNC_TOTAL_SIZE) throw new Error('WebDAV manifest exceeds the total backup size limit');
        return { path: relativePath, size, mtimeMs, sha256 };
    });

    files.sort((left, right) => left.path.localeCompare(right.path));
    return {
        version: MANIFEST_VERSION,
        generatedAt: typeof rawManifest.generatedAt === 'string' ? rawManifest.generatedAt.slice(0, 100) : '',
        files
    };
}

module.exports = {
    MANIFEST_NAME,
    MANIFEST_VERSION,
    MAX_MANIFEST_SIZE,
    MAX_SYNC_FILES,
    MAX_SYNC_FILE_SIZE,
    MAX_SYNC_TOTAL_SIZE,
    joinRemotePath,
    normalizeManifestPath,
    validateManifest
};
