import { showAlert, updateTranslations } from './utility.js';

const PCGAMINGWIKI_API_REPOSITORY = 'https://github.com/PCGamingWiki/api';
const categoryKeys = Object.freeze({
    all: 'main.all_sources',
    official: 'main.guide_category_official',
    wiki: 'main.guide_category_wiki',
    esports: 'main.guide_category_esports'
});

let initialized = false;
let guideGame = null;
let catalogGames = [];
let language = 'en_US';
let activeCategory = 'all';
let searchTimer = null;
let searchRequestId = 0;

function localize(item, field) {
    return language === 'zh_CN' ? item?.[`${field}_zh_CN`] || item?.[field] : item?.[field];
}

function getVisibleSources() {
    return (guideGame?.sources || []).filter(source => (
        activeCategory === 'all' || source.category === activeCategory
    ));
}

async function openUrl(url) {
    try {
        await window.api.invoke('open-url', url);
    } catch (error) {
        console.error('Could not open guide source:', error);
        showAlert('error', await window.i18n.translate('alert.guide_open_failed'));
    }
}

function createSourceCard(source) {
    const card = document.createElement('article');
    card.className = 'guide-source-card';
    card.tabIndex = 0;

    const header = document.createElement('div');
    header.className = 'guide-source-card-header';
    const category = document.createElement('span');
    category.className = `guide-source-category category-${source.category}`;
    category.dataset.i18n = categoryKeys[source.category] || categoryKeys.wiki;
    category.textContent = source.category;
    const trusted = document.createElement('span');
    trusted.className = 'guide-trusted-mark';
    trusted.title = localize(source, 'trust_reason') || '';
    trusted.setAttribute('aria-label', trusted.title);
    trusted.setAttribute('data-lucide-icon', 'shield-check');
    header.append(category, trusted);

    const title = document.createElement('h3');
    title.textContent = localize(source, 'name');
    const description = document.createElement('p');
    description.textContent = localize(source, 'description');

    const footer = document.createElement('div');
    footer.className = 'guide-source-card-footer';
    const metadata = document.createElement('div');
    metadata.className = 'guide-source-metadata';
    const host = document.createElement('span');
    host.textContent = new URL(source.url).hostname;
    metadata.appendChild(host);
    if (source.verified_at) {
        const verified = document.createElement('span');
        verified.className = 'guide-source-verified';
        window.i18n.translate('main.guide_verified_at', { date: source.verified_at })
            .then(label => { verified.textContent = label; });
        metadata.appendChild(verified);
    }
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'guide-open-button';
    open.setAttribute('data-i18n-title', 'main.open_guide');
    open.setAttribute('data-i18n-aria-label', 'main.open_guide');
    open.setAttribute('data-lucide-icon', 'external-link');
    open.addEventListener('click', (event) => {
        event.stopPropagation();
        void openUrl(source.url);
    });
    footer.append(metadata, open);
    card.append(header, title, description, footer);
    card.addEventListener('click', () => void openUrl(source.url));
    card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') void openUrl(source.url);
    });
    return card;
}

function renderSources() {
    const grid = document.getElementById('guides-source-grid');
    const empty = document.getElementById('guides-empty');
    const count = document.getElementById('guides-source-count');
    const sources = getVisibleSources();
    grid.replaceChildren(...sources.map(createSourceCard));
    empty.classList.toggle('hidden', sources.length !== 0);
    window.i18n.translate('main.guide_source_count', {
        count: sources.length,
        total: guideGame?.sources?.length || 0
    }).then(label => { count.textContent = label; });
    void updateTranslations(grid);
}

function renderCategoryFilters() {
    const filters = document.getElementById('guides-category-filters');
    const categories = ['all', ...new Set((guideGame?.sources || []).map(source => source.category))];
    filters.replaceChildren(...categories.map((categoryId) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'library-filter-button';
        button.classList.toggle('active', activeCategory === categoryId);
        button.dataset.i18n = categoryKeys[categoryId] || categoryKeys.wiki;
        button.textContent = categoryId;
        button.addEventListener('click', () => {
            activeCategory = categoryId;
            renderCategoryFilters();
            renderSources();
        });
        return button;
    }));
    void updateTranslations(filters);
}

function gameMonogram(gameTitle) {
    const words = String(gameTitle || '').split(/\s+/).filter(Boolean);
    return words.slice(0, 2).map(word => word[0]).join('').toLocaleUpperCase().slice(0, 3) || 'G';
}

