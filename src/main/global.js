const { BrowserWindow, Menu, Notification, app, dialog, ipcMain, shell, nativeTheme } = require('electron');

const fs = require('fs');
const fsOriginal = require('original-fs');
const os = require('os');
const path = require('path');
const { exec, spawn } = require('child_process');

const axios = require('axios');
const fse = require('fs-extra');
const i18next = require('i18next');
const moment = require('moment');
const Seven = require('node-7z');
const sevenBin = require('7zip-bin');



let win;
let settingsWin;
let aboutWin;
let settings;
let writeQueue = Promise.resolve();
let allowAuxiliaryWindowClose = false;

const appVersion = "0.6.22 D.VA edition";
const appRepositoryUrl = 'https://github.com/leisurefire/OpenGameSave';
const appRepositoryApiLatestReleaseUrl = 'https://api.github.com/repos/leisurefire/OpenGameSave/releases/latest';
const supportedLanguages = new Set(['en_US', 'zh_CN']);
const normalizeLanguage = (language) => supportedLanguages.has(language) ? language : 'en_US';
const isWindows = process.platform === 'win32';

nativeTheme.themeSource = 'dark';

const windowVisualEffect = isWindows ? {
    backgroundMaterial: 'mica',
    backgroundColor: '#00000000'
} : {};

const applyWindowsMicaEffect = (browserWindow) => {
    if (!isWindows || !browserWindow) {
        return;
    }

    if (typeof browserWindow.setBackgroundMaterial === 'function') {
        browserWindow.setBackgroundMaterial('mica');
    }

    browserWindow.setBackgroundColor('#00000000');
};

let status = {
    backuping: false,
    scanning_full: false,
    restoring: false,
    migrating: false,
    updating_db: false,
    exporting: false,
    importing: false,
    updating_backup: false,
    updating_restore: false,
    github_syncing: false
}

const showAuxiliaryWindow = (browserWindow) => {
    if (!browserWindow || browserWindow.isDestroyed()) {
        return;
    }

    browserWindow.show();
    browserWindow.focus();
};

const createSettingsWindow = (showWhenReady = true) => {
    let settings_window_size = [620, 820];
    settingsWin = new BrowserWindow({
        width: settings_window_size[0],
        height: settings_window_size[1],
        minWidth: settings_window_size[0],
        minHeight: settings_window_size[1],
        resizable: false,
        show: false,
        icon: path.join(__dirname, "../assets/setting.ico"),
        parent: win,
        modal: true,
        ...windowVisualEffect,
        webPreferences: {
            preload: path.join(__dirname, "../preload/preload.js"),
            sandbox: false,
        },
    });

    applyWindowsMicaEffect(settingsWin);

    if (!app.isPackaged) {
        settingsWin.webContents.openDevTools({ mode: "detach" });
    }
    settingsWin.setMenuBarVisibility(false);
    settingsWin.loadFile(path.join(__dirname, "../renderer/settings.html"));

    settingsWin.once('ready-to-show', () => {
        if (showWhenReady) {
            showAuxiliaryWindow(settingsWin);
        }
    });

    settingsWin.on('close', (event) => {
        if (!allowAuxiliaryWindowClose && settingsWin && !settingsWin.isDestroyed()) {
            event.preventDefault();
            settingsWin.hide();
        }
    });

    settingsWin.on("closed", () => {
        settingsWin = null;
    });
};

const openSettingsWindow = () => {
    if (!settingsWin || settingsWin.isDestroyed()) {
        createSettingsWindow(true);
    } else {
        showAuxiliaryWindow(settingsWin);
    }
};

const createAboutWindow = (showWhenReady = true) => {
    let about_window_size = [480, 380];
    aboutWin = new BrowserWindow({
        width: about_window_size[0],
        height: about_window_size[1],
        resizable: false,
        show: false,
        icon: path.join(__dirname, "../assets/logo.ico"),
        parent: win,
        modal: true,
        ...windowVisualEffect,
        webPreferences: {
            preload: path.join(__dirname, "../preload/preload.js"),
            sandbox: false,
        },
    });

    applyWindowsMicaEffect(aboutWin);

    if (!app.isPackaged) {
        aboutWin.webContents.openDevTools({ mode: "detach" });
    }
    aboutWin.setMenuBarVisibility(false);
    aboutWin.loadFile(path.join(__dirname, "../renderer/about.html"));

    aboutWin.once('ready-to-show', () => {
        if (showWhenReady) {
            showAuxiliaryWindow(aboutWin);
        }
    });

    aboutWin.on('close', (event) => {
        if (!allowAuxiliaryWindowClose && aboutWin && !aboutWin.isDestroyed()) {
            event.preventDefault();
            aboutWin.hide();
        }
    });

    aboutWin.on("closed", () => {
        aboutWin = null;
    });
};

