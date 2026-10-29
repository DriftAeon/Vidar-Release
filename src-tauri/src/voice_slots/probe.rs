//! src-tauri\src\voice_slots\probe.rs — root expansion and presence: does the command, each
//! `files[]` match and the picked model exist on disk. Every failure here is a `missing`
//! reason (the fill can supply it), except a path escaping its root (`ESCAPES`), which is
//! `broken`. No process is spawned.

use std::path::{Path, PathBuf};

use super::manifest::{self, FileSpec, ModelEntry};

/// The three roots a manifest may name. `home` is None without USERPROFILE.
#[derive(Clone)]
pub struct Roots {
    pub vidar: PathBuf,
    pub pack: PathBuf,
    pub home: Option<PathBuf>,
}

/// A file whose content is checked against a pin: the manifest's own hash when it declares
/// one, else the trust-on-first-use store.
pub struct Target {
    pub path: PathBuf,
    pub bytes: Option<u64>,
    pub sha256: Option<String>,
}

impl Target {
    pub fn tofu(path: PathBuf) -> Self {
        Target { path, bytes: None, sha256: None }
    }
}

/// Reason prefix of a rooted path that lands outside its root: `broken`, unlike every other
/// probe failure (the caller tells them apart by this prefix).
pub const ESCAPES: &str = "Path Escapes Root";

/// A validated rooted string (`manifest::check_rooted`) to a path, asserted to stay under its root.
pub fn expand_rooted(s: &str, roots: &Roots) -> Result<PathBuf, String> {
    manifest::check_rooted(s)?;
    let (root, tail) = match s[1..].split_once('}') {
        Some((root, tail)) => (root, tail),
        None => return Err(format!("Bad Root in {s:?}")),
    };
    let mut p = match root {
        "vidar" => roots.vidar.clone(),
        "pack" => roots.pack.clone(),
        "home" => roots.home.clone().ok_or("No USERPROFILE for {home}")?,
        _ => return Err(format!("Bad Root in {s:?}")),
    };
    let base = p.clone();
    for seg in tail.split('/').filter(|s| !s.is_empty()) {
        p.push(seg);
    }
    if !p.starts_with(&base) {
        return Err(format!("{ESCAPES}: {s:?}"));
    }
    Ok(p)
}

/// Rule 2 of the pins: only fetched artefacts are pinned, never files git tracks. Everything in
/// a non-stock pack is pinned (`stock_pack` None); under the Vidar root only the contract's
/// `vendor` dir and the `localVoice` dir's `.venv` and `models` are fetched; the rest is repo
/// content (the stock manifests, `listen.py`, `tools/`). Outside the
/// root (`{home}`) is pinned.
pub fn pinnable(path: &Path, roots: &Roots, stock_pack: bool) -> bool {
    if !stock_pack && path.starts_with(&roots.pack) {
        // First-party packs (claude, codex) are repo content: git tracks them, so rule 2 skips them.
        // A pack with no checkout behind it (a release install, a user pack) stays pinned.
        return !git_tracked(path, roots);
    }
    let Ok(rel) = path.strip_prefix(&roots.vidar) else {
        return true;
    };
    let voice = crate::paths::rel("localVoice");
    [crate::paths::rel("vendor"), voice.join(".venv"), voice.join("models")]
        .iter()
        .any(|fetched| rel.starts_with(fetched))
}

/// Whether the Vidar checkout's git index tracks `path` (false with no checkout, no git or any error).
fn git_tracked(path: &Path, roots: &Roots) -> bool {
    use crate::gitrun::{git, GitOpts};
    use std::time::Duration;
    if !roots.vidar.join(".git").exists() {
        return false;
    }
    let Ok(rel) = path.strip_prefix(&roots.vidar) else {
        return false;
    };
    let rel = rel.to_string_lossy().replace('\\', "/");
    let mut opts = GitOpts::read(Duration::from_secs(5), 4096);
    opts.ceiling = roots.vidar.parent();
    git(&roots.vidar, &["ls-files", "--error-unmatch", "--", &rel], &opts).is_ok()
}

fn is_rooted_arg(arg: &str) -> Result<bool, String> {
    Ok(manifest::tokens(arg)?.first().is_some_and(|&(at, name)| at == 0 && manifest::contract().roots.iter().any(|r| r == name)))
}

/// An argument: a rooted one becomes a path string, anything else is kept (its slot tokens
/// are filled per call by the stage that runs it).
pub fn expand_arg(arg: &str, roots: &Roots) -> Result<String, String> {
    if is_rooted_arg(arg)? {
        return Ok(expand_rooted(arg, roots)?.to_string_lossy().into_owned());
    }
    Ok(arg.to_string())
}

/// A rooted argument that resolves to an existing file (a script the command runs): a pin
/// target like a `files[]` path. Anything else is None.
pub fn arg_file(arg: &str, roots: &Roots) -> Result<Option<Target>, String> {
    if !is_rooted_arg(arg)? {
        return Ok(None);
    }
    let p = expand_rooted(arg, roots)?;
    Ok(p.is_file().then(|| Target::tofu(p)))
}

