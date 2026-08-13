'use strict';

const { normalizeSha256 } = require('./databaseUpdateFiles');

const MAX_DATABASE_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_PATCH_DOWNLOAD_BYTES = 16 * 1024 * 1024;

function validateAssetDescriptor(raw, expectedName, maxBytes) {
    if (!raw || typeof raw !== 'object' || raw.name !== expectedName) throw new Error('Invalid asset descriptor');
    const size = Number(raw.size);
    const sha256 = normalizeSha256(raw.sha256);
    if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes || !sha256) {
        throw new Error('Invalid asset size or SHA-256 digest in manifest');
    }
    return { ...raw, name: expectedName, size, sha256 };
}

function validateDatabaseManifest(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid database manifest');
    const latestVersion = Number(raw.latest_version);
    if (!Number.isInteger(latestVersion) || latestVersion < 1 || latestVersion > 2147483647) {
        throw new Error('Invalid latest database version');
    }
    if (typeof raw.source_sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(raw.source_sha)) {
        throw new Error('Invalid database source SHA');
    }
    if (typeof raw.schema_version !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.schema_version)) {
        throw new Error('Invalid database schema version');
    }
    const database = validateAssetDescriptor(raw.database, `database_v${latestVersion}.db`, MAX_DATABASE_DOWNLOAD_BYTES);
    if (database.user_version !== latestVersion) throw new Error('Manifest database version is inconsistent');
    const seenVersions = new Set();
    const patches = (raw.patches || []).map(item => {
        const from = Number(item?.from);
        const to = Number(item?.to);
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to !== from + 1 || to > latestVersion) {
            throw new Error('Manifest contains an invalid patch version range');
        }
        if (seenVersions.has(to)) throw new Error('Manifest contains a duplicate patch version');
        seenVersions.add(to);
        const descriptor = validateAssetDescriptor(item, `db_patch_v${to}.json`, MAX_PATCH_DOWNLOAD_BYTES);
        return { ...descriptor, from, to };
    }).sort((left, right) => left.to - right.to);
    for (let index = 1; index < patches.length; index++) {
        if (patches[index].from !== patches[index - 1].to) throw new Error('Manifest patch sequence contains a gap');
    }
    return {
        latest_version: latestVersion,
        source_sha: raw.source_sha,
        schema_version: raw.schema_version.toLowerCase(),
        database,
        patches
    };
}

module.exports = {
    MAX_DATABASE_DOWNLOAD_BYTES,
    MAX_PATCH_DOWNLOAD_BYTES,
    validateAssetDescriptor,
    validateDatabaseManifest
};
