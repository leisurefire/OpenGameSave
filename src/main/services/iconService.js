const fs = require('fs');
const path = require('path');

let iconMapCache = null;
let iconMapCachePromise = null;

async function getCachedIconMap() {
    if (iconMapCache) return iconMapCache;
    if (iconMapCachePromise) return iconMapCachePromise;

    const iconPaths = {
        Steam: path.join(__dirname, '../assets/steam.svg'),
        Ubisoft: path.join(__dirname, '../assets/ubisoft.svg'),
        EA: path.join(__dirname, '../assets/ea.svg'),
        Epic: path.join(__dirname, '../assets/epic.svg'),
        GOG: path.join(__dirname, '../assets/gog.svg'),
        Xbox: path.join(__dirname, '../assets/xbox.svg'),
        Blizzard: path.join(__dirname, '../assets/battlenet.svg')
    };

    iconMapCachePromise = Promise.all(
        Object.entries(iconPaths).map(async ([platform, iconPath]) => [
            platform,
            await fs.promises.readFile(iconPath, 'utf8')
        ])
    ).then((entries) => {
        iconMapCache = Object.fromEntries(entries);
        return iconMapCache;
    }).catch((error) => {
        iconMapCachePromise = null;
        throw error;
    });

    return iconMapCachePromise;
}

module.exports = { getCachedIconMap };
