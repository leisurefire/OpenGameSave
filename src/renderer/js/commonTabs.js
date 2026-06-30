import { showAlert, updateTranslations } from './utility.js';
import { showDontShowDialog } from './dialog.js';
import { createLoadingIndicator } from './loadingIndicator.js';

export function runWhenDomReady(callback) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', callback, { once: true });
    } else {
        callback();
    }
}

const displayCollators = new Map();

function getDisplayCollator(language) {
    const locale = language === 'zh_CN' ? 'zh-CN' : 'en-US';
    if (!displayCollators.has(locale)) {
        displayCollators.set(locale, new Intl.Collator(locale, {
            numeric: true,
            sensitivity: 'base'
        }));
    }
    return displayCollators.get(locale);
}

export function withTitleToSort(game, settings) {
    const titleToSort = settings.language === 'zh_CN'
        ? game.zh_CN || game.title
        : game.title;
    return { ...game, titleToSort: titleToSort || '' };
}

export function sortGamesForDisplay(games, settings) {
    const collator = getDisplayCollator(settings.language);
    return [...games].sort((a, b) => collator.compare(a.titleToSort || '', b.titleToSort || ''));
}

export function appendRows(tableBody, rows) {
    const fragment = document.createDocumentFragment();
    rows.forEach(row => fragment.appendChild(row));
    tableBody.appendChild(fragment);
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
    const backupRow = document.querySelector(`#backup tbody tr[data-wiki-id="${wikiId}"]`);
    const restoreRow = document.querySelector(`#restore tbody tr[data-wiki-id="${wikiId}"]`);
    if (backupRow) setIcon(backupRow, 'timer', true);
    if (restoreRow) setIcon(restoreRow, 'timer', true);
});

window.api.receive('auto-backup-stopped', (wikiId) => {
    const backupRow = document.querySelector(`#backup tbody tr[data-wiki-id="${wikiId}"]`);
    const restoreRow = document.querySelector(`#restore tbody tr[data-wiki-id="${wikiId}"]`);
    if (backupRow) setIcon(backupRow, 'timer', false);
    if (restoreRow) setIcon(restoreRow, 'timer', false);
});

window.api.receive('auto-backup-performed', async (wikiId) => {
    if (window.backupTableDataMap) {
        await addOrUpdateTableRow('backup', wikiId);
    }
    if (window.restoreTableDataMap) {
        await addOrUpdateTableRow('restore', wikiId);
    }
});

export const spinner = `
    <svg aria-hidden="true" role="status" class="inline w-4 h-4 text-white animate-spin"
        viewBox="0 0 100 101" fill="none">
        <path d="M100 50.5908C100 78.2051 77.6142 100.591 50 100.591C22.3858 100.591 0 78.2051 0 50.5908C0 22.9766 22.3858 0.59082 50 0.59082C77.6142 0.59082 100 22.9766 100 50.5908ZM9.08144 50.5908C9.08144 73.1895 27.4013 91.5094 50 91.5094C72.5987 91.5094 90.9186 73.1895 90.9186 50.5908C90.9186 27.9921 72.5987 9.67226 50 9.67226C27.4013 9.67226 9.08144 27.9921 9.08144 50.5908Z"
            fill="#E5E7EB" />
        <path d="M93.9676 39.0409C96.393 38.4038 97.8624 35.9116 97.0079 33.5539C95.2932 28.8227 92.871 24.3692 89.8167 20.348C85.8452 15.1192 80.8826 10.7238 75.2124 7.41289C69.5422 4.10194 63.2754 1.94025 56.7698 1.05124C51.7666 0.367541 46.6976 0.446843 41.7345 1.27873C39.2613 1.69328 37.813 4.19778 38.4501 6.62326C39.0873 9.04874 41.5694 10.4717 44.0505 10.1071C47.8511 9.54855 51.7191 9.52689 55.5402 10.0491C60.8642 10.7766 65.9928 12.5457 70.6331 15.2552C75.2735 17.9648 79.3347 21.5619 82.5849 25.841C84.9175 28.9121 86.7997 32.2913 88.1811 35.8758C89.083 38.2158 91.5421 39.6781 93.9676 39.0409Z" fill="currentColor" />
    </svg>
`;

