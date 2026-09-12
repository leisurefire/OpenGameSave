// Run only in a disposable Windows account/VM. Default invocation is read-only.
/* global window */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { SmokeRun, createFixture, GAME_ID, ORIGINAL_SAVE } = require('./smoke-tauri.cjs');

const ROOT = path.resolve(__dirname, '..');
const LEGACY_ID = '4cc94751-e365-5f27-95ea-388f4d0e40fc';
const UNINSTALL = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const PREVIOUS_ASSOCIATION = 'OGS.InstallerVerification.Previous';
const quote = value => `'${String(value).replace(/'/g, "''")}'`;
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function command(file, args, options = {}) {
    return await new Promise((resolve, reject) => {
        const child = spawn(file, args, { windowsHide: true, ...options });
        let output = '';
        let errors = '';
        child.stdout?.on('data', data => { output += data; });
        child.stderr?.on('data', data => { errors += data; });
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`Timed out: ${path.basename(file)}; inspect the disposable VM before retrying`));
        }, 180000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => {
            clearTimeout(timer);
            if (code !== 0) reject(new Error(`${path.basename(file)} exited ${code}: ${output}\n${errors}`));
            else resolve(output.trim());
        });
    });
}

async function powershell(script) {
    return await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(`$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new()\n${script}`, 'utf16le').toString('base64')]);
}

async function systemState() {
    return JSON.parse(await powershell(`
$found = @()
foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
    $key = $base.OpenSubKey(${quote(UNINSTALL)})
    if ($key) {
      foreach ($name in $key.GetSubKeyNames()) {
        $item = $key.OpenSubKey($name)
        if ($item.GetValue('DisplayName') -like '*OpenGameSave*' -or $name -in @('OpenGameSave', '${LEGACY_ID}')) {
          $found += @{key=$name; hive="$hive"; view="$view"; version=$item.GetValue('DisplayVersion'); command=$item.GetValue('UninstallString')}
        }
        $item.Dispose()
      }
      $key.Dispose()
    }
    $base.Dispose()
  }
}
$desktop = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')
@{ installs=$found; roaming=[Environment]::GetFolderPath('ApplicationData'); local=[Environment]::GetFolderPath('LocalApplicationData'); desktop=$desktop; programs=$programs } | ConvertTo-Json -Depth 5
`));
}

async function registryValue(key, name = '') {
    const result = JSON.parse(await powershell(`
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(key)})
$value = $null
if ($key) { $value = $key.GetValue(${quote(name)}); $key.Dispose() }
@{value=$value} | ConvertTo-Json
`));
    return result.value;
}

async function setRegistryValue(key, name, value) {
    await powershell(`$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${quote(key)})
$key.SetValue(${quote(name)}, ${quote(value)})
$key.Dispose()`);
}

function assertClean(state, collisions) {
    assert.equal(state.installs.length, 0, 'Existing OpenGameSave install: use a disposable Windows account/VM');
    assert.deepEqual(collisions, [], 'Existing app data, registration or shortcuts: use a clean disposable account/VM');
}

async function preflight() {
    assert.equal(process.platform, 'win32', 'Windows is required');
    const state = await systemState();
    const paths = [
        path.join(state.roaming, 'opengamesave'), path.join(state.roaming, 'OGS Backups'),
        path.join(state.roaming, 'com.leisurefire.opengamesave'), path.join(state.local, 'com.leisurefire.opengamesave'),
        path.join(state.local, 'OpenGameSave'), path.join(state.local, 'Programs', 'opengamesave'),
        path.join(state.desktop, 'OpenGameSave.lnk'), path.join(state.programs, 'OpenGameSave.lnk')
    ];
    const collisions = paths.filter(file => fs.existsSync(file));
    for (const [key, name] of [
        ['Software\\Classes\\.gsmr', ''], ['Software\\Classes\\OpenGameSave Archive', ''],
        [`Software\\Classes\\${PREVIOUS_ASSOCIATION}`, ''],
        ['Software\\leisurefire\\OpenGameSave', ''], [`Software\\${LEGACY_ID}`, 'InstallLocation'],
        ['Software\\Microsoft\\Windows\\CurrentVersion\\Run', 'OpenGameSave']
    ]) {
        if (await registryValue(key, name) !== null) collisions.push(`${key}:${name}`);
    }
    const processes = JSON.parse(await powershell("@{ running=@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -ieq 'opengamesave' } | Select-Object -ExpandProperty Id) } | ConvertTo-Json"));
    if (processes.running.length) collisions.push('OpenGameSave is running');
    assertClean(state, collisions);
    return state;
}

