const test = require('node:test');
const assert = require('node:assert/strict');

const { getSteamAccountId } = require('../src/main/steamAccount');

test('Steam account IDs are derived directly from valid SteamID64 values', () => {
    assert.equal(getSteamAccountId('76561197960265728'), '0');
    assert.equal(getSteamAccountId('76561197960278073'), '12345');
    assert.equal(getSteamAccountId('not-a-steam-id'), null);
    assert.equal(getSteamAccountId(null), null);
});
