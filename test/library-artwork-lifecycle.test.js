const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const MINIMAL_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function freshArtworkService() {
    const modulePath = require.resolve('../src/main/services/libraryArtworkService');
    delete require.cache[modulePath];
    return require(modulePath);
}

function temporaryArtwork(context) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-art-lifecycle-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const coverPath = path.join(root, 'cover.jpg');
    fs.writeFileSync(coverPath, MINIMAL_JPEG);
    return { id: 'local', platform: 'local', coverPath, artRoots: [root] };
}

test('local artwork uses asynchronous bounded reads and closes handles on cache hits', async (context) => {
    const service = freshArtworkService();
    const game = temporaryArtwork(context);
    const originalOpen = fs.promises.open;
    let opened = 0;
    let closed = 0;
    context.mock.method(fs.promises, 'open', async (...args) => {
        const handle = await originalOpen(...args);
        opened += 1;
        const close = handle.close.bind(handle);
        handle.close = async () => { closed += 1; await close(); };
        return handle;
    });
    const forbidden = [];
    for (const method of ['lstatSync', 'statSync', 'realpathSync', 'openSync', 'readSync']) {
        forbidden.push(context.mock.method(fs, method, () => {
            throw new Error('Synchronous artwork I/O blocks the main process');
        }));
    }
    forbidden.push(context.mock.method(fs.promises, 'readFile', async () => {
        throw new Error('Artwork must not use an unbounded read');
    }));
    const [first, coalesced] = await Promise.all([
        service.getGameArtwork(game, 'cover'), service.getGameArtwork(game, 'cover')
    ]);
    assert.deepEqual(first.data, MINIMAL_JPEG);
    assert.equal(coalesced, first);
    assert.equal(opened, 1);
    assert.equal(closed, opened);
    assert.equal(await service.getGameArtwork(game, 'cover'), first);
    assert.equal(closed, opened);
    for (const method of forbidden) assert.equal(method.mock.callCount(), 0);
});

test('artwork reads stop at the inspected size when a file grows during the read', async (context) => {
    const service = freshArtworkService();
    const game = temporaryArtwork(context);
    const originalOpen = fs.promises.open;
    let readBytes = 0;
    let closed = false;
    context.mock.method(fs.promises, 'open', async (...args) => {
        const handle = await originalOpen(...args);
        const read = handle.read.bind(handle);
        const close = handle.close.bind(handle);
        handle.read = async (...readArgs) => {
            await fs.promises.appendFile(game.coverPath, Buffer.alloc(1024 * 1024));
            const result = await read(...readArgs);
            readBytes += result.bytesRead;
            return result;
        };
        handle.close = async () => { closed = true; await close(); };
        return handle;
    });
    assert.equal(await service.getGameArtwork(game, 'cover'), null);
    assert.equal(readBytes, MINIMAL_JPEG.length + 1);
    assert.equal(closed, true);
});

test('special artwork files are rejected before opening a potentially blocking handle', async (context) => {
    const service = freshArtworkService();
    const game = temporaryArtwork(context);
    context.mock.method(fs.promises, 'lstat', async () => ({
        isSymbolicLink: () => false, isFile: () => false, size: 10
    }));
    const opened = context.mock.method(fs.promises, 'open', async () => {
        throw new Error('Special files must not be opened');
    });
    assert.equal(await service.getGameArtwork(game, 'cover'), null);
    assert.equal(opened.mock.callCount(), 0);
});

test('rejected artwork redirects cancel their response bodies', async (context) => {
    const service = freshArtworkService();
    let canceled = 0;
    context.mock.method(console, 'warn', () => {});
    const requests = context.mock.method(globalThis, 'fetch', async () => ({
        status: 302,
        headers: new Headers(),
        body: { cancel: async () => { canceled += 1; } }
    }));
    assert.equal(await service.getGameArtwork({ platform: 'Steam', platformId: '100' }, 'cover'), null);
    assert.equal(requests.mock.callCount(), 2);
    assert.equal(canceled, requests.mock.callCount());
});

