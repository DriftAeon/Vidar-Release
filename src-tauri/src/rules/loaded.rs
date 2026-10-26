//! src-tauri\src\rules\loaded.rs — `runes_loaded`: which instruction files a Claude session loaded,
//! read from its transcript. `attachment.type` `instructions` (`files:[{path,type}]`) are the
//! session-start loads; `nested_memory` (path at `path`, type at `content.type`) are loads on touch.
//! `scan_transcript` also reads a Codex rollout (`CODEX_HOME\sessions\...\rollout-*.jsonl`): its
//! completed `CommandExecution` items give `reads` and `runeReads` (`codex_line`); the runes probe
//! uses it. A Codex tab's `runes_loaded` answers from its session record and vault, plus its
//! rollout's injected head (`bare::codex_runes_loaded`); each such row names its `source`.
//! Transcript content is untrusted and never returned: only paths, memory types and Skill names leave.
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
    /// Codex rows only: `vault` (a rune the session's vault loads) or `rollout` (Codex's own injection).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<&'static str>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Loaded {
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub files: Vec<LoadedFile>,
    pub reads: Vec<String>,
    /// Rune ids read through a `vidar-runes/<id>.md` skill copy.
    #[serde(rename = "runeReads")]
    pub rune_reads: Vec<String>,
    pub skills: Vec<String>,
    pub truncated: bool,
}

pub(crate) fn none(reason: &str) -> Loaded {
    Loaded { source: "none", reason: Some(reason.into()), files: Vec::new(), reads: Vec::new(), rune_reads: Vec::new(), skills: Vec::new(), truncated: false }
}

#[derive(Clone)]
struct Scan {
    len: u64,
    mtime: Option<SystemTime>,
    /// End of the last complete line consumed.
    offset: u64,
    files: Vec<LoadedFile>,
    seen: HashSet<String>,
    reads: Vec<String>,
    seen_reads: HashSet<String>,
    rune_reads: Vec<String>,
    seen_runes: HashSet<String>,
    skills: Vec<String>,
    seen_skills: HashSet<String>,
    /// File named by the last unambiguous assistant file-tool message.
    last_touch: Option<String>,
    truncated: bool,
}

const READS_MAX: usize = 2000;
const CONTENT_KEY: &str = concat!("con", "tent");

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
        let trigger = if when == "touch" { scan.last_touch.clone() } else { None };
        scan.files.push(LoadedFile { path, memory_type: memory_type.to_string(), when, trigger, source: None });
    }
}

fn skill_rune_id(path: &str) -> Option<String> {
    let path = path.replace('\\', "/");
    let (parent, filename) = path.rsplit_once('/')?;
    if !parent.to_ascii_lowercase().ends_with("/vidar-runes") { return None; }
    let id = filename.strip_suffix(".md")?;
    if id.eq_ignore_ascii_case("SKILL") || crate::rules::rune::check_id(id).is_err() { return None; }
    Some(id.to_string())
}

fn note_rune(scan: &mut Scan, id: String) {
    if scan.seen_runes.contains(&id) { return }
    if scan.rune_reads.len() == READS_MAX { scan.truncated = true; }
    else { scan.seen_runes.insert(id.clone()); scan.rune_reads.push(id); }
}

fn note_read(scan: &mut Scan, path: &str) {
    let path = clean(Path::new(path));
    if !path.to_lowercase().ends_with(".md") { return }
    let key = path.to_lowercase().replace('/', "\\");
    if scan.seen_reads.contains(&key) { return }
    if scan.reads.len() == READS_MAX { scan.truncated = true; }
    else { scan.seen_reads.insert(key); scan.reads.push(path); }
}

/// Rune ids named as `vidar-runes\<id>.md` (either slash) anywhere in a command line.
fn rune_ids_in(text: &str) -> Vec<String> {
    let lower = text.to_ascii_lowercase();
    let mut out = Vec::new();
    for (at, _) in lower.match_indices("vidar-runes") {
        let rest = &text[at + "vidar-runes".len()..];
        let rest = rest.trim_start_matches(['\\', '/']);
        if rest.len() == text[at + "vidar-runes".len()..].len() { continue }
        let id: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        if !rest[id.len()..].to_ascii_lowercase().starts_with(".md") { continue }
        if let Some(id) = skill_rune_id(&format!("x/vidar-runes/{id}.md")) { out.push(id); }
    }
    out
}

