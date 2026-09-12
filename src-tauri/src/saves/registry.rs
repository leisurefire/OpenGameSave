use super::fs::{self, Result};
use std::{
    path::Path,
    process::{Command, Output},
};
pub fn command(args: &[&str]) -> Result<Output> {
    if !cfg!(windows) {
        return Err("Registry operations require Windows".into());
    }
    let mut c = Command::new("reg.exe");
    c.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    let out = c.output().map_err(fs::err)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(out)
}
pub fn normalize(raw: &str) -> Result<String> {
    let value = raw.replace('/', "\\");
    let parts: Vec<_> = value.trim_end_matches('\\').split('\\').collect();
    if parts.len() < 3
        || parts.iter().any(|p| {
            p.is_empty()
                || *p == "."
                || *p == ".."
                || p.contains(['\0', '\r', '\n', '[', ']', '*', '?'])
        })
    {
        return Err("Unsafe registry key".into());
    }
    let hive = match parts[0].to_uppercase().as_str() {
        "HKCU" | "HKEY_CURRENT_USER" => "HKEY_CURRENT_USER",
        "HKLM" | "HKEY_LOCAL_MACHINE" => "HKEY_LOCAL_MACHINE",
        "HKCR" | "HKEY_CLASSES_ROOT" => "HKEY_CLASSES_ROOT",
        _ => return Err("Unsupported registry hive".into()),
    };
    let sub = parts[1..].join("\\").to_lowercase();
    let blocked = [
        "environment",
        "volatile environment",
        "system",
        "control panel",
        "console",
        "network",
        "printers",
        "sessioninformation",
        "software\\classes",
        "software\\policies",
        "software\\microsoft\\windows",
        "software\\microsoft\\windows nt",
        "software\\microsoft\\internet explorer",
        "software\\microsoft\\office",
        "software\\microsoft\\onedrive",
        "software\\microsoft\\powershell",
    ];
    if sub == "software\\microsoft"
        || blocked
            .iter()
            .any(|b| sub == *b || sub.starts_with(&format!("{b}\\")))
        || (hive == "HKEY_LOCAL_MACHINE" && !sub.starts_with("software\\"))
        || (hive == "HKEY_CLASSES_ROOT" && !sub.starts_with("virtualstore\\machine\\software\\"))
    {
        return Err("Registry key targets protected operating-system configuration".into());
    }
    Ok(format!("{hive}\\{}", parts[1..].join("\\")))
}
pub fn exists(key: &str) -> bool {
    #[cfg(windows)]
    {
        let Ok(normalized) = normalize(key) else {
            return false;
        };
        let Some((hive, subkey)) = normalized.split_once('\\') else {
            return false;
        };
        let hive = match hive {
            "HKEY_CURRENT_USER" => winreg::enums::HKEY_CURRENT_USER,
            "HKEY_LOCAL_MACHINE" => winreg::enums::HKEY_LOCAL_MACHINE,
            "HKEY_CLASSES_ROOT" => winreg::enums::HKEY_CLASSES_ROOT,
            _ => return false,
        };
        // No WOW64 override: use the current process view, matching reg.exe's
        // default view. Keep read-only access and collapse missing/denied keys
        // to false, as the former query subprocess did.
        winreg::RegKey::predef(hive)
            .open_subkey_with_flags(subkey, winreg::enums::KEY_READ)
            .is_ok()
    }
    #[cfg(not(windows))]
    {
        let _ = key;
        false
    }
}
pub fn expand(pattern: &str) -> Result<Vec<String>> {
    if !cfg!(windows) {
        return Ok(vec![]);
    }
    let p = pattern.replace('/', "\\");
    let segments: Vec<_> = p.split('\\').collect();
    let mut paths = vec![segments.first().unwrap_or(&"").to_string()];
    for segment in &segments[1..] {
        let mut next = vec![];
        for parent in paths {
            if segment.contains('*') {
                if let Ok(out) = command(&["query", &parent]) {
                    let matcher = glob::Pattern::new(segment).map_err(fs::err)?;
                    for line in String::from_utf8_lossy(&out.stdout).lines() {
                        let child = line.trim();
                        if let Some(name) = child.strip_prefix(&(parent.clone() + "\\")) {
                            if !name.contains('\\') && matcher.matches(name) {
                                next.push(child.into());
                            }
                        }
                    }
                }
            } else {
                next.push(format!("{parent}\\{segment}"));
            }
            if next.len() > 1000 {
                return Err("Too many registry matches".into());
            }
        }
        paths = next;
    }
    Ok(paths.into_iter().filter(|p| exists(p)).collect())
}
pub fn export(key: &str, path: &Path) -> Result<()> {
    command(&["export", &normalize(key)?, &path.to_string_lossy(), "/y"])?;
    Ok(())
}
pub fn import(path: &Path) -> Result<()> {
    command(&["import", &path.to_string_lossy()])?;
    Ok(())
}
pub fn delete(key: &str) -> Result<()> {
    command(&["delete", &normalize(key)?, "/f"])?;
    Ok(())
}
pub fn validate_payload(path: &Path, destination: &str) -> Result<()> {
    let m = fs::regular(path)?;
    if !m.is_file() || m.len() > 10 * 1024 * 1024 {
        return Err("Invalid registry backup file".into());
    }
    let bytes = std::fs::read(path).map_err(fs::err)?;
    let text = if bytes.starts_with(&[255, 254]) {
        String::from_utf16(
            &bytes[2..]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|x| u16::from_le_bytes([x[0], x[1]]))
                .collect::<Vec<_>>(),
        )
        .map_err(fs::err)?
    } else {
        String::from_utf8(bytes).map_err(fs::err)?
    };
    let expected = normalize(destination)?.to_lowercase();
    let mut count = 0;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            count += 1;
            if !line.ends_with(']') || line.starts_with("[-") {
                return Err("Registry backup contains unsafe key headers".into());
            }
            let key = normalize(&line[1..line.len() - 1])?.to_lowercase();
            if key != expected && !key.starts_with(&(expected.clone() + "\\")) {
                return Err("Registry payload targets another key".into());
            }
        }
    }
    if count == 0 {
        return Err("Registry backup has no key headers".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn native_exists_matches_query_in_the_default_view_for_isolated_keys() {
        struct ScopedKey(String);
        impl Drop for ScopedKey {
            fn drop(&mut self) {
                let _ = delete(&self.0);
            }
        }
        let subkey = format!("Software\\OpenGameSave-RustTest-{}", uuid::Uuid::new_v4());
        let scope = ScopedKey(format!("HKEY_CURRENT_USER\\{subkey}"));
        normalize(&scope.0).unwrap();
        assert!(!exists(&scope.0));
        let (key, _) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .create_subkey(&subkey)
            .unwrap();
        key.set_value("Unicode", &"原始存档").unwrap();
        key.create_subkey("EmptyChild").unwrap();
        for path in [
            scope.0.clone(),
            format!("{}\\EmptyChild", scope.0),
            format!("{}\\MissingChild", scope.0),
        ] {
            assert_eq!(exists(&path), command(&["query", &path]).is_ok(), "{path}");
        }
        assert!(exists(&format!("HKCU\\{subkey}")));
        assert!(exists(&scope.0.replace('\\', "/")));
        assert!(!exists("HKCU\\Software\\Microsoft\\Windows"));
        assert!(!exists("HKCU\\Software\\..\\Escape"));
    }
    #[test]
    fn protected_registry_keys_are_blocked() {
        assert!(normalize("HKCU/Software/GameStudio/Game").is_ok());
        assert!(normalize("HKCU/Software/Microsoft/Windows/CurrentVersion/Run").is_err());
        assert!(normalize("HKLM/SYSTEM/CurrentControlSet").is_err());
    }
}
