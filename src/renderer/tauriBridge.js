import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { createTauriBridge } from './tauriBridgeCore.js';

let bridge;

function syncWindowTitle() {
    const nativeWindow = getCurrentWebviewWindow();
    let pendingTitle = null;
    let disposed = false;
    let update = Promise.resolve();
    const sync = () => {
        const title = document.title.slice(0, 512) || 'OpenGameSave';
        if (title === pendingTitle || disposed) return;
        pendingTitle = title;
        update = update.then(async () => {
            if (!disposed && pendingTitle === title) await nativeWindow.setTitle(title);
        }).catch(error => console.error('Unable to update window title:', error));
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    window.addEventListener('pagehide', () => {
        disposed = true;
        observer.disconnect();
    }, { once: true });
    sync();
}

export function installTauriBridge() {
    if (!bridge) {
        const webview = getCurrentWebviewWindow();
        bridge = createTauriBridge({
            invoke,
            listen: (event, callback) => webview.listen(event, callback),
            targetWindow: window,
            targetDocument: document
        });
    }
    return bridge.ready;
}

export async function startRenderer(loadPage) {
    try {
        await installTauriBridge();
        if (document.readyState === 'loading') {
            await new Promise(resolve => { document.addEventListener('DOMContentLoaded', resolve, { once: true }); });
        }
        syncWindowTitle();
        await loadPage();
        await bridge.notifyReady();
    } catch (error) {
        bridge?.dispose();
        console.error('Unable to start this window:', error);
        const message = document.createElement('p');
        message.setAttribute('role', 'alert');
        message.textContent = `Unable to start OpenGameSave: ${error instanceof Error ? error.message : String(error)}`;
        document.body?.replaceChildren(message);
        if (document.body) document.body.style.visibility = 'visible';
    }
}
