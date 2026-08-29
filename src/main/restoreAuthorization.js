const path = require('path');

const { normalizeRegistryKeyPath } = require('./validation');

const MAX_TEMPLATE_LENGTH = 16384;
const MAX_PATH_SEGMENTS = 256;
const MAX_SEGMENT_LENGTH = 255;
const DYNAMIC_PLACEHOLDERS = new Set(['uid', 'xbox_uid']);
const DYNAMIC_MARKERS = new Map([
    ['uid', '__OGS_DYNAMIC_UID_PLACEHOLDER__'],
    ['xbox_uid', '__OGS_DYNAMIC_XBOX_UID_PLACEHOLDER__']
]);
const FORBIDDEN_WILDCARD_EXTENSIONS = new Set([
    '.app', '.bat', '.bash', '.cmd', '.com', '.cpl', '.dll', '.dylib', '.exe',
    '.fish', '.hta', '.jar', '.js', '.jse', '.lnk', '.msi', '.msp', '.ps1',
    '.psd1', '.psm1', '.py', '.pyw', '.rb', '.reg', '.scr', '.sh', '.so',
    '.url', '.vbe', '.vbs', '.wsf', '.wsh', '.zsh'
]);

function normalizePlaceholderName(value) {
    return String(value || '').trim().toLowerCase().replace(/\\/g, '/');
}

function normalizePlaceholderValues(values, trustedInstallFolder) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
        throw new Error('Placeholder values must be an object');
    }
    const normalized = new Map();
    for (const [rawName, rawValue] of Object.entries(values)) {
        const wrappedMatch = /^\{\{p\|([^{}]+)\}\}$/i.exec(rawName);
        const name = normalizePlaceholderName(wrappedMatch ? wrappedMatch[1] : rawName);
        if (!name || DYNAMIC_PLACEHOLDERS.has(name)) continue;
        if (typeof rawValue !== 'string' || !rawValue || rawValue.includes('\0')) {
            throw new Error(`Invalid value for placeholder: ${name}`);
        }
        normalized.set(name, rawValue);
    }
    if (trustedInstallFolder != null) {
        if (typeof trustedInstallFolder !== 'string' || !trustedInstallFolder || trustedInstallFolder.includes('\0')) {
            throw new Error('Invalid trusted install folder');
        }
        normalized.set('game', trustedInstallFolder);
    } else {
        normalized.delete('game');
    }
    if (normalized.has('uplay') && !normalized.has('ubisoftconnect')) {
        normalized.set('ubisoftconnect', normalized.get('uplay'));
    }
    if (normalized.has('ubisoftconnect') && !normalized.has('uplay')) {
        normalized.set('uplay', normalized.get('ubisoftconnect'));
    }
    return normalized;
}

function expandTemplate(rawTemplate, placeholderValues, { allowDynamic }) {
    if (typeof rawTemplate !== 'string' || !rawTemplate || rawTemplate.length > MAX_TEMPLATE_LENGTH
        || rawTemplate.includes('\0') || /[\r\n]/.test(rawTemplate)) {
        throw new Error('Invalid restore template');
    }
    for (const marker of DYNAMIC_MARKERS.values()) {
        if (rawTemplate.includes(marker)) throw new Error('Restore template contains a reserved marker');
    }

    const expanded = rawTemplate.replace(/\{\{p\|([^{}]+)\}\}/gi, (placeholder, rawName) => {
        const name = normalizePlaceholderName(rawName);
        if (DYNAMIC_PLACEHOLDERS.has(name)) {
            if (!allowDynamic) throw new Error('Backup template is not concrete');
            return DYNAMIC_MARKERS.get(name);
        }
        if (!placeholderValues.has(name)) throw new Error(`Unknown restore placeholder: ${placeholder}`);
        return placeholderValues.get(name);
    });
    if (/\{\{|\}\}/.test(expanded)) throw new Error('Unknown restore placeholder syntax');
    return expanded;
}

function splitPathSegments(value, pathApi) {
    const root = pathApi.parse(value).root;
    const remainder = value.slice(root.length);
    const result = {
        root: pathApi.normalize(root),
        segments: remainder.split(/[\\/]+/).filter(Boolean)
    };
    if (result.segments.length > MAX_PATH_SEGMENTS
        || result.segments.some(segment => segment.length > MAX_SEGMENT_LENGTH)) {
        throw new Error('Restore path has too many or oversized segments');
    }
    return result;
}

