use super::{accounts, entries, read_json, text, vdf, Game, MAX_ENTRIES};
use serde_json::json;
use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
};

fn safe_id(id: &str, max: usize, numeric: bool) -> bool {
    !id.is_empty()
        && id.len() <= max
        && id.bytes().all(|c| {
            if numeric {
                c.is_ascii_digit()
            } else {
                c.is_ascii_alphanumeric() || b"._-".contains(&c)
            }
        })
}

pub(super) fn resolve_install(root: &Path, relative: &str) -> Option<PathBuf> {
    if relative.is_empty() || relative.len() > 260 {
        return None;
    }
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        return None;
    }
    let canonical_root = root.canonicalize().ok()?;
    let result = root.join(path).canonicalize().ok()?;
    (result.is_dir() && result.starts_with(&canonical_root)).then(|| accounts::native_path(result))
}

fn add_images(game: &mut Game, root: &Path, names: &[&str], hero: bool) {
    for name in names {
        for extension in ["jpg", "jpeg", "png", "webp"] {
            let candidate = root.join(format!("{name}.{extension}"));
            if candidate.is_file() {
                if hero {
                    game.hero.push(candidate);
                } else {
                    game.cover.push(candidate);
                }
            }
        }
    }
}

fn steam() -> Vec<Game> {
    let mut games = Vec::new();
    let mut visited = HashSet::new();
    for steam_root in accounts::steam_roots() {
        for root in accounts::steam_libraries(&steam_root) {
            let apps = root.join("steamapps");
            if !visited.insert(apps.clone()) {
                continue;
            }
            for file in entries(&apps, MAX_ENTRIES) {
                if games.len() >= MAX_ENTRIES {
                    return games;
                }
                let name = file.file_name().to_string_lossy().to_lowercase();
                if !name.starts_with("appmanifest_") || !name.ends_with(".acf") {
                    continue;
                }
                let data = vdf::read(&file.path());
                let app = vdf::get(&data, "AppState");
                let id = text(vdf::get(app, "appid"));
                let title = text(vdf::get(app, "name"));
                if !safe_id(&id, 12, true)
                    || id == "228980"
                    || title.is_empty()
                    || text(vdf::get(app, "type")) == "Tool"
                {
                    continue;
                }
                let Some(install) =
                    resolve_install(&apps.join("common"), &text(vdf::get(app, "installdir")))
                else {
                    continue;
                };
                let mut game = Game::new("Steam", &id, &title, install);
                let cache = steam_root.join("appcache/librarycache");
                let app_root = cache.join(&id);
                game.art_roots.push(cache.clone());
                add_images(
                    &mut game,
                    &app_root,
                    &["library_600x900_2x", "library_600x900", "library_capsule"],
                    false,
                );
                add_images(
                    &mut game,
                    &app_root,
                    &["library_hero", "library_header", "header"],
                    true,
                );
                add_images(
                    &mut game,
                    &cache,
                    &[&format!("{id}_library_600x900")],
                    false,
                );
                add_images(
                    &mut game,
                    &cache,
                    &[&format!("{id}_library_hero"), &format!("{id}_header")],
                    true,
                );
                for entry in entries(&app_root, 1024) {
                    let name = entry.file_name().to_string_lossy().to_lowercase();
                    if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                        add_images(
                            &mut game,
                            &entry.path(),
                            &["library_600x900", "library_capsule"],
                            false,
                        );
                        add_images(
                            &mut game,
                            &entry.path(),
                            &["library_hero", "library_header"],
                            true,
                        );
                    } else if name.starts_with("library_600x900") {
                        game.cover.push(entry.path());
                    } else if name.starts_with("library_hero")
                        || name.starts_with("library_header")
                        || name.starts_with("header")
                    {
                        game.hero.push(entry.path());
                    }
                }
                games.push(game);
            }
        }
    }
    games
}

