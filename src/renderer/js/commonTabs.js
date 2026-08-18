import { showAlert, updateTranslations } from './utility.js';
import { showDontShowDialog, showMessageDialog } from './dialog.js';
import { getSortedFavoriteGroups, sortGamesForDisplay } from './tableDisplay.js';
import { initializeTabs } from './tabNavigation.js';
import { createBackupTableRow, createRestoreTableRow, platformOrder } from './tableRows.js';
import {
    getSelectedWikiIds,
    setupSelectAllCheckbox,
    updateSelectAllCheckbox,
    updateSelectedCountAndSize
} from './tableSelection.js';

export { createBackupTableRow, createRestoreTableRow } from './tableRows.js';
export { getSelectedWikiIds, setupSelectAllCheckbox, updateSelectedCountAndSize } from './tableSelection.js';
export { hideLoadingIndicator, setActionButtonState, showLoadingIndicator } from './tableUi.js';
import { formatSize } from './formatting.js';
import { ACTION_ICONS } from './icons.js';
import {
    appendRows as appendVirtualRows,
    applyVirtualFilter,
    findVirtualRow,
    getRowId,
    getVirtualState,
    removeVirtualRow,
    sortVirtualRows
} from './virtualTable.js';

export function runWhenDomReady(callback) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', callback, { once: true });
    } else {
        callback();
    }
}

const tableUpdateStates = new Map();

function getTableUpdateState(tabName) {
    if (!tableUpdateStates.has(tabName)) {
        tableUpdateStates.set(tabName, {
            promise: null,
            fullUpdatePending: false,
            loaderRequested: false,
            loadTable: null,
            rowActions: new Map()
        });
    }
    return tableUpdateStates.get(tabName);
}

async function processTableUpdates(tabName, state) {
    window.api.send('update-status', `updating_${tabName}`, true);
    try {
        while (state.fullUpdatePending || state.rowActions.size > 0) {
            if (state.fullUpdatePending) {
                const loadTable = state.loadTable;
                const loaderRequested = state.loaderRequested;
                state.fullUpdatePending = false;
                state.loaderRequested = false;

                // A full reload includes every row action queued before it.
                // Actions arriving while the reload is in progress remain in
                // the map and are applied to the freshly loaded table.
                state.rowActions.clear();
                if (loadTable) await loadTable(loaderRequested);
                continue;
            }

            const actions = [...state.rowActions.values()];
            state.rowActions.clear();
            for (const action of actions) {
                if (action.type === 'remove') {
                    performRemoveTableRow(tabName, action.wikiId);
                } else {
                    await performAddOrUpdateTableRow(tabName, action.wikiId);
                }
            }
        }
    } finally {
        window.api.send('update-status', `updating_${tabName}`, false);
    }
}

function scheduleTableUpdates(tabName, state) {
    if (!state.promise) {
        state.promise = processTableUpdates(tabName, state)
            .catch(error => {
                console.error(`Failed to update ${tabName} table:`, error);
                state.fullUpdatePending = false;
                state.loaderRequested = false;
                state.rowActions.clear();
                throw error;
            })
            .finally(() => {
                state.promise = null;
            });
    }
    return state.promise;
}

export function queueFullTableUpdate(tabName, loader, loadTable) {
    const state = getTableUpdateState(tabName);
    state.fullUpdatePending = true;
    state.loaderRequested = state.loaderRequested || Boolean(loader);
    state.loadTable = loadTable;
    return scheduleTableUpdates(tabName, state);
}

export function appendRows(tableBody, rows) {
    appendVirtualRows(tableBody, rows, { rowHeight: 60 });
}

runWhenDomReady(() => {
    updateTranslations(document);
    initializeTabs();
    setupSearchFilter('backup');
    setupSearchFilter('restore');
    setDropDownAction();
});

window.api.receive('apply-language', () => {
    updateTranslations(document);
    updateSelectedCountAndSize('backup');
    updateSelectedCountAndSize('restore');
});

// Auto backup IPC receivers
window.api.receive('auto-backup-started', (wikiId) => {
    setTableRowIcon('backup', wikiId, 'timer', true);
    setTableRowIcon('restore', wikiId, 'timer', true);
});

