import { showToast } from './toast.js';
import { getFilteredVirtualSelectedIds, getVirtualState } from './virtualTable.js';
import { renderIcon } from './icons.js';

window.api.receive('show-alert', (type, message, modalContent) => {
    showAlert(type, message, modalContent);
});

window.api.receive('open-import-modal', (gsmPath) => {
    showImportModal(gsmPath);
});

window.api.receive('update-progress', (progressId, progressTitle, percentage) => {
    updateProgress(progressId, progressTitle, percentage);
});

window.api.receive('menu-hidden', () => {
    window.activeMenuTrigger?.setAttribute('aria-expanded', 'false');
    window.activeMenuTrigger = null;
});

window.api.receive('app-update-state', (state) => {
    void applyAppUpdateState(state);
});

window.api.receive('collect-selected-wiki-ids', (requestId, tableId) => {
    const table = document.querySelector(`#${tableId}`);
    const tableBody = table?.querySelector('tbody');
    const wikiIds = getVirtualState(tableBody)
        ? getFilteredVirtualSelectedIds(tableBody)
        : Array.from(table ? table.querySelectorAll('.row-checkbox:checked') : [])
            .map(checkbox => checkbox.closest('tr')?.getAttribute('data-wiki-id')?.trim())
            .filter(Boolean);
    window.api.send('selected-wiki-ids-response', requestId, wikiIds);
});

document.addEventListener('DOMContentLoaded', () => {
    setupHomeActions();
    setupTitlebarMenus();
    setupAppUpdateButton();
});

async function getTitlebarMenuItems(menuName) {
    const item = async (key, icon, action, data) => ({
        label: await window.i18n.translate(key),
        icon,
        action,
        data
    });
    if (menuName === 'view') {
        return await Promise.all([
            item('main.library', 'library-big', 'navigate', 'library'),
            item('main.guides', 'book-open', 'navigate', 'guides'),
            item('main.saves', 'save', 'navigate', 'backup'),
            item('main.sync', 'cloud', 'navigate', 'sync'),
            item('main.collapse_sidebar', 'panel-left-close', 'toggle-sidebar'),
            item('main.view_account_ids', 'user-round-cog', 'view-account-ids')
        ]);
    }
    if (menuName === 'games') {
        return await Promise.all([
            item('main.import', 'download', 'import'),
            item('main.export', 'upload', 'export'),
            item('main.scan_full', 'scan-search', 'scan-full'),
            item('main.refresh_library', 'refresh-cw', 'refresh-library')
        ]);
    }
    return await Promise.all([
        item('settings.title', 'settings', 'settings'),
        item('about.title', 'info', 'about')
    ]);
}

function setupTitlebarMenus() {
    document.querySelectorAll('[data-titlebar-menu]').forEach(button => button.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (button === window.activeMenuTrigger) {
            window.api.send('hide-popup-menu');
            window.activeMenuTrigger = null;
            return;
        }
        const rect = button.getBoundingClientRect();
        window.api.send('show-popup-menu', {
            items: await getTitlebarMenuItems(button.dataset.titlebarMenu),
            x: rect.left,
            y: rect.bottom + 3,
            direction: 'down'
        });
        window.activeMenuTrigger = button;
    }));
}

async function applyAppUpdateState(state) {
    const updateButton = document.getElementById('app-update-download');
    const updateIcon = document.getElementById('app-update-download-icon');
    if (!updateButton || !updateIcon || !state) return;

    const canShow = state.canAutoUpdate === true && !!state.availableVersion &&
        ['available', 'downloading', 'downloaded', 'installing', 'error'].includes(state.status);
    updateButton.classList.toggle('hidden', !canShow);
    if (!canShow) return;

    const isBusy = ['downloading', 'downloaded', 'installing'].includes(state.status);
    const percent = Math.round(Math.min(100, Math.max(0, Number(state.percent) || 0)));
    const i18nKey = state.status === 'available'
        ? 'settings.app_update_download'
        : state.status === 'downloading'
            ? 'settings.app_update_downloading'
            : state.status === 'error'
                ? 'settings.app_update_retry'
                : 'settings.app_update_installing';
    const label = await window.i18n.translate(i18nKey, {
        version: state.availableVersion,
        percent
    });

    updateButton.disabled = isBusy;
    updateButton.dataset.state = state.status;
    updateButton.style.setProperty('--update-progress', `${percent}%`);
    updateButton.title = label;
    updateButton.setAttribute('aria-label', label);
    updateIcon.classList.toggle('is-spinning', isBusy);
    renderIcon(updateIcon, isBusy ? 'loader-circle' : 'download');
}

