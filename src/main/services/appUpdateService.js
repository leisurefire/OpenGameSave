const { BrowserWindow, Notification, app, autoUpdater: nativeAutoUpdater, shell } = require('electron');
const path = require('path');

const axios = require('axios');
const { autoUpdater } = require('electron-updater');
const i18next = require('i18next');

const { acquireGlobalOperation } = require('../gameOperationLock');
const {
    isNewerAppVersion: compareNewerAppVersion,
    normalizeAppVersion,
    selectLatestAppRelease
} = require('../appUpdatePolicy');
const { getSettings } = require('./settingsService');
const { getMainWin } = require('./windowManager');
const { getStatus, updateStatus } = require('./statusService');

const appVersion = app.getVersion();
const appReleaseUrl = 'https://github.com/leisurefire/OpenGameSave/releases';
const appRepositoryApiReleasesUrl = 'https://api.github.com/repos/leisurefire/OpenGameSave/releases';
const canAutoUpdate = app.isPackaged && process.platform === 'win32';
const installLaunchTimeoutMs = 15000;

let checkPromise = null;
let downloadPromise = null;
let installTimer = null;
let installLaunchWatchdog = null;
let releaseUpdateOperation = null;
let activeRelease = null;
let updateQuitRequested = false;
const updateState = {
    status: 'idle',
    currentVersion: appVersion,
    availableVersion: null,
    canAutoUpdate,
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    error: null,
    releaseUrl: null,
    fallbackAvailable: false
};

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.autoRunAppAfterInstall = true;
autoUpdater.allowPrerelease = false;
autoUpdater.disableWebInstaller = true;
autoUpdater.logger = console;

function resource_path(resource_name) {
    if (!app.isPackaged) {
        return path.join(__dirname, '../assets_export', resource_name);
    }
    return path.join(process.resourcesPath, 'assets_export', resource_name);
}

function isNewerAppVersion(candidateVersion, currentVersion = appVersion) {
    return compareNewerAppVersion(candidateVersion, currentVersion);
}

function getAppUpdateState() {
    return { ...updateState };
}

function broadcastAppUpdateState() {
    const state = getAppUpdateState();
    BrowserWindow.getAllWindows().forEach((browserWindow) => {
        if (!browserWindow.isDestroyed()) {
            browserWindow.webContents.send('app-update-state', state);
        }
    });
}

function setAppUpdateState(changes) {
    Object.assign(updateState, changes);
    broadcastAppUpdateState();
    return getAppUpdateState();
}

function releaseAppUpdateOperation() {
    updateStatus('updating_app', false);
    releaseUpdateOperation?.();
    releaseUpdateOperation = null;
}

function clearInstallTimers() {
    if (installTimer) clearTimeout(installTimer);
    if (installLaunchWatchdog) clearTimeout(installLaunchWatchdog);
    installTimer = null;
    installLaunchWatchdog = null;
}

function getUpdateErrorCode(error) {
    const message = String(error?.message || error || '').toLowerCase();
    if (message.includes('publisher') || message.includes('signature') || message.includes('authenticode')) {
        return 'signature-invalid';
    }
    if (message.includes('.yml') || message.includes('404') || message.includes('update info')) return 'metadata-unavailable';
    if (message.includes('sha512') || message.includes('checksum')) return 'verification-failed';
    if (message.includes('network') || message.includes('timeout') || message.includes('enotfound')) return 'network-failed';
    return 'update-failed';
}

function shouldIncludePrerelease() {
    return getSettings()?.appUpdatePrerelease === true;
}

async function getLatestAppRelease() {
    const response = await axios.get(appRepositoryApiReleasesUrl, {
        headers: {
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'OpenGameSave'
        },
        params: { per_page: 100 },
        timeout: 15000,
        maxContentLength: 2 * 1024 * 1024
    });
    return selectLatestAppRelease(response.data, { includePrerelease: shouldIncludePrerelease() });
}

async function getLatestVersion(appName) {
    try {
        const latestRelease = await getLatestAppRelease();
        if (latestRelease) return latestRelease.version;
        console.error('Error: release version not found in GitHub response');
        return null;
    } catch (error) {
        console.error(`Error retrieving latest version from GitHub for ${appName}: ${error.message}`);
        return null;
    }
}

function configurePinnedUpdateFeed(release) {
    const encodedTag = encodeURIComponent(release.tag);
    autoUpdater.allowPrerelease = shouldIncludePrerelease();
    autoUpdater.channel = release.channel;
    autoUpdater.allowDowngrade = false;
    autoUpdater.setFeedURL({
        provider: 'generic',
        url: `https://github.com/leisurefire/OpenGameSave/releases/download/${encodedTag}/`,
        channel: release.channel
    });
}

