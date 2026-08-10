const DEFAULT_THRESHOLD = 200;
const DEFAULT_ROW_HEIGHT = 57;
const DEFAULT_BUFFER = 8;

const virtualTableStates = new WeakMap();

export function getRowId(row) {
    return row?.getAttribute('data-wiki-id')?.trim();
}

export function getVirtualState(rowHost) {
    return rowHost ? virtualTableStates.get(rowHost) : null;
}

export function getVirtualRows(rowHost) {
    const state = getVirtualState(rowHost);
    return state ? state.allRows : Array.from(rowHost?.querySelectorAll('tr:not([data-virtual-spacer])') || []);
}

export function getFilteredVirtualRows(rowHost) {
    const state = getVirtualState(rowHost);
    return state ? state.filteredRows : getVirtualRows(rowHost).filter(row => row.style.display !== 'none');
}

export function getFilteredVirtualRowIds(rowHost) {
    const state = getVirtualState(rowHost);
    if (state) return state.filteredIds;
    return new Set(getFilteredVirtualRows(rowHost).map(row => getRowId(row)).filter(Boolean));
}

export function findVirtualRow(rowHost, rowId) {
    const state = getVirtualState(rowHost);
    if (!state) return null;
    return state.rowsById.get(rowId.toString()) || null;
}

export function appendRows(rowHost, rows, options = {}) {
    disableVirtualRows(rowHost);

    const threshold = options.threshold ?? DEFAULT_THRESHOLD;
    if (rows.length >= threshold) {
        enableVirtualRows(rowHost, rows, options);
        return;
    }

    const fragment = document.createDocumentFragment();
    rows.forEach(row => fragment.appendChild(row));
    rowHost.appendChild(fragment);
}

export function applyVirtualFilter(rowHost, predicate, { resetScroll = true } = {}) {
    const state = getVirtualState(rowHost);
    if (!state) return false;

    state.filteredRows = state.allRows.filter(predicate);
    state.filteredIds = new Set(state.filteredRows.map(row => getRowId(row)).filter(Boolean));
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

    state.filteredRows.forEach(row => {
        const rowId = getRowId(row);
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
    for (const row of state.filteredRows) {
        const rowId = getRowId(row);
        if (rowId && state.selectedIds.has(rowId)) selectedIds.push(rowId);
    }
    return selectedIds;
}

export function sortVirtualRows(rowHost, sorter) {
    const state = getVirtualState(rowHost);
    if (!state) return false;

    state.allRows = sorter(state.allRows);
    state.filteredRows = sorter(state.filteredRows);
    renderVirtualRows(rowHost);
    return true;
}

export function removeVirtualRow(rowHost, rowId) {
    const state = getVirtualState(rowHost);
    if (!state) return false;

    const targetId = rowId.toString();
    state.allRows = state.allRows.filter(row => getRowId(row) !== targetId);
    state.filteredRows = state.filteredRows.filter(row => getRowId(row) !== targetId);
    state.rowsById.delete(targetId);
    state.filteredIds.delete(targetId);
    state.selectedIds.delete(targetId);
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
}

function enableVirtualRows(rowHost, rows, options = {}) {
    const scrollContainer = options.scrollContainer || rowHost.closest('.table-container') || rowHost.parentElement;
    const selectedIds = new Set(
        rows
            .filter(row => row.querySelector('.row-checkbox')?.checked)
            .map(row => getRowId(row))
            .filter(Boolean)
    );

    const state = {
        rowHost,
        scrollContainer,
        allRows: rows,
        filteredRows: rows,
        filteredIds: new Set(rows.map(row => getRowId(row)).filter(Boolean)),
        rowsById: new Map(rows.map(row => [getRowId(row), row]).filter(([rowId]) => rowId)),
        selectedIds,
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

    const { scrollContainer, filteredRows, selectedIds, rowHeight, buffer } = state;
    const viewportHeight = scrollContainer?.clientHeight || 0;
    const scrollTop = scrollContainer?.scrollTop || 0;
    const firstVisible = Math.max(0, Math.floor(scrollTop / rowHeight) - buffer);
    const visibleCount = Math.ceil(viewportHeight / rowHeight) + buffer * 2;
    const lastVisible = Math.min(filteredRows.length, firstVisible + visibleCount);
    const fragment = document.createDocumentFragment();

    fragment.appendChild(state.createSpacer(rowHost, firstVisible * rowHeight));
    for (let index = firstVisible; index < lastVisible; index += 1) {
        const row = filteredRows[index];
        const checkbox = row.querySelector('.row-checkbox');
        const rowId = getRowId(row);
        if (checkbox && rowId) {
            checkbox.checked = selectedIds.has(rowId);
        }
        row.style.display = '';
        fragment.appendChild(row);
    }
    fragment.appendChild(state.createSpacer(rowHost, (filteredRows.length - lastVisible) * rowHeight));

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
