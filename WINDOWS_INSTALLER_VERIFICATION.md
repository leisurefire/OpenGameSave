# Windows installer verification

## Status of this run (2026-09-12)

**PASS — packaged x64 per-user installer lifecycle.** Final evidence is in
`dist/installer-lifecycle-verified/lifecycle.json` and `isolated-result.json`.
First install, actual Electron 0.7.3 upgrade, settings/catalog/backup preservation,
restore, startup migration, reinstall, default uninstall and the English/Chinese
reset dialogs all passed. Running-app, invalid-command and missing-uninstaller
cases failed safely, and uninstall preserved an association changed by another
app. The temporary account and profile were removed. The original user's installed
Electron 0.7.2 registration remains unchanged.

This host has a real per-user Electron 0.7.2 installation, while the workspace
application is Tauri. These are independent: the old installed app is a migration
source, not a build dependency. The initial preflight correctly refused to test
against the occupied account. The isolated launcher below now creates its own
temporary standard Windows account and runs the actual installers there.

The first real upgrade attempt exposed an in-place Electron uninstaller failure
(exit 2). The hook now copies the old uninstaller to NSIS's private temporary
directory and uses `/S /KEEP_APP_DATA /currentuser --updated`, matching
[electron-builder's own upgrade protocol](https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/templates/nsis/include/installUtil.nsh).
The corrected installer passed two complete lifecycle runs; the final run also
includes the negative cases and association takeover check.

Completed locally:

- Ran the real installers and both application generations in temporary standard
  accounts, including actual native uninstall checkbox interactions.
- Built the unsigned x64 NSIS package with the migration hooks and both languages.
- Extracted the actual NSIS payload without installing it.
- Launched that extracted executable with an empty isolated profile, checked
  default settings and exact catalog bytes, and closed normally.
- Passed native backup/restore, menus and auxiliary windows, export, pending
  restore-conflict shutdown, interval backup and watcher/rebind smoke checks.
- Passed 112 JavaScript tests, ESLint and TypeScript checking.
- Downloaded the published Electron 0.7.3 installer and matched GitHub's SHA-256.

Evidence is retained in `dist/installer-verification-build.log`,
`dist/installer-verification-rebundle.log`, `dist/installer-payload-smoke.log`,
`dist/installer-verification-tests.log`, `dist/installer-artifact-evidence.json`,
and the `dist/native-smoke-*/summary.json` files named in the smoke log. The
`dist/installer-verification-*.json` preflight reports distinguish refusal from
a successful lifecycle run. The final lifecycle reports supersede the earlier
blocked preflight and payload-only evidence.

## Changes under verification

- Recognize electron-builder's existing UUID registration, validate its publisher,
  install location and exact per-user uninstall command, copy its uninstaller out
  of the installation directory and invoke the copy with data retention flags.
  Wait for success and check that the
  legacy registration is gone before copying Tauri files. Never recursively delete
  a registry-provided path ourselves. A running Electron app, missing/unexpected
  uninstaller or all-users installation stops migration with an explanation.
- Retarget an existing Electron startup entry to the installed Tauri executable.
- Quote the executable and document in the `.gsmr` association command. Preserve
  the previous association across Tauri reinstalls and preserve another app's
  association if it changes after installation.
- Default uninstall retains settings, catalog and backups. The optional checkbox
  now says **Reset settings and catalog (keep backups)** in English and Chinese.
  It deletes only the known legacy settings/catalog files, plus the stock Tauri
  identifier cache directories; it never walks the configured backup directory.
  Other legacy files and credentials remain. This is intentionally not a complete
  user-data or credential erasure feature.
- Wait for the menu opening animation to finish before smoke-testing its final
  dimensions. Keep the existing size and clipping assertions.

The `--updated` behavior comes from
[electron-builder's uninstaller](https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/templates/nsis/uninstaller.nsh).
The checked-in NSIS language files retain Tauri 2.11.4's translations with the
reset checkbox relabeled; review them when upgrading the bundler.

## Prepare artifacts on the build host

Use Node.js 24, the repository's Rust toolchain, and Windows build prerequisites.
From the repository root in PowerShell:

```powershell
npm ci
npm run app:dist
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
npm test
npm run lint
npm run typecheck
```

The local installer is
`src-tauri/target/release/bundle/nsis/OpenGameSave_0.7.3_x64-setup.exe`.
This is an unsigned development package. The release workflow selects an unused,
newer version before publishing; do not publish this local 0.7.3 package over the
existing Electron 0.7.3 release.

Download the actual preceding Electron release:

```powershell
Invoke-WebRequest 'https://github.com/leisurefire/OpenGameSave/releases/download/v0.7.3/OpenGameSave-Setup-0.7.3.exe' -OutFile 'dist/Electron-OpenGameSave-Setup-0.7.3.exe'
$expected = '72DAC47FEE4DCF686CECF477ABF714C3525A073C5BB8446613A34EA60E758EA3'
if ((Get-FileHash -LiteralPath 'dist/Electron-OpenGameSave-Setup-0.7.3.exe' -Algorithm SHA256).Hash -ne $expected) { throw 'Electron checksum mismatch' }
```

Source: [published Electron 0.7.3 release](https://github.com/leisurefire/OpenGameSave/releases/tag/v0.7.3).
The verifier also records the SHA-256 of both supplied installers.

## Automated lifecycle in a disposable Windows environment

On an occupied developer machine, run:

```powershell
npm run verify:installer:isolated
```

Windows requests UAC approval to create a temporary **standard** account. The
installers and applications run without administrator privileges under that
account, using its own registry, profile, desktop and startup entries. Only the
account coordinator is elevated. No changes are made to the developer account's
installed OpenGameSave or app data. The launcher copies only the verification
scripts, required Node modules, catalog/licenses and installers into a unique
`C:\Users\Public\OGSInstallerVerification-*` directory; it copies no credentials
or existing user data.

The printed directory retains `test-output.log`, `test-errors.log`,
`dist/installer-verification-*.json`, native phase reports and
`isolated-result.json`. The final coordinator report must show `passed: true`,
`accountRemoved: true` and `profileRemoved: true`. The launcher waits for that
report and returns failure if either verification or cleanup fails. The
coordinator removes its own account and profile after the run and retains fixture
evidence in the public staging directory. Inspect `cleanupError` if cleanup fails.

For a pre-existing disposable account or VM, use the lower-level harness:

Use an interactive Windows x64 account with WebView2, Node.js 24 and no previous
OpenGameSave installation, profile, backups, shortcuts or file associations.
Take a VM snapshot. Copy this workspace, both installers and its installed Node
dependencies into the VM, or run `npm ci` there. A fresh standard account on a
machine with an all-users OpenGameSave installation is insufficient.

```powershell
# Read-only preflight. A failure must be resolved by choosing a clean environment.
npm run verify:installer
if ($LASTEXITCODE -ne 0) { throw 'Use a clean disposable account or VM' }

npm run verify:installer -- --run --installer 'src-tauri/target/release/bundle/nsis/OpenGameSave_0.7.3_x64-setup.exe' --electron 'dist/Electron-OpenGameSave-Setup-0.7.3.exe'
if ($LASTEXITCODE -ne 0) { throw 'Installer validation did not pass; inspect the retained report' }
```

The script deliberately uses the real Windows profile paths in this disposable
account, without `OGS_DATA_DIR`, to exercise actual migration and startup
registration. Saves, custom backups and installation directories live beneath a
unique workspace fixture. Paths contain spaces and Chinese characters.

It checks:

1. Fresh silent install, exact resources, shortcuts, uninstall registration and
   quoted `.gsmr` command; default first launch and catalog initialization.
2. Default uninstall retaining settings and a default-backup-directory sentinel.
3. Installation and launch of the supplied Electron release with isolated
   settings/catalog; a backup created by Electron through its renderer IPC.
4. Installation of Tauri over Electron, removal of the old registration/runtime,
   startup entry migration, settings/catalog/backup hashes and all configured
   fixture settings; restoration of Electron's backup to the isolated save.
5. Tauri reinstall, default uninstall, previous file association restoration,
   shortcut/registration/startup cleanup, and unchanged settings/catalog/backups.
6. The actual English and Chinese uninstall dialogs: verify the reset checkbox is
   initially unchecked, select it, and confirm settings/catalog removal while
   default, custom and profile-nested backup hashes remain unchanged.

Inspect the final JSON's `passed`, `steps`, artifact hashes and per-phase native
reports. Preserve the VM on failure; the harness does not attempt a broad cleanup
that could erase diagnostic data. Successful runs also retain their data. Restore
the clean snapshot before rerunning the complete lifecycle.

## Coverage and additional release scenarios

The automated run now covers the actual English/Chinese reset checkbox,
default-unchecked state, backup retention (including nested profile backups),
running Electron, missing/unexpected uninstallers and association takeover.
Additional scenarios for a broader release matrix, beyond the validated x64
per-user migration:

- Cancel installation and uninstall dialogs and confirm the currently installed
  application and fixture data remain usable.
- Test an all-users Electron installation: the per-user Tauri package should stop
  and request manual removal while retaining app data, without silently escalating.
- Open an exported `.gsmr` by double-clicking from a directory with spaces and
  confirm the import dialog receives that file. The automated installer test
  verifies the exact quoted shell command and association restoration.

Production Authenticode, missing-WebView2 installation, reboot-required scenarios,
and a real signed Tauri updater transition remain separate release gates.

## Safe payload-only regression on an occupied account

Close any running OpenGameSave instance. Use the full `7z.exe` from
[7-Zip](https://www.7-zip.org/download.html), which supports NSIS; the reduced
`7za.exe` does not. Extract into a new directory, without running either installer:

```powershell
& 'C:\Program Files\7-Zip\7z.exe' x 'src-tauri/target/release/bundle/nsis/OpenGameSave_0.7.3_x64-setup.exe' '-odist/installer-payload-verified'
if ($LASTEXITCODE -ne 0) { throw 'Payload extraction failed' }
npm run smoke:desktop -- --binary 'dist/installer-payload-verified/opengamesave.exe' --fresh --conflict-close --watcher
if ($LASTEXITCODE -ne 0) { throw 'Payload smoke failed' }
```

This mode uses isolated settings, saves and WebView2 profiles and skips startup
registration. It proves payload behavior only; it does not replace the disposable
environment's installer lifecycle test.
