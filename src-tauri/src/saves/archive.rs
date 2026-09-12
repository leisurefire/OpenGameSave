use super::{
    backup,
    fs::{self, Result},
    metadata,
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{self as disk, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
};
const MAX_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 100000;
pub fn entry_path(name: &str) -> Result<String> {
    let normalized = name.replace('\\', "/").trim_end_matches('/').to_owned();
    let segments: Vec<_> = normalized.split('/').collect();
    if name.len() > 4096 || segments.len() > 64 || segments.iter().any(|s| fs::segment(s).is_err())
    {
        return Err("Archive contains an unsafe path".into());
    }
    metadata::wiki(&json!(segments[0]))?;
    if segments.len() > 1 {
        metadata::date(segments[1])?;
    }
    Ok(normalized)
}
fn extraction_entry(
    root: &Path,
    name: &str,
    directory: bool,
    size: u64,
    reader: &mut dyn Read,
    total: &mut u64,
) -> Result<()> {
    let name = entry_path(name)?;
    let path = root.join(&name);
    if !fs::inside(root, &path) {
        return Err("Archive path escapes staging".into());
    }
    if directory {
        if size != 0 {
            return Err("Directory contains unexpected archive data".into());
        }
        fs::mkdir(&path)?;
        return Ok(());
    }
    if name.split('/').count() < 3 {
        return Err("Archive files must belong to a backup snapshot".into());
    }
    fs::mkdir(path.parent().ok_or("Invalid archive path")?)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(fs::err)?;
    let actual =
        std::io::copy(&mut reader.take(size.saturating_add(1)), &mut file).map_err(fs::err)?;
    *total = total.checked_add(actual).ok_or("Archive size overflow")?;
    if actual != size || *total > MAX_BYTES {
        return Err("Archive exceeded its declared size or extraction limit".into());
    }
    file.sync_all().map_err(fs::err)?;
    Ok(())
}
fn extract(path: &Path, root: &Path, progress: &impl Fn(u64)) -> Result<()> {
    let m = fs::regular(path)?;
    if !m.is_file()
        || m.len() > MAX_BYTES
        || path
            .extension()
            .and_then(|s| s.to_str())
            .map(str::to_lowercase)
            .as_deref()
            != Some("gsmr")
    {
        return Err("Select a regular .gsmr backup archive".into());
    }
    let mut header = [0u8; 6];
    File::open(path)
        .map_err(fs::err)?
        .read_exact(&mut header)
        .map_err(fs::err)?;
    let mut actual = 0u64;
    if header == [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] {
        let mut archive = sevenz_rust2::ArchiveReader::open(path, sevenz_rust2::Password::empty())
            .map_err(fs::err)?;
        let entries = &archive.archive().files;
        if entries.is_empty() || entries.len() > MAX_ENTRIES {
            return Err("Invalid archive entry count".into());
        }
        let mut declared = 0u64;
        let mut seen = HashSet::new();
        for e in entries {
            let name = entry_path(&e.name)?;
            if !seen.insert(name.to_lowercase())
                || e.is_anti_item
                || e.windows_attributes & 0x400 != 0
                || (e.windows_attributes >> 16) & 0xf000 == 0xa000
            {
                return Err(
                    "Archive contains duplicate entries, links, or deletion records".into(),
                );
            }
            declared = declared
                .checked_add(e.size)
                .ok_or("Archive size overflow")?;
            if declared > MAX_BYTES {
                return Err("Archive expands beyond size limit".into());
            }
        }
        archive
            .for_each_entries(|e, reader| {
                extraction_entry(root, &e.name, e.is_directory, e.size, reader, &mut actual)
                    .map_err(|e| sevenz_rust2::Error::Other(e.into()))?;
                if e.has_last_modified_date && !e.is_directory {
                    let time: std::time::SystemTime = e.last_modified_date.into();
                    let _ = filetime::set_file_mtime(
                        root.join(
                            entry_path(&e.name)
                                .map_err(|e| sevenz_rust2::Error::Other(e.into()))?,
                        ),
                        filetime::FileTime::from_system_time(time),
                    );
                }
                progress((actual * 50).checked_div(declared).unwrap_or(50));
                Ok(true)
            })
            .map_err(fs::err)?;
    } else if header.starts_with(b"PK") {
        let mut archive =
            zip::ZipArchive::new(File::open(path).map_err(fs::err)?).map_err(fs::err)?;
        if archive.is_empty() || archive.len() > MAX_ENTRIES {
            return Err("Invalid archive entry count".into());
        }
        let mut declared = 0u64;
        let mut seen = HashSet::new();
        for i in 0..archive.len() {
            let e = archive.by_index(i).map_err(fs::err)?;
            let name = entry_path(e.name())?;
            if !seen.insert(name.to_lowercase())
                || e.unix_mode()
                    .is_some_and(|mode| !matches!(mode & 0xf000, 0 | 0x4000 | 0x8000))
            {
                return Err("Archive contains links or duplicate entries".into());
            }
            declared = declared
                .checked_add(e.size())
                .ok_or("Archive size overflow")?;
            if declared > MAX_BYTES {
                return Err("Archive expands beyond size limit".into());
            }
        }
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(fs::err)?;
            let name = entry.name().to_owned();
            let is_dir = entry.is_dir();
            let size = entry.size();
            let modified = entry.last_modified();
            extraction_entry(root, &name, is_dir, size, &mut entry, &mut actual)?;
            if !is_dir {
                use chrono::TimeZone;
                if let Some(modified) = modified {
                    if let Some(naive) = chrono::NaiveDate::from_ymd_opt(
                        modified.year() as i32,
                        modified.month() as u32,
                        modified.day() as u32,
                    )
                    .and_then(|date| {
                        date.and_hms_opt(
                            modified.hour() as u32,
                            modified.minute() as u32,
                            modified.second() as u32,
                        )
                    }) {
                        if let Some(time) = chrono::Local.from_local_datetime(&naive).earliest() {
                            filetime::set_file_mtime(
                                root.join(entry_path(&name)?),
                                filetime::FileTime::from_unix_time(time.timestamp(), 0),
                            )
                            .map_err(fs::err)?;
                        }
                    }
                }
            }
            progress((actual * 50).checked_div(declared).unwrap_or(50));
        }
    } else {
        return Err("Unsupported backup archive format".into());
    }
    Ok(())
}
fn collect(root: &Path) -> Result<Vec<(String, String, PathBuf)>> {
    let mut result = vec![];
    for game in disk::read_dir(root).map_err(fs::err)? {
        let game = game.map_err(fs::err)?;
        if !fs::regular(&game.path())?.is_dir() {
            return Err("Archive root may only contain game directories".into());
        }
        let id = metadata::wiki(&json!(game.file_name().to_string_lossy()))?;
        for snapshot in disk::read_dir(game.path()).map_err(fs::err)? {
            let snapshot = snapshot.map_err(fs::err)?;
            let when = metadata::date(&snapshot.file_name().to_string_lossy())?;
            if !fs::regular(&snapshot.path())?.is_dir() {
                return Err("Expected snapshot directory".into());
            }
            let mut info = metadata::load(&snapshot.path())?;
            let mut allowed = HashSet::from(["backup_info.json".to_owned()]);
            for p in info["backup_paths"]
                .as_array()
                .ok_or("Invalid backup paths")?
            {
                allowed.insert(
                    p["folder_name"]
                        .as_str()
                        .ok_or("Invalid backup folder")?
                        .to_owned(),
                );
                if !fs::regular(
                    &snapshot
                        .path()
                        .join(p["folder_name"].as_str().ok_or("Invalid backup folder")?),
                )?
                .is_dir()
                {
                    return Err("Archive is missing a declared payload directory".into());
                }
            }
            for child in disk::read_dir(snapshot.path()).map_err(fs::err)? {
                let child = child.map_err(fs::err)?;
                if !allowed.contains(&child.file_name().to_string_lossy().into_owned()) {
                    return Err("Archive snapshot contains undeclared data".into());
                }
            }
            info["provenance"] = json!("external");
            fs::atomic_json(&snapshot.path().join("backup_info.json"), &info)?;
            result.push((id.clone(), when, snapshot.path()));
        }
    }
    if result.is_empty() {
        return Err("Archive contains no backup snapshots".into());
    }
    Ok(result)
}
pub fn import(root: &Path, path: &Path, progress: impl Fn(u64)) -> Result<Value> {
    fs::mkdir(root)?;
    let staging = tempfile::Builder::new()
        .prefix(".ogs-import-")
        .tempdir_in(root)
        .map_err(fs::err)?;
    extract(path, staging.path(), &progress)?;
    let entries = collect(staging.path())?;
    let mut installed = vec![];
    let mut skipped = 0usize;
    let result = (|| -> Result<()> {
        for (i, (id, when, source)) in entries.iter().enumerate() {
            let game = metadata::snapshot(root, &json!(id), None)?;
            fs::mkdir(&game)?;
            let destination = metadata::snapshot(root, &json!(id), Some(when))?;
            if destination.exists() {
                if !fs::regular(&destination)?.is_dir() {
                    return Err("Existing backup destination is invalid".into());
                }
                skipped += 1;
            } else {
                disk::rename(source, &destination).map_err(fs::err)?;
                installed.push(destination);
            }
            progress(50 + (i + 1) as u64 * 50 / entries.len() as u64);
        }
        Ok(())
    })();
    if let Err(error) = result {
        let mut failures = vec![];
        for dest in &installed {
            if let Err(e) = fs::remove(root, dest) {
                failures.push(format!("{}: {e}", dest.display()));
            }
        }
        if !failures.is_empty() {
            return Err(format!(
                "{error}; import rollback incomplete; retained snapshots: {}",
                failures.join("; ")
            ));
        }
        return Err(error);
    }
    Ok(json!({"imported":installed.len(),"skipped":skipped}))
}
pub fn export(
    root: &Path,
    destination: &Path,
    count: u64,
    ids: Option<&[Value]>,
    progress: impl Fn(u64),
) -> Result<PathBuf> {
    if count == 0 || count > 1000 {
        return Err("Export count must be between 1 and 1000".into());
    }
    fs::mkdir(destination)?;
    let selected = ids
        .map(|v| v.iter().map(metadata::wiki).collect::<Result<HashSet<_>>>())
        .transpose()?;
    let listed = backup::list(root, None)?;
    let mut snapshots = vec![];
    for game in listed["games"].as_array().into_iter().flatten() {
        let id = metadata::wiki(&game["wiki_page_id"])?;
        if selected.as_ref().is_some_and(|v| !v.contains(&id)) {
            continue;
        }
        let mut ordinary = 0;
        for snapshot in game["backups"].as_array().into_iter().flatten() {
            if snapshot["is_permanent"] != true {
                if ordinary >= count {
                    continue;
                }
                ordinary += 1;
            }
            snapshots.push(metadata::snapshot(
                root,
                &json!(id),
                snapshot["date"].as_str(),
            )?);
        }
    }
    if snapshots.is_empty() {
        return Err("No backups matched export selection".into());
    }
    let output = destination.join(format!(
        "GSMBackup-{}-{}.gsmr",
        chrono::Local::now().format("%Y-%m-%d_%H-%M-%S"),
        &uuid::Uuid::new_v4().to_string()[..8]
    ));
    let staging = destination.join(format!(".ogs-export-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut writer = sevenz_rust2::ArchiveWriter::new(
            OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&staging)
                .map_err(fs::err)?,
        )
        .map_err(fs::err)?;
        let mut count = 0;
        for (i, snapshot) in snapshots.iter().enumerate() {
            for entry in walkdir::WalkDir::new(snapshot).follow_links(false) {
                let entry = entry.map_err(fs::err)?;
                count += 1;
                if count > MAX_ENTRIES {
                    return Err("Export exceeds archive entry limit".into());
                }
                let m = fs::regular(entry.path())?;
                let name = entry
                    .path()
                    .strip_prefix(root)
                    .map_err(fs::err)?
                    .to_string_lossy()
                    .replace('\\', "/");
                entry_path(&name)?;
                let archive_entry = sevenz_rust2::ArchiveEntry::from_path(entry.path(), name);
                if m.is_file() {
                    writer
                        .push_archive_entry(
                            archive_entry,
                            Some(File::open(entry.path()).map_err(fs::err)?),
                        )
                        .map_err(fs::err)?;
                } else {
                    writer
                        .push_archive_entry::<File>(archive_entry, None)
                        .map_err(fs::err)?;
                }
            }
            progress((i + 1) as u64 * 100 / snapshots.len() as u64);
        }
        writer
            .finish()
            .map_err(fs::err)?
            .sync_all()
            .map_err(fs::err)?;
        disk::rename(&staging, &output).map_err(fs::err)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = disk::remove_file(staging);
    }
    result?;
    Ok(output)
}
pub fn migrate(
    source: &Path,
    destination: &Path,
    progress: impl Fn(u64),
    commit: impl FnOnce() -> Result<()>,
) -> Result<bool> {
    fs::absolute(source)?;
    fs::absolute(destination)?;
    if fs::inside(source, destination) || fs::inside(destination, source) {
        return Err("Migration paths must be separate non-root directories".into());
    }
    fs::no_links(source)?;
    fs::no_links(destination)?;
    let initial = fs::manifest(source)?;
    let parent = destination.parent().ok_or("Missing migration parent")?;
    fs::mkdir(parent)?;
    if destination.exists()
        && disk::read_dir(destination)
            .map_err(fs::err)?
            .next()
            .is_some()
    {
        if fs::manifest(destination)? != initial {
            return Err("Migration destination must be empty or exactly match source".into());
        }
    } else {
        let staging = tempfile::Builder::new()
            .prefix(".ogs-migration-")
            .tempdir_in(parent)
            .map_err(fs::err)?;
        fs::copy_tree(source, staging.path())?;
        progress(75);
        if fs::manifest(source)? != initial || fs::manifest(staging.path())? != initial {
            return Err("Source changed or copied data failed verification".into());
        }
        if destination.exists() {
            disk::remove_dir(destination).map_err(fs::err)?;
        }
        disk::rename(staging.path(), destination).map_err(fs::err)?;
    }
    if fs::manifest(source)? != initial || fs::manifest(destination)? != initial {
        return Err("Migration verification failed".into());
    }
    commit()?;
    progress(100);
    // Configuration is committed before retiring the old data. A cleanup failure
    // leaves a second safe copy and never rolls configuration back.
    if fs::manifest(source).is_ok_and(|manifest| manifest == initial)
        && fs::no_links(source).is_ok()
    {
        // `source` itself was explicitly authorized, checked to be non-root,
        // and byte-for-byte verified again immediately before retirement.
        let _ = disk::remove_dir_all(source);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn rejects_archive_traversal_ads_and_devices() {
        for name in [
            "/42/x",
            "../x",
            "42/2025-01-01_00-00/path1/../../bad",
            "42/2025-01-01_00-00/path1/file:ads",
            "42/2025-01-01_00-00/path1/CON",
        ] {
            assert!(entry_path(name).is_err(), "{name}");
        }
    }
    #[test]
    fn legacy_7z_roundtrip_marks_import_external() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("backups");
        let snap = root.join("42/2025-01-01_00-00/path1");
        fs::mkdir(&snap).unwrap();
        disk::write(snap.join("slot.sav"), "save data").unwrap();
        fs::atomic_json(&snap.parent().unwrap().join("backup_info.json"),&json!({"title":"Example","provenance":"local","backup_paths":[{"folder_name":"path1","template":"{{p|userprofile}}/Example/slot.sav","type":"file"}]})).unwrap();
        let out = temp.path().join("export");
        let file = export(&root, &out, 5, None, |_| {}).unwrap();
        let dest = temp.path().join("import");
        assert_eq!(import(&dest, &file, |_| {}).unwrap()["imported"], 1);
        assert_eq!(
            metadata::load(&dest.join("42/2025-01-01_00-00")).unwrap()["provenance"],
            "external"
        );
        assert_eq!(
            disk::read_to_string(dest.join("42/2025-01-01_00-00/path1/slot.sav")).unwrap(),
            "save data"
        );
        assert_eq!(import(&dest, &file, |_| {}).unwrap()["skipped"], 1);
    }

    #[test]
    fn zip_interchange_preserves_file_time_and_external_provenance() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("example.gsmr");
        let mut writer = zip::ZipWriter::new(File::create(&archive).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .last_modified_time(zip::DateTime::from_date_and_time(2025, 2, 3, 4, 5, 6).unwrap());
        writer
            .start_file("42/2025-02-03_04-05/backup_info.json", options)
            .unwrap();
        writer.write_all(serde_json::to_string(&json!({"title":"Zip game","provenance":"local","backup_paths":[{"folder_name":"path1","template":"{{p|userprofile}}/Game/slot.sav","type":"file"}]})).unwrap().as_bytes()).unwrap();
        writer
            .start_file("42/2025-02-03_04-05/path1/slot.sav", options)
            .unwrap();
        writer.write_all(b"zip save").unwrap();
        writer.finish().unwrap();
        let root = temp.path().join("imported");
        import(&root, &archive, |_| {}).unwrap();
        let path = root.join("42/2025-02-03_04-05");
        assert_eq!(metadata::load(&path).unwrap()["provenance"], "external");
        assert_eq!(
            disk::read(path.join("path1/slot.sav")).unwrap(),
            b"zip save"
        );
        let modified: chrono::DateTime<chrono::Local> = disk::metadata(path.join("path1/slot.sav"))
            .unwrap()
            .modified()
            .unwrap()
            .into();
        assert_eq!(
            modified.format("%Y-%m-%d %H:%M:%S").to_string(),
            "2025-02-03 04:05:06"
        );
    }

    #[test]
    fn malicious_zip_is_rejected_before_installing_any_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("malicious.gsmr");
        let mut writer = zip::ZipWriter::new(File::create(&archive).unwrap());
        writer
            .start_file(
                "42/2025-01-01_00-00/path1/slot.sav",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        writer.write_all(b"untrusted").unwrap();
        writer
            .start_file("../outside.sav", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"escape").unwrap();
        writer.finish().unwrap();
        let root = temp.path().join("imported");
        assert!(import(&root, &archive, |_| {}).is_err());
        assert!(!root.join("42").exists());
        assert!(!temp.path().join("outside.sav").exists());
    }

    #[test]
    fn archive_rejects_payload_directories_not_declared_in_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("undeclared.gsmr");
        let mut writer = zip::ZipWriter::new(File::create(&archive).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        writer
            .start_file("42/2025-01-01_00-00/backup_info.json", options)
            .unwrap();
        writer.write_all(br#"{"title":"Game","backup_paths":[{"folder_name":"path1","template":"{{p|game}}/save","type":"folder"}]}"#).unwrap();
        for name in ["path1/save.sav", "path2/undeclared.sav"] {
            writer
                .start_file(format!("42/2025-01-01_00-00/{name}"), options)
                .unwrap();
            writer.write_all(b"data").unwrap();
        }
        writer.finish().unwrap();
        let root = temp.path().join("imported");
        assert!(import(&root, &archive, |_| {})
            .unwrap_err()
            .contains("undeclared"));
        assert!(!root.join("42").exists());
    }
}
