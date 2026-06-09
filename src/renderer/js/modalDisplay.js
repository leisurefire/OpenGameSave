import { confirmBrowseLocalSave, showAlert, updateProgress, operationStartCheck, wrapNumberInput } from './utility.js';
import { showConfirmDialog } from './dialog.js';
import { setIcon, formatSize, addOrUpdateTableRow, removeTableRow, updateSelectedCountAndSize } from './commonTabs.js';

// Helper function for Backup Management Modal to update backup date display
function updateBackupDateDisplay(backupDateDisplay, backupDate, customName, isPermanent) {
    const formattedDate = backupDate.replace(/(\d{4})-(\d{1,2})-(\d{1,2})_(\d{1,2})-(\d{1,2})/, (match, year, month, day, hour, minute) => {
        return `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    });

    if (isPermanent) {
        const permanentIcon = '<i class="fa-solid fa-star text-yellow-500 mr-2"></i>';
        const renameIcon = `<button type="button" class="rename-backup-btn opacity-40 hover:opacity-100 hover:text-xbox-green transition-all ml-2" data-backup-date="${backupDate}"><i class="fa-solid fa-pencil"></i></button>`;

        if (customName) {
            backupDateDisplay.innerHTML = `${permanentIcon}<div class="flex flex-col"><span class="backup-custom-name font-bold text-xbox-green">${customName}</span><span class="text-xs opacity-50">${formattedDate}</span></div>${renameIcon}`;
        } else {
            backupDateDisplay.innerHTML = `${permanentIcon}<span class="backup-date-text font-semibold">${formattedDate}</span>${renameIcon}`;
        }
    } else {
        backupDateDisplay.innerHTML = `<span class="backup-date-text opacity-80">${formattedDate}</span>`;
    }
}

// Helper function for Backup Management Modal to attach rename button listener
function attachRenameButtonListener(renameBtn) {
    const row = renameBtn.closest('tr');
    renameBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const renameMode = row.querySelector('.rename-mode');
        const backupDateDisplay = row.querySelector('.backup-date-display');
        const nameInput = row.querySelector('.backup-name-input');
        const currentCustomName = row.getAttribute('data-custom-name');

        renameMode.classList.remove('hidden');
        renameMode.classList.add('flex');
        backupDateDisplay.classList.add('hidden');
        nameInput.value = currentCustomName || '';
        nameInput.focus();
        nameInput.select();
    });
}



export async function showManageBackupsModal(wikiId) {
    const gamesList = await window.api.invoke('fetch-restore-table-data', wikiId);

    // Extract the single game from the returned array, fall back to backupTableDataMap if no backups exist
    const gameData = gamesList && gamesList.length > 0
        ? gamesList[0]
        : { backups: [], latest_backup: '-', title: '', zh_CN: '' };

    // If no restore data, use backupTableDataMap for game info
    if (!gamesList || gamesList.length === 0) {
        const backupData = window.backupTableDataMap.get(wikiId);
        if (backupData) {
            gameData.title = backupData.title;
            gameData.zh_CN = backupData.zh_CN;
        }
    }

    const modal = document.getElementById('modal-manage-backups');
    const modalOverlay = document.getElementById('modal-overlay');
    const modalTitle = document.getElementById('modal-manage-backups-title');
    const headerInfo = document.getElementById('modal-manage-backups-header-info');
    const modalContent = document.getElementById('modal-manage-backups-content');

    // Set title
    let gameTitle = gameData.title;
    await window.api.invoke('get-settings').then((settings) => {
        if (gameData.zh_CN && settings.language === 'zh_CN') {
            gameTitle = gameData.zh_CN;
        }
    });
    const backupCount = gameData.backups.length;
    const latestBackup = gameData.latest_backup;
    modalTitle.textContent = gameTitle;

    // Create header info with translations
    const newestBackupLabel = await window.i18n.translate('main.newest_backup_time');
    const backupCountLabel = await window.i18n.translate('main.backup_count');
    headerInfo.innerHTML = `
        <p><span class="opacity-60">${newestBackupLabel}:</span> <span class="newest-backup-value font-bold">${latestBackup}</span></p>
        <p><span class="opacity-60">${backupCountLabel}:</span> <span class="backup-count-value font-bold">${backupCount}</span></p>
    `;

    const backupTimeLabel = await window.i18n.translate('main.backup_time');
    const backupSizeLabel = await window.i18n.translate('main.backup_size');
    const actionLabel = await window.i18n.translate('main.action');
    const restoreLabel = await window.i18n.translate('main.restore');
    const deleteLabel = await window.i18n.translate('main.delete');
    const makePermanentLabel = await window.i18n.translate('main.make_permanent');
    const removePermanentLabel = await window.i18n.translate('main.remove_permanent');
    const enterBackupNameLabel = await window.i18n.translate('main.enter_backup_name');
    const openBackupFolderLabel = await window.i18n.translate('main.open_backup_folder');
    const browseLocalSaveLabel = await window.i18n.translate('main.browse_local_save');
    const deleteLocalSaveLabel = await window.i18n.translate('main.delete_local_save');

    const rowsHtml = gameData.backups
        .sort((a, b) => {
            // Sort by is_permanent (true first), then by date
            if (a.is_permanent !== b.is_permanent) {
                return b.is_permanent - a.is_permanent;
            }
            return b.date.localeCompare(a.date);
        })
        .map(backup => {
            const formattedDate = backup.date.replace(/(\d{4})-(\d{1,2})-(\d{1,2})_(\d{1,2})-(\d{1,2})/, (match, year, month, day, hour, minute) => {
                return `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
            });
            const backupSize = formatSize(backup.backup_size);
            const permanentIcon = backup.is_permanent ? '<i class="fa-solid fa-star text-yellow-500 mr-2"></i>' : '';
            const renameIcon = backup.is_permanent ? `<button type="button" class="rename-backup-btn opacity-40 hover:opacity-100 hover:text-xbox-green transition-all ml-2" data-backup-date="${backup.date}"><i class="fa-solid fa-pencil"></i></button>` : '';

            // Display logic
            let dateDisplay;
            if (backup.is_permanent && backup.custom_name) {
                dateDisplay = `${permanentIcon}<div class="flex flex-col"><span class="backup-custom-name font-bold text-xbox-green">${backup.custom_name}</span><span class="text-xs opacity-50">${formattedDate}</span></div>${renameIcon}`;
            } else {
                dateDisplay = `${permanentIcon}<span class="backup-date-text font-semibold">${formattedDate}</span>${renameIcon}`;
            }

            return `<tr class="border-b border-white/5 hover:bg-white/5 transition-colors" data-custom-name="${backup.custom_name || ''}">
                <td class="p-4">
                    <div class="flex items-center">
                        <div class="rename-mode hidden items-center bg-black/40 rounded-lg border border-white/10 overflow-hidden">
                            <input type="text" class="backup-name-input px-3 py-1.5 bg-transparent border-0 text-sm focus:outline-none" placeholder="${enterBackupNameLabel}" />
                            <button type="button" class="confirm-rename-btn px-3 py-1.5 text-xbox-green hover:bg-xbox-green hover:text-black transition-colors">
                                <i class="fa-solid fa-check"></i>
                            </button>
                        </div>
                        <div class="backup-date-display flex items-center">
                            ${dateDisplay}
                        </div>
                    </div>
                </td>
                <td class="p-4 opacity-70 font-medium">${backupSize}</td>
                <td class="p-4">
                    <div class="flex justify-center gap-2">
                        <button type="button" class="restore-backup-btn home-action-button px-3 py-1.5 text-xs font-bold flex items-center gap-1" data-backup-date="${backup.date}">
                            <i class="fa-solid fa-arrow-left"></i> ${restoreLabel}
                        </button>
                        <button type="button" class="permanent-backup-btn home-action-button px-3 py-1.5 text-xs font-bold flex items-center gap-1" data-backup-date="${backup.date}" data-is-permanent="${backup.is_permanent}">
                            <i class="fa-solid fa-star"></i> ${backup.is_permanent ? removePermanentLabel : makePermanentLabel}
                        </button>
                        <button type="button" class="delete-backup-btn px-3 py-1.5 text-xs font-bold text-red-500 hover:bg-red-500/10 rounded-lg transition-colors flex items-center gap-1" data-backup-date="${backup.date}">
                            <i class="fa-solid fa-trash"></i> ${deleteLabel}
                        </button>
                    </div>
                </td>
            </tr>`;
        })
        .join('');

    const tableHtml = `
        <div class="table-container">
            <table class="w-full text-sm text-left">
                <thead>
                    <tr>
                        <th class="p-4">${backupTimeLabel}</th>
                        <th class="p-4">${backupSizeLabel}</th>
                        <th class="p-4 text-center">${actionLabel}</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
        </div>
    `;

    const footerButtonsHtml = `
        <div class="mt-6 flex flex-wrap items-center justify-between border-t border-white/10 pt-6">
            <button type="button" id="modal-open-backup-folder" class="home-action-button px-4 py-2 text-sm font-bold flex items-center gap-2">
                <i class="fa-solid fa-folder-open"></i> ${openBackupFolderLabel}
            </button>

            <div class="flex gap-3">
                <button type="button" id="modal-browse-local-save" class="home-action-button px-4 py-2 text-sm font-bold flex items-center gap-2">
                    <i class="fa-solid fa-book-open"></i> ${browseLocalSaveLabel}
                </button>
                <button type="button" id="modal-delete-local-save" class="px-4 py-2 text-sm font-bold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors flex items-center gap-2">
                    <i class="fa-solid fa-trash"></i> ${deleteLocalSaveLabel}
                </button>
            </div>
        </div>
    `;

    modalContent.innerHTML = tableHtml + footerButtonsHtml;

    // Add event listeners (Rest of the logic remains same, but using IDs/Classes updated above)
    document.getElementById('modal-open-backup-folder').addEventListener('click', () => {
        window.api.send('open-backup-folder', wikiId);
    });

    document.getElementById('modal-browse-local-save').addEventListener('click', async () => {
        const backupLoaderContainer = document.getElementById('backup-loading');
        const isBackupLoading = backupLoaderContainer && !backupLoaderContainer.classList.contains('hidden') && backupLoaderContainer.querySelector('[data-loader-active="true"]');
        if (isBackupLoading) {
            showAlert('warning', await window.i18n.translate('alert.wait_for_backup_loading'));
            return;
        }
        const gameData = window.backupTableDataMap.get(wikiId);
        const resolvedPaths = gameData?.resolved_paths;
        if (!gameData || !resolvedPaths || resolvedPaths.length === 0) {
            showAlert('warning', await window.i18n.translate('alert.no_local_save_found'));
            return;
        }
        const confirmed = await confirmBrowseLocalSave(resolvedPaths);
        if (!confirmed) return;

        window.api.send('browse-local-save', resolvedPaths);
    });

    document.getElementById('modal-delete-local-save').addEventListener('click', async () => {
        const backupLoaderContainer = document.getElementById('backup-loading');
        const isBackupLoading = backupLoaderContainer && !backupLoaderContainer.classList.contains('hidden') && backupLoaderContainer.querySelector('[data-loader-active="true"]');
        if (isBackupLoading) {
            showAlert('warning', await window.i18n.translate('alert.wait_for_backup_loading'));
            return;
        }
        const gameData = window.backupTableDataMap.get(wikiId);
        const resolvedPaths = gameData?.resolved_paths;
        if (!gameData || !resolvedPaths || resolvedPaths.length === 0) {
            showAlert('warning', await window.i18n.translate('alert.no_local_save_found'));
            return;
        }
        const confirmed = await showConfirmDialog(
            await window.i18n.translate('main.delete_local_save'),
            await window.i18n.translate('alert.confirm_delete_local_save_message')
        );
        if (!confirmed) return;

        const success = await window.api.invoke('delete-local-save', resolvedPaths);
        if (success) {
            removeTableRow('backup', wikiId);
            showAlert('success', await window.i18n.translate('alert.local_save_deleted'));
        }
    });

    modalContent.querySelectorAll('.restore-backup-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            closeManageBackupsModal();
            const backupDate = btn.dataset.backupDate;
            await restoreBackupInstance(backupDate, gameData);
        });
    });

    modalContent.querySelectorAll('.permanent-backup-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const backupDate = btn.dataset.backupDate;
            const isPermanent = btn.dataset.isPermanent === 'true';
            const newIsPermanent = !isPermanent;
            const success = await window.api.invoke('update-backup-info', wikiId, backupDate, 'is_permanent', newIsPermanent);

            if (success) {
                const row = btn.closest('tr');
                const backupDateDisplay = row.querySelector('.backup-date-display');
                const customName = row.getAttribute('data-custom-name');
                if (newIsPermanent) {
                    btn.dataset.isPermanent = 'true';
                    btn.innerHTML = `<i class="fa-solid fa-star"></i> ${removePermanentLabel}`;
                    updateBackupDateDisplay(backupDateDisplay, backupDate, customName, true);
                    const renameBtn = backupDateDisplay.querySelector('.rename-backup-btn');
                    if (renameBtn) attachRenameButtonListener(renameBtn);
                } else {
                    btn.dataset.isPermanent = 'false';
                    btn.innerHTML = `<i class="fa-solid fa-star"></i> ${makePermanentLabel}`;
                    updateBackupDateDisplay(backupDateDisplay, backupDate, customName, false);
                }
                // Update icons and sorting (existing logic)
                const hasAnyPermanentBackup = gameData.backups.some(backup => {
                    const b = modalContent.querySelector(`.permanent-backup-btn[data-backup-date="${backup.date}"]`);
                    return b && b.dataset.isPermanent === 'true';
                });
                const backupTableRow = document.querySelector(`#backup tbody tr[data-wiki-id="${wikiId}"]`);
                const restoreTableRow = document.querySelector(`#restore tbody tr[data-wiki-id="${wikiId}"]`);
                if (backupTableRow) setIcon(backupTableRow, 'star', hasAnyPermanentBackup);
                if (restoreTableRow) setIcon(restoreTableRow, 'star', hasAnyPermanentBackup);
                const restoreGameData = window.restoreTableDataMap.get(wikiId);
                if (restoreGameData) {
                    const bToUpdate = restoreGameData.backups.find(b => b.date === backupDate);
                    if (bToUpdate) bToUpdate.is_permanent = newIsPermanent;
                }
                const tbody = modalContent.querySelector('tbody');
                const rows = Array.from(tbody.querySelectorAll('tr'));
                rows.sort((a, b) => {
                    const aP = a.querySelector('.permanent-backup-btn').dataset.isPermanent === 'true';
                    const bP = b.querySelector('.permanent-backup-btn').dataset.isPermanent === 'true';
                    if (aP !== bP) return bP - aP;
                    return b.querySelector('.permanent-backup-btn').dataset.backupDate.localeCompare(a.querySelector('.permanent-backup-btn').dataset.backupDate);
                });
                rows.forEach(r => tbody.appendChild(r));
            }
        });
    });

    modalContent.querySelectorAll('.delete-backup-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const backupDate = btn.dataset.backupDate;
            const row = btn.closest('tr');
            const formattedDate = backupDate.replace(/(\d{4})-(\d{1,2})-(\d{1,2})_(\d{1,2})-(\d{1,2})/, (m, y, mo, d, h, mi) => `${y}/${mo.padStart(2, '0')}/${d.padStart(2, '0')} ${h.padStart(2, '0')}:${mi.padStart(2, '0')}`);
            const confirmMessage = (await window.i18n.translate('alert.confirm_delete_backup_message')).replace('{{backup_date}}', formattedDate);
            const confirmed = await showConfirmDialog(
                await window.i18n.translate('alert.confirm_delete_backup_title'),
                confirmMessage
            );
            if (!confirmed) return;

            const success = await window.api.invoke('delete-backup', wikiId, backupDate);
            if (success) {
                row.remove();
                const countE = headerInfo.querySelector('.backup-count-value');
                const newC = parseInt(countE.textContent) - 1;
                countE.textContent = newC;
                const newestE = headerInfo.querySelector('.newest-backup-value');
                const remaining = Array.from(modalContent.querySelectorAll('.permanent-backup-btn'))
                    .map(b => b.dataset.backupDate).sort((a, b) => b.localeCompare(a));
                if (remaining.length > 0) {
                    newestE.textContent = remaining[0].replace(/(\d{4})-(\d{1,2})-(\d{1,2})_(\d{1,2})-(\d{1,2})/, (m, y, mo, d, h, mi) => `${y}/${mo.padStart(2, '0')}/${d.padStart(2, '0')} ${h.padStart(2, '0')}:${mi.padStart(2, '0')}`);
                }
                if (newC === 0) removeTableRow('restore', wikiId);
                else { await addOrUpdateTableRow('restore', wikiId); updateSelectedCountAndSize('restore'); }
                await addOrUpdateTableRow('backup', wikiId); updateSelectedCountAndSize('backup');
            }
        });
    });

    modalContent.querySelectorAll('.rename-backup-btn').forEach(btn => attachRenameButtonListener(btn));
    modalContent.querySelectorAll('.confirm-rename-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const row = btn.closest('tr');
            const bDate = row.querySelector('.permanent-backup-btn').dataset.backupDate;
            const nInput = row.querySelector('.backup-name-input');
            const nName = nInput.value.trim();
            const success = await window.api.invoke('update-backup-info', wikiId, bDate, 'custom_name', nName);
            if (success) {
                row.setAttribute('data-custom-name', nName);
                const rMode = row.querySelector('.rename-mode');
                const bDisplay = row.querySelector('.backup-date-display');
                updateBackupDateDisplay(bDisplay, bDate, nName, true);
                rMode.classList.add('hidden');
                rMode.classList.remove('flex');
                bDisplay.classList.remove('hidden');
                const rGameData = window.restoreTableDataMap && window.restoreTableDataMap.get(wikiId);
                if (rGameData) {
                    const bUpd = rGameData.backups.find(b => b.date === bDate);
                    if (bUpd) bUpd.custom_name = nName;
                }
                const nRenameBtn = bDisplay.querySelector('.rename-backup-btn');
                if (nRenameBtn) attachRenameButtonListener(nRenameBtn);
            }
        });
    });

    modalContent.querySelectorAll('.backup-name-input').forEach(input => {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const cBtn = input.closest('.rename-mode').querySelector('.confirm-rename-btn');
                if (cBtn) cBtn.click();
            }
        });
    });

    modal.classList.add('flex');
    modal.classList.remove('hidden');
    modalOverlay.classList.remove('hidden');
    document.getElementById('modal-manage-backups-close').onclick = closeManageBackupsModal;
}

