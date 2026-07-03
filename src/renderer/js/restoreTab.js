import { showAlert, updateProgress, operationStartCheck } from './utility.js';
import { showRestoreConflictDialog } from './dialog.js';
import { spinner, showLoadingIndicator, hideLoadingIndicator, createRestoreTableRow, addOrUpdateTableRow, formatSize, updateSelectedCountAndSize, setupSelectAllCheckbox, getSelectedWikiIds, setIcon, applyTableFilters, updateUninstalledButtonVisibility, runWhenDomReady, getSortedFavoriteGroups, showOperationSummary, appendRows } from './commonTabs.js';

const restoreTableDataMap = new Map();
window.restoreTableDataMap = restoreTableDataMap;
let restoreTabInitialized = false;

window.api.receive('restore-conflict-prompt', async (requestId, prompt) => {
    const result = await showRestoreConflictDialog(prompt);
    window.api.send('restore-conflict-response', requestId, result);
});

function initializeRestoreTab() {
    if (restoreTabInitialized) {
        return;
    }
    restoreTabInitialized = true;

    setupRestoreButton();
    updateRestoreTable(true);
}

runWhenDomReady(() => {
    initializeRestoreTab();
});

window.api.receive('update-restore-table', () => {
    updateRestoreTable(true);
});

async function updateRestoreTable(loader) {
    window.api.send('update-status', 'updating_restore', true);
    if (loader) {
        await showLoadingIndicator('restore');
    }

    const viewModel = await window.api.invoke('get-table-view-model', 'restore');
    await populateRestoreTable(viewModel);
    updateSelectedCountAndSize('restore');
    updateUninstalledButtonVisibility('restore');

    if (loader) {
        hideLoadingIndicator('restore');
    }
    window.api.send('update-status', 'updating_restore', false);
}
window.updateRestoreTable = updateRestoreTable;

// Function to populate restore table
async function populateRestoreTable(viewModel) {
    const restoreTable = document.querySelector('#restore');
    const tableBody = document.querySelector('#restore tbody');
    const selectAllCheckbox = restoreTable.querySelector('#restore-checkbox-all-search');

    const { games: data, settings, autoBackupState } = viewModel;
    const blockedGamesWikiIds = settings.blockedGames || [];
    const uninstalledGamesWikiIds = (settings.uninstalledGames || []).map(String);
    const selectedWikiIds = getSelectedWikiIds('restore');

    tableBody.innerHTML = '';
    restoreTableDataMap.clear();

    const { favoriteGames, otherGames } = getSortedFavoriteGroups(data, settings);

    // Append rows to the table body
    const autoBackupSet = new Set(Object.keys(autoBackupState));

    const rows = [];
    const appendRowsToTable = (games, isFavorite) => {
        games.forEach((game) => {
            const wikiId = game.wiki_page_id;
            restoreTableDataMap.set(wikiId, game);

            let gameTitle = game.title;
            if (game.zh_CN && settings.language === 'zh_CN') {
                gameTitle = game.zh_CN;
            }
            if (!gameTitle) {
                return;
            }

            const backupCount = game.backups.length;
            const backupSize = formatSize(game.backup_size);

            let row = createRestoreTableRow(gameTitle, backupCount, backupSize, game.latest_backup, game.wiki_page_id);

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

            // Check if any backup is permanent
            const hasPermamentBackup = game.backups.some(backup => backup.is_permanent);
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

    setupSelectAllCheckbox('restore', selectAllCheckbox);
    applyTableFilters('restore');
}

function setupRestoreButton() {
    const restoreButton = document.getElementById('restore-button');
    const restoreIcon = document.getElementById('restore-icon');
    const restoreText = document.getElementById('restore-text');

    restoreButton.addEventListener('click', async () => {
        const selectedGames = getSelectedWikiIds('restore');

        if (restoreButton.disabled) return;
        if (selectedGames.length === 0) {
            showAlert('warning', await window.i18n.translate('alert.no_games_selected'));
            return;
        }

        // Disable the button and change the appearance
        restoreButton.disabled = true;
        restoreButton.classList.add('cursor-not-allowed');
        restoreIcon.classList.remove('fa-clock-rotate-left');
        restoreIcon.innerHTML = spinner;
        restoreButton.setAttribute('data-i18n', 'main.restore_in_progress');
        restoreText.textContent = await window.i18n.translate('main.restore_in_progress');

        await performRestore();
        document.querySelector('#restore-summary-done').classList.remove('hidden');

        // Re-enable the button and revert to the original state
        restoreButton.disabled = false;
        restoreButton.classList.remove('cursor-not-allowed');
        restoreIcon.innerHTML = '';
        restoreIcon.classList.add('fa-clock-rotate-left');
        restoreButton.setAttribute('data-i18n', 'main.restore_selected');
        restoreText.textContent = await window.i18n.translate('main.restore_selected');
        window.api.send('update-status', 'restoring', false);

        // Update table rows in background
        (async () => {
            window.api.send('update-status', 'updating_backup', true);
            restoreButton.disabled = true;
            restoreButton.classList.add('cursor-not-allowed');
            restoreIcon.classList.remove('fa-clock-rotate-left');
            restoreIcon.innerHTML = spinner;
            restoreButton.setAttribute('data-i18n', 'main.updating_restore');
            restoreText.textContent = await window.i18n.translate('main.updating_restore');

            for (const wikiId of selectedGames) {
                await addOrUpdateTableRow('backup', wikiId);
            }

            restoreButton.disabled = false;
            restoreButton.classList.remove('cursor-not-allowed');
            restoreIcon.innerHTML = '';
            restoreIcon.classList.add('fa-clock-rotate-left');
            restoreButton.setAttribute('data-i18n', 'main.restore_selected');
            restoreText.textContent = await window.i18n.translate('main.restore_selected');
            window.api.send('update-status', 'updating_backup', false);
        })();
    });
}

async function performRestore() {
    const selectedWikiIds = getSelectedWikiIds('restore');
    const restoreProgressId = 'restore-progress';
    const restoreProgressTitle = await window.api.invoke('translate', 'main.restore_in_progress');
    const totalGames = selectedWikiIds.length;

    const start = await operationStartCheck('restore');
    if (start) {
        window.api.send('update-status', 'restoring', true);
        updateProgress(restoreProgressId, restoreProgressTitle, 'start');

        let restoreCount = 0;
        let restoreFailed = 0;
        let restoreSize = 0;
        let errors = [];
        let globalAction = null;

        for (const wikiId of selectedWikiIds) {
            const gameData = restoreTableDataMap.get(wikiId);
            const { action: actionForAll, error: newError } = await window.api.invoke('restore-game', gameData, globalAction);

            // Not counting games that are skipped
            if (newError) {
                restoreFailed += 1;
                restoreCount++;
                errors.push(newError);
            } else if (actionForAll !== 'skip') {
                restoreSize += gameData.backup_size;
                restoreCount++;
            }

            const progressPercentage = Math.round((restoreCount / totalGames) * 100);
            updateProgress(restoreProgressId, restoreProgressTitle, progressPercentage);

            if (actionForAll) {
                globalAction = actionForAll;
            }
        }

        updateProgress(restoreProgressId, restoreProgressTitle, 'end');
        showRestoreSummary(restoreCount, restoreFailed, errors, restoreSize);
    }
}

export function showRestoreSummary(restoreCount, restoreFailed, errors, restoreSize) {
    showOperationSummary('restore', restoreCount, restoreFailed, errors, restoreSize, 'summary.total_restore_failed');
}
window.showRestoreSummary = showRestoreSummary;
