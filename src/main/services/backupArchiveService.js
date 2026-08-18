const { execFile } = require('child_process');
const { randomUUID } = require('crypto');
const fsOriginal = require('original-fs');
const os = require('os');
const path = require('path');

const fse = require('fs-extra');
const i18next = require('i18next');
const { format } = require('date-fns');
const Seven = require('node-7z');
const sevenBin = require('7zip-bin');

const { copyFolderAsync } = require('../fileSystemUtils');
const { acquireGlobalOperation } = require('../gameOperationLock');
const {
    normalizeAbsolutePath,
    normalizeBackupDate,
    normalizeBoundedInteger,
    normalizeWikiId,
    normalizeWikiIdArray,
    resolveInside,
    validateArchiveEntryPath,
    validateBackupMetadata
} = require('../validation');
const { getSettings } = require('./settingsService');
const { getStatus, updateStatus } = require('./statusService');
const { getMainWin } = require('./windowManager');

const MAX_ARCHIVE_ENTRIES = 100000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 20 * 1024 * 1024 * 1024;

function getSevenZipOptions() {
    return {
        yes: true,
        recursive: true,
        $bin: sevenBin.path7za.replace('app.asar', 'app.asar.unpacked'),
        $progress: true,
        $raw: []
    };
}

async function inspectImportArchive(gsmPath) {
    const archivePath = normalizeAbsolutePath(gsmPath);
    if (path.extname(archivePath).toLowerCase() !== '.gsmr') {
        throw new Error('Only .gsmr backup archives can be imported');
    }
    const archiveStats = await fsOriginal.promises.lstat(archivePath);
    if (!archiveStats.isFile() || archiveStats.isSymbolicLink() || archiveStats.size > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
        throw new Error('The selected import path is not a regular file');
    }

    const listStream = Seven.list(archivePath, {
        ...getSevenZipOptions(),
        techInfo: true,
        $progress: false
    });
    let entryCount = 0;
    let totalSize = 0;
    listStream.on('data', (entry) => {
        if (!entry?.file) return;
        validateArchiveEntryPath(entry.file);
        entryCount += 1;
        if (entryCount > MAX_ARCHIVE_ENTRIES) {
            listStream.destroy(new Error('Archive contains too many entries'));
            return;
        }

        const technicalInfo = entry.techInfo instanceof Map ? entry.techInfo : new Map();
        const attributes = String(entry.attributes || technicalInfo.get('Attributes') || '');
        if (/\bL\b|reparse|symbolic/i.test(attributes)
            || technicalInfo.has('Symbolic Link')
            || technicalInfo.has('Hard Link')) {
            listStream.destroy(new Error('Archive contains links, which are not allowed'));
            return;
        }
        const size = Number(entry.size ?? technicalInfo.get('Size') ?? 0);
        if (Number.isFinite(size) && size > 0) totalSize += size;
        if (totalSize > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
            listStream.destroy(new Error('Archive expands beyond the allowed size'));
        }
    });
    await new Promise((resolve, reject) => {
        listStream.once('end', resolve);
        listStream.once('error', reject);
    });
    if (entryCount === 0) throw new Error('Archive is empty');
    return archivePath;
}

async function collectExtractedBackups(extractRoot) {
    const pendingPaths = [extractRoot];
    let entryCount = 0;
    let totalSize = 0;
    while (pendingPaths.length > 0) {
        const currentPath = pendingPaths.pop();
        const entries = await fsOriginal.promises.readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            entryCount += 1;
            if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error('Extracted archive contains too many entries');
            const entryPath = resolveInside(extractRoot, path.relative(extractRoot, currentPath), entry.name);
            const stats = await fsOriginal.promises.lstat(entryPath);
            if (stats.isSymbolicLink()) throw new Error('Extracted archive contains a symbolic link');
            if (stats.isDirectory()) pendingPaths.push(entryPath);
            else if (stats.isFile()) {
                totalSize += stats.size;
                if (totalSize > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new Error('Extracted archive is too large');
            } else throw new Error('Extracted archive contains an unsupported file type');
        }
    }

    const backups = [];
    const gameEntries = await fsOriginal.promises.readdir(extractRoot, { withFileTypes: true });
    for (const gameEntry of gameEntries) {
        if (!gameEntry.isDirectory()) throw new Error('Archive root may only contain game folders');
        const gameId = normalizeWikiId(gameEntry.name);
        const gamePath = resolveInside(extractRoot, gameId);
        const backupEntries = await fsOriginal.promises.readdir(gamePath, { withFileTypes: true });
        for (const backupEntry of backupEntries) {
            if (!backupEntry.isDirectory()) throw new Error('Game folders may only contain backup folders');
            const backupDate = normalizeBackupDate(backupEntry.name);
            const backupPath = resolveInside(gamePath, backupDate);
            const metadataPath = resolveInside(backupPath, 'backup_info.json');
            const metadataStats = await fsOriginal.promises.lstat(metadataPath);
            if (!metadataStats.isFile() || metadataStats.isSymbolicLink() || metadataStats.size > 1024 * 1024) {
                throw new Error('Backup metadata is invalid');
            }
            const metadata = validateBackupMetadata(await fse.readJson(metadataPath));
            const allowedEntries = new Set(['backup_info.json', ...metadata.backup_paths.map(item => item.folder_name)]);
            const contentEntries = await fsOriginal.promises.readdir(backupPath, { withFileTypes: true });
            for (const contentEntry of contentEntries) {
                if (!allowedEntries.has(contentEntry.name)) throw new Error('Backup contains undeclared content');
            }
            for (const backupItem of metadata.backup_paths) {
                const itemPath = resolveInside(backupPath, backupItem.folder_name);
                const itemStats = await fsOriginal.promises.lstat(itemPath);
                if (!itemStats.isDirectory() || itemStats.isSymbolicLink()) {
                    throw new Error('Backup data folder is invalid');
                }
            }
            backups.push({ gameId, backupDate, sourcePath: backupPath });
        }
    }
    if (backups.length === 0) throw new Error('Archive does not contain any backups');
    return backups;
}

