use crate::state::AppState;
use serde_json::{json, Value};
use tauri_plugin_updater::UpdaterExt;

pub fn allowed_external_url(value: &str) -> bool {
    url::Url::parse(value)
        .map(|url| {
            value.len() <= 2048
                && url.scheme() == "https"
                && url.username().is_empty()
                && url.password().is_none()
                && url.port().map(|p| p == 443).unwrap_or(true)
                && matches!(
                    url.host_str(),
                    Some(
                        "github.com"
                            | "www.gnu.org"
                            | "www.pcgamingwiki.com"
                            | "pcgamingwiki.com"
                            | "liquipedia.net"
                            | "overlab.cn"
                            | "ow.blizzard.cn"
                    )
                )
        })
        .unwrap_or(false)
}

pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (
        semver::Version::parse(candidate.trim_start_matches('v')),
        semver::Version::parse(current.trim_start_matches('v')),
    ) {
        (Ok(candidate), Ok(current)) => candidate > current,
        _ => false,
    }
}

fn publish(state: &AppState, changes: Value) -> Value {
    let mut guard = state.update_state.lock().unwrap();
    if let Some(changes) = changes.as_object() {
        for (k, v) in changes {
            guard[k] = v.clone();
        }
    }
    let value = guard.clone();
    drop(guard);
    state.emit("app-update-state", json!([value]));
    value
}

pub async fn check(state: &AppState) -> Result<Value, String> {
    publish(state, json!({"status":"checking","error":null}));
    let prerelease = state.settings()["appUpdatePrerelease"] == true;
    let result=async {
        let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).user_agent("OpenGameSave").build().map_err(|e|e.to_string())?;
        let mut response=client.get("https://api.github.com/repos/leisurefire/OpenGameSave/releases?per_page=100").send().await.map_err(|e|e.to_string())?.error_for_status().map_err(|e|e.to_string())?;
        if response.content_length().unwrap_or(0)>4*1024*1024 {return Err("Release response too large".into());}
        let mut bytes=Vec::new();
        while let Some(chunk)=response.chunk().await.map_err(|e|e.to_string())? {
            if bytes.len()+chunk.len()>4*1024*1024 {return Err("Release response too large".into());}
            bytes.extend_from_slice(&chunk);
        }
        let releases:Value=serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;
        let mut candidates:Vec<_>=releases.as_array().ok_or("Invalid releases response")?.iter().filter(|r|r["draft"]==false && (prerelease || r["prerelease"]==false))
            .filter_map(|r|semver::Version::parse(r["tag_name"].as_str()?.trim_start_matches('v')).ok().map(|v|(v,r))).collect();
        candidates.sort_by(|a,b|b.0.cmp(&a.0));
        let (version,release)=candidates.first().ok_or("No application releases found")?;
        let available=is_newer(&version.to_string(),env!("CARGO_PKG_VERSION"));
        let release_url=release["html_url"].as_str().filter(|u|u.starts_with("https://github.com/leisurefire/OpenGameSave/releases/tag/")).ok_or("Invalid release URL")?;
        let has_manifest=release["assets"].as_array().map(|a|a.iter().any(|a|a["name"]=="latest.json")).unwrap_or(false);
        publish(state,json!({"status":if available {"available"} else {"up-to-date"},"availableVersion":if available {json!(version.to_string())}else{Value::Null},
            "releaseUrl":release_url,"fallbackAvailable":true,"canAutoUpdate":has_manifest && option_env!("OGS_UPDATER_PUBLIC_KEY").is_some(),"tag":release["tag_name"]}));
        Ok(json!(version.to_string()))
    }.await;
    if let Err(error) = &result {
        publish(
            state,
            json!({"status":"error","error":error,"fallbackAvailable":true}),
        );
    }
    result
}

pub async fn download(state: &AppState) -> Result<Value, String> {
    if state.update_state.lock().unwrap()["status"] != "available" {
        check(state).await?;
    }
    let current = state.update_state.lock().unwrap().clone();
    let release_url = current["releaseUrl"]
        .as_str()
        .unwrap_or("https://github.com/leisurefire/OpenGameSave/releases");
    let public_key = option_env!("OGS_UPDATER_PUBLIC_KEY").filter(|k| !k.trim().is_empty());
    if public_key.is_none() || current["canAutoUpdate"] != true {
        crate::platform::open_url(release_url)?;
        let mut result = current;
        result["fallbackOpened"] = json!(true);
        return Ok(result);
    }
    let _guard = state.operation.try_lock().map_err(|_| "app-busy")?;
    let tag = current["tag"]
        .as_str()
        .filter(|t| {
            t.bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-'))
        })
        .ok_or("Invalid update tag")?;
    let endpoint = url::Url::parse(&format!(
        "https://github.com/leisurefire/OpenGameSave/releases/download/{tag}/latest.json"
    ))
    .map_err(|e| e.to_string())?;
    state.set_status("updating_app", true);
    let result=async {
        let updater=state.app.updater_builder().pubkey(public_key.unwrap()).endpoints(vec![endpoint]).map_err(|e|e.to_string())?.build().map_err(|e|e.to_string())?;
        let update=updater.check().await.map_err(|e|e.to_string())?.ok_or("No signed update available")?;
        if current["availableVersion"]!=update.version {return Err("Update manifest version differs from selected release".into());}
        let download_url=update.download_url.as_str();
        if !download_url.starts_with(&format!("https://github.com/leisurefire/OpenGameSave/releases/download/{tag}/")) {return Err("Update download URL differs from selected release".into());}
        publish(state,json!({"status":"downloading","transferred":0,"percent":0}));
        let mut transferred=0u64;
        update.download_and_install(|chunk,total|{
            transferred+=chunk as u64;
            publish(state,json!({"transferred":transferred,"total":total,"percent":total.filter(|n|*n>0).map(|total|100.*transferred as f64/total as f64).unwrap_or(0.)}));
        },||{publish(state,json!({"status":"installing","percent":100}));}).await.map_err(|e|e.to_string())?;
        Ok(publish(state,json!({"status":"downloaded","percent":100})))
    }.await;
    state.set_status("updating_app", false);
    if let Err(error) = &result {
        publish(
            state,
            json!({"status":"error","error":error,"fallbackAvailable":true}),
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_and_url_boundaries() {
        assert!(is_newer("v1.1.0", "1.0.9"));
        assert!(!is_newer("v1.1.0-beta.1", "1.1.0"));
        assert!(!is_newer("db-v100", "0.7.3"));
        assert!(allowed_external_url(
            "https://www.pcgamingwiki.com/?curid=123"
        ));
        assert!(!allowed_external_url("https://github.com.evil.invalid/"));
        assert!(!allowed_external_url("javascript:alert(1)"));
        assert!(!allowed_external_url("https://name:password@github.com/"));
    }
}
