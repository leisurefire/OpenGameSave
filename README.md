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
- Git is optional and is required only for GitHub synchronization.
- WebDAV synchronization requires an HTTPS endpoint. Plain HTTP is rejected outside explicitly enabled loopback development tests.
- Allow enough free space for both the original saves and the backup history you choose to retain.

## Installation

1. Open the [latest release](https://github.com/leisurefire/OpenGameSave/releases/latest).
2. Download `OpenGameSave-Setup-<version>.exe` and run the installer.
3. Open **Options**, confirm the backup storage folder, and review the detected game installation roots.
4. Open **Saves**, select the games you want to protect, and create the first backup.

Official releases are produced by the Windows release workflow, which requires a signed installer and validated update metadata. Installed builds can check for updates at startup; when an update is available, use the download button beside **Options**. Pre-release updates remain opt-in.

## Quick start

1. **Choose storage.** The default Windows backup folder is `%APPDATA%\OGS Backups`; it can be changed in Settings. Moving it later uses the built-in migration flow.
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
| WebDAV | Enter an HTTPS server URL, optional username and password, and a remote folder. | Uploads changed content, verifies remote objects, merges downloads transactionally, and preserves both versions of multi-device conflicts. | The password is encrypted with Electron `safeStorage` for the current operating-system account; after it is saved, it is never returned to the renderer. |

OpenGameSave does not encrypt the backup payload itself. Use a private GitHub repository or a trusted WebDAV service, and prefer an app-specific WebDAV password.

## Xbox database notes

Settings offers two independently updated database editions:

- **Standard** — the normal PCGamingWiki-based database, with reviewed additions from the Ludusavi Manifest.
- **Xbox Enhanced** — a generated copy that also merges compatible WGS/PGS mappings from the MIT-licensed XgpSaveTools registry.

Switching editions installs a validated complete database; same-edition updates may use sequential patches with a full-database fallback. Xbox PGS locations can be copied into backups, but OpenGameSave will not restore or delete them automatically. See [database sources and Xbox save formats](database/SOURCES.md) for the rationale and update design.

## Data and privacy

- Backup, scan, export, import, and restore operations run locally. Backup folders and `.gsmr` archives may contain save files, Registry exports, account-related game data, and metadata; they are **not encrypted by OpenGameSave**.
- Settings are stored below Electron's user-data directory in `OGS Settings/settings.json`. The updatable database is stored in `OGS Database/database.db`, and fatal error logs are written below `logs/`.
- This repository does not include an analytics or telemetry integration.
- The application may connect to GitHub for application or database updates, and may retrieve missing library artwork from size-limited, allowlisted official Steam, Epic, GOG, or Blizzard resources. Guide and project links open in the system browser.
- GitHub and WebDAV receive backup content only when you configure the provider and invoke a synchronization action. Git credentials remain with Git; WebDAV passwords use operating-system-backed encryption. Other processes running as the same operating-system user remain within the same trust boundary.
- Error logs can contain technical details or local paths. Review logs and archives before sharing them publicly.

The renderer runs with Node.js integration disabled, context isolation and sandboxing enabled, a restrictive Content Security Policy, and a role-scoped default-deny IPC bridge. Filesystem, Registry, archive, URL, and sync inputs are validated in the main process.

## Database and attribution

The primary game database is based on PCGamingWiki. Scheduled maintenance also uses the MIT-licensed [Ludusavi Manifest](https://github.com/mtkennerly/ludusavi-manifest), and the Xbox Enhanced edition uses selected mappings from the MIT-licensed [XgpSaveTools](https://github.com/brodrigz/XgpSaveTools) registry. OpenGameSave links to external guide content and does not redistribute those articles or game artwork.

Read [database/SOURCES.md](database/SOURCES.md) for provenance, update workflows, and Xbox format details. Complete third-party notices and source-specific licenses are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `database/licenses/`.

## Development

The CI and release workflows use **Node.js 24** and npm. Windows is recommended for running the complete application because Registry handling, launcher detection, notifications, and the official packaging flow are Windows-oriented.

Run commands from the repository root:

```powershell
npm ci

# Tailwind and Webpack watchers plus Electron
npm run dev

# Lint, checkJs type-checking, coverage tests, and a production build
npm run check

# Individual checks
npm run lint
npm run typecheck
npm run test
npm run test:coverage

# Build or launch
npm run build
npm start

# Package locally
npm run app:dir
npm run app:dist
```

`npm run build` writes production bundles to `dist/out`. `npm start` runs the production build and rebuilds Electron native dependencies before launching. `npm run app:dir` creates an unpacked application for local verification; `npm run app:dist` creates local distributables, while official signed releases are produced only by the release workflow. Use `npm run styles:build` to compile shared Tailwind CSS without building the application.

Database maintainers should follow the preview/apply rules in [database/SOURCES.md](database/SOURCES.md) before using the `db:sync:*` scripts.

## Architecture

```text
src/main/       Electron lifecycle, IPC handlers, workers, backup/restore,
                synchronization, database updates, and OS integration
src/preload/    Role-scoped contextBridge API exposed to renderer pages
src/shared/     Shared IPC policy and library virtualization code
src/renderer/   Main, settings, about, modal, and menu pages, components, CSS
src/locale/     English and Simplified Chinese translations
src/data/       Reviewed guide catalog source
database/       Tracked Standard SQLite database, source metadata, licenses
scripts/        Build, release, database synchronization, and validation tools
test/           Node test-runner suites
```

Webpack builds separate main, preload, and renderer targets. Backup/database work uses a bounded worker pool, and installed-library scanning runs in a separate worker so long-running operations do not block the interface.

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