async function exportBackups(count, exportPath, wikiIds = null) {
    if (getStatus().exporting || getStatus().importing) return;
    let releaseOperation;
    try {
        releaseOperation = acquireGlobalOperation('export backups');
    } catch (_) {
        return;
    }
    updateStatus('exporting', true);
    const progressId = 'export';
    const progressTitle = i18next.t('alert.exporting');
    const sourcePath = getSettings().backupPath;
    let progressStarted = false;
    let finalDestPath = null;
    let archiveListDirectory = null;

    try {
        const sourceStats = await fsOriginal.promises.lstat(sourcePath);
        if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
            throw new Error('The backup source is not a regular directory');
        }
        const destinationDirectory = normalizeAbsolutePath(exportPath);
        const destinationStats = await fsOriginal.promises.lstat(destinationDirectory);
        if (!destinationStats.isDirectory() || destinationStats.isSymbolicLink()) {
            throw new Error('The export destination is not a regular directory');
        }
        const exportCount = normalizeBoundedInteger(count, 1, getSettings().maxBackups);
        const selectedWikiIds = wikiIds == null ? null : new Set(normalizeWikiIdArray(wikiIds));

        getMainWin().webContents.send('update-progress', progressId, progressTitle, 'start');
        progressStarted = true;

        const itemsToArchive = [];
        let gameFolders = (await fsOriginal.promises.readdir(sourcePath, { withFileTypes: true }))
            .filter(item => item.isDirectory())
            .map(item => item.name)
            .filter((gameId) => {
                try {
                    normalizeWikiId(gameId);
                    return true;
                } catch (_) {
                    return false;
                }
            });

        if (selectedWikiIds) gameFolders = gameFolders.filter(folder => selectedWikiIds.has(folder));

        for (const gameId of gameFolders) {
            const gameFolderPath = resolveInside(sourcePath, gameId);
            const backups = (await fsOriginal.promises.readdir(gameFolderPath, { withFileTypes: true }))
                .filter(item => item.isDirectory())
                .map(item => item.name)
                .filter((backupDate) => {
                    try {
                        normalizeBackupDate(backupDate);
                        return true;
                    } catch (_) {
                        return false;
                    }
                });

            const permanentBackups = [];
            const nonPermanentBackups = [];
            for (const backup of backups) {
                const infoPath = resolveInside(gameFolderPath, backup, 'backup_info.json');
                if (fsOriginal.existsSync(infoPath)) {
                    const infoStats = await fsOriginal.promises.lstat(infoPath);
                    if (!infoStats.isFile() || infoStats.isSymbolicLink() || infoStats.size > 1024 * 1024) {
                        throw new Error('Backup metadata is not a regular bounded file');
                    }
                    const info = validateBackupMetadata(await fse.readJson(infoPath));
                    if (info.is_permanent) {
                        permanentBackups.push(backup);
                        continue;
                    }
                }
                nonPermanentBackups.push(backup);
            }

            nonPermanentBackups.sort((a, b) => b.localeCompare(a));
            const selected = nonPermanentBackups.slice(0, exportCount);

            for (const backupFolder of [...permanentBackups, ...selected]) {
                itemsToArchive.push(path.join(gameId, backupFolder));
            }
        }
        if (itemsToArchive.length === 0) throw new Error('No backups matched the export selection');

        const timestamp = format(new Date(), 'yyyy-MM-dd_HH-mm-ss');
        const finalFileName = `GSMBackup-${timestamp}-${randomUUID().slice(0, 8)}.gsmr`;
        finalDestPath = resolveInside(destinationDirectory, finalFileName);
        archiveListDirectory = await fsOriginal.promises.mkdtemp(path.join(os.tmpdir(), 'GSMExportList-'));
        const archiveListPath = path.join(archiveListDirectory, 'files.txt');
        await fsOriginal.promises.writeFile(archiveListPath, itemsToArchive.join('\n'), { encoding: 'utf8', mode: 0o600 });
        await new Promise((resolve, reject) => {
            execFile(
                sevenBin.path7za.replace('app.asar', 'app.asar.unpacked'),
                ['a', finalDestPath, `@${archiveListPath}`, '-scsUTF-8', '-y', '-r', '-bso0', '-bsp0'],
                { cwd: sourcePath, windowsHide: true, timeout: 6 * 60 * 60 * 1000, maxBuffer: 1024 * 1024 },
                (error) => error ? reject(error) : resolve()
            );
        });

        getMainWin().webContents.send('show-alert', 'success', i18next.t('alert.export_success'));

    } catch (error) {
        if (finalDestPath) await fsOriginal.promises.rm(finalDestPath, { force: true }).catch(() => { });
        console.error(`An error occurred while exporting backups: ${error.message}`);
        getMainWin().webContents.send('show-alert', 'modal', i18next.t('alert.error_during_export'), error.message);
    } finally {
        if (archiveListDirectory) {
            await fsOriginal.promises.rm(archiveListDirectory, { recursive: true, force: true }).catch(() => { });
        }
        updateStatus('exporting', false);
        releaseOperation?.();
        if (progressStarted) getMainWin().webContents.send('update-progress', progressId, progressTitle, 'end');
    }
}