window.api.receive('auto-backup-stopped', (wikiId) => {
    setTableRowIcon('backup', wikiId, 'timer', false);
    setTableRowIcon('restore', wikiId, 'timer', false);
});

window.api.receive('auto-backup-performed', async (wikiId) => {
    try {
        if (window.backupTableDataMap) {
            await addOrUpdateTableRow('backup', wikiId);
        }
        if (window.restoreTableDataMap) {
            await addOrUpdateTableRow('restore', wikiId);
        }
    } catch (error) {
        console.error('Failed to refresh auto-backup table rows:', error);
    }
});


function setupSearchFilter(tabName) {
    const searchInput = document.getElementById(`${tabName}-search`);
    const favoritesButton = document.getElementById(`${tabName}-favorites-only`);
    const blockedButton = document.getElementById(`${tabName}-blocked-only`);
    const uninstalledButton = document.getElementById(`${tabName}-uninstalled-only`);
    const tableBody = document.querySelector(`#${tabName} tbody`);
    const selectAllCheckbox = document.getElementById(`${tabName}-checkbox-all-search`);

    // Hide or show the uninstalled button based on settings
    window.api.invoke('get-settings').then((settings) => {
        if (uninstalledButton) {
            uninstalledButton.classList.toggle('hidden', !settings.saveUninstalledGames);
        }
    });

    const applyFilters = () => {
        const filter = searchInput.value.toLowerCase();
        const favoritesOnly = favoritesButton?.dataset.favoritesActive === 'true';
        const blockedOnly = blockedButton?.dataset.blockedActive === 'true';
        const uninstalledOnly = uninstalledButton?.dataset.uninstalledActive === 'true';
        const rows = tableBody.querySelectorAll('tr');

        const dataMap = tabName === 'backup' ? window.backupTableDataMap : window.restoreTableDataMap;

        const rowMatchesFilters = (row) => {
            // Match against both English and Chinese names, regardless of the
            // displayed language. Fall back to the visible cell text if the
            // game data isn't available in the data map.
            const gameData = dataMap && dataMap.get(row.getAttribute('data-wiki-id'));
            const searchTargets = [];
            if (gameData) {
                if (gameData.title) searchTargets.push(gameData.title);
                if (gameData.zh_CN) searchTargets.push(gameData.zh_CN);
            }
            if (searchTargets.length === 0) {
                const gameNameCell = row.querySelector('th[scope="row"]');
                if (gameNameCell) searchTargets.push(gameNameCell.textContent);
            }

            const matchesSearch = searchTargets.some(name => name.toLowerCase().includes(filter));
            const isFavorite = !row.querySelector('span[data-icon="favorite"].hidden');
            const isBlocked = row.dataset.blocked === 'true';
            const isUninstalled = row.dataset.uninstalled === 'true';
            const matchesFavorite = !favoritesOnly || isFavorite;
            const matchesBlocked = blockedOnly ? isBlocked : !isBlocked;
            const matchesUninstalled = !uninstalledOnly || isUninstalled;
            return matchesSearch && matchesFavorite && matchesBlocked && matchesUninstalled;
        };

        const virtualState = getVirtualState(tableBody);
        if (virtualState) {
            applyVirtualFilter(tableBody, rowMatchesFilters);
        } else {
            rows.forEach(row => {
                row.style.display = rowMatchesFilters(row) ? '' : 'none';
            });
        }

        if (selectAllCheckbox) {
            updateSelectAllCheckbox(selectAllCheckbox, tableBody);
        }
        updateSelectedCountAndSize(tabName);
    };

    searchInput.addEventListener('input', applyFilters);

    if (favoritesButton) {
        favoritesButton.addEventListener('click', () => {
            const isActive = favoritesButton.dataset.favoritesActive === 'true';
            favoritesButton.dataset.favoritesActive = (!isActive).toString();
            favoritesButton.setAttribute('aria-pressed', (!isActive).toString());
            favoritesButton.classList.toggle('text-red-400', !isActive);
            favoritesButton.classList.toggle('opacity-100', !isActive);
            favoritesButton.classList.toggle('opacity-70', isActive);
            applyFilters();
        });
    }

    if (blockedButton) {
        blockedButton.addEventListener('click', () => {
            const isActive = blockedButton.dataset.blockedActive === 'true';
            blockedButton.dataset.blockedActive = (!isActive).toString();
            blockedButton.setAttribute('aria-pressed', (!isActive).toString());
            blockedButton.classList.toggle('text-yellow-400', !isActive);
            blockedButton.classList.toggle('opacity-100', !isActive);
            blockedButton.classList.toggle('opacity-70', isActive);
            applyFilters();
        });
    }

    if (uninstalledButton) {
        uninstalledButton.addEventListener('click', () => {
            const isActive = uninstalledButton.dataset.uninstalledActive === 'true';
            uninstalledButton.dataset.uninstalledActive = (!isActive).toString();
            uninstalledButton.setAttribute('aria-pressed', (!isActive).toString());
            uninstalledButton.classList.toggle('text-blue-400', !isActive);
            uninstalledButton.classList.toggle('opacity-100', !isActive);
            uninstalledButton.classList.toggle('opacity-70', isActive);
            applyFilters();
        });
    }
}

