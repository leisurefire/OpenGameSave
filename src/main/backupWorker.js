const { parentPort } = require('worker_threads');
const { exec } = require('child_process');
const fs = require('fs');
const fsOriginal = fs;
const os = require('os');
const path = require('path');
const util = require('util');

const fse = require('fs-extra');
const glob = require('glob');
const { format, parse } = require('date-fns');
const sqlite3 = require('sqlite3');
const WinReg = require('winreg');

const execPromise = util.promisify(exec);

let context = null;

function settings() {
    return context.settings;
}

function gameData() {
    return context.gameData || {};
}

function allUserIds() {
    return context.allUserIds || {};
}

function getGameDisplayName(gameObj) {
    return settings().language === 'zh_CN' ? gameObj.zh_CN || gameObj.title : gameObj.title;
}

function calculateDirectorySize(directoryPath, ignoreConfig = true) {
    let totalSize = 0;

    try {
        const stats = fsOriginal.statSync(directoryPath);
        if (stats.isDirectory()) {
            const files = fsOriginal.readdirSync(directoryPath);
            files.forEach(file => {
                if (ignoreConfig && file === 'backup_info.json') return;
                const filePath = path.join(directoryPath, file);
                const fileStats = fsOriginal.statSync(filePath);
                if (fileStats.isDirectory()) {
                    totalSize += calculateDirectorySize(filePath, ignoreConfig);
                } else {
                    totalSize += fileStats.size;
                }
            });
        } else {
            totalSize += stats.size;
        }
    } catch (error) {
        console.error(`Error calculating directory size for ${directoryPath}:`, error);
    }

    return totalSize;
}

function ensureWritable(pathToCheck) {
    if (!fsOriginal.existsSync(pathToCheck)) return;

    const stats = fsOriginal.statSync(pathToCheck);
    if (stats.isDirectory()) {
        const items = fsOriginal.readdirSync(pathToCheck);
        for (const item of items) {
            ensureWritable(path.join(pathToCheck, item));
        }
    } else if (!(stats.mode & 0o200)) {
        fsOriginal.chmodSync(pathToCheck, 0o666);
    }
}

function fsOriginalCopyFolder(source, target) {
    fsOriginal.mkdirSync(target, { recursive: true });

    const items = fsOriginal.readdirSync(source);
    for (const item of items) {
        const sourcePath = path.join(source, item);
        const destinationPath = path.join(target, item);
        const stats = fsOriginal.statSync(sourcePath);

        if (stats.isDirectory()) {
            fsOriginalCopyFolder(sourcePath, destinationPath);
        } else {
            fsOriginal.copyFileSync(sourcePath, destinationPath);
        }
    }
}

function getNewestBackup(wikiPageId) {
    const backupDir = path.join(settings().backupPath, wikiPageId.toString());
    if (!fsOriginal.existsSync(backupDir)) {
        return context.labels.noBackups;
    }

    const backups = fsOriginal.readdirSync(backupDir).filter(file => {
        const fullPath = path.join(backupDir, file);
        return fsOriginal.statSync(fullPath).isDirectory();
    });

    if (backups.length === 0) {
        return context.labels.noBackups;
    }

    const latestBackup = backups.sort((a, b) => b.localeCompare(a))[0];
    return format(parse(latestBackup, 'yyyy-MM-dd_HH-mm', new Date()), 'yyyy/MM/dd HH:mm');
}

async function ensureDatabase() {
    const dbPath = context.dbPath;
    if (fs.existsSync(dbPath)) {
        return true;
    }

    if (!fs.existsSync(context.installedDbPath)) {
        return false;
    }

    await fse.ensureDir(path.dirname(dbPath));
    await fse.copy(context.installedDbPath, dbPath);
    return true;
}

function parseDbRow(row) {
    row.wiki_page_id = row.wiki_page_id.toString();
    row.platform = JSON.parse(row.platform);
    row.save_location = JSON.parse(row.save_location);
    row.latest_backup = getNewestBackup(row.wiki_page_id);
}

