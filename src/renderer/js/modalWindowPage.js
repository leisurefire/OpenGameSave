import { operationStartCheck, showAlert, updateTranslations, wrapNumberInput, autoResizeWindow } from './utility.js';

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function closeModalWindow() {
    window.api.send('close-current-modal-window');
}

function showMainAlert(type, message, detailContent) {
    window.api.send('show-main-alert', type, message, detailContent);
}

function formatSize(sizeInBytes) {
    if (sizeInBytes === 0) return '0 B';
    const i = Math.floor(Math.log(sizeInBytes) / Math.log(1024));
    return (sizeInBytes / Math.pow(1024, i)).toFixed(2) * 1 + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i];
}

async function getGameTitle(wikiId, settings) {
    const [backupGames, restoreGames] = await Promise.all([
        window.api.invoke('fetch-backup-table-data', false, wikiId),
        window.api.invoke('fetch-restore-table-data', wikiId)
    ]);
    const gameData = backupGames?.[0] || restoreGames?.[0];
    if (!gameData) return '';
    return gameData.zh_CN && settings.language === 'zh_CN' ? gameData.zh_CN : gameData.title;
}

async function setWindowTitle(title) {
    document.title = title;
}

async function setModalLoading(root) {
    const loadingText = await window.i18n.translate('main.loading');
    root.innerHTML = `
        <div class="modal-loading-state">
            <i class="fa-solid fa-spinner fa-spin text-2xl text-xbox-green"></i>
            <span>${escapeHtml(loadingText)}</span>
        </div>
    `;
}

async function requestConfirmModal(title, message) {
    return await window.api.invoke('show-confirm-modal-window', { title, message });
}

async function renderExportModal(root) {
    const settings = await window.api.invoke('get-settings');
    const title = await window.i18n.translate('alert.export_backups');
    const exportScopeLabel = await window.i18n.translate('alert.export_scope');
    const exportAllGamesLabel = await window.i18n.translate('alert.export_all_games');
    const exportSelectedBackupLabel = await window.i18n.translate('alert.export_selected_backup');
    const exportCountLabel = await window.i18n.translate('alert.export_count');
    const exportPathLabel = await window.i18n.translate('alert.export_path');
    const exportLabel = await window.i18n.translate('main.export');

    await setWindowTitle(title);
    root.innerHTML = `
        <section class="modal-window-panel">
            <div class="modal-window-content space-y-4">
                <div>
                    <label class="block text-sm font-medium mb-2 opacity-60">${escapeHtml(exportScopeLabel)}</label>
                    <div class="space-y-2">
                        <label class="flex items-center gap-3 cursor-pointer group">
                            <input type="radio" name="export-scope" value="all" checked class="accent-xbox-green">
                            <span class="group-hover:text-xbox-green transition-colors">${escapeHtml(exportAllGamesLabel)}</span>
                        </label>
                        <label class="flex items-center gap-3 cursor-pointer group">
                            <input type="radio" name="export-scope" value="backup" class="accent-xbox-green">
                            <span class="group-hover:text-xbox-green transition-colors">${escapeHtml(exportSelectedBackupLabel)}</span>
                        </label>
                    </div>
                </div>
                <div>
                    <label class="block text-sm font-medium mb-2 opacity-60">${escapeHtml(exportCountLabel)}</label>
                    <input type="number" id="modal-export-count" value="1" min="1" max="${escapeHtml(settings?.maxBackups || 1000)}" class="w-full">
                </div>
                <div>
                    <label class="block text-sm font-medium mb-2 opacity-60">${escapeHtml(exportPathLabel)}</label>
                    <div class="flex gap-2">
                        <input type="text" id="modal-export-path" readonly class="flex-1" value="${escapeHtml(settings?.exportPath || '')}">
                        <button id="modal-export-select-path" type="button" class="secondary-button px-4">...</button>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button id="modal-export-confirm" type="button" class="primary-button px-8 py-2">${escapeHtml(exportLabel)}</button>
            </div>
        </section>
    `;

    wrapNumberInput(document.getElementById('modal-export-count'));

    document.getElementById('modal-export-select-path').addEventListener('click', async () => {
        const result = await window.api.invoke('select-path', 'folder');
        if (result) document.getElementById('modal-export-path').value = result;
    });

    document.getElementById('modal-export-confirm').addEventListener('click', async () => {
        const start = await operationStartCheck('export');
        if (!start) return;

        const count = document.getElementById('modal-export-count').value;
        const exportPath = document.getElementById('modal-export-path').value;
        const scope = document.querySelector('input[name="export-scope"]:checked').value;
        let wikiIds = null;

        if (scope !== 'all') {
            wikiIds = await window.api.invoke('get-main-selected-wiki-ids', scope);
            if (!wikiIds || wikiIds.length === 0) {
                showAlert('warning', await window.i18n.translate('alert.no_games_selected'));
                return;
            }
        }

        window.api.send('save-settings', 'exportPath', exportPath);
        window.api.send('export-backups', count, exportPath, wikiIds);
        closeModalWindow();
    });
}

