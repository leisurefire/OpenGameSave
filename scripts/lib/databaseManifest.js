'use strict';

const { normalizeSha256 } = require('./databaseUpdateFiles');

const MAX_DATABASE_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_PATCH_DOWNLOAD_BYTES = 16 * 1024 * 1024;
const DATABASE_VARIANT_METADATA_KEY = 'database_variant';
const DATABASE_VARIANTS = new Set(['standard', 'xbox']);

function normalizeDatabaseVariant(value, fallback) {
    if (DATABASE_VARIANTS.has(value)) return value;
    if (arguments.length > 1 && DATABASE_VARIANTS.has(fallback)) return fallback;
    throw new Error('Invalid database variant');
}

function getDatabaseAssetNames(variant, version = null) {
    const normalizedVariant = normalizeDatabaseVariant(variant);
    const suffix = normalizedVariant === 'xbox' ? '_xbox' : '';
    const names = { pointer: `current${suffix}.json` };
    if (version !== null) {
        if (!Number.isInteger(version) || version < 1) throw new Error('Invalid database asset version');
        names.manifest = `manifest${suffix}_v${version}.json`;
        names.database = `database${suffix}_v${version}.db`;
        names.patch = `db_patch${suffix}_v${version}.json`;
    }
    return names;
}

function validateAssetDescriptor(raw, expectedName, maxBytes) {
    if (!raw || typeof raw !== 'object' || raw.name !== expectedName) throw new Error('Invalid asset descriptor');
    const size = Number(raw.size);
    const sha256 = normalizeSha256(raw.sha256);
    if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes || !sha256) {
        throw new Error('Invalid asset size or SHA-256 digest in manifest');
    }
    return { ...raw, name: expectedName, size, sha256 };
}

function validateDatabaseManifest(raw, expectedVariant = 'standard') {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid database manifest');
    const normalizedExpectedVariant = normalizeDatabaseVariant(expectedVariant);
    const variant = normalizeDatabaseVariant(raw.variant ?? 'standard');
    if (variant !== normalizedExpectedVariant) throw new Error('Database manifest variant does not match the requested variant');
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
    const names = getDatabaseAssetNames(variant, latestVersion);
    const database = validateAssetDescriptor(raw.database, names.database, MAX_DATABASE_DOWNLOAD_BYTES);
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
        const descriptor = validateAssetDescriptor(item, getDatabaseAssetNames(variant, to).patch, MAX_PATCH_DOWNLOAD_BYTES);
        return { ...descriptor, from, to };
    }).sort((left, right) => left.to - right.to);
    for (let index = 1; index < patches.length; index++) {
        if (patches[index].from !== patches[index - 1].to) throw new Error('Manifest patch sequence contains a gap');
    }
    return {
        variant,
        latest_version: latestVersion,
        source_sha: raw.source_sha,
        schema_version: raw.schema_version.toLowerCase(),
        database,
        patches
    };
}

module.exports = {
    DATABASE_VARIANTS,
    DATABASE_VARIANT_METADATA_KEY,
    MAX_DATABASE_DOWNLOAD_BYTES,
    MAX_PATCH_DOWNLOAD_BYTES,
    getDatabaseAssetNames,
    normalizeDatabaseVariant,
    validateAssetDescriptor,
    validateDatabaseManifest
};