export function applyTableFilters(tabName) {
    document.getElementById(`${tabName}-search`)?.dispatchEvent(new Event('input'));
}

// Update the visibility of the "Uninstalled" filter button based on settings
export async function updateUninstalledButtonVisibility(tabName) {
    const uninstalledButton = document.getElementById(`${tabName}-uninstalled-only`);
    if (uninstalledButton) {
        const settings = await window.api.invoke('get-settings');
        uninstalledButton.classList.toggle('hidden', !settings.saveUninstalledGames);
        // If hiding the button, also deactivate the filter
        if (!settings.saveUninstalledGames && uninstalledButton.dataset.uninstalledActive === 'true') {
            uninstalledButton.dataset.uninstalledActive = 'false';
            uninstalledButton.classList.remove('text-blue-400', 'opacity-100');
            uninstalledButton.classList.add('opacity-70');
            applyTableFilters(tabName);
        }
    }
}

export function isBlockedViewActive(tabName) {
    return document.getElementById(`${tabName}-blocked-only`)?.dataset.blockedActive === 'true';
}

export function setIcon(row, iconName, show) {
    const titleCell = row.querySelector('th[scope="row"]');
    if (!titleCell) return;

    const iconSpan = titleCell.querySelector(`span[data-icon="${iconName}"]`);
    if (iconSpan) {
        iconSpan.classList.toggle('hidden', !show);
    }
}

function getTableRow(tabName, wikiId) {
    const tableBody = document.querySelector(`#${tabName} tbody`);
    return tableBody?.querySelector(`tr[data-wiki-id="${wikiId}"]`) || findVirtualRow(tableBody, wikiId);
}

function setTableRowIcon(tabName, wikiId, iconName, show) {
    const row = getTableRow(tabName, wikiId);
    if (row) {
        setIcon(row, iconName, show);
    }
}

function isFavoriteRow(row) {
    return !row.querySelector('span[data-icon="favorite"].hidden');
}

function sortRowsForTable(rows, settings) {
    const sortRows = (rowsToSort) => sortGamesForDisplay(
        rowsToSort.map(row => ({
            row,
            wikiId: getRowId(row),
            titleToSort: row.querySelector('.game-title')?.textContent.trim() || ''
        })),
        settings
    ).map(item => item.row);

    return [
        ...sortRows(rows.filter(isFavoriteRow)),
        ...sortRows(rows.filter(row => !isFavoriteRow(row)))
    ];
}

export function getPlatformIcon(platform, iconMap) {
    return iconMap[platform] || '';
}

export { formatSize };

