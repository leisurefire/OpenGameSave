const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const libraryVirtualization = require('../src/shared/libraryVirtualization');

function loadLibrary(overrides = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/libraryPage.js'), 'utf8')
        .replace(/^import .*;\r?\n/gm, '')
        .replace(/initializeLibrary\(\);\s*$/, '');
    const context = vm.createContext({
        libraryVirtualization,
        console,
        URL,
        window: {},
        ...overrides
    });
    const reconciliation = fs.readFileSync(path.join(__dirname, '../src/renderer/js/virtualTable.js'), 'utf8')
        .match(/export function reconcileRenderedChildren[\s\S]*?\r?\n}/)[0].replace(/^export /, '');
    vm.runInContext(reconciliation, context);
    vm.runInContext(source, context);
    return context;
}

test('library scroll reuses overlapping cards and releases only artwork leaving the window', () => {
    let createdCards = 0;
    let offset = 0;
    const releasedImages = [];
    const makeCard = game => {
        createdCards += 1;
        const image = { dataset: { artRequestId: '1' }, onload() {}, onerror() {} };
        return {
            dataset: { gameId: game.id },
            image,
            querySelectorAll: selector => selector === 'img' ? [image] : [],
            getBoundingClientRect: () => ({ height: 58 })
        };
    };
    const grid = {
        children: [],
        get childNodes() { return this.children; },
        get firstChild() { return this.children[0] || null; },
        removeChild(card) {
            this.children.splice(this.children.indexOf(card), 1);
            card.parentNode = null;
            releasedImages.push(card.image);
        },
        insertBefore(card, reference) {
            card.parentNode?.removeChild(card);
            this.children.splice(reference ? this.children.indexOf(reference) : this.children.length, 0, card);
            card.parentNode = this;
            Object.defineProperty(card, 'nextSibling', {
                configurable: true,
                get: () => this.children[this.children.indexOf(card) + 1] || null
            });
        },
        style: {},
        clientWidth: 100,
        querySelectorAll(selector) {
            if (selector === '.library-card') return this.children;
            return [];
        },
        querySelector() { return this.children[0]; },
        replaceChildren(fragment) {
            for (const card of this.children) {
                if (!fragment.children.includes(card)) releasedImages.push(card.image);
            }
            this.children = fragment.children;
        },
        getBoundingClientRect: () => ({ top: -offset })
    };
    const context = loadLibrary({
        makeCard,
        elements: {
            grid,
            scroll: { clientHeight: 116, getBoundingClientRect: () => ({ top: 0 }) }
        },
        document: {
            createDocumentFragment: () => ({
                children: [],
                appendChild(child) { this.children.push(child); }
            })
        },
        getComputedStyle: () => ({ gridTemplateColumns: '100px', rowGap: '0', columnGap: '0' })
    });
    vm.runInContext(`
        libraryElements = elements;
        currentView = 'list';
        visibleLibraryGames = Array.from({ length: 1000 }, (_, i) => ({ id: String(i) }));
        createCard = makeCard;
        renderLibraryWindow();
    `, context);
    const original = new Map(grid.children.map(card => [card.dataset.gameId, card]));
    assert.equal(createdCards, 6);
    offset = 232;
    vm.runInContext('renderLibraryWindow();', context);
    assert.equal(createdCards, 10, 'scroll requests only the four entering cards');
    for (const card of grid.children) {
        if (original.has(card.dataset.gameId)) assert.equal(card, original.get(card.dataset.gameId));
    }
    assert.equal(releasedImages.length, 1);
    assert.equal(releasedImages[0].onload, null);
    assert.equal(releasedImages[0].onerror, null);
    assert.equal(releasedImages[0].dataset.artRequestId, undefined);
    for (const card of grid.children) {
        assert.ok(!releasedImages.includes(card.image), 'overlapping cards are never detached from the live DOM');
    }
    const currentCards = grid.children;
    vm.runInContext('renderLibraryWindow();', context);
    assert.equal(grid.children, currentCards);
    assert.equal(createdCards, 10);
});

test('rapid hero selections retain only the latest pending image request', async () => {
    const requests = [];
    const context = loadLibrary({
        window: {
            api: {
                invoke(channel, gameId) {
                    return new Promise(resolve => { requests.push({ channel, gameId, resolve }); });
                }
            }
        },
        heldImages: [0, 1].map(() => ({ isConnected: true, dataset: {} })),
        heroImage: { id: 'library-hero-image', isConnected: true, dataset: {} }
    });
    const completion = vm.runInContext(`
        const completions = heldImages.map((image, index) => loadArt(String(index), 'cover', image));
        for (let index = 0; index < 1000; index += 1) {
            selectedGameId = String(index);
            completions.push(loadArt(selectedGameId, 'hero', heroImage));
        }
        Promise.all(completions);
    `, context);
    assert.equal(vm.runInContext('pendingArtLoads.length', context), 1);
    assert.equal(requests.length, 2);
    requests[0].resolve(null);
    requests[1].resolve(null);
    await new Promise(resolve => { setImmediate(resolve); });
    assert.equal(requests.length, 3);
    assert.equal(requests[2].gameId, '999');
    requests[2].resolve(null);
    await completion;
    assert.equal(vm.runInContext('pendingArtLoads.length', context), 0);
});
