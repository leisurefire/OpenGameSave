const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/formatting.js'), 'utf8').replace(/export /g, '');
const context = vm.createContext({});
vm.runInContext(source, context);

test('size labels consistently handle invalid, fractional, and binary-unit values', () => {
    for (const value of [null, undefined, NaN, Infinity, -10, 0]) assert.equal(context.formatSize(value), '0 B');
    assert.equal(context.formatSize(0.5), '0.5 B');
    assert.equal(context.formatSize(1024), '1 KB');
    assert.equal(context.formatSize(1536), '1.5 KB');
    assert.equal(context.formatSize(1024 ** 4), '1 TB');
});

test('legacy and current backup dates use the same second-level display precision', () => {
    assert.equal(context.formatBackupDate('2026-09-05_01-02'), '2026/09/05 01:02:00');
    assert.equal(context.formatBackupDate('2026-09-05_01-02-03'), '2026/09/05 01:02:03');
    assert.equal(context.formatBackupDate('2026-9-5_1-2-3'), '2026/09/05 01:02:03');
    assert.equal(context.formatBackupDate('2026/09/05 01:02:03'), '2026/09/05 01:02:03');
    assert.equal(context.formatBackupDate(null), '');
});
