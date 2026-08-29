const { createHash } = require('crypto');
const fsOriginal = require('original-fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const i18next = require('i18next');

const { acquireGlobalOperation } = require('../gameOperationLock');
const {
    assertNoSymlinkAncestors,
    isPathInside,
    normalizeAbsolutePath,
    resolveInside
} = require('../validation');
const { saveSettings } = require('./settingsService');
const { getStatus, updateStatus } = require('./statusService');
const { getMainWin } = require('./windowManager');

function sendToMainWindow(...args) {
    const mainWindow = getMainWin();
    if (!mainWindow
        || mainWindow.isDestroyed?.()
        || !mainWindow.webContents
        || mainWindow.webContents.isDestroyed?.()) {
        return false;
    }
    try {
        mainWindow.webContents.send(...args);
        return true;
    } catch (_) {
        // Renderer lifecycle changes must not interrupt the migration pipeline.
        return false;
    }
}

const MAX_MIGRATION_ENTRIES = 200000;

function statFingerprint(stats) {
    return {
        size: stats.size,
        mode: stats.mode,
        mtimeMs: stats.mtimeMs,
        ctimeMs: stats.ctimeMs,
        dev: stats.dev,
        ino: stats.ino
    };
}

function sameFingerprint(left, right) {
    return left.size === right.size
        && left.mode === right.mode
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs
        && left.dev === right.dev
        && left.ino === right.ino;
}

function toRelativeKey(rootPath, entryPath) {
    const relativePath = path.relative(rootPath, entryPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error('Backup migration path escapes the source directory');
    }
    return relativePath.split(path.sep).join('/');
}

function fromRelativeKey(rootPath, relativeKey) {
    return relativeKey ? resolveInside(rootPath, ...relativeKey.split('/')) : rootPath;
}

async function hashRegularFile(filePath) {
    const beforeStats = await fsOriginal.promises.lstat(filePath);
    if (!beforeStats.isFile() || beforeStats.isSymbolicLink() || !Number.isSafeInteger(beforeStats.size)) {
        throw new Error(`Refusing to migrate unsupported file: ${filePath}`);
    }
    const hash = createHash('sha256');
    let size = 0;
    const flags = fsOriginal.constants.O_RDONLY | (fsOriginal.constants.O_NOFOLLOW || 0);
    const stream = fsOriginal.createReadStream(filePath, { flags });
    for await (const chunk of stream) {
        size += chunk.length;
        if (!Number.isSafeInteger(size)) throw new Error('Backup migration file is too large');
        hash.update(chunk);
    }
    const afterStats = await fsOriginal.promises.lstat(filePath);
    if (!afterStats.isFile() || afterStats.isSymbolicLink()
        || !sameFingerprint(statFingerprint(beforeStats), statFingerprint(afterStats))
        || size !== beforeStats.size) {
        throw new Error('Source backup data changed during migration');
    }
    return {
        size,
        sha256: hash.digest('hex'),
        fingerprint: statFingerprint(beforeStats),
        atimeMs: beforeStats.atimeMs,
        mtimeMs: beforeStats.mtimeMs
    };
}

async function createSourceManifest(sourcePath) {
    const directories = new Map();
    const files = new Map();
    const pendingDirectories = [sourcePath];
    let entryCount = 0;
    let totalSize = 0;

    while (pendingDirectories.length > 0) {
        const currentDirectory = pendingDirectories.pop();
        const beforeStats = await fsOriginal.promises.lstat(currentDirectory);
        if (!beforeStats.isDirectory() || beforeStats.isSymbolicLink()) {
            throw new Error(`Refusing to migrate non-directory or linked path: ${currentDirectory}`);
        }
        const relativeDirectory = toRelativeKey(sourcePath, currentDirectory);
        const entries = await fsOriginal.promises.readdir(currentDirectory, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        const afterStats = await fsOriginal.promises.lstat(currentDirectory);
        if (!afterStats.isDirectory() || afterStats.isSymbolicLink()
            || !sameFingerprint(statFingerprint(beforeStats), statFingerprint(afterStats))) {
            throw new Error('Source backup data changed during migration');
        }
        directories.set(relativeDirectory, {
            fingerprint: statFingerprint(beforeStats),
            atimeMs: beforeStats.atimeMs,
            mtimeMs: beforeStats.mtimeMs
        });

        for (const entry of entries) {
            entryCount += 1;
            if (entryCount > MAX_MIGRATION_ENTRIES) throw new Error('Backup migration contains too many entries');
            const entryPath = resolveInside(currentDirectory, entry.name);
            const entryStats = await fsOriginal.promises.lstat(entryPath);
            if (entryStats.isSymbolicLink()) throw new Error(`Refusing to migrate symbolic link: ${entryPath}`);
            if (entryStats.isDirectory()) {
                pendingDirectories.push(entryPath);
            } else if (entryStats.isFile()) {
                const relativeFile = toRelativeKey(sourcePath, entryPath);
                const descriptor = await hashRegularFile(entryPath);
                files.set(relativeFile, descriptor);
                totalSize += descriptor.size;
                if (!Number.isSafeInteger(totalSize)) throw new Error('Backup migration is too large');
            } else {
                throw new Error(`Unsupported file type in backup folder: ${entryPath}`);
            }
        }
    }

    return { directories, files, totalSize };
}

function assertMatchingManifests(expected, actual) {
    if (expected.totalSize !== actual.totalSize
        || expected.files.size !== actual.files.size
        || expected.directories.size !== actual.directories.size) {
        throw new Error('Source backup data changed during migration');
    }
    for (const [relativePath, expectedFile] of expected.files) {
        const actualFile = actual.files.get(relativePath);
        if (!actualFile || actualFile.size !== expectedFile.size
            || actualFile.sha256 !== expectedFile.sha256
            || !sameFingerprint(actualFile.fingerprint, expectedFile.fingerprint)) {
            throw new Error('Source backup data changed during migration');
        }
    }
    for (const [relativePath, expectedDirectory] of expected.directories) {
        const actualDirectory = actual.directories.get(relativePath);
        if (!actualDirectory
            || !sameFingerprint(actualDirectory.fingerprint, expectedDirectory.fingerprint)) {
            throw new Error('Source backup data changed during migration');
        }
    }
}

function assertMatchingContent(expected, actual) {
    if (expected.totalSize !== actual.totalSize
        || expected.files.size !== actual.files.size
        || expected.directories.size !== actual.directories.size) {
        throw new Error('The migration destination does not exactly match the source');
    }
    for (const [relativePath, expectedFile] of expected.files) {
        const actualFile = actual.files.get(relativePath);
        if (!actualFile
            || actualFile.size !== expectedFile.size
            || actualFile.sha256 !== expectedFile.sha256
            || (actualFile.fingerprint.mode & 0o777) !== (expectedFile.fingerprint.mode & 0o777)) {
            throw new Error('The migration destination does not exactly match the source');
        }
    }
    for (const [relativePath, expectedDirectory] of expected.directories) {
        const actualDirectory = actual.directories.get(relativePath);
        if (!actualDirectory
            || (actualDirectory.fingerprint.mode & 0o777) !== (expectedDirectory.fingerprint.mode & 0o777)) {
            throw new Error('The migration destination does not exactly match the source');
        }
    }
}

async function copyManifestToStaging(sourcePath, stagingPath, manifest, onProgress) {
    const directoryEntries = [...manifest.directories.entries()]
        .sort(([left], [right]) => left.split('/').length - right.split('/').length);
    for (const [relativeDirectory, directory] of directoryEntries) {
        if (!relativeDirectory) continue;
        const destinationDirectory = fromRelativeKey(stagingPath, relativeDirectory);
        await fsOriginal.promises.mkdir(destinationDirectory, {
            recursive: true,
            mode: directory.fingerprint.mode & 0o777
        });
    }

    for (const [relativeFile, descriptor] of manifest.files) {
        const sourceFile = fromRelativeKey(sourcePath, relativeFile);
        const destinationFile = fromRelativeKey(stagingPath, relativeFile);
        const currentSourceStats = await fsOriginal.promises.lstat(sourceFile);
        if (!currentSourceStats.isFile() || currentSourceStats.isSymbolicLink()
            || !sameFingerprint(statFingerprint(currentSourceStats), descriptor.fingerprint)) {
            throw new Error('Source backup data changed during migration');
        }

        await fsOriginal.promises.mkdir(path.dirname(destinationFile), { recursive: true });
        const copiedHash = createHash('sha256');
        let copiedSize = 0;
        const monitor = new Transform({
            transform(chunk, encoding, callback) {
                copiedSize += chunk.length;
                copiedHash.update(chunk);
                onProgress(chunk.length);
                callback(null, chunk);
            }
        });
        const flags = fsOriginal.constants.O_RDONLY | (fsOriginal.constants.O_NOFOLLOW || 0);
        await pipeline(
            fsOriginal.createReadStream(sourceFile, { flags }),
            monitor,
            fsOriginal.createWriteStream(destinationFile, {
                flags: 'wx',
                mode: descriptor.fingerprint.mode & 0o777
            })
        );
        const sourceAfterCopy = await fsOriginal.promises.lstat(sourceFile);
        if (!sourceAfterCopy.isFile() || sourceAfterCopy.isSymbolicLink()
            || !sameFingerprint(statFingerprint(sourceAfterCopy), descriptor.fingerprint)
            || copiedSize !== descriptor.size || copiedHash.digest('hex') !== descriptor.sha256) {
            throw new Error('Source backup data changed during migration');
        }
        const stagedDescriptor = await hashRegularFile(destinationFile);
        if (stagedDescriptor.size !== descriptor.size || stagedDescriptor.sha256 !== descriptor.sha256) {
            throw new Error('Backup migration verification failed');
        }
        await fsOriginal.promises.chmod(destinationFile, descriptor.fingerprint.mode & 0o777);
        await fsOriginal.promises.utimes(
            destinationFile,
            new Date(descriptor.atimeMs),
            new Date(descriptor.mtimeMs)
        );
    }

    for (const [relativeDirectory, directory] of [...directoryEntries].reverse()) {
        const destinationDirectory = fromRelativeKey(stagingPath, relativeDirectory);
        await fsOriginal.promises.chmod(destinationDirectory, directory.fingerprint.mode & 0o777);
        await fsOriginal.promises.utimes(
            destinationDirectory,
            new Date(directory.atimeMs),
            new Date(directory.mtimeMs)
        );
    }
}

async function inspectMigrationDestination(destinationPath, { allowNonEmpty = false } = {}) {
    const stats = await fsOriginal.promises.lstat(destinationPath).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
    });
    if (!stats) return null;
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error('The migration destination is not a regular directory');
    }
    const isEmpty = (await fsOriginal.promises.readdir(destinationPath)).length === 0;
    if (!isEmpty && !allowNonEmpty) {
        throw new Error('The migration destination must be empty');
    }
    return { fingerprint: statFingerprint(stats), isEmpty };
}