function findInstallPath(row, gameInstallPaths) {
    if (!row.install_folder) return false;

    for (const installPath of gameInstallPaths) {
        const potentialPath = path.join(installPath, row.install_folder);
        if (fsOriginal.existsSync(potentialPath)) {
            row.install_path = potentialPath;
            return true;
        }
    }
    return false;
}

async function processAndPushGame(row, games) {
    const processed = await processGame(row);
    if (processed.resolved_paths.length !== 0) {
        games.push(processed);
    }
}

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });
}

function dbPrepareAll(stmt, param) {
    return new Promise((resolve, reject) => {
        stmt.all(param, (err, rows) => err ? reject(err) : resolve(rows));
    });
}

function dbClose(db) {
    return new Promise((resolve, reject) => {
        db.close((err) => err ? reject(err) : resolve());
    });
}

function stmtFinalize(stmt) {
    return new Promise((resolve) => stmt.finalize(resolve));
}

async function getGameDataFromDB({ ignoreUninstalled = false, wikiId = null }) {
    const games = [];
    const errors = [];
    const dbReady = await ensureDatabase();
    if (!dbReady) {
        return { games, errors: [context.labels.missingDatabase] };
    }

    const db = new sqlite3.Database(context.dbPath, sqlite3.OPEN_READONLY);
    const gameInstallPaths = Array.isArray(settings().gameInstalls) ? settings().gameInstalls : [];

    if (wikiId) {
        try {
            const rows = await dbAll(db, 'SELECT * FROM games WHERE wiki_page_id = ?', [wikiId]);
            if (rows && rows.length > 0) {
                const row = rows[0];
                parseDbRow(row);
                const isInstalled = findInstallPath(row, gameInstallPaths);

                if (!isInstalled) {
                    if (ignoreUninstalled || !settings().saveUninstalledGames) {
                        return { games, errors };
                    }
                    const uninstalledWikiIds = (settings().uninstalledGames || []).map(String);
                    if (!uninstalledWikiIds.includes(row.wiki_page_id)) {
                        return { games, errors };
                    }
                }

                await processAndPushGame(row, games);
            }
        } catch (error) {
            console.error(`Error fetching single game data for ${wikiId}: ${error.stack}`);
            errors.push(`Error processing ${wikiId}: ${error.message}`);
        } finally {
            await dbClose(db);
        }
        return { games, errors };
    }

    const processedInstallPaths = new Set();
    let stmtInstallFolder;

    try {
        stmtInstallFolder = db.prepare('SELECT * FROM games WHERE install_folder = ?');

        for (const installPath of gameInstallPaths) {
            if (!fsOriginal.existsSync(installPath)) continue;
            const directories = fsOriginal.readdirSync(installPath, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory())
                .map(dirent => dirent.name);

            for (const dir of directories) {
                if (processedInstallPaths.has(dir)) continue;
                processedInstallPaths.add(dir);

                const rows = await dbPrepareAll(stmtInstallFolder, dir);
                if (rows && rows.length > 0) {
                    for (const row of rows) {
                        try {
                            parseDbRow(row);
                            row.install_path = path.join(installPath, dir);
                            await processAndPushGame(row, games);
                        } catch (err) {
                            console.error(`Error processing installed game ${getGameDisplayName(row)}: ${err.stack}`);
                            errors.push(`Error processing ${getGameDisplayName(row)}: ${err.message}`);
                        }
                    }
                }
            }
        }

        await stmtFinalize(stmtInstallFolder);
        stmtInstallFolder = null;

        if (!ignoreUninstalled && settings().saveUninstalledGames) {
            const uninstalledWikiIds = settings().uninstalledGames || [];
            const processedWikiIds = new Set(games.map(game => game.wiki_page_id));
            const remainingUninstalledWikiIds = uninstalledWikiIds.filter(id => !processedWikiIds.has(id));

            for (const remainingWikiId of remainingUninstalledWikiIds) {
                const rows = await dbAll(db, 'SELECT * FROM games WHERE wiki_page_id = ?', [remainingWikiId]);
                if (rows && rows.length > 0) {
                    for (const row of rows) {
                        try {
                            parseDbRow(row);
                            await processAndPushGame(row, games);
                        } catch (err) {
                            console.error(`Error processing uninstalled game ${getGameDisplayName(row)}: ${err.stack}`);
                            errors.push(`Error processing ${getGameDisplayName(row)}: ${err.message}`);
                        }
                    }
                }
            }

            return { games, errors, remainingUninstalledWikiIds };
        }
    } catch (error) {
        console.error(`Error displaying backup table: ${error.stack}`);
        errors.push(`Error displaying backup table: ${error.message}`);
        if (stmtInstallFolder) {
            stmtInstallFolder.finalize();
        }
    } finally {
        await dbClose(db);
    }

    return { games, errors };
}

