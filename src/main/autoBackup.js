const fsOriginal = require('original-fs');
const chokidar = require('chokidar');
const i18next = require('i18next');
const { format } = require('date-fns');

const { getSettings, saveSettings, getMainWin } = require('./global');
const { getGameDataFromDB, backupGame } = require('./backup');

// Active auto-backup entries: Map<wikiId, { mode, intervalMinutes, timer?, watcher?, logs[] }>
const activeAutoBackups = new Map();

// Cooldown tracking for file watchers - throttle pattern (backup immediately, then cooldown)
const watcherCooldowns = new Map();
const pendingWatcherBackups = new Set(); // Track changes that occurred during cooldown
const WATCHER_COOLDOWN_MS = 10000; // 10 seconds cooldown between backups
const MAX_AUTO_BACKUP_LOGS = 100;

function addAutoBackupLog(entry, logEntry) {
    entry.logs.push(logEntry);
    if (entry.logs.length > MAX_AUTO_BACKUP_LOGS) {
        entry.logs.splice(0, entry.logs.length - MAX_AUTO_BACKUP_LOGS);
    }
}

/**
 * Start auto backup for a game
 * @param {string} wikiId
 * @param {string} mode - 'interval' or 'watcher'
 * @param {number} intervalMinutes - only used for 'interval' mode
 */
async function startAutoBackup(wikiId, mode, intervalMinutes) {
    // Stop any existing auto backup for this game first
    stopAutoBackup(wikiId, false);

    const entry = {
        mode,
        intervalMinutes: mode === 'interval' ? intervalMinutes : null,
        timer: null,
        watcher: null,
        logs: [],
        backupInProgress: false
    };

    if (mode === 'interval') {
        // Perform backup immediately on start, then at interval
        const intervalMs = intervalMinutes * 60 * 1000;
        entry.timer = setInterval(() => {
            performSilentBackup(wikiId);
        }, intervalMs);
    } else if (mode === 'watcher') {
        await setupFileWatcher(wikiId, entry);
    }

    activeAutoBackups.set(wikiId, entry);

    // Save setting
    const settings = getSettings();
    const autoBackupGames = settings.autoBackupGames || {};
    autoBackupGames[wikiId] = { mode, intervalMinutes: mode === 'interval' ? intervalMinutes : null };
    saveSettings('autoBackupGames', autoBackupGames);

    // Notify renderer to update timer icon
    const win = getMainWin();
    if (win && !win.isDestroyed()) {
        win.webContents.send('auto-backup-started', wikiId);
    }
}

/**
 * Stop auto backup for a game
 * @param {string} wikiId
 * @param {boolean} showSummary - whether to show disable summary
 * @returns {object|null} - logs if showSummary is true
 */
function stopAutoBackup(wikiId, showSummary = true) {
    const entry = activeAutoBackups.get(wikiId);
    if (!entry) return null;

    // Clear timer
    if (entry.timer) {
        clearInterval(entry.timer);
        entry.timer = null;
    }

    // Close watcher. chokidar.close() is asynchronous, but do not await it in
    // normal UI paths; stopAllAutoBackups() handles graceful shutdown on quit.
    if (entry.watcher) {
        entry.watcher.close().catch((error) => {
            console.error(`Error closing file watcher for ${wikiId}:`, error.message);
        });
        entry.watcher = null;
    }

    // Clear cooldown
    if (watcherCooldowns.has(wikiId)) {
        clearTimeout(watcherCooldowns.get(wikiId));
        watcherCooldowns.delete(wikiId);
    }
    pendingWatcherBackups.delete(wikiId);

    const logs = [...entry.logs];
    activeAutoBackups.delete(wikiId);

    // Remove from settings
    const settings = getSettings();
    const autoBackupGames = settings.autoBackupGames || {};
    delete autoBackupGames[wikiId];
    saveSettings('autoBackupGames', autoBackupGames);

    // Notify renderer to update timer icon
    const win = getMainWin();
    if (win && !win.isDestroyed()) {
        win.webContents.send('auto-backup-stopped', wikiId);
    }

    if (showSummary) {
        return logs;
    }
    return null;
}

/**
 * Set up file watcher for a game's save paths
 */
async function setupFileWatcher(wikiId, entry) {
    try {
        const { games } = await getGameDataFromDB(false, wikiId);
        if (!games || games.length === 0) return;

        const gameData = games[0];
        if (!gameData.resolved_paths || gameData.resolved_paths.length === 0) return;

        const pathsToWatch = [];
        for (const resolvedPathObj of gameData.resolved_paths) {
            if (resolvedPathObj.type === 'reg') continue; // Skip registry paths
            const resolvedPath = resolvedPathObj.resolved;
            if (fsOriginal.existsSync(resolvedPath)) {
                pathsToWatch.push(resolvedPath);
            }
        }

        if (pathsToWatch.length === 0) return;

        const watcher = chokidar.watch(pathsToWatch, {
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 2000,
                pollInterval: 500
            }
        });

        watcher.on('all', (event, filePath) => {
            // Throttle: backup immediately on first change, then cooldown
            if (watcherCooldowns.has(wikiId)) {
                // Mark that changes happened during cooldown
                pendingWatcherBackups.add(wikiId);
                return;
            }

            performSilentBackup(wikiId);
            watcherCooldowns.set(wikiId, setTimeout(() => {
                watcherCooldowns.delete(wikiId);
                // If changes occurred during cooldown, perform backup now
                if (pendingWatcherBackups.has(wikiId)) {
                    pendingWatcherBackups.delete(wikiId);
                    performSilentBackup(wikiId);
                    watcherCooldowns.set(wikiId, setTimeout(() => {
                        watcherCooldowns.delete(wikiId);
                    }, WATCHER_COOLDOWN_MS));
                }
            }, WATCHER_COOLDOWN_MS));
        });

        entry.watcher = watcher;
    } catch (error) {
        console.error(`Error setting up file watcher for ${wikiId}:`, error.message);
    }
}

