import { showAlert, updateTranslations } from './utility.js';
import libraryVirtualization from '../../shared/libraryVirtualization.js';

const { calculateLibraryWindow } = libraryVirtualization;

const PLATFORM_BRAND_COLORS = Object.freeze({
    Steam: '#66c0f4',
    Epic: '#a8a8b3',
    GOG: '#b36cff',
    Blizzard: '#00aeff'
});
const ART_LOAD_CONCURRENCY = 2;
const MAX_RENDERED_LIBRARY_ITEMS = 120;

let libraryInitialized = false;
let libraryElements;
let games = [];
let iconMap = {};
let activePlatform = 'All';
let selectedGameId = null;
let currentView = 'grid';
let artObserver;
let activeArtLoads = 0;
let searchRenderFrame;
let countRenderId = 0;
let artRequestId = 0;
let visibleLibraryGames = [];
let libraryWindowFrame;
let measuredCardStride = 0;
let renderedWindowKey = '';
const pendingArtLoads = [];
const activeGameActions = new Set();

function getElements() {
    if (libraryElements) return libraryElements;
    libraryElements = {
        count: document.getElementById('library-count'),
        controls: document.getElementById('library-controls'),
        empty: document.getElementById('library-empty'),
        filters: document.getElementById('library-platform-filters'),
        grid: document.getElementById('library-grid'),
        hero: document.getElementById('library-hero'),
        heroFolder: document.getElementById('library-hero-folder'),
        heroGuide: document.getElementById('library-hero-guide'),
        heroImage: document.getElementById('library-hero-image'),
        heroPath: document.getElementById('library-hero-path'),
        heroPlatform: document.getElementById('library-hero-platform'),
        heroPlay: document.getElementById('library-hero-play'),
        heroTitle: document.getElementById('library-hero-title'),
        loading: document.getElementById('library-loading'),
        refresh: document.getElementById('library-refresh'),
        search: document.getElementById('library-search'),
        scroll: document.querySelector('.library-scroll')
    };
    return libraryElements;
}

function platformLabel(platform) {
    return platform === 'Blizzard' ? 'Battle.net' : platform;
}

