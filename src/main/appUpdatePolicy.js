const APP_INSTALLER_PREFIX = 'OpenGameSave-Setup-';
const SEMVER_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseAppVersion(value) {
    const match = String(value || '').trim().match(SEMVER_PATTERN);
    if (!match) return null;

    const prerelease = match[4] ? match[4].split('.') : [];
    if (prerelease.some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) {
        return null;
    }

    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (![major, minor, patch].every(Number.isSafeInteger)) return null;
    const version = `${major}.${minor}.${patch}${prerelease.length ? `-${prerelease.join('.')}` : ''}`;
    return { major, minor, patch, prerelease, version };
}

function comparePrerelease(left, right) {
    if (left.length === 0 || right.length === 0) {
        if (left.length === right.length) return 0;
        return left.length === 0 ? 1 : -1;
    }

    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        if (left[index] === undefined) return -1;
        if (right[index] === undefined) return 1;
        if (left[index] === right[index]) continue;

        const leftNumeric = /^\d+$/.test(left[index]);
        const rightNumeric = /^\d+$/.test(right[index]);
        if (leftNumeric && rightNumeric) return Number(left[index]) - Number(right[index]);
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        return left[index] < right[index] ? -1 : 1;
    }
    return 0;
}

function compareAppVersions(left, right) {
    const leftVersion = parseAppVersion(left);
    const rightVersion = parseAppVersion(right);
    if (!leftVersion || !rightVersion) return 0;

    for (const key of ['major', 'minor', 'patch']) {
        if (leftVersion[key] !== rightVersion[key]) {
            return leftVersion[key] - rightVersion[key];
        }
    }
    return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function normalizeAppVersion(value) {
    return parseAppVersion(value)?.version || null;
}

function isNewerAppVersion(candidateVersion, currentVersion) {
    return compareAppVersions(candidateVersion, currentVersion) > 0;
}

function getUpdateChannel(version) {
    const parsed = parseAppVersion(version);
    if (!parsed) return null;
    if (parsed.prerelease.length === 0) return 'latest';
    const channel = parsed.prerelease[0].toLowerCase();
    return /^[a-z][a-z0-9-]{0,31}$/.test(channel) ? channel : null;
}

function getExpectedAppAssetNames(version) {
    const normalizedVersion = normalizeAppVersion(version);
    const channel = getUpdateChannel(normalizedVersion);
    if (!normalizedVersion || !channel) return null;
    const installer = `${APP_INSTALLER_PREFIX}${normalizedVersion}.exe`;
    return {
        installer,
        blockmap: `${installer}.blockmap`,
        metadata: `${channel}.yml`,
        channel
    };
}

function normalizeAssetNames(assets) {
    if (!Array.isArray(assets)) return new Set();
    return new Set(assets.map(asset => String(asset?.name || '')).filter(Boolean));
}

function toAppRelease(release, includePrerelease) {
    if (!release || release.draft === true) return null;
    const parsedVersion = parseAppVersion(release.tag_name);
    if (!parsedVersion) return null;

    const isPrerelease = parsedVersion.prerelease.length > 0;
    if (Boolean(release.prerelease) !== isPrerelease || (!includePrerelease && isPrerelease)) return null;

    const expectedAssets = getExpectedAppAssetNames(parsedVersion.version);
    const assetNames = normalizeAssetNames(release.assets);
    if (!expectedAssets || ![expectedAssets.installer, expectedAssets.blockmap, expectedAssets.metadata]
        .every(assetName => assetNames.has(assetName))) {
        return null;
    }

    return {
        version: parsedVersion.version,
        tag: String(release.tag_name),
        channel: expectedAssets.channel,
        metadata: expectedAssets.metadata
    };
}

function selectLatestAppRelease(releases, { includePrerelease = false } = {}) {
    return (Array.isArray(releases) ? releases : [])
        .map(release => toAppRelease(release, includePrerelease))
        .filter(Boolean)
        .sort((left, right) => compareAppVersions(right.version, left.version))[0] || null;
}

module.exports = {
    compareAppVersions,
    getExpectedAppAssetNames,
    getUpdateChannel,
    isNewerAppVersion,
    normalizeAppVersion,
    parseAppVersion,
    selectLatestAppRelease
};
