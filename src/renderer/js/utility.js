document.documentElement.classList.add('dark');

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
    document.documentElement.classList.add('dark');
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
    container.querySelectorAll("[data-i18n]").forEach(async (el) => {
        const key = el.getAttribute("data-i18n");
        const translation = await window.i18n.translate(key);
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
    });

    container.querySelectorAll('[data-i18n-placeholder]').forEach(async element => {
        const i18nKey = element.getAttribute('data-i18n-placeholder');
        element.setAttribute('placeholder', await window.i18n.translate(i18nKey));
    });
}


export async function showAlert(type, message, modalContent) {
    const alertContainer = document.getElementById('alert-container');

    const alertStyles = {
        info: 'bg-white/10 text-white border-white/5',
        error: 'bg-red-500/10 text-red-500 border-red-500/20',
        success: 'bg-xbox-green/10 text-xbox-green border-xbox-green/20',
        warning: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
        modal: 'bg-red-500/10 text-red-500 border-red-500/20',
    };

    const iconClass = {
        info: 'fa-circle-info',
        error: 'fa-circle-xmark',
        success: 'fa-circle-check',
        warning: 'fa-triangle-exclamation',
        modal: 'fa-circle-question',
    };

    const alertElement = document.createElement('div');
    alertElement.className = `flex items-center gap-4 p-4 rounded-xl border floating-surface shadow-2xl ${alertStyles[type]} animate-fadeInShift max-w-sm`;

    alertElement.innerHTML = `
        <i class="fa-solid ${iconClass[type]} text-xl"></i>
        <div class="flex-1 text-sm font-bold leading-tight">
            <span class="text-content">${message}</span>
        </div>
    `;

    if (type === 'modal') {
        const learnMoreBtn = document.createElement('button');
        learnMoreBtn.className = 'text-xs font-black uppercase tracking-widest opacity-60 hover:opacity-100 transition-opacity underline';
        learnMoreBtn.setAttribute('data-i18n', 'alert.learn_more');
        learnMoreBtn.innerHTML = '<span class="text-content"></span>';
        learnMoreBtn.addEventListener('click', () => {
            showInfoModal(message, modalContent);
        });
        alertElement.appendChild(learnMoreBtn);
    } else {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'p-1 opacity-40 hover:opacity-100 transition-opacity';
        closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        closeBtn.onclick = () => {
            alertElement.classList.replace('animate-fadeInShift', 'animate-fadeOut');
            setTimeout(() => alertElement.remove(), 300);
        };
        alertElement.appendChild(closeBtn);
    }

    alertContainer.appendChild(alertElement);
    updateTranslations(alertElement);

    setTimeout(() => {
        if (alertElement.parentNode) {
            alertElement.classList.replace('animate-fadeInShift', 'animate-fadeOut');
            setTimeout(() => alertElement.remove(), 300);
        }
    }, 5000);
}

