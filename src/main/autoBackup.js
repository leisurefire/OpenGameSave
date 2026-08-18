const fsOriginal = require('original-fs');
const chokidar = require('chokidar');
const i18next = require('i18next');
const { format } = require('date-fns');

const { getSettings, saveSettings, getMainWin } = require('./global');
const { getGameDataFromDB, backupGame } = require('./backup');
const { normalizeAutoBackupInterval, normalizeAutoBackupMode, normalizeWikiId } = require('./validation');

// Active auto-backup entries: Map<wikiId, { mode, intervalMinutes, timer?, watcher?, logs[] }>
const activeAutoBackups = new Map();

// Cooldown tracking for file watchers - throttle pattern (backup immediately, then cooldown)
const watcherCooldowns = new Map();
const pendingWatcherBackups = new Set(); // Track changes that occurred during cooldown
const WATCHER_COOLDOWN_MS = 10000; // 10 seconds cooldown between backups
const MAX_AUTO_BACKUP_LOGS = 100;

function addAutoBackupLog(entry, logEntry) {
    entry.logs.push(logEntry);
    if (!logEntry.success) entry.failCount += 1;
    if (entry.logs.length > MAX_AUTO_BACKUP_LOGS) {
        const removed = entry.logs.splice(0, entry.logs.length - MAX_AUTO_BACKUP_LOGS);
        entry.failCount -= removed.filter(log => !log.success).length;
    }
}

async function disposeAutoBackupEntry(wikiId, entry) {
    if (entry.timer) {
        clearInterval(entry.timer);
        entry.timer = null;
    }
    if (entry.watcher) {
        try {
            await entry.watcher.close();
        } catch (error) {
            console.error(`Error closing file watcher for ${wikiId}:`, error.message);
        }
        entry.watcher = null;
    }
    const cooldown = watcherCooldowns.get(wikiId);
    if (cooldown) clearTimeout(cooldown);
    watcherCooldowns.delete(wikiId);
    pendingWatcherBackups.delete(wikiId);
}

/**
 * Start auto backup for a game
 * @param {string} wikiId
 * @param {string} mode - 'interval' or 'watcher'
 * @param {number} intervalMinutes - only used for 'interval' mode
 */
async function startAutoBackup(wikiId, mode, intervalMinutes) {
    const safeWikiId = normalizeWikiId(wikiId);
    const safeMode = normalizeAutoBackupMode(mode);
    const safeIntervalMinutes = safeMode === 'interval' ? normalizeAutoBackupInterval(intervalMinutes) : null;
    const { games } = await getGameDataFromDB(false, safeWikiId);
    if (!games?.[0]) throw new Error('Game data is no longer available');

    // Stop any existing auto backup for this game first
    await stopAutoBackup(safeWikiId, false);

    const entry = {
        mode: safeMode,
        intervalMinutes: safeIntervalMinutes,
        timer: null,
        watcher: null,
        logs: [],
        backupInProgress: false,
        failCount: 0
    };

    try {
        if (safeMode === 'interval') {
            const intervalMs = safeIntervalMinutes * 60 * 1000;
            entry.timer = setInterval(() => {
                void performSilentBackup(safeWikiId);
            }, intervalMs);
        } else {
            await setupFileWatcher(safeWikiId, entry);
        }

        activeAutoBackups.set(safeWikiId, entry);
        const settings = getSettings();
        const autoBackupGames = { ...(settings.autoBackupGames || {}) };
        autoBackupGames[safeWikiId] = { mode: safeMode, intervalMinutes: safeIntervalMinutes };
        await saveSettings('autoBackupGames', autoBackupGames);
    } catch (error) {
        activeAutoBackups.delete(safeWikiId);
        await disposeAutoBackupEntry(safeWikiId, entry);
        throw error;
    }

    // Notify renderer to update timer icon
    const win = getMainWin();
    if (win && !win.isDestroyed()) {
        win.webContents.send('auto-backup-started', safeWikiId);
    }
}

/**
 * Stop auto backup for a game
 * @param {string} wikiId
 * @param {boolean} showSummary - whether to show disable summary
 * @returns {object|null} - logs if showSummary is true
 */
