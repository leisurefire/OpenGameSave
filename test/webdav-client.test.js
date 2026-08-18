const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const {
    downloadResource,
    putConditionalResource,
    putImmutableResource
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