async function getAllGameDataFromDB() {
    const games = [];
    const errors = [];
    const dbReady = await ensureDatabase();
    if (!dbReady) {
        return { games, errors: [context.labels.missingDatabase] };
    }

    const db = new sqlite3.Database(context.dbPath, sqlite3.OPEN_READONLY);

    try {
        const rows = await dbAll(db, 'SELECT * FROM games');
        const totalRows = rows.length;
        let processedRows = 0;

        for (const row of rows) {
            try {
                parseDbRow(row);
                await processAndPushGame(row, games);
            } catch (err) {
                console.error(`Error processing database game ${getGameDisplayName(row)}: ${err.stack}`);
                errors.push(`Error processing ${getGameDisplayName(row)}: ${err.message}`);
            }

            processedRows += 1;
            const dbProgress = totalRows ? Math.floor((processedRows / totalRows) * 95) : 95;
            parentPort.postMessage({ type: 'progress', value: dbProgress });
        }

        parentPort.postMessage({ type: 'progress', value: 100 });
    } catch (error) {
        console.error(`Error displaying backup table: ${error.stack}`);
        errors.push(`Error displaying backup table: ${error.message}`);
    } finally {
        await dbClose(db);
    }

    return { games, errors };
}

async function processGame(dbGameRow) {
    const resolvedPaths = [];
    let totalBackupSize = 0;
    const osKey = context.osKeyMap[os.platform()];

    if (osKey && dbGameRow.save_location[osKey]) {
        for (const templatedPath of dbGameRow.save_location[osKey]) {
            const resolvedPathObjs = await resolveTemplatedBackupPath(templatedPath, dbGameRow.install_path, false);

            for (const resolvedPathObj of resolvedPathObjs) {
                if (fsOriginal.existsSync(resolvedPathObj.resolved)) {
                    const backupSize = calculateDirectorySize(resolvedPathObj.resolved);
                    if (backupSize > 0) {
                        totalBackupSize += backupSize;
                        resolvedPaths.push(resolvedPathObj);
                    }
                }
            }
        }
    }

    if (osKey === 'win' && dbGameRow.save_location.reg && dbGameRow.save_location.reg.length > 0) {
        for (const templatedPath of dbGameRow.save_location.reg) {
            const resolvedPathObjs = await resolveTemplatedBackupPath(templatedPath, null, true);

            for (const resolvedPathObj of resolvedPathObjs) {
                const normalizedRegPath = path.normalize(resolvedPathObj.resolved);
                const { hive, key } = parseRegistryPath(normalizedRegPath);
                const winRegHive = getWinRegHive(hive);
                if (!winRegHive) continue;

                const registryKey = new WinReg({ hive: winRegHive, key });
                await new Promise((resolve, reject) => {
                    registryKey.keyExists((err, exists) => {
                        if (err) return reject(err);
                        if (exists) {
                            resolvedPaths.push({
                                template: resolvedPathObj.template,
                                finalTemplate: resolvedPathObj.finalTemplate,
                                resolved: normalizedRegPath,
                                type: 'reg'
                            });
                        }
                        resolve();
                    });
                });
            }
        }
    }

    dbGameRow.resolved_paths = resolvedPaths;
    dbGameRow.backup_size = totalBackupSize;
    return dbGameRow;
}