function closeManageBackupsModal() {
    const modal = document.getElementById('modal-manage-backups');
    const modalOverlay = document.getElementById('modal-overlay');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modalOverlay.classList.add('hidden');
}

export async function showAutoBackupModal(wikiId) {
    const modal = document.getElementById('modal-auto-backup');
    const modalOverlay = document.getElementById('modal-overlay');
    const modalTitle = document.getElementById('modal-auto-backup-title');
    const modalContent = document.getElementById('modal-auto-backup-content');
    const confirmButton = document.getElementById('modal-auto-backup-confirm');
    const closeButton = document.getElementById('modal-auto-backup-close');

    if (!modalOverlay.classList.contains('hidden')) return;

    const settings = await window.api.invoke('get-settings');
    const backupData = window.backupTableDataMap.get(wikiId);
    const restoreData = window.restoreTableDataMap && window.restoreTableDataMap.get(wikiId);
    const gameData = backupData || restoreData;
    let gameTitle = '';
    if (gameData) {
        gameTitle = (gameData.zh_CN && settings.language === 'zh_CN') ? gameData.zh_CN : gameData.title;
    }

    const autoBackupState = await window.api.invoke('get-auto-backup-state');
    const isActive = !!autoBackupState[wikiId];
    const status = autoBackupState[wikiId] || null;

    const autoBackupLabel = await window.i18n.translate('main.auto_backup');
    modalTitle.innerHTML = `<i class="fa-solid fa-clock-rotate-left mr-2"></i><span>${autoBackupLabel}</span>`;

    const enableLabel = await window.i18n.translate('main.auto_backup_enable');
    const disableLabel = await window.i18n.translate('main.auto_backup_disable');
    const modeIntervalLabel = await window.i18n.translate('main.auto_backup_mode_interval');
    const modeWatcherLabel = await window.i18n.translate('main.auto_backup_mode_watcher');
    const intervalLabel = await window.i18n.translate('main.auto_backup_interval_minutes');
    const modeLabel = await window.i18n.translate('main.auto_backup_mode');
    const statusActiveLabel = await window.i18n.translate('main.auto_backup_status_active');
    const statusInactiveLabel = await window.i18n.translate('main.auto_backup_status_inactive');

    const currentMode = status ? status.mode : 'interval';
    const currentInterval = status ? (status.intervalMinutes || 30) : 30;

    let statusHtml = '';
    if (isActive) {
        const modeDisplay = status.mode === 'interval'
            ? await window.i18n.translate('main.auto_backup_mode_interval_detail', { minutes: status.intervalMinutes })
            : modeWatcherLabel;
        const backupsPerformed = await window.i18n.translate('main.auto_backup_backups_performed', { count: status.logCount });
        const failedCount = status.failCount > 0
            ? await window.i18n.translate('main.auto_backup_failures', { count: status.failCount })
            : '';
        statusHtml = `
            <div class="mb-6 p-4 bg-xbox-green/10 border border-xbox-green/30 rounded-xl">
                <p class="text-xbox-green font-bold flex items-center gap-2">
                    <i class="fa-solid fa-circle-check"></i>
                    ${statusActiveLabel} — ${modeDisplay}
                </p>
                <p class="text-sm opacity-60 mt-2">${backupsPerformed}</p>
                ${failedCount ? `<p class="text-sm text-red-500 mt-1">${failedCount}</p>` : ''}
            </div>
        `;
    } else {
        statusHtml = `
            <div class="mb-6 p-4 bg-white/5 border border-white/10 rounded-xl">
                <p class="opacity-40 flex items-center gap-2">
                    <i class="fa-solid fa-circle-xmark"></i>
                    ${statusInactiveLabel}
                </p>
            </div>
        `;
    }

    modalContent.innerHTML = `
        <p class="text-lg font-black mb-6">${gameTitle}</p>
        ${statusHtml}
        <div id="auto-backup-config" class="${isActive ? 'hidden' : 'space-y-6'}">
            <div>
                <label class="block mb-3 text-sm font-bold opacity-60 uppercase tracking-widest">${modeLabel}</label>
                <div class="space-y-3">
                    <label class="flex items-center gap-3 cursor-pointer group">
                        <input type="radio" name="auto-backup-mode" value="interval" ${currentMode === 'interval' ? 'checked' : ''} class="accent-xbox-green w-5 h-5">
                        <span class="text-sm font-semibold opacity-80 group-hover:opacity-100">${modeIntervalLabel}</span>
                    </label>
                    <label class="flex items-center gap-3 cursor-pointer group">
                        <input type="radio" name="auto-backup-mode" value="watcher" ${currentMode === 'watcher' ? 'checked' : ''} class="accent-xbox-green w-5 h-5">
                        <span class="text-sm font-semibold opacity-80 group-hover:opacity-100">${modeWatcherLabel}</span>
                    </label>
                </div>
            </div>

            <div id="auto-backup-interval-config" class="${currentMode === 'watcher' ? 'hidden' : ''}">
                <label class="block mb-2 text-sm font-bold opacity-60 uppercase tracking-widest">${intervalLabel}</label>
                <input type="number" id="auto-backup-interval" value="${currentInterval}" min="1" class="w-full">
            </div>
        </div>
    `;

    modalContent.querySelectorAll('input[name="auto-backup-mode"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const intervalConfig = document.getElementById('auto-backup-interval-config');
            if (radio.value === 'watcher') intervalConfig.classList.add('hidden');
            else intervalConfig.classList.remove('hidden');
        });
    });

    const intervalInput = document.getElementById('auto-backup-interval');
    if (intervalInput) wrapNumberInput(intervalInput);

    if (isActive) {
        confirmButton.innerHTML = `<span>${disableLabel}</span>`;
        confirmButton.classList.remove('primary-button');
        confirmButton.classList.add('px-8', 'py-2', 'bg-red-600', 'text-white', 'font-bold', 'rounded-lg', 'hover:bg-red-700');
    } else {
        confirmButton.innerHTML = `<span>${enableLabel}</span>`;
        confirmButton.classList.add('primary-button');
        confirmButton.classList.remove('bg-red-600', 'hover:bg-red-700');
    }

    const handleClose = () => {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        modalOverlay.classList.add('hidden');
    };

    const handleConfirm = async () => {
        if (isActive) {
            const logs = await window.api.invoke('stop-auto-backup', wikiId);
            handleClose();
            if (logs && logs.length > 0) {
                const fC = logs.filter(l => !l.success).length;
                const sM = await window.i18n.translate('main.auto_backup_summary', { total: logs.length, failed: fC });
                if (fC > 0) showAlert('modal', sM, logs.filter(l => !l.success).map(l => `[${l.timestamp}] ${l.error}`));
                else showAlert('success', sM);
            } else showAlert('info', await window.i18n.translate('main.auto_backup_disabled'));
        } else {
            const mode = modalContent.querySelector('input[name="auto-backup-mode"]:checked').value;
            const intervalM = parseInt(document.getElementById('auto-backup-interval').value, 10) || 30;
            await window.api.invoke('start-auto-backup', wikiId, mode, intervalM);
            handleClose();
            showAlert('success', await window.i18n.translate('main.auto_backup_enabled'));
        }
    };

    const nCloseB = closeButton.cloneNode(true);
    closeButton.parentNode.replaceChild(nCloseB, closeButton);
    nCloseB.addEventListener('click', handleClose);

    const nConfirmB = confirmButton.cloneNode(true);
    confirmButton.parentNode.replaceChild(nConfirmB, confirmButton);
    nConfirmB.addEventListener('click', handleConfirm);

    modal.classList.add('flex');
    modal.classList.remove('hidden');
    modalOverlay.classList.remove('hidden');
}

