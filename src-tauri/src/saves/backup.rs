use super::{
    database,
    fs::{self, Result},
    metadata, registry,
};
use serde_json::{json, Value};
use std::{fs as disk, path::Path};
pub fn latest_date(root: &Path, id: &str) -> Result<Option<String>> {
    let game = metadata::snapshot(root, &json!(id), None)?;
    if !game.exists() {
        return Ok(None);
    }
    if !fs::regular(&game)?.is_dir() {
        return Ok(None);
    }
    let mut dates: Vec<_> = disk::read_dir(&game)
        .map_err(fs::err)?
        .filter_map(std::result::Result::ok)
        .filter_map(|entry| {
            entry
                .file_name()
                .to_str()
                .and_then(|s| metadata::date(s).ok())
        })
        .collect();
    dates.sort_unstable_by(|a, b| b.cmp(a));
    Ok(dates
        .into_iter()
        .find(|date| metadata::load(&game.join(date)).is_ok()))
}
pub fn list(root: &Path, id: Option<&str>) -> Result<Value> {
    fs::mkdir(root)?;
    let mut games = vec![];
    let mut errors = vec![];
    let ids: Vec<String> = if let Some(id) = id {
        vec![metadata::wiki(&json!(id))?]
    } else {
        disk::read_dir(root)
            .map_err(fs::err)?
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().to_str().map(str::to_owned))
            .filter(|s| metadata::wiki(&json!(s)).is_ok())
            .collect()
    };
    for id in ids {
        let path = metadata::snapshot(root, &json!(id), None)?;
        if !path.exists() {
            continue;
        }
        if !fs::regular(&path).map(|m| m.is_dir()).unwrap_or(false) {
            continue;
        }
        let mut backups = vec![];
        for e in disk::read_dir(&path).map_err(fs::err)? {
            let e = e.map_err(fs::err)?;
            let when = e.file_name().to_string_lossy().into_owned();
            if metadata::date(&when).is_err() {
                continue;
            }
            match (|| -> Result<Value> {
                let mut info = metadata::load(&e.path())?;
                info["date"] = json!(when);
                let metadata_size = fs::regular(&e.path().join("backup_info.json"))?.len();
                info["backup_size"] =
                    json!(fs::size_time(&e.path())?.0.saturating_sub(metadata_size));
                Ok(info)
            })() {
                Ok(v) => backups.push(v),
                Err(e) => errors.push(format!("{id}/{when}: {e}")),
            }
        }
        backups.sort_by(|a, b| b["date"].as_str().cmp(&a["date"].as_str()));
        if let Some(latest) = backups.first() {
            games.push(json!({"wiki_page_id":id,"latest_backup":metadata::display_date(latest["date"].as_str().unwrap_or("")),"title":latest["title"],"zh_CN":latest["zh_CN"],"backup_size":latest["backup_size"],"backups":backups}));
        }
    }
    Ok(json!({"games":games,"errors":errors}))
}
pub fn create(settings: &Value, db: &Path, data: &Value, id: &str) -> Result<String> {
    let mut game = database::definition(db, id, settings)?;
    database::process(&mut game, settings, data)?;
    let paths = game["resolved_paths"].as_array().ok_or("No save paths")?;
    if paths.is_empty() {
        return Err("No local saves are available for this game".into());
    }
    if paths.len() > 128 {
        return Err("Game resolves to more than 128 backup locations".into());
    }
    let root = metadata::root(settings)?;
    for path in paths.iter().filter(|p| p["type"] != "reg") {
        let source = Path::new(path["resolved"].as_str().ok_or("Invalid save source")?);
        if fs::inside(source, &root) || fs::inside(&root, source) {
            return Err("Backup storage must be separate from every local save location".into());
        }
    }
    fs::mkdir(&root)?;
    let game_root = metadata::snapshot(&root, &json!(id), None)?;
    fs::mkdir(&game_root)?;
    let mut time = chrono::Local::now();
    let mut when = time.format("%Y-%m-%d_%H-%M-%S").to_string();
    while game_root.join(&when).exists() {
        time += chrono::Duration::seconds(1);
        when = time.format("%Y-%m-%d_%H-%M-%S").to_string();
    }
    let target = game_root.join(&when);
    let staging = game_root.join(format!(".ogs-backup-{}", uuid::Uuid::new_v4()));
    disk::create_dir(&staging).map_err(fs::err)?;
    let result = (|| -> Result<()> {
        let mut entries = vec![];
        for (i, p) in paths.iter().enumerate() {
            let folder = format!("path{}", i + 1);
            let dest = staging.join(&folder);
            fs::mkdir(&dest)?;
            let source = p["resolved"].as_str().ok_or("Invalid resolved source")?;
            let kind = if p["type"] == "reg" {
                registry::export(source, &dest.join("registry_backup.reg"))?;
                "reg"
            } else {
                let path = Path::new(source);
                let m = fs::regular(path)?;
                if m.is_dir() {
                    fs::copy_tree(path, &dest)?;
                    "folder"
                } else {
                    fs::copy_file(
                        path,
                        &dest.join(path.file_name().ok_or("Invalid source file")?),
                    )?;
                    "file"
                }
            };
            entries.push(json!({"folder_name":folder,"template":p["finalTemplate"],"type":kind,"install_folder":game["install_folder"]}));
        }
        let info = metadata::validate(
            &json!({"title":game["title"],"zh_CN":game["zh_CN"],"provenance":"local","backup_paths":entries}),
        )?;
        fs::atomic_json(&staging.join("backup_info.json"), &info)?;
        fs::no_links(&target)?;
        disk::rename(&staging, &target).map_err(fs::err)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove(&game_root, &staging);
    }
    result?;
    // Retention failures never invalidate an already committed snapshot; damaged
    // historical snapshots are preserved for manual recovery.
    if let Ok(listed) = list(&root, Some(id)) {
        let mut dates: Vec<_> = listed["games"][0]["backups"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| v["is_permanent"] != true)
            .filter_map(|v| v["date"].as_str())
            .collect();
        dates.sort();
        let max = settings["maxBackups"]
            .as_u64()
            .filter(|&v| v > 0 && v <= 1000)
            .unwrap_or(10) as usize;
        for date in dates.iter().take(dates.len().saturating_sub(max)) {
            if *date != when {
                let _ = fs::remove(&game_root, &game_root.join(date));
            }
        }
    }
    Ok(when)
}
pub fn update(root: &Path, id: &Value, when: &str, key: &str, value: &Value) -> Result<bool> {
    let path = metadata::snapshot(root, id, Some(when))?;
    let mut m = metadata::load(&path)?;
    match key {
        "is_permanent" if value.is_boolean() => {}
        "custom_name"
            if value
                .as_str()
                .is_some_and(|s| s.encode_utf16().count() <= 120) => {}
        _ => return Err("Invalid backup metadata change".into()),
    }
    m[key] = value.clone();
    fs::atomic_json(&path.join("backup_info.json"), &metadata::validate(&m)?)?;
    Ok(true)
}
pub fn delete(root: &Path, id: &Value, when: &str) -> Result<bool> {
    let p = metadata::snapshot(root, id, Some(when))?;
    fs::remove(root, &p)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lists_legacy_metadata_and_preserves_custom_fields() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("42/2025-01-01_12-30");
        fs::mkdir(&p).unwrap();
        fs::atomic_json(&p.join("backup_info.json"),&json!({"title":"Example","backup_paths":[],"is_permanent":true,"custom_name":"Before update"})).unwrap();
        let data = list(dir.path(), Some("42")).unwrap();
        assert_eq!(data["games"][0]["backups"][0]["provenance"], "external");
        assert_eq!(data["games"][0]["latest_backup"], "2025/01/01 12:30:00");
        update(
            dir.path(),
            &json!("42"),
            "2025-01-01_12-30",
            "custom_name",
            &json!("Renamed"),
        )
        .unwrap();
        assert_eq!(metadata::load(&p).unwrap()["custom_name"], "Renamed");
    }
}
