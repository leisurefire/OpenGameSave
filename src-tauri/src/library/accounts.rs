use super::{entries, read_bounded, read_json, text, vdf};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime},
};

pub(super) fn env_path(name: &str, fallback: PathBuf) -> PathBuf {
    std::env::var_os(name)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or(fallback)
}
pub(super) fn local_data() -> PathBuf {
    env_path("LOCALAPPDATA", dirs::data_local_dir().unwrap_or_default())
}
pub(super) fn program_data() -> PathBuf {
    env_path("PROGRAMDATA", PathBuf::from("C:\\ProgramData"))
}
pub(super) fn roaming_data() -> PathBuf {
    env_path("APPDATA", dirs::data_dir().unwrap_or_default())
}

pub(super) fn native_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        // Keep Win32 paths suitable for launcher protocols and save-pattern
        // expansion; canonicalize() adds a verbatim prefix on Windows.
        let value = path.to_string_lossy();
        if let Some(path) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{path}"));
        }
        if let Some(path) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(path);
        }
    }
    path
}

pub(super) fn registry(machine: bool, path: &str, name: &str) -> Option<String> {
    #[cfg(windows)]
    {
        use winreg::{
            enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE},
            RegKey,
        };
        let key = RegKey::predef(if machine {
            HKEY_LOCAL_MACHINE
        } else {
            HKEY_CURRENT_USER
        })
        .open_subkey(path)
        .ok()?;
        key.get_value::<String, _>(name)
            .ok()
            .or_else(|| key.get_value::<u64, _>(name).ok().map(|v| v.to_string()))
            .or_else(|| key.get_value::<u32, _>(name).ok().map(|v| v.to_string()))
    }
    #[cfg(not(windows))]
    {
        let _ = (machine, path, name);
        None
    }
}

pub(super) fn steam_roots() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for (machine, key, name) in [
        (false, "Software\\Valve\\Steam", "SteamPath"),
        (true, "SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"),
        (true, "SOFTWARE\\Valve\\Steam", "InstallPath"),
    ] {
        if let Some(path) = registry(machine, key, name) {
            candidates.push(PathBuf::from(path));
        }
    }
    for name in ["PROGRAMFILES(X86)", "PROGRAMFILES"] {
        if let Some(path) = std::env::var_os(name) {
            candidates.push(PathBuf::from(path).join("Steam"));
        }
    }
    if let Some(home) = dirs::home_dir() {
        candidates.extend([
            home.join(".steam/steam"),
            home.join(".local/share/Steam"),
            home.join("Library/Application Support/Steam"),
        ]);
    }
    let mut seen = BTreeSet::new();
    candidates
        .into_iter()
        .filter_map(|p| p.canonicalize().ok())
        .map(native_path)
        .filter(|p| p.is_dir() && seen.insert(p.clone()))
        .collect()
}

pub(super) fn steam_libraries(root: &Path) -> Vec<PathBuf> {
    let mut roots = BTreeSet::from([root.to_path_buf()]);
    for file in ["steamapps/libraryfolders.vdf", "config/libraryfolders.vdf"] {
        let data = vdf::read(&root.join(file));
        if let Some(folders) = vdf::get(&data, "libraryfolders").as_object() {
            for (_, entry) in folders.iter().take(256) {
                let candidate = if entry.is_string() {
                    text(entry)
                } else {
                    text(vdf::get(entry, "path"))
                };
                let path = PathBuf::from(candidate);
                if path.is_absolute() && path.is_dir() && roots.len() < 256 {
                    roots.insert(path);
                }
            }
        }
    }
    roots.into_iter().collect()
}

fn steam_account(data: &Value) -> (Value, Value, Value) {
    let Some(users) = vdf::get(data, "users").as_object() else {
        return (Value::Null, Value::Null, Value::Null);
    };
    let account = users
        .iter()
        .find(|(_, value)| text(vdf::get(value, "AutoLogin")) == "1")
        .or_else(|| {
            users
                .iter()
                .find(|(_, value)| text(vdf::get(value, "MostRecent")) == "1")
        });
    let Some((id, user)) = account else {
        return (Value::Null, Value::Null, Value::Null);
    };
    let id3 = id
        .parse::<u64>()
        .ok()
        .and_then(|n| n.checked_sub(76_561_197_960_265_728))
        .filter(|n| *n <= u32::MAX as u64)
        .map(|n| json!(n.to_string()))
        .unwrap_or(Value::Null);
    (json!(id), id3, vdf::get(user, "PersonaName").clone())
}

