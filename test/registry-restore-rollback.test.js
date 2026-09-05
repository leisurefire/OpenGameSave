const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('registry rollback removes values added by the failed restore before importing the old snapshot', {
    skip: process.platform !== 'win32'
}, async (t) => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ogs-registry-rollback-test-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const sourcePath = path.join(root, 'game', 'snapshot', 'path1');
    await fs.promises.mkdir(sourcePath, { recursive: true });
    await fs.promises.writeFile(path.join(sourcePath, 'registry_backup.reg'),
        'Windows Registry Editor Version 5.00\n[HKEY_CURRENT_USER\\Software\\GameSaveTest]\n"added"="new"\n');
    let values = { original: 'old' };
    let exportedValues;
    const commands = [];
    class FakeRegistry {
        keyExists(callback) { callback(null, values !== null); }
    }
    FakeRegistry.HKCU = 'HKCU';
    const mocks = {
        winreg: FakeRegistry,
        child_process: {
            execFile(binary, args, options, callback) {
                commands.push(args[0]);
                if (args[0] === 'export') exportedValues = { ...values };
                else if (args[0] === 'delete') values = null;
                else if (args[0] === 'import') {
                    const imported = path.basename(args[1]) === 'registry_backup.reg'
                        ? { added: 'new' } : exportedValues;
                    values = { ...values, ...imported };
                }
                callback(null, '', '');
            }
        },
        './backupWorkerContext': { getSettings: () => ({ backupPath: root }) },
        './restoreFileSystemTransaction': {
            restoreFileSystemPathsTransactionally: async () => { throw new Error('filesystem activation failed'); }
        }
    };
    const filename = path.resolve(__dirname, '../src/main/services/backupWorkerOperations.js');
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    const originalRequire = loaded.require.bind(loaded);
    loaded.require = request => mocks[request] || originalRequire(request);
    loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
    await assert.rejects(loaded.exports.restorePaths([{
        sourcePath, destinationPath: 'HKEY_CURRENT_USER\\Software\\GameSaveTest', backupType: 'reg'
    }]), /filesystem activation failed/);
    assert.deepEqual(values, { original: 'old' });
    assert.deepEqual(commands, ['export', 'import', 'delete', 'import']);
});
