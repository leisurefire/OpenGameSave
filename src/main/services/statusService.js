const { getSettings } = require('./settingsService');

const STATUS_KEYS = new Set([
    'backuping',
    'scanning_full',
    'restoring',
    'migrating',
    'updating_db',
    'exporting',
    'importing',
    'updating_backup',
    'updating_restore',
    'syncing'
]);

const status = Object.fromEntries([...STATUS_KEYS].map(key => [key, false]));

function getGameDisplayName(gameObject) {
    const language = getSettings().language;
    if (language === 'zh_CN') return gameObject.zh_CN || gameObject.title;
    return gameObject.title;
}

function updateStatus(statusKey, statusValue) {
    if (!STATUS_KEYS.has(statusKey) || typeof statusValue !== 'boolean') {
        throw new Error('Invalid status update');
    }
    status[statusKey] = statusValue;
}

module.exports = {
    getGameDisplayName,
    getStatus: () => ({ ...status }),
    updateStatus
};