function treeHashes(root) {
    const result = {};
    if (!fs.existsSync(root)) return result;
    function walk(directory) {
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, item.name);
            assert.ok(!fs.lstatSync(file).isSymbolicLink(), `Fixture contains a link: ${file}`);
            if (item.isDirectory()) walk(file);
            else result[path.relative(root, file)] = hash(file);
        }
    }
    walk(root);
    return result;
}

async function install(installer, directory) {
    // NSIS consumes the unquoted remainder of the command line after /D=.
    try {
        await command(installer, ['/S', '/OGSLOG', '--no-startup', `/D=${directory}`], { windowsVerbatimArguments: true });
    } catch (error) {
        const diagnostic = path.join(os.tmpdir(), 'OpenGameSave-installer-error.log');
        if (fs.existsSync(diagnostic)) error.message += `\nInstaller diagnostic: ${fs.readFileSync(diagnostic, 'utf8')}`;
        const trace = path.join(path.dirname(installer), 'OpenGameSave-installer.log');
        if (fs.existsSync(trace)) error.message += `\nInstaller trace: ${fs.readFileSync(trace, 'utf8')}`;
        throw error;
    }
    assert.ok(fs.existsSync(path.join(directory, 'opengamesave.exe')), 'Installed executable is missing');
}

async function uninstall(directory) {
    await command(path.join(directory, 'uninstall.exe'), ['/S', `_?=${directory}`], { windowsVerbatimArguments: true });
    assert.ok(!fs.existsSync(path.join(directory, 'opengamesave.exe')));
    // With _?= NSIS leaves its running uninstaller behind. Delete that exact file.
    fs.unlinkSync(path.join(directory, 'uninstall.exe'));
    assert.equal(await registryValue(`${UNINSTALL}\\OpenGameSave`, 'UninstallString'), null);
    assert.equal(await registryValue('Software\\Classes\\.gsmr'), PREVIOUS_ASSOCIATION);
}

async function checkInstalled(directory, state) {
    const executable = path.join(directory, 'opengamesave.exe');
    assert.equal(await registryValue(`${UNINSTALL}\\OpenGameSave`, 'UninstallString'), `"${path.join(directory, 'uninstall.exe')}"`);
    assert.equal(await registryValue('Software\\Classes\\OpenGameSave Archive\\shell\\open\\command'), `"${executable}" "%1"`);
    for (const file of ['database/database.db', 'database/licenses/LUDUSAVI-MANIFEST-LICENSE.txt', 'database/licenses/XGPSAVETOOLS-LICENSE.txt', 'THIRD_PARTY_NOTICES.md']) {
        assert.equal(hash(path.join(directory, file)), hash(path.join(ROOT, file)), `Packaged resource mismatch: ${file}`);
    }
    for (const folder of [state.desktop, state.programs]) {
        const target = await powershell(`$shell = New-Object -ComObject WScript.Shell
$shell.CreateShortcut(${quote(path.join(folder, 'OpenGameSave.lnk'))}).TargetPath`);
        assert.equal(target.toLowerCase(), executable.toLowerCase(), 'Shortcut must target the Tauri binary');
    }
}

class ElectronRun extends SmokeRun {
    isPage(page, file) {
        try { return page.type === 'page' && new URL(page.url).protocol === 'file:' && new URL(page.url).pathname.endsWith(`/${file}`); } catch { return false; }
    }

