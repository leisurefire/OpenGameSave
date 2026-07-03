import { showAlert, updateProgress, operationStartCheck } from './utility.js';
import { showMessageDialog } from './dialog.js';
import { spinner, showLoadingIndicator, hideLoadingIndicator, createBackupTableRow, addOrUpdateTableRow, getPlatformIcon, formatSize, updateSelectedCountAndSize, setupSelectAllCheckbox, getSelectedWikiIds, setIcon, applyTableFilters, updateUninstalledButtonVisibility, runWhenDomReady, getSortedFavoriteGroups, showOperationSummary, appendRows } from './commonTabs.js';

const backupTableDataMap = new Map();
window.backupTableDataMap = backupTableDataMap;
let backupTabInitialized = false;

async function initializeBackupTab() {
    if (backupTabInitialized) {
        return;
    }
    backupTabInitialized = true;

    setupBackupTabButtons();

    const settings = await window.api.invoke('get-settings');
    if (settings.autoDbUpdate) {
        await updateDatabase();
    }
    await updateBackupTable(true);

    if (!settings.firstLaunchFullScanTipShown) {
        showMessageDialog(
            await window.i18n.translate('main.scan_full'),
            await window.i18n.translate('alert.first_launch_full_scan_tip')
        );
        window.api.send('save-settings', 'firstLaunchFullScanTipShown', true);
    }
}

runWhenDomReady(() => {
    initializeBackupTab().catch(console.error);
});

window.api.receive('update-backup-table', () => {
    updateBackupTable(true);
});

window.api.receive('run-scan-full', async () => {
    const start = await operationStartCheck('scan-full');
    if (start) {
        const fullScanGameData = await window.api.invoke('start-scan-full');

        if (fullScanGameData) {
            window.api.send('update-status', 'updating_backup', true);
            await showLoadingIndicator('backup');
            let normalScanGameData = await window.api.invoke('fetch-backup-table-data', true);

            const allIds = new Set(fullScanGameData.map(game => game.wiki_page_id));
            const installedGameIds = new Set(normalScanGameData.map(game => game.wiki_page_id));
            const uninstalledGameIds = [...allIds].filter(id => !installedGameIds.has(id));
            if (uninstalledGameIds.length > 0) {
                window.api.send('save-settings', 'uninstalledGames', uninstalledGameIds);
            }

            const viewModel = await window.api.invoke('get-table-view-model', 'backup');
            await populateBackupTable(viewModel);
            updateSelectedCountAndSize('backup');
            hideLoadingIndicator('backup');
            window.api.send('update-status', 'updating_backup', false);
        }
    }
});

export async function updateBackupTable(loader) {
    window.api.send('update-status', 'updating_backup', true);
    if (loader) {
        await showLoadingIndicator('backup');
    }

    const viewModel = await window.api.invoke('get-table-view-model', 'backup');
    await populateBackupTable(viewModel);
    updateSelectedCountAndSize('backup');
    updateUninstalledButtonVisibility('backup');

    if (loader) {
        hideLoadingIndicator('backup');
    }
    window.api.send('update-status', 'updating_backup', false);
}

// Function to populate backup table
async function populateBackupTable(viewModel) {
    const backupTable = document.querySelector('#backup');
    const tableBody = document.querySelector('#backup tbody');
    const selectAllCheckbox = backupTable.querySelector('#backup-checkbox-all-search');

    const { games: data, settings, iconMap, autoBackupState } = viewModel;
    const blockedGamesWikiIds = settings.blockedGames || [];
    const uninstalledGamesWikiIds = (settings.uninstalledGames || []).map(String);
    const selectedWikiIds = getSelectedWikiIds('backup');

    const platformOrder = ['Steam', 'Ubisoft', 'EA', 'Epic', 'GOG', 'Xbox', 'Blizzard'];

    tableBody.innerHTML = '';
    backupTableDataMap.clear();

    const { favoriteGames, otherGames } = getSortedFavoriteGroups(data, settings);

    // Append rows to the table body
    const autoBackupSet = new Set(Object.keys(autoBackupState));

    const rows = [];
    const appendRowsToTable = (games, isFavorite) => {
        games.forEach((game) => {
            const wikiId = game.wiki_page_id;
            backupTableDataMap.set(wikiId, game);

            let gameTitle = game.title;
            if (game.zh_CN && settings.language === 'zh_CN') {
                gameTitle = game.zh_CN;
            }
            if (!gameTitle) {
                return;
            }

            const sortedPlatforms = platformOrder.filter(platform => (game.platform || []).includes(platform));
            const platformIcons = sortedPlatforms.map(platform => getPlatformIcon(platform, iconMap)).join(' ');
            const backupSize = formatSize(game.backup_size);

            let row = createBackupTableRow(gameTitle, platformIcons, backupSize, game.latest_backup, game.wiki_page_id);

            // Check if selected
            if (selectedWikiIds.includes(wikiId)) {
                const checkbox = row.querySelector('.row-checkbox');
                if (checkbox) {
                    checkbox.checked = true;
                }
            }

            // Check if favorite
            if (isFavorite) {
                setIcon(row, 'favorite', true);
            }

            // Check if blocked
            if (blockedGamesWikiIds.includes(wikiId.toString())) {
                row.dataset.blocked = 'true';
                setIcon(row, 'blocked', true);
            }

            // Check if uninstalled
            if (uninstalledGamesWikiIds.includes(wikiId.toString())) {
                row.dataset.uninstalled = 'true';
            }

            // Check if any backup is permanent by looking at restore table data which has is_permanent
            const restoreGameData = window.restoreTableDataMap && window.restoreTableDataMap.get(wikiId);
            const hasPermamentBackup = restoreGameData && restoreGameData.backups && restoreGameData.backups.some(backup => backup.is_permanent);
            if (hasPermamentBackup) {
                setIcon(row, 'star', true);
            }

            // Check if auto backup is active
            if (autoBackupSet.has(wikiId.toString())) {
                setIcon(row, 'timer', true);
            }

            rows.push(row);
        });
    };

    appendRowsToTable(favoriteGames, true);
    appendRowsToTable(otherGames, false);
    appendRows(tableBody, rows);

    setupSelectAllCheckbox('backup', selectAllCheckbox);
    applyTableFilters('backup');
}

