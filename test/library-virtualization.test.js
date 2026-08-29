const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { calculateLibraryWindow } = require('../src/shared/libraryVirtualization');

test('library virtualization caps materialized cards while preserving total scroll extent', () => {
    const range = calculateLibraryWindow({
        itemCount: 20_000,
        columnCount: 5,
        rowStride: 260,
        viewportStart: 520_000,
        viewportSize: 780,
        maxRenderedItems: 120
    });

    assert.ok(range.startIndex > 0);
    assert.ok(range.endIndex < 20_000);
    assert.ok(range.endIndex - range.startIndex <= 120);
    assert.equal(
        range.topPadding + range.bottomPadding
            + (Math.ceil((range.endIndex - range.startIndex) / 5) * 260),
        range.totalRows * 260
    );
});

test('library virtualization clamps stale scroll offsets after filtering', () => {
    const range = calculateLibraryWindow({
        itemCount: 7,
        columnCount: 3,
        rowStride: 200,
        viewportStart: 100_000,
        viewportSize: 400
    });

    assert.equal(range.endIndex, 7);
    assert.equal(range.bottomPadding, 0);
    assert.ok(range.startIndex >= 0);
});

test('library page renders only the calculated window instead of mapping the full result set', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'src/renderer/js/libraryPage.js'),
        'utf8'
    );

    assert.match(source, /calculateLibraryWindow/);
    assert.match(source, /MAX_RENDERED_LIBRARY_ITEMS = 120/);
    assert.match(source, /visibleLibraryGames\.slice\(windowRange\.startIndex, windowRange\.endIndex\)/);
    assert.doesNotMatch(source, /replaceChildren\(\.\.\.visibleGames\.map\(createCard\)\)/);
    assert.match(source, /releaseRenderedArtwork\(grid\)/);
});