function assertSafeWindowsSegment(segment, { allowMagic }) {
    if (segment === '.' || segment === '..') throw new Error('Windows path contains traversal segments');
    if ([...segment].some(character => character.charCodeAt(0) <= 0x1f) || /[<>"|:]/.test(segment)) {
        throw new Error('Windows path contains invalid characters or ADS');
    }
    if (!allowMagic && /[*?]/.test(segment)) throw new Error('Concrete restore path contains wildcard characters');
    if (/[ .]$/.test(segment)) throw new Error('Windows path contains a trailing dot or space');

    if (!allowMagic || !/[*?[]/.test(segment)) {
        const deviceName = segment.split('.', 1)[0].toUpperCase();
        if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(deviceName)) {
            throw new Error('Windows path contains a reserved device name');
        }
    }
}

function normalizeFilePath(value, pathFlavor, { allowMagic }) {
    const pathApi = pathFlavor === 'win32' ? path.win32 : path.posix;
    if (pathFlavor !== 'win32' && pathFlavor !== 'posix') throw new Error('Unsupported path flavor');
    if (typeof value !== 'string' || !value || value.length > MAX_TEMPLATE_LENGTH
        || value.includes('\0') || /[\r\n]/.test(value)) {
        throw new Error('Invalid restore path');
    }
    if (pathFlavor === 'win32') {
        const windowsValue = value.replace(/\//g, '\\');
        if (/^(?:\\\\[?.]\\|\\\?\?\\)/.test(windowsValue)) {
            throw new Error('Windows device paths are not allowed');
        }
    }
    if (!pathApi.isAbsolute(value)) throw new Error('Restore path must be absolute');

    const { segments } = splitPathSegments(value, pathApi);
    for (const segment of segments) {
        if (segment === '.' || segment === '..') throw new Error('Restore path contains traversal segments');
        if (pathFlavor === 'win32') assertSafeWindowsSegment(segment, { allowMagic });
        else if (!allowMagic && /[*?]/.test(segment)) throw new Error('Concrete restore path contains wildcard characters');
    }
    return pathApi.normalize(value);
}

function isStrictDescendant(root, target, pathApi, caseInsensitive) {
    const normalizedRoot = pathApi.resolve(root);
    const normalizedTarget = pathApi.resolve(target);
    const relative = pathApi.relative(normalizedRoot, normalizedTarget);
    if (!relative || pathApi.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${pathApi.sep}`)) {
        return false;
    }
    if (!caseInsensitive) return true;
    const foldedRoot = normalizedRoot.toLowerCase();
    const foldedTarget = normalizedTarget.toLowerCase();
    return foldedTarget.startsWith(`${foldedRoot.replace(/[\\/]+$/, '')}${pathApi.sep}`.toLowerCase());
}

function normalizeAllowedRoots(allowedRoots, trustedInstallFolder, pathFlavor) {
    if (!Array.isArray(allowedRoots)) throw new Error('Allowed restore roots must be an array');
    const pathApi = pathFlavor === 'win32' ? path.win32 : path.posix;
    const candidates = trustedInstallFolder == null
        ? [...allowedRoots]
        : [...allowedRoots, trustedInstallFolder];
    const normalized = [];
    for (const root of candidates) {
        const safeRoot = normalizeFilePath(root, pathFlavor, { allowMagic: false });
        if (pathApi.normalize(pathApi.parse(safeRoot).root) === safeRoot) {
            throw new Error('Filesystem roots cannot authorize restore destinations');
        }
        if (!normalized.some(item => (pathFlavor === 'win32'
            ? item.toLowerCase() === safeRoot.toLowerCase()
            : item === safeRoot))) {
            normalized.push(safeRoot);
        }
    }
    return normalized;
}

function selectAllowedRoot(destination, allowedRoots, pathFlavor) {
    const pathApi = pathFlavor === 'win32' ? path.win32 : path.posix;
    const caseInsensitive = pathFlavor === 'win32';
    const matches = allowedRoots.filter(root => isStrictDescendant(root, destination, pathApi, caseInsensitive));
    matches.sort((left, right) => right.length - left.length);
    if (matches.length === 0) throw new Error('Restore destination is outside the allowed roots');
    return matches[0];
}

function getDynamicPlaceholderNames(segment) {
    const names = [];
    for (const [name, marker] of DYNAMIC_MARKERS) {
        let offset = segment.indexOf(marker);
        while (offset !== -1) {
            names.push({ name, marker, offset });
            offset = segment.indexOf(marker, offset + marker.length);
        }
    }
    return names.sort((left, right) => left.offset - right.offset);
}

function hasDynamicPlaceholder(segment) {
    return getDynamicPlaceholderNames(segment).length > 0;
}

function hasSegmentMagic(segment) {
    return /[*?[]/.test(segment);
}

function isForbiddenRestorePayloadPath(filePath, pathFlavor = 'win32') {
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) return true;
    const pathApi = pathFlavor === 'posix' ? path.posix : path.win32;
    return FORBIDDEN_WILDCARD_EXTENSIONS.has(pathApi.extname(filePath).toLowerCase());
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globSegmentToRegExp(segment, caseInsensitive) {
    let expression = '^';
    for (let index = 0; index < segment.length; index += 1) {
        const character = segment[index];
        if (character === '*') {
            expression += '.*';
        } else if (character === '?') {
            expression += '.';
        } else if (character === '[') {
            const closeIndex = segment.indexOf(']', index + 1);
            if (closeIndex === -1) {
                expression += '\\[';
            } else {
                let classBody = segment.slice(index + 1, closeIndex);
                if (!classBody || /[\\/]/.test(classBody)) throw new Error('Invalid wildcard character class');
                if (classBody[0] === '!') classBody = `^${classBody.slice(1)}`;
                classBody = classBody.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
                expression += `[${classBody}]`;
                index = closeIndex;
            }
        } else {
            expression += escapeRegExp(character);
        }
    }
    expression += '$';
    return new RegExp(expression, caseInsensitive ? 'i' : '');
}

function assertSafeDynamicSegment(segment, pathFlavor) {
    if (!segment || segment === '.' || segment === '..' || /[\\/\0\r\n]/.test(segment)) {
        throw new Error('Dynamic placeholder matched an unsafe path segment');
    }
    if (pathFlavor === 'win32') assertSafeWindowsSegment(segment, { allowMagic: false });
}

function getTrustedDynamicValues(dynamicName, dynamicValues, pathFlavor) {
    if (!dynamicValues || typeof dynamicValues !== 'object' || Array.isArray(dynamicValues)
        || !Object.prototype.hasOwnProperty.call(dynamicValues, dynamicName)
        || !Array.isArray(dynamicValues[dynamicName]) || dynamicValues[dynamicName].length === 0) {
        throw new Error(`Trusted dynamic values for ${dynamicName} are required`);
    }
    const trustedValues = [...new Set(dynamicValues[dynamicName])];
    for (const value of trustedValues) {
        if (typeof value !== 'string') throw new Error(`Invalid trusted ${dynamicName} value`);
        assertSafeDynamicSegment(value, pathFlavor);
    }
    return trustedValues;
}

function dynamicGlobSegmentToRegExp(segment, caseInsensitive, dynamicValues, pathFlavor) {
    const dynamicMatches = getDynamicPlaceholderNames(segment);
    if (dynamicMatches.length === 0) return globSegmentToRegExp(segment, caseInsensitive);

    let expression = '^';
    let cursor = 0;
    for (const dynamicMatch of dynamicMatches) {
        expression += globSegmentToRegExp(segment.slice(cursor, dynamicMatch.offset), false)
            .source.slice(1, -1);
        const alternatives = getTrustedDynamicValues(dynamicMatch.name, dynamicValues, pathFlavor)
            .map(escapeRegExp)
            .join('|');
        expression += `(?:${alternatives})`;
        cursor = dynamicMatch.offset + dynamicMatch.marker.length;
    }
    expression += globSegmentToRegExp(segment.slice(cursor), false).source.slice(1, -1);
    expression += '$';
    return new RegExp(expression, caseInsensitive ? 'i' : '');
}

function matchPatternSegments(patternSegments, concreteSegments, { caseInsensitive, dynamicValues, pathFlavor }) {
    const memo = new Map();
    function visit(patternIndex, concreteIndex) {
        const memoKey = `${patternIndex}:${concreteIndex}`;
        if (memo.has(memoKey)) return memo.get(memoKey);
        let matched = false;
        if (patternIndex === patternSegments.length) {
            matched = concreteIndex === concreteSegments.length;
        } else {
            const patternSegment = patternSegments[patternIndex];
            if (patternSegment === '**') {
                matched = visit(patternIndex + 1, concreteIndex);
                for (let index = concreteIndex; !matched && index < concreteSegments.length; index += 1) {
                    assertSafeDynamicSegment(concreteSegments[index], pathFlavor);
                    matched = visit(patternIndex + 1, index + 1);
                }
            } else if (concreteIndex < concreteSegments.length
                && (hasDynamicPlaceholder(patternSegment) || hasSegmentMagic(patternSegment))) {
                matched = dynamicGlobSegmentToRegExp(
                    patternSegment,
                    caseInsensitive,
                    dynamicValues,
                    pathFlavor
                ).test(concreteSegments[concreteIndex])
                    && visit(patternIndex + 1, concreteIndex + 1);
            } else if (concreteIndex < concreteSegments.length) {
                matched = (caseInsensitive
                    ? patternSegment.toLowerCase() === concreteSegments[concreteIndex].toLowerCase()
                    : patternSegment === concreteSegments[concreteIndex])
                    && visit(patternIndex + 1, concreteIndex + 1);
            }
        }
        memo.set(memoKey, matched);
        return matched;
    }
    return visit(0, 0);
}

function getRelativePatternSegments(patternPath, allowedRoot, pathFlavor) {
    const pathApi = pathFlavor === 'win32' ? path.win32 : path.posix;
    const patternParts = splitPathSegments(patternPath, pathApi);
    const rootParts = splitPathSegments(allowedRoot, pathApi);
    const caseInsensitive = pathFlavor === 'win32';
    if ((caseInsensitive ? patternParts.root.toLowerCase() : patternParts.root)
        !== (caseInsensitive ? rootParts.root.toLowerCase() : rootParts.root)) {
        throw new Error('Restore pattern is not rooted in the authorized directory');
    }
    for (let index = 0; index < rootParts.segments.length; index += 1) {
        const patternSegment = patternParts.segments[index];
        const rootSegment = rootParts.segments[index];
        if (!patternSegment || hasSegmentMagic(patternSegment) || hasDynamicPlaceholder(patternSegment)
            || (caseInsensitive
                ? patternSegment.toLowerCase() !== rootSegment.toLowerCase()
                : patternSegment !== rootSegment)) {
            throw new Error('Restore pattern has a dynamic authorized root');
        }
    }
    return patternParts.segments.slice(rootParts.segments.length);
}

function assertPatternScope(patternPath, destination, allowedRoot, pathFlavor) {
    const relativePattern = getRelativePatternSegments(patternPath, allowedRoot, pathFlavor);
    for (let index = 0; index < relativePattern.length; index += 1) {
        const segment = relativePattern[index];
        const isDynamic = hasDynamicPlaceholder(segment);
        const previousFixed = relativePattern.slice(0, index)
            .some(candidate => !hasSegmentMagic(candidate) && !hasDynamicPlaceholder(candidate));
        if (segment === '**') {
            const laterFixed = relativePattern.slice(index + 1)
                .some(candidate => !hasSegmentMagic(candidate) && !hasDynamicPlaceholder(candidate));
            if (!previousFixed || !laterFixed) {
                throw new Error('Globstar requires a fixed game-specific prefix and suffix');
            }
        } else if (/^[*?]+$/.test(segment) && !previousFixed) {
            throw new Error('Broad whole-segment wildcards cannot target an allowed-root child');
        } else if (isDynamic && !previousFixed) {
            throw new Error('Dynamic placeholders require a fixed game-specific prefix');
        }
    }

    const usesDynamicMatching = relativePattern.some(segment => hasSegmentMagic(segment) || hasDynamicPlaceholder(segment));
    if (usesDynamicMatching && isForbiddenRestorePayloadPath(destination, pathFlavor)) {
        throw new Error('Wildcards cannot authorize executable or script destinations');
    }
}

function authorizeFileDestination({
    rawTemplates,
    concreteTemplate,
    placeholderValues,
    trustedInstallFolder,
    allowedRoots,
    dynamicValues,
    pathFlavor
}) {
    const pathApi = pathFlavor === 'win32' ? path.win32 : path.posix;
    const destination = normalizeFilePath(
        expandTemplate(concreteTemplate, placeholderValues, { allowDynamic: false }),
        pathFlavor,
        { allowMagic: false }
    );
    const normalizedRoots = normalizeAllowedRoots(allowedRoots, trustedInstallFolder, pathFlavor);
    const allowedRoot = selectAllowedRoot(destination, normalizedRoots, pathFlavor);
    const concreteParts = splitPathSegments(destination, pathApi);
    const caseInsensitive = pathFlavor === 'win32';

    for (const rawTemplate of rawTemplates) {
        try {
            const patternPath = normalizeFilePath(
                expandTemplate(rawTemplate, placeholderValues, { allowDynamic: true }),
                pathFlavor,
                { allowMagic: true }
            );
            const parsedPattern = pathApi.parse(patternPath);
            const patternCandidates = [patternPath];
            if (parsedPattern.base.includes('*')) {
                patternCandidates.unshift(pathApi.join(parsedPattern.dir, '*', parsedPattern.base));
            }
            for (const patternCandidate of patternCandidates) {
                const patternParts = splitPathSegments(patternCandidate, pathApi);
                if ((caseInsensitive ? patternParts.root.toLowerCase() : patternParts.root)
                    !== (caseInsensitive ? concreteParts.root.toLowerCase() : concreteParts.root)) continue;
                if (!matchPatternSegments(patternParts.segments, concreteParts.segments, {
                    caseInsensitive,
                    dynamicValues,
                    pathFlavor
                })) continue;
                assertPatternScope(patternCandidate, destination, allowedRoot, pathFlavor);
                return { destination, allowedRoot, rawTemplate, type: 'file' };
            }
        } catch (_) {
            // Invalid or non-matching database templates do not authorize the backup metadata.
        }
    }
    throw new Error('Backup destination is not authorized by the current database templates');
}

function normalizeRegistryPattern(value, { allowMagic }) {
    if (typeof value !== 'string' || !value || value.length > MAX_TEMPLATE_LENGTH
        || value.includes('\0') || /[\r\n]/.test(value)) {
        throw new Error('Invalid registry restore template');
    }
    const segments = value.replace(/\//g, '\\').replace(/\\+$/, '').split('\\');
    if (segments.length < 3 || segments.length > MAX_PATH_SEGMENTS
        || segments.some(segment => !segment || segment === '.' || segment === '..'
            || segment.length > MAX_SEGMENT_LENGTH)) {
        throw new Error('Registry restore template is too broad');
    }
    for (const segment of segments) {
        if (!allowMagic && hasSegmentMagic(segment)) throw new Error('Concrete registry path contains wildcards');
    }
    return segments;
}

function authorizeRegistryDestination({ rawTemplates, concreteTemplate, placeholderValues, dynamicValues }) {
    const concreteSegments = normalizeRegistryPattern(
        expandTemplate(concreteTemplate, placeholderValues, { allowDynamic: false }),
        { allowMagic: false }
    );
    const destination = normalizeRegistryKeyPath(concreteSegments.join('\\'));
    for (const rawTemplate of rawTemplates) {
        try {
            const patternSegments = normalizeRegistryPattern(
                expandTemplate(rawTemplate, placeholderValues, { allowDynamic: true }),
                { allowMagic: true }
            );
            if (!matchPatternSegments(patternSegments, concreteSegments, {
                caseInsensitive: true,
                dynamicValues,
                pathFlavor: 'win32'
            })) continue;
            const firstDynamicIndex = patternSegments.findIndex(segment => (
                hasSegmentMagic(segment) || hasDynamicPlaceholder(segment)
            ));
            if (firstDynamicIndex !== -1 && firstDynamicIndex < 3) {
                throw new Error('Registry wildcards require a fixed application prefix');
            }
            return { destination, allowedRoot: null, rawTemplate, type: 'reg' };
        } catch (_) {
            // Invalid or non-matching database templates do not authorize the backup metadata.
        }
    }
    throw new Error('Backup registry destination is not authorized by the current database templates');
}

/**
 * Authorize one concrete backup metadata destination against the current database row.
 * `trustedInstallFolder` is the absolute game directory derived from the database's
 * install_folder value; backup metadata must never supply it.
 */
function authorizeRestoreDestination({
    currentTemplates,
    trustedInstallFolder = null,
    placeholderValues = {},
    allowedRoots = [],
    dynamicValues = {},
    metadata,
    pathFlavor = 'win32'
}) {
    if (!currentTemplates || typeof currentTemplates !== 'object' || Array.isArray(currentTemplates)) {
        throw new Error('Current database templates are required');
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error('Backup path metadata is required');
    }
    if (!['file', 'folder', 'reg'].includes(metadata.type)) throw new Error('Invalid backup path type');
    const normalizedValues = normalizePlaceholderValues(placeholderValues, trustedInstallFolder);
    const concreteTemplate = metadata.template;

    if (metadata.type === 'reg') {
        const rawTemplates = currentTemplates.registry;
        if (!Array.isArray(rawTemplates)) throw new Error('Current registry templates must be an array');
        return authorizeRegistryDestination({
            rawTemplates,
            concreteTemplate,
            placeholderValues: normalizedValues,
            dynamicValues
        });
    }

    const rawTemplates = currentTemplates.file;
    if (!Array.isArray(rawTemplates)) throw new Error('Current file templates must be an array');
    const authorization = authorizeFileDestination({
        rawTemplates,
        concreteTemplate,
        placeholderValues: normalizedValues,
        trustedInstallFolder,
        allowedRoots,
        dynamicValues,
        pathFlavor
    });
    return { ...authorization, type: metadata.type };
}

module.exports = { authorizeRestoreDestination, isForbiddenRestorePayloadPath };
