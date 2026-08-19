const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const catalog = require('../src/data/gameGuides.json');
const {
    GUIDE_CATALOG_METADATA_KEY,
    normalizeCatalog,
    validateGuideUrl
} = require('../src/main/services/guideService');

test('curated Overwatch guides use a bounded catalog of trusted HTTPS sources', () => {
    const normalized = normalizeCatalog(catalog);
    const overwatch = normalized.games.find(game => game.id === 'overwatch');
    assert.ok(overwatch);
    assert.equal(overwatch.platform_ids.Blizzard, 'Pro');
    assert.ok(overwatch.sources.some(source => source.url === 'https://overlab.cn/'));
    assert.ok(overwatch.sources.some(source => source.url.startsWith('https://ow.blizzard.cn/')));
    assert.ok(overwatch.sources.some(source => source.url.startsWith('https://liquipedia.net/overwatch/')));
    assert.equal(GUIDE_CATALOG_METADATA_KEY, 'game_guide_catalog');
    assert.throws(() => validateGuideUrl('http://overlab.cn/'), /not trusted/);
    assert.throws(() => validateGuideUrl('https://overlab.cn.example.com/'), /not trusted/);
});

test('about page and shipped notices disclose licenses for curated references', () => {
    const aboutHtml = fs.readFileSync(path.join(__dirname, '../src/renderer/about.html'), 'utf8');
    const notices = fs.readFileSync(path.join(__dirname, '../THIRD_PARTY_NOTICES.md'), 'utf8');

    assert.match(aboutHtml, /id="app-license-link"[^>]*>GPL-3\.0-only</);
    assert.match(aboutHtml, /id="about-notices"/);
    assert.match(aboutHtml, /https:\/\/overlab\.cn\/about\/creative-commons/);
    assert.match(aboutHtml, /https:\/\/liquipedia\.net\/commons\/Liquipedia:Copyrights/);
    assert.match(aboutHtml, /Steam Store artwork/);
    assert.match(notices, /CC BY-NC-SA 4\.0/);
    assert.match(notices, /CC BY-SA 3\.0/);
    assert.match(notices, /cdn\.akamai\.steamstatic\.com/);
    assert.match(notices, /ld5\.res\.netease\.com/);
    assert.match(notices, /does not redistribute|does not bundle/i);
});