    async closeNormally() {
        await this.main.evaluate(() => { setTimeout(() => window.close(), 0); return true; });
        // poll() treats any process exit as an unexpected startup/IPC failure.
        // A normal close must await the process completion event directly.
        const exit = await this.exited;
        assert.equal(exit.code, 0);
        return exit;
    }
}

async function appPhase(binary, fixture, label, action, { electron = false, verifyFixture = true } = {}) {
    const logRoot = path.join(fixture.root, label);
    fs.mkdirSync(logRoot);
    const run = new (electron ? ElectronRun : SmokeRun)(binary, { ...fixture, root: logRoot }, label);
    let failure;
    try {
        await run.step('startup using the actual Windows profile', () => run.launch({ useDefaultData: true, verifyFixture, electron }));
        await run.step(label, () => action(run), 90000);
        await run.step('normal shutdown', () => run.closeNormally());
        run.report.passed = true;
    } catch (error) { failure = error; } finally { await run.finish(failure); }
    if (failure) throw failure;
    return run.report;
}

async function lifecycle(installer, electronInstaller, state, report) {
    const fixture = createFixture();
    report.fixture = fixture.root;
    const originalFixtureData = fixture.appData;
    fixture.appData = path.join(state.roaming, 'opengamesave');
    const settingsFile = path.join(fixture.appData, 'OGS Settings', 'settings.json');
    const databaseFile = path.join(fixture.appData, 'OGS Database', 'database.db');
    const directory = path.join(fixture.root, 'Installed App 空间');
    const binary = path.join(directory, 'opengamesave.exe');
    const association = 'Software\\Classes\\.gsmr';
    await setRegistryValue(association, '', PREVIOUS_ASSOCIATION);
    await install(installer, directory);
    await checkInstalled(directory, state);
    report.steps.push(await appPhase(binary, fixture, 'clean-first-install', async run => {
        const settings = await run.main.api('invoke', 'get-settings');
        assert.equal(settings.backupPath, path.join(state.roaming, 'OGS Backups'));
        assert.equal(settings.maxBackups, 5);
        assert.equal(hash(databaseFile), hash(path.join(ROOT, 'database/database.db')));
    }, { verifyFixture: false }));
    const defaultBackups = path.join(state.roaming, 'OGS Backups');
    fs.mkdirSync(defaultBackups, { recursive: true });
    fs.writeFileSync(path.join(defaultBackups, 'installer-verification-sentinel.txt'), ORIGINAL_SAVE);
    const defaultBackupHashes = treeHashes(defaultBackups);
    const freshSettings = hash(settingsFile);
    await uninstall(directory);
    assert.equal(hash(settingsFile), freshSettings, 'Default uninstall must preserve settings');
    assert.deepEqual(treeHashes(defaultBackups), defaultBackupHashes, 'Default backup directory must survive uninstall');
    fs.renameSync(fixture.appData, path.join(fixture.root, 'clean-profile-retained'));
    // Only this run created the profile directory: preflight required it absent.
    fs.cpSync(originalFixtureData, fixture.appData, { recursive: true, errorOnExist: true, force: false });
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    Object.assign(settings, { maxBackups: 17, pinnedGames: [GAME_ID], blockedGames: ['998'], backupAllAccounts: true, launchAtStartup: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    const legacyDirectory = path.join(fixture.root, 'Electron App 空间');
    await install(electronInstaller, legacyDirectory);
    assert.ok(await registryValue(`${UNINSTALL}\\${LEGACY_ID}`, 'UninstallString'));
    report.steps.push(await appPhase(path.join(legacyDirectory, 'OpenGameSave.exe'), fixture, 'electron-creates-backup', async run => {
        const games = await run.main.api('invoke', 'fetch-backup-table-data', [false, GAME_ID], 30000);
        assert.equal(games.length, 1);
        await run.main.api('invoke', 'backup-game', [games[0]], 30000);
        const snapshots = await run.main.api('invoke', 'fetch-restore-table-data', [GAME_ID]);
        assert.equal(snapshots[0].backups.length, 1);
        assert.ok(Object.keys(treeHashes(fixture.backups)).some(file => file.endsWith('slot.dat')));
        const liveBackups = treeHashes(fixture.backups);
        await assert.rejects(() => install(installer, directory), /Close OpenGameSave before upgrading/);
        assert.deepEqual(treeHashes(fixture.backups), liveBackups);
        assert.equal(run.exit, undefined, 'An upgrade must not kill the running Electron app');
        report.steps.push({ name: 'running-electron-upgrade-rejected-without-killing-app', passed: true });
    }, { electron: true }));
    assert.equal((await registryValue('Software\\Microsoft\\Windows\\CurrentVersion\\Run', 'OpenGameSave')).toLowerCase(), `"${path.join(legacyDirectory, 'OpenGameSave.exe')}"`.toLowerCase());
    const before = { settings: hash(settingsFile), database: hash(databaseFile), backups: treeHashes(fixture.backups) };
    report.preUpgrade = {
        registrations: (await systemState()).installs,
        legacyDirectory: await registryValue(`Software\\${LEGACY_ID}`, 'InstallLocation'),
        publisher: await registryValue(`${UNINSTALL}\\${LEGACY_ID}`, 'Publisher')
    };
    assert.ok(Object.keys(before.backups).length > 1, 'Electron must produce a real backup');
    const legacyKey = `${UNINSTALL}\\${LEGACY_ID}`;
    const originalCommand = await registryValue(legacyKey, 'UninstallString');
    try {
        await setRegistryValue(legacyKey, 'UninstallString', `${originalCommand} --unexpected`);
        await assert.rejects(() => install(installer, directory), /Unexpected Electron uninstall command/);
    } finally { await setRegistryValue(legacyKey, 'UninstallString', originalCommand); }
    const legacyUninstaller = path.join(legacyDirectory, 'Uninstall OpenGameSave.exe');
    const heldUninstaller = `${legacyUninstaller}.verification-held`;
    fs.renameSync(legacyUninstaller, heldUninstaller);
    try {
        await assert.rejects(() => install(installer, directory), /Electron uninstaller is missing/);
    } finally { fs.renameSync(heldUninstaller, legacyUninstaller); }
    assert.equal(hash(settingsFile), before.settings);
    assert.deepEqual(treeHashes(fixture.backups), before.backups);
    assert.ok(!fs.existsSync(binary));
    report.steps.push({ name: 'invalid-and-missing-uninstaller-fail-with-data-intact', passed: true });
    await install(installer, directory);
    await checkInstalled(directory, state);
    assert.equal(await registryValue(`${UNINSTALL}\\${LEGACY_ID}`, 'UninstallString'), null);
    assert.equal(await registryValue('Software\\Microsoft\\Windows\\CurrentVersion\\Run', 'OpenGameSave'), `"${binary}"`);
    assert.ok(!fs.existsSync(path.join(legacyDirectory, 'resources', 'app.asar')), 'Electron runtime must be removed');
    assert.equal(hash(settingsFile), before.settings);
    assert.equal(hash(databaseFile), before.database);
    assert.deepEqual(treeHashes(fixture.backups), before.backups);
    assert.deepEqual(treeHashes(defaultBackups), defaultBackupHashes);
    report.steps.push(await appPhase(binary, fixture, 'upgrade-preserves-and-restores', async run => {
        const migrated = await run.main.api('invoke', 'get-settings');
        for (const key of Object.keys(settings)) assert.deepEqual(migrated[key], settings[key], `Lost setting: ${key}`);
        const snapshots = await run.main.api('invoke', 'fetch-restore-table-data', [GAME_ID]);
        assert.equal(snapshots[0].backups.length, 1);
        fs.writeFileSync(fixture.save, 'Changed after Electron backup\n');
        const result = await run.main.api('invoke', 'restore-game', [snapshots[0], 'replace'], 30000);
        assert.equal(result.error, null);
        assert.equal(fs.readFileSync(fixture.save, 'utf8'), ORIGINAL_SAVE);
    }));
    // Exercise association preservation across an in-place Tauri reinstall too.
    await install(installer, directory);
    await checkInstalled(directory, state);
    await uninstall(directory);
    assert.equal(hash(settingsFile), before.settings);
    assert.equal(hash(databaseFile), before.database);
    assert.deepEqual(treeHashes(fixture.backups), before.backups);
    for (const folder of [state.desktop, state.programs]) assert.ok(!fs.existsSync(path.join(folder, 'OpenGameSave.lnk')));
    assert.equal(await registryValue('Software\\Microsoft\\Windows\\CurrentVersion\\Run', 'OpenGameSave'), null);
    report.steps.push({ name: 'default-uninstall-preserves-all-fixture-data-and-removes-registration', passed: true, hashes: before });
    const embeddedBackups = path.join(fixture.appData, 'custom-backups', '999', '2026-09-12_00-00');
    fs.mkdirSync(embeddedBackups, { recursive: true });
    fs.writeFileSync(path.join(embeddedBackups, 'sentinel.dat'), ORIGINAL_SAVE);
    const embeddedHashes = treeHashes(embeddedBackups);
    for (const language of ['1033', '2052']) {
        // Reset via the real native checkbox, in both bundled languages.
        await install(installer, directory);
        await setRegistryValue('Software\\leisurefire\\OpenGameSave', 'Installer Language', language);
        fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
        fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
        fs.copyFileSync(path.join(originalFixtureData, 'OGS Settings', 'settings.json'), settingsFile);
        fs.copyFileSync(path.join(originalFixtureData, 'OGS Database', 'database.db'), databaseFile);
        const expectedAssociation = language === '2052' ? 'OGS.InstallerVerification.Changed' : PREVIOUS_ASSOCIATION;
        if (language === '2052') await setRegistryValue(association, '', expectedAssociation);
        const result = await command('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            path.join(ROOT, 'scripts', 'verify-uninstall-dialog.ps1'), '-Directory', directory]);
        assert.ok(!fs.existsSync(settingsFile));
        assert.ok(!fs.existsSync(databaseFile));
        assert.deepEqual(treeHashes(fixture.backups), before.backups);
        assert.deepEqual(treeHashes(embeddedBackups), embeddedHashes);
        assert.deepEqual(treeHashes(defaultBackups), defaultBackupHashes);
        assert.equal(await registryValue(association), expectedAssociation);
        fs.unlinkSync(path.join(directory, 'uninstall.exe'));
        report.steps.push({ name: `graphical-reset-keeps-backups-${language}`, passed: true, dialog: JSON.parse(result) });
    }
    // Retain data and registry evidence in this disposable account for inspection.
}

async function main() {
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index++) {
        if (args[index] === '--run') continue;
        assert.ok(['--installer', '--electron'].includes(args[index]), `Unknown option: ${args[index]}`);
        assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `${args[index]} requires a path`);
        index++;
    }
    const run = args.includes('--run');
    const installer = args.includes('--installer') ? path.resolve(args[args.indexOf('--installer') + 1]) : null;
    const electronInstaller = args.includes('--electron') ? path.resolve(args[args.indexOf('--electron') + 1]) : null;
    const report = { startedAt: new Date().toISOString(), passed: false, steps: [], scope: run ? 'installer-lifecycle' : 'read-only-preflight' };
    fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
    const reportFile = path.join(ROOT, 'dist', `installer-verification-${Date.now()}.json`);
    try {
        const state = await preflight();
        report.preflight = { passed: true };
        if (run) {
            assert.ok(installer && electronInstaller, 'Use --run --installer <Tauri exe> --electron <previous Electron exe>');
            report.artifacts = { tauri: { path: installer, sha256: hash(installer) }, electron: { path: electronInstaller, sha256: hash(electronInstaller) } };
            await lifecycle(installer, electronInstaller, state, report);
        }
        report.passed = true;
    } catch (error) { report.error = String(error.stack || error); process.exitCode = 1; } finally {
        report.finishedAt = new Date().toISOString();
        fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
        console.log(`${report.passed ? 'PASS' : 'BLOCKED/FAIL'} ${report.scope}: ${reportFile}`);
        if (report.error) console.error(report.error);
    }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { assertClean, treeHashes, quote };
