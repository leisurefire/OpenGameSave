use serde_json::Value;
use std::sync::OnceLock;

fn policy() -> &'static Value {
    static POLICY: OnceLock<Value> = OnceLock::new();
    POLICY.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/shared/ipc-policy.json"))
            .expect("embedded role policy")
    })
}

pub fn allowed(role: &str, direction: &str, channel: &str) -> bool {
    policy()["roles"][role][direction]
        .as_array()
        .map(|a| a.iter().any(|v| v == channel))
        .unwrap_or(false)
}

pub fn file(role: &str) -> Option<&'static str> {
    policy()["files"][role].as_str()
}

pub fn settings_update_allowed(role: &str, updates: &Value) -> bool {
    let keys: &[&str] = match role {
        "main" => &[
            "blockedGameTipDismissed",
            "blockedGames",
            "firstLaunchFullScanTipShown",
            "pinnedGames",
            "syncProvider",
            "uninstalledGames",
        ],
        "settings" => &[
            "appUpdatePrerelease",
            "autoAppUpdate",
            "autoDbUpdate",
            "databaseVariant",
            "gameInstalls",
            "launchAtStartup",
            "maxBackups",
            "saveUninstalledGames",
            "syncAccentColor",
            "visibleSidebarItems",
        ],
        "export" => &["exportPath"],
        "account" => &["backupAllAccounts"],
        _ => &[],
    };
    updates
        .as_object()
        .map(|o| !o.is_empty() && o.keys().all(|k| keys.contains(&k.as_str())))
        .unwrap_or(false)
}

pub fn settings_for_role(role: &str, settings: Value) -> Value {
    if matches!(role, "main" | "settings") {
        return settings;
    }
    let keys: &[&str] = match role {
        "export" => &["exportPath", "maxBackups"],
        "account" => &["backupAllAccounts"],
        "auto-backup" | "manage-backups" | "local-save" => &["language"],
        _ => &[],
    };
    keys.iter()
        .map(|k| (k.to_string(), settings[*k].clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deny_unknown_and_cross_role_requests() {
        assert!(!allowed("unknown", "invoke", "get-settings"));
        assert!(!allowed("about", "invoke", "restore-game"));
        assert!(!allowed("confirm", "send", "save-settings"));
        assert!(allowed("main", "invoke", "backup-game"));
        assert!(allowed("confirm", "send", "modal-window-confirm-response"));
        assert!(!settings_update_allowed(
            "main",
            &serde_json::json!({"backupPath":"C:\\saves"})
        ));
        assert!(!settings_update_allowed(
            "export",
            &serde_json::json!({"webdavUrl":"https://example.org"})
        ));
        assert!(settings_update_allowed(
            "account",
            &serde_json::json!({"backupAllAccounts":true})
        ));
    }
}
