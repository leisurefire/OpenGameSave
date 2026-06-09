import { showConfirmDialog, showDialog, showLegacyInfoDialog } from './dialog.js';
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

// Backward-compatible alias for the new Dialog API.
export function showInfoModal(modalTitle, modalContent, style = 'ok') {
    return showLegacyInfoDialog(modalTitle, modalContent, style);
}

export async function confirmBrowseLocalSave(resolvedPaths) {
    const folderCount = resolvedPaths.filter(pathObj => pathObj.type !== 'reg').length;
    const hasRegistry = resolvedPaths.some(pathObj => pathObj.type === 'reg');

    if (!hasRegistry && folderCount <= 1) return true;

    let message;
    if (folderCount > 0 && hasRegistry) {
        message = await window.i18n.translate('alert.confirm_open_folders_and_reg', { count: folderCount });
    } else if (hasRegistry) {
        message = await window.i18n.translate('alert.confirm_open_reg');
    } else {
        message = await window.i18n.translate('alert.confirm_open_folders', { count: folderCount });
    }

    return await showConfirmDialog(await window.i18n.translate('main.browse_local_save'), message);
}

// Export modal
function showExportModal() {
    const modal = document.getElementById('modal-export');
    const modalOverlay = document.getElementById('modal-overlay');
    const modalExportCountInput = document.getElementById('modal-export-count');
    const modalExportPathInput = document.getElementById('modal-export-path');
    const modalExportPathSelectButton = document.getElementById('modal-export-select-path');

    if (!modalOverlay.classList.contains('hidden')) return;

    wrapNumberInput(modalExportCountInput);

    window.api.invoke('get-settings').then((settings) => {
        if (settings) {
            modalExportCountInput.max = settings.maxBackups;
            modalExportPathInput.value = settings.exportPath;
        }
    });

    if (!modal.dataset.listenerAdded) {
        modalExportPathSelectButton.addEventListener('click', async () => {
            const result = await window.api.invoke('select-path', 'folder');
            if (result) modalExportPathInput.value = result;
        });
        modal.dataset.listenerAdded = true;
    }

    modal.classList.add('flex');
    modal.classList.remove('hidden');
    modalOverlay.classList.remove('hidden');

    document.getElementById('modal-export-close').onclick = closeExportModal;
    document.getElementById('modal-export-confirm').onclick = exportConfirm;
}

async function exportConfirm() {
    const start = await operationStartCheck('export');
    if (start) {
        const count = document.getElementById('modal-export-count').value;
        const exportPath = document.getElementById('modal-export-path').value;
        const scope = document.querySelector('input[name="export-scope"]:checked').value;

        let wikiIds = null;
        if (scope !== 'all') {
            const table = document.querySelector(`#${scope}`);
            const selectedRows = table.querySelectorAll('.row-checkbox:checked');
            wikiIds = Array.from(selectedRows).map(checkbox => checkbox.closest('tr').getAttribute('data-wiki-id').trim());
            if (wikiIds.length === 0) {
                showAlert('warning', await window.i18n.translate('alert.no_games_selected'));
                closeExportModal();
                return;
            }
        }
        window.api.send("export-backups", count, exportPath, wikiIds);
    }
    closeExportModal();
}

function closeExportModal() {
    const modal = document.getElementById('modal-export');
    const modalOverlay = document.getElementById('modal-overlay');
    const modalExportPathInput = document.getElementById('modal-export-path');
    window.api.send('save-settings', 'exportPath', modalExportPathInput.value);
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modalOverlay.classList.add('hidden');
}

// Import modal
function showImportModal(gsmPath) {
    const modal = document.getElementById('modal-import');
    const modalOverlay = document.getElementById('modal-overlay');
    const modalImportPathInput = document.getElementById('modal-import-path');
    const modalImportPathSelectButton = document.getElementById('modal-import-select-path');

    if (!modalOverlay.classList.contains('hidden')) return;

    if (gsmPath) modalImportPathInput.value = gsmPath;
    if (!modal.dataset.listenerAdded) {
        modalImportPathSelectButton.onclick = async () => {
            const result = await window.api.invoke('select-path', 'gsmr');
            if (result) modalImportPathInput.value = result;
        };
        modal.dataset.listenerAdded = true;
    }

    modal.classList.add('flex');
    modal.classList.remove('hidden');
    modalOverlay.classList.remove('hidden');

    document.getElementById('modal-import-close').onclick = closeImportModal;
    document.getElementById('modal-import-confirm').onclick = importConfirm;
}

