const fs = require('fs');
const fsOriginal = require('original-fs');
const os = require('os');
const path = require('path');

const vdf = require('vdf-parser');
const WinReg = require('winreg');
const yaml = require('js-yaml');

const { getLatestModificationTimeAsync } = require('./fileSystemUtils');
const { getSteamAccountId } = require('./steamAccount');

class GameData {
    constructor() {
        this.steamPath = null;
        this.ubisoftPath = null;

        this.currentSteamUserId64 = null;
        this.currentSteamUserId3 = null;
        this.currentSteamUserName = null;
        this.currentUbisoftUserId = null;
        this.currentEpicUserId = null;
        this.currentXboxUserId = null;
        this.currentRockStarUserId = null;

        this.detectedGamePaths = [];
        this.initialized = false;
        this.initializePromise = null;
    }

    getRegistryValue(hive, key, valueName) {
        return new Promise((resolve) => {
            const regKey = new WinReg({
                hive: hive,
                key: key
            });

            regKey.get(valueName, (err, item) => {
                if (err) {
                    resolve('');
                } else {
                    resolve(item.value);
                }
            });
        });
    }

    async initialize() {
        if (this.initialized) {
            return;
        }

        if (!this.initializePromise) {
            this.initializePromise = this._initialize().catch((error) => {
                this.initializePromise = null;
                throw error;
            });
        }

        return this.initializePromise;
    }

    async _initialize() {
        if (process.platform === 'win32') {
            [this.steamPath, this.ubisoftPath] = await Promise.all([
                this.getRegistryValue(
                    WinReg.HKLM,
                    '\\SOFTWARE\\WOW6432Node\\Valve\\Steam',
                    'InstallPath'
                ),
                this.getRegistryValue(
                    WinReg.HKLM,
                    '\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher',
                    'InstallDir'
                )
            ]);

            // Get current logged in user ids
            await this.getCurrentUserIds();
        }

        this.initialized = true;
    }

