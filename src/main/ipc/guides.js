const { ipcMain } = require('electron');

const { getGameGuideCatalog } = require('../services/guideService');

function registerGuideIpc({ ensureGameDataReady }) {
    ipcMain.handle('get-game-guide-catalog', async () => {
        await ensureGameDataReady();
        return await getGameGuideCatalog();
    });
}

module.exports = { registerGuideIpc };
