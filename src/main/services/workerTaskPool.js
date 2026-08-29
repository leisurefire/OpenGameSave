class WorkerTaskPool {
    constructor({ createWorker, maxWorkers = 2, maxQueue = 64, name = 'Worker' }) {
        if (typeof createWorker !== 'function') throw new TypeError('createWorker must be a function');
        if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1) {
            throw new RangeError('maxWorkers must be a positive integer');
        }
        if (!Number.isSafeInteger(maxQueue) || maxQueue < 0) {
            throw new RangeError('maxQueue must be a non-negative integer');
        }

        this.createWorker = createWorker;
        this.maxWorkers = maxWorkers;
        this.maxQueue = maxQueue;
        this.name = name;
        this.workers = new Set();
        this.queue = [];
        this.closed = false;
        this.shutdownPromise = null;
    }

    run(message, onMessage = null) {
        if (this.closed) return Promise.reject(new Error(`${this.name} pool is shut down`));

        const hasImmediateCapacity = [...this.workers].some(state => state.current === null)
            || this.workers.size < this.maxWorkers;
        if (!hasImmediateCapacity && this.queue.length >= this.maxQueue) {
            return Promise.reject(new Error(`${this.name} queue is full`));
        }

        return new Promise((resolve, reject) => {
            this.queue.push({ message, onMessage, resolve, reject });
            this.drain();
        });
    }

    createWorkerState() {
        const worker = this.createWorker();
        const state = { worker, current: null };
        this.workers.add(state);

        worker.on('message', message => this.handleMessage(state, message));
        worker.once('error', error => this.handleCrash(state, error));
        worker.once('exit', code => this.handleCrash(
            state,
            new Error(`${this.name} stopped before returning a result (exit code ${code})`)
        ));
        return state;
    }

    drain() {
        if (this.closed) return;

        while (this.queue.length > 0) {
            let state = [...this.workers].find(candidate => candidate.current === null);
            if (!state && this.workers.size < this.maxWorkers) {
                try {
                    state = this.createWorkerState();
                } catch (error) {
                    this.queue.shift().reject(error);
                    continue;
                }
            }
            if (!state) return;

            const task = this.queue.shift();
            state.current = task;
            try {
                state.worker.postMessage(task.message);
            } catch (error) {
                state.current = null;
                task.reject(error);
            }
        }
    }

    handleMessage(state, message) {
        if (!this.workers.has(state) || !state.current) return;
        const task = state.current;

        if (message?.type === 'done') {
            state.current = null;
            task.resolve(message.result);
            this.drain();
        } else if (message?.type === 'error') {
            const error = new Error(message.error?.message || `${this.name} task failed`);
            error.stack = message.error?.stack || error.stack;
            state.current = null;
            task.reject(error);
            this.drain();
        } else if (typeof task.onMessage === 'function') {
            try {
                const observerResult = task.onMessage(message);
                Promise.resolve(observerResult).catch((error) => {
                    console.error(`${this.name} progress observer failed:`, error);
                });
            } catch (error) {
                // Progress delivery is observational. A stale or destroyed UI
                // must not abort the underlying worker operation or escape from
                // the EventEmitter callback as an uncaught main-process error.
                console.error(`${this.name} progress observer failed:`, error);
            }
        }
    }

    handleCrash(state, error) {
        if (!this.workers.delete(state)) return;
        if (state.current) {
            state.current.reject(error instanceof Error ? error : new Error(String(error)));
            state.current = null;
        }
        try {
            Promise.resolve(state.worker.terminate()).catch(() => undefined);
        } catch {
            // The worker has already stopped.
        }
        if (this.closed) return;
        // Only replace a crashed worker when work is waiting. Eagerly spawning
        // here creates an infinite crash/restart loop when the worker bundle or
        // runtime is systematically broken.
        this.drain();
    }

    shutdown() {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.closed = true;
        const shutdownError = new Error(`${this.name} pool is shut down`);
        for (const task of this.queue.splice(0)) task.reject(shutdownError);

        const states = [...this.workers];
        this.workers.clear();
        const terminations = states.map((state) => {
            if (state.current) {
                state.current.reject(shutdownError);
                state.current = null;
            }
            try {
                return Promise.resolve(state.worker.terminate()).catch(() => undefined);
            } catch {
                return Promise.resolve();
            }
        });
        this.shutdownPromise = Promise.all(terminations).then(() => undefined);
        return this.shutdownPromise;
    }
}

module.exports = { WorkerTaskPool };