export function populateGameTable({
    tabName,
    tableDataMap,
    viewModel,
    createRow,
    hasPermanentBackup = () => false
}) {
    const table = document.querySelector(`#${tabName}`);
    const tableBody = document.querySelector(`#${tabName} tbody`);
    const selectAllCheckbox = table.querySelector(`#${tabName}-checkbox-all-search`);

    const { games: data, settings, autoBackupState } = viewModel;
    const blockedGamesWikiIds = settings.blockedGames || [];
    const uninstalledGamesWikiIds = (settings.uninstalledGames || []).map(String);
    const selectedWikiIds = new Set(getSelectedWikiIds(tabName).map(String));
    const autoBackupSet = new Set(Object.keys(autoBackupState));

    tableBody.innerHTML = '';
    tableDataMap.clear();

    const { favoriteGames, otherGames } = getSortedFavoriteGroups(data, settings);
    const rows = [];

    const appendRowsToTable = (games, isFavorite) => {
        games.forEach((game) => {
            const wikiId = game.wiki_page_id;
            tableDataMap.set(wikiId, game);

            const gameTitle = game.zh_CN && settings.language === 'zh_CN'
                ? game.zh_CN
                : game.title;
            if (!gameTitle) {
                return;
            }

            const row = createRow(game, gameTitle);

            if (selectedWikiIds.has(wikiId.toString())) {
                const checkbox = row.querySelector('.row-checkbox');
                if (checkbox) {
                    checkbox.checked = true;
                }
            }

            if (isFavorite) {
                setIcon(row, 'favorite', true);
            }

            if (blockedGamesWikiIds.includes(wikiId.toString())) {
                row.dataset.blocked = 'true';
                setIcon(row, 'blocked', true);
            }

            if (uninstalledGamesWikiIds.includes(wikiId.toString())) {
                row.dataset.uninstalled = 'true';
            }

            if (hasPermanentBackup(game, wikiId)) {
                setIcon(row, 'star', true);
            }

            if (autoBackupSet.has(wikiId.toString())) {
                setIcon(row, 'timer', true);
            }

            rows.push(row);
        });
    };

    appendRowsToTable(favoriteGames, true);
    appendRowsToTable(otherGames, false);
    appendRows(tableBody, rows);

    setupSelectAllCheckbox(tabName, selectAllCheckbox);
    applyTableFilters(tabName);
}

export function showOperationSummary(tabName, completedCount, failedCount, errors, totalSize, failedMessageKey) {
    const summary = document.querySelector(`#${tabName}-summary`);
    const content = document.querySelector(`#${tabName}-content`);
    const failedContainer = document.querySelector(`#${tabName}-summary-total-failed-container`);
    summary.classList.remove('hidden');
    content.classList.add('hidden');

    window.api.invoke('get-settings').then(async (settings) => {
        if (!settings) return;

        document.getElementById(`${tabName}-summary-total-games`).textContent = completedCount;
        document.getElementById(`${tabName}-summary-total-size`).textContent = formatSize(totalSize);
        document.getElementById(`${tabName}-summary-save-path`).textContent = settings.backupPath;

        if (failedCount > 0) {
            const failedMessage = await window.i18n.translate(failedMessageKey, {
                failed_count: failedCount
            });
            document.getElementById(`${tabName}-summary-total-failed`).textContent = failedMessage;
            document.getElementById(`${tabName}-failed-learn-more`).onclick = () => {
                showMessageDialog(failedMessage, [errors]);
            };
            failedContainer.classList.remove('hidden');
        } else {
            failedContainer.classList.add('hidden');
        }
    });

    document.querySelector(`#${tabName}-summary-done`).onclick = (event) => {
        content.classList.remove('animate-fadeInShift', 'animate-fadeOut');
        summary.classList.add('hidden');
        content.classList.remove('hidden');
        event.target.closest('button').classList.add('hidden');
    };
}

