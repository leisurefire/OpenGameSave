use super::{text, Game};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

const TRUSTED_HOSTS: &[&str] = &[
    "github.com",
    "liquipedia.net",
    "overlab.cn",
    "ow.blizzard.cn",
    "pcgamingwiki.com",
    "www.pcgamingwiki.com",
];
const COLUMNS: &str =
    "wiki_page_id, title, COALESCE(zh_CN,''), CAST(steam_id AS TEXT), CAST(gog_id AS TEXT)";

#[derive(Clone)]
struct Row {
    wiki: String,
    title: String,
    chinese: String,
    steam: String,
    gog: String,
}

fn normalized(s: &str) -> String {
    s.trim().to_lowercase()
}
fn numeric(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.bytes().all(|c| c.is_ascii_digit())
        && value.bytes().any(|c| c != b'0')
}
fn database(path: &Path) -> Option<Connection> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    db.busy_timeout(std::time::Duration::from_secs(5)).ok()?;
    Some(db)
}
fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        wiki: row.get::<_, i64>(0)?.to_string(),
        title: row.get(1)?,
        chinese: row.get(2)?,
        steam: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        gog: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
    })
}

fn validate_url(value: &str) -> Result<String, String> {
    let url = url::Url::parse(value).map_err(|e| e.to_string())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
        || !url
            .host_str()
            .is_some_and(|host| TRUSTED_HOSTS.contains(&host))
    {
        return Err("Guide source is not trusted".into());
    }
    Ok(url.into())
}

fn normalized_catalog(raw: Value) -> Result<Value, String> {
    if raw["version"] != 1 || !raw["games"].is_array() {
        return Err("Unsupported guide catalog".into());
    }
    let mut games = Vec::new();
    for game in raw["games"].as_array().unwrap().iter().take(100) {
        let mut normalized = json!({"platform_ids":{},"sources":[]});
        for (key, max) in [("id", 80), ("title", 200), ("title_zh_CN", 200)] {
            normalized[key] = json!(text(&game[key]).chars().take(max).collect::<String>());
        }
        if let Some(platforms) = game["platform_ids"].as_object() {
            for (platform, id) in platforms.iter().take(10) {
                normalized["platform_ids"][platform.chars().take(40).collect::<String>()] =
                    json!(text(id).chars().take(256).collect::<String>());
            }
        }
        let mut sources = Vec::new();
        if let Some(items) = game["sources"].as_array() {
            for source in items.iter().take(40) {
                if !["official", "wiki", "esports"]
                    .contains(&source["category"].as_str().unwrap_or(""))
                {
                    return Err("Unsupported guide source category".into());
                }
                let mut cleaned = json!({"url":validate_url(&text(&source["url"]))?});
                for (key, max) in [
                    ("id", 80),
                    ("name", 200),
                    ("name_zh_CN", 200),
                    ("category", 20),
                    ("language", 20),
                    ("description", 1000),
                    ("description_zh_CN", 1000),
                    ("trust_reason", 500),
                    ("trust_reason_zh_CN", 500),
                ] {
                    cleaned[key] = json!(text(&source[key]).chars().take(max).collect::<String>());
                }
                let date = text(&source["verified_at"]);
                cleaned["verified_at"] = json!(if date.len() == 10
                    && chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").is_ok()
                {
                    date
                } else {
                    String::new()
                });
                sources.push(cleaned);
            }
        }
        normalized["sources"] = json!(sources);
        games.push(normalized);
    }
    Ok(json!({"version":1,"games":games}))
}

fn catalog(db: Option<&Connection>) -> Value {
    if let Some(db) = db {
        if let Ok(raw) = db.query_row(
            "SELECT value FROM metadata WHERE key='game_guide_catalog'",
            [],
            |row| row.get::<_, String>(0),
        ) {
            if raw.len() <= 5 * 1024 * 1024 {
                if let Ok(value) = serde_json::from_str(&raw)
                    .map_err(|e| e.to_string())
                    .and_then(normalized_catalog)
                {
                    return value;
                }
            }
        }
    }
    normalized_catalog(
        serde_json::from_str(include_str!("../../../src/data/gameGuides.json"))
            .expect("Bundled guide catalog"),
    )
    .expect("Trusted bundled guide catalog")
}

fn curated<'a>(catalog: &'a Value, row: &Row) -> Option<&'a Value> {
    let games = catalog["games"].as_array()?;
    if let Some(game) = games.iter().find(|game| {
        (numeric(&row.steam, 12) && text(&game["platform_ids"]["Steam"]) == row.steam)
            || (numeric(&row.gog, 20) && text(&game["platform_ids"]["GOG"]) == row.gog)
    }) {
        return Some(game);
    }
    let titles: HashSet<_> = [&row.title, &row.chinese]
        .into_iter()
        .map(|s| normalized(s))
        .filter(|s| !s.is_empty())
        .collect();
    let matches: Vec<_> = games
        .iter()
        .filter(|game| {
            titles.contains(&normalized(&text(&game["title"])))
                || titles.contains(&normalized(&text(&game["title_zh_CN"])))
        })
        .collect();
    if matches.len() == 1 {
        Some(matches[0])
    } else {
        None
    }
}

