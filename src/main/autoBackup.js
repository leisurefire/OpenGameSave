const fsOriginal = require('original-fs');
const chokidar = require('chokidar');
const i18next = require('i18next');
const { format } = require('date-fns');

const { getSettings, saveSettings, getMainWin } = require('./global');
const { getGameDataFromDB, backupGame } = require('./backup');
const {
    MAX_AUTO_BACKUP_GAMES,
    normalizeAutoBackupInterval,
    normalizeAutoBackupMode,
    normalizeWikiId
} = require('./validation');

// Active auto-backup entries: Map<wikiId, { mode, intervalMinutes, timer?, watcher?, logs[] }>
const activeAutoBackups = new Map();
const pendingStartGenerations = new Map();
const pendingStartPromises = new Set();
let settingsPersistenceQueue = Promise.resolve();
let autoBackupShuttingDown = false;

const WATCHER_COOLDOWN_MS = 10000; // 10 seconds cooldown between backups
const MAX_AUTO_BACKUP_LOGS = 100;

function sendToMainWindow(...args) {
    const window = getMainWin();
    if (!window || window.isDestroyed?.() || window.webContents?.isDestroyed?.()) return false;
    try {
        window.webContents.send(...args);
        return true;
    } catch (error) {
        console.warn(`Could not deliver auto-backup event ${args[0]}:`, error.message);
        return false;
    }
}

function persistAutoBackupSettings() {
    const persistence = settingsPersistenceQueue.catch(() => undefined).then(async () => {
        const autoBackupGames = {};
        for (const [wikiId, entry] of activeAutoBackups) {
            if (entry.disposed) continue;
            autoBackupGames[wikiId] = {
                mode: entry.mode,
                intervalMinutes: entry.intervalMinutes
            };
        }
        await saveSettings('autoBackupGames', autoBackupGames);
    });
    settingsPersistenceQueue = persistence;
    return persistence;
}

function addAutoBackupLog(entry, logEntry) {
    entry.logs.push(logEntry);
    if (!logEntry.success) entry.failCount += 1;
    if (entry.logs.length > MAX_AUTO_BACKUP_LOGS) {
        const removed = entry.logs.splice(0, entry.logs.length - MAX_AUTO_BACKUP_LOGS);
        entry.failCount -= removed.filter(log => !log.success).length;
    }
}

async function disposeAutoBackupEntry(wikiId, entry) {
    if (entry.disposePromise) return entry.disposePromise;
    entry.disposePromise = (async () => {
        entry.disposed = true;
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
        if (entry.cooldownTimer) clearTimeout(entry.cooldownTimer);
        entry.cooldownTimer = null;
        entry.pendingBackup = false;
        if (entry.inFlightPromise) await entry.inFlightPromise;
        if (entry.refreshPromise) await entry.refreshPromise.catch(() => undefined);
    })();
    return entry.disposePromise;
}

/**
 * Start auto backup for a game
 * @param {string} wikiId
 * @param {string} mode - 'interval' or 'watcher'
 * @param {number} intervalMinutes - only used for 'interval' mode
 */
function assertCurrentStart(wikiId, generation) {
    if (autoBackupShuttingDown) throw new Error('Application is shutting down');
    if (pendingStartGenerations.get(wikiId) !== generation) {
        throw new Error('Auto-backup start was superseded');
    }
}

function countScheduledAutoBackups() {
    const wikiIds = new Set(activeAutoBackups.keys());
    for (const wikiId of pendingStartGenerations.keys()) wikiIds.add(wikiId);
    return wikiIds.size;
}

