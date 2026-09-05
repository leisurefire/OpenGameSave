const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

function createUpdaterHarness(t) {
    const updater = new EventEmitter();
    const app = Object.assign(new EventEmitter(), { getVersion: () => '0.7.3', isPackaged: true });
    let held = false;
    const status = { updating_app: false };
    const opened = [];
    const mocks = {
        electron: {
            app,
            BrowserWindow: { getAllWindows: () => [] },
            autoUpdater: new EventEmitter(),
            shell: { openExternal: async url => { opened.push(url); } }
        },
        'electron-updater': { autoUpdater: updater },
        './settingsService': { getSettings: () => ({ appUpdatePrerelease: false }) },
        './windowManager': { getMainWin: () => null },
        './statusService': { getStatus: () => status, updateStatus: (key, value) => { status[key] = value; } },
        '../gameOperationLock': { acquireGlobalOperation: () => {
            if (held) throw new Error('operation already held');
            held = true;
            return () => { held = false; };
        } }
    };
    const filename = path.resolve(__dirname, '../src/main/services/appUpdateService.js');
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    const originalRequire = loaded.require.bind(loaded);
    loaded.require = request => Object.hasOwn(mocks, request) ? mocks[request] : originalRequire(request);
    // Exercise the supported Windows updater branch on every CI platform.
    const source = fs.readFileSync(filename, 'utf8');
    loaded._compile(`(function(process) { ${source}\n})({ ...process, platform: 'win32' });`, filename);
    t.after(() => {
        app.emit('will-quit');
    });
    return { service: loaded.exports, updater, status, opened, isHeld: () => held };
}

test('a synchronous updater download failure releases the operation lock and allows retry', async t => {
    const harness = createUpdaterHarness(t);
    harness.updater.downloadUpdate = () => { throw new Error('invalid download metadata'); };
    harness.updater.emit('update-available', { version: '0.7.4' });
    const failed = await harness.service.downloadAppUpdate();
    assert.equal(failed.status, 'error');
    assert.equal(failed.fallbackOpened, true);
    assert.equal(harness.opened.length, 1);
    assert.equal(harness.status.updating_app, false);
    assert.equal(harness.isHeld(), false);

    harness.updater.downloadUpdate = async () => [];
    harness.updater.emit('update-available', { version: '0.7.4' });
    assert.equal((await harness.service.downloadAppUpdate()).status, 'downloaded');
    assert.equal(harness.isHeld(), true);
});

test('concurrent updater download requests share one download and release on rejection', async t => {
    const harness = createUpdaterHarness(t);
    let rejectDownload;
    let calls = 0;
    harness.updater.downloadUpdate = () => {
        calls += 1;
        return new Promise((resolve, reject) => { rejectDownload = reject; });
    };
    harness.updater.emit('update-available', { version: '0.7.4' });
    const first = harness.service.downloadAppUpdate();
    const second = harness.service.downloadAppUpdate();
    await Promise.resolve();
    assert.equal(calls, 1);
    rejectDownload(new Error('network failed'));
    const results = await Promise.all([first, second]);
    assert.equal(results[0].status, 'error');
    assert.deepEqual(results[1], results[0]);
    assert.equal(harness.isHeld(), false);
    assert.equal(harness.status.updating_app, false);
});
