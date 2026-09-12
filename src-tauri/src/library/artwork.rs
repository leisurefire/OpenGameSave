use super::{read_bounded, text, Game};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    io::Read,
    path::Path,
    sync::{Condvar, Mutex, OnceLock},
    time::{Duration, Instant},
};

const MAX_ART_BYTES: u64 = 8 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CACHE_BYTES: usize = 24 * 1024 * 1024;

fn allowed(provider: &str, metadata: bool, url: &url::Url) -> bool {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|p| p != 443)
    {
        return false;
    }
    let host = url.host_str().unwrap_or("");
    match (provider, metadata) {
        ("Steam", false) => host == "cdn.akamai.steamstatic.com",
        ("Epic", true) => [
            "store-content.ak.epicgames.com",
            "store-content-ipv4.ak.epicgames.com",
        ]
        .contains(&host),
        ("Epic", false) => [
            "cdn1.unrealengine.com",
            "cdn2.unrealengine.com",
            "cdn1-unrealengine-1251447533.file.myqcloud.com",
            "cdn2-unrealengine-1251447533.file.myqcloud.com",
            "static-assets-prod.epicgames.com",
            "store-site-backend-static.ak.epicgames.com",
        ]
        .contains(&host),
        ("GOG", true) => host == "api.gog.com",
        ("GOG", false) => {
            host == "images.gog-statics.com"
                || host
                    .strip_prefix("images-")
                    .and_then(|s| s.strip_suffix(".gog-statics.com"))
                    .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        }
        ("Blizzard", true) => ["blizzard.com", "battle.net"]
            .iter()
            .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}"))),
        ("Blizzard", false) => [
            "blz-contentstack-images.akamaized.net",
            "images.blz-contentstack.com",
            "bnetcmsus-a.akamaihd.net",
            "d39zum0jwvcigt.cloudfront.net",
        ]
        .contains(&host),
        _ => false,
    }
}