async function startAutoBackupInternal(wikiId, mode, intervalMinutes, options = {}) {
    if (autoBackupShuttingDown) throw new Error('Application is shutting down');
    const safeWikiId = normalizeWikiId(wikiId);
    const safeMode = normalizeAutoBackupMode(mode);
    const safeIntervalMinutes = safeMode === 'interval' ? normalizeAutoBackupInterval(intervalMinutes) : null;
    const persist = options.persist !== false;
    const notify = options.notify !== false;
    if (!activeAutoBackups.has(safeWikiId) && !pendingStartGenerations.has(safeWikiId)
        && countScheduledAutoBackups() >= MAX_AUTO_BACKUP_GAMES) {
        throw new Error('Too many active auto-backup jobs');
    }
    const generation = Symbol(safeWikiId);
    pendingStartGenerations.set(safeWikiId, generation);
    let entry = null;
    let configurationChanged = false;

    try {
        const { games } = await getGameDataFromDB(false, safeWikiId);
        if (!games?.[0]) throw new Error('Game data is no longer available');
        assertCurrentStart(safeWikiId, generation);

        configurationChanged = activeAutoBackups.has(safeWikiId);
        await stopAutoBackup(safeWikiId, false, { cancelPending: false, notify: false, persist: false });
        assertCurrentStart(safeWikiId, generation);

        entry = {
            mode: safeMode,
            intervalMinutes: safeIntervalMinutes,
            timer: null,
            watcher: null,
            logs: [],
            cooldownTimer: null,
            pendingBackup: false,
            inFlightPromise: null,
            refreshPromise: null,
            disposePromise: null,
            disposed: false,
            failCount: 0
        };
        if (safeMode === 'interval') {
            const intervalMs = safeIntervalMinutes * 60 * 1000;
            entry.timer = setInterval(() => {
                void triggerSilentBackup(safeWikiId, entry);
            }, intervalMs);
        } else {
            entry.watcher = await createFileWatcher(safeWikiId, entry);
        }

        assertCurrentStart(safeWikiId, generation);
        activeAutoBackups.set(safeWikiId, entry);
        configurationChanged = true;
        if (persist) await persistAutoBackupSettings();
        assertCurrentStart(safeWikiId, generation);
    } catch (error) {
        if (entry && activeAutoBackups.get(safeWikiId) === entry) {
            activeAutoBackups.delete(safeWikiId);
        }
        if (entry) await disposeAutoBackupEntry(safeWikiId, entry);
        if (persist && configurationChanged && !autoBackupShuttingDown) {
            await persistAutoBackupSettings().catch((persistenceError) => {
                console.error('Failed to persist auto-backup cleanup:', persistenceError.message);
            });
        }
        throw error;
    } finally {
        if (pendingStartGenerations.get(safeWikiId) === generation) {
            pendingStartGenerations.delete(safeWikiId);
        }
    }

    if (notify) {
        sendToMainWindow('auto-backup-started', safeWikiId);
    }
}

function startAutoBackup(wikiId, mode, intervalMinutes, options) {
    const startPromise = startAutoBackupInternal(wikiId, mode, intervalMinutes, options);
    pendingStartPromises.add(startPromise);
    const forget = () => pendingStartPromises.delete(startPromise);
    startPromise.then(forget, forget);
    return startPromise;
}

/**
 * Stop auto backup for a game
 * @param {string} wikiId
 * @param {boolean} showSummary - whether to show disable summary
 * @returns {object|null} - logs if showSummary is true
 */
async function stopAutoBackup(wikiId, showSummary = true, options = {}) {
    const safeWikiId = normalizeWikiId(wikiId);
    const cancelPending = options.cancelPending !== false;
    const persist = options.persist !== false;
    const notify = options.notify !== false;
    if (cancelPending) pendingStartGenerations.delete(safeWikiId);
    const entry = activeAutoBackups.get(safeWikiId);
    if (!entry) {
        if (cancelPending && persist) await persistAutoBackupSettings();
        return null;
    }

    activeAutoBackups.delete(safeWikiId);
    await disposeAutoBackupEntry(safeWikiId, entry);

    const logs = [...entry.logs];
    const replacementEntry = activeAutoBackups.get(safeWikiId);

    if (!replacementEntry) {
        if (persist) await persistAutoBackupSettings();

        // Notify renderer to update timer icon
        if (notify) {
            sendToMainWindow('auto-backup-stopped', safeWikiId);
        }
    }

    if (showSummary) {
        return logs;
    }
    return null;
}

/**
 * Set up file watcher for a game's save paths
 */
async function createFileWatcher(wikiId, entry) {
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
            if (autoBackupShuttingDown || entry.disposed || activeAutoBackups.get(wikiId) !== entry) return;
            // Throttle: backup immediately on first change, then cooldown
            if (entry.cooldownTimer) {
                // Mark that changes happened during cooldown
                entry.pendingBackup = true;
                return;
            }

            void triggerSilentBackup(wikiId, entry);
            startWatcherCooldown(wikiId, entry);
        });
        watcher.on('error', (error) => {
            console.error(`File watcher error for ${wikiId}:`, error.message);
        });
        return watcher;
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

        try {
            const previousRefresh = entry.refreshPromise || Promise.resolve();
            entry.refreshPromise = previousRefresh.catch(() => undefined).then(async () => {
                if (entry.disposed || activeAutoBackups.get(wikiId) !== entry) return;
                const replacementWatcher = await createFileWatcher(wikiId, entry);
                if (entry.disposed || activeAutoBackups.get(wikiId) !== entry) {
                    await replacementWatcher.close();
                    return;
                }

                const previousWatcher = entry.watcher;
                entry.watcher = replacementWatcher;
                if (entry.cooldownTimer) clearTimeout(entry.cooldownTimer);
                entry.cooldownTimer = null;
                entry.pendingBackup = false;
                if (previousWatcher) await previousWatcher.close();
            });
            await entry.refreshPromise;
        } catch (error) {
            failures.push({ wikiId, error: error.message });
        }
    }

    return failures;
}

