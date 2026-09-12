<p align="center">
  <img src="src/assets/logo.png" alt="OpenGameSave logo" width="220">
</p>

<h1 align="center">OpenGameSave</h1>

<p align="center"><strong>Back up, restore, move, and synchronize PC game saves from one Windows app.</strong></p>

<p align="center">
  English · <a href="README_CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/leisurefire/OpenGameSave/releases/latest"><img src="https://img.shields.io/github/v/release/leisurefire/OpenGameSave?label=release" alt="Latest release"></a>
  <a href="https://github.com/leisurefire/OpenGameSave/actions/workflows/test.yml"><img src="https://github.com/leisurefire/OpenGameSave/actions/workflows/test.yml/badge.svg" alt="CI status"></a>
  <a href="LICENSE.txt"><img src="https://img.shields.io/badge/license-GPL--3.0--only-2ea44f.svg" alt="GPL-3.0-only license"></a>
</p>

## Overview

OpenGameSave is a local-first desktop application for finding, backing up, restoring, exporting, and synchronizing PC game saves. Its database contains save-location mappings for more than 14,000 games, while custom installation roots cover games outside the automatically detected libraries.

The app is designed around recoverable snapshots: keep a rolling history, preserve important backups permanently, and review a conflict before an older backup replaces newer local data.

> [!IMPORTANT]
> Xbox PGS saves are **backup-only**. OpenGameSave intentionally blocks their automatic restore and deletion because those snapshots are managed by Xbox Gaming Services and cloud synchronization.

## Highlights

- **Unified installed-game library** — scan Steam, Epic Games, GOG, and Battle.net; search and filter the library, launch a game, or open its installation folder.
- **Broad save detection** — back up database-defined files, folders, and Windows Registry data, add custom installation roots, and optionally scan for saves from uninstalled games.
- **Versioned backups** — back up multiple games at once, configure the number of regular snapshots retained per game, and mark important snapshots as permanent.
- **Per-game automatic backups** — run on a configurable interval or when watched save files change.
- **Safer restores** — warn when local data is newer, authorize destinations against the current trusted database definition, and roll back file-system and Registry changes when a restore fails.
- **Portable migration** — export all or selected backups to a validated `.gsmr` archive and import it on another computer.
- **Working cloud sync** — upload and download backups through an existing GitHub repository or an HTTPS WebDAV server.
- **Database and guide links** — choose the Standard or Xbox Enhanced database and open an exact PCGamingWiki technical page for matched games, with additional manually reviewed sources where available.
- **English and Simplified Chinese UI** — with a configurable sidebar, Windows Mica material, and optional system accent color.

## Platform and requirements

- **Windows is the only platform with official installers.** The application contains some guarded cross-platform code, but macOS and Linux builds are not currently published or supported.
- Windows 11 provides the full Mica visual effect. The repository does not declare a specific minimum Windows release.
- Microsoft Edge WebView2 Runtime is required to display the application.
- Git is optional and is required only for GitHub synchronization.
- WebDAV synchronization requires an HTTPS endpoint. Plain HTTP is rejected outside explicitly enabled loopback development tests.
- Allow enough free space for both the original saves and the backup history you choose to retain.

## Installation

