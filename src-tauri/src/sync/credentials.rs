use super::{
    manifest,
    util::{self, err, Result},
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

static PROVIDER_LOCK: Mutex<()> = Mutex::new(());
const SERVICE: &str = "OpenGameSave.WebDAV";
const REENTER: &str = "Re-enter the WebDAV password in sync settings to migrate its encrypted credential to this operating-system account";

#[derive(Clone)]
pub struct Config {
    pub url: String,
    pub username: String,
    pub remote_path: String,
    pub device_id: String,
    pub password: String,
    pub has_password: bool,
    pub needs_password: bool,
}
impl Config {
    pub fn require_ready(self) -> Result<Self> {
        if self.url.is_empty() {
            return Err("Configure WebDAV before synchronization".into());
        }
        if self.needs_password {
            return Err(REENTER.into());
        }
        if self.username.is_empty() != self.password.is_empty() {
            return Err(
                "WebDAV username and password must both be provided or both be empty".into(),
            );
        }
        Ok(self)
    }
    pub fn public(&self) -> Value {
        json!({"url":self.url,"username":self.username,"remotePath":self.remote_path,
        "hasPassword":self.has_password,"needsPassword":self.needs_password})
    }
}
pub fn normalize_url(value: &str) -> Result<String> {
    if value.is_empty() {
        return Ok(String::new());
    }
    if value.encode_utf16().count() > 2048 || value.chars().any(|c| c < ' ') {
        return Err("Invalid WebDAV URL".into());
    }
    let url = url::Url::parse(value.trim()).map_err(|_| "Invalid WebDAV URL".to_owned())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err(
            "WebDAV requires an HTTPS URL without embedded credentials, query or fragment".into(),
        );
    }
    Ok(url.as_str().trim_end_matches('/').into())
}
pub fn normalize_remote(value: &str) -> Result<String> {
    if value.is_empty() || value.encode_utf16().count() > 1024 || value.chars().any(|c| c < ' ') {
        return Err("Invalid WebDAV remote path".into());
    }
    let normalized = value.trim().replace('\\', "/");
    let segments = normalized
        .split('/')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    if segments.is_empty() || segments.iter().any(|s| matches!(*s, "." | "..")) {
        return Err("WebDAV remote path must be a dedicated subdirectory".into());
    }
    Ok(format!("/{}", segments.join("/")))
}
fn normalize_username(value: &str) -> Result<String> {
    if value.encode_utf16().count() > 512 || value.chars().any(|c| c < ' ') {
        return Err("Invalid WebDAV username".into());
    }
    Ok(value.trim().into())
}
fn provider_path(app_data: &Path) -> PathBuf {
    app_data.join("OGS Settings/webdav-provider.json")
}
fn entry(app_data: &Path, generation: &str) -> Result<keyring::Entry> {
    let account = format!(
        "{}:{generation}",
        util::hash(app_data.to_string_lossy().as_bytes())
    );
    keyring::Entry::new(SERVICE, &account)
        .map_err(|_| "Secure operating-system credential storage is unavailable".into())
}
fn fallback(settings: &Value) -> Result<Config> {
    Ok(Config {
        url: normalize_url(settings["webdavUrl"].as_str().unwrap_or(""))?,
        username: normalize_username(settings["webdavUsername"].as_str().unwrap_or(""))?,
        remote_path: normalize_remote(
            settings["webdavRemotePath"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("/OpenGameSave"),
        )?,
        device_id: Uuid::new_v4().to_string(),
        password: String::new(),
        has_password: false,
        needs_password: false,
    })
}
fn load_unlocked(app_data: &Path, settings: &Value) -> Result<Config> {
    let path = provider_path(app_data);
    let mut config = fallback(settings)?;
    if !path.exists() {
        let legacy = app_data.join("OGS Settings/webdav-credentials.json");
        if legacy.exists() {
            let record = util::read_json(&legacy, 128 * 1024)?;
            config.has_password = record["encryptedPassword"]
                .as_str()
                .is_some_and(|s| !s.is_empty());
            if config.has_password {
                match decrypt_legacy(record["encryptedPassword"].as_str().unwrap()) {
                    Ok(password) => {
                        config.password = password;
                        persist(app_data, &config)?;
                    }
                    Err(_) => config.needs_password = true,
                }
            }
        }
        if !config.has_password {
            persist(app_data, &config)?;
        }
        return Ok(config);
    }
    let record = util::read_json(&path, 128 * 1024)?;
    let version = record["version"]
        .as_u64()
        .ok_or("Invalid WebDAV provider version")?;
    if !matches!(version, 2 | 3) {
        return Err("Unsupported WebDAV provider version".into());
    }
    config.url = normalize_url(
        record["url"]
            .as_str()
            .ok_or("Invalid WebDAV provider URL")?,
    )?;
    config.username = normalize_username(
        record["username"]
            .as_str()
            .ok_or("Invalid WebDAV provider username")?,
    )?;
    config.remote_path = normalize_remote(
        record["remotePath"]
            .as_str()
            .ok_or("Invalid WebDAV provider path")?,
    )?;
    config.device_id = record["deviceId"]
        .as_str()
        .ok_or("Missing WebDAV device id")?
        .into();
    manifest::revision(&config.device_id)?;
    let generation = record["generation"]
        .as_str()
        .ok_or("Missing credential generation")?;
    manifest::revision(generation)?;
    config.has_password = record["hasPassword"]
        .as_bool()
        .ok_or("Invalid credential marker")?;
    if config.has_password {
        let password = if version == 3 {
            entry(app_data, generation)?
                .get_password()
                .map_err(|_| REENTER.to_owned())
        } else {
            decrypt_legacy(
                record["encryptedPassword"]
                    .as_str()
                    .ok_or("Missing encrypted password")?,
            )
        };
        match password {
            Ok(password) => {
                config.password = password;
                if version == 2 {
                    persist(app_data, &config)?;
                }
            }
            Err(_) => config.needs_password = true,
        }
    }
    Ok(config)
}
pub fn load(app_data: &Path, settings: &Value) -> Result<Config> {
    let _guard = PROVIDER_LOCK.lock().map_err(err)?;
    load_unlocked(app_data, settings)
}
pub fn require(app_data: &Path, settings: &Value) -> Result<Config> {
    load(app_data, settings)?.require_ready()
}
pub fn public_config(app_data: &Path, settings: &Value) -> Result<Value> {
    Ok(load(app_data, settings)?.public())
}
fn persist(app_data: &Path, config: &Config) -> Result<()> {
    let generation = Uuid::new_v4().to_string();
    let path = provider_path(app_data);
    let old = if path.exists() {
        util::read_json(&path, 128 * 1024).ok()
    } else {
        None
    };
    let credential = entry(app_data, &generation)?;
    if !config.password.is_empty() {
        credential.set_password(&config.password).map_err(|_| {
            "Cannot save WebDAV password in secure operating-system credential storage".to_owned()
        })?;
    }
    let record = json!({"version":3,"generation":generation,"deviceId":config.device_id,"url":config.url,"username":config.username,
        "remotePath":config.remote_path,"hasPassword":!config.password.is_empty(),"credentialStore":"operating-system"});
    if let Err(error) = util::atomic_json(&path, &record) {
        if !config.password.is_empty() {
            let _ = credential.delete_credential();
        }
        return Err(error);
    }
    if let Some(old) = old {
        if old["version"] == 3 && old["hasPassword"] == true {
            if let Some(generation) = old["generation"].as_str() {
                if let Ok(old_entry) = entry(app_data, generation) {
                    let _ = old_entry.delete_credential();
                }
            }
        }
    }
    Ok(())
}
pub fn save_config(app_data: &Path, settings: &Value, input: &Value) -> Result<Value> {
    let _guard = PROVIDER_LOCK.lock().map_err(err)?;
    let mut current = load_unlocked(app_data, settings)?;
    current.url = normalize_url(input["url"].as_str().unwrap_or(""))?;
    current.username = normalize_username(input["username"].as_str().unwrap_or(""))?;
    current.remote_path = normalize_remote(
        input["remotePath"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("/OpenGameSave"),
    )?;
    if let Some(password) = input.get("password") {
        let password = password.as_str().ok_or("Invalid WebDAV password")?;
        if password.encode_utf16().count() > 4096 || password.contains('\0') {
            return Err("Invalid WebDAV password".into());
        }
        current.password = password.into();
        current.needs_password = false;
    } else if current.url.is_empty() && current.username.is_empty() {
        current.password.clear();
        current.needs_password = false;
    }
    if current.needs_password {
        return Err(REENTER.into());
    }
    if current.username.is_empty() != current.password.is_empty() {
        return Err("WebDAV username and password must both be provided or both be empty".into());
    }
    if current.url.is_empty() && !current.username.is_empty() {
        return Err("A WebDAV URL is required when credentials are configured".into());
    }
    current.has_password = !current.password.is_empty();
    persist(app_data, &current)?;
    Ok(current.public())
}

#[cfg(not(windows))]
fn decrypt_legacy(_encoded: &str) -> Result<String> {
    Err(REENTER.into())
}

#[cfg(windows)]
fn decrypt_legacy(encoded: &str) -> Result<String> {
    use base64::Engine;
    use std::ffi::c_void;
    #[repr(C)]
    struct Blob {
        size: u32,
        data: *mut u8,
    }
    #[link(name = "Crypt32")]
    extern "system" {
        fn CryptUnprotectData(
            input: *mut Blob,
            description: *mut *mut u16,
            entropy: *mut Blob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
    }
    #[link(name = "Kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }
    let mut bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| REENTER.to_owned())?;
    if bytes.len() > 128 * 1024 {
        return Err(REENTER.into());
    }
    let mut input = Blob {
        size: bytes.len() as u32,
        data: bytes.as_mut_ptr(),
    };
    let mut output = Blob {
        size: 0,
        data: std::ptr::null_mut(),
    };
    // Chromium's Windows safeStorage uses DPAPI scoped to the signed-in account.
    // An incompatible envelope remains on disk and requests one password re-entry.
    unsafe {
        if CryptUnprotectData(
            &mut input,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            1,
            &mut output,
        ) == 0
        {
            return Err(REENTER.into());
        }
        let result = String::from_utf8(
            std::slice::from_raw_parts(output.data, output.size as usize).to_vec(),
        )
        .map_err(|_| REENTER.to_owned());
        std::ptr::write_bytes(output.data, 0, output.size as usize);
        LocalFree(output.data.cast());
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoints_never_send_credentials_in_cleartext() {
        for url in [
            "http://localhost/dav",
            "https://u:p@example.com",
            "https://example.com/?token=a",
            "https://example.com/#fragment",
        ] {
            assert!(normalize_url(url).is_err());
        }
        assert_eq!(
            normalize_url("https://example.com/dav/").unwrap(),
            "https://example.com/dav"
        );
        assert!(normalize_remote("/").is_err());
        assert!(normalize_remote("/a/../b").is_err());
    }
}
