# OpenGameSave
## Game on. Worry-free.
English | [中文](./README_CN.md)

<div align="center">
<img src="src/assets/logo.png" alt="OpenGameSave logo" width="250" />
</div>

> Current developers: [leisurefire](https://github.com/leisurefire). Former developers: Yongcan Yang. This fork is maintained at [leisurefire/OpenGameSave](https://github.com/leisurefire/OpenGameSave).

Safeguard every save from Steam, Epic, and even custom locations all in one place. Restore them in a heartbeat. Your progress, exactly as it should be—yours.

### Stunning by design.
Every detail, thoughtfully refined. Embracing the Windows 11 Mica effect, the interface is beautifully translucent, brilliantly simple, and effortlessly elegant.

### Turn back time.
Regrets are a thing of the past. Automatically maintain a rolling history of your backups, or manually pin your most epic milestones so they are never lost.

### Head into the clouds. (In development)
Soon, your saves will go wherever you do. Upcoming updates will let you customize your backup paths, seamlessly syncing your precious progress to platforms like GitHub repositories and Google Drive.

### Universally compatible.
Powered by the PCGamingWiki database, OpenGameSave effortlessly recognizes save locations for over 14,000 games right out of the box.

Database paths are also sourced from the MIT-licensed Ludusavi Manifest and XgpSaveTools registry. GitHub Actions publishes separate **Standard** and **Xbox Enhanced** database editions; the Xbox registry is merged into an ephemeral build database and is never committed over the standard database. See [database sources and Xbox format notes](database/SOURCES.md).

Choose the database edition in Settings, then enable **Update database automatically** or use **Update Database**. Each edition has its own sequential patches and validated full-database fallback; switching editions always installs a complete database.

### Seamless migration.
Upgraded your PC? Just export a sleek .gsmr archive and bring your entire gaming history to your new device with one simple click.

### Installation
Head over to the [Latest Release page](https://github.com/leisurefire/OpenGameSave/releases/latest), download the newest installer built for Windows, launch OpenGameSave, and enjoy your games with absolute peace of mind.

Installed builds can check for application updates at startup. When an update is available, use the download button beside **Options**; OpenGameSave verifies the release metadata, downloads the installer, closes safely, installs the update, and starts again.

### Developers
- Current developers: [leisurefire](https://github.com/leisurefire)
- Former developers: Yongcan Yang

WebDAV requires HTTPS. Local integration tests may explicitly enable plain HTTP for loopback addresses only by setting `NODE_ENV=development` and `OPENGAMESAVE_ALLOW_INSECURE_LOCALHOST=1`.

### License
OpenGameSave is licensed under GPL-3.0-only. See [third-party notices](THIRD_PARTY_NOTICES.md) for the MIT-licensed database sources distributed with the project.
