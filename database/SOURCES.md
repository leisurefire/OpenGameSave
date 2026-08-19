# Database sources and Xbox save formats

OpenGameSave's primary database is based on PCGamingWiki. The scheduled incremental sync also consumes the MIT-licensed [Ludusavi Manifest](https://github.com/mtkennerly/ludusavi-manifest), which is itself primarily compiled from PCGamingWiki and store metadata.

## Curated guide catalog

The `game_guide_catalog` metadata record is a small, reviewed directory of external guide sources. Its maintained source is `src/data/gameGuides.json`; `npm run db:sync:guides` synchronizes that catalog into the tracked SQLite database without embedding or republishing third-party article content.

The first supported game is Overwatch. Sources are restricted to HTTPS pages on an explicit host allowlist and currently include the official Chinese Overwatch hero and patch pages, the Chinese community knowledge base OverLab (春语实验室), and Liquipedia's established competitive Overwatch wiki. The application opens these sources in the system browser instead of embedding remote pages.

## Xbox formats

- **WGS / XGameSave** stores container-and-blob data under `%LOCALAPPDATA%\Packages\<package>\SystemAppData\wgs`. Microsoft documents the container/blob model and the PC path in the [XGameSave overview](https://learn.microsoft.com/en-us/gaming/gdk/docs/features/common/game-save/xgamesave).
- **XGS / XGameSaveFiles** is the newer file-oriented GDK API and uses `%LOCALAPPDATA%\Packages\<package>\SystemAppData\xgs`. Microsoft recommends it for new GDK titles and documents the path in the [XGameSaveFiles overview](https://learn.microsoft.com/en-us/gaming/gdk/docs/features/common/game-save/xgamesavefiles).
- **PGS** has been observed in newer PC releases under `%SystemDrive%\XboxGames\GameSave\pgs\u_<user-id>_<game-id>`. The community [XgpSaveTools](https://github.com/brodrigz/XgpSaveTools) implementation resolves the active snapshot and backs up both metadata and `ContainersRoot`. It intentionally does not write PGS data back because a safe cloud-aware transaction is not yet available.

OpenGameSave therefore treats PGS paths as **backup-only**. The database may contain a PGS location and the application may copy it into a backup, but automatic restore skips it to avoid corrupting the Gaming Services snapshot or racing Xbox cloud synchronization.

The [XgpSaveTools](https://github.com/brodrigz/XgpSaveTools) repository is licensed under MIT, Copyright (c) 2026 Bruno Rodrigues. The required notice is retained in `database/licenses/XGPSAVETOOLS-LICENSE.txt` and packaged with the application.

OpenGameSave imports only the WGS/PGS package and save-path mappings from `games.json`; it does not copy or execute XgpSaveTools handlers. Mappings are matched to a unique existing database row by normalized full title and appended without replacing paths from the standard database. Ambiguous and unmatched titles are reported but not imported.

The mappings are merged by GitHub Actions into an ephemeral Xbox-enhanced database instead of being downloaded or merged by installed clients. The tracked `database/database.db` remains the standard edition.

## XgpSaveTools incremental sync

The workflow in `.github/workflows/db-patch.yml` runs every Wednesday at 04:47 UTC, on relevant database changes, and on manual dispatch. It verifies that GitHub still identifies the upstream license as MIT, resolves one upstream commit, and downloads both `games.json` and `LICENSE` from that exact revision. If any validation fails, publication stops.

Actions then copies the standard database, performs the merge into the copy, and publishes it directly as the Xbox-enhanced edition. It also publishes the untouched standard edition. There is no sync pull request and users do not merge data themselves. A workflow artifact records unmatched titles, conflicts, added paths, and source hashes; PGS paths remain backup-only. Because the enhanced edition is rebuilt from the standard database on every run, an XgpSaveTools-only path removed upstream will disappear from the next enhanced edition, while standard database paths remain untouched.

The two independent release chains are:

- Standard: `current.json`, `manifest_vN.json`, `database_vN.db`, `db_patch_vN.json`.
- Xbox Enhanced: `current_xbox.json`, `manifest_xbox_vN.json`, `database_xbox_vN.db`, `db_patch_xbox_vN.json`.

The Xbox database embeds its edition marker, matched game IDs, registry and license hashes, and the complete MIT notice in SQLite metadata. Upstream registry or license changes are therefore detected by the scheduled run without changing the tracked standard database.

Run a local preview with:

```text
npm run db:sync:xgp
```

The apply step is reserved for the ephemeral Actions copy so a local preview cannot accidentally overwrite the standard database.

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

`.github/workflows/db-patch.yml` compares both generated editions with their respective publications in the dedicated `database` GitHub Release. Each chain independently increments SQLite `user_version`, publishes immutable versioned databases and patches, and advances only its own `current*.json` pointer.

Users select **Standard** or **Xbox Enhanced** in Settings. When **Update database automatically** is enabled, OpenGameSave checks the selected chain at startup; manual updates use the same selection. It applies missing patches only when the local database belongs to that same edition. Switching editions, an incomplete patch chain, or a schema mismatch triggers a validated full download. The previous user database is retained until integrity validation succeeds and is restored if an update fails.
