use super::{
    authorization, backup, database,
    fs::{self, Result},
    metadata, registry,
    resolver::{self, Resolver},
};
use serde_json::{json, Value};
use std::{
    fs as disk,
    path::{Path, PathBuf},
};
#[derive(Clone, Debug)]
pub struct Item {
    pub source: PathBuf,
    pub destination: PathBuf,
    pub allowed_root: PathBuf,
    pub kind: String,
    pub external: bool,
}
#[derive(Clone)]
pub struct Plan {
    pub items: Vec<Item>,
    pub source_time: u64,
    pub destination_time: u64,
    pub title: String,
}
pub fn plan(
    settings: &Value,
    db: &Path,
    data: &Value,
    id: &str,
    date: Option<&str>,
) -> Result<Plan> {
    let root = metadata::root(settings)?;
    let listed = backup::list(&root, Some(id))?;
    let game = listed["games"]
        .as_array()
        .and_then(|v| v.first())
        .ok_or("No backups are available")?;
    let snapshots = game["backups"].as_array().ok_or("Invalid backup list")?;
    let selected = if let Some(date) = date {
        metadata::date(date)?;
        snapshots.iter().find(|b| b["date"] == date)
    } else {
        snapshots.first()
    }
    .ok_or("Requested backup does not exist")?;
    let snapshot = metadata::snapshot(&root, &json!(id), selected["date"].as_str())?;
    let definition = database::definition(db, id, settings)?;
    let resolver = Resolver::new(settings, data, definition["install_path"].as_str());
    let mut items = vec![];
    for p in selected["backup_paths"]
        .as_array()
        .ok_or("Invalid backup paths")?
    {
        let kind = p["type"].as_str().ok_or("Invalid backup type")?;
        let template = p["template"].as_str().ok_or("Invalid backup template")?;
        let source = snapshot.join(p["folder_name"].as_str().ok_or("Invalid source folder")?);
        if !fs::regular(&source)?.is_dir() {
            return Err("Backup source must be a regular directory".into());
        }
        let (destination, allowed_root) = if kind == "reg" {
            if selected["provenance"] != "local" {
                return Err("Registry restore from external backups is forbidden".into());
            }
            (
                PathBuf::from(authorization::registry_destination(
                    &resolver,
                    &database::templates(&definition, "reg"),
                    template,
                )?),
                PathBuf::new(),
            )
        } else {
            let (d, r) = authorization::file_destination(
                &resolver,
                &database::templates(&definition, resolver::platform_key()),
                template,
            )?;
            if resolver::pgs(&d.to_string_lossy()) {
                return Err("Xbox PGS saves are backup-only; automatic restore is blocked".into());
            }
            (d, r)
        };
        let item = Item {
            source,
            destination,
            allowed_root,
            kind: kind.into(),
            external: selected["provenance"] != "local",
        };
        validate_item(&item, &root)?;
        items.push(item);
    }
    items.sort_by_key(|i| i.destination.as_os_str().len());
    let mut independent: Vec<Item> = vec![];
    for item in items {
        if let Some(parent) = independent.iter().find(|p| {
            p.kind != "reg" && item.kind != "reg" && fs::inside(&p.destination, &item.destination)
        }) {
            if parent.kind == "folder" || fs::key(&parent.destination) == fs::key(&item.destination)
            {
                continue;
            }
            return Err("Restore destinations overlap".into());
        }
        if independent.iter().any(|p| {
            p.kind == "reg"
                && item.kind == "reg"
                && (fs::inside(&p.destination, &item.destination)
                    || fs::inside(&item.destination, &p.destination))
        }) {
            return Err("Registry destinations overlap".into());
        }
        independent.push(item);
    }
    if independent.is_empty() {
        return Err("Backup contains no restorable paths".into());
    }
    let mut source_time = 0;
    let mut destination_time = 0;
    for item in &independent {
        if item.kind != "reg" {
            source_time = source_time.max(fs::size_time(&item.source)?.1);
            destination_time = destination_time.max(fs::size_time(&item.destination)?.1);
        }
    }
    Ok(Plan {
        items: independent,
        source_time,
        destination_time,
        title: game["title"].as_str().unwrap_or(id).into(),
    })
}
fn validate_item(item: &Item, backup_root: &Path) -> Result<()> {
    if item.kind != "reg"
        && (fs::inside(backup_root, &item.destination)
            || fs::inside(&item.destination, backup_root))
    {
        return Err("Restore destination must not overlap backup storage".into());
    }
    if !fs::inside(backup_root, &item.source)
        || fs::key(backup_root) == fs::key(&item.source)
        || !fs::regular(&item.source)?.is_dir()
    {
        return Err("Restore source escapes backup root".into());
    }
    if item.kind == "reg" {
        if item.external {
            return Err("External registry restore is forbidden".into());
        }
        registry::validate_payload(
            &item.source.join("registry_backup.reg"),
            &item.destination.to_string_lossy(),
        )?;
        return Ok(());
    }
    if !fs::inside(&item.allowed_root, &item.destination)
        || fs::key(&item.allowed_root) == fs::key(&item.destination)
    {
        return Err("Restore destination escapes authorized root".into());
    }
    fs::no_links(&item.destination)?;
    if !fs::regular(&item.allowed_root)?.is_dir() {
        return Err("Restore root must exist".into());
    }
    if item.kind == "file" {
        let entries = disk::read_dir(&item.source)
            .map_err(fs::err)?
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(fs::err)?;
        if entries.len() != 1
            || Some(entries[0].file_name().as_os_str()) != item.destination.file_name()
            || !fs::regular(&entries[0].path())?.is_file()
        {
            return Err("File payload does not match the authorized filename".into());
        }
    }
    if item.external {
        for e in walkdir::WalkDir::new(&item.source).follow_links(false) {
            let e = e.map_err(fs::err)?;
            let m = fs::regular(e.path())?;
            if m.is_file() && authorization::forbidden(e.path()) {
                return Err("External backup contains executable or script payload".into());
            }
        }
    }
    Ok(())
}
struct Staged {
    item: Item,
    root: PathBuf,
    replacement: PathBuf,
    previous: PathBuf,
    moved: bool,
    activated: bool,
    created_parents: Vec<PathBuf>,
}
struct RegistryPrevious {
    destination: String,
    path: PathBuf,
    existed: bool,
}
pub fn execute(plan: &Plan, backup_root: &Path) -> Result<()> {
    execute_internal(plan, backup_root, None)
}
fn execute_internal(plan: &Plan, backup_root: &Path, fail_after: Option<usize>) -> Result<()> {
    execute_transaction(plan, backup_root, fail_after, |_, _| Ok(()))
}
fn validate_staged(item: &Item, replacement: &Path) -> Result<()> {
    let meta = fs::regular(replacement)?;
    if (item.kind == "folder" && !meta.is_dir()) || (item.kind == "file" && !meta.is_file()) {
        return Err("Staged restore payload has an unexpected type".into());
    }
    if !item.external {
        return Ok(());
    }
    // A staged file is named replacement, so check its eventual filename too.
    if item.kind == "file" && authorization::forbidden(&item.destination) {
        return Err("External backup contains executable or script payload".into());
    }
    for (count, entry) in walkdir::WalkDir::new(replacement)
        .follow_links(false)
        .max_depth(65)
        .into_iter()
        .enumerate()
    {
        let entry = entry.map_err(fs::err)?;
        if count >= 200_000 || entry.depth() > 64 {
            return Err("Staged restore payload exceeds traversal limits".into());
        }
        if fs::regular(entry.path())?.is_file() && authorization::forbidden(entry.path()) {
            return Err("External backup contains executable or script payload".into());
        }
    }
    Ok(())
}
fn execute_transaction(
    plan: &Plan,
    backup_root: &Path,
    fail_after: Option<usize>,
    after_stage: impl Fn(&Item, &Path) -> Result<()>,
) -> Result<()> {
    let mut staged: Vec<Staged> = vec![];
    let registry_root =
        std::env::temp_dir().join(format!("ogs-reg-restore-{}", uuid::Uuid::new_v4()));
    let mut reg_previous: Vec<RegistryPrevious> = vec![];
    let result = (|| -> Result<()> {
        for item in &plan.items {
            validate_item(item, backup_root)?;
            if item.kind == "reg" {
                continue;
            }
            let root = item
                .allowed_root
                .join(format!(".ogs-restore-{}", uuid::Uuid::new_v4()));
            disk::create_dir(&root).map_err(fs::err)?;
            let replacement = root.join("replacement");
            let previous = root.join("previous");
            staged.push(Staged {
                item: item.clone(),
                root,
                replacement: replacement.clone(),
                previous,
                moved: false,
                activated: false,
                created_parents: vec![],
            });
            if item.kind == "folder" {
                fs::copy_tree(&item.source, &replacement)?;
            } else {
                fs::copy_file(
                    &item
                        .source
                        .join(item.destination.file_name().ok_or("Missing filename")?),
                    &replacement,
                )?;
            }
            after_stage(item, &replacement)?;
            validate_staged(item, &replacement)?;
        }
        for item in plan.items.iter().filter(|i| i.kind == "reg") {
            fs::mkdir(&registry_root)?;
            let destination = registry::normalize(&item.destination.to_string_lossy())?;
            let path = registry_root.join(format!("previous-{}.reg", reg_previous.len()));
            let existed = registry::exists(&destination);
            if existed {
                registry::export(&destination, &path)?;
            }
            reg_previous.push(RegistryPrevious {
                destination,
                path,
                existed,
            });
            registry::import(&item.source.join("registry_backup.reg"))?;
        }
        for (index, s) in staged.iter_mut().enumerate() {
            fs::no_links(&s.item.destination)?;
            if fail_after == Some(index) {
                return Err("Injected transaction activation failure".into());
            }
            let parent = s
                .item
                .destination
                .parent()
                .ok_or("Missing destination parent")?;
            let mut p = parent.to_path_buf();
            while !p.exists() && fs::inside(&s.item.allowed_root, &p) {
                s.created_parents.push(p.clone());
                p = p.parent().ok_or("Invalid parent")?.to_path_buf();
            }
            fs::mkdir(parent)?;
            fs::no_links(&s.item.destination)?;
            if s.item.destination.exists() {
                fs::regular(&s.item.destination)?;
                disk::rename(&s.item.destination, &s.previous).map_err(fs::err)?;
                s.moved = true;
            }
            disk::rename(&s.replacement, &s.item.destination).map_err(fs::err)?;
            s.activated = true;
        }
        Ok(())
    })();
    if let Err(error) = result {
        let mut rollback_errors = vec![];
        for s in staged.iter_mut().rev() {
            let r = (|| -> Result<()> {
                fs::no_links(&s.item.destination)?;
                if s.activated {
                    fs::remove(&s.item.allowed_root, &s.item.destination)?;
                }
                if s.moved {
                    disk::rename(&s.previous, &s.item.destination).map_err(fs::err)?;
                }
                for p in &s.created_parents {
                    let _ = disk::remove_dir(p);
                }
                Ok(())
            })();
            if let Err(e) = r {
                rollback_errors.push(e);
            }
        }
        for r in reg_previous.iter().rev() {
            let restored = (|| -> Result<()> {
                if registry::exists(&r.destination) {
                    registry::delete(&r.destination)?;
                }
                if r.existed {
                    registry::import(&r.path)?;
                }
                Ok(())
            })();
            if let Err(e) = restored {
                rollback_errors.push(e);
            }
        }
        if !rollback_errors.is_empty() {
            return Err(format!(
                "{error}; rollback incomplete: {}. Recovery data retained: {} {}",
                rollback_errors.join("; "),
                staged
                    .iter()
                    .map(|s| s.root.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", "),
                registry_root.display()
            ));
        }
        for s in &staged {
            let _ = fs::remove(&s.item.allowed_root, &s.root);
        }
        if registry_root.exists() {
            let _ = fs::remove(&std::env::temp_dir(), &registry_root);
        }
        return Err(error);
    }
    // Cleanup failure keeps recovery data but must not report a committed restore
    // as unsuccessful and encourage the user to repeat it.
    for s in &staged {
        let _ = fs::remove(&s.item.allowed_root, &s.root);
    }
    if registry_root.exists() {
        let _ = fs::remove(&std::env::temp_dir(), &registry_root);
    }
    Ok(())
}
pub fn delete_local(settings: &Value, db: &Path, data: &Value, id: &str) -> Result<bool> {
    let backup_root = metadata::root(settings)?;
    let mut game = database::definition(db, id, settings)?;
    database::process(&mut game, settings, data)?;
    let resolver = Resolver::new(settings, data, game["install_path"].as_str());
    let paths = game["resolved_paths"].as_array().ok_or("No local saves")?;
    let mut file_paths = vec![];
    let mut reg_paths = vec![];
    for p in paths {
        let template = p["finalTemplate"].as_str().ok_or("Invalid local path")?;
        if p["type"] == "reg" {
            reg_paths.push(authorization::registry_destination(
                &resolver,
                &database::templates(&game, "reg"),
                template,
            )?);
        } else {
            let (dest, root) = authorization::file_destination(
                &resolver,
                &database::templates(&game, resolver::platform_key()),
                template,
            )?;
            if resolver::pgs(&dest.to_string_lossy()) {
                return Err("Xbox PGS saves are backup-only; deletion is blocked".into());
            }
            if fs::inside(&dest, &backup_root) || fs::inside(&backup_root, &dest) {
                return Err("Local save deletion must not overlap backup storage".into());
            }
            file_paths.push((dest, root));
        }
    }
    // Stage deletions as same-volume renames, then drop recovery only after all
    // filesystem and registry removals succeeded.
    let mut moved: Vec<(PathBuf, PathBuf, PathBuf)> = vec![];
    let mut reg_old = vec![];
    let reg_temp = tempfile::tempdir().map_err(fs::err)?;
    let result = (|| -> Result<()> {
        file_paths.sort_by_key(|(p, _)| p.as_os_str().len());
        for (dest, root) in file_paths {
            if moved.iter().any(|(p, _, _)| fs::inside(p, &dest)) {
                continue;
            }
            let recovery = root.join(format!(".ogs-delete-{}", uuid::Uuid::new_v4()));
            fs::no_links(&dest)?;
            disk::rename(&dest, &recovery).map_err(fs::err)?;
            moved.push((dest, recovery, root));
        }
        for key in reg_paths {
            let path = reg_temp.path().join(format!("{}.reg", reg_old.len()));
            registry::export(&key, &path)?;
            reg_old.push((key.clone(), path));
            registry::delete(&key)?;
        }
        Ok(())
    })();
    if let Err(e) = result {
        let mut failures = vec![];
        for (key, path) in reg_old.iter().rev() {
            if let Err(e) = registry::import(path) {
                failures.push(format!("{key}: {e}"));
            }
        }
        for (dest, recovery, _) in moved.iter().rev() {
            if let Err(e) =
                fs::no_links(dest).and_then(|_| disk::rename(recovery, dest).map_err(fs::err))
            {
                failures.push(e);
            }
        }
        if !failures.is_empty() {
            let path = reg_temp.keep();
            return Err(format!(
                "{e}; rollback incomplete: {}; registry recovery at {}",
                failures.join("; "),
                path.display()
            ));
        }
        return Err(e);
    }
    for (_, recovery, root) in moved {
        let _ = fs::remove(&root, &recovery);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn activation_failure_rolls_back_all_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("user");
        let backups = temp.path().join("backups");
        fs::mkdir(&root).unwrap();
        fs::mkdir(&backups).unwrap();
        let mut items = vec![];
        for name in ["a", "b"] {
            let source = backups.join(name);
            fs::mkdir(&source).unwrap();
            disk::write(source.join(format!("{name}.sav")), "replacement").unwrap();
            let destination = root.join(format!("{name}.sav"));
            disk::write(&destination, "original").unwrap();
            items.push(Item {
                source,
                destination,
                allowed_root: root.clone(),
                kind: "file".into(),
                external: false,
            });
        }
        let plan = Plan {
            items,
            source_time: 0,
            destination_time: 0,
            title: String::new(),
        };
        assert!(execute_internal(&plan, &backups, Some(1)).is_err());
        for name in ["a", "b"] {
            assert_eq!(
                disk::read_to_string(root.join(format!("{name}.sav"))).unwrap(),
                "original"
            );
        }
        assert_eq!(disk::read_dir(&root).unwrap().count(), 2);
    }
    #[test]
    fn payload_added_during_staging_is_rejected_before_originals_move() {
        let temp = tempfile::tempdir().unwrap();
        let backup = temp.path().join("backup");
        let source = backup.join("path1");
        let user = temp.path().join("user");
        let destination = user.join("Game");
        fs::mkdir(&source).unwrap();
        fs::mkdir(&destination).unwrap();
        disk::write(source.join("slot.sav"), "replacement").unwrap();
        disk::write(destination.join("slot.sav"), "original").unwrap();
        let plan = Plan {
            items: vec![Item {
                source,
                destination: destination.clone(),
                allowed_root: user.clone(),
                kind: "folder".into(),
                external: true,
            }],
            source_time: 0,
            destination_time: 0,
            title: String::new(),
        };
        validate_item(&plan.items[0], &backup).unwrap();
        let error = execute_transaction(&plan, &backup, None, |_, replacement| {
            disk::write(replacement.join("late.ps1"), "malicious script").map_err(fs::err)
        })
        .unwrap_err();
        assert!(error.contains("executable or script"), "{error}");
        assert_eq!(
            disk::read_to_string(destination.join("slot.sav")).unwrap(),
            "original"
        );
        assert!(!destination.join("late.ps1").exists());
        assert_eq!(disk::read_dir(&user).unwrap().count(), 1);
        // The temporary replacement filename must not mask a file's final extension.
        let replacement = temp.path().join("replacement");
        disk::write(&replacement, "script").unwrap();
        let mut item = plan.items[0].clone();
        item.kind = "file".into();
        item.destination = user.join("startup.cmd");
        assert!(validate_staged(&item, &replacement).is_err());
    }

    #[test]
    fn external_folder_cannot_install_scripts() {
        let temp = tempfile::tempdir().unwrap();
        let backup = temp.path().join("backup");
        let source = backup.join("path1");
        let root = temp.path().join("user");
        fs::mkdir(&source).unwrap();
        fs::mkdir(&root).unwrap();
        disk::write(source.join("attack.ps1"), "bad").unwrap();
        let item = Item {
            source,
            destination: root.join("Game"),
            allowed_root: root,
            kind: "folder".into(),
            external: true,
        };
        assert!(validate_item(&item, &backup).is_err());
    }

    #[test]
    #[cfg(windows)]
    fn registry_and_filesystem_rollback_preserve_unicode_and_remove_new_values() {
        struct RegistryScope(String);
        impl Drop for RegistryScope {
            fn drop(&mut self) {
                let _ = registry::delete(&self.0);
            }
        }
        let scope = RegistryScope(format!(
            "HKEY_CURRENT_USER\\Software\\OpenGameSave-RustTest-{}",
            uuid::Uuid::new_v4()
        ));
        registry::normalize(&scope.0).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let backup = temp.path().join("backup");
        let reg_source = backup.join("path1");
        let file_source = backup.join("path2");
        let user = temp.path().join("user");
        for path in [&reg_source, &file_source, &user] {
            fs::mkdir(path).unwrap();
        }
        registry::command(&[
            "add",
            &scope.0,
            "/v",
            "State",
            "/t",
            "REG_SZ",
            "/d",
            "新存档",
            "/f",
        ])
        .unwrap();
        registry::command(&[
            "add",
            &scope.0,
            "/v",
            "Added",
            "/t",
            "REG_SZ",
            "/d",
            "added by backup",
            "/f",
        ])
        .unwrap();
        registry::export(&scope.0, &reg_source.join("registry_backup.reg")).unwrap();
        registry::command(&["delete", &scope.0, "/v", "Added", "/f"]).unwrap();
        registry::command(&[
            "add",
            &scope.0,
            "/v",
            "State",
            "/t",
            "REG_SZ",
            "/d",
            "原始存档",
            "/f",
        ])
        .unwrap();
        disk::write(file_source.join("slot.sav"), "replacement").unwrap();
        disk::write(user.join("slot.sav"), "original").unwrap();
        let plan = Plan {
            items: vec![
                Item {
                    source: reg_source,
                    destination: PathBuf::from(&scope.0),
                    allowed_root: PathBuf::new(),
                    kind: "reg".into(),
                    external: false,
                },
                Item {
                    source: file_source,
                    destination: user.join("slot.sav"),
                    allowed_root: user.clone(),
                    kind: "file".into(),
                    external: false,
                },
            ],
            source_time: 0,
            destination_time: 0,
            title: String::new(),
        };
        let error = execute_internal(&plan, &backup, Some(0)).unwrap_err();
        assert!(error.contains("Injected transaction"), "{error}");
        let key = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .open_subkey(scope.0.strip_prefix("HKEY_CURRENT_USER\\").unwrap())
            .unwrap();
        assert_eq!(key.get_value::<String, _>("State").unwrap(), "原始存档");
        assert!(key.get_raw_value("Added").is_err());
        assert_eq!(
            disk::read_to_string(user.join("slot.sav")).unwrap(),
            "original"
        );
    }
}
