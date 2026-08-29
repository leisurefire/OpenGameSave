import { formatSize } from './formatting.js';
import {
    getFilteredVirtualRowIds,
    getFilteredVirtualRows,
    getFilteredVirtualSelectedIds,
    getVirtualState,
    setAllVirtualSelected,
    updateVirtualSelection
} from './virtualTable.js';

export function getSelectedWikiIds(tabName) {
    const table = document.querySelector(`#${tabName}`);
    if (!table) return [];
    const tableBody = table.querySelector('tbody');
    const virtualSelectedIds = getFilteredVirtualSelectedIds(tableBody);
    if (virtualSelectedIds.length > 0 || getVirtualState(tableBody)) return virtualSelectedIds;
    return Array.from(table.querySelectorAll('.row-checkbox:checked'))
        .filter(checkbox => checkbox.closest('tr')?.style.display !== 'none')
        .map(checkbox => checkbox.closest('tr').getAttribute('data-wiki-id').trim());
}

export function updateSelectAllCheckbox(selectAllCheckbox, tableContainer) {
    const virtualState = getVirtualState(tableContainer);
    const visibleCheckboxes = virtualState ? [] : Array.from(tableContainer.querySelectorAll('.row-checkbox'))
        .filter(checkbox => checkbox.closest('tr')?.style.display !== 'none');
    const totalRows = virtualState ? virtualState.filteredRecords.length : visibleCheckboxes.length;
    const selectedRows = virtualState
        ? getFilteredVirtualSelectedIds(tableContainer).length
        : visibleCheckboxes.filter(checkbox => checkbox.checked).length;
    const allChecked = totalRows > 0 && selectedRows === totalRows;
    selectAllCheckbox.checked = allChecked;
    selectAllCheckbox.indeterminate = !allChecked && selectedRows > 0;
}

export async function updateSelectedCountAndSize(tabName) {
    const selectedCountWidget = document.querySelector(`#${tabName}-selected-count`);
    const totalSizeWidget = document.querySelector(`#${tabName}-selected-size`);
    const tableBody = document.querySelector(`#${tabName} tbody`);
    const selectedWikiIds = getSelectedWikiIds(tabName);
    const visibleIds = getFilteredVirtualRowIds(tableBody);
    const dataMap = tabName === 'backup' ? window.backupTableDataMap : window.restoreTableDataMap;
    let totalSize = 0;
    let totalSelected = 0;

    selectedWikiIds.forEach((wikiId) => {
        if (!visibleIds.has(wikiId)) return;
        const gameData = dataMap.get(wikiId) || dataMap.get(Number(wikiId));
        if (gameData) {
            totalSize += gameData.backup_size;
            totalSelected += 1;
        }
    });
    selectedCountWidget.textContent = await window.i18n.translate('main.selected_games_count', {
        count: totalSelected,
        total: getFilteredVirtualRows(tableBody).length
    });
    totalSizeWidget.textContent = await window.i18n.translate(`main.total_${tabName}_size`, {
        size: formatSize(totalSize)
    });
}

export function setupSelectAllCheckbox(tabName, selectAllCheckbox) {
    if (!selectAllCheckbox || selectAllCheckbox.dataset.listenerAdded) return;
    selectAllCheckbox.dataset.listenerAdded = 'true';
    const tableBody = document.querySelector(`#${tabName} tbody`);
    selectAllCheckbox.addEventListener('change', function handleSelectAll() {
        if (!setAllVirtualSelected(tableBody, this.checked)) {
            Array.from(tableBody.querySelectorAll('.row-checkbox'))
                .filter(checkbox => checkbox.closest('tr')?.style.display !== 'none')
                .forEach((checkbox) => {
                    checkbox.checked = this.checked;
                });
        }
        updateSelectAllCheckbox(selectAllCheckbox, tableBody);
        updateSelectedCountAndSize(tabName);
    });
    tableBody.addEventListener('change', (event) => {
        if (!event.target.classList.contains('row-checkbox')) return;
        updateVirtualSelection(tableBody, event.target);
        updateSelectAllCheckbox(selectAllCheckbox, tableBody);
        updateSelectedCountAndSize(tabName);
    });
}
