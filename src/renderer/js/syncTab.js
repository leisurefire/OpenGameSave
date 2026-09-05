import { formatSize, runWhenDomReady } from './commonTabs.js';
import { operationStartCheck, showAlert, updateTranslations } from './utility.js';

const PROVIDERS = Object.freeze({
    github: {
        badge: 'Git',
        noteKey: 'main.github_sync_note',
        uploadHintKey: 'main.github_sync_upload_hint',
        downloadHintKey: 'main.github_sync_download_hint',
        progressHintKey: 'alert.github_sync_progress_hint'
    },
    webdav: {
        badge: 'WebDAV',
        noteKey: 'main.webdav_sync_note',
        uploadHintKey: 'main.webdav_sync_upload_hint',
        downloadHintKey: 'main.webdav_sync_download_hint',
        progressHintKey: 'alert.webdav_sync_progress_hint'
    }
});

let activeProvider = 'github';
let providerSelectionId = 0;
let webDAVConfigLoaded = false;
let webDAVPasswordDirty = false;
let syncStatusRequestId = 0;
let syncOperationInProgress = false;

async function setTranslatedText(element, key) {
    if (!element) return;
    element.dataset.i18n = key;
    const label = await window.i18n.translate(key);
    if (element.dataset.i18n === key) element.textContent = label;
}

async function loadSyncSettings(isCurrent = () => true) {
    const settings = await window.api.invoke('get-settings');
    const backupPathInput = document.getElementById('backup-path');
    if (backupPathInput && isCurrent()) backupPathInput.value = settings.backupPath || '';
    return settings;
}

async function chooseBackupPath() {
    const selectedPath = await window.api.invoke('open-backup-dialog');
    if (!selectedPath) return;

    const backupPathInput = document.getElementById('backup-path');
    const settings = await window.api.invoke('get-settings');
    if (settings.backupPath.trim() === selectedPath.trim()) {
        backupPathInput.value = selectedPath;
        return;
    }

    const canStart = await operationStartCheck('change-settings');
    if (canStart) {
        backupPathInput.value = selectedPath;
        try {
            const migrated = await window.api.invoke('migrate-backups', selectedPath);
            if (!migrated) {
                backupPathInput.value = settings.backupPath;
                return;
            }
        } catch (error) {
            console.error('Failed to migrate backup path:', error);
            backupPathInput.value = settings.backupPath;
            await showAlert(
                'error',
                await window.i18n.translate('alert.error_during_backup_migration'),
                error?.message || String(error)
            );
            return;
        }
        try {
            await refreshSyncStatus();
        } catch (error) {
            console.error('Failed to refresh sync status after backup migration:', error);
            await showAlert(
                'error',
                await window.i18n.translate('alert.sync_failed'),
                error?.message || String(error)
            );
        }
    } else {
        backupPathInput.value = settings.backupPath;
    }
}

async function openBackupDirectory() {
    const pathInput = document.getElementById('backup-path');
    const result = await window.api.invoke('open-directory', pathInput.value);
    if (!result.success) {
        showAlert('warning', result.message || await window.i18n.translate('alert.sync_path_missing'));
    }
}

function formatRemoteUrl(remoteUrl) {
    return (remoteUrl || '').replace(/^\S+\s+/, '').replace(/\s+\((fetch|push)\)$/i, '').trim();
}

async function loadWebDAVConfig({ force = false } = {}) {
    if (webDAVConfigLoaded && !force) return;
    const config = await window.api.invoke('sync-provider-config', 'webdav');
    document.getElementById('webdav-url').value = config?.url || '';
    document.getElementById('webdav-username').value = config?.username || '';
    document.getElementById('webdav-remote-path').value = config?.remotePath || '/OpenGameSave';
    const passwordInput = document.getElementById('webdav-password');
    passwordInput.value = '';
    passwordInput.dataset.i18nPlaceholder = config?.hasPassword
        ? 'main.webdav_password_saved_placeholder'
        : 'main.webdav_password_placeholder';
    passwordInput.placeholder = await window.i18n.translate(passwordInput.dataset.i18nPlaceholder);
    webDAVPasswordDirty = false;
    webDAVConfigLoaded = true;
}

