import { operationStartCheck, showAlert, updateTranslations, wrapNumberInput, autoResizeWindow } from './utility.js';
import { createLoadingIndicator } from './loadingIndicator.js';
import { formatSize } from './formatting.js';
import './components/DataTable.js';

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
    root.innerHTML = `<div class="modal-loading-state">${createLoadingIndicator(loadingText)}</div>`;
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
    const browseLabel = await window.i18n.translate('main.browse');

    await setWindowTitle(title);
    root.innerHTML = `
        <section class="modal-window-panel">
            <div class="modal-window-content">
                <div class="modal-setting-card">
                    <div class="modal-setting-row">
                        <div class="modal-setting-copy">
                            <div class="modal-setting-title">${escapeHtml(exportScopeLabel)}</div>
                        </div>
                        <div class="modal-segmented-control" role="radiogroup" aria-label="${escapeHtml(exportScopeLabel)}">
                            <label class="modal-segment-option">
                            <input type="radio" name="export-scope" value="all" checked class="accent-theme-accent">
                                <span>${escapeHtml(exportAllGamesLabel)}</span>
                            </label>
                            <label class="modal-segment-option">
                            <input type="radio" name="export-scope" value="backup" class="accent-theme-accent">
                                <span>${escapeHtml(exportSelectedBackupLabel)}</span>
                            </label>
                        </div>
                    </div>
                    <div class="modal-setting-row">
                        <label for="modal-export-count" class="modal-setting-copy">
                            <span class="modal-setting-title">${escapeHtml(exportCountLabel)}</span>
                        </label>
                        <div class="modal-setting-control">
                            <input type="number" id="modal-export-count" value="1" min="1" max="${escapeHtml(settings?.maxBackups || 1000)}">
                        </div>
                    </div>
                    <div class="modal-setting-row">
                        <label for="modal-export-path" class="modal-setting-copy">
                            <span class="modal-setting-title">${escapeHtml(exportPathLabel)}</span>
                        </label>
                        <div class="modal-path-control">
                            <input type="text" id="modal-export-path" readonly value="${escapeHtml(settings?.exportPath || '')}">
                            <button id="modal-export-select-path" type="button" class="path-picker-button secondary-button" aria-label="${escapeHtml(exportPathLabel)}">
                                <span data-lucide-icon="folder-search"></span><span>${escapeHtml(browseLabel)}</span>
                            </button>
                        </div>
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
    const browseLabel = await window.i18n.translate('main.browse');

    await setWindowTitle(title);
    root.innerHTML = `
        <section class="modal-window-panel">
            <div class="modal-window-content">
                <div class="modal-setting-card">
                    <div class="modal-setting-row">
                        <label for="modal-import-path" class="modal-setting-copy">
                            <span class="modal-setting-title">${escapeHtml(gsmPathLabel)}</span>
                        </label>
                        <div class="modal-path-control">
                            <input type="text" id="modal-import-path" readonly value="${escapeHtml(initData?.gsmPath || '')}">
                            <button id="modal-import-select-path" type="button" class="path-picker-button secondary-button" aria-label="${escapeHtml(gsmPathLabel)}">
                                <span data-lucide-icon="file-input"></span><span>${escapeHtml(browseLabel)}</span>
                            </button>
                        </div>
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
                    <div class="modal-account-row">
                        <span class="modal-account-label">${escapeHtml(platformLabel)}</span>
                        <code class="modal-account-value" title="${escapeHtml(id)}">${escapeHtml(id)}</code>
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
                    <div class="modal-list-card">${accountRows}</div>
                </div>
                <div class="modal-setting-card">
                    <div class="modal-setting-row modal-setting-row-tall">
                        <div class="modal-setting-copy">
                            <div class="modal-setting-title">${escapeHtml(labels.backupScope)}</div>
                            <p class="modal-setting-description">${escapeHtml(labels.accountBackupNote)}</p>
                        </div>
                        <div class="modal-segmented-control" role="radiogroup" aria-label="${escapeHtml(labels.backupScope)}">
                            <label class="modal-segment-option">
                            <input id="backup-scope-current" type="radio" name="backup-scope" ${!isBackupAllAccounts ? 'checked' : ''} class="accent-theme-accent w-5 h-5">
                                <span>${escapeHtml(labels.currentAccountOnly)}</span>
                            </label>
                            <label class="modal-segment-option">
                            <input id="backup-scope-all" type="radio" name="backup-scope" ${isBackupAllAccounts ? 'checked' : ''} class="accent-theme-accent w-5 h-5">
                                <span>${escapeHtml(labels.allAccounts)}</span>
                            </label>
                        </div>
                    </div>
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
    return String(backupDate || '').replace(/^(\d{4})-(\d{1,2})-(\d{1,2})_(\d{1,2})-(\d{1,2})(?:-(\d{1,2}))?$/, (match, year, month, day, hour, minute, second) => {
        const formatted = `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        return second == null ? formatted : `${formatted}:${String(second).padStart(2, '0')}`;
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
        const permanentIcon = backup.is_permanent ? '<span data-lucide-icon="star" class="text-yellow-500 mr-2"></span>' : '';
        const renameIcon = backup.is_permanent ? `<button type="button" class="rename-backup-btn opacity-40 hover:opacity-100 hover:text-theme-accent transition-all ml-2" data-backup-date="${escapeHtml(backup.date)}"><span data-lucide-icon="pencil"></span></button>` : '';
        if (backup.is_permanent && backup.custom_name) {
            return `${permanentIcon}<div class="flex flex-col"><span class="backup-custom-name font-bold text-theme-accent">${escapeHtml(backup.custom_name)}</span><span class="text-xs opacity-50">${escapeHtml(formatBackupDate(backup.date))}</span></div>${renameIcon}`;
        }
        return `${permanentIcon}<span class="backup-date-text font-semibold ${backup.is_permanent ? '' : 'opacity-80'}">${escapeHtml(formatBackupDate(backup.date))}</span>${renameIcon}`;
    };

    const rowsHtml = [...(gameData.backups || [])]
        .sort((a, b) => (a.is_permanent !== b.is_permanent) ? b.is_permanent - a.is_permanent : b.date.localeCompare(a.date))
        .map(backup => `
            <tr data-backup-date="${escapeHtml(backup.date)}" data-custom-name="${escapeHtml(backup.custom_name || '')}">
                <td>
                    <div class="flex items-center">
                        <div class="rename-mode hidden items-center">
                            <input type="text" class="backup-name-input" placeholder="${escapeHtml(labels.enterBackupName)}" />
                            <button type="button" class="confirm-rename-btn" aria-label="${escapeHtml(labels.enterBackupName)}"><span data-lucide-icon="check"></span></button>
                        </div>
                        <div class="backup-date-display flex items-center">${renderDateDisplay(backup)}</div>
                    </div>
                </td>
                <td style="opacity:0.7;font-weight:500">${escapeHtml(formatSize(backup.backup_size))}</td>
                <td>
                    <div style="display:flex;justify-content:flex-end;gap:0.5rem">
                        <button type="button" class="restore-backup-btn btn-action" data-backup-date="${escapeHtml(backup.date)}"><span data-lucide-icon="rotate-ccw-clock"></span> ${escapeHtml(labels.restore)}</button>
                        <button type="button" class="permanent-backup-btn btn-action" data-backup-date="${escapeHtml(backup.date)}" data-is-permanent="${backup.is_permanent}"><span data-lucide-icon="star"></span> ${escapeHtml(backup.is_permanent ? labels.removePermanent : labels.makePermanent)}</button>
                        <button type="button" class="delete-backup-btn btn-danger" data-backup-date="${escapeHtml(backup.date)}"><span data-lucide-icon="trash-2"></span> ${escapeHtml(labels.delete)}</button>
                    </div>
                </td>
            </tr>
        `).join('');

    await setWindowTitle(labels.title);
    root.innerHTML = `
        <section class="modal-window-panel">
            <div class="mb-6">
                <h1 class="text-2xl font-bold text-theme-accent">${escapeHtml(gameTitle || labels.title)}</h1>
                <div class="text-sm opacity-60 mt-1">
                    <p><span class="opacity-60">${escapeHtml(labels.newestBackup)}:</span> <span class="newest-backup-value font-bold">${escapeHtml(gameData.latest_backup || '-')}</span></p>
                    <p><span class="opacity-60">${escapeHtml(labels.backupCount)}:</span> <span class="backup-count-value font-bold">${escapeHtml((gameData.backups || []).length)}</span></p>
                </div>
            </div>
            <div class="modal-window-content" id="manage-backups-table-container">
            </div>
            <div class="modal-footer">
                <button type="button" id="modal-open-backup-folder" class="compact-action-button home-action-button"><span data-lucide-icon="folder-open"></span> ${escapeHtml(labels.openBackupFolder)}</button>
            </div>
        </section>
    `;

    const manageTable = document.createElement('data-table');
    manageTable.setColumns([
        { label: labels.backupTime, width: 'minmax(210px, 1fr)' },
        { label: labels.backupSize, width: '110px' },
        { label: labels.action, width: 'minmax(330px, auto)' }
    ]);
    root.querySelector('#manage-backups-table-container').appendChild(manageTable);
    manageTable.appendRows(rowsHtml);

    const refreshMainTables = () => {
        window.api.send('update-backup-table');
        window.api.send('update-restore-table');
    };

    document.getElementById('modal-open-backup-folder').addEventListener('click', () => window.api.send('open-backup-folder', wikiId));

    manageTable.addEventListener('click', async (event) => {
        const button = event.target.closest('.delete-backup-btn, .permanent-backup-btn, .rename-backup-btn, .confirm-rename-btn, .restore-backup-btn');
        if (!button || !manageTable.contains(button)) {
            return;
        }

        if (button.classList.contains('delete-backup-btn')) {
            const backupDate = button.dataset.backupDate;
            const confirmMessage = (await window.i18n.translate('alert.confirm_delete_backup_message')).replace('{{backup_date}}', formatBackupDate(backupDate));
            const confirmed = await requestConfirmModal(await window.i18n.translate('alert.confirm_delete_backup_title'), confirmMessage);
            if (!confirmed) return;
            const success = await window.api.invoke('delete-backup', wikiId, backupDate);
            if (success) {
                refreshMainTables();
                await renderManageBackupsModal(root, initData);
            }
            return;
        }

        if (button.classList.contains('permanent-backup-btn')) {
            const backupDate = button.dataset.backupDate;
            const newIsPermanent = button.dataset.isPermanent !== 'true';
            const success = await window.api.invoke('update-backup-info', wikiId, backupDate, 'is_permanent', newIsPermanent);
            if (success) {
                refreshMainTables();
                await renderManageBackupsModal(root, initData);
            }
            return;
        }

        if (button.classList.contains('rename-backup-btn')) {
            const row = button.closest('tr');
            row.querySelector('.rename-mode').classList.replace('hidden', 'flex');
            row.querySelector('.backup-date-display').classList.add('hidden');
            const input = row.querySelector('.backup-name-input');
            input.value = row.dataset.customName || '';
            input.focus();
            return;
        }

        if (button.classList.contains('confirm-rename-btn')) {
            const row = button.closest('tr');
            const backupDate = row.dataset.backupDate;
            const customName = row.querySelector('.backup-name-input').value.trim();
            const success = await window.api.invoke('update-backup-info', wikiId, backupDate, 'custom_name', customName);
            if (success) {
                refreshMainTables();
                await renderManageBackupsModal(root, initData);
            }
            return;
        }

        if (button.classList.contains('restore-backup-btn')) {
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
        }
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
            <div class="modal-status-card" data-status="active">
                <p>
                    <span data-lucide-icon="circle-check"></span>
                    ${escapeHtml(labels.statusActive)} — ${escapeHtml(modeDisplay)}
                </p>
                <p class="text-sm opacity-60 mt-2">${escapeHtml(backupsPerformed)}</p>
                ${failedCount ? `<p class="text-sm text-red-500 mt-1">${escapeHtml(failedCount)}</p>` : ''}
            </div>
        `;
    } else {
        statusHtml = `
            <div class="modal-status-card" data-status="inactive">
                <p>
                    <span data-lucide-icon="circle-x"></span>
                    ${escapeHtml(labels.statusInactive)}
                </p>
            </div>
        `;
    }

    await setWindowTitle(labels.title);
    root.innerHTML = `
        <section class="modal-window-panel">
            <div class="modal-window-content">
                <h1 class="text-xl font-bold text-theme-accent mb-6">${escapeHtml(gameTitle)}</h1>
                ${statusHtml}
                <div id="auto-backup-config" class="${isActive ? 'hidden' : 'modal-setting-card'}">
                    <div class="modal-setting-row">
                        <div class="modal-setting-copy">
                            <div class="modal-setting-title">${escapeHtml(labels.mode)}</div>
                        </div>
                        <div class="modal-segmented-control" role="radiogroup" aria-label="${escapeHtml(labels.mode)}">
                            <label class="modal-segment-option">
                                <input type="radio" name="auto-backup-mode" value="interval" ${currentMode === 'interval' ? 'checked' : ''} class="accent-theme-accent w-5 h-5">
                                <span>${escapeHtml(labels.modeInterval)}</span>
                            </label>
                            <label class="modal-segment-option">
                                <input type="radio" name="auto-backup-mode" value="watcher" ${currentMode === 'watcher' ? 'checked' : ''} class="accent-theme-accent w-5 h-5">
                                <span>${escapeHtml(labels.modeWatcher)}</span>
                            </label>
                        </div>
                    </div>

                    <div id="auto-backup-interval-config" class="modal-setting-row ${currentMode === 'watcher' ? 'hidden' : ''}">
                        <label for="auto-backup-interval" class="modal-setting-copy">
                            <span class="modal-setting-title">${escapeHtml(labels.interval)}</span>
                        </label>
                        <div class="modal-setting-control">
                            <input type="number" id="auto-backup-interval" value="${escapeHtml(currentInterval)}" min="1">
                        </div>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button id="modal-auto-backup-confirm" type="button" class="${isActive ? 'danger-button' : 'primary-button px-8 py-2'}">
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
                <h1 class="text-xl font-bold text-theme-accent mb-6">${escapeHtml(title)}</h1>
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
        const openIcon = pathObj.type === 'folder' ? 'folder-open' : 'external-link';
        return `
            <tr>
                <td style="font-weight:bold;opacity:0.7;white-space:nowrap">${escapeHtml(typeLabel)}</td>
                <td style="font-size:0.75rem;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0.8" title="${escapeHtml(pathObj.resolved || pathObj.path || '')}">${escapeHtml(pathObj.resolved || pathObj.path || '')}</td>
                <td>
                    <button type="button" class="open-local-save-path-btn btn-action" data-index="${index}">
                        <span data-lucide-icon="${openIcon}"></span> ${escapeHtml(labels.open)}
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    await setWindowTitle(labels.title);
    root.innerHTML = `
        <section class="modal-window-panel">
            <div class="mb-6">
                <h1 class="text-xl font-bold text-theme-accent">${escapeHtml(gameTitle)}</h1>
            </div>
            <div class="modal-window-content" id="local-save-table-container">
            </div>
            <div class="modal-footer">
                <button type="button" id="modal-delete-local-save" class="danger-button flex items-center gap-2"><span data-lucide-icon="trash-2"></span> ${escapeHtml(labels.deleteLocalSave)}</button>
            </div>
        </section>
    `;

    const localSaveTable = document.createElement('data-table');
    localSaveTable.setColumns([
        { label: labels.type, width: '92px' },
        { label: labels.path, width: 'minmax(0, 1fr)' },
        { label: null, width: '96px' }
    ]);
    root.querySelector('#local-save-table-container').appendChild(localSaveTable);
    localSaveTable.appendRows(rowsHtml);

    localSaveTable.addEventListener('click', (event) => {
        const button = event.target.closest('.open-local-save-path-btn');
        if (!button || !localSaveTable.contains(button)) {
            return;
        }

        const pathIndex = Number(button.dataset.index);
        if (resolvedPaths[pathIndex]) window.api.send('browse-local-save', wikiId, [pathIndex]);
    });

    document.getElementById('modal-delete-local-save').addEventListener('click', async () => {
        const confirmed = await requestConfirmModal(await window.i18n.translate('main.delete_local_save'), await window.i18n.translate('alert.confirm_delete_local_save_message'));
        if (!confirmed) return;
        const success = await window.api.invoke('delete-local-save', wikiId);
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
                <span class="modal-message-icon" data-lucide-icon="info"></span>
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
                return `<ul class="space-y-2 py-2">${item.map(line => `<li class="flex gap-2 opacity-80 text-sm"><span data-lucide-icon="chevron-right" class="text-theme-accent mt-1"></span><span>${escapeHtml(line)}</span></li>`).join('')}</ul>`;
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
    const isWarning = initData?.iconType === 'warning';

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
            <input id="modal-dialog-checkbox" type="checkbox" class="accent-theme-accent w-5 h-5">
            <span class="text-sm font-semibold opacity-80 group-hover:opacity-100">${escapeHtml(checkbox.label || '')}</span>
        </label>
    ` : '';

    root.innerHTML = `
        <section class="modal-window-panel">
            <div class="modal-window-content flex items-start gap-4">
                <span class="modal-message-icon" ${isWarning ? 'data-status="warning" data-lucide-icon="triangle-alert"' : 'data-lucide-icon="info"'}></span>
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
                <span class="modal-message-icon" data-status="warning" data-lucide-icon="triangle-alert"></span>
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