async function performAddOrUpdateTableRow(tabName, wikiId) {
    const dataMap = tabName === 'backup' ? window.backupTableDataMap : window.restoreTableDataMap;
    const tableBody = document.querySelector(`#${tabName} tbody`);
    if (!dataMap || !tableBody) {
        return;
    }

    let gameData;
    if (tabName === 'backup') {
        const games = await window.api.invoke('fetch-backup-table-data', null, wikiId);
        gameData = games && games.length > 0 ? games[0] : null;
    } else {
        const games = await window.api.invoke('fetch-restore-table-data', wikiId);
        gameData = games && games.length > 0 ? games[0] : null;
    }
    if (!gameData) return;

    dataMap.set(wikiId, gameData);

    const existingRow = getTableRow(tabName, wikiId);

    if (existingRow) {
        // Update existing row cells
        const sizeCell = existingRow.querySelector('.backup-size');
        if (sizeCell) sizeCell.textContent = formatSize(gameData.backup_size);
        const timeCell = existingRow.querySelector('.newest-backup-time');
        if (timeCell) timeCell.textContent = gameData.latest_backup;
        if (tabName === 'restore') {
            const countCell = existingRow.querySelector('.backup-count');
            if (countCell) countCell.textContent = gameData.backups.length;
        }
    } else {
        // Create and append new row
        const settings = await window.api.invoke('get-settings');
        let gameTitle = gameData.title;
        if (gameData.zh_CN && settings.language === 'zh_CN') {
            gameTitle = gameData.zh_CN;
        }
        if (!gameTitle) return;

        let row;
        if (tabName === 'backup') {
            const iconMap = await window.api.invoke('get-icon-map');
            const sortedPlatforms = platformOrder.filter(platform => (gameData.platform || []).includes(platform));
            const platformIcons = sortedPlatforms.map(platform => getPlatformIcon(platform, iconMap)).join(' ');
            row = createBackupTableRow(gameTitle, platformIcons, formatSize(gameData.backup_size), gameData.latest_backup, wikiId);

            const restoreGameData = window.restoreTableDataMap && window.restoreTableDataMap.get(wikiId);
            const hasPermanent = restoreGameData && restoreGameData.backups && restoreGameData.backups.some(b => b.is_permanent);
            if (hasPermanent) setIcon(row, 'star', true);
        } else {
            row = createRestoreTableRow(gameTitle, gameData.backups.length, formatSize(gameData.backup_size), gameData.latest_backup, wikiId);

            const hasPermanent = gameData.backups.some(b => b.is_permanent);
            if (hasPermanent) setIcon(row, 'star', true);
        }

        const favoriteGamesWikiIds = settings.pinnedGames || [];
        const isFavorite = favoriteGamesWikiIds.includes(wikiId.toString());
        if (isFavorite) {
            setIcon(row, 'favorite', true);
        }

        const blockedGamesWikiIds = settings.blockedGames || [];
        if (blockedGamesWikiIds.includes(wikiId.toString())) {
            row.dataset.blocked = 'true';
            setIcon(row, 'blocked', true);
        }

        const uninstalledGamesWikiIds = (settings.uninstalledGames || []).map(String);
        if (uninstalledGamesWikiIds.includes(wikiId.toString())) {
            row.dataset.uninstalled = 'true';
        }

        // Check if auto backup is active
        const autoBackupState = await window.api.invoke('get-auto-backup-state');
        if (autoBackupState[wikiId.toString()]) {
            setIcon(row, 'timer', true);
        }

        // Insert row in sorted position
        if (getVirtualState(tableBody)) {
            getVirtualState(tableBody).allRows.push(row);
            sortVirtualRows(tableBody, rows => sortRowsForTable(rows, settings));
            applyTableFilters(tabName);
            return;
        }

        const siblingRows = Array.from(tableBody.querySelectorAll('tr'))
            .filter(r => !r.dataset.virtualSpacer)
            .filter(r => {
                const favorite = isFavoriteRow(r);
                return isFavorite ? favorite : !favorite;
            })
            .concat({ getAttribute: () => wikiId.toString(), querySelector: () => ({ textContent: gameTitle }) })
            .map(r => ({
                wikiId: r.getAttribute('data-wiki-id'),
                titleToSort: r.querySelector('.game-title')?.textContent.trim() || ''
            }));

        const sorted = sortGamesForDisplay(siblingRows, settings);
        const targetIndex = sorted.findIndex(g => g.wikiId === wikiId.toString());

        if (isFavorite) {
            // Insert among favorite rows
            if (targetIndex === 0) {
                tableBody.insertBefore(row, tableBody.firstChild);
            } else {
                const prevRow = tableBody.querySelector(`tr[data-wiki-id="${sorted[targetIndex - 1].wikiId}"]`);
                tableBody.insertBefore(row, prevRow.nextSibling);
            }
        } else {
            // Insert among non-favorite rows
            if (targetIndex === 0) {
                const lastFavoriteRow = Array.from(tableBody.querySelectorAll('tr'))
                    .filter(r => !r.dataset.virtualSpacer)
                    .reverse()
                    .find(isFavoriteRow);
                if (lastFavoriteRow) {
                    tableBody.insertBefore(row, lastFavoriteRow.nextSibling);
                } else {
                    tableBody.insertBefore(row, tableBody.firstChild);
                }
            } else {
                const prevRow = tableBody.querySelector(`tr[data-wiki-id="${sorted[targetIndex - 1].wikiId}"]`);
                tableBody.insertBefore(row, prevRow.nextSibling);
            }
        }
    }

    applyTableFilters(tabName);
}

