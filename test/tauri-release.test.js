const assert = require('node:assert/strict');
const test = require('node:test');
const { buildManifest } = require('../scripts/tauri-release-artifacts.cjs');

test('Tauri updater manifest pins version, platform and exact release asset', () => {
    const manifest = buildManifest({ version: '1.2.3', tag: 'v1.2.3', installer: 'OpenGameSave_1.2.3_x64-setup.exe', signature: 'YWJjZA==' });
    assert.equal(manifest.platforms['windows-x86_64'].url, 'https://github.com/leisurefire/OpenGameSave/releases/download/v1.2.3/OpenGameSave_1.2.3_x64-setup.exe');
    assert.throws(() => buildManifest({ version: '1.2.3', tag: 'v1.2.4', installer: '../payload.exe', signature: '' }));
});
