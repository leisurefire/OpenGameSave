const fsOriginal = require('fs');
const path = require('path');

const glob = require('glob');
const WinReg = require('winreg');

const { normalizeRegistryKeyPath } = require('../validation');
const {
    getAllUserIds,
    getContext,
    getGameData,
    getSettings
} = require('./backupWorkerContext');

const MAX_GLOB_MATCHES = 10000;
const MAX_REGISTRY_MATCHES = 1000;
const MAX_UID_PLACEHOLDERS = 4;
const MAX_UID_COMBINATIONS = 256;

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
    const hive = String(parts.shift() || '').toUpperCase();
    const key = parts.length > 0 ? '\\' + parts.join('\\') : '';
    return { hive, key };
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createFinalTemplate(resolvedPath, placeholderMappings) {
    let finalTemplate = resolvedPath.replace(/\\/g, '/');
    const sortedMappings = Object.entries(placeholderMappings)
        .filter(([, resolvedValue]) => typeof resolvedValue === 'string' && resolvedValue.length > 0)
        .sort((a, b) => b[1].length - a[1].length);

    for (const [placeholder, resolvedValue] of sortedMappings) {
        const normalizedValue = resolvedValue.replace(/\\/g, '/');
        finalTemplate = finalTemplate.replace(new RegExp(escapeRegExp(normalizedValue), 'gi'), placeholder);
    }
    return finalTemplate;
}

function* generateUidCombinations(
    count,
    uidValues,
    current = [],
    budget = { remaining: MAX_UID_COMBINATIONS }
) {
    if (budget.remaining <= 0) return;
    if (current.length === count) {
        budget.remaining -= 1;
        yield current;
        return;
    }
    for (const uid of uidValues) {
        if (budget.remaining <= 0) break;
        yield* generateUidCombinations(count, uidValues, [...current, uid], budget);
    }
}

async function resolveTemplatedBackupPath(templatedPath, gameInstallPath, isRegistry = false) {
    const placeholderMappings = {};
    let basePath = templatedPath.replace(/\{\{p\|[^}]+\}\}/gi, match => {
        const normalizedMatch = match.toLowerCase().replace(/\\/g, '/');
        let replacement = normalizedMatch;

        if (normalizedMatch === '{{p|game}}') {
            replacement = gameInstallPath;
        } else if (normalizedMatch === '{{p|steam}}') {
            replacement = getGameData().steamPath;
        } else if (normalizedMatch === '{{p|uplay}}' || normalizedMatch === '{{p|ubisoftconnect}}') {
            replacement = getGameData().ubisoftPath;
        } else if (normalizedMatch === '{{p|uid}}') {
            return '{{p|uid}}';
        } else if (normalizedMatch === '{{p|xbox_uid}}') {
            return '{{p|xbox_uid}}';
        } else if (getContext().placeholderMapping[normalizedMatch]) {
            replacement = getContext().placeholderMapping[normalizedMatch];
        }

        if (replacement !== normalizedMatch) {
            placeholderMappings[normalizedMatch] = replacement;
        }
        return replacement;
    });

    const withoutUidPlaceholders = basePath.toLowerCase()
        .replace(/\{\{p\|uid\}\}/gi, '')
        .replace(/\{\{p\|xbox_uid\}\}/gi, '');
    if (/\{\{p\|[^}]+\}\}/i.test(withoutUidPlaceholders)) {
        return [];
    }

    if (isRegistry) {
        return fillRegistryPathUid(templatedPath, basePath, placeholderMappings);
    }

    return await fillPathUid(templatedPath, basePath, placeholderMappings);
}

