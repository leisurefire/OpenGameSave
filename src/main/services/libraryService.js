const { shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vdf = require('vdf-parser');
const WinReg = require('winreg');

const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_ART_BYTES = 12 * 1024 * 1024;
const STEAM_UTILITY_APP_IDS = new Set(['228980']);
const ART_MIME_TYPES = Object.freeze({
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp'
});

const BATTLE_NET_GAMES = Object.freeze([
    { title: 'Overwatch 2', productCode: 'Pro', folders: ['Overwatch'] },
    { title: 'Hearthstone', productCode: 'WTCG', folders: ['Hearthstone'] },
    { title: 'World of Warcraft', productCode: 'WoW', folders: ['World of Warcraft'] },
    { title: 'World of Warcraft Classic', productCode: 'WoWC', folders: ['World of Warcraft\\_classic_'] },
    { title: 'Diablo IV', productCode: 'Fen', folders: ['Diablo IV'] },
    { title: 'Diablo III', productCode: 'D3', folders: ['Diablo III'] },
    { title: 'Diablo II: Resurrected', productCode: 'OSI', folders: ['Diablo II Resurrected'] },
    { title: 'StarCraft II', productCode: 'S2', folders: ['StarCraft II'] },
    { title: 'StarCraft: Remastered', productCode: 'S1', folders: ['StarCraft'] },
    { title: 'Heroes of the Storm', productCode: 'Hero', folders: ['Heroes of the Storm'] }
]);
const BATTLE_NET_ART = Object.freeze({
    Pro: Object.freeze({
        cover: 'https://ld5.res.netease.com/images/20250707/1751860761227_0cfb00f220.jpg',
        hero: 'https://ld5.res.netease.com/images/20250707/1751860761227_0cfb00f220.jpg'
    })
});

let scannedGames = new Map();

function isReadableFile(filePath, maximumBytes = MAX_MANIFEST_BYTES) {
    if (!filePath) return false;
    try {
        const stats = fs.statSync(filePath);
        return stats.isFile() && stats.size > 0 && stats.size <= maximumBytes;
    } catch {
        return false;
    }
}

function readJsonFile(filePath) {
    if (!isReadableFile(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function normalizeSteamAppId(appId) {
    const normalizedAppId = String(appId || '').trim();
    if (!/^\d{1,12}$/.test(normalizedAppId)) throw new Error('Invalid Steam app id');
    return normalizedAppId;
}

function createSteamLaunchUri(appId) {
    const normalizedAppId = normalizeSteamAppId(appId);
    return `steam://rungameid/${normalizedAppId}`;
}

function createSteamArtUrls(appId, artType) {
    const normalizedAppId = normalizeSteamAppId(appId);
    const baseUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${normalizedAppId}`;
    if (artType === 'cover') return [`${baseUrl}/library_600x900_2x.jpg`, `${baseUrl}/library_600x900.jpg`];
    if (artType === 'hero') return [`${baseUrl}/library_hero.jpg`];
    throw new Error('Invalid Steam artwork type');
}

function createEpicLaunchUri(appName) {
    const normalizedAppName = String(appName || '').trim();
    if (!/^[A-Za-z0-9._-]{1,256}$/.test(normalizedAppName)) throw new Error('Invalid Epic app name');
    return `com.epicgames.launcher://apps/${encodeURIComponent(normalizedAppName)}?action=launch&silent=true`;
}

function makeLibraryId(platform, platformId) {
    return `${platform.toLowerCase()}:${String(platformId).trim()}`;
}

function findFirstExistingFile(candidates) {
    return candidates.find(candidate => isReadableFile(candidate, MAX_ART_BYTES)) || null;
}

function findSteamArt(steamRoot, appId) {
    const cacheRoot = path.join(steamRoot, 'appcache', 'librarycache');
    const appRoot = path.join(cacheRoot, String(appId));
    const coverCandidates = [
        path.join(appRoot, 'library_600x900_2x.jpg'),
        path.join(appRoot, 'library_600x900.jpg'),
        path.join(appRoot, 'library_capsule.jpg'),
        path.join(cacheRoot, `${appId}_library_600x900.jpg`)
    ];
    const heroCandidates = [
        path.join(appRoot, 'library_hero.jpg'),
        path.join(appRoot, 'library_header.jpg'),
        path.join(appRoot, 'header.jpg'),
        path.join(cacheRoot, `${appId}_library_hero.jpg`),
        path.join(cacheRoot, `${appId}_header.jpg`)
    ];

    if (fs.existsSync(appRoot)) {
        try {
            for (const entry of fs.readdirSync(appRoot, { withFileTypes: true })) {
                if (entry.isFile()) {
                    if (/^library_600x900(?:_2x)?(?:_[a-z0-9-]+)?\.(?:jpe?g|png|webp)$/i.test(entry.name)) {
                        coverCandidates.push(path.join(appRoot, entry.name));
                    }
                    if (/^(?:library_hero|library_header|header)(?:_[a-z0-9-]+)?\.(?:jpe?g|png|webp)$/i.test(entry.name)) {
                        heroCandidates.push(path.join(appRoot, entry.name));
                    }
                    continue;
                }
                if (entry.isDirectory()) {
                    const nestedRoot = path.join(appRoot, entry.name);
                    coverCandidates.push(
                        path.join(nestedRoot, 'library_600x900.jpg'),
                        path.join(nestedRoot, 'library_capsule.jpg')
                    );
                    heroCandidates.push(
                        path.join(nestedRoot, 'library_hero.jpg'),
                        path.join(nestedRoot, 'library_header.jpg')
                    );
                }
            }
        } catch {
            // Steam's cache may be changing while the library is scanned.
        }
    }

    return {
        cover: findFirstExistingFile(coverCandidates),
        hero: findFirstExistingFile(heroCandidates)
    };
}

function getSteamRootCandidates() {
    const home = os.homedir();
    // Load gameData lazily: `original-fs` is an Electron runtime module and is
    // unavailable when pure helpers from this service are exercised by Node tests.
    const detectedRoot = require('../gameData').getGameData().steamPath;
    const candidates = process.platform === 'win32'
        ? [
            detectedRoot,
            path.join(process.env['PROGRAMFILES(X86)'] || '', 'Steam'),
            path.join(process.env.PROGRAMFILES || '', 'Steam')
        ]
        : process.platform === 'darwin'
            ? [path.join(home, 'Library', 'Application Support', 'Steam')]
            : [path.join(home, '.steam', 'steam'), path.join(home, '.local', 'share', 'Steam')];
    return [...new Set(candidates.filter(candidate => candidate && fs.existsSync(candidate)))];
}

function getSteamLibraryRoots(steamRoot) {
    const libraryRoots = new Set([steamRoot]);
    const manifestCandidates = [
        path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'),
        path.join(steamRoot, 'config', 'libraryfolders.vdf')
    ];

    for (const manifestPath of manifestCandidates) {
        if (!isReadableFile(manifestPath)) continue;
        try {
            const parsed = vdf.parse(fs.readFileSync(manifestPath, 'utf8'));
            const folders = parsed.libraryfolders || parsed.LibraryFolders || {};
            Object.values(folders).forEach((entry) => {
                const libraryPath = typeof entry === 'string' ? entry : entry?.path;
                if (libraryPath && fs.existsSync(libraryPath)) libraryRoots.add(path.normalize(libraryPath));
            });
        } catch (error) {
            console.warn(`Could not parse Steam library manifest ${manifestPath}:`, error.message);
        }
    }

    return [...libraryRoots];
}

function scanSteamGames() {
    const games = [];
    for (const steamRoot of getSteamRootCandidates()) {
        for (const libraryRoot of getSteamLibraryRoots(steamRoot)) {
            const steamAppsRoot = path.join(libraryRoot, 'steamapps');
            let manifests = [];
            try {
                manifests = fs.readdirSync(steamAppsRoot, { withFileTypes: true })
                    .filter(entry => entry.isFile() && /^appmanifest_\d+\.acf$/i.test(entry.name));
            } catch {
                continue;
            }

            for (const manifest of manifests) {
                const manifestPath = path.join(steamAppsRoot, manifest.name);
                if (!isReadableFile(manifestPath)) continue;
                try {
                    const appState = vdf.parse(fs.readFileSync(manifestPath, 'utf8')).AppState;
                    const appId = String(appState?.appid || '').trim();
                    const title = String(appState?.name || '').trim();
                    if (!appId || !title || STEAM_UTILITY_APP_IDS.has(appId) || appState?.type === 'Tool') continue;
                    const installPath = path.join(steamAppsRoot, 'common', String(appState.installdir || ''));
                    const art = findSteamArt(steamRoot, appId);
                    games.push({
                        id: makeLibraryId('Steam', appId),
                        title,
                        platform: 'Steam',
                        platformId: appId,
                        installPath,
                        launchType: 'steam',
                        coverPath: art.cover,
                        heroPath: art.hero
                    });
                } catch (error) {
                    console.warn(`Could not parse Steam app manifest ${manifestPath}:`, error.message);
                }
            }
        }
    }
    return games;
}

function scanEpicGames() {
    if (process.platform !== 'win32') return [];
    const manifestRoot = path.join(
        process.env.PROGRAMDATA || 'C:\\ProgramData',
        'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'
    );
    let entries = [];
    try {
        entries = fs.readdirSync(manifestRoot, { withFileTypes: true })
            .filter(entry => entry.isFile() && entry.name.endsWith('.item'));
    } catch {
        return [];
    }

    return entries.flatMap((entry) => {
        const manifest = readJsonFile(path.join(manifestRoot, entry.name));
        const appName = String(manifest?.AppName || '').trim();
        const title = String(manifest?.DisplayName || '').trim();
        const installPath = String(manifest?.InstallLocation || '').trim();
        if (!appName || !title || !installPath || !fs.existsSync(installPath)) return [];
        return [{
            id: makeLibraryId('Epic', appName),
            title,
            platform: 'Epic',
            platformId: appName,
            installPath: path.normalize(installPath),
            launchType: 'epic'
        }];
    });
}

function registryKeys(registryKey) {
    return new Promise((resolve) => {
        registryKey.keys((error, keys) => resolve(error ? [] : keys));
    });
}

function registryValues(registryKey) {
    return new Promise((resolve) => {
        registryKey.values((error, values) => resolve(error ? [] : values));
    });
}

async function scanGogGames() {
    if (process.platform !== 'win32') return [];
    const roots = [
        new WinReg({ hive: WinReg.HKLM, key: '\\SOFTWARE\\WOW6432Node\\GOG.com\\Games' }),
        new WinReg({ hive: WinReg.HKLM, key: '\\SOFTWARE\\GOG.com\\Games' })
    ];
    const games = [];

    for (const root of roots) {
        for (const gameKey of await registryKeys(root)) {
            const values = await registryValues(gameKey);
            const registryData = Object.fromEntries(values.map(value => [value.name.toLowerCase(), value.value]));
            const platformId = path.basename(gameKey.key);
            const title = String(registryData.gamename || registryData.gameid || '').trim();
            const installPath = String(registryData.path || '').trim();
            const executable = String(registryData.exe || '').trim();
            if (!title || !installPath || !fs.existsSync(installPath)) continue;
            games.push({
                id: makeLibraryId('GOG', platformId),
                title,
                platform: 'GOG',
                platformId,
                installPath: path.normalize(installPath),
                launchType: 'gog',
                executable: executable && fs.existsSync(executable) ? path.normalize(executable) : null
            });
        }
    }
    return games;
}

function findBattleNetLauncher() {
    if (process.platform !== 'win32') return null;
    return [
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Battle.net', 'Battle.net Launcher.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Battle.net', 'Battle.net Launcher.exe')
    ].find(candidate => isReadableFile(candidate, 500 * 1024 * 1024)) || null;
}

function scanBattleNetGames() {
    if (process.platform !== 'win32') return [];
    const configPath = path.join(process.env.APPDATA || '', 'Battle.net', 'Battle.net.config');
    const defaultInstallPath = String(readJsonFile(configPath)?.Client?.Install?.DefaultInstallPath || '').trim();
    if (!defaultInstallPath || !fs.existsSync(defaultInstallPath)) return [];
    const launcherPath = findBattleNetLauncher();

    return BATTLE_NET_GAMES.flatMap((definition) => {
        const installPath = definition.folders
            .map(folder => path.join(defaultInstallPath, folder))
            .find(candidate => fs.existsSync(candidate));
        if (!installPath) return [];
        return [{
            id: makeLibraryId('Blizzard', definition.productCode),
            title: definition.title,
            platform: 'Blizzard',
            platformId: definition.productCode,
            installPath: path.normalize(installPath),
            launchType: 'battlenet',
            launcherPath
        }];
    });
}

function toRendererGame(game) {
    const hasSteamArtFallback = game.platform === 'Steam';
    const battleNetArt = game.platform === 'Blizzard' ? BATTLE_NET_ART[game.platformId] : null;
    return {
        id: game.id,
        title: game.title,
        platform: game.platform,
        platformId: game.platformId,
        installPath: game.installPath,
        hasCover: Boolean(game.coverPath) || hasSteamArtFallback || Boolean(battleNetArt?.cover),
        hasHero: Boolean(game.heroPath) || hasSteamArtFallback || Boolean(battleNetArt?.hero)
    };
}

async function scanLibraryGames() {
    const scanned = [
        ...scanSteamGames(),
        ...scanEpicGames(),
        ...await scanGogGames(),
        ...scanBattleNetGames()
    ];
    scannedGames = new Map(scanned.map(game => [game.id, game]));
    return [...scannedGames.values()]
        .map(toRendererGame)
        .sort((left, right) => left.title.localeCompare(right.title, undefined, { numeric: true }));
}

async function getLibraryGameArt(gameId, artType) {
    const game = scannedGames.get(String(gameId));
    const artPath = artType === 'hero' ? game?.heroPath : artType === 'cover' ? game?.coverPath : null;
    if (artPath && isReadableFile(artPath, MAX_ART_BYTES)) {
        const mimeType = ART_MIME_TYPES[path.extname(artPath).toLowerCase()];
        if (mimeType) {
            const contents = await fs.promises.readFile(artPath);
            return `data:${mimeType};base64,${contents.toString('base64')}`;
        }
    }
    if (game?.platform === 'Steam') return createSteamArtUrls(game.platformId, artType)[0];
    if (game?.platform === 'Blizzard') return BATTLE_NET_ART[game.platformId]?.[artType] || null;
    return null;
}

async function launchLibraryGame(gameId) {
    const game = scannedGames.get(String(gameId));
    if (!game) throw new Error('Game is not present in the scanned library');

    if (game.launchType === 'steam') {
        await shell.openExternal(createSteamLaunchUri(game.platformId));
    } else if (game.launchType === 'epic') {
        await shell.openExternal(createEpicLaunchUri(game.platformId));
    } else if (game.launchType === 'gog' && game.executable) {
        const errorMessage = await shell.openPath(game.executable);
        if (errorMessage) throw new Error(errorMessage);
    } else if (game.launchType === 'gog') {
        await shell.openExternal(`goggalaxy://openGameView/${encodeURIComponent(game.platformId)}`);
    } else if (game.launchType === 'battlenet' && game.launcherPath) {
        const child = spawn(game.launcherPath, [`--exec=launch ${game.platformId}`], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
        });
        child.unref();
    } else if (game.launchType === 'battlenet') {
        await shell.openExternal(`battlenet://${encodeURIComponent(game.platformId)}`);
    } else {
        throw new Error('This game provider does not support launching yet');
    }

    return { launched: true, gameId: game.id };
}

async function openLibraryGameDirectory(gameId) {
    const game = scannedGames.get(String(gameId));
    if (!game || !game.installPath || !fs.existsSync(game.installPath)) {
        throw new Error('Game installation directory is unavailable');
    }
    const errorMessage = await shell.openPath(game.installPath);
    if (errorMessage) throw new Error(errorMessage);
    return true;
}

module.exports = {
    createEpicLaunchUri,
    createSteamArtUrls,
    createSteamLaunchUri,
    getLibraryGameArt,
    launchLibraryGame,
    openLibraryGameDirectory,
    scanLibraryGames
};
