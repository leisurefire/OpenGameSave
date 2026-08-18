const fsOriginal = require('original-fs');
const os = require('os');
const path = require('path');

const { getGameDataFromDB } = require('../backup');
const { getGameData } = require('../gameData');
const { getSettings } = require('../global');
const {
    assertNoSymlinkAncestors,
    isPathInside,
    normalizeBackupDate,
    normalizeRegistryKeyPath,
    normalizeWikiId,
    resolveInside
} = require('../validation');

function getValidatedBackupPath(wikiId, backupDate = null) {
    const backupRoot = path.resolve(getSettings().backupPath);
    const safeWikiId = normalizeWikiId(wikiId);
    return backupDate === null
        ? resolveInside(backupRoot, safeWikiId)
        : resolveInside(backupRoot, safeWikiId, normalizeBackupDate(backupDate));
}

async function getVerifiedBackupPath(wikiId, backupDate = null) {
    const backupRoot = path.resolve(getSettings().backupPath);
    const gamePath = getValidatedBackupPath(wikiId);
    const targetPath = backupDate === null ? gamePath : getValidatedBackupPath(wikiId, backupDate);
    const pathsToVerify = backupDate === null
        ? [backupRoot, gamePath]
        : [backupRoot, gamePath, targetPath];

    for (const candidatePath of pathsToVerify) {
        const stats = await fsOriginal.promises.lstat(candidatePath);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new Error('Backup path is not a regular directory');
        }
    }
    return targetPath;
}

function getAllowedLocalSaveRoots() {
    const currentGameData = getGameData();
    const configuredInstallPaths = Array.isArray(getSettings().gameInstalls) ? getSettings().gameInstalls : [];
    const systemDrive = process.env.SystemDrive
        || path.parse(process.env.WINDIR || 'C:\\Windows').root.replace(/[\\/]$/, '')
        || 'C:';
    const xboxPgsRoot = path.join(systemDrive, 'XboxGames', 'GameSave', 'pgs');

    return [
        os.homedir(),
        process.env.APPDATA,
        process.env.LOCALAPPDATA,
        process.env.PROGRAMDATA,
        process.env.PUBLIC,
        currentGameData.steamPath,
        currentGameData.ubisoftPath,
        xboxPgsRoot,
        ...configuredInstallPaths
    ].filter(root => typeof root === 'string' && path.isAbsolute(root));
}

async function getVerifiedLocalSavePaths(wikiId, selectedIndexes = null) {
    const safeWikiId = normalizeWikiId(wikiId);
    const { games } = await getGameDataFromDB(false, safeWikiId);
    const resolvedPaths = games?.[0]?.resolved_paths || [];
    const selectedPaths = !Array.isArray(selectedIndexes)
        ? resolvedPaths
        : selectedIndexes
            .map(Number)
            .filter(index => Number.isInteger(index) && index >= 0 && index < resolvedPaths.length)
            .map(index => resolvedPaths[index]);
    const allowedRoots = getAllowedLocalSaveRoots();
    const comparePath = value => process.platform === 'win32'
        ? path.resolve(value).toLowerCase()
        : path.resolve(value);
    const verifiedPaths = [];

    for (const pathObject of selectedPaths) {
        if (pathObject?.type === 'reg') {
            verifiedPaths.push({ ...pathObject, resolved: normalizeRegistryKeyPath(pathObject.resolved) });
            continue;
        }

        const resolvedPath = typeof pathObject?.resolved === 'string' && path.isAbsolute(pathObject.resolved)
            ? path.resolve(pathObject.resolved)
            : null;
        const allowedRoot = resolvedPath
            ? allowedRoots
                .filter(root => isPathInside(root, resolvedPath) && comparePath(root) !== comparePath(resolvedPath))
                .sort((left, right) => right.length - left.length)[0]
            : null;
        if (!allowedRoot) throw new Error('Local save path is outside the allowed roots');
        await assertNoSymlinkAncestors(allowedRoot, resolvedPath, fsOriginal);
        verifiedPaths.push({ ...pathObject, resolved: resolvedPath });
    }

    return verifiedPaths;
}

module.exports = {
    getValidatedBackupPath,
    getVerifiedBackupPath,
    getVerifiedLocalSavePaths
};
