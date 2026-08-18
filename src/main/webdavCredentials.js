const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PROVIDER_VERSION = 2;
const LEGACY_CREDENTIAL_VERSION = 1;
const MAX_PROVIDER_FILE_SIZE = 128 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let providerWriteQueue = Promise.resolve();

function getProviderPath() {
    return path.join(app.getPath('userData'), 'OGS Settings', 'webdav-provider.json');
}

function getLegacyCredentialPath() {
    return path.join(app.getPath('userData'), 'OGS Settings', 'webdav-credentials.json');
}

async function readBoundedJson(filePath, maximumSize = MAX_PROVIDER_FILE_SIZE) {
    try {
        const stats = await fs.promises.stat(filePath);
        if (!stats.isFile() || stats.size > maximumSize) throw new Error('Invalid WebDAV provider file');
        return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (error instanceof SyntaxError) throw new Error('Invalid WebDAV provider file');
        throw error;
    }
}

function validateEncryptedRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || record.version !== PROVIDER_VERSION || !UUID_PATTERN.test(record.generation)
        || !UUID_PATTERN.test(record.deviceId) || typeof record.url !== 'string'
        || typeof record.username !== 'string' || typeof record.remotePath !== 'string'
        || typeof record.hasPassword !== 'boolean' || typeof record.encryptedPassword !== 'string'
        || record.encryptedPassword.length > MAX_PROVIDER_FILE_SIZE
        || record.hasPassword !== Boolean(record.encryptedPassword)) {
        throw new Error('Invalid WebDAV provider file');
    }
    return record;
}

async function ensureAsyncEncryptionAvailable() {
    if (!await safeStorage.isAsyncEncryptionAvailable()) {
        throw new Error('Secure credential storage is temporarily unavailable');
    }
}

async function decryptPassword(encryptedPassword) {
    if (!encryptedPassword) return { password: '', shouldReEncrypt: false };
    await ensureAsyncEncryptionAvailable();
    try {
        const decrypted = await safeStorage.decryptStringAsync(Buffer.from(encryptedPassword, 'base64'));
        return { password: decrypted.result, shouldReEncrypt: decrypted.shouldReEncrypt === true };
    } catch (_) {
        throw new Error('The saved WebDAV password cannot be decrypted for this operating-system account');
    }
}

async function encryptPassword(password) {
    if (!password) return '';
    await ensureAsyncEncryptionAvailable();
    return (await safeStorage.encryptStringAsync(password)).toString('base64');
}

async function writeProviderRecord(record) {
    const providerPath = getProviderPath();
    const payload = JSON.stringify(validateEncryptedRecord(record), null, 2);
    const temporaryPath = `${providerPath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.promises.mkdir(path.dirname(providerPath), { recursive: true, mode: 0o700 });
    try {
        const fileHandle = await fs.promises.open(temporaryPath, 'wx', 0o600);
        try {
            await fileHandle.writeFile(payload, 'utf8');
            await fileHandle.sync();
        } finally {
            await fileHandle.close();
        }
        await fs.promises.rename(temporaryPath, providerPath);
    } finally {
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
}

async function persistWebDAVProviderConfig(config) {
    const password = config?.password;
    if (typeof password !== 'string' || password.length > 4096 || password.includes('\0')) {
        throw new Error('Invalid WebDAV password');
    }
    providerWriteQueue = providerWriteQueue.catch(() => undefined).then(async () => {
        const record = {
            version: PROVIDER_VERSION,
            generation: randomUUID(),
            deviceId: UUID_PATTERN.test(config.deviceId || '') ? config.deviceId.toLowerCase() : randomUUID(),
            url: config.url,
            username: config.username,
            remotePath: config.remotePath,
            hasPassword: Boolean(password),
            encryptedPassword: await encryptPassword(password)
        };
        await writeProviderRecord(record);
    });
    return providerWriteQueue;
}

async function readLegacyPassword() {
    const record = await readBoundedJson(getLegacyCredentialPath(), 64 * 1024);
    if (!record) return '';
    if (record.version !== LEGACY_CREDENTIAL_VERSION || typeof record.encryptedPassword !== 'string'
        || record.encryptedPassword.length > 64 * 1024) {
        throw new Error('Invalid legacy WebDAV credential file');
    }
    return (await decryptPassword(record.encryptedPassword)).password;
}

async function readWebDAVProviderConfig(fallbackConfig) {
    const storedRecord = await readBoundedJson(getProviderPath());
    if (!storedRecord) {
        const migrated = {
            ...fallbackConfig,
            deviceId: randomUUID(),
            password: await readLegacyPassword()
        };
        await persistWebDAVProviderConfig(migrated);
        await fs.promises.rm(getLegacyCredentialPath(), { force: true }).catch(() => undefined);
        return migrated;
    }

    const record = validateEncryptedRecord(storedRecord);
    const decrypted = await decryptPassword(record.encryptedPassword);
    const config = {
        url: record.url,
        username: record.username,
        remotePath: record.remotePath,
        deviceId: record.deviceId,
        password: decrypted.password
    };
    if (decrypted.shouldReEncrypt) await persistWebDAVProviderConfig(config);
    return config;
}

module.exports = {
    persistWebDAVProviderConfig,
    readWebDAVProviderConfig
};