async function importBackups(gsmPath) {
    if (getStatus().importing || getStatus().exporting) return;
    let releaseOperation;
    try {
        releaseOperation = acquireGlobalOperation('import backups');
    } catch (_) {
        return;
    }
    updateStatus('importing', true);
    const progressId = 'import';
    const progressTitle = i18next.t('alert.importing');
    const destinationPath = getSettings().backupPath;
    let tempExtractPath = null;
    let progressStarted = false;

    try {
        const archivePath = await inspectImportArchive(gsmPath);
        await fsOriginal.promises.mkdir(destinationPath, { recursive: true });
        const destinationStats = await fsOriginal.promises.lstat(destinationPath);
        if (!destinationStats.isDirectory() || destinationStats.isSymbolicLink()) {
            throw new Error('The backup destination is not a regular directory');
        }
        getMainWin().webContents.send('update-progress', progressId, progressTitle, 'start');
        progressStarted = true;

        tempExtractPath = await fsOriginal.promises.mkdtemp(path.join(os.tmpdir(), 'GSMImportTemp-'));
        const extractStream = Seven.extractFull(archivePath, tempExtractPath, getSevenZipOptions());

        extractStream.on('progress', (progress) => {
            if (Number.isFinite(progress.percent)) {
                getMainWin().webContents.send('update-progress', progressId, progressTitle, Math.floor(progress.percent * 0.5));
            }
        });

        await new Promise((resolve, reject) => {
            extractStream.once('end', resolve);
            extractStream.once('error', reject);
        });

        const extractedBackups = await collectExtractedBackups(tempExtractPath);
        await fsOriginal.promises.mkdir(destinationPath, { recursive: true });
        let processedBackups = 0;
        for (const backup of extractedBackups) {
            const destGameFolder = resolveInside(destinationPath, backup.gameId);
            const destBackupPath = resolveInside(destGameFolder, backup.backupDate);
            await fsOriginal.promises.mkdir(destGameFolder, { recursive: true });
            const gameFolderStats = await fsOriginal.promises.lstat(destGameFolder);
            if (!gameFolderStats.isDirectory() || gameFolderStats.isSymbolicLink()) {
                throw new Error('Destination game folder is invalid');
            }
            const existingBackupStats = await fsOriginal.promises.lstat(destBackupPath).catch((error) => {
                if (error?.code === 'ENOENT') return null;
                throw error;
            });
            if (existingBackupStats && (!existingBackupStats.isDirectory() || existingBackupStats.isSymbolicLink())) {
                throw new Error('Destination backup path is invalid');
            }
            if (!existingBackupStats) {
                await copyFolderAsync(backup.sourcePath, destBackupPath, fsOriginal);
            }
            processedBackups += 1;
            const movingProgress = Math.floor((processedBackups / extractedBackups.length) * 50);
            getMainWin().webContents.send('update-progress', progressId, progressTitle, 50 + movingProgress);
        }

        getMainWin().webContents.send('show-alert', 'success', i18next.t('alert.import_success'));

    } catch (error) {
        console.error(`An error occurred while importing backups: ${error.message}`);
        getMainWin().webContents.send('show-alert', 'modal', i18next.t('alert.error_during_import'), error.message);
    } finally {
        if (tempExtractPath) {
            await fsOriginal.promises.rm(tempExtractPath, { recursive: true, force: true }).catch(() => { });
        }
        updateStatus('importing', false);
        releaseOperation?.();
        if (progressStarted) getMainWin().webContents.send('update-progress', progressId, progressTitle, 'end');
        getMainWin().webContents.send('update-backup-table');
        getMainWin().webContents.send('update-restore-table');
    }
}
module.exports = { exportBackups, importBackups };

