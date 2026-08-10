const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { acquireGameOperation, acquireGlobalOperation } = require('../src/main/gameOperationLock');
const { acquireDatabaseRead, acquireDatabaseWrite } = require('../src/main/databaseOperationLock');
const { isRendererFileUrl } = require('../src/main/windowSecurity');

test('renderer navigation only accepts files under the renderer root', () => {
    const rendererRoot = path.resolve('src', 'renderer');
    assert.equal(isRendererFileUrl(pathToFileURL(path.join(rendererRoot, 'index.html')).href, rendererRoot), true);
    assert.equal(isRendererFileUrl(pathToFileURL(path.resolve('package.json')).href, rendererRoot), false);
    assert.equal(isRendererFileUrl('https://example.com/', rendererRoot), false);
});

test('game operations are mutually exclusive and releases are idempotent', () => {
    const release = acquireGameOperation('123', 'backup');
    assert.throws(() => acquireGameOperation('123', 'restore'), /busy/);
    release();
    release();
    const releaseRestore = acquireGameOperation('123', 'restore');
    releaseRestore();
});

test('global backup-storage operations exclude per-game mutations', () => {
    const releaseGlobal = acquireGlobalOperation('migration');
    assert.throws(() => acquireGameOperation('123', 'backup'), /busy/);
    assert.throws(() => acquireGlobalOperation('import'), /busy/);
    releaseGlobal();

    const releaseGame = acquireGameOperation('123', 'backup');
    assert.throws(() => acquireGlobalOperation('migration'), /busy/);
    releaseGame();
});

test('database writes wait for readers and do not starve behind new reads', async () => {
    const releaseReadOne = await acquireDatabaseRead();
    const releaseReadTwo = await acquireDatabaseRead();
    const order = [];
    let releaseWrite;
    let releaseLateRead;
    const writeAcquired = acquireDatabaseWrite().then((release) => {
        releaseWrite = release;
        order.push('write');
    });
    const lateReadAcquired = acquireDatabaseRead().then((release) => {
        releaseLateRead = release;
        order.push('read');
    });

    await Promise.resolve();
    assert.deepEqual(order, []);
    releaseReadOne();
    releaseReadTwo();
    await writeAcquired;
    assert.deepEqual(order, ['write']);
    releaseWrite();
    await lateReadAcquired;
    assert.deepEqual(order, ['write', 'read']);
    releaseLateRead();
});
