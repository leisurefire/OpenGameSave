const path = require('path');

const SUPPORTED_LANGUAGES = new Set(['en_US', 'zh_CN']);
const SUPPORTED_SYNC_PROVIDERS = new Set(['github', 'webdav']);
const AUTO_BACKUP_MODES = new Set(['interval', 'watcher']);
const BACKUP_PATH_TYPES = new Set(['file', 'folder', 'reg']);
const WIKI_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const BACKUP_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}(?:-\d{2})?$/;
const BACKUP_FOLDER_PATTERN = /^path[1-9]\d{0,3}$/;
const MAX_PATH_LENGTH = 32767;
const MAX_WIKI_ID_LIST_LENGTH = 10000;
const MAX_AUTO_BACKUP_GAMES = 1000;
const MAX_DATABASE_PATCH_ROWS = 100000;

const BOOLEAN_SETTING_KEYS = new Set([
    'launchAtStartup',
    'autoAppUpdate',
    'autoDbUpdate',
    'syncAccentColor',
    'experimentalXgpSource',
    'backupAllAccounts',
    'saveUninstalledGames',
    'blockedGameTipDismissed',
    'firstLaunchFullScanTipShown'
]);

const WIKI_ID_ARRAY_SETTING_KEYS = new Set([
    'pinnedGames',
    'blockedGames',
    'uninstalledGames'
]);

const ALLOWED_SETTING_KEYS = new Set([
    'language',
    'backupPath',
    'exportPath',
    'syncProvider',
    'webdavUrl',
    'webdavUsername',
    'webdavRemotePath',
    'maxBackups',
    ...BOOLEAN_SETTING_KEYS,
    'gameInstalls',
    ...WIKI_ID_ARRAY_SETTING_KEYS,
    'autoBackupGames'
]);

function normalizeLanguage(language) {
    return SUPPORTED_LANGUAGES.has(language) ? language : 'en_US';
}

function normalizeSyncProvider(provider, fallback = 'github') {
    return SUPPORTED_SYNC_PROVIDERS.has(provider) ? provider : fallback;
}

function normalizeWebDAVUrl(value, { allowEmpty = true, fallback = null } = {}) {
    if ((value === null || value === undefined || value === '') && allowEmpty) return '';
    if (typeof value !== 'string' || value.length > 2048 || value.includes('\0') || /[\r\n]/.test(value)) {
        if (fallback !== null) return fallback;
        throw new Error('Invalid WebDAV URL');
    }
    try {
        const parsed = new URL(value.trim());
        if (!['http:', 'https:'].includes(parsed.protocol)
            || parsed.username || parsed.password || parsed.hash || parsed.search) {
            throw new Error('Invalid WebDAV URL');
        }
        return parsed.toString().replace(/\/$/, '');
    } catch (_) {
        if (fallback !== null) return fallback;
        throw new Error('Invalid WebDAV URL');
    }
}

function normalizeWebDAVUsername(value, fallback = null) {
    if (typeof value !== 'string' || value.length > 512 || value.includes('\0') || /[\r\n]/.test(value)) {
        if (fallback !== null) return fallback;
        throw new Error('Invalid WebDAV username');
    }
    return value.trim();
}

function normalizeWebDAVRemotePath(value, fallback = null) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024
        || value.includes('\0') || /[\r\n]/.test(value)) {
        if (fallback !== null) return fallback;
        throw new Error('Invalid WebDAV remote path');
    }
    const normalized = `/${value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}`;
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length === 0 || segments.some(segment => segment === '.' || segment === '..')) {
        if (fallback !== null) return fallback;
        throw new Error('WebDAV remote path must be a dedicated subdirectory');
    }
    return `/${segments.join('/')}`;
}

function normalizeWikiId(wikiId) {
    const normalized = String(wikiId ?? '').trim();
    if (!normalized || normalized.length > 128 || !WIKI_ID_PATTERN.test(normalized)) {
        throw new Error('Invalid wiki id');
    }
    return normalized;
}

function normalizeBackupDate(backupDate) {
    const normalized = String(backupDate ?? '').trim();
    if (!BACKUP_DATE_PATTERN.test(normalized)) {
        throw new Error('Invalid backup date');
    }

    const [datePart, timePart] = normalized.split('_');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute, second = 0] = timePart.split('-').map(Number);
    const candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (
        candidate.getUTCFullYear() !== year
        || candidate.getUTCMonth() !== month - 1
        || candidate.getUTCDate() !== day
        || candidate.getUTCHours() !== hour
        || candidate.getUTCMinutes() !== minute
        || candidate.getUTCSeconds() !== second
    ) {
        throw new Error('Invalid backup date');
    }
    return normalized;
}

