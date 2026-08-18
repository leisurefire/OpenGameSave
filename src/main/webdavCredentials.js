const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const CREDENTIAL_VERSION = 1;
const MAX_CREDENTIAL_FILE_SIZE = 64 * 1024;
let credentialWriteQueue = Promise.resolve();

function getCredentialPath() {
    return path.join(app.getPath('userData'), 'OGS Settings', 'webdav-credentials.json');
}

async function readCredentialRecord() {
    const credentialPath = getCredentialPath();
    try {
        const stats = await fs.promises.stat(credentialPath);
        if (!stats.isFile() || stats.size > MAX_CREDENTIAL_FILE_SIZE) {
            throw new Error('Invalid WebDAV credential file');
        }
        const record = JSON.parse(await fs.promises.readFile(credentialPath, 'utf8'));
        if (record?.version !== CREDENTIAL_VERSION
            || typeof record.encryptedPassword !== 'string'
            || record.encryptedPassword.length > MAX_CREDENTIAL_FILE_SIZE) {
            throw new Error('Invalid WebDAV credential file');
        }
        return record;
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

async function hasStoredWebDAVPassword() {
    return Boolean(await readCredentialRecord());
}

async function readWebDAVPassword() {
    const record = await readCredentialRecord();
    if (!record) return '';
    if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Secure credential storage is unavailable');
    }
    try {
        return safeStorage.decryptString(Buffer.from(record.encryptedPassword, 'base64'));
    } catch (_) {
        throw new Error('The saved WebDAV password cannot be decrypted for this Windows account');
    }
}

async function persistWebDAVPassword(password) {
    if (typeof password !== 'string' || password.length > 4096 || password.includes('\0')) {
        throw new Error('Invalid WebDAV password');
    }

    credentialWriteQueue = credentialWriteQueue.catch(() => undefined).then(async () => {
        const credentialPath = getCredentialPath();
        await fs.promises.mkdir(path.dirname(credentialPath), { recursive: true, mode: 0o700 });

        if (!password) {
            await fs.promises.rm(credentialPath, { force: true });
            return;
        }
        if (!safeStorage.isEncryptionAvailable()) {
            throw new Error('Secure credential storage is unavailable; the password was not saved');
        }

        const encryptedPassword = safeStorage.encryptString(password).toString('base64');
        const payload = JSON.stringify({ version: CREDENTIAL_VERSION, encryptedPassword }, null, 2);
        const tempPath = `${credentialPath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await fs.promises.writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
            await fs.promises.rename(tempPath, credentialPath);
        } finally {
            await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
        }
    });
    return credentialWriteQueue;
}

module.exports = {
    hasStoredWebDAVPassword,
    persistWebDAVPassword,
    readWebDAVPassword
};
