const {
    checkGitSyncStatus,
    downloadBackupsFromGitHub,
    uploadBackupsToGitHub
} = require('./githubSync');
const {
    checkWebDAVSyncStatus,
    downloadBackupsFromWebDAV,
    getWebDAVPublicConfig,
    saveWebDAVProviderConfig,
    uploadBackupsToWebDAV
} = require('./webdavSync');

const providerDefinitions = new Map([
    ['github', {
        id: 'github',
        configurable: false,
        getStatus: checkGitSyncStatus,
        upload: uploadBackupsToGitHub,
        download: downloadBackupsFromGitHub
    }],
    ['webdav', {
        id: 'webdav',
        configurable: true,
        getConfig: getWebDAVPublicConfig,
        saveConfig: saveWebDAVProviderConfig,
        getStatus: checkWebDAVSyncStatus,
        upload: uploadBackupsToWebDAV,
        download: downloadBackupsFromWebDAV
    }]
]);

function getSyncProvider(providerId) {
    const provider = providerDefinitions.get(String(providerId || ''));
    if (!provider) throw new Error('Unsupported sync provider');
    return provider;
}

function listSyncProviders() {
    return [...providerDefinitions.values()].map(provider => ({
        id: provider.id,
        configurable: provider.configurable
    }));
}

async function getSyncProviderConfig(providerId) {
    const provider = getSyncProvider(providerId);
    return provider.getConfig ? provider.getConfig() : null;
}

async function saveSyncProviderConfig(providerId, config) {
    const provider = getSyncProvider(providerId);
    if (!provider.saveConfig) throw new Error('This sync provider has no editable configuration');
    return provider.saveConfig(config);
}

async function checkSyncProviderStatus(providerId, syncPath) {
    return getSyncProvider(providerId).getStatus(syncPath);
}

async function runSyncProviderAction(providerId, direction, syncPath) {
    if (!['upload', 'download'].includes(direction)) throw new Error('Unsupported sync direction');
    return getSyncProvider(providerId)[direction](syncPath);
}

module.exports = {
    checkSyncProviderStatus,
    getSyncProviderConfig,
    listSyncProviders,
    runSyncProviderAction,
    saveSyncProviderConfig
};