function getWinRegHive(hive) {
    switch (hive) {
        case 'HKEY_CURRENT_USER': return WinReg.HKCU;
        case 'HKEY_LOCAL_MACHINE': return WinReg.HKLM;
        case 'HKEY_CLASSES_ROOT': return WinReg.HKCR;
        default: return null;
    }
}

function parseRegistryPath(registryPath) {
    const parts = registryPath.split('\\');
    const hive = parts.shift();
    const key = '\\' + parts.join('\\');
    return { hive, key };
}

async function resolveTemplatedBackupPath(templatedPath, gameInstallPath, isRegistry = false) {
    const placeholderMappings = {};
    let basePath = templatedPath.replace(/\{\{p\|[^\}]+\}\}/gi, match => {
        const normalizedMatch = match.toLowerCase().replace(/\\/g, '/');
        let replacement = normalizedMatch;

        if (normalizedMatch === '{{p|game}}') {
            replacement = gameInstallPath;
        } else if (normalizedMatch === '{{p|steam}}') {
            replacement = gameData().steamPath;
        } else if (normalizedMatch === '{{p|uplay}}' || normalizedMatch === '{{p|ubisoftconnect}}') {
            replacement = gameData().ubisoftPath;
        } else if (normalizedMatch === '{{p|uid}}') {
            return '{{p|uid}}';
        } else if (normalizedMatch === '{{p|xbox_uid}}') {
            return '{{p|xbox_uid}}';
        } else if (context.placeholderMapping[normalizedMatch]) {
            replacement = context.placeholderMapping[normalizedMatch];
        }

        if (replacement !== normalizedMatch) {
            placeholderMappings[normalizedMatch] = replacement;
        }
        return replacement;
    });

    const withoutUidPlaceholders = basePath.toLowerCase()
        .replace(/\{\{p\|uid\}\}/gi, '')
        .replace(/\{\{p\|xbox_uid\}\}/gi, '');
    if (/\{\{p\|[^\}]+\}\}/i.test(withoutUidPlaceholders)) {
        return [];
    }

    if (isRegistry) {
        return [{ template: templatedPath, finalTemplate: basePath, resolved: basePath }];
    }

    return await fillPathUid(templatedPath, basePath, placeholderMappings);
}

