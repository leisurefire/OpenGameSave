let activeReaders = 0;
let writerActive = false;
const waiters = [];
const MAX_WAITERS = 1000;

function createRelease(callback) {
    let released = false;
    return () => {
        if (released) return;
        released = true;
        callback();
        drainWaiters();
    };
}

function grantReader(resolve) {
    activeReaders += 1;
    resolve(createRelease(() => { activeReaders -= 1; }));
}

function grantWriter(resolve) {
    writerActive = true;
    resolve(createRelease(() => { writerActive = false; }));
}

function drainWaiters() {
    if (writerActive || activeReaders > 0 || waiters.length === 0) return;
    if (waiters[0].type === 'write') {
        grantWriter(waiters.shift().resolve);
        return;
    }
    while (waiters[0]?.type === 'read' && !writerActive) {
        grantReader(waiters.shift().resolve);
    }
}

function enqueue(type) {
    if (waiters.length >= MAX_WAITERS) return Promise.reject(new Error('Database operation queue is full'));
    return new Promise((resolve) => {
        const writerWaiting = waiters.some(waiter => waiter.type === 'write');
        if (type === 'read' && !writerActive && !writerWaiting) {
            grantReader(resolve);
        } else if (type === 'write' && !writerActive && activeReaders === 0 && waiters.length === 0) {
            grantWriter(resolve);
        } else {
            waiters.push({ type, resolve });
        }
    });
}

module.exports = {
    acquireDatabaseRead: () => enqueue('read'),
    acquireDatabaseWrite: () => enqueue('write')
};
