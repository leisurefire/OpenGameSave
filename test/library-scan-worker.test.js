const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    LibraryScanWorkerController,
    scanLibraryGames,
    shutdownLibraryScanner
} = require('../src/main/services/libraryService');

function deferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

class FakeScanWorker extends EventEmitter {
    constructor(terminationPromise) {
        super();
        this.messages = [];
        this.terminateCalls = 0;
        this.terminationPromise = terminationPromise;
    }

    postMessage(message) {
        this.messages.push(message);
    }

    terminate() {
        this.terminateCalls += 1;
        return this.terminationPromise;
    }
}

test('provider traversal stays off the caller thread and preserves renderer results', async (context) => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-library-worker-'));
    context.after(async () => {
        await shutdownLibraryScanner();
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    });

    const steamAppsRoot = path.join(temporaryDirectory, 'steamapps');
    const installPath = path.join(steamAppsRoot, 'common', 'Worker Boundary Game');
    fs.mkdirSync(installPath, { recursive: true });
    fs.writeFileSync(path.join(steamAppsRoot, 'appmanifest_345678.acf'), `
        "AppState"
        {
            "appid" "345678"
            "name" "Worker Boundary Game"
            "installdir" "Worker Boundary Game"
            "type" "Game"
        }
    `);

    const originalReadFileSync = fs.readFileSync;
    const originalReaddirSync = fs.readdirSync;
    const originalStatSync = fs.statSync;
    const callerThreadSyncReads = [];
    fs.readFileSync = (...args) => {
        callerThreadSyncReads.push(['readFileSync', args[0]]);
        return originalReadFileSync(...args);
    };
    fs.readdirSync = (...args) => {
        callerThreadSyncReads.push(['readdirSync', args[0]]);
        return originalReaddirSync(...args);
    };
    fs.statSync = (...args) => {
        callerThreadSyncReads.push(['statSync', args[0]]);
        return originalStatSync(...args);
    };

    try {
        const scanContext = {
            providerNames: ['Steam'],
            steamRootCandidates: [temporaryDirectory]
        };
        const firstScan = scanLibraryGames(scanContext);
        const coalescedScan = scanLibraryGames(scanContext);
        assert.equal(coalescedScan, firstScan);

        const games = await firstScan;
        assert.deepEqual(games, [{
            id: 'steam:345678',
            title: 'Worker Boundary Game',
            platform: 'Steam',
            platformId: '345678',
            installPath,
            hasCover: true,
            hasHero: true
        }]);
        assert.deepEqual(callerThreadSyncReads, []);
    } finally {
        fs.readFileSync = originalReadFileSync;
        fs.readdirSync = originalReaddirSync;
        fs.statSync = originalStatSync;
    }
});

test('scanner shutdown rejects active and future scans and awaits one termination', async () => {
    const termination = deferred();
    const worker = new FakeScanWorker(termination.promise);
    const controller = new LibraryScanWorkerController({ createWorker: () => worker });
    const scan = controller.run({ providerNames: ['Steam'] });

    assert.deepEqual(worker.messages, [{ scanContext: { providerNames: ['Steam'] } }]);
    const firstShutdown = controller.shutdown();
    const repeatedShutdown = controller.shutdown();
    assert.equal(repeatedShutdown, firstShutdown);
    await assert.rejects(scan, /Library scanner is shut down/);
    assert.equal(worker.terminateCalls, 1);

    let shutdownSettled = false;
    void firstShutdown.then(() => { shutdownSettled = true; });
    await new Promise(resolve => { setImmediate(resolve); });
    assert.equal(shutdownSettled, false);

    termination.resolve(0);
    await firstShutdown;
    assert.equal(shutdownSettled, true);
    await assert.rejects(controller.run({}), /Library scanner is shut down/);
    assert.equal(worker.terminateCalls, 1);
});

test('the library scan worker is emitted as a packaged main-process entry', () => {
    const workerSource = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'main', 'libraryScanWorker.js'),
        'utf8'
    );
    const webpackSource = fs.readFileSync(path.join(__dirname, '..', 'webpack.main.config.js'), 'utf8');
    const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
    const librarySource = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'main', 'services', 'libraryService.js'),
        'utf8'
    );

    assert.match(workerSource, /scanLibraryProviders/);
    assert.match(workerSource, /parentPort\.postMessage\(\{ type: 'done', games \}\)/);
    assert.match(webpackSource, /libraryScanWorker: '\.\/src\/main\/libraryScanWorker\.js'/);
    assert.match(mainSource, /shutdownLibraryScanner/);
    assert.match(mainSource, /runShutdownStep\('library scanner', shutdownLibraryScanner\(\)\)/);
    assert.match(librarySource, /MAX_LIBRARY_GAMES = 20000/);
    assert.match(librarySource, /readDirectoryEntriesBounded/);
    assert.match(librarySource, /results\.flat\(\)\.slice\(0, MAX_LIBRARY_GAMES\)/);
});
