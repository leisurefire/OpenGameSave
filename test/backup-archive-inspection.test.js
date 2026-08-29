const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ARCHIVE_PATH = path.join(PROJECT_ROOT, 'fixture.gsmr');

function requireWithMocks(relativePath, mocks) {
    const modulePath = path.join(PROJECT_ROOT, relativePath);
    const originalLoad = Module._load;
    Module._load = function loadWithTestMocks(request, parent, isMain) {
        if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve(modulePath)];
    try {
        return require(modulePath);
    } finally {
        Module._load = originalLoad;
    }
}

function createListing(entries) {
    const stream = new EventEmitter();
    let destroyed = false;
    stream.destroy = (error) => {
        if (destroyed) return;
        destroyed = true;
        process.nextTick(() => stream.emit('error', error));
    };
    process.nextTick(() => {
        for (const entry of entries) {
            if (destroyed) break;
            stream.emit('data', entry);
        }
        if (!destroyed) stream.emit('end');
    });
    return stream;
}

function loadArchiveService(entries) {
    return requireWithMocks('src/main/services/backupArchiveService.js', {
        'original-fs': {
            promises: {
                lstat: async () => ({
                    isFile: () => true,
                    isSymbolicLink: () => false,
                    size: 128
                })
            }
        },
        'node-7z': { list: () => createListing(entries) },
        '7zip-bin': { path7za: '7za' },
        '../fileSystemUtils': {},
        '../gameOperationLock': {},
        './settingsService': {},
        './statusService': {},
        './windowManager': {}
    });
}

test('invalid archive entry paths reject the inspection promise instead of escaping a data listener', async () => {
    const service = loadArchiveService([{ file: '../outside/backup_info.json', size: 1 }]);
    await assert.rejects(service.inspectImportArchive(ARCHIVE_PATH), /Archive path escapes|absolute path/);
});

test('non-finite and unsafe archive entry sizes fail closed before extraction', async (context) => {
    for (const size of [Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER + 1]) {
        await context.test(String(size), async () => {
            const service = loadArchiveService([{ file: '1234/2026-08-29_12-30/backup_info.json', size }]);
            await assert.rejects(service.inspectImportArchive(ARCHIVE_PATH), /invalid entry size/);
        });
    }
});

test('a bounded regular archive listing passes inspection', async () => {
    const service = loadArchiveService([
        { file: '1234', size: 0 },
        { file: '1234/2026-08-29_12-30', size: 0 },
        { file: '1234/2026-08-29_12-30/backup_info.json', size: 256 }
    ]);
    assert.equal(await service.inspectImportArchive(ARCHIVE_PATH), ARCHIVE_PATH);
});