function startWatcherCooldown(wikiId, entry) {
    if (entry.cooldownTimer) clearTimeout(entry.cooldownTimer);
    entry.cooldownTimer = setTimeout(() => {
        entry.cooldownTimer = null;
        if (entry.disposed || activeAutoBackups.get(wikiId) !== entry || !entry.pendingBackup) return;
        entry.pendingBackup = false;
        void triggerSilentBackup(wikiId, entry);
        startWatcherCooldown(wikiId, entry);
    }, WATCHER_COOLDOWN_MS);
}

/**
 * Perform a silent backup (no UI summary)
 */
function triggerSilentBackup(wikiId, expectedEntry = null) {
    const entry = expectedEntry || activeAutoBackups.get(wikiId);
    if (autoBackupShuttingDown || !entry || entry.disposed || activeAutoBackups.get(wikiId) !== entry) {
        return Promise.resolve();
    }
    if (entry.inFlightPromise) {
        entry.pendingBackup = true;
        return entry.inFlightPromise;
    }

    const task = performSilentBackup(wikiId, entry).finally(() => {
        if (entry.inFlightPromise === task) entry.inFlightPromise = null;
        if (entry.disposed || activeAutoBackups.get(wikiId) !== entry
            || !entry.pendingBackup || entry.cooldownTimer) return;
        entry.pendingBackup = false;
        void triggerSilentBackup(wikiId, entry);
    });
    entry.inFlightPromise = task;
    return task;
}

async function performSilentBackup(wikiId, entry) {

    try {
        const { games } = await getGameDataFromDB(false, wikiId);
        if (!games || games.length === 0) {
            const errorMsg = i18next.t('alert.auto_backup_game_not_found');
            addAutoBackupLog(entry, {
                timestamp: format(new Date(), 'yyyy/MM/dd HH:mm:ss'),
                success: false,
                error: errorMsg
            });
            if (!entry.disposed && activeAutoBackups.get(wikiId) === entry) {
                sendToMainWindow('show-alert', 'error', errorMsg);
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
        if (!entry.disposed && activeAutoBackups.get(wikiId) === entry) {
            sendToMainWindow('auto-backup-performed', wikiId);

            // Send alert on failure
            if (error) {
                sendToMainWindow('show-alert', 'error', error);
            }
        }
    } catch (error) {
        console.error(`Auto backup error for ${wikiId}:`, error.message);
        addAutoBackupLog(entry, {
            timestamp: format(new Date(), 'yyyy/MM/dd HH:mm:ss'),
            success: false,
            error: error.message
        });
        if (!entry.disposed && activeAutoBackups.get(wikiId) === entry) {
            sendToMainWindow('show-alert', 'error', error.message);
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
            await startAutoBackup(wikiId, config.mode, config.intervalMinutes, { notify: false, persist: false });
        } catch (error) {
            console.error(`Failed to restore auto backup for ${wikiId}:`, error.message);
        }
    }
    if (!autoBackupShuttingDown) await persistAutoBackupSettings();
}

/**
 * Stop all auto backups (for app quit) - cleanup only, preserves settings
 */
async function stopAllAutoBackups() {
    autoBackupShuttingDown = true;
    await Promise.allSettled([...pendingStartPromises]);
    await settingsPersistenceQueue.catch(() => undefined);
    const entries = [...activeAutoBackups];
    activeAutoBackups.clear();
    for (const [, entry] of entries) entry.disposed = true;
    await Promise.all(entries.map(([wikiId, entry]) => disposeAutoBackupEntry(wikiId, entry)));
}

module.exports = {
    startAutoBackup,
    stopAutoBackup,
    getAutoBackupState,
    refreshAutoBackupWatchers,
    restoreAutoBackups,
    stopAllAutoBackups
};