const openAboutWindow = () => {
    if (!aboutWin || aboutWin.isDestroyed()) {
        createAboutWindow(true);
    } else {
        showAuxiliaryWindow(aboutWin);
    }
};

const preloadAuxiliaryWindows = () => {
    if (!settingsWin || settingsWin.isDestroyed()) {
        createSettingsWindow(false);
    }

    if (!aboutWin || aboutWin.isDestroyed()) {
        createAboutWindow(false);
    }
};

// Menu settings
const initializeMenu = () => {
    return [
        {
            label: i18next.t("main.options"),
            submenu: [
                {
                    label: i18next.t("settings.title"),
                    click() {
                        openSettingsWindow();
                    },
                },
                {
                    label: i18next.t("main.view_account_ids"),
                    click() {
                        win.webContents.send("view_account_ids");
                    },
                },
                {
                    label: i18next.t("main.scan_full"),
                    click() {
                        win.webContents.send("scan-full");
                    },
                },
                {
                    label: i18next.t("about.title"),
                    click() {
                        openAboutWindow();
                    },
                },
            ],
        },
        {
            label: i18next.t("main.export"),
            click() {
                win.webContents.send("open-export-modal");
            },
        },
        {
            label: i18next.t("main.import"),
            click() {
                win.webContents.send("open-import-modal", "");
            },
        },
    ];
}

// Main window
const createMainWindow = async () => {
    let main_window_size = [1150, 750];
    win = new BrowserWindow({
        width: main_window_size[0],
        height: main_window_size[1],
        minWidth: main_window_size[0],
        minHeight: main_window_size[1],
        icon: path.join(__dirname, "../assets/logo.ico"),
        ...windowVisualEffect,
        webPreferences: {
            preload: path.join(__dirname, "../preload/preload.js"),
            sandbox: false,
        },
    });

    applyWindowsMicaEffect(win);

    if (!app.isPackaged) {
        win.webContents.openDevTools({ mode: "detach" });
    }
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
    win.setMenuBarVisibility(false);
    Menu.setApplicationMenu(null);

    win.on("close", () => {
        allowAuxiliaryWindowClose = true;
    });

    win.on("closed", () => {
        BrowserWindow.getAllWindows().forEach((window) => {
            if (window !== win) {
                window.close();
            }
        });

        if (process.platform !== "darwin") {
            app.quit();
        }
    });
};

function resource_path(resource_name) {
    if (!app.isPackaged) {
        return path.join(__dirname, "../assets_export", resource_name);
    } else {
        return path.join(process.resourcesPath, "assets_export", resource_name);
    }
}

async function getLatestVersion(appName) {
    try {
        const response = await axios.get(appRepositoryApiLatestReleaseUrl, {
            headers: {
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'OpenGameSave'
            },
            timeout: 15000 // 15 seconds
        });

        const latestVersion = response.data?.tag_name || response.data?.name;
        if (latestVersion) {
            return latestVersion.replace(/^v/i, '');
        } else {
            console.error(`Error: release version not found in GitHub response. Response: ${JSON.stringify(response.data)}`);
            return null;
        }
    } catch (error) {
        console.error(`Error retrieving latest version from GitHub for ${appName}: ${error.message}`);
        return null;
    }
}


async function checkAppUpdate() {
    try {
        const latestVersion = await getLatestVersion('OpenGameSave');

        if (latestVersion > appVersion) {
            showNotification(
                "app",
                i18next.t('alert.update_available'),
                `${i18next.t('alert.new_version_found', { old_version: appVersion, new_version: latestVersion })}\n` +
                `${i18next.t('alert.new_version_found_text')}`,
                latestVersion
            );
        }

    } catch (error) {
        console.error("Error checking for update:", error.stack);
        showNotification(
            "app",
            i18next.t('alert.update_check_failed'),
            i18next.t('alert.update_check_failed_text')
        );
    }
}

