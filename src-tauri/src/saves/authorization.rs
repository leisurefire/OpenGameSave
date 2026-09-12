use super::{
    fs::{self, Result},
    registry,
    resolver::Resolver,
};
use std::path::{Path, PathBuf};

pub fn forbidden(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    [
        "app", "bat", "bash", "cmd", "com", "cpl", "dll", "dylib", "exe", "fish", "hta", "jar",
        "js", "jse", "lnk", "msi", "msp", "ps1", "psd1", "psm1", "py", "pyw", "rb", "reg", "scr",
        "sh", "so", "url", "vbe", "vbs", "wsf", "wsh", "zsh",
    ]
    .contains(&extension.as_str())
}
fn dynamic(s: &str) -> bool {
    s.contains(['*', '?', '[']) || s.contains("{{p|")
}
fn segment_match(pattern: &str, concrete: &str, resolver: &Resolver) -> Result<bool> {
    let placeholders = regex::Regex::new(r"\{\{p\|(uid|xbox_uid)\}\}").unwrap();
    let mut expression = String::new();
    let mut cursor = 0;
    for m in placeholders.captures_iter(pattern) {
        let whole = m.get(0).unwrap();
        expression.push_str(&glob_regex(&pattern[cursor..whole.start()])?);
        let values = if &m[1] == "xbox_uid" {
            &resolver.xbox
        } else {
            &resolver.ids
        };
        if values.is_empty() {
            return Ok(false);
        }
        expression.push_str(&format!(
            "(?:{})",
            values
                .iter()
                .map(|s| regex::escape(s))
                .collect::<Vec<_>>()
                .join("|")
        ));
        cursor = whole.end();
    }
    expression.push_str(&glob_regex(&pattern[cursor..])?);
    Ok(regex::RegexBuilder::new(&format!("^{expression}$"))
        .case_insensitive(cfg!(windows))
        .build()
        .map_err(fs::err)?
        .is_match(concrete))
}
fn glob_regex(pattern: &str) -> Result<String> {
    let mut out = String::new();
    let chars: Vec<_> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' => out.push_str("[^/]*"),
            '?' => out.push_str("[^/]"),
            '[' => {
                let end = chars[i + 1..]
                    .iter()
                    .position(|&c| c == ']')
                    .map(|n| n + i + 1);
                if let Some(end) = end {
                    let mut class = chars[i + 1..end].iter().collect::<String>();
                    if class.is_empty() || class.contains(['\\', '/']) {
                        return Err("Unsafe wildcard class".into());
                    }
                    if class.starts_with('!') {
                        class.replace_range(..1, "^");
                    }
                    out.push('[');
                    out.push_str(&class);
                    out.push(']');
                    i = end;
                } else {
                    out.push_str("\\[");
                }
            }
            c => out.push_str(&regex::escape(&c.to_string())),
        }
        i += 1;
    }
    Ok(out)
}
fn pattern_matches(pattern: &str, path: &str, resolver: &Resolver) -> Result<bool> {
    let parts: Vec<_> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    let concrete: Vec<_> = path.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() > 256 || concrete.len() > 256 {
        return Err("Restore path exceeds segment limit".into());
    }
    let mut memo = std::collections::HashMap::new();
    fn visit(
        i: usize,
        j: usize,
        p: &[&str],
        c: &[&str],
        r: &Resolver,
        m: &mut std::collections::HashMap<(usize, usize), bool>,
    ) -> Result<bool> {
        if let Some(v) = m.get(&(i, j)) {
            return Ok(*v);
        }
        let found = if i == p.len() {
            j == c.len()
        } else if p[i] == "**" {
            visit(i + 1, j, p, c, r, m)? || (j < c.len() && visit(i, j + 1, p, c, r, m)?)
        } else {
            j < c.len() && segment_match(p[i], c[j], r)? && visit(i + 1, j + 1, p, c, r, m)?
        };
        m.insert((i, j), found);
        Ok(found)
    }
    visit(0, 0, &parts, &concrete, resolver, &mut memo)
}
fn safe_scope(pattern: &str, root: &Path, dest: &Path) -> Result<()> {
    let root = fs::key(root);
    let folded = if cfg!(windows) {
        pattern.to_lowercase()
    } else {
        pattern.into()
    };
    let relative = folded
        .strip_prefix(&(root.trim_end_matches('/').to_owned() + "/"))
        .ok_or("Restore pattern has a dynamic or unrelated authorized root")?;
    let parts: Vec<_> = relative.split('/').collect();
    for (i, p) in parts.iter().enumerate() {
        let before = parts[..i].iter().any(|s| !dynamic(s));
        let after = parts[i + 1..].iter().any(|s| !dynamic(s));
        if (*p == "**" && (!before || !after))
            || ((p.chars().all(|c| c == '*' || c == '?') || p.contains("{{p|")) && !before)
        {
            return Err("Wildcard restore requires a fixed game-specific prefix".into());
        }
    }
    if parts.iter().any(|s| dynamic(s)) && forbidden(dest) {
        return Err("Wildcards cannot authorize executable or script destinations".into());
    }
    Ok(())
}
pub fn file_destination(
    resolver: &Resolver,
    templates: &[String],
    concrete: &str,
) -> Result<(PathBuf, PathBuf)> {
    let expanded = resolver.expand(concrete, false)?;
    if expanded.contains(['*', '?']) {
        return Err("Backup destination must be concrete".into());
    }
    let destination = PathBuf::from(&expanded);
    fs::absolute(&destination)?;
    let root = resolver
        .roots
        .iter()
        .filter(|root| fs::inside(root, &destination) && fs::key(root) != fs::key(&destination))
        .max_by_key(|p| p.as_os_str().len())
        .ok_or("Restore destination is outside allowed roots")?
        .clone();
    for template in templates {
        let Ok(pattern) = resolver.expand(template, true) else {
            continue;
        };
        let mut candidates = vec![pattern.clone()];
        if let Some((parent, base)) = pattern.rsplit_once('/') {
            if base.contains('*') {
                candidates.push(format!("{parent}/*/{base}"));
            }
        }
        for candidate in candidates {
            if candidate.split('/').any(|s| s == ".." || s == ".") {
                continue;
            }
            if pattern_matches(&candidate, &expanded, resolver).unwrap_or(false)
                && safe_scope(&candidate, &root, &destination).is_ok()
            {
                fs::no_links(&destination)?;
                return Ok((destination, root));
            }
        }
    }
    Err("Backup destination is not authorized by the current game database".into())
}
pub fn registry_destination(
    resolver: &Resolver,
    templates: &[String],
    concrete: &str,
) -> Result<String> {
    let destination = registry::normalize(&resolver.expand(concrete, false)?)?;
    for template in templates {
        let Ok(pattern) = resolver.expand(template, true) else {
            continue;
        };
        let pattern = pattern.replace('\\', "/");
        let parts: Vec<_> = pattern.split('/').collect();
        if parts.iter().any(|p| p.contains(['*', '?', '[']))
            || parts.iter().take(3).any(|p| dynamic(p))
        {
            continue;
        }
        if pattern_matches(&pattern, &destination.replace('\\', "/"), resolver)? {
            return Ok(destination);
        }
    }
    Err("Registry destination is not authorized by the current game database".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn trusted_ids_and_game_scope_are_required() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Resolver::new(&json!({}), &json!({}), None);
        let root = dir.path().to_path_buf();
        r.values.insert(
            "linuxhome".into(),
            root.to_string_lossy().replace('\\', "/"),
        );
        r.roots = vec![root];
        r.ids = vec!["123".into()];
        let templates = vec!["{{p|linuxhome}}/Game/{{p|uid}}/*.sav".into()];
        assert!(file_destination(&r, &templates, "{{p|linuxhome}}/Game/123/slot.sav").is_ok());
        assert!(file_destination(&r, &templates, "{{p|linuxhome}}/Game/456/slot.sav").is_err());
        assert!(file_destination(&r, &templates, "{{p|linuxhome}}/../slot.sav").is_err());
        assert!(
            file_destination(&r, &["{{p|linuxhome}}/*".into()], "{{p|linuxhome}}/other").is_err()
        );
        assert!(file_destination(
            &r,
            &["{{p|linuxhome}}/Game/*".into()],
            "{{p|linuxhome}}/Game/bad.exe"
        )
        .is_err());
    }
}
