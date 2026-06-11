import { formatSize } from './commonTabs.js';
import { operationStartCheck, showAlert, updateTranslations } from './utility.js';

async function loadSyncSettings() {
    const settings = await window.api.invoke('get-settings');
    const backupPathInput = document.getElementById('backup-path');

    if (backupPathInput) {
        backupPathInput.value = settings.backupPath || '';
    }

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
        window.api.send('migrate-backups', selectedPath);
    } else {
        backupPathInput.value = settings.backupPath;
    }
}

async function openBackupDirectory() {
    const pathInput = document.getElementById('backup-path');
    const result = await window.api.invoke('open-directory', pathInput.value);

    if (!result.success) {
        showAlert('warning', result.message || await window.i18n.translate('alert.github_sync_repo_missing'));
    }
}

function formatRemoteUrl(remoteUrl) {
    return (remoteUrl || '').replace(/^\S+\s+/, '').replace(/\s+\((fetch|push)\)$/i, '').trim();
}

async function refreshGitHubSyncStatus() {
    await loadSyncSettings();
    const pathInput = document.getElementById('backup-path');
    const statusMessage = document.getElementById('github-sync-status-message');
    const statusDetails = document.getElementById('github-sync-status-details');

    const status = await window.api.invoke('github-sync-status', pathInput.value);
    statusMessage.textContent = status.message || '';
    statusMessage.className = status.isGitRepo && status.hasRemote
        ? 'text-sm font-bold text-theme-accent'
        : 'text-sm font-bold text-yellow-400';

    const remoteUrl = formatRemoteUrl(status.remoteUrl);
    statusDetails.textContent = remoteUrl
        ? `${await window.i18n.translate('main.github_sync_remote_repository')}${remoteUrl}${status.branch ? ` (${status.branch})` : ''}`
        : '';

    return status;
}

function setSyncBusy(isBusy) {
    const buttons = [
        document.getElementById('backup-path-select'),
        document.getElementById('backup-path-open'),
        document.getElementById('github-sync-refresh'),
        document.getElementById('github-sync-upload'),
        document.getElementById('github-sync-download')
    ].filter(Boolean);

    buttons.forEach(button => {
        button.disabled = isBusy;
        button.classList.toggle('cursor-not-allowed', isBusy);
        button.classList.toggle('opacity-50', isBusy);
    });
}

async function runGitHubSync(direction) {
    const canStart = await operationStartCheck('github-sync');
    if (!canStart) return;

    const pathInput = document.getElementById('backup-path');
    const progressTitle = await window.i18n.translate(direction === 'upload' ? 'alert.github_sync_uploading' : 'alert.github_sync_downloading');

    setSyncBusy(true);
    window.api.send('update-status', 'github_syncing', true);

    try {
        const progressId = 'github-sync';
        const progressContainer = document.getElementById('progress-container');
        if (!document.getElementById(progressId)) {
            const progressElement = document.createElement('div');
            progressElement.id = progressId;
            progressElement.className = 'ml-auto p-4 mb-2 border floating-surface animate-fadeIn w-72 shadow-2xl';
            progressElement.innerHTML = `<div class="flex justify-between mb-2 text-xs font-black uppercase tracking-widest text-theme-accent"><span>${progressTitle}</span><span>Git</span></div><div class="text-xs opacity-60">${await window.i18n.translate('alert.github_sync_progress_hint')}</div>`;
            progressContainer.appendChild(progressElement);
        }

        const result = await window.api.invoke(direction === 'upload' ? 'github-sync-upload' : 'github-sync-download', pathInput.value);
        document.getElementById(progressId)?.remove();

        const messageKey = direction === 'upload' ? 'alert.github_sync_upload_success' : 'alert.github_sync_download_success';
        showAlert('success', await window.i18n.translate(messageKey, {
            games: result.games,
            size: formatSize(result.size || 0)
        }));
        await refreshGitHubSyncStatus();
    } catch (error) {
        document.getElementById('github-sync')?.remove();
        showAlert('modal', await window.i18n.translate('alert.github_sync_failed'), error.message || String(error));
    } finally {
        window.api.send('update-status', 'github_syncing', false);
        setSyncBusy(false);
    }
}

function setupGitHubSyncTab() {
    const backupPathButton = document.getElementById('backup-path-select');
    const openPathButton = document.getElementById('backup-path-open');
    const refreshButton = document.getElementById('github-sync-refresh');
    const uploadButton = document.getElementById('github-sync-upload');
    const downloadButton = document.getElementById('github-sync-download');

    if (!backupPathButton || backupPathButton.dataset.listenerAdded) return;

    backupPathButton.dataset.listenerAdded = 'true';
    backupPathButton.addEventListener('click', chooseBackupPath);
    openPathButton.addEventListener('click', openBackupDirectory);
    refreshButton.addEventListener('click', refreshGitHubSyncStatus);
    uploadButton.addEventListener('click', () => runGitHubSync('upload'));
    downloadButton.addEventListener('click', () => runGitHubSync('download'));

    refreshGitHubSyncStatus().catch(console.error);
}

document.addEventListener('DOMContentLoaded', () => {
    setupGitHubSyncTab();
    updateTranslations(document);
});

window.api.receive('apply-language', () => {
    updateTranslations(document);
    refreshGitHubSyncStatus().catch(console.error);
});
