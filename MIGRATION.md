# Tauri migration

OpenGameSave now uses Tauri 2 with a Rust application core. JavaScript is limited
to the web frontend and repository maintenance tools. The application has no
Electron runtime, preload script, JavaScript backend or Node sidecar.

## Implemented

- [x] Tauri lifecycle, immutable window roles, default-deny commands and targeted events.
- [x] Asynchronous frontend bridge, initialization handshake, subscription cleanup and native window controls.
- [x] Rust settings with atomic persistence and existing Windows user-data paths.
- [x] Rust launcher discovery, account resolution, artwork and guide catalog.
- [x] Rust database scanning, trusted save resolution and database updates.
- [x] Rust backups, retention, restore authorization and transactional rollback.
- [x] Legacy 7z `.gsmr` import/export and backup-directory migration.
- [x] Rust automatic backup scheduler and graceful operation shutdown.
- [x] Rust GitHub/WebDAV synchronization and protected credentials.
- [x] Tauri build configuration, NSIS packaging and signed release workflow.
- [x] Frontend/Rust regression tests, including legacy-format and transaction fixtures.
- [x] Removal of the superseded Electron application and its runtime dependencies.

## Validation

The validation pipeline passes 109 JavaScript and 83 Rust tests, ESLint, TypeScript,
Clippy with warnings denied, and the production frontend build. The native
WebView2 smoke harness uses isolated databases, saves and browser profiles;
it never restores over a user's game files.

- [x] Native window, dialog authorization, backup/restore, 7z export and shutdown smoke tests.
- [x] Five consecutive menu open/size/disabled/Escape cycles reusing one independent native window.
- [x] Actual View/Games/Help menu actions and save-row right-click/more menus, including complete content sizing.
- [x] Shutdown with an unanswered restore-conflict dialog preserves the newer save.
- [x] Interval backup start/stop and watcher reattachment after a directory-replacing restore.
- [x] Read-only detection of local saves with the real catalog; Windows DWM reports Mica enabled.
- [x] Build the unsigned NSIS installer and verify its embedded executable, database and license resource declarations.
- [x] Validate the packaged x64 per-user Windows installer: first install, actual Electron upgrade, data preservation, reinstall and default/optional-reset uninstall in English and Chinese.
- [ ] Validate a release signed with the production Windows certificate and matching Tauri updater key pair, including a real signed update.
- [x] Combined test and frontend build results after migration fixes.

Run `npm run smoke:desktop -- --conflict-close --watcher` against a built debug
application, or add `--binary <exe>` to validate the release executable. Every
run retains `summary.json` and `native.log` under `dist/native-smoke-*`.

The packaged runtime also passes an empty-profile startup with `--fresh`.
See [Windows installer verification](WINDOWS_INSTALLER_VERIFICATION.md) for the
installer migration fixes, retained evidence and the guarded lifecycle harness.
The complete lifecycle passed in a temporary standard Windows account, which was
then removed with its profile. This host's real Electron installation was not
modified.

## Responsiveness and rendering

Translations use the same bundled catalogs locally in the frontend. Ordinary
IPC checks the native window's immutable role; the initial document check and
native navigation callback enforce its page boundary without querying WebView2
for the URL on every command. Database scans select installed/candidate rows
before parsing save definitions, index installation roots once per scan, and
read the latest backup metadata without walking every historical payload.
Battle.net artwork indexing is lazy, image IPC uses bounded base64 payloads,
and WebDAV avoids repeating verified directory/probe requests within their scope.

Full catalog scans share bounded directory, metadata, size and pattern caches,
precompile placeholder expressions and use native registry existence checks.
Their coverage includes uninstalled games; live path validation remains mandatory
for real directory reads and mutations. Scan loops observe shutdown cancellation.
See [PERFORMANCE.md](PERFORMANCE.md) for the equivalent-result I/O comparison.

Mica uses a transparent WebView over the native Windows backdrop. Fonts use
system rendering, the logo uses SVG, and menus no longer scale text or wait
for animation frames while hidden. Initial/obsolete focus events cannot dismiss
a menu that has not been shown. A precreated independent menu WebView is retained
across hide/show cycles, with native shadow disabled to remove Windows' extra
white border. Request IDs protect reused windows from stale actions and sizing
responses; physical positioning respects the monitor work area and DPI.
Window-state locks are released before native
calls and event delivery. Shutdown cancels dialog waiters and drains mutations,
including repeated close requests.

## Architecture boundaries

The frontend sends domain requests through a bridge; it has no general file,
process, HTTP or shell permission. Rust resolves roles from registered native
windows, validates each channel against the shared role policy and exact local
page, then invokes domain services. Events target authorized WebViews. Save
targets come from the trusted local database, never from renderer-supplied
resolved paths. Long disk/network work runs off the UI thread. Mutating
save/database/sync operations share an operation lock.

## Existing installations and release configuration

Windows continues to use `%APPDATA%/opengamesave` for settings and the database,
and `%APPDATA%/OGS Backups` as the default backup directory. Existing backups
are read in place, including legacy metadata and 7z `.gsmr` archives. Legacy
DPAPI WebDAV credentials are migrated when decryptable; their source files are
preserved.

Electron users must download and install their first Tauri version manually:
the former Electron update manifest is incompatible with Tauri's signed update
manifest. Subsequent official Tauri releases use the updater public key embedded
at build time. Keep that public key paired with the release signing private key.

Node.js 24 and Rust stable (minimum 1.93, declared by `src-tauri/Cargo.toml`)
are build dependencies. `npm run app:dist` creates a local unsigned installer
without release credentials. `npm run app:dist:release` requires the public
updater key, private signing key and an imported Windows certificate, generates
the signing configuration, builds, and verifies the installer identity before
staging release assets. Local builds with no updater public key use the release
page for manual downloads.

The `application-release` GitHub environment uses `WINDOWS_CSC_LINK`,
`WINDOWS_CSC_KEY_PASSWORD`, `WINDOWS_PUBLISHER_NAME`,
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets,
plus the public `TAURI_UPDATER_PUBLIC_KEY` repository/environment variable.
Windows Authenticode and Tauri updater signatures use separate signing identities.
The workflow imports the Windows certificate, embeds only the Tauri public key,
validates Authenticode and downloaded release hashes, then publishes the draft.
Private signing credentials are not required by ordinary CI or local development.
