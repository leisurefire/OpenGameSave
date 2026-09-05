const { ipcMain } = require('electron');

const {
    getLibraryGameArt,
    launchLibraryGame,
    openLibraryGameDirectory,
    scanLibraryGames
} = require('../services/libraryService');

function registerLibraryIpc({ ensureGameDataReady }) {
    ipcMain.handle('get-library-games', async () => {
        await ensureGameDataReady();
        return await scanLibraryGames();
    });
    ipcMain.handle('get-library-game-art', (event, gameId, artType) => (
        getLibraryGameArt(gameId, artType)
    ));
    ipcMain.handle('launch-library-game', (event, gameId) => launchLibraryGame(gameId));
    ipcMain.handle('open-library-game-directory', (event, gameId) => openLibraryGameDirectory(gameId));
}

module.exports = { registerLibraryIpc };
