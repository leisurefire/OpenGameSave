const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const {
    createCapabilityCacheKey,
    downloadResource,
    isWebDAVIntegrityError,
    pruneCapabilityCache,
    putConditionalResource,
    putImmutableResource,
    verifyRemoteResource,
    verifyUploadSource
} = require('../src/main/webdavClient');

function response(body, headers = {}) {
    return {
        body: Readable.from(body),
        headers: { get: name => headers[name.toLowerCase()] ?? null }
    };
}

test('immutable streaming PUTs send an explicit length and create-only condition', async () => {
    let captured;
    const client = {
        putFileContents: async (remotePath, data, options) => {
            captured = { remotePath, data, options };
            return true;
        }
    };
    const payload = Buffer.from('payload');
    assert.equal(await putImmutableResource(client, '/objects/object', payload, payload.length), true);
    assert.equal(captured.options.headers['Content-Length'], String(payload.length));
    assert.equal(captured.options.headers['If-None-Match'], '*');
    assert.equal(captured.options.overwrite, false);
    assert.equal(captured.options.signal instanceof AbortSignal, true);
});

test('current pointer publication uses the exact ETag as a compare-and-swap precondition', async () => {
    let captured;
    const client = {
        customRequest: async (remotePath, options) => {
            captured = { remotePath, options };
            return {};
        }
    };
    const payload = Buffer.from('{}');
    await putConditionalResource(client, '/current.json', payload, payload.length, '"revision-etag"');
    assert.equal(captured.options.headers['If-Match'], '"revision-etag"');
    assert.equal(captured.options.headers['Content-Length'], String(payload.length));
});

test('chunked downloads abort as soon as they exceed the snapshot size', async (context) => {
    const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-webdav-limit-'));
    context.after(() => fs.promises.rm(temporaryDirectory, { recursive: true, force: true }));
    const destinationPath = path.join(temporaryDirectory, 'object');
    const client = {
        customRequest: async () => response([Buffer.from('oversized')])
    };
    await assert.rejects(
        downloadResource(client, '/objects/object', destinationPath, 1),
        /exceeded its declared size/
    );
});

test('remote object hash mismatches are classified as repairable integrity failures', async () => {
    const payload = Buffer.from('altered');
    const client = {
        customRequest: async () => response([payload], { 'content-length': String(payload.length) })
    };
    await assert.rejects(
        verifyRemoteResource(client, '/objects/object', payload.length, '0'.repeat(64)),
        error => isWebDAVIntegrityError(error) && /hash verification failed/.test(error.message)
    );
});

test('object repair rejects a local source that changed after collection', async () => {
    const collected = Buffer.from('collected');
    const changed = Buffer.from('changed!!');
    const expectedHash = require('node:crypto').createHash('sha256').update(collected).digest('hex');

    await assert.rejects(
        verifyUploadSource(changed, collected.length, expectedHash),
        /local backup changed/
    );
});

test('the WebDAV capability cache expires old entries and stays bounded', () => {
    const now = 1_000_000;
    const cache = new Map([
        ['expired', now - (5 * 60 * 1000)],
        ...Array.from({ length: 40 }, (_, index) => [`active-${index}`, now - 1])
    ]);

    pruneCapabilityCache(cache, now);

    assert.equal(cache.has('expired'), false);
    assert.equal(cache.size, 32);
    assert.equal(cache.has('active-0'), false);
    assert.equal(cache.has('active-39'), true);
});

test('WebDAV capability cache entries are isolated by authentication identity', () => {
    const baseConfig = { url: 'https://dav.example.test', remotePath: '/backups' };
    const first = createCapabilityCacheKey({ ...baseConfig, username: 'first', password: 'secret' });
    const second = createCapabilityCacheKey({ ...baseConfig, username: 'second', password: 'secret' });
    const rotated = createCapabilityCacheKey({ ...baseConfig, username: 'first', password: 'rotated' });

    assert.notEqual(first, second);
    assert.notEqual(first, rotated);
    assert.doesNotMatch(first, /first|secret/);
});