async function fillPathUid(templatedPath, basePath, placeholderMappings) {
    const toResolvedPathObject = resolvedPath => ({
        template: templatedPath,
        finalTemplate: createFinalTemplate(resolvedPath, placeholderMappings),
        resolved: resolvedPath
    });

    function findGlobMatches(testPath) {
        const files = [];
        for (const filePath of glob.globIterateSync(testPath.replace(/\\/g, '/'), {
            follow: false,
            maxDepth: 64,
            windowsPathsNoEscape: true
        })) {
            if (files.length >= MAX_GLOB_MATCHES) {
                throw new Error('Save path pattern matched too many files');
            }
            files.push(filePath);
        }
        return files;
    }

    function tryGlobAndReturnPaths(testPath) {
        const files = findGlobMatches(testPath);
        if (files.length === 0) return null;
        return files
            .filter(filePath => fsOriginal.existsSync(filePath))
            .map(toResolvedPathObject);
    }

    function tryExactAndReturnPath(testPath) {
        try {
            fsOriginal.lstatSync(testPath);
            return [toResolvedPathObject(testPath)];
        } catch (error) {
            if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
            throw error;
        }
    }

    function tryPathAndReturnPaths(testPath) {
        const normalizedPath = testPath.replace(/\\/g, '/');
        if (!glob.hasMagic(normalizedPath, { magicalBraces: true, windowsPathsNoEscape: true })) {
            return tryExactAndReturnPath(testPath);
        }
        return tryGlobAndReturnPaths(testPath);
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
        return tryPathAndReturnPaths(basePath) || [];
    }

    if (getSettings().backupAllAccounts) {
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
    contextAwarePath = applyContextReplacement(contextAwarePath, `${getGameData().steamPath}/userdata/{{p|uid}}`, getGameData().currentSteamUserId3);
    contextAwarePath = applyContextReplacement(contextAwarePath, `${getGameData().ubisoftPath}/savegames/{{p|uid}}`, getGameData().currentUbisoftUserId);

    if (!contextAwarePath.includes('{{p|uid}}') && !contextAwarePath.includes('{{p|xbox_uid}}')) {
        return tryPathAndReturnPaths(contextAwarePath) || [];
    }

    const uidMatches = contextAwarePath.match(/\{\{p\|uid\}\}/gi);
    const xboxUidMatches = contextAwarePath.match(/\{\{p\|xbox_uid\}\}/gi);
    const uidCount = (uidMatches ? uidMatches.length : 0) + (xboxUidMatches ? xboxUidMatches.length : 0);
    if (uidCount === 0) return [];

    const uidValues = [...new Set(Object.values(getAllUserIds()).filter(uid => uid && uid !== 'N/A'))];
    const uidCombinations = uidCount <= MAX_UID_PLACEHOLDERS
        ? generateUidCombinations(uidCount, uidValues)
        : [];

    for (const uidCombo of uidCombinations) {
        let testPath = contextAwarePath;
        let uidIndex = 0;
        testPath = testPath.replace(/\{\{p\|uid\}\}/gi, () => uidCombo[uidIndex++]);
        testPath = testPath.replace(/\{\{p\|xbox_uid\}\}/gi, () => uidCombo[uidIndex++]);

        const result = tryPathAndReturnPaths(testPath);
        if (result) return result;
    }

    const wildcardPath = basePath
        .replace(/\{\{p\|uid\}\}/gi, '*')
        .replace(/\{\{p\|xbox_uid\}\}/gi, '*');
    const wildcardResolvedPaths = findGlobMatches(wildcardPath);
    if (wildcardResolvedPaths.length === 0) return [];

    const latestPath = await findLatestModifiedPath(wildcardResolvedPaths);
    return [{
        template: templatedPath,
        finalTemplate: createFinalTemplate(latestPath, placeholderMappings),
        resolved: latestPath
    }];
}

async function fillRegistryPathUid(templatedPath, basePath, placeholderMappings) {
    const uidPlaceholderPattern = /\{\{p\|(?:uid|xbox_uid)\}\}/i;

    function getSafeRegistryPath(candidatePath) {
        try {
            return normalizeRegistryKeyPath(candidatePath);
        } catch (_) {
            return null;
        }
    }

    function registryKeyExists(candidatePath) {
        const registryPath = getSafeRegistryPath(candidatePath);
        if (!registryPath) return Promise.resolve(false);

        const { hive, key } = parseRegistryPath(registryPath);
        const winRegHive = getWinRegHive(hive);
        if (!winRegHive) return Promise.resolve(false);

        const registryKey = new WinReg({ hive: winRegHive, key });
        return new Promise(resolve => {
            registryKey.keyExists((err, exists) => resolve(!err && exists));
        });
    }

    function getRegistryChildNames(candidatePath) {
        const registryPath = getSafeRegistryPath(candidatePath);
        if (!registryPath) return Promise.resolve([]);

        const { hive, key } = parseRegistryPath(registryPath);
        const winRegHive = getWinRegHive(hive);
        if (!winRegHive) return Promise.resolve([]);

        const registryKey = new WinReg({ hive: winRegHive, key });
        return new Promise(resolve => {
            registryKey.keys((err, subKeys) => {
                if (err || !Array.isArray(subKeys)) {
                    resolve([]);
                    return;
                }

                const parentSegments = key.split('\\').filter(Boolean);
                const childNames = subKeys
                    .slice(0, MAX_REGISTRY_MATCHES + 1)
                    .map(subKey => String(subKey.key || '').split('\\').filter(Boolean))
                    .filter(segments => segments.length === parentSegments.length + 1)
                    .map(segments => segments[segments.length - 1]);

                resolve([...new Set(childNames)].slice(0, MAX_REGISTRY_MATCHES));
            });
        });
    }

    async function expandUidWildcards(candidatePath, matches = [], budget = { remaining: MAX_REGISTRY_MATCHES }) {
        if (matches.length >= MAX_REGISTRY_MATCHES || budget.remaining <= 0) return matches;

        const { hive, key } = parseRegistryPath(candidatePath);
        const segments = key.split('\\').filter(Boolean);
        const uidSegmentIndex = segments.findIndex(segment => uidPlaceholderPattern.test(segment));
        if (uidSegmentIndex === -1) {
            const registryPath = getSafeRegistryPath(candidatePath);
            if (registryPath) matches.push(registryPath);
            return matches;
        }

        const parentSegments = segments.slice(0, uidSegmentIndex);
        const parentPath = parentSegments.length > 0
            ? `${hive}\\${parentSegments.join('\\')}`
            : hive;
        const childNames = await getRegistryChildNames(parentPath);
        const segmentPattern = new RegExp(
            `^${segments[uidSegmentIndex]
                .split(/\{\{p\|(?:uid|xbox_uid)\}\}/i)
                .map(escapeRegExp)
                .join('(.+)')}$`,
            'i'
        );

        for (const childName of childNames) {
            if (matches.length >= MAX_REGISTRY_MATCHES || budget.remaining <= 0) break;
            budget.remaining -= 1;
            if (!segmentPattern.test(childName)) continue;

            const candidateSegments = [...segments];
            candidateSegments[uidSegmentIndex] = childName;
            await expandUidWildcards(`${hive}\\${candidateSegments.join('\\')}`, matches, budget);
        }
        return matches;
    }

    const toResolvedPathObject = resolvedPath => ({
        template: templatedPath,
        finalTemplate: createFinalTemplate(resolvedPath, placeholderMappings),
        resolved: resolvedPath
    });

    if (!uidPlaceholderPattern.test(basePath)) {
        const registryPath = getSafeRegistryPath(basePath);
        return registryPath ? [toResolvedPathObject(registryPath)] : [];
    }

    const uidMatches = basePath.match(/\{\{p\|(?:uid|xbox_uid)\}\}/gi) || [];
    if (uidMatches.length > MAX_UID_PLACEHOLDERS) return [];

    if (!getSettings().backupAllAccounts) {
        const uidValues = [...new Set(Object.values(getAllUserIds())
            .filter(uid => uid && uid !== 'N/A')
            .map(String))];

        for (const uidCombination of generateUidCombinations(uidMatches.length, uidValues)) {
            let uidIndex = 0;
            const candidatePath = basePath.replace(
                /\{\{p\|(?:uid|xbox_uid)\}\}/gi,
                () => uidCombination[uidIndex++]
            );
            if (await registryKeyExists(candidatePath)) {
                return [toResolvedPathObject(getSafeRegistryPath(candidatePath))];
            }
        }
    }

    const expandedPaths = await expandUidWildcards(basePath);
    const existingPaths = [];
    for (const registryPath of expandedPaths) {
        if (await registryKeyExists(registryPath)) {
            existingPaths.push(toResolvedPathObject(registryPath));
            if (!getSettings().backupAllAccounts) break;
        }
    }
    return existingPaths;
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
module.exports = {
    getWinRegHive,
    parseRegistryPath,
    resolveTemplatedBackupPath
};