// Info modal, showing either "ok" or "yesno" style
export async function showInfoModal(modalTitle, modalContent, style = 'ok') {
    return new Promise(async (resolve) => {
        const modal = document.getElementById('modal-info');
        const modalOverlay = document.getElementById('modal-overlay');
        const modalTitleElement = document.getElementById('modal-info-title');
        const modalContentElement = document.getElementById('modal-info-content');
        const closeButton = document.getElementById('modal-info-close');
        const noButton = document.getElementById('modal-info-no');
        const confirmButton = document.getElementById('modal-info-confirm');

        modalTitleElement.textContent = modalTitle;

        if (Array.isArray(modalContent)) {
            modalContentElement.innerHTML = modalContent.map(item => {
                if (Array.isArray(item)) {
                    return `<ul class="space-y-2 py-2">${item.map(li => `<li class="flex gap-2 opacity-80 text-sm"><i class="fa-solid fa-caret-right text-xbox-green mt-1"></i>${li}</li>`).join('')}</ul>`;
                }
                return `<p class="text-sm opacity-80 leading-relaxed mb-2">${item}</p>`;
            }).join('');
        } else {
            modalContentElement.textContent = modalContent;
            modalContentElement.className = "text-sm opacity-80 leading-relaxed";
        }

        const closeModal = () => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            modalOverlay.classList.add('hidden');
            cleanupListeners();
        };

        const cleanupListeners = () => {
            closeButton.onclick = null;
            noButton.onclick = null;
            confirmButton.onclick = null;
        };

        const handleClose = () => {
            closeModal();
            resolve(style === 'yesno' ? false : true);
        };

        if (style === 'yesno') {
            noButton.style.display = '';
            noButton.textContent = await window.i18n.translate('alert.no');
            confirmButton.textContent = await window.i18n.translate('alert.yes');
        } else {
            noButton.style.display = 'none';
            confirmButton.textContent = 'OK';
        }

        modal.classList.add('flex');
        modal.classList.remove('hidden');
        modalOverlay.classList.remove('hidden');

        closeButton.onclick = handleClose;
        noButton.onclick = () => { closeModal(); resolve(false); };
        confirmButton.onclick = () => { closeModal(); resolve(true); };
    });
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
        progressElement.className = "ml-auto p-4 mb-2 rounded-xl border border-white/10 bg-black/40 backdrop-blur-xl animate-fadeIn w-72 shadow-2xl";
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
    const modal = document.getElementById('modal-info');
    const modalOverlay = document.getElementById('modal-overlay');
    const modalTitleElement = document.getElementById('modal-info-title');
    const modalContentElement = document.getElementById('modal-info-content');
    const closeButton = document.getElementById('modal-info-close');
    const confirmButton = document.getElementById('modal-info-confirm');

    if (!modalOverlay.classList.contains('hidden')) return;

    Promise.all([
        window.api.invoke('get-account-data'),
        window.api.invoke('get-settings')
    ]).then(([accountData, settings]) => {
        modalTitleElement.setAttribute('data-i18n', 'main.view_account_ids');
        const titleSpan = document.createElement('span');
        titleSpan.className = 'text-content';
        modalTitleElement.appendChild(titleSpan);

        const isBackupAllAccounts = settings.backupAllAccounts || false;

        let contentHTML = `
            <div class="space-y-6">
                <div>
                    <h4 class="text-xs font-black uppercase tracking-widest opacity-40 mb-3 text-content" data-i18n="alert.detected_accounts"></h4>
                    <div class="surface-effect p-4 space-y-3">
        `;

        if (accountData && Object.keys(accountData).length > 0) {
            for (const [platform, id] of Object.entries(accountData)) {
                if (id && id !== 'N/A' && id !== null) {
                    const platformKeys = {
                        steamId64: 'alert.steam_user_id64',
                        steamId3: 'alert.steam_user_id3',
                        ubisoftId: 'alert.ubisoft_user_id',
                        epicId: 'alert.epic_user_id',
                        xboxId: 'alert.xbox_user_id',
                        rockStarId: 'alert.rockstar_user_id'
                    };
                    contentHTML += `
                        <div class="flex justify-between items-center">
                            <span class="text-sm font-semibold opacity-70 text-content" data-i18n="${platformKeys[platform] || platform}"></span>
                            <code class="text-xs bg-black/40 px-2 py-1 rounded font-mono text-xbox-green">${id}</code>
                        </div>
                    `;
                }
            }
        } else {
            contentHTML += `<p class="text-sm opacity-40 text-center py-4 text-content" data-i18n="alert.no_accounts_detected"></p>`;
        }

        contentHTML += `
                    </div>
                </div>

                <div>
                    <h4 class="text-xs font-black uppercase tracking-widest opacity-40 mb-3 text-content" data-i18n="alert.backup_scope"></h4>
                    <div class="space-y-3">
                        <label class="flex items-center gap-3 cursor-pointer group">
                            <input id="backup-scope-current" type="radio" name="backup-scope" ${!isBackupAllAccounts ? 'checked' : ''} class="accent-xbox-green w-5 h-5">
                            <span class="text-sm font-semibold opacity-80 group-hover:opacity-100 text-content" data-i18n="alert.current_account_only"></span>
                        </label>
                        <label class="flex items-center gap-3 cursor-pointer group">
                            <input id="backup-scope-all" type="radio" name="backup-scope" ${isBackupAllAccounts ? 'checked' : ''} class="accent-xbox-green w-5 h-5">
                            <span class="text-sm font-semibold opacity-80 group-hover:opacity-100 text-content" data-i18n="alert.all_accounts"></span>
                        </label>
                    </div>
                </div>

                <div class="p-4 bg-xbox-green/10 border border-xbox-green/20 rounded-xl">
                    <p class="text-xs font-bold text-xbox-green leading-relaxed">
                        <i class="fa-solid fa-circle-info mr-1"></i> <span data-i18n="alert.account_backup_note"></span>
                    </p>
                </div>
            </div>
        `;

        modalContentElement.innerHTML = contentHTML;

        const handleClose = () => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            modalOverlay.classList.add('hidden');
        };

        const handleConfirm = () => {
            const isAllAccountsSelected = document.getElementById('backup-scope-all').checked;
            window.api.send('save-settings', 'backupAllAccounts', isAllAccountsSelected);
            window.api.send('update-backup-table');
            handleClose();
        };

        confirmButton.setAttribute('data-i18n', 'alert.confirm');
        confirmButton.className = 'primary-button px-8 py-2 text-content';

        const nCloseB = closeButton.cloneNode(true);
        closeButton.parentNode.replaceChild(nCloseB, closeButton);
        nCloseB.onclick = handleClose;

        const nConfirmB = confirmButton.cloneNode(true);
        confirmButton.parentNode.replaceChild(nConfirmB, confirmButton);
        nConfirmB.onclick = handleConfirm;

        updateTranslations(modal);
        modal.classList.add('flex');
        modal.classList.remove('hidden');
        modalOverlay.classList.remove('hidden');
    }).catch(err => {
        console.error('Error fetching account data:', err);
    });
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
        'backup': { restoring: 'alert.wait_for_restore', scanning_full: 'alert.wait_for_scan_full', migrating: 'alert.wait_for_migrate', updating_db: 'alert.wait_for_updating_db', exporting: 'alert.wait_for_export', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup', updating_restore: 'alert.wait_for_updating_restore' },
        'scan-full': { backuping: 'alert.wait_for_backup', restoring: 'alert.wait_for_restore', migrating: 'alert.wait_for_migrate', updating_db: 'alert.wait_for_updating_db', exporting: 'alert.wait_for_export', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup' },
        'restore': { restoring: 'alert.wait_for_restore', backuping: 'alert.wait_for_backup', migrating: 'alert.wait_for_migrate', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup', updating_restore: 'alert.wait_for_updating_restore' },
        'change-settings': { backuping: 'alert.wait_for_backup', restoring: 'alert.wait_for_restore', scanning_full: 'alert.wait_for_scan_full', migrating: 'alert.wait_for_migrate', updating_db: 'alert.wait_for_updating_db', exporting: 'alert.wait_for_export', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup', updating_restore: 'alert.wait_for_updating_restore' },
        'save-custom': { backuping: 'alert.wait_for_backup', restoring: 'alert.wait_for_restore', scanning_full: 'alert.wait_for_scan_full', migrating: 'alert.wait_for_migrate', exporting: 'alert.wait_for_export', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup' },
        'update-db': { updating_db: 'alert.wait_for_updating_db', backuping: 'alert.wait_for_backup', scanning_full: 'alert.wait_for_scan_full', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup' },
        'export': { exporting: 'alert.wait_for_export', backuping: 'alert.wait_for_backup', scanning_full: 'alert.wait_for_scan_full', migrating: 'alert.wait_for_migrate', importing: 'alert.wait_for_import', updating_backup: 'alert.wait_for_updating_backup', updating_restore: 'alert.wait_for_updating_restore' },
        'import': { importing: 'alert.wait_for_import', backuping: 'alert.wait_for_backup', restoring: 'alert.wait_for_restore', scanning_full: 'alert.wait_for_scan_full', migrating: 'alert.wait_for_migrate', exporting: 'alert.wait_for_export', updating_backup: 'alert.wait_for_updating_backup', updating_restore: 'alert.wait_for_updating_restore' },
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
        window.api.send('hide-popup-menu');
    }
});