fn epic() -> Vec<Game> {
    if !cfg!(windows) {
        return vec![];
    }
    let root = accounts::program_data().join("Epic/EpicGamesLauncher/Data/Manifests");
    let mut games = Vec::new();
    for file in entries(&root, MAX_ENTRIES) {
        if file.path().extension().is_none_or(|e| e != "item") {
            continue;
        }
        let data = read_json(&file.path());
        let id = text(&data["AppName"]);
        let title = text(&data["DisplayName"]);
        let install = PathBuf::from(text(&data["InstallLocation"]));
        if !safe_id(&id, 256, false)
            || title.is_empty()
            || !install.is_absolute()
            || !install.is_dir()
        {
            continue;
        }
        let mut game = Game::new("Epic", &id, &title, install.clone());
        game.art_roots = vec![root.clone(), install.clone()];
        for (keys, hero) in [
            (
                vec![
                    "CoverImagePath",
                    "CoverPath",
                    "PortraitImagePath",
                    "ThumbnailPath",
                    "ImagePath",
                ],
                false,
            ),
            (
                vec![
                    "HeroImagePath",
                    "BackgroundImagePath",
                    "BannerImagePath",
                    "WideImagePath",
                ],
                true,
            ),
        ] {
            for key in keys {
                let value = text(&data[key]);
                if value.is_empty() {
                    continue;
                }
                for base in [&install, &root] {
                    let path = base.join(&value);
                    if hero {
                        game.hero.push(path);
                    } else {
                        game.cover.push(path);
                    }
                }
            }
        }
        let base = file
            .path()
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        add_images(
            &mut game,
            &root,
            &[&format!("{base}.cover"), &format!("{base}-cover"), &base],
            false,
        );
        add_images(
            &mut game,
            &root,
            &[
                &format!("{base}.hero"),
                &format!("{base}-hero"),
                &format!("{base}.background"),
            ],
            true,
        );
        add_images(
            &mut game,
            &install,
            &["cover", "poster", ".egstore/cover"],
            false,
        );
        add_images(
            &mut game,
            &install,
            &["hero", "background", "banner", ".egstore/hero"],
            true,
        );
        let namespace = data
            .get("CatalogNamespace")
            .or(data.get("MainGameCatalogNamespace"))
            .cloned()
            .unwrap_or_default();
        game.metadata = json!({"namespace":namespace,"appName":id});
        games.push(game);
    }
    games
}

fn gog() -> Vec<Game> {
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
        let mut games = Vec::new();
        for root in [
            "SOFTWARE\\WOW6432Node\\GOG.com\\Games",
            "SOFTWARE\\GOG.com\\Games",
        ] {
            let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(root) else {
                continue;
            };
            for id in key.enum_keys().take(MAX_ENTRIES).filter_map(Result::ok) {
                let Ok(game_key) = key.open_subkey(&id) else {
                    continue;
                };
                let title = game_key
                    .get_value::<String, _>("gameName")
                    .or_else(|_| game_key.get_value("gameID"))
                    .unwrap_or_default();
                let install =
                    PathBuf::from(game_key.get_value::<String, _>("path").unwrap_or_default());
                if !safe_id(&id, 20, true)
                    || title.is_empty()
                    || !install.is_absolute()
                    || !install.is_dir()
                {
                    continue;
                }
                let mut game = Game::new("GOG", &id, &title, install.clone());
                if let Ok(exe) = game_key.get_value::<String, _>("exe") {
                    let path = install.join(exe);
                    if let (Ok(base), Ok(candidate)) = (install.canonicalize(), path.canonicalize())
                    {
                        if candidate.starts_with(base) && candidate.is_file() {
                            game.executable = Some(candidate);
                        }
                    }
                }
                let cache = accounts::program_data().join("GOG.com/Galaxy/webcache");
                game.art_roots = vec![install.clone(), cache.clone()];
                for (keys, hero) in [
                    (
                        vec!["cover", "coverimage", "coverpath", "image", "imagepath"],
                        false,
                    ),
                    (
                        vec![
                            "background",
                            "backgroundimage",
                            "backgroundpath",
                            "hero",
                            "heropath",
                        ],
                        true,
                    ),
                ] {
                    for field in keys {
                        if let Ok(value) = game_key.get_value::<String, _>(field) {
                            if value.is_empty() {
                                continue;
                            }
                            for root in [&install, &cache] {
                                if hero {
                                    game.hero.push(root.join(&value));
                                } else {
                                    game.cover.push(root.join(&value));
                                }
                            }
                        }
                    }
                }
                add_images(
                    &mut game,
                    &install,
                    &[&format!("goggame-{id}"), "cover", "poster"],
                    false,
                );
                add_images(&mut game, &install, &["hero", "header", "background"], true);
                games.push(game);
            }
        }
        games
    }
    #[cfg(not(windows))]
    {
        vec![]
    }
}