async function restoreBackupInstance(backupDate, gameData) {
    const start = await operationStartCheck('restore');
    if (start) {
        window.api.send('update-status', 'restoring', true);
        const rBtn = document.getElementById('restore-button');
        rBtn.disabled = true;
        rBtn.classList.add('cursor-not-allowed', 'opacity-50');
        const rProgressId = 'restore-progress';
        const rProgressTitle = await window.api.invoke('translate', 'main.restore_in_progress');
        updateProgress(rProgressId, rProgressTitle, 'start');
        const bInst = gameData.backups.find(b => b.date === backupDate);
        const gObj = { ...gameData, backups: [bInst] };
        const { error } = await window.api.invoke('restore-game', gObj, null);
        updateProgress(rProgressId, rProgressTitle, 'end');
        document.querySelector('#restore-tab').click();
        // showRestoreSummary logic (needs to be consistent with main page)
        rBtn.disabled = false;
        rBtn.classList.remove('cursor-not-allowed', 'opacity-50');
        window.api.send('update-status', 'restoring', false);
        const wikiId = gameData.wiki_page_id;
        (async () => {
            window.api.send('update-status', 'updating_backup', true);
            await addOrUpdateTableRow('backup', wikiId);
            window.api.send('update-status', 'updating_backup', false);
        })();
    }
}
