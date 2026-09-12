use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, String>;
pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn hash(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
/// Match Node path.resolve's representation used by legacy journal/baseline hashes.
pub fn root_identity(path: &Path) -> String {
    let normalized: PathBuf = path.components().collect();
    if cfg!(windows) {
        normalized
            .to_string_lossy()
            .replace('/', "\\")
            .to_lowercase()
    } else {
        normalized.to_string_lossy().into_owned()
    }
}
pub fn truncate_utf16(value: &str, maximum: usize) -> String {
    let mut units = 0;
    value
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= maximum
        })
        .collect()
}

pub fn no_links(path: &Path) -> Result<()> {
    let mut prefix = PathBuf::new();
    for component in path.components() {
        if matches!(component, Component::ParentDir) {
            return Err("Parent path components are not allowed".into());
        }
        prefix.push(component);
        match fs::symlink_metadata(&prefix) {
            Ok(meta) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return Err("Refusing a filesystem reparse point".into());
                    }
                }
                if meta.file_type().is_symlink() {
                    return Err("Refusing a symbolic link in a backup path".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(err(e)),
        }
    }
    Ok(())
}
pub fn same_path(a: &Path, b: &Path) -> bool {
    root_identity(a) == root_identity(b)
}
pub fn sync_root(settings: &Value, requested: Option<&Value>) -> Result<PathBuf> {
    let configured = settings["backupPath"].as_str().unwrap_or_default();
    if configured.is_empty() {
        return Err("Configure a backup directory before synchronization".into());
    }
    let path = PathBuf::from(configured);
    if !path.is_absolute() {
        return Err("Backup path must be absolute".into());
    }
    no_links(&path)?;
    let requested = requested
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(configured);
    if !same_path(&path, Path::new(requested)) {
        return Err("Sync is limited to the configured backup directory".into());
    }
    Ok(path)
}
pub fn read_json(path: &Path, limit: u64) -> Result<Value> {
    no_links(path)?;
    let meta = fs::symlink_metadata(path).map_err(err)?;
    if !meta.is_file() || meta.len() > limit {
        return Err("Invalid or oversized JSON file".into());
    }
    let mut data = Vec::new();
    File::open(path)
        .map_err(err)?
        .take(limit + 1)
        .read_to_end(&mut data)
        .map_err(err)?;
    if data.len() as u64 > limit {
        return Err("JSON file changed while reading".into());
    }
    serde_json::from_slice(&data).map_err(err)
}
pub fn atomic_json(path: &Path, value: &impl serde::Serialize) -> Result<()> {
    atomic_write(path, &serde_json::to_vec_pretty(value).map_err(err)?)
}
pub fn atomic_write(path: &Path, data: &[u8]) -> Result<()> {
    no_links(path)?;
    let parent = path.parent().ok_or("Missing parent directory")?;
    fs::create_dir_all(parent).map_err(err)?;
    no_links(parent)?;
    let temp = parent.join(format!(".ogs-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(err)?;
        file.write_all(data).map_err(err)?;
        file.sync_all().map_err(err)?;
        drop(file);
        fs::rename(&temp, path).map_err(err)?;
        #[cfg(unix)]
        {
            File::open(parent).map_err(err)?.sync_all().map_err(err)?;
        }
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    result
}
pub fn hash_file(path: &Path) -> Result<(u64, String)> {
    no_links(path)?;
    let meta = fs::symlink_metadata(path).map_err(err)?;
    if !meta.is_file() {
        return Err("Backup item is not a regular file".into());
    }
    let mut file = File::open(path).map_err(err)?;
    let mut hasher = Sha256::new();
    let mut size = 0;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(err)?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > super::manifest::MAX_FILE_SIZE {
            return Err("Backup file exceeds synchronization size limit".into());
        }
        hasher.update(&buffer[..n]);
    }
    if size != meta.len() {
        return Err("Backup changed while hashing; retry synchronization".into());
    }
    Ok((size, format!("{:x}", hasher.finalize())))
}
pub fn safe_remove_tree(base: &Path, target: &Path) -> Result<()> {
    if target == base || !target.starts_with(base) {
        return Err("Refusing to delete outside transaction directory".into());
    }
    no_links(target)?;
    if !target.exists() {
        return Ok(());
    }
    for entry in walkdir::WalkDir::new(target).follow_links(false) {
        let entry = entry.map_err(err)?;
        no_links(entry.path())?;
    }
    fs::remove_dir_all(target).map_err(err)
}
pub fn backup_keys(root: &Path) -> Result<BTreeSet<String>> {
    no_links(root)?;
    let mut keys = BTreeSet::new();
    if !root.exists() {
        return Ok(keys);
    }
    for game in fs::read_dir(root).map_err(err)? {
        let game = game.map_err(err)?;
        if !game.file_type().map_err(err)?.is_dir() {
            continue;
        }
        let id = game.file_name().to_string_lossy().into_owned();
        if super::manifest::wiki_id(&id).is_err() {
            continue;
        }
        no_links(&game.path())?;
        for backup in fs::read_dir(game.path()).map_err(err)? {
            let backup = backup.map_err(err)?;
            if !backup.file_type().map_err(err)?.is_dir() {
                continue;
            }
            let date = backup.file_name().to_string_lossy().into_owned();
            if super::manifest::backup_date(&date).is_err() {
                continue;
            }
            if backup.path().join("backup_info.json").exists() {
                no_links(&backup.path())?;
                keys.insert(format!("{id}/{date}"));
            }
        }
    }
    Ok(keys)
}
pub fn prune(root: &Path, settings: &Value) -> Result<()> {
    let max = settings["maxBackups"]
        .as_u64()
        .filter(|n| *n > 0)
        .unwrap_or(5) as usize;
    let mut grouped = std::collections::BTreeMap::<String, Vec<String>>::new();
    for key in backup_keys(root)? {
        if let Ok(metadata) = read_json(&root.join(&key).join("backup_info.json"), 1024 * 1024)
            .and_then(super::manifest::metadata)
        {
            if metadata["is_permanent"] != true {
                grouped
                    .entry(key.split('/').next().unwrap().into())
                    .or_default()
                    .push(key);
            }
        }
    }
    for backups in grouped.values_mut() {
        backups.sort_by(|a, b| b.cmp(a));
        for key in backups.iter().skip(max) {
            safe_remove_tree(root, &root.join(key))?;
        }
    }
    Ok(())
}
