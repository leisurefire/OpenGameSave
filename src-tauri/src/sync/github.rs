use super::{
    manifest,
    util::{self, err, Result},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    io::Read,
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::Duration,
};
use wait_timeout::ChildExt;

const MAX_OUTPUT: u64 = 10 * 1024 * 1024;
const SAFE_CONFIG: &[(&str, &str)] = &[
    ("core.fsmonitor", "false"),
    ("core.sshCommand", "ssh"),
    ("ssh.variant", "ssh"),
    ("commit.gpgSign", "false"),
    ("tag.gpgSign", "false"),
    ("push.gpgSign", "false"),
    ("merge.verifySignatures", "false"),
    ("submodule.recurse", "false"),
    ("fetch.recurseSubmodules", "false"),
    ("push.recurseSubmodules", "false"),
    ("gc.auto", "0"),
    ("maintenance.auto", "false"),
    ("protocol.allow", "never"),
    ("protocol.https.allow", "always"),
    ("protocol.ssh.allow", "always"),
];
fn scrub(message: &str) -> String {
    let url = regex::Regex::new(r"(?i)https://[^\s/@]+(?::[^\s/@]*)?@github\.com").unwrap();
    let token =
        regex::Regex::new(r"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+)\b").unwrap();
    token
        .replace_all(
            &url.replace_all(message, "https://[redacted]@github.com"),
            "[redacted-token]",
        )
        .chars()
        .take(10000)
        .collect()
}
fn read_output(pipe: impl Read + Send + 'static) -> Receiver<std::io::Result<Vec<u8>>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = pipe
            .take(MAX_OUTPUT + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = sender.send(result);
    });
    receiver
}
fn receive_output(
    receiver: Receiver<std::io::Result<Vec<u8>>>,
    timeout: Duration,
) -> Result<Vec<u8>> {
    receiver
        .recv_timeout(timeout)
        .map_err(|_| "Git helper kept an output pipe open after the command exited".to_owned())?
        .map_err(err)
}
fn stop_process_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let taskkill = std::path::PathBuf::from(
            std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()),
        )
        .join("System32/taskkill.exe");
        if let Ok(mut cleanup) = Command::new(taskkill)
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .spawn()
        {
            if !matches!(cleanup.wait_timeout(Duration::from_secs(3)), Ok(Some(_))) {
                let _ = cleanup.kill();
                let _ = cleanup.wait();
            }
        }
    }
    #[cfg(unix)]
    {
        extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        // Each Git invocation has its own process group; never target the app's group.
        if let Ok(pid) = i32::try_from(child.id()) {
            unsafe {
                kill(-pid, 9);
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}
fn raw(root: &Path, args: &[&str], allowed: &[i32]) -> Result<String> {
    let mut command = Command::new("git");
    command.arg("--no-pager").arg("-c").arg(if cfg!(windows) {
        "core.hooksPath=NUL"
    } else {
        "core.hooksPath=/dev/null"
    });
    for (key, value) in SAFE_CONFIG {
        command.arg("-c").arg(format!("{key}={value}"));
    }
    command
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.env_clear();
    for (key, value) in std::env::vars_os() {
        let upper = key.to_string_lossy().to_uppercase();
        if upper == "GIT"
            || upper.starts_with("GIT_")
            || upper == "SSH_ASKPASS"
            || upper == "SSH_ASKPASS_REQUIRE"
        {
            continue;
        }
        command.env(key, value);
    }
    command.env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Unable to run Git; install Git and make it available on PATH".to_owned())?;
    let stdout = child.stdout.take().ok_or("Missing Git stdout")?;
    let stderr = child.stderr.take().ok_or("Missing Git stderr")?;
    let out = read_output(stdout);
    let error = read_output(stderr);
    let status = match child.wait_timeout(Duration::from_secs(120)) {
        Ok(Some(status)) => status,
        Ok(None) => {
            stop_process_tree(&mut child);
            return Err("Git command timed out after 120 seconds".into());
        }
        Err(error) => {
            stop_process_tree(&mut child);
            return Err(err(error));
        }
    };
    // A descendant may inherit stdout/stderr and outlive Git. Never join its
    // reader without a deadline while holding the application's operation lock.
    // Git has already exited; an output timeout must not target a reused PID.
    let stdout = receive_output(out, Duration::from_secs(2))?;
    let stderr = receive_output(error, Duration::from_secs(2))?;
    if stdout.len() as u64 > MAX_OUTPUT || stderr.len() as u64 > MAX_OUTPUT {
        return Err("Git command output exceeded its safety limit".into());
    }
    if !status.success() && !status.code().is_some_and(|code| allowed.contains(&code)) {
        return Err(scrub(&String::from_utf8_lossy(&stderr)));
    }
    String::from_utf8(stdout)
        .map_err(|_| "Git returned a non-Unicode path; use portable backup filenames".into())
}
fn unsafe_config(key: &str) -> bool {
    let key = key.to_lowercase();
    matches!(
        key.as_str(),
        "core.sshcommand"
            | "core.askpass"
            | "core.gitproxy"
            | "core.alternaterefscommand"
            | "gpg.program"
            | "gpg.ssh.defaultkeycommand"
            | "diff.external"
            | "include.path"
            | "fetch.bundleuri"
            | "extensions.partialclone"
            | "gc.recentobjectshook"
    ) || (key.starts_with("gpg.") && key.ends_with(".program"))
        || (key.starts_with("credential.") && key.ends_with(".helper"))
        || (key.starts_with("filter.")
            && [".clean", ".smudge", ".process"]
                .iter()
                .any(|s| key.ends_with(s)))
        || (key.starts_with("diff.") && [".command", ".textconv"].iter().any(|s| key.ends_with(s)))
        || (key.starts_with("merge.") && key.ends_with(".driver"))
        || (["difftool.", "mergetool."]
            .iter()
            .any(|p| key.starts_with(p))
            && key.ends_with(".cmd"))
        || (key.starts_with("hook.") && key.ends_with(".command"))
        || (key.starts_with("includeif.") && key.ends_with(".path"))
        || (key.starts_with("url.")
            && [".insteadof", ".pushinsteadof"]
                .iter()
                .any(|s| key.ends_with(s)))
        || (key.starts_with("remote.")
            && [
                ".vcs",
                ".uploadpack",
                ".receivepack",
                ".promisor",
                ".partialclonefilter",
            ]
            .iter()
            .any(|s| key.ends_with(s)))
        || (key.starts_with("submodule.") && key.ends_with(".update"))
}
fn audit(root: &Path) -> Result<()> {
    util::no_links(root)?;
    util::no_links(&root.join(".git"))?;
    let output = raw(
        root,
        &[
            "config",
            "--no-includes",
            "--show-scope",
            "--null",
            "--name-only",
            "--list",
        ],
        &[],
    )?;
    if !output.ends_with('\0') {
        return Err("Unable to audit repository Git configuration".into());
    }
    let fields = output
        .trim_end_matches('\0')
        .split('\0')
        .collect::<Vec<_>>();
    if fields.len() % 2 != 0 {
        return Err("Malformed repository configuration audit".into());
    }
    for pair in fields.as_chunks::<2>().0 {
        if matches!(pair[0], "local" | "worktree") && unsafe_config(pair[1]) {
            return Err("Unsafe repository Git configuration can execute commands or redirect synchronization; remove it before syncing".into());
        }
    }
    Ok(())
}
fn git(root: &Path, args: &[&str]) -> Result<String> {
    audit(root)?;
    raw(root, args, &[])
}
fn allowed_git(root: &Path, args: &[&str], allowed: &[i32]) -> Result<String> {
    audit(root)?;
    raw(root, args, allowed)
}
fn remote(value: &str) -> Option<String> {
    let lines = value.lines().filter(|s| !s.is_empty()).collect::<Vec<_>>();
    if lines.len() != 1 {
        return None;
    }
    let value = lines[0].trim();
    let valid = |path: &str| {
        let parts = path.split('/').collect::<Vec<_>>();
        parts.len() == 2
            && parts.iter().all(|p| {
                !p.is_empty()
                    && !matches!(*p, "." | "..")
                    && p.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
            })
    };
    if let Some(path) = value.strip_prefix("git@github.com:") {
        return valid(path).then(|| value.into());
    }
    let url = url::Url::parse(value).ok()?;
    if url.host_str() != Some("github.com")
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.password().is_some()
        || !valid(url.path().strip_prefix('/')?)
    {
        return None;
    }
    if (url.scheme() == "https" && url.username().is_empty())
        || (url.scheme() == "ssh" && url.username() == "git")
    {
        Some(url.to_string())
    } else {
        None
    }
}
fn identity(remote: &str) -> String {
    remote
        .strip_prefix("git@github.com:")
        .unwrap_or_else(|| remote.split("github.com/").nth(1).unwrap_or(""))
        .trim_end_matches(".git")
        .to_lowercase()
}
pub fn status(settings: &Value, requested: Option<&Value>) -> Value {
    let root = match util::sync_root(settings, requested) {
        Ok(root) => root,
        Err(message) => {
            return json!({"configured":false,"syncPath":"","repoRoot":"","exists":false,"isGitRepo":false,"hasRemote":false,"branch":"","remoteUrl":"","dirty":false,"message":message})
        }
    };
    let mut result = json!({"configured":true,"syncPath":root,"repoRoot":root,"exists":root.is_dir(),"isGitRepo":false,"hasRemote":false,"branch":"","remoteUrl":"","dirty":false,"message":""});
    let check = (|| {
        if !root.is_dir() {
            return Err("The configured backup repository does not exist".into());
        }
        if git(&root, &["rev-parse", "--is-inside-work-tree"])?.trim() != "true" {
            return Err("The backup directory must be a Git repository".into());
        }
        let top = git(&root, &["rev-parse", "--show-toplevel"])?;
        let top = std::path::PathBuf::from(top.trim());
        // Git normalizes Windows separators; canonicalization also handles that.
        if !util::same_path(
            &top.canonicalize().map_err(err)?,
            &root.canonicalize().map_err(err)?,
        ) {
            return Err("The backup directory must be the Git repository root".into());
        }
        result["isGitRepo"] = json!(true);
        let branch = git(&root, &["branch", "--show-current"])?;
        result["branch"] = json!(branch.trim());
        if branch.trim().is_empty() {
            return Err("Check out a Git branch before synchronization".into());
        }
        let fetch = remote(&git(&root, &["remote", "get-url", "--all", "origin"])?)
            .ok_or("Configure exactly one credential-free GitHub origin URL")?;
        let push = remote(&git(
            &root,
            &["remote", "get-url", "--push", "--all", "origin"],
        )?)
        .ok_or("Configure exactly one credential-free GitHub push URL")?;
        if identity(&fetch) != identity(&push) {
            return Err("GitHub fetch and push repositories must match".into());
        }
        result["remoteUrl"] = json!(fetch);
        result["dirty"] = json!(!git(&root, &["status", "--short", "--", "."])?
            .trim()
            .is_empty());
        result["hasRemote"] = json!(true);
        result["message"] = json!("GitHub synchronization is ready");
        Ok::<(), String>(())
    })();
    if let Err(message) = check {
        result["hasRemote"] = json!(false);
        result["message"] = json!(message);
    }
    result
}
fn revision(value: &str) -> Result<&str> {
    let value = value.trim();
    if !matches!(value.len(), 40 | 64) || !value.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Git returned an invalid revision identifier".into());
    }
    Ok(value)
}
fn paths(output: &str) -> Result<Vec<&str>> {
    if output.is_empty() {
        return Ok(vec![]);
    }
    if !output.ends_with('\0') {
        return Err("Malformed NUL-delimited Git path list".into());
    }
    let paths = output[..output.len() - 1].split('\0').collect::<Vec<_>>();
    if paths.iter().any(|p| p.is_empty()) {
        return Err("Invalid Git path list".into());
    }
    Ok(paths)
}
fn mark_external(root: &Path, changed: &[&str]) -> Result<()> {
    let mut owners = BTreeSet::new();
    let mut errors = Vec::new();
    for path in changed {
        let segments = path.split('/').collect::<Vec<_>>();
        let metadata_like = segments
            .last()
            .is_some_and(|p| p.eq_ignore_ascii_case("backup_info.json"));
        if path.starts_with('/')
            || path.contains('\\')
            || path.chars().any(|c| c < ' ')
            || segments
                .iter()
                .any(|s| s.is_empty() || matches!(*s, "." | ".."))
            || path.len() > 4096
        {
            errors.push("Remote Git history contains an unsafe backup path".to_owned());
            continue;
        }
        if metadata_like && segments.len() != 3 {
            errors.push("Remote Git history contains misplaced backup metadata".into());
            continue;
        }
        if segments.len() < 3 {
            continue;
        }
        let key = segments[..2].join("/");
        if manifest::backup_key(&key).is_err() {
            if metadata_like {
                errors.push("Remote Git history contains noncanonical backup metadata".into());
            }
            continue;
        }
        owners.insert(key);
    }
    // Downgrade every valid owner even when a sibling fails validation.
    for key in owners {
        let result = (|| {
            let path = root.join(key).join("backup_info.json");
            let mut metadata = manifest::metadata(util::read_json(&path, 1024 * 1024)?)?;
            metadata["provenance"] = json!("external");
            util::atomic_json(&path, &metadata)
        })();
        if let Err(error) = result {
            errors.push(error);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Remote backup validation failed: {}",
            errors.join("; ")
        ))
    }
}
fn pull(root: &Path, audit_all: bool) -> Result<()> {
    let old = allowed_git(root, &["rev-parse", "--verify", "--quiet", "HEAD"], &[1])?;
    if !old.trim().is_empty() {
        revision(&old)?;
    }
    git(root, &["pull", "--ff-only", "origin", "main"])?;
    let new = git(root, &["rev-parse", "--verify", "HEAD"])?;
    let new = revision(&new)?;
    let changed = if old.trim() == new {
        String::new()
    } else if old.trim().is_empty() {
        git(
            root,
            &[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "-r",
                "--name-only",
                "-z",
                "--diff-filter=AMT",
                "--no-renames",
                new,
                "--",
            ],
        )?
    } else {
        git(
            root,
            &[
                "diff",
                "--name-only",
                "-z",
                "--diff-filter=AMT",
                "--no-renames",
                old.trim(),
                new,
                "--",
            ],
        )?
    };
    let tracked = if audit_all {
        git(root, &["ls-files", "-z", "--"])?
    } else {
        String::new()
    };
    let mut changed = paths(&changed)?;
    changed.extend(paths(&tracked)?);
    mark_external(root, &changed)
}
pub fn run(root: &Path, settings: &Value, direction: &str) -> Result<Value> {
    let status = status(settings, Some(&json!(root)));
    if status["isGitRepo"] != true || status["hasRemote"] != true {
        return Err(status["message"]
            .as_str()
            .unwrap_or("GitHub synchronization is not ready")
            .into());
    }
    let mut committed = false;
    if direction == "download" {
        pull(root, true)?;
        util::prune(root, settings)?;
    } else {
        let exists = !git(root, &["ls-remote", "--heads", "origin", "main"])?
            .trim()
            .is_empty();
        if exists {
            pull(root, false)?;
        }
        util::prune(root, settings)?;
        // Validate every owned backup before staging content or pruning further.
        manifest::collect(root)?;
        git(root, &["add", "--all", "--", "."])?;
        let dirty = !git(root, &["status", "--short", "--", "."])?
            .trim()
            .is_empty();
        let message = format!(
            "OpenGameSave backup {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M")
        );
        if dirty {
            git(root, &["commit", "-m", &message])?;
            committed = true;
        } else if !exists {
            git(root, &["commit", "--allow-empty", "-m", &message])?;
            committed = true;
        }
        if exists {
            git(root, &["push", "origin", "HEAD:main"])?;
        } else {
            git(root, &["push", "-u", "origin", "HEAD:main"])?;
        }
    }
    let files = manifest::collect(root)?;
    let mut result = json!({"syncPath":root,"repoRoot":root,"size":files.iter().map(|f|f.size).sum::<u64>(),"games":files.iter().map(|f|f.path.split('/').next().unwrap()).collect::<BTreeSet<_>>().len()});
    if direction == "upload" {
        result["committed"] = json!(committed);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inherited_output_pipe_cannot_block_sync_forever() {
        let (sender, receiver) = mpsc::channel::<std::io::Result<Vec<u8>>>();
        let start = std::time::Instant::now();
        assert!(receive_output(receiver, Duration::from_millis(5)).is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
        drop(sender);
        let output = read_output(std::io::Cursor::new(b"git output".to_vec()));
        assert_eq!(
            receive_output(output, Duration::from_secs(1)).unwrap(),
            b"git output"
        );
    }
    #[test]
    fn rejects_command_config_categories() {
        for key in [
            "core.sshCommand",
            "credential.helper",
            "credential.https://github.com.helper",
            "filter.x.process",
            "includeIf.gitdir:foo.path",
            "url.file:///tmp/.insteadOf",
            "remote.origin.uploadpack",
            "submodule.foo.update",
        ] {
            assert!(unsafe_config(key), "{key}");
        }
        assert!(!unsafe_config("user.name"));
        assert!(!unsafe_config("remote.origin.url"));
    }
    #[test]
    fn github_remote_allowlist_rejects_credentials_and_helpers() {
        for value in [
            "https://token@github.com/a/b",
            "https://github.com.evil/a/b",
            "https://github.com:8443/a/b",
            "ext::sh -c boom",
            "file:///tmp/repo",
            "https://github.com/a/b\nhttps://github.com/a/c",
        ] {
            assert!(remote(value).is_none(), "{value}");
        }
        assert!(remote("git@github.com:owner/repo.git").is_some());
        assert!(remote("https://github.com/owner/repo.git").is_some());
    }
    #[test]
    fn repository_local_helpers_are_rejected_before_execution() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        assert!(Command::new("git")
            .args(["init", "--quiet"])
            .arg(root)
            .status()
            .unwrap()
            .success());
        std::fs::write(
            root.join(".git/config"),
            "[core]\nrepositoryformatversion=0\n[credential]\nhelper = !echo unsafe\n",
        )
        .unwrap();
        assert!(audit(root).unwrap_err().contains("Unsafe repository"));
    }
    #[test]
    fn payload_change_downgrades_owning_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let path = root.join("1/2026-08-18_10-00-00/backup_info.json");
        util::atomic_json(
            &path,
            &json!({"title":"Game","backup_paths":[],"provenance":"local"}),
        )
        .unwrap();
        mark_external(root, &["1/2026-08-18_10-00-00/path1/save.dat"]).unwrap();
        assert_eq!(
            util::read_json(&path, 1024).unwrap()["provenance"],
            "external"
        );
    }
}
