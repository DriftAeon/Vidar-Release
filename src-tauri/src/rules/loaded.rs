//! src-tauri\src\rules\loaded.rs — `runes_loaded`: which instruction files a Claude session loaded,
//! read from its transcript. `attachment.type` `instructions` (`files:[{path,type}]`) are the
//! session-start loads; `nested_memory` (path at `path`, type at `content.type`) are loads on touch.
//! Transcript content is untrusted and never returned: only paths and memory types leave.
//! Cache per (path, len, mtime); a grown file resumes from the last complete line.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use serde::Serialize;
use serde_json::Value;

use super::catalog::clean;

/// A transcript is read to at most this many bytes.
const CAP: u64 = 64 * 1024 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoadedFile {
    pub path: String,
    pub memory_type: String,
    /// `start` (instructions at session start) or `touch` (nested memory).
    pub when: &'static str,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Loaded {
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub files: Vec<LoadedFile>,
    pub truncated: bool,
}

fn none(reason: &str) -> Loaded {
    Loaded { source: "none", reason: Some(reason.into()), files: Vec::new(), truncated: false }
}

#[derive(Clone)]
struct Scan {
    len: u64,
    mtime: Option<SystemTime>,
    /// End of the last complete line consumed.
    offset: u64,
    files: Vec<LoadedFile>,
    seen: HashSet<String>,
    truncated: bool,
}

/// Scan cache entries kept; the oldest insert goes first.
const CACHE_MAX: usize = 32;

#[derive(Default)]
struct Cache {
    scans: HashMap<PathBuf, Scan>,
    /// Insert order of `scans` keys, oldest first.
    order: Vec<PathBuf>,
    /// session id -> transcript path found by the projects walk.
    transcripts: HashMap<String, PathBuf>,
}

impl Cache {
    fn put(&mut self, path: PathBuf, scan: Scan) {
        self.order.retain(|p| *p != path);
        self.order.push(path.clone());
        self.scans.insert(path, scan);
        while self.order.len() > CACHE_MAX {
            let old = self.order.remove(0);
            self.scans.remove(&old);
        }
    }
}

fn cache() -> &'static Mutex<Cache> {
    static C: OnceLock<Mutex<Cache>> = OnceLock::new();
    C.get_or_init(Default::default)
}

pub(crate) fn plain_id(s: &str, extra: &[char]) -> bool {
    // 128 matches `pty::kill::valid_tab_id`, which sits in a private module
    !s.is_empty() && s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || extra.contains(&c))
}

fn take(scan: &mut Scan, path: &str, memory_type: &str, when: &'static str) {
    let path = clean(Path::new(path));
    if scan.seen.insert(path.to_lowercase().replace('/', "\\")) {
        scan.files.push(LoadedFile { path, memory_type: memory_type.to_string(), when });
    }
}

fn read_line(scan: &mut Scan, line: &[u8]) {
    let has = |needle: &[u8]| line.windows(needle.len()).any(|w| w == needle);
    if !has(b"\"instructions\"") && !has(b"\"nested_memory\"") {
        return;
    }
    let Ok(v) = serde_json::from_slice::<Value>(line) else { return };
    let att = &v["attachment"];
    match att["type"].as_str() {
        Some("instructions") => {
            for f in att["files"].as_array().into_iter().flatten() {
                if let Some(p) = f["path"].as_str() {
                    take(scan, p, f["type"].as_str().unwrap_or(""), "start");
                }
            }
        }
        Some("nested_memory") => {
            if let Some(p) = att["path"].as_str() {
                take(scan, p, att.pointer("/content/type").and_then(|t| t.as_str()).unwrap_or(""), "touch");
            }
        }
        _ => {}
    }
}

/// Scan `path`, resuming from the cached offset when the file only grew.
pub fn scan_transcript(path: &Path) -> std::io::Result<Loaded> {
    let meta = std::fs::metadata(path)?;
    let (len, mtime) = (meta.len(), meta.modified().ok());
    let mut scan = {
        let cached = cache().lock().unwrap().scans.get(path).cloned();
        match cached {
            Some(c) if c.len == len && c.mtime == mtime => return Ok(done(&c)),
            Some(c) if len > c.len => c,
            _ => Scan { len, mtime, offset: 0, files: Vec::new(), seen: HashSet::new(), truncated: false },
        }
    };
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(scan.offset))?;
    // `take` bounds even a single newline-free line to the bytes the cap leaves, plus one to detect overrun
    let mut reader = BufReader::new(file.take((CAP + 1).saturating_sub(scan.offset)));
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf)? as u64;
        if n == 0 {
            break;
        }
        if scan.offset + n > CAP {
            scan.truncated = true;
            break;
        }
        if buf.last() != Some(&b'\n') {
            break; // a line still being written
        }
        scan.offset += n;
        read_line(&mut scan, &buf);
    }
    scan.len = len;
    scan.mtime = mtime;
    let out = done(&scan);
    cache().lock().unwrap().put(path.to_path_buf(), scan);
    Ok(out)
}

