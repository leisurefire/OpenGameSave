use super::fs::{self, Result};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

#[derive(Clone)]
pub struct Resolver {
    pub values: HashMap<String, String>,
    pub ids: Vec<String>,
    pub xbox: Vec<String>,
    pub roots: Vec<PathBuf>,
    pub all_accounts: bool,
    account_contexts: Vec<(String, String)>,
}
fn literal_expression(value: &str) -> Arc<regex::Regex> {
    static EXPRESSIONS: OnceLock<Mutex<HashMap<String, Arc<regex::Regex>>>> = OnceLock::new();
    let expressions = EXPRESSIONS.get_or_init(Default::default);
    if let Some(expression) = expressions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(value)
    {
        return expression.clone();
    }
    let expression = Arc::new(
        regex::RegexBuilder::new(&regex::escape(value))
            .case_insensitive(cfg!(windows))
            .build()
            .expect("Escaped literal expression"),
    );
    let mut cache = expressions.lock().unwrap_or_else(|e| e.into_inner());
    if cache.len() < 512 {
        cache.insert(value.into(), expression.clone());
    }
    expression
}
fn env(name: &str, fallback: String) -> String {
    std::env::var(name).unwrap_or(fallback)
}
pub fn platform_key() -> &'static str {
    if cfg!(windows) {
        "win"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else {
        "linux"
    }
}
impl Resolver {
    pub fn new(settings: &Value, data: &Value, install: Option<&str>) -> Self {
        let home = env("USERPROFILE", env("HOME", String::new()));
        let mut values = HashMap::new();
        for (name, value) in [
            ("systemdrive", env("SystemDrive", "C:".into())),
            ("username", env("USERNAME", env("USER", String::new()))),
            ("userprofile", home.clone()),
            ("userprofile/documents", format!("{home}/Documents")),
            (
                "userprofile/appdata/locallow",
                format!("{home}/AppData/LocalLow"),
            ),
            ("appdata", env("APPDATA", format!("{home}/AppData/Roaming"))),
            (
                "localappdata",
                env("LOCALAPPDATA", format!("{home}/AppData/Local")),
            ),
            (
                "programfiles",
                env("PROGRAMFILES", "C:/Program Files".into()),
            ),
            ("programdata", env("PROGRAMDATA", "C:/ProgramData".into())),
            ("public", env("PUBLIC", "C:/Users/Public".into())),
            ("windir", env("WINDIR", "C:/Windows".into())),
            ("hkcu", "HKEY_CURRENT_USER".into()),
            ("hklm", "HKEY_LOCAL_MACHINE".into()),
            ("wow64", "HKEY_LOCAL_MACHINE/SOFTWARE/WOW6432Node".into()),
            ("osxhome", home.clone()),
            ("linuxhome", home.clone()),
            (
                "xdgdatahome",
                env("XDG_DATA_HOME", format!("{home}/.local/share")),
            ),
            (
                "xdgconfighome",
                env("XDG_CONFIG_HOME", format!("{home}/.config")),
            ),
        ] {
            values.insert(name.into(), value.replace('\\', "/"));
        }
        for (name, field) in [
            ("steam", "steamPath"),
            ("uplay", "ubisoftPath"),
            ("ubisoftconnect", "ubisoftPath"),
        ] {
            if let Some(s) = data[field].as_str().filter(|s| !s.is_empty()) {
                values.insert(name.into(), s.replace('\\', "/"));
            }
        }
        if let Some(s) = install {
            values.insert("game".into(), s.replace('\\', "/"));
        }
        let ids = [
            "currentSteamUserId64",
            "currentSteamUserId3",
            "currentUbisoftUserId",
            "currentEpicUserId",
            "currentXboxUserId",
            "currentRockStarUserId",
        ]
        .iter()
        .filter_map(|k| data[*k].as_str())
        .filter(|s| !s.is_empty() && *s != "N/A" && fs::segment(s).is_ok())
        .map(str::to_owned)
        .collect();
        let xbox = data["currentXboxUserId"]
            .as_str()
            .filter(|s| !s.is_empty() && fs::segment(s).is_ok())
            .map(|s| vec![s.into()])
            .unwrap_or_default();
        let mut roots = vec![PathBuf::from(home)];
        for k in [
            "appdata",
            "localappdata",
            "programdata",
            "public",
            "steam",
            "uplay",
            "game",
        ] {
            if let Some(s) = values.get(k) {
                roots.push(PathBuf::from(s));
            }
        }
        if let Some(arr) = settings["gameInstalls"].as_array() {
            for v in arr {
                if let Some(s) = v.as_str() {
                    roots.push(PathBuf::from(s));
                }
            }
        }
        roots.retain(|p| fs::absolute(p).is_ok());
        let mut account_contexts = vec![];
        for (base_key, relative, id_key) in [
            ("steam", "userdata", "currentSteamUserId3"),
            ("uplay", "savegames", "currentUbisoftUserId"),
        ] {
            if let (Some(base), Some(id)) = (values.get(base_key), data[id_key].as_str()) {
                if !id.is_empty() && fs::segment(id).is_ok() {
                    account_contexts.push((
                        format!("{base}/{relative}/{{{{p|uid}}}}"),
                        format!("{base}/{relative}/{id}"),
                    ));
                }
            }
        }
        Self {
            values,
            ids,
            xbox,
            roots,
            all_accounts: settings["backupAllAccounts"] == true,
            account_contexts,
        }
    }
    pub fn expand(&self, template: &str, dynamic: bool) -> Result<String> {
        if template.is_empty() || template.len() > 32767 || template.contains(['\0', '\r', '\n']) {
            return Err("Invalid save template".into());
        }
        static PLACEHOLDER: OnceLock<regex::Regex> = OnceLock::new();
        let re = PLACEHOLDER.get_or_init(|| regex::Regex::new(r"(?i)\{\{p\|([^{}]+)\}\}").unwrap());
        let mut failed = None;
        let value = re
            .replace_all(template, |c: &regex::Captures| {
                let name = c[1].replace('\\', "/").to_lowercase();
                if name == "uid" || name == "xbox_uid" {
                    if dynamic {
                        return format!("{{{{p|{name}}}}}");
                    }
                    failed = Some("Backup template must be concrete".to_string());
                    return String::new();
                }
                match self.values.get(&name) {
                    Some(v) => v.clone(),
                    None => {
                        failed = Some(format!("Unknown save placeholder: {name}"));
                        String::new()
                    }
                }
            })
            .replace('\\', "/");
        if let Some(e) = failed {
            return Err(e);
        }
        if value
            .replace("{{p|uid}}", "")
            .replace("{{p|xbox_uid}}", "")
            .contains(['{', '}'])
        {
            return Err("Unresolved save template".into());
        }
        Ok(value)
    }
    fn final_template(&self, resolved: &str) -> String {
        let mut out = resolved.replace('\\', "/");
        let mut mapping: Vec<_> = self.values.iter().filter(|(_, v)| !v.is_empty()).collect();
        mapping.sort_by_key(|(_, v)| std::cmp::Reverse(v.len()));
        for (k, v) in mapping {
            if k == "username" || k == "systemdrive" {
                continue;
            }
            let re = literal_expression(v);
            out = re
                .replace_all(&out, |_: &regex::Captures| format!("{{{{p|{k}}}}}"))
                .into_owned();
        }
        out
    }
    pub fn resolve(&self, template: &str, registry: bool) -> Result<Vec<Value>> {
        self.resolve_internal(template, registry, None)
    }
    pub fn resolve_for_scan(
        &self,
        template: &str,
        registry: bool,
        scan: &mut fs::ScanContext,
    ) -> Result<Vec<Value>> {
        self.resolve_internal(template, registry, Some(scan))
    }
    fn resolve_internal(
        &self,
        template: &str,
        registry: bool,
        mut scan: Option<&mut fs::ScanContext>,
    ) -> Result<Vec<Value>> {
        if let Some(scan) = scan.as_deref_mut() {
            scan.check_cancelled()?;
        }
        let mut base = match self.expand(template, true) {
            Ok(v) => v,
            Err(_) => return Ok(vec![]),
        };
        if !self.all_accounts {
            for (pattern, replacement) in &self.account_contexts {
                let expression = literal_expression(pattern);
                base = expression
                    .replace_all(&base, |_: &regex::Captures| replacement.clone())
                    .into_owned();
            }
        }
        let dynamic = base.contains("{{p|");
        let mut candidates = vec![];
        if !dynamic {
            candidates.push(base.clone());
        } else if !self.all_accounts {
            let mut combinations = vec![base.clone()];
            for _ in 0..4 {
                let mut next = vec![];
                for c in combinations {
                    let name = if c.contains("{{p|uid}}") {
                        "{{p|uid}}"
                    } else if c.contains("{{p|xbox_uid}}") {
                        "{{p|xbox_uid}}"
                    } else {
                        next.push(c);
                        continue;
                    };
                    let ids = if name.contains("xbox") {
                        &self.xbox
                    } else {
                        &self.ids
                    };
                    for id in ids {
                        if next.len() >= 256 {
                            break;
                        }
                        next.push(c.replacen(name, id, 1));
                    }
                }
                combinations = next;
            }
            candidates.extend(combinations.into_iter().filter(|c| !c.contains("{{p|")));
        }
        let mut matches = vec![];
        for c in candidates {
            if registry {
                matches.extend(registry_paths(&c, false, scan.as_deref_mut())?);
            } else {
                matches.extend(glob_paths(&c, scan.as_deref_mut())?);
            }
            if dynamic && !matches.is_empty() && !self.all_accounts {
                break;
            }
        }
        if matches.is_empty() && dynamic || dynamic && self.all_accounts {
            let pattern = base
                .replace("{{p|uid}}", "*")
                .replace("{{p|xbox_uid}}", "*");
            matches = if registry {
                registry_paths(&pattern, true, scan.as_deref_mut())?
            } else {
                glob_paths(&pattern, scan.as_deref_mut())?
            };
            if !self.all_accounts && matches.len() > 1 {
                matches.sort_by_cached_key(|p| {
                    std::cmp::Reverse(
                        discovery_regular(Path::new(p), &mut scan)
                            .ok()
                            .and_then(|m| m.modified().ok()),
                    )
                });
                matches.truncate(1);
            }
        }
        if matches.is_empty() && !registry {
            if let Some((parent, name)) = base.rsplit_once('/') {
                if name.contains('*') {
                    matches = glob_paths(&format!("{parent}/*/{name}"), scan)?;
                }
            }
        }
        let mut seen = HashSet::new();
        Ok(matches.into_iter().filter(|s|seen.insert(if cfg!(windows){s.to_lowercase()}else{s.clone()})).map(|s|{let mut item=json!({"template":template,"finalTemplate":self.final_template(&s),"resolved":s});if registry{item["type"]=json!("reg");}item}).collect())
    }
}
fn registry_paths(
    pattern: &str,
    wildcard: bool,
    mut scan: Option<&mut fs::ScanContext>,
) -> Result<Vec<String>> {
    let key = format!("registry:{wildcard}:{pattern}");
    if let Some(scan) = scan.as_deref_mut() {
        scan.check_cancelled()?;
        if let Some(paths) = scan.cached_paths(&key) {
            return paths;
        }
    }
    let result = if wildcard {
        super::registry::expand(pattern)
    } else {
        Ok(super::registry::normalize(pattern)
            .ok()
            .filter(|path| super::registry::exists(path))
            .into_iter()
            .collect())
    };
    if let Some(scan) = scan {
        scan.remember_paths(key, &result);
    }
    result
}
fn discovery_regular(
    path: &Path,
    scan: &mut Option<&mut fs::ScanContext>,
) -> Result<std::fs::Metadata> {
    match scan.as_deref_mut() {
        Some(scan) => scan.regular(path),
        None => fs::regular(path),
    }
}
fn discovery_entries(
    path: &Path,
    scan: &mut Option<&mut fs::ScanContext>,
) -> Result<Box<dyn Iterator<Item = Result<PathBuf>>>> {
    if let Some(scan) = scan.as_deref_mut() {
        return Ok(Box::new(scan.read_dir(path)?));
    }
    fs::regular(path)?;
    Ok(Box::new(
        std::fs::read_dir(path)
            .map_err(fs::err)?
            .map(|entry| entry.map(|e| e.path()).map_err(fs::err)),
    ))
}
fn glob_paths(pattern: &str, mut scan: Option<&mut fs::ScanContext>) -> Result<Vec<String>> {
    let cleaned = pattern.replace('\\', "/");
    let key = format!("file:{cleaned}");
    if let Some(scan) = scan.as_deref_mut() {
        scan.check_cancelled()?;
        if let Some(paths) = scan.cached_paths(&key) {
            return paths;
        }
    }
    let result = glob_paths_inner(&cleaned, scan.as_deref_mut());
    if let Some(scan) = scan {
        scan.remember_paths(key, &result);
    }
    result
}
fn glob_paths_inner(cleaned: &str, mut scan: Option<&mut fs::ScanContext>) -> Result<Vec<String>> {
    if !cleaned.contains(['*', '?', '[']) {
        let p = Path::new(cleaned);
        return Ok(if discovery_regular(p, &mut scan).is_ok() {
            vec![cleaned.to_owned()]
        } else {
            vec![]
        });
    }
    let mut out = vec![];
    let options = glob::MatchOptions {
        case_sensitive: !cfg!(windows),
        require_literal_separator: true,
        require_literal_leading_dot: false,
    };
    // The glob crate's filesystem iterator follows directory links. Expand
    // components ourselves so junctions cannot cause recursion outside the
    // configured tree before the resulting match is validated.
    let path = Path::new(cleaned);
    if !path.is_absolute() {
        return Ok(vec![]);
    }
    let mut root = PathBuf::new();
    let mut segments = vec![];
    for component in path.components() {
        match component {
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                root.push(component.as_os_str())
            }
            std::path::Component::Normal(name) => {
                segments.push(name.to_string_lossy().into_owned())
            }
            _ => return Err("Save pattern contains traversal segments".into()),
        }
    }
    let mut pending = vec![(root, 0usize)];
    let mut visited = 0usize;
    while let Some((current, index)) = pending.pop() {
        if let Some(scan) = scan.as_deref_mut() {
            scan.check_cancelled()?;
        }
        visited += 1;
        if visited > 200000 {
            return Err("Save pattern exceeds traversal budget".into());
        }
        if current.components().count() > 64 {
            return Err("Save pattern exceeds depth limit".into());
        }
        let Ok(meta) = discovery_regular(&current, &mut scan) else {
            continue;
        };
        if index == segments.len() {
            if out.len() >= 10000 {
                return Err("Save pattern matches too many files".into());
            }
            out.push(current.to_string_lossy().into_owned());
            continue;
        }
        if !meta.is_dir() {
            continue;
        }
        let segment = &segments[index];
        if segment == "**" {
            pending.push((current.clone(), index + 1));
            for entry in discovery_entries(&current, &mut scan)? {
                if let Some(scan) = scan.as_deref_mut() {
                    scan.check_cancelled()?;
                }
                let entry = entry?;
                let Ok(meta) = discovery_regular(&entry, &mut scan) else {
                    continue;
                };
                if meta.is_dir() {
                    pending.push((entry, index));
                } else if index + 1 == segments.len() {
                    pending.push((entry, index + 1));
                }
            }
        } else if segment.contains(['*', '?', '[']) {
            let matcher = glob::Pattern::new(segment).map_err(fs::err)?;
            for entry in discovery_entries(&current, &mut scan)? {
                if let Some(scan) = scan.as_deref_mut() {
                    scan.check_cancelled()?;
                }
                let entry = entry?;
                if matcher.matches_with(
                    &entry.file_name().unwrap_or_default().to_string_lossy(),
                    options,
                ) {
                    pending.push((entry, index + 1));
                }
            }
        } else {
            pending.push((current.join(segment), index + 1));
        }
    }
    Ok(out)
}
pub fn pgs(path: &str) -> bool {
    let p = path.replace('\\', "/").to_lowercase();
    let rest = p.get(2..).unwrap_or("");
    p.as_bytes().get(1) == Some(&b':')
        && (rest == "/xboxgames/gamesave/pgs" || rest.starts_with("/xboxgames/gamesave/pgs/"))
}
