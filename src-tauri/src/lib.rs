mod automatic;
pub mod library;
mod logging;
pub mod platform;
mod policy;
pub mod saves;
mod settings;
pub mod state;
pub mod sync;
mod updates;
mod windows;

use serde_json::{json, Value};
use state::AppState;
use std::{path::PathBuf, sync::atomic::Ordering};
use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
async fn get_window_context(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let context = windows::context(&state, &window)?;
    Ok(json!({"role":context.role,"language":state.settings()["language"]}))
}

#[tauri::command]
async fn renderer_ready(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    windows::context(&state, &window)?;
    windows::ready(&state, &window)?;
    if window.label() == "main" {
        let menu_state = state.inner().clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = windows::prepare_menu(&menu_state).await {
                crate::logging::error(&menu_state.app_data, &format!("Menu prewarm: {error}"));
            }
        });
        let state = state.inner().clone();
        tauri::async_runtime::spawn(async move {
            if state.shutting_down.load(Ordering::SeqCst) {
                return;
            }
            if let Err(error) = automatic::restore(&state).await {
                state.emit("show-alert", json!(["error", error]));
            }
            if state.shutting_down.load(Ordering::SeqCst) {
                return;
            }
            if state.settings()["autoAppUpdate"] == true {
                let _ = updates::check(&state).await;
            }
            if state.shutting_down.load(Ordering::SeqCst) {
                return;
            }
            if state.settings()["autoDbUpdate"] == true {
                let _guard = state.operation.lock().await;
                if state.shutting_down.load(Ordering::SeqCst) {
                    return;
                }
                if let Err(error) = saves::dispatch(&state, "update-database", vec![]).await {
                    state.emit("show-alert", json!(["error", error]));
                }
            }
            for arg in std::env::args()
                .skip(1)
                .filter(|arg| arg.to_lowercase().ends_with(".gsmr"))
            {
                state.emit_to("main", "open-import-modal", json!([arg]));
            }
        });
    }
    Ok(())
}

fn argument(args: &[Value], index: usize) -> Value {
    args.get(index).cloned().unwrap_or(Value::Null)
}
fn string_arg(args: &[Value], index: usize) -> Result<&str, String> {
    args.get(index)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Missing argument {index}"))
}

