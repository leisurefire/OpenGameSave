use std::{path::Path, process::Command};

pub fn command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

pub fn open_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || !path.exists() {
        return Err("Path does not exist".into());
    }
    #[cfg(windows)]
    let result = command("explorer.exe").arg(path).spawn();
    #[cfg(target_os = "macos")]
    let result = command("open").arg(path).spawn();
    #[cfg(target_os = "linux")]
    let result = command("xdg-open").arg(path).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

pub fn open_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
    if url.len() > 2048 || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Blocked URL".into());
    }
    #[cfg(windows)]
    let result = command("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", parsed.as_str()])
        .spawn();
    #[cfg(target_os = "macos")]
    let result = command("open").arg(parsed.as_str()).spawn();
    #[cfg(target_os = "linux")]
    let result = command("xdg-open").arg(parsed.as_str()).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

pub fn set_autostart(enabled: bool) -> Result<(), String> {
    if cfg!(debug_assertions) || std::env::var_os("OGS_DATA_DIR").is_some() {
        return Ok(());
    }
    #[cfg(windows)]
    {
        let key = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
            .map_err(|e| e.to_string())?
            .0;
        if enabled {
            let executable = std::env::current_exe().map_err(|e| e.to_string())?;
            key.set_value("OpenGameSave", &format!("\"{}\"", executable.display()))
                .map_err(|e| e.to_string())?;
        } else if let Err(e) = key.delete_value("OpenGameSave") {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(e.to_string());
            }
        }
    }
    #[cfg(not(windows))]
    {
        if enabled {
            return Err("Autostart is supported by the Windows distribution".into());
        }
    }
    Ok(())
}

pub fn accent_color() -> String {
    #[cfg(windows)]
    {
        if let Ok(key) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .open_subkey("Software\\Microsoft\\Windows\\DWM")
        {
            if let Ok(value) = key.get_value::<u32, _>("ColorizationColor") {
                return format!("#{:06x}", value & 0x00ffffff);
            }
        }
    }
    "#16c60c".into()
}