function showNotification(type, title, body, latest_version = 0) {
    const icon_map = {
        'app': resource_path('logo.png'),
        'info': resource_path('information.png'),
        'warning': resource_path('warning.png'),
        'critical': resource_path('critical.png'),
    }

    if (process.platform === 'win32') {
        const actionsXml = latest_version ? `
                <actions>
                    <action content="${i18next.t("alert.yes")}" activationType="protocol" arguments="gamesavemanager://yes"/>
                    <action content="${i18next.t("alert.no")}" activationType="protocol" arguments="gamesavemanager://no"/>
                </actions>` : '';

        const toastXml = `
            <toast launch="gamesavemanager://default-click">
                <visual>
                    <binding template="ToastImageAndText04">
                        <image id="1" src="${icon_map[type]}" placement="appLogoOverride"/>
                        <text id="1">${title}</text>
                        <text id="2">${body}</text>
                    </binding>
                </visual>${actionsXml}
            </toast>
        `;

        app.setAppUserModelId('com.leisurefire.opengamesave');
        const notification = new Notification({
            toastXml: toastXml
        });
        notification.show();

        if (latest_version) {
            const handleAction = (event, action) => {
                if (action === 'yes') {
                    updateApp(latest_version);
                }
                ipcMain.removeListener('notification-action', handleAction);
            };
            ipcMain.on('notification-action', handleAction);
        }

    } else {
        const notification = new Notification({
            title: title,
            body: body,
            icon: icon_map[type]
        });
        notification.show();
    }
}

function showBackgroundNotification(type, title, body) {
    if (!win || win.isDestroyed()) {
        return;
    }

    const isInBackground = !win.isFocused() || win.isMinimized() || !win.isVisible();
    if (isInBackground) {
        showNotification(type, title, body);
    }
}

function updateApp(latest_version) {
    const updaterPath = './Updater.exe';
    const s3Path = `OpenGameSave/OpenGameSave Setup ${latest_version}.exe`;
    const args = ['--pid', process.pid, '--s3-path', s3Path, '--language', settings['language']];

    try {
        const updaterProcess = spawn(updaterPath, args, {
            detached: true,
            stdio: 'ignore',
        });
        updaterProcess.unref();

    } catch (error) {
        console.error('An error occurred while trying to spawn the updater process:', error);
    }
}

function getGameDisplayName(gameObj) {
    if (settings.language === "en_US") {
        return gameObj.title;
    } else if (settings.language === "zh_CN") {
        return gameObj.zh_CN || gameObj.title;
    }
}

// Calculates the total size of a directory or file
function calculateDirectorySize(directoryPath, ignoreConfig = true) {
    let totalSize = 0;

    try {
        if (fsOriginal.statSync(directoryPath).isDirectory()) {
            const files = fsOriginal.readdirSync(directoryPath);
            files.forEach(file => {
                if (ignoreConfig && file === 'backup_info.json') {
                    return;
                }
                const filePath = path.join(directoryPath, file);
                if (fsOriginal.statSync(filePath).isDirectory()) {
                    totalSize += calculateDirectorySize(filePath);
                } else {
                    totalSize += fsOriginal.statSync(filePath).size;
                }
            });

        } else {
            totalSize += fsOriginal.statSync(directoryPath).size;
        }

    } catch (error) {
        console.error(`Error calculating directory size for ${directoryPath}:`, error);
    }

    return totalSize;
}

// Ensure all files under a path have writable permission
function ensureWritable(pathToCheck) {
    if (!fsOriginal.existsSync(pathToCheck)) {
        return;
    }

    const stats = fsOriginal.statSync(pathToCheck);

    if (stats.isDirectory()) {
        const items = fsOriginal.readdirSync(pathToCheck);

        for (const item of items) {
            const fullPath = path.join(pathToCheck, item);
            ensureWritable(fullPath);
        }

    } else {
        if (!(stats.mode & 0o200)) {
            fsOriginal.chmod(pathToCheck, 0o666, (err) => {
                if (err) {
                    throw (`Error changing permissions for ${pathToCheck}:`, err);
                }
            });
        }
    }
}