async fn select_path(state: &AppState, kind: &str) -> Result<Value, String> {
    if kind == "registry" {
        return Ok(Value::Null);
    }
    if !matches!(kind, "file" | "folder" | "gsmr" | "backup" | "directories") {
        return Err("Invalid path selection".into());
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    let dialog = state.app.dialog().file();
    if kind == "file" || kind == "gsmr" {
        let dialog = if kind == "gsmr" {
            dialog.add_filter("OpenGameSave archive", &["gsmr"])
        } else {
            dialog
        };
        dialog.pick_file(move |p| {
            let _ = tx.send(p);
        });
    } else {
        dialog.pick_folder(move |p| {
            let _ = tx.send(p);
        });
    }
    let path = rx
        .await
        .map_err(|_| "Dialog cancelled")?
        .map(|p| p.into_path())
        .transpose()
        .map_err(|e| e.to_string())?;
    let path = path.map(|p| {
        if kind == "backup" && p.parent().is_none() {
            p.join("OGS Backups")
        } else {
            p
        }
    });
    if kind == "directories" {
        Ok(json!({"canceled":path.is_none(),"filePaths":path.into_iter().collect::<Vec<_>>() }))
    } else {
        Ok(json!(path))
    }
}

#[tauri::command]
async fn dispatch(
    window: WebviewWindow,
    state: State<'_, AppState>,
    channel: String,
    args: Vec<Value>,
    direction: String,
) -> Result<Value, String> {
    let context = windows::context(&state, &window)?;
    if !matches!(direction.as_str(), "invoke" | "send")
        || !policy::allowed(&context.role, &direction, &channel)
    {
        return Err("Command denied for this window".into());
    }
    if args.len() > 16
        || serde_json::to_vec(&args).map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024
    {
        return Err("Command payload too large".into());
    }
    if state.shutting_down.load(Ordering::SeqCst) {
        return Err("Application is shutting down".into());
    }
    let status = match channel.as_str() {
        "backup-game" => Some("backuping"),
        "restore-game" => Some("restoring"),
        "migrate-backups" => Some("migrating"),
        "export-backups" => Some("exporting"),
        "import-backups" => Some("importing"),
        "update-database" => Some("updating_db"),
        "sync-provider-run" => Some("syncing"),
        "start-scan-full" => Some("scanning_full"),
        _ => None,
    };
    let exclusive = status.is_some()
        || matches!(
            channel.as_str(),
            "delete-backup"
                | "update-backup-info"
                | "delete-local-save"
                | "start-auto-backup"
                | "stop-auto-backup"
        );
    let _operation = if exclusive {
        Some(state.operation.lock().await)
    } else {
        None
    };
    if state.shutting_down.load(Ordering::SeqCst) {
        return Err("Application is shutting down".into());
    }
    if let Some(status) = status {
        state.set_status(status, true);
    }
    let restored_game = if channel == "restore-game" {
        args.first()
            .and_then(|game| settings::wiki_id(&game["wiki_page_id"]).ok())
    } else {
        None
    };
    let result = route(&state, &window, &context, &channel, args).await;
    if result
        .as_ref()
        .ok()
        .is_some_and(|value| value.get("error") == Some(&Value::Null))
    {
        if let Some(id) = restored_game {
            automatic::refresh_restored_game(&state, &id).await;
        }
    }
    if let Err(error) = &result {
        logging::error(&state.app_data, &format!("{channel}: {error}"));
    }
    if let Some(status) = status {
        state.set_status(status, false);
    }
    if direction == "send" {
        if let Err(error) = &result {
            state.emit("show-alert", json!(["error", error]));
        }
    }
    result
}

async fn route(
    state: &AppState,
    window: &WebviewWindow,
    context: &state::WindowContext,
    channel: &str,
    args: Vec<Value>,
) -> Result<Value, String> {
    match channel {
        "translate" => Ok(json!(
            state.translate(string_arg(&args, 0)?, argument(&args, 1))
        )),
        "get-window-accent-color" => Ok(json!(state.accent())),
        "apply-accent-color-setting" => {
            state.emit("accent-color-changed", json!([state.accent()]));
            Ok(Value::Null)
        }
        "get-settings" => Ok(policy::settings_for_role(&context.role, state.settings())),
        "save-settings" => {
            let updates = if args.first().map(Value::is_object).unwrap_or(false) {
                argument(&args, 0)
            } else {
                json!({string_arg(&args,0)?:argument(&args,1)})
            };
            if !policy::settings_update_allowed(&context.role, &updates) {
                return Err("Settings change denied for this window".into());
            }
            let before = state.settings();
            let changed: Vec<String> = updates
                .as_object()
                .unwrap()
                .iter()
                .filter(|(k, v)| before[*k] != **v)
                .map(|(k, _)| k.clone())
                .collect();
            state.save_settings_async(updates).await?;
            let failures = if changed
                .iter()
                .any(|k| k == "backupAllAccounts" || k == "gameInstalls")
            {
                automatic::refresh_watchers(state).await
            } else {
                vec![]
            };
            Ok(json!({"success":true,"changedKeys":changed,"watcherFailures":failures}))
        }
        "change-language" => {
            state
                .save_settings_async(json!({"language":argument(&args,0)}))
                .await?;
            Ok(state.settings()["language"].clone())
        }
        "get-status" => Ok(state.status()),
        "update-status" => {
            let key = string_arg(&args, 0)?;
            // Renderers own display-loading flags only. Domain operation flags are Rust-owned.
            if matches!(key, "updating_backup" | "updating_restore") {
                state.set_status(key, argument(&args, 1).as_bool().ok_or("Invalid status")?);
            }
            Ok(Value::Null)
        }
        "get-modal-window-data" => Ok(context.data.clone()),
        "open-settings-window" | "open-about-window" | "view-account-ids" | "scan-full" => {
            let role = match channel {
                "open-settings-window" => "settings",
                "open-about-window" => "about",
                "view-account-ids" => "account",
                _ => "scan-full",
            };
            windows::create(state, role, json!({}))?;
            Ok(Value::Null)
        }
        "open-modal-window" => {
            let role = string_arg(&args, 0)?;
            if !matches!(
                role,
                "export"
                    | "import"
                    | "account"
                    | "auto-backup"
                    | "manage-backups"
                    | "local-save"
                    | "scan-full"
            ) {
                return Err("Invalid public modal".into());
            }
            windows::create(state, role, argument(&args, 1))?;
            Ok(Value::Null)
        }
        "close-current-modal-window" => {
            window.close().map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "resize-current-modal-window" => {
            let current_width = window
                .inner_size()
                .map_err(|e| e.to_string())?
                .to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?)
                .width;
            let width = argument(&args, 0)
                .as_f64()
                .unwrap_or(current_width)
                .clamp(320., 1600.);
            let height = argument(&args, 1)
                .as_f64()
                .unwrap_or(300.)
                .clamp(150., 1200.);
            window
                .set_size(tauri::LogicalSize::new(width, height))
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "show-main-alert" => {
            state.emit_to("main", "show-alert", json!(args));
            Ok(Value::Null)
        }
        "show-confirm-modal-window" => state.confirm(argument(&args, 0)).await,
        "show-dialog-modal-window" => state.dialog(argument(&args, 0)).await,
        "modal-window-confirm-response"
        | "modal-window-dialog-response"
        | "selected-wiki-ids-response" => {
            windows::respond(state, window, string_arg(&args, 0)?, argument(&args, 1))?;
            Ok(Value::Null)
        }
        "get-main-selected-wiki-ids" => {
            let table = string_arg(&args, 0)?;
            if !matches!(table, "backup" | "restore") {
                return Err("Invalid table".into());
            }
            let id = uuid::Uuid::new_v4().to_string();
            let (tx, rx) = tokio::sync::oneshot::channel();
            state.pending.lock().unwrap().insert(
                id.clone(),
                state::PendingResponse {
                    window: "main".into(),
                    sender: tx,
                },
            );
            state.emit_to("main", "collect-selected-wiki-ids", json!([id, table]));
            let value = tokio::time::timeout(std::time::Duration::from_secs(3), rx)
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or(json!([]));
            state.pending.lock().unwrap().remove(&id);
            Ok(json!(value
                .as_array()
                .map(|a| a
                    .iter()
                    .take(10000)
                    .filter_map(|id| settings::wiki_id(id).ok())
                    .collect::<Vec<_>>())
                .unwrap_or_default()))
        }
        "show-popup-menu" => {
            let _menu = state.menu_requests.lock().await;
            windows::show_menu(state, window, argument(&args, 0)).await?;
            Ok(Value::Null)
        }
        "hide-popup-menu" => {
            let _menu = state.menu_requests.lock().await;
            windows::hide_menu(state)?;
            Ok(Value::Null)
        }
        "resize-and-show-menu" => {
            let _menu = state.menu_requests.lock().await;
            windows::resize_menu(state, window, &argument(&args, 0))?;
            Ok(Value::Null)
        }
        "menu-item-click" => {
            let _menu = state.menu_requests.lock().await;
            windows::menu_action(state, window, &args)?;
            Ok(Value::Null)
        }
        "run-scan-full" | "update-backup-table" | "update-restore-table" => {
            state.emit_to("main", channel, json!([]));
            Ok(Value::Null)
        }
        "select-path" => {
            let kind = string_arg(&args, 0)?;
            if !matches!(
                (context.role.as_str(), kind),
                ("export", "folder") | ("import", "gsmr")
            ) {
                return Err("Path selection denied".into());
            }
            select_path(state, kind).await
        }
        "open-dialog" => select_path(state, "directories").await,
        "open-backup-dialog" => select_path(state, "backup").await,
        "open-directory" => {
            let configured = PathBuf::from(
                state.settings()["backupPath"]
                    .as_str()
                    .ok_or("Missing backup path")?,
            );
            let requested = PathBuf::from(string_arg(&args, 0)?);
            if requested != configured {
                return Err("Path is not the configured backup directory".into());
            }
            platform::open_path(&configured)?;
            Ok(json!({"success":true,"message":""}))
        }
        "open-url" => {
            let url = string_arg(&args, 0)?;
            if !updates::allowed_external_url(url) {
                return Err("Blocked external URL".into());
            }
            platform::open_url(url)?;
            Ok(Value::Null)
        }
        "get-icon-map" => Ok(icons()),
        "get-current-version" => Ok(json!(env!("CARGO_PKG_VERSION"))),
        "get-repository-url" => Ok(json!("https://github.com/leisurefire/OpenGameSave")),
        "get-latest-version" => updates::check(state).await,
        "is-newer-version" => Ok(json!(updates::is_newer(
            string_arg(&args, 0)?,
            args.get(1)
                .and_then(Value::as_str)
                .unwrap_or(env!("CARGO_PKG_VERSION"))
        ))),
        "get-app-update-state" => Ok(state.update_state.lock().unwrap().clone()),
        "download-app-update" => updates::download(state).await,
        "start-auto-backup" | "stop-auto-backup" | "get-auto-backup-state" => {
            automatic::dispatch(state, channel, args).await
        }
        channel if channel.starts_with("sync-provider-") => {
            sync::dispatch(state, channel, args).await
        }
        "get-library-games"
        | "get-library-game-art"
        | "launch-library-game"
        | "open-library-game-directory"
        | "get-game-guide-catalog"
        | "search-game-guides"
        | "get-game-guide"
        | "get-account-data"
        | "get-detected-game-paths" => library::dispatch(state, channel, args).await,
        _ => {
            if matches!(
                channel,
                "fetch-backup-table-data"
                    | "get-local-save-data"
                    | "start-scan-full"
                    | "backup-game"
                    | "restore-game"
                    | "delete-local-save"
                    | "browse-local-save"
            ) || (channel == "get-table-view-model"
                && args.first().is_some_and(|view| view == "backup"))
            {
                state.ensure_game_data().await?;
            }
            saves::dispatch(state, channel, args).await
        }
    }
}

pub fn icons() -> Value {
    json!({"Steam":include_str!("../../src/assets/steam.svg"),"Ubisoft":include_str!("../../src/assets/ubisoft.svg"),
        "EA":include_str!("../../src/assets/ea.svg"),"Epic":include_str!("../../src/assets/epic.svg"),
        "GOG":include_str!("../../src/assets/gog.svg"),"Xbox":include_str!("../../src/assets/xbox.svg"),"Blizzard":include_str!("../../src/assets/battlenet.svg")})
}

pub fn run() {
    let log_data = std::env::var_os("OGS_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::config_dir().unwrap_or_default().join("opengamesave"));
    let original_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        logging::error(&log_data, &info.to_string());
        original_panic(info);
    }));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if let Some(state) = app.try_state::<AppState>() {
                for arg in args.iter().filter(|a| a.to_lowercase().ends_with(".gsmr")) {
                    state.emit_to("main", "open-import-modal", json!([arg]));
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            if let Some(state) = window.app_handle().try_state::<AppState>() {
                windows::on_event(&state, window.label(), event);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_window_context,
            renderer_ready,
            dispatch
        ])
        .setup(|app| {
            // Keep Electron's Windows data location so backups/settings are adopted in place.
            let app_data = std::env::var_os("OGS_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    dirs::config_dir()
                        .unwrap_or_else(|| PathBuf::from("."))
                        .join("opengamesave")
                });
            let resource_dir = if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap()
                    .to_path_buf()
            } else {
                app.path().resource_dir()?
            };
            let state = AppState::new(app.handle().clone(), app_data, resource_dir)?;
            if let Err(error) = platform::set_autostart(state.settings()["launchAtStartup"] == true)
            {
                logging::error(&state.app_data, &format!("Startup registration: {error}"));
            }
            app.manage(state.clone());
            windows::create(&state, "main", json!({}))?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Failed to initialize OpenGameSave");
    app.run(|app, event| match event {
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" => {
            let state = app.state::<AppState>();
            if !state.exit_ready.load(Ordering::SeqCst) {
                api.prevent_close();
                if state.begin_shutdown() {
                    let state = state.inner().clone();
                    tauri::async_runtime::spawn(async move {
                        let _guard = state.operation.lock().await;
                        let finish = state.clone();
                        let _ =
                            tauri::async_runtime::spawn_blocking(move || finish.finish_shutdown())
                                .await;
                    });
                }
            }
        }
        tauri::RunEvent::ExitRequested { api, .. } => {
            let state = app.state::<AppState>();
            if !state.exit_ready.load(Ordering::SeqCst) {
                api.prevent_exit();
                if state.begin_shutdown() {
                    let state = state.inner().clone();
                    tauri::async_runtime::spawn(async move {
                        let _guard = state.operation.lock().await;
                        let finish = state.clone();
                        let _ =
                            tauri::async_runtime::spawn_blocking(move || finish.finish_shutdown())
                                .await;
                    });
                }
            }
        }
        _ => {}
    });
}