function setupAppUpdateButton() {
    const updateButton = document.getElementById('app-update-download');
    if (!updateButton) return;

    updateButton.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (updateButton.disabled) return;
        updateButton.disabled = true;
        try {
            const state = await window.api.invoke('download-app-update');
            await applyAppUpdateState(state);
            if (state?.status === 'error') {
                const errorKey = state.error === 'app-busy'
                    ? 'settings.app_update_busy'
                    : 'settings.app_update_failed';
                showAlert(state.error === 'app-busy' ? 'warning' : 'error', await window.i18n.translate(errorKey));
            }
        } catch (error) {
            console.error('Failed to download application update:', error);
            showAlert('error', await window.i18n.translate('settings.app_update_failed'));
            updateButton.disabled = false;
        }
    });

    window.api.invoke('get-app-update-state')
        .then(applyAppUpdateState)
        .catch((error) => console.error('Failed to load application update state:', error));
}

function setupHomeActions() {
    const optionsButton = document.getElementById('home-options-button');

    if (optionsButton) {
        optionsButton.addEventListener('click', (event) => {
            event.stopPropagation();
            window.api.send('open-settings-window');
        });
    }
}

export async function updateTranslations(container) {
    const translationTasks = [];

    container.querySelectorAll('[data-i18n]').forEach((el) => {
        const key = el.getAttribute('data-i18n');
        translationTasks.push(window.i18n.translate(key).then((translation) => {
            if (translation) {
                // Priority 1: Specifically marked span for dynamic content protection
                const textContentElement = el.querySelector('.text-content');
                if (textContentElement) {
                    textContentElement.innerText = translation;
                } else if (el.classList.contains('text-content')) {
                    // Priority 2: If the element itself is marked as text-content
                    el.innerText = translation;
                } else if (el.children.length === 0) {
                    // Only leaf elements can safely replace all of their text. Buttons
                    // with child nodes may contain Lucide icon containers, so assigning
                    // innerText to the button would remove those icons.
                    el.innerText = translation;
                }
            }
        }));
    });

    container.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
        const i18nKey = element.getAttribute('data-i18n-placeholder');
        translationTasks.push(window.i18n.translate(i18nKey).then((translation) => {
            element.setAttribute('placeholder', translation);
        }));
    });

    container.querySelectorAll('[data-i18n-title]').forEach((element) => {
        const i18nKey = element.getAttribute('data-i18n-title');
        translationTasks.push(window.i18n.translate(i18nKey).then((translation) => {
            if (translation) element.setAttribute('title', translation);
        }));
    });

    container.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
        const i18nKey = element.getAttribute('data-i18n-aria-label');
        translationTasks.push(window.i18n.translate(i18nKey).then((translation) => {
            if (translation) element.setAttribute('aria-label', translation);
        }));
    });

    await Promise.all(translationTasks);
}


export function showAlert(type, message, modalContent) {
    return showToast(type, message, modalContent);
}



// Standalone modal windows
export function showExportModal() {
    window.api.send('open-modal-window', 'export');
}

export function showImportModal(gsmPath = '') {
    window.api.send('open-modal-window', 'import', { gsmPath });
}

