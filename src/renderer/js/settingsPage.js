import { operationStartCheck, updateTranslations, showAlert, wrapNumberInput } from './utility.js';
import { setActionButtonState } from './tableUi.js';
import './components/ToggleSwitch.js';
import './components/DropdownSelect.js';

// Guard: track whether DOMContentLoaded initialisation has finished.
// If apply-language arrives before the page is ready (e.g. the user
// changes language while this modal window is still loading), we defer
// the update until initialisation completes rather than touching
// potentially absent DOM elements.
let _domReady = false;
let _pendingLanguageUpdate = false;

window.api.receive('apply-language', async () => {
    if (!_domReady) {
        // Will be handled at the end of the DOMContentLoaded block.
        _pendingLanguageUpdate = true;
        return;
    }
    const settings = await window.api.invoke('get-settings');
    const languageSelect = document.getElementById('language');
    if (languageSelect && settings?.language) {
        languageSelect.value = settings.language;
    }
    await updateTranslations(document);
});

function setupDatabaseUpdateButton(button, icon, text) {
    button.addEventListener('click', async () => {
        if (!await operationStartCheck('update-db')) return;

        await setActionButtonState({
            button,
            icon,
            text,
            iconName: 'database-zap',
            i18nKey: 'alert.updating_database',
            busy: true
        });
        try {
            const result = await window.api.invoke('update-database');
            if (result?.success) {
                window.api.send('update-backup-table');
                window.api.send('update-restore-table');
                if (result.alreadyLatest) {
                    showAlert('info', await window.i18n.translate('settings.database_up_to_date'));
                }
            }
        } finally {
            await setActionButtonState({
                button,
                icon,
                text,
                iconName: 'database-zap',
                i18nKey: 'settings.update_now',
                busy: false
            });
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    const languageSelect = document.getElementById('language');
    const maxBackupsInput = document.getElementById('max-backups');
    const launchAtStartupCheckbox = document.getElementById('launch-at-startup');
    const autoAppUpdateCheckbox = document.getElementById('auto-app-update');
    const appUpdatePrereleaseCheckbox = document.getElementById('app-update-prerelease');
    const autoDbUpdateCheckbox = document.getElementById('auto-db-update');
    const saveUninstalledCheckbox = document.getElementById('save-uninstalled-games');
    const syncAccentColorCheckbox = document.getElementById('sync-accent-color');
    const experimentalXgpSourceCheckbox = document.getElementById('experimental-xgp-source');
    const xgpSourceProjectButton = document.getElementById('xgp-source-project');
    const updateDatabaseButton = document.getElementById('update-database');
    const updateDatabaseIcon = document.getElementById('update-database-icon');
    const updateDatabaseText = document.getElementById('update-database-text');
    // toggle-switch exposes .checked as a property, same interface as <input type="checkbox">
    const autoDetectButton = document.getElementById('auto-detect-paths');
    const gamePathsContainer = document.getElementById('game-paths-container');
    const addNewPathButton = document.getElementById('add-new-path');

    wrapNumberInput(maxBackupsInput);
    setupDatabaseUpdateButton(updateDatabaseButton, updateDatabaseIcon, updateDatabaseText);

    // Initial load
    window.api.invoke('get-settings').then(async (settings) => {
        if (settings) {
            languageSelect.value = settings.language;
            maxBackupsInput.value = settings.maxBackups;
            launchAtStartupCheckbox.checked = settings.launchAtStartup ?? false;
            autoAppUpdateCheckbox.checked = settings.autoAppUpdate;
            appUpdatePrereleaseCheckbox.checked = settings.appUpdatePrerelease ?? false;
            autoDbUpdateCheckbox.checked = settings.autoDbUpdate;
            saveUninstalledCheckbox.checked = settings.saveUninstalledGames;
            syncAccentColorCheckbox.checked = settings.syncAccentColor ?? false;
            experimentalXgpSourceCheckbox.checked = settings.experimentalXgpSource ?? false;
            // ToggleSwitch uses the same .checked property, so no extra logic needed.

            if (settings.gameInstalls && settings.gameInstalls.length > 0) {
                settings.gameInstalls.forEach((installPath) => {
                    addGameInstallPath(installPath, false); // Don't trigger save on initial load
                });
            }
        }
        await updateTranslations(document);
        document.body.style.visibility = 'visible';

        // Mark DOM as ready, then flush any language update that arrived early.
        _domReady = true;
        if (_pendingLanguageUpdate) {
            _pendingLanguageUpdate = false;
            const latestSettings = await window.api.invoke('get-settings');
            if (languageSelect && latestSettings?.language) {
                languageSelect.value = latestSettings.language;
            }
            await updateTranslations(document);
        }
    });

    // Auto-save function
    let autoSaveQueue = Promise.resolve();
    let maxBackupsSaveTimer = null;
    function autoSave() {
        autoSaveQueue = autoSaveQueue.catch(() => undefined).then(async () => {
            const previousSettings = await window.api.invoke('get-settings');
            const updates = {};

            const newGameInstallPaths = [];
            document.querySelectorAll('.game-path-item .display-path').forEach((input) => {
                const path = input.value.trim();
                if (path) newGameInstallPaths.push(path);
            });

            const areArraysEqual = (arr1 = [], arr2 = []) => {
                if (arr1.length !== arr2.length) return false;
                const sortedLeft = [...arr1].sort();
                const sortedRight = [...arr2].sort();
                return sortedLeft.every((value, index) => value === sortedRight[index]);
            };

            if (!areArraysEqual(previousSettings.gameInstalls, newGameInstallPaths)) {
                updates.gameInstalls = newGameInstallPaths;
            }

            if (previousSettings.saveUninstalledGames !== saveUninstalledCheckbox.checked) {
                updates.saveUninstalledGames = saveUninstalledCheckbox.checked;
            }

            if (previousSettings.syncAccentColor !== syncAccentColorCheckbox.checked) {
                updates.syncAccentColor = syncAccentColorCheckbox.checked;
            }

            const maxBackups = Number(maxBackupsInput.value);
            if (previousSettings.maxBackups !== maxBackups) {
                updates.maxBackups = maxBackups;
            }
            if (previousSettings.launchAtStartup !== launchAtStartupCheckbox.checked) {
                updates.launchAtStartup = launchAtStartupCheckbox.checked;
            }
            if (previousSettings.autoAppUpdate !== autoAppUpdateCheckbox.checked) {
                updates.autoAppUpdate = autoAppUpdateCheckbox.checked;
            }
            if (previousSettings.appUpdatePrerelease !== appUpdatePrereleaseCheckbox.checked) {
                updates.appUpdatePrerelease = appUpdatePrereleaseCheckbox.checked;
            }
            if (previousSettings.autoDbUpdate !== autoDbUpdateCheckbox.checked) {
                updates.autoDbUpdate = autoDbUpdateCheckbox.checked;
            }

            if (Object.keys(updates).length > 0) {
                try {
                    await window.api.invoke('save-settings', updates);
                    if (Object.prototype.hasOwnProperty.call(updates, 'syncAccentColor')) {
                        window.api.send('apply-accent-color-setting', updates.syncAccentColor);
                    }
                } catch (error) {
                    console.error('Failed to save settings:', error);
                    showAlert('error', await window.i18n.translate('settings.save_settings_error'));
                }
            }
        });
        return autoSaveQueue;
    }

    // Event listeners for auto-save
    languageSelect.addEventListener('change', async (event) => {
        const previousLanguage = (await window.api.invoke('get-settings')).language;
        const nextLanguage = event.target.value;

        if (previousLanguage === nextLanguage) {
            return;
        }

        languageSelect.disabled = true;
        try {
            await window.i18n.changeLanguage(nextLanguage);
        } catch (error) {
            console.error('Failed to change language:', error);
            languageSelect.value = previousLanguage;
        } finally {
            languageSelect.disabled = false;
        }
    });

    [maxBackupsInput, launchAtStartupCheckbox, autoAppUpdateCheckbox, appUpdatePrereleaseCheckbox,
        autoDbUpdateCheckbox, saveUninstalledCheckbox, syncAccentColorCheckbox].forEach(el => {
        el.addEventListener('change', autoSave);
    });

    document.querySelectorAll('.settings-toggle-row').forEach(row => {
        row.addEventListener('click', event => {
            if (event.target.closest('toggle-switch, button, a')) return;
            const toggle = row.querySelector('toggle-switch');
            if (!toggle || toggle.disabled) return;
            toggle.checked = !toggle.checked;
            toggle.dispatchEvent(new Event('change', { bubbles: true }));
        });
    });

    let xgpSourceToggleBusy = false;
    experimentalXgpSourceCheckbox.addEventListener('change', async () => {
        if (xgpSourceToggleBusy) return;
        xgpSourceToggleBusy = true;
        experimentalXgpSourceCheckbox.disabled = true;
        const requestedState = experimentalXgpSourceCheckbox.checked;
        try {
            const result = await window.api.invoke('set-experimental-xgp-source', requestedState);
            experimentalXgpSourceCheckbox.checked = result.enabled === true;
            if (result.enabled && result.available) {
                showAlert('success', await window.i18n.translate('settings.xgp_source_enabled', { count: result.entryCount }));
                window.api.send('update-backup-table');
            } else if (result.enabled && !result.available) {
                showAlert('warning', await window.i18n.translate('settings.xgp_source_fetch_failed'));
            }
        } catch (error) {
            console.error('Failed to change experimental XgpSaveTools source:', error);
            const latestSettings = await window.api.invoke('get-settings');
            experimentalXgpSourceCheckbox.checked = latestSettings.experimentalXgpSource === true;
            showAlert('error', await window.i18n.translate('settings.xgp_source_change_failed'));
        } finally {
            experimentalXgpSourceCheckbox.disabled = false;
            xgpSourceToggleBusy = false;
        }
    });

    xgpSourceProjectButton.addEventListener('click', () => {
        window.api.invoke('open-url', 'https://github.com/brodrigz/XgpSaveTools');
    });

    maxBackupsInput.addEventListener('input', function () {
        const value = parseInt(this.value, 10);
        if (isNaN(value) || value < 1) this.value = 1;
        else if (value > 1000) this.value = 1000;
        clearTimeout(maxBackupsSaveTimer);
        maxBackupsSaveTimer = setTimeout(autoSave, 250);
    });

    autoDetectButton.addEventListener('click', () => {
        window.api.invoke('get-detected-game-paths').then(async (value) => {
            if (value && value.length > 0) {
                let added = false;
                value.forEach(path => {
                    if (!duplicatePathCheck(path)) {
                        addGameInstallPath(path, false);
                        added = true;
                    }
                });
                if (added) autoSave();
            } else {
                showAlert('warning', await window.i18n.translate('settings.noPathsDetected'));
            }
        });
    });

    addNewPathButton.addEventListener('click', () => {
        addGameInstallPath('', false);
    });

    function addGameInstallPath(installPath = '', triggerSave = true) {
        const newPath = document.createElement('div');
        newPath.className = 'game-path-item';
        newPath.innerHTML = `
            <input type="text" readonly
                class="display-path grow text-xs font-mono" />
            <button type="button" class="select-path settings-icon-button" aria-label="Select path">
                <span data-action-icon="selectDirectory"></span>
            </button>
            <button type="button" class="remove-path settings-icon-button danger" aria-label="Remove path">
                <span data-action-icon="delete"></span>
            </button>
        `;
        gamePathsContainer.appendChild(newPath);

        const selectPathButton = newPath.querySelector('.select-path');
        const pathInput = newPath.querySelector('.display-path');
        const removePathButton = newPath.querySelector('.remove-path');
        pathInput.value = installPath;

        selectPathButton.addEventListener('click', async () => {
            const result = await window.api.invoke('open-dialog');
            if (result.filePaths && result.filePaths.length > 0) {
                if (!duplicatePathCheck(result.filePaths[0], pathInput)) {
                    pathInput.value = result.filePaths[0];
                    autoSave();
                } else {
                    showAlert('warning', await window.i18n.translate('settings.gameInstallExists'));
                }
            }
        });

        removePathButton.addEventListener('click', () => {
            newPath.remove();
            autoSave();
        });

        if (triggerSave) autoSave();
    }

    function duplicatePathCheck(newPath, currentInput) {
        let isDuplicate = false;
        document.querySelectorAll('.game-path-item .display-path').forEach((input) => {
            if (input !== currentInput && input.value.trim() === newPath.trim()) {
                isDuplicate = true;
            }
        });
        return isDuplicate;
    }
});