fn modified(path: &Path) -> SystemTime {
    walkdir::WalkDir::new(path)
        .follow_links(false)
        .max_depth(12)
        .into_iter()
        .take(20_000)
        .filter_map(Result::ok)
        .filter_map(|entry| entry.metadata().ok()?.modified().ok())
        .max()
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

fn newest_directory(root: &Path) -> Value {
    entries(root, 2048)
        .into_iter()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .max_by_key(|e| modified(&e.path()))
        .map(|e| json!(e.file_name().to_string_lossy()))
        .unwrap_or(Value::Null)
}

fn detect_accounts() -> Value {
    let steam = steam_roots().into_iter().next();
    let ubisoft = registry(
        true,
        "SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher",
        "InstallDir",
    )
    .or_else(|| registry(true, "SOFTWARE\\Ubisoft\\Launcher", "InstallDir"))
    .map(PathBuf::from);
    let (id64, mut id3, name) = steam
        .as_ref()
        .map(|p| steam_account(&vdf::read(&p.join("config/loginusers.vdf"))))
        .unwrap_or((Value::Null, Value::Null, Value::Null));
    if id3.is_null() && !name.is_null() {
        if let Some(root) = &steam {
            for entry in entries(&root.join("userdata"), 2048) {
                let data = vdf::read(&entry.path().join("config/localconfig.vdf"));
                if vdf::get(
                    vdf::get(vdf::get(&data, "UserLocalConfigStore"), "friends"),
                    "PersonaName",
                ) == &name
                {
                    id3 = json!(entry.file_name().to_string_lossy());
                    break;
                }
            }
        }
    }
    let epic_pattern = regex::Regex::new(r"(?i)^(?:OC_)?([a-f0-9]+)\.dat$").unwrap();
    let epic = entries(&local_data().join("EpicGamesLauncher/Saved/Data"), 20_000)
        .into_iter()
        .filter(|e| {
            e.file_type().is_ok_and(|t| t.is_file())
                && epic_pattern.is_match(&e.file_name().to_string_lossy())
        })
        .max_by_key(|e| {
            e.metadata()
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH)
        })
        .and_then(|e| {
            epic_pattern
                .captures(&e.file_name().to_string_lossy())
                .map(|c| json!(&c[1]))
        })
        .unwrap_or(Value::Null);
    let documents = dirs::document_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Documents"));
    json!({"steamPath":steam,"ubisoftPath":ubisoft,"currentSteamUserId64":id64,"currentSteamUserId3":id3,
        "currentSteamUserName":name,"currentUbisoftUserId":ubisoft.as_ref().map(|p|newest_directory(&p.join("savegames"))).unwrap_or(Value::Null),
        "currentEpicUserId":epic,"currentXboxUserId":registry(false,"Software\\Microsoft\\XboxLive","Xuid"),
        "currentRockStarUserId":newest_directory(&documents.join("Rockstar Games/Social Club/Profiles")),"initialized":true})
}

pub fn game_data() -> Value {
    static CACHE: OnceLock<Mutex<Option<(Instant, Value)>>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some((when, value)) = &*cache {
        if when.elapsed() < Duration::from_secs(30) {
            return value.clone();
        }
    }
    let value = detect_accounts();
    *cache = Some((Instant::now(), value.clone()));
    value
}

pub fn detected_paths() -> Vec<String> {
    let mut paths = BTreeSet::new();
    for root in steam_roots() {
        for library in steam_libraries(&root) {
            paths.insert(library.join("steamapps/common"));
        }
    }
    let epic = read_json(&program_data().join("Epic/UnrealEngineLauncher/LauncherInstalled.dat"));
    if let Some(installs) = epic["InstallationList"].as_array() {
        for install in installs.iter().take(20_000) {
            if let Some(parent) = Path::new(&text(&install["InstallLocation"])).parent() {
                paths.insert(parent.to_path_buf());
            }
        }
    }
    let ubi = local_data().join("Ubisoft Game Launcher/settings.yaml");
    if let Some(bytes) = read_bounded(&ubi, super::MAX_MANIFEST_BYTES) {
        for line in String::from_utf8_lossy(&bytes).lines() {
            if let Some(path) = line.trim().strip_prefix("game_installation_path:") {
                paths.insert(PathBuf::from(path.trim().trim_matches(['\'', '"'])));
            }
        }
    }
    for file in entries(&local_data().join("Electronic Arts/EA Desktop"), 2048) {
        let name = file.file_name().to_string_lossy().to_lowercase();
        if name.starts_with("user_") && name.ends_with(".ini") {
            if let Some(bytes) = read_bounded(&file.path(), super::MAX_MANIFEST_BYTES) {
                for line in String::from_utf8_lossy(&bytes).lines() {
                    if let Some(path) = line.trim().strip_prefix("user.downloadinplacedir=") {
                        paths.insert(PathBuf::from(path.trim()));
                    }
                }
            }
        }
    }
    paths.insert(PathBuf::from(text(
        &read_json(&program_data().join("GOG.com/Galaxy/config.json"))["libraryPath"],
    )));
    paths.insert(PathBuf::from(text(
        &read_json(&roaming_data().join("Battle.net/Battle.net.config"))["Client"]["Install"]
            ["DefaultInstallPath"],
    )));
    paths
        .into_iter()
        .filter(|p| p.is_absolute() && p.is_dir())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_login_wins_and_steam_account_id_does_not_lose_precision() {
        let data = json!({"users":{"76561197960265729":{"MostRecent":"1","PersonaName":"old"},"76561198012345678":{"AutoLogin":"1","PersonaName":"current"}}});
        let (id, id3, name) = steam_account(&data);
        assert_eq!(id, "76561198012345678");
        assert_eq!(id3, "52079950");
        assert_eq!(name, "current");
    }
    #[test]
    fn invalid_steam_id_cannot_underflow() {
        let (_, id3, _) = steam_account(&json!({"users":{"1":{"AutoLogin":"1"}}}));
        assert!(id3.is_null());
    }
}
