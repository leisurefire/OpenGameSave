use serde_json::{json, Value};
use std::{fs, io::Write, path::Path};

pub fn defaults(app_data: &Path) -> Value {
    let language = sys_locale::get_locale().unwrap_or_default();
    json!({
        "language":if language.to_lowercase().starts_with("zh") {"zh_CN"} else {"en_US"},
        "backupPath":app_data.parent().unwrap_or(app_data).join("OGS Backups"),
        "exportPath":"", "syncProvider":"github", "webdavUrl":"", "webdavUsername":"",
        "webdavRemotePath":"/OpenGameSave", "visibleSidebarItems":["library","guides","backup","sync"],
        "maxBackups":5, "launchAtStartup":false, "autoAppUpdate":true,"appUpdatePrerelease":false,
        "autoDbUpdate":false,"databaseVariant":"standard","syncAccentColor":false,
        "backupAllAccounts":false,"saveUninstalledGames":true,"gameInstalls":"uninitialized",
        "pinnedGames":[],"blockedGames":[],"blockedGameTipDismissed":false,"uninstalledGames":[],
        "autoBackupGames":{},"firstLaunchFullScanTipShown":false
    })
}

pub fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    crate::saves::fs::no_links(path)?;
    let parent = path.parent().ok_or("Missing parent directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    if fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("Refusing to overwrite a symbolic link".into());
    }
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(data)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn load(app_data: &Path) -> Result<Value, String> {
    let path = app_data.join("OGS Settings/settings.json");
    crate::saves::fs::no_links(&path)?;
    let mut settings = defaults(app_data);
    if path.exists() {
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > 4 * 1024 * 1024
        {
            return Err("Invalid settings file".into());
        }
        // Never overwrite a malformed legacy file with defaults: keep it recoverable.
        let old: Value = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        for (key, value) in old.as_object().ok_or("Invalid settings object")? {
            if validate(key, value).is_ok() {
                settings[key] = value.clone();
            }
        }
        settings["firstLaunchFullScanTipShown"] = old
            .get("firstLaunchFullScanTipShown")
            .cloned()
            .unwrap_or(json!(true));
    } else {
        atomic_write(
            &path,
            &serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?,
        )?;
    }
    Ok(settings)
}

fn safe_string(value: &Value, max: usize) -> bool {
    value
        .as_str()
        .map(|s| s.len() <= max && !s.chars().any(|c| c == '\0' || c == '\r' || c == '\n'))
        .unwrap_or(false)
}

pub fn wiki_id(value: &Value) -> Result<String, String> {
    let id = value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_u64().map(|n| n.to_string()))
        .ok_or("Invalid game ID")?;
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err("Invalid game ID".into());
    }
    Ok(id)
}

pub fn validate(key: &str, value: &Value) -> Result<(), String> {
    let valid = match key {
        "language" => matches!(value.as_str(), Some("en_US" | "zh_CN")),
        "databaseVariant" => matches!(value.as_str(), Some("standard" | "xbox")),
        "syncProvider" => matches!(value.as_str(), Some("github" | "webdav")),
        "backupPath" => {
            safe_string(value, 32767)
                && value
                    .as_str()
                    .map(|s| Path::new(s).is_absolute() && Path::new(s).parent().is_some())
                    .unwrap_or(false)
        }
        "exportPath" => {
            safe_string(value, 32767)
                && value
                    .as_str()
                    .map(|s| s.is_empty() || Path::new(s).is_absolute())
                    .unwrap_or(false)
        }
        "webdavUsername" => safe_string(value, 512),
        "webdavUrl" => {
            safe_string(value, 2048)
                && value
                    .as_str()
                    .map(|s| {
                        s.is_empty()
                            || url::Url::parse(s)
                                .map(|u| {
                                    u.scheme() == "https"
                                        && u.username().is_empty()
                                        && u.password().is_none()
                                        && u.query().is_none()
                                        && u.fragment().is_none()
                                })
                                .unwrap_or(false)
                    })
                    .unwrap_or(false)
        }
        "webdavRemotePath" => {
            safe_string(value, 1024)
                && value
                    .as_str()
                    .map(|s| {
                        s.split(['/', '\\']).filter(|s| !s.is_empty()).count() > 0
                            && !s.split(['/', '\\']).any(|s| s == "." || s == "..")
                    })
                    .unwrap_or(false)
        }
        "maxBackups" => value
            .as_u64()
            .map(|n| (1..=1000).contains(&n))
            .unwrap_or(false),
        "launchAtStartup"
        | "autoAppUpdate"
        | "appUpdatePrerelease"
        | "autoDbUpdate"
        | "syncAccentColor"
        | "backupAllAccounts"
        | "saveUninstalledGames"
        | "blockedGameTipDismissed"
        | "firstLaunchFullScanTipShown" => value.is_boolean(),
        "pinnedGames" | "blockedGames" | "uninstalledGames" => value
            .as_array()
            .map(|v| v.len() <= 10000 && v.iter().all(|id| wiki_id(id).is_ok()))
            .unwrap_or(false),
        "visibleSidebarItems" => value
            .as_array()
            .map(|a| {
                a.len() <= 4
                    && a.iter().all(|v| {
                        matches!(v.as_str(), Some("library" | "guides" | "backup" | "sync"))
                    })
            })
            .unwrap_or(false),
        "gameInstalls" => {
            value == "uninitialized"
                || value
                    .as_array()
                    .map(|a| {
                        a.len() <= 1000
                            && a.iter().all(|v| {
                                safe_string(v, 32767)
                                    && v.as_str()
                                        .map(|s| Path::new(s).is_absolute())
                                        .unwrap_or(false)
                            })
                    })
                    .unwrap_or(false)
        }
        "autoBackupGames" => value
            .as_object()
            .map(|o| {
                o.len() <= 1000
                    && o.iter().all(|(k, v)| {
                        wiki_id(&json!(k)).is_ok()
                            && matches!(v["mode"].as_str(), Some("interval" | "watcher"))
                            && (v["mode"] == "watcher"
                                || v["intervalMinutes"]
                                    .as_u64()
                                    .map(|n| (1..=1440).contains(&n))
                                    .unwrap_or(false))
                    })
            })
            .unwrap_or(false),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(format!("Invalid setting: {key}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_security_sensitive_settings() {
        assert!(validate("webdavUrl", &json!("https://user:pass@example.org")).is_err());
        assert!(validate("webdavRemotePath", &json!("/../saves")).is_err());
        assert!(validate("autoBackupGames", &json!({"../escape":{"mode":"watcher"}})).is_err());
        assert!(validate("maxBackups", &json!(0)).is_err());
        assert!(validate("webdavPassword", &json!("secret")).is_err());
    }
    #[test]
    fn atomic_settings_and_corrupt_file_preservation() {
        let temp = tempfile::tempdir().unwrap();
        let value = load(temp.path()).unwrap();
        assert_eq!(value["maxBackups"], 5);
        let path = temp.path().join("OGS Settings/settings.json");
        fs::write(&path, b"bad json").unwrap();
        assert!(load(temp.path()).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"bad json");
    }
}
