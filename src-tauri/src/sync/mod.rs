//! Native synchronization services. Transport and reconciliation run on a blocking worker;
//! callers serialize mutations with the application's operation lock.
mod client;
mod credentials;
mod github;
mod manifest;
mod merge;
#[cfg(test)]
mod test_server;
mod transaction;
mod util;
mod webdav;

use serde_json::{json, Value};

pub async fn dispatch(
    ctx: &crate::state::AppState,
    channel: &str,
    args: Vec<Value>,
) -> Result<Value, String> {
    let context = ctx.clone();
    let channel = channel.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let settings = context.settings();
        if channel == "sync-provider-list" {
            return Ok(
                json!([{"id":"github","configurable":false},{"id":"webdav","configurable":true}]),
            );
        }
        let provider = args.first().and_then(Value::as_str).unwrap_or_default();
        if !matches!(provider, "github" | "webdav") {
            return Err("Unsupported sync provider".into());
        }
        match channel.as_str() {
            "sync-provider-config" if provider == "github" => Ok(Value::Null),
            "sync-provider-config" => credentials::public_config(&context.app_data, &settings),
            "sync-provider-save-config" if provider == "webdav" => credentials::save_config(
                &context.app_data,
                &settings,
                args.get(1).unwrap_or(&Value::Null),
            ),
            "sync-provider-save-config" => {
                Err("This sync provider has no editable configuration".into())
            }
            "sync-provider-status" if provider == "webdav" => {
                Ok(webdav::status(&context.app_data, &settings))
            }
            "sync-provider-status" => Ok(github::status(&settings, args.get(1))),
            "sync-provider-run" => {
                let direction = args.get(1).and_then(Value::as_str).unwrap_or_default();
                if !matches!(direction, "upload" | "download") {
                    return Err("Unsupported sync direction".into());
                }
                let root = util::sync_root(&settings, args.get(2))?;
                let result = if provider == "github" {
                    github::run(&root, &settings, direction)
                } else {
                    webdav::run(&context.app_data, &root, &settings, direction)
                };
                if direction == "download" {
                    context.emit("update-restore-table", json!([]));
                    context.emit("update-backup-table", json!([]));
                }
                result
            }
            _ => Err(format!("Unknown sync channel: {channel}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Called during startup before automatic backups can access the same directory.
pub fn recover_transactions(root: &std::path::Path) -> Result<(), String> {
    transaction::recover(root)
}