// Function to initialize the tab switching functionality
function initializeTabs() {
    const tabsElement = document.getElementById('main-tab');
    const tabElements = [
        { id: 'backup', triggerEl: document.querySelector('#backup-tab'), targetEl: document.querySelector('#backup') },
        { id: 'restore', triggerEl: document.querySelector('#restore-tab'), targetEl: document.querySelector('#restore') },
        { id: 'sync', triggerEl: document.querySelector('#sync-tab'), targetEl: document.querySelector('#sync') },
    ];

    const options = {
        defaultTabId: 'backup',
        activeClasses: 'tab-active opacity-100',
        inactiveClasses: 'opacity-60 hover:opacity-100',
    };

    if (tabsElement) {
        const defaultTab = tabElements.find(tab => tab.id === options.defaultTabId);
        if (defaultTab) {
            showTab(defaultTab, tabElements, options);
        }

        tabElements.filter(tab => tab.triggerEl && tab.targetEl).forEach(tab => {
            tab.triggerEl.addEventListener('click', async () => {
                const contentEl = document.getElementById(`${tab.id}-content`);
                if (contentEl) {
                    contentEl.classList.remove('animate-fadeInShift', 'animate-fadeOut');
                }
                showTab(tab, tabElements, options);
            });
        });
    }
}

// Function to handle tab switching logic
function showTab(tab, tabElements, options) {
    tabElements.filter(t => t.triggerEl && t.targetEl).forEach(t => {
        if (t.id === tab.id) {
            t.triggerEl.classList.add(...options.activeClasses.split(' '));
            t.triggerEl.classList.remove(...options.inactiveClasses.split(' '));
            t.targetEl.classList.remove('hidden');
        } else {
            t.triggerEl.classList.remove(...options.activeClasses.split(' '));
            t.triggerEl.classList.add(...options.inactiveClasses.split(' '));
            t.targetEl.classList.add('hidden');
        }
    });

    if (typeof options.onShow === 'function') {
        options.onShow(tab);
    }
}



export async function showLoadingIndicator(tabName) {
    const loadingContainer = document.getElementById(`${tabName}-loading`);
    const actionSummary = document.querySelector(`#${tabName}-summary`);
    const contentContainer = document.getElementById(`${tabName}-content`);
    const actionButton = document.getElementById(`${tabName}-button`);

    actionSummary.classList.add('hidden');
    document.querySelector(`#${tabName}-summary-done`).classList.add('hidden');
    actionButton.disabled = true;
    actionButton.classList.add('cursor-not-allowed', 'opacity-50');

    if (contentContainer && window.getComputedStyle(contentContainer).display !== 'none') {
        contentContainer.classList.remove('animate-fadeInShift');
        contentContainer.classList.add('animate-fadeOut');

        await new Promise(resolve => setTimeout(resolve, 300));
        contentContainer.classList.add('hidden');

        if (loadingContainer) {
            const loadingTextKey = loadingContainer.getAttribute('data-i18n');
            const loadingText = await window.i18n.translate(loadingTextKey);
            loadingContainer.innerHTML = createLoadingIndicator(loadingText);
            loadingContainer.classList.remove('hidden');
        }
    } else {
        if (loadingContainer) {
            const loadingTextKey = loadingContainer.getAttribute('data-i18n');
            const loadingText = await window.i18n.translate(loadingTextKey);
            loadingContainer.innerHTML = createLoadingIndicator(loadingText);
            loadingContainer.classList.remove('hidden');
        }
    }
}

export function hideLoadingIndicator(tabName) {
    const loadingContainer = document.getElementById(`${tabName}-loading`);
    const contentContainer = document.getElementById(`${tabName}-content`);
    const actionButton = document.getElementById(`${tabName}-button`);

    actionButton.disabled = false;
    actionButton.classList.remove('cursor-not-allowed', 'opacity-50');

    if (loadingContainer) {
        loadingContainer.classList.add('hidden');
    }

    if (contentContainer) {
        contentContainer.classList.remove('hidden');
        contentContainer.classList.remove('animate-fadeOut');
        contentContainer.classList.add('animate-fadeInShift');
    }
}

// Function to set up the search, favorites, blocked, and uninstalled filters for the table
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

        rows.forEach(row => {
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
            row.style.display = matchesSearch && matchesFavorite && matchesBlocked && matchesUninstalled ? '' : 'none';
        });

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

export function getPlatformIcon(platform, iconMap) {
    return iconMap[platform] || '';
}

