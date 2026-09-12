use crate::state::{AppState, PendingResponse, WindowContext};
use serde_json::{json, Value};
use tauri::{
    Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const MENU_LABEL: &str = "menu-popup";

fn trusted_document(url: &url::Url, file: &str) -> bool {
    matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    ) && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && (url.path().trim_start_matches('/') == file
            || (file == "index.html" && url.path() == "/"))
}

pub fn create(state: &AppState, role: &str, data: Value) -> Result<String, String> {
    create_inner(state, role, data, None)
}

fn create_inner(
    state: &AppState,
    role: &str,
    mut data: Value,
    response: Option<tokio::sync::oneshot::Sender<Value>>,
) -> Result<String, String> {
    use std::sync::atomic::Ordering;
    if state.shutting_down.load(Ordering::SeqCst) {
        return Err("Application is shutting down".into());
    }
    let file = crate::policy::file(role).ok_or("Unknown window role")?;
    let label = if role == "main" {
        "main".to_owned()
    } else if role == "menu" {
        MENU_LABEL.to_owned()
    } else {
        format!(
            "{}-{}",
            if matches!(role, "settings" | "about" | "menu") {
                role
            } else {
                "modal"
            },
            uuid::Uuid::new_v4()
        )
    };
    if !data.is_object() {
        data = json!({});
    }
    data["modalType"] = json!(role);
    let (width, height, resizable) = match role {
        "main" => (1080., 680., true),
        "settings" => (620., 600., true),
        "about" => (620., 520., true),
        "manage-backups" => (960., 680., true),
        "local-save" => (760., 560., true),
        "account" => (620., 500., false),
        "auto-backup" => (620., 400., false),
        "export" => (520., 360., false),
        "menu" => (240., 300., false),
        _ => (520., 250., true),
    };
    let owner = if matches!(role, "main" | "menu") {
        None
    } else {
        state
            .app
            .webview_windows()
            .into_values()
            .find(|w| w.label() != MENU_LABEL && w.is_focused().unwrap_or(false))
            .or_else(|| state.app.get_webview_window("main"))
    };
    let mut builder = WebviewWindowBuilder::new(&state.app, &label, WebviewUrl::App(file.into()))
        .data_directory(state.app_data.join("WebView2"))
        .title("OpenGameSave")
        .inner_size(width, height)
        .resizable(resizable)
        .visible(false)
        .decorations(!matches!(role, "main" | "menu"))
        .theme(Some(tauri::Theme::Dark))
        .transparent(true)
        .on_navigation(move |url| trusted_document(url, file));
    if role == "main" {
        builder = builder.min_inner_size(780., 540.);
    }
    if role == "menu" {
        builder = builder
            .skip_taskbar(true)
            .always_on_top(true)
            .focused(false)
            .shadow(false)
            .transparent(true);
    }
    if let Some(owner) = owner.as_ref() {
        builder = builder.parent(owner).map_err(|e| e.to_string())?;
    }
    let request_id = data["requestId"].as_str().map(str::to_owned);
    state
        .windows
        .lock()
        .map_err(|_| "Window state poisoned")?
        .insert(
            label.clone(),
            WindowContext {
                role: role.into(),
                data,
                ready: false,
                owner: owner.as_ref().map(|w| w.label().to_owned()),
            },
        );
    if let Some(sender) = response {
        let mut pending = state.pending.lock().map_err(|_| "Dialog state poisoned")?;
        // Register before constructing the WebView. Shutdown clears this same
        // map, so a fast close or shutdown cannot strand a waiting operation.
        if state.shutting_down.load(Ordering::SeqCst) {
            drop(pending);
            state.windows.lock().unwrap().remove(&label);
            return Err("Application is shutting down".into());
        }
        pending.insert(
            request_id.clone().ok_or("Missing dialog request ID")?,
            PendingResponse {
                window: label.clone(),
                sender,
            },
        );
    }
    if let Some(owner) = owner.as_ref() {
        let _ = owner.set_enabled(false);
    }
    let window = match builder.build() {
        Ok(w) => w,
        Err(e) => {
            state.windows.lock().unwrap().remove(&label);
            if let Some(id) = request_id {
                state.pending.lock().unwrap().remove(&id);
            }
            if let Some(owner) = owner.as_ref() {
                let _ = owner.set_enabled(true);
            }
            return Err(e.to_string());
        }
    };
    if !matches!(role, "main" | "menu") {
        let _ = window.center();
    }
    #[cfg(windows)]
    if role != "menu" {
        let _ = window.set_effects(
            tauri::window::EffectsBuilder::new()
                .effect(tauri::utils::WindowEffect::MicaDark)
                .build(),
        );
    }
    Ok(label)
}