function getNewestBackup(wiki_page_id) {
    const backupDir = path.join(settings.backupPath, wiki_page_id.toString());

    if (!fsOriginal.existsSync(backupDir)) {
        return i18next.t('main.no_backups');
    }

    const backups = fsOriginal.readdirSync(backupDir).filter(file => {
        const fullPath = path.join(backupDir, file);
        return fsOriginal.statSync(fullPath).isDirectory();
    });

    if (backups.length === 0) {
        return i18next.t('main.no_backups');
    }

    const latestBackup = backups.sort((a, b) => {
        return b.localeCompare(a);
    })[0];

    return moment(latestBackup, 'YYYY-MM-DD_HH-mm').format('YYYY/MM/DD HH:mm');
}

function updateStatus(statusKey, statusValue) {
    status[statusKey] = statusValue;
}

function fsOriginalCopyFolder(source, target) {
    fsOriginal.mkdirSync(target, { recursive: true });

    const items = fsOriginal.readdirSync(source);

    for (const item of items) {
        const sourcePath = path.join(source, item);
        const destinationPath = path.join(target, item);

        const stats = fsOriginal.statSync(sourcePath);

        if (stats.isDirectory()) {
            fsOriginalCopyFolder(sourcePath, destinationPath);
        } else {
            fsOriginal.copyFileSync(sourcePath, destinationPath);
        }
    }
}

async function exportBackups(count, exportPath, wikiIds = null) {
    const progressId = 'export';
    const progressTitle = i18next.t('alert.exporting');
    const sourcePath = settings.backupPath;

    try {
        if (!exportPath) {
            win.webContents.send('show-alert', 'warning', i18next.t('alert.empty_export_path'));
            return;
        }

        if (!status.exporting) {
            status.exporting = true;
            win.webContents.send('update-progress', progressId, progressTitle, 'start');

            // Build the list of relative paths to archive
            let itemsToArchive = [];

            const items = fsOriginal.readdirSync(sourcePath);
            let gameFolders = items.filter(item => {
                const fullPath = path.join(sourcePath, item);
                return fsOriginal.lstatSync(fullPath).isDirectory();
            });

            // Filter to selected games if wikiIds provided
            if (wikiIds && wikiIds.length > 0) {
                const wikiIdSet = new Set(wikiIds.map(String));
                gameFolders = gameFolders.filter(folder => wikiIdSet.has(folder));
            }

            // For each game folder, select the most recent backup instances
            // Permanent backups are always included regardless of count
            for (const gameId of gameFolders) {
                const gameFolderPath = path.join(sourcePath, gameId);
                let backups = fsOriginal.readdirSync(gameFolderPath).filter(item => {
                    const fullPath = path.join(gameFolderPath, item);
                    return fsOriginal.lstatSync(fullPath).isDirectory();
                });

                const permanentBackups = [];
                const nonPermanentBackups = [];
                for (const backup of backups) {
                    const infoPath = path.join(gameFolderPath, backup, 'backup_info.json');
                    if (fsOriginal.existsSync(infoPath)) {
                        const info = fse.readJsonSync(infoPath);
                        if (info.is_permanent) {
                            permanentBackups.push(backup);
                            continue;
                        }
                    }
                    nonPermanentBackups.push(backup);
                }

                nonPermanentBackups.sort((a, b) => b.localeCompare(a));
                const selected = nonPermanentBackups.slice(0, count);

                for (const backupFolder of [...permanentBackups, ...selected]) {
                    itemsToArchive.push(path.join(gameId, backupFolder));
                }
            }

            const timestamp = moment().format('YYYY-MM-DD_HH-mm');
            const finalFileName = `GSMBackup-${timestamp}.gsmr`;
            const finalDestPath = path.join(exportPath, finalFileName);

            const sevenOptions = {
                yes: true,
                recursive: true,
                $bin: sevenBin.path7za.replace('app.asar', 'app.asar.unpacked'),
                $progress: true,
                $raw: []
            };

            const originalCwd = process.cwd();
            process.chdir(sourcePath);
            const archiveStream = Seven.add(finalDestPath, itemsToArchive, sevenOptions);

            archiveStream.on('progress', (progress) => {
                if (progress.percent) {
                    win.webContents.send('update-progress', progressId, progressTitle, Math.floor(progress.percent));
                }
            });

            await new Promise((resolve, reject) => {
                archiveStream.on('end', resolve);
                archiveStream.on('error', reject);
            });

            process.chdir(originalCwd);
            win.webContents.send('update-progress', progressId, progressTitle, 'end');
            win.webContents.send('show-alert', 'success', i18next.t('alert.export_success'));
            status.exporting = false;
        }

    } catch (error) {
        console.error(`An error occurred while exporting backups: ${error.message}`);
        win.webContents.send('show-alert', 'modal', i18next.t('alert.error_during_export'), error.message);
        win.webContents.send('update-progress', progressId, progressTitle, 'end');
        status.exporting = false;
    }
}