function getReleasePageUrl(release) {
    return release ? `${appReleaseUrl}/tag/${encodeURIComponent(release.tag)}` : appReleaseUrl;
}

async function checkUnsupportedPlatformUpdate() {
    const latestVersion = await getLatestVersion('OpenGameSave');
    if (latestVersion && isNewerAppVersion(latestVersion, appVersion)) {
        return setAppUpdateState({
            status: 'available',
            availableVersion: latestVersion,
            percent: 0,
            error: null
        });
    }
    return setAppUpdateState({
        status: latestVersion ? 'up-to-date' : 'error',
        availableVersion: null,
        error: latestVersion ? null : 'update-failed'
    });
}

async function checkAppUpdate() {
    if (!canAutoUpdate) {
        return checkUnsupportedPlatformUpdate();
    }
    if (checkPromise) {
        return checkPromise;
    }
    if (['downloading', 'downloaded', 'installing'].includes(updateState.status)) {
        return getAppUpdateState();
    }

    setAppUpdateState({ status: 'checking', error: null, fallbackAvailable: false });
    checkPromise = getLatestAppRelease()
        .then((release) => {
            if (!release) throw new Error('No application release with complete update assets was found');
            activeRelease = release;
            setAppUpdateState({ releaseUrl: getReleasePageUrl(release) });
            if (!isNewerAppVersion(release.version, appVersion)) {
                return setAppUpdateState({
                    status: 'up-to-date',
                    availableVersion: null,
                    percent: 0,
                    error: null
                });
            }
            configurePinnedUpdateFeed(release);
            return autoUpdater.checkForUpdates().then(() => getAppUpdateState());
        })
        .then(() => getAppUpdateState())
        .catch((error) => {
            console.error('Error checking for application update:', error);
            return setAppUpdateState({
                status: 'error',
                error: getUpdateErrorCode(error),
                fallbackAvailable: true
            });
        })
        .finally(() => {
            checkPromise = null;
        });
    return checkPromise;
}

async function openUpdateFallback() {
    await shell.openExternal(updateState.releaseUrl || getReleasePageUrl(activeRelease)).catch((error) => {
        console.error('An error occurred while opening the release page:', error);
    });
    return true;
}

function beginUpdateInstallation() {
    setAppUpdateState({ status: 'installing', error: null });
    installLaunchWatchdog = setTimeout(() => {
        installLaunchWatchdog = null;
        if (updateQuitRequested) return;
        releaseAppUpdateOperation();
        setAppUpdateState({
            status: 'error',
            error: 'install-launch-failed',
            fallbackAvailable: true
        });
        void openUpdateFallback();
    }, installLaunchTimeoutMs);
    try {
        autoUpdater.quitAndInstall(true, true);
    } catch (error) {
        clearInstallTimers();
        releaseAppUpdateOperation();
        setAppUpdateState({ status: 'error', error: getUpdateErrorCode(error), fallbackAvailable: true });
        void openUpdateFallback();
    }
}

async function downloadAppUpdate() {
    if (!canAutoUpdate) {
        await updateApp();
        return { ...getAppUpdateState(), fallbackOpened: true };
    }
    if (downloadPromise) {
        return downloadPromise;
    }
    if (!['available', 'downloading', 'downloaded', 'installing'].includes(updateState.status)) {
        await checkAppUpdate();
    }
    if (updateState.status !== 'available') {
        const state = getAppUpdateState();
        if (state.fallbackAvailable) {
            await openUpdateFallback();
            return { ...state, fallbackOpened: true };
        }
        return state;
    }

    const hasActiveOperation = Object.entries(getStatus()).some(([key, value]) => key !== 'updating_app' && value);
    if (hasActiveOperation) {
        return setAppUpdateState({ status: 'error', error: 'app-busy' });
    }
    try {
        releaseUpdateOperation = acquireGlobalOperation('application update');
        updateStatus('updating_app', true);
    } catch (error) {
        console.warn(`Application update is waiting for another operation: ${error.message}`);
        return setAppUpdateState({ status: 'error', error: 'app-busy' });
    }

    setAppUpdateState({
        status: 'downloading',
        percent: 0,
        transferred: 0,
        total: 0,
        bytesPerSecond: 0,
        error: null
    });
    downloadPromise = autoUpdater.downloadUpdate()
        .then(() => {
            setAppUpdateState({ status: 'downloaded', percent: 100, error: null });
            if (!installTimer) {
                installTimer = setTimeout(() => {
                    installTimer = null;
                    beginUpdateInstallation();
                }, 500);
            }
            return getAppUpdateState();
        })
        .catch((error) => {
            console.error('Error downloading application update:', error);
            clearInstallTimers();
            releaseAppUpdateOperation();
            const state = setAppUpdateState({
                status: 'error',
                error: getUpdateErrorCode(error),
                fallbackAvailable: true
            });
            return openUpdateFallback().then(() => ({ ...state, fallbackOpened: true }));
        })
        .finally(() => {
            downloadPromise = null;
        });
    return downloadPromise;
}