/// A Codex rollout line: `event_msg` `item_completed` whose `item` is a completed `CommandExecution`.
/// Codex parses each command into `parsed_cmd`; a `read` entry carries the file at `path`. A rune read
/// through a command Codex leaves `unknown` (a pipe, `cat a b`) is still taken from the `command` argv.
fn codex_line(scan: &mut Scan, v: &Value) {
    let item = &v["payload"]["item"];
    if v["type"] != "event_msg" || v["payload"]["type"] != "item_completed" || item["type"] != "CommandExecution" || item["status"] != "completed" {
        return;
    }
    for p in item["parsed_cmd"].as_array().into_iter().flatten() {
        if p["type"] != "read" { continue }
        let Some(path) = p["path"].as_str() else { continue };
        if let Some(id) = skill_rune_id(path) { note_rune(scan, id); }
        note_read(scan, path);
    }
    for arg in item["command"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        for id in rune_ids_in(arg) { note_rune(scan, id); }
    }
}

fn read_line(scan: &mut Scan, line: &[u8]) {
    let has = |needle: &[u8]| line.windows(needle.len()).any(|w| w == needle);
    let codex = has(b"\"CommandExecution\"");
    if !codex && !has(b"\"instructions\"") && !has(b"\"nested_memory\"") && !has(b"\"tool_use\"") {
        return;
    }
    let Ok(v) = serde_json::from_slice::<Value>(line) else { return };
    if codex { return codex_line(scan, &v) }
    if v["isSidechain"] == true { return }
    if v["type"] == "assistant" {
        let file_tools: Vec<&Value> = v["message"][CONTENT_KEY].as_array().into_iter().flatten()
            .filter(|item| item["type"] == "tool_use" && matches!(item["name"].as_str(), Some("Read" | "Edit" | "Write" | "MultiEdit")))
            .collect();
        match file_tools.as_slice() {
            [item] => scan.last_touch = item["input"]["file_path"].as_str().map(|p| clean(Path::new(p))),
            [_, _, ..] => scan.last_touch = None,
            [] => {}
        }
        for item in v["message"][CONTENT_KEY].as_array().into_iter().flatten() {
            if item["type"] != "tool_use" { continue }
            match item["name"].as_str() {
                Some("Read") => {
                    let Some(path) = item["input"]["file_path"].as_str() else { continue };
                    if let Some(id) = skill_rune_id(path) { note_rune(scan, id); }
                    note_read(scan, path);
                }
                Some("Skill") => {
                    if let Some(skill) = item["input"]["skill"].as_str() {
                        if scan.seen_skills.insert(skill.to_string()) { scan.skills.push(skill.to_string()); }
                    }
                }
                _ => {}
            }
        }
    }
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
            _ => fresh(len, mtime, 0),
        }
    };
    run(path, &mut scan)?;
    scan.len = len;
    scan.mtime = mtime;
    let out = done(&scan);
    cache().lock().unwrap().put(path.to_path_buf(), scan);
    Ok(out)
}

fn fresh(len: u64, mtime: Option<SystemTime>, offset: u64) -> Scan {
    Scan { len, mtime, offset, files: Vec::new(), seen: HashSet::new(), reads: Vec::new(), seen_reads: HashSet::new(), rune_reads: Vec::new(), seen_runes: HashSet::new(), skills: Vec::new(), seen_skills: HashSet::new(), last_touch: None, truncated: false }
}

/// The load history's sweep (`load_history.rs`): `path` read from `offset` (a line start) with the
/// same line reader, bypassing the cache. Returns the uses found and the end of the last complete
/// line consumed; a file-trigger needs the lines before `offset`, so a resumed slice may lack one.
pub(crate) fn scan_uncached(path: &Path, offset: u64) -> std::io::Result<(Loaded, u64)> {
    let mut scan = fresh(0, None, offset);
    run(path, &mut scan)?;
    Ok((done(&scan), scan.offset))
}

/// Reads complete lines of `path` from `scan.offset` into `scan`, stopping at a partial last line or the cap.
fn run(path: &Path, scan: &mut Scan) -> std::io::Result<()> {
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
        read_line(scan, &buf);
    }
    Ok(())
}