async function importBackups(gsmPath) {
    const progressId = 'import';
    const progressTitle = i18next.t('alert.importing');
    const destinationPath = settings.backupPath;

    try {
        if (!status.importing) {
            status.importing = true;
            win.webContents.send('update-progress', progressId, progressTitle, 'start');

            // 1. Extract the GSMR file to a temporary directory
            const tempExtractPath = fsOriginal.mkdtempSync(path.join(os.tmpdir(), 'GSMImportTemp-'));
            const sevenOptions = {
                yes: true,
                recursive: true,
                $bin: sevenBin.path7za.replace('app.asar', 'app.asar.unpacked'),
                $progress: true,
                $raw: []
            };

            const extractStream = Seven.extractFull(gsmPath, tempExtractPath, sevenOptions);

            extractStream.on('progress', (progress) => {
                if (progress.percent) {
                    const overallProgress = Math.floor(progress.percent * 0.5);
                    win.webContents.send('update-progress', progressId, progressTitle, Math.floor(overallProgress));
                }
            });

            await new Promise((resolve, reject) => {
                extractStream.on('end', resolve);
                extractStream.on('error', reject);
            });

            const extractedItems = fsOriginal.readdirSync(tempExtractPath);

            // 2. Process game backup folders
            let totalBackups = extractedItems.length;
            let processedBackups = 0;

            for (const item of extractedItems) {
                const itemPath = path.join(tempExtractPath, item);
                if (fsOriginal.lstatSync(itemPath).isDirectory()) {
                    const gameId = item;
                    const destGameFolder = path.join(destinationPath, gameId);

                    const backupFolders = fsOriginal.readdirSync(itemPath).filter(sub => {
                        const subPath = path.join(itemPath, sub);
                        return fsOriginal.lstatSync(subPath).isDirectory();
                    });

                    // For each backup instance folder, skip if the same folder exists in destination
                    backupFolders.forEach(backupFolder => {
                        const srcBackupPath = path.join(itemPath, backupFolder);
                        const destBackupPath = path.join(destGameFolder, backupFolder);
                        if (!fsOriginal.existsSync(destBackupPath)) {
                            fsOriginalCopyFolder(srcBackupPath, destBackupPath);
                        }
                    });
                }

                processedBackups++;
                const movingProgress = totalBackups ? Math.floor((processedBackups / totalBackups) * 50) : 50;
                const overallProgress = 50 + movingProgress;
                win.webContents.send('update-progress', progressId, progressTitle, overallProgress);
            }

            win.webContents.send('show-alert', 'success', i18next.t('alert.import_success'));
            status.importing = false;

            await fsOriginal.promises.rm(tempExtractPath, { recursive: true });
        }

    } catch (error) {
        console.error(`An error occurred while importing backups: ${error.message}`);
        win.webContents.send('show-alert', 'modal', i18next.t('alert.error_during_import'), error.message);
        status.importing = false;

    } finally {
        win.webContents.send('update-progress', progressId, progressTitle, 'end');
        win.webContents.send('update-backup-table');
        win.webContents.send('update-restore-table');
    }
}

async function openRegistryAtKey(keyPath) {
    // Set the "LastKey" preference in Regedit so it opens where we want
    const safeKey = keyPath.replace(/^HKEY_/, 'Computer\\HKEY_');
    const setLastKeyCommand = `reg add "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Applets\\Regedit" /v "LastKey" /t REG_SZ /d "${safeKey}" /f`;

    exec(setLastKeyCommand, (error) => {
        const regedit = spawn('regedit.exe', [], { detached: true, stdio: 'ignore', shell: true });
        regedit.unref();
    });
}

