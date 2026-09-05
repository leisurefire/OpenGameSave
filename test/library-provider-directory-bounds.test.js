const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { scanLibraryProviders } = require('../src/main/services/libraryService');

test('provider enumeration counts irrelevant entries while allowing manifests beyond the artwork limit', async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-provider-bound-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const steamAppsRoot = path.join(root, 'steamapps');
    fs.mkdirSync(path.join(steamAppsRoot, 'common', 'Bounded Game'), { recursive: true });
    fs.writeFileSync(path.join(steamAppsRoot, 'appmanifest_543210.acf'), `
        "AppState"
        {
            "appid" "543210"
            "name" "Bounded Game"
            "installdir" "Bounded Game"
            "type" "Game"
        }
    `);

    let readCount = 0;
    let closeCount = 0;
    const realOpenDirectory = fs.opendirSync;
    context.mock.method(fs, 'opendirSync', (directoryPath, ...options) => {
        if (directoryPath !== steamAppsRoot) return realOpenDirectory(directoryPath, ...options);
        return {
            readSync() {
                readCount += 1;
                if (readCount > 25000) return null;
                return {
                    name: readCount === 1500 ? 'appmanifest_543210.acf' : `unrelated-${readCount}.txt`,
                    isFile: () => true
                };
            },
            closeSync() { closeCount += 1; }
        };
    });

    const games = await scanLibraryProviders({ providerNames: ['Steam'], steamRootCandidates: [root] });

    assert.deepEqual(games.map(game => game.title), ['Bounded Game']);
    assert.equal(readCount, 20000);
    assert.equal(closeCount, 1);
});