export function formatSize(sizeInBytes) {
    if (sizeInBytes === 0) return '0 B';
    const i = Math.floor(Math.log(sizeInBytes) / Math.log(1024));
    return (sizeInBytes / Math.pow(1024, i)).toFixed(2) * 1 + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i];
}

const platformOrder = ['Custom', 'Steam', 'Ubisoft', 'EA', 'Epic', 'GOG', 'Xbox', 'Blizzard'];

export function createBackupTableRow(gameTitle, platformIcons, backupSize, newestBackupTime, wikiPageId) {
    const row = document.createElement('tr');
    row.setAttribute('data-wiki-id', wikiPageId);
    row.classList.add('border-b', 'border-white/5');
    row.innerHTML = `
        <td class="p-4">
            <input type="checkbox" class="row-checkbox w-4 h-4 accent-theme-accent">
        </td>
        <th scope="row" class="p-4 font-bold text-white truncate">
                        <span data-icon="favorite" class="hidden"><i class="fa-solid fa-heart text-red-400 mr-2"></i></span>
                        <span data-icon="blocked" class="hidden"><i class="fa-solid fa-ban text-yellow-400 mr-2"></i></span>
                        <span data-icon="star" class="hidden"><i class="fa-solid fa-star text-yellow-500 mr-2"></i></span>
            <span data-icon="timer" class="hidden"><i class="fa-solid fa-clock-rotate-left text-theme-accent mr-2"></i></span>
            ${gameTitle}
        </th>
        <td class="p-4 truncate opacity-80 text-center align-middle">
            ${platformIcons}
        </td>
        <td class="p-4 truncate opacity-80 text-center align-middle backup-size">
            ${backupSize}
        </td>
        <td class="p-4 truncate opacity-60 text-center align-middle newest-backup-time">
            ${newestBackupTime}
        </td>
        <td class="p-4 text-center">
            <button class="dropdown-menu-button p-2 hover:text-theme-accent transition-colors" type="button">
                <i class="fa-solid fa-ellipsis-vertical"></i>
            </button>
        </td>
    `;
    return row;
}

export function createRestoreTableRow(gameTitle, backupCount, backupSize, newestBackupTime, wikiPageId) {
    const row = document.createElement('tr');
    row.setAttribute('data-wiki-id', wikiPageId);
    row.classList.add('border-b', 'border-white/5');
    row.innerHTML = `
        <td class="p-4">
            <input type="checkbox" class="row-checkbox w-4 h-4 accent-theme-accent">
        </td>
        <th scope="row" class="p-4 font-bold text-white truncate">
                        <span data-icon="favorite" class="hidden"><i class="fa-solid fa-heart text-red-400 mr-2"></i></span>
                        <span data-icon="blocked" class="hidden"><i class="fa-solid fa-ban text-yellow-400 mr-2"></i></span>
                        <span data-icon="star" class="hidden"><i class="fa-solid fa-star text-yellow-500 mr-2"></i></span>
            <span data-icon="timer" class="hidden"><i class="fa-solid fa-clock-rotate-left text-theme-accent mr-2"></i></span>
            ${gameTitle}
        </th>
        <td class="p-4 truncate opacity-80 text-center align-middle backup-count">
            ${backupCount}
        </td>
        <td class="p-4 truncate opacity-80 text-center align-middle backup-size">
            ${backupSize}
        </td>
        <td class="p-4 truncate opacity-60 text-center align-middle newest-backup-time">
            ${newestBackupTime}
        </td>
        <td class="p-4 text-center">
            <button class="dropdown-menu-button p-2 hover:text-theme-accent transition-colors" type="button">
                <i class="fa-solid fa-ellipsis-vertical"></i>
            </button>
        </td>
    `;
    return row;
}

