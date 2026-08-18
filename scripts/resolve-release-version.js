#!/usr/bin/env node

const {
    compareAppVersions,
    normalizeAppVersion,
    parseAppVersion
} = require('../src/main/appUpdatePolicy');

const FLOOR_VERSION = '0.6.22';
const PRERELEASE_LABEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

function getStableReleaseVersions(releases) {
    return (Array.isArray(releases) ? releases : [])
        .filter(release => release?.isPrerelease !== true)
        .map(release => normalizeAppVersion(release?.tagName))
        .filter(version => version && parseAppVersion(version).prerelease.length === 0);
}

function getBaseStableVersion(packageVersion, releases) {
    const normalizedPackageVersion = normalizeAppVersion(packageVersion);
    const packageStableVersion = normalizedPackageVersion
        && parseAppVersion(normalizedPackageVersion).prerelease.length === 0
        ? normalizedPackageVersion
        : null;
    return [FLOOR_VERSION, packageStableVersion, ...getStableReleaseVersions(releases)]
        .filter(Boolean)
        .reduce((latest, version) => compareAppVersions(version, latest) > 0 ? version : latest, FLOOR_VERSION);
}

function bumpStableVersion(version, bump) {
    const parsed = parseAppVersion(version);
    if (!parsed || parsed.prerelease.length > 0) throw new Error(`Invalid stable base version: ${version}`);
    if (bump === 'patch') return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
    if (bump === 'minor') return `${parsed.major}.${parsed.minor + 1}.0`;
    throw new Error(`Unsupported version bump: ${bump}`);
}

function resolveNextReleaseVersion({
    packageVersion,
    releases,
    versionBump,
    releaseChannel,
    prereleaseLabel = 'beta'
}) {
    if (!['stable', 'prerelease'].includes(releaseChannel)) {
        throw new Error(`Unsupported release channel: ${releaseChannel}`);
    }
    if (!PRERELEASE_LABEL_PATTERN.test(prereleaseLabel)) {
        throw new Error(`Invalid prerelease label: ${prereleaseLabel}`);
    }

    const currentVersion = getBaseStableVersion(packageVersion, releases);
    const targetStableVersion = bumpStableVersion(currentVersion, versionBump);
    let nextVersion = targetStableVersion;

    if (releaseChannel === 'prerelease') {
        const prefix = `${targetStableVersion}-${prereleaseLabel}.`;
        const lastNumber = (Array.isArray(releases) ? releases : [])
            .map(release => normalizeAppVersion(release?.tagName))
            .filter(version => version?.startsWith(prefix))
            .map(version => Number(version.slice(prefix.length)))
            .filter(Number.isSafeInteger)
            .reduce((maximum, value) => Math.max(maximum, value), 0);
        nextVersion = `${prefix}${lastNumber + 1}`;
    }

    const existingTags = new Set((Array.isArray(releases) ? releases : [])
        .map(release => normalizeAppVersion(release?.tagName))
        .filter(Boolean));
    if (existingTags.has(nextVersion)) throw new Error(`Release v${nextVersion} already exists`);

    return {
        currentVersion,
        nextVersion,
        tag: `v${nextVersion}`,
        updateChannel: releaseChannel === 'stable' ? 'latest' : prereleaseLabel,
        isPrerelease: releaseChannel === 'prerelease'
    };
}

function run() {
    const result = resolveNextReleaseVersion({
        packageVersion: process.env.PACKAGE_VERSION,
        releases: JSON.parse(process.env.RELEASES_JSON || '[]'),
        versionBump: process.env.VERSION_BUMP,
        releaseChannel: process.env.RELEASE_CHANNEL,
        prereleaseLabel: process.env.PRERELEASE_LABEL || 'beta'
    });
    process.stdout.write([
        `CURRENT_VERSION=${result.currentVersion}`,
        `NEXT_VERSION=${result.nextVersion}`,
        `TAG=${result.tag}`,
        `UPDATE_CHANNEL=${result.updateChannel}`,
        `IS_PRERELEASE=${result.isPrerelease}`
    ].join('\n') + '\n');
}

if (require.main === module) run();

module.exports = { resolveNextReleaseVersion };