function normalizeRegistryKeyPath(registryPath) {
    const normalized = String(registryPath || '').trim().replace(/\//g, '\\').replace(/\\+$/, '');
    if (normalized.length > 16384 || normalized.includes('\0') || /[\r\n]/.test(normalized)) {
        throw new Error('Invalid registry key path');
    }
    const segments = normalized.split('\\');
    if (segments.length < 3 || segments.some(segment => !segment || segment === '.' || segment === '..')) {
        throw new Error('Registry path is too broad');
    }
    const hive = segments[0].toUpperCase();
    const subkey = segments.slice(1).join('\\').toLowerCase();
    const forbiddenUserPrefixes = [
        'environment', 'volatile environment', 'system', 'control panel', 'console',
        'network', 'printers', 'sessioninformation', 'software\\classes', 'software\\policies',
        'software\\microsoft\\windows', 'software\\microsoft\\windows nt',
        'software\\microsoft\\internet explorer', 'software\\microsoft\\office',
        'software\\microsoft\\onedrive', 'software\\microsoft\\powershell'
    ];

    if (hive === 'HKEY_CURRENT_USER') {
        if (subkey === 'software\\microsoft'
            || forbiddenUserPrefixes.some(prefix => subkey === prefix || subkey.startsWith(`${prefix}\\`))) {
            throw new Error('Registry path targets a protected user key');
        }
    } else if (hive === 'HKEY_LOCAL_MACHINE') {
        if (!subkey.startsWith('software\\')
            || subkey === 'software\\microsoft'
            || ['software\\classes', 'software\\policies', 'software\\microsoft\\windows', 'software\\microsoft\\windows nt']
                .some(prefix => subkey === prefix || subkey.startsWith(`${prefix}\\`))) {
            throw new Error('Registry path targets a protected machine key');
        }
    } else if (hive === 'HKEY_CLASSES_ROOT') {
        if (!subkey.startsWith('virtualstore\\machine\\software\\')) {
            throw new Error('Registry path targets a protected classes key');
        }
    } else {
        throw new Error('Unsupported registry hive');
    }
    return `${hive}\\${segments.slice(1).join('\\')}`;
}

function isXboxPgsPath(value) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false;
    const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
    return /^(?:[a-z]:|\{\{p\|systemdrive\}\})\/xboxgames\/gamesave\/pgs(?:\/|$)/.test(normalized);
}

function isPathInside(rootPath, targetPath) {
    const relativePath = path.relative(path.resolve(rootPath), path.resolve(targetPath));
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function resolveInside(rootPath, ...segments) {
    const resolvedRoot = path.resolve(rootPath);
    const resolvedTarget = path.resolve(resolvedRoot, ...segments.map(segment => String(segment)));
    if (!isPathInside(resolvedRoot, resolvedTarget)) {
        throw new Error('Path escapes the expected root');
    }
    return resolvedTarget;
}

async function assertNoSymlinkAncestors(rootPath, targetPath, fsAdapter) {
    if (!fsAdapter?.promises?.lstat || !isPathInside(rootPath, targetPath)) {
        throw new Error('Invalid path verification request');
    }
    const resolvedRoot = path.resolve(rootPath);
    const relativeSegments = path.relative(resolvedRoot, path.resolve(targetPath)).split(path.sep).filter(Boolean);
    let currentPath = resolvedRoot;
    for (const segment of ['', ...relativeSegments]) {
        if (segment) currentPath = path.join(currentPath, segment);
        try {
            const stats = await fsAdapter.promises.lstat(currentPath);
            if (stats.isSymbolicLink()) throw new Error('Path contains a symbolic link');
        } catch (error) {
            if (error?.code === 'ENOENT') break;
            throw error;
        }
    }
}

function normalizeAbsolutePath(value, { allowEmpty = false, fallback = null } = {}) {
    if ((value === null || value === undefined || value === '') && allowEmpty) {
        return '';
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH || !path.isAbsolute(value)) {
        if (fallback !== null) return fallback;
        throw new Error('Invalid absolute path');
    }
    return path.normalize(value);
}

function normalizeBackupRoot(value, fallback = null) {
    const normalized = normalizeAbsolutePath(value, { fallback });
    if (normalized && path.parse(normalized).root === normalized) {
        if (fallback !== null) return fallback;
        throw new Error('Backup path cannot be a filesystem root');
    }
    return normalized;
}

function normalizeBoundedInteger(value, minimum, maximum, fallback = null) {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
        if (fallback !== null) return fallback;
        throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
    }
    return parsed;
}

