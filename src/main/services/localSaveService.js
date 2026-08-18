const { shell } = require('electron');
const { execFile, spawn } = require('child_process');
const fsOriginal = require('original-fs');
const path = require('path');

const i18next = require('i18next');

const { normalizeRegistryKeyPath } = require('../validation');
const { getMainWin } = require('./windowManager');

async function openRegistryAtKey(keyPath) {
    const normalizedKey = normalizeRegistryKeyPath(keyPath);
    const safeKey = normalizedKey.replace(/^HKEY_/, 'Computer\\HKEY_');
    const args = [
        'add',
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Applets\\Regedit',
        '/v', 'LastKey',
        '/t', 'REG_SZ',
        '/d', safeKey,
        '/f'
    ];

    await new Promise((resolve, reject) => {
        execFile('reg.exe', args, { windowsHide: true }, (error) => error ? reject(error) : resolve());
    });
    const regedit = spawn('regedit.exe', [], { detached: true, stdio: 'ignore', shell: false, windowsHide: true });
    regedit.unref();
}

function deleteRegistryKey(keyPath) {
    return new Promise((resolve, reject) => {
        let normalizedKey;
        try {
            normalizedKey = normalizeRegistryKeyPath(keyPath);
        } catch (error) {
            reject(error);
            return;
        }
        const args = ['delete', normalizedKey, '/f'];
        execFile('reg.exe', args, { windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Failed to delete registry key: ${normalizedKey}`, stderr);
                resolve(false);
            } else {
                resolve(true);
            }
        });
    });
}

async function browseLocalSave(resolvedPaths) {
    try {
        const foldersToOpen = new Set();
        let registryKeyToOpen = null;

        // 1. Sort paths into Folders vs Registry
        for (const pathObj of resolvedPaths) {
            if (pathObj.type === 'reg') {
                // Only picking the first registry key to open the editor
                if (!registryKeyToOpen) {
                    registryKeyToOpen = pathObj.resolved;
                }
            } else {
                const fullPath = pathObj.resolved;
                if (!fullPath) continue;
                try {
                    const stats = await fsOriginal.promises.lstat(fullPath);
                    if (stats.isSymbolicLink()) continue;
                    if (stats.isFile()) foldersToOpen.add(path.dirname(fullPath));
                    else if (stats.isDirectory()) foldersToOpen.add(fullPath);
                } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                }
            }
        }

        const folders = Array.from(foldersToOpen);
        const hasRegistry = !!registryKeyToOpen;

        if (folders.length === 0 && !hasRegistry) {
            getMainWin().webContents.send('show-alert', 'warning', i18next.t('alert.no_local_save_found'));
            return;
        }

        // Open directories
        for (const folder of folders) {
            const errorMessage = await shell.openPath(folder);
            if (errorMessage) throw new Error(errorMessage);
        }

        // Open Registry
        if (hasRegistry && registryKeyToOpen) {
            await openRegistryAtKey(registryKeyToOpen);
        }

    } catch (error) {
        console.error('Error browsing local saves:', error);
    }
}

async function deleteLocalSave(resolvedPaths) {
    try {
        let success = true;

        for (const pathObj of resolvedPaths) {
            // Case A: Registry
            if (pathObj.type === 'reg') {
                if (pathObj.resolved) {
                    const regResult = await deleteRegistryKey(pathObj.resolved);
                    if (!regResult) success = false;
                }
            } else {
                // Case B: Files/Folders
                const fullPath = pathObj.resolved;
                if (fullPath) {
                    try {
                        const stats = await fsOriginal.promises.lstat(fullPath);
                        if (stats.isSymbolicLink()) {
                            throw new Error('Refusing to delete a symbolic link');
                        }
                        await fsOriginal.promises.rm(fullPath, { recursive: true, force: true });
                    } catch (err) {
                        if (err.code === 'ENOENT') continue;
                        console.error(`Failed to delete file path: ${fullPath}`, err);
                        success = false;
                    }
                }
            }
        }

        if (!success) {
            getMainWin().webContents.send('show-alert', 'error', i18next.t('alert.delete_partial_failure'));
        }
        return success;

    } catch (error) {
        console.error('Error deleting local saves:', error);
        getMainWin().webContents.send('show-alert', 'error', i18next.t('alert.delete_failed'));
        return false;
    }
}
module.exports = { browseLocalSave, deleteLocalSave };