async function fillPathUid(templatedPath, basePath, placeholderMappings) {
    function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function createFinalTemplate(resolvedPath) {
        let finalTemplate = resolvedPath.replace(/\\/g, '/');
        const sortedMappings = Object.entries(placeholderMappings)
            .sort((a, b) => b[1].length - a[1].length);

        for (const [placeholder, resolvedValue] of sortedMappings) {
            const normalizedValue = resolvedValue.replace(/\\/g, '/');
            const regex = new RegExp(escapeRegExp(normalizedValue), 'gi');
            finalTemplate = finalTemplate.replace(regex, placeholder);
        }
        return finalTemplate;
    }

    function generateUidCombinations(count, uidValues) {
        if (count === 0) return [[]];
        if (count === 1) return uidValues.map(uid => [uid]);

        const smaller = generateUidCombinations(count - 1, uidValues);
        const result = [];
        for (const combo of smaller) {
            for (const uid of uidValues) {
                result.push([...combo, uid]);
            }
        }
        return result;
    }

    function tryGlobAndReturnPaths(testPath) {
        const files = glob.sync(testPath.replace(/\\/g, '/'));
        if (files.length === 0) return null;
        return files
            .filter(filePath => fsOriginal.existsSync(filePath))
            .map(filePath => ({
                template: templatedPath,
                finalTemplate: createFinalTemplate(filePath),
                resolved: filePath
            }));
    }

    if (!basePath.includes('{{p|uid}}') && !basePath.includes('{{p|xbox_uid}}')) {
        const pathParts = path.parse(basePath);
        if (pathParts.base.includes('*')) {
            const subdirectoryPath = path.join(pathParts.dir, '*', pathParts.base);
            const subDirFiles = tryGlobAndReturnPaths(subdirectoryPath);
            if (subDirFiles && subDirFiles.length > 0) {
                return subDirFiles;
            }
        }
        return tryGlobAndReturnPaths(basePath) || [];
    }

    if (settings().backupAllAccounts) {
        const wildcardPath = basePath
            .replace(/\{\{p\|uid\}\}/gi, '*')
            .replace(/\{\{p\|xbox_uid\}\}/gi, '*');
        return tryGlobAndReturnPaths(wildcardPath) || [];
    }

    const applyContextReplacement = (pathStr, fullPattern, uidValue, placeholderName = 'uid') => {
        if (!fullPattern || !uidValue) return pathStr;
        const normalizedPattern = fullPattern.replace(/\\/g, '/');
        const normalizedPath = pathStr.replace(/\\/g, '/');
        const regex = new RegExp(escapeRegExp(normalizedPattern), 'gi');
        const placeholderRegex = new RegExp(`\\{\\{p\\|${placeholderName}\\}\\}`, 'gi');
        const replacement = normalizedPattern.replace(placeholderRegex, uidValue);
        return normalizedPath.replace(regex, replacement);
    };

    let contextAwarePath = basePath;
    contextAwarePath = applyContextReplacement(contextAwarePath, `${gameData().steamPath}/userdata/{{p|uid}}`, gameData().currentSteamUserId3);
    contextAwarePath = applyContextReplacement(contextAwarePath, `${gameData().ubisoftPath}/savegames/{{p|uid}}`, gameData().currentUbisoftUserId);

    if (!contextAwarePath.includes('{{p|uid}}') && !contextAwarePath.includes('{{p|xbox_uid}}')) {
        return tryGlobAndReturnPaths(contextAwarePath) || [];
    }

    const uidMatches = contextAwarePath.match(/\{\{p\|uid\}\}/gi);
    const xboxUidMatches = contextAwarePath.match(/\{\{p\|xbox_uid\}\}/gi);
    const uidCount = (uidMatches ? uidMatches.length : 0) + (xboxUidMatches ? xboxUidMatches.length : 0);
    if (uidCount === 0) return [];

    const uidValues = Object.values(allUserIds()).filter(uid => uid && uid !== 'N/A');
    const uidCombinations = generateUidCombinations(uidCount, uidValues);

    for (const uidCombo of uidCombinations) {
        let testPath = contextAwarePath;
        let uidIndex = 0;
        testPath = testPath.replace(/\{\{p\|uid\}\}/gi, () => uidCombo[uidIndex++]);
        testPath = testPath.replace(/\{\{p\|xbox_uid\}\}/gi, () => uidCombo[uidIndex++]);

        const result = tryGlobAndReturnPaths(testPath);
        if (result) return result;
    }

    const wildcardPath = basePath
        .replace(/\{\{p\|uid\}\}/gi, '*')
        .replace(/\{\{p\|xbox_uid\}\}/gi, '*');
    const wildcardResolvedPaths = glob.sync(wildcardPath.replace(/\\/g, '/'));
    if (wildcardResolvedPaths.length === 0) return [];

    const latestPath = await findLatestModifiedPath(wildcardResolvedPaths);
    return [{
        template: templatedPath,
        finalTemplate: createFinalTemplate(latestPath),
        resolved: latestPath
    }];
}

async function findLatestModifiedPath(paths) {
    let latestPath = null;
    let latestTime = 0;

    for (const filePath of paths) {
        const stats = fsOriginal.statSync(filePath);
        if (stats.mtimeMs > latestTime) {
            latestTime = stats.mtimeMs;
            latestPath = filePath;
        }
    }

    return latestPath;
}

