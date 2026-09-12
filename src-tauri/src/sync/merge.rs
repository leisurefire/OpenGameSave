use super::{
    credentials::Config,
    manifest::{self, SyncFile},
    util::{self, err, Result},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

#[derive(Clone, Serialize, Deserialize)]
pub struct HashFile {
    pub path: String,
    pub sha256: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Baseline {
    version: u32,
    target_key: String,
    remote_revision: Option<String>,
    pub local_files: Vec<HashFile>,
    pub remote_files: Vec<HashFile>,
}
fn target(root: &Path, config: &Config) -> String {
    let root = util::root_identity(root);
    util::hash(
        serde_json::to_string(&json!([
            root,
            config.url,
            config.username,
            config.remote_path
        ]))
        .unwrap()
        .as_bytes(),
    )
}
fn hashes(files: &[SyncFile]) -> Vec<HashFile> {
    files
        .iter()
        .map(|f| HashFile {
            path: f.path.clone(),
            sha256: f.sha256.clone(),
        })
        .collect()
}
pub fn load(app_data: &Path, root: &Path, config: &Config) -> Option<Baseline> {
    let key = target(root, config);
    let value = util::read_json(
        &app_data.join(format!("OGS Settings/webdav-sync-{key}.json")),
        41 * 1024 * 1024,
    )
    .ok()?;
    let state: Baseline = serde_json::from_value(value).ok()?;
    if state.version != 1
        || state.target_key != key
        || state
            .remote_revision
            .as_deref()
            .is_some_and(|r| manifest::revision(r).is_err())
    {
        return None;
    }
    for files in [&state.local_files, &state.remote_files] {
        if files.len() > manifest::MAX_FILES {
            return None;
        }
        let mut seen = BTreeSet::new();
        for file in files {
            if manifest::manifest_path(&file.path).is_err()
                || !manifest::digest(&file.sha256)
                || !seen.insert(file.path.to_lowercase())
            {
                return None;
            }
        }
    }
    Some(state)
}
pub struct BaselineUpdate<'a> {
    pub local: &'a [SyncFile],
    pub remote: &'a [SyncFile],
    pub revision: Option<String>,
    pub old: Option<&'a Baseline>,
    pub deferred_local: &'a BTreeSet<String>,
    pub deferred_remote: &'a BTreeSet<String>,
}
pub fn persist(
    app_data: &Path,
    root: &Path,
    config: &Config,
    update: BaselineUpdate<'_>,
) -> Result<()> {
    let BaselineUpdate {
        local,
        remote,
        revision,
        old,
        deferred_local,
        deferred_remote,
    } = update;
    let retain =
        |current: Vec<HashFile>, previous: Option<&Vec<HashFile>>, deferred: &BTreeSet<String>| {
            let mut current = current
                .into_iter()
                .filter(|f| !deferred.contains(&key(&f.path)))
                .collect::<Vec<_>>();
            if let Some(previous) = previous {
                current.extend(
                    previous
                        .iter()
                        .filter(|f| deferred.contains(&key(&f.path)))
                        .cloned(),
                );
            }
            current.sort_by(|a, b| a.path.cmp(&b.path));
            current
        };
    let target_key = target(root, config);
    let state = Baseline {
        version: 1,
        target_key: target_key.clone(),
        remote_revision: revision,
        local_files: retain(hashes(local), old.map(|s| &s.local_files), deferred_local),
        remote_files: retain(
            hashes(remote),
            old.map(|s| &s.remote_files),
            deferred_remote,
        ),
    };
    let bytes = serde_json::to_vec_pretty(&state).map_err(err)?;
    if bytes.len() > 41 * 1024 * 1024 {
        return Err("WebDAV sync baseline is too large".into());
    }
    util::atomic_write(
        &app_data.join(format!("OGS Settings/webdav-sync-{target_key}.json")),
        &bytes,
    )
}
pub fn key(path: &str) -> String {
    path.split('/').take(2).collect::<Vec<_>>().join("/")
}
pub fn groups(files: &[SyncFile]) -> BTreeMap<String, Vec<SyncFile>> {
    let mut groups = BTreeMap::new();
    for file in files {
        groups
            .entry(file.key())
            .or_insert_with(Vec::new)
            .push(file.clone());
    }
    groups
}
fn group_hashes(
    files: impl IntoIterator<Item = (String, String)>,
) -> BTreeMap<String, BTreeMap<String, String>> {
    let mut groups = BTreeMap::new();
    for (path, sha) in files {
        groups
            .entry(key(&path))
            .or_insert_with(BTreeMap::new)
            .insert(path, sha);
    }
    groups
}
#[derive(Default)]
pub struct Classification {
    pub conflicts: BTreeSet<String>,
    pub local: BTreeSet<String>,
    pub remote: BTreeSet<String>,
    pub stable: BTreeSet<String>,
}
pub fn classify(
    remote: &[SyncFile],
    local: &[SyncFile],
    baseline: Option<&Baseline>,
) -> Classification {
    let r = group_hashes(remote.iter().map(|f| (f.path.clone(), f.sha256.clone())));
    let l = group_hashes(local.iter().map(|f| (f.path.clone(), f.sha256.clone())));
    let pl = group_hashes(baseline.into_iter().flat_map(|s| {
        s.local_files
            .iter()
            .map(|f| (f.path.clone(), f.sha256.clone()))
    }));
    let pr = group_hashes(baseline.into_iter().flat_map(|s| {
        s.remote_files
            .iter()
            .map(|f| (f.path.clone(), f.sha256.clone()))
    }));
    let keys = r
        .keys()
        .chain(l.keys())
        .chain(pl.keys())
        .chain(pr.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut result = Classification::default();
    for key in keys {
        if l.get(&key) == r.get(&key) {
            continue;
        }
        if !l.contains_key(&key) {
            result.remote.insert(key);
            continue;
        }
        if !r.contains_key(&key) {
            result.local.insert(key);
            continue;
        }
        let local_changed = l.get(&key) != pl.get(&key);
        let remote_changed = r.get(&key) != pr.get(&key);
        if baseline.is_none() || (local_changed && remote_changed) {
            result.conflicts.insert(key);
        } else if local_changed {
            result.local.insert(key);
        } else if remote_changed {
            result.remote.insert(key);
        } else {
            result.stable.insert(key);
        }
    }
    result
}
pub fn allocate(
    original: &str,
    reserved: &mut BTreeSet<String>,
    root: Option<&Path>,
) -> Result<String> {
    manifest::backup_key(original)?;
    let (game, date) = original.split_once('/').unwrap();
    let date = manifest::backup_date(date)?;
    for offset in 1..=86400 {
        let candidate = format!(
            "{game}/{}",
            (date + chrono::Duration::seconds(offset)).format("%Y-%m-%d_%H-%M-%S")
        );
        if !reserved.contains(&candidate) && !root.is_some_and(|r| r.join(&candidate).exists()) {
            reserved.insert(candidate.clone());
            return Ok(candidate);
        }
    }
    Err("Unable to allocate a conflict backup".into())
}
pub fn conflict_metadata(bytes: &[u8], device: &str) -> Result<Vec<u8>> {
    let mut value = manifest::metadata(serde_json::from_slice(bytes).map_err(err)?)?;
    let name = value["custom_name"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(value["title"].as_str().unwrap());
    value["custom_name"] = json!(util::truncate_utf16(
        &format!(
            "{name} [Conflict {}]",
            device.chars().take(8).collect::<String>()
        ),
        120
    ));
    value["is_permanent"] = json!(true);
    serde_json::to_vec_pretty(&value).map_err(err)
}
pub fn conflict_record(
    original: &str,
    destination: &str,
    local: &str,
    remote: &str,
    direction: &str,
    preserve_remote: bool,
) -> Value {
    json!({"originalBackup":original,"conflictBackup":destination,"localDeviceId":local,"remoteDeviceId":remote,"direction":direction,
        "originalVersion":if preserve_remote{"local"}else{"remote"},"conflictVersion":if preserve_remote{"remote"}else{"local"}})
}
pub struct UploadMerge {
    pub files: Vec<SyncFile>,
    pub upload: Vec<SyncFile>,
    pub conflicts: Vec<Value>,
    pub deferred: BTreeSet<String>,
}
pub fn upload(
    remote: &[SyncFile],
    local: &[SyncFile],
    baseline: Option<&Baseline>,
    device: &str,
    remote_device: &str,
) -> Result<UploadMerge> {
    let classification = classify(remote, local, baseline);
    let mut merged = groups(remote);
    let mut reserved = remote
        .iter()
        .chain(local)
        .map(SyncFile::key)
        .collect::<BTreeSet<_>>();
    let mut conflicts = Vec::new();
    let mut upload = Vec::new();
    let remote_index = remote
        .iter()
        .map(|f| (&f.path, &f.sha256))
        .collect::<BTreeMap<_, _>>();
    for (key, files) in groups(local) {
        if classification.remote.contains(&key) || classification.stable.contains(&key) {
            continue;
        }
        if classification.conflicts.contains(&key) {
            let destination = allocate(&key, &mut reserved, None)?;
            let remapped = merged
                .remove(&key)
                .unwrap_or_default()
                .iter()
                .map(|f| {
                    let mut f = f.remap(&destination);
                    f.conflict_device = Some(remote_device.into());
                    f
                })
                .collect::<Vec<_>>();
            merged.insert(destination.clone(), remapped);
            conflicts.push(conflict_record(
                &key,
                &destination,
                device,
                remote_device,
                "upload",
                true,
            ));
        }
        upload.extend(
            files
                .iter()
                .filter(|f| {
                    remote_index
                        .get(&f.path)
                        .is_none_or(|hash| *hash != &f.sha256)
                })
                .cloned(),
        );
        merged.insert(key, files);
    }
    let mut files = merged.into_values().flatten().collect::<Vec<_>>();
    manifest::validate_files(&mut files)?;
    Ok(UploadMerge {
        files,
        upload,
        conflicts,
        deferred: classification.remote,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(windows)]
    fn legacy_baseline_key_normalizes_windows_root_aliases() {
        let config = Config {
            url: "https://example.com/dav".into(),
            username: "alice".into(),
            password: String::new(),
            remote_path: "/OGS".into(),
            device_id: uuid::Uuid::new_v4().to_string(),
            has_password: false,
            needs_password: false,
        };
        let expected = util::hash(
            serde_json::to_string(&json!([
                "c:\\users\\example\\ogs backups",
                config.url,
                config.username,
                config.remote_path
            ]))
            .unwrap()
            .as_bytes(),
        );
        assert_eq!(
            target(Path::new("C:/Users/Example//OGS Backups/"), &config),
            expected
        );
        assert_eq!(
            target(Path::new("C:\\Users\\Example\\OGS Backups"), &config),
            expected
        );
    }
    fn file(name: &str, data: &str) -> SyncFile {
        SyncFile {
            path: format!("1/2026-08-18_10-00-00/path1/{name}"),
            size: data.len() as u64,
            mtime_ms: 0.0,
            sha256: util::hash(data.as_bytes()),
            local_path: None,
            data: Some(data.as_bytes().to_vec()),
            remote_path: None,
            conflict_device: None,
        }
    }
    fn baseline(local: &[SyncFile], remote: &[SyncFile]) -> Baseline {
        Baseline {
            version: 1,
            target_key: "".into(),
            remote_revision: None,
            local_files: hashes(local),
            remote_files: hashes(remote),
        }
    }
    #[test]
    fn concurrent_changes_preserve_entire_remote_backup() {
        let remote = vec![file("a", "remote"), file("b", "remote b")];
        let local = vec![file("a", "local")];
        let result = upload(&remote, &local, None, "local-device", "remote-device").unwrap();
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(result.files.len(), 3);
        assert!(result
            .files
            .iter()
            .any(|f| f.path.contains("10-00-01") && f.sha256 == util::hash(b"remote b")));
    }
    #[test]
    fn unchanged_local_never_reverts_remote_and_remains_deferred() {
        let base = vec![file("a", "base")];
        let remote = vec![file("a", "remote")];
        let state = baseline(&base, &base);
        let result = upload(&remote, &base, Some(&state), "local", "remote").unwrap();
        assert_eq!(result.files[0].sha256, remote[0].sha256);
        assert!(result.upload.is_empty());
        assert_eq!(result.deferred.len(), 1);
    }
    #[test]
    fn local_group_replacement_drops_stale_remote_members() {
        let remote = vec![file("a", "base"), file("b", "stale")];
        let old = vec![file("a", "base")];
        let local = vec![file("a", "changed")];
        let result = upload(
            &remote,
            &local,
            Some(&baseline(&old, &remote)),
            "local",
            "remote",
        )
        .unwrap();
        assert_eq!(result.files.len(), 1);
    }
    #[test]
    fn stable_provenance_divergence_does_not_conflict() {
        let local = vec![file("a", "local")];
        let remote = vec![file("a", "remote")];
        let state = baseline(&local, &remote);
        assert_eq!(classify(&remote, &local, Some(&state)).stable.len(), 1);
        assert!(upload(&remote, &local, Some(&state), "local", "remote")
            .unwrap()
            .conflicts
            .is_empty());
    }
    #[test]
    fn conflict_backups_are_permanent() {
        let bytes =
            conflict_metadata(br#"{"title":"Game","backup_paths":[]}"#, "12345678-abcd").unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["is_permanent"], true);
        assert_eq!(value["custom_name"], "Game [Conflict 12345678]");
    }
}
