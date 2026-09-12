use super::fs::{self, Result};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};
pub fn wiki(value: &Value) -> Result<String> {
    let v = if let Some(s) = value.as_str() {
        s.to_owned()
    } else if let Some(n) = value.as_u64() {
        n.to_string()
    } else {
        return Err("Invalid game identifier".into());
    };
    if v.is_empty()
        || v.len() > 128
        || !v
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err("Invalid game identifier".into());
    }
    Ok(v)
}
pub fn date(value: &str) -> Result<String> {
    let format = if value.len() == 19 {
        "%Y-%m-%d_%H-%M-%S"
    } else if value.len() == 16 {
        "%Y-%m-%d_%H-%M"
    } else {
        return Err("Invalid backup date".into());
    };
    let parsed = if value.len() == 16 {
        chrono::NaiveDateTime::parse_from_str(&format!("{value}-00"), "%Y-%m-%d_%H-%M-%S")
            .map_err(fs::err)?
    } else {
        chrono::NaiveDateTime::parse_from_str(value, format).map_err(fs::err)?
    };
    if parsed.format(format).to_string() != value
        || parsed.and_utc().timestamp_subsec_nanos() >= 1_000_000_000
    {
        return Err("Noncanonical backup date".into());
    }
    Ok(value.into())
}
fn text(v: &Value, max: usize, required: bool) -> Result<String> {
    let s = if v.is_null() && !required {
        ""
    } else {
        v.as_str().ok_or("Expected text")?
    }
    .trim();
    if s.encode_utf16().count() > max || (required && s.is_empty()) || s.contains('\0') {
        return Err("Invalid metadata text".into());
    }
    Ok(s.into())
}
pub fn validate(v: &Value) -> Result<Value> {
    let paths = v["backup_paths"]
        .as_array()
        .ok_or("Invalid backup path list")?;
    if paths.len() > 128 {
        return Err("Too many backup paths".into());
    }
    let mut seen = HashSet::new();
    let mut items = vec![];
    for p in paths {
        let name = p["folder_name"].as_str().ok_or("Invalid backup folder")?;
        let suffix = name.strip_prefix("path").ok_or("Invalid backup folder")?;
        if suffix.is_empty()
            || suffix.len() > 4
            || suffix.starts_with('0')
            || !suffix.bytes().all(|c| c.is_ascii_digit())
            || !seen.insert(name)
        {
            return Err("Invalid or duplicate backup folder".into());
        }
        let kind = p["type"].as_str().unwrap_or("");
        if !["file", "folder", "reg"].contains(&kind) {
            return Err("Unknown backup type".into());
        }
        items.push(json!({"folder_name":name,"template":text(&p["template"],32767,true)?,"type":kind,"install_folder":if p["install_folder"].is_null(){Value::Null}else{json!(text(&p["install_folder"],512,false)? )}}));
    }
    Ok(
        json!({"title":text(&v["title"],512,true)?,"zh_CN":if v["zh_CN"].is_null(){Value::Null}else{json!(text(&v["zh_CN"],512,false)?)},"backup_paths":items,"provenance":if v["provenance"]=="local"{"local"}else{"external"},"is_permanent":v["is_permanent"]==true,"custom_name":text(&v["custom_name"],120,false)?}),
    )
}
pub fn load(path: &Path) -> Result<Value> {
    validate(&fs::read_json(&path.join("backup_info.json"), 1024 * 1024)?)
}
pub fn root(settings: &Value) -> Result<PathBuf> {
    let path = PathBuf::from(
        settings["backupPath"]
            .as_str()
            .ok_or("Missing backup path")?,
    );
    fs::absolute(&path)?;
    fs::no_links(&path)?;
    Ok(path)
}
pub fn snapshot(root: &Path, id: &Value, when: Option<&str>) -> Result<PathBuf> {
    let mut result = root.join(wiki(id)?);
    if let Some(d) = when {
        result.push(date(d)?);
    }
    fs::no_links(&result)?;
    Ok(result)
}
pub fn display_date(s: &str) -> String {
    let s = if s.len() == 16 {
        format!("{s}-00")
    } else {
        s.into()
    };
    chrono::NaiveDateTime::parse_from_str(&s, "%Y-%m-%d_%H-%M-%S")
        .map(|v| v.format("%Y/%m/%d %H:%M:%S").to_string())
        .unwrap_or(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_traversal_and_invalid_dates() {
        assert!(wiki(&json!("../bad")).is_err());
        assert!(date("2025-02-31_10-00").is_err());
        assert!(date("2025-02-28_10-00").is_ok());
    }
    #[test]
    fn old_metadata_is_external() {
        let m = validate(&json!({"title":"Game","backup_paths":[]})).unwrap();
        assert_eq!(m["provenance"], "external");
    }
}