fn done(s: &Scan) -> Loaded {
    Loaded { source: "transcript", reason: None, files: s.files.clone(), truncated: s.truncated }
}

/// `<projects>\*\<sid>.jsonl`, the first folder holding it. `sid` is grammar-checked by the caller.
/// A found path is remembered per session id and reused while the file still exists.
fn find_transcript(projects: &Path, sid: &str) -> Option<PathBuf> {
    let known = cache().lock().unwrap().transcripts.get(sid).cloned();
    if let Some(p) = known.filter(|p| p.is_file()) {
        return Some(p);
    }
    let found = std::fs::read_dir(projects)
        .ok()?
        .flatten()
        .map(|d| d.path().join(format!("{sid}.jsonl")))
        .find(|p| p.is_file())?;
    let mut c = cache().lock().unwrap();
    if c.transcripts.len() >= CACHE_MAX * 4 {
        c.transcripts.clear();
    }
    c.transcripts.insert(sid.to_string(), found.clone());
    Some(found)
}

/// Ids are checked before any path join; only Claude tabs report loads.
fn loaded_in(
    sessions: &Path,
    projects: Option<&Path>,
    tab: &str,
    agent: &str,
    session_id: Option<&str>,
) -> Result<Loaded, String> {
    if !plain_id(tab, &['_']) {
        return Err(format!("invalid tab id `{tab}`"));
    }
    if let Some(s) = session_id {
        if !plain_id(s, &[]) {
            return Err(format!("invalid session id `{s}`"));
        }
    }
    match agent {
        "claude" => {}
        "codex" => return Ok(none("Codex Doesn't Report Loads")),
        _ => return Ok(none("No Agent in This Tab")),
    }
    let payload: Option<Value> = std::fs::read_to_string(sessions.join(format!("{tab}.json")))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    let sid = session_id
        .map(str::to_owned)
        .or_else(|| payload.as_ref()?.get("session_id")?.as_str().map(str::to_owned));
    let Some(sid) = sid else { return Ok(none("No Session Yet")) };
    if !plain_id(&sid, &[]) {
        return Err(format!("invalid session id `{sid}`"));
    }
    let from_payload = payload
        .as_ref()
        .and_then(|v| crate::status::transcript_from_payload(v, &sid, None, ""))
        .filter(|p| p.is_file());
    let Some(path) = from_payload.or_else(|| projects.and_then(|p| find_transcript(p, &sid))) else {
        return Ok(none("No Session Yet"));
    };
    scan_transcript(&path).or_else(|_| Ok(none("No Loads Recorded")))
}

