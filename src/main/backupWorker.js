const { parentPort } = require('worker_threads');

const { setWorkerContext } = require('./services/backupWorkerContext');
const {
    getAllGameDataFromDB,
    getGameDataFromDB
} = require('./services/backupWorkerDatabase');
const {
    backupGame,
    getGameDataForRestore,
    getRestoreConflictTimes,
    restorePaths
} = require('./services/backupWorkerOperations');

const TASK_HANDLERS = {
    getGameDataFromDB: payload => getGameDataFromDB(payload || {}),
    getAllGameDataFromDB: () => getAllGameDataFromDB(),
    backupGame: payload => backupGame(payload.gameObj),
    getGameDataForRestore: payload => getGameDataForRestore(payload || {}),
    restorePaths: payload => restorePaths(payload.pathsToRestore || []),
    getRestoreConflictTimes: payload => getRestoreConflictTimes(payload.pathsToCheck || [])
};

async function runTask(message) {
    const handler = TASK_HANDLERS[message.task];
    if (!handler) throw new Error(`Unknown backup worker task: ${message.task}`);
    setWorkerContext(message.context, response => parentPort.postMessage(response));
    return handler(message.payload || {});
}

parentPort.on('message', async (message) => {
    try {
        parentPort.postMessage({ type: 'done', result: await runTask(message) });
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
