import { showToast } from './toast.js';

window.api.receive('show-alert', (type, message, modalContent) => {
    showAlert(type, message, modalContent);
});

window.api.receive('open-export-modal', () => {
    showExportModal();
});

window.api.receive('open-import-modal', (gsmPath) => {
    showImportModal(gsmPath);
});

window.api.receive('update-progress', (progressId, progressTitle, percentage) => {
    updateProgress(progressId, progressTitle, percentage);
});

window.api.receive('view_account_ids', () => {
    showAccountModal();
});

window.api.receive('menu-hidden', () => {
    window.activeMenuTrigger = null;
});

window.api.receive('collect-selected-wiki-ids', (requestId, tableId) => {
    const table = document.querySelector(`#${tableId}`);
    const selectedRows = table ? table.querySelectorAll('.row-checkbox:checked') : [];
    const wikiIds = Array.from(selectedRows)
        .map(checkbox => checkbox.closest('tr')?.getAttribute('data-wiki-id')?.trim())
        .filter(Boolean);
    window.api.send('selected-wiki-ids-response', requestId, wikiIds);
});

document.addEventListener('DOMContentLoaded', () => {
    setupHomeActions();
});

function setupHomeActions() {
    const optionsButton = document.getElementById('home-options-button');
    const importButton = document.getElementById('home-import-button');
    const exportButton = document.getElementById('home-export-button');

    if (optionsButton) {
        optionsButton.addEventListener('click', async (event) => {
            event.stopPropagation();

            if (optionsButton === window.activeMenuTrigger) {
                window.api.send('hide-popup-menu');
                window.activeMenuTrigger = null;
                return;
            }

            const menuItems = [
                {
                    label: await window.i18n.translate('settings.title'),
                    icon: 'fa-solid fa-gear',
                    action: 'settings'
                },
                {
                    label: await window.i18n.translate('main.view_account_ids'),
                    icon: 'fa-solid fa-user-tag',
                    action: 'view-account-ids'
                },
                {
                    label: await window.i18n.translate('main.scan_full'),
                    icon: 'fa-solid fa-magnifying-glass-plus',
                    action: 'scan-full'
                },
                {
                    label: await window.i18n.translate('about.title'),
                    icon: 'fa-solid fa-circle-info',
                    action: 'about'
                }
            ];

            const rect = optionsButton.getBoundingClientRect();
            window.api.send('show-popup-menu', {
                items: menuItems,
                x: rect.right - 180, // Align right edge (MENU_WIDTH is 180)
                y: rect.bottom + 8
            });
            window.activeMenuTrigger = optionsButton;
        });
    }

    if (importButton) {
        importButton.addEventListener('click', () => showImportModal(''));
    }

    if (exportButton) {
        exportButton.addEventListener('click', () => showExportModal());
    }
}

