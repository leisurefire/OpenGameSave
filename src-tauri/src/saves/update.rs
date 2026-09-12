use super::{
    database,
    fs::{self, Result},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self as disk, OpenOptions},
    io::{Read, Write},
    path::Path,
    time::Duration,
};
const MAX_DB: u64 = 256 * 1024 * 1024;
#[derive(Serialize)]
struct SchemaRow {
    r#type: String,
    name: String,
    tbl_name: String,
    sql: Option<String>,
}
pub fn validate(
    path: &Path,
    version: Option<u64>,
    schema: Option<&str>,
    variant: Option<&str>,
) -> Result<Value> {
    let m = fs::regular(path)?;
    if !m.is_file() || m.len() == 0 || m.len() > MAX_DB {
        return Err("Invalid database size".into());
    }
    let c = database::open(path)?;
    let integrity: String = c
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(fs::err)?;
    if integrity != "ok" {
        return Err("Database integrity check failed".into());
    }
    for (table, columns) in [
        (
            "games",
            vec![
                "wiki_page_id",
                "title",
                "zh_CN",
                "install_folder",
                "steam_id",
                "gog_id",
                "platform",
                "save_location",
            ],
        ),
        ("metadata", vec!["key", "value"]),
    ] {
        let mut stmt = c
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(fs::err)?;
        let names = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(fs::err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(fs::err)?;
        if columns.iter().any(|s| !names.iter().any(|n| n == s)) {
            return Err("Database is missing required columns".into());
        }
    }
    let mut stmt=c.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").map_err(fs::err)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(SchemaRow {
                r#type: r.get(0)?,
                name: r.get(1)?,
                tbl_name: r.get(2)?,
                sql: r.get(3)?,
            })
        })
        .map_err(fs::err)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(fs::err)?;
    if rows
        .iter()
        .any(|r| r.r#type == "trigger" || r.r#type == "view")
    {
        return Err("Unexpected database executable schema objects".into());
    }
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&rows).map_err(fs::err)?)
    );
    let current: u64 = c
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(fs::err)?;
    let current_variant = c
        .query_row(
            "SELECT value FROM metadata WHERE key='database_variant'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(fs::err)?
        .unwrap_or_else(|| "standard".into());
    if !["standard", "xbox"].contains(&current_variant.as_str())
        || version.is_some_and(|v| v != current)
        || schema.is_some_and(|v| v != digest)
        || variant.is_some_and(|v| v != current_variant)
    {
        return Err("Database version, schema, or variant does not match the manifest".into());
    }
    Ok(json!({"version":current,"schemaVersion":digest,"variant":current_variant}))
}
fn digest(raw: &str) -> Result<String> {
    let value = raw.strip_prefix("sha256:").unwrap_or(raw).to_lowercase();
    if value.len() != 64 || !value.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Missing or invalid SHA-256 digest".into());
    }
    Ok(value)
}
fn read_response(mut response: reqwest::blocking::Response, max: u64) -> Result<Vec<u8>> {
    if !response.status().is_success() {
        return Err(format!("Database server returned {}", response.status()));
    }
    if response.content_length().is_some_and(|n| n > max) {
        return Err("Download exceeds size limit".into());
    }
    let mut bytes = vec![];
    response
        .by_ref()
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(fs::err)?;
    if bytes.len() as u64 > max {
        return Err("Download exceeds size limit".into());
    }
    Ok(bytes)
}
fn asset<'a>(assets: &'a [Value], name: &str) -> Result<&'a Value> {
    let matching: Vec<_> = assets.iter().filter(|a| a["name"] == name).collect();
    if matching.len() != 1 {
        return Err(format!("Release asset is missing or ambiguous: {name}"));
    }
    Ok(matching[0])
}
fn download(
    client: &reqwest::blocking::Client,
    assets: &[Value],
    descriptor: &Value,
    max: u64,
) -> Result<Vec<u8>> {
    let name = descriptor["name"].as_str().ok_or("Missing asset name")?;
    let expected_size = descriptor["size"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= max)
        .ok_or("Invalid asset size")?;
    let expected_hash = digest(
        descriptor["sha256"]
            .as_str()
            .ok_or("Missing asset SHA-256")?,
    )?;
    let a = asset(assets, name)?;
    if a["size"].as_u64() != Some(expected_size) {
        return Err("Release and manifest asset sizes disagree".into());
    }
    if let Some(hash) = a["digest"].as_str() {
        if digest(hash)? != expected_hash {
            return Err("Release and manifest digests disagree".into());
        }
    }
    let url = reqwest::Url::parse(
        a["browser_download_url"]
            .as_str()
            .ok_or("Missing asset download URL")?,
    )
    .map_err(fs::err)?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !url
            .path()
            .starts_with("/leisurefire/OpenGameSave/releases/download/")
    {
        return Err("Untrusted database release asset URL".into());
    }
    let data = read_response(client.get(url).send().map_err(fs::err)?, max)?;
    if data.len() as u64 != expected_size || format!("{:x}", Sha256::digest(&data)) != expected_hash
    {
        return Err(format!("Asset failed SHA-256 verification: {name}"));
    }
    Ok(data)
}
fn json_download(
    client: &reqwest::blocking::Client,
    assets: &[Value],
    descriptor: &Value,
    max: u64,
) -> Result<Value> {
    serde_json::from_slice(&download(client, assets, descriptor, max)?).map_err(fs::err)
}
fn number(value: &Value) -> Result<i64> {
    value
        .as_i64()
        .filter(|v| *v >= 0)
        .ok_or_else(|| "Invalid database integer".into())
}
fn dbtext(value: &Value, max: usize, required: bool) -> Result<Option<String>> {
    if value.is_null() && !required {
        return Ok(None);
    }
    let s = value.as_str().ok_or("Invalid database text")?;
    if s.len() > max || (required && s.trim().is_empty()) || s.contains('\0') {
        return Err("Invalid database text length".into());
    }
    Ok(Some(s.into()))
}
pub fn patch(path: &Path, raw: &Value, from: u64, to: u64, variant: &str) -> Result<()> {
    if raw["version"].as_u64() != Some(to)
        || raw["from_version"].as_u64() != Some(from)
        || to != from + 1
        || raw["variant"].as_str().unwrap_or("standard") != variant
    {
        return Err("Database patch version or variant mismatch".into());
    }
    let names = ["upsert", "delete", "metadata_upsert", "metadata_delete"];
    let empty = vec![];
    let mut count = 0;
    for name in names {
        if !raw[name].is_null() && !raw[name].is_array() {
            return Err("Invalid patch row list".into());
        }
        count += raw[name].as_array().map(Vec::len).unwrap_or(0);
    }
    if count > 100000 {
        return Err("Too many database patch rows".into());
    }
    let mut c = Connection::open(path).map_err(fs::err)?;
    c.pragma_update(None, "trusted_schema", false)
        .map_err(fs::err)?;
    let current: u64 = c
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(fs::err)?;
    if current != from {
        return Err("Patch source does not match staged database".into());
    }
    let tx = c.transaction().map_err(fs::err)?;
    for row in raw["upsert"].as_array().unwrap_or(&empty) {
        let id = number(&row["wiki_page_id"])?;
        let title = dbtext(&row["title"], 512, true)?;
        let chinese = dbtext(&row["zh_CN"], 512, false)?;
        let folder = dbtext(&row["install_folder"], 1024, false)?;
        let steam = if row["steam_id"].is_null() {
            None
        } else {
            Some(number(&row["steam_id"])?)
        };
        let gog = if row["gog_id"].is_null() {
            None
        } else {
            Some(number(&row["gog_id"])?)
        };
        let platform = dbtext(&row["platform"], 256, false)?;
        let saves = dbtext(&row["save_location"], 1024 * 1024, true)?.ok_or("Missing saves")?;
        let saves_value: Value = serde_json::from_str(&saves).map_err(fs::err)?;
        if !saves_value.is_object() {
            return Err("Invalid save-location JSON".into());
        }
        for key in ["win", "linux", "mac", "reg"] {
            if let Some(locations) = saves_value.get(key) {
                let locations = locations
                    .as_array()
                    .ok_or("Invalid platform save locations")?;
                if locations.len() > 128
                    || locations.iter().any(|v| {
                        v.as_str()
                            .is_none_or(|s| s.is_empty() || s.len() > 32767 || s.contains('\0'))
                    })
                {
                    return Err("Invalid platform save template".into());
                }
            }
        }
        tx.execute("INSERT OR REPLACE INTO games (wiki_page_id,title,zh_CN,install_folder,steam_id,gog_id,platform,save_location) VALUES (?,?,?,?,?,?,?,?)",params![id,title,chinese,folder,steam,gog,platform,saves]).map_err(fs::err)?;
    }
    for id in raw["delete"].as_array().unwrap_or(&empty) {
        tx.execute("DELETE FROM games WHERE wiki_page_id=?", [number(id)?])
            .map_err(fs::err)?;
    }
    for row in raw["metadata_upsert"].as_array().unwrap_or(&empty) {
        tx.execute(
            "INSERT OR REPLACE INTO metadata (key,value) VALUES (?,?)",
            params![
                dbtext(&row["key"], 256, true)?,
                dbtext(&row["value"], 4096, false)?
            ],
        )
        .map_err(fs::err)?;
    }
    for key in raw["metadata_delete"].as_array().unwrap_or(&empty) {
        tx.execute(
            "DELETE FROM metadata WHERE key=?",
            [dbtext(key, 256, true)?],
        )
        .map_err(fs::err)?;
    }
    tx.pragma_update(None, "user_version", to)
        .map_err(fs::err)?;
    tx.commit().map_err(fs::err)
}
pub fn recover(path: &Path) -> Result<()> {
    let previous = path.with_extension("db.previous");
    if !path.exists() && previous.exists() {
        validate(&previous, None, None, None)?;
        disk::rename(&previous, path).map_err(fs::err)?;
    } else if path.exists() && previous.exists() {
        if validate(path, None, None, None).is_ok() {
            disk::remove_file(previous).map_err(fs::err)?;
        } else {
            validate(&previous, None, None, None)?;
            let corrupt = path.with_extension(format!("db.corrupt-{}", uuid::Uuid::new_v4()));
            disk::rename(path, &corrupt).map_err(fs::err)?;
            disk::rename(previous, path).map_err(fs::err)?;
        }
    }
    Ok(())
}
pub fn update(settings: &Value, path: &Path, progress: impl Fn(u64)) -> Result<Value> {
    recover(path)?;
    let variant = settings["databaseVariant"].as_str().unwrap_or("standard");
    if !["standard", "xbox"].contains(&variant) {
        return Err("Invalid database variant".into());
    }
    let suffix = if variant == "xbox" { "_xbox" } else { "" };
    let client = reqwest::blocking::Client::builder()
        .user_agent("OpenGameSave")
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(fs::err)?;
    let release: Value = serde_json::from_slice(&read_response(
        client
            .get("https://api.github.com/repos/leisurefire/OpenGameSave/releases/tags/database")
            .header("Accept", "application/vnd.github+json")
            .send()
            .map_err(fs::err)?,
        2 * 1024 * 1024,
    )?)
    .map_err(fs::err)?;
    let assets = release["assets"]
        .as_array()
        .filter(|a| a.len() <= 1000)
        .ok_or("Malformed database release assets")?;
    let pointer_name = format!("current{suffix}.json");
    let pointer_asset = asset(assets, &pointer_name)?;
    let pointer = json_download(
        &client,
        assets,
        &json!({"name":pointer_name,"size":pointer_asset["size"],"sha256":pointer_asset["digest"]}),
        64 * 1024,
    )?;
    let latest = pointer["latest_version"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 2147483647)
        .ok_or("Invalid database version")?;
    let manifest_name = format!("manifest{suffix}_v{latest}.json");
    if pointer["variant"].as_str().unwrap_or("standard") != variant
        || pointer["manifest"] != manifest_name
    {
        return Err("Database pointer variant or name mismatch".into());
    }
    let manifest = json_download(
        &client,
        assets,
        &json!({"name":manifest_name,"size":pointer["size"],"sha256":pointer["sha256"]}),
        1024 * 1024,
    )?;
    if manifest["latest_version"].as_u64() != Some(latest)
        || manifest["variant"].as_str().unwrap_or("standard") != variant
        || manifest["database"]["name"] != format!("database{suffix}_v{latest}.db")
        || manifest["database"]["user_version"].as_u64() != Some(latest)
    {
        return Err("Database manifest is inconsistent".into());
    }
    let schema = digest(
        manifest["schema_version"]
            .as_str()
            .ok_or("Missing schema digest")?,
    )?;
    let local = validate(path, None, None, None).ok();
    let same_variant = local.as_ref().is_some_and(|v| v["variant"] == variant);
    let current = local
        .as_ref()
        .and_then(|v| v["version"].as_u64())
        .unwrap_or(0);
    if same_variant && current > latest {
        return Err("Local database is newer than published version".into());
    }
    if same_variant
        && current == latest
        && validate(path, Some(latest), Some(&schema), Some(variant)).is_ok()
    {
        return Ok(json!({"success":true,"alreadyLatest":true}));
    }
    let temp = path.with_extension(format!("db.{}.new", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut patches = vec![];
        let empty = vec![];
        for version in current + 1..=latest {
            if let Some(p) = manifest["patches"]
                .as_array()
                .unwrap_or(&empty)
                .iter()
                .find(|p| {
                    p["from"].as_u64() == Some(version - 1)
                        && p["to"].as_u64() == Some(version)
                        && p["name"] == format!("db_patch{suffix}_v{version}.json")
                })
            {
                patches.push(p);
            } else {
                break;
            }
        }
        if same_variant
            && current < latest
            && patches.len() as u64 == latest - current
            && validate(path, Some(current), Some(&schema), Some(variant)).is_ok()
        {
            fs::copy_file(path, &temp)?;
            for (i, descriptor) in patches.iter().enumerate() {
                let raw = json_download(&client, assets, descriptor, 16 * 1024 * 1024)?;
                patch(
                    &temp,
                    &raw,
                    current + i as u64,
                    current + i as u64 + 1,
                    variant,
                )?;
                progress((i + 1) as u64 * 95 / patches.len() as u64);
            }
        } else {
            let data = download(&client, assets, &manifest["database"], MAX_DB)?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(fs::err)?;
            output.write_all(&data).map_err(fs::err)?;
            output.sync_all().map_err(fs::err)?;
            progress(95);
        }
        validate(&temp, Some(latest), Some(&schema), Some(variant))?;
        let previous = path.with_extension("db.previous");
        if path.exists() {
            fs::no_links(path)?;
            disk::rename(path, &previous).map_err(fs::err)?;
        }
        if let Err(e) = disk::rename(&temp, path) {
            if previous.exists() {
                disk::rename(&previous, path).map_err(|r| format!("{e}; rollback failed: {r}"))?;
            }
            return Err(fs::err(e));
        }
        if let Err(e) = validate(path, Some(latest), Some(&schema), Some(variant)) {
            let _ = disk::rename(path, &temp);
            if previous.exists() {
                disk::rename(&previous, path).map_err(|r| format!("{e}; rollback failed: {r}"))?;
            }
            return Err(e);
        }
        if previous.exists() {
            let _ = disk::remove_file(previous);
        }
        progress(100);
        Ok(())
    })();
    if result.is_err() {
        let _ = disk::remove_file(temp);
    }
    result?;
    Ok(json!({"success":true,"variant":variant}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_patch_rolls_back_rows_and_version() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("test.db");
        let c = Connection::open(&db).unwrap();
        c.execute_batch("CREATE TABLE games(wiki_page_id INTEGER PRIMARY KEY,title TEXT,zh_CN TEXT,install_folder TEXT,steam_id INTEGER,gog_id INTEGER,platform TEXT,save_location TEXT); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); PRAGMA user_version=1;").unwrap();
        drop(c);
        let p = json!({"version":2,"from_version":1,"upsert":[{"wiki_page_id":42,"title":"Game","save_location":"{}"},{"wiki_page_id":-1,"title":"Bad","save_location":"{}"}]});
        assert!(patch(&db, &p, 1, 2, "standard").is_err());
        let c = Connection::open(db).unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM games", [], |r| r.get::<_, u64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, u64>(0))
                .unwrap(),
            1
        );
    }
}