function normalizeBoolean(value, fallback = null) {
    if (typeof value === 'boolean') return value;
    if (fallback !== null) return fallback;
    throw new Error('Expected a boolean');
}

function normalizeWikiIdArray(value, fallback = []) {
    if (!Array.isArray(value)) return [...fallback];
    const normalizedIds = [];
    const seen = new Set();
    for (const wikiId of value.slice(0, MAX_WIKI_ID_LIST_LENGTH)) {
        try {
            const normalized = normalizeWikiId(wikiId);
            if (!seen.has(normalized)) {
                seen.add(normalized);
                normalizedIds.push(normalized);
            }
        } catch (_) {
            // Ignore malformed persisted identifiers instead of poisoning settings load.
        }
    }
    return normalizedIds;
}

function normalizeGameInstallPaths(value, fallback = 'uninitialized') {
    if (value === 'uninitialized') return value;
    if (!Array.isArray(value)) return fallback;

    const normalizedPaths = [];
    const seen = new Set();
    for (const installPath of value.slice(0, 100)) {
        try {
            const normalized = normalizeAbsolutePath(installPath);
            const comparisonKey = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
            if (!seen.has(comparisonKey)) {
                seen.add(comparisonKey);
                normalizedPaths.push(normalized);
            }
        } catch (_) {
            // Invalid or relative install paths are not useful and are dropped.
        }
    }
    return normalizedPaths;
}

function normalizeAutoBackupMode(mode) {
    if (!AUTO_BACKUP_MODES.has(mode)) {
        throw new Error('Invalid auto-backup mode');
    }
    return mode;
}

function normalizeAutoBackupInterval(intervalMinutes) {
    return normalizeBoundedInteger(intervalMinutes, 1, 1440);
}

function normalizeAutoBackupGames(value, fallback = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...fallback };
    const normalized = Object.create(null);
    let count = 0;
    for (const [rawWikiId, config] of Object.entries(value)) {
        if (count >= MAX_AUTO_BACKUP_GAMES) break;
        try {
            const wikiId = normalizeWikiId(rawWikiId);
            const mode = normalizeAutoBackupMode(config?.mode);
            normalized[wikiId] = {
                mode,
                intervalMinutes: mode === 'interval' ? normalizeAutoBackupInterval(config?.intervalMinutes) : null
            };
            count += 1;
        } catch (_) {
            // Ignore malformed persisted jobs; they must not create zero-delay timers.
        }
    }
    return normalized;
}

function sanitizeSettingValue(key, value, fallback) {
    if (!ALLOWED_SETTING_KEYS.has(key)) {
        throw new Error(`Unknown setting: ${key}`);
    }
    if (key === 'language') return normalizeLanguage(value);
    if (key === 'backupPath') return normalizeBackupRoot(value, fallback);
    if (key === 'exportPath') return normalizeAbsolutePath(value, { allowEmpty: true, fallback });
    if (key === 'syncProvider') return normalizeSyncProvider(value, fallback);
    if (key === 'webdavUrl') return normalizeWebDAVUrl(value, { allowEmpty: true, fallback });
    if (key === 'webdavUsername') return normalizeWebDAVUsername(value, fallback);
    if (key === 'webdavRemotePath') return normalizeWebDAVRemotePath(value, fallback);
    if (key === 'maxBackups') return normalizeBoundedInteger(value, 1, 1000, fallback);
    if (BOOLEAN_SETTING_KEYS.has(key)) return normalizeBoolean(value, fallback);
    if (WIKI_ID_ARRAY_SETTING_KEYS.has(key)) return normalizeWikiIdArray(value, fallback);
    if (key === 'gameInstalls') return normalizeGameInstallPaths(value, fallback);
    if (key === 'autoBackupGames') return normalizeAutoBackupGames(value, fallback);
    throw new Error(`Unsupported setting: ${key}`);
}