// Installed on the builder before any WebView is constructed. A renderer can
// become ready (or close) before WebviewWindowBuilder::build returns.
pub fn on_event(state: &AppState, label: &str, event: &tauri::WindowEvent) {
    #[cfg(debug_assertions)]
    if std::env::var_os("OGS_NATIVE_TRACE").is_some() {
        eprintln!("window {label}: {event:?}");
    }
    match event {
        tauri::WindowEvent::Destroyed => closed(state, label),
        tauri::WindowEvent::CloseRequested { api, .. }
            if label == MENU_LABEL
                && !state
                    .shutting_down
                    .load(std::sync::atomic::Ordering::SeqCst) =>
        {
            api.prevent_close();
            let request_id = state.menu.lock().unwrap()["payload"]["requestId"].clone();
            let state = state.clone();
            tauri::async_runtime::spawn(async move {
                let _guard = state.menu_requests.lock().await;
                let current_id = state.menu.lock().unwrap()["payload"]["requestId"].clone();
                if !request_id.is_null() && current_id == request_id {
                    let _ = hide_menu_matching(&state, Some(MENU_LABEL), true);
                }
            });
        }
        tauri::WindowEvent::Focused(false) if label.starts_with("menu-") => {
            // Native focus callbacks must never wait on locks held by commands
            // that are themselves waiting for the UI thread. Queue the check,
            // and reject callbacks belonging to an older menu presentation.
            let request_id = state.menu.lock().unwrap()["payload"]["requestId"].clone();
            let state = state.clone();
            let label = label.to_owned();
            tauri::async_runtime::spawn(async move {
                let _guard = state.menu_requests.lock().await;
                let current = state.menu.lock().unwrap().clone();
                if current["label"] == label
                    && !request_id.is_null()
                    && current["payload"]["requestId"] == request_id
                    && state.app.get_webview_window(&label).is_some_and(|window| {
                        window.is_visible().unwrap_or(false)
                            && !window.is_focused().unwrap_or(false)
                    })
                {
                    let _ = hide_menu_matching(&state, Some(&label), false);
                }
            });
        }
        tauri::WindowEvent::Moved(_) if label == "main" => {
            let request_id = state.menu.lock().unwrap()["payload"]["requestId"].clone();
            let state = state.clone();
            tauri::async_runtime::spawn(async move {
                let _guard = state.menu_requests.lock().await;
                let current_id = state.menu.lock().unwrap()["payload"]["requestId"].clone();
                if !request_id.is_null() && current_id == request_id {
                    let _ = hide_menu(&state);
                }
            });
        }
        _ => {}
    }
}

pub fn context(state: &AppState, window: &WebviewWindow) -> Result<WindowContext, String> {
    let context = state
        .windows
        .lock()
        .map_err(|_| "Window state poisoned")?
        .get(window.label())
        .cloned()
        .ok_or("Unregistered window")?;
    // The native navigation callback permanently restricts this window to its
    // role's bundled document. Once the initial handshake verified the URL,
    // querying WebView2 synchronously on every IPC adds a UI-thread round trip
    // without strengthening that immutable navigation boundary.
    if context.ready {
        return Ok(context);
    }
    let url = window.url().map_err(|e| e.to_string())?;
    let file = crate::policy::file(&context.role).ok_or("Unknown role")?;
    if !trusted_document(&url, file) {
        return Err("Untrusted window document".into());
    }
    Ok(context)
}