export async function updateTranslations(container) {
    const translationTasks = [];

    container.querySelectorAll("[data-i18n]").forEach((el) => {
        const key = el.getAttribute("data-i18n");
        translationTasks.push(window.i18n.translate(key).then((translation) => {
            if (translation) {
                // Priority 1: Specifically marked span for dynamic content protection
                const textContentElement = el.querySelector('.text-content');
                if (textContentElement) {
                    textContentElement.innerText = translation;
                }
                // Priority 2: If the element itself is marked as text-content
                else if (el.classList.contains('text-content')) {
                    el.innerText = translation;
                }
                // Priority 3: Default behavior for buttons and simple containers without children
                else if (el.children.length === 0 || (el.tagName === 'BUTTON' && !el.querySelector('i'))) {
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

    await Promise.all(translationTasks);
}


export function showAlert(type, message, modalContent) {
    return showToast(type, message, modalContent);
}



// Standalone modal windows
function showExportModal() {
    window.api.send('open-modal-window', 'export');
}

function showImportModal(gsmPath = '') {
    window.api.send('open-modal-window', 'import', { gsmPath });
}

export function updateProgress(progressId, progressTitle, percentage) {
    const progressContainer = document.getElementById('progress-container');

    if (percentage === 'start') {
        const progressElement = document.createElement('div');
        progressElement.id = progressId;
        progressElement.className = "ml-auto p-4 mb-2 rounded-xl border floating-surface animate-fadeIn w-72 shadow-2xl";
        progressElement.innerHTML = `
            <div class="flex justify-between mb-2 text-xs font-black uppercase tracking-widest text-xbox-green">
                <span>${progressTitle}</span>
                <span id="${progressId}-percentage">0%</span>
            </div>
            <div class="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                <div id="${progressId}-bar" class="bg-xbox-green w-0 h-full transition-all duration-300 shadow-[0_0_10px_rgba(16,124,16,0.5)]"></div>
            </div>
        `;
        progressContainer.appendChild(progressElement);
        return;
    } else if (percentage === 'end') {
        const progressElement = document.getElementById(progressId);
        if (progressElement) progressElement.remove();
        return;
    }

    const progressBar = document.getElementById(`${progressId}-bar`);
    const progressPercentage = document.getElementById(`${progressId}-percentage`);
    if (progressBar) progressBar.style.width = `${percentage}%`;
    if (progressPercentage) progressPercentage.innerText = `${percentage}%`;
}

function showAccountModal() {
    window.api.send('open-modal-window', 'account');
}


export function wrapNumberInput(input) {
    if (!input || input.type !== 'number' || input.dataset.wrapped) return;
    input.dataset.wrapped = 'true';

    const min = input.min !== '' ? parseInt(input.min, 10) : null;
    const max = input.max !== '' ? parseInt(input.max, 10) : null;

    const wrapper = document.createElement('div');
    wrapper.className = 'relative inline-flex items-center w-full';

    for (const cls of [...input.classList]) {
        if (cls.startsWith('mb-') || cls.startsWith('mt-') || cls.startsWith('my-')) {
            wrapper.classList.add(cls);
            input.classList.remove(cls);
        }
    }

    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);
    input.classList.add('pr-10');

    const controls = document.createElement('div');
    controls.className = 'absolute right-0 top-0 bottom-0 flex flex-col w-9 border-l border-white/10';
    const btnClass = 'flex-1 flex items-center justify-center cursor-pointer text-white/40 hover:text-xbox-green hover:bg-white/5 transition-all';
    controls.innerHTML = `
        <button type="button" tabindex="-1" data-action="increment" class="${btnClass} rounded-tr-lg">
            <i class="fa-solid fa-chevron-up text-[10px]"></i>
        </button>
        <button type="button" tabindex="-1" data-action="decrement" class="${btnClass} rounded-br-lg border-t border-white/5">
            <i class="fa-solid fa-chevron-down text-[10px]"></i>
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
    const statusChecks = {
        'backup': { restoring: 'alert.wait_for_restore', scanning_full: 'alert.wait_for_scan_full', migrating: 'alert.wait_for_migrate', updating_db: 'alert.wait_for_updating_db', exporting: 'alert.wait_for_export', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup', updating_restore: 'alert.wait_for_updating_restore', github_syncing: 'alert.wait_for_github_sync' },
        'scan-full': { backuping: 'alert.wait_for_backup', restoring: 'alert.wait_for_restore', migrating: 'alert.wait_for_migrate', updating_db: 'alert.wait_for_updating_db', exporting: 'alert.wait_for_export', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup', github_syncing: 'alert.wait_for_github_sync' },
        'restore': { restoring: 'alert.wait_for_restore', backuping: 'alert.wait_for_backup', migrating: 'alert.wait_for_migrate', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup', updating_restore: 'alert.wait_for_updating_restore', github_syncing: 'alert.wait_for_github_sync' },
        'change-settings': { backuping: 'alert.wait_for_backup', restoring: 'alert.wait_for_restore', scanning_full: 'alert.wait_for_scan_full', migrating: 'alert.wait_for_migrate', updating_db: 'alert.wait_for_updating_db', exporting: 'alert.wait_for_export', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup', updating_restore: 'alert.wait_for_updating_restore', github_syncing: 'alert.wait_for_github_sync' },
        'save-custom': { backuping: 'alert.wait_for_backup', restoring: 'alert.wait_for_restore', scanning_full: 'alert.wait_for_scan_full', migrating: 'alert.wait_for_migrate', exporting: 'alert.wait_for_export', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup', github_syncing: 'alert.wait_for_github_sync' },
        'update-db': { updating_db: 'alert.wait_for_updating_db', backuping: 'alert.wait_for_backup', scanning_full: 'alert.wait_for_scan_full', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup', github_syncing: 'alert.wait_for_github_sync' },
        'export': { exporting: 'alert.wait_for_export', backuping: 'alert.wait_for_backup', scanning_full: 'alert.wait_for_scan_full', migrating: 'alert.wait_for_migrate', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup', updating_restore: 'alert.wait_for_updating_restore', github_syncing: 'alert.wait_for_github_sync' },
        'import': { importing: 'alert.wait_for_import', backuping: 'alert.wait_for_backup', restoring: 'alert.wait_for_restore', scanning_full: 'alert.wait_for_scan_full', migrating: 'alert.wait_for_migrate', exporting: 'alert.wait_for_export', updating_backup: 'alert.wait_for_updating_backup', updating_restore: 'alert.wait_for_updating_restore', github_syncing: 'alert.wait_for_github_sync' },
        'github-sync': { github_syncing: 'alert.wait_for_github_sync', backuping: 'alert.wait_for_backup', restoring: 'alert.wait_for_restore', scanning_full: 'alert.wait_for_scan_full', migrating: 'alert.wait_for_migrate', exporting: 'alert.wait_for_export', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup', updating_restore: 'alert.wait_for_updating_restore' },
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
    const isMenuTrigger = event.target.closest('.dropdown-menu-button') || event.target.closest('#home-options-button');
    if (!isMenuTrigger) {
        window.activeMenuTrigger = null;
        window.api.send('hide-popup-menu');
    }
});
