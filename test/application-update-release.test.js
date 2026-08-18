const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('Windows releases are version-bound, channel-aware and remotely verified', () => {
    const packageJson = JSON.parse(read('package.json'));
    const releaseWorkflow = read('.github/workflows/release.yml');
    const releaseValidator = read('scripts/validate-app-release.js');
    const releaseBuilder = read('scripts/electron-builder.release.js');

    assert.equal(packageJson.dependencies['electron-updater'], '^6.8.9');
    assert.deepEqual(packageJson.build.publish, {
        provider: 'github',
        owner: 'leisurefire',
        repo: 'OpenGameSave'
    });
    assert.equal(packageJson.build.artifactName, '${productName}-Setup-${version}.${ext}');
    assert.match(releaseWorkflow, /group: application-release/);
    assert.match(releaseWorkflow, /--verify-tag/);
    assert.match(releaseWorkflow, /validate-app-release\.js/);
    assert.match(releaseWorkflow, /--remote-json/);
    assert.match(releaseWorkflow, /permissions:\s+contents: write/);
    assert.match(releaseBuilder, /channel: updateChannel/);
    assert.match(releaseValidator, /metadata\.files\[0\]\.url/);
    assert.match(releaseValidator, /metadata\.files\[0\]\.size/);
    assert.match(releaseValidator, /metadata\.files\[0\]\.sha512/);
    assert.match(releaseValidator, /remoteAsset\?\.digest/);
});

test('application and database update actions are exposed in their intended locations', () => {
    const mainPage = read('src/renderer/index.html');
    const settingsPage = read('src/renderer/settings.html');
    const settingsStyles = read('src/renderer/css/settings.css');

    assert.match(mainPage, /id="app-update-download"/);
    assert.doesNotMatch(mainPage, /id="update-database"/);
    assert.match(settingsPage, /id="update-database"/);
    assert.match(settingsStyles, /\.settings-row:has\(dropdown-select\[open\]\)/);
});
