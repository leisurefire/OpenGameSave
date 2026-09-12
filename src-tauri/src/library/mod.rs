mod accounts;
mod artwork;
mod blizzard_art;
mod guides;
mod providers;
mod vdf;

pub use accounts::{detected_paths, game_data};

use crate::state::AppState;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const MAX_MANIFEST_BYTES: u64 = 5 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;

pub(super) fn read_bounded(path: &Path, max: u64) -> Option<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > max {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(max + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= max).then_some(bytes)
}

pub(super) fn read_json(path: &Path) -> Value {
    read_bounded(path, MAX_MANIFEST_BYTES)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}

pub(super) fn entries(path: &Path, limit: usize) -> Vec<std::fs::DirEntry> {
    std::fs::read_dir(path)
        .map(|it| {
            it.take(limit.min(MAX_ENTRIES))
                .filter_map(Result::ok)
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

#[derive(Clone, Debug)]
pub(super) struct Game {
    id: String,
    title: String,
    platform: String,
    platform_id: String,
    install_path: PathBuf,
    executable: Option<PathBuf>,
    launcher: Option<PathBuf>,
    art_roots: Vec<PathBuf>,
    cover: Vec<PathBuf>,
    hero: Vec<PathBuf>,
    metadata: Value,
    guide: Value,
}

impl Game {
    fn new(platform: &str, id: &str, title: &str, path: PathBuf) -> Self {
        Self {
            id: format!("{}:{id}", platform.to_lowercase()),
            title: title.chars().take(200).collect(),
            platform: platform.into(),
            platform_id: id.into(),
            install_path: path,
            executable: None,
            launcher: None,
            art_roots: vec![],
            cover: vec![],
            hero: vec![],
            metadata: Value::Null,
            guide: Value::Null,
        }
    }
    fn renderer(&self) -> Value {
        let mut value = json!({"id":self.id,"title":self.title,"platform":self.platform,"platformId":self.platform_id,
            "installPath":self.install_path,"hasCover":!self.cover.is_empty() || artwork::has_fallback(self),
            "hasHero":!self.hero.is_empty() || artwork::has_fallback(self)});
        if !self.guide.is_null() {
            value["guide"] = self.guide.clone();
        }
        value
    }
}

#[derive(Default)]
struct LibraryCache {
    scanned: Option<Instant>,
    database: PathBuf,
    games: HashMap<String, Game>,
}
static LIBRARY: OnceLock<Mutex<LibraryCache>> = OnceLock::new();

fn scan(ctx: &AppState, force: bool) -> Result<Value, String> {
    let mut cache = LIBRARY
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Library lock poisoned")?;
    if force
        || cache.database != ctx.database_path
        || cache
            .scanned
            .map(|t| t.elapsed() > Duration::from_secs(60))
            .unwrap_or(true)
    {
        let mut games = providers::scan();
        guides::enrich(&ctx.database_path, &mut games);
        cache.games = games
            .into_iter()
            .take(MAX_ENTRIES)
            .map(|game| (game.id.clone(), game))
            .collect();
        cache.scanned = Some(Instant::now());
        cache.database = ctx.database_path.clone();
    }
    let mut result: Vec<_> = cache.games.values().map(Game::renderer).collect();
    result.sort_by_cached_key(|game| text(&game["title"]).to_lowercase());
    Ok(json!(result))
}

fn find_game(id: &str) -> Result<Game, String> {
    LIBRARY
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Library lock poisoned")?
        .games
        .get(id)
        .cloned()
        .ok_or_else(|| "Game is not present in the scanned library".into())
}

pub async fn dispatch(ctx: &AppState, channel: &str, args: Vec<Value>) -> Result<Value, String> {
    let ctx = ctx.clone();
    let channel = channel.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let first = args.first().unwrap_or(&Value::Null);
        match channel.as_str() {
            "get-library-games" => scan(&ctx, first["force"] == true),
            "get-library-game-art" => {
                let game = match find_game(&text(first)) { Ok(game) => game, Err(_) => return Ok(Value::Null) };
                artwork::load(&game, args.get(1).and_then(Value::as_str).unwrap_or("cover"))
            },
            "launch-library-game" => {
                let game = find_game(&text(first))?;
                providers::launch(&game)?;
                Ok(json!({"launched":true,"gameId":game.id}))
            },
            "open-library-game-directory" => { crate::platform::open_path(&find_game(&text(first))?.install_path)?; Ok(json!(true)) },
            "get-game-guide-catalog" | "search-game-guides" | "get-game-guide" => guides::dispatch(&ctx.database_path, &channel, first),
            "get-account-data" => {
                let data = game_data();
                Ok(json!({"steamId64":data["currentSteamUserId64"],"steamId3":data["currentSteamUserId3"],
                    "ubisoftId":data["currentUbisoftUserId"],"epicId":data["currentEpicUserId"],
                    "xboxId":data["currentXboxUserId"],"rockStarId":data["currentRockStarUserId"]}))
            },
            "get-detected-game-paths" => Ok(json!(detected_paths())),
            _ => Err(format!("Unknown library command: {channel}"))
        }
    }).await.map_err(|error| error.to_string())?
}
