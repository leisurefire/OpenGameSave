export const platformOrder = ['Custom', 'Steam', 'Ubisoft', 'EA', 'Epic', 'GOG', 'Xbox', 'Blizzard'];

function createBaseRow(gameTitle, backupSize, newestBackupTime, wikiPageId, detailClass, detailValue, moreLabel = 'More') {
    const row = document.createElement('tr');
    row.setAttribute('data-wiki-id', wikiPageId);
    row.innerHTML = `
        <td class="p-4"><input type="checkbox" class="row-checkbox w-4 h-4 accent-theme-accent"></td>
        <th scope="row" class="game-list-primary-cell p-4">
            <div class="game-title-line">
                <span data-icon="favorite" class="hidden"><span data-lucide-icon="heart" class="text-red-400"></span></span>
                <span data-icon="blocked" class="hidden"><span data-lucide-icon="ban" class="text-yellow-400"></span></span>
                <span data-icon="star" class="hidden"><span data-lucide-icon="star" class="text-yellow-500"></span></span>
                <span data-icon="timer" class="hidden"><span data-lucide-icon="timer-reset" class="text-theme-accent"></span></span>
                <span class="game-title"></span>
            </div>
            <div class="game-row-subtitle newest-backup-time"></div>
        </th>
        <td class="row-detail-cell p-4 truncate opacity-80 text-center align-middle ${detailClass}">${detailValue}</td>
        <td class="row-size-cell p-4 truncate opacity-80 text-center align-middle backup-size">${backupSize}</td>
        <td class="p-4 text-center">
            <button class="dropdown-menu-button p-2 hover:text-theme-accent transition-colors" type="button"
                data-i18n-aria-label="main.more" aria-haspopup="menu" aria-expanded="false">
                <span data-lucide-icon="ellipsis-vertical"></span>
            </button>
        </td>`;
    row.querySelector('.game-title').textContent = gameTitle;
    row.querySelector('.newest-backup-time').textContent = newestBackupTime || '';
    row.querySelector('.dropdown-menu-button').setAttribute('aria-label', moreLabel);
    return row;
}

export function createBackupTableRow(gameTitle, platformIcons, backupSize, newestBackupTime, wikiPageId, moreLabel) {
    return createBaseRow(gameTitle, backupSize, newestBackupTime, wikiPageId, '', platformIcons, moreLabel);
}

export function createRestoreTableRow(gameTitle, backupCount, backupSize, newestBackupTime, wikiPageId, moreLabel) {
    return createBaseRow(gameTitle, backupSize, newestBackupTime, wikiPageId, 'backup-count', backupCount, moreLabel);
}
