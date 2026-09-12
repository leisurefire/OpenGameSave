use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone)]
pub struct WindowContext {
    pub role: String,
    pub data: Value,
    pub ready: bool,
    pub owner: Option<String>,
}

pub struct PendingResponse {
    pub window: String,
    pub sender: tokio::sync::oneshot::Sender<Value>,
}

#[derive(Clone)]
pub struct AppState {
    pub app_data: PathBuf,
    pub database_path: PathBuf,
    pub resource_dir: PathBuf,
    pub app: AppHandle,
    pub operation: Arc<tokio::sync::Mutex<()>>,
    pub shutting_down: Arc<AtomicBool>,
    pub exit_ready: Arc<AtomicBool>,
    pub windows: Arc<Mutex<HashMap<String, WindowContext>>>,
    pub pending: Arc<Mutex<HashMap<String, PendingResponse>>>,
    pub menu: Arc<Mutex<Value>>,
    pub menu_creation: Arc<tokio::sync::Mutex<()>>,
    pub menu_requests: Arc<tokio::sync::Mutex<()>>,
    pub auto_backup: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pub auto_logs: Arc<Mutex<Value>>,
    settings: Arc<Mutex<Value>>,
    settings_write: Arc<Mutex<()>>,
    status: Arc<Mutex<Value>>,
    pub update_state: Arc<Mutex<Value>>,
    initialization: Arc<tokio::sync::OnceCell<()>>,
}

