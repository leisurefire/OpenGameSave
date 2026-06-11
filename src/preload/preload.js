const { contextBridge, ipcRenderer } = require('electron');

const DEFAULT_ACCENT_COLOR = '#16c60c';

function setAccentColor(color) {
  if (document.documentElement) {
    document.documentElement.style.setProperty('--system-accent', color);
  }
}

async function applyAccentColor() {
  const settings = await ipcRenderer.invoke('get-settings');
  if (settings && settings.syncAccentColor) {
    const color = await ipcRenderer.invoke('get-accent-color');
    setAccentColor(color);
  } else {
    setAccentColor(DEFAULT_ACCENT_COLOR);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', applyAccentColor);
} else {
  applyAccentColor();
}

ipcRenderer.on('accent-color-changed', (event, color) => {
  setAccentColor(color);
});

contextBridge.exposeInMainWorld('api', {
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  receive: (channel, func) => ipcRenderer.on(channel, (event, ...args) => func(...args)),
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args)
});

contextBridge.exposeInMainWorld('i18n', {
  changeLanguage: (lng) => ipcRenderer.invoke('change-language', lng),
  translate: (key, options) => ipcRenderer.invoke('translate', key, options)
});
