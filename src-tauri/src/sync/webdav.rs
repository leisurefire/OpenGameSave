use super::{
    client::{Dav, Source},
    credentials::{self, Config},
    manifest::{self, Snapshot, SyncFile, MAX_MANIFEST},
    merge,
    transaction::{self, Transaction},
    util::{self, err, Result},
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
use uuid::Uuid;

struct Remote {
    snapshot: Snapshot,
    etag: String,
    legacy: bool,
}
fn read_remote(dav: &Dav) -> Result<Option<Remote>> {
    let root = &dav.config.remote_path;
    if let Some((pointer, etag)) = dav.json(&format!("{root}/current.json"), 64 * 1024, true)? {
        if pointer["version"] != 2 || pointer.get("parentRevision").is_none() {
            return Err("Invalid WebDAV current pointer version or parent revision".into());
        }
        for field in ["revision", "deviceId"] {
            manifest::revision(
                pointer[field]
                    .as_str()
                    .ok_or("Invalid WebDAV current pointer")?,
            )?;
        }
        if !pointer["parentRevision"].is_null() {
            manifest::revision(
                pointer["parentRevision"]
                    .as_str()
                    .ok_or("Invalid parent revision")?,
            )?;
        }
        super::client::validate_etag(&etag)?;
        let revision = pointer["revision"].as_str().unwrap();
        let (snapshot, _) = dav
            .json(
                &format!("{root}/snapshots/{revision}.json"),
                MAX_MANIFEST,
                false,
            )?
            .ok_or("Missing immutable snapshot")?;
        let snapshot = manifest::snapshot(snapshot, false)?;
        if snapshot.revision.as_deref() != Some(revision)
            || snapshot.parent_revision.as_deref() != pointer["parentRevision"].as_str()
            || snapshot.device_id.as_deref() != pointer["deviceId"].as_str()
        {
            return Err("WebDAV current.json does not match its immutable snapshot".into());
        }
        return Ok(Some(Remote {
            snapshot,
            etag,
            legacy: false,
        }));
    }
    if let Some((value, _)) = dav.json(
        &format!("{root}/.opengamesave-manifest.json"),
        MAX_MANIFEST,
        true,
    )? {
        return Ok(Some(Remote {
            snapshot: manifest::snapshot(value, true)?,
            etag: String::new(),
            legacy: true,
        }));
    }
    Ok(None)
}
fn source_path(dav: &Dav, remote: &Remote, file: &SyncFile) -> String {
    if remote.legacy {
        format!(
            "{}/{}",
            dav.config.remote_path,
            file.remote_path.as_deref().unwrap_or(&file.path)
        )
    } else {
        dav.object(&file.sha256)
    }
}
fn remote_metadata(dav: &Dav, remote: &Remote) -> Result<BTreeMap<String, Value>> {
    let mut metadata = BTreeMap::new();
    for file in remote
        .snapshot
        .files
        .iter()
        .filter(|f| f.path.ends_with("/backup_info.json"))
    {
        let (data, _) = dav
            .read(&source_path(dav, remote, file), 1024 * 1024, false)?
            .ok_or("Missing backup metadata")?;
        if data.len() as u64 != file.size || util::hash(&data) != file.sha256 {
            return Err("Remote backup metadata failed SHA-256 verification".into());
        }
        metadata.insert(
            file.key(),
            manifest::metadata(serde_json::from_slice(&data).map_err(err)?)?,
        );
    }
    manifest::validate_metadata_paths(&remote.snapshot.files, &metadata)?;
    Ok(metadata)
}
pub fn status(app_data: &Path, settings: &Value) -> Value {
    let config = match credentials::load(app_data, settings) {
        Ok(config) => config,
        Err(message) => {
            return json!({"configured":false,"ready":false,"remoteInitialized":false,"endpoint":"","remotePath":"","message":message})
        }
    };
    let mut status = json!({"configured":!config.url.is_empty(),"ready":false,"remoteInitialized":false,"endpoint":config.url,"remotePath":config.remote_path,"message":""});
    let result = (|| {
        let dav = Dav::new(config.require_ready()?)?;
        dav.probe()?;
        let remote = read_remote(&dav)?;
        if let Some(remote) = &remote {
            remote_metadata(&dav, remote)?;
        }
        status["ready"] = json!(true);
        status["remoteInitialized"] = json!(remote.is_some());
        status["fileCount"] = json!(remote.as_ref().map_or(0, |r| r.snapshot.files.len()));
        status["legacy"] = json!(remote.as_ref().is_some_and(|r| r.legacy));
        status["message"] = json!(if remote.is_some() {
            "WebDAV is ready"
        } else {
            "WebDAV is ready for its first upload"
        });
        Ok::<(), String>(())
    })();
    if let Err(message) = result {
        status["message"] = json!(message);
    }
    status
}
fn counts(root: &Path, files: &[SyncFile]) -> Value {
    json!({"syncPath":root,"games":files.iter().map(|f|f.path.split('/').next().unwrap()).collect::<BTreeSet<_>>().len(),"size":files.iter().map(|f|f.size).sum::<u64>()})
}
pub fn run(app_data: &Path, root: &Path, settings: &Value, direction: &str) -> Result<Value> {
    util::no_links(root)?;
    fs::create_dir_all(root).map_err(err)?;
    transaction::recover(root)?;
    let config = credentials::require(app_data, settings)?;
    let dav = Dav::new(config.clone())?;
    dav.probe()?;
    if direction == "upload" {
        upload(app_data, root, settings, &dav, &config)
    } else {
        download(app_data, root, settings, &dav, &config)
    }
}
fn migrate_legacy(dav: &Dav, remote: &Remote) -> Result<()> {
    if !remote.legacy {
        return Ok(());
    }
    let temp = tempfile::tempdir().map_err(err)?;
    let mut seen = BTreeSet::new();
    for file in &remote.snapshot.files {
        if !seen.insert(&file.sha256) {
            continue;
        }
        transaction::disk_space(temp.path(), file.size)?;
        let destination = temp.path().join(&file.sha256);
        dav.verify(
            &source_path(dav, remote, file),
            file.size,
            &file.sha256,
            Some(&destination),
        )?;
        let mut file = file.clone();
        file.local_path = Some(destination.clone());
        dav.ensure_object(&file)?;
        fs::remove_file(destination).map_err(err)?;
    }
    Ok(())
}
fn upload(
    app_data: &Path,
    root: &Path,
    settings: &Value,
    dav: &Dav,
    config: &Config,
) -> Result<Value> {
    util::prune(root, settings)?;
    let local = manifest::collect(root)?;
    let baseline = merge::load(app_data, root, config);
    let mut remote = read_remote(dav)?;
    let mut verified = BTreeSet::new();
    let mut uploaded = 0u64;
    let mut bytes = 0u64;
    for _attempt in 0..5 {
        if let Some(remote) = &remote {
            remote_metadata(dav, remote)?;
            migrate_legacy(dav, remote)?;
        }
        let mut merged = merge::upload(
            remote.as_ref().map_or(&[], |r| r.snapshot.files.as_slice()),
            &local,
            baseline.as_ref(),
            &config.device_id,
            remote
                .as_ref()
                .and_then(|r| r.snapshot.device_id.as_deref())
                .unwrap_or("legacy"),
        )?;
        // Conflicts preserve the remote group as a permanent, visibly named backup.
        for file in &mut merged.files {
            if let Some(device) = file
                .conflict_device
                .clone()
                .filter(|_| file.path.ends_with("/backup_info.json"))
            {
                let remote = remote.as_ref().ok_or("Missing conflict source")?;
                let (data, _) = dav
                    .read(&source_path(dav, remote, file), 1024 * 1024, false)?
                    .ok_or("Missing conflict metadata")?;
                if util::hash(&data) != file.sha256 {
                    return Err("Conflict metadata changed on the remote server".into());
                }
                let data = merge::conflict_metadata(&data, &device)?;
                file.size = data.len() as u64;
                file.sha256 = util::hash(&data);
                file.data = Some(data);
            }
        }
        // Revalidate all referenced objects before making a revision visible. Local
        // copies provide a repair source for interrupted or corrupted prior uploads.
        let sources = local
            .iter()
            .chain(&merged.upload)
            .map(|file| (&file.sha256, file))
            .collect::<BTreeMap<_, _>>();
        for file in &merged.files {
            if verified.contains(&file.sha256) {
                continue;
            }
            let source = if file.data.is_some() || file.local_path.is_some() {
                Some(file)
            } else {
                sources.get(&file.sha256).copied()
            };
            if let Some(source) = source {
                if dav.ensure_object(source)? {
                    uploaded += 1;
                    bytes += source.size;
                }
            } else {
                dav.verify(&dav.object(&file.sha256), file.size, &file.sha256, None)?;
            }
            verified.insert(file.sha256.clone());
        }
        let revision = Uuid::new_v4().to_string();
        let snapshot = Snapshot {
            version: 2,
            revision: Some(revision.clone()),
            parent_revision: remote.as_ref().and_then(|r| r.snapshot.revision.clone()),
            device_id: Some(config.device_id.clone()),
            generated_at: chrono::Utc::now().to_rfc3339(),
            files: merged.files.clone(),
        };
        let snapshot = manifest::snapshot(serde_json::to_value(snapshot).map_err(err)?, false)?;
        let payload = serde_json::to_vec_pretty(&snapshot).map_err(err)?;
        if payload.len() as u64 > MAX_MANIFEST {
            return Err("WebDAV snapshot is too large".into());
        }
        let snapshots = format!("{}/snapshots", config.remote_path);
        dav.mkdir(&snapshots)?;
        let snapshot_path = format!("{snapshots}/{revision}.json");
        if !dav.put(&snapshot_path, Source::Bytes(&payload), None)? {
            return Err("WebDAV snapshot revision collision".into());
        }
        dav.verify(
            &snapshot_path,
            payload.len() as u64,
            &util::hash(&payload),
            None,
        )?;
        let pointer = json!({"version":2,"revision":revision,"parentRevision":snapshot.parent_revision,"deviceId":config.device_id,"generatedAt":snapshot.generated_at});
        let pointer = serde_json::to_vec_pretty(&pointer).map_err(err)?;
        let etag = remote
            .as_ref()
            .map(|r| r.etag.as_str())
            .filter(|s| !s.is_empty());
        if dav.put(
            &format!("{}/current.json", config.remote_path),
            Source::Bytes(&pointer),
            etag,
        )? {
            merge::persist(
                app_data,
                root,
                config,
                merge::BaselineUpdate {
                    local: &local,
                    remote: &snapshot.files,
                    revision: Some(revision),
                    old: baseline.as_ref(),
                    deferred_local: &BTreeSet::new(),
                    deferred_remote: &merged.deferred,
                },
            )?;
            let mut result = counts(root, &local);
            result["uploadedFiles"] = json!(uploaded);
            result["uploadedBytes"] = json!(bytes);
            result["conflicts"] = json!(merged.conflicts);
            return Ok(result);
        }
        remote = read_remote(dav)?;
    }
    Err("WebDAV current snapshot changed repeatedly; retry synchronization later".into())
}
fn download(
    app_data: &Path,
    root: &Path,
    settings: &Value,
    dav: &Dav,
    config: &Config,
) -> Result<Value> {
    let remote = read_remote(dav)?.ok_or("WebDAV contains no backup snapshot")?;
    remote_metadata(dav, &remote)?;
    let local = manifest::collect(root)?;
    let baseline = merge::load(app_data, root, config);
    let classification = merge::classify(&remote.snapshot.files, &local, baseline.as_ref());
    let local_groups = merge::groups(&local);
    let remote_groups = merge::groups(&remote.snapshot.files);
    let mut reserved = local
        .iter()
        .chain(&remote.snapshot.files)
        .map(SyncFile::key)
        .collect::<BTreeSet<_>>();
    let mut plan = Vec::new();
    let mut conflicts = Vec::new();
    let remote_device = remote.snapshot.device_id.as_deref().unwrap_or("legacy");
    for (key, files) in remote_groups {
        util::no_links(&root.join(&key))?;
        let collision = !local_groups.contains_key(&key) && root.join(&key).exists();
        if !collision
            && (classification.local.contains(&key) || classification.stable.contains(&key))
        {
            continue;
        }
        if collision {
            let destination = merge::allocate(&key, &mut reserved, Some(root))?;
            plan.extend(files.iter().map(|file| {
                let mut f = file.remap(&destination);
                f.conflict_device = Some(remote_device.into());
                f
            }));
            conflicts.push(merge::conflict_record(
                &key,
                &destination,
                &config.device_id,
                remote_device,
                "download",
                true,
            ));
            continue;
        }
        if classification.conflicts.contains(&key) {
            let destination = merge::allocate(&key, &mut reserved, Some(root))?;
            for file in local_groups
                .get(&key)
                .ok_or("Missing local conflict group")?
            {
                let mut copy = file.remap(&destination);
                if file.path.ends_with("/backup_info.json") {
                    let data = fs::read(
                        file.local_path
                            .as_deref()
                            .ok_or("Missing local conflict source")?,
                    )
                    .map_err(err)?;
                    let data = merge::conflict_metadata(&data, &config.device_id)?;
                    copy.sha256 = util::hash(&data);
                    copy.size = data.len() as u64;
                    copy.data = Some(data);
                }
                plan.push(copy);
            }
            conflicts.push(merge::conflict_record(
                &key,
                &destination,
                &config.device_id,
                remote_device,
                "download",
                false,
            ));
        }
        plan.extend(files);
    }
    manifest::validate_files(&mut plan)?;
    let keys = plan.iter().map(SyncFile::key).collect::<BTreeSet<_>>();
    let bytes = plan.iter().map(|f| f.size).sum::<u64>();
    let mut tx = Transaction::begin(root, &keys, bytes)?;
    let prepared = (|| {
        let mut metadata_by_key = BTreeMap::new();
        for file in &plan {
            let path = tx.stage(&file.path)?;
            if let Some(data) = &file.data {
                fs::create_dir_all(path.parent().unwrap()).map_err(err)?;
                util::atomic_write(&path, data)?;
            } else if let Some(source) = &file.local_path {
                if util::hash_file(source)? != (file.size, file.sha256.clone()) {
                    return Err("Local conflict backup changed while staging".into());
                }
                fs::create_dir_all(path.parent().unwrap()).map_err(err)?;
                fs::copy(source, &path).map_err(err)?;
            } else {
                dav.verify(
                    &source_path(dav, &remote, file),
                    file.size,
                    &file.sha256,
                    Some(&path),
                )?;
            }
            if util::hash_file(&path)? != (file.size, file.sha256.clone()) {
                return Err("Staged backup failed integrity verification".into());
            }
            if file.path.ends_with("/backup_info.json") {
                let data = fs::read(&path).map_err(err)?;
                let data = if let Some(device) = &file.conflict_device {
                    merge::conflict_metadata(&data, device)?
                } else {
                    data
                };
                let mut metadata = manifest::metadata(serde_json::from_slice(&data).map_err(err)?)?;
                metadata["provenance"] = json!("external");
                util::atomic_json(&path, &metadata)?;
                // The content manifest stores files only. Recreate declared roots
                // even when a game had an empty save folder at backup time.
                for item in metadata["backup_paths"]
                    .as_array()
                    .ok_or("Invalid staged backup paths")?
                {
                    let folder = path
                        .parent()
                        .ok_or("Missing staged backup directory")?
                        .join(
                            item["folder_name"]
                                .as_str()
                                .ok_or("Invalid staged backup folder")?,
                        );
                    util::no_links(&folder)?;
                    fs::create_dir_all(folder).map_err(err)?;
                }
                metadata_by_key.insert(file.key(), metadata);
            }
            let seconds = (file.mtime_ms / 1000.0).floor() as i64;
            let nanos = ((file.mtime_ms % 1000.0) * 1_000_000.0) as u32;
            filetime::set_file_mtime(&path, filetime::FileTime::from_unix_time(seconds, nanos))
                .map_err(err)?;
        }
        manifest::validate_metadata_paths(&plan, &metadata_by_key)?;
        // Recollect whole groups so concurrent removals/additions are detected too.
        let current = manifest::collect(root)?;
        let fingerprints = |files: &[SyncFile], key: &str| {
            files
                .iter()
                .filter(|f| f.key() == key)
                .map(|f| (f.path.clone(), f.sha256.clone()))
                .collect::<BTreeMap<_, _>>()
        };
        for key in &keys {
            if fingerprints(&current, key) != fingerprints(&local, key)
                || (!local_groups.contains_key(key) && root.join(key).exists())
            {
                return Err(
                    "A local backup changed while downloading; retry to reconcile it safely".into(),
                );
            }
        }
        // Conflict sources retain their original key and must also stay unchanged.
        for key in &classification.conflicts {
            if fingerprints(&current, key) != fingerprints(&local, key) {
                return Err("A conflict source changed while downloading".into());
            }
        }
        Ok(())
    })();
    if let Err(error) = prepared {
        return match tx.rollback() {
            Ok(()) => Err(error),
            Err(recovery) => Err(format!(
                "{error}; staged transaction requires recovery: {recovery}"
            )),
        };
    }
    tx.install()?;
    util::prune(root, settings)?;
    let reconciled = manifest::collect(root)?;
    merge::persist(
        app_data,
        root,
        config,
        merge::BaselineUpdate {
            local: &reconciled,
            remote: &remote.snapshot.files,
            revision: remote.snapshot.revision.clone(),
            old: baseline.as_ref(),
            deferred_local: &classification.local,
            deferred_remote: &BTreeSet::new(),
        },
    )?;
    let mut result = counts(root, &reconciled);
    result["downloadedFiles"] = json!(plan.len());
    result["conflicts"] = json!(conflicts);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::super::test_server::Server;
    use super::*;
    const KEY: &str = "1/2026-08-18_10-00-00";
    fn backup(root: &Path, data: &str) {
        fs::create_dir_all(root.join(KEY).join("path1")).unwrap();
        util::atomic_json(&root.join(KEY).join("backup_info.json"),&json!({"title":"Test game","provenance":"local","backup_paths":[{"folder_name":"path1","type":"folder","template":"{{p|userprofile}}/Saves"}]})).unwrap();
        fs::write(root.join(KEY).join("path1/save.dat"), data).unwrap();
    }
    #[test]
    fn verified_upload_and_transactional_download_roundtrip() {
        let server = Server::start();
        let config = server.config();
        let dav = Dav::test_client(config.clone());
        dav.probe().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("a");
        let b = temp.path().join("b");
        backup(&a, "save bytes");
        fs::create_dir_all(a.join(KEY).join("path2")).unwrap();
        let metadata_path = a.join(KEY).join("backup_info.json");
        let mut metadata = util::read_json(&metadata_path, 1024 * 1024).unwrap();
        metadata["backup_paths"].as_array_mut().unwrap().push(json!({"folder_name":"path2","type":"folder","template":"{{p|userprofile}}/EmptyGameSaves"}));
        util::atomic_json(&metadata_path, &metadata).unwrap();
        fs::create_dir_all(&b).unwrap();
        let settings = json!({"maxBackups":5});
        server.storage.lock().unwrap().fail_pointer_once = true;
        let result = upload(&temp.path().join("app-a"), &a, &settings, &dav, &config).unwrap();
        assert_eq!(result["uploadedFiles"], 2);
        let config_b = Config {
            device_id: Uuid::new_v4().to_string(),
            ..config.clone()
        };
        download(&temp.path().join("app-b"), &b, &settings, &dav, &config_b).unwrap();
        assert_eq!(
            fs::read(b.join(KEY).join("path1/save.dat")).unwrap(),
            b"save bytes"
        );
        assert!(b.join(KEY).join("path2").is_dir());
        assert_eq!(
            util::read_json(&b.join(KEY).join("backup_info.json"), 1024 * 1024).unwrap()
                ["provenance"],
            "external"
        );
        let uploads = server
            .storage
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|(method, path, _)| method == "PUT" && path.contains("/objects/"))
            .cloned()
            .collect::<Vec<_>>();
        assert!(uploads
            .iter()
            .all(
                |(_, _, headers)| headers.get("if-none-match") == Some(&"*".into())
                    && headers.contains_key("content-length")
            ));
    }
    #[test]
    fn remote_only_change_replaces_whole_tree_and_conflict_preserves_local() {
        let server = Server::start();
        let config = server.config();
        let dav = Dav::test_client(config.clone());
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("a");
        let b = temp.path().join("b");
        let app_a = temp.path().join("app-a");
        let app_b = temp.path().join("app-b");
        backup(&a, "base");
        fs::write(a.join(KEY).join("path1/stale.dat"), "stale").unwrap();
        fs::create_dir_all(&b).unwrap();
        let settings = json!({"maxBackups":1});
        let config_b = Config {
            device_id: Uuid::new_v4().to_string(),
            ..config.clone()
        };
        upload(&app_a, &a, &settings, &dav, &config).unwrap();
        download(&app_b, &b, &settings, &dav, &config_b).unwrap();
        fs::remove_file(a.join(KEY).join("path1/stale.dat")).unwrap();
        fs::write(a.join(KEY).join("path1/save.dat"), "remote update").unwrap();
        upload(&app_a, &a, &settings, &dav, &config).unwrap();
        let result = download(&app_b, &b, &settings, &dav, &config_b).unwrap();
        assert!(result["conflicts"].as_array().unwrap().is_empty());
        assert!(!b.join(KEY).join("path1/stale.dat").exists());
        fs::write(a.join(KEY).join("path1/save.dat"), "remote conflict").unwrap();
        fs::write(b.join(KEY).join("path1/save.dat"), "local conflict").unwrap();
        upload(&app_a, &a, &settings, &dav, &config).unwrap();
        let result = download(&app_b, &b, &settings, &dav, &config_b).unwrap();
        assert_eq!(result["conflicts"].as_array().unwrap().len(), 1);
        let conflict = result["conflicts"][0]["conflictBackup"].as_str().unwrap();
        assert_eq!(
            fs::read(b.join(conflict).join("path1/save.dat")).unwrap(),
            b"local conflict"
        );
        assert_eq!(
            fs::read(b.join(KEY).join("path1/save.dat")).unwrap(),
            b"remote conflict"
        );
        assert_eq!(
            util::read_json(&b.join(conflict).join("backup_info.json"), 1024 * 1024).unwrap()
                ["is_permanent"],
            true
        );
    }
    #[test]
    fn corrupt_content_object_is_repaired_conditionally_from_verified_source() {
        let server = Server::start();
        let config = server.config();
        let dav = Dav::test_client(config.clone());
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("backups");
        backup(&root, "correct");
        let file = manifest::collect(&root)
            .unwrap()
            .into_iter()
            .find(|f| f.path.ends_with("save.dat"))
            .unwrap();
        let path = dav.object(&file.sha256);
        server
            .storage
            .lock()
            .unwrap()
            .files
            .insert(path.clone(), b"corrupt".to_vec());
        dav.ensure_object(&file).unwrap();
        assert_eq!(server.storage.lock().unwrap().files[&path], b"correct");
        assert!(server
            .storage
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|(method, p, headers)| method == "PUT"
                && p == &path
                && headers.contains_key("if-match")));
    }
    #[test]
    fn rejected_download_leaves_all_existing_backups_intact() {
        let server = Server::start();
        let config = server.config();
        let dav = Dav::test_client(config.clone());
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("a");
        let b = temp.path().join("b");
        backup(&a, "remote");
        backup(&b, "local");
        let settings = json!({});
        upload(&temp.path().join("app-a"), &a, &settings, &dav, &config).unwrap();
        let remote = read_remote(&dav).unwrap().unwrap();
        let file = remote
            .snapshot
            .files
            .iter()
            .find(|f| f.path.ends_with("save.dat"))
            .unwrap();
        server
            .storage
            .lock()
            .unwrap()
            .files
            .insert(dav.object(&file.sha256), b"corrupt and oversized".to_vec());
        assert!(download(&temp.path().join("app-b"), &b, &settings, &dav, &config).is_err());
        assert_eq!(
            fs::read(b.join(KEY).join("path1/save.dat")).unwrap(),
            b"local"
        );
        transaction::recover(&b).unwrap();
    }
}