function deleteRegistryKey(keyPath) {
    return new Promise((resolve, reject) => {
        const cmd = `reg delete "${keyPath}" /f`;
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error(`Failed to delete registry key: ${keyPath}`, stderr);
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
                if (fullPath && fsOriginal.existsSync(fullPath)) {
                    const stats = fsOriginal.statSync(fullPath);
                    if (stats.isFile()) {
                        foldersToOpen.add(path.dirname(fullPath));
                    } else if (stats.isDirectory()) {
                        foldersToOpen.add(fullPath);
                    }
                }
            }
        }

        const folders = Array.from(foldersToOpen);
        const hasRegistry = !!registryKeyToOpen;

        if (folders.length === 0 && !hasRegistry) {
            win.send('show-alert', 'warning', i18next.t('alert.no_local_save_found'));
            return;
        }

        // 2. Open a single directory directly. Prompt only when multiple
        // directories or any registry key will be opened.
        const shouldPrompt = hasRegistry || folders.length > 1;
        let canOpen = true;

        if (shouldPrompt) {
            let message = '';
            if (folders.length > 0 && hasRegistry) {
                message = i18next.t('alert.confirm_open_folders_and_reg', {
                    count: folders.length
                });
            } else if (hasRegistry) {
                message = i18next.t('alert.confirm_open_reg');
            } else {
                message = i18next.t('alert.confirm_open_folders', {
                    count: folders.length
                });
            }

            const response = await dialog.showMessageBox(win, {
                type: 'question',
                title: i18next.t('main.browse_local_save'),
                message: message,
                buttons: [i18next.t('alert.yes'), i18next.t('alert.no')],
                defaultId: 0,
                cancelId: 1
            });
            canOpen = response.response === 0;
        }

        if (canOpen) {
            // Open directories
            for (const folder of folders) {
                await shell.openPath(folder);
            }

            // Open Registry
            if (hasRegistry && registryKeyToOpen) {
                await openRegistryAtKey(registryKeyToOpen);
            }
        }

    } catch (error) {
        console.error('Error browsing local saves:', error);
    }
}

async function deleteLocalSave(resolvedPaths) {
    try {
        // 1. Ask for confirmation
        const response = await dialog.showMessageBox(win, {
            type: 'warning',
            title: i18next.t('main.delete_local_save'),
            message: i18next.t('alert.confirm_delete_local_save_message'),
            buttons: [i18next.t('alert.yes'), i18next.t('alert.no')],
            defaultId: 1,
            cancelId: 1
        });

        // 2. Delete paths if confirmed
        if (response.response === 0) {
            let success = true;

            for (const pathObj of resolvedPaths) {
                // Case A: Registry
                if (pathObj.type === 'reg') {
                    if (pathObj.resolved) {
                        const regResult = await deleteRegistryKey(pathObj.resolved);
                        if (!regResult) success = false;
                    }
                }
                // Case B: Files/Folders
                else {
                    const fullPath = pathObj.resolved;
                    if (fullPath && fsOriginal.existsSync(fullPath)) {
                        try {
                            fsOriginal.rmSync(fullPath, { recursive: true, force: true });
                        } catch (err) {
                            console.error(`Failed to delete file path: ${fullPath}`, err);
                            success = false;
                        }
                    }
                }
            }

            if (!success) {
                win.send('show-alert', 'error', i18next.t('alert.delete_partial_failure'));
            }
            return true;
        }

        return false;

    } catch (error) {
        console.error('Error deleting local saves:', error);
        win.send('show-alert', 'error', i18next.t('alert.delete_failed'));
        return false;
    }
}