impl AppState {
    pub fn new(app: AppHandle, app_data: PathBuf, resource_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&app_data).map_err(|e| e.to_string())?;
        let settings = crate::settings::load(&app_data)?;
        if let Some(path) = settings["backupPath"].as_str() {
            crate::sync::recover_transactions(std::path::Path::new(path))?;
        }
        let database_path = app_data.join("OGS Database/database.db");
        crate::saves::update::recover(&database_path)?;
        if !database_path.exists() {
            let seed = resource_dir.join("database/database.db");
            crate::settings::atomic_write(
                &database_path,
                &std::fs::read(&seed)
                    .map_err(|e| format!("Cannot read database {}: {e}", seed.display()))?,
            )?;
        }
        Ok(Self {
            app_data,
            database_path,
            resource_dir,
            app,
            settings: Arc::new(Mutex::new(settings)),
            settings_write: Arc::new(Mutex::new(())),
            operation: Arc::new(tokio::sync::Mutex::new(())),
            shutting_down: Arc::new(AtomicBool::new(false)),
            exit_ready: Arc::new(AtomicBool::new(false)),
            windows: Arc::new(Mutex::new(HashMap::new())),
            pending: Arc::new(Mutex::new(HashMap::new())),
            menu: Arc::new(Mutex::new(Value::Null)),
            menu_creation: Arc::new(tokio::sync::Mutex::new(())),
            menu_requests: Arc::new(tokio::sync::Mutex::new(())),
            auto_backup: Arc::new(Mutex::new(HashMap::new())),
            auto_logs: Arc::new(Mutex::new(json!({}))),
            initialization: Arc::new(tokio::sync::OnceCell::new()),
            status: Arc::new(Mutex::new(
                json!({"backuping":false,"scanning_full":false,"restoring":false,"migrating":false,"updating_db":false,"exporting":false,"importing":false,"updating_backup":false,"updating_restore":false,"updating_app":false,"syncing":false}),
            )),
            update_state: Arc::new(Mutex::new(
                json!({"status":"idle","currentVersion":env!("CARGO_PKG_VERSION"),"availableVersion":null,"canAutoUpdate":false,"percent":0,"transferred":0,"total":0,"bytesPerSecond":0,"error":null,"releaseUrl":null,"fallbackAvailable":false}),
            )),
        })
    }

    pub fn settings(&self) -> Value {
        self.settings
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub async fn ensure_game_data(&self) -> Result<(), String> {
        self.initialization
            .get_or_try_init(|| async {
                let state = self.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    crate::library::game_data();
                    if state.settings()["gameInstalls"] == "uninitialized" {
                        state.save_settings(
                            json!({"gameInstalls":crate::library::detected_paths()}),
                        )?;
                    }
                    Ok::<(), String>(())
                })
                .await
                .map_err(|e| e.to_string())?
            })
            .await
            .map(|_| ())
    }

    pub fn save_settings(&self, updates: Value) -> Result<(), String> {
        let updates = updates
            .as_object()
            .ok_or("Settings update must be an object")?;
        for (key, value) in updates {
            crate::settings::validate(key, value)?;
        }
        // Serialize writers without holding the read snapshot lock during fsync.
        let _write = self
            .settings_write
            .lock()
            .map_err(|_| "Settings writer poisoned")?;
        let before = self.settings();
        let mut next = before.clone();
        for (key, value) in updates {
            next[key] = value.clone();
        }
        if next == before {
            return Ok(());
        }
        crate::settings::atomic_write(
            &self.app_data.join("OGS Settings/settings.json"),
            &serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?,
        )?;
        *self.settings.lock().map_err(|_| "Settings lock poisoned")? = next;
        if updates.contains_key("launchAtStartup") {
            crate::platform::set_autostart(
                self.settings()["launchAtStartup"]
                    .as_bool()
                    .unwrap_or(false),
            )?;
        }
        if updates.contains_key("language") {
            self.emit("apply-language", json!([self.settings()["language"]]));
        }
        if updates.contains_key("syncAccentColor") {
            self.emit("accent-color-changed", json!([self.accent()]));
        }
        if updates.contains_key("visibleSidebarItems") {
            self.emit(
                "sidebar-visibility-changed",
                json!([self.settings()["visibleSidebarItems"]]),
            );
        }
        if updates.keys().any(|k| {
            matches!(
                k.as_str(),
                "language" | "gameInstalls" | "saveUninstalledGames" | "backupPath"
            )
        }) {
            self.emit("update-backup-table", json!([]));
            self.emit("update-restore-table", json!([]));
        }
        Ok(())
    }

    pub async fn save_settings_async(&self, updates: Value) -> Result<(), String> {
        let state = self.clone();
        tauri::async_runtime::spawn_blocking(move || state.save_settings(updates))
            .await
            .map_err(|e| e.to_string())?
    }

    pub fn status(&self) -> Value {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn set_status(&self, key: &str, value: bool) {
        let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
        if status.get(key).is_some() {
            status[key] = json!(value);
        }
    }

    pub fn accent(&self) -> String {
        if self.settings()["syncAccentColor"] == true {
            crate::platform::accent_color()
        } else {
            "#16c60c".into()
        }
    }

    pub fn emit(&self, channel: &str, args: Value) {
        let labels: Vec<String> = self
            .windows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|(_, c)| crate::policy::allowed(&c.role, "receive", channel))
            .map(|(l, _)| l.clone())
            .collect();
        for label in labels {
            self.emit_to(&label, channel, args.clone());
        }
    }
    pub fn emit_to(&self, label: &str, channel: &str, args: Value) {
        let allowed = self
            .windows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(label)
            .map(|c| crate::policy::allowed(&c.role, "receive", channel))
            .unwrap_or(false);
        if allowed && self.app.get_webview_window(label).is_some() {
            let _ = self.app.emit_to(
                tauri::EventTarget::webview_window(label),
                "ogs:event",
                json!({"channel":channel,"args":args}),
            );
        }
    }
    pub fn translate(&self, key: &str, options: Value) -> String {
        static EN: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
        static ZH: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
        let en = EN.get_or_init(|| {
            serde_json::from_str(include_str!("../../src/locale/en_US.json"))
                .expect("English catalog")
        });
        let zh = ZH.get_or_init(|| {
            serde_json::from_str(include_str!("../../src/locale/zh_CN.json"))
                .expect("Chinese catalog")
        });
        let find = |catalog: &Value| -> Option<String> {
            let mut v = catalog;
            for part in key.split('.') {
                v = v.get(part)?;
            }
            v.as_str().map(str::to_owned)
        };
        let selected = if self.settings()["language"] == "zh_CN" {
            zh
        } else {
            en
        };
        let mut text = find(selected)
            .or_else(|| find(en))
            .unwrap_or_else(|| key.to_owned());
        if let Some(options) = options.as_object() {
            for (key, value) in options {
                let value = value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string());
                text = text.replace(&format!("{{{{{key}}}}}"), &value);
            }
        }
        text
    }
    pub async fn confirm(&self, prompt: Value) -> Result<Value, String> {
        crate::windows::request(self, "confirm", prompt).await
    }
    pub async fn dialog(&self, prompt: Value) -> Result<Value, String> {
        crate::windows::request(self, "dialog", prompt).await
    }
    pub fn begin_shutdown(&self) -> bool {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return false;
        }
        for (_, flag) in self
            .auto_backup
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
        {
            flag.store(true, Ordering::SeqCst);
        }
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        true
    }
    pub fn finish_shutdown(&self) {
        // A setting may have been committed while a domain operation drained.
        let _write = self
            .settings_write
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        self.exit_ready.store(true, Ordering::SeqCst);
        self.app.exit(0);
    }
}
