// Resolve rustup's per-user tools without requiring a desktop-app restart after installation.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const env = { ...process.env };
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
env[pathKey] = `${path.join(os.homedir(), '.cargo', 'bin')}${path.delimiter}${env[pathKey] || ''}`;
const result = spawnSync(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), ...process.argv.slice(2)], {
    env, stdio: 'inherit', windowsHide: true
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
