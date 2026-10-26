//! src-tauri\src\bare\vault\session.rs — session records (model R4): which vault, at which hash, a session
//! loaded. One file per record at `<vaults folder>\sessions\<stamp>-<agent>-<hex8>.json`; a record never
//! names a launcher row. Lookup: `falconSession`, then `threadId`, then `tab`; the newest match wins.
//! The launch paths write records (L2a); adopt with no record builds or reuses a vault (D-g); the
//! Falcon event reader and the Codex app-server reader add the thread id once it is known (L3c).
// `record`'s callers are split across the launch, adopt and reader paths; some helpers are test-only.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::SetSource;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct VaultPin {
    pub id: String,
    pub hash: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub version: u32,
    pub created_utc: String,
    pub agent: String,
    /// `rendered`, `raw`, `hosted`, … as the launch path names its body.
    pub body: String,
    pub tab: String,
    pub falcon_session: Option<String>,
    pub thread_id: Option<String>,
    pub vault: VaultPin,
    pub home: String,
    pub loadout_hash: String,
}

fn dir(root: &Path) -> PathBuf {
    crate::paths::rune_vaults_dir_in(root).join("sessions")
}

/// `2026-10-25T12:31:00Z` + millis -> `2026-10-25T123100000Z`.
fn stamp(created_utc: &str) -> String {
    let ms = crate::fsx::now_ms() % 1000;
    let base = created_utc.trim_end_matches('Z').replace(':', "");
    format!("{base}{ms:03}Z")
}

fn hex8() -> String {
    use sha2::{Digest, Sha256};
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let seed = format!("{nanos}-{}-{:?}", std::process::id(), std::thread::current().id());
    Sha256::digest(seed.as_bytes()).iter().take(4).map(|b| format!("{b:02x}")).collect()
}

/// A new record stamped now; the caller fills the optional ids.
pub fn record(agent: &str, body: &str, tab: &str, vault: VaultPin, home: &str, loadout_hash: &str) -> Record {
    Record {
        version: 1,
        created_utc: crate::runlog::utc_stamp(),
        agent: agent.to_string(),
        body: body.to_string(),
        tab: tab.to_string(),
        falcon_session: None,
        thread_id: None,
        vault,
        home: home.to_string(),
        loadout_hash: loadout_hash.to_string(),
    }
}

/// Writes `r` as a new record file; returns its path.
pub fn write(root: &Path, r: &Record) -> Result<PathBuf, String> {
    if r.agent.is_empty() || !r.agent.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
        return Err(format!("session record agent {:?} is not a plain name", r.agent));
    }
    let d = dir(root);
    std::fs::create_dir_all(&d).map_err(|e| format!("{}: {e}", d.display()))?;
    let path = d.join(format!("{}-{}-{}.json", stamp(&r.created_utc), r.agent, hex8()));
    let json = serde_json::to_string_pretty(r).map_err(|e| e.to_string())? + "\n";
    crate::fsx::atomic_write(&path, json.as_bytes())?;
    Ok(path)
}

/// Every readable record, oldest first (file names lead with the stamp).
fn all(root: &Path) -> Vec<Record> {
    let Ok(rd) = std::fs::read_dir(dir(root)) else { return Vec::new() };
    let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
    files.sort();
    files.iter().filter_map(|p| crate::fsx::read_json::<Record>(p).ok()).collect()
}

/// The newest record for a session: by `falcon_session`, then `thread_id`, then `tab`.
pub fn find(root: &Path, tab: &str, falcon_session: Option<&str>, thread_id: Option<&str>) -> Result<Option<Record>, String> {
    let records = all(root);
    let newest = |hit: &dyn Fn(&Record) -> bool| records.iter().rev().find(|r| hit(r)).cloned();
    if let Some(fs) = falcon_session.filter(|s| !s.is_empty()) {
        if let Some(r) = newest(&|r| r.falcon_session.as_deref() == Some(fs)) {
            return Ok(Some(r));
        }
    }
    if let Some(t) = thread_id.filter(|s| !s.is_empty()) {
        if let Some(r) = newest(&|r| r.thread_id.as_deref() == Some(t)) {
            return Ok(Some(r));
        }
    }
    if tab.is_empty() {
        return Ok(None);
    }
    Ok(newest(&|r| r.tab == tab))
}

/// When a session's thread id is first known: a new record, the newest match's copy with `thread_id`
/// set. `None` when no record matches; the match itself when it already carries an id (that one, or a
/// different one, which is never overwritten). A Falcon session matches only a record of that session
/// and an in-process tab only a record with no Falcon session, so another session's record under the
/// same tab id never takes the id.
pub fn append_thread_id(root: &Path, tab: &str, falcon_session: Option<&str>, thread_id: &str) -> Result<Option<Record>, String> {
    if thread_id.is_empty() {
        return Ok(None);
    }
    let Some(mut r) = find(root, tab, falcon_session, None)? else { return Ok(None) };
    if r.falcon_session.as_deref() != falcon_session.filter(|s| !s.is_empty()) {
        return Ok(None);
    }
    if r.thread_id.is_some() {
        return Ok(Some(r));
    }
    r.thread_id = Some(thread_id.to_string());
    r.created_utc = crate::runlog::utc_stamp();
    write(root, &r)?;
    Ok(Some(r))
}

/// The thread id an agent's stdout line first names: Claude's `system`/`init` `session_id`, or Falcon's
/// `falcon/thread` line (the host's own reply to its `thread/start` or `thread/resume`). Any other line,
/// a `thread/read` reply included, names no thread this session runs.
pub fn thread_id_in_line(line: &serde_json::Value) -> Option<&str> {
    let s = |p: &str| line.pointer(p).and_then(serde_json::Value::as_str).filter(|v| !v.is_empty());
    if s("/type") == Some("system") && s("/subtype") == Some("init") {
        return s("/session_id");
    }
    if s("/method") == Some("falcon/thread") {
        return s("/params/result/thread/id");
    }
    None
}

/// A Make Variant answer moves the tab to the variant (run 2026-10-25-rune-vault, L3b2): a new record, the
/// newest match's copy (by `falcon_session`, then `tab`) pinned to `vault`, so the tab's respawn loads it.
/// The copy drops `thread_id`: a Resume of the earlier thread still finds the vault that thread loaded.
/// `None` when no record matches.
pub fn move_to(root: &Path, tab: &str, falcon_session: Option<&str>, vault: VaultPin) -> Result<Option<Record>, String> {
    let Some(mut r) = find(root, tab, falcon_session, None)? else { return Ok(None) };
    r.vault = vault;
    r.thread_id = None;
    r.created_utc = crate::runlog::utc_stamp();
    write(root, &r)?;
    Ok(Some(r))
}

/// Adopt with no record (D-g): build or reuse the Custom vault of the host-echoed sets on the agent's
/// stock floor (`super::floored_custom`), then write the record. A running session never gets the vault pick.
pub fn adopt(root: &Path, agent: &str, tab: &str, falcon_session: &str, echoed_sets: &[SetSource]) -> Result<Record, String> {
    let v = super::floored_custom(root, agent, echoed_sets, &[])?;
    let body = if agent == "claude" { "rendered" } else { "hosted" };
    let mut r = record(agent, body, tab, VaultPin { id: v.id, hash: v.hash }, "", "");
    r.falcon_session = Some(falcon_session.to_string());
    write(root, &r)?;
    Ok(r)
}
