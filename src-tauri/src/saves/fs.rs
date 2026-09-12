use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::UNIX_EPOCH,
};

pub type Result<T> = std::result::Result<T, String>;

/// A bounded snapshot cache for one read-only discovery request. Never pass it
/// into backup/restore authorization or filesystem mutation operations.
#[derive(Default)]
pub struct ScanContext {
    metadata: HashMap<String, Result<fs::Metadata>>,
    directories: HashMap<String, Arc<Vec<PathBuf>>>,
    sizes: HashMap<String, Result<(u64, u64, u64)>>,
    paths: HashMap<String, Result<Vec<String>>>,
    cached_entries: usize,
    cached_matches: usize,
    cancellation: Option<Arc<AtomicBool>>,
    pub metrics: ScanMetrics,
    #[cfg(test)]
    disable_cache: bool,
}

#[derive(Default, Debug)]
pub struct ScanMetrics {
    pub strict_path_checks: u64,
    pub directory_reads: u64,
    pub metadata_hits: u64,
    pub directory_hits: u64,
    pub stats_hits: u64,
    pub pattern_hits: u64,
}

pub enum ScanEntries {
    Cached {
        paths: Arc<Vec<PathBuf>>,
        index: usize,
    },
    Streaming {
        prefix: std::vec::IntoIter<PathBuf>,
        rest: Box<fs::ReadDir>,
    },
}
impl Iterator for ScanEntries {
    type Item = Result<PathBuf>;
    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::Cached { paths, index } => {
                let path = paths.get(*index)?.clone();
                *index += 1;
                Some(Ok(path))
            }
            Self::Streaming { prefix, rest } => prefix.next().map(Ok).or_else(|| {
                rest.next()
                    .map(|entry| entry.map(|e| e.path()).map_err(err))
            }),
        }
    }
}

impl ScanContext {
    const MAX_ENTRIES: usize = 50_000;
    pub fn with_cancellation(cancellation: Arc<AtomicBool>) -> Self {
        Self {
            cancellation: Some(cancellation),
            ..Self::default()
        }
    }
    #[cfg(test)]
    pub fn uncached() -> Self {
        Self {
            disable_cache: true,
            ..Self::default()
        }
    }
    fn caches(&self) -> bool {
        #[cfg(test)]
        {
            !self.disable_cache
        }
        #[cfg(not(test))]
        {
            true
        }
    }
    pub fn check_cancelled(&self) -> Result<()> {
        if self
            .cancellation
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
        {
            Err("Save scan cancelled".into())
        } else {
            Ok(())
        }
    }
    pub fn regular(&mut self, path: &Path) -> Result<fs::Metadata> {
        self.check_cancelled()?;
        let key = key(path);
        if let Some(value) = self.metadata.get(&key) {
            self.metrics.metadata_hits += 1;
            return value.clone();
        }
        self.metrics.strict_path_checks += 1;
        let result = regular(path);
        if self.caches() && self.metadata.len() < Self::MAX_ENTRIES {
            self.metadata.insert(key, result.clone());
        }
        result
    }
    pub fn read_dir(&mut self, path: &Path) -> Result<ScanEntries> {
        self.check_cancelled()?;
        let key = key(path);
        if let Some(paths) = self.directories.get(&key) {
            self.metrics.directory_hits += 1;
            return Ok(ScanEntries::Cached {
                paths: paths.clone(),
                index: 0,
            });
        }
        // Before every actual directory enumeration revalidate the complete
        // ancestry live. Cached metadata must never authorize following a newly
        // substituted junction or symlink into a different tree.
        self.metrics.strict_path_checks += 1;
        if !regular(path)?.is_dir() {
            return Err("Expected scan directory".into());
        }
        self.metrics.directory_reads += 1;
        let mut rest = fs::read_dir(path).map_err(err)?;
        let capacity = if self.caches() {
            Self::MAX_ENTRIES
                .saturating_sub(self.cached_entries)
                .min(10_000)
        } else {
            0
        };
        let mut prefix = Vec::new();
        if capacity > 0 {
            while prefix.len() <= capacity {
                self.check_cancelled()?;
                match rest.next() {
                    Some(entry) => prefix.push(entry.map_err(err)?.path()),
                    None => {
                        self.cached_entries += prefix.len().max(1);
                        let paths = Arc::new(prefix);
                        self.directories.insert(key, paths.clone());
                        return Ok(ScanEntries::Cached { paths, index: 0 });
                    }
                }
            }
        }
        // Large directories stream the remainder instead of increasing cache
        // memory or dropping rules/files after a cache limit is reached.
        Ok(ScanEntries::Streaming {
            prefix: prefix.into_iter(),
            rest: Box::new(rest),
        })
    }
    pub fn cached_paths(&mut self, key: &str) -> Option<Result<Vec<String>>> {
        let result = self.paths.get(key)?.clone();
        self.metrics.pattern_hits += 1;
        Some(result)
    }
    pub fn remember_paths(&mut self, key: String, value: &Result<Vec<String>>) {
        let count = value.as_ref().map(|paths| paths.len().max(1)).unwrap_or(1);
        if self.caches() && self.cached_matches + count <= Self::MAX_ENTRIES {
            self.cached_matches += count;
            self.paths.insert(key, value.clone());
        }
    }
    pub fn stats(&mut self, path: &Path) -> Result<(u64, u64, u64)> {
        self.check_cancelled()?;
        let key = key(path);
        if let Some(value) = self.sizes.get(&key) {
            self.metrics.stats_hits += 1;
            return value.clone();
        }
        let result = (|| {
            let mut pending = vec![(path.to_owned(), 0usize)];
            let (mut size, mut latest, mut files, mut visited) = (0u64, 0u64, 0u64, 0usize);
            while let Some((current, depth)) = pending.pop() {
                self.check_cancelled()?;
                visited += 1;
                if visited > 200_000 || depth > 64 {
                    return Err("Directory exceeds traversal limits".into());
                }
                let metadata = self.regular(&current)?;
                if metadata.is_file() {
                    files += 1;
                    size = size
                        .checked_add(metadata.len())
                        .ok_or("Directory size overflow")?;
                    latest = latest.max(
                        metadata
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|t| t.as_millis() as u64)
                            .unwrap_or(0),
                    );
                } else {
                    for child in self.read_dir(&current)? {
                        self.check_cancelled()?;
                        pending.push((child?, depth + 1));
                        if pending.len() + visited > 200_000 {
                            return Err("Directory exceeds traversal limits".into());
                        }
                    }
                }
            }
            Ok((size, latest, files))
        })();
        if self.caches() && self.sizes.len() < Self::MAX_ENTRIES {
            self.sizes.insert(key, result.clone());
        }
        result
    }
}

pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn key(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}
pub fn inside(root: &Path, path: &Path) -> bool {
    let r = key(root).trim_end_matches('/').to_owned();
    let p = key(path);
    p == r || p.starts_with(&(r + "/"))
}
pub fn absolute(path: &Path) -> Result<()> {
    if !path.is_absolute() || path.parent().is_none() {
        return Err("A non-root absolute path is required".into());
    }
    let text = path.to_string_lossy();
    if text.encode_utf16().count() > 32767
        || text.contains(['\0', '\r', '\n'])
        || text.starts_with("\\\\?\\")
        || text.starts_with("\\\\.\\")
    {
        return Err("Invalid filesystem path".into());
    }
    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        || text
            .replace('\\', "/")
            .split('/')
            .any(|p| p == ".." || p == ".")
    {
        return Err("Path traversal is forbidden".into());
    }
    if cfg!(windows) {
        for part in path.components() {
            if let Component::Normal(name) = part {
                segment(&name.to_string_lossy())?;
            }
        }
    }
    Ok(())
}
pub fn segment(name: &str) -> Result<()> {
    let base = name.split('.').next().unwrap_or("").to_uppercase();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.encode_utf16().count() > 255
        || name.contains(['\\', '/', ':', '\0'])
        || name.ends_with([' ', '.'])
        || name.chars().any(|c| c.is_control())
        || ["CON", "PRN", "AUX", "NUL"].contains(&base.as_str())
        || (base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && base.as_bytes()[3].is_ascii_digit())
    {
        return Err("Unsafe path component".into());
    }
    Ok(())
}
pub fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_type().is_symlink() || meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}
pub fn no_links(path: &Path) -> Result<()> {
    // Filesystem roots may be inspected or used as an existing parent, while
    // mutation targets are separately required to be non-root absolute paths.
    if path.is_absolute() && path.parent().is_none() {
        let metadata = fs::symlink_metadata(path).map_err(err)?;
        return if is_link(&metadata) {
            Err("Linked filesystem root".into())
        } else {
            Ok(())
        };
    }
    absolute(path)?;
    let mut current = PathBuf::new();
    for c in path.components() {
        current.push(c);
        match fs::symlink_metadata(&current) {
            Ok(m) if is_link(&m) => {
                return Err(format!("Linked paths are forbidden: {}", current.display()))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(err(e)),
        }
    }
    Ok(())
}
pub fn regular(path: &Path) -> Result<fs::Metadata> {
    no_links(path)?;
    let m = fs::symlink_metadata(path).map_err(err)?;
    if is_link(&m) || (!m.is_file() && !m.is_dir()) {
        return Err("Unsupported filesystem object".into());
    }
    Ok(m)
}
pub fn mkdir(path: &Path) -> Result<()> {
    no_links(path)?;
    fs::create_dir_all(path).map_err(err)?;
    if !regular(path)?.is_dir() {
        return Err("Expected directory".into());
    }
    Ok(())
}
pub fn read_json(path: &Path, max: u64) -> Result<serde_json::Value> {
    let m = regular(path)?;
    if !m.is_file() || m.len() > max {
        return Err("Invalid bounded JSON file".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(err)
}
pub fn atomic_json(path: &Path, value: &serde_json::Value) -> Result<()> {
    no_links(path)?;
    mkdir(path.parent().ok_or("Missing parent")?)?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(err)?;
        file.write_all(&serde_json::to_vec_pretty(value).map_err(err)?)
            .map_err(err)?;
        file.sync_all().map_err(err)?;
        fs::rename(&temp, path).map_err(err)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
pub fn copy_file(source: &Path, dest: &Path) -> Result<()> {
    let before = regular(source)?;
    if !before.is_file() {
        return Err("Expected regular source file".into());
    }
    no_links(dest)?;
    let mut input = File::open(source).map_err(err)?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(dest)
        .map_err(err)?;
    let count = std::io::copy(&mut input, &mut output).map_err(err)?;
    output.sync_all().map_err(err)?;
    let after = regular(source)?;
    if count != before.len()
        || after.len() != before.len()
        || after.modified().ok() != before.modified().ok()
    {
        return Err("Source data changed while copying".into());
    }
    fs::set_permissions(dest, before.permissions()).map_err(err)?;
    filetime::set_file_times(
        dest,
        filetime::FileTime::from_last_access_time(&before),
        filetime::FileTime::from_last_modification_time(&before),
    )
    .map_err(err)
}
pub fn copy_tree(source: &Path, dest: &Path) -> Result<()> {
    if !regular(source)?.is_dir() {
        return Err("Expected source directory".into());
    }
    mkdir(dest)?;
    let mut count = 0;
    for entry in walkdir::WalkDir::new(source)
        .follow_links(false)
        .max_depth(65)
    {
        let e = entry.map_err(err)?;
        count += 1;
        if count > 200000 || e.depth() > 64 {
            return Err("Directory exceeds traversal limits".into());
        }
        let m = regular(e.path())?;
        let rel = e.path().strip_prefix(source).map_err(err)?;
        if rel.as_os_str().is_empty() {
            continue;
        }
        let target = dest.join(rel);
        if m.is_dir() {
            mkdir(&target)?;
        } else {
            copy_file(e.path(), &target)?;
        }
    }
    Ok(())
}
pub fn remove(root: &Path, target: &Path) -> Result<()> {
    absolute(root)?;
    if !inside(root, target) || key(root) == key(target) {
        return Err("Removal escapes its authorized root".into());
    }
    let m = regular(target)?;
    if m.is_dir() {
        fs::remove_dir_all(target).map_err(err)
    } else {
        fs::remove_file(target).map_err(err)
    }
}
pub fn size_time(path: &Path) -> Result<(u64, u64)> {
    stats(path).map(|(size, latest, _)| (size, latest))
}
pub fn stats(path: &Path) -> Result<(u64, u64, u64)> {
    if !path.exists() {
        return Ok((0, 0, 0));
    }
    let mut size = 0u64;
    let mut latest = 0;
    let mut n = 0;
    let mut files = 0;
    for e in walkdir::WalkDir::new(path)
        .follow_links(false)
        .max_depth(65)
    {
        let e = e.map_err(err)?;
        n += 1;
        if n > 200000 || e.depth() > 64 {
            return Err("Directory exceeds traversal limits".into());
        }
        let m = regular(e.path())?;
        if m.is_file() {
            files += 1;
            size = size.checked_add(m.len()).ok_or("Directory size overflow")?;
            latest = latest.max(
                m.modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|x| x.as_millis() as u64)
                    .unwrap_or(0),
            );
        }
    }
    Ok((size, latest, files))
}
pub fn hash(path: &Path) -> Result<String> {
    let before = regular(path)?;
    if !before.is_file() {
        return Err("Expected file".into());
    }
    let mut file = File::open(path).map_err(err)?;
    let mut digest = Sha256::new();
    let mut bytes = [0u8; 65536];
    loop {
        let count = file.read(&mut bytes).map_err(err)?;
        if count == 0 {
            break;
        }
        digest.update(&bytes[..count]);
    }
    let after = regular(path)?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err("File changed during verification".into());
    }
    Ok(format!("{:x}", digest.finalize()))
}
pub fn manifest(root: &Path) -> Result<BTreeMap<String, (u64, String)>> {
    let mut result = BTreeMap::new();
    for (n, e) in walkdir::WalkDir::new(root)
        .follow_links(false)
        .max_depth(65)
        .into_iter()
        .enumerate()
    {
        let e = e.map_err(err)?;
        if n > 200000 || e.depth() > 64 {
            return Err("Migration exceeds traversal limits".into());
        }
        let m = regular(e.path())?;
        let rel = e
            .path()
            .strip_prefix(root)
            .map_err(err)?
            .to_string_lossy()
            .replace('\\', "/");
        result.insert(
            rel,
            if m.is_file() {
                (m.len(), hash(e.path())?)
            } else {
                (0, String::new())
            },
        );
    }
    Ok(result)
}