export function updateProgress(progressId, progressTitle, percentage) {
    const progressContainer = document.getElementById('progress-container');
    const safeProgressId = /^[A-Za-z0-9_-]{1,80}$/.test(progressId) ? progressId : null;
    if (!progressContainer || !safeProgressId) return;

    if (percentage === 'start') {
        const progressElement = document.createElement('div');
        progressElement.id = safeProgressId;
        progressElement.className = 'app-progress floating-surface animate-fadeIn';
        progressElement.innerHTML = `
            <div class="app-progress-header">
                <span class="progress-title"></span>
                <span class="progress-percentage">0%</span>
            </div>
            <div class="app-progress-track">
                <div class="progress-bar"></div>
            </div>
        `;
        progressElement.querySelector('.progress-title').textContent = progressTitle;
        progressContainer.appendChild(progressElement);
        return;
    } else if (percentage === 'end') {
        const progressElement = document.getElementById(safeProgressId);
        if (progressElement) progressElement.remove();
        return;
    }

    const progressElement = document.getElementById(safeProgressId);
    const progressBar = progressElement?.querySelector('.progress-bar');
    const progressPercentage = progressElement?.querySelector('.progress-percentage');
    const safePercentage = Math.min(100, Math.max(0, Number(percentage) || 0));
    if (progressBar) progressBar.style.width = `${safePercentage}%`;
    if (progressPercentage) progressPercentage.innerText = `${safePercentage}%`;
}

export function wrapNumberInput(input) {
    if (!input || input.type !== 'number' || input.dataset.wrapped) return;
    input.dataset.wrapped = 'true';

    const min = input.min !== '' ? parseInt(input.min, 10) : null;
    const max = input.max !== '' ? parseInt(input.max, 10) : null;

    const wrapper = document.createElement('div');
    wrapper.className = 'number-input-wrapper';

    for (const cls of [...input.classList]) {
        if (cls.startsWith('mb-') || cls.startsWith('mt-') || cls.startsWith('my-')) {
            wrapper.classList.add(cls);
            input.classList.remove(cls);
        }
    }

    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);
    input.classList.add('number-input-field');

    const controls = document.createElement('div');
    controls.className = 'number-input-controls';
    controls.innerHTML = `
        <button type="button" tabindex="-1" data-action="increment" class="number-input-stepper">
            <span data-lucide-icon="chevron-up" class="text-[10px]"></span>
        </button>
        <button type="button" tabindex="-1" data-action="decrement" class="number-input-stepper">
            <span data-lucide-icon="chevron-down" class="text-[10px]"></span>
        </button>
    `;
    wrapper.appendChild(controls);

    controls.querySelectorAll('button[data-action]').forEach(btn => {
        btn.onclick = () => {
            const current = parseInt(input.value, 10) || 0;
            let next = btn.dataset.action === 'increment' ? current + 1 : current - 1;
            if (min !== null && next < min) next = min;
            if (max !== null && next > max) next = max;
            input.value = next;
            input.dispatchEvent(new Event('input'));
        };
    });
}

