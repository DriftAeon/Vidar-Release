/* ---- past sessions (＋ › Claude › <location> › Resume) ----
   Claude Code keeps one transcript per session under
   %USERPROFILE%\.claude\projects\<slug>\<sessionId>.jsonl, slug = the START cwd
   with every non-alphanumeric character replaced by '-' (matches the six
   folders on this machine). No title is stored locally, so the
   label is the first real prompt. Read at menu-open time, never polled. */

use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use super::{project_slug, registry_states, LiveState};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentSession {
    session_id: String,
    label: String,
    /// the transcript's own cwd spelling — the spawn must use this, not the picked location
    cwd: String,
    age_secs: u64,
    /// true → not resumable now; `note` says why (running elsewhere, open in Vidar, unknown)
    live: bool,
    note: Option<String>,
}

const RECENT_MAX: usize = 15;
pub(super) const RECENT_READ_CAP: u64 = 256 * 1024;
const RECENT_LABEL_MAX: usize = 80;

fn same_path(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase();
    norm(a) == norm(b)
}

/// First real prompt of a transcript (skipping isMeta and `<…>` wrappers) and
/// the transcript's cwd, from at most the first RECENT_READ_CAP bytes. Reads line by
/// line and stops at the first prompt, so a long transcript costs its first lines only.
pub(super) fn first_prompt(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(f) = fs::File::open(path) else { return (None, None) };
    let mut reader = BufReader::new(f.take(RECENT_READ_CAP));
    let mut cwd: Option<String> = None;
    let mut raw = Vec::new();
    loop {
        raw.clear();
        match reader.read_until(b'\n', &mut raw) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let text = String::from_utf8_lossy(&raw);
        let Ok(v) = serde_json::from_str::<Value>(text.trim_end()) else { continue }; // a cut-off last line
        if cwd.is_none() { cwd = v.get("cwd").and_then(Value::as_str).map(str::to_owned); }
        if v.get("type").and_then(Value::as_str) != Some("user") { continue; }
        if v.get("isMeta").and_then(Value::as_bool) == Some(true) { continue; }
        let content = v.get("message").and_then(|m| m.get("content"));
        let s = match content {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(a)) => a.iter().find_map(|b| (b.get("type")?.as_str()? == "text").then(|| b.get("text")?.as_str().map(str::to_owned))?).unwrap_or_default(),
            _ => String::new(),
        };
        let first = s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
        if first.is_empty() || first.starts_with('<') { continue; }
        let label: String = first.chars().take(RECENT_LABEL_MAX).collect();
        return (Some(label), cwd);
    }
    (None, cwd)
}

/// Async on the blocking pool: the transcript reads and the process snapshot must not run on
/// the UI thread. Callers guard stale replies (`recentGen` in recent.ts).
#[tauri::command]
pub async fn list_recent_sessions(cwd: String, profile: Option<String>) -> Vec<RecentSession> {
    tauri::async_runtime::spawn_blocking(move || recent_blocking(&cwd, profile.as_deref()))
        .await
        .unwrap_or_default()
}

fn recent_blocking(cwd: &str, profile: Option<&str>) -> Vec<RecentSession> {
    let Some(claude) = crate::bare::claude_dir::claude_dir_for(profile) else { return Vec::new() };
    let dir = claude.join("projects").join(project_slug(cwd));
    let Ok(rd) = fs::read_dir(&dir) else { return Vec::new() };
    let mut files: Vec<(PathBuf, std::time::SystemTime, u64)> = rd
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") { return None; }
            let md = e.metadata().ok()?;
            Some((p, md.modified().ok()?, md.len()))
        })
        .collect();
    if files.is_empty() { return Vec::new(); }
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files.truncate(RECENT_MAX);
    let states = registry_states(profile);
    let now = std::time::SystemTime::now();
    files
        .into_iter()
        .filter_map(|(p, mtime, len)| {
            let id = p.file_stem()?.to_str()?.to_owned();
            if id.len() != 36 { return None; }
            let (label, tcwd) = first_prompt(&p);
            let label = match label {
                Some(l) => l,
                // a big transcript whose first prompt sits past the cap is still a session
                None if len > RECENT_READ_CAP => format!("session {}", &id[..8]),
                None => return None,
            };
            let tcwd = tcwd.unwrap_or_else(|| cwd.to_owned());
            if !same_path(&tcwd, cwd) { return None; } // slug collision: another spelling's project
            let (live, note) = match states.get(&id) {
                Some(LiveState::Live(n)) => (true, Some(n.clone())),
                Some(LiveState::Unknown(why)) => (true, Some(format!("state unknown: {why}"))),
                _ => (false, None),
            };
            Some(RecentSession {
                session_id: id,
                label,
                cwd: tcwd,
                age_secs: now.duration_since(mtime).map(|d| d.as_secs()).unwrap_or(0),
                live,
                note,
            })
        })
        .collect()
}
