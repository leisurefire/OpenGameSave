const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const yaml = require('js-yaml');

const { getExpectedAppAssetNames } = require('../src/main/appUpdatePolicy');
const { validateLocalArtifacts, validateRemoteAssets } = require('../scripts/validate-app-release');

const projectVersion = require('../package.json').version;

test('release validator binds metadata and remote digests to exact local bytes', async (context) => {
    const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-release-validation-'));
    context.after(() => fs.rmSync(tempPath, { recursive: true, force: true }));
    const expected = getExpectedAppAssetNames(projectVersion);
    const installerBytes = Buffer.from('installer-fixture');
    const installerPath = path.join(tempPath, expected.installer);
    fs.writeFileSync(installerPath, installerBytes);
    fs.writeFileSync(path.join(tempPath, expected.blockmap), 'blockmap');
    fs.mkdirSync(path.join(tempPath, 'win-unpacked', 'resources'), { recursive: true });
    fs.writeFileSync(path.join(tempPath, 'win-unpacked', 'resources', 'app-update.yml'), yaml.dump({
        provider: 'github'
    }));

    const sha512 = crypto.createHash('sha512').update(installerBytes).digest('base64');
    fs.writeFileSync(path.join(tempPath, expected.metadata), yaml.dump({
        version: projectVersion,
        files: [{ url: expected.installer, size: installerBytes.length, sha512 }],
        path: expected.installer,
        sha512
    }));

    const report = await validateLocalArtifacts({
        distPath: tempPath,
        version: projectVersion
    });
    const remotePath = path.join(tempPath, 'remote.json');
    fs.writeFileSync(remotePath, JSON.stringify({
        assets: report.artifacts.map(artifact => ({
            name: artifact.name,
            size: artifact.size,
            digest: artifact.digest
        }))
    }));
    assert.doesNotThrow(() => validateRemoteAssets(report, remotePath));

    const metadata = yaml.load(fs.readFileSync(path.join(tempPath, expected.metadata), 'utf8'));
    metadata.files[0].size += 1;
    fs.writeFileSync(path.join(tempPath, expected.metadata), yaml.dump(metadata));
    await assert.rejects(validateLocalArtifacts({
        distPath: tempPath,
        version: projectVersion
    }), /size mismatch/);
});
