const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const { getSteamAccountId } = require('../src/main/steamAccount');

test('Steam account IDs are derived directly from valid SteamID64 values', () => {
    assert.equal(getSteamAccountId('76561197960265728'), '0');
    assert.equal(getSteamAccountId('76561197960278073'), '12345');
    assert.equal(getSteamAccountId('not-a-steam-id'), null);
    assert.equal(getSteamAccountId(null), null);
});

test('unrelated newer Epic files cannot hide the latest valid account', async () => {
    const inspected = [];
    class FakeRegistry {
        get(name, callback) { callback(null, { value: '' }); }
    }
    const mocks = {
        fs: {
            existsSync: target => target.endsWith(path.join('EpicGamesLauncher', 'Saved', 'Data')),
            readdirSync: () => ['launcher.log', 'OC_abcd.dat'].map(name => ({ name, isFile: () => true }))
        },
        'original-fs': {},
        winreg: FakeRegistry,
        './fileSystemUtils': {
            getLatestModificationTimeAsync: async target => {
                inspected.push(path.basename(target));
                return target.endsWith('.log') ? 2000 : 1000;
            }
        }
    };
    const filename = path.resolve(__dirname, '../src/main/gameData.js');
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    const originalRequire = loaded.require.bind(loaded);
    loaded.require = request => mocks[request] || originalRequire(request);
    loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
    const gameData = loaded.exports.getGameData();
    await gameData.getCurrentUserIds();
    assert.equal(gameData.currentEpicUserId, 'abcd');
    assert.deepEqual(inspected, ['OC_abcd.dat']);
});
