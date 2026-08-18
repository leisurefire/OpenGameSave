const { BrowserWindow, Notification, app, shell } = require('electron');
const path = require('path');

const axios = require('axios');
const { autoUpdater } = require('electron-updater');
const i18next = require('i18next');

const { acquireGlobalOperation } = require('../gameOperationLock');
const { getMainWin } = require('./windowManager');
const { getStatus, updateStatus } = require('./statusService');

const appVersion = app.getVersion();
const appReleaseUrl = 'https://github.com/leisurefire/OpenGameSave/releases';
const appRepositoryApiLatestReleaseUrl = 'https://api.github.com/repos/leisurefire/OpenGameSave/releases/latest';
const canAutoUpdate = app.isPackaged && process.platform === 'win32';

let checkPromise = null;
let downloadPromise = null;
let installTimer = null;
let releaseUpdateOperation = null;
const updateState = {
    status: 'idle',
    currentVersion: appVersion,
    availableVersion: null,
    canAutoUpdate,
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    error: null
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

function normalizeAppVersion(version) {
    const match = String(version || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
    return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}

function compareAppVersions(left, right) {
    const leftVersion = normalizeAppVersion(left);
    const rightVersion = normalizeAppVersion(right);

    if (!leftVersion || !rightVersion) {
        return 0;
    }

    const leftParts = leftVersion.split('.').map(Number);
    const rightParts = rightVersion.split('.').map(Number);

    for (let index = 0; index < 3; index += 1) {
        if (leftParts[index] !== rightParts[index]) {
            return leftParts[index] - rightParts[index];
        }
    }

    return 0;
}

function isNewerAppVersion(candidateVersion, currentVersion = appVersion) {
    return compareAppVersions(candidateVersion, currentVersion) > 0;
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

function getUpdateErrorCode(error) {
    const message = String(error?.message || error || '').toLowerCase();
    if (message.includes('latest.yml') || message.includes('404')) return 'metadata-unavailable';
    if (message.includes('sha512') || message.includes('checksum')) return 'verification-failed';
    if (message.includes('network') || message.includes('timeout') || message.includes('enotfound')) return 'network-failed';
    return 'update-failed';
}

async function getLatestVersion(appName) {
    try {
        const response = await axios.get(appRepositoryApiLatestReleaseUrl, {
            headers: {
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'OpenGameSave'
            },
            timeout: 15000,
            maxContentLength: 1024 * 1024
        });

        const latestVersion = normalizeAppVersion(response.data?.tag_name) || normalizeAppVersion(response.data?.name);
        if (latestVersion) {
            return latestVersion;
        }

        console.error('Error: release version not found in GitHub response');
        return null;
    } catch (error) {
        console.error(`Error retrieving latest version from GitHub for ${appName}: ${error.message}`);
        return null;
    }
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

    setAppUpdateState({ status: 'checking', error: null });
    checkPromise = autoUpdater.checkForUpdates()
        .then(() => getAppUpdateState())
        .catch((error) => {
            console.error('Error checking for application update:', error);
            return setAppUpdateState({
                status: 'error',
                error: getUpdateErrorCode(error)
            });
        })
        .finally(() => {
            checkPromise = null;
        });
    return checkPromise;
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
        return getAppUpdateState();
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
                    setAppUpdateState({ status: 'installing' });
                    autoUpdater.quitAndInstall(true, true);
                }, 500);
            }
            return getAppUpdateState();
        })
        .catch((error) => {
            console.error('Error downloading application update:', error);
            releaseAppUpdateOperation();
            return setAppUpdateState({
                status: 'error',
                error: getUpdateErrorCode(error)
            });
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
        error: null
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
    if (getStatus().updating_app) {
        releaseAppUpdateOperation();
    }
    setAppUpdateState({
        status: 'error',
        error: getUpdateErrorCode(error)
    });
});

module.exports = {
    checkAppUpdate,
    downloadAppUpdate,
    getAppUpdateState,
    getCurrentVersion: () => appVersion,
    getLatestVersion,
    getRepositoryUrl: () => 'https://github.com/leisurefire/OpenGameSave',
    isNewerAppVersion,
    showBackgroundNotification,
    updateApp
};
