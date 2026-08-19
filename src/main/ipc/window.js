const { BrowserWindow, dialog, ipcMain, shell } = require('electron');

const { randomUUID } = require('crypto');
const fsOriginal = require('original-fs');
const path = require('path');

const i18next = require('i18next');

const { getAllUserIds } = require('../gameData');
const { getMainWin, getSettings } = require('../global');
const { normalizeWikiId } = require('../validation');
const { getCachedIconMap } = require('../services/iconService');
const { TRUSTED_GUIDE_HOSTS } = require('../services/guideService');
const { getSavePlatformKey } = require('../services/platformService');

const ALLOWED_EXTERNAL_HOSTS = new Set([...TRUSTED_GUIDE_HOSTS, 'www.gnu.org']);

function isAllowedExternalUrl(url) {
    try {
        const parsedUrl = new URL(String(url || ''));
        return String(url || '').length <= 2048
            && parsedUrl.protocol === 'https:'
            && !parsedUrl.username
            && !parsedUrl.password
            && (!parsedUrl.port || parsedUrl.port === '443')
            && ALLOWED_EXTERNAL_HOSTS.has(parsedUrl.hostname.toLowerCase());
    } catch (error) {
        return false;
    }
}

function isDriveRoot(directoryPath) {
    const resolvedPath = path.resolve(directoryPath);
    return resolvedPath === path.parse(resolvedPath).root;
}

async function openConfiguredBackupDirectory(directoryPath) {
    const configuredBackupPath = path.resolve(getSettings().backupPath);
    const requestedPath = typeof directoryPath === 'string' ? path.resolve(directoryPath) : '';
    const comparePath = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (!requestedPath || comparePath(requestedPath) !== comparePath(configuredBackupPath)) {
        return { success: false, message: i18next.t('alert.github_sync_repo_missing') };
    }

    const stats = await fsOriginal.promises.lstat(requestedPath).catch(() => null);
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
        return { success: false, message: i18next.t('alert.github_sync_repo_missing') };
    }
    const message = await shell.openPath(requestedPath);
    return { success: !message, message };
}

async function selectPath(fileType) {
    const dialogOptions = { title: i18next.t('settings.select_path'), properties: [] };
    if (fileType === 'file') dialogOptions.properties = ['openFile'];
    else if (fileType === 'folder') dialogOptions.properties = ['openDirectory'];
    else if (fileType === 'registry') return null;
    else if (fileType === 'gsmr') {
        dialogOptions.properties = ['openFile'];
        dialogOptions.filters = [{ name: i18next.t('main.gsmr-file-type'), extensions: ['gsmr'] }];
    } else {
        throw new Error('Invalid path selection type');
    }

    const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), { ...dialogOptions, modal: true });
    return result.filePaths[0] || null;
}

function requestSelectedWikiIds(tableId) {
    if (tableId !== 'backup' && tableId !== 'restore') return Promise.resolve([]);
    const mainWindow = getMainWin();
    if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve([]);

    return new Promise((resolve) => {
        const requestId = randomUUID();
        const finish = (wikiIds) => {
            clearTimeout(timeout);
            ipcMain.removeListener('selected-wiki-ids-response', handleResponse);
            resolve(wikiIds);
        };
        const handleResponse = (event, responseId, wikiIds) => {
            if (event.sender !== mainWindow.webContents || responseId !== requestId) return;
            const safeWikiIds = [];
            for (const wikiId of Array.isArray(wikiIds) ? wikiIds.slice(0, 10000) : []) {
                try {
                    safeWikiIds.push(normalizeWikiId(wikiId));
                } catch (error) {
                    // Ignore stale, malformed renderer state.
                }
            }
            finish(safeWikiIds);
        };
        const timeout = setTimeout(() => finish([]), 3000);
        ipcMain.on('selected-wiki-ids-response', handleResponse);
        mainWindow.webContents.send('collect-selected-wiki-ids', requestId, tableId);
    });
}

function registerWindowIpc({ ensureGameDataReady }) {
    ipcMain.handle('open-url', async (event, url) => {
        if (!isAllowedExternalUrl(url)) throw new Error('Blocked external URL');
        await shell.openExternal(url);
    });
    ipcMain.handle('open-backup-dialog', async () => {
        const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
            title: i18next.t('settings.select_backup_path'),
            properties: ['openDirectory'],
            modal: true
        });
        const selectedPath = result.filePaths[0];
        return selectedPath && isDriveRoot(selectedPath) ? path.join(selectedPath, 'OGS Backups') : selectedPath || null;
    });
    ipcMain.handle('open-directory', (event, directoryPath) => openConfiguredBackupDirectory(directoryPath));
    ipcMain.handle('open-dialog', () => dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
        title: i18next.t('settings.select_path'),
        properties: ['openDirectory'],
        modal: true
    }));
    ipcMain.handle('select-path', (event, fileType) => selectPath(fileType));
    ipcMain.handle('get-account-data', async () => {
        await ensureGameDataReady();
        return getAllUserIds();
    });
    ipcMain.handle('get-platform', () => getSavePlatformKey());
    ipcMain.handle('get-icon-map', getCachedIconMap);
    ipcMain.handle('get-main-selected-wiki-ids', (event, tableId) => requestSelectedWikiIds(tableId));
}

module.exports = { isAllowedExternalUrl, registerWindowIpc };
