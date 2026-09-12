use super::{
    fs::{self, Result},
    metadata,
    resolver::{platform_key, Resolver},
};
use rusqlite::{types::ValueRef, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs as disk,
    path::{Path, PathBuf},
};
pub fn open(path: &Path) -> Result<Connection> {
    fs::regular(path)?;
    let c = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(fs::err)?;
    c.pragma_update(None, "trusted_schema", false)
        .map_err(fs::err)?;
    Ok(c)
}
fn row_value(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    let id: i64 = row.get("wiki_page_id")?;
    let platform: Option<String> = row.get("platform")?;
    let saves: String = row.get("save_location")?;
    Ok(
        json!({"wiki_page_id":id.to_string(),"title":row.get::<_,String>("title")?,"zh_CN":row.get::<_,Option<String>>("zh_CN")?,"install_folder":row.get::<_,Option<String>>("install_folder")?,"steam_id":platform_id(row,"steam_id")?,"gog_id":platform_id(row,"gog_id")?,"platform":serde_json::from_str::<Value>(platform.as_deref().unwrap_or("[]")).unwrap_or(json!([])),"save_location":serde_json::from_str::<Value>(&saves).unwrap_or(Value::Null)}),
    )
}
// SQLite's catalog contains both numeric IDs and text slugs in these columns.
// Preserve the stored scalar, as the previous SQLite adapter did.
fn platform_id(row: &rusqlite::Row, column: &str) -> rusqlite::Result<Value> {
    Ok(match row.get_ref(column)? {
        ValueRef::Integer(value) => json!(value),
        ValueRef::Real(value) => json!(value),
        ValueRef::Text(value) => json!(String::from_utf8_lossy(value)),
        ValueRef::Null | ValueRef::Blob(_) => Value::Null,
    })
}
pub fn definition(db: &Path, id: &str, settings: &Value) -> Result<Value> {
    let c = open(db)?;
    let mut row = c
        .query_row(
            "SELECT * FROM games WHERE wiki_page_id = ?",
            [id],
            row_value,
        )
        .optional()
        .map_err(fs::err)?
        .ok_or("Game is not in the current database")?;
    find_install(&mut row, settings);
    if !row["save_location"].is_object() {
        return Err("Invalid save-location definition".into());
    }
    Ok(row)
}
pub fn find_install(row: &mut Value, settings: &Value) -> bool {
    let Some(folder) = row["install_folder"].as_str().map(str::to_owned) else {
        return false;
    };
    if Path::new(&folder).is_absolute()
        || folder
            .replace('\\', "/")
            .split('/')
            .any(|s| s == ".." || s == ".")
    {
        return false;
    }
    if let Some(roots) = settings["gameInstalls"].as_array() {
        for root in roots.iter().filter_map(Value::as_str) {
            let root = Path::new(root);
            let candidate = root.join(&folder);
            if fs::inside(root, &candidate)
                && fs::key(root) != fs::key(&candidate)
                && fs::regular(&candidate).map(|m| m.is_dir()).unwrap_or(false)
            {
                row["install_path"] = json!(candidate);
                return true;
            }
        }
    }
    false
}
// A read-only scan indexes each install root once. Only matching catalog folders
// incur full ancestor validation. Mutations keep using uncached find_install.
struct InstallIndex {
    children: HashMap<String, Vec<(PathBuf, PathBuf)>>,
    resolved: HashMap<String, Option<PathBuf>>,
}
impl InstallIndex {
    fn new(settings: &Value) -> Self {
        let mut children: HashMap<String, Vec<(PathBuf, PathBuf)>> = HashMap::new();
        for root in settings["gameInstalls"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let root = Path::new(root);
            if !fs::regular(root).is_ok_and(|m| m.is_dir()) {
                continue;
            }
            let Ok(entries) = disk::read_dir(root) else {
                continue;
            };
            for entry in entries.take(200_000).filter_map(std::result::Result::ok) {
                if entry
                    .file_type()
                    .is_ok_and(|t| t.is_dir() && !t.is_symlink())
                {
                    children
                        .entry(fs::key(Path::new(&entry.file_name())))
                        .or_default()
                        .push((root.to_owned(), entry.path()));
                }
            }
        }
        Self {
            children,
            resolved: HashMap::new(),
        }
    }
    fn find(&mut self, row: &mut Value) -> bool {
        let Some(folder) = row["install_folder"].as_str() else {
            return false;
        };
        let folder = folder.replace('\\', "/");
        if folder.is_empty()
            || Path::new(&folder).is_absolute()
            || folder
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
        {
            return false;
        }
        let key = fs::key(Path::new(&folder));
        let candidate = self.resolved.entry(key).or_insert_with(|| {
            let (first, rest) = folder.split_once('/').unwrap_or((&folder, ""));
            self.children
                .get(&fs::key(Path::new(first)))?
                .iter()
                .find_map(|(root, child)| {
                    let path = if rest.is_empty() {
                        child.clone()
                    } else {
                        child.join(rest)
                    };
                    (fs::inside(root, &path)
                        && fs::key(root) != fs::key(&path)
                        && fs::regular(&path).is_ok_and(|m| m.is_dir()))
                    .then_some(path)
                })
        });
        if let Some(path) = candidate {
            row["install_path"] = json!(path);
            true
        } else {
            false
        }
    }
}
pub fn templates(row: &Value, kind: &str) -> Vec<String> {
    row["save_location"][kind]
        .as_array()
        .map(|v| {
            v.iter()
                .filter_map(Value::as_str)
                .take(128)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
pub fn process(row: &mut Value, settings: &Value, data: &Value) -> Result<()> {
    process_internal(row, settings, data, None)
}
fn process_internal(
    row: &mut Value,
    settings: &Value,
    data: &Value,
    mut scan: Option<&mut fs::ScanContext>,
) -> Result<()> {
    if !row["save_location"].is_object() {
        return Err("Game has an invalid save-location definition".into());
    }
    let resolver = Resolver::new(settings, data, row["install_path"].as_str());
    let mut resolved = vec![];
    let mut seen = std::collections::HashSet::new();
    let mut size = 0u64;
    for template in templates(row, platform_key()) {
        let paths = if let Some(scan) = scan.as_deref_mut() {
            resolver.resolve_for_scan(&template, false, scan)?
        } else {
            resolver.resolve(&template, false)?
        };
        for mut path in paths {
            let p = Path::new(path["resolved"].as_str().ok_or("Invalid resolved path")?);
            if !seen.insert(fs::key(p)) {
                continue;
            }
            let (bytes, _, files) = if let Some(scan) = scan.as_deref_mut() {
                scan.stats(p)?
            } else {
                fs::stats(p)?
            };
            if files > 0 {
                size = size.checked_add(bytes).ok_or("Backup size overflow")?;
                let metadata = if let Some(scan) = scan.as_deref_mut() {
                    scan.regular(p)?
                } else {
                    fs::regular(p)?
                };
                path["type"] = json!(if metadata.is_dir() { "folder" } else { "file" });
                resolved.push(path);
            }
        }
    }
    if cfg!(windows) {
        for template in templates(row, "reg") {
            resolved.extend(if let Some(scan) = scan.as_deref_mut() {
                resolver.resolve_for_scan(&template, true, scan)?
            } else {
                resolver.resolve(&template, true)?
            });
        }
    }
    row["resolved_paths"] = json!(resolved);
    row["backup_size"] = json!(size);
    let root = metadata::root(settings)?;
    row["latest_backup"] = super::backup::latest_date(
        &root,
        row["wiki_page_id"]
            .as_str()
            .ok_or("Invalid game identifier")?,
    )?
    .map(|date| json!(metadata::display_date(&date)))
    .unwrap_or(json!(if settings["language"] == "zh_CN" {
        "暂无备份"
    } else {
        "No backups"
    }));
    Ok(())
}
pub fn scan_with_data(
    settings: &Value,
    db: &Path,
    data: &Value,
    wiki_id: Option<&str>,
    full: bool,
    ignore_uninstalled: bool,
    progress: impl Fn(u64),
) -> Result<Value> {
    scan_with_context(
        settings,
        db,
        data,
        (wiki_id, full, ignore_uninstalled),
        progress,
        &mut fs::ScanContext::default(),
    )
}
pub fn scan_with_context(
    settings: &Value,
    db: &Path,
    data: &Value,
    query: (Option<&str>, bool, bool),
    progress: impl Fn(u64),
    scan: &mut fs::ScanContext,
) -> Result<Value> {
    scan.check_cancelled()?;
    let (wiki_id, full, ignore_uninstalled) = query;
    let c = open(db)?;
    let mut stmt = c
        .prepare(if wiki_id.is_some() {
            "SELECT * FROM games WHERE wiki_page_id = ?"
        } else {
            "SELECT * FROM games"
        })
        .map_err(fs::err)?;
    let mut rows = if let Some(id) = wiki_id {
        stmt.query([id]).map_err(fs::err)?
    } else {
        stmt.query([]).map_err(fs::err)?
    };
    let total: i64 = c
        .query_row("SELECT COUNT(*) FROM games", [], |r| r.get(0))
        .map_err(fs::err)?;
    let candidates = c
        .query_row(
            "SELECT value FROM metadata WHERE key = 'xgp_save_tools_wiki_ids'",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(fs::err)?
        .and_then(|v| serde_json::from_str::<Value>(&v).ok())
        .unwrap_or(json!([]));
    let candidate_ids: std::collections::HashSet<_> = candidates
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| v.to_string())
        })
        .collect();
    let uninstalled: HashSet<_> = settings["uninstalledGames"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| metadata::wiki(v).ok())
        .collect();
    let mut installs = InstallIndex::new(settings);
    let mut games = vec![];
    let mut errors = vec![];
    let mut n = 0;
    let mut last = 101;
    while let Some(row) = rows.next().map_err(fs::err)? {
        scan.check_cancelled()?;
        n += 1;
        // Normal scans need only the ID and install folder to select rows. Avoid
        // parsing every platform/save-location document in the entire catalog.
        let id = row
            .get::<_, i64>("wiki_page_id")
            .map_err(fs::err)?
            .to_string();
        let mut candidate = json!({"install_folder": row.get::<_, Option<String>>("install_folder").map_err(fs::err)?});
        let installed = installs.find(&mut candidate);
        let listed = uninstalled.contains(&id);
        if full
            || installed
            || candidate_ids.contains(&id)
            || (!ignore_uninstalled && settings["saveUninstalledGames"] == true && listed)
        {
            let mut game = row_value(row).map_err(fs::err)?;
            if let Some(path) = candidate.get("install_path") {
                game["install_path"] = path.clone();
            }
            let result = process_internal(&mut game, settings, data, Some(scan));
            scan.check_cancelled()?;
            match result {
                Ok(()) => {
                    if game["resolved_paths"]
                        .as_array()
                        .is_some_and(|v| !v.is_empty())
                    {
                        games.push(game);
                    }
                }
                Err(e) => errors.push(format!("{}: {e}", game["title"].as_str().unwrap_or(&id))),
            }
        }
        let p = if total > 0 { n * 95 / total as u64 } else { 95 };
        if full && p != last {
            progress(p);
            last = p;
        }
    }
    if full {
        progress(100);
    }
    Ok(json!({"games":games,"errors":errors}))
}

pub fn scan(
    settings: &Value,
    db: &Path,
    wiki_id: Option<&str>,
    full: bool,
    ignore_uninstalled: bool,
    progress: impl Fn(u64),
) -> Result<Value> {
    scan_with_data(
        settings,
        db,
        &crate::library::game_data(),
        wiki_id,
        full,
        ignore_uninstalled,
        progress,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_scan_skips_unused_definitions_but_selected_rows_are_still_parsed() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("catalog.db");
        let installs = temp.path().join("installs");
        let game = installs.join("Owned");
        fs::mkdir(&game).unwrap();
        disk::write(game.join("slot.sav"), "save").unwrap();
        let connection = Connection::open(&db).unwrap();
        connection.execute_batch("CREATE TABLE games(wiki_page_id INTEGER PRIMARY KEY,title TEXT,zh_CN TEXT,install_folder TEXT,steam_id INTEGER,gog_id INTEGER,platform TEXT,save_location TEXT); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);").unwrap();
        connection.execute("INSERT INTO games(wiki_page_id,title,install_folder,platform,save_location)VALUES(1,'Owned','Owned','[]',?)", [json!({platform_key():["{{p|game}}/slot.sav"]}).to_string()]).unwrap();
        // SQLite permits NULL here. An unrelated game's unusable definition must
        // not prevent a normal scan from returning the installed game's saves.
        connection.execute("INSERT INTO games(wiki_page_id,title,install_folder,platform,save_location)VALUES(2,'Not installed','Missing','[]',NULL)", []).unwrap();
        drop(connection);
        let mut settings = json!({"backupPath":temp.path().join("backups"),"gameInstalls":[installs],"saveUninstalledGames":true,"uninstalledGames":[]});
        let scan = scan_with_data(&settings, &db, &json!({}), None, false, false, |_| {}).unwrap();
        assert_eq!(scan["games"].as_array().unwrap().len(), 1);
        assert_eq!(scan["games"][0]["wiki_page_id"], "1");
        assert_eq!(scan["games"][0]["install_path"], json!(game));
        assert_eq!(scan["errors"], json!([]));
        assert!(scan_with_data(&settings, &db, &json!({}), None, true, false, |_| {}).is_err());
        settings["uninstalledGames"] = json!(["2"]);
        assert!(scan_with_data(&settings, &db, &json!({}), None, false, false, |_| {}).is_err());
        assert!(scan_with_data(&settings, &db, &json!({}), None, false, true, |_| {}).is_ok());
    }
}