export async function addOrUpdateTableRow(tabName, wikiId) {
    let gameData;
    if (tabName === 'backup') {
        const games = await window.api.invoke('fetch-backup-table-data', null, wikiId);
        gameData = games && games.length > 0 ? games[0] : null;
    } else {
        const games = await window.api.invoke('fetch-restore-table-data', wikiId);
        gameData = games && games.length > 0 ? games[0] : null;
    }
    if (!gameData) return;

    const dataMap = tabName === 'backup' ? window.backupTableDataMap : window.restoreTableDataMap;
    dataMap.set(wikiId, gameData);

    const existingRow = document.querySelector(`#${tabName} tbody tr[data-wiki-id="${wikiId}"]`);

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
        const tableBody = document.querySelector(`#${tabName} tbody`);
        const siblingRows = Array.from(tableBody.querySelectorAll('tr'))
            .filter(r => {
                const favorite = !r.querySelector('span[data-icon="favorite"].hidden');
                return isFavorite ? favorite : !favorite;
            })
            .concat({ getAttribute: () => wikiId.toString(), querySelector: () => ({ textContent: gameTitle }) })
            .map(r => ({
                wikiId: r.getAttribute('data-wiki-id'),
                titleToSort: r.querySelector('th[scope="row"]').textContent.trim()
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
                    .reverse()
                    .find(r => !r.querySelector('span[data-icon="favorite"].hidden'));
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

// Helper function to remove a game row from a tab's table and clean up its data map
export function removeTableRow(tabName, wikiId) {
    const row = document.querySelector(`#${tabName} tbody tr[data-wiki-id="${wikiId}"]`);
    if (row) {
        row.remove();
    }
    const dataMap = tabName === 'backup' ? window.backupTableDataMap : window.restoreTableDataMap;
    dataMap.delete(wikiId);
    updateSelectedCountAndSize(tabName);
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
    } else if (action === 'open-save-folder') {
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
            const wikiUrl = !wikiPageId.includes('-') ? `https://www.pcgamingwiki.com/wiki/index.php?curid=${wikiPageId}` : "none";

            const menuItems = [
                {
                    label: await window.i18n.translate(isFavorite ? 'main.remove_favorite' : 'main.add_favorite'),
                    icon: isFavorite ? 'fa-solid fa-heart-crack' : 'fa-solid fa-heart',
                    action: isFavorite ? 'unfavorite' : 'add-favorite',
                    data: wikiPageId
                },
                {
                    label: await window.i18n.translate(isBlocked ? 'main.unblock_game' : 'main.block_game'),
                    icon: isBlocked ? 'fa-solid fa-eye' : 'fa-solid fa-ban',
                    action: isBlocked ? 'unblock-game' : 'block-game',
                    data: wikiPageId
                },
                {
                    label: await window.i18n.translate('main.auto_backup'),
                    icon: 'fa-solid fa-clock-rotate-left',
                    action: 'auto-backup',
                    data: wikiPageId,
                    visible: tabName !== 'restore'
                },
                {
                    label: await window.i18n.translate('main.manage_backups'),
                    icon: 'fa-solid fa-list-check',
                    action: 'manage-backups',
                    data: wikiPageId
                },
                {
                    label: await window.i18n.translate('main.browse_local_save'),
                    icon: 'fa-solid fa-book-open',
                    action: 'open-save-folder',
                    data: wikiPageId
                },
                {
                    label: await window.i18n.translate('main.view_wiki'),
                    icon: 'fa-solid fa-globe',
                    action: 'open-wiki',
                    data: wikiUrl
                }
            ].filter(item => item.visible !== false);

            const rect = button.getBoundingClientRect();
            window.api.send('show-popup-menu', {
                items: menuItems,
                x: rect.right + 4,
                y: rect.bottom + 8
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
    const rowToMove = tableBody.querySelector(`tr[data-wiki-id="${wikiId}"]`);

    if (rowToMove) {
        const settings = await window.api.invoke('get-settings');
        tableBody.removeChild(rowToMove);
        setIcon(rowToMove, 'favorite', true);

        const favoriteGames = Array.from(tableBody.querySelectorAll('tr'))
            .filter(row => !row.querySelector('span[data-icon="favorite"].hidden'))
            .concat(rowToMove)
            .map(row => ({
                wikiId: row.getAttribute('data-wiki-id'),
                titleToSort: row.querySelector('th[scope="row"]').textContent.trim()
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
    const rowToMove = tableBody.querySelector(`tr[data-wiki-id="${wikiId}"]`);

    if (rowToMove) {
        const settings = await window.api.invoke('get-settings');
        setIcon(rowToMove, 'favorite', false);
        tableBody.removeChild(rowToMove);

        const nonFavoriteGames = Array.from(tableBody.querySelectorAll('tr'))
            .filter(row => row.querySelector('span[data-icon="favorite"].hidden'))
            .concat(rowToMove)
            .map(row => ({
                wikiId: row.getAttribute('data-wiki-id'),
                titleToSort: row.querySelector('th[scope="row"]').textContent.trim()
            }));

        const sortedNonFavoriteGames = sortGamesForDisplay(nonFavoriteGames, settings);
        const targetIndex = sortedNonFavoriteGames.findIndex(game => game.wikiId === wikiId);

        const lastFavoriteRow = Array.from(tableBody.querySelectorAll('tr'))
            .reverse()
            .find(row => !row.querySelector('span[data-icon="favorite"].hidden'));

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
    const row = tableBody?.querySelector(`tr[data-wiki-id="${wikiId}"]`);

    if (row) {
        row.dataset.blocked = blocked.toString();
        setIcon(row, 'blocked', blocked);
        applyTableFilters(tabName);
        updateSelectedCountAndSize(tabName);
    }
}

// Function to update the count and size display
export async function updateSelectedCountAndSize(tabName) {
    const selectedCountWidget = document.querySelector(`#${tabName}-selected-count`);
    const totalSizeWidget = document.querySelector(`#${tabName}-selected-size`);
    const tableBody = document.querySelector(`#${tabName} tbody`);
    const selectedWikiIds = getSelectedWikiIds(tabName);
    const visibleRows = Array.from(tableBody.querySelectorAll('tr'))
        .filter(row => row.style.display !== 'none');
    const total_games_count = visibleRows.length;

    let total_size = 0;
    let total_selected = 0;

    const dataMap = tabName === 'backup' ? window.backupTableDataMap : window.restoreTableDataMap;

    selectedWikiIds.forEach(wikiId => {
        const row = tableBody.querySelector(`tr[data-wiki-id="${wikiId}"]`);
        if (!row || row.style.display === 'none') return;

        const gameData = dataMap.get(wikiId);
        if (gameData) {
            total_size += gameData.backup_size;
            total_selected += 1;
        }
    });

    selectedCountWidget.innerHTML = await window.i18n.translate('main.selected_games_count', {
        count: total_selected,
        total: total_games_count
    });
    totalSizeWidget.innerHTML = await window.i18n.translate(`main.total_${tabName}_size`, {
        size: formatSize(total_size)
    });
}

// Function to setup "Select All" checkbox functionality
export function setupSelectAllCheckbox(tabName, selectAllCheckbox) {
    if (!selectAllCheckbox || selectAllCheckbox.dataset.listenerAdded) {
        return;
    }
    selectAllCheckbox.dataset.listenerAdded = 'true';

    const tableBody = document.querySelector(`#${tabName} tbody`);

    // Handle the "Select All" checkbox change
    selectAllCheckbox.addEventListener('change', function () {
        const isChecked = this.checked;
        const rowCheckboxes = Array.from(tableBody.querySelectorAll('.row-checkbox'))
            .filter(checkbox => checkbox.closest('tr')?.style.display !== 'none');
        rowCheckboxes.forEach(checkbox => {
            checkbox.checked = isChecked;
        });

        updateSelectAllCheckbox(selectAllCheckbox, tableBody);
        updateSelectedCountAndSize(tabName);
    });

    // Handle individual row checkbox changes
    tableBody.addEventListener('change', function (event) {
        if (event.target.classList.contains('row-checkbox')) {
            updateSelectAllCheckbox(selectAllCheckbox, tableBody);
            updateSelectedCountAndSize(tabName);
        }
    });
}

// Function to update the "Select All" checkbox state
function updateSelectAllCheckbox(selectAllCheckbox, tableContainer) {
    const rowCheckboxes = Array.from(tableContainer.querySelectorAll('.row-checkbox'))
        .filter(checkbox => checkbox.closest('tr')?.style.display !== 'none');
    const allChecked = rowCheckboxes.length > 0 && rowCheckboxes.every(checkbox => checkbox.checked);
    const anyChecked = rowCheckboxes.some(checkbox => checkbox.checked);
    selectAllCheckbox.checked = allChecked;
    selectAllCheckbox.indeterminate = !allChecked && anyChecked;
}

export function getSelectedWikiIds(tabName) {
    const table = document.querySelector(`#${tabName}`);
    const selectedRows = table.querySelectorAll('.row-checkbox:checked');
    return Array.from(selectedRows)
        .filter(checkbox => checkbox.closest('tr')?.style.display !== 'none')
        .map(checkbox => {
            const row = checkbox.closest('tr');
            return row.getAttribute('data-wiki-id').trim();
        });
}