async function backupGame(gameObj) {
    const gameBackupPath = path.join(settings().backupPath, gameObj.wiki_page_id.toString());
    const backupInstanceFolder = format(new Date(), 'yyyy-MM-dd_HH-mm');
    const backupInstancePath = path.join(gameBackupPath, backupInstanceFolder);

    try {
        const backupConfig = {
            title: gameObj.title,
            zh_CN: gameObj.zh_CN || null,
            backup_paths: []
        };

        for (const [index, resolvedPathObj] of gameObj.resolved_paths.entries()) {
            const resolvedPath = path.normalize(resolvedPathObj.resolved);
            const pathFolderName = `path${index + 1}`;
            const targetPath = path.join(backupInstancePath, pathFolderName);
            fsOriginal.mkdirSync(targetPath, { recursive: true });

            if (resolvedPathObj.type === 'reg') {
                const registryFilePath = path.join(targetPath, 'registry_backup.reg');
                await execPromise(`reg export "${resolvedPath}" "${registryFilePath}" /y`);
                backupConfig.backup_paths.push({
                    folder_name: pathFolderName,
                    template: resolvedPathObj.finalTemplate,
                    type: 'reg',
                    install_folder: gameObj.install_folder || null
                });
            } else {
                ensureWritable(resolvedPath);
                const stats = fsOriginal.statSync(resolvedPath);
                let dataType;

                if (stats.isDirectory()) {
                    dataType = 'folder';
                    fsOriginalCopyFolder(resolvedPath, targetPath);
                } else {
                    dataType = 'file';
                    const targetFilePath = path.join(targetPath, path.basename(resolvedPath));
                    fsOriginal.copyFileSync(resolvedPath, targetFilePath);
                }

                backupConfig.backup_paths.push({
                    folder_name: pathFolderName,
                    template: resolvedPathObj.finalTemplate,
                    type: dataType,
                    install_folder: gameObj.install_folder || null
                });
            }
        }

        await fse.writeJson(path.join(backupInstancePath, 'backup_info.json'), backupConfig, { spaces: 4 });

        const nonPermanentBackups = [];
        for (const backup of fsOriginal.readdirSync(gameBackupPath).sort((a, b) => a.localeCompare(b))) {
            const backupConfigPath = path.join(gameBackupPath, backup, 'backup_info.json');
            if (fsOriginal.existsSync(backupConfigPath)) {
                const existingConfig = await fse.readJson(backupConfigPath);
                if (!existingConfig.is_permanent) {
                    nonPermanentBackups.push(backup);
                }
            } else {
                nonPermanentBackups.push(backup);
            }
        }

        const maxBackups = settings().maxBackups;
        if (nonPermanentBackups.length > maxBackups) {
            const backupsToDelete = nonPermanentBackups.slice(0, nonPermanentBackups.length - maxBackups);
            for (const backup of backupsToDelete) {
                fsOriginal.rmSync(path.join(gameBackupPath, backup), { recursive: true, force: true });
            }
        }
    } catch (error) {
        console.error(`Error during backup for game ${getGameDisplayName(gameObj)}: ${error.stack}`);
        return `Error during backup for ${getGameDisplayName(gameObj)}: ${error.message}`;
    }

    return null;
}

parentPort.on('message', async (message) => {
    context = message.context;

    try {
        let result;
        if (message.task === 'getGameDataFromDB') {
            result = await getGameDataFromDB(message.payload || {});
        } else if (message.task === 'getAllGameDataFromDB') {
            result = await getAllGameDataFromDB();
        } else if (message.task === 'backupGame') {
            result = await backupGame(message.payload.gameObj);
        } else {
            throw new Error(`Unknown backup worker task: ${message.task}`);
        }

        parentPort.postMessage({ type: 'done', result });
    } catch (error) {
        parentPort.postMessage({
            type: 'error',
            error: {
                message: error.message || String(error),
                stack: error.stack || ''
            }
        });
    }
});
