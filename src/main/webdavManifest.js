const path = require('path');

const {
    normalizeBackupDate,
    normalizeWikiId
} = require('./validation');

const MANIFEST_VERSION = 2;
const LEGACY_MANIFEST_VERSION = 1;
const MANIFEST_NAME = '.opengamesave-manifest.json';
const CURRENT_NAME = 'current.json';
const OBJECTS_DIRECTORY = 'objects';
const SNAPSHOTS_DIRECTORY = 'snapshots';
const MAX_MANIFEST_SIZE = 20 * 1024 * 1024;
const MAX_SYNC_FILES = 100000;
const MAX_SYNC_FILE_SIZE = 20 * 1024 * 1024 * 1024;
const MAX_SYNC_TOTAL_SIZE = 200 * 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BACKUP_FOLDER_PATTERN = /^path[1-9]\d{0,3}$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
const WINDOWS_UNSAFE_CHARACTERS = /[<>:"|?*]/;

function joinRemotePath(...parts) {
    const segments = parts
        .flatMap(part => String(part || '').replace(/\\/g, '/').split('/'))
        .filter(Boolean);
    return `/${segments.join('/')}`;
}

function validatePortableSegment(segment) {
    if (!segment || segment.length > 255 || segment === '.' || segment === '..' || segment.startsWith('.')
        || segment.endsWith('.') || segment.endsWith(' ') || WINDOWS_UNSAFE_CHARACTERS.test(segment)
        || [...segment].some(character => character.charCodeAt(0) < 32)
        || WINDOWS_RESERVED_NAME.test(segment) || segment.normalize('NFC') !== segment) {
        throw new Error('Invalid path in WebDAV manifest');
    }
    return segment;
}

function normalizeManifestPath(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096
        || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)) {
        throw new Error('Invalid path in WebDAV manifest');
    }

    const segments = value.split('/');
    if (segments.length < 3 || segments.length > 64) throw new Error('Invalid backup path in WebDAV manifest');
    const wikiId = validatePortableSegment(normalizeWikiId(segments[0]));
    const backupDate = normalizeBackupDate(segments[1]);
    const contentSegments = segments.slice(2).map(validatePortableSegment);
    if (contentSegments[0] === 'backup_info.json') {
        if (contentSegments.length !== 1) throw new Error('Invalid backup metadata path in WebDAV manifest');
    } else if (!BACKUP_FOLDER_PATTERN.test(contentSegments[0])) {
        throw new Error('WebDAV manifest path is outside the backup metadata structure');
    }
    return [wikiId, backupDate, ...contentSegments].join('/');
}

function caseFoldPath(relativePath) {
    return relativePath.normalize('NFC').toLocaleLowerCase('en-US');
}

function validateFiles(rawFiles) {
    if (!Array.isArray(rawFiles) || rawFiles.length > MAX_SYNC_FILES) {
        throw new Error('Invalid WebDAV backup file list');
    }

    const seen = new Set();
    const seenFolded = new Map();
    const digestSizes = new Map();
    let totalSize = 0;
    const files = rawFiles.map((file) => {
        const relativePath = normalizeManifestPath(file?.path);
        const foldedPath = caseFoldPath(relativePath);
        if (seen.has(relativePath)) throw new Error('Duplicate path in WebDAV manifest');
        if (seenFolded.has(foldedPath) && seenFolded.get(foldedPath) !== relativePath) {
            throw new Error('Case-folding path collision in WebDAV manifest');
        }
        seen.add(relativePath);
        seenFolded.set(foldedPath, relativePath);

        const size = Number(file?.size);
        const mtimeMs = Number(file?.mtimeMs);
        const sha256 = String(file?.sha256 || '').toLowerCase();
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SYNC_FILE_SIZE
            || !Number.isFinite(mtimeMs) || mtimeMs < 0 || mtimeMs > 8640000000000000
            || !SHA256_PATTERN.test(sha256)) {
            throw new Error('Invalid file metadata in WebDAV manifest');
        }
        if (digestSizes.has(sha256) && digestSizes.get(sha256) !== size) {
            throw new Error('A WebDAV object digest has conflicting sizes');
        }
        digestSizes.set(sha256, size);
        if (relativePath.endsWith('/backup_info.json') && size > 1024 * 1024) {
            throw new Error('WebDAV backup metadata is too large');
        }
        totalSize += size;
        if (totalSize > MAX_SYNC_TOTAL_SIZE) throw new Error('WebDAV manifest exceeds the total backup size limit');
        return { path: relativePath, size, mtimeMs, sha256 };
    });

    files.sort((left, right) => left.path.localeCompare(right.path));
    return files;
}

