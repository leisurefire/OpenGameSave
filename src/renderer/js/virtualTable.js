const DEFAULT_THRESHOLD = 200;
const DEFAULT_ROW_HEIGHT = 42;
const DEFAULT_BUFFER = 8;

const virtualTableStates = new WeakMap();

export function getRowId(rowOrRecord) {
    for (const candidate of [rowOrRecord?.id, rowOrRecord?.wikiId]) {
        if (candidate !== undefined && candidate !== null && String(candidate).trim()) {
            return String(candidate).trim();
        }
    }
    return rowOrRecord?.getAttribute?.('data-wiki-id')?.trim();
}

export function getVirtualState(rowHost) {
    return rowHost ? virtualTableStates.get(rowHost) || null : null;
}

export function getVirtualRows(rowHost) {
    const state = getVirtualState(rowHost);
    return state ? state.allRecords : Array.from(rowHost?.querySelectorAll('tr:not([data-virtual-spacer])') || []);
}

export function getFilteredVirtualRows(rowHost) {
    const state = getVirtualState(rowHost);
    return state ? state.filteredRecords : getVirtualRows(rowHost).filter(row => row.style.display !== 'none');
}

export function getFilteredVirtualRowIds(rowHost) {
    const state = getVirtualState(rowHost);
    if (state) return state.filteredIds;
    return new Set(getFilteredVirtualRows(rowHost).map(row => getRowId(row)).filter(Boolean));
}

export function findVirtualRow(rowHost, rowId) {
    const state = getVirtualState(rowHost);
    if (!state || rowId === undefined || rowId === null) return null;
    return state.renderedRowsById.get(String(rowId)) || null;
}

export function findVirtualRecord(rowHost, rowId) {
    const state = getVirtualState(rowHost);
    if (!state || rowId === undefined || rowId === null) return null;
    return state.recordsById.get(String(rowId)) || null;
}

export function appendRows(rowHost, rowsOrRecords, options = {}) {
    disableVirtualRows(rowHost);

    const threshold = options.threshold ?? DEFAULT_THRESHOLD;
    if (rowsOrRecords.length >= threshold) {
        enableVirtualRows(rowHost, rowsOrRecords, options);
        return;
    }

    const fragment = document.createDocumentFragment();
    rowsOrRecords.forEach(item => {
        const row = options.materializeRow ? options.materializeRow(item) : item;
        if (row) fragment.appendChild(row);
    });
    rowHost.appendChild(fragment);
}

export function applyVirtualFilter(rowHost, predicate, { resetScroll = true } = {}) {
    const state = getVirtualState(rowHost);
    if (!state) return false;

    state.filterPredicate = predicate;
    rebuildFilteredRecords(state);
    if (resetScroll && state.scrollContainer) {
        state.scrollContainer.scrollTop = 0;
    }
    renderVirtualRows(rowHost);
    return true;
}

export function updateVirtualSelection(rowHost, checkbox) {
    const state = getVirtualState(rowHost);
    const rowId = getRowId(checkbox.closest('tr'));
    if (!state || !rowId) return;

    if (checkbox.checked) {
        state.selectedIds.add(rowId);
    } else {
        state.selectedIds.delete(rowId);
    }
}

export function setAllVirtualSelected(rowHost, selected) {
    const state = getVirtualState(rowHost);
    if (!state) return false;

    state.filteredRecords.forEach(record => {
        const rowId = getRowId(record);
        if (!rowId) return;
        if (selected) {
            state.selectedIds.add(rowId);
        } else {
            state.selectedIds.delete(rowId);
        }
    });
    renderVirtualRows(rowHost);
    return true;
}

export function getFilteredVirtualSelectedIds(rowHost) {
    const state = getVirtualState(rowHost);
    if (!state) return [];

    const selectedIds = [];
    for (const record of state.filteredRecords) {
        const rowId = getRowId(record);
        if (rowId && state.selectedIds.has(rowId)) selectedIds.push(rowId);
    }
    return selectedIds;
}

export function sortVirtualRows(rowHost, sorter) {
    const state = getVirtualState(rowHost);
    if (!state) return false;

    const sortedRecords = sorter([...state.allRecords]);
    if (!Array.isArray(sortedRecords)) {
        throw new TypeError('Virtual table sorter must return an array');
    }
    state.allRecords = sortedRecords;
    rebuildFilteredRecords(state);
    renderVirtualRows(rowHost);
    return true;
}

export function addVirtualRecord(rowHost, record) {
    const state = getVirtualState(rowHost);
    const rowId = getRowId(record);
    if (!state || !rowId || state.recordsById.has(rowId)) return false;

    state.allRecords.push(record);
    state.recordsById.set(rowId, record);
    if (record.selected) state.selectedIds.add(rowId);
    rebuildFilteredRecords(state);
    renderVirtualRows(rowHost);
    return true;
}

export function updateVirtualRecord(rowHost, rowId, updater, { refilter = true } = {}) {
    const state = getVirtualState(rowHost);
    const targetId = rowId?.toString();
    const record = targetId ? state?.recordsById.get(targetId) : null;
    if (!state || !record) return false;

    const patch = typeof updater === 'function' ? updater(record) : updater;
    if (patch && patch !== record) Object.assign(record, patch);
    if (getRowId(record) !== targetId) {
        throw new Error('Virtual row identifiers cannot be changed');
    }

    const isRendered = state.renderedRowsById.has(targetId);
    if (refilter) rebuildFilteredRecords(state);
    if (refilter || isRendered) renderVirtualRows(rowHost);
    return true;
}

