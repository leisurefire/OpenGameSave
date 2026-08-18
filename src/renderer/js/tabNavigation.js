function showTab(tab, tabElements, options) {
    tabElements.filter(item => item.triggerEl && item.targetEl).forEach((item) => {
        const isActive = item.id === tab.id;
        item.triggerEl.setAttribute('aria-selected', isActive.toString());
        item.triggerEl.tabIndex = isActive ? 0 : -1;
        item.targetEl.setAttribute('aria-hidden', (!isActive).toString());
        item.triggerEl.classList.toggle('tab-active', isActive);
        item.triggerEl.classList.toggle('opacity-100', isActive);
        item.triggerEl.classList.toggle('opacity-60', !isActive);
        item.triggerEl.classList.toggle('hover:opacity-100', !isActive);
        item.targetEl.classList.toggle('hidden', !isActive);
    });
    if (typeof options.onShow === 'function') options.onShow(tab);
}

export function initializeTabs() {
    const tabsElement = document.getElementById('main-tab');
    const tabElements = [
        { id: 'backup', triggerEl: document.querySelector('#backup-tab'), targetEl: document.querySelector('#backup') },
        { id: 'restore', triggerEl: document.querySelector('#restore-tab'), targetEl: document.querySelector('#restore') },
        { id: 'sync', triggerEl: document.querySelector('#sync-tab'), targetEl: document.querySelector('#sync') }
    ];
    const options = {
        defaultTabId: 'backup',
        activeClasses: 'tab-active opacity-100',
        inactiveClasses: 'opacity-60 hover:opacity-100'
    };
    if (!tabsElement) return;

    const defaultTab = tabElements.find(tab => tab.id === options.defaultTabId);
    if (defaultTab) showTab(defaultTab, tabElements, options);
    tabElements.filter(tab => tab.triggerEl && tab.targetEl).forEach((tab) => {
        tab.triggerEl.addEventListener('click', () => {
            const contentElement = document.getElementById(`${tab.id}-content`);
            contentElement?.classList.remove('animate-fadeInShift', 'animate-fadeOut');
            showTab(tab, tabElements, options);
        });
    });
}