export function addOrUpdateTableRow(tabName, wikiId) {
    const state = getTableUpdateState(tabName);
    const normalizedWikiId = String(wikiId);
    state.rowActions.set(normalizedWikiId, { type: 'update', wikiId: normalizedWikiId });
    return scheduleTableUpdates(tabName, state);
}

// Helper function to remove a game row from a tab's table and clean up its data map
function performRemoveTableRow(tabName, wikiId) {
    const tableBody = document.querySelector(`#${tabName} tbody`);
    const dataMap = tabName === 'backup' ? window.backupTableDataMap : window.restoreTableDataMap;
    if (!dataMap || !tableBody) {
        return;
    }

    if (!removeVirtualRow(tableBody, wikiId)) {
        const row = tableBody?.querySelector(`tr[data-wiki-id="${wikiId}"]`);
        if (row) {
            row.remove();
        }
    }
    dataMap.delete(wikiId);
    updateSelectedCountAndSize(tabName);
}

export function removeTableRow(tabName, wikiId) {
    const state = getTableUpdateState(tabName);
    const normalizedWikiId = String(wikiId);
    state.rowActions.set(normalizedWikiId, { type: 'remove', wikiId: normalizedWikiId });
    return scheduleTableUpdates(tabName, state);
}

window.api.receive('execute-menu-action', async (action, data) => {
    window.activeMenuTrigger = null;
    if (action === 'add-favorite') {
        const wikiId = data;
        const settings = await window.api.invoke('get-settings');
        let favorite_games_wiki_ids = new Set(settings['pinnedGames']);
        favorite_games_wiki_ids.add(wikiId);
        window.api.send('save-settings', 'pinnedGames', Array.from(favorite_games_wiki_ids));
        addGameToFavorites('backup', wikiId);
        addGameToFavorites('restore', wikiId);
    } else if (action === 'unfavorite') {
        const wikiId = data;
        const settings = await window.api.invoke('get-settings');
        let favorite_games_wiki_ids = new Set(settings['pinnedGames']);
        favorite_games_wiki_ids.delete(wikiId);
        window.api.send('save-settings', 'pinnedGames', Array.from(favorite_games_wiki_ids));
        removeGameFromFavorites('backup', wikiId);
        removeGameFromFavorites('restore', wikiId);
    } else if (action === 'block-game') {
        const wikiId = data;
        const settings = await window.api.invoke('get-settings');
        if (!settings.blockedGameTipDismissed) {
            const tipResult = await showDontShowDialog(
                await window.i18n.translate('main.block_game'),
                await window.i18n.translate('alert.blocked_game_tip')
            );
            if (tipResult === false) {
                return;
            }
            if (tipResult === 'dont-show') {
                window.api.send('save-settings', 'blockedGameTipDismissed', true);
            }
        }
        let blocked_games_wiki_ids = new Set(settings.blockedGames || []);
        blocked_games_wiki_ids.add(wikiId);
        window.api.send('save-settings', 'blockedGames', Array.from(blocked_games_wiki_ids));
        updateGameBlockedState('backup', wikiId, true);
        updateGameBlockedState('restore', wikiId, true);
    } else if (action === 'unblock-game') {
        const wikiId = data;
        const settings = await window.api.invoke('get-settings');
        let blocked_games_wiki_ids = new Set(settings.blockedGames || []);
        blocked_games_wiki_ids.delete(wikiId);
        window.api.send('save-settings', 'blockedGames', Array.from(blocked_games_wiki_ids));
        updateGameBlockedState('backup', wikiId, false);
        updateGameBlockedState('restore', wikiId, false);
    } else if (action === 'open-wiki') {
        if (data && data !== 'none') window.api.invoke('open-url', data);
        else showAlert('warning', await window.i18n.translate('alert.no_wiki_url'));
    } else if (action === 'manage-local-data') {
        window.api.send('open-modal-window', 'local-save', { wikiId: data });
    } else if (action === 'manage-backups') {
        window.api.send('open-modal-window', 'manage-backups', { wikiId: data });
    } else if (action === 'auto-backup') {
        window.api.send('open-modal-window', 'auto-backup', { wikiId: data });
    } else if (action === 'settings') {
        window.api.send('open-settings-window');
    } else if (action === 'view-account-ids') {
        window.api.send('view-account-ids');
    } else if (action === 'scan-full') {
        window.api.send('scan-full');
    } else if (action === 'about') {
        window.api.send('open-about-window');
    }
});

