//! Durable journal compatible with the Electron v1/v2 recovery format.
//! Staged backup trees are installed by rename; pre-commit failures restore originals.
use super::{
    manifest,
    util::{self, err, Result},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    path: String,
    #[serde(default)]
    mtime_ms: f64,
    #[serde(default = "replace")]
    operation: String,
    #[serde(default = "pending")]
    state: String,
    had_original: Option<bool>,
}
fn replace() -> String {
    "replace".into()
}
fn pending() -> String {
    "pending".into()
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    version: u32,
    sync_root: PathBuf,
    state: String,
    entries: Vec<Entry>,
    #[serde(skip)]
    directory: PathBuf,
}
pub fn base(root: &Path) -> Result<PathBuf> {
    if !root.is_absolute() {
        return Err("Transaction backup root must be absolute".into());
    }
    util::no_links(root)?;
    let comparison = util::root_identity(root);
    let key = util::hash(comparison.as_bytes());
    let directory = root
        .parent()
        .ok_or("Backup directory has no parent")?
        .join(format!(".OpenGameSave-transactions-{}", &key[..16]));
    if directory.starts_with(root) {
        return Err("Transaction storage must be outside the backup directory".into());
    }
    util::no_links(&directory)?;
    Ok(directory)
}
fn remove(path: &Path, base: &Path, tree: bool) -> Result<()> {
    util::no_links(path)?;
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(err(e)),
        Ok(meta) if tree && meta.is_dir() => util::safe_remove_tree(base, path),
        Ok(meta) if !tree && meta.is_file() => fs::remove_file(path).map_err(err),
        _ => Err("Unexpected item type in transaction recovery".into()),
    }
}
pub fn disk_space(path: &Path, bytes: u64) -> Result<()> {
    let available = fs2::available_space(path).map_err(err)?;
    if available
        < bytes
            .checked_add(64 * 1024 * 1024)
            .ok_or("Download size overflow")?
    {
        return Err("Not enough free disk space for a transactional download".into());
    }
    Ok(())
}
impl Transaction {
    pub fn begin(root: &Path, keys: &BTreeSet<String>, bytes: u64) -> Result<Self> {
        recover(root)?;
        let base = base(root)?;
        fs::create_dir_all(&base).map_err(err)?;
        util::no_links(&base)?;
        disk_space(&base, bytes)?;
        let directory = base.join(Uuid::new_v4().to_string());
        fs::create_dir(&directory).map_err(err)?;
        let mut entries = Vec::new();
        for key in keys {
            manifest::backup_key(key)?;
            entries.push(Entry {
                path: key.clone(),
                mtime_ms: 0.0,
                operation: "replace-tree".into(),
                state: "pending".into(),
                had_original: None,
            });
        }
        let transaction = Self {
            version: 2,
            sync_root: root.into(),
            state: "downloading".into(),
            entries,
            directory,
        };
        let preparation = (|| {
            fs::create_dir(transaction.directory.join("staged")).map_err(err)?;
            fs::create_dir(transaction.directory.join("previous")).map_err(err)?;
            util::atomic_json(&transaction.directory.join("journal.json"), &transaction)
        })();
        if preparation.is_err() {
            let _ = util::safe_remove_tree(&base, &transaction.directory);
        }
        preparation?;
        Ok(transaction)
    }
    pub fn stage(&self, path: &str) -> Result<PathBuf> {
        manifest::manifest_path(path)?;
        let destination = self.directory.join("staged").join(path);
        util::no_links(&destination)?;
        Ok(destination)
    }
    fn update(&self, index: Option<usize>) -> Result<()> {
        let update = if let Some(index) = index {
            json!({"index":index,"state":self.entries[index].state,"hadOriginal":self.entries[index].had_original})
        } else {
            json!({"state":self.state})
        };
        let path = self.directory.join("journal-updates.jsonl");
        util::no_links(&path)?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(err)?;
        serde_json::to_writer(&mut file, &update).map_err(err)?;
        file.write_all(b"\n").map_err(err)?;
        file.sync_all().map_err(err)
    }
    pub fn install(&mut self) -> Result<()> {
        fs::create_dir_all(&self.sync_root).map_err(err)?;
        util::no_links(&self.sync_root)?;
        self.state = "installing".into();
        self.update(None)?;
        let install = (|| {
            for index in 0..self.entries.len() {
                let destination = self.sync_root.join(&self.entries[index].path);
                let previous = self
                    .directory
                    .join("previous")
                    .join(&self.entries[index].path);
                let staged = self
                    .directory
                    .join("staged")
                    .join(&self.entries[index].path);
                util::no_links(&destination)?;
                util::no_links(&previous)?;
                util::no_links(&staged)?;
                let tree = self.entries[index].operation == "replace-tree";
                let expected = |path: &Path| if tree { path.is_dir() } else { path.is_file() };
                if !expected(&staged) {
                    return Err("Invalid staged backup item".into());
                }
                let exists = destination.try_exists().map_err(err)?;
                if exists && !expected(&destination) {
                    return Err("Refusing to replace an unexpected backup item".into());
                }
                self.entries[index].had_original = Some(exists);
                self.entries[index].state = if exists {
                    "moving-previous"
                } else {
                    "installing"
                }
                .into();
                self.update(Some(index))?;
                if exists {
                    fs::create_dir_all(previous.parent().unwrap()).map_err(err)?;
                    fs::rename(&destination, &previous).map_err(err)?;
                    self.entries[index].state = "previous-moved".into();
                    self.update(Some(index))?;
                }
                fs::create_dir_all(destination.parent().unwrap()).map_err(err)?;
                util::no_links(&destination)?;
                self.entries[index].state = "installing".into();
                self.update(Some(index))?;
                fs::rename(&staged, &destination).map_err(err)?;
                self.entries[index].state = "installed".into();
                self.update(Some(index))?;
            }
            self.state = "committed".into();
            if let Err(error) = self.update(None) {
                self.state = "installing".into();
                return Err(error);
            }
            Ok(())
        })();
        if let Err(error) = install {
            return match self.rollback() {
                Ok(()) => Err(error),
                Err(recovery) => Err(format!("{error}; rollback requires recovery: {recovery}")),
            };
        }
        // Committed data must never roll back if cleanup is interrupted.
        let _ = self.cleanup();
        Ok(())
    }
    pub fn rollback(&self) -> Result<()> {
        if self.state == "committed" {
            return self.cleanup();
        }
        for entry in self.entries.iter().rev() {
            let destination = self.sync_root.join(&entry.path);
            let staged = self.directory.join("staged").join(&entry.path);
            let previous = self.directory.join("previous").join(&entry.path);
            util::no_links(&destination)?;
            util::no_links(&staged)?;
            util::no_links(&previous)?;
            let tree = entry.operation == "replace-tree";
            if previous.try_exists().map_err(err)? {
                if if tree {
                    !previous.is_dir()
                } else {
                    !previous.is_file()
                } {
                    return Err("Invalid previous backup item".into());
                }
                remove(&destination, &self.sync_root, tree)?;
                fs::create_dir_all(destination.parent().unwrap()).map_err(err)?;
                fs::rename(previous, destination).map_err(err)?;
            } else if !staged.try_exists().map_err(err)?
                && entry.state != "pending"
                && entry.had_original == Some(false)
            {
                remove(&destination, &self.sync_root, tree)?;
            }
        }
        util::safe_remove_tree(&base(&self.sync_root)?, &self.directory)
    }
    fn cleanup(&self) -> Result<()> {
        if !self.directory.exists() {
            return Ok(());
        }
        let directory = self.directory.with_file_name(format!(
            "{}.committed",
            self.directory.file_name().unwrap().to_string_lossy()
        ));
        util::no_links(&directory)?;
        fs::rename(&self.directory, &directory).map_err(err)?;
        util::safe_remove_tree(&base(&self.sync_root)?, &directory)
    }
}
fn read(directory: &Path, root: &Path) -> Result<Transaction> {
    let mut value = util::read_json(&directory.join("journal.json"), 32 * 1024 * 1024)?;
    let updates = directory.join("journal-updates.jsonl");
    if updates.exists() {
        util::no_links(&updates)?;
        if !updates.is_file() || fs::metadata(&updates).map_err(err)?.len() > 64 * 1024 * 1024 {
            return Err("Invalid transaction updates".into());
        }
        let mut data = String::new();
        File::open(updates)
            .map_err(err)?
            .take(64 * 1024 * 1024 + 1)
            .read_to_string(&mut data)
            .map_err(err)?;
        if data.len() > 64 * 1024 * 1024 {
            return Err("Oversized transaction updates".into());
        }
        let complete = &data[..data.rfind('\n').map(|n| n + 1).unwrap_or(0)];
        for line in complete.lines().filter(|s| !s.is_empty()) {
            let update: Value = serde_json::from_str(line).map_err(err)?;
            if let Some(index) = update.get("index") {
                let index = index.as_u64().ok_or("Invalid transaction update index")? as usize;
                let entry = value["entries"]
                    .as_array_mut()
                    .and_then(|entries| entries.get_mut(index))
                    .ok_or("Invalid transaction update index")?;
                entry["state"] = update["state"].clone();
                entry["hadOriginal"] = update["hadOriginal"].clone();
            } else {
                value["state"] = update["state"].clone();
            }
        }
    }
    let mut transaction: Transaction = serde_json::from_value(value).map_err(err)?;
    if !matches!(transaction.version, 1 | 2)
        || !util::same_path(root, &transaction.sync_root)
        || !matches!(
            transaction.state.as_str(),
            "downloading" | "installing" | "committed"
        )
        || transaction.entries.len() > 100_000
    {
        return Err("Invalid transaction journal".into());
    }
    let mut seen = BTreeSet::new();
    let mut trees = BTreeSet::new();
    for entry in &transaction.entries {
        if entry.operation == "replace-tree" {
            manifest::backup_key(&entry.path)?;
            trees.insert(entry.path.clone());
        } else if entry.operation == "replace" {
            manifest::manifest_path(&entry.path)?;
        } else {
            return Err("Invalid transaction operation".into());
        }
        if !seen.insert(entry.path.to_lowercase())
            || !entry.mtime_ms.is_finite()
            || entry.mtime_ms < 0.0
            || !matches!(
                entry.state.as_str(),
                "pending" | "moving-previous" | "previous-moved" | "installing" | "installed"
            )
        {
            return Err("Invalid transaction journal entry".into());
        }
    }
    if transaction.entries.iter().any(|entry| {
        entry.operation == "replace"
            && trees.contains(&entry.path.split('/').take(2).collect::<Vec<_>>().join("/"))
    }) {
        return Err("Overlapping transaction entries".into());
    }
    transaction.directory = directory.into();
    transaction.sync_root = root.into();
    Ok(transaction)
}
pub fn recover(root: &Path) -> Result<()> {
    let base = base(root)?;
    if !base.exists() {
        return Ok(());
    }
    util::no_links(&base)?;
    for entry in fs::read_dir(&base).map_err(err)? {
        let entry = entry.map_err(err)?;
        let directory = entry.path();
        util::no_links(&directory)?;
        if !entry.file_type().map_err(err)?.is_dir() {
            return Err("Unsafe transaction storage item".into());
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(id) = name.strip_suffix(".committed") {
            manifest::revision(id)?;
            util::safe_remove_tree(&base, &directory)?;
            continue;
        }
        manifest::revision(&name)?;
        let transaction = read(&directory, root)?;
        if transaction.state == "committed" {
            transaction.cleanup()?;
        } else {
            transaction.rollback()?;
        }
    }
    match fs::remove_dir(&base) {
        Ok(()) => {}
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) => {}
        Err(e) => return Err(err(e)),
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(windows)]
    fn recovery_finds_legacy_journal_with_forward_slash_settings() {
        let (_temp, root) = fixture();
        let tx = Transaction::begin(&root, &BTreeSet::from([KEY.into()]), 1).unwrap();
        let alias = PathBuf::from(format!("{}/", root.to_string_lossy().replace('\\', "/")));
        assert_eq!(base(&root).unwrap(), base(&alias).unwrap());
        recover(&alias).unwrap();
        assert!(!tx.directory.exists());
        assert!(root.join(KEY).join("old").exists());
    }
    const KEY: &str = "1/2026-08-18_10-00-00";
    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("backups");
        fs::create_dir_all(root.join(KEY)).unwrap();
        fs::write(root.join(KEY).join("old"), b"original").unwrap();
        (temp, root)
    }
    #[test]
    fn interrupted_tree_install_restores_original() {
        let (_temp, root) = fixture();
        let mut tx = Transaction::begin(&root, &BTreeSet::from([KEY.into()]), 1).unwrap();
        let staged = tx.directory.join("staged").join(KEY);
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("new"), b"new").unwrap();
        tx.state = "installing".into();
        tx.update(None).unwrap();
        tx.entries[0].had_original = Some(true);
        tx.entries[0].state = "moving-previous".into();
        tx.update(Some(0)).unwrap();
        let previous = tx.directory.join("previous").join(KEY);
        fs::create_dir_all(previous.parent().unwrap()).unwrap();
        fs::rename(root.join(KEY), previous).unwrap();
        // Simulate process termination between the rename and its journal append.
        recover(&root).unwrap();
        assert_eq!(fs::read(root.join(KEY).join("old")).unwrap(), b"original");
    }
    #[test]
    fn committed_install_replaces_whole_backup() {
        let (_temp, root) = fixture();
        let mut tx = Transaction::begin(&root, &BTreeSet::from([KEY.into()]), 1).unwrap();
        let staged = tx.directory.join("staged").join(KEY);
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("new"), b"new").unwrap();
        tx.install().unwrap();
        recover(&root).unwrap();
        assert!(!root.join(KEY).join("old").exists());
        assert_eq!(fs::read(root.join(KEY).join("new")).unwrap(), b"new");
    }
    #[test]
    fn recovery_rejects_traversal_before_mutation() {
        let (_temp, root) = fixture();
        let tx = Transaction::begin(&root, &BTreeSet::from([KEY.into()]), 1).unwrap();
        let mut value = serde_json::to_value(&tx).unwrap();
        value["entries"][0]["path"] = json!("../outside");
        util::atomic_json(&tx.directory.join("journal.json"), &value).unwrap();
        assert!(recover(&root).is_err());
        assert!(root.join(KEY).join("old").exists());
    }
}