function sanitizeSettings(loadedSettings, defaultSettings) {
    const source = loadedSettings && typeof loadedSettings === 'object' && !Array.isArray(loadedSettings)
        ? loadedSettings
        : {};
    const sanitized = {};
    for (const [key, defaultValue] of Object.entries(defaultSettings)) {
        sanitized[key] = sanitizeSettingValue(key, source[key], defaultValue);
    }
    return sanitized;
}

function normalizeShortText(value, maximumLength, { allowEmpty = true } = {}) {
    if (value === null || value === undefined) {
        if (allowEmpty) return '';
        throw new Error('Expected text');
    }
    if (typeof value !== 'string') throw new Error('Expected text');
    const normalized = value.trim();
    if ((!allowEmpty && !normalized) || normalized.length > maximumLength) {
        throw new Error('Text is outside the allowed length');
    }
    return normalized;
}

function validateBackupMetadata(rawMetadata) {
    if (!rawMetadata || typeof rawMetadata !== 'object' || Array.isArray(rawMetadata)) {
        throw new Error('Invalid backup metadata');
    }
    if (!Array.isArray(rawMetadata.backup_paths) || rawMetadata.backup_paths.length > 128) {
        throw new Error('Invalid backup path list');
    }

    const seenFolders = new Set();
    const backupPaths = rawMetadata.backup_paths.map((backupPath) => {
        if (!backupPath || typeof backupPath !== 'object' || Array.isArray(backupPath)) {
            throw new Error('Invalid backup path metadata');
        }
        const folderName = String(backupPath.folder_name || '');
        if (!BACKUP_FOLDER_PATTERN.test(folderName) || seenFolders.has(folderName)) {
            throw new Error('Invalid backup folder name');
        }
        seenFolders.add(folderName);

        const template = normalizeShortText(backupPath.template, MAX_PATH_LENGTH, { allowEmpty: false });
        const type = String(backupPath.type || '');
        if (!BACKUP_PATH_TYPES.has(type)) throw new Error('Invalid backup path type');

        return {
            folder_name: folderName,
            template,
            type,
            install_folder: backupPath.install_folder == null
                ? null
                : normalizeShortText(backupPath.install_folder, 512)
        };
    });

    return {
        title: normalizeShortText(rawMetadata.title, 512, { allowEmpty: false }),
        zh_CN: rawMetadata.zh_CN == null ? null : normalizeShortText(rawMetadata.zh_CN, 512),
        backup_paths: backupPaths,
        is_permanent: rawMetadata.is_permanent === true,
        custom_name: normalizeShortText(rawMetadata.custom_name, 120)
    };
}

function validateArchiveEntryPath(entryPath) {
    if (typeof entryPath !== 'string' || !entryPath || entryPath.length > 4096 || entryPath.includes('\0')) {
        throw new Error('Archive contains an invalid path');
    }
    const normalized = entryPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
        throw new Error('Archive contains an absolute path');
    }
    const segments = normalized.split('/');
    if (segments.length > 64 || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes(':'))) {
        throw new Error('Archive path escapes its destination');
    }
    normalizeWikiId(segments[0]);
    if (segments.length >= 2) normalizeBackupDate(segments[1]);
    return normalized;
}

function normalizeNullableInteger(value, fieldName) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`Invalid ${fieldName}`);
    }
    return parsed;
}

function normalizeDatabaseText(value, fieldName, maximumLength, { required = false } = {}) {
    if (value === null || value === undefined) {
        if (required) throw new Error(`Missing ${fieldName}`);
        return null;
    }
    if (typeof value !== 'string' || value.length > maximumLength || (required && !value.trim())) {
        throw new Error(`Invalid ${fieldName}`);
    }
    return value;
}

function validateSaveLocationJson(value) {
    const serialized = normalizeDatabaseText(value, 'save_location', 1024 * 1024, { required: true });
    let parsed;
    try {
        parsed = JSON.parse(serialized);
    } catch (_) {
        throw new Error('Invalid save_location JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid save_location object');
    }
    for (const platformKey of ['win', 'linux', 'mac', 'reg']) {
        const locations = parsed[platformKey];
        if (locations !== undefined && (!Array.isArray(locations) || locations.length > 128)) {
            throw new Error(`Invalid ${platformKey} save locations`);
        }
        for (const location of locations || []) {
            if (typeof location !== 'string' || !location || location.length > MAX_PATH_LENGTH || location.includes('\0')) {
                throw new Error(`Invalid ${platformKey} save location`);
            }
        }
    }
    return serialized;
}

