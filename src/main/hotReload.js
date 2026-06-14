const path = require('path');
const { app, BrowserWindow } = require('electron');
const chokidar = require('chokidar');

/**
 * Setup hot reload for renderer process (development only)
 */
function setupHotReload() {
    if (process.env.NODE_ENV === 'production') {
        return;
    }

    // From dist/out/
    const rendererPath = path.resolve(__dirname, '../renderer');
    let reloadTimeout;

    const watcher = chokidar.watch(rendererPath, {
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
        ignored: [/(^|[/\\])\.\./, '**/node_modules', '**/*.map']
    });

    watcher.on('change', () => {
        clearTimeout(reloadTimeout);
        reloadTimeout = setTimeout(() => {
            BrowserWindow.getAllWindows().forEach(window => {
                // Skip the internal menu popup window — it is managed by the
                // main process and must not be hot-reloaded. Reloading it
                // destroys the 'set-menu-items' IPC listener registered in
                // menu.html, which causes the menu to stop responding after
                // any hot reload cycle.
                const url = window.webContents.getURL();
                if (url && url.includes('menu.html')) {
                    return;
                }
                window.webContents.reloadIgnoringCache();
            });
        }, 300);
    });

    app.on('quit', () => watcher.close());

    return watcher;
}

module.exports = setupHotReload;