async function renderImportModal(root, initData) {
    const title = await window.i18n.translate('alert.import_backups');
    const gsmPathLabel = await window.i18n.translate('alert.gsmr_path');
    const importLabel = await window.i18n.translate('main.import');

    await setWindowTitle(title);
    root.innerHTML = `
        <section class="modal-window-panel">
            <div class="modal-window-content space-y-4">
                <div>
                    <label class="block text-sm font-medium mb-2 opacity-60">${escapeHtml(gsmPathLabel)}</label>
                    <div class="flex gap-2">
                        <input type="text" id="modal-import-path" readonly class="flex-1" value="${escapeHtml(initData?.gsmPath || '')}">
                        <button id="modal-import-select-path" type="button" class="secondary-button px-4">...</button>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button id="modal-import-confirm" type="button" class="primary-button px-8 py-2">${escapeHtml(importLabel)}</button>
            </div>
        </section>
    `;

    document.getElementById('modal-import-select-path').addEventListener('click', async () => {
        const result = await window.api.invoke('select-path', 'gsmr');
        if (result) document.getElementById('modal-import-path').value = result;
    });

    document.getElementById('modal-import-confirm').addEventListener('click', async () => {
        const start = await operationStartCheck('import');
        if (!start) return;

        const importPath = document.getElementById('modal-import-path').value;
        window.api.send('import-backups', importPath);
        closeModalWindow();
    });
}

async function renderAccountModal(root) {
    const [accountData, settings] = await Promise.all([
        window.api.invoke('get-account-data'),
        window.api.invoke('get-settings')
    ]);

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
                    <div class="flex justify-between items-center gap-4">
                        <span class="text-sm font-semibold opacity-70">${escapeHtml(platformLabel)}</span>
                        <code class="text-xs bg-black/40 px-2 py-1 rounded font-mono text-xbox-green break-all text-right">${escapeHtml(id)}</code>
                    </div>
                `;
            }
        }
    }

    if (!accountRows) {
        accountRows = `<p class="text-sm opacity-40 text-center py-4">${escapeHtml(labels.noAccountsDetected)}</p>`;
    }

    const isBackupAllAccounts = settings?.backupAllAccounts || false;
    await setWindowTitle(labels.title);
    root.innerHTML = `
        <section class="modal-window-panel">
            <div class="modal-window-content space-y-6">
                <div>
                    <h2 class="modal-section-title">${escapeHtml(labels.detectedAccounts)}</h2>
                    <div class="surface-effect p-4 space-y-3">${accountRows}</div>
                </div>
                <div>
                    <h2 class="modal-section-title">${escapeHtml(labels.backupScope)}</h2>
                    <div class="space-y-3">
                        <label class="flex items-center gap-3 cursor-pointer group">
                            <input id="backup-scope-current" type="radio" name="backup-scope" ${!isBackupAllAccounts ? 'checked' : ''} class="accent-xbox-green w-5 h-5">
                            <span class="text-sm font-semibold opacity-80 group-hover:opacity-100">${escapeHtml(labels.currentAccountOnly)}</span>
                        </label>
                        <label class="flex items-center gap-3 cursor-pointer group">
                            <input id="backup-scope-all" type="radio" name="backup-scope" ${isBackupAllAccounts ? 'checked' : ''} class="accent-xbox-green w-5 h-5">
                            <span class="text-sm font-semibold opacity-80 group-hover:opacity-100">${escapeHtml(labels.allAccounts)}</span>
                        </label>
                    </div>
                </div>
                <div class="p-4 bg-xbox-green/10 border border-xbox-green/20 rounded-xl">
                    <p class="text-xs font-bold text-xbox-green leading-relaxed">
                        <i class="fa-solid fa-circle-info mr-1"></i> <span>${escapeHtml(labels.accountBackupNote)}</span>
                    </p>
                </div>
            </div>
            <div class="modal-footer">
                <button id="modal-account-confirm" type="button" class="primary-button px-8 py-2">${escapeHtml(labels.confirm)}</button>
            </div>
        </section>
    `;

    document.getElementById('modal-account-confirm').addEventListener('click', () => {
        const isAllAccountsSelected = document.getElementById('backup-scope-all').checked;
        window.api.send('save-settings', 'backupAllAccounts', isAllAccountsSelected);
        window.api.send('update-backup-table');
        closeModalWindow();
    });
}

function formatBackupDate(backupDate) {
    return String(backupDate || '').replace(/(\d{4})-(\d{1,2})-(\d{1,2})_(\d{1,2})-(\d{1,2})/, (match, year, month, day, hour, minute) => {
        return `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    });
}