function renderHero() {
    const gameTitle = localize(guideGame, 'title') || guideGame?.title || '';
    document.getElementById('guides-game-title').textContent = gameTitle;
    document.getElementById('guides-hero-mark').textContent = gameMonogram(guideGame?.title);
    window.i18n.translate('main.guide_for_game_title', { game: gameTitle })
        .then(label => { document.getElementById('guides-hero-title').textContent = label; });
    window.i18n.translate('main.guide_for_game_description')
        .then(label => { document.getElementById('guides-hero-description').textContent = label; });
}

function selectGuideGame(game) {
    if (!game) return;
    guideGame = game;
    activeCategory = 'all';
    renderHero();
    renderCategoryFilters();
    renderSources();
}

function hideSearchResults() {
    document.getElementById('guides-game-results')?.classList.add('hidden');
}

function createGameResult(game) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'guide-game-result';
    const copy = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = localize(game, 'title') || game.title;
    const source = document.createElement('small');
    source.dataset.i18n = game.sources?.length > 1
        ? 'main.guide_result_pcgw_curated'
        : 'main.guide_result_pcgw';
    source.textContent = game.sources?.length > 1 ? 'PCGamingWiki + curated' : 'PCGamingWiki';
    copy.append(title, source);
    const icon = document.createElement('span');
    icon.setAttribute('data-lucide-icon', 'chevron-right');
    button.append(copy, icon);
    button.addEventListener('click', () => {
        selectGuideGame(game);
        document.getElementById('guides-search').value = localize(game, 'title') || game.title;
        hideSearchResults();
    });
    return button;
}

async function renderSearchResults(games, query, requestId) {
    if (requestId !== searchRequestId) return;
    const results = document.getElementById('guides-game-results');
    results.replaceChildren();
    if (games.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'guide-game-results-empty';
        empty.textContent = await window.i18n.translate('main.no_guide_games_found', { query });
        results.appendChild(empty);
    } else {
        results.append(...games.map(createGameResult));
    }
    results.classList.remove('hidden');
    void updateTranslations(results);
}

function searchGames() {
    clearTimeout(searchTimer);
    const query = document.getElementById('guides-search')?.value.trim() || '';
    if (!query) {
        hideSearchResults();
        return;
    }
    const requestId = ++searchRequestId;
    searchTimer = setTimeout(async () => {
        try {
            const games = await window.api.invoke('search-game-guides', query);
            await renderSearchResults(Array.isArray(games) ? games : [], query, requestId);
        } catch (error) {
            console.error('Could not search game guides:', error);
        }
    }, 180);
}

async function selectGuideByWikiId(wikiPageId) {
    try {
        const game = await window.api.invoke('get-game-guide', wikiPageId);
        if (game) {
            selectGuideGame(game);
            document.getElementById('guides-search').value = localize(game, 'title') || game.title;
        }
    } catch (error) {
        console.error('Could not select game guide:', error);
        showAlert('error', await window.i18n.translate('alert.guide_catalog_failed'));
    }
}

async function loadGuides() {
    const loading = document.getElementById('guides-loading');
    const content = document.getElementById('guides-content');
    loading.classList.remove('hidden');
    content.classList.add('hidden');
    try {
        const [catalog, settings] = await Promise.all([
            window.api.invoke('get-game-guide-catalog'),
            window.api.invoke('get-settings')
        ]);
        language = settings?.language || 'en_US';
        catalogGames = Array.isArray(catalog?.games) ? catalog.games : [];
        const selectedWikiId = guideGame?.wiki_page_id;
        guideGame = catalogGames.find(game => game.wiki_page_id === selectedWikiId)
            || catalogGames.find(game => game.id === guideGame?.id)
            || catalogGames[0]
            || null;
        if (guideGame) selectGuideGame(guideGame);
        content.classList.remove('hidden');
    } catch (error) {
        console.error('Could not load game guides:', error);
        showAlert('error', await window.i18n.translate('alert.guide_catalog_failed'));
    } finally {
        loading.classList.add('hidden');
    }
}

function initializeGuides() {
    if (initialized) return;
    initialized = true;
    document.getElementById('guides-search')?.addEventListener('input', searchGames);
    document.getElementById('guides-database-repo')?.addEventListener('click', () => (
        void openUrl(PCGAMINGWIKI_API_REPOSITORY)
    ));
    document.addEventListener('click', (event) => {
        if (!event.target.closest('.guides-game-search')) hideSearchResults();
    });
    document.addEventListener('ogs:select-game-guide', (event) => {
        const selectionEvent = /** @type {CustomEvent} */ (event);
        if (selectionEvent.detail?.wikiPageId) void selectGuideByWikiId(selectionEvent.detail.wikiPageId);
    });
    window.api.receive('apply-language', () => void loadGuides());
    void loadGuides();
}

initializeGuides();
