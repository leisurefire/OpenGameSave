const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Worker } = require('node:worker_threads');

const { WorkerTaskPool } = require('../src/main/services/workerTaskPool');

class FakeWorker extends EventEmitter {
    constructor() {
        super();
        this.messages = [];
        this.terminateCalls = 0;
    }

    postMessage(message) {
        this.messages.push(message);
    }

    terminate() {
        this.terminateCalls += 1;
        return Promise.resolve(0);
    }

    respond(message) {
        this.emit('message', message);
    }
}

function createPool(options = {}) {
    const createdWorkers = [];
    const pool = new WorkerTaskPool({
        createWorker: () => {
            const worker = new FakeWorker();
            createdWorkers.push(worker);
            return worker;
        },
        maxWorkers: options.maxWorkers ?? 2,
        maxQueue: options.maxQueue ?? 4,
        name: 'Test worker'
    });
    return { createdWorkers, pool };
}

test('completed tasks reuse a worker and preserve progress delivery', async () => {
    const { createdWorkers, pool } = createPool();
    const progress = [];

    const first = pool.run({ task: 'first' }, message => progress.push(message.value));
    assert.equal(createdWorkers.length, 1);
    createdWorkers[0].respond({ type: 'progress', value: 25 });
    createdWorkers[0].respond({ type: 'done', result: 'first-result' });
    assert.equal(await first, 'first-result');

    const second = pool.run({ task: 'second' });
    assert.equal(createdWorkers.length, 1);
    assert.deepEqual(createdWorkers[0].messages, [{ task: 'first' }, { task: 'second' }]);
    createdWorkers[0].respond({ type: 'done', result: 'second-result' });

    assert.equal(await second, 'second-result');
    assert.deepEqual(progress, [25]);
    await pool.shutdown();
});

test('a throwing progress observer cannot abort the task or poison the worker', async () => {
    const { createdWorkers, pool } = createPool({ maxWorkers: 1 });
    const originalConsoleError = console.error;
    const observerErrors = [];
    console.error = (...args) => observerErrors.push(args);

    try {
        const first = pool.run({ task: 'first' }, () => {
            throw new Error('detached progress window');
        });
        assert.doesNotThrow(() => {
            createdWorkers[0].respond({ type: 'progress', value: 50 });
        });
        createdWorkers[0].respond({ type: 'done', result: 'completed' });
        assert.equal(await first, 'completed');

        const second = pool.run({ task: 'second' });
        createdWorkers[0].respond({ type: 'done', result: 'reused' });
        assert.equal(await second, 'reused');
        assert.equal(createdWorkers.length, 1);
        assert.match(String(observerErrors[0]?.[1]?.message), /detached progress window/);
    } finally {
        console.error = originalConsoleError;
        await pool.shutdown();
    }
});

test('the pool runs at most two tasks and enforces its waiting queue bound', async () => {
    const { createdWorkers, pool } = createPool({ maxWorkers: 2, maxQueue: 1 });
    const first = pool.run({ task: 'first' });
    const second = pool.run({ task: 'second' });
    const queued = pool.run({ task: 'queued' });

    assert.equal(createdWorkers.length, 2);
    assert.deepEqual(createdWorkers.map(worker => worker.messages.length), [1, 1]);
    await assert.rejects(pool.run({ task: 'overflow' }), /queue is full/);

    createdWorkers[0].respond({ type: 'done', result: 1 });
    assert.equal(await first, 1);
    assert.deepEqual(createdWorkers[0].messages.map(message => message.task), ['first', 'queued']);
    createdWorkers[0].respond({ type: 'done', result: 3 });
    createdWorkers[1].respond({ type: 'done', result: 2 });
    assert.equal(await queued, 3);
    assert.equal(await second, 2);
    await pool.shutdown();
});

test('a worker crash rejects only its active task and a replacement serves queued work', async () => {
    const { createdWorkers, pool } = createPool({ maxWorkers: 1 });
    const active = pool.run({ task: 'active' });
    const queued = pool.run({ task: 'queued' });
    const crashedWorker = createdWorkers[0];
    const crash = new Error('worker crashed');

    crashedWorker.emit('error', crash);
    await assert.rejects(active, /worker crashed/);
    assert.equal(crashedWorker.terminateCalls, 1);
    assert.equal(createdWorkers.length, 2);
    assert.deepEqual(createdWorkers[1].messages, [{ task: 'queued' }]);

    createdWorkers[1].respond({ type: 'done', result: 'recovered' });
    assert.equal(await queued, 'recovered');
    await pool.shutdown();
});