async function renderManageBackupsModal(root, initData) {
    await setModalLoading(root);
    const wikiId = initData?.wikiId;
    const settings = await window.api.invoke('get-settings');
    const [restoreGames, backupGames] = await Promise.all([
        window.api.invoke('fetch-restore-table-data', wikiId),
        window.api.invoke('fetch-backup-table-data', false, wikiId)
    ]);

    const fallbackData = backupGames?.[0];
    const gameData = restoreGames?.[0] || {
        ...(fallbackData || {}),
        backups: [],
        latest_backup: '-'
    };
    const gameTitle = gameData.zh_CN && settings.language === 'zh_CN' ? gameData.zh_CN : gameData.title;

    const labels = {
        title: await window.i18n.translate('main.manage_backups'),
        newestBackup: await window.i18n.translate('main.newest_backup_time'),
        backupCount: await window.i18n.translate('main.backup_count'),
        backupTime: await window.i18n.translate('main.backup_time'),
        backupSize: await window.i18n.translate('main.backup_size'),
        action: await window.i18n.translate('main.action'),
        restore: await window.i18n.translate('main.restore'),
        delete: await window.i18n.translate('main.delete'),
        makePermanent: await window.i18n.translate('main.make_permanent'),
        removePermanent: await window.i18n.translate('main.remove_permanent'),
        enterBackupName: await window.i18n.translate('main.enter_backup_name'),
        openBackupFolder: await window.i18n.translate('main.open_backup_folder')
    };

    const renderDateDisplay = (backup) => {
        const permanentIcon = backup.is_permanent ? '<i class="fa-solid fa-star text-yellow-500 mr-2"></i>' : '';
        const renameIcon = backup.is_permanent ? `<button type="button" class="rename-backup-btn opacity-40 hover:opacity-100 hover:text-xbox-green transition-all ml-2" data-backup-date="${escapeHtml(backup.date)}"><i class="fa-solid fa-pencil"></i></button>` : '';
        if (backup.is_permanent && backup.custom_name) {
            return `${permanentIcon}<div class="flex flex-col"><span class="backup-custom-name font-bold text-xbox-green">${escapeHtml(backup.custom_name)}</span><span class="text-xs opacity-50">${escapeHtml(formatBackupDate(backup.date))}</span></div>${renameIcon}`;
        }
        return `${permanentIcon}<span class="backup-date-text font-semibold ${backup.is_permanent ? '' : 'opacity-80'}">${escapeHtml(formatBackupDate(backup.date))}</span>${renameIcon}`;
    };

    const rowsHtml = [...(gameData.backups || [])]
        .sort((a, b) => (a.is_permanent !== b.is_permanent) ? b.is_permanent - a.is_permanent : b.date.localeCompare(a.date))
        .map(backup => `
            <tr class="border-b border-white/5 hover:bg-white/5 transition-colors" data-backup-date="${escapeHtml(backup.date)}" data-custom-name="${escapeHtml(backup.custom_name || '')}">
                <td class="p-4">
                    <div class="flex items-center">
                        <div class="rename-mode hidden items-center bg-black/40 rounded-lg border border-white/10 overflow-hidden">
                            <input type="text" class="backup-name-input px-3 py-1.5 bg-transparent border-0 text-sm focus:outline-none" placeholder="${escapeHtml(labels.enterBackupName)}" />
                            <button type="button" class="confirm-rename-btn px-3 py-1.5 text-xbox-green hover:bg-xbox-green hover:text-black transition-colors"><i class="fa-solid fa-check"></i></button>
                        </div>
                        <div class="backup-date-display flex items-center">${renderDateDisplay(backup)}</div>
                    </div>
                </td>
                <td class="p-4 opacity-70 font-medium">${escapeHtml(formatSize(backup.backup_size))}</td>
                <td class="p-4">
                    <div class="flex justify-center gap-2">
                        <button type="button" class="restore-backup-btn home-action-button px-3 py-1.5 text-xs font-bold flex items-center gap-1" data-backup-date="${escapeHtml(backup.date)}"><i class="fa-solid fa-arrow-left"></i> ${escapeHtml(labels.restore)}</button>
                        <button type="button" class="permanent-backup-btn home-action-button px-3 py-1.5 text-xs font-bold flex items-center gap-1" data-backup-date="${escapeHtml(backup.date)}" data-is-permanent="${backup.is_permanent}"><i class="fa-solid fa-star"></i> ${escapeHtml(backup.is_permanent ? labels.removePermanent : labels.makePermanent)}</button>
                        <button type="button" class="delete-backup-btn px-3 py-1.5 text-xs font-bold text-red-500 hover:bg-red-500/10 rounded-lg transition-colors flex items-center gap-1" data-backup-date="${escapeHtml(backup.date)}"><i class="fa-solid fa-trash"></i> ${escapeHtml(labels.delete)}</button>
                    </div>
                </td>
            </tr>
        `).join('');

    await setWindowTitle(labels.title);
    root.innerHTML = `
        <section class="modal-window-panel">
            <div class="mb-6">
                <h1 class="text-2xl font-bold text-xbox-green">${escapeHtml(gameTitle || labels.title)}</h1>
                <div class="text-sm opacity-60 mt-1">
                    <p><span class="opacity-60">${escapeHtml(labels.newestBackup)}:</span> <span class="newest-backup-value font-bold">${escapeHtml(gameData.latest_backup || '-')}</span></p>
                    <p><span class="opacity-60">${escapeHtml(labels.backupCount)}:</span> <span class="backup-count-value font-bold">${escapeHtml((gameData.backups || []).length)}</span></p>
                </div>
            </div>
            <div class="modal-window-content">
                <div class="table-container">
                    <table class="w-full text-sm text-left">
                        <thead><tr><th class="p-4">${escapeHtml(labels.backupTime)}</th><th class="p-4">${escapeHtml(labels.backupSize)}</th><th class="p-4 text-center">${escapeHtml(labels.action)}</th></tr></thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>
            </div>
            <div class="modal-footer">
                <button type="button" id="modal-open-backup-folder" class="home-action-button px-4 py-2 text-sm font-bold flex items-center gap-2"><i class="fa-solid fa-folder-open"></i> ${escapeHtml(labels.openBackupFolder)}</button>
            </div>
        </section>
    `;

    const refreshMainTables = () => {
        window.api.send('update-backup-table');
        window.api.send('update-restore-table');
    };

    document.getElementById('modal-open-backup-folder').addEventListener('click', () => window.api.send('open-backup-folder', wikiId));

    root.querySelectorAll('.delete-backup-btn').forEach(button => {
        button.addEventListener('click', async () => {
            const backupDate = button.dataset.backupDate;
            const confirmMessage = (await window.i18n.translate('alert.confirm_delete_backup_message')).replace('{{backup_date}}', formatBackupDate(backupDate));
            const confirmed = await requestConfirmModal(await window.i18n.translate('alert.confirm_delete_backup_title'), confirmMessage);
            if (!confirmed) return;
            const success = await window.api.invoke('delete-backup', wikiId, backupDate);
            if (success) {
                button.closest('tr')?.remove();
                const countElement = root.querySelector('.backup-count-value');
                countElement.textContent = Math.max(0, parseInt(countElement.textContent, 10) - 1);
                refreshMainTables();
            }
        });
    });

    root.querySelectorAll('.permanent-backup-btn').forEach(button => {
        button.addEventListener('click', async () => {
            const backupDate = button.dataset.backupDate;
            const newIsPermanent = button.dataset.isPermanent !== 'true';
            const success = await window.api.invoke('update-backup-info', wikiId, backupDate, 'is_permanent', newIsPermanent);
            if (success) {
                refreshMainTables();
                await renderManageBackupsModal(root, initData);
            }
        });
    });

    root.querySelectorAll('.rename-backup-btn').forEach(button => {
        button.addEventListener('click', () => {
            const row = button.closest('tr');
            row.querySelector('.rename-mode').classList.replace('hidden', 'flex');
            row.querySelector('.backup-date-display').classList.add('hidden');
            const input = row.querySelector('.backup-name-input');
            input.value = row.dataset.customName || '';
            input.focus();
        });
    });

    root.querySelectorAll('.confirm-rename-btn').forEach(button => {
        button.addEventListener('click', async () => {
            const row = button.closest('tr');
            const backupDate = row.dataset.backupDate;
            const customName = row.querySelector('.backup-name-input').value.trim();
            const success = await window.api.invoke('update-backup-info', wikiId, backupDate, 'custom_name', customName);
            if (success) {
                refreshMainTables();
                await renderManageBackupsModal(root, initData);
            }
        });
    });

    root.querySelectorAll('.restore-backup-btn').forEach(button => {
        button.addEventListener('click', async () => {
            const backupDate = button.dataset.backupDate;
            const start = await operationStartCheck('restore');
            if (!start) return;
            const backupInstance = gameData.backups.find(backup => backup.date === backupDate);
            if (!backupInstance) return;
            window.api.send('update-status', 'restoring', true);
            const { error } = await window.api.invoke('restore-game', { ...gameData, backups: [backupInstance] }, null);
            window.api.send('update-status', 'restoring', false);
            refreshMainTables();
            closeModalWindow();
            if (error) showMainAlert('modal', await window.i18n.translate('alert.restore_game_error', { game_name: gameTitle }), error);
            else showMainAlert('success', await window.i18n.translate('main.restore_complete'));
        });
    });
}

