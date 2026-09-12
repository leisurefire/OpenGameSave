const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('Tauri releases require Windows and updater signatures before publication', () => {
    const pkg = JSON.parse(read('package.json'));
    const config = JSON.parse(read('src-tauri/tauri.conf.json'));
    const workflow = read('.github/workflows/release.yml');
    assert.equal(pkg.dependencies.electron, undefined);
    assert.equal(pkg.devDependencies.electron, undefined);
    assert.deepEqual(config.bundle.targets, ['nsis']);
    assert.equal(config.build.frontendDist, '../dist/out/renderer');
    assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
    assert.match(workflow, /TAURI_UPDATER_PUBLIC_KEY/);
    assert.match(workflow, /Import-PfxCertificate/);
    assert.match(workflow, /--verify-tag/);
    assert.match(workflow, /git push --atomic/);
    assert.match(workflow, /Get-FileHash[\s\S]*Publish verified draft/);
    assert.match(read('scripts/tauri-release-artifacts.cjs'), /Get-AuthenticodeSignature/);
    assert.match(read('src-tauri/src/updates.rs'), /pubkey/);
});

test('application and database update actions remain in their intended locations', () => {
    assert.match(read('src/renderer/index.html'), /id="app-update-download"/);
    assert.doesNotMatch(read('src/renderer/index.html'), /id="update-database"/);
    assert.match(read('src/renderer/settings.html'), /id="update-database"/);
});

test('privileged workflows pin actions and scope repository credentials', () => {
    for (const [file, environment] of [['release.yml', 'application-release'], ['db-patch.yml', 'database-release'], ['ludusavi-sync.yml', 'database-sync']]) {
        const workflow = read(`.github/workflows/${file}`);
        assert.match(workflow, /permissions:\s+contents: read/);
        assert.match(workflow, new RegExp(`environment: ${environment}`));
        assert.match(workflow, /persist-credentials: false/);
        for (const action of workflow.matchAll(/uses:\s+([^\s#]+)@([^\s#]+)/g)) assert.match(action[2], /^[a-f0-9]{40}$/);
    }
});
