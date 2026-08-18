const PLATFORM_SAVE_KEYS = Object.freeze({
    win32: 'win',
    darwin: 'mac',
    linux: 'linux'
});

/**
 * Translate a Node.js platform identifier to the corresponding database save-location key.
 *
 * @param {NodeJS.Platform | string} [platform]
 * @returns {'win' | 'mac' | 'linux' | null}
 */
function getSavePlatformKey(platform = process.platform) {
    return PLATFORM_SAVE_KEYS[platform] || null;
}

/**
 * Return only the save templates that apply to the requested platform.
 *
 * @param {Record<string, unknown> | null | undefined} saveLocation
 * @param {NodeJS.Platform | string} [platform]
 * @returns {string[]}
 */
function getPlatformSaveLocations(saveLocation, platform = process.platform) {
    const platformKey = getSavePlatformKey(platform);
    if (!platformKey || !saveLocation || !Array.isArray(saveLocation[platformKey])) return [];
    return saveLocation[platformKey].filter(location => typeof location === 'string');
}

module.exports = {
    PLATFORM_SAVE_KEYS,
    getPlatformSaveLocations,
    getSavePlatformKey
};
