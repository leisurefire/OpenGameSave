const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const catalog = require('../src/data/gameGuides.json');
const {
    GUIDE_CATALOG_METADATA_KEY,
    createPcGamingWikiSource,
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
    assert.ok(overwatch.sources.every(source => source.verified_at === '2026-08-20'));
    assert.ok(overwatch.sources.every(source => source.trust_reason && source.trust_reason_zh_CN));
    assert.deepEqual(createPcGamingWikiSource(151795), {
        id: 'pcgamingwiki',
        name: 'PCGamingWiki',
        name_zh_CN: 'PCGamingWiki 技术百科',
        category: 'wiki',
        language: 'en',
        url: 'https://www.pcgamingwiki.com/wiki/index.php?curid=151795',
        description: 'Game-specific fixes, save locations, configuration details, known issues, and PC compatibility notes.',
        description_zh_CN: '面向该游戏的故障修复、存档位置、配置说明、已知问题与 PC 兼容性资料。',
        trust_reason: 'Matched by the stable PCGamingWiki page ID stored in the OpenGameSave database.',
        trust_reason_zh_CN: '通过 OpenGameSave 数据库保存的 PCGamingWiki 稳定页面 ID 精确匹配。',
        verified_at: '2026-08-20'
    });
    assert.equal(GUIDE_CATALOG_METADATA_KEY, 'game_guide_catalog');
    assert.throws(() => validateGuideUrl('http://overlab.cn/'), /not trusted/);
    assert.throws(() => validateGuideUrl('https://overlab.cn.example.com/'), /not trusted/);
    assert.throws(() => createPcGamingWikiSource('../1'), /Invalid wiki page id/);
});

test('guide UI searches the local game database and exposes source provenance', () => {
    const indexHtml = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
    const guidePage = fs.readFileSync(path.join(__dirname, '../src/renderer/js/guidesPage.js'), 'utf8');
    const guideIpc = fs.readFileSync(path.join(__dirname, '../src/main/ipc/guides.js'), 'utf8');
    const libraryIpc = fs.readFileSync(path.join(__dirname, '../src/main/ipc/library.js'), 'utf8');

    assert.match(indexHtml, /id="guides-game-results"/);
    assert.match(indexHtml, /id="guides-database-repo"/);
    assert.match(guidePage, /search-game-guides/);
    assert.match(guidePage, /get-game-guide/);
    assert.match(guideIpc, /ipcMain\.handle\('search-game-guides'/);
    assert.match(libraryIpc, /enrichLibraryGamesWithGuides/);
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
