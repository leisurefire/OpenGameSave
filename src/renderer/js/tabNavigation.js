const ROUTES = new Set(['library', 'guides', 'backup', 'restore', 'sync']);

/**
 * @typedef {object} RendererApi
 * @property {(channel: string, callback: (value: unknown) => void) => () => void} receive
 * @property {(channel: string) => Promise<{ visibleSidebarItems?: unknown }>} invoke
 */

const rendererApi = /** @type {RendererApi} */ (
    (/** @type {Window & { api: unknown }} */ (/** @type {unknown} */ (window))).api
);

function getSidebarRoute(route) {
    return route === 'backup' || route === 'restore' ? 'backup' : route;
}

export function initializeTabs() {
    const sections = [...document.querySelectorAll('#main-tab-content > section[id]')]
        .filter(section => ROUTES.has(section.id));
    const navigationButtons = [.../** @type {NodeListOf<HTMLButtonElement>} */ (
        document.querySelectorAll('button[data-nav-target]')
    )];
    const saveViewButtons = [.../** @type {NodeListOf<HTMLButtonElement>} */ (
        document.querySelectorAll('button[data-save-target]')
    )];
    const backButton = /** @type {HTMLButtonElement | null} */ (document.getElementById('nav-back'));
    const forwardButton = /** @type {HTMLButtonElement | null} */ (document.getElementById('nav-forward'));
    const sidebarToggle = /** @type {HTMLButtonElement | null} */ (document.getElementById('sidebar-toggle'));
    if (sections.length === 0) return;

    const applySidebarVisibility = (visibleItems) => {
        const normalizedItems = Array.isArray(visibleItems)
            ? new Set(visibleItems)
            : new Set(navigationButtons.map(button => button.dataset.navTarget));
        navigationButtons.forEach((button) => {
            button.classList.toggle('hidden', !normalizedItems.has(button.dataset.navTarget));
        });
    };

    rendererApi.receive('sidebar-visibility-changed', applySidebarVisibility);
    rendererApi.invoke('get-settings')
        .then(settings => applySidebarVisibility(settings?.visibleSidebarItems))
        .catch(error => console.error('Failed to load sidebar visibility:', error));

    let history = ['library'];
    let historyIndex = 0;
    let currentRoute = '';

    const updateHistoryButtons = () => {
        if (backButton) backButton.disabled = historyIndex <= 0;
        if (forwardButton) forwardButton.disabled = historyIndex >= history.length - 1;
    };

    const showRoute = (requestedRoute, { record = true } = {}) => {
        const route = ROUTES.has(requestedRoute) ? requestedRoute : 'library';
        if (route === currentRoute) return;
        currentRoute = route;

        sections.forEach((section) => {
            const active = section.id === route;
            section.classList.toggle('hidden', !active);
            section.setAttribute('aria-hidden', (!active).toString());
        });

        const sidebarRoute = getSidebarRoute(route);
        navigationButtons.forEach((button) => {
            const active = button.dataset.navTarget === sidebarRoute;
            button.classList.toggle('tab-active', active);
            button.classList.toggle('opacity-100', active);
            button.classList.toggle('opacity-60', !active);
            button.setAttribute('aria-current', active ? 'page' : 'false');
        });
        saveViewButtons.forEach((button) => {
            const active = button.dataset.saveTarget === route;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', active.toString());
        });

        if (record) {
            history = history.slice(0, historyIndex + 1);
            history.push(route);
            historyIndex = history.length - 1;
        }
        updateHistoryButtons();
        document.dispatchEvent(new CustomEvent('ogs:navigate', { detail: { route } }));
    };

    navigationButtons.forEach(button => button.addEventListener('click', () => {
        showRoute(button.dataset.navTarget);
    }));
    saveViewButtons.forEach(button => button.addEventListener('click', () => {
        showRoute(button.dataset.saveTarget);
    }));
    document.addEventListener('ogs:navigate-request', (event) => {
        const navigationEvent = /** @type {CustomEvent} */ (event);
        showRoute(navigationEvent.detail?.route);
    });

    backButton?.addEventListener('click', () => {
        if (historyIndex <= 0) return;
        historyIndex -= 1;
        showRoute(history[historyIndex], { record: false });
    });
    forwardButton?.addEventListener('click', () => {
        if (historyIndex >= history.length - 1) return;
        historyIndex += 1;
        showRoute(history[historyIndex], { record: false });
    });

    document.addEventListener('keydown', (event) => {
        if (!event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === 'ArrowLeft') backButton?.click();
        if (event.key === 'ArrowRight') forwardButton?.click();
    });

    const setSidebarCollapsed = (collapsed) => {
        document.body.classList.toggle('sidebar-collapsed', collapsed);
        sidebarToggle?.setAttribute('aria-pressed', collapsed.toString());
        const labelKey = collapsed ? 'main.expand_sidebar' : 'main.collapse_sidebar';
        sidebarToggle?.setAttribute('data-i18n-title', labelKey);
        sidebarToggle?.setAttribute('data-i18n-aria-label', labelKey);
        document.dispatchEvent(new CustomEvent('ogs:update-translations'));
        localStorage.setItem('ogs-sidebar-collapsed', collapsed.toString());
    };
    sidebarToggle?.addEventListener('click', () => {
        setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
    });
    setSidebarCollapsed(localStorage.getItem('ogs-sidebar-collapsed') === 'true');

    showRoute('library', { record: false });
}