function normalizeRevision(value, { nullable = false } = {}) {
    if (nullable && value === null) return null;
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error('Invalid WebDAV revision');
    return value.toLowerCase();
}

function validateSnapshot(rawManifest) {
    if (!rawManifest || typeof rawManifest !== 'object' || Array.isArray(rawManifest)
        || rawManifest.version !== MANIFEST_VERSION) {
        throw new Error('Invalid WebDAV backup snapshot');
    }
    const revision = normalizeRevision(rawManifest.revision);
    const parentRevision = normalizeRevision(rawManifest.parentRevision, { nullable: true });
    if (parentRevision === revision) throw new Error('A WebDAV snapshot cannot be its own parent');
    return {
        version: MANIFEST_VERSION,
        revision,
        parentRevision,
        deviceId: normalizeRevision(rawManifest.deviceId),
        generatedAt: typeof rawManifest.generatedAt === 'string' ? rawManifest.generatedAt.slice(0, 100) : '',
        files: validateFiles(rawManifest.files)
    };
}

function validateLegacyManifest(rawManifest) {
    if (!rawManifest || typeof rawManifest !== 'object' || Array.isArray(rawManifest)
        || rawManifest.version !== LEGACY_MANIFEST_VERSION) {
        throw new Error('Invalid legacy WebDAV backup manifest');
    }
    return {
        version: LEGACY_MANIFEST_VERSION,
        generatedAt: typeof rawManifest.generatedAt === 'string' ? rawManifest.generatedAt.slice(0, 100) : '',
        files: validateFiles(rawManifest.files)
    };
}

function validateCurrentPointer(rawPointer) {
    if (!rawPointer || typeof rawPointer !== 'object' || Array.isArray(rawPointer)
        || rawPointer.version !== MANIFEST_VERSION) {
        throw new Error('Invalid WebDAV current snapshot pointer');
    }
    return {
        version: MANIFEST_VERSION,
        revision: normalizeRevision(rawPointer.revision),
        parentRevision: normalizeRevision(rawPointer.parentRevision, { nullable: true }),
        deviceId: normalizeRevision(rawPointer.deviceId),
        generatedAt: typeof rawPointer.generatedAt === 'string' ? rawPointer.generatedAt.slice(0, 100) : ''
    };
}

function validateManifestPathsAgainstMetadata(files, metadataByBackup) {
    const filesByBackup = new Map();
    for (const file of files) {
        const backupKey = file.path.split('/').slice(0, 2).join('/');
        if (!filesByBackup.has(backupKey)) filesByBackup.set(backupKey, []);
        filesByBackup.get(backupKey).push(file);
    }
    for (const [backupKey, backupFiles] of filesByBackup) {
        const metadata = metadataByBackup.get(backupKey);
        if (!metadata) throw new Error(`Missing backup_info.json for ${backupKey}`);
        const allowedFolders = new Set(metadata.backup_paths.map(item => item.folder_name));
        for (const file of backupFiles) {
            const thirdSegment = file.path.split('/')[2];
            if (thirdSegment !== 'backup_info.json' && !allowedFolders.has(thirdSegment)) {
                throw new Error(`WebDAV snapshot contains a path not declared by backup metadata: ${file.path}`);
            }
        }
    }
    return files;
}

function getObjectPath(remoteRoot, sha256) {
    if (!SHA256_PATTERN.test(String(sha256 || ''))) throw new Error('Invalid WebDAV object digest');
    return joinRemotePath(remoteRoot, OBJECTS_DIRECTORY, sha256.slice(0, 2), sha256);
}

function getSnapshotPath(remoteRoot, revision) {
    return joinRemotePath(remoteRoot, SNAPSHOTS_DIRECTORY, `${normalizeRevision(revision)}.json`);
}

module.exports = {
    CURRENT_NAME,
    LEGACY_MANIFEST_VERSION,
    MANIFEST_NAME,
    MANIFEST_VERSION,
    MAX_MANIFEST_SIZE,
    MAX_SYNC_FILES,
    MAX_SYNC_FILE_SIZE,
    MAX_SYNC_TOTAL_SIZE,
    OBJECTS_DIRECTORY,
    SHA256_PATTERN,
    SNAPSHOTS_DIRECTORY,
    caseFoldPath,
    getObjectPath,
    getSnapshotPath,
    joinRemotePath,
    normalizeManifestPath,
    validateCurrentPointer,
    validateLegacyManifest,
    validateManifest: validateSnapshot,
    validateManifestPathsAgainstMetadata,
    validateSnapshot
};