test('completed and oversized artwork responses release their reader locks', async (context) => {
    const service = freshArtworkService();
    const bodies = [];
    let oversized = false;
    context.mock.method(console, 'warn', () => {});
    context.mock.method(globalThis, 'fetch', async () => {
        const response = new Response(oversized ? Buffer.alloc(8 * 1024 * 1024 + 1) : MINIMAL_JPEG, {
            headers: { 'content-type': 'image/jpeg' }
        });
        bodies.push(response.body);
        return response;
    });
    const art = await service.getGameArtwork({ platform: 'Steam', platformId: '101' }, 'hero');
    assert.deepEqual(art.data, MINIMAL_JPEG);
    oversized = true;
    assert.equal(await service.getGameArtwork({ platform: 'Steam', platformId: '102' }, 'hero'), null);
    assert.ok(bodies.every(body => !body.locked));
});

test('tiny artwork entries are evicted by count as well as byte size', async (context) => {
    const service = freshArtworkService();
    const requests = context.mock.method(globalThis, 'fetch', async () => new Response(MINIMAL_JPEG, {
        headers: { 'content-type': 'image/jpeg' }
    }));
    const firstGame = { platform: 'Steam', platformId: '1000' };
    await service.getGameArtwork(firstGame, 'hero');
    await service.getGameArtwork(firstGame, 'hero');
    assert.equal(requests.mock.callCount(), 1);
    for (let index = 1; index <= 256; index += 1) {
        await service.getGameArtwork({ platform: 'Steam', platformId: String(1000 + index) }, 'hero');
    }
    await service.getGameArtwork(firstGame, 'hero');
    assert.equal(requests.mock.callCount(), 258);
});

test('an evicted metadata failure cannot evict its newer in-flight replacement', async (context) => {
    const service = freshArtworkService();
    let rejectFirst;
    let resolveReplacement;
    let firstGameRequests = 0;
    const jsonResponse = () => new Response('{}', { headers: { 'content-type': 'application/json' } });
    context.mock.method(console, 'warn', () => {});
    context.mock.method(globalThis, 'fetch', async (url) => {
        if (new URL(url).pathname === '/products/1000') {
            firstGameRequests += 1;
            if (firstGameRequests === 1) return new Promise((resolve, reject) => { rejectFirst = reject; });
            if (firstGameRequests === 2) return new Promise((resolve) => { resolveReplacement = resolve; });
        }
        return jsonResponse();
    });
    const game = { platform: 'GOG', platformId: '1000' };
    const first = service.getGameArtwork(game, 'cover');
    await Promise.all(Array.from({ length: 33 }, (_, index) => service.getGameArtwork({
        platform: 'GOG', platformId: String(1001 + index)
    }, 'cover')));
    const replacement = service.getGameArtwork(game, 'cover');
    await new Promise(resolve => { setImmediate(resolve); });
    rejectFirst(new Error('The old request failed after eviction'));
    await first;
    const coalesced = service.getGameArtwork(game, 'hero');
    await new Promise(resolve => { setImmediate(resolve); });
    resolveReplacement(jsonResponse());
    await Promise.all([replacement, coalesced]);
    assert.equal(firstGameRequests, 2);
});

test('Battle.net directory enumeration has a budget even when no entries are usable', (context) => {
    const service = freshArtworkService();
    let reads = 0;
    let closes = 0;
    context.mock.method(fs, 'opendirSync', () => ({
        readSync: () => {
            reads += 1;
            return { name: 'unrelated', isDirectory: () => false };
        },
        closeSync: () => { closes += 1; }
    }));
    assert.deepEqual(service.findBattleNetLocalArt('bounded-cache', ['GAME']), {
        coverPath: null, heroPath: null, artRoots: ['bounded-cache']
    });
    assert.equal(reads, 20000);
    assert.equal(closes, 1);
});
