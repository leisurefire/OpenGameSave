import './js/icons.js';
import './tailwind-output.css';
import './css/common.css';
import './css/main.css';
import './js/utility.js';
import { runWhenDomReady } from './js/commonTabs.js';

const tabModuleLoaders = {
    library: () => import(/* webpackChunkName: "tab-library" */ './js/libraryPage.js'),
    guides: () => import(/* webpackChunkName: "tab-guides" */ './js/guidesPage.js'),
    backup: () => import(/* webpackChunkName: "tab-backup" */ './js/backupTab.js'),
    restore: () => import(/* webpackChunkName: "tab-restore" */ './js/restoreTab.js'),
    sync: () => import(/* webpackChunkName: "tab-sync" */ './js/syncTab.js')
};

const loadedTabModules = new Map();

function loadTabModule(tabName) {
    if (!loadedTabModules.has(tabName)) {
        loadedTabModules.set(tabName, tabModuleLoaders[tabName]());
    }
    return loadedTabModules.get(tabName);
}

runWhenDomReady(() => {
    loadTabModule('library');
    document.addEventListener('ogs:navigate', (event) => {
        const route = event.detail?.route;
        if (tabModuleLoaders[route]) loadTabModule(route);
    });
});