function setDropDownAction() {
    document.addEventListener('click', async (event) => {
        const button = event.target.closest('.dropdown-menu-button');

        if (button) {
            event.stopPropagation();
            if (button === window.activeMenuTrigger) {
                // Clicking the same button again should hide the menu
                window.api.send('hide-popup-menu');
                window.activeMenuTrigger = null;
                return;
            }

            const row = button.closest('tr');
            const wikiPageId = row.getAttribute('data-wiki-id');
            const tabName = button.closest('#backup, #restore, #custom')?.id || 'backup';

            const settings = await window.api.invoke('get-settings');
            const isFavorite = (settings.pinnedGames || []).includes(wikiPageId.toString());
            const isBlocked = (settings.blockedGames || []).includes(wikiPageId.toString());
            const wikiUrl = !wikiPageId.includes('-') ? `https://www.pcgamingwiki.com/wiki/index.php?curid=${wikiPageId}` : 'none';

            const menuItems = [
                {
                    label: await window.i18n.translate(isFavorite ? 'main.remove_favorite' : 'main.add_favorite'),
                    icon: isFavorite ? 'heart-crack' : 'heart',
                    action: isFavorite ? 'unfavorite' : 'add-favorite',
                    data: wikiPageId
                },
                {
                    label: await window.i18n.translate(isBlocked ? 'main.unblock_game' : 'main.block_game'),
                    icon: isBlocked ? 'eye' : 'ban',
                    action: isBlocked ? 'unblock-game' : 'block-game',
                    data: wikiPageId
                },
                {
                    label: await window.i18n.translate('main.auto_backup'),
                    icon: 'timer-reset',
                    action: 'auto-backup',
                    data: wikiPageId,
                    visible: tabName !== 'restore'
                },
                {
                    label: await window.i18n.translate('main.manage_backups'),
                    icon: 'list-checks',
                    action: 'manage-backups',
                    data: wikiPageId
                },
                {
                    label: await window.i18n.translate('main.browse_local_save'),
                    icon: ACTION_ICONS.manageLocalData,
                    action: 'manage-local-data',
                    data: wikiPageId
                },
                {
                    label: await window.i18n.translate('main.view_wiki'),
                    icon: 'globe',
                    action: 'open-wiki',
                    data: wikiUrl
                }
            ].filter(item => item.visible !== false);

            const rect = button.getBoundingClientRect();
            const menuGap = 4;
            const estimatedMenuHeight = menuItems.length * 34 + 10;
            const availableAbove = rect.top;
            const availableBelow = window.innerHeight - rect.bottom;
            // Open upward only when the measured row count will not fit below
            // and the upper side genuinely has more room. The previous fixed
            // 260px threshold made menus jump upward much too early.
            const shouldOpenUp = availableBelow < estimatedMenuHeight + menuGap
                && availableAbove > availableBelow;
            window.api.send('show-popup-menu', {
                items: menuItems,
                x: rect.right + 4,
                y: shouldOpenUp ? rect.top - menuGap : rect.bottom + menuGap,
                direction: shouldOpenUp ? 'up' : 'down'
            });
            window.activeMenuTrigger = button;
            return;
        }
    });

    // Close on scroll in either table
    ['#backup .table-container', '#restore .table-container'].forEach(selector => {
        const el = document.querySelector(selector);
        if (el) el.addEventListener('scroll', () => {
            window.api.send('hide-popup-menu');
            window.activeMenuTrigger = null;
        });
    });
}

