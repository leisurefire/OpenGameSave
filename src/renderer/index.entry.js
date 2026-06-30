import "../../node_modules/@fortawesome/fontawesome-free/css/all.min.css"
import "./tailwind-output.css"
import "./css/common.css"
import "./css/main.css"
import "./js/utility.js"
import { runWhenDomReady } from "./js/commonTabs.js"

const tabModuleLoaders = {
    backup: () => import(/* webpackChunkName: "tab-backup" */ "./js/backupTab.js"),
    restore: () => import(/* webpackChunkName: "tab-restore" */ "./js/restoreTab.js"),
    sync: () => import(/* webpackChunkName: "tab-sync" */ "./js/syncTab.js"),
};

const loadedTabModules = new Map();

function loadTabModule(tabName) {
    if (!loadedTabModules.has(tabName)) {
        loadedTabModules.set(tabName, tabModuleLoaders[tabName]());
    }
    return loadedTabModules.get(tabName);
}

runWhenDomReady(() => {
    loadTabModule('backup');

    document.getElementById('restore-tab')?.addEventListener('click', () => {
        loadTabModule('restore');
    }, { once: true });

    document.getElementById('sync-tab')?.addEventListener('click', () => {
        loadTabModule('sync');
    }, { once: true });
});
