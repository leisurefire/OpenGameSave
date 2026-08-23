const { BrowserWindow, Menu, app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const i18next = require('i18next');

const {
    ALLOWED_SETTING_KEYS,
    normalizeLanguage,
    sanitizeSettings,
    sanitizeSettingValue
} = require('../validation');
const { getMainWin } = require('./windowManager');

let settings;
/** @type {Promise<void | string[]>} */
let writeQueue = Promise.resolve();

const placeholder_mapping = {
    // Windows
    '{{p|systemdrive}}': process.env.SystemDrive || path.parse(process.env.WINDIR || 'C:\\Windows').root.replace(/[\\/]$/, '') || 'C:',
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
    '{{p|xdgconfighome}}': process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
};

function setLaunchAtStartup(enabled) {
    if (!app.isPackaged || (process.platform !== 'win32' && process.platform !== 'darwin')) {
        return;
    }

    const loginItemSettings = { openAtLogin: Boolean(enabled) };
    if (process.platform === 'win32') {
        loginItemSettings.path = process.execPath;
        loginItemSettings.args = [];
        loginItemSettings.name = 'OpenGameSave';
    }
    app.setLoginItemSettings(loginItemSettings);
}

// ======================================================================
// Settings
// ======================================================================
const loadSettings = () => {
    const userDataPath = app.getPath('userData');
    const appDataPath = app.getPath('appData');
    const settingsPath = path.join(userDataPath, 'OGS Settings', 'settings.json');

    const locale_mapping = {
        'en': 'en_US',
        'en-US': 'en_US',
        'zh': 'zh_CN',
        'zh-CN': 'zh_CN',
        'zh-SG': 'zh_CN',
        'zh-Hans': 'zh_CN',
        'zh-Hans-CN': 'zh_CN',
        'zh-Hans-SG': 'zh_CN'
    };

    const detectLanguage = () => {
        const locales = [app.getLocale(), ...app.getPreferredSystemLanguages()];
        const detectedLocale = locales.find(locale => {
            if (!locale) return false;
            return Boolean(locale_mapping[locale]) || locale.toLowerCase().startsWith('zh');
        });

        if (detectedLocale && detectedLocale.toLowerCase().startsWith('zh')) {
            return 'zh_CN';
        }

        return normalizeLanguage(locale_mapping[detectedLocale]);
    };

    const detectedLanguage = detectLanguage();
    const isFirstLaunch = !fs.existsSync(settingsPath);

    // Default settings
    const defaultSettings = {
        language: detectedLanguage,
        backupPath: path.join(appDataPath, 'OGS Backups'),
        exportPath: '',
        syncProvider: 'github',
        webdavUrl: '',
        webdavUsername: '',
        webdavRemotePath: '/OpenGameSave',
        visibleSidebarItems: ['library', 'guides', 'backup', 'sync'],
        maxBackups: 5,
        launchAtStartup: false,
        autoAppUpdate: true,
        appUpdatePrerelease: false,
        autoDbUpdate: false,
        databaseVariant: 'standard',
        syncAccentColor: false,
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

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });

    try {
        const data = fs.readFileSync(settingsPath, 'utf8');
        const loadedSettings = JSON.parse(data);
        settings = sanitizeSettings(loadedSettings, defaultSettings);

    } catch (err) {
        if (err.code !== 'ENOENT') console.error('Error loading settings, using defaults:', err);
        settings = sanitizeSettings({}, defaultSettings);
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    }
};

function saveSettings(keyOrUpdates, value) {
    const userDataPath = app.getPath('userData');
    const settingsPath = path.join(userDataPath, 'OGS Settings', 'settings.json');

    const updates = keyOrUpdates && typeof keyOrUpdates === 'object' && !Array.isArray(keyOrUpdates)
        ? keyOrUpdates
        : { [keyOrUpdates]: value };
    const updateEntries = Object.entries(updates);
    if (updateEntries.length === 0) return Promise.resolve([]);

    // Validate the whole transaction before changing the in-memory settings so
    // a single invalid value cannot partially apply a batch.
    const sanitizedUpdates = {};
    for (const [key, nextValue] of updateEntries) {
        if (!ALLOWED_SETTING_KEYS.has(key)) throw new Error(`Unknown setting: ${key}`);
        sanitizedUpdates[key] = sanitizeSettingValue(key, nextValue, settings[key]);
    }

    const changedKeys = Object.keys(sanitizedUpdates)
        .filter(key => !Object.is(settings[key], sanitizedUpdates[key]));
    if (changedKeys.length === 0) return Promise.resolve([]);

    settings = { ...settings, ...sanitizedUpdates };
    const settingsSnapshot = JSON.stringify(settings, null, 2);

    writeQueue = writeQueue.catch(() => undefined).then(async () => {
        const tempPath = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
            await fs.promises.writeFile(tempPath, settingsSnapshot, { encoding: 'utf8', mode: 0o600 });
            await fs.promises.rename(tempPath, settingsPath);
        } finally {
            await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
        }

        if (changedKeys.includes('launchAtStartup')) {
            setLaunchAtStartup(settings.launchAtStartup);
        }

        if (changedKeys.some(key => key === 'gameInstalls' || key === 'saveUninstalledGames')
            && getMainWin() && !getMainWin().isDestroyed()) {
            getMainWin().webContents.send('update-backup-table');
            getMainWin().webContents.send('update-restore-table');
        }

        if (changedKeys.includes('language')) {
            await i18next.changeLanguage(settings.language);
            BrowserWindow.getAllWindows().forEach((window) => {
                if (!window.isDestroyed()) window.webContents.send('apply-language');
            });
            if (getMainWin() && !getMainWin().isDestroyed()) {
                getMainWin().webContents.send('update-backup-table');
                getMainWin().webContents.send('update-restore-table');
            }
            Menu.setApplicationMenu(null);
        }

        return changedKeys;
    });
    return writeQueue;
}
module.exports = {
    getSettings: () => settings,
    loadSettings,
    placeholder_mapping,
    saveSettings,
    setLaunchAtStartup
};