fn mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn client() -> Result<&'static reqwest::blocking::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::blocking::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::blocking::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(7))
                .connect_timeout(Duration::from_secs(4))
                .user_agent("OpenGameSave artwork resolver")
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn fetch(
    provider: &str,
    metadata: bool,
    initial: &str,
) -> Result<(Vec<u8>, String, String), String> {
    let mut url = url::Url::parse(initial).map_err(|e| e.to_string())?;
    let start = Instant::now();
    let max = if metadata {
        MAX_METADATA_BYTES
    } else {
        MAX_ART_BYTES
    };
    for redirect in 0..=3 {
        if !allowed(provider, metadata, &url) {
            return Err("Artwork host is not allowed".into());
        }
        let timeout = Duration::from_secs(7)
            .checked_sub(start.elapsed())
            .ok_or("Artwork request timed out")?;
        let response = client()?
            .get(url.clone())
            .timeout(timeout)
            .header(
                "Accept",
                if metadata {
                    "application/json,text/html"
                } else {
                    "image/jpeg,image/png,image/webp"
                },
            )
            .send()
            .map_err(|e| e.to_string())?;
        if response.status().is_redirection() {
            if redirect == 3 {
                return Err("Artwork redirect limit exceeded".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .ok_or("Missing artwork redirect")?
                .to_str()
                .map_err(|e| e.to_string())?;
            url = url.join(location).map_err(|e| e.to_string())?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("Artwork returned HTTP {}", response.status()));
        }
        if response.content_length().is_some_and(|size| size > max) {
            return Err("Artwork exceeds size limit".into());
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_lowercase();
        let mut bytes = Vec::new();
        response
            .take(max + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > max {
            return Err("Artwork exceeds size limit".into());
        }
        return Ok((bytes, content_type, url.into()));
    }
    Err("Artwork redirect limit exceeded".into())
}

fn metadata(provider: &str, url: &str) -> Result<Value, String> {
    type MetadataCache = VecDeque<(String, Instant, Value)>;
    static CACHE: OnceLock<Mutex<MetadataCache>> = OnceLock::new();
    let key = format!("{provider}:{url}");
    {
        let cache = CACHE
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some((_, _, value)) = cache.iter().find(|(existing, time, _)| {
            existing == &key && time.elapsed() < Duration::from_secs(1800)
        }) {
            return Ok(value.clone());
        }
    }
    let (bytes, content_type, final_url) = fetch(provider, true, url)?;
    let value = if content_type == "text/html" && provider == "Blizzard" {
        json!({"html":String::from_utf8_lossy(&bytes),"url":final_url})
    } else if content_type == "application/json" || content_type.ends_with("+json") {
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())?
    } else {
        return Err("Unexpected artwork metadata type".into());
    };
    let mut cache = CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    cache.retain(|(existing, _, _)| existing != &key);
    cache.push_back((key, Instant::now(), value.clone()));
    while cache.len() > 32 {
        cache.pop_front();
    }
    Ok(value)
}

fn normalize_url(value: &str) -> String {
    if value.starts_with("//") {
        format!("https:{value}")
    } else {
        value.into()
    }
}
fn urls(game: &Game, art_type: &str) -> Result<Vec<String>, String> {
    let cover = art_type == "cover";
    let candidates = match game.platform.as_str() {
        "Steam" => {
            let root = format!(
                "https://cdn.akamai.steamstatic.com/steam/apps/{}",
                game.platform_id
            );
            if cover {
                vec![
                    format!("{root}/library_600x900_2x.jpg"),
                    format!("{root}/library_600x900.jpg"),
                ]
            } else {
                vec![format!("{root}/library_hero.jpg")]
            }
        }
        "GOG" => {
            let product = metadata(
                "GOG",
                &format!(
                    "https://api.gog.com/products/{}?locale=en-US",
                    game.platform_id
                ),
            )?;
            let keys = if cover {
                vec!["coverVertical", "productCard", "background", "icon"]
            } else {
                vec!["background", "coverHorizontal", "coverVertical"]
            };
            keys.into_iter()
                .map(|key| text(&product["images"][key]))
                .collect()
        }
        "Epic" => {
            let namespace = text(&game.metadata["namespace"]);
            if namespace.is_empty() {
                return Ok(vec![]);
            }
            let mapping = metadata(
                "Epic",
                "https://store-content.ak.epicgames.com/api/content/productmapping",
            )?;
            let slug = text(&mapping[&namespace]);
            if slug.is_empty()
                || slug.len() > 200
                || !slug
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            {
                return Ok(vec![]);
            }
            let product = metadata(
                "Epic",
                &format!(
                    "https://store-content.ak.epicgames.com/api/en-US/content/products/{slug}"
                ),
            )?;
            let Some(pages) = product["pages"].as_array() else {
                return Ok(vec![]);
            };
            let page = pages
                .iter()
                .find(|page| {
                    text(&page["item"]["namespace"]) == namespace
                        && text(&page["item"]["appName"]) == game.platform_id
                })
                .or_else(|| pages.iter().find(|page| page["type"] == "productHome"))
                .or_else(|| pages.first())
                .unwrap_or(&Value::Null);
            let portrait = text(&page["data"]["hero"]["portraitBackgroundImageUrl"]);
            let landscape = text(&page["data"]["hero"]["backgroundImageUrl"]);
            let mut images = if cover {
                vec![portrait, landscape]
            } else {
                vec![landscape, portrait]
            };
            if let Some(other) = page["_images_"].as_array() {
                images.extend(other.iter().take(100).map(text));
            }
            images
        }
        "Blizzard" => {
            let page = metadata("Blizzard", &text(&game.metadata["officialPage"]))?;
            let html = text(&page["html"]);
            let base = url::Url::parse(&text(&page["url"])).map_err(|e| e.to_string())?;
            let tags = regex::Regex::new(r"(?is)<meta\b[^>]*>").unwrap();
            let attributes =
                regex::Regex::new(r#"(?is)([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#).unwrap();
            let mut images = Vec::new();
            for tag in tags.find_iter(&html).take(500) {
                let attrs: std::collections::HashMap<_, _> = attributes
                    .captures_iter(tag.as_str())
                    .map(|capture| {
                        (
                            capture[1].to_lowercase(),
                            capture
                                .get(2)
                                .or_else(|| capture.get(3))
                                .unwrap()
                                .as_str()
                                .replace("&amp;", "&"),
                        )
                    })
                    .collect();
                if attrs
                    .get("property")
                    .or_else(|| attrs.get("name"))
                    .is_some_and(|name| name.eq_ignore_ascii_case("og:image"))
                {
                    if let Some(content) = attrs.get("content") {
                        if let Ok(url) = base.join(content) {
                            images.push(url.into());
                        }
                    }
                }
            }
            images
        }
        _ => vec![],
    };
    let mut seen = std::collections::HashSet::new();
    Ok(candidates
        .into_iter()
        .map(|value| normalize_url(&value))
        .filter(|value| {
            url::Url::parse(value).is_ok_and(|url| allowed(&game.platform, false, &url))
        })
        .filter(|url| seen.insert(url.clone()))
        .take(20)
        .collect())
}

#[derive(Clone)]
struct Asset {
    bytes: Vec<u8>,
    mime: String,
}
impl Asset {
    fn value(&self) -> Value {
        use base64::Engine;
        json!({"dataBase64":base64::engine::general_purpose::STANDARD.encode(&self.bytes),"mimeType":self.mime})
    }
}
static ASSETS: OnceLock<Mutex<VecDeque<(String, Asset)>>> = OnceLock::new();

fn cached(key: &str) -> Option<Asset> {
    let mut cache = ASSETS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let index = cache.iter().position(|(existing, _)| existing == key)?;
    let entry = cache.remove(index)?;
    let value = entry.1.clone();
    cache.push_back(entry);
    Some(value)
}
fn cache(key: String, asset: Asset) -> Asset {
    let mut cache = ASSETS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    cache.retain(|(existing, _)| existing != &key);
    cache.push_back((key, asset.clone()));
    let mut size: usize = cache.iter().map(|(_, asset)| asset.bytes.len()).sum();
    while size > MAX_CACHE_BYTES || cache.len() > 256 {
        if let Some((_, asset)) = cache.pop_front() {
            size -= asset.bytes.len();
        } else {
            break;
        }
    }
    asset
}
fn local(path: &Path, roots: &[std::path::PathBuf]) -> Option<Asset> {
    let real = path.canonicalize().ok()?;
    if !roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| real.starts_with(root))
    {
        return None;
    }
    let meta = std::fs::metadata(&real).ok()?;
    if !meta.is_file() || meta.len() > MAX_ART_BYTES {
        return None;
    }
    let key = format!(
        "local:{}:{}:{:?}",
        real.display(),
        meta.len(),
        meta.modified().ok()
    );
    if let Some(asset) = cached(&key) {
        return Some(asset);
    }
    let bytes = read_bounded(&real, MAX_ART_BYTES)?;
    let mime = mime(&bytes)?.to_owned();
    if path.canonicalize().ok().as_ref() != Some(&real) {
        return None;
    }
    Some(cache(key, Asset { bytes, mime }))
}

#[derive(Default)]
struct Queue {
    active: usize,
    waiting: usize,
}
static QUEUE: OnceLock<(Mutex<Queue>, Condvar)> = OnceLock::new();
struct Permit;
impl Drop for Permit {
    fn drop(&mut self) {
        let (lock, cv) = QUEUE.get().unwrap();
        let mut queue = lock.lock().unwrap_or_else(|e| e.into_inner());
        queue.active -= 1;
        cv.notify_one();
    }
}
fn acquire() -> Result<Permit, String> {
    let (lock, cv) = QUEUE.get_or_init(Default::default);
    let mut queue = lock.lock().unwrap_or_else(|e| e.into_inner());
    if queue.waiting >= 64 {
        return Err("Artwork request queue is full".into());
    }
    queue.waiting += 1;
    while queue.active >= 4 {
        queue = cv.wait(queue).unwrap_or_else(|e| e.into_inner());
    }
    queue.waiting -= 1;
    queue.active += 1;
    Ok(Permit)
}

pub(super) fn has_fallback(game: &Game) -> bool {
    match game.platform.as_str() {
        "Steam" | "GOG" => true,
        "Epic" => !text(&game.metadata["namespace"]).is_empty(),
        "Blizzard" => true,
        _ => false,
    }
}
pub(super) fn load(game: &Game, art_type: &str) -> Result<Value, String> {
    if !["cover", "hero"].contains(&art_type) {
        return Err("Unknown artwork type".into());
    }
    let _permit = acquire()?;
    let mut resolved;
    let game = if game.platform == "Blizzard" {
        resolved = game.clone();
        super::blizzard_art::attach(&mut resolved);
        &resolved
    } else {
        game
    };
    let paths = if art_type == "cover" {
        &game.cover
    } else {
        &game.hero
    };
    for path in paths {
        if let Some(asset) = local(path, &game.art_roots) {
            return Ok(asset.value());
        }
    }
    let candidates = match urls(game, art_type) {
        Ok(urls) => urls,
        Err(error) => {
            eprintln!("Artwork metadata for {}: {error}", game.id);
            return Ok(Value::Null);
        }
    };
    for url in candidates {
        let key = format!("{}:{url}", game.platform);
        if let Some(asset) = cached(&key) {
            return Ok(asset.value());
        }
        if let Ok((bytes, content_type, _)) = fetch(&game.platform, false, &url) {
            if let Some(detected) = mime(&bytes) {
                if detected == content_type {
                    return Ok(cache(
                        key,
                        Asset {
                            bytes,
                            mime: content_type,
                        },
                    )
                    .value());
                }
            }
        }
    }
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_artwork_is_constrained_by_provider_and_purpose() {
        assert!(allowed(
            "Steam",
            false,
            &url::Url::parse("https://cdn.akamai.steamstatic.com/steam/apps/1/header.jpg").unwrap()
        ));
        for value in [
            "https://cdn.akamai.steamstatic.com.evil.test/a",
            "http://cdn.akamai.steamstatic.com/a",
            "https://user@cdn.akamai.steamstatic.com/a",
            "https://127.0.0.1/a",
        ] {
            assert!(!allowed("Steam", false, &url::Url::parse(value).unwrap()));
        }
        assert!(!allowed(
            "Steam",
            true,
            &url::Url::parse("https://cdn.akamai.steamstatic.com/a").unwrap()
        ));
    }
    #[test]
    fn magic_bytes_reject_svg_and_html() {
        assert_eq!(mime(b"<svg></svg>"), None);
        assert_eq!(mime(b"\x89PNG\r\n\x1a\nextra"), Some("image/png"));
    }
    #[test]
    fn local_artwork_cannot_read_outside_roots() {
        let root = std::env::temp_dir().join(format!("ogs-art-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("trusted")).unwrap();
        let image = root.join("outside.png");
        std::fs::write(&image, b"\x89PNG\r\n\x1a\nextra").unwrap();
        assert!(local(&image, &[root.join("trusted")]).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
