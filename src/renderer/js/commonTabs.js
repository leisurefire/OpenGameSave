import { showAlert, showExportModal, showImportModal, updateTranslations } from './utility.js';
import { showDontShowDialog, showMessageDialog } from './dialog.js';
import { getSortedFavoriteGroups, sortGamesForDisplay } from './tableDisplay.js';
import { initializeTabs } from './tabNavigation.js';
import { createBackupTableRow, createRestoreTableRow, platformOrder } from './tableRows.js';
import { setDropDownAction } from './tablePopupMenu.js';
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
import {
    addVirtualRecord,
    appendRows as appendVirtualRows,
    applyVirtualFilter,
    disableVirtualRows,
    findVirtualRecord,
    findVirtualRow,
    getRowId,
    getVirtualState,
    removeVirtualRow,
    sortVirtualRows,
    updateVirtualRecord
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

export function appendRows(tableBody, rows, options = {}) {
    appendVirtualRows(tableBody, rows, { rowHeight: 60, ...options });
}

runWhenDomReady(() => {
    updateTranslations(document);
    initializeTabs();
    setupSearchFilter('backup');
    setupSearchFilter('restore');
    setDropDownAction();
});

document.addEventListener('ogs:update-translations', () => {
    void updateTranslations(document);
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

        const rowMatchesFilters = (rowOrRecord) => {
            // Match against both English and Chinese names, regardless of the
            // displayed language. Fall back to the visible cell text if the
            // game data isn't available in the data map.
            const wikiId = getRowId(rowOrRecord);
            const gameData = dataMap && (dataMap.get(wikiId) || dataMap.get(Number(wikiId)));
            const searchTargets = [];
            if (gameData) {
                if (gameData.title) searchTargets.push(gameData.title);
                if (gameData.zh_CN) searchTargets.push(gameData.zh_CN);
            }
            if (searchTargets.length === 0) {
                if (rowOrRecord.gameTitle) {
                    searchTargets.push(rowOrRecord.gameTitle);
                } else {
                    const gameNameCell = rowOrRecord.querySelector('th[scope="row"]');
                    if (gameNameCell) searchTargets.push(gameNameCell.textContent);
                }
            }

            const matchesSearch = searchTargets.some(name => name.toLowerCase().includes(filter));
            const isRecord = Boolean(rowOrRecord.iconStates);
            const isFavorite = isRecord
                ? rowOrRecord.iconStates.favorite
                : !rowOrRecord.querySelector('span[data-icon="favorite"].hidden');
            const isBlocked = isRecord
                ? rowOrRecord.iconStates.blocked
                : rowOrRecord.dataset.blocked === 'true';
            const isUninstalled = isRecord
                ? rowOrRecord.isUninstalled
                : rowOrRecord.dataset.uninstalled === 'true';
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
    const tableBody = document.querySelector(`#${tabName} tbody`);
    if (updateVirtualRecord(tableBody, wikiId, record => {
        record.iconStates[iconName] = show;
        return record;
    }, { refilter: iconName === 'favorite' || iconName === 'blocked' })) return;

    const row = getTableRow(tabName, wikiId);
    if (row) {
        setIcon(row, iconName, show);
    }
}

function isFavoriteRow(row) {
    if (row.iconStates) return row.iconStates.favorite;
    return !row.querySelector('span[data-icon="favorite"].hidden');
}

function sortRowsForTable(rows, settings) {
    const sortRows = (rowsToSort) => sortGamesForDisplay(
        rowsToSort.map(row => ({
            row,
            wikiId: getRowId(row),
            titleToSort: row.gameTitle || row.querySelector('.game-title')?.textContent.trim() || ''
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

function createGameTableRecord({
    wikiId,
    game,
    gameTitle,
    selected = false,
    favorite = false,
    blocked = false,
    uninstalled = false,
    permanent = false,
    autoBackup = false
}) {
    return {
        id: wikiId.toString(),
        game,
        gameTitle,
        selected,
        isUninstalled: uninstalled,
        iconStates: {
            favorite,
            blocked,
            star: permanent,
            timer: autoBackup
        }
    };
}

function materializeGameTableRecord(record, createRow) {
    const row = createRow(record.game, record.gameTitle);
    const checkbox = row.querySelector('.row-checkbox');
    if (checkbox) checkbox.checked = record.selected;

    for (const [iconName, show] of Object.entries(record.iconStates)) {
        if (show) setIcon(row, iconName, true);
    }
    if (record.iconStates.blocked) row.dataset.blocked = 'true';
    if (record.isUninstalled) row.dataset.uninstalled = 'true';
    return row;
}

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
    const blockedGamesWikiIds = new Set((settings.blockedGames || []).map(String));
    const uninstalledGamesWikiIds = new Set((settings.uninstalledGames || []).map(String));
    const selectedWikiIds = new Set(getSelectedWikiIds(tabName).map(String));
    const autoBackupSet = new Set(Object.keys(autoBackupState));

    disableVirtualRows(tableBody);
    tableBody.innerHTML = '';
    tableDataMap.clear();

    const { favoriteGames, otherGames } = getSortedFavoriteGroups(data, settings);
    const records = [];

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

            const normalizedWikiId = wikiId.toString();
            records.push(createGameTableRecord({
                wikiId: normalizedWikiId,
                game,
                gameTitle,
                selected: selectedWikiIds.has(normalizedWikiId),
                favorite: isFavorite,
                blocked: blockedGamesWikiIds.has(normalizedWikiId),
                uninstalled: uninstalledGamesWikiIds.has(normalizedWikiId),
                permanent: hasPermanentBackup(game, wikiId),
                autoBackup: autoBackupSet.has(normalizedWikiId)
            }));
        });
    };

    appendRowsToTable(favoriteGames, true);
    appendRowsToTable(otherGames, false);
    appendRows(tableBody, records, {
        materializeRow: record => materializeGameTableRecord(record, createRow)
    });

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

    const virtualRecord = findVirtualRecord(tableBody, wikiId);
    const existingRow = getTableRow(tabName, wikiId);

    if (virtualRecord) {
        updateVirtualRecord(tableBody, wikiId, record => {
            record.game = gameData;
            return record;
        });
    } else if (existingRow) {
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

        const normalizedWikiId = wikiId.toString();
        const isFavorite = (settings.pinnedGames || []).map(String).includes(normalizedWikiId);
        const isBlocked = (settings.blockedGames || []).map(String).includes(normalizedWikiId);
        const isUninstalled = (settings.uninstalledGames || []).map(String).includes(normalizedWikiId);
        const restoreGameData = tabName === 'backup'
            ? window.restoreTableDataMap?.get(wikiId) || window.restoreTableDataMap?.get(Number(wikiId))
            : gameData;
        const hasPermanent = Boolean(restoreGameData?.backups?.some(backup => backup.is_permanent));
        const autoBackupState = await window.api.invoke('get-auto-backup-state');
        const hasAutoBackup = Boolean(autoBackupState[normalizedWikiId]);

        // Insert row in sorted position
        if (getVirtualState(tableBody)) {
            addVirtualRecord(tableBody, createGameTableRecord({
                wikiId: normalizedWikiId,
                game: gameData,
                gameTitle,
                favorite: isFavorite,
                blocked: isBlocked,
                uninstalled: isUninstalled,
                permanent: hasPermanent,
                autoBackup: hasAutoBackup
            }));
            sortVirtualRows(tableBody, rows => sortRowsForTable(rows, settings));
            applyTableFilters(tabName);
            return;
        }

        let row;
        if (tabName === 'backup') {
            const iconMap = await window.api.invoke('get-icon-map');
            const sortedPlatforms = platformOrder.filter(platform => (gameData.platform || []).includes(platform));
            const platformIcons = sortedPlatforms.map(platform => getPlatformIcon(platform, iconMap)).join(' ');
            row = createBackupTableRow(gameTitle, platformIcons, formatSize(gameData.backup_size), gameData.latest_backup, wikiId);
        } else {
            row = createRestoreTableRow(gameTitle, gameData.backups.length, formatSize(gameData.backup_size), gameData.latest_backup, wikiId);
        }
        if (isFavorite) setIcon(row, 'favorite', true);
        if (isBlocked) {
            row.dataset.blocked = 'true';
            setIcon(row, 'blocked', true);
        }
        if (isUninstalled) row.dataset.uninstalled = 'true';
        if (hasPermanent) setIcon(row, 'star', true);
        if (hasAutoBackup) setIcon(row, 'timer', true);

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
    } else if (action === 'import') {
        showImportModal('');
    } else if (action === 'export') {
        showExportModal();
    } else if (action === 'view-account-ids') {
        window.api.send('view-account-ids');
    } else if (action === 'scan-full') {
        window.api.send('scan-full');
    } else if (action === 'about') {
        window.api.send('open-about-window');
    } else if (action === 'navigate') {
        document.dispatchEvent(new CustomEvent('ogs:navigate-request', { detail: { route: data } }));
    } else if (action === 'toggle-sidebar') {
        document.getElementById('sidebar-toggle')?.click();
    } else if (action === 'refresh-library') {
        document.getElementById('library-refresh')?.click();
    } else if (action === 'launch-library-game' || action === 'open-library-game-directory') {
        const gameId = typeof data === 'object' && data ? data.id : data;
        const gameTitle = typeof data === 'object' && data ? data.title : data;
        try {
            await window.api.invoke(action, gameId);
        } catch (error) {
            console.error(`Library action ${action} failed:`, error);
            const messageKey = action === 'launch-library-game'
                ? 'alert.game_launch_failed'
                : 'alert.open_install_directory_failed';
            showAlert('error', await window.i18n.translate(messageKey, { game: gameTitle }));
        }
    } else if (action === 'open-game-guide') {
        if (data?.wikiPageId) {
            document.dispatchEvent(new CustomEvent('ogs:select-game-guide', {
                detail: { wikiPageId: data.wikiPageId }
            }));
        }
        document.dispatchEvent(new CustomEvent('ogs:navigate-request', { detail: { route: 'guides' } }));
    }
});

async function addGameToFavorites(tabName, wikiId) {
    const tableBody = document.querySelector(`#${tabName} tbody`);
    const virtualRecord = findVirtualRecord(tableBody, wikiId);
    const rowToMove = getTableRow(tabName, wikiId);

    if (virtualRecord || rowToMove) {
        const settings = await window.api.invoke('get-settings');
        if (virtualRecord) {
            updateVirtualRecord(tableBody, wikiId, record => {
                record.iconStates.favorite = true;
                return record;
            });
            sortVirtualRows(tableBody, rows => sortRowsForTable(rows, settings));
            document.getElementById(`${tabName}-search`)?.dispatchEvent(new Event('input'));
            return;
        }

        setIcon(rowToMove, 'favorite', true);

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
    const virtualRecord = findVirtualRecord(tableBody, wikiId);
    const rowToMove = getTableRow(tabName, wikiId);

    if (virtualRecord || rowToMove) {
        const settings = await window.api.invoke('get-settings');
        if (virtualRecord) {
            updateVirtualRecord(tableBody, wikiId, record => {
                record.iconStates.favorite = false;
                return record;
            });
            sortVirtualRows(tableBody, rows => sortRowsForTable(rows, settings));
            document.getElementById(`${tabName}-search`)?.dispatchEvent(new Event('input'));
            updateSelectedCountAndSize(tabName);
            return;
        }

        setIcon(rowToMove, 'favorite', false);

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
    const tableBody = document.querySelector(`#${tabName} tbody`);
    if (updateVirtualRecord(tableBody, wikiId, record => {
        record.iconStates.blocked = blocked;
        return record;
    })) {
        applyTableFilters(tabName);
        updateSelectedCountAndSize(tabName);
        return;
    }

    const row = getTableRow(tabName, wikiId);

    if (row) {
        row.dataset.blocked = blocked.toString();
        setIcon(row, 'blocked', blocked);
        applyTableFilters(tabName);
        updateSelectedCountAndSize(tabName);
    }
}
