const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
    return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

function lineCount(relativePath) {
    return readProjectFile(relativePath).split(/\r?\n/).length;
}

test('main process entry remains an IPC-free lifecycle coordinator', () => {
    const mainSource = readProjectFile('src/main/main.js');
    assert.doesNotMatch(mainSource, /ipcMain\.(?:handle|on)\s*\(/);
    assert.match(mainSource, /registerIpcHandlers\(\{ ensureGameDataReady \}\)/);
});

test('large legacy modules stay behind explicit size boundaries', () => {
    assert.ok(lineCount('src/main/main.js') <= 350);
    assert.ok(lineCount('src/main/global.js') <= 100);
    assert.ok(lineCount('src/main/backupWorker.js') <= 100);
    assert.ok(lineCount('src/renderer/js/commonTabs.js') <= 900);
});

test('IPC handlers are grouped by domain', () => {
    for (const domain of ['application', 'backup', 'database', 'restore', 'settings', 'window']) {
        const source = readProjectFile(`src/main/ipc/${domain}.js`);
        assert.match(source, /ipcMain\.(?:handle|on)\s*\(/);
    }
});

test('service constants cannot contain accidentally materialized getter calls', () => {
    const servicesDirectory = path.join(PROJECT_ROOT, 'src/main/services');
    const serviceFiles = fs.readdirSync(servicesDirectory)
        .filter(fileName => fileName.endsWith('.js'));

    for (const fileName of serviceFiles) {
        const source = fs.readFileSync(path.join(servicesDirectory, fileName), 'utf8');
        assert.doesNotMatch(source, /(['"])get[A-Z][A-Za-z0-9_]*\(\)\1/, fileName);
    }
});