const placeholder_mapping = {
    // Windows
    '{{p|username}}': os.userInfo().username,
    '{{p|userprofile}}': process.env.USERPROFILE || os.homedir(),
    '{{p|userprofile/documents}}': path.join(process.env.USERPROFILE || os.homedir(), 'Documents'),
    '{{p|userprofile/appdata/locallow}}': path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'LocalLow'),
    '{{p|appdata}}': process.env.APPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Roaming'),
    '{{p|localappdata}}': process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local'),
    '{{p|programfiles}}': process.env.PROGRAMFILES || 'C:\\Program Files',
    '{{p|programdata}}': process.env.PROGRAMDATA || 'C:\\ProgramData',
    '{{p|public}}': path.join(process.env.PUBLIC || 'C:\\Users\\Public'),
    '{{p|windir}}': process.env.WINDIR || 'C:\\Windows',

    // Registry
    '{{p|hkcu}}': 'HKEY_CURRENT_USER',
    '{{p|hklm}}': 'HKEY_LOCAL_MACHINE',
    '{{p|wow64}}': 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node',

    // Mac
    '{{p|osxhome}}': os.homedir(),

    // Linux
    '{{p|linuxhome}}': os.homedir(),
    '{{p|xdgdatahome}}': process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    '{{p|xdgconfighome}}': process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
};

const osKeyMap = {
    win32: 'win',
    darwin: 'mac',
    linux: 'linux'
};

// ======================================================================
// Settings
// ======================================================================
const loadSettings = () => {
    const userDataPath = app.getPath("userData");
    const appDataPath = app.getPath("appData");
    const settingsPath = path.join(userDataPath, "OGS Settings", "settings.json");

    const locale_mapping = {
        'en': 'en_US',
        'en-US': 'en_US',
        'zh': 'zh_CN',
        'zh-CN': 'zh_CN',
        'zh-SG': 'zh_CN',
        'zh-Hans': 'zh_CN',
        'zh-Hans-CN': 'zh_CN',
        'zh-Hans-SG': 'zh_CN',
    };

    const detectLanguage = () => {
        const locales = [app.getLocale(), ...app.getPreferredSystemLanguages()];
        const detectedLocale = locales.find(locale => {
            if (!locale) return false;
            return supportedLanguages.has(locale_mapping[locale]) || locale.toLowerCase().startsWith('zh');
        });

        if (detectedLocale && detectedLocale.toLowerCase().startsWith('zh')) {
            return 'zh_CN';
        }

        return normalizeLanguage(locale_mapping[detectedLocale]);
    };

    const systemLocale = app.getLocale();
    console.log(`Current locale: ${systemLocale}; Preferred languages: ${app.getPreferredSystemLanguages()}`);
    const detectedLanguage = detectLanguage();
    const isFirstLaunch = !fs.existsSync(settingsPath);

    // Default settings
    const defaultSettings = {
        language: detectedLanguage,
        backupPath: path.join(appDataPath, "OGS Backups"),
        exportPath: "",
        maxBackups: 5,
        autoAppUpdate: true,
        autoDbUpdate: false,
        backupAllAccounts: false,
        saveUninstalledGames: true,
        gameInstalls: 'uninitialized',
        pinnedGames: [],
        blockedGames: [],
        blockedGameTipDismissed: false,
        uninstalledGames: [],
        autoBackupGames: {},
        firstLaunchFullScanTipShown: !isFirstLaunch
    };

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

    try {
        const data = fs.readFileSync(settingsPath, 'utf8');
        const loadedSettings = JSON.parse(data);
        settings = { ...defaultSettings, ...loadedSettings };
        settings.language = normalizeLanguage(settings.language);

    } catch (err) {
        console.error("Error loading settings, using defaults:", err);
        fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings), 'utf8');
        settings = defaultSettings;
    }
};

function saveSettings(key, value) {
    const userDataPath = app.getPath('userData');
    const settingsPath = path.join(userDataPath, 'OGS Settings', 'settings.json');

    settings[key] = key === 'language' ? normalizeLanguage(value) : value;

    // Queue the write operation to prevent simultaneous writes
    return writeQueue = writeQueue.then(() => {
        return new Promise((resolve, reject) => {
            fs.writeFile(settingsPath, JSON.stringify(settings), (writeErr) => {
                if (writeErr) {
                    console.error('Error saving settings:', writeErr);
                    reject(writeErr);
                } else {
                    console.log(`Settings updated successfully: ${key}: ${settings[key]}`);


                    if (key === 'gameInstalls' || key === 'saveUninstalledGames') {
                        win.webContents.send('update-backup-table');
                        win.webContents.send('update-restore-table');
                    }

                    if (key === 'language') {
                        i18next.changeLanguage(settings[key]).then(() => {
                            BrowserWindow.getAllWindows().forEach((window) => {
                                window.webContents.send('apply-language');
                            });
                            if (win && !win.isDestroyed()) {
                                win.webContents.send('update-backup-table');
                                win.webContents.send('update-restore-table');
                            }
                            Menu.setApplicationMenu(null);
                            resolve();
                        }).catch(reject);
                    } else {
                        resolve();
                    }
                }
            });
        });
    }).catch((err) => {
        console.error('Error in write queue:', err);
    });
}

