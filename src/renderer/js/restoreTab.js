import { showAlert, updateProgress, operationStartCheck } from './utility.js';
import { showRestoreConflictDialog } from './dialog.js';
import { showLoadingIndicator, hideLoadingIndicator, createRestoreTableRow, addOrUpdateTableRow, formatSize, updateSelectedCountAndSize, getSelectedWikiIds, updateUninstalledButtonVisibility, runWhenDomReady, showOperationSummary, setActionButtonState, populateGameTable } from './commonTabs.js';

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

// Function to populate restore table
async function populateRestoreTable(viewModel) {
    populateGameTable({
        tabName: 'restore',
        tableDataMap: restoreTableDataMap,
        viewModel,
        createRow: (game, gameTitle) => {
            const backupCount = game.backups.length;
            const backupSize = formatSize(game.backup_size);

            return createRestoreTableRow(gameTitle, backupCount, backupSize, game.latest_backup, game.wiki_page_id);
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

        await setActionButtonState({
            button: restoreButton,
            icon: restoreIcon,
            text: restoreText,
            iconClass: 'fa-clock-rotate-left',
            i18nKey: 'main.restore_in_progress',
            busy: true
        });

        await performRestore();
        document.querySelector('#restore-summary-done').classList.remove('hidden');

        await setActionButtonState({
            button: restoreButton,
            icon: restoreIcon,
            text: restoreText,
            iconClass: 'fa-clock-rotate-left',
            i18nKey: 'main.restore_selected',
            busy: false
        });
        window.api.send('update-status', 'restoring', false);

        // Update table rows in background
        (async () => {
            window.api.send('update-status', 'updating_backup', true);
            await setActionButtonState({
                button: restoreButton,
                icon: restoreIcon,
                text: restoreText,
                iconClass: 'fa-clock-rotate-left',
                i18nKey: 'main.updating_restore',
                busy: true
            });

            for (const wikiId of selectedGames) {
                await addOrUpdateTableRow('backup', wikiId);
            }

            await setActionButtonState({
                button: restoreButton,
                icon: restoreIcon,
                text: restoreText,
                iconClass: 'fa-clock-rotate-left',
                i18nKey: 'main.restore_selected',
                busy: false
            });
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
        showOperationSummary('restore', restoreCount, restoreFailed, errors, restoreSize, 'summary.total_restore_failed');
    }
}