/// The command: `{path:<name>}` through PATH (never pinned: the PATH owner changes it), else
/// the rooted file, which must exist. The bool is "pin this".
pub fn command(cmd: &str, roots: &Roots) -> Result<(PathBuf, bool), String> {
    if let Some(name) = manifest::path_command(cmd) {
        return crate::which::find_on_path_exact(name).map(|p| (p, false)).ok_or_else(|| format!("Not On PATH: {name}"));
    }
    let p = expand_rooted(cmd, roots)?;
    exists(&p)?;
    Ok((p, true))
}

fn exists(p: &Path) -> Result<(), String> {
    if p.is_file() {
        Ok(())
    } else {
        Err(format!("Not Found: {}", p.display()))
    }
}

/// `*` in a file name: any run of characters, ASCII case-insensitive (Windows names).
fn wild(pattern: &str, name: &str) -> bool {
    let (p, n) = (pattern.to_ascii_lowercase(), name.to_ascii_lowercase());
    let parts: Vec<&str> = p.split('*').collect();
    if parts.len() == 1 {
        return p == n;
    }
    let (first, last) = (parts[0], parts[parts.len() - 1]);
    if !n.starts_with(first) || !n[first.len()..].ends_with(last) || n.len() < first.len() + last.len() {
        return false;
    }
    let mut rest = &n[first.len()..n.len() - last.len()];
    for mid in &parts[1..parts.len() - 1] {
        match rest.find(mid) {
            Some(i) => rest = &rest[i + mid.len()..],
            None => return false,
        }
    }
    true
}

/// Each `files[]` entry to its targets. A glob that matches nothing is missing, like a path.
pub fn files(specs: &[FileSpec], roots: &Roots) -> Result<Vec<Target>, String> {
    let mut out = Vec::new();
    for spec in specs {
        match spec {
            FileSpec::Entry(e) => {
                let p = expand_rooted(&e.file, roots)?;
                exists(&p)?;
                out.push(Target { path: p, bytes: e.bytes, sha256: e.sha256.clone() });
            }
            FileSpec::Path(s) if s.contains('*') => {
                let (dir, pattern) = s.rsplit_once('/').ok_or_else(|| format!("Bad Root in {s:?}"))?;
                let dir = expand_rooted(dir, roots)?;
                let mut hits: Vec<PathBuf> = std::fs::read_dir(&dir)
                    .map(|rd| {
                        rd.filter_map(|e| e.ok())
                            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                            .filter(|e| wild(pattern, &e.file_name().to_string_lossy()))
                            .map(|e| e.path())
                            .collect()
                    })
                    .unwrap_or_default();
                if hits.is_empty() {
                    return Err(format!("Not Found: {}", dir.join(pattern).display()));
                }
                hits.sort();
                out.extend(hits.into_iter().map(Target::tofu));
            }
            FileSpec::Path(s) => {
                let p = expand_rooted(s, roots)?;
                exists(&p)?;
                out.push(Target::tofu(p));
            }
        }
    }
    Ok(out)
}

/// The picked model's file, which must exist; its declared bytes/sha256 ride along.
pub fn model(entry: &ModelEntry, roots: &Roots) -> Result<(ModelEntry, Target), String> {
    let p = expand_rooted(&entry.file, roots)?;
    exists(&p)?;
    let resolved = ModelEntry { file: p.to_string_lossy().into_owned(), ..entry.clone() };
    Ok((resolved, Target { path: p, bytes: entry.bytes, sha256: entry.sha256.clone() }))
}

/// The fill line with `{vidar}`, `{pack}` and `{model}` expanded, forward slashes, for display.
pub fn fill(text: &str, roots: &Roots, model: Option<&str>) -> String {
    let fwd = |p: &Path| p.to_string_lossy().replace('\\', "/");
    let mut s = text.replace("{vidar}", &fwd(&roots.vidar)).replace("{pack}", &fwd(&roots.pack));
    if let Some(m) = model {
        s = s.replace("{model}", m);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fetched_and_repo_content_under_the_content_dir() {
        let roots = Roots { vidar: PathBuf::from(r"C:\v"), pack: PathBuf::from(r"C:\v\p"), home: None };
        let at = |s: &str| expand_rooted(s, &roots).unwrap();
        assert!(pinnable(&at("{vidar}/content/local-voice/.venv/Scripts/python.exe"), &roots, true));
        assert!(!pinnable(&at("{vidar}/content/local-voice/listen.py"), &roots, true));
    }

    #[test]
    fn git_tracked_first_party_pack_script_is_not_pinned() {
        let vidar = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        if !vidar.join(".git").exists() {
            return; // shipped tree: no checkout to ask
        }
        let pack = vidar.join(crate::paths::rel("packs")).join("claude");
        let roots = Roots { vidar, pack: pack.clone(), home: None };
        assert!(!pinnable(&pack.join("voice").join("rewrite_claude.py"), &roots, false));
        // A file git does not track in the same pack is still pinned.
        assert!(pinnable(&pack.join("voice").join("untracked-user-script.py"), &roots, false));
    }
}
