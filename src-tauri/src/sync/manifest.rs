use super::util::{self, err, Result};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

pub const MAX_MANIFEST: u64 = 20 * 1024 * 1024;
pub const MAX_FILES: usize = 100_000;
pub const MAX_FILE_SIZE: u64 = 20 * 1024 * 1024 * 1024;
pub const MAX_TOTAL_SIZE: u64 = 200 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFile {
    pub path: String,
    pub size: u64,
    pub mtime_ms: f64,
    pub sha256: String,
    #[serde(skip)]
    pub local_path: Option<PathBuf>,
    #[serde(skip)]
    pub data: Option<Vec<u8>>,
    #[serde(skip)]
    pub remote_path: Option<String>,
    #[serde(skip)]
    pub conflict_device: Option<String>,
}
impl SyncFile {
    pub fn key(&self) -> String {
        self.path.split('/').take(2).collect::<Vec<_>>().join("/")
    }
    pub fn remap(&self, key: &str) -> Self {
        let mut file = self.clone();
        file.remote_path = Some(
            self.remote_path
                .clone()
                .unwrap_or_else(|| self.path.clone()),
        );
        file.path = format!(
            "{key}/{}",
            self.path.split('/').skip(2).collect::<Vec<_>>().join("/")
        );
        file
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u32,
    #[serde(default)]
    pub revision: Option<String>,
    #[serde(default)]
    pub parent_revision: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub generated_at: String,
    pub files: Vec<SyncFile>,
}
pub fn wiki_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err("Invalid wiki id".into());
    }
    Ok(())
}
pub fn backup_date(value: &str) -> Result<NaiveDateTime> {
    let format = match value.len() {
        16 => "%Y-%m-%d_%H-%M",
        19 => "%Y-%m-%d_%H-%M-%S",
        _ => return Err("Invalid backup date".into()),
    };
    let with_seconds = if value.len() == 16 {
        format!("{value}-00")
    } else {
        value.to_owned()
    };
    let date = NaiveDateTime::parse_from_str(&with_seconds, "%Y-%m-%d_%H-%M-%S")
        .map_err(|_| "Invalid backup date".to_owned())?;
    if date.format(format).to_string() != value
        || date.and_utc().timestamp_subsec_nanos() >= 1_000_000_000
    {
        return Err("Noncanonical backup date".into());
    }
    Ok(date)
}
pub fn portable_segment(value: &str) -> Result<()> {
    let reserved = value.split('.').next().unwrap_or("").to_lowercase();
    let device = matches!(
        reserved.as_str(),
        "con" | "prn" | "aux" | "nul" | "clock$" | "conin$" | "conout$"
    ) || ["com", "lpt"].iter().any(|p| {
        reserved
            .strip_prefix(p)
            .is_some_and(|s| s.chars().count() == 1 && "123456789¹²³".contains(s))
    });
    if value.is_empty()
        || value.encode_utf16().count() > 255
        || value.starts_with('.')
        || value.ends_with(['.', ' '])
        || value.chars().any(|c| c < ' ' || "<>:\"|?*\\/".contains(c))
        || device
        || value.nfc().collect::<String>() != value
    {
        return Err("Invalid portable path in WebDAV manifest".into());
    }
    Ok(())
}
pub fn folder_name(value: &str) -> bool {
    value.strip_prefix("path").is_some_and(|n| {
        !n.is_empty()
            && n.len() <= 4
            && !n.starts_with('0')
            && n.bytes().all(|c| c.is_ascii_digit())
    })
}
pub fn backup_key(value: &str) -> Result<()> {
    let segments = value.split('/').collect::<Vec<_>>();
    if segments.len() != 2 {
        return Err("Invalid backup key".into());
    }
    wiki_id(segments[0])?;
    portable_segment(segments[0])?;
    backup_date(segments[1])?;
    Ok(())
}
pub fn manifest_path(value: &str) -> Result<()> {
    if value.is_empty()
        || value.encode_utf16().count() > 4096
        || value.starts_with('/')
        || value.contains('\\')
    {
        return Err("Invalid manifest path".into());
    }
    let segments = value.split('/').collect::<Vec<_>>();
    if !(3..=64).contains(&segments.len()) {
        return Err("Invalid manifest path depth".into());
    }
    backup_key(&segments[..2].join("/"))?;
    for segment in &segments[2..] {
        portable_segment(segment)?;
    }
    if segments[2] == "backup_info.json" {
        if segments.len() != 3 {
            return Err("Invalid backup metadata path".into());
        }
    } else if !folder_name(segments[2]) {
        return Err("Path is outside backup metadata structure".into());
    }
    Ok(())
}
pub fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub fn revision(value: &str) -> Result<()> {
    let parsed = Uuid::parse_str(value).map_err(|_| "Invalid WebDAV revision".to_owned())?;
    if parsed.to_string() != value.to_lowercase()
        || !matches!(parsed.get_version_num(), 1..=8)
        || parsed.get_variant() != uuid::Variant::RFC4122
    {
        return Err("Invalid WebDAV revision".into());
    }
    Ok(())
}
pub fn validate_files(files: &mut [SyncFile]) -> Result<()> {
    if files.len() > MAX_FILES {
        return Err("Too many synchronization files".into());
    }
    let mut seen = BTreeSet::new();
    let mut prefixes = BTreeMap::new();
    let mut directories = BTreeSet::new();
    let mut sizes = BTreeMap::new();
    let mut total = 0u64;
    for file in files.iter() {
        manifest_path(&file.path)?;
        let segments = file.path.split('/').collect::<Vec<_>>();
        if segments.len() == 3 && segments[2] != "backup_info.json" {
            return Err("Backup data folders cannot be files".into());
        }
        if !seen.insert(file.path.to_lowercase()) {
            return Err("Duplicate file in manifest".into());
        }
        for i in 1..=segments.len() {
            let prefix = segments[..i].join("/");
            let folded = prefix.to_lowercase();
            if prefixes.get(&folded).is_some_and(|old| old != &prefix) {
                return Err("Case-folding path collision in manifest".into());
            }
            prefixes.insert(folded.clone(), prefix);
            if i < segments.len() {
                directories.insert(folded);
            }
        }
        if file.size > MAX_FILE_SIZE
            || !file.mtime_ms.is_finite()
            || !(0.0..=8640000000000000.0).contains(&file.mtime_ms)
            || !digest(&file.sha256)
        {
            return Err("Invalid file metadata in manifest".into());
        }
        if sizes
            .insert(file.sha256.clone(), file.size)
            .is_some_and(|size| size != file.size)
        {
            return Err("One object digest has conflicting sizes".into());
        }
        if file.path.ends_with("/backup_info.json") && file.size > 1024 * 1024 {
            return Err("Backup metadata is too large".into());
        }
        total = total
            .checked_add(file.size)
            .ok_or("Backup sizes overflow")?;
        if total > MAX_TOTAL_SIZE {
            return Err("Snapshot exceeds synchronization size limit".into());
        }
    }
    if seen.iter().any(|path| directories.contains(path)) {
        return Err("File/directory path collision in manifest".into());
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(())
}
pub fn snapshot(value: Value, legacy: bool) -> Result<Snapshot> {
    if !legacy && value.get("parentRevision").is_none() {
        return Err("Missing WebDAV parent revision".into());
    }
    let mut result: Snapshot = serde_json::from_value(value).map_err(err)?;
    if result.version != if legacy { 1 } else { 2 } {
        return Err("Invalid WebDAV snapshot version".into());
    }
    if !legacy {
        revision(result.revision.as_deref().ok_or("Missing revision")?)?;
        revision(result.device_id.as_deref().ok_or("Missing device id")?)?;
        if let Some(parent) = &result.parent_revision {
            revision(parent)?;
        }
        if result.revision == result.parent_revision {
            return Err("Snapshot cannot be its own parent".into());
        }
    }
    validate_files(&mut result.files)?;
    Ok(result)
}
fn text(value: &Value, maximum: usize, required: bool) -> Result<String> {
    if value.is_null() && !required {
        return Ok(String::new());
    }
    let value = value
        .as_str()
        .ok_or("Expected backup metadata text")?
        .trim();
    if value.encode_utf16().count() > maximum
        || (required && value.is_empty())
        || value.contains('\0')
    {
        return Err("Invalid backup metadata text".into());
    }
    Ok(value.into())
}
pub fn metadata(value: Value) -> Result<Value> {
    if !value.is_object() {
        return Err("Invalid backup metadata".into());
    }
    let paths = value["backup_paths"]
        .as_array()
        .ok_or("Invalid backup path list")?;
    if paths.len() > 128 {
        return Err("Too many backup paths".into());
    }
    let mut seen = BTreeSet::new();
    let mut normalized = Vec::new();
    for item in paths {
        let folder = item["folder_name"]
            .as_str()
            .ok_or("Invalid backup folder name")?;
        if !folder_name(folder) || !seen.insert(folder) {
            return Err("Invalid or duplicate backup folder".into());
        }
        let kind = item["type"].as_str().ok_or("Invalid backup path type")?;
        if !matches!(kind, "file" | "folder" | "reg") {
            return Err("Invalid backup path type".into());
        }
        normalized.push(json!({"folder_name":folder,"template":text(&item["template"],32767,true)?,"type":kind,
            "install_folder":if item["install_folder"].is_null(){Value::Null}else{json!(text(&item["install_folder"],512,false)?)} }));
    }
    Ok(
        json!({"title":text(&value["title"],512,true)?,"zh_CN":if value["zh_CN"].is_null(){Value::Null}else{json!(text(&value["zh_CN"],512,false)?)},
        "backup_paths":normalized,"provenance":if value["provenance"] == "local" {"local"}else{"external"},
        "is_permanent":value["is_permanent"] == true,"custom_name":text(&value["custom_name"],120,false)?}),
    )
}
pub fn validate_metadata_paths(
    files: &[SyncFile],
    metadata_by_key: &BTreeMap<String, Value>,
) -> Result<()> {
    let metadata_keys: BTreeSet<_> = files
        .iter()
        .filter(|f| f.path.ends_with("/backup_info.json"))
        .map(SyncFile::key)
        .collect();
    for file in files {
        let key = file.key();
        if !metadata_keys.contains(&key) {
            return Err(format!("Missing backup_info.json for {key}"));
        }
        let metadata = metadata_by_key
            .get(&key)
            .ok_or_else(|| format!("Missing backup metadata for {key}"))?;
        let folder = file.path.split('/').nth(2).unwrap_or("");
        if folder != "backup_info.json"
            && !metadata["backup_paths"]
                .as_array()
                .ok_or("Invalid metadata paths")?
                .iter()
                .any(|p| p["folder_name"] == folder)
        {
            return Err("Snapshot contains a path not declared by backup metadata".into());
        }
    }
    Ok(())
}
pub fn collect(root: &Path) -> Result<Vec<SyncFile>> {
    util::no_links(root)?;
    if !root.is_dir() {
        return Err("The backup path is not a regular directory".into());
    }
    let mut files = Vec::new();
    let mut metadata_by_key = BTreeMap::new();
    for key in util::backup_keys(root)? {
        let directory = root.join(&key);
        let value = metadata(util::read_json(
            &directory.join("backup_info.json"),
            1024 * 1024,
        )?)?;
        let mut allowed = BTreeSet::from(["backup_info.json".to_owned()]);
        for item in value["backup_paths"].as_array().unwrap() {
            allowed.insert(item["folder_name"].as_str().unwrap().into());
        }
        for entry in fs::read_dir(&directory).map_err(err)? {
            let entry = entry.map_err(err)?;
            if !allowed.contains(&entry.file_name().to_string_lossy().into_owned()) {
                return Err(format!("Backup contains undeclared data: {key}"));
            }
        }
        metadata_by_key.insert(key, value);
        for entry in walkdir::WalkDir::new(&directory)
            .min_depth(1)
            .follow_links(false)
        {
            let entry = entry.map_err(err)?;
            util::no_links(entry.path())?;
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(err)?
                .to_str()
                .ok_or("Non-Unicode backup filename")?
                .replace('\\', "/");
            manifest_path(&relative)?;
            if entry.file_type().is_dir() {
                continue;
            }
            if !entry.file_type().is_file() {
                return Err("Unsupported backup file type".into());
            }
            let stats = fs::metadata(entry.path()).map_err(err)?;
            let (size, sha256) = util::hash_file(entry.path())?;
            files.push(SyncFile {
                path: relative,
                size,
                mtime_ms: stats
                    .modified()
                    .map_err(err)?
                    .duration_since(UNIX_EPOCH)
                    .map_err(err)?
                    .as_secs_f64()
                    * 1000.0,
                sha256,
                local_path: Some(entry.path().to_path_buf()),
                data: None,
                remote_path: None,
                conflict_device: None,
            });
            if files.len() > MAX_FILES {
                return Err("Too many synchronization files".into());
            }
        }
    }
    validate_files(&mut files)?;
    validate_metadata_paths(&files, &metadata_by_key)?;
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_lengths_match_legacy_utf16_metadata_limits() {
        let valid =
            metadata(json!({"title":"游戏","backup_paths":[],"custom_name":"汉".repeat(120)}));
        assert!(valid.is_ok());
        assert!(
            metadata(json!({"title":"Game","backup_paths":[],"custom_name":"🎮".repeat(60)}))
                .is_ok()
        );
        assert!(
            metadata(json!({"title":"Game","backup_paths":[],"custom_name":"🎮".repeat(61)}))
                .is_err()
        );
        assert!(portable_segment(&"汉".repeat(255)).is_ok());
    }
    #[test]
    fn rejects_portability_and_traversal_hazards() {
        for path in [
            "../2026-08-18_10-00-00/path1/a",
            "1/2026-08-18_10-00-00/path1/../a",
            "1/2026-08-18_10-00-00/path1/NUL.txt",
            "1/2026-08-18_10-00-00/path1/a:b",
            "1/2026-08-18_10-00-00/other/a",
            "1/2026-02-30_10-00-00/path1/a",
        ] {
            assert!(manifest_path(path).is_err(), "{path}");
        }
        assert!(manifest_path("123/2026-08-18_10-00/path1/save.dat").is_ok());
    }
    #[test]
    fn defaults_remote_metadata_to_external() {
        let value = metadata(json!({"title":"Game","backup_paths":[]})).unwrap();
        assert_eq!(value["provenance"], "external");
    }
    #[test]
    fn rejects_case_and_file_directory_collisions() {
        let make = |path: &str| SyncFile {
            path: format!("1/2026-08-18_10-00-00/path1/{path}"),
            size: 1,
            mtime_ms: 0.0,
            sha256: util::hash(b"x"),
            local_path: None,
            data: None,
            remote_path: None,
            conflict_device: None,
        };
        assert!(validate_files(&mut [make("a"), make("a/b")]).is_err());
        assert!(validate_files(&mut [make("A/a"), make("a/b")]).is_err());
        assert!(validate_files(&mut [make("a"), make("b")]).is_ok());
    }
}
