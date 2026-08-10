const { normalizeWikiId } = require('./validation');

const activeGameOperations = new Map();
let activeGlobalOperation = null;

function acquireGameOperation(wikiId, operation) {
    const safeWikiId = normalizeWikiId(wikiId);
    const safeOperation = String(operation || '').slice(0, 64);
    if (!safeOperation) throw new Error('Invalid game operation');
    if (activeGlobalOperation) {
        throw new Error(`Backup storage is busy with ${activeGlobalOperation}`);
    }

    const currentOperation = activeGameOperations.get(safeWikiId);
    if (currentOperation) {
        throw new Error(`Game ${safeWikiId} is busy with ${currentOperation}`);
    }
    activeGameOperations.set(safeWikiId, safeOperation);

    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (activeGameOperations.get(safeWikiId) === safeOperation) {
            activeGameOperations.delete(safeWikiId);
        }
    };
}

function acquireGlobalOperation(operation) {
    const safeOperation = String(operation || '').slice(0, 64);
    if (!safeOperation) throw new Error('Invalid global operation');
    if (activeGlobalOperation || activeGameOperations.size > 0) {
        throw new Error(`Backup storage is busy with ${activeGlobalOperation || 'a game operation'}`);
    }
    activeGlobalOperation = safeOperation;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (activeGlobalOperation === safeOperation) activeGlobalOperation = null;
    };
}

module.exports = { acquireGameOperation, acquireGlobalOperation };