function setupBackupTabButtons() {
    const backupButton = document.getElementById('backup-button');
    const backupIcon = document.getElementById('backup-icon');
    const backupText = document.getElementById('backup-text');

    backupButton.addEventListener('click', async () => {
        const selectedGames = getSelectedWikiIds('backup');

        if (backupButton.disabled) return;
        if (selectedGames.length === 0) {
            showAlert('warning', await window.i18n.translate('alert.no_games_selected'));
            return;
        }
        window.api.send('update-status', 'backuping', true);

        // Disable the button and change the appearance
        backupButton.disabled = true;
        backupButton.classList.add('cursor-not-allowed');
        backupIcon.classList.remove('fa-bolt');
        backupIcon.innerHTML = spinner;
        backupButton.setAttribute('data-i18n', 'main.backup_in_progress');
        backupText.textContent = await window.i18n.translate('main.backup_in_progress');

        await performBackup();
        document.querySelector('#backup-summary-done').classList.remove('hidden');

        // Re-enable the button and revert to the original state
        backupButton.disabled = false;
        backupButton.classList.remove('cursor-not-allowed');
        backupIcon.innerHTML = '';
        backupIcon.classList.add('fa-bolt');
        backupButton.setAttribute('data-i18n', 'main.backup_selected');
        backupText.textContent = await window.i18n.translate('main.backup_selected');
        window.api.send('update-status', 'backuping', false);

        // Update table rows in background
        (async () => {
            window.api.send('update-status', 'updating_backup', true);
            window.api.send('update-status', 'updating_restore', true);
            backupButton.disabled = true;
            backupButton.classList.add('cursor-not-allowed');
            backupIcon.classList.remove('fa-bolt');
            backupIcon.innerHTML = spinner;
            backupButton.setAttribute('data-i18n', 'main.updating_backup');
            backupText.textContent = await window.i18n.translate('main.updating_backup');

            for (const wikiId of selectedGames) {
                await addOrUpdateTableRow('backup', wikiId);
                await addOrUpdateTableRow('restore', wikiId);
            }

            backupButton.disabled = false;
            backupButton.classList.remove('cursor-not-allowed');
            backupIcon.innerHTML = '';
            backupIcon.classList.add('fa-bolt');
            backupButton.setAttribute('data-i18n', 'main.backup_selected');
            backupText.textContent = await window.i18n.translate('main.backup_selected');
            window.api.send('update-status', 'updating_backup', false);
            window.api.send('update-status', 'updating_restore', false);
        })();
    });

    document.getElementById('update-database').addEventListener('click', async () => {
        await updateDatabase();
    });
}

async function performBackup() {
    const selectedWikiIds = getSelectedWikiIds('backup');
    const backupProgressId = 'backup-progress';
    const backupProgressTitle = await window.api.invoke('translate', 'main.backup_in_progress');
    const totalGames = selectedWikiIds.length;

    const start = await operationStartCheck('backup');
    if (start) {
        updateProgress(backupProgressId, backupProgressTitle, 'start');

        let backupCount = 0;
        let backupFailed = 0;
        let backupSize = 0;
        let errors = [];

        for (const wikiId of selectedWikiIds) {
            const gameData = backupTableDataMap.get(wikiId);
            const newError = await window.api.invoke('backup-game', gameData);

            if (newError) {
                backupFailed += 1;
                errors.push(newError);
            } else {
                backupSize += gameData.backup_size;
            }

            backupCount++;
            const progressPercentage = Math.round((backupCount / totalGames) * 100);
            updateProgress(backupProgressId, backupProgressTitle, progressPercentage);
        }

        updateProgress(backupProgressId, backupProgressTitle, 'end');
        showBackupSummary(backupCount, backupFailed, errors, backupSize);
    }
}

function showBackupSummary(backupCount, backupFailed, errors, backupSize) {
    showOperationSummary('backup', backupCount, backupFailed, errors, backupSize, 'summary.total_backup_failed');
}

async function updateDatabase() {
    const updateButton = document.getElementById('update-database');
    const updateButtonIcon = document.getElementById('update-database-icon');
    const updateButtonText = document.getElementById('update-database-text');

    if (updateButton.disabled) return;

    const start = await operationStartCheck('update-db');
    if (start) {
        window.api.send('update-status', 'updating_db', true);
        updateButton.disabled = true;
        updateButton.classList.add('cursor-not-allowed');
        updateButtonIcon.innerHTML = spinner;
        updateButtonIcon.classList.remove('fa-rotate');
        updateButton.setAttribute('data-i18n', 'alert.updating_database');
        updateButtonText.textContent = await window.i18n.translate('alert.updating_database');

        await window.api.invoke('update-database');

        window.api.send('update-status', 'updating_db', false);
        updateButton.disabled = false;
        updateButton.classList.remove('cursor-not-allowed');
        updateButtonIcon.innerHTML = '';
        updateButtonIcon.classList.add('fa-rotate');
        updateButton.setAttribute('data-i18n', 'main.update_database');
        updateButtonText.textContent = await window.i18n.translate('main.update_database');
        updateBackupTable(true);
    }
}
