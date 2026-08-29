const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('application shutdown prevents queued startup work from starting', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/main/main.js'), 'utf8');
    const enqueueSource = source.slice(
        source.indexOf('function enqueueStartupIdleTask'),
        source.indexOf('function initializeI18next')
    );
    const quitSource = source.slice(source.indexOf("app.on('before-quit'"), source.indexOf("app.on('window-all-closed'"));

    assert.match(enqueueSource, /if \(isQuitting\) return;/);
    assert.match(enqueueSource, /if \(startupIdleQueueStarted \|\| isQuitting\) return;/);
    assert.ok((enqueueSource.match(/if \(isQuitting\) return;/g) || []).length >= 3);
    assert.match(quitSource, /startupIdleTasks\.length = 0;/);
    assert.match(quitSource, /await Promise\.all\(\[/);
    assert.match(quitSource, /runShutdownStep\('auto backups', stopAllAutoBackups\(\)\)/);
    assert.match(quitSource, /runShutdownStep\('library scanner', shutdownLibraryScanner\(\)\)/);
    assert.match(quitSource, /runShutdownStep\('backup workers', shutdownBackupWorkers\(\)\)/);
});

test('post-render startup is queued after the awaited main-window load', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/main/main.js'), 'utf8');
    const startupStart = source.indexOf('async function startApplication');
    const startupSource = source.slice(
        startupStart,
        source.indexOf('registerIpcHandlers', startupStart)
    );
    const createIndex = startupSource.indexOf('await createMainWindow();');
    const queueIndex = startupSource.indexOf('queuePostRenderStartup(mainWindow);');

    assert.ok(createIndex >= 0);
    assert.ok(queueIndex > createIndex);
    assert.doesNotMatch(startupSource, /webContents\.once\('did-finish-load'/);
    assert.match(startupSource, /void createMainWindow\(\)\.catch\(logFatalError\)/);
});
