import './js/icons.js';
import './tailwind-output.css';
import './css/common.css';
import './css/main.css';
import { startRenderer } from './tauriBridge.js';

const tabModuleLoaders = {
    library: () => import(/* webpackChunkName: "tab-library" */ './js/libraryPage.js'),
    guides: () => import(/* webpackChunkName: "tab-guides" */ './js/guidesPage.js'),
    backup: () => import(/* webpackChunkName: "tab-backup" */ './js/backupTab.js'),
    restore: () => import(/* webpackChunkName: "tab-restore" */ './js/restoreTab.js'),
    sync: () => import(/* webpackChunkName: "tab-sync" */ './js/syncTab.js')
};

const loadedTabModules = new Map();
const readyTabModules = new Set();

function loadTabModule(tabName) {
    if (!loadedTabModules.has(tabName)) {
        const loading = tabModuleLoaders[tabName]().then((module) => {
            readyTabModules.add(tabName);
            return module;
        }).catch((error) => {
            loadedTabModules.delete(tabName);
            throw error;
        });
        loadedTabModules.set(tabName, loading);
    }
    return loadedTabModules.get(tabName);
}

startRenderer(async () => {
    await import('./js/commonTabs.js');
    await import('./js/windowControls.js');
    await loadTabModule('library');
    window.api.receive('run-scan-full', async () => {
        const backup = await loadTabModule('backup');
        await backup.runFullScan();
    });
    document.addEventListener('ogs:select-game-guide', (event) => {
        if (readyTabModules.has('guides')) return;
        const wikiPageId = event.detail?.wikiPageId;
        if (!wikiPageId) return;
        void loadTabModule('guides').then(() => {
            document.dispatchEvent(new CustomEvent('ogs:select-game-guide', { detail: { wikiPageId } }));
        }).catch(error => console.error('Unable to load game guides:', error));
    });
    document.addEventListener('ogs:navigate', (event) => {
        const route = event.detail?.route;
        if (tabModuleLoaders[route]) void loadTabModule(route).catch(error => console.error(`Unable to load ${route}:`, error));
    });
});
