use crate::state::AppState;
use notify::{RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub fn snapshot(state: &AppState) -> Value {
    let settings = state.settings();
    let active = state.auto_backup.lock().unwrap();
    let logs = state.auto_logs.lock().unwrap();
    let mut result = json!({});
    for id in active.keys() {
        let entries = logs[id].as_array();
        result[id] = json!({"mode":settings["autoBackupGames"][id]["mode"],"intervalMinutes":settings["autoBackupGames"][id]["intervalMinutes"],
            "logCount":entries.map(Vec::len).unwrap_or(0),"failCount":entries.map(|a|a.iter().filter(|e|e["success"]==false).count()).unwrap_or(0)});
    }
    result
}

async fn watch_paths(state: &AppState, id: &str) -> Result<Vec<PathBuf>, String> {
    let state = state.clone();
    let id = id.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let scan = crate::saves::database::scan(
            &state.settings(),
            &state.database_path,
            Some(&id),
            false,
            false,
            |_| {},
        )?;
        Ok(scan["games"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|g| g["resolved_paths"].as_array().into_iter().flatten())
            .filter(|p| p["type"] != "reg")
            .filter_map(|p| p["resolved"].as_str())
            .map(PathBuf::from)
            .collect::<Vec<_>>())
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn start(
    state: &AppState,
    id: String,
    mode: &str,
    interval: Value,
    persist: bool,
) -> Result<(), String> {
    if state.shutting_down.load(Ordering::SeqCst) {
        return Err("Application is shutting down".into());
    }
    if !matches!(mode, "interval" | "watcher") {
        return Err("Invalid automatic backup mode".into());
    }
    let minutes = if mode == "interval" {
        interval
            .as_u64()
            .filter(|n| (1..=1440).contains(n))
            .ok_or("Invalid backup interval")?
    } else {
        0
    };
    if state.auto_backup.lock().unwrap().len() >= 1000 {
        return Err("Too many automatic backups".into());
    }
    let dirty = Arc::new(AtomicBool::new(false));
    let mut watcher = None;
    if mode == "watcher" {
        let paths = watch_paths(state, &id).await?;
        if paths.is_empty() {
            return Err(state.translate("alert.auto_backup_game_not_found", Value::Null));
        }
        let dirty = dirty.clone();
        let mut native =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result {
                    if !matches!(event.kind, notify::EventKind::Access(_)) {
                        dirty.store(true, Ordering::SeqCst);
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        for path in paths {
            native
                .watch(&path, RecursiveMode::Recursive)
                .map_err(|e| e.to_string())?;
        }
        watcher = Some(native);
    }
    if persist {
        let mut configs = state.settings()["autoBackupGames"].clone();
        configs[&id] = json!({"mode":mode,"intervalMinutes":if mode=="interval" {json!(minutes)}else{Value::Null}});
        state
            .save_settings_async(json!({"autoBackupGames":configs}))
            .await?;
    }
    let stopped = Arc::new(AtomicBool::new(false));
    if let Some(old) = state
        .auto_backup
        .lock()
        .unwrap()
        .insert(id.clone(), stopped.clone())
    {
        old.store(true, Ordering::SeqCst);
    }
    state.auto_logs.lock().unwrap()[&id] = json!([]);
    state.emit("auto-backup-started", json!([id, mode]));
    let state = state.clone();
    let mode = mode.to_owned();
    tauri::async_runtime::spawn(async move {
        let _watcher = watcher;
        let period = Duration::from_secs((minutes * 60).max(1));
        let mut next = Instant::now() + period;
        let mut changed_at = None;
        let mut cooldown = Instant::now();
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if stopped.load(Ordering::SeqCst) || state.shutting_down.load(Ordering::SeqCst) {
                break;
            }
            if dirty.swap(false, Ordering::SeqCst) {
                changed_at = Some(Instant::now());
            }
            let due = if mode == "interval" {
                Instant::now() >= next
            } else {
                changed_at
                    .map(|t: Instant| {
                        t.elapsed() >= Duration::from_secs(2) && Instant::now() >= cooldown
                    })
                    .unwrap_or(false)
            };
            if !due {
                continue;
            }
            let _guard = state.operation.lock().await;
            if stopped.load(Ordering::SeqCst) || state.shutting_down.load(Ordering::SeqCst) {
                break;
            }
            state.set_status("backuping", true);
            let work_state = state.clone();
            let work_id = id.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                crate::saves::backup::create(
                    &work_state.settings(),
                    &work_state.database_path,
                    &crate::library::game_data(),
                    &work_id,
                )
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r);
            state.set_status("backuping", false);
            let error = result.as_ref().err().cloned();
            let log = json!({"timestamp":chrono::Local::now().format("%Y/%m/%d %H:%M:%S").to_string(),"success":error.is_none(),"error":error});
            if !stopped.load(Ordering::SeqCst) {
                {
                    let mut logs = state.auto_logs.lock().unwrap();
                    if let Some(entries) = logs[&id].as_array_mut() {
                        entries.push(log);
                        if entries.len() > 1000 {
                            entries.remove(0);
                        }
                    }
                }
                state.emit("auto-backup-performed", json!([id]));
                if let Some(error) = error {
                    state.emit("show-alert", json!(["error", error]));
                }
            }
            changed_at = None;
            next = Instant::now() + period;
            cooldown = Instant::now() + Duration::from_secs(30);
        }
    });
    Ok(())
}

pub async fn dispatch(state: &AppState, channel: &str, args: Vec<Value>) -> Result<Value, String> {
    if channel == "get-auto-backup-state" {
        return Ok(snapshot(state));
    }
    state.ensure_game_data().await?;
    let id = crate::settings::wiki_id(args.first().unwrap_or(&Value::Null))?;
    if channel == "start-auto-backup" {
        start(
            state,
            id,
            args.get(1)
                .and_then(Value::as_str)
                .ok_or("Missing backup mode")?,
            args.get(2).cloned().unwrap_or(Value::Null),
            true,
        )
        .await?;
        Ok(Value::Null)
    } else if channel == "stop-auto-backup" {
        let mut configs = state.settings()["autoBackupGames"].clone();
        if let Some(configs) = configs.as_object_mut() {
            configs.remove(&id);
        }
        state
            .save_settings_async(json!({"autoBackupGames":configs}))
            .await?;
        if let Some(flag) = state.auto_backup.lock().unwrap().remove(&id) {
            flag.store(true, Ordering::SeqCst);
        }
        let logs = state
            .auto_logs
            .lock()
            .unwrap()
            .as_object_mut()
            .and_then(|logs| logs.remove(&id))
            .unwrap_or(json!([]));
        state.emit("auto-backup-stopped", json!([id]));
        Ok(logs)
    } else {
        Err("Unknown automatic backup command".into())
    }
}

pub async fn restore(state: &AppState) -> Result<(), String> {
    state.ensure_game_data().await?;
    let _operation = state.operation.lock().await;
    if state.shutting_down.load(Ordering::SeqCst) {
        return Ok(());
    }
    let settings = state.settings();
    if let Some(configs) = settings["autoBackupGames"].as_object() {
        for (id, config) in configs {
            if state.auto_backup.lock().unwrap().contains_key(id) {
                continue;
            }
            if let Err(error) = start(
                state,
                id.clone(),
                config["mode"].as_str().unwrap_or(""),
                config["intervalMinutes"].clone(),
                false,
            )
            .await
            {
                state.emit("show-alert", json!(["error", error]));
            }
        }
    }
    Ok(())
}

pub async fn refresh_watchers(state: &AppState) -> Vec<Value> {
    // Scope changes and start/stop share the same serialization boundary. A
    // slow rescan must never resurrect a watcher after the user stopped it.
    let _operation = state.operation.lock().await;
    if state.shutting_down.load(Ordering::SeqCst) {
        return vec![];
    }
    let settings = state.settings();
    let mut failures = vec![];
    if let Some(configs) = settings["autoBackupGames"].as_object() {
        for (id, config) in configs {
            if config["mode"] != "watcher" {
                continue;
            }
            // Retire the old scope before resolving a changed account or install root.
            if let Some(flag) = state.auto_backup.lock().unwrap().remove(id) {
                flag.store(true, Ordering::SeqCst);
            }
            if let Err(error) = start(state, id.clone(), "watcher", Value::Null, false).await {
                failures.push(json!({"wikiId":id,"error":error}));
            }
        }
    }
    failures
}

/// The restore command already owns the operation lock. Windows directory
/// notifications follow the old handle across a rename, so bind to the newly
/// installed save directory before another backup/stop command can proceed.
pub async fn refresh_restored_game(state: &AppState, id: &str) {
    if state.shutting_down.load(Ordering::SeqCst)
        || state.settings()["autoBackupGames"][id]["mode"] != "watcher"
    {
        return;
    }
    let previous = state.auto_backup.lock().unwrap().remove(id);
    let Some(previous) = previous else {
        return;
    };
    previous.store(true, Ordering::SeqCst);
    let logs = state.auto_logs.lock().unwrap()[id].clone();
    match start(state, id.to_owned(), "watcher", Value::Null, false).await {
        Ok(()) => {
            state.auto_logs.lock().unwrap()[id] = logs;
        }
        Err(error) => {
            state.emit("auto-backup-stopped", json!([id]));
            state.emit("show-alert", json!(["error", error]));
        }
    }
}