async function renderAutoBackupModal(root, initData) {
    const wikiId = initData?.wikiId;
    const settings = await window.api.invoke('get-settings');
    const gameTitle = await getGameTitle(wikiId, settings);
    const autoBackupState = await window.api.invoke('get-auto-backup-state');
    const isActive = !!autoBackupState[wikiId];
    const status = autoBackupState[wikiId] || null;

    const labels = {
        title: await window.i18n.translate('main.auto_backup'),
        enable: await window.i18n.translate('main.auto_backup_enable'),
        disable: await window.i18n.translate('main.auto_backup_disable'),
        modeInterval: await window.i18n.translate('main.auto_backup_mode_interval'),
        modeWatcher: await window.i18n.translate('main.auto_backup_mode_watcher'),
        interval: await window.i18n.translate('main.auto_backup_interval_minutes'),
        mode: await window.i18n.translate('main.auto_backup_mode'),
        statusActive: await window.i18n.translate('main.auto_backup_status_active'),
        statusInactive: await window.i18n.translate('main.auto_backup_status_inactive')
    };

    const currentMode = status ? status.mode : 'interval';
    const currentInterval = status ? (status.intervalMinutes || 30) : 30;

    let statusHtml = '';
    if (isActive) {
        const modeDisplay = status.mode === 'interval'
            ? await window.i18n.translate('main.auto_backup_mode_interval_detail', { minutes: status.intervalMinutes })
            : labels.modeWatcher;
        const backupsPerformed = await window.i18n.translate('main.auto_backup_backups_performed', { count: status.logCount });
        const failedCount = status.failCount > 0
            ? await window.i18n.translate('main.auto_backup_failures', { count: status.failCount })
            : '';
        statusHtml = `
            <div class="mb-6 p-4 bg-xbox-green/10 border border-xbox-green/30 rounded-xl">
                <p class="text-xbox-green font-bold flex items-center gap-2">
                    <i class="fa-solid fa-circle-check"></i>
                    ${escapeHtml(labels.statusActive)} — ${escapeHtml(modeDisplay)}
                </p>
                <p class="text-sm opacity-60 mt-2">${escapeHtml(backupsPerformed)}</p>
                ${failedCount ? `<p class="text-sm text-red-500 mt-1">${escapeHtml(failedCount)}</p>` : ''}
            </div>
        `;
    } else {
        statusHtml = `
            <div class="mb-6 p-4 bg-white/5 border border-white/10 rounded-xl">
                <p class="opacity-40 flex items-center gap-2">
                    <i class="fa-solid fa-circle-xmark"></i>
                    ${escapeHtml(labels.statusInactive)}
                </p>
            </div>
        `;
    }

    await setWindowTitle(labels.title);
    root.innerHTML = `
        <section class="modal-window-panel">
            <div class="modal-window-content">
                <h1 class="text-xl font-bold text-xbox-green mb-6">${escapeHtml(gameTitle)}</h1>
                ${statusHtml}
                <div id="auto-backup-config" class="${isActive ? 'hidden' : 'space-y-6'}">
                    <div>
                        <label class="block mb-3 text-sm font-bold opacity-60 uppercase tracking-widest">${escapeHtml(labels.mode)}</label>
                        <div class="space-y-3">
                            <label class="flex items-center gap-3 cursor-pointer group">
                                <input type="radio" name="auto-backup-mode" value="interval" ${currentMode === 'interval' ? 'checked' : ''} class="accent-xbox-green w-5 h-5">
                                <span class="text-sm font-semibold opacity-80 group-hover:opacity-100">${escapeHtml(labels.modeInterval)}</span>
                            </label>
                            <label class="flex items-center gap-3 cursor-pointer group">
                                <input type="radio" name="auto-backup-mode" value="watcher" ${currentMode === 'watcher' ? 'checked' : ''} class="accent-xbox-green w-5 h-5">
                                <span class="text-sm font-semibold opacity-80 group-hover:opacity-100">${escapeHtml(labels.modeWatcher)}</span>
                            </label>
                        </div>
                    </div>

                    <div id="auto-backup-interval-config" class="${currentMode === 'watcher' ? 'hidden' : ''}">
                        <label class="block mb-2 text-sm font-bold opacity-60 uppercase tracking-widest">${escapeHtml(labels.interval)}</label>
                        <input type="number" id="auto-backup-interval" value="${escapeHtml(currentInterval)}" min="1" class="w-full">
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button id="modal-auto-backup-confirm" type="button" class="${isActive ? 'px-8 py-2 bg-red-600 text-white font-bold rounded-lg hover:bg-red-700' : 'primary-button px-8 py-2'}">
                    ${escapeHtml(isActive ? labels.disable : labels.enable)}
                </button>
            </div>
        </section>
    `;

    root.querySelectorAll('input[name="auto-backup-mode"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const intervalConfig = document.getElementById('auto-backup-interval-config');
            if (radio.value === 'watcher') intervalConfig.classList.add('hidden');
            else intervalConfig.classList.remove('hidden');
            autoResizeWindow();
        });
    });

    const intervalInput = document.getElementById('auto-backup-interval');
    if (intervalInput) wrapNumberInput(intervalInput);

    document.getElementById('modal-auto-backup-confirm').addEventListener('click', async () => {
        if (isActive) {
            const logs = await window.api.invoke('stop-auto-backup', wikiId);
            closeModalWindow();
            if (logs && logs.length > 0) {
                const failedCount = logs.filter(log => !log.success).length;
                const summaryMessage = await window.i18n.translate('main.auto_backup_summary', { total: logs.length, failed: failedCount });
                if (failedCount > 0) {
                    showMainAlert('modal', summaryMessage, logs.filter(log => !log.success).map(log => `[${log.timestamp}] ${log.error}`));
                } else {
                    showMainAlert('success', summaryMessage);
                }
            } else {
                showMainAlert('info', await window.i18n.translate('main.auto_backup_disabled'));
            }
        } else {
            const mode = root.querySelector('input[name="auto-backup-mode"]:checked').value;
            const intervalMinutes = parseInt(document.getElementById('auto-backup-interval').value, 10) || 30;
            await window.api.invoke('start-auto-backup', wikiId, mode, intervalMinutes);
            closeModalWindow();
            showMainAlert('success', await window.i18n.translate('main.auto_backup_enabled'));
        }
    });
}

