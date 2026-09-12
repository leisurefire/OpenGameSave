use super::{accounts, read_bounded, text, Game};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

#[derive(Clone)]
struct Entry {
    key: String,
    path: PathBuf,
    locale_rank: usize,
}
struct Index {
    root: PathBuf,
    locale: String,
    created: Instant,
    entries: Vec<Entry>,
}
static INDEX: OnceLock<Mutex<Option<Index>>> = OnceLock::new();

fn hex(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn cache_files(root: &Path) -> Vec<PathBuf> {
    fn children(root: &Path, remaining: &mut usize) -> Vec<std::fs::DirEntry> {
        let mut result = Vec::new();
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries {
                if *remaining == 0 {
                    break;
                }
                *remaining -= 1;
                if let Ok(entry) = entry {
                    result.push(entry);
                }
            }
        }
        result
    }
    let mut budget = 20_000;
    let mut files = Vec::new();
    for first in children(root, &mut budget) {
        if !first.file_type().is_ok_and(|t| t.is_dir())
            || !hex(&first.file_name().to_string_lossy(), 2)
        {
            continue;
        }
        for second in children(&first.path(), &mut budget) {
            if !second.file_type().is_ok_and(|t| t.is_dir())
                || !hex(&second.file_name().to_string_lossy(), 2)
            {
                continue;
            }
            for file in children(&second.path(), &mut budget) {
                if file.file_type().is_ok_and(|t| t.is_file()) {
                    files.push(file.path());
                }
                if files.len() >= 4096 {
                    return files;
                }
            }
        }
    }
    files
}

fn build(root: &Path, locale: &str) -> Vec<Entry> {
    use std::io::Read;
    let mut entries = Vec::new();
    let mut remaining_bytes = 64 * 1024 * 1024;
    for file in cache_files(root) {
        let Ok(metadata) = std::fs::metadata(&file) else {
            continue;
        };
        if metadata.len() <= 2 || metadata.len() > super::MAX_MANIFEST_BYTES {
            continue;
        }
        let Ok(mut handle) = std::fs::File::open(&file) else {
            continue;
        };
        let mut first = [0];
        if handle.read_exact(&mut first).is_err() || first[0] != b'{' {
            continue;
        }
        if metadata.len() > remaining_bytes {
            break;
        }
        remaining_bytes -= metadata.len();
        let Some(bytes) = read_bounded(&file, super::MAX_MANIFEST_BYTES) else {
            continue;
        };
        let Ok(catalog) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        for (rank, name) in [locale, "default"].into_iter().enumerate() {
            if rank == 1 && locale == "default" {
                continue;
            }
            let Some(files) = catalog["files"][name].as_object() else {
                continue;
            };
            for (key, descriptor) in files {
                if entries.len() >= 50_000 {
                    return entries;
                }
                let hash = text(&descriptor["hash"]);
                let name = text(&descriptor["name"]);
                if !hex(&hash, 32)
                    || !Path::new(&name).extension().is_some_and(|extension| {
                        ["jpg", "jpeg", "png", "webp"]
                            .contains(&extension.to_string_lossy().to_lowercase().as_str())
                    })
                {
                    continue;
                }
                entries.push(Entry {
                    key: key.to_uppercase(),
                    path: root.join(&hash[..2]).join(&hash[2..4]).join(&hash),
                    locale_rank: rank,
                });
            }
        }
    }
    entries
}

fn score(key: &str, hero: bool) -> u8 {
    let ranks = if hero {
        [
            ("BACKGROUND", 50),
            ("INSTALL_BACKGROUND", 40),
            ("KEY_ART", 30),
            ("", 0),
        ]
    } else {
        [
            ("KEY_ART", 50),
            ("INSTALL_BACKGROUND", 40),
            ("BACKGROUND", 30),
            ("ICON_MASSIVE", 20),
        ]
    };
    ranks
        .into_iter()
        .find(|(token, _)| !token.is_empty() && key.contains(token))
        .map(|(_, score)| score)
        .unwrap_or(0)
}

pub(super) fn attach(game: &mut Game) {
    let token = match game.platform_id.as_str() {
        "Pro" => "#OVERWATCH_",
        "WTCG" => "#HS_",
        "WoW" => "#WOW_",
        "WoWC" => "#WOW_CLASSIC_",
        "Fen" => "#FENRIS_",
        "D3" => "#D3_",
        "OSI" => "#OSI_",
        "S2" => "#S2_",
        "S1" => "#S1_",
        "Hero" => "#HEROES_",
        _ => return,
    };
    let root = accounts::local_data().join("Battle.net/Cache");
    let system_locale = sys_locale::get_locale()
        .unwrap_or_default()
        .replace('_', "-");
    let parts: Vec<_> = system_locale.split('-').collect();
    let locale = if parts.len() >= 2 {
        format!("{}{}", parts[0].to_lowercase(), parts[1].to_uppercase())
    } else {
        "default".into()
    };
    let mut cache = INDEX
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if cache.as_ref().is_none_or(|index| {
        index.root != root
            || index.locale != locale
            || index.created.elapsed() > Duration::from_secs(30)
    }) {
        *cache = Some(Index {
            entries: build(&root, &locale),
            root: root.clone(),
            locale,
            created: Instant::now(),
        });
    }
    let entries = &cache.as_ref().unwrap().entries;
    for hero in [false, true] {
        let mut candidates: Vec<_> = entries
            .iter()
            .filter(|entry| {
                entry.key.contains(token)
                    && !(game.platform_id == "WoW" && entry.key.contains("#WOW_CLASSIC_"))
                    && score(&entry.key, hero) > 0
            })
            .collect();
        candidates.sort_by_key(|entry| {
            (
                std::cmp::Reverse(score(&entry.key, hero)),
                entry.locale_rank,
            )
        });
        let paths = candidates
            .into_iter()
            .take(128)
            .map(|entry| entry.path.clone());
        if hero {
            game.hero.extend(paths);
        } else {
            game.cover.extend(paths);
        }
    }
    game.art_roots.push(root);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_hashes_cannot_escape_root() {
        assert!(!hex("../../secret", 32));
        assert!(hex("00112233445566778899aabbccddeeff", 32));
    }
    #[test]
    fn cover_prefers_key_art_and_hero_prefers_background() {
        assert!(score("#OVERWATCH_KEY_ART", false) > score("#OVERWATCH_BACKGROUND", false));
        assert!(score("#OVERWATCH_BACKGROUND", true) > score("#OVERWATCH_KEY_ART", true));
    }
}
