const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('out-of-order selection translations cannot overwrite newer count and size', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/tableSelection.js'), 'utf8')
        .replace(/^import [\s\S]*? from '[^']+';\r?\n/gm, '')
        .replace(/export /g, '');
    const countWidget = { textContent: '' };
    const sizeWidget = { textContent: '' };
    const tableBody = {};
    const table = { querySelector: () => tableBody };
    const translations = [];
    let selectedIds = ['1'];
    const context = vm.createContext({
        document: {
            querySelector: selector => ({
                '#backup': table,
                '#backup tbody': tableBody,
                '#backup-selected-count': countWidget,
                '#backup-selected-size': sizeWidget
            })[selector]
        },
        window: {
            backupTableDataMap: new Map([['1', { backup_size: 10 }], ['2', { backup_size: 20 }]]),
            i18n: {
                translate(key, options) {
                    return new Promise(resolve => { translations.push({ key, options, resolve }); });
                }
            }
        },
        formatSize: String,
        getFilteredVirtualSelectedIds: () => [...selectedIds],
        getFilteredVirtualRowIds: () => new Set(['1', '2']),
        getFilteredVirtualRows: () => [1, 2],
        getVirtualState: () => ({})
    });
    vm.runInContext(source, context);
    const first = vm.runInContext("updateSelectedCountAndSize('backup')", context);
    selectedIds = ['1', '2'];
    const second = vm.runInContext("updateSelectedCountAndSize('backup')", context);
    assert.equal(translations.length, 4, 'count and size translations run together');
    assert.equal(translations[2].options.count, 2);
    assert.equal(translations[3].options.size, '30');
    translations[2].resolve('2 selected');
    translations[3].resolve('30 bytes');
    await second;
    translations[0].resolve('1 selected');
    translations[1].resolve('10 bytes');
    await first;
    assert.equal(countWidget.textContent, '2 selected');
    assert.equal(sizeWidget.textContent, '30 bytes');
});