async function moveFilesWithProgress(sourceDir, destinationDir) {
    let totalSize = 0;
    let movedSize = 0;
    let errors = [];
    status.migrating = true;
    const progressId = 'migrate-backups';
    const progressTitle = i18next.t('alert.migrate_backups');

    const moveAndTrackProgress = async (srcDir, destDir) => {
        try {
            const items = fsOriginal.readdirSync(srcDir, { withFileTypes: true });

            for (const item of items) {
                const srcPath = path.join(srcDir, item.name);
                const destPath = path.join(destDir, item.name);

                if (item.isDirectory()) {
                    fse.ensureDirSync(destPath);
                    await moveAndTrackProgress(srcPath, destPath);
                } else {
                    const fileStats = fsOriginal.statSync(srcPath);
                    const readStream = fsOriginal.createReadStream(srcPath);
                    const writeStream = fsOriginal.createWriteStream(destPath);

                    readStream.on('data', (chunk) => {
                        movedSize += chunk.length;
                        const progressPercentage = Math.round((movedSize / totalSize) * 100);
                        win.webContents.send('update-progress', progressId, progressTitle, progressPercentage);
                    });

                    await new Promise((resolve, reject) => {
                        readStream.pipe(writeStream);
                        readStream.on('error', reject);
                        writeStream.on('error', reject);
                        writeStream.on('finish', () => {
                            fsOriginal.promises.utimes(destPath, fileStats.atime, fileStats.mtime)
                                .then(() => fsOriginal.promises.rm(srcPath))
                                .then(resolve)
                                .catch(reject);
                        });
                    });
                }
            }
            await fsOriginal.promises.rm(srcDir, { recursive: true });

        } catch (err) {
            errors.push(`Error moving file or directory: ${err.message}`);
        }
    };

    if (fsOriginal.existsSync(sourceDir)) {
        totalSize = calculateDirectorySize(sourceDir, false);

        win.webContents.send('update-progress', progressId, progressTitle, 'start');
        await moveAndTrackProgress(sourceDir, destinationDir);
        win.webContents.send('update-progress', progressId, progressTitle, 'end');

        if (errors.length > 0) {
            console.log(errors);
            win.webContents.send('show-alert', 'modal', i18next.t('alert.error_during_backup_migration'), errors);
        } else {
            win.webContents.send('show-alert', 'success', i18next.t('alert.backup_migration_success'));
        }
    }
    saveSettings('backupPath', destinationDir);
    win.webContents.send('update-restore-table');
    status.migrating = false;
}

ipcMain.on('open-settings-window', () => {
    openSettingsWindow();
});

ipcMain.on('open-about-window', () => {
    openAboutWindow();
});

ipcMain.on('view-account-ids', () => {
    win.webContents.send("view_account_ids");
});

ipcMain.on('scan-full', () => {
    win.webContents.send("scan-full");
});

module.exports = {
    createMainWindow,
    getMainWin: () => win,
    getSettingsWin: () => settingsWin,
    preloadAuxiliaryWindows,
    getStatus: () => status,
    updateStatus,

    getCurrentVersion: () => appVersion,
    getRepositoryUrl: () => appRepositoryUrl,
    getLatestVersion,
    checkAppUpdate,
    showBackgroundNotification,
    updateApp,
    getGameDisplayName,
    calculateDirectorySize,
    ensureWritable,
    getNewestBackup,
    fsOriginalCopyFolder,
    exportBackups,
    importBackups,
    browseLocalSave,
    deleteLocalSave,
    placeholder_mapping,
    osKeyMap,
    loadSettings,
    saveSettings,
    getSettings: () => settings,
    moveFilesWithProgress,
};
