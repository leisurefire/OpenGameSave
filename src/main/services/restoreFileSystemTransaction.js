const path = require('path');
const { randomUUID } = require('crypto');

const fsOriginal = require('fs');

const { copyFolderAsync } = require('../fileSystemUtils');
const { isForbiddenRestorePayloadPath } = require('../restoreAuthorization');
const { assertNoSymlinkAncestors, isPathInside } = require('../validation');

function isStrictlyInside(rootPath, targetPath) {
    return path.resolve(rootPath) !== path.resolve(targetPath) && isPathInside(rootPath, targetPath);
}

async function lstatIfPresent(targetPath, fsAdapter) {
    try {
        return await fsAdapter.promises.lstat(targetPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function assertIndependentDestinations(items) {
    const sorted = items
        .map(item => path.resolve(item.destinationPath))
        .sort((left, right) => left.length - right.length);
    for (let index = 0; index < sorted.length; index += 1) {
        for (let otherIndex = index + 1; otherIndex < sorted.length; otherIndex += 1) {
            if (isPathInside(sorted[index], sorted[otherIndex])) {
                throw new Error('Restore destinations overlap');
            }
        }
    }
}

async function validateSource(item, backupRoot, fsAdapter) {
    const sourcePath = path.resolve(item.sourcePath);
    if (!isStrictlyInside(backupRoot, sourcePath)) {
        throw new Error('Restore source escapes the backup root');
    }
    await assertNoSymlinkAncestors(backupRoot, sourcePath, fsAdapter);
    const sourceStats = await fsAdapter.promises.lstat(sourcePath);
    if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
        throw new Error('Restore source is not a regular directory');
    }
    return sourcePath;
}

async function validateDestination(item, fsAdapter) {
    const allowedRoot = path.resolve(item.allowedRoot);
    const destinationPath = path.resolve(item.destinationPath);
    if (!path.isAbsolute(item.allowedRoot) || !path.isAbsolute(item.destinationPath)
        || !isStrictlyInside(allowedRoot, destinationPath)) {
        throw new Error('Restore destination escapes its authorized root');
    }
    const rootStats = await fsAdapter.promises.lstat(allowedRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new Error('Restore root is not a regular directory');
    }
    await assertNoSymlinkAncestors(allowedRoot, destinationPath, fsAdapter);
    return { allowedRoot, destinationPath };
}

async function stageReplacement(item, index, transactionRoot, sourcePath, fsAdapter) {
    const replacementPath = path.join(transactionRoot, `replacement-${index}`);
    if (item.backupType === 'folder') {
        await copyFolderAsync(sourcePath, replacementPath, fsAdapter);
        if (item.untrusted) await assertSafeExternalPayload(replacementPath, fsAdapter);
        return replacementPath;
    }
    if (item.backupType !== 'file') throw new Error('Unsupported filesystem backup type');

    const expectedName = path.basename(item.destinationPath);
    if (item.untrusted && isForbiddenRestorePayloadPath(expectedName, process.platform === 'win32' ? 'win32' : 'posix')) {
        throw new Error('External backup contains an executable or script payload');
    }
    const entries = await fsAdapter.promises.readdir(sourcePath, { withFileTypes: true });
    if (entries.length !== 1 || entries[0].name !== expectedName
        || !entries[0].isFile() || entries[0].isSymbolicLink()) {
        throw new Error('File backup payload does not match its authorized destination');
    }
    await fsAdapter.promises.copyFile(path.join(sourcePath, expectedName), replacementPath);
    return replacementPath;
}

async function assertSafeExternalPayload(rootPath, fsAdapter) {
    const pathFlavor = process.platform === 'win32' ? 'win32' : 'posix';
    const pendingDirectories = [rootPath];
    while (pendingDirectories.length > 0) {
        const currentPath = pendingDirectories.pop();
        const entries = await fsAdapter.promises.readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(currentPath, entry.name);
            if (entry.isSymbolicLink()) throw new Error('External backup contains a symbolic link');
            if (entry.isDirectory()) {
                pendingDirectories.push(entryPath);
            } else if (!entry.isFile()) {
                throw new Error('External backup contains an unsupported file type');
            } else if (isForbiddenRestorePayloadPath(path.relative(rootPath, entryPath), pathFlavor)) {
                throw new Error('External backup contains an executable or script payload');
            }
        }
    }
}

async function removeEmptyParents(startPath, stopPath, fsAdapter) {
    let currentPath = path.resolve(startPath);
    const resolvedStop = path.resolve(stopPath);
    while (currentPath !== resolvedStop && isStrictlyInside(resolvedStop, currentPath)) {
        try {
            await fsAdapter.promises.rmdir(currentPath);
        } catch (_) {
            break;
        }
        currentPath = path.dirname(currentPath);
    }
}

async function restoreFileSystemPathsTransactionally(items, {
    backupRoot,
    fsAdapter = fsOriginal,
    idFactory = randomUUID
} = {}) {
    if (!Array.isArray(items) || items.length === 0) return;
    const resolvedBackupRoot = path.resolve(backupRoot);
    const backupRootStats = await fsAdapter.promises.lstat(resolvedBackupRoot);
    if (!backupRootStats.isDirectory() || backupRootStats.isSymbolicLink()) {
        throw new Error('Backup root is not a regular directory');
    }
    assertIndependentDestinations(items);

    const transactionRoots = new Map();
    const staged = [];
    const committed = [];
    let preserveRecoveryData = false;

    try {
        for (const [index, item] of items.entries()) {
            const sourcePath = await validateSource(item, resolvedBackupRoot, fsAdapter);
            const { allowedRoot, destinationPath } = await validateDestination(item, fsAdapter);
            let transactionRoot = transactionRoots.get(allowedRoot);
            if (!transactionRoot) {
                transactionRoot = path.join(allowedRoot, `.ogs-restore-${idFactory()}`);
                await fsAdapter.promises.mkdir(transactionRoot, { recursive: false, mode: 0o700 });
                const transactionStats = await fsAdapter.promises.lstat(transactionRoot);
                if (!transactionStats.isDirectory() || transactionStats.isSymbolicLink()) {
                    throw new Error('Restore staging path is not a regular directory');
                }
                transactionRoots.set(allowedRoot, transactionRoot);
            }
            const replacementPath = await stageReplacement(
                { ...item, destinationPath }, index, transactionRoot, sourcePath, fsAdapter
            );
            staged.push({ ...item, allowedRoot, destinationPath, replacementPath, transactionRoot, index });
        }

        for (const item of staged) {
            await assertNoSymlinkAncestors(item.allowedRoot, item.destinationPath, fsAdapter);
            const parentPath = path.dirname(item.destinationPath);
            const parentExisted = Boolean(await lstatIfPresent(parentPath, fsAdapter));
            await fsAdapter.promises.mkdir(parentPath, { recursive: true });
            await assertNoSymlinkAncestors(item.allowedRoot, item.destinationPath, fsAdapter);

            const previousStats = await lstatIfPresent(item.destinationPath, fsAdapter);
            if (previousStats?.isSymbolicLink()) throw new Error('Restore destination is a symbolic link');
            const previousPath = path.join(item.transactionRoot, `previous-${item.index}`);
            const commitRecord = {
                ...item,
                parentPath,
                parentExisted,
                previousPath,
                previousMoved: false,
                replacementActivated: false
            };
            committed.push(commitRecord);
            if (previousStats) {
                await fsAdapter.promises.rename(item.destinationPath, previousPath);
                commitRecord.previousMoved = true;
            }
            await fsAdapter.promises.rename(item.replacementPath, item.destinationPath);
            commitRecord.replacementActivated = true;
        }
    } catch (error) {
        const rollbackErrors = [];
        for (const item of [...committed].reverse()) {
            try {
                if (item.replacementActivated) {
                    await fsAdapter.promises.rm(item.destinationPath, { recursive: true, force: true });
                }
                if (item.previousMoved) {
                    await fsAdapter.promises.rename(item.previousPath, item.destinationPath);
                } else if (!item.parentExisted) {
                    await removeEmptyParents(item.parentPath, item.allowedRoot, fsAdapter);
                }
            } catch (rollbackError) {
                rollbackErrors.push(rollbackError);
            }
        }
        if (rollbackErrors.length > 0) {
            preserveRecoveryData = true;
            throw new AggregateError([error, ...rollbackErrors], 'Restore failed and rollback was incomplete');
        }
        throw error;
    } finally {
        if (!preserveRecoveryData) {
            await Promise.all([...transactionRoots.values()].map(transactionRoot =>
                fsAdapter.promises.rm(transactionRoot, { recursive: true, force: true })
            ));
        }
    }
}

module.exports = { restoreFileSystemPathsTransactionally };
