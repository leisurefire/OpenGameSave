const test = require('node:test');
const assert = require('node:assert/strict');

const {
    compareAppVersions,
    getExpectedAppAssetNames,
    normalizeAppVersion,
    selectLatestAppRelease
} = require('../src/main/appUpdatePolicy');
const { resolveNextReleaseVersion } = require('../scripts/resolve-release-version');

function appRelease(version, { prerelease = version.includes('-'), assets = true } = {}) {
    const expected = getExpectedAppAssetNames(version);
    return {
        tag_name: `v${version}`,
        tagName: `v${version}`,
        draft: false,
        prerelease,
        isPrerelease: prerelease,
        html_url: `https://github.example/releases/v${version}`,
        assets: assets ? Object.values(expected).filter(name => name.includes('.')).map(name => ({ name })) : []
    };
}

test('application versions use SemVer prerelease ordering', () => {
    assert.equal(normalizeAppVersion('v0.8.0-beta.2'), '0.8.0-beta.2');
    assert.equal(compareAppVersions('0.8.0-beta.2', '0.8.0-beta.1') > 0, true);
    assert.equal(compareAppVersions('0.8.0', '0.8.0-rc.9') > 0, true);
    assert.equal(normalizeAppVersion('0.8.0-beta.01'), null);
});

test('release selection ignores database releases and requires complete assets', () => {
    const databaseRelease = { tag_name: 'database-42', prerelease: false, assets: [{ name: 'database.db' }] };
    const incomplete = appRelease('0.8.0', { assets: false });
    const stable = appRelease('0.7.2');
    const beta = appRelease('0.8.0-beta.2');

    assert.equal(selectLatestAppRelease([databaseRelease, incomplete, stable, beta]).version, '0.7.2');
    assert.equal(selectLatestAppRelease([databaseRelease, stable, beta], { includePrerelease: true }).version,
        '0.8.0-beta.2');
});

test('release resolver increments stable and prerelease channels independently', () => {
    const releases = [appRelease('0.7.2'), appRelease('0.7.3-beta.1')];
    const prerelease = resolveNextReleaseVersion({
        packageVersion: '0.7.2',
        releases,
        versionBump: 'patch',
        releaseChannel: 'prerelease',
        prereleaseLabel: 'beta'
    });
    assert.equal(prerelease.nextVersion, '0.7.3-beta.2');
    assert.equal(prerelease.updateChannel, 'beta');

    const stable = resolveNextReleaseVersion({
        packageVersion: '0.7.2',
        releases,
        versionBump: 'patch',
        releaseChannel: 'stable'
    });
    assert.equal(stable.nextVersion, '0.7.3');
    assert.equal(stable.isPrerelease, false);
});
