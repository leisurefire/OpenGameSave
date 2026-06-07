import { updateTranslations, showAlert, operationStartCheck, wrapNumberInput } from './utility.js';

window.api.receive('apply-language', () => {
    updateTranslations(document);
});

document.addEventListener('DOMContentLoaded', () => {
    const languageSelect = document.getElementById('language');
    const backupPathInput = document.getElementById('backup-path');
    const backupPathButton = document.getElementById('select-path');
    const maxBackupsInput = document.getElementById('max-backups');
    const autoAppUpdateCheckbox = document.getElementById('auto-app-update');
    const autoDbUpdateCheckbox = document.getElementById('auto-db-update');
    const saveUninstalledCheckbox = document.getElementById('save-uninstalled-games');
    const autoDetectButton = document.getElementById('auto-detect-paths');
    const gamePathsContainer = document.getElementById('game-paths-container');
    const addNewPathButton = document.getElementById('add-new-path');

    wrapNumberInput(maxBackupsInput);

    // Initial load
    window.api.invoke('get-settings').then((settings) => {
        if (settings) {
            languageSelect.value = settings.language;
            backupPathInput.value = settings.backupPath;
            maxBackupsInput.value = settings.maxBackups;
            autoAppUpdateCheckbox.checked = settings.autoAppUpdate;
            autoDbUpdateCheckbox.checked = settings.autoDbUpdate;
            saveUninstalledCheckbox.checked = settings.saveUninstalledGames;

            if (settings.gameInstalls && settings.gameInstalls.length > 0) {
                settings.gameInstalls.forEach((installPath) => {
                    addGameInstallPath(installPath, false); // Don't trigger save on initial load
                });
            }
        }
        updateTranslations(document);
    });

    // Auto-save function
    async function autoSave() {
        const previousSettings = await window.api.invoke('get-settings');
        
        // Collect current paths
        const newGameInstallPaths = [];
        document.querySelectorAll('.game-path-item .display-path').forEach((input) => {
            const path = input.value.trim();
            if (path) newGameInstallPaths.push(path);
        });

        const areArraysEqual = (arr1, arr2) => {
            if (arr1.length !== arr2.length) return false;
            return [...arr1].sort().every((v, i) => v === [...arr2].sort()[i]);
        };

        // Save individual fields if changed
        if (!areArraysEqual(previousSettings.gameInstalls, newGameInstallPaths)) {
            window.api.send('save-settings', 'gameInstalls', newGameInstallPaths);
        }

        if (previousSettings.saveUninstalledGames !== saveUninstalledCheckbox.checked) {
            window.api.send('save-settings', 'saveUninstalledGames', saveUninstalledCheckbox.checked);
        }

        const newBackupPath = backupPathInput.value.trim();
        if (previousSettings.backupPath.trim() !== newBackupPath) {
            // Migration is a heavy operation, check start check
            const start = await operationStartCheck('change-settings');
            if (start) {
                window.api.send('migrate-backups', newBackupPath);
            } else {
                // Revert UI if migration blocked
                backupPathInput.value = previousSettings.backupPath;
            }
        }

        window.api.send('save-settings', 'maxBackups', maxBackupsInput.value);
        window.api.send('save-settings', 'autoAppUpdate', autoAppUpdateCheckbox.checked);
        window.api.send('save-settings', 'autoDbUpdate', autoDbUpdateCheckbox.checked);
    }

    // Event listeners for auto-save
    languageSelect.addEventListener('change', (event) => {
        window.api.send('save-settings', 'language', event.target.value);
    });

    backupPathButton.addEventListener('click', async () => {
        const result = await window.api.invoke('open-backup-dialog');
        if (result) {
            backupPathInput.value = result;
            autoSave();
        }
    });

    [maxBackupsInput, autoAppUpdateCheckbox, autoDbUpdateCheckbox, saveUninstalledCheckbox].forEach(el => {
        el.addEventListener('change', autoSave);
    });

    maxBackupsInput.addEventListener('input', function () {
        const value = parseInt(this.value, 10);
        if (isNaN(value) || value < 1) this.value = 1;
        else if (value > 1000) this.value = 1000;
        autoSave();
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
        newPath.className = 'flex gap-2 game-path-item';
        newPath.innerHTML = `
            <input type="text" readonly value="${installPath}"
                class="display-path grow text-xs font-mono" />
            <button type="button" class="select-path home-action-button px-4 py-2">
                <i class="fa-solid fa-ellipsis"></i>
            </button>
            <button type="button" class="remove-path px-4 py-2 text-red-500 hover:bg-red-500/10 rounded-lg transition-colors">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        `;
        gamePathsContainer.appendChild(newPath);

        const selectPathButton = newPath.querySelector('.select-path');
        const pathInput = newPath.querySelector('.display-path');
        const removePathButton = newPath.querySelector('.remove-path');

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