function validateDatabasePatch(rawPatch, expectedVersion, expectedFromVersion) {
    if (!rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
        throw new Error('Invalid database patch');
    }
    const version = normalizeBoundedInteger(rawPatch.version, 1, 2147483647);
    if (expectedVersion !== undefined && version !== expectedVersion) {
        throw new Error('Database patch version does not match its asset name');
    }
    const fromVersion = normalizeBoundedInteger(rawPatch.from_version, 0, 2147483646);
    if (version !== fromVersion + 1) {
        throw new Error('Database patch must advance exactly one version');
    }
    if (expectedFromVersion !== undefined && fromVersion !== expectedFromVersion) {
        throw new Error('Database patch source version does not match the local database');
    }
    const upsert = rawPatch.upsert === undefined ? [] : rawPatch.upsert;
    const deleted = rawPatch.delete === undefined ? [] : rawPatch.delete;
    const metadataUpsert = rawPatch.metadata_upsert === undefined ? [] : rawPatch.metadata_upsert;
    const metadataDelete = rawPatch.metadata_delete === undefined ? [] : rawPatch.metadata_delete;
    if (!Array.isArray(upsert) || !Array.isArray(deleted) || !Array.isArray(metadataUpsert) || !Array.isArray(metadataDelete)
        || upsert.length + deleted.length + metadataUpsert.length + metadataDelete.length > MAX_DATABASE_PATCH_ROWS) {
        throw new Error('Database patch contains too many rows');
    }

    const normalizedUpserts = upsert.map((row) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new Error('Invalid database patch row');
        }
        const wikiPageId = normalizeNullableInteger(row.wiki_page_id, 'wiki_page_id');
        if (wikiPageId === null) throw new Error('Missing wiki_page_id');
        return {
            wiki_page_id: wikiPageId,
            title: normalizeDatabaseText(row.title, 'title', 512, { required: true }),
            zh_CN: normalizeDatabaseText(row.zh_CN, 'zh_CN', 512),
            install_folder: normalizeDatabaseText(row.install_folder, 'install_folder', 1024),
            steam_id: normalizeNullableInteger(row.steam_id, 'steam_id'),
            gog_id: normalizeNullableInteger(row.gog_id, 'gog_id'),
            platform: normalizeDatabaseText(row.platform, 'platform', 256),
            save_location: validateSaveLocationJson(row.save_location)
        };
    });
    const normalizedDeletes = deleted.map((wikiPageId) => {
        const normalized = normalizeNullableInteger(wikiPageId, 'wiki_page_id');
        if (normalized === null) throw new Error('Missing wiki_page_id');
        return normalized;
    });

    const normalizedMetadataUpserts = metadataUpsert.map(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid metadata patch row');
        return {
            key: normalizeDatabaseText(row.key, 'metadata key', 256, { required: true }),
            value: normalizeDatabaseText(row.value, 'metadata value', 4096)
        };
    });
    const normalizedMetadataDeletes = metadataDelete.map(key =>
        normalizeDatabaseText(key, 'metadata key', 256, { required: true }));

    return {
        version,
        from_version: fromVersion,
        upsert: normalizedUpserts,
        delete: [...new Set(normalizedDeletes)],
        metadata_upsert: normalizedMetadataUpserts,
        metadata_delete: [...new Set(normalizedMetadataDeletes)]
    };
}

module.exports = {
    ALLOWED_SETTING_KEYS,
    BACKUP_DATE_PATTERN,
    assertNoSymlinkAncestors,
    isXboxPgsPath,
    normalizeAbsolutePath,
    normalizeAutoBackupGames,
    normalizeAutoBackupInterval,
    normalizeAutoBackupMode,
    normalizeBackupRoot,
    normalizeBackupDate,
    normalizeBoundedInteger,
    normalizeLanguage,
    normalizeSyncProvider,
    normalizeWebDAVRemotePath,
    normalizeWebDAVUrl,
    normalizeWebDAVUsername,
    normalizeRegistryKeyPath,
    normalizeWikiId,
    normalizeWikiIdArray,
    isPathInside,
    resolveInside,
    sanitizeSettings,
    sanitizeSettingValue,
    validateArchiveEntryPath,
    validateBackupMetadata,
    validateDatabasePatch
};
