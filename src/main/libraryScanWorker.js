const { parentPort } = require('worker_threads');

const { scanLibraryProviders } = require('./services/libraryService');

parentPort.on('message', async ({ scanContext }) => {
    try {
        const games = await scanLibraryProviders(scanContext || {});
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