fn blizzard() -> Vec<Game> {
    if !cfg!(windows) {
        return vec![];
    }
    let config = read_json(&accounts::roaming_data().join("Battle.net/Battle.net.config"));
    let root = PathBuf::from(text(&config["Client"]["Install"]["DefaultInstallPath"]));
    if !root.is_absolute() || !root.is_dir() {
        return vec![];
    }
    let launcher = ["PROGRAMFILES(X86)", "PROGRAMFILES"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(|p| PathBuf::from(p).join("Battle.net/Battle.net Launcher.exe"))
        .find(|p| p.is_file());
    let definitions = [
        (
            "Overwatch 2",
            "Pro",
            "Overwatch",
            "https://overwatch.blizzard.com/",
        ),
        (
            "Hearthstone",
            "WTCG",
            "Hearthstone",
            "https://hearthstone.blizzard.com/",
        ),
        (
            "World of Warcraft",
            "WoW",
            "World of Warcraft",
            "https://worldofwarcraft.blizzard.com/",
        ),
        (
            "World of Warcraft Classic",
            "WoWC",
            "World of Warcraft/_classic_",
            "https://wowclassic.blizzard.com/",
        ),
        (
            "Diablo IV",
            "Fen",
            "Diablo IV",
            "https://diablo4.blizzard.com/",
        ),
        (
            "Diablo III",
            "D3",
            "Diablo III",
            "https://us.diablo3.blizzard.com/",
        ),
        (
            "Diablo II: Resurrected",
            "OSI",
            "Diablo II Resurrected",
            "https://diablo2.blizzard.com/",
        ),
        (
            "StarCraft II",
            "S2",
            "StarCraft II",
            "https://starcraft2.blizzard.com/",
        ),
        (
            "StarCraft: Remastered",
            "S1",
            "StarCraft",
            "https://starcraft.com/",
        ),
        (
            "Heroes of the Storm",
            "Hero",
            "Heroes of the Storm",
            "https://heroesofthestorm.blizzard.com/",
        ),
    ];
    definitions
        .into_iter()
        .filter_map(|(title, id, folder, url)| {
            let path = root.join(folder);
            if !path.is_dir() {
                return None;
            }
            let mut game = Game::new("Blizzard", id, title, path.clone());
            game.launcher = launcher.clone();
            game.metadata = json!({"officialPage":url});
            game.art_roots = vec![path.clone()];
            // Index Battle.net's image cache only when artwork is requested.
            // Catalog discovery must not read thousands of unrelated images.
            add_images(&mut game, &path, &["cover", "poster"], false);
            add_images(&mut game, &path, &["hero", "header"], true);
            Some(game)
        })
        .collect()
}

pub(super) fn scan() -> Vec<Game> {
    let mut seen = HashSet::new();
    [steam(), epic(), gog(), blizzard()]
        .into_iter()
        .flatten()
        .filter(|game| seen.insert(game.id.clone()))
        .take(MAX_ENTRIES)
        .collect()
}

pub(super) fn launch(game: &Game) -> Result<(), String> {
    match game.platform.as_str() {
        "Steam" if safe_id(&game.platform_id, 12, true) => {
            crate::platform::open_url(&format!("steam://rungameid/{}", game.platform_id))
        }
        "Epic" if safe_id(&game.platform_id, 256, false) => crate::platform::open_url(&format!(
            "com.epicgames.launcher://apps/{}?action=launch&silent=true",
            game.platform_id
        )),
        "GOG" if safe_id(&game.platform_id, 20, true) => {
            if let Some(executable) = &game.executable {
                let base = game
                    .install_path
                    .canonicalize()
                    .map_err(|e| e.to_string())?;
                let executable = executable.canonicalize().map_err(|e| e.to_string())?;
                if !executable.starts_with(base) {
                    return Err("Game executable escaped its installation directory".into());
                }
                crate::platform::open_path(&executable)
            } else {
                crate::platform::open_url(&format!("goggalaxy://openGameView/{}", game.platform_id))
            }
        }
        "Blizzard" if safe_id(&game.platform_id, 12, false) => {
            if let Some(launcher) = &game.launcher {
                crate::platform::command(&launcher.to_string_lossy())
                    .arg(format!("--exec=launch {}", game.platform_id))
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            } else {
                crate::platform::open_url(&format!("battlenet://{}", game.platform_id))
            }
        }
        _ => Err("Unsupported game launch provider".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn steam_install_cannot_traverse_outside_common() {
        let root = std::env::temp_dir().join(format!("ogs-install-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("common/game")).unwrap();
        assert!(resolve_install(&root.join("common"), "game").is_some());
        assert!(resolve_install(&root.join("common"), "../other").is_none());
        assert!(resolve_install(&root.join("common"), "/absolute").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn launch_ids_reject_uri_injection() {
        assert!(!safe_id("12?exec=bad", 12, true));
        assert!(!safe_id("game/../../x", 256, false));
    }
}
