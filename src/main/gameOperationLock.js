const { normalizeWikiId } = require('./validation');

class GameOperationLock {
    constructor() {
        this.activeGameOperations = new Map();
        this.activeGlobalOperation = null;
        this.acceptingOperations = true;
        this.idleWaiters = new Set();
    }

    acquireGame(wikiId, operation) {
        const safeWikiId = normalizeWikiId(wikiId);
        const safeOperation = String(operation || '').slice(0, 64);
        if (!safeOperation) throw new Error('Invalid game operation');
        if (!this.acceptingOperations) throw new Error('Application is shutting down');
        if (this.activeGlobalOperation) {
            throw new Error(`Backup storage is busy with ${this.activeGlobalOperation}`);
        }

        const currentOperation = this.activeGameOperations.get(safeWikiId);
        if (currentOperation) {
            throw new Error(`Game ${safeWikiId} is busy with ${currentOperation}`);
        }
        this.activeGameOperations.set(safeWikiId, safeOperation);

        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (this.activeGameOperations.get(safeWikiId) === safeOperation) {
                this.activeGameOperations.delete(safeWikiId);
                this.notifyIdleWaiters();
            }
        };
    }

    acquireGlobal(operation) {
        const safeOperation = String(operation || '').slice(0, 64);
        if (!safeOperation) throw new Error('Invalid global operation');
        if (!this.acceptingOperations) throw new Error('Application is shutting down');
        if (this.activeGlobalOperation || this.activeGameOperations.size > 0) {
            throw new Error(`Backup storage is busy with ${this.activeGlobalOperation || 'a game operation'}`);
        }
        this.activeGlobalOperation = safeOperation;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (this.activeGlobalOperation === safeOperation) {
                this.activeGlobalOperation = null;
                this.notifyIdleWaiters();
            }
        };
    }

    beginShutdown() {
        this.acceptingOperations = false;
        this.notifyIdleWaiters();
    }

    isIdle(ignoreGlobal = false) {
        return this.activeGameOperations.size === 0 && (ignoreGlobal || !this.activeGlobalOperation);
    }

    waitForIdle({ ignoreGlobal = false } = {}) {
        if (this.isIdle(ignoreGlobal)) return Promise.resolve();
        return new Promise((resolve) => {
            this.idleWaiters.add({ resolve, ignoreGlobal });
        });
    }

    notifyIdleWaiters() {
        for (const waiter of this.idleWaiters) {
            if (!this.isIdle(waiter.ignoreGlobal)) continue;
            this.idleWaiters.delete(waiter);
            waiter.resolve();
        }
    }
}

const operationLock = new GameOperationLock();

module.exports = {
    GameOperationLock,
    acquireGameOperation: (...args) => operationLock.acquireGame(...args),
    acquireGlobalOperation: (...args) => operationLock.acquireGlobal(...args),
    beginOperationShutdown: () => operationLock.beginShutdown(),
    waitForOperationsToFinish: options => operationLock.waitForIdle(options)
};