async function addGameToFavorites(tabName, wikiId) {
    const tableBody = document.querySelector(`#${tabName} tbody`);
    const rowToMove = getTableRow(tabName, wikiId);

    if (rowToMove) {
        const settings = await window.api.invoke('get-settings');
        setIcon(rowToMove, 'favorite', true);

        if (sortVirtualRows(tableBody, rows => sortRowsForTable(rows, settings))) {
            document.getElementById(`${tabName}-search`)?.dispatchEvent(new Event('input'));
            return;
        }

        tableBody.removeChild(rowToMove);

        const favoriteGames = Array.from(tableBody.querySelectorAll('tr'))
            .filter(row => !row.dataset.virtualSpacer)
            .filter(isFavoriteRow)
            .concat(rowToMove)
            .map(row => ({
                wikiId: row.getAttribute('data-wiki-id'),
                titleToSort: row.querySelector('.game-title')?.textContent.trim() || ''
            }));

        const sortedFavoriteGames = sortGamesForDisplay(favoriteGames, settings);
        const targetIndex = sortedFavoriteGames.findIndex(game => game.wikiId === wikiId);

        if (targetIndex === 0) {
            tableBody.insertBefore(rowToMove, tableBody.firstChild);
        } else {
            const previousRowId = sortedFavoriteGames[targetIndex - 1].wikiId;
            const previousRow = tableBody.querySelector(`tr[data-wiki-id="${previousRowId}"]`);
            tableBody.insertBefore(rowToMove, previousRow.nextSibling);
        }

        document.getElementById(`${tabName}-search`)?.dispatchEvent(new Event('input'));
    }
}

async function removeGameFromFavorites(tabName, wikiId) {
    const tableBody = document.querySelector(`#${tabName} tbody`);
    const rowToMove = getTableRow(tabName, wikiId);

    if (rowToMove) {
        const settings = await window.api.invoke('get-settings');
        setIcon(rowToMove, 'favorite', false);

        if (sortVirtualRows(tableBody, rows => sortRowsForTable(rows, settings))) {
            document.getElementById(`${tabName}-search`)?.dispatchEvent(new Event('input'));
            updateSelectedCountAndSize(tabName);
            return;
        }

        tableBody.removeChild(rowToMove);

        const nonFavoriteGames = Array.from(tableBody.querySelectorAll('tr'))
            .filter(row => !row.dataset.virtualSpacer)
            .filter(row => !isFavoriteRow(row))
            .concat(rowToMove)
            .map(row => ({
                wikiId: row.getAttribute('data-wiki-id'),
                titleToSort: row.querySelector('.game-title')?.textContent.trim() || ''
            }));

        const sortedNonFavoriteGames = sortGamesForDisplay(nonFavoriteGames, settings);
        const targetIndex = sortedNonFavoriteGames.findIndex(game => game.wikiId === wikiId);

        const lastFavoriteRow = Array.from(tableBody.querySelectorAll('tr'))
            .filter(row => !row.dataset.virtualSpacer)
            .reverse()
            .find(isFavoriteRow);

        if (targetIndex === 0) {
            if (lastFavoriteRow) {
                tableBody.insertBefore(rowToMove, lastFavoriteRow.nextSibling);
            } else {
                tableBody.insertBefore(rowToMove, tableBody.firstChild);
            }
        } else {
            const previousRowId = sortedNonFavoriteGames[targetIndex - 1].wikiId;
            const previousRow = tableBody.querySelector(`tr[data-wiki-id="${previousRowId}"]`);
            tableBody.insertBefore(rowToMove, previousRow.nextSibling);
        }

        document.getElementById(`${tabName}-search`)?.dispatchEvent(new Event('input'));
        updateSelectedCountAndSize(tabName);
    }
}

function updateGameBlockedState(tabName, wikiId, blocked) {
    const row = getTableRow(tabName, wikiId);

    if (row) {
        row.dataset.blocked = blocked.toString();
        setIcon(row, 'blocked', blocked);
        applyTableFilters(tabName);
        updateSelectedCountAndSize(tabName);
    }
}