fn pcgamingwiki(id: &str) -> Value {
    json!({"id":"pcgamingwiki","name":"PCGamingWiki","name_zh_CN":"PCGamingWiki 技术百科","category":"wiki","language":"en",
        "url":format!("https://www.pcgamingwiki.com/wiki/index.php?curid={id}"),
        "description":"Game-specific fixes, save locations, configuration details, known issues, and PC compatibility notes.",
        "description_zh_CN":"面向该游戏的故障修复、存档位置、配置说明、已知问题与 PC 兼容性资料。",
        "trust_reason":"Matched by the stable PCGamingWiki page ID stored in the OpenGameSave database.",
        "trust_reason_zh_CN":"通过 OpenGameSave 数据库保存的 PCGamingWiki 稳定页面 ID 精确匹配。","verified_at":"2026-08-20"})
}

fn to_game(row: &Row, catalog: &Value) -> Value {
    let curated = curated(catalog, row);
    let mut sources = vec![pcgamingwiki(&row.wiki)];
    if let Some(items) = curated.and_then(|game| game["sources"].as_array()) {
        for source in items {
            if !sources
                .iter()
                .any(|existing| existing["url"] == source["url"])
            {
                sources.push(source.clone());
            }
        }
    }
    let mut platforms = json!({});
    if numeric(&row.steam, 12) {
        platforms["Steam"] = json!(row.steam);
    }
    if numeric(&row.gog, 20) {
        platforms["GOG"] = json!(row.gog);
    }
    json!({"id":curated.map(|game|text(&game["id"])).unwrap_or_else(||format!("pcgamingwiki-{}",row.wiki)),
        "title":curated.map(|game|text(&game["title"])).unwrap_or_else(||row.title.clone()),
        "title_zh_CN":curated.map(|game|text(&game["title_zh_CN"])).unwrap_or_else(||row.chinese.clone()),
        "wiki_page_id":row.wiki,"platform_ids":curated.map(|game|game["platform_ids"].clone()).unwrap_or(platforms),"sources":sources})
}

fn full_catalog(db: Option<&Connection>, catalog: &Value) -> Value {
    let mut games = Vec::new();
    let mut seen = HashSet::new();
    if let Some(db) = db {
        if let Ok(mut query)=db.prepare(&format!("SELECT {COLUMNS} FROM games WHERE LOWER(title)=LOWER(?1) OR LOWER(COALESCE(zh_CN,''))=LOWER(?1) LIMIT 100")) {
            for game in catalog["games"].as_array().unwrap() {for title in [&game["title"],&game["title_zh_CN"]] {
                let title=text(title);if title.is_empty() {continue;}
                if let Ok(rows)=query.query_map([title],map_row) {
                    for row in rows.filter_map(Result::ok) {let game=to_game(&row,catalog);if seen.insert(text(&game["id"])) {games.push(game);}}
                }
            }}
        }
    }
    for game in catalog["games"].as_array().unwrap() {
        if seen.insert(text(&game["id"])) {
            games.push(game.clone());
        }
    }
    json!({"version":1,"games":games})
}