async function renderLocalSaveModal(root, initData) {
    await setModalLoading(root);
    const wikiId = initData?.wikiId;
    const [settings, gameData] = await Promise.all([
        window.api.invoke('get-settings'),
        window.api.invoke('get-local-save-data', wikiId)
    ]);

    const resolvedPaths = gameData?.resolved_paths || [];
    const gameTitle = gameData?.zh_CN && settings.language === 'zh_CN' ? gameData.zh_CN : gameData?.title;
    const title = gameTitle
        ? await window.i18n.translate('main.local_save_title', { game_name: gameTitle })
        : await window.i18n.translate('main.browse_local_save');

    if (!gameData || resolvedPaths.length === 0) {
        await setWindowTitle(title);
        root.innerHTML = `
            <section class="modal-window-panel">
                <h1 class="text-xl font-bold text-xbox-green mb-6">${escapeHtml(title)}</h1>
                <div class="modal-window-content">
                    <p class="text-sm opacity-60">${escapeHtml(await window.i18n.translate('alert.no_local_save_found'))}</p>
                </div>
            </section>
        `;
        return;
    }

    const labels = {
        title,
        open: await window.i18n.translate('main.open_directory'),
        deleteLocalSave: await window.i18n.translate('main.delete_local_save'),
        type: await window.i18n.translate('main.type'),
        path: await window.i18n.translate('main.path'),
        registry: await window.i18n.translate('main.registry'),
        file: await window.i18n.translate('main.file'),
        folder: await window.i18n.translate('main.folder')
    };

    const rowsHtml = resolvedPaths.map((pathObj, index) => {
        const typeLabel = pathObj.type === 'reg'
            ? labels.registry
            : (pathObj.type === 'file' ? labels.file : labels.folder);
        return `
            <tr class="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td class="p-4 font-bold opacity-70 whitespace-nowrap">${escapeHtml(typeLabel)}</td>
                <td class="p-4 text-xs font-mono break-all opacity-80">${escapeHtml(pathObj.resolved || pathObj.path || '')}</td>
                <td class="p-4 text-right">
                    <button type="button" class="open-local-save-path-btn home-action-button px-3 py-1.5 text-xs font-bold" data-index="${index}">
                        <i class="fa-solid fa-arrow-up-right-from-square mr-1"></i>${escapeHtml(labels.open)}
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    await setWindowTitle(labels.title);
    root.innerHTML = `
        <section class="modal-window-panel">
            <div class="mb-6">
                <h1 class="text-xl font-bold text-xbox-green">${escapeHtml(gameTitle)}</h1>
            </div>
            <div class="modal-window-content">
                <div class="table-container">
                    <table class="w-full text-sm text-left">
                        <thead>
                            <tr>
                                <th class="p-4">${escapeHtml(labels.type)}</th>
                                <th class="p-4">${escapeHtml(labels.path)}</th>
                            </tr>
                        </thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>
            </div>
            <div class="modal-footer">
                <button type="button" id="modal-delete-local-save" class="px-4 py-2 text-sm font-bold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors flex items-center gap-2"><i class="fa-solid fa-trash"></i> ${escapeHtml(labels.deleteLocalSave)}</button>
            </div>
        </section>
    `;

    root.querySelectorAll('.open-local-save-path-btn').forEach(button => {
        button.addEventListener('click', async () => {
            const pathObj = resolvedPaths[Number(button.dataset.index)];
            if (pathObj) window.api.send('browse-local-save', [pathObj]);
        });
    });

    document.getElementById('modal-delete-local-save').addEventListener('click', async () => {
        const confirmed = await requestConfirmModal(await window.i18n.translate('main.delete_local_save'), await window.i18n.translate('alert.confirm_delete_local_save_message'));
        if (!confirmed) return;
        const success = await window.api.invoke('delete-local-save', resolvedPaths);
        if (success) {
            window.api.send('update-backup-table');
            window.api.send('update-restore-table');
            showMainAlert('success', await window.i18n.translate('alert.local_save_deleted'));
            closeModalWindow();
        }
    });
}

async function renderScanFullModal(root) {
    const title = await window.i18n.translate('main.scan_full');
    const explain = await window.i18n.translate('alert.first_launch_full_scan_tip');
    const message = await window.i18n.translate('alert.scan_full_may_take_minutes');
    const confirmLabel = await window.i18n.translate('alert.confirm');

    await setWindowTitle(title);
    root.innerHTML = `
        <section class="modal-window-panel">
            <div class="modal-window-content flex items-start gap-4">
                <img src="../assets_export/information.png" class="w-12 h-12 flex-shrink-0" alt="Info">
                <div>
                    <p class="text-sm opacity-80 leading-relaxed mb-2">${escapeHtml(explain)}
                    <br>
                    ${escapeHtml(message)}</p>
                </div>
            </div>
            <div class="modal-footer">
                <button id="modal-scan-full-confirm" type="button" class="primary-button px-8 py-2">${escapeHtml(confirmLabel)}</button>
            </div>
        </section>
    `;

    document.getElementById('modal-scan-full-confirm').addEventListener('click', async () => {
        const start = await operationStartCheck('scan-full');
        if (!start) return;
        window.api.send('run-scan-full');
        closeModalWindow();
    });
}

function renderDialogContent(content) {
    if (Array.isArray(content)) {
        return content.map(item => {
            if (Array.isArray(item)) {
                return `<ul class="space-y-2 py-2">${item.map(line => `<li class="flex gap-2 opacity-80 text-sm"><i class="fa-solid fa-caret-right text-xbox-green mt-1"></i><span>${escapeHtml(line)}</span></li>`).join('')}</ul>`;
            }
            return `<p class="text-sm opacity-80 leading-relaxed mb-2 whitespace-pre-line">${escapeHtml(item)}</p>`;
        }).join('');
    }

    return `<p class="text-sm opacity-80 leading-relaxed whitespace-pre-line">${escapeHtml(content || '')}</p>`;
}

async function renderDialogModal(root, initData) {
    const title = initData?.title || '';
    const buttons = Array.isArray(initData?.buttons) && initData.buttons.length > 0
        ? initData.buttons.slice(-2)
        : [{ value: true, text: await window.i18n.translate('alert.confirm'), primary: true }];
    const requestId = initData?.requestId;
    const checkbox = initData?.checkbox || null;
    const iconPath = initData?.iconType === 'warning' ? '../assets_export/warning.png' : '../assets_export/information.png';

    await setWindowTitle(title || 'OpenGameSave');

    let buttonsHtml = '';
    for (let index = 0; index < buttons.length; index += 1) {
        const button = buttons[index];
        const text = button.text || (button.i18n ? await window.i18n.translate(button.i18n) : '');
        const buttonClass = button.primary ? 'primary-button px-8 py-2' : 'secondary-button';
        buttonsHtml += `<button type="button" class="modal-dialog-action ${buttonClass}" data-index="${index}">${escapeHtml(text)}</button>`;
    }

    const checkboxHtml = checkbox ? `
        <label class="flex items-center gap-3 cursor-pointer group pt-4">
            <input id="modal-dialog-checkbox" type="checkbox" class="accent-xbox-green w-5 h-5">
            <span class="text-sm font-semibold opacity-80 group-hover:opacity-100">${escapeHtml(checkbox.label || '')}</span>
        </label>
    ` : '';

    root.innerHTML = `
        <section class="modal-window-panel">
            <div class="modal-window-content flex items-start gap-4">
                <img src="${iconPath}" class="w-12 h-12 flex-shrink-0" alt="Icon">
                <div class="flex-1">
                    ${renderDialogContent(initData?.content)}
                    ${checkboxHtml}
                </div>
            </div>
            <div class="modal-footer">${buttonsHtml}</div>
        </section>
    `;

    const finish = (button) => {
        window.api.send('modal-window-dialog-response', requestId, {
            value: button?.value,
            checked: document.getElementById('modal-dialog-checkbox')?.checked || false
        });
    };

    root.querySelectorAll('.modal-dialog-action').forEach(buttonElement => {
        buttonElement.addEventListener('click', () => {
            finish(buttons[Number(buttonElement.dataset.index)]);
        });
    });
}

async function renderConfirmModal(root, initData) {
    const title = initData?.title || '';
    const message = initData?.message || '';
    const requestId = initData?.requestId;
    const confirmLabel = initData?.confirmText || await window.i18n.translate('alert.yes');
    const cancelLabel = initData?.cancelText || await window.i18n.translate('alert.no');

    await setWindowTitle(title || 'OpenGameSave');
    root.innerHTML = `
        <section class="modal-window-panel">
            <div class="modal-window-content flex items-start gap-4">
                <img src="../assets_export/warning.png" class="w-12 h-12 flex-shrink-0" alt="Warning">
                <div class="flex-1">
                    <p class="text-sm opacity-80 leading-relaxed whitespace-pre-line">${escapeHtml(message)}</p>
                </div>
            </div>
            <div class="modal-footer">
                <button id="modal-confirm-cancel" type="button" class="secondary-button">${escapeHtml(cancelLabel)}</button>
                <button id="modal-confirm-ok" type="button" class="primary-button px-8 py-2">${escapeHtml(confirmLabel)}</button>
            </div>
        </section>
    `;

    const finish = (value) => {
        window.api.send('modal-window-confirm-response', requestId, value);
    };

    document.getElementById('modal-confirm-cancel').addEventListener('click', () => finish(false));
    document.getElementById('modal-confirm-ok').addEventListener('click', () => finish(true));
}

async function initModalWindowPage() {
    const root = document.getElementById('modal-root');
    await setModalLoading(root);

    await updateTranslations(document);

    const initData = await window.api.invoke('get-modal-window-data');
    const modalType = initData?.modalType;

    if (modalType === 'export') {
        await renderExportModal(root);
    } else if (modalType === 'import') {
        await renderImportModal(root, initData);
    } else if (modalType === 'account') {
        await renderAccountModal(root);
    } else if (modalType === 'auto-backup') {
        await renderAutoBackupModal(root, initData);
    } else if (modalType === 'manage-backups') {
        await renderManageBackupsModal(root, initData);
    } else if (modalType === 'local-save') {
        await renderLocalSaveModal(root, initData);
    } else if (modalType === 'scan-full') {
        await renderScanFullModal(root);
    } else if (modalType === 'dialog') {
        await renderDialogModal(root, initData);
    } else if (modalType === 'confirm') {
        await renderConfirmModal(root, initData);
    } else {
        root.innerHTML = `<div class="modal-loading-state">Unknown modal: ${escapeHtml(modalType)}</div>`;
    }

    if (modalType !== 'manage-backups' && modalType !== 'local-save') {
        autoResizeWindow();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initModalWindowPage().catch((error) => {
        console.error('Failed to initialize modal window:', error);
        const root = document.getElementById('modal-root');
        root.innerHTML = `<div class="modal-loading-state text-red-400">${escapeHtml(error.message || String(error))}</div>`;
    });
});