function showNotification(type, title, body) {
    const icon_map = {
        'app': resource_path('logo.png'),
        'info': resource_path('information.png'),
        'warning': resource_path('warning.png'),
        'critical': resource_path('critical.png')
    };

    if (process.platform === 'win32') {
        const escapeXml = (value) => String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
        const toastXml = `
            <toast launch="gamesavemanager://default-click">
                <visual>
                    <binding template="ToastImageAndText04">
                        <image id="1" src="${escapeXml(icon_map[type] || icon_map.info)}" placement="appLogoOverride"/>
                        <text id="1">${escapeXml(title)}</text>
                        <text id="2">${escapeXml(body)}</text>
                    </binding>
                </visual>
            </toast>
        `;

        app.setAppUserModelId('com.leisurefire.opengamesave');
        new Notification({ toastXml }).show();
        return;
    }

    new Notification({ title, body, icon: icon_map[type] }).show();
}

function showBackgroundNotification(type, title, body) {
    const mainWindow = getMainWin();
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    const isInBackground = !mainWindow.isFocused() || mainWindow.isMinimized() || !mainWindow.isVisible();
    if (isInBackground) {
        showNotification(type, title, body);
    }
}

function updateApp() {
    return shell.openExternal(appReleaseUrl).catch((error) => {
        console.error('An error occurred while opening the release page:', error);
    });
}

autoUpdater.on('checking-for-update', () => {
    setAppUpdateState({ status: 'checking', error: null });
});

autoUpdater.on('update-available', (info) => {
    const latestVersion = normalizeAppVersion(info?.version);
    setAppUpdateState({
        status: 'available',
        availableVersion: latestVersion,
        percent: 0,
        error: null,
        releaseUrl: getReleasePageUrl(activeRelease),
        fallbackAvailable: true
    });
    showBackgroundNotification(
        'app',
        i18next.t('alert.update_available'),
        `${i18next.t('alert.new_version_found', { old_version: appVersion, new_version: latestVersion })}\n` +
        i18next.t('alert.new_version_found_text')
    );
});

autoUpdater.on('update-not-available', () => {
    setAppUpdateState({
        status: 'up-to-date',
        availableVersion: null,
        percent: 0,
        error: null
    });
});

autoUpdater.on('download-progress', (progress) => {
    setAppUpdateState({
        status: 'downloading',
        percent: Math.min(100, Math.max(0, Number(progress?.percent) || 0)),
        transferred: Math.max(0, Number(progress?.transferred) || 0),
        total: Math.max(0, Number(progress?.total) || 0),
        bytesPerSecond: Math.max(0, Number(progress?.bytesPerSecond) || 0),
        error: null
    });
});

autoUpdater.on('update-downloaded', (info) => {
    setAppUpdateState({
        status: 'downloaded',
        availableVersion: normalizeAppVersion(info?.version) || updateState.availableVersion,
        percent: 100,
        error: null
    });
});

autoUpdater.on('error', (error) => {
    console.error('Application updater error:', error);
    clearInstallTimers();
    if (getStatus().updating_app) {
        releaseAppUpdateOperation();
    }
    setAppUpdateState({
        status: 'error',
        error: getUpdateErrorCode(error),
        fallbackAvailable: true
    });
});

nativeAutoUpdater.on('before-quit-for-update', () => {
    updateQuitRequested = true;
    if (installLaunchWatchdog) clearTimeout(installLaunchWatchdog);
    installLaunchWatchdog = null;
});

app.on('will-quit', clearInstallTimers);

module.exports = {
    checkAppUpdate,
    downloadAppUpdate,
    getAppUpdateState,
    getCurrentVersion: () => appVersion,
    getLatestVersion,
    getRepositoryUrl: () => 'https://github.com/leisurefire/OpenGameSave',
    isAppUpdateQuitPending: () => updateQuitRequested,
    isNewerAppVersion,
    showBackgroundNotification,
    updateApp
};
