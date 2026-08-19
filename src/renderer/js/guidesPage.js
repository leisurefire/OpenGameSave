import { showAlert, updateTranslations } from './utility.js';

let initialized = false;
let guideGame = null;
let language = 'en_US';
let activeCategory = 'all';

const categoryKeys = Object.freeze({
    all: 'main.all_sources',
    official: 'main.guide_category_official',
    wiki: 'main.guide_category_wiki',
    esports: 'main.guide_category_esports'
});

function localize(source, field) {
    return language === 'zh_CN' ? source[`${field}_zh_CN`] || source[field] : source[field];
}

function getVisibleSources() {
    const query = document.getElementById('guides-search')?.value.trim().toLocaleLowerCase() || '';
    return (guideGame?.sources || []).filter(source => {
        if (activeCategory !== 'all' && source.category !== activeCategory) return false;
        const searchable = `${localize(source, 'name')} ${localize(source, 'description')}`.toLocaleLowerCase();
        return !query || searchable.includes(query);
    });
}

async function openSource(source) {
    try {
        await window.api.invoke('open-url', source.url);
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
    trusted.setAttribute('data-i18n-title', 'main.trusted_source');
    trusted.setAttribute('data-lucide-icon', 'shield-check');
    header.append(category, trusted);

    const title = document.createElement('h3');
    title.textContent = localize(source, 'name');
    const description = document.createElement('p');
    description.textContent = localize(source, 'description');

    const footer = document.createElement('div');
    footer.className = 'guide-source-card-footer';
    const host = document.createElement('span');
    host.textContent = new URL(source.url).hostname;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'guide-open-button';
    open.setAttribute('data-i18n-title', 'main.open_guide');
    open.setAttribute('data-i18n-aria-label', 'main.open_guide');
    open.setAttribute('data-lucide-icon', 'external-link');
    open.addEventListener('click', (event) => {
        event.stopPropagation();
        void openSource(source);
    });
    footer.append(host, open);
    card.append(header, title, description, footer);
    card.addEventListener('click', () => void openSource(source));
    card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') void openSource(source);
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
        guideGame = catalog?.games?.find(game => game.id === 'overwatch') || catalog?.games?.[0] || null;
        renderCategoryFilters();
        renderSources();
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
    document.getElementById('guides-search')?.addEventListener('input', renderSources);
    window.api.receive('apply-language', () => void loadGuides());
    void loadGuides();
}

initializeGuides();
