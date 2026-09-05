const { parentPort } = require('worker_threads');

const { scanLibraryProviders } = require('./services/libraryService');
const { enrichLibraryGamesWithGuides } = require('./services/guideService');

parentPort.on('message', async ({ scanContext }) => {
    try {
        let games = await scanLibraryProviders(scanContext || {});
        if (scanContext?.guideDatabasePath) {
            games = enrichLibraryGamesWithGuides(games, scanContext.guideDatabasePath);
        }
        games = [...new Map(games.map(game => [game.id, game])).values()];
        const titleCollator = new Intl.Collator(undefined, { numeric: true });
        games.sort((left, right) => titleCollator.compare(left.title, right.title));
        parentPort.postMessage({ type: 'done', games });
    } catch (error) {
        parentPort.postMessage({
            type: 'error',
            error: {
                message: error.message || String(error),
                stack: error.stack || ''
            }
        });
    }
});