test('an idle pool does not spin through replacement workers after a systematic crash', async () => {
    const { createdWorkers, pool } = createPool({ maxWorkers: 1 });
    const active = pool.run({ task: 'active' });
    createdWorkers[0].emit('error', new Error('worker startup failed'));

    await assert.rejects(active, /worker startup failed/);
    assert.equal(createdWorkers.length, 1);

    const retry = pool.run({ task: 'retry' });
    assert.equal(createdWorkers.length, 2);
    createdWorkers[1].respond({ type: 'done', result: 'recovered' });
    assert.equal(await retry, 'recovered');
    await pool.shutdown();
});

test('task errors keep the worker reusable without treating them as crashes', async () => {
    const { createdWorkers, pool } = createPool({ maxWorkers: 1 });
    const failed = pool.run({ task: 'expected-failure' });
    createdWorkers[0].respond({
        type: 'error',
        error: { message: 'task failed safely', stack: 'worker-stack' }
    });
    await assert.rejects(failed, error => error.message === 'task failed safely' && error.stack === 'worker-stack');

    const recovered = pool.run({ task: 'next' });
    assert.equal(createdWorkers.length, 1);
    createdWorkers[0].respond({ type: 'done', result: 'next-result' });
    assert.equal(await recovered, 'next-result');
    await pool.shutdown();
});

test('shutdown rejects active and queued work, terminates workers, and closes the pool', async () => {
    const { createdWorkers, pool } = createPool({ maxWorkers: 1 });
    const active = pool.run({ task: 'active' });
    const queued = pool.run({ task: 'queued' });

    const firstShutdown = pool.shutdown();
    const repeatedShutdown = pool.shutdown();
    assert.equal(repeatedShutdown, firstShutdown);
    await firstShutdown;

    await assert.rejects(active, /pool is shut down/);
    await assert.rejects(queued, /pool is shut down/);
    await assert.rejects(pool.run({ task: 'after-shutdown' }), /pool is shut down/);
    assert.equal(createdWorkers[0].terminateCalls, 1);
});

test('backup task routing keeps database read locks outside the pooled operation', () => {
    const backupSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'backup.js'), 'utf8');
    assert.match(
        backupSource,
        /const operation = \(\) => runBackupWorkerTask\(task, payload, onMessage\);[\s\S]*DATABASE_READ_WORKER_TASKS\.has\(task\) \? await runWithDatabaseRead\(operation\)/
    );
    assert.match(backupSource, /shutdownBackupWorkers/);
});

test('the real backup worker accepts sequential tasks with fresh per-task context', async () => {
    let createdWorkers = 0;
    const pool = new WorkerTaskPool({
        createWorker: () => {
            createdWorkers += 1;
            return new Worker(path.join(__dirname, '..', 'src', 'main', 'backupWorker.js'));
        },
        maxWorkers: 1,
        maxQueue: 1,
        name: 'Backup worker'
    });
    const missingDatabasePath = path.join(
        os.tmpdir(),
        `ogs-missing-worker-database-${process.pid}-${Date.now()}.db`
    );
    const createMessage = missingDatabaseLabel => ({
        task: 'getGameDataFromDB',
        payload: {},
        context: {
            allUserIds: {},
            dbPath: missingDatabasePath,
            gameData: {},
            installedDbPath: `${missingDatabasePath}.installed`,
            labels: { missingDatabase: missingDatabaseLabel, noBackups: 'none' },
            placeholderMapping: {},
            settings: { backupAllAccounts: false, gameInstalls: [], language: 'en_US' }
        }
    });

    try {
        const first = await pool.run(createMessage('first missing database'));
        const second = await pool.run(createMessage('second missing database'));
        assert.deepEqual(first, { games: [], errors: ['first missing database'] });
        assert.deepEqual(second, { games: [], errors: ['second missing database'] });
        assert.equal(createdWorkers, 1);
    } finally {
        await pool.shutdown();
    }
});