export async function operationStartCheck(operation) {
    const status = await window.api.invoke('get-status');
    if (status.updating_app) {
        showAlert('warning', await window.i18n.translate('alert.wait_for_app_update'));
        return false;
    }
    const statusChecks = {
        'backup': { restoring: 'alert.wait_for_restore', scanning_full: 'alert.wait_for_scan_full', migrating: 'alert.wait_for_migrate', updating_db: 'alert.wait_for_updating_db', exporting: 'alert.wait_for_export', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup', updating_restore: 'alert.wait_for_updating_restore', syncing: 'alert.wait_for_sync' },
        'scan-full': { backuping: 'alert.wait_for_backup', restoring: 'alert.wait_for_restore', migrating: 'alert.wait_for_migrate', updating_db: 'alert.wait_for_updating_db', exporting: 'alert.wait_for_export', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup', syncing: 'alert.wait_for_sync' },
        'restore': { restoring: 'alert.wait_for_restore', backuping: 'alert.wait_for_backup', migrating: 'alert.wait_for_migrate', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup', updating_restore: 'alert.wait_for_updating_restore', syncing: 'alert.wait_for_sync' },
        'change-settings': { backuping: 'alert.wait_for_backup', restoring: 'alert.wait_for_restore', scanning_full: 'alert.wait_for_scan_full', migrating: 'alert.wait_for_migrate', updating_db: 'alert.wait_for_updating_db', exporting: 'alert.wait_for_export', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup', updating_restore: 'alert.wait_for_updating_restore', syncing: 'alert.wait_for_sync' },
        'save-custom': { backuping: 'alert.wait_for_backup', restoring: 'alert.wait_for_restore', scanning_full: 'alert.wait_for_scan_full', migrating: 'alert.wait_for_migrate', exporting: 'alert.wait_for_export', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup', syncing: 'alert.wait_for_sync' },
        'update-db': { updating_db: 'alert.wait_for_updating_db', backuping: 'alert.wait_for_backup', scanning_full: 'alert.wait_for_scan_full', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup', syncing: 'alert.wait_for_sync' },
        'export': { exporting: 'alert.wait_for_export', backuping: 'alert.wait_for_backup', scanning_full: 'alert.wait_for_scan_full', migrating: 'alert.wait_for_migrate', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup', updating_restore: 'alert.wait_for_updating_restore', syncing: 'alert.wait_for_sync' },
        'import': { importing: 'alert.wait_for_import', backuping: 'alert.wait_for_backup', restoring: 'alert.wait_for_restore', scanning_full: 'alert.wait_for_scan_full', migrating: 'alert.wait_for_migrate', exporting: 'alert.wait_for_export', updating_backup: 'alert.wait_for_updating_backup', updating_restore: 'alert.wait_for_updating_restore', syncing: 'alert.wait_for_sync' },
        'sync': { syncing: 'alert.wait_for_sync', backuping: 'alert.wait_for_backup', restoring: 'alert.wait_for_restore', scanning_full: 'alert.wait_for_scan_full', migrating: 'alert.wait_for_migrate', exporting: 'alert.wait_for_export', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup', updating_restore: 'alert.wait_for_updating_restore' }
    };

    const alerts = statusChecks[operation];
    for (const [key, message] of Object.entries(alerts)) {
        if (status[key]) {
            showAlert('warning', await window.i18n.translate(message));
            return false;
        }
    }
    return true;
}

// Global click listener to dismiss popup menu when clicking outside any trigger
document.addEventListener('click', (event) => {
    const isMenuTrigger = event.target.closest('.dropdown-menu-button')
        || event.target.closest('.library-card-manage')
        || event.target.closest('#home-options-button')
        || event.target.closest('[data-titlebar-menu]');
    if (!isMenuTrigger) {
        window.activeMenuTrigger = null;
        window.api.send('hide-popup-menu');
    }
});

export function autoResizeWindow() {
    requestAnimationFrame(() => {
        setTimeout(() => {
            const originalHeight = document.body.style.height;
            const originalOverflow = document.body.style.overflow;

            document.body.style.height = 'auto';
            document.body.style.overflow = 'visible';

            // Also remove constraints from modal panel or settings form if any
            let targetContent = document.querySelector('.settings-form') || document.querySelector('.modal-window-panel') || document.querySelector('.about-container');
            let originalTargetHeight, originalTargetOverflow;
            if (targetContent) {
                originalTargetHeight = targetContent.style.height;
                originalTargetOverflow = targetContent.style.overflow;
                targetContent.style.height = 'auto';
                targetContent.style.overflow = 'visible';
            }

            const height = document.documentElement.scrollHeight;

            document.body.style.height = originalHeight;
            document.body.style.overflow = originalOverflow;

            if (targetContent) {
                targetContent.style.height = originalTargetHeight;
                targetContent.style.overflow = originalTargetOverflow;
            }

            // In Windows, add a small buffer for the frame if needed, but setContentSize is inner.
            // But we add a small padding if it feels cramped.
            window.api.send('resize-current-modal-window', null, height);
        }, 50); // slight delay to allow rendering and i18n
    });
}
