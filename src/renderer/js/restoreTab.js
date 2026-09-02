import { showAlert, updateProgress, operationStartCheck } from './utility.js';
import { showLoadingIndicator, hideLoadingIndicator, createRestoreTableRow, formatSize, updateSelectedCountAndSize, getSelectedWikiIds, updateUninstalledButtonVisibility, queueFullTableUpdate, runWhenDomReady, showOperationSummary, setActionButtonState, populateGameTable } from './commonTabs.js';

const restoreTableDataMap = new Map();
window.restoreTableDataMap = restoreTableDataMap;
let restoreTabInitialized = false;

function initializeRestoreTab() {
    if (restoreTabInitialized) {
        return;
    }
    restoreTabInitialized = true;

    setupRestoreButton();
    void updateRestoreTable(true).catch(console.error);
}

runWhenDomReady(() => {
    initializeRestoreTab();
});

window.api.receive('update-restore-table', () => {
    void updateRestoreTable(true).catch(console.error);
});

function updateRestoreTable(loader) {
    return queueFullTableUpdate('restore', loader, async (showLoader) => {
        if (showLoader) await showLoadingIndicator('restore');
        try {
            const viewModel = await window.api.invoke('get-table-view-model', 'restore');
            await populateRestoreTable(viewModel);
            updateSelectedCountAndSize('restore');
            updateUninstalledButtonVisibility('restore');
        } finally {
            if (showLoader) hideLoadingIndicator('restore');
        }
    });
}

// Function to populate restore table
async function populateRestoreTable(viewModel) {
    const moreLabel = await window.i18n.translate('main.more');
    populateGameTable({
        tabName: 'restore',
        tableDataMap: restoreTableDataMap,
        viewModel,
        createRow: (game, gameTitle) => {
            const backupCount = game.backups.length;
            const backupSize = formatSize(game.backup_size);

            return createRestoreTableRow(gameTitle, backupCount, backupSize, game.latest_backup, game.wiki_page_id, moreLabel);
        },
        hasPermanentBackup: (game) => game.backups.some(backup => backup.is_permanent)
    });
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

        let completed = false;
        try {
            await setActionButtonState({
                button: restoreButton,
                icon: restoreIcon,
                text: restoreText,
                iconName: 'rotate-ccw-clock',
                i18nKey: 'main.restore_in_progress',
                busy: true
            });
            completed = await performRestore();
            if (completed) document.querySelector('#restore-summary-done').classList.remove('hidden');
        } catch (error) {
            console.error('Restore operation failed:', error);
            showAlert('error', error.message || String(error));
        } finally {
            await setActionButtonState({
                button: restoreButton,
                icon: restoreIcon,
                text: restoreText,
                iconName: 'rotate-ccw-clock',
                i18nKey: 'main.restore_selected',
                busy: false
            });
            window.api.send('update-status', 'restoring', false);
        }
        if (!completed) return;

        window.api.send('update-backup-table');
        window.api.send('update-restore-table');
    });
}

async function performRestore() {
    const selectedWikiIds = getSelectedWikiIds('restore');
    const restoreProgressId = 'restore-progress';
    const restoreProgressTitle = await window.api.invoke('translate', 'main.restore_in_progress');
    const totalGames = selectedWikiIds.length;

    const start = await operationStartCheck('restore');
    if (!start) return false;
    window.api.send('update-status', 'restoring', true);
    updateProgress(restoreProgressId, restoreProgressTitle, 'start');

    let restoreCount = 0;
    let restoreFailed = 0;
    let restoreSize = 0;
    const errors = [];
    let globalAction = null;

    try {
        for (const wikiId of selectedWikiIds) {
            const gameData = restoreTableDataMap.get(wikiId);
            let actionForAll = null;
            let newError = null;
            try {
                ({ action: actionForAll, error: newError } = await window.api.invoke('restore-game', gameData, globalAction));
            } catch (error) {
                newError = error.message || String(error);
            }

            // Not counting games that are skipped
            if (newError) {
                restoreFailed += 1;
                restoreCount++;
                errors.push(newError);
            } else if (actionForAll !== 'skip') {
                restoreSize += gameData?.backup_size || 0;
                restoreCount++;
            }

            const progressPercentage = Math.round((restoreCount / totalGames) * 100);
            updateProgress(restoreProgressId, restoreProgressTitle, progressPercentage);

            if (actionForAll) {
                globalAction = actionForAll;
            }
        }

        showOperationSummary('restore', restoreCount, restoreFailed, errors, restoreSize, 'summary.total_restore_failed');
        return true;
    } finally {
        updateProgress(restoreProgressId, restoreProgressTitle, 'end');
        window.api.send('update-status', 'restoring', false);
    }
}