#[tauri::command]
pub async fn runes_loaded(tab: String, agent: String, session_id: Option<String>, profile: Option<String>) -> Result<Loaded, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let projects = crate::bare::claude_dir::claude_dir_for(profile.as_deref()).map(|d| d.join("projects"));
        loaded_in(&crate::paths::sessions_dir(), projects.as_deref(), &tab, &agent, session_id.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/runes-catalog/transcript.jsonl")
    }

    #[test]
    fn runes_loaded_refuses_bad_ids() {
        let dir = std::env::temp_dir();
        for tab in ["", "../x", "a/b", "a\\b", "t.json", "a b"] {
            assert!(loaded_in(&dir, None, tab, "claude", None).is_err(), "tab {tab}");
            assert!(loaded_in(&dir, None, tab, "codex", None).is_err(), "tab {tab} codex");
        }
        for sid in ["../x", "a/b", "a\\b", "x.jsonl", ""] {
            assert!(loaded_in(&dir, None, "tab-1", "claude", Some(sid)).is_err(), "sid {sid}");
        }
        let codex = loaded_in(&dir, None, "tab-1", "codex", None).unwrap();
        assert_eq!((codex.source, codex.files.len()), ("none", 0));
        let none = loaded_in(&dir, None, "no-such-tab-zz", "claude", None).unwrap();
        assert_eq!(none.reason.as_deref(), Some("No Session Yet"));
    }

    #[test]
    fn runes_loaded_reads_start_and_touch_files() {
        let got = scan_transcript(&fixture()).unwrap();
        assert_eq!(got.source, "transcript");
        assert!(!got.truncated);
        let rows: Vec<(&str, &str, &str)> =
            got.files.iter().map(|f| (f.path.as_str(), f.memory_type.as_str(), f.when)).collect();
        assert_eq!(
            rows,
            vec![
                ("<home>/.claude/CLAUDE.md", "User", "start"),
                ("<repo>/CLAUDE.md", "Project", "start"),
                ("<repo>/.claude/rules/ui-copy.md", "Project", "touch"),
            ]
        );
        let json = serde_json::to_value(&got).unwrap();
        assert!(json.get("reason").is_none() && json["files"][2]["memoryType"] == "Project");

        // a grown file resumes: the appended line adds one entry, a duplicate path adds none
        let tmp = TempDir::new("grow");
        let copy = tmp.0.join("t.jsonl");
        std::fs::copy(fixture(), &copy).unwrap();
        assert_eq!(scan_transcript(&copy).unwrap().files.len(), 3);
        let extra = concat!(
            "{\"type\":\"attachment\",\"attachment\":{\"type\":\"nested_memory\",\"path\":\"<REPO>/CLAUDE.md\",\"content\":{\"type\":\"Project\"}}}\n",
            "{\"type\":\"attachment\",\"attachment\":{\"type\":\"nested_memory\",\"path\":\"<repo>/docs/rules.md\",\"content\":{\"type\":\"Project\"}}}\n",
        );
        let mut text = std::fs::read_to_string(&copy).unwrap();
        text.push_str(extra);
        std::fs::write(&copy, text).unwrap();
        let grown = scan_transcript(&copy).unwrap();
        assert_eq!(grown.files.len(), 4);
        assert_eq!(grown.files[3].path, "<repo>/docs/rules.md");
    }

    /// Temp dir removed on drop, so a failed assert leaves nothing behind.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("vidar-runes-loaded-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn nested(path: &str) -> String {
        format!(
            "{{\"type\":\"attachment\",\"attachment\":{{\"type\":\"nested_memory\",\"path\":\"{path}\",\"content\":{{\"type\":\"Project\"}}}}}}"
        )
    }

    #[test]
    fn runes_loaded_resumes_after_partial_trailing_line() {
        let tmp = TempDir::new("partial");
        let f = tmp.0.join("p.jsonl");
        let (a, b) = (nested("<p>/a.md"), nested("<p>/b.md"));
        let half = &b[..b.len() / 2];
        std::fs::write(&f, format!("{a}\n{half}")).unwrap();
        let first = scan_transcript(&f).unwrap();
        assert_eq!(first.files.len(), 1, "the unfinished line is not read");
        std::fs::write(&f, format!("{a}\n{b}\n")).unwrap();
        let second = scan_transcript(&f).unwrap();
        let paths: Vec<&str> = second.files.iter().map(|x| x.path.as_str()).collect();
        assert_eq!(paths, vec!["<p>/a.md", "<p>/b.md"]);
    }

    #[test]
    fn runes_loaded_rescans_when_file_shrinks() {
        let tmp = TempDir::new("shrink");
        let f = tmp.0.join("s.jsonl");
        std::fs::write(&f, format!("{}\n{}\n", nested("<s>/a.md"), nested("<s>/b.md"))).unwrap();
        assert_eq!(scan_transcript(&f).unwrap().files.len(), 2);
        std::fs::write(&f, format!("{}\n", nested("<s>/c.md"))).unwrap();
        let after = scan_transcript(&f).unwrap();
        let paths: Vec<&str> = after.files.iter().map(|x| x.path.as_str()).collect();
        assert_eq!(paths, vec!["<s>/c.md"]);
    }

    #[test]
    fn runes_loaded_dedupes_across_slash_forms() {
        let mut scan = Scan {
            len: 0,
            mtime: None,
            offset: 0,
            files: Vec::new(),
            seen: HashSet::new(),
            truncated: false,
        };
        take(&mut scan, "C:/Repo/CLAUDE.md", "Project", "start");
        take(&mut scan, "c:\\repo\\claude.md", "Project", "touch");
        assert_eq!(scan.files.len(), 1);
    }
}
