const { spawn } = require('child_process');
const { isMainThread, Worker } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { shell } = isMainThread ? require('electron') : { shell: null };

const vdf = require('vdf-parser');
const WinReg = require('winreg');

const {
    MAX_MANIFEST_BYTES,
    createSteamArtUrls,
    findBattleNetLocalArt,
    findEpicManifestArt,
    findGogLocalArt,
    findTrustedArtFile,
    getGameArtwork,
    hasOfficialArtFallback
} = require('./libraryArtworkService');

const STEAM_UTILITY_APP_IDS = new Set(['228980']);
const MAX_LIBRARY_GAMES = 20000;
const MAX_LIBRARY_ROOTS = 256;
const MAX_PROVIDER_DIRECTORY_ENTRIES = 20000;
const MAX_STEAM_ART_ENTRIES = 1024;

const BATTLE_NET_GAMES = Object.freeze([
    {
        title: 'Overwatch 2', productCode: 'Pro', folders: ['Overwatch'], artTokens: ['#OVERWATCH_'],
        officialPage: 'https://overwatch.blizzard.com/'
    },
    {
        title: 'Hearthstone', productCode: 'WTCG', folders: ['Hearthstone'], artTokens: ['#HS_'],
        officialPage: 'https://hearthstone.blizzard.com/'
    },
    {
        title: 'World of Warcraft', productCode: 'WoW', folders: ['World of Warcraft'],
        artTokens: ['#WOW_'], rejectArtTokens: ['#WOW_CLASSIC_'],
        officialPage: 'https://worldofwarcraft.blizzard.com/'
    },
    {
        title: 'World of Warcraft Classic', productCode: 'WoWC', folders: ['World of Warcraft\\_classic_'],
        artTokens: ['#WOW_CLASSIC_'], officialPage: 'https://wowclassic.blizzard.com/'
    },
    {
        title: 'Diablo IV', productCode: 'Fen', folders: ['Diablo IV'], artTokens: ['#FENRIS_'],
        officialPage: 'https://diablo4.blizzard.com/'
    },
    {
        title: 'Diablo III', productCode: 'D3', folders: ['Diablo III'], artTokens: ['#D3_'],
        officialPage: 'https://us.diablo3.blizzard.com/'
    },
    {
        title: 'Diablo II: Resurrected', productCode: 'OSI', folders: ['Diablo II Resurrected'], artTokens: ['#OSI_'],
        officialPage: 'https://diablo2.blizzard.com/'
    },
    {
        title: 'StarCraft II', productCode: 'S2', folders: ['StarCraft II'], artTokens: ['#S2_'],
        officialPage: 'https://starcraft2.blizzard.com/'
    },
    {
        title: 'StarCraft: Remastered', productCode: 'S1', folders: ['StarCraft'], artTokens: ['#S1_'],
        officialPage: 'https://starcraft.com/'
    },
    {
        title: 'Heroes of the Storm', productCode: 'Hero', folders: ['Heroes of the Storm'], artTokens: ['#HEROES_'],
        officialPage: 'https://heroesofthestorm.blizzard.com/'
    }
]);

class LibraryScanWorkerController {
    constructor({ createWorker = () => new Worker(getLibraryScanWorkerPath()) } = {}) {
        if (typeof createWorker !== 'function') throw new TypeError('createWorker must be a function');
        this.createWorker = createWorker;
        this.activeTask = null;
        this.closed = false;
        this.shutdownPromise = null;
        this.terminations = new Set();
    }

    isClosed() {
        return this.closed;
    }

    trackTermination(worker) {
        let termination;
        try {
            termination = Promise.resolve(worker.terminate()).catch(() => undefined);
        } catch (_) {
            termination = Promise.resolve();
        }
        this.terminations.add(termination);
        termination.then(() => this.terminations.delete(termination));
        return termination;
    }