    async getCurrentUserIds() {
        if (this.steamPath) {
            // Prefer Steam's explicit auto-login account, then fall back to the
            // most recently used account for installations without AutoLogin.
            const loginUsersPath = path.join(this.steamPath, 'config', 'loginusers.vdf');
            if (fs.existsSync(loginUsersPath)) {
                try {
                    const vdfContent = fs.readFileSync(loginUsersPath, 'utf-8');
                    const parsedData = vdf.parse(vdfContent);

                    if (parsedData.users) {
                        const accounts = Object.entries(parsedData.users);
                        const selectedAccount = accounts.find(([, account]) => Number(account.AutoLogin) === 1)
                            || accounts.find(([, account]) => Number(account.MostRecent) === 1);

                        if (selectedAccount) {
                            const [steamId64, accountData] = selectedAccount;
                            this.currentSteamUserId64 = steamId64;
                            this.currentSteamUserId3 = getSteamAccountId(steamId64);
                            this.currentSteamUserName = accountData.PersonaName;
                        }
                    } else {
                        console.log(`No users found in ${loginUsersPath}`);
                    }
                } catch (e) {
                    console.log('Error reading or parsing Steam loginusers.vdf file:', e);
                }
            } else {
                console.log(`Steam loginusers.vdf file not found at: ${loginUsersPath}`);
            }

            // SteamID64 normally gives us the account ID directly. Retain the
            // older userdata scan as a compatibility fallback for malformed or
            // non-standard loginusers.vdf entries.
            if (!this.currentSteamUserId3) {
                const userdataPath = path.join(this.steamPath, 'userdata');
                try {
                    const userDirectories = fs.readdirSync(userdataPath, { withFileTypes: true })
                        .filter(dirent => dirent.isDirectory())
                        .map(dirent => dirent.name);

                    for (const userId3 of userDirectories) {
                        const configPath = path.join(userdataPath, userId3, 'config', 'localconfig.vdf');
                        if (fs.existsSync(configPath)) {
                            const localConfigContent = fs.readFileSync(configPath, 'utf-8');
                            const localConfigData = vdf.parse(localConfigContent);

                            if (localConfigData.UserLocalConfigStore && localConfigData.UserLocalConfigStore.friends) {
                                const personaName = localConfigData.UserLocalConfigStore.friends.PersonaName;
                                if (personaName === this.currentSteamUserName) {
                                    this.currentSteamUserId3 = userId3;
                                    break;
                                }
                            } else {
                                console.log(`No persona name found in ${configPath}`);
                            }
                        } else {
                            console.log(`Steam localconfig.vdf file not found at: ${configPath}`);
                        }
                    }
                } catch (e) {
                    console.log('Error reading or parsing Steam userdata directory:', e);
                }
            }
        } else {
            console.log('Steam not installed');
        }

        // Get current Ubisoft user id
        const saveGamesPath = this.ubisoftPath ? path.join(this.ubisoftPath, 'savegames') : null;
        if (saveGamesPath && fs.existsSync(saveGamesPath)) {
            try {
                const userFolders = fs.readdirSync(saveGamesPath, { withFileTypes: true })
                    .filter(dirent => dirent.isDirectory())
                    .map(dirent => dirent.name);

                let latestUserId = null;
                let latestTime = 0;

                for (const userId of userFolders) {
                    const userFolderPath = path.join(saveGamesPath, userId);
                    const userFolderTime = await getLatestModificationTimeAsync(userFolderPath, fsOriginal);

                    if (userFolderTime > latestTime) {
                        latestTime = userFolderTime;
                        latestUserId = userId;
                    }
                }
                this.currentUbisoftUserId = latestUserId;
            } catch (e) {
                console.log('Error reading or parsing Ubisoft savegames directory:', e);
            }
        }

        // Get current Epic user id
        const epicDataPath = path.join(
            process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local'),
            'EpicGamesLauncher', 'Saved', 'Data'
        );
        if (fs.existsSync(epicDataPath)) {
            try {
                const files = fs.readdirSync(epicDataPath, { withFileTypes: true })
                    .filter(dirent => dirent.isFile())
                    .map(dirent => dirent.name);

                let latestUserId = null;
                let latestTime = 0;

                for (const fileName of files) {
                    const filePath = path.join(epicDataPath, fileName);
                    const fileModTime = await getLatestModificationTimeAsync(filePath, fsOriginal);

                    if (fileModTime > latestTime) {
                        latestTime = fileModTime;
                        // remove 'OC_' prefix if present and remove .dat extension
                        const idMatch = fileName.match(/^(?:OC_)?([a-f0-9]+)\.dat$/i);
                        if (idMatch) {
                            latestUserId = idMatch[1];
                        }
                    }
                }
                this.currentEpicUserId = latestUserId;
            } catch (e) {
                console.log('Error reading or parsing Epic user data directory:', e);
            }
        } else {
            console.log(`No Epic user data found at: ${epicDataPath}`);
        }

        // Get current Xbox user id
        this.currentXboxUserId = await this.getRegistryValue(
            WinReg.HKCU,
            '\\Software\\Microsoft\\XboxLive',
            'Xuid'
        );

        // Get current RockStar user id
        const rStarProfilePath = path.join(process.env.USERPROFILE || os.homedir(), "Documents\\Rockstar Games\\Social Club\\Profiles");
        if (fs.existsSync(rStarProfilePath)) {
            try {
                const userFolders = fs.readdirSync(rStarProfilePath, { withFileTypes: true })
                    .filter(dirent => dirent.isDirectory())
                    .map(dirent => dirent.name);

                let latestUserId = null;
                let latestTime = 0;

                for (const userId of userFolders) {
                    const userFolderPath = path.join(rStarProfilePath, userId);
                    const userFolderTime = await getLatestModificationTimeAsync(userFolderPath, fsOriginal);

                    if (userFolderTime > latestTime) {
                        latestTime = userFolderTime;
                        latestUserId = userId;
                    }
                }
                this.currentRockStarUserId = latestUserId;
            } catch (e) {
                console.log('Error reading or parsing Rockstar savegames directory:', e);
            }
        } else {
            console.log(`No Rockstar users found at: ${rStarProfilePath}`);
        }

    }

    getAllUserIds() {
        return {
            steamId64: this.currentSteamUserId64,
            steamId3: this.currentSteamUserId3,
            ubisoftId: this.currentUbisoftUserId,
            epicId: this.currentEpicUserId,
            xboxId: this.currentXboxUserId,
            rockStarId: this.currentRockStarUserId,
        };
    }