pub fn ready(state: &AppState, window: &WebviewWindow) -> Result<(), String> {
    let role = {
        let mut windows = state.windows.lock().map_err(|_| "Window state poisoned")?;
        let context = windows.get_mut(window.label()).ok_or("Unknown window")?;
        context.ready = true;
        context.role.clone()
    };
    if role == "menu" {
        let menu = state.menu.lock().unwrap().clone();
        if menu["label"] == window.label() {
            state.emit_to(window.label(), "set-menu-items", json!([menu["payload"]]));
        }
    } else {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn closed(state: &AppState, label: &str) {
    let context = state
        .windows
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(label);
    let request_ids: Vec<String> = state
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|(_, p)| p.window == label)
        .map(|(id, _)| id.clone())
        .collect();
    for id in request_ids {
        if let Some(pending) = state.pending.lock().unwrap().remove(&id) {
            let value = if context.as_ref().map(|c| c.role.as_str()) == Some("dialog") {
                json!({"value":context.as_ref().and_then(|c|c.data.get("closeValue")).cloned().unwrap_or(json!(false)),"checked":false})
            } else {
                json!(false)
            };
            let _ = pending.sender.send(value);
        }
    }
    if let Some(owner) = context
        .and_then(|c| c.owner)
        .and_then(|label| state.app.get_webview_window(&label))
    {
        let _ = owner.set_enabled(true);
        let _ = owner.set_focus();
    }
}

pub async fn request(state: &AppState, role: &str, mut prompt: Value) -> Result<Value, String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    if !prompt.is_object() {
        return Err("Invalid dialog payload".into());
    }
    prompt["requestId"] = json!(request_id);
    if role == "dialog" {
        if let Some(buttons) = prompt["buttons"].as_array_mut() {
            for button in buttons {
                if let Some(key) = button["i18n"].as_str() {
                    button["text"] = json!(state.translate(key, Value::Null));
                }
            }
        }
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let label = create_inner(state, role, prompt, Some(sender))?;
    let result = receiver.await.unwrap_or(json!(false));
    state.pending.lock().unwrap().remove(&request_id);
    if let Some(window) = state.app.get_webview_window(&label) {
        let _ = window.close();
    }
    Ok(result)
}

pub fn respond(
    state: &AppState,
    window: &WebviewWindow,
    id: &str,
    value: Value,
) -> Result<(), String> {
    let mut pending = state.pending.lock().map_err(|_| "Dialog state poisoned")?;
    if pending.get(id).map(|p| p.window.as_str()) != Some(window.label()) {
        return Err("Stale or unauthorized response".into());
    }
    if let Some(p) = pending.remove(id) {
        let _ = p.sender.send(value);
    }
    Ok(())
}

pub async fn prepare_menu(state: &AppState) -> Result<String, String> {
    let _creation = state.menu_creation.lock().await;
    if state.app.get_webview_window(MENU_LABEL).is_none() {
        create(state, "menu", json!({}))?;
    }
    Ok(MENU_LABEL.to_owned())
}

pub async fn show_menu(
    state: &AppState,
    parent: &WebviewWindow,
    payload: Value,
) -> Result<(), String> {
    hide_menu(state)?;
    let items = payload["items"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 30)
        .ok_or("Invalid menu items")?;
    let x = payload["x"]
        .as_f64()
        .filter(|n| n.is_finite())
        .ok_or("Invalid menu position")?;
    let y = payload["y"]
        .as_f64()
        .filter(|n| n.is_finite())
        .ok_or("Invalid menu position")?;
    let id = uuid::Uuid::new_v4().to_string();
    let direction = if payload["direction"] == "up" {
        "up"
    } else {
        "down"
    };
    let label = prepare_menu(state).await?;
    let position = parent.inner_position().map_err(|e| e.to_string())?;
    let parent_scale = parent.scale_factor().map_err(|e| e.to_string())?;
    let anchor_x = f64::from(position.x) + x * parent_scale;
    let anchor_y = f64::from(position.y) + y * parent_scale;
    let monitor = parent
        .monitor_from_point(anchor_x, anchor_y)
        .map_err(|e| e.to_string())?
        .or_else(|| parent.current_monitor().ok().flatten());
    let scale = monitor
        .as_ref()
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(parent_scale);
    let work_area = monitor.map(|monitor| {
        let work = monitor.work_area();
        json!({"x":work.position.x,"y":work.position.y,"width":work.size.width,"height":work.size.height})
    });
    *state.menu.lock().unwrap() = json!({"label":label,"parent":parent.label(),"x":anchor_x,"y":anchor_y,"scale":scale,"workArea":work_area,"rendererRequestId":payload["rendererRequestId"],
        "payload":{"items":items,"direction":direction,"locale":state.translate("meta.locale",Value::Null),"requestId":id}});
    // Drop the registry guard before emitting: emit_to authorizes against this
    // same registry. Holding it here deadlocks a fast renderer and the UI loop.
    let ready = state
        .windows
        .lock()
        .unwrap()
        .get(&label)
        .map(|c| c.ready)
        .unwrap_or(false);
    if ready {
        let payload = state.menu.lock().unwrap()["payload"].clone();
        state.emit_to(&label, "set-menu-items", json!([payload]));
    }
    Ok(())
}

pub fn hide_menu(state: &AppState) -> Result<(), String> {
    hide_menu_matching(state, None, false)
}

fn hide_menu_matching(
    state: &AppState,
    label: Option<&str>,
    restore_focus: bool,
) -> Result<(), String> {
    let menu = {
        let mut menu = state.menu.lock().map_err(|_| "Menu state poisoned")?;
        if label.is_some_and(|label| menu["label"] != label) {
            return Ok(());
        }
        std::mem::take(&mut *menu)
    };
    if let Some(label) = menu["label"].as_str() {
        if let Some(window) = state.app.get_webview_window(label) {
            let _ = window.hide();
        }
    }
    if let Some(parent) = menu["parent"].as_str() {
        if restore_focus {
            if let Some(window) = state.app.get_webview_window(parent) {
                let _ = window.set_focus();
            }
        }
        state.emit_to(
            parent,
            "menu-hidden",
            json!([{"restoreFocus":restore_focus,"rendererRequestId":menu["rendererRequestId"]}]),
        );
    }
    Ok(())
}

pub fn resize_menu(state: &AppState, window: &WebviewWindow, size: &Value) -> Result<(), String> {
    let menu = state.menu.lock().unwrap().clone();
    if menu["label"] != window.label() || size["requestId"] != menu["payload"]["requestId"] {
        return Ok(());
    }
    if size["dismiss"] == true {
        return hide_menu_matching(state, Some(window.label()), true);
    }
    let scale = menu["scale"].as_f64().unwrap_or(1.).clamp(0.5, 8.);
    let width = size["width"]
        .as_f64()
        .filter(|n| n.is_finite())
        .unwrap_or(240.)
        .clamp(196., 400.)
        * scale;
    let height = size["height"]
        .as_f64()
        .filter(|n| n.is_finite())
        .unwrap_or(100.)
        .clamp(1., 1000.)
        * scale;
    let inset = |k: &str| size["inset"][k].as_f64().unwrap_or(0.).clamp(0., 48.);
    let x = menu["x"].as_f64().unwrap_or(0.) - inset("left") * scale;
    let y = menu["y"].as_f64().unwrap_or(0.)
        + if menu["payload"]["direction"] == "up" {
            -height + inset("bottom") * scale
        } else {
            -inset("top") * scale
        };
    let (x, y, width, height) = menu_bounds(x, y, width, height, &menu["workArea"]);
    window
        .set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
        .map_err(|e| e.to_string())?;
    window
        .set_size(PhysicalSize::new(width.ceil() as u32, height.ceil() as u32))
        .map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

pub fn menu_action(state: &AppState, window: &WebviewWindow, args: &[Value]) -> Result<(), String> {
    let menu = state.menu.lock().unwrap().clone();
    if menu["label"] != window.label() || args.get(2) != Some(&menu["payload"]["requestId"]) {
        return Err("Stale menu action".into());
    }
    let action = args.first().ok_or("Missing action")?;
    let data = args.get(1).unwrap_or(&Value::Null);
    if !menu["payload"]["items"]
        .as_array()
        .map(|a| {
            a.iter().any(|item| {
                item["action"] == *action
                    && item.get("data").unwrap_or(&Value::Null) == data
                    && item["disabled"] != true
            })
        })
        .unwrap_or(false)
    {
        return Err("Unauthorized menu item".into());
    }
    let parent = menu["parent"].as_str().unwrap_or("main");
    // Restore the invoking window before delivering an action that may open a
    // modal. A reusable menu must never become the modal's disabled owner.
    hide_menu_matching(state, Some(window.label()), true)?;
    state.emit_to(parent, "execute-menu-action", json!([action, data]));
    Ok(())
}

fn menu_bounds(x: f64, y: f64, width: f64, height: f64, work: &Value) -> (f64, f64, f64, f64) {
    let Some(left) = work["x"].as_f64() else {
        return (x, y, width, height);
    };
    let top = work["y"].as_f64().unwrap_or(0.);
    let available_width = work["width"].as_f64().unwrap_or(width).max(1.);
    let available_height = work["height"].as_f64().unwrap_or(height).max(1.);
    let width = width.min(available_width);
    let height = height.min(available_height);
    (
        x.clamp(left, left + available_width - width),
        y.clamp(top, top + available_height - height),
        width,
        height,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn menu_geometry_uses_physical_monitor_coordinates_and_work_area() {
        let work = json!({"x":-2560,"y":0,"width":2560,"height":1400});
        assert_eq!(
            menu_bounds(-100., 1300., 480., 240., &work),
            (-480., 1160., 480., 240.)
        );
        assert_eq!(
            menu_bounds(-3000., -60., 480., 240., &work),
            (-2560., 0., 480., 240.)
        );
        assert_eq!(
            menu_bounds(
                0.,
                0.,
                480.,
                240.,
                &json!({"x":0,"y":0,"width":300,"height":200})
            ),
            (0., 0., 300., 200.)
        );
    }
    #[test]
    fn window_identity_rejects_local_servers_and_other_pages() {
        assert!(trusted_document(
            &url::Url::parse("http://tauri.localhost/index.html").unwrap(),
            "index.html"
        ));
        assert!(trusted_document(
            &url::Url::parse("http://tauri.localhost/").unwrap(),
            "index.html"
        ));
        assert!(!trusted_document(
            &url::Url::parse("http://localhost:3000/index.html").unwrap(),
            "index.html"
        ));
        assert!(!trusted_document(
            &url::Url::parse("http://tauri.localhost:3000/index.html").unwrap(),
            "index.html"
        ));
        assert!(!trusted_document(
            &url::Url::parse("http://tauri.localhost/settings.html").unwrap(),
            "index.html"
        ));
        assert!(!trusted_document(
            &url::Url::parse("https://example.org/index.html").unwrap(),
            "index.html"
        ));
    }
}