async function updateProviderUI() {
    document.querySelectorAll('[data-sync-provider]').forEach((button) => {
        const selected = button.dataset.syncProvider === activeProvider;
        button.setAttribute('aria-checked', String(selected));
    });
    document.getElementById('webdav-config-panel').classList.toggle('hidden', activeProvider !== 'webdav');

    const provider = PROVIDERS[activeProvider];
    await Promise.all([
        setTranslatedText(document.getElementById('sync-provider-note'), provider.noteKey),
        setTranslatedText(document.getElementById('sync-upload-hint'), provider.uploadHintKey),
        setTranslatedText(document.getElementById('sync-download-hint'), provider.downloadHintKey)
    ]);
    if (activeProvider === 'webdav') await loadWebDAVConfig();
}

async function selectProvider(providerId, { persist = true } = {}) {
    if (syncOperationInProgress || !PROVIDERS[providerId]) return;
    providerSelectionId += 1;
    if (providerId === activeProvider) {
        if (persist) await window.api.invoke('save-settings', 'syncProvider', providerId);
        await updateProviderUI();
        return;
    }
    activeProvider = providerId;
    if (persist) await window.api.invoke('save-settings', 'syncProvider', providerId);
    await updateProviderUI();
    await refreshSyncStatus();
}

async function refreshSyncStatus() {
    const requestId = ++syncStatusRequestId;
    const provider = activeProvider;
    const isCurrent = () => requestId === syncStatusRequestId && provider === activeProvider;
    await loadSyncSettings(isCurrent);
    if (!isCurrent()) return;
    const pathInput = document.getElementById('backup-path');
    const statusMessage = document.getElementById('sync-status-message');
    const statusDetails = document.getElementById('sync-status-details');
    const status = await window.api.invoke('sync-provider-status', provider, pathInput.value);
    if (!isCurrent()) return;
    const ready = provider === 'github'
        ? Boolean(status.isGitRepo && status.hasRemote)
        : Boolean(status.ready);

    let details;
    if (provider === 'github') {
        const remoteUrl = formatRemoteUrl(status.remoteUrl);
        details = remoteUrl
            ? `${await window.i18n.translate('main.github_sync_remote_repository')}${remoteUrl}${status.branch ? ` (${status.branch})` : ''}`
            : '';
    } else {
        const location = status.endpoint ? `${status.endpoint}${status.remotePath || ''}` : '';
        details = location
            ? `${await window.i18n.translate('main.webdav_remote_location')}${location}`
            : '';
    }
    if (!isCurrent()) return;
    statusMessage.textContent = status.message || '';
    statusMessage.dataset.ready = String(ready);
    statusDetails.textContent = details;
    return status;
}

function setSyncBusy(isBusy) {
    syncOperationInProgress = isBusy;
    const controls = [
        document.getElementById('backup-path-select'),
        document.getElementById('backup-path-open'),
        document.getElementById('sync-refresh'),
        document.getElementById('sync-upload'),
        document.getElementById('sync-download'),
        document.getElementById('webdav-save'),
        ...document.querySelectorAll('[data-sync-provider]'),
        ...document.querySelectorAll('#webdav-config-panel input')
    ].filter(Boolean);
    controls.forEach(control => {
        control.disabled = isBusy;
        control.classList.toggle('cursor-not-allowed', isBusy);
        control.classList.toggle('opacity-50', isBusy);
    });
}

async function formatWebDAVConflictDetails(conflicts) {
    const visibleConflicts = conflicts.slice(0, 25);
    const details = await Promise.all(visibleConflicts.map(conflict => window.i18n.translate(
        conflict.originalVersion === 'remote'
            ? 'alert.webdav_conflict_remote_original_detail'
            : 'alert.webdav_conflict_local_original_detail',
        {
            original: conflict.originalBackup,
            conflict: conflict.conflictBackup
        }
    )));
    if (conflicts.length > visibleConflicts.length) {
        details.push(await window.i18n.translate('alert.webdav_conflict_more', {
            count: conflicts.length - visibleConflicts.length
        }));
    }
    return details.join('\n');
}

async function saveWebDAVConfig() {
    if (syncOperationInProgress) return;
    const config = {
        url: document.getElementById('webdav-url').value.trim(),
        username: document.getElementById('webdav-username').value.trim(),
        remotePath: document.getElementById('webdav-remote-path').value.trim()
    };
    if (webDAVPasswordDirty) config.password = document.getElementById('webdav-password').value;

    setSyncBusy(true);
    try {
        await window.api.invoke('sync-provider-save-config', 'webdav', config);
        webDAVConfigLoaded = false;
        await loadWebDAVConfig({ force: true });
        showAlert('success', await window.i18n.translate('alert.webdav_config_saved'));
        await refreshSyncStatus();
    } catch (error) {
        showAlert('modal', await window.i18n.translate('alert.webdav_config_failed'), error.message || String(error));
    } finally {
        setSyncBusy(false);
    }
}