async function stopAutoBackup(wikiId, showSummary = true) {
    const safeWikiId = normalizeWikiId(wikiId);
    const entry = activeAutoBackups.get(safeWikiId);
    if (!entry) return null;

    await disposeAutoBackupEntry(safeWikiId, entry);

    const logs = [...entry.logs];
    activeAutoBackups.delete(safeWikiId);

    // Remove from settings
    const settings = getSettings();
    const autoBackupGames = { ...(settings.autoBackupGames || {}) };
    delete autoBackupGames[safeWikiId];
    await saveSettings('autoBackupGames', autoBackupGames);

    // Notify renderer to update timer icon
    const win = getMainWin();
    if (win && !win.isDestroyed()) {
        win.webContents.send('auto-backup-stopped', safeWikiId);
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
        if (!games || games.length === 0) throw new Error('Game data is no longer available');

        const gameData = games[0];
        if (!gameData.resolved_paths || gameData.resolved_paths.length === 0) throw new Error('Game has no save paths to watch');

        const pathsToWatch = [];
        for (const resolvedPathObj of gameData.resolved_paths) {
            if (resolvedPathObj.type === 'reg') continue; // Skip registry paths
            const resolvedPath = resolvedPathObj.resolved;
            if (fsOriginal.existsSync(resolvedPath)) {
                pathsToWatch.push(resolvedPath);
            }
        }

        if (pathsToWatch.length === 0) throw new Error('Game has no file-system save paths to watch');

        const watcher = chokidar.watch(pathsToWatch, {
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 2000,
                pollInterval: 500
            }
        });

        watcher.on('all', () => {
            // Throttle: backup immediately on first change, then cooldown
            if (watcherCooldowns.has(wikiId)) {
                // Mark that changes happened during cooldown
                pendingWatcherBackups.add(wikiId);
                return;
            }

            void performSilentBackup(wikiId);
            startWatcherCooldown(wikiId);
        });
        watcher.on('error', (error) => {
            console.error(`File watcher error for ${wikiId}:`, error.message);
        });

        entry.watcher = watcher;
    } catch (error) {
        console.error(`Error setting up file watcher for ${wikiId}:`, error.message);
        throw error;
    }
}

/**
 * Re-resolve active watcher paths after an account-scope setting changes.
 * Interval jobs do not retain resolved paths and therefore need no refresh.
 *
 * @returns {Promise<Array<{wikiId: string, error: string}>>}
 */
async function refreshAutoBackupWatchers() {
    const failures = [];

    for (const [wikiId, entry] of activeAutoBackups) {
        if (entry.mode !== 'watcher') continue;

        const previousWatcher = entry.watcher;
        entry.watcher = null;

        const cooldown = watcherCooldowns.get(wikiId);
        if (cooldown) clearTimeout(cooldown);
        watcherCooldowns.delete(wikiId);
        pendingWatcherBackups.delete(wikiId);

        try {
            await setupFileWatcher(wikiId, entry);
        } catch (error) {
            // Keep the last known-good watcher alive when the new account scope
            // does not currently resolve to a usable filesystem path.
            entry.watcher = previousWatcher;
            failures.push({ wikiId, error: error.message });
            continue;
        }

        if (previousWatcher) {
            try {
                await previousWatcher.close();
            } catch (error) {
                console.error(`Error closing previous file watcher for ${wikiId}:`, error.message);
            }
        }
    }

    return failures;
}

function startWatcherCooldown(wikiId) {
    const existingTimer = watcherCooldowns.get(wikiId);
    if (existingTimer) clearTimeout(existingTimer);
    watcherCooldowns.set(wikiId, setTimeout(() => {
        watcherCooldowns.delete(wikiId);
        if (!activeAutoBackups.has(wikiId) || !pendingWatcherBackups.delete(wikiId)) return;
        void performSilentBackup(wikiId);
        startWatcherCooldown(wikiId);
    }, WATCHER_COOLDOWN_MS));
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
            if (pendingWatcherBackups.has(wikiId) && !watcherCooldowns.has(wikiId)) {
                pendingWatcherBackups.delete(wikiId);
                void performSilentBackup(wikiId);
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
            failCount: entry.failCount
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
    const closePromises = [...activeAutoBackups]
        .map(([wikiId, entry]) => disposeAutoBackupEntry(wikiId, entry));
    activeAutoBackups.clear();
    await Promise.allSettled(closePromises);
}

module.exports = {
    startAutoBackup,
    stopAutoBackup,
    getAutoBackupState,
    refreshAutoBackupWatchers,
    restoreAutoBackups,
    stopAllAutoBackups
};
