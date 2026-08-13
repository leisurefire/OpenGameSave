# Database sources and Xbox save formats

OpenGameSave's primary database is based on PCGamingWiki. The scheduled incremental sync also consumes the MIT-licensed [Ludusavi Manifest](https://github.com/mtkennerly/ludusavi-manifest), which is itself primarily compiled from PCGamingWiki and store metadata.

## Xbox formats

- **WGS / XGameSave** stores container-and-blob data under `%LOCALAPPDATA%\Packages\<package>\SystemAppData\wgs`. Microsoft documents the container/blob model and the PC path in the [XGameSave overview](https://learn.microsoft.com/en-us/gaming/gdk/docs/features/common/game-save/xgamesave).
- **XGS / XGameSaveFiles** is the newer file-oriented GDK API and uses `%LOCALAPPDATA%\Packages\<package>\SystemAppData\xgs`. Microsoft recommends it for new GDK titles and documents the path in the [XGameSaveFiles overview](https://learn.microsoft.com/en-us/gaming/gdk/docs/features/common/game-save/xgamesavefiles).
- **PGS** has been observed in newer PC releases under `%SystemDrive%\XboxGames\GameSave\pgs\u_<user-id>_<game-id>`. The community [XgpSaveTools](https://github.com/brodrigz/XgpSaveTools) implementation resolves the active snapshot and backs up both metadata and `ContainersRoot`. It intentionally does not write PGS data back because a safe cloud-aware transaction is not yet available.

OpenGameSave therefore treats PGS paths as **backup-only**. The database may contain a PGS location and the application may copy it into a backup, but automatic restore skips it to avoid corrupting the Gaming Services snapshot or racing Xbox cloud synchronization.

XgpSaveTools is useful implementation research, but its repository currently has no declared license. Its `games.json` is therefore not ingested into the tracked database, copied by GitHub Actions, or bundled with releases.

Users may explicitly enable **Experimental Sources → XgpSaveTools registry** in the application settings. Before the first enablement, OpenGameSave shows the upstream license status and requires confirmation that the user has reviewed and accepts the applicable third-party terms. This confirmation does not create or grant any license rights.

When enabled, the application downloads `games.json` directly from the upstream repository at runtime, validates it, keeps a minimal per-user cache, and conservatively overlays exact normalized title matches onto existing database rows. Only WGS/PGS package and save-path mappings are used; XgpSaveTools handlers are not integrated. The cache is refreshed at most once per day on startup and deleted when the option is disabled. This experimental integration has no availability or accuracy guarantee.

## Ludusavi incremental sync

The workflow in `.github/workflows/ludusavi-sync.yml` runs every Monday at 03:23 UTC and can also be started manually. It creates or updates an automated pull request instead of committing directly to the default branch.

The converter follows these rules:

1. Match an existing OpenGameSave row by primary Steam or GOG ID; use an exact normalized title only when no stable ID match exists.
2. Reject identifier conflicts, ambiguous/unmatched games, path traversal, unsupported placeholders, and protected registry locations.
3. Convert supported Ludusavi placeholders into OpenGameSave placeholders, append only paths that are not already present, and normalize legacy hard-coded PGS system-drive prefixes.
4. Never delete an existing path or create a game without a PCGamingWiki `wiki_page_id`.
5. Keep a detailed JSON report as a workflow artifact and record the last manifest content hash applied to the database in `database/sources/ludusavi.json`.

Run a local preview with:

```text
npm run db:sync:ludusavi
```

Apply the preview to `database/database.db` with:

```text
npm run db:sync:ludusavi:apply
```

The sync is additive by design. Upstream removals require human review in OpenGameSave.

## Application database updates

When `database/database.db` changes on the default branch, `.github/workflows/db-patch.yml` automatically compares it with the database currently published in the dedicated `database` GitHub Release. It increments SQLite `user_version`, publishes the next `db_patch_vN.json`, retains older sequential patches, and replaces the full `database.db` fallback asset.

When **Update database automatically** is enabled, OpenGameSave checks that dedicated release at startup. It applies every missing sequential patch under a database write lock. If the patch chain is incomplete, it downloads and validates the full database instead. The previous user database is retained until integrity validation succeeds and is restored if an update fails. Manual updates use the same path through the sidebar button.