async function importConfirm() {
    const start = await operationStartCheck('import');
    if (start) {
        const importPath = document.getElementById('modal-import-path').value;
        window.api.send("import-backups", importPath);
    }
    closeImportModal();
}

function closeImportModal() {
    const modal = document.getElementById('modal-import');
    const modalOverlay = document.getElementById('modal-overlay');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modalOverlay.classList.add('hidden');
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

async function showAccountModal() {
    const modalOverlay = document.getElementById('modal-overlay');
    if (!modalOverlay.classList.contains('hidden')) return;

    try {
        const [accountData, settings] = await Promise.all([
            window.api.invoke('get-account-data'),
            window.api.invoke('get-settings')
        ]);

        const isBackupAllAccounts = settings.backupAllAccounts || false;
        const platformKeys = {
            steamId64: 'alert.steam_user_id64',
            steamId3: 'alert.steam_user_id3',
            ubisoftId: 'alert.ubisoft_user_id',
            epicId: 'alert.epic_user_id',
            xboxId: 'alert.xbox_user_id',
            rockStarId: 'alert.rockstar_user_id'
        };

        const labels = {
            title: await window.i18n.translate('main.view_account_ids'),
            detectedAccounts: await window.i18n.translate('alert.detected_accounts'),
            noAccountsDetected: await window.i18n.translate('alert.no_accounts_detected'),
            backupScope: await window.i18n.translate('alert.backup_scope'),
            currentAccountOnly: await window.i18n.translate('alert.current_account_only'),
            allAccounts: await window.i18n.translate('alert.all_accounts'),
            accountBackupNote: await window.i18n.translate('alert.account_backup_note'),
            confirm: await window.i18n.translate('alert.confirm')
        };

        let accountRows = '';
        if (accountData && Object.keys(accountData).length > 0) {
            for (const [platform, id] of Object.entries(accountData)) {
                if (id && id !== 'N/A' && id !== null) {
                    const platformLabel = await window.i18n.translate(platformKeys[platform] || platform);
                    accountRows += `
                        <div class="flex justify-between items-center">
                            <span class="text-sm font-semibold opacity-70 text-content">${platformLabel}</span>
                            <code class="text-xs bg-black/40 px-2 py-1 rounded font-mono text-xbox-green">${id}</code>
                        </div>
                    `;
                }
            }
        }

        if (!accountRows) {
            accountRows = `<p class="text-sm opacity-40 text-center py-4 text-content">${labels.noAccountsDetected}</p>`;
        }

        const contentHTML = `
            <div class="space-y-6">
                <div>
                    <h4 class="text-xs font-black uppercase tracking-widest opacity-40 mb-3 text-content">${labels.detectedAccounts}</h4>
                    <div class="surface-effect p-4 space-y-3">
                        ${accountRows}
                    </div>
                </div>

                <div>
                    <h4 class="text-xs font-black uppercase tracking-widest opacity-40 mb-3 text-content">${labels.backupScope}</h4>
                    <div class="space-y-3">
                        <label class="flex items-center gap-3 cursor-pointer group">
                            <input id="backup-scope-current" type="radio" name="backup-scope" ${!isBackupAllAccounts ? 'checked' : ''} class="accent-xbox-green w-5 h-5">
                            <span class="text-sm font-semibold opacity-80 group-hover:opacity-100 text-content">${labels.currentAccountOnly}</span>
                        </label>
                        <label class="flex items-center gap-3 cursor-pointer group">
                            <input id="backup-scope-all" type="radio" name="backup-scope" ${isBackupAllAccounts ? 'checked' : ''} class="accent-xbox-green w-5 h-5">
                            <span class="text-sm font-semibold opacity-80 group-hover:opacity-100 text-content">${labels.allAccounts}</span>
                        </label>
                    </div>
                </div>

                <div class="p-4 bg-xbox-green/10 border border-xbox-green/20 rounded-xl">
                    <p class="text-xs font-bold text-xbox-green leading-relaxed">
                        <i class="fa-solid fa-circle-info mr-1"></i> <span>${labels.accountBackupNote}</span>
                    </p>
                </div>
            </div>
        `;

        const confirmed = await showDialog({
            title: labels.title,
            content: (contentElement) => {
                contentElement.innerHTML = contentHTML;
            },
            buttons: [{ value: true, text: labels.confirm, primary: true }],
            closeValue: false
        });

        if (confirmed) {
            const isAllAccountsSelected = document.getElementById('backup-scope-all').checked;
            window.api.send('save-settings', 'backupAllAccounts', isAllAccountsSelected);
            window.api.send('update-backup-table');
        }
    } catch (err) {
        console.error('Error fetching account data:', err);
    }
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