export function removeVirtualRow(rowHost, rowId) {
    const state = getVirtualState(rowHost);
    if (!state) return false;

    const targetId = rowId.toString();
    if (!state.recordsById.has(targetId)) return false;
    state.allRecords = state.allRecords.filter(record => getRowId(record) !== targetId);
    state.recordsById.delete(targetId);
    state.selectedIds.delete(targetId);
    rebuildFilteredRecords(state);
    renderVirtualRows(rowHost);
    return true;
}

export function refreshVirtualRows(rowHost) {
    if (getVirtualState(rowHost)) {
        renderVirtualRows(rowHost);
        return true;
    }
    return false;
}

export function disableVirtualRows(rowHost) {
    const state = getVirtualState(rowHost);
    if (!state) return;

    state.scrollContainer?.removeEventListener('scroll', state.onScroll);
    if (state.renderFrame !== null) cancelAnimationFrame(state.renderFrame);
    virtualTableStates.delete(rowHost);

    state.allRecords.length = 0;
    state.filteredRecords.length = 0;
    state.recordsById.clear();
    state.renderedRowsById.clear();
    state.filteredIds.clear();
    state.selectedIds.clear();
}

function enableVirtualRows(rowHost, rowsOrRecords, options = {}) {
    const scrollContainer = options.scrollContainer || rowHost.closest('.table-container') || rowHost.parentElement;
    const records = options.materializeRow
        ? [...rowsOrRecords]
        : rowsOrRecords.map(serializeRow);
    const materializeRow = options.materializeRow || materializeSerializedRow;
    const selectedIds = new Set(
        records
            .filter(record => record.selected)
            .map(record => getRowId(record))
            .filter(Boolean)
    );

    const state = {
        rowHost,
        scrollContainer,
        allRecords: records,
        filteredRecords: [...records],
        filteredIds: new Set(records.map(record => getRowId(record)).filter(Boolean)),
        recordsById: new Map(records.map(record => [getRowId(record), record]).filter(([rowId]) => rowId)),
        renderedRowsById: new Map(),
        selectedIds,
        filterPredicate: null,
        materializeRow,
        rowHeight: options.rowHeight || DEFAULT_ROW_HEIGHT,
        buffer: options.buffer ?? DEFAULT_BUFFER,
        createSpacer: options.createSpacer || createTableSpacer,
        renderFrame: null,
        onScroll: () => scheduleVirtualRows(rowHost)
    };

    virtualTableStates.set(rowHost, state);
    scrollContainer?.addEventListener('scroll', state.onScroll, { passive: true });
    if (scrollContainer) {
        scrollContainer.scrollTop = 0;
    }
    renderVirtualRows(rowHost);
}

function serializeRow(row) {
    return {
        id: getRowId(row),
        html: row.outerHTML,
        selected: Boolean(row.querySelector?.('.row-checkbox')?.checked)
    };
}

function materializeSerializedRow(record) {
    const tableBody = document.createElement('tbody');
    tableBody.innerHTML = record.html;
    return tableBody.firstElementChild;
}

function rebuildFilteredRecords(state) {
    state.filteredRecords = state.filterPredicate
        ? state.allRecords.filter(state.filterPredicate)
        : [...state.allRecords];
    state.filteredIds = new Set(state.filteredRecords.map(record => getRowId(record)).filter(Boolean));
}

function scheduleVirtualRows(rowHost) {
    const state = getVirtualState(rowHost);
    if (!state || state.renderFrame !== null) return;
    state.renderFrame = requestAnimationFrame(() => {
        const currentState = getVirtualState(rowHost);
        if (!currentState) return;
        currentState.renderFrame = null;
        renderVirtualRows(rowHost);
    });
}

function renderVirtualRows(rowHost) {
    const state = getVirtualState(rowHost);
    if (!state) return;
    if (state.renderFrame !== null) cancelAnimationFrame(state.renderFrame);
    state.renderFrame = null;

    const { scrollContainer, filteredRecords, selectedIds, rowHeight, buffer } = state;
    const viewportHeight = scrollContainer?.clientHeight || 0;
    const scrollTop = scrollContainer?.scrollTop || 0;
    const firstVisible = Math.min(
        filteredRecords.length,
        Math.max(0, Math.floor(scrollTop / rowHeight) - buffer)
    );
    const visibleCount = Math.ceil(viewportHeight / rowHeight) + buffer * 2;
    const lastVisible = Math.min(filteredRecords.length, firstVisible + visibleCount);
    const fragment = document.createDocumentFragment();

    state.renderedRowsById.clear();
    fragment.appendChild(state.createSpacer(rowHost, firstVisible * rowHeight));
    for (let index = firstVisible; index < lastVisible; index += 1) {
        const record = filteredRecords[index];
        const row = state.materializeRow(record);
        if (!row) continue;
        const checkbox = row.querySelector?.('.row-checkbox');
        const rowId = getRowId(record) || getRowId(row);
        if (checkbox && rowId) {
            checkbox.checked = selectedIds.has(rowId);
        }
        row.style.display = '';
        if (rowId) state.renderedRowsById.set(rowId, row);
        fragment.appendChild(row);
    }
    fragment.appendChild(state.createSpacer(rowHost, (filteredRecords.length - lastVisible) * rowHeight));

    rowHost.replaceChildren(fragment);
}

function createTableSpacer(rowHost, height) {
    const row = document.createElement('tr');
    row.dataset.virtualSpacer = 'true';
    row.setAttribute('aria-hidden', 'true');

    const cell = document.createElement('td');
    cell.colSpan = rowHost.closest('table')?.tHead?.rows?.[0]?.cells?.length || 1;
    cell.style.height = `${Math.max(0, height)}px`;
    cell.style.padding = '0';
    cell.style.border = '0';
    row.appendChild(cell);

    return row;
}
