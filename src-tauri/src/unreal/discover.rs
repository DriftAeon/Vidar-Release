//! Finds the `.uproject` for a cwd: walk up, else scan down two levels. Cached per cwd.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime};

const UP_LEVELS: usize = 8;
const DOWN_DEPTH: usize = 2;
/// Directory visits allowed in the downward scan; a cwd like a drive root must not crawl.
const DOWN_BUDGET: usize = 400;
const CACHE_MAX: usize = 256;
const SKIP: [&str; 6] = ["node_modules", ".git", "saved", "intermediate", "binaries", "target"];

/// How long a "no project here" answer holds before the cwd is scanned again.
const MISS_TTL: Duration = Duration::from_secs(45);

static CACHE: LazyLock<Mutex<HashMap<String, Vec<PathBuf>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static MISSES: LazyLock<Mutex<HashMap<String, Instant>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn uprojects_in(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut v: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("uproject")) && p.is_file())
        .collect();
    v.sort();
    v
}

fn walk_up(cwd: &Path) -> Vec<PathBuf> {
    for dir in cwd.ancestors().take(UP_LEVELS) {
        let found = uprojects_in(dir);
        if !found.is_empty() { return found; }
    }
    Vec::new()
}

fn scan_down(cwd: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut budget = DOWN_BUDGET;
    let mut level = vec![cwd.to_path_buf()];
    for _ in 0..DOWN_DEPTH {
        let mut next = Vec::new();
        for dir in &level {
            let Ok(rd) = fs::read_dir(dir) else { continue };
            for e in rd.flatten() {
                if budget == 0 { return out; }
                budget -= 1; // every entry counts, files included
                let Ok(ft) = e.file_type() else { continue };
                if !ft.is_dir() { continue; }
                let p = e.path();
                let skip = p.file_name().and_then(|n| n.to_str()).is_none_or(|n| SKIP.contains(&n.to_lowercase().as_str()));
                if skip { continue; }
                out.extend(uprojects_in(&p));
                next.push(p);
            }
        }
        level = next;
    }
    out
}

fn log_time(uproject: &Path) -> Option<SystemTime> {
    let stem = uproject.file_stem()?;
    let log = uproject.parent()?.join("Saved").join("Logs").join(format!("{}.log", stem.to_string_lossy()));
    fs::metadata(log).ok()?.modified().ok()
}

/// The project whose log was written last; with no logs, the first by path.
fn newest(cands: &[PathBuf]) -> Option<PathBuf> {
    cands
        .iter()
        .max_by_key(|p| (log_time(p), std::cmp::Reverse((*p).clone())))
        .cloned()
}

fn recent_miss(key: &str) -> bool {
    MISSES.lock().ok().and_then(|m| m.get(key).copied()).is_some_and(|t| t.elapsed() < MISS_TTL)
}

/// The `.uproject` for `cwd`, or None. The candidate list is cached per cwd; a miss is cached
/// for `MISS_TTL` so a non-Unreal cwd is not re-scanned every poll, and a project created later
/// shows up after that. The pick among candidates re-runs each call.
pub fn find_uproject(cwd: &Path) -> Option<PathBuf> {
    let key = cwd.to_string_lossy().to_lowercase();
    if recent_miss(&key) { return None; }
    let cached = CACHE.lock().ok().and_then(|c| c.get(&key).cloned());
    if let Some(c) = cached {
        if c.iter().all(|p| p.is_file()) { return newest(&c); }
    }
    let mut found = walk_up(cwd);
    if found.is_empty() { found = scan_down(cwd); }
    if found.is_empty() {
        if let Ok(mut m) = MISSES.lock() {
            if m.len() >= CACHE_MAX { m.clear(); }
            m.insert(key, Instant::now());
        }
        return None;
    }
    if let Ok(mut c) = CACHE.lock() {
        if c.len() >= CACHE_MAX { c.clear(); }
        c.insert(key, found.clone());
    }
    newest(&found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acme() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/unreal/acme")
    }

    #[test]
    fn discover_walks_up_to_uproject() {
        let deep = acme().join("Saved").join("Logs");
        let found = find_uproject(&deep).unwrap();
        assert_eq!(found.file_name().unwrap(), "Acme.uproject");
        // second call comes from the cache and agrees
        assert_eq!(find_uproject(&deep), Some(found));
    }

    #[test]
    fn discover_scans_down_from_a_parent_and_misses_elsewhere() {
        let fixtures = acme().join("..");
        assert_eq!(find_uproject(&fixtures).unwrap().file_name().unwrap(), "Acme.uproject");
        assert!(find_uproject(Path::new(env!("CARGO_MANIFEST_DIR")).join("src").as_path()).is_none());
    }

    #[test]
    fn a_miss_is_cached_for_the_ttl() {
        let d = std::env::temp_dir().join(format!("vidar-unreal-miss-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        assert!(find_uproject(&d).is_none());
        assert!(recent_miss(&d.to_string_lossy().to_lowercase()));
        // a project created inside the TTL stays hidden until it lapses
        fs::write(d.join("Late.uproject"), "{}").unwrap();
        assert!(find_uproject(&d).is_none());
        let _ = fs::remove_dir_all(&d);
    }
}