    run(scanContext) {
        if (this.closed) return Promise.reject(new Error('Library scanner is shut down'));
        if (this.activeTask) return Promise.reject(new Error('Library scan is already running'));

        let worker;
        try {
            worker = this.createWorker();
        } catch (error) {
            return Promise.reject(error);
        }

        return new Promise((resolve, reject) => {
            const task = { worker, settled: false, cancel: null };
            const finish = (callback, value) => {
                if (task.settled) return;
                task.settled = true;
                if (this.activeTask === task) this.activeTask = null;
                this.trackTermination(worker);
                callback(value);
            };
            task.cancel = error => finish(reject, error);
            this.activeTask = task;

            worker.once('error', error => finish(reject, error));
            worker.once('exit', (code) => {
                if (!task.settled) {
                    finish(reject, new Error(`Library scan worker stopped before returning a result (exit code ${code})`));
                }
            });
            worker.once('message', (message) => {
                if (message?.type === 'done' && Array.isArray(message.games)) {
                    finish(resolve, message.games);
                    return;
                }
                const error = new Error(message?.error?.message || 'Library scan worker failed');
                error.stack = message?.error?.stack || error.stack;
                finish(reject, error);
            });
            try {
                worker.postMessage({ scanContext });
            } catch (error) {
                finish(reject, error);
            }
        });
    }

    shutdown() {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.closed = true;
        this.activeTask?.cancel(new Error('Library scanner is shut down'));
        this.shutdownPromise = Promise.all([...this.terminations]).then(() => undefined);
        return this.shutdownPromise;
    }
}

let scannedGames = new Map();
let libraryScanPromise = null;
const libraryScanWorkerController = new LibraryScanWorkerController();

function readDirectoryEntriesBounded(directoryPath, predicate, maximumEntries) {
    const entries = [];
    let directory;
    try {
        directory = fs.opendirSync(directoryPath);
        while (entries.length < maximumEntries) {
            const entry = directory.readSync();
            if (!entry) break;
            if (predicate(entry)) entries.push(entry);
        }
    } catch (_) {
        return entries;
    } finally {
        try {
            directory?.closeSync();
        } catch (_) {
            // The provider may replace its directory during a scan.
        }
    }
    return entries;
}

function isReadableFile(filePath, maximumBytes = MAX_MANIFEST_BYTES) {
    if (!filePath) return false;
    try {
        const stats = fs.statSync(filePath);
        return stats.isFile() && stats.size > 0 && stats.size <= maximumBytes;
    } catch {
        return false;
    }
}

function isExistingDirectory(directoryPath) {
    if (!directoryPath) return false;
    try {
        return fs.statSync(directoryPath).isDirectory();
    } catch {
        return false;
    }
}

