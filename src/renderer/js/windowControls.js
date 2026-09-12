import { getCurrentWindow } from '@tauri-apps/api/window';

const appWindow = getCurrentWindow();
const maximizeButton = document.getElementById('window-maximize');
let disposed = false;
let stateRequest = 0;

async function updateMaximizeState() {
    const request = ++stateRequest;
    try {
        const maximized = await appWindow.isMaximized();
        const key = maximized ? 'main.window_restore' : 'main.window_maximize';
        const label = await window.i18n.translate(key);
        if (disposed || request !== stateRequest || !maximizeButton) return;
        maximizeButton.dataset.maximized = String(maximized);
        maximizeButton.dataset.i18nTitle = key;
        maximizeButton.dataset.i18nAriaLabel = key;
        maximizeButton.setAttribute('title', label);
        maximizeButton.setAttribute('aria-label', label);
    } catch (error) {
        console.error('Unable to read window state:', error);
    }
}

for (const [id, action] of [
    ['window-minimize', () => appWindow.minimize()],
    ['window-maximize', () => appWindow.toggleMaximize()],
    ['window-close', () => appWindow.close()]
]) {
    document.getElementById(id)?.addEventListener('click', async () => {
        try {
            await action();
            if (id === 'window-maximize') await updateMaximizeState();
        } catch (error) {
            console.error('Unable to change window state:', error);
        }
    });
}

window.addEventListener('resize', updateMaximizeState);
const removeLanguageListener = window.api.receive('apply-language', updateMaximizeState);
window.addEventListener('pagehide', () => {
    disposed = true;
    window.removeEventListener('resize', updateMaximizeState);
    removeLanguageListener();
}, { once: true });
void updateMaximizeState();