fn done(s: &Scan) -> Loaded {
    Loaded { source: "transcript", reason: None, files: s.files.clone(), reads: s.reads.clone(), rune_reads: s.rune_reads.clone(), skills: s.skills.clone(), truncated: s.truncated }
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

/// Ids are checked before any path join. Claude tabs read their transcript; Codex tabs their session
/// record under the vaults store `root` (`bare::codex_runes_loaded`).
fn loaded_in(
    root: &Path,
    sessions: &Path,
    projects: &[PathBuf],
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
        "codex" => return Ok(crate::bare::codex_runes_loaded::loaded(root, tab, session_id)),
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
    let Some(path) = from_payload.or_else(|| projects.iter().find_map(|p| find_transcript(p, &sid))) else {
        return Ok(none("No Session Yet"));
    };
    scan_transcript(&path).or_else(|_| Ok(none("No Loads Recorded")))
}

#[tauri::command]
pub async fn runes_loaded(tab: String, agent: String, session_id: Option<String>, profile: Option<String>) -> Result<Loaded, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // every config dir of the profile: a Bare session's transcript sits in its combination's home
        let projects: Vec<PathBuf> = crate::bare::claude_dir::homes_for(profile.as_deref()).into_iter().map(|d| d.join("projects")).collect();
        loaded_in(&crate::paths::root(), &crate::paths::sessions_dir(), &projects, &tab, &agent, session_id.as_deref())
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
            assert!(loaded_in(&dir, &dir, &[], tab, "claude", None).is_err(), "tab {tab}");
            assert!(loaded_in(&dir, &dir, &[], tab, "codex", None).is_err(), "tab {tab} codex");
        }
        for sid in ["../x", "a/b", "a\\b", "x.jsonl", ""] {
            assert!(loaded_in(&dir, &dir, &[], "tab-1", "claude", Some(sid)).is_err(), "sid {sid}");
            assert!(loaded_in(&dir, &dir, &[], "tab-1", "codex", Some(sid)).is_err(), "sid {sid} codex");
        }
        // a Codex tab with no session record (`bare::codex_runes_loaded` covers the record cases)
        let empty = TempDir::new("codex-none");
        let codex = loaded_in(&empty.0, &dir, &[], "tab-1", "codex", None).unwrap();
        assert_eq!((codex.source, codex.reason.as_deref(), codex.files.len()), ("none", Some("No Session Yet"), 0));
        let none = loaded_in(&dir, &dir, &[], "no-such-tab-zz", "claude", None).unwrap();
        assert_eq!(none.reason.as_deref(), Some("No Session Yet"));
    }

    /// A Bare profile's sessions sit in its own dir or a combination home: both are searched.
    #[test]
    fn runes_loaded_finds_a_session_in_any_home() {
        let tmp = TempDir::new("homes");
        let projects = [tmp.0.join("claude-config").join("projects"), tmp.0.join("claude-homes").join("abc123def456").join("projects")];
        let (legacy_sid, combo_sid) = ("sessLegacy1", "sessCombo2");
        for (p, sid) in [(&projects[0], legacy_sid), (&projects[1], combo_sid)] {
            let slug = p.join("C--r-x");
            std::fs::create_dir_all(&slug).unwrap();
            std::fs::copy(fixture(), slug.join(format!("{sid}.jsonl"))).unwrap();
        }
        let sessions = tmp.0.join("sessions");
        for sid in [legacy_sid, combo_sid] {
            let got = loaded_in(&tmp.0, &sessions, &projects, "tab-homes", "claude", Some(sid)).unwrap();
            assert_eq!((got.source, got.files.len()), ("transcript", 3), "{sid}");
        }
        let one = loaded_in(&tmp.0, &sessions, &projects[..1], "tab-homes", "claude", Some("sessMissing3")).unwrap();
        assert_eq!(one.reason.as_deref(), Some("No Session Yet"));
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
    fn runes_loaded_names_only_unambiguous_file_triggers_across_resume() {
        let tmp = TempDir::new("triggers");
        let path = tmp.0.join("triggers.jsonl");
        let tool = |name: &str, file: &str| serde_json::json!({"type":"tool_use", "name":name, "input":{"file_path":file}});
        let assistant = |items: Vec<Value>| {
            let mut line = serde_json::json!({"type":"assistant", "message":{}});
            line["message"][CONTENT_KEY] = Value::Array(items);
            line.to_string()
        };
        std::fs::write(&path, format!("{}\n", assistant(vec![tool("Edit", "C:/repo/edited.rs")]))).unwrap();
        assert!(scan_transcript(&path).unwrap().files.is_empty());

        let mut lines = std::fs::read_to_string(&path).unwrap();
        lines.push_str(&format!("{}\n", nested("C:/repo/.claude/rules/first.md")));
        std::fs::write(&path, &lines).unwrap();
        let resumed = scan_transcript(&path).unwrap();
        assert_eq!(resumed.files[0].trigger.as_deref(), Some("C:/repo/edited.rs"));

        lines.push_str(&format!("{}\n{}\n", assistant(vec![tool("Read", "C:/repo/a.md"), tool("Write", "C:/repo/b.md")]), nested("C:/repo/.claude/rules/batch.md")));
        std::fs::write(&path, &lines).unwrap();
        let batch = scan_transcript(&path).unwrap();
        assert_eq!(batch.files[1].trigger, None);
        let json = serde_json::to_value(&batch).unwrap();
        assert!(json["files"][1].get("trigger").is_none());

        let fresh = tmp.0.join("no-prior.jsonl");
        std::fs::write(&fresh, format!("{}\n", nested("C:/repo/.claude/rules/no-prior.md"))).unwrap();
        assert_eq!(scan_transcript(&fresh).unwrap().files[0].trigger, None);

        for name in ["Read", "Write", "MultiEdit"] {
            let transcript = tmp.0.join(format!("{name}.jsonl"));
            std::fs::write(&transcript, format!("{}\n{}\n", assistant(vec![tool(name, "C:/repo/target.rs")]), nested("C:/repo/.claude/rules/on-touch.md"))).unwrap();
            assert_eq!(scan_transcript(&transcript).unwrap().files[0].trigger.as_deref(), Some("C:/repo/target.rs"), "{name}");
        }
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
            reads: Vec::new(),
            seen_reads: HashSet::new(),
            rune_reads: Vec::new(),
            seen_runes: HashSet::new(),
            skills: Vec::new(),
            seen_skills: HashSet::new(),
            last_touch: None,
            truncated: false,
        };
        take(&mut scan, "C:/Repo/CLAUDE.md", "Project", "start");
        take(&mut scan, "c:\\repo\\claude.md", "Project", "touch");
        assert_eq!(scan.files.len(), 1);
    }

    #[test]
    fn runes_loaded_tracks_assistant_reads_and_skills_separately() {
        let tmp = TempDir::new("reads");
        let path = tmp.0.join("reads.jsonl");
        let tool = |name: &str, input: Value| serde_json::json!({"type":"tool_use", "name":name, "input":input});
        let assistant = |items: Vec<Value>| {
            let mut line = serde_json::json!({"type":"assistant", "message":{}});
            line["message"][CONTENT_KEY] = Value::Array(items);
            line
        };
        let lines = [
            serde_json::json!({"type":"attachment", "attachment":{"type":"instructions", "files":[{"path":"C:/repo/CLAUDE.md", "type":"Project"}]}}),
            assistant(vec![tool("Read", serde_json::json!({"file_path":"C:/repo/rules/App/X.md"})), tool("Skill", serde_json::json!({"skill":"x"}))]),
            assistant(vec![tool("Read", serde_json::json!({"file_path":"c:\\REPO\\rules\\app\\x.md"})), tool("Read", serde_json::json!({"file_path":"C:/repo/image.png"}))]),
            { let mut line = assistant(vec![tool("Read", serde_json::json!({"file_path":"C:/repo/user.md"}))]); line["type"] = "user".into(); line },
            serde_json::json!({"type":"tool_result", "output":"\\\"name\\\":\\\"Read\\\" C:/repo/fake.md"}),
            { let mut line = assistant(vec![tool("Read", serde_json::json!({"file_path":"C:/repo/side.md"}))]); line["isSidechain"] = true.into(); line },
        ];
        std::fs::write(&path, lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n").unwrap();
        let got = scan_transcript(&path).unwrap();
        assert_eq!(got.reads, ["C:/repo/rules/App/X.md"]);
        assert_eq!(got.skills, ["x"]);
        assert_eq!(got.files.len(), 1);
        assert_eq!(got.files[0].path, "C:/repo/CLAUDE.md");
        assert!(!got.truncated);
    }

    #[test]
    fn a_vidar_runes_body_read_names_its_rune_but_the_skill_index_does_not() {
        let tmp = TempDir::new("rune-skill-reads");
        let transcript = tmp.0.join("reads.jsonl");
        let read = |path: &str| {
            let mut line = serde_json::json!({"type":"assistant", "message":{}});
            line["message"][CONTENT_KEY] = serde_json::json!([{"type":"tool_use", "name":"Read", "input":{"file_path":path}}]);
            line.to_string()
        };
        std::fs::write(&transcript, format!("{}\n{}\n{}\n",
            read(r"C:\Vidar\runtime\rune-skills\abc\vidar-runes\note-first.md"),
            read(r"C:\Users\agent\.claude\skills\vidar-runes\another-note.md"),
            read(r"C:\Vidar\runtime\rune-skills\abc\vidar-runes\SKILL.md"))).unwrap();
        let loaded = scan_transcript(&transcript).unwrap();
        assert_eq!(loaded.rune_reads, ["note-first", "another-note"]);
        assert_eq!(loaded.reads.len(), 3, "all three paths remain in the raw read ledger");
    }

    /// Lines in the shape Codex 0.164 writes to `CODEX_HOME\sessions\YYYY\MM\DD\rollout-*.jsonl`
    /// (copied from a Bare Codex rollout, paths swapped): only completed `CommandExecution` items count.
    #[test]
    fn a_codex_rollout_names_rune_reads_from_completed_commands_only() {
        let tmp = TempDir::new("codex-rollout");
        let path = tmp.0.join("rollout-2026-10-25T15-30-00-x.jsonl");
        let exec = |status: &str, cmd: &str, parsed: Value| serde_json::json!({
            "timestamp":"2026-10-25T05:30:01.000Z","ordinal":15,"type":"event_msg",
            "payload":{"type":"item_completed","thread_id":"t","turn_id":"u","item":{
                "type":"CommandExecution","id":"exec-1","process_id":"1",
                "command":["C:\\Program Files\\PowerShell\\7\\pwsh.exe","-Command",cmd],
                "cwd":"file:///C:/Temp/cwd","parsed_cmd":parsed,"source":"unified_exec_startup",
                "status":status,"aggregated_output":"body","exit_code":0,"duration":{"secs":0,"nanos":1}}}
        });
        let read = |p: &str| serde_json::json!([{"type":"read","cmd":format!("Get-Content -LiteralPath '{p}'"),"name":"x.md","path":p.replace('\\', "/")}]);
        let skill = r"C:\Vidar\runtime\rune-skills\abc\vidar-runes";
        let lines = [
            serde_json::json!({"timestamp":"t","type":"session_meta","payload":{"id":"s","cwd":"C:\\Temp\\cwd"}}),
            exec("completed", &format!(r"Get-Content -LiteralPath '{skill}\SKILL.md'"), read(&format!(r"{skill}\SKILL.md"))),
            exec("completed", &format!(r"Get-Content -LiteralPath '{skill}\paths-scan-tracked-only.md'"), read(&format!(r"{skill}\paths-scan-tracked-only.md"))),
            exec("failed", &format!(r"Get-Content -LiteralPath '{skill}\failed-read.md'"), read(&format!(r"{skill}\failed-read.md"))),
            exec("completed", &format!(r"Get-Content '{skill}\piped-read.md' | Select-Object -First 40"), serde_json::json!([{"type":"unknown","cmd":"..."}])),
            // The model-side call record: an attempt, not a completed read.
            serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","status":"completed",
                "input":format!(r"await tools.exec_command({{cmd:'Get-Content {skill}\attempt-only.md'}})")}}),
        ];
        std::fs::write(&path, lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n").unwrap();
        let got = scan_transcript(&path).unwrap();
        assert_eq!(got.rune_reads, ["paths-scan-tracked-only", "piped-read"]);
        assert_eq!(got.reads, [format!("{}/SKILL.md", skill.replace('\\', "/")), format!("{}/paths-scan-tracked-only.md", skill.replace('\\', "/"))]);
        assert!(got.files.is_empty() && !got.truncated);
        assert_eq!(rune_ids_in(r"type C:\h\vidar-runes\SKILL.md vidar-runes/a-b.md vidar-runes.md vidar-runes\c.txt"), ["a-b"]);
    }

    #[test]
    fn runes_loaded_caps_reads_and_marks_truncated() {
        let tmp = TempDir::new("read-cap");
        let path = tmp.0.join("reads.jsonl");
        let lines = (0..=READS_MAX).map(|n| {
            let mut line = serde_json::json!({"type":"assistant", "message":{}});
            line["message"][CONTENT_KEY] = serde_json::json!([{"type":"tool_use", "name":"Read", "input":{"file_path":format!("C:/repo/{n}.md")}}]);
            line.to_string()
        }).collect::<Vec<_>>().join("\n");
        std::fs::write(&path, lines + "\n").unwrap();
        let got = scan_transcript(&path).unwrap();
        assert_eq!(got.reads.len(), READS_MAX);
        assert_eq!(got.reads.last().unwrap(), "C:/repo/1999.md");
        assert!(got.truncated);
    }
}