function isExistingFile(filePath) {
    if (!filePath) return false;
    try {
        return fs.statSync(filePath).isFile();
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

function createEpicLaunchUri(appName) {
    const normalizedAppName = String(appName || '').trim();
    if (!/^[A-Za-z0-9._-]{1,256}$/.test(normalizedAppName)) throw new Error('Invalid Epic app name');
    return `com.epicgames.launcher://apps/${encodeURIComponent(normalizedAppName)}?action=launch&silent=true`;
}

function makeLibraryId(platform, platformId) {
    return `${platform.toLowerCase()}:${String(platformId).trim()}`;
}

function resolveSteamInstallPath(steamAppsRoot, rawDirectoryName) {
    const directoryName = String(rawDirectoryName || '').trim();
    if (!directoryName || directoryName.length > 260 || path.isAbsolute(directoryName)) return null;
    const commonRoot = path.resolve(steamAppsRoot, 'common');
    const installPath = path.resolve(commonRoot, directoryName);
    const relative = path.relative(commonRoot, installPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    try {
        return isExistingDirectory(installPath) ? installPath : null;
    } catch {
        return null;
    }
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
            for (const entry of readDirectoryEntriesBounded(appRoot, () => true, MAX_STEAM_ART_ENTRIES)) {
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
        cover: findTrustedArtFile(coverCandidates, [cacheRoot]),
        hero: findTrustedArtFile(heroCandidates, [cacheRoot]),
        roots: [cacheRoot]
    };
}

function getSteamRootCandidates(scanContext = {}) {
    if (Array.isArray(scanContext.steamRootCandidates)) {
        const roots = new Set();
        for (const candidate of scanContext.steamRootCandidates) {
            if (roots.size >= MAX_LIBRARY_ROOTS) break;
            if (candidate && fs.existsSync(candidate)) roots.add(path.normalize(candidate));
        }
        return [...roots];
    }

    const home = os.homedir();
    const detectedRoot = scanContext.detectedSteamRoot;
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
            for (const key of Object.keys(folders).slice(0, MAX_LIBRARY_ROOTS)) {
                const entry = folders[key];
                const libraryPath = typeof entry === 'string' ? entry : entry?.path;
                if (libraryRoots.size >= MAX_LIBRARY_ROOTS) break;
                if (libraryPath && fs.existsSync(libraryPath)) libraryRoots.add(path.normalize(libraryPath));
            }
        } catch (error) {
            console.warn(`Could not parse Steam library manifest ${manifestPath}:`, error.message);
        }
    }

    return [...libraryRoots];
}

function scanSteamGames(scanContext = {}) {
    const games = [];
    let limitReached = false;
    for (const steamRoot of getSteamRootCandidates(scanContext)) {
        for (const libraryRoot of getSteamLibraryRoots(steamRoot)) {
            const steamAppsRoot = path.join(libraryRoot, 'steamapps');
            const manifests = readDirectoryEntriesBounded(
                steamAppsRoot,
                entry => entry.isFile() && /^appmanifest_\d+\.acf$/i.test(entry.name),
                MAX_PROVIDER_DIRECTORY_ENTRIES
            );

            for (const manifest of manifests) {
                if (games.length >= MAX_LIBRARY_GAMES) {
                    limitReached = true;
                    break;
                }
                const manifestPath = path.join(steamAppsRoot, manifest.name);
                if (!isReadableFile(manifestPath)) continue;
                try {
                    const appState = vdf.parse(fs.readFileSync(manifestPath, 'utf8')).AppState;
                    const appId = String(appState?.appid || '').trim();
                    const title = String(appState?.name || '').trim().slice(0, 200);
                    const installPath = resolveSteamInstallPath(steamAppsRoot, appState?.installdir);
                    if (!/^\d{1,12}$/.test(appId) || !title || !installPath
                        || STEAM_UTILITY_APP_IDS.has(appId) || appState?.type === 'Tool') continue;
                    const art = findSteamArt(steamRoot, appId);
                    games.push({
                        id: makeLibraryId('Steam', appId),
                        title,
                        platform: 'Steam',
                        platformId: appId,
                        installPath,
                        launchType: 'steam',
                        coverPath: art.cover,
                        heroPath: art.hero,
                        artRoots: art.roots
                    });
                } catch (error) {
                    console.warn(`Could not parse Steam app manifest ${manifestPath}:`, error.message);
                }
            }
            if (limitReached) break;
        }
        if (limitReached) break;
    }
    return games;
}

function scanEpicGames() {
    if (process.platform !== 'win32') return [];
    const manifestRoot = path.join(
        process.env.PROGRAMDATA || 'C:\\ProgramData',
        'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'
    );
    const entries = readDirectoryEntriesBounded(
        manifestRoot,
        entry => entry.isFile() && entry.name.endsWith('.item'),
        MAX_PROVIDER_DIRECTORY_ENTRIES
    );

    return entries.slice(0, MAX_LIBRARY_GAMES).flatMap((entry) => {
        const manifestPath = path.join(manifestRoot, entry.name);
        const manifest = readJsonFile(manifestPath);
        const appName = String(manifest?.AppName || '').trim();
        const title = String(manifest?.DisplayName || '').trim().slice(0, 200);
        const installPath = String(manifest?.InstallLocation || '').trim();
        if (!/^[A-Za-z0-9._-]{1,256}$/.test(appName) || !title || installPath.length > 4096
            || !isExistingDirectory(installPath)) return [];
        const normalizedInstallPath = path.normalize(installPath);
        const art = findEpicManifestArt(manifest, manifestPath, normalizedInstallPath);
        const namespace = String(manifest?.CatalogNamespace || manifest?.MainGameCatalogNamespace || '').trim();
        return [{
            id: makeLibraryId('Epic', appName),
            title,
            platform: 'Epic',
            platformId: appName,
            installPath: normalizedInstallPath,
            launchType: 'epic',
            coverPath: art.coverPath,
            heroPath: art.heroPath,
            artRoots: art.artRoots,
            artMetadata: { namespace, appName }
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

function getGogCacheRoots() {
    if (process.platform !== 'win32') return [];
    const galaxyRoot = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'GOG.com', 'Galaxy');
    return [galaxyRoot, path.join(galaxyRoot, 'webcache'), path.join(galaxyRoot, 'storage')]
        .filter(isExistingDirectory);
}

async function scanGogGames() {
    if (process.platform !== 'win32') return [];
    const roots = [
        new WinReg({ hive: WinReg.HKLM, key: '\\SOFTWARE\\WOW6432Node\\GOG.com\\Games' }),
        new WinReg({ hive: WinReg.HKLM, key: '\\SOFTWARE\\GOG.com\\Games' })
    ];
    const games = [];
    const cacheRoots = getGogCacheRoots();

    for (const root of roots) {
        for (const gameKey of (await registryKeys(root)).slice(0, MAX_PROVIDER_DIRECTORY_ENTRIES)) {
            if (games.length >= MAX_LIBRARY_GAMES) break;
            const values = await registryValues(gameKey);
            const registryData = Object.fromEntries(values.map(value => [value.name.toLowerCase(), value.value]));
            const platformId = path.basename(gameKey.key);
            const title = String(registryData.gamename || registryData.gameid || '').trim().slice(0, 200);
            const installPath = String(registryData.path || '').trim();
            const executable = String(registryData.exe || '').trim();
            if (!/^\d{1,20}$/.test(platformId) || !title || installPath.length > 4096
                || !isExistingDirectory(installPath)) continue;
            const normalizedInstallPath = path.normalize(installPath);
            const art = findGogLocalArt(registryData, platformId, normalizedInstallPath, cacheRoots);
            games.push({
                id: makeLibraryId('GOG', platformId),
                title,
                platform: 'GOG',
                platformId,
                installPath: normalizedInstallPath,
                launchType: 'gog',
                executable: isExistingFile(executable) ? path.normalize(executable) : null,
                coverPath: art.coverPath,
                heroPath: art.heroPath,
                artRoots: art.artRoots
            });
        }
        if (games.length >= MAX_LIBRARY_GAMES) break;
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

function getBattleNetArtLocale() {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
    const [language, region] = locale.replace('_', '-').split('-');
    return language && region ? `${language.toLowerCase()}${region.toUpperCase()}` : 'default';
}

function scanBattleNetGames() {
    if (process.platform !== 'win32') return [];
    const configPath = path.join(process.env.APPDATA || '', 'Battle.net', 'Battle.net.config');
    const defaultInstallPath = String(readJsonFile(configPath)?.Client?.Install?.DefaultInstallPath || '').trim();
    if (!defaultInstallPath || !isExistingDirectory(defaultInstallPath)) return [];
    const launcherPath = findBattleNetLauncher();
    const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'Battle.net', 'Cache');
    const artLocale = getBattleNetArtLocale();

    return BATTLE_NET_GAMES.flatMap((definition) => {
        const installPath = definition.folders
            .map(folder => path.join(defaultInstallPath, folder))
            .find(isExistingDirectory);
        if (!installPath) return [];
        const art = findBattleNetLocalArt(
            cacheRoot,
            definition.artTokens,
            definition.rejectArtTokens || [],
            artLocale
        );
        return [{
            id: makeLibraryId('Blizzard', definition.productCode),
            title: definition.title,
            platform: 'Blizzard',
            platformId: definition.productCode,
            installPath: path.normalize(installPath),
            launchType: 'battlenet',
            launcherPath,
            coverPath: art.coverPath,
            heroPath: art.heroPath,
            artRoots: art.artRoots,
            artMetadata: { officialPage: definition.officialPage }
        }];
    });
}

function toRendererGame(game) {
    const hasFallback = hasOfficialArtFallback(game);
    return {
        id: game.id,
        title: game.title,
        platform: game.platform,
        platformId: game.platformId,
        installPath: game.installPath,
        hasCover: Boolean(game.coverPath) || hasFallback,
        hasHero: Boolean(game.heroPath) || hasFallback
    };
}

async function scanLibraryProviders(scanContext = {}) {
    const providers = [
        ['Steam', () => scanSteamGames(scanContext)],
        ['Epic', scanEpicGames],
        ['GOG', scanGogGames],
        ['Battle.net', scanBattleNetGames]
    ];
    const requestedProviders = Array.isArray(scanContext.providerNames)
        ? new Set(scanContext.providerNames)
        : null;
    const selectedProviders = requestedProviders
        ? providers.filter(([provider]) => requestedProviders.has(provider))
        : providers;
    const results = await Promise.all(selectedProviders.map(async ([provider, scan]) => {
        try {
            const games = await scan();
            return Array.isArray(games) ? games.slice(0, MAX_LIBRARY_GAMES) : [];
        } catch (error) {
            console.warn(`Could not scan the ${provider} library:`, error.message);
            return [];
        }
    }));
    return results.flat().slice(0, MAX_LIBRARY_GAMES);
}

function getLibraryScanWorkerPath() {
    const mainDirectory = path.basename(__dirname) === 'services' ? path.dirname(__dirname) : __dirname;
    return path.join(mainDirectory, 'libraryScanWorker.js');
}

function runLibraryScanWorker(scanContext) {
    return libraryScanWorkerController.run(scanContext);
}

function createLibraryScanContext(overrides = {}) {
    if (Array.isArray(overrides.steamRootCandidates)) return overrides;
    const detectedSteamRoot = require('../gameData').getGameData().steamPath;
    return { ...overrides, detectedSteamRoot };
}

async function performLibraryScan(scanContext = {}) {
    const scanned = await runLibraryScanWorker(createLibraryScanContext(scanContext));
    scannedGames = new Map(scanned.slice(0, MAX_LIBRARY_GAMES).map(game => [game.id, game]));
    return [...scannedGames.values()]
        .map(toRendererGame)
        .sort((left, right) => left.title.localeCompare(right.title, undefined, { numeric: true }));
}

function scanLibraryGames(scanContext = {}) {
    if (libraryScanWorkerController.isClosed()) {
        return Promise.reject(new Error('Library scanner is shut down'));
    }
    if (libraryScanPromise) return libraryScanPromise;
    libraryScanPromise = performLibraryScan(scanContext)
        .finally(() => { libraryScanPromise = null; });
    return libraryScanPromise;
}

function shutdownLibraryScanner() {
    return libraryScanWorkerController.shutdown();
}

function launchDetached(executable, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
        });
        child.once('error', reject);
        child.once('spawn', () => {
            child.unref();
            resolve();
        });
    });
}

async function getLibraryGameArt(gameId, artType) {
    const game = scannedGames.get(String(gameId));
    if (!game) return null;
    return await getGameArtwork(game, artType);
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
        await launchDetached(game.launcherPath, [`--exec=launch ${game.platformId}`]);
    } else if (game.launchType === 'battlenet') {
        await shell.openExternal(`battlenet://${encodeURIComponent(game.platformId)}`);
    } else {
        throw new Error('This game provider does not support launching yet');
    }

    return { launched: true, gameId: game.id };
}

async function openLibraryGameDirectory(gameId) {
    const game = scannedGames.get(String(gameId));
    if (!game || !isExistingDirectory(game.installPath)) {
        throw new Error('Game installation directory is unavailable');
    }
    const errorMessage = await shell.openPath(game.installPath);
    if (errorMessage) throw new Error(errorMessage);
    return true;
}

module.exports = {
    LibraryScanWorkerController,
    MAX_LIBRARY_GAMES,
    createEpicLaunchUri,
    createSteamArtUrls,
    createSteamLaunchUri,
    getLibraryGameArt,
    launchLibraryGame,
    openLibraryGameDirectory,
    resolveSteamInstallPath,
    runLibraryScanWorker,
    scanLibraryProviders,
    scanLibraryGames,
    shutdownLibraryScanner
};
