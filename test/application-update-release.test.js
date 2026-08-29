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
    assert.match(releaseWorkflow, /npm ci --ignore-scripts/);
    assert.match(releaseWorkflow, /npm rebuild better-sqlite3/);
    assert.match(releaseWorkflow, /--verify-tag/);
    assert.match(releaseWorkflow, /releases\?per_page=100/);
    assert.match(releaseWorkflow, /steps\.draft_release\.outputs\.RELEASE_ID/);
    assert.match(releaseWorkflow, /releases\/\$RELEASE_ID/);
    assert.match(releaseWorkflow, /--method PATCH/);
    assert.match(releaseWorkflow, /validate-app-release\.js/);
    assert.match(releaseWorkflow, /--remote-json/);
    assert.match(releaseWorkflow, /environment: application-release/);
    assert.match(releaseWorkflow, /WINDOWS_CSC_LINK/);
    assert.match(releaseWorkflow, /WINDOWS_PUBLISHER_NAME/);
    assert.match(releaseWorkflow, /Rebuild Electron native dependencies[\s\S]*npm run rebuild:electron-native/);
    assert.match(releaseWorkflow, /Package and sign distributables[\s\S]*node node_modules\/electron-builder\/cli\.js/);
    assert.doesNotMatch(releaseWorkflow, /run: npm run app:dist:release/);
    assert.match(releaseWorkflow, /--publisher \$env:WIN_PUBLISHER_NAME/);
    assert.match(releaseWorkflow, /--publisher "\$WIN_PUBLISHER_NAME"/);
    assert.match(releaseWorkflow, /actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5/);
    assert.match(releaseWorkflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/);
    assert.match(releaseWorkflow, /persist-credentials: false/);
    assert.match(releaseWorkflow, /gh auth setup-git/);
    assert.match(releaseWorkflow, /permissions:\s+contents: read[\s\S]*release:[\s\S]*permissions:\s+contents: write/);
    assert.match(releaseBuilder, /channel: updateChannel/);
    assert.match(releaseBuilder, /WIN_PUBLISHER_NAME/);
    assert.match(releaseBuilder, /CSC_LINK/);
    assert.match(releaseBuilder, /signtoolOptions:[\s\S]*publisherName: \[publisherName\]/);
    assert.match(releaseBuilder, /npmRebuild: false/);
    assert.match(releaseValidator, /Get-AuthenticodeSignature/);
    assert.match(releaseValidator, /--publisher is required/);
    assert.match(releaseValidator, /signature\?\.Status !== 'Valid'/);
    assert.match(releaseValidator, /publisherMatchesSubject/);
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

test('privileged workflows pin third-party actions and scope repository credentials', () => {
    const privilegedWorkflows = [
        ['.github/workflows/release.yml', 'application-release'],
        ['.github/workflows/db-patch.yml', 'database-release'],
        ['.github/workflows/ludusavi-sync.yml', 'database-sync']
    ];
    for (const [workflowPath, environment] of privilegedWorkflows) {
        const workflow = read(workflowPath);
        assert.match(workflow, /permissions:\s+contents: read/);
        assert.match(workflow, new RegExp(`environment: ${environment}`));
        assert.match(workflow, /persist-credentials: false/);
        for (const action of workflow.matchAll(/uses:\s+([^\s#]+)@([^\s#]+)/g)) {
            assert.match(action[2], /^[a-f0-9]{40}$/, `${action[1]} in ${workflowPath} is not SHA-pinned`);
        }
    }
});