async function installStagedMigration(stagingPath, destinationPath, initialDestination) {
    const currentDestination = await inspectMigrationDestination(destinationPath);
    if (initialDestination) {
        if (!currentDestination
            || !sameFingerprint(currentDestination.fingerprint, initialDestination.fingerprint)) {
            throw new Error('The migration destination changed during migration');
        }
    } else {
        if (currentDestination) throw new Error('The migration destination appeared during migration');
        await fsOriginal.promises.mkdir(destinationPath, { mode: 0o700 });
    }

    const createdReservation = !initialDestination;
    if (process.platform === 'win32') {
        await fsOriginal.promises.rmdir(destinationPath);
    }
    try {
        await fsOriginal.promises.rename(stagingPath, destinationPath);
    } catch (error) {
        if (process.platform === 'win32' && initialDestination) {
            await fsOriginal.promises.mkdir(destinationPath, {
                mode: initialDestination.fingerprint.mode & 0o777
            }).catch(() => undefined);
        } else if (process.platform !== 'win32' && createdReservation) {
            const reservation = await inspectMigrationDestination(destinationPath).catch(() => null);
            if (reservation) await fsOriginal.promises.rmdir(destinationPath).catch(() => undefined);
        }
        throw error;
    }
}

async function performBackupMigration(sourceDir, destinationDir) {
    const sourcePath = normalizeAbsolutePath(sourceDir);
    const destinationPath = normalizeAbsolutePath(destinationDir);
    const normalizedSource = process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath;
    const normalizedDestination = process.platform === 'win32' ? destinationPath.toLowerCase() : destinationPath;
    if (normalizedSource === normalizedDestination
        || isPathInside(sourcePath, destinationPath)
        || isPathInside(destinationPath, sourcePath)
        || path.parse(sourcePath).root === sourcePath) {
        throw new Error('Backup migration paths must be separate, non-root directories');
    }

    const sourceStats = await fsOriginal.promises.lstat(sourcePath);
    if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
        throw new Error('The current backup path is not a regular directory');
    }
    await assertNoSymlinkAncestors(path.parse(sourcePath).root, sourcePath, fsOriginal);
    const destinationParent = path.dirname(destinationPath);
    await fsOriginal.promises.mkdir(destinationParent, { recursive: true, mode: 0o700 });
    await assertNoSymlinkAncestors(path.parse(destinationParent).root, destinationParent, fsOriginal);
    const destinationParentStats = await fsOriginal.promises.lstat(destinationParent);
    if (!destinationParentStats.isDirectory() || destinationParentStats.isSymbolicLink()) {
        throw new Error('The migration destination parent is not a regular directory');
    }
    const initialDestination = await inspectMigrationDestination(destinationPath, { allowNonEmpty: true });

    let movedSize = 0;
    let lastProgress = -1;
    const progressId = 'migrate-backups';
    const progressTitle = i18next.t('alert.migrate_backups');
    sendToMainWindow('update-progress', progressId, progressTitle, 'start');
    let stagingPath = null;

    try {
        const sourceManifest = await createSourceManifest(sourcePath);
        if (initialDestination && !initialDestination.isEmpty) {
            assertMatchingContent(sourceManifest, await createSourceManifest(destinationPath));
            lastProgress = 100;
            sendToMainWindow('update-progress', progressId, progressTitle, 100);
        } else {
            const stagingPrefix = `.${path.basename(destinationPath).slice(0, 80)}.ogs-migration-`;
            stagingPath = await fsOriginal.promises.mkdtemp(path.join(destinationParent, stagingPrefix));
            const stagingStats = await fsOriginal.promises.lstat(stagingPath);
            if (!stagingStats.isDirectory() || stagingStats.isSymbolicLink()) {
                throw new Error('Unable to create a safe migration staging directory');
            }
            await copyManifestToStaging(sourcePath, stagingPath, sourceManifest, (copiedBytes) => {
                movedSize += copiedBytes;
                const progressPercentage = sourceManifest.totalSize > 0
                    ? Math.min(100, Math.floor((movedSize / sourceManifest.totalSize) * 100))
                    : 100;
                if (progressPercentage !== lastProgress) {
                    lastProgress = progressPercentage;
                    sendToMainWindow('update-progress', progressId, progressTitle, progressPercentage);
                }
            });
            if (sourceManifest.totalSize === 0 && lastProgress !== 100) {
                lastProgress = 100;
                sendToMainWindow('update-progress', progressId, progressTitle, 100);
            }

            const verifiedSourceManifest = await createSourceManifest(sourcePath);
            assertMatchingManifests(sourceManifest, verifiedSourceManifest);
            await installStagedMigration(stagingPath, destinationPath, initialDestination);
            stagingPath = null;
        }

        assertMatchingManifests(sourceManifest, await createSourceManifest(sourcePath));
        assertMatchingContent(sourceManifest, await createSourceManifest(destinationPath));
        await saveSettings('backupPath', destinationPath);

        let cleanupError = null;
        try {
            const sourceBeforeCleanup = await createSourceManifest(sourcePath);
            assertMatchingManifests(sourceManifest, sourceBeforeCleanup);
            await fsOriginal.promises.rm(sourcePath, { recursive: true });
        } catch (error) {
            cleanupError = error;
            console.error('Backup migration succeeded, but the old backup folder could not be removed:', error);
        }
        sendToMainWindow('update-restore-table');
        if (cleanupError) {
            sendToMainWindow(
                'show-alert',
                'warning',
                i18next.t('alert.backup_migration_cleanup_warning', { path: sourcePath }),
                cleanupError.message
            );
        } else {
            sendToMainWindow('show-alert', 'success', i18next.t('alert.backup_migration_success'));
        }
        return true;
    } catch (error) {
        console.error('Backup migration failed:', error);
        sendToMainWindow('show-alert', 'modal', i18next.t('alert.error_during_backup_migration'), error.message);
        return false;
    } finally {
        if (stagingPath) {
            await fsOriginal.promises.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
        }
        sendToMainWindow('update-progress', progressId, progressTitle, 'end');
    }
}

async function moveFilesWithProgress(sourceDir, destinationDir) {
    if (getStatus().migrating) return false;
    let releaseOperation;
    try {
        releaseOperation = acquireGlobalOperation('migrate backups');
    } catch (_) {
        return false;
    }
    updateStatus('migrating', true);
    try {
        return await performBackupMigration(sourceDir, destinationDir);
    } catch (error) {
        console.error('Backup migration validation failed:', error);
        sendToMainWindow('show-alert', 'modal', i18next.t('alert.error_during_backup_migration'), error.message);
        return false;
    } finally {
        updateStatus('migrating', false);
        releaseOperation?.();
    }
}
module.exports = { moveFilesWithProgress };
