const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const VIRTUAL_TABLE_PATH = path.resolve(__dirname, '../src/renderer/js/virtualTable.js');

class FakeFragment {
    constructor() {
        this.children = [];
    }

    appendChild(child) {
        this.children.push(child);
        return child;
    }
}

class FakeRow {
    constructor(record) {
        this.record = record;
        this.id = '';
        this.style = {};
        this.checkbox = { checked: false, closest: () => this };
    }

    getAttribute(name) {
        return name === 'data-wiki-id' ? this.record.id : null;
    }

    querySelector(selector) {
        return selector === '.row-checkbox' ? this.checkbox : null;
    }
}

class FakeRowHost {
    constructor(scrollContainer) {
        this.children = [];
        this.parentElement = scrollContainer;
    }

    appendChild(fragment) {
        this.children.push(...fragment.children);
    }

    replaceChildren(fragment) {
        this.children = [...fragment.children];
    }

    closest() {
        return null;
    }

    querySelectorAll() {
        return [];
    }
}

function createScrollContainer() {
    return {
        clientHeight: 30,
        scrollTop: 0,
        addEventListener() {},
        removeEventListener() {}
    };
}

async function loadVirtualTableModule() {
    const source = fs.readFileSync(VIRTUAL_TABLE_PATH, 'utf8');
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('large virtual tables retain lightweight records and bound materialized DOM rows', async (t) => {
    const previousDocument = global.document;
    const previousRequestAnimationFrame = global.requestAnimationFrame;
    const previousCancelAnimationFrame = global.cancelAnimationFrame;
    global.document = { createDocumentFragment: () => new FakeFragment() };
    global.requestAnimationFrame = callback => {
        callback();
        return 1;
    };
    global.cancelAnimationFrame = () => {};
    t.after(() => {
        global.document = previousDocument;
        global.requestAnimationFrame = previousRequestAnimationFrame;
        global.cancelAnimationFrame = previousCancelAnimationFrame;
    });

    const virtualTable = await loadVirtualTableModule();
    assert.equal(virtualTable.getRowId(new FakeRow({ id: 'dom-row' })), 'dom-row');
    const scrollContainer = createScrollContainer();
    const rowHost = new FakeRowHost(scrollContainer);
    const records = Array.from({ length: 1_000 }, (_, index) => ({
        id: String(index),
        gameTitle: `Game ${index}`,
        rank: index,
        included: index % 2 === 0,
        selected: index === 0
    }));
    let materializedCount = 0;
    const materializeRow = record => {
        materializedCount += 1;
        return new FakeRow(record);
    };
    const createSpacer = () => ({ spacer: true });

    virtualTable.appendRows(rowHost, records, {
        threshold: 1,
        rowHeight: 10,
        buffer: 2,
        scrollContainer,
        materializeRow,
        createSpacer
    });

    const state = virtualTable.getVirtualState(rowHost);
    const materializedLimit = 7;
    assert.equal(state.allRecords.length, 1_000);
    assert.ok(state.allRecords.every(record => !(record instanceof FakeRow)));
    assert.ok(state.renderedRowsById.size <= materializedLimit);
    assert.ok(rowHost.children.length <= materializedLimit + 2);
    assert.equal(materializedCount, materializedLimit);

    let previousCount = materializedCount;
    virtualTable.applyVirtualFilter(rowHost, record => record.included);
    assert.equal(state.filteredRecords.length, 500);
    assert.equal(state.filteredIds.size, 500);
    assert.ok(materializedCount - previousCount <= materializedLimit);

    previousCount = materializedCount;
    virtualTable.sortVirtualRows(rowHost, items => items.sort((left, right) => right.rank - left.rank));
    assert.equal(state.allRecords[0].id, '999');
    assert.equal(state.filteredRecords[0].id, '998');
    assert.ok(materializedCount - previousCount <= materializedLimit);

    virtualTable.updateVirtualRecord(rowHost, '998', { gameTitle: 'Updated' });
    assert.equal(virtualTable.findVirtualRecord(rowHost, '998').gameTitle, 'Updated');
    assert.equal(virtualTable.findVirtualRow(rowHost, '998').record.gameTitle, 'Updated');

    virtualTable.setAllVirtualSelected(rowHost, true);
    assert.equal(virtualTable.getFilteredVirtualSelectedIds(rowHost).length, 500);
    virtualTable.removeVirtualRow(rowHost, '998');
    assert.equal(state.allRecords.length, 999);
    assert.equal(state.filteredRecords.length, 499);
    assert.equal(virtualTable.findVirtualRecord(rowHost, '998'), null);

    virtualTable.addVirtualRecord(rowHost, {
        id: '1000',
        gameTitle: 'Game 1000',
        rank: 1_000,
        included: true
    });
    assert.equal(state.allRecords.length, 1_000);
    assert.equal(state.filteredRecords.length, 500);

    previousCount = materializedCount;
    scrollContainer.scrollTop = 5_000;
    virtualTable.refreshVirtualRows(rowHost);
    assert.ok(state.renderedRowsById.size <= materializedLimit);
    assert.ok(materializedCount - previousCount <= materializedLimit);

    previousCount = materializedCount;
    virtualTable.updateVirtualRecord(rowHost, '800', { backgroundState: true }, { refilter: false });
    assert.equal(virtualTable.findVirtualRecord(rowHost, '800').backgroundState, true);
    assert.equal(materializedCount, previousCount);

    virtualTable.disableVirtualRows(rowHost);
    assert.equal(virtualTable.getVirtualState(rowHost), null);
    assert.equal(state.allRecords.length, 0);
    assert.equal(state.recordsById.size, 0);
    assert.equal(state.renderedRowsById.size, 0);
});
