const fsOriginal = require('fs');
const path = require('path');

const WinReg = require('winreg');

const { calculateDirectorySize } = require('../fileSystemUtils');
const {
    getWinRegHive,
    parseRegistryPath,
    resolveTemplatedBackupPath
} = require('./backupWorkerPathResolver');
const { getPlatformSaveLocations, getSavePlatformKey } = require('./platformService');

async function resolveFileSaveLocations(dbGameRow, resolvedPaths) {
    let totalBackupSize = 0;
    const platformSaveLocations = getPlatformSaveLocations(dbGameRow.save_location);

    for (const templatedPath of platformSaveLocations) {
        const resolvedPathObjs = await resolveTemplatedBackupPath(templatedPath, dbGameRow.install_path, false);

        for (const resolvedPathObj of resolvedPathObjs) {
            if (!fsOriginal.existsSync(resolvedPathObj.resolved)) continue;

            const backupSize = calculateDirectorySize(resolvedPathObj.resolved);
            if (backupSize > 0) {
                totalBackupSize += backupSize;
                resolvedPaths.push(resolvedPathObj);
            }
        }
    }
    return totalBackupSize;
}

async function resolveRegistrySaveLocations(dbGameRow, resolvedPaths) {
    const registrySaveLocations = Array.isArray(dbGameRow.save_location?.reg)
        ? dbGameRow.save_location.reg
        : [];
    if (getSavePlatformKey() !== 'win' || registrySaveLocations.length === 0) return;

    for (const templatedPath of registrySaveLocations) {
        const resolvedPathObjs = await resolveTemplatedBackupPath(templatedPath, null, true);

        for (const resolvedPathObj of resolvedPathObjs) {
            const normalizedRegPath = path.normalize(resolvedPathObj.resolved);
            const { hive, key } = parseRegistryPath(normalizedRegPath);
            const winRegHive = getWinRegHive(hive);
            if (!winRegHive) continue;

            const registryKey = new WinReg({ hive: winRegHive, key });
            const exists = await new Promise((resolve, reject) => {
                registryKey.keyExists((error, keyExists) => {
                    if (error) reject(error);
                    else resolve(keyExists);
                });
            });
            if (exists) {
                resolvedPaths.push({
                    template: resolvedPathObj.template,
                    finalTemplate: resolvedPathObj.finalTemplate,
                    resolved: normalizedRegPath,
                    type: 'reg'
                });
            }
        }
    }
}

/**
 * Resolve all existing, non-empty save locations for one database game row.
 *
 * @param {*} dbGameRow
 * @returns {Promise<*>}
 */
async function processGame(dbGameRow) {
    const resolvedPaths = [];
    const totalBackupSize = await resolveFileSaveLocations(dbGameRow, resolvedPaths);
    await resolveRegistrySaveLocations(dbGameRow, resolvedPaths);

    dbGameRow.resolved_paths = resolvedPaths;
    dbGameRow.backup_size = totalBackupSize;
    return dbGameRow;
}

module.exports = { processGame };
