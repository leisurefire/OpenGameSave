//! Save domain: trusted catalog discovery, immutable snapshots, transactional
//! restoration, archive interchange, and verified database publication updates.
//! Tauri is confined to this command adapter; the domain modules use plain Rust.
pub mod archive;
pub mod authorization;
pub mod backup;
pub mod database;
pub mod fs;
pub mod metadata;
pub mod registry;
pub mod resolver;
pub mod restore;
pub mod update;

#[cfg(test)]
mod tests;

use crate::state::AppState;
use fs::Result;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
fn arg(args: &[Value], index: usize) -> Value {
    args.get(index).cloned().unwrap_or(Value::Null)
}
fn string(args: &[Value], index: usize) -> Result<&str> {
    args.get(index)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Missing argument {index}"))
}
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f).await.map_err(fs::err)?
}
fn report(ctx: &AppState, result: &Value) {
    if result["errors"].as_array().is_some_and(|a| !a.is_empty()) {
        ctx.emit(
            "show-alert",
            json!([
                "modal",
                ctx.translate("alert.backup_process_error_display", Value::Null),
                result["errors"]
            ]),
        );
    }
}
fn alert(ctx: &AppState, kind: &str, key: &str, details: Value) {
    ctx.emit(
        "show-alert",
        json!([kind, ctx.translate(key, Value::Null), details]),
    );
}
struct Progress {
    ctx: AppState,
    id: String,
    title: String,
}
impl Progress {
    fn new(ctx: &AppState, id: &str, key: &str) -> Self {
        let title = ctx.translate(key, Value::Null);
        ctx.emit("update-progress", json!([id, title, "start"]));
        Self {
            ctx: ctx.clone(),
            id: id.into(),
            title,
        }
    }
    fn value(&self, value: u64) {
        self.ctx
            .emit("update-progress", json!([self.id, self.title, value]));
    }
}
impl Drop for Progress {
    fn drop(&mut self) {
        self.ctx
            .emit("update-progress", json!([self.id, self.title, "end"]));
    }
}
pub async fn dispatch(ctx: &AppState, channel: &str, args: Vec<Value>) -> Result<Value> {
    let settings = ctx.settings();
    let db = ctx.database_path.clone();
    match channel {
        "fetch-backup-table-data"
        | "get-local-save-data"
        | "start-scan-full"
        | "get-table-view-model" => {
            let full = channel == "start-scan-full";
            let view = channel == "get-table-view-model";
            let restore_view = view && arg(&args, 0) == "restore";
            if view && arg(&args, 0) != "restore" && arg(&args, 0) != "backup" {
                return Err("Unknown table view model".into());
            }
            let id_value = if view {
                arg(&args, 1)["wikiId"].clone()
            } else if channel == "fetch-backup-table-data" {
                arg(&args, 1)
            } else if channel == "get-local-save-data" {
                arg(&args, 0)
            } else {
                Value::Null
            };
            let id = if id_value.is_null() {
                None
            } else {
                Some(metadata::wiki(&id_value)?)
            };
            let ignore = if view {
                arg(&args, 1)["ignoreUninstalled"] == true
            } else {
                arg(&args, 0) == true
            };
            let progress = if full {
                Some(Progress::new(ctx, "scan-full", "alert.scanning_full"))
            } else {
                None
            };
            let cancellation = ctx.shutting_down.clone();
            let result = blocking(move || {
                if restore_view {
                    let root = metadata::root(&settings)?;
                    backup::list(&root, id.as_deref())
                } else {
                    database::scan_with_context(
                        &settings,
                        &db,
                        &crate::library::game_data(),
                        (id.as_deref(), full, ignore),
                        |n| {
                            if let Some(p) = &progress {
                                p.value(n);
                            }
                        },
                        &mut fs::ScanContext::with_cancellation(cancellation),
                    )
                }
            })
            .await?;
            report(ctx, &result);
            if full {
                alert(ctx, "success", "alert.scan_full_complete", Value::Null);
            }
            if channel == "get-local-save-data" {
                return Ok(result["games"]
                    .as_array()
                    .and_then(|g| g.first())
                    .cloned()
                    .unwrap_or(Value::Null));
            }
            if view {
                Ok(
                    json!({"games":result["games"],"settings":ctx.settings(),"autoBackupState":crate::automatic::snapshot(ctx),"iconMap":if restore_view{Value::Null}else{crate::icons()}}),
                )
            } else {
                Ok(result["games"].clone())
            }
        }
        "fetch-restore-table-data" => {
            let id = if arg(&args, 0).is_null() {
                None
            } else {
                Some(metadata::wiki(&arg(&args, 0))?)
            };
            let result =
                blocking(move || backup::list(&metadata::root(&settings)?, id.as_deref())).await?;
            report(ctx, &result);
            Ok(result["games"].clone())
        }
        "backup-game" => {
            let id = metadata::wiki(&arg(&args, 0)["wiki_page_id"])?;
            match blocking(move || {
                backup::create(&settings, &db, &crate::library::game_data(), &id)
            })
            .await
            {
                Ok(_) => Ok(Value::Null),
                Err(e) => Ok(json!(e)),
            }
        }
        "restore-game" => {
            let game = arg(&args, 0);
            let id = metadata::wiki(&game["wiki_page_id"])?;
            let when = game["backups"][0]["date"]
                .as_str()
                .map(metadata::date)
                .transpose()?;
            let mut action = match arg(&args, 1).as_str() {
                Some("replace") => Some("replace".to_string()),
                Some("skip") => Some("skip".to_string()),
                _ => None,
            };
            let settings_for_plan = settings.clone();
            let db_for_plan = db.clone();
            let id_for_plan = id.clone();
            let when_for_plan = when.clone();
            let plan = match blocking(move || {
                restore::plan(
                    &settings_for_plan,
                    &db_for_plan,
                    &crate::library::game_data(),
                    &id_for_plan,
                    when_for_plan.as_deref(),
                )
            })
            .await
            {
                Ok(p) => p,
                Err(e) => return Ok(json!({"action":action,"error":e})),
            };
            if plan.destination_time > plan.source_time {
                if action.is_none() {
                    let response=ctx.dialog(json!({"title":ctx.translate("alert.save_conflict",Value::Null),"content":format!("{}\n\n{}",ctx.translate("alert.save_conflict_detected",json!({"game":plan.title})),ctx.translate("alert.overwrite_prompt",Value::Null)),"iconType":"warning","buttons":[{"value":"skip","text":ctx.translate("alert.no",Value::Null)},{"value":"replace","text":ctx.translate("alert.yes",Value::Null),"primary":true}],"closeValue":"skip","checkbox":{"label":ctx.translate("alert.do_this_for_all",Value::Null)}})).await?;
                    let chosen = if response["value"] == "replace" {
                        "replace"
                    } else {
                        "skip"
                    };
                    if response["checked"] == true {
                        action = Some(chosen.into());
                    }
                    if chosen == "skip" {
                        return Ok(
                            json!({"action":action,"error":ctx.translate("alert.manually_skipped",Value::Null)}),
                        );
                    }
                } else if action.as_deref() == Some("skip") {
                    return Ok(
                        json!({"action":action,"error":ctx.translate("alert.manually_skipped",Value::Null)}),
                    );
                }
            }
            let result = blocking(move || {
                let root = metadata::root(&settings)?;
                let fresh = restore::plan(
                    &settings,
                    &db,
                    &crate::library::game_data(),
                    &id,
                    when.as_deref(),
                )?;
                restore::execute(&fresh, &root)
            })
            .await;
            Ok(json!({"action":action,"error":result.err()}))
        }
        "delete-backup" | "update-backup-info" => {
            let id = arg(&args, 0);
            let when = string(&args, 1)?.to_owned();
            let channel = channel.to_owned();
            let key = arg(&args, 2).as_str().unwrap_or("").to_owned();
            let value = arg(&args, 3);
            let result = blocking(move || {
                let root = metadata::root(&settings)?;
                if channel == "delete-backup" {
                    backup::delete(&root, &id, &when)
                } else {
                    backup::update(&root, &id, &when, &key, &value)
                }
            })
            .await;
            match result {
                Ok(v) => Ok(json!(v)),
                Err(e) => {
                    ctx.emit("show-alert", json!(["error", e]));
                    Ok(json!(false))
                }
            }
        }
        "delete-local-save" => {
            let id = metadata::wiki(&arg(&args, 0))?;
            match blocking(move || {
                restore::delete_local(&settings, &db, &crate::library::game_data(), &id)
            })
            .await
            {
                Ok(v) => Ok(json!(v)),
                Err(e) => {
                    ctx.emit("show-alert", json!(["error", e]));
                    Ok(json!(false))
                }
            }
        }
        "open-backup-folder" => {
            let id = arg(&args, 0);
            let path = blocking(move || {
                let root = metadata::root(&settings)?;
                let path = metadata::snapshot(&root, &id, None)?;
                Ok((path.exists() && fs::regular(&path)?.is_dir()).then_some(path))
            })
            .await?;
            if let Some(path) = path {
                crate::platform::open_path(&path)?;
            } else {
                alert(ctx, "warning", "alert.no_backups_found", Value::Null);
            }
            Ok(Value::Null)
        }
        "browse-local-save" => {
            let id = metadata::wiki(&arg(&args, 0))?;
            let indexes = arg(&args, 1);
            let paths = blocking(move || {
                let mut game = database::definition(&db, &id, &settings)?;
                database::process(&mut game, &settings, &crate::library::game_data())?;
                Ok(game["resolved_paths"].clone())
            })
            .await?;
            let paths = paths.as_array().ok_or("No local save paths")?;
            let selected: Vec<usize> = if indexes.is_null() {
                (0..paths.len()).collect()
            } else {
                let values = indexes.as_array().ok_or("Invalid selected save paths")?;
                if values.is_empty() || values.len() > 128 {
                    return Err("Invalid selection count".into());
                }
                values
                    .iter()
                    .map(|v| {
                        v.as_u64()
                            .map(|i| i as usize)
                            .filter(|i| *i < paths.len())
                            .ok_or_else(|| "Invalid local save index".to_string())
                    })
                    .collect::<Result<_>>()?
            };
            let mut opened = std::collections::HashSet::new();
            for index in selected {
                let p = &paths[index];
                let source = p["resolved"].as_str().ok_or("Invalid local save path")?;
                if p["type"] == "reg" {
                    registry::normalize(source)?;
                    registry::command(&["add","HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Applets\\Regedit","/v","LastKey","/t","REG_SZ","/d",source,"/f"])?;
                    let mut command = std::process::Command::new("regedit.exe");
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        command.creation_flags(0x08000000);
                    }
                    command.spawn().map_err(fs::err)?;
                } else {
                    let path = Path::new(source);
                    let target = if fs::regular(path)?.is_dir() {
                        path
                    } else {
                        path.parent().ok_or("Invalid file parent")?
                    };
                    if opened.insert(fs::key(target)) {
                        crate::platform::open_path(target)?;
                    }
                }
            }
            Ok(Value::Null)
        }
        "export-backups" => {
            let count = arg(&args, 0).as_u64().ok_or("Invalid export count")?;
            let dest = PathBuf::from(string(&args, 1)?);
            let ids = arg(&args, 2);
            let progress = Progress::new(ctx, "export", "alert.exporting");
            let result = blocking(move || {
                let root = metadata::root(&settings)?;
                archive::export(
                    &root,
                    &dest,
                    count,
                    ids.as_array().map(Vec::as_slice),
                    |n| progress.value(n),
                )
            })
            .await;
            match result {
                Ok(path) => {
                    alert(ctx, "success", "alert.export_success", Value::Null);
                    Ok(json!(path))
                }
                Err(e) => {
                    alert(ctx, "modal", "alert.error_during_export", json!(e));
                    Err(e)
                }
            }
        }
        "import-backups" => {
            let path = PathBuf::from(string(&args, 0)?);
            let progress = Progress::new(ctx, "import", "alert.importing");
            let result = blocking(move || {
                archive::import(&metadata::root(&settings)?, &path, |n| progress.value(n))
            })
            .await;
            ctx.emit("update-backup-table", json!([]));
            ctx.emit("update-restore-table", json!([]));
            match result {
                Ok(value) => {
                    alert(ctx, "success", "alert.import_success", Value::Null);
                    Ok(value)
                }
                Err(e) => {
                    alert(ctx, "modal", "alert.error_during_import", json!(e));
                    Err(e)
                }
            }
        }
        "migrate-backups" => {
            let source = blocking(move || metadata::root(&settings)).await?;
            let cleanup_source = source.clone();
            let destination = PathBuf::from(string(&args, 0)?);
            let state = ctx.clone();
            let progress = Progress::new(ctx, "migrate-backups", "alert.migrate_backups");
            let result = blocking(move || {
                archive::migrate(
                    &source,
                    &destination,
                    |n| progress.value(n),
                    || state.save_settings(json!({"backupPath":destination})),
                )
            })
            .await;
            match result {
                Ok(v) => {
                    if cleanup_source.exists() {
                        ctx.emit(
                            "show-alert",
                            json!([
                                "warning",
                                ctx.translate(
                                    "alert.backup_migration_cleanup_warning",
                                    json!({"path":cleanup_source})
                                ),
                                Value::Null
                            ]),
                        );
                    } else {
                        alert(
                            ctx,
                            "success",
                            "alert.backup_migration_success",
                            Value::Null,
                        );
                    }
                    Ok(json!(v))
                }
                Err(e) => {
                    alert(
                        ctx,
                        "modal",
                        "alert.error_during_backup_migration",
                        json!(e),
                    );
                    Ok(json!(false))
                }
            }
        }
        "update-database" => {
            let progress = Progress::new(ctx, "update-db", "alert.updating_database");
            match blocking(move || update::update(&settings, &db, |n| progress.value(n))).await {
                Ok(result) => {
                    if result["alreadyLatest"] != true {
                        alert(ctx, "success", "alert.update_db_success", Value::Null);
                        ctx.emit("update-backup-table", json!([]));
                    }
                    Ok(result)
                }
                Err(e) => {
                    alert(ctx, "modal", "alert.error_during_db_update", json!(e));
                    Ok(json!({"success":false,"error":e}))
                }
            }
        }
        _ => Err(format!("Unknown save command: {channel}")),
    }
}