    async detectGamePaths() {
        await this.initialize();
        this.detectedGamePaths = [];

        if (process.platform === 'win32') {
            // Detect Steam game installation folders
            const steamVdfPath = path.join(this.steamPath, 'config', 'libraryfolders.vdf');
            if (fs.existsSync(steamVdfPath)) {
                try {
                    const vdfContent = fs.readFileSync(steamVdfPath, 'utf-8');
                    const parsedData = vdf.parse(vdfContent);

                    for (const key in parsedData.libraryfolders) {
                        if (Object.prototype.hasOwnProperty.call(parsedData.libraryfolders, key)) {
                            const folder = parsedData.libraryfolders[key];

                            // Add the "path" to detectedGamePaths
                            if (folder.path) {
                                const normalizedPath = path.normalize(path.join(folder.path, 'steamapps', 'common'));
                                if (fs.existsSync(normalizedPath)) {
                                    this.detectedGamePaths.push(normalizedPath);
                                }
                            }

                        }
                    }
                } catch (e) {
                    console.log('Error reading or parsing Steam libraryfolders.vdf file:', e);
                }
            } else {
                console.log(`Steam libraryfolders.vdf file not found at: ${steamVdfPath}`);
            }

            // Detect Ubisoft game installation folders
            const ubisoftSettingsPath = path.join(
                process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local'),
                'Ubisoft Game Launcher', 'settings.yaml'
            );
            if (fs.existsSync(ubisoftSettingsPath)) {
                try {
                    const fileContents = fs.readFileSync(ubisoftSettingsPath, 'utf8');
                    const settings = yaml.load(fileContents);
                    const gameInstallationPath = settings?.misc?.game_installation_path;

                    if (gameInstallationPath && fs.existsSync(gameInstallationPath)) {
                        this.detectedGamePaths.push(path.normalize(gameInstallationPath));
                    }
                } catch (e) {
                    console.log('Error reading or parsing Ubisoft YAML file:', e);
                }
            } else {
                console.log(`Ubisoft settings.yaml file not found at ${ubisoftSettingsPath}`);
            }

            // Detect Epic game installation folders
            const epicManifestsPath = path.join(
                process.env.PROGRAMDATA || 'C:\\ProgramData',
                'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat'
            );
            if (fs.existsSync(epicManifestsPath)) {
                try {
                    const manifestFile = fs.readFileSync(epicManifestsPath, 'utf-8');
                    const manifest = JSON.parse(manifestFile);

                    if (manifest.InstallationList && Array.isArray(manifest.InstallationList)) {
                        const epicBasePaths = new Set();

                        for (const installation of manifest.InstallationList) {
                            if (installation.InstallLocation) {
                                // Get parent directory
                                const basePath = path.dirname(installation.InstallLocation);
                                if (basePath) {
                                    epicBasePaths.add(path.normalize(basePath));
                                }
                            }
                        }

                        // Add all unique base paths
                        for (const basePath of epicBasePaths) {
                            if (fs.existsSync(basePath)) {
                                this.detectedGamePaths.push(basePath);
                            }
                        }
                    }
                } catch (e) {
                    console.log('Error reading or parsing Epic LauncherInstalled.dat file:', e);
                }
            } else {
                console.log(`Epic LauncherInstalled.dat file not found at ${epicManifestsPath}`);
            }

            // Detect EA game installation folders
            const eaSettingsDirectory = path.join(
                process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local'),
                'Electronic Arts', 'EA Desktop'
            );
            const eaSettingsFile = fs.existsSync(eaSettingsDirectory)
                ? fs.readdirSync(eaSettingsDirectory, { withFileTypes: true })
                    .find(entry => entry.isFile() && /^user_.+\.ini$/i.test(entry.name))
                : null;
            if (eaSettingsFile) {
                try {
                    const eaSettingsPath = path.join(eaSettingsDirectory, eaSettingsFile.name);
                    const fileContents = fs.readFileSync(eaSettingsPath, 'utf8');
                    const lines = fileContents.split('\n');

                    for (const line of lines) {
                        if (line.startsWith('user.downloadinplacedir=')) {
                            const downloadPath = line.split('=')[1].trim();
                            if (downloadPath && fs.existsSync(downloadPath)) {
                                this.detectedGamePaths.push(path.normalize(downloadPath));
                            }
                        }
                    }
                } catch (e) {
                    console.log('Error reading or parsing EA user_*.ini file:', e);
                }
            } else {
                console.log(`EA user_*.ini file not found at ${eaSettingsDirectory}`);
            }

            // Detect GOG game installation folders
            const gogConfigPath = path.join(
                process.env.PROGRAMDATA || 'C:\\ProgramData',
                'GOG.com', 'Galaxy', 'config.json'
            );
            if (fs.existsSync(gogConfigPath)) {
                try {
                    const configFile = fs.readFileSync(gogConfigPath, 'utf-8');
                    const config = JSON.parse(configFile);
                    const libraryPath = config.libraryPath;
                    if (libraryPath && fs.existsSync(libraryPath)) {
                        this.detectedGamePaths.push(path.normalize(libraryPath));
                    }
                } catch (e) {
                    console.log('Error reading or parsing GOG config.json file:', e);
                }
            } else {
                console.log(`GOG config.json file not found at ${gogConfigPath}`);
            }

            // Detect Battle.net game installation folders
            const battleNetConfigPath = path.join(
                process.env.APPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Roaming'),
                'Battle.net', 'Battle.net.config'
            );
            if (fs.existsSync(battleNetConfigPath)) {
                try {
                    const configFile = fs.readFileSync(battleNetConfigPath, 'utf-8');
                    const config = JSON.parse(configFile);

                    const defaultInstallPath = config?.Client?.Install?.DefaultInstallPath;
                    if (defaultInstallPath && fs.existsSync(defaultInstallPath)) {
                        this.detectedGamePaths.push(path.normalize(defaultInstallPath));
                    }
                } catch (e) {
                    console.log('Error reading or parsing Battle.net configuration file:', e);
                }
            } else {
                console.log(`Battle.net config file not found at ${battleNetConfigPath}`);
            }

            this.detectedGamePaths = [...new Set(this.detectedGamePaths)];
        }
    }
}

let gameData = new GameData();

module.exports = {
    getGameData: () => gameData,
    initializeGameData: async () => await gameData.initialize(),
    detectGamePaths: async () => await gameData.detectGamePaths(),
    getAllUserIds: () => gameData.getAllUserIds()
};