async function runSync(direction) {
    if (syncOperationInProgress) return;
    const provider = activeProvider;
    const backupPath = document.getElementById('backup-path').value;
    const progressId = 'cloud-sync';
    setSyncBusy(true);

    try {
        if (!await operationStartCheck('sync')) return;
        const progressTitle = await window.i18n.translate(direction === 'upload' ? 'alert.sync_uploading' : 'alert.sync_downloading');
        const progressContainer = document.getElementById('progress-container');
        if (!document.getElementById(progressId)) {
            const progressElement = document.createElement('div');
            progressElement.id = progressId;
            progressElement.className = 'app-progress floating-surface animate-fadeIn';
            progressElement.innerHTML = '<div class="app-progress-header"><span class="sync-progress-title"></span><span class="sync-progress-provider"></span></div><div class="sync-progress-hint text-xs opacity-60"></div>';
            progressElement.querySelector('.sync-progress-title').textContent = progressTitle;
            progressElement.querySelector('.sync-progress-provider').textContent = PROVIDERS[provider].badge;
            progressElement.querySelector('.sync-progress-hint').textContent = await window.i18n.translate(PROVIDERS[provider].progressHintKey);
            progressContainer.appendChild(progressElement);
        }

        const result = await window.api.invoke('sync-provider-run', provider, direction, backupPath);
        document.getElementById(progressId)?.remove();
        const messageKey = direction === 'upload' ? 'alert.sync_upload_success' : 'alert.sync_download_success';
        showAlert('success', await window.i18n.translate(messageKey, {
            games: result.games,
            size: formatSize(result.size || 0)
        }));
        if (provider === 'webdav' && result.conflicts?.length > 0) {
            showAlert('modal', await window.i18n.translate('alert.webdav_conflicts_preserved', {
                count: result.conflicts.length
            }), await formatWebDAVConflictDetails(result.conflicts));
        }
        await refreshSyncStatus();
    } catch (error) {
        document.getElementById(progressId)?.remove();
        showAlert('modal', await window.i18n.translate('alert.sync_failed'), error.message || String(error));
    } finally {
        setSyncBusy(false);
    }
}

async function setupSyncTab() {
    const backupPathButton = document.getElementById('backup-path-select');
    if (!backupPathButton || backupPathButton.dataset.listenerAdded) return;
    backupPathButton.dataset.listenerAdded = 'true';
    const initialSelectionId = providerSelectionId;

    const availableProviders = await window.api.invoke('sync-provider-list');
    const availableProviderIds = new Set(availableProviders.map(provider => provider.id));
    document.querySelectorAll('[data-sync-provider]').forEach((button) => {
        button.hidden = !availableProviderIds.has(button.dataset.syncProvider);
        button.addEventListener('click', () => selectProvider(button.dataset.syncProvider).catch(console.error));
    });
    document.getElementById('backup-path-open').addEventListener('click', openBackupDirectory);
    backupPathButton.addEventListener('click', chooseBackupPath);
    document.getElementById('sync-refresh').addEventListener('click', refreshSyncStatus);
    document.getElementById('sync-upload').addEventListener('click', () => runSync('upload'));
    document.getElementById('sync-download').addEventListener('click', () => runSync('download'));
    document.getElementById('webdav-save').addEventListener('click', saveWebDAVConfig);
    document.getElementById('webdav-password').addEventListener('input', () => {
        webDAVPasswordDirty = true;
    });

    const settings = await loadSyncSettings();
    if (providerSelectionId === initialSelectionId) {
        activeProvider = availableProviderIds.has(settings.syncProvider) ? settings.syncProvider : 'github';
    }
    await updateProviderUI();
    await refreshSyncStatus();
}

runWhenDomReady(() => {
    updateTranslations(document).then(setupSyncTab).catch(console.error);
});

window.api.receive('apply-language', async () => {
    await updateTranslations(document);
    await updateProviderUI();
    await refreshSyncStatus();
});
