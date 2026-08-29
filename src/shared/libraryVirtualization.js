'use strict';

const DEFAULT_OVERSCAN_ROWS = 3;
const DEFAULT_MAX_RENDERED_ITEMS = 120;

function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function calculateLibraryWindow({
    itemCount,
    columnCount,
    rowStride,
    viewportStart,
    viewportSize,
    overscanRows = DEFAULT_OVERSCAN_ROWS,
    maxRenderedItems = DEFAULT_MAX_RENDERED_ITEMS
}) {
    const count = positiveInteger(itemCount, 0);
    const columns = positiveInteger(columnCount, 1);
    const stride = Math.max(1, nonNegativeNumber(rowStride, 1));
    const totalRows = Math.ceil(count / columns);
    if (totalRows === 0) {
        return {
            startIndex: 0,
            endIndex: 0,
            topPadding: 0,
            bottomPadding: 0,
            totalRows: 0
        };
    }

    const visibleRows = Math.max(1, Math.ceil(nonNegativeNumber(viewportSize) / stride) + 1);
    const firstVisibleRow = Math.min(
        totalRows - 1,
        Math.floor(nonNegativeNumber(viewportStart) / stride)
    );
    const overscan = Math.max(0, Math.floor(nonNegativeNumber(overscanRows)));
    const requestedStartRow = Math.max(0, firstVisibleRow - overscan);
    const requestedEndRow = Math.min(totalRows, firstVisibleRow + visibleRows + overscan);
    const itemBudgetRows = Math.max(1, Math.floor(positiveInteger(maxRenderedItems, columns) / columns));
    const windowRows = Math.max(visibleRows, itemBudgetRows);
    let startRow = requestedStartRow;
    let endRow = requestedEndRow;

    if (endRow - startRow > windowRows) {
        startRow = Math.max(0, firstVisibleRow - Math.min(overscan, windowRows - visibleRows));
        endRow = Math.min(totalRows, startRow + windowRows);
    }
    if (endRow - startRow < Math.min(totalRows, windowRows) && endRow === totalRows) {
        startRow = Math.max(0, endRow - windowRows);
    }

    return {
        startIndex: startRow * columns,
        endIndex: Math.min(count, endRow * columns),
        topPadding: startRow * stride,
        bottomPadding: Math.max(0, (totalRows - endRow) * stride),
        totalRows
    };
}

module.exports = {
    DEFAULT_MAX_RENDERED_ITEMS,
    DEFAULT_OVERSCAN_ROWS,
    calculateLibraryWindow
};
