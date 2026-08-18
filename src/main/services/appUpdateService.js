const { Notification, app, ipcMain, shell } = require('electron');
const path = require('path');

const axios = require('axios');
const i18next = require('i18next');

const { getMainWin } = require('./windowManager');

const appVersion = app.getVersion();
const appReleaseUrl = 'https://github.com/leisurefire/OpenGameSave/releases';
const appRepositoryApiLatestReleaseUrl = 'https://api.github.com/repos/leisurefire/OpenGameSave/releases/latest';

function resource_path(resource_name) {
    if (!app.isPackaged) {
        return path.join(__dirname, '../assets_export', resource_name);
    } else {
        return path.join(process.resourcesPath, 'assets_export', resource_name);
    }
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
        } else {
            console.error('Error: release version not found in GitHub response');
            return null;
        }
    } catch (error) {
        console.error(`Error retrieving latest version from GitHub for ${appName}: ${error.message}`);
        return null;
    }
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


async function checkAppUpdate() {
    try {
        const latestVersion = await getLatestVersion('OpenGameSave');

        if (latestVersion && isNewerAppVersion(latestVersion, appVersion)) {
            showNotification(
                'app',
                i18next.t('alert.update_available'),
                `${i18next.t('alert.new_version_found', { old_version: appVersion, new_version: latestVersion })}\n` +
                `${i18next.t('alert.new_version_found_text')}`,
                latestVersion
            );
        }

    } catch (error) {
        console.error('Error checking for update:', error.stack);
        showNotification(
            'app',
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
        'critical': resource_path('critical.png')
    };

    if (process.platform === 'win32') {
        const escapeXml = (value) => String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
        const actionsXml = latest_version ? `
                <actions>
                    <action content="${escapeXml(i18next.t('alert.yes'))}" activationType="protocol" arguments="gamesavemanager://yes"/>
                    <action content="${escapeXml(i18next.t('alert.no'))}" activationType="protocol" arguments="gamesavemanager://no"/>
                </actions>` : '';

        const toastXml = `
            <toast launch="gamesavemanager://default-click">
                <visual>
                    <binding template="ToastImageAndText04">
                        <image id="1" src="${escapeXml(icon_map[type] || icon_map.info)}" placement="appLogoOverride"/>
                        <text id="1">${escapeXml(title)}</text>
                        <text id="2">${escapeXml(body)}</text>
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
                    updateApp();
                }
                ipcMain.removeListener('notification-action', handleAction);
            };
            ipcMain.on('notification-action', handleAction);
            notification.once('close', () => ipcMain.removeListener('notification-action', handleAction));
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
    if (!getMainWin() || getMainWin().isDestroyed()) {
        return;
    }

    const isInBackground = !getMainWin().isFocused() || getMainWin().isMinimized() || !getMainWin().isVisible();
    if (isInBackground) {
        showNotification(type, title, body);
    }
}

function updateApp() {
    shell.openExternal(appReleaseUrl).catch((error) => {
        console.error('An error occurred while opening the release page:', error);
    });
}
module.exports = {
    checkAppUpdate,
    getCurrentVersion: () => appVersion,
    getLatestVersion,
    getRepositoryUrl: () => 'https://github.com/leisurefire/OpenGameSave',
    isNewerAppVersion,
    showBackgroundNotification,
    updateApp
};

