use std::{io::Write, path::Path};

pub fn error(app_data: &Path, message: &str) {
    let path = app_data.join("logs/main-error.log");
    if crate::saves::fs::no_links(&path).is_err() {
        return;
    }
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let rotate = std::fs::metadata(&path)
        .map(|m| m.len() > 5 * 1024 * 1024)
        .unwrap_or(false);
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true);
    if rotate {
        options.truncate(true);
    } else {
        options.append(true);
    }
    if let Ok(mut file) = options.open(path) {
        let _ = writeln!(file, "[{}] {}", chrono::Utc::now().to_rfc3339(), message);
    }
}