pub(super) fn dispatch(path: &Path, channel: &str, arg: &Value) -> Result<Value, String> {
    let db = database(path);
    let catalog = catalog(db.as_ref());
    match channel {
        "get-game-guide-catalog" => Ok(full_catalog(db.as_ref(), &catalog)),
        "get-game-guide" => {
            let id = text(arg)
                .parse::<i64>()
                .map_err(|_| "Invalid wiki page ID")?;
            if id <= 0 {
                return Err("Invalid wiki page ID".into());
            }
            let Some(db) = db else {
                return Ok(Value::Null);
            };
            let result = db.query_row(
                &format!("SELECT {COLUMNS} FROM games WHERE wiki_page_id=?1"),
                [id],
                map_row,
            );
            match result {
                Ok(row) => Ok(to_game(&row, &catalog)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(Value::Null),
                Err(e) => Err(e.to_string()),
            }
        }
        "search-game-guides" => {
            let query: String = text(arg).trim().chars().take(100).collect();
            if query.is_empty() {
                return Ok(json!(full_catalog(db.as_ref(), &catalog)["games"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .take(24)
                    .collect::<Vec<_>>()));
            }
            let escaped = query
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            let pattern = format!("%{escaped}%");
            let prefix = format!("{escaped}%");
            let mut games = Vec::new();
            if let Some(db) = db {
                let sql=format!("SELECT {COLUMNS} FROM games WHERE title LIKE ?1 ESCAPE '\\' OR COALESCE(zh_CN,'') LIKE ?1 ESCAPE '\\' ORDER BY CASE WHEN LOWER(title)=LOWER(?2) OR LOWER(COALESCE(zh_CN,''))=LOWER(?2) THEN 0 WHEN title LIKE ?3 ESCAPE '\\' OR COALESCE(zh_CN,'') LIKE ?3 ESCAPE '\\' THEN 1 ELSE 2 END,title COLLATE NOCASE LIMIT 24");
                let mut statement = db.prepare(&sql).map_err(|e| e.to_string())?;
                let rows = statement
                    .query_map(params![pattern, query, prefix], map_row)
                    .map_err(|e| e.to_string())?;
                for row in rows {
                    games.push(to_game(&row.map_err(|e| e.to_string())?, &catalog));
                }
            }
            let mut seen: HashSet<_> = games.iter().map(|game| text(&game["id"])).collect();
            for game in catalog["games"].as_array().unwrap() {
                if normalized(&format!(
                    "{} {}",
                    text(&game["title"]),
                    text(&game["title_zh_CN"])
                ))
                .contains(&normalized(&query))
                    && seen.insert(text(&game["id"]))
                {
                    games.push(game.clone());
                }
            }
            games.truncate(24);
            Ok(json!(games))
        }
        _ => Err("Unknown guide command".into()),
    }
}

pub(super) fn enrich(path: &Path, games: &mut [Game]) {
    let Some(db) = database(path) else {
        return;
    };
    let Ok(mut statement) = db.prepare(&format!(
        "SELECT {COLUMNS} FROM games ORDER BY wiki_page_id LIMIT 100000"
    )) else {
        return;
    };
    let Ok(rows) = statement.query_map([], map_row) else {
        return;
    };
    let rows: Vec<_> = rows.filter_map(Result::ok).collect();
    let mut title_map: HashMap<String, Vec<usize>> = HashMap::new();
    let mut platform_map: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        let titles: HashSet<_> = [&row.title, &row.chinese]
            .into_iter()
            .map(|s| normalized(s))
            .filter(|s| !s.is_empty())
            .collect();
        for title in titles {
            title_map.entry(title).or_default().push(index);
        }
        for (platform, id, max) in [("Steam", &row.steam, 12), ("GOG", &row.gog, 20)] {
            if numeric(id, max) {
                platform_map
                    .entry(format!("{platform}:{id}"))
                    .or_default()
                    .push(index);
            }
        }
    }
    for game in games {
        let title = normalized(&game.title);
        let candidates = platform_map.get(&format!("{}:{}", game.platform, game.platform_id));
        let matched = candidates
            .and_then(|indexes| {
                if indexes.len() == 1 {
                    return Some(indexes[0]);
                }
                let matching: Vec<_> = indexes
                    .iter()
                    .filter(|i| {
                        normalized(&rows[**i].title) == title
                            || normalized(&rows[**i].chinese) == title
                    })
                    .collect();
                if matching.len() == 1 {
                    Some(*matching[0])
                } else {
                    None
                }
            })
            .or_else(|| {
                title_map
                    .get(&title)
                    .filter(|indexes| indexes.len() == 1)
                    .map(|indexes| indexes[0])
            });
        if let Some(index) = matched {
            let row = &rows[index];
            game.guide = json!({"wikiPageId":row.wiki,"title":row.title,"titleZhCN":row.chinese});
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn guides_reject_active_or_untrusted_urls() {
        for url in [
            "http://github.com/x",
            "https://github.com.evil.test/x",
            "https://user:pass@github.com/x",
            "javascript:alert(1)",
        ] {
            assert!(validate_url(url).is_err());
        }
        assert!(validate_url("https://www.pcgamingwiki.com/wiki/index.php?curid=1").is_ok());
    }
    #[test]
    fn bundled_catalog_is_normalized() {
        let catalog = catalog(None);
        assert!(!catalog["games"].as_array().unwrap().is_empty());
    }
    #[test]
    fn guide_search_treats_like_wildcards_as_literal_text() {
        let root = std::env::temp_dir().join(format!("ogs-guides-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("db.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE games(wiki_page_id INTEGER,title TEXT,zh_CN TEXT,steam_id TEXT,gog_id TEXT); INSERT INTO games VALUES(1,'100% Game','','1','0'),(2,'1000 Game','','2','0');").unwrap();
        drop(db);
        let result = dispatch(&path, "search-game-guides", &json!("100%")).unwrap();
        assert_eq!(result.as_array().unwrap().len(), 1);
        assert_eq!(result[0]["wiki_page_id"], "1");
        std::fs::remove_dir_all(root).unwrap();
    }
}