function platformIconDataUrl(platform) {
    const svg = iconMap[platform];
    const color = PLATFORM_BRAND_COLORS[platform] || '#ffffff';
    return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replaceAll('currentColor', color))}` : '';
}

function appendPlatformBadge(container, platform, includeLabel = false) {
    container.replaceChildren();
    const accessibleLabel = platformLabel(platform);
    container.setAttribute('aria-label', accessibleLabel);
    container.title = accessibleLabel;
    const iconUrl = platformIconDataUrl(platform);
    if (iconUrl) {
        const image = document.createElement('img');
        image.src = iconUrl;
        image.alt = '';
        image.setAttribute('aria-hidden', 'true');
        container.appendChild(image);
    }
    if (includeLabel) {
        const label = document.createElement('span');
        label.textContent = platformLabel(platform);
        container.appendChild(label);
    }
}

async function translate(key, options) {
    return await window.i18n.translate(key, options);
}

async function runGameAction(game, action, button) {
    const actionKey = game ? `${action}:${game.id}` : '';
    if (!game || button?.disabled || activeGameActions.has(actionKey)) return;
    activeGameActions.add(actionKey);
    button?.setAttribute('disabled', '');
    try {
        await window.api.invoke(action, game.id);
    } catch (error) {
        console.error(`Library action ${action} failed:`, error);
        showAlert('error', await translate(
            action === 'launch-library-game' ? 'alert.game_launch_failed' : 'alert.open_install_directory_failed',
            { game: game.title }
        ));
    } finally {
        activeGameActions.delete(actionKey);
        button?.removeAttribute('disabled');
    }
}

function navigateToGuides(game) {
    if (game?.guide?.wikiPageId) {
        document.dispatchEvent(new CustomEvent('ogs:select-game-guide', {
            detail: { wikiPageId: game.guide.wikiPageId }
        }));
    }
    document.dispatchEvent(new CustomEvent('ogs:navigate-request', { detail: { route: 'guides' } }));
}

async function showGameMenu(game, button) {
    if (button === window.activeMenuTrigger) {
        window.api.send('hide-popup-menu');
        button.setAttribute('aria-expanded', 'false');
        window.activeMenuTrigger = null;
        return;
    }
    const menuItems = [
        {
            label: await translate('main.play'),
            icon: 'play',
            action: 'launch-library-game',
            data: { id: game.id, title: game.title }
        },
        {
            label: await translate('main.open_install_directory'),
            icon: 'folder-open',
            action: 'open-library-game-directory',
            data: { id: game.id, title: game.title }
        }
    ];
    if (game.guide) {
        menuItems.push({
            label: await translate('main.view_game_guides'),
            icon: 'book-open',
            action: 'open-game-guide',
            data: { wikiPageId: game.guide.wikiPageId }
        });
    }
    const rect = button.getBoundingClientRect();
    window.activeMenuTrigger?.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-expanded', 'true');
    window.activeMenuTrigger = button;
    window.api.send('show-popup-menu', {
        items: menuItems,
        x: rect.left,
        y: rect.bottom + 3,
        direction: 'down'
    });
}

function revokeImageObjectUrl(image) {
    const objectUrl = image?.dataset?.artObjectUrl;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (image?.dataset) delete image.dataset.artObjectUrl;
}

function releaseRenderedArtwork(container) {
    container?.querySelectorAll('img[data-art-object-url]').forEach((image) => {
        revokeImageObjectUrl(image);
        image.onload = null;
        image.onerror = null;
    });
}

async function executeArtLoad({ gameId, artType, image, expectedGameId }) {
    if (!image?.isConnected || (image.id === 'library-hero-image' && expectedGameId !== selectedGameId)) return;
    const requestId = String(++artRequestId);
    image.dataset.artRequestId = requestId;
    let createdObjectUrl = null;
    const isCurrentRequest = () => image.dataset.artRequestId === requestId;
    const revokeCreatedObjectUrl = () => {
        if (!createdObjectUrl) return;
        URL.revokeObjectURL(createdObjectUrl);
        if (image.dataset.artObjectUrl === createdObjectUrl) delete image.dataset.artObjectUrl;
        createdObjectUrl = null;
    };
    try {
        const asset = await window.api.invoke('get-library-game-art', gameId, artType);
        if (!asset || !image.isConnected || !isCurrentRequest()
            || (image.id === 'library-hero-image' && expectedGameId !== selectedGameId)) return;
        let imageUrl;
        if (typeof asset === 'string') {
            imageUrl = asset;
        } else if (/^image\/(?:jpeg|png|webp)$/.test(asset.mimeType)
            && (asset.data instanceof Uint8Array || asset.data instanceof ArrayBuffer)) {
            const bytes = asset.data instanceof Uint8Array ? asset.data : new Uint8Array(asset.data);
            imageUrl = URL.createObjectURL(new Blob([bytes], { type: asset.mimeType }));
            createdObjectUrl = imageUrl;
        } else {
            return;
        }
        revokeImageObjectUrl(image);
        if (imageUrl.startsWith('blob:')) image.dataset.artObjectUrl = imageUrl;
        const revealArtwork = () => {
            if (!isCurrentRequest()
                || (image.id === 'library-hero-image' && expectedGameId !== selectedGameId)) {
                revokeCreatedObjectUrl();
                return;
            }
            image.onload = null;
            image.onerror = null;
            image.classList.remove('hidden', 'is-pending');
            image.closest('.library-card')?.classList.add('has-art');
            revokeCreatedObjectUrl();
        };
        image.onload = revealArtwork;
        image.onerror = () => {
            if (!isCurrentRequest()) {
                revokeCreatedObjectUrl();
                return;
            }
            image.onload = null;
            image.onerror = null;
            revokeCreatedObjectUrl();
            image.removeAttribute('src');
            image.classList.add('is-pending');
        };
        image.src = imageUrl;
        if (image.complete && image.naturalWidth > 0) revealArtwork();
    } catch (error) {
        revokeCreatedObjectUrl();
        console.warn(`Could not load ${artType} artwork for ${gameId}:`, error);
    }
}

function pumpArtLoads() {
    while (activeArtLoads < ART_LOAD_CONCURRENCY && pendingArtLoads.length) {
        const request = pendingArtLoads.shift();
        activeArtLoads += 1;
        void executeArtLoad(request).finally(() => {
            activeArtLoads -= 1;
            request.resolve();
            pumpArtLoads();
        });
    }
}

function loadArt(gameId, artType, image, expectedGameId = gameId) {
    if (!image || image.dataset.artLoaded === `${gameId}:${artType}`) return Promise.resolve();
    image.dataset.artLoaded = `${gameId}:${artType}`;
    return new Promise((resolve) => {
        const request = { gameId, artType, image, expectedGameId, resolve };
        if (artType === 'hero') pendingArtLoads.unshift(request);
        else pendingArtLoads.push(request);
        pumpArtLoads();
    });
}

function discardDetachedArtLoads() {
    for (let index = pendingArtLoads.length - 1; index >= 0; index -= 1) {
        if (pendingArtLoads[index].image?.isConnected) continue;
        const [request] = pendingArtLoads.splice(index, 1);
        request.resolve();
    }
}

function createCard(game, position) {
    const card = document.createElement('article');
    card.className = 'library-card';
    card.tabIndex = 0;
    card.dataset.gameId = game.id;
    card.setAttribute('role', 'listitem');
    card.setAttribute('aria-label', `${game.title}, ${platformLabel(game.platform)}`);
    card.setAttribute('aria-posinset', String(position + 1));
    card.setAttribute('aria-setsize', String(visibleLibraryGames.length));
    card.classList.toggle('selected', game.id === selectedGameId);
    if (game.id === selectedGameId) card.setAttribute('aria-current', 'true');

    const artwork = document.createElement('div');
    artwork.className = 'library-card-art';
    const image = document.createElement('img');
    image.className = 'library-cover-image is-pending';
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.fetchPriority = 'low';
    artwork.appendChild(image);
    const monogram = document.createElement('span');
    monogram.className = 'library-card-monogram';
    monogram.textContent = game.title.slice(0, 1).toLocaleUpperCase();
    monogram.setAttribute('aria-hidden', 'true');
    artwork.appendChild(monogram);

    const overlay = document.createElement('div');
    overlay.className = 'library-card-overlay';
    const playButton = document.createElement('button');
    playButton.className = 'library-card-play';
    playButton.type = 'button';
    playButton.setAttribute('data-i18n-title', 'main.play');
    playButton.setAttribute('data-i18n-aria-label', 'main.play');
    playButton.setAttribute('data-lucide-icon', 'play');
    playButton.addEventListener('click', (event) => {
        event.stopPropagation();
        void runGameAction(game, 'launch-library-game', playButton);
    });
    overlay.appendChild(playButton);
    artwork.appendChild(overlay);

    const platformMark = document.createElement('div');
    platformMark.className = 'library-card-platform';
    appendPlatformBadge(platformMark, game.platform, false);
    artwork.appendChild(platformMark);

    if (game.guide) {
        const guideButton = document.createElement('button');
        guideButton.className = 'library-card-guide';
        guideButton.type = 'button';
        guideButton.setAttribute('data-i18n-title', 'main.view_game_guides');
        guideButton.setAttribute('data-i18n-aria-label', 'main.view_game_guides');
        guideButton.setAttribute('data-lucide-icon', 'book-open');
        guideButton.addEventListener('click', (event) => {
            event.stopPropagation();
            navigateToGuides(game);
        });
        artwork.appendChild(guideButton);
    }

    const manageButton = document.createElement('button');
    manageButton.className = 'library-card-manage';
    manageButton.type = 'button';
    manageButton.setAttribute('aria-haspopup', 'menu');
    manageButton.setAttribute('aria-expanded', 'false');
    manageButton.setAttribute('data-i18n-title', 'main.manage_game');
    manageButton.setAttribute('data-i18n-aria-label', 'main.manage_game');
    manageButton.setAttribute('data-lucide-icon', 'ellipsis-vertical');
    manageButton.addEventListener('click', (event) => {
        event.stopPropagation();
        void showGameMenu(game, manageButton);
    });
    const copy = document.createElement('div');
    copy.className = 'library-card-copy';
    const title = document.createElement('h3');
    title.textContent = game.title;
    const provider = document.createElement('p');
    provider.textContent = platformLabel(game.platform);
    copy.append(title, provider);
    card.append(artwork, copy, manageButton);

    card.addEventListener('click', () => selectGame(game));
    card.addEventListener('dblclick', () => void runGameAction(game, 'launch-library-game'));
    card.addEventListener('keydown', (event) => {
        if (event.target !== card) return;
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectGame(game);
        }
    });

    if (game.hasCover) {
        image.dataset.lazyGameId = game.id;
    }
    return card;
}

function filteredGames() {
    const query = getElements().search?.value.trim().toLocaleLowerCase() || '';
    return games.filter(game => (
        (activePlatform === 'All' || game.platform === activePlatform)
        && (!query || game.searchTitle.includes(query))
    ));
}

async function updateCount(visibleCount) {
    const count = getElements().count;
    const renderId = ++countRenderId;
    const label = await translate('main.library_game_count', {
        count: visibleCount,
        total: games.length
    });
    if (count && renderId === countRenderId) count.textContent = label;
}

function getLibraryColumnCount(grid) {
    if (currentView === 'list') return 1;
    const tracks = getComputedStyle(grid).gridTemplateColumns;
    return Math.max(1, tracks.split(' ').filter(Boolean).length);
}

function estimateCardStride(grid, columnCount) {
    if (measuredCardStride > 0) return measuredCardStride;
    const styles = getComputedStyle(grid);
    const rowGap = Number.parseFloat(styles.rowGap) || 0;
    if (currentView === 'list') return 58 + rowGap;
    const columnGap = Number.parseFloat(styles.columnGap) || 0;
    const availableWidth = Math.max(1, grid.clientWidth - columnGap * (columnCount - 1));
    return ((availableWidth / columnCount) * 1.5) + 38 + rowGap;
}

function getLibraryViewport(grid, scroll) {
    const gridRect = grid.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    return {
        viewportStart: Math.max(0, scrollRect.top - gridRect.top),
        viewportSize: scroll.clientHeight
    };
}

function observeRenderedArtwork(grid) {
    grid.querySelectorAll('[data-lazy-game-id]').forEach(image => artObserver?.observe(image));
}

function renderLibraryWindow(force = false) {
    libraryWindowFrame = null;
    const { grid, scroll } = getElements();
    if (!grid || !scroll || visibleLibraryGames.length === 0) return;
    const columnCount = getLibraryColumnCount(grid);
    const rowStride = estimateCardStride(grid, columnCount);
    const windowRange = calculateLibraryWindow({
        itemCount: visibleLibraryGames.length,
        columnCount,
        rowStride,
        ...getLibraryViewport(grid, scroll),
        maxRenderedItems: MAX_RENDERED_LIBRARY_ITEMS
    });
    const windowKey = `${currentView}:${columnCount}:${windowRange.startIndex}:${windowRange.endIndex}`;
    if (!force && renderedWindowKey === windowKey) return;

    artObserver?.disconnect();
    releaseRenderedArtwork(grid);
    const fragment = document.createDocumentFragment();
    visibleLibraryGames.slice(windowRange.startIndex, windowRange.endIndex).forEach((game, index) => {
        fragment.appendChild(createCard(game, windowRange.startIndex + index));
    });
    grid.style.paddingTop = `${windowRange.topPadding}px`;
    grid.style.paddingBottom = `${windowRange.bottomPadding}px`;
    grid.replaceChildren(fragment);
    renderedWindowKey = windowKey;
    discardDetachedArtLoads();
    observeRenderedArtwork(grid);

    const firstCard = grid.querySelector('.library-card');
    const rowGap = Number.parseFloat(getComputedStyle(grid).rowGap) || 0;
    const nextStride = firstCard ? firstCard.getBoundingClientRect().height + rowGap : rowStride;
    if (Number.isFinite(nextStride) && Math.abs(nextStride - rowStride) > 1) {
        measuredCardStride = nextStride;
        scheduleLibraryWindowRender(true);
    }
}

function scheduleLibraryWindowRender(force = false) {
    if (force) renderedWindowKey = '';
    if (libraryWindowFrame) return;
    libraryWindowFrame = requestAnimationFrame(() => renderLibraryWindow(force));
}

function clearRenderedGames() {
    const { grid } = getElements();
    artObserver?.disconnect();
    releaseRenderedArtwork(grid);
    grid.replaceChildren();
    grid.style.paddingTop = '';
    grid.style.paddingBottom = '';
    renderedWindowKey = '';
    measuredCardStride = 0;
    discardDetachedArtLoads();
}

function renderGames() {
    const elements = getElements();
    visibleLibraryGames = filteredGames();
    clearRenderedGames();
    elements.grid.classList.toggle('library-list', currentView === 'list');
    elements.empty.classList.toggle('hidden', visibleLibraryGames.length !== 0);
    void updateCount(visibleLibraryGames.length);

    if (!visibleLibraryGames.some(game => game.id === selectedGameId)) {
        selectedGameId = visibleLibraryGames[0]?.id || null;
    }
    const selected = visibleLibraryGames.find(game => game.id === selectedGameId);
    if (visibleLibraryGames.length > 0) renderLibraryWindow(true);
    if (selected) selectGame(selected);
    else elements.hero.classList.add('hidden');
}

function renderFilters() {
    const elements = getElements();
    const platforms = ['All', ...new Set(games.map(game => game.platform))];
    elements.filters.replaceChildren(...platforms.map((platform) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'library-filter-button';
        button.classList.toggle('active', platform === activePlatform);
        button.setAttribute('aria-pressed', String(platform === activePlatform));
        if (platform === 'All') {
            button.dataset.i18n = 'main.all_platforms';
            button.textContent = 'All';
        } else {
            appendPlatformBadge(button, platform);
        }
        button.addEventListener('click', () => {
            activePlatform = platform;
            renderFilters();
            renderGames();
            void updateTranslations(elements.filters);
        });
        return button;
    }));
    void updateTranslations(elements.filters);
}

function selectGame(game) {
    const elements = getElements();
    selectedGameId = game.id;
    elements.grid.querySelectorAll('.library-card').forEach(card => {
        const selected = card.dataset.gameId === game.id;
        card.classList.toggle('selected', selected);
        if (selected) card.setAttribute('aria-current', 'true');
        else card.removeAttribute('aria-current');
    });
    elements.hero.classList.remove('hidden');
    elements.heroTitle.textContent = game.title;
    elements.heroPath.textContent = game.installPath;
    appendPlatformBadge(elements.heroPlatform, game.platform);
    elements.heroPlay.onclick = () => void runGameAction(game, 'launch-library-game', elements.heroPlay);
    elements.heroFolder.onclick = () => void runGameAction(game, 'open-library-game-directory', elements.heroFolder);
    elements.heroGuide.classList.toggle('hidden', !game.guide);
    elements.heroGuide.onclick = game.guide ? () => navigateToGuides(game) : null;
    elements.heroImage.dataset.artRequestId = String(++artRequestId);
    elements.heroImage.onload = null;
    elements.heroImage.onerror = null;
    revokeImageObjectUrl(elements.heroImage);
    elements.heroImage.classList.add('hidden');
    elements.heroImage.removeAttribute('src');
    delete elements.heroImage.dataset.artLoaded;
    if (game.hasHero) void loadArt(game.id, 'hero', elements.heroImage, game.id);
    else if (game.hasCover) void loadArt(game.id, 'cover', elements.heroImage, game.id);
}

async function refreshLibrary() {
    const elements = getElements();
    document.getElementById('library')?.setAttribute('aria-busy', 'true');
    elements.loading.classList.remove('hidden');
    elements.empty.classList.add('hidden');
    elements.controls.classList.add('hidden');
    visibleLibraryGames = [];
    clearRenderedGames();
    elements.refresh.disabled = true;
    elements.refresh.querySelector('.lucide-icon')?.classList.add('is-spinning');
    try {
        const [libraryGames, platforms] = await Promise.all([
            window.api.invoke('get-library-games'),
            window.api.invoke('get-icon-map')
        ]);
        games = Array.isArray(libraryGames) ? libraryGames.map(game => ({
            ...game,
            searchTitle: game.title.toLocaleLowerCase()
        })) : [];
        iconMap = platforms || {};
        if (!games.some(game => game.id === selectedGameId)) selectedGameId = games[0]?.id || null;
        renderFilters();
        renderGames();
        elements.controls.classList.toggle('hidden', games.length === 0);
    } catch (error) {
        console.error('Library scan failed:', error);
        games = [];
        renderGames();
        showAlert('error', await translate('alert.library_scan_failed'));
    } finally {
        document.getElementById('library')?.setAttribute('aria-busy', 'false');
        elements.loading.classList.add('hidden');
        elements.refresh.disabled = false;
        elements.refresh.querySelector('.lucide-icon')?.classList.remove('is-spinning');
    }
}

function initializeLibrary() {
    if (libraryInitialized) return;
    libraryInitialized = true;
    const elements = getElements();
    artObserver = new IntersectionObserver((entries) => {
        entries.filter(entry => entry.isIntersecting).forEach((entry) => {
            artObserver.unobserve(entry.target);
            void loadArt(entry.target.dataset.lazyGameId, 'cover', entry.target);
        });
    }, { root: document.querySelector('.library-scroll'), rootMargin: '200px' });

    elements.scroll?.addEventListener('scroll', () => scheduleLibraryWindowRender(), { passive: true });
    if (typeof ResizeObserver === 'function' && elements.scroll) {
        const resizeObserver = new ResizeObserver(() => {
            measuredCardStride = 0;
            scheduleLibraryWindowRender(true);
        });
        resizeObserver.observe(elements.scroll);
    }

    elements.search?.addEventListener('input', () => {
        if (searchRenderFrame) cancelAnimationFrame(searchRenderFrame);
        searchRenderFrame = requestAnimationFrame(() => {
            searchRenderFrame = null;
            renderGames();
        });
    });
    elements.refresh?.addEventListener('click', () => void refreshLibrary());
    document.querySelectorAll('[data-library-view]').forEach(button => button.addEventListener('click', () => {
        currentView = button.dataset.libraryView;
        document.querySelectorAll('[data-library-view]').forEach((option) => {
            const selected = option === button;
            option.classList.toggle('active', selected);
            option.setAttribute('aria-pressed', String(selected));
        });
        renderGames();
    }));
    window.api.receive('apply-language', () => {
        renderFilters();
        void updateCount(filteredGames().length);
    });
    void refreshLibrary();
}

initializeLibrary();
