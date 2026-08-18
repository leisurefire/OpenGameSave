let context = null;
/** @type {(message: {type: string, value: number}) => void} */
let progressReporter = () => {};

/**
 * @param {*} nextContext
 * @param {(message: {type: string, value: number}) => void} [nextProgressReporter]
 */
function setWorkerContext(nextContext, nextProgressReporter = () => {}) {
    context = nextContext;
    progressReporter = nextProgressReporter;
}

function getContext() {
    if (!context) throw new Error('Backup worker context has not been initialized');
    return context;
}

function getSettings() {
    return getContext().settings;
}

function getGameData() {
    return getContext().gameData || {};
}

function getAllUserIds() {
    return getContext().allUserIds || {};
}

function reportProgress(value) {
    progressReporter({ type: 'progress', value });
}

module.exports = {
    getAllUserIds,
    getContext,
    getGameData,
    getSettings,
    reportProgress,
    setWorkerContext
};
