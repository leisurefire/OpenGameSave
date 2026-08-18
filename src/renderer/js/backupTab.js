import { showAlert, updateProgress, operationStartCheck } from './utility.js';
import { showMessageDialog } from './dialog.js';
import { showLoadingIndicator, hideLoadingIndicator, createBackupTableRow, addOrUpdateTableRow, getPlatformIcon, formatSize, updateSelectedCountAndSize, getSelectedWikiIds, updateUninstalledButtonVisibility, queueFullTableUpdate, runWhenDomReady, showOperationSummary, setActionButtonState, populateGameTable } from './commonTabs.js';

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
    void updateBackupTable(true).catch(console.error);
});

window.api.receive('run-scan-full', async () => {
    const start = await operationStartCheck('scan-full');
    if (start) {
        const fullScanGameData = await window.api.invoke('start-scan-full');

        if (fullScanGameData) {
            const normalScanGameData = await window.api.invoke('fetch-backup-table-data', true);

            const allIds = new Set(fullScanGameData.map(game => game.wiki_page_id));
            const installedGameIds = new Set(normalScanGameData.map(game => game.wiki_page_id));
            const uninstalledGameIds = [...allIds].filter(id => !installedGameIds.has(id));
            await window.api.invoke('save-settings', 'uninstalledGames', uninstalledGameIds);
            await updateBackupTable(true);
        }
    }
});

export function updateBackupTable(loader) {
    return queueFullTableUpdate('backup', loader, async (showLoader) => {
        if (showLoader) await showLoadingIndicator('backup');
        try {
            const viewModel = await window.api.invoke('get-table-view-model', 'backup');
            await populateBackupTable(viewModel);
            updateSelectedCountAndSize('backup');
            updateUninstalledButtonVisibility('backup');
        } finally {
            if (showLoader) hideLoadingIndicator('backup');
        }
    });
}

// Function to populate backup table
async function populateBackupTable(viewModel) {
    const platformOrder = ['Steam', 'Ubisoft', 'EA', 'Epic', 'GOG', 'Xbox', 'Blizzard'];

    populateGameTable({
        tabName: 'backup',
        tableDataMap: backupTableDataMap,
        viewModel,
        createRow: (game, gameTitle) => {
            const sortedPlatforms = platformOrder.filter(platform => (game.platform || []).includes(platform));
            const platformIcons = sortedPlatforms.map(platform => getPlatformIcon(platform, viewModel.iconMap)).join(' ');
            const backupSize = formatSize(game.backup_size);

            return createBackupTableRow(gameTitle, platformIcons, backupSize, game.latest_backup, game.wiki_page_id);
        },
        hasPermanentBackup: (game, wikiId) => {
            const restoreGameData = window.restoreTableDataMap && window.restoreTableDataMap.get(wikiId);
            return restoreGameData && restoreGameData.backups && restoreGameData.backups.some(backup => backup.is_permanent);
        }
    });
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

        await setActionButtonState({
            button: backupButton,
            icon: backupIcon,
            text: backupText,
            iconName: 'shield-check',
            i18nKey: 'main.backup_in_progress',
            busy: true
        });

        await performBackup();
        document.querySelector('#backup-summary-done').classList.remove('hidden');

        await setActionButtonState({
            button: backupButton,
            icon: backupIcon,
            text: backupText,
            iconName: 'shield-check',
            i18nKey: 'main.backup_selected',
            busy: false
        });
        window.api.send('update-status', 'backuping', false);

        // Update table rows in background
        (async () => {
            await setActionButtonState({
                button: backupButton,
                icon: backupIcon,
                text: backupText,
                iconName: 'shield-check',
                i18nKey: 'main.updating_backup',
                busy: true
            });

            for (const wikiId of selectedGames) {
                await addOrUpdateTableRow('backup', wikiId);
                await addOrUpdateTableRow('restore', wikiId);
            }

            await setActionButtonState({
                button: backupButton,
                icon: backupIcon,
                text: backupText,
                iconName: 'shield-check',
                i18nKey: 'main.backup_selected',
                busy: false
            });
        })().catch(console.error);
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
        showOperationSummary('backup', backupCount, backupFailed, errors, backupSize, 'summary.total_backup_failed');
    }
}

async function updateDatabase() {
    const updateButton = document.getElementById('update-database');
    const updateButtonIcon = document.getElementById('update-database-icon');
    const updateButtonText = document.getElementById('update-database-text');

    if (updateButton.disabled) return;

    const start = await operationStartCheck('update-db');
    if (start) {
        await setActionButtonState({
            button: updateButton,
            icon: updateButtonIcon,
            text: updateButtonText,
            iconName: 'database-zap',
            i18nKey: 'alert.updating_database',
            busy: true
        });

        try {
            const result = await window.api.invoke('update-database');
            if (result?.success) await updateBackupTable(true);
        } finally {
            await setActionButtonState({
                button: updateButton,
                icon: updateButtonIcon,
                text: updateButtonText,
                iconName: 'database-zap',
                i18nKey: 'main.update_database',
                busy: false
            });
        }
    }
}
