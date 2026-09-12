const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { ROLE_CAPABILITIES, ROLE_FILES, getRoleCapabilities } = require('../src/shared/ipcPolicy');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(PROJECT_ROOT, name), 'utf8');

function javascriptFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? javascriptFiles(file) : entry.name.endsWith('.js') ? [file] : [];
    });
}

test('the distribution uses a web frontend and Tauri without a Node runtime entry', () => {
    const manifest = JSON.parse(read('package.json'));
    const config = JSON.parse(read('src-tauri/tauri.conf.json'));
    assert.equal(manifest.main, undefined);
    assert.ok(manifest.dependencies['@tauri-apps/api']);
    assert.ok(manifest.devDependencies['@tauri-apps/cli']);
    assert.ok(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).every(name => !/^electron(?:-|$)/.test(name)));
    for (const name of ['start', 'dev', 'build']) assert.match(manifest.scripts[name], /tauri/);
    assert.equal(config.bundle.externalBin, undefined, 'a Node sidecar must not be reintroduced');
    assert.match(read('webpack.renderer.config.js'), /target:\s*['"]web['"]/);
});

test('renderer modules cannot directly import filesystem, process, or legacy desktop APIs', () => {
    const forbiddenImport = /(?:from\s*|require\s*\(\s*|import\s*\(\s*)['"](?:node:|electron(?:[/'"]|$)|fs(?:[/'"]|$)|child_process['"]|worker_threads['"]|original-fs['"])/;
    for (const file of javascriptFiles(path.join(PROJECT_ROOT, 'src/renderer'))) {
        assert.doesNotMatch(fs.readFileSync(file, 'utf8'), forbiddenImport, path.relative(PROJECT_ROOT, file));
    }
    for (const entry of ['index', 'settings', 'about', 'modal', 'menu']) {
        const source = read(`src/renderer/${entry}.entry.js`);
        assert.match(source, /startRenderer\(/, `${entry} must wait for the host bridge`);
        assert.doesNotMatch(source, /^import .*['"]\.\/js\/(?:utility|commonTabs|settingsPage|aboutPage|modalWindowPage)\.js['"]/m,
            `${entry} cannot initialize business modules before the bridge`);
    }
});

test('Rust and JavaScript use the same explicit role policy and deny unregistered roles', () => {
    const policy = JSON.parse(read('src/shared/ipc-policy.json'));
    assert.deepEqual(ROLE_FILES, policy.files);
    assert.deepEqual(ROLE_CAPABILITIES, policy.roles);
    assert.deepEqual(getRoleCapabilities('unregistered'), { send: [], invoke: [], receive: [] });
    assert.deepEqual(getRoleCapabilities('__proto__'), { send: [], invoke: [], receive: [] });
    for (const [role, capabilities] of Object.entries(ROLE_CAPABILITIES)) {
        assert.ok(ROLE_FILES[role]);
        for (const direction of ['send', 'invoke', 'receive']) {
            assert.ok(Array.isArray(capabilities[direction]));
            assert.ok(capabilities[direction].every(channel => /^[a-z][a-z-]+$/.test(channel)), `${role}/${direction} must use explicit channels`);
            assert.equal(new Set(capabilities[direction]).size, capabilities[direction].length);
        }
    }
    assert.match(read('src-tauri/src/policy.rs'), /include_str!\("\.\.\/\.\.\/src\/shared\/ipc-policy\.json"\)/);
    const host = read('src-tauri/src/lib.rs');
    assert.match(host, /windows::context\(&state,\s*&window\)/);
    assert.match(host, /policy::allowed\(&context\.role,\s*&direction,\s*&channel\)/);
    assert.doesNotMatch(host, /context\.role\s*=\s*args/);
});

test('webviews cannot grant themselves filesystem, shell, or event emission capabilities', () => {
    const capabilities = JSON.parse(read('src-tauri/capabilities/desktop.json'));
    assert.equal(capabilities.remote, undefined);
    assert.ok(capabilities.permissions.includes('core:event:allow-listen'));
    for (const permission of capabilities.permissions) {
        const identifier = typeof permission === 'string' ? permission : permission.identifier;
        assert.doesNotMatch(identifier, /^(?:fs|shell|process|http|opener):/);
        assert.doesNotMatch(identifier, /^core:event:allow-emit/);
        assert.notEqual(identifier, 'core:default');
    }
    const config = JSON.parse(read('src-tauri/tauri.conf.json'));
    assert.notEqual(config.app.withGlobalTauri, true);
    assert.match(config.app.security.csp, /connect-src[^;]*ipc:/);
    assert.match(config.app.security.csp, /object-src 'none'/);
    assert.doesNotMatch(config.app.security.csp, /unsafe-eval|connect-src[^;]*\*/);
});

test('backup, synchronization, and library operations have Rust domain entry points', () => {
    const host = read('src-tauri/src/lib.rs');
    for (const domain of ['saves', 'sync', 'library']) {
        assert.match(host, new RegExp(`${domain}::dispatch\\(`));
        assert.ok(fs.existsSync(path.join(PROJECT_ROOT, `src-tauri/src/${domain}/mod.rs`)));
    }
    assert.ok(read('src/renderer/js/commonTabs.js').split(/\r?\n/).length <= 900);
});
