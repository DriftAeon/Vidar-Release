//! src-tauri\src\bare\vault\session.rs — session records (model R4): which vault, at which hash, a session
//! loaded. One file per record at `<vaults folder>\sessions\<stamp>-<agent>-<hex8>.json`; a record never
//! names a launcher row. Lookup: `falconSession`, then `threadId`, then `tab`; the newest match wins.
//! The launch paths write records (L2a); adopt with no record builds or reuses a vault (D-g); the
//! Falcon event reader and the Codex app-server reader add the thread id once it is known (L3c).
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
    crate::fsx::write_json_pretty(&path, r, true)?;
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

/// Every vault id a session record names. Fails closed: a record file that cannot be read or parsed
/// aborts, since the vault it names could be swept (`Store::sweep_copies`). A missing folder names none.
pub(crate) fn named_vaults(root: &Path) -> Result<std::collections::HashSet<String>, String> {
    let rd = match std::fs::read_dir(dir(root)) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Default::default()),
        Err(e) => return Err(format!("{}: {e}", dir(root).display())),
    };
    let mut out = std::collections::HashSet::new();
    for e in rd {
        let p = e.map_err(|e| e.to_string())?.path();
        if p.extension().is_some_and(|x| x == "json") {
            out.insert(crate::fsx::read_json::<Record>(&p).map_err(|e| format!("session record {}: {e}", p.display()))?.vault.id);
        }
    }
    Ok(out)
}

/// Adopt with no record (D-g): start a blank vault plus the host-echoed sets (`super::create_at` with no
/// name and no `from`: the Vidar Runeset at index 0, then the echoed sets), then write the record. A Falcon session
/// adopted twice keeps its first record: it is re-read under `ADOPT` before a copy is minted. A running
/// session never gets the vault pick.
pub fn adopt(root: &Path, agent: &str, tab: &str, falcon_session: &str, echoed_sets: &[SetSource]) -> Result<Record, String> {
    static ADOPT: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let Some(parsed) = crate::agent_spec::parse(agent) else {
        return Err(format!("Agent {agent:?} is not claude or codex; vault refused"));
    };
    let _g = ADOPT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(r) = find(root, tab, Some(falcon_session), None)?.filter(|r| r.falcon_session.as_deref() == Some(falcon_session)) {
        return Ok(r);
    }
    let v = super::create_at(root, None, None, echoed_sets, &[])?;
    let body = crate::agent_spec::spec(parsed).adopt_body;
    let mut r = record(parsed.as_str(), body, tab, VaultPin { id: v.id, hash: v.hash }, "", "");
    r.falcon_session = Some(falcon_session.to_string());
    write(root, &r)?;
    Ok(r)
}
