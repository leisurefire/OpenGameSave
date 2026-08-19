const { ipcMain } = require('electron');

const {
    getGameGuideByWikiId,
    getGameGuideCatalog,
    searchGameGuides
} = require('../services/guideService');

function registerGuideIpc({ ensureGameDataReady }) {
    ipcMain.handle('get-game-guide-catalog', async () => {
        await ensureGameDataReady();
        return await getGameGuideCatalog();
    });
    ipcMain.handle('search-game-guides', async (event, query) => {
        await ensureGameDataReady();
        return await searchGameGuides(query);
    });
    ipcMain.handle('get-game-guide', async (event, wikiPageId) => {
        await ensureGameDataReady();
        return await getGameGuideByWikiId(wikiPageId);
    });
}

module.exports = { registerGuideIpc };