1. Open the [latest release](https://github.com/leisurefire/OpenGameSave/releases/latest).
2. Download `OpenGameSave_<version>_x64-setup.exe` and run the installer.
3. Confirm the backup storage folder in **Sync**, then review the detected game installation roots in **Settings**.
4. Open **Saves**, select the games you want to protect, and create the first backup.

Official releases are produced by the Windows release workflow, which requires a signed installer and validated update metadata. Installed builds can check for updates at startup; when an update is available, use the download button beside **Options**. Pre-release updates remain opt-in.

## Quick start

1. **Choose storage.** The default Windows backup folder is `%APPDATA%\OGS Backups`; it can be changed in **Sync**. Moving it later uses the built-in migration flow.
2. **Find games.** Open **Library** to scan supported launchers. In Settings, auto-detect or add installation roots for save matching; enable the full database scan if you also need saves from uninstalled games.
3. **Create snapshots.** In **Saves → Backup**, select one or more games and run a backup. Use **Manage Backups** to name, preserve, or remove snapshots.
4. **Restore carefully.** In **Saves → Restore**, choose a snapshot. If the computer contains newer save data, OpenGameSave asks whether to skip or replace it.
5. **Automate or migrate.** Enable interval- or file-change-based automatic backup for individual games, or export selected history to a `.gsmr` archive.

Database paths can change as games are updated. Verify that the first backup contains the expected data before relying on it, and keep an independent copy of irreplaceable saves.

## Synchronization

Cloud synchronization is available now, but it is explicit rather than an automatic background service: use **Check**, **Upload Local Backups**, or **Download Backups** from the Sync page.

| Provider | Setup | Behavior | Credentials |
| --- | --- | --- | --- |
| GitHub repository | Install Git and set the backup folder to the root of a local clone whose `origin` points to the target GitHub repository. | Pulls `origin/main` when it exists, applies retention, then commits and pushes local backups. Download uses a fast-forward-only pull and validates imported backup metadata. | Managed entirely by the local Git configuration or credential helper; OpenGameSave does not read Git credentials. |
| WebDAV | Enter an HTTPS server URL, optional username and password, and a remote folder. | Uploads changed content, verifies remote objects, merges downloads transactionally, and preserves both versions of multi-device conflicts. | The password is encrypted with Windows Credential Manager / DPAPI for the current operating-system account; after it is saved, it is never returned to the renderer. |

OpenGameSave does not encrypt the backup payload itself. Use a private GitHub repository or a trusted WebDAV service, and prefer an app-specific WebDAV password.

## Xbox database notes

Settings offers two independently updated database editions:

- **Standard** — the normal PCGamingWiki-based database, with reviewed additions from the Ludusavi Manifest.
- **Xbox Enhanced** — a generated copy that also merges compatible WGS/PGS mappings from the MIT-licensed XgpSaveTools registry.

Switching editions installs a validated complete database; same-edition updates may use sequential patches with a full-database fallback. Xbox PGS locations can be copied into backups, but OpenGameSave will not restore or delete them automatically. See [database sources and Xbox save formats](database/SOURCES.md) for the rationale and update design.

## Data and privacy

- Backup, scan, export, import, and restore operations run locally. Backup folders and `.gsmr` archives may contain save files, Registry exports, account-related game data, and metadata; they are **not encrypted by OpenGameSave**.
- Settings are stored below OpenGameSave's user-data directory in `OGS Settings/settings.json`. The updatable database is stored in `OGS Database/database.db`, and error logs are written below `logs/`.
- This repository does not include an analytics or telemetry integration.
- The application may connect to GitHub for application or database updates, and may retrieve missing library artwork from size-limited, allowlisted official Steam, Epic, GOG, or Blizzard resources. Guide and project links open in the system browser.
- GitHub and WebDAV receive backup content only when you configure the provider and invoke a synchronization action. Git credentials remain with Git; WebDAV passwords use operating-system-backed encryption. Other processes running as the same operating-system user remain within the same trust boundary.
- Error logs can contain technical details or local paths. Review logs and archives before sharing them publicly.

The interface runs in WebView2 without Node.js. Tauri and Rust enforce a restrictive Content Security Policy and a default-deny command boundary for each window role. Filesystem, Registry, archive, URL, and sync inputs are validated in Rust.

## Database and attribution

The primary game database is based on PCGamingWiki. Scheduled maintenance also uses the MIT-licensed [Ludusavi Manifest](https://github.com/mtkennerly/ludusavi-manifest), and the Xbox Enhanced edition uses selected mappings from the MIT-licensed [XgpSaveTools](https://github.com/brodrigz/XgpSaveTools) registry. OpenGameSave links to external guide content and does not redistribute those articles or game artwork.

Read [database/SOURCES.md](database/SOURCES.md) for provenance, update workflows, and Xbox format details. Complete third-party notices and source-specific licenses are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `database/licenses/`.

## Development

The desktop runtime is **Tauri 2 with a Rust core**. JavaScript, HTML and CSS remain in the web frontend; Node.js 24 and npm are build/test/database-maintenance tools. The application ships without Electron or a Node sidecar.

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/): Rust stable (minimum 1.93, declared in `src-tauri/Cargo.toml`), Visual Studio C++ Build Tools and WebView2 on Windows. The repository selects the stable toolchain in `rust-toolchain.toml`. Windows is the supported release/test platform.

```powershell
npm ci
npm run dev                 # Build the frontend and launch Tauri
npm run check               # JS checks/tests, Rust Clippy/tests and frontend build
npm run build               # Build the native application without bundling
npm run app:dist            # Build a local unsigned Windows NSIS installer
npm run rust:test           # Isolated file, database, registry and WebDAV tests
npm run frontend:build      # Build only the web frontend
```

Frontend output is in dist/out/renderer, native binaries in src-tauri/target/release, and installers in src-tauri/target/release/bundle/nsis. After frontend changes, run npm run frontend:build and reload the window; the Tauri CLI watches Rust changes.

## Architecture and migration

```text
src-tauri/src/           Tauri lifecycle, native windows, authorization, settings and application services
src-tauri/src/saves/     SQLite, save discovery, backups, restore authorization, transactions, archives and database updates
src-tauri/src/sync/      Git/WebDAV, OS credentials, validation, reconciliation and transaction recovery
src-tauri/src/library/   Launcher/account discovery, artwork and guide matching
src/renderer/           Web frontend and asynchronous Tauri bridge
src/shared/             Shared window-role contract and virtual-list logic
scripts/                Build, release and database-maintenance tools
scripts/lib/            JavaScript validation used only by maintenance tools
```

Rust checks each request against an immutable native window role and its exact local page, and targets events only to authorized windows. The frontend has no general filesystem, process, network or window-creation permission. Blocking disk/database/network work uses the blocking task pool. Backup, restore, sync and database mutations share an operation lock; shutdown waits for active operations.

On Windows, settings continue to use %APPDATA%/opengamesave/OGS Settings/settings.json, with the database under OGS Database/database.db. The default backup directory remains %APPDATA%/OGS Backups. Existing backups are adopted in place. Minute/second timestamps, backup_info.json and legacy 7z .gsmr archives remain supported; validated ZIP .gsmr input is also accepted. Legacy DPAPI WebDAV credentials are migrated to Windows Credential Manager when possible; otherwise re-enter the password. Existing credential files are preserved.

Install the first Tauri release manually when switching from Electron: the two update manifest formats differ. Subsequent Tauri releases use signed updates. Local builds without an updater public key open the release page for manual downloads.

Signed releases use the `application-release` GitHub environment. Configure `WINDOWS_CSC_LINK` (base64 PFX or an HTTPS PFX URL), `WINDOWS_CSC_KEY_PASSWORD` and `WINDOWS_PUBLISHER_NAME` secrets for Windows Authenticode, plus `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets for Tauri updater signatures. Set the matching public key as the `TAURI_UPDATER_PUBLIC_KEY` repository/environment variable. These are separate signing identities; only the updater public key is embedded in the application.

The workflow runs `npm run app:dist:release`, verifies the installer certificate and downloaded remote artifact hashes, then publishes. Local signed packaging uses the same command with `OGS_UPDATER_PUBLIC_KEY`, `TAURI_SIGNING_PRIVATE_KEY`, its optional password, and `OGS_CERTIFICATE_THUMBPRINT` for an imported Windows certificate. Ordinary `npm run app:dist` requires none of these credentials and produces an unsigned local installer. Current implementation and remaining native/installer validation are tracked in [MIGRATION.md](MIGRATION.md).

Database maintainers should read [database/SOURCES.md](database/SOURCES.md) before running db:sync:* scripts.

## Contributing

Bug reports, game requests, documentation fixes, and focused pull requests are welcome.

1. Search [existing issues](https://github.com/leisurefire/OpenGameSave/issues) first, then use the repository's bug-report or add-game issue form when appropriate.
2. Keep changes focused and preserve user save data. User-visible text must be added to both `src/locale/en_US.json` and `src/locale/zh_CN.json`.
3. Do not weaken renderer sandboxing, IPC authorization, path validation, archive validation, or restore confirmation flows.
4. Run `npm run check` before opening a pull request.
5. Do not commit personal saves, settings, logs, credentials, packaged installers, or generated `dist/` output.

For database changes, follow the matching, licensing, and preview requirements in [database/SOURCES.md](database/SOURCES.md). Save paths for pirated copies are not accepted.

## Maintainers and acknowledgements

- Current maintainer: [leisurefire](https://github.com/leisurefire)
- Original and former developer: Yongcan Yang

This fork is maintained at [leisurefire/OpenGameSave](https://github.com/leisurefire/OpenGameSave).

## License

OpenGameSave is licensed under [GPL-3.0-only](LICENSE.txt). Separately licensed database sources and external-content notices are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