/**
 * Perform a silent backup (no UI summary)
 */
async function performSilentBackup(wikiId) {
    const entry = activeAutoBackups.get(wikiId);
    if (!entry) return;

    // Prevent concurrent backups for the same game
    if (entry.backupInProgress) {
        pendingWatcherBackups.add(wikiId);
        return;
    }
    entry.backupInProgress = true;

    try {
        const { games } = await getGameDataFromDB(false, wikiId);
        if (!games || games.length === 0) {
            const errorMsg = i18next.t('alert.auto_backup_game_not_found');
            addAutoBackupLog(entry, {
                timestamp: format(new Date(), 'yyyy/MM/dd HH:mm:ss'),
                success: false,
                error: errorMsg
            });
            const win = getMainWin();
            if (win && !win.isDestroyed()) {
                win.webContents.send('show-alert', 'error', errorMsg);
            }
            return;
        }

        const gameData = games[0];
        const error = await backupGame(gameData);

        const logEntry = {
            timestamp: format(new Date(), 'yyyy/MM/dd HH:mm:ss'),
            success: !error,
            error: error || null
        };
        addAutoBackupLog(entry, logEntry);

        // Notify renderer to update table rows
        const win = getMainWin();
        if (win && !win.isDestroyed()) {
            win.webContents.send('auto-backup-performed', wikiId);

            // Send alert on failure
            if (error) {
                win.webContents.send('show-alert', 'error', error);
            }
        }
    } catch (error) {
        console.error(`Auto backup error for ${wikiId}:`, error.message);
        addAutoBackupLog(entry, {
            timestamp: format(new Date(), 'yyyy/MM/dd HH:mm:ss'),
            success: false,
            error: error.message
        });
        const win = getMainWin();
        if (win && !win.isDestroyed()) {
            win.webContents.send('show-alert', 'error', error.message);
        }
    } finally {
        if (activeAutoBackups.has(wikiId)) {
            const activeEntry = activeAutoBackups.get(wikiId);
            activeEntry.backupInProgress = false;
            if (pendingWatcherBackups.has(wikiId)) {
                pendingWatcherBackups.delete(wikiId);
                performSilentBackup(wikiId);
            }
        }
    }
}

/**
 * Get serializable state of all active auto backups
 * @returns {Object} - { [wikiId]: { mode, intervalMinutes, logCount, failCount } }
 */
function getAutoBackupState() {
    const state = {};
    for (const [wikiId, entry] of activeAutoBackups) {
        state[wikiId] = {
            mode: entry.mode,
            intervalMinutes: entry.intervalMinutes,
            logCount: entry.logs.length,
            failCount: entry.logs.filter(l => !l.success).length
        };
    }
    return state;
}

/**
 * Restore auto backups from settings on app start
 */
async function restoreAutoBackups() {
    const settings = getSettings();
    const autoBackupGames = settings.autoBackupGames || {};

    for (const [wikiId, config] of Object.entries(autoBackupGames)) {
        try {
            await startAutoBackup(wikiId, config.mode, config.intervalMinutes);
        } catch (error) {
            console.error(`Failed to restore auto backup for ${wikiId}:`, error.message);
        }
    }
}

/**
 * Stop all auto backups (for app quit) - cleanup only, preserves settings
 */
async function stopAllAutoBackups() {
    const closePromises = [];

    for (const [wikiId, entry] of activeAutoBackups) {
        if (entry.timer) {
            clearInterval(entry.timer);
            entry.timer = null;
        }
        if (entry.watcher) {
            closePromises.push(
                entry.watcher.close().catch((error) => {
                    console.error(`Error closing file watcher for ${wikiId}:`, error.message);
                })
            );
            entry.watcher = null;
        }
        if (watcherCooldowns.has(wikiId)) {
            clearTimeout(watcherCooldowns.get(wikiId));
            watcherCooldowns.delete(wikiId);
        }
        pendingWatcherBackups.delete(wikiId);
    }
    activeAutoBackups.clear();

    await Promise.allSettled(closePromises);
}

module.exports = {
    startAutoBackup,
    stopAutoBackup,
    getAutoBackupState,
    restoreAutoBackups,
    stopAllAutoBackups
};
