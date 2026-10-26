use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

// Per-tab statusline payloads. Claude's statusline script writes
// <VIDAR_TAB>.json here (VIDAR_TAB is set on every pty by spawn_pty), so the
// bar can show the session in the focused tab rather than the machine-wide
// ~\.claude\statusline-latest.json singleton, which any Claude anywhere
// overwrites. Tabs without Claude (powershell, codex) simply have no file.
#[derive(Clone, Serialize)]
pub struct TabStatus {
    tab: String,
    /// at read time; the bar derives the live age from `mtime_ms`, since nothing re-emits an unchanged file
    age_secs: u64,
    /// the payload file's last write, ms since the Unix epoch
    mtime_ms: u64,
    payload: Value,
}

/// Tab ids restart at s1 every launch, so leftovers from a previous run would
/// be misattributed. Wipe on startup.
pub fn reset_dir() {
    let _ = fs::remove_dir_all(crate::paths::sessions_dir());
    let _ = fs::create_dir_all(crate::paths::sessions_dir());
}

/// Called when a pty dies (killed or exited) so a stale payload can't outlive
/// its tab.
pub fn forget_tab(tab: &str) {
    let _ = fs::remove_file(crate::paths::sessions_dir().join(format!("{tab}.json")));
}

// ---- external Claude sessions (adopted into a Vidar tab) ----
//
// Claude Code keeps a per-process registry at ~\.claude\sessions\<pid>.json
// ({pid, sessionId, cwd, procStart, name, status, ...}; verified on
// 2.1.263). It is undocumented, so everything below fails soft: unparseable
// entries are skipped, and nothing in that directory is ever written or
// deleted by Vidar. `procStart` is the process creation FILETIME, which is
// what makes a pid trustworthy — compare it exactly, or a reused pid could
// name a different live Claude.

const SHELLS: &[&str] = &["pwsh.exe", "powershell.exe", "cmd.exe"];
// The process images a Claude can run as come from the claude pack's dep probe
// (`deps::claude_images`: claude.exe, plus node.exe for an npm install).

pub struct RegistryEntry {
    pub pid: u32,
    pub session_id: String,
    /// the START cwd — the transcript's project key derives from this, not from
    /// wherever the session has since `cd`'d (statusline `cwd` follows that)
    pub cwd: String,
    pub proc_start: u64,
    pub name: Option<String>,
    pub status: String,
    pub updated_at_ms: u64,
}

/// A registry entry that has been checked against the live process table.
pub struct Resolved {
    pub entry: RegistryEntry,
    /// direct parent — the shell whose tree gets killed on adopt
    pub shell_pid: u32,
    pub shell_exe: String,
    /// grandparent exe (WindowsTerminal.exe, explorer.exe, Code.exe, …)
    pub host: String,
    pub inside_vidar: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSession {
    pid: u32,
    session_id: String,
    name: Option<String>,
    cwd: String,
    status: String,
    host: String,
    age_secs: u64,
    /// false → `note` says why the row is inert
    adoptable: bool,
    note: Option<String>,
}

/// The session registry of the tab's Claude config dir (`bare/claude_dir.rs`); None = the user's own.
fn registry_dir(profile: Option<&str>) -> Option<PathBuf> {
    Some(crate::bare::claude_dir::claude_dir_for(profile)?.join("sessions"))
}

fn read_registry(path: &Path) -> Option<RegistryEntry> {
    let text = fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let pid = v.get("pid")?.as_u64()? as u32;
    let session_id = v.get("sessionId")?.as_str()?.to_owned();
    let cwd = v.get("cwd")?.as_str()?.to_owned();
    // stored as a decimal string (u64 doesn't survive JSON in JS)
    let proc_start = match v.get("procStart")? {
        Value::String(s) => s.parse::<u64>().ok()?,
        Value::Number(n) => n.as_u64()?,
        _ => return None,
    };
    Some(RegistryEntry {
        pid,
        session_id,
        cwd,
        proc_start,
        name: v.get("name").and_then(Value::as_str).map(str::to_owned),
        status: v.get("status").and_then(Value::as_str).unwrap_or("unknown").to_owned(),
        updated_at_ms: v.get("updatedAt").and_then(Value::as_u64).unwrap_or(0),
    })
}

/// Registry entry + live-process facts for one pid. Err when the process is
/// gone, is not the process the entry describes (pid reused), or isn't Claude.
/// Both the list and the adopt path go through here so they can't disagree.
pub fn resolve(pid: u32, map: &std::collections::HashMap<u32, crate::procs::ProcRow>) -> Result<Resolved, String> {
    resolve_in(None, pid, map)
}

fn resolve_in(profile: Option<&str>, pid: u32, map: &std::collections::HashMap<u32, crate::procs::ProcRow>) -> Result<Resolved, String> {
    let dir = registry_dir(profile).ok_or("no Claude config dir")?;
    resolve_at(&dir, pid, map, &crate::deps::claude_images())
}

/// `resolve_in` against one registry folder; `images` are the accepted Claude image names.
fn resolve_at(dir: &Path, pid: u32, map: &std::collections::HashMap<u32, crate::procs::ProcRow>, images: &[String]) -> Result<Resolved, String> {
    let entry = read_registry(&dir.join(format!("{pid}.json"))).ok_or("no registry entry")?;
    if entry.pid != pid {
        return Err("registry entry names a different pid".into());
    }
    if !crate::procs::is_alive(pid) {
        return Err("process has exited".into());
    }
    match crate::procs::creation_time(pid) {
        Some(t) if t == entry.proc_start => {}
        Some(_) => return Err("pid was reused by another process".into()),
        None => return Err("process not queryable".into()),
    }
    match crate::procs::image_name(pid) {
        Some(img) if images.iter().any(|c| *c == img) => {}
        Some(img) => return Err(format!("{img} is not a Claude process")),
        None => return Err("process image not readable".into()),
    }
    let chain = crate::procs::ancestors(map, pid);
    let (shell_pid, shell_exe) = chain.first().cloned().ok_or("no parent process")?;
    let host = chain.get(1).map(|(_, exe)| exe.clone()).unwrap_or_default();
    let me = std::process::id();
    let inside_vidar = chain.iter().any(|(p, _)| *p == me);
    Ok(Resolved { entry, shell_pid, shell_exe, host, inside_vidar })
}

pub fn is_shell(exe: &str) -> bool {
    SHELLS.contains(&exe)
}

/// Live Claude sessions outside Vidar's own tabs, for ＋ → Claude → Active.
/// Read at menu-open time, not polled.
#[tauri::command]
pub fn list_external_sessions() -> Vec<ExternalSession> {
    let Some(dir) = registry_dir(None) else { return Vec::new() };
    let Ok(rd) = fs::read_dir(&dir) else { return Vec::new() };
    let map = crate::procs::snapshot();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut out: Vec<ExternalSession> = rd
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let stem = path.file_stem()?.to_str()?;
            if path.extension()?.to_str()? != "json" { return None; }
            let pid: u32 = stem.parse().ok()?;
            let r = resolve(pid, &map).ok()?; // dead / reused / foreign → not listed
            if r.inside_vidar { return None; } // it's already a tab
            let (adoptable, note) = if !is_shell(&r.shell_exe) {
                (false, Some(format!("hosted by {}, not adoptable", r.host.trim_end_matches(".exe"))))
            } else if r.entry.status == "busy" {
                (false, Some("busy — wait for it to go idle".into()))
            } else {
                (true, None)
            };
            Some(ExternalSession {
                pid,
                session_id: r.entry.session_id,
                name: r.entry.name,
                cwd: r.entry.cwd,
                status: r.entry.status,
                host: r.host.trim_end_matches(".exe").to_owned(),
                age_secs: now_ms.saturating_sub(r.entry.updated_at_ms) / 1000,
                adoptable,
                note,
            })
        })
        .collect();
    out.sort_by_key(|s| s.age_secs);
    out
}

// Past sessions (＋ › Claude › <location> › Resume) live in `status/recent.rs`.
mod recent;
pub use self::recent::*;

pub enum LiveState {
    Free,
    Live(String),
    Unknown(String),
}

/// Every registry entry classified once: session id → state. A resolving
/// process holds its session; an exited or reused pid is a stale file (Free);
/// anything else (not queryable, image unreadable, no ancestry) is Unknown and
/// is never treated as idle.
/// Reads every config dir of the profile (`claude_dir::homes_for`): a Bare session registers in
/// its combination's home.
fn registry_states(profile: Option<&str>) -> HashMap<String, LiveState> {
    let images = crate::deps::claude_images();
    let mut out = HashMap::new();
    for dir in crate::bare::claude_dir::homes_for(profile) {
        for (id, state) in states_in(&dir.join("sessions"), &images) {
            merge_state(&mut out, id, state);
        }
    }
    out
}

fn states_in(dir: &Path, images: &[String]) -> HashMap<String, LiveState> {
    let mut out = HashMap::new();
    let Ok(rd) = fs::read_dir(dir) else { return out };
    let map = crate::procs::snapshot();
    for e in rd.flatten() {
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") { continue; }
        let Some(entry) = read_registry(&path) else { continue };
        let state = match resolve_at(dir, entry.pid, &map, images) {
            Ok(r) => LiveState::Live(if r.inside_vidar { "open in Vidar".into() } else { format!("running in {}", r.host.trim_end_matches(".exe")) }),
            Err(why) if why == "process has exited" || why.starts_with("pid was reused") => LiveState::Free,
            Err(why) => LiveState::Unknown(why),
        };
        merge_state(&mut out, entry.session_id, state);
    }
    out
}

/// A Live verdict beats an Unknown one for the same id; never downgrade to Free.
fn merge_state(out: &mut HashMap<String, LiveState>, id: String, state: LiveState) {
    match (out.get(&id), &state) {
        (Some(LiveState::Live(_)), _) => {}
        (Some(LiveState::Unknown(_)), LiveState::Free) => {}
        _ => { out.insert(id, state); }
    }
}

/// Every registry a Vidar-started Claude can write: the user's own and each Bare config dir (the
/// profile's own and every combination home). A Bare tab runs with `CLAUDE_CONFIG_DIR` in one of
/// them, so its process registers there, never in the user's `.claude\sessions`.
fn guard_dirs() -> Vec<PathBuf> {
    let bare = crate::bare::claude_dir::homes_for(Some("bare")).into_iter().map(|d| d.join("sessions"));
    registry_dir(None).into_iter().chain(bare).collect()
}

fn live_state_across(dirs: &[PathBuf], images: &[String], session_id: &str) -> LiveState {
    let mut out = HashMap::new();
    for dir in dirs {
        if let Some(state) = states_in(dir, images).remove(session_id) {
            merge_state(&mut out, session_id.to_owned(), state);
        }
    }
    out.remove(session_id).unwrap_or(LiveState::Free)
}

/// The spawn-time guard: resuming a session that another process holds would
/// interleave two writers on one transcript. Reads every registry (`guard_dirs`), so a
/// running Bare session blocks the resume whichever profile the spawn carries.
pub fn session_live_state(session_id: &str) -> LiveState {
    live_state_across(&guard_dirs(), &crate::deps::claude_images(), session_id)
}

pub(crate) fn project_slug(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// The session's transcript: the payload's `transcript_path` when its stem is the session id, else
/// `<projects>\<slug of spawn_cwd>\<sid>.jsonl`; None without a projects dir to fall back on.
pub(crate) fn transcript_from_payload(v: &Value, sid: &str, projects: Option<&Path>, spawn_cwd: &str) -> Option<PathBuf> {
    let from_payload = v.get("transcript_path").and_then(Value::as_str).map(PathBuf::from)
        .filter(|p| p.file_stem().and_then(|s| s.to_str()) == Some(sid));
    match from_payload {
        Some(p) => Some(p),
        None => Some(projects?.join(project_slug(spawn_cwd)).join(format!("{sid}.jsonl"))),
    }
}

// The Codex half (session inference, model) lives in `status/codex.rs`, on the index in
// `status/rollout_index.rs`.
mod codex;
mod rollout_index;
pub use self::codex::*;

/// (tab, mtime_ms, len) of every payload file, sorted: what changed since the last tick.
type Sig = Vec<(String, u64, u64)>;

/// Emits `status-update` only when a payload file was added, removed or rewritten; the bar
/// derives ages from `mtime_ms` and `status_snapshot` gives a late webview its first state.
pub fn start_status_poller(app: AppHandle) {
    thread::spawn(move || {
        let mut last: Option<Sig> = None;
        let mut cache = GoodCache::new();
        loop {
            if let Some(tabs) = step(&mut last, stat_sig(), |s| read_all(s, &mut cache)) {
                let _ = app.emit("status-update", tabs);
            }
            thread::sleep(Duration::from_secs(2));
        }
    });
}

/// One tick: nothing when the signature is unchanged; otherwise read. `read` returns the tabs
/// (a failed one that parsed before keeps its last good status) plus the signature with each
/// failed tab at its old entry, or removed when it never parsed; that reduced signature is
/// committed, so a failed (torn or never-parsing) file is retried next tick without holding
/// back the others, and nothing is emitted unless the readable set changed.
fn step(
    last: &mut Option<Sig>,
    sig: Sig,
    read: impl FnOnce(&Sig) -> (Vec<TabStatus>, Sig),
) -> Option<Vec<TabStatus>> {
    if last.as_ref() == Some(&sig) {
        return None;
    }
    let (tabs, reduced) = read(&sig);
    if last.as_ref() == Some(&reduced) {
        return None;
    }
    *last = Some(reduced);
    Some(tabs)
}

fn ms_since_epoch(t: std::time::SystemTime) -> u64 {
    t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn stat_sig() -> Sig {
    let Ok(rd) = fs::read_dir(crate::paths::sessions_dir()) else { return Vec::new() };
    let mut sig: Sig = rd
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension()?.to_str()? != "json" {
                return None;
            }
            let tab = path.file_stem()?.to_str()?.to_owned();
            let md = e.metadata().ok()?;
            Some((tab, ms_since_epoch(md.modified().ok()?), md.len()))
        })
        .collect();
    sig.sort();
    sig
}

/// Last good status per tab, with the signature entry it was read under.
type GoodCache = HashMap<String, (TabStatus, (String, u64, u64))>;

fn read_all(sig: &Sig, cache: &mut GoodCache) -> (Vec<TabStatus>, Sig) {
    read_in(&crate::paths::sessions_dir(), sig, cache)
}

/// The tabs of `sig` that parse, and `sig` without the ones that did not. A tab that fails but
/// parsed before contributes its cached status and its old entry, so a torn read neither blanks
/// it nor hides the retry; a tab with no cached status is dropped.
fn read_in(dir: &std::path::Path, sig: &Sig, cache: &mut GoodCache) -> (Vec<TabStatus>, Sig) {
    cache.retain(|k, _| sig.iter().any(|e| &e.0 == k));
    let mut tabs = Vec::new();
    let mut kept = Sig::new();
    for entry in sig {
        if let Some(t) = read_one(&dir.join(format!("{}.json", entry.0))) {
            cache.insert(entry.0.clone(), (t.clone(), entry.clone()));
            tabs.push(t);
            kept.push(entry.clone());
        } else if let Some((t, old)) = cache.get(&entry.0) {
            tabs.push(t.clone());
            kept.push(old.clone());
        }
    }
    (tabs, kept)
}

/// The first state for a webview that mounted after the poller's last emit (or reloaded).
#[tauri::command]
pub fn status_snapshot() -> Vec<TabStatus> {
    let dir = crate::paths::sessions_dir();
    stat_sig().iter().filter_map(|(tab, _, _)| read_one(&dir.join(format!("{tab}.json")))).collect()
}

fn read_one(path: &PathBuf) -> Option<TabStatus> {
    if path.extension()?.to_str()? != "json" {
        return None;
    }
    let tab = path.file_stem()?.to_str()?.to_owned();
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok();
    let age_secs = modified
        .and_then(|m| m.elapsed().ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mtime_ms = modified.map(ms_since_epoch).unwrap_or(0);
    // Writer renames into place, so a torn read is unlikely — but skip the tick
    // rather than emit garbage if it ever happens.
    let text = fs::read_to_string(path).ok()?;
    let payload = serde_json::from_str::<Value>(&text).ok()?;
    Some(TabStatus { tab, age_secs, mtime_ms, payload })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    #[test]
    fn the_poller_emits_only_on_a_changed_signature_and_holds_it_on_a_torn_read() {
        use super::{step, Sig, TabStatus};
        let tab = |t: &str| TabStatus { tab: t.into(), age_secs: 0, mtime_ms: 1, payload: serde_json::Value::Null };
        let sig_a: Sig = vec![("s1".into(), 10, 5)];
        let mut last = None;
        // first tick emits and commits
        assert_eq!(step(&mut last, sig_a.clone(), |s| (vec![tab("s1")], s.clone())).map(|v| v.len()), Some(1));
        // unchanged: nothing emitted and the file is not even read
        assert!(step(&mut last, sig_a.clone(), |_| panic!("read on an unchanged signature")).is_none());
        // changed but torn: the failed tab leaves the committed signature, so it is retried
        let sig_b: Sig = vec![("s1".into(), 20, 7)];
        assert_eq!(step(&mut last, sig_b.clone(), |_| (vec![], vec![])).map(|v| v.len()), Some(0));
        assert_eq!(last, Some(vec![]));
        // still torn: the readable set is unchanged, nothing re-emitted
        assert!(step(&mut last, sig_b.clone(), |_| (vec![], vec![])).is_none());
        assert_eq!(step(&mut last, sig_b.clone(), |s| (vec![tab("s1")], s.clone())).map(|v| v.len()), Some(1));
        assert_eq!(last, Some(sig_b));
    }

    #[test]
    fn one_bad_tab_file_still_emits_the_good_ones() {
        use super::{read_in, step, GoodCache, Sig};
        let dir = std::env::temp_dir().join(format!("vidar-badtab-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.json"), "{\"x\":1}").unwrap();
        std::fs::write(dir.join("b.json"), "{not json").unwrap();
        std::fs::write(dir.join("c.json"), "{\"x\":3}").unwrap();
        let sig: Sig = vec![("a".into(), 1, 1), ("b".into(), 1, 1), ("c".into(), 1, 1)];
        let mut cache = GoodCache::new();
        let mut last = None;
        let tabs = step(&mut last, sig.clone(), |s| read_in(&dir, s, &mut cache));
        assert_eq!(tabs.map(|v| v.len()), Some(2));
        // unchanged next tick: nothing re-emitted although the bad tab is retried
        assert!(step(&mut last, sig, |s| read_in(&dir, s, &mut cache)).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_torn_read_of_a_parsed_tab_emits_nothing_then_the_rewrite() {
        use super::{read_in, step, GoodCache, Sig};
        let dir = std::env::temp_dir().join(format!("vidar-torn-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut cache = GoodCache::new();
        let mut last = None;
        std::fs::write(dir.join("t.json"), "{\"x\":1}").unwrap();
        let s1: Sig = vec![("t".into(), 1, 7)];
        assert_eq!(step(&mut last, s1, |s| read_in(&dir, s, &mut cache)).map(|v| v.len()), Some(1));
        // torn rewrite: invalid JSON, new len; the tab keeps its status, so nothing changed
        std::fs::write(dir.join("t.json"), "{\"x\":").unwrap();
        let s2: Sig = vec![("t".into(), 2, 5)];
        assert!(step(&mut last, s2.clone(), |s| read_in(&dir, s, &mut cache)).is_none());
        // still torn next tick: retried, still nothing
        assert!(step(&mut last, s2, |s| read_in(&dir, s, &mut cache)).is_none());
        // valid rewrite emits
        std::fs::write(dir.join("t.json"), "{\"x\":2}").unwrap();
        let s3: Sig = vec![("t".into(), 3, 7)];
        let tabs = step(&mut last, s3, |s| read_in(&dir, s, &mut cache)).unwrap();
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].payload["x"], 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_torn_tab_rides_along_with_cached_status_when_another_tab_changes() {
        use super::{read_in, step, GoodCache, Sig};
        let dir = std::env::temp_dir().join(format!("vidar-torn2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut cache = GoodCache::new();
        let mut last = None;
        std::fs::write(dir.join("a.json"), "{\"x\":1}").unwrap();
        std::fs::write(dir.join("b.json"), "{\"y\":1}").unwrap();
        let s1: Sig = vec![("a".into(), 1, 7), ("b".into(), 1, 7)];
        assert_eq!(step(&mut last, s1, |s| read_in(&dir, s, &mut cache)).map(|v| v.len()), Some(2));
        std::fs::write(dir.join("a.json"), "{\"x\":").unwrap();
        std::fs::write(dir.join("b.json"), "{\"y\":2}").unwrap();
        let s2: Sig = vec![("a".into(), 2, 5), ("b".into(), 2, 7)];
        let tabs = step(&mut last, s2, |s| read_in(&dir, s, &mut cache)).unwrap();
        assert_eq!(tabs.len(), 2);
        assert_eq!(tabs[0].tab, "a");
        assert_eq!(tabs[0].payload["x"], 1);
        assert_eq!(tabs[1].payload["y"], 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A registry entry for this test process, which stands in for a running claude: `images`
    /// accepts its own image name. `proc_start` None writes the real creation time.
    fn live_entry(dir: &std::path::Path, sid: &str, proc_start: Option<u64>) -> Vec<String> {
        let pid = std::process::id();
        let start = proc_start.unwrap_or_else(|| crate::procs::creation_time(pid).expect("own creation time"));
        std::fs::create_dir_all(dir).unwrap();
        let body = format!("{{\"pid\":{pid},\"sessionId\":\"{sid}\",\"cwd\":\"C:\\\\Work\",\"procStart\":\"{start}\"}}");
        std::fs::write(dir.join(format!("{pid}.json")), body).unwrap();
        vec![crate::procs::image_name(pid).expect("own image name")]
    }

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("vidar-guard-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    #[test]
    fn the_resume_guard_sees_a_live_bare_session() {
        use super::{guard_dirs, live_state_across, registry_dir, LiveState};
        let sid = "aaaaaaaa-2222-3333-4444-555555555555";
        let root = temp_root("bare");
        let (user, bare) = (root.join("user").join("sessions"), root.join("bare").join("sessions"));
        std::fs::create_dir_all(&user).unwrap();
        let images = live_entry(&bare, sid, None);
        // the user's registry alone (the guard before this fix) misses it
        assert!(matches!(live_state_across(&[user.clone()], &images, sid), LiveState::Free));
        assert!(matches!(live_state_across(&[user, bare], &images, sid), LiveState::Live(_)));
        // and the real guard reads every bare home's registry beside the user's
        let dirs = guard_dirs();
        for home in crate::bare::claude_dir::homes_for(Some("bare")) {
            assert!(dirs.contains(&home.join("sessions")), "{dirs:?}");
        }
        assert!(dirs.contains(&registry_dir(None).expect("user registry")), "{dirs:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_resume_guard_reads_a_non_bare_session_as_before() {
        use super::{live_state_across, LiveState};
        let sid = "bbbbbbbb-2222-3333-4444-555555555555";
        let root = temp_root("user");
        let (user, bare) = (root.join("user").join("sessions"), root.join("bare").join("sessions"));
        std::fs::create_dir_all(&bare).unwrap();
        let images = live_entry(&user, sid, None);
        assert!(matches!(live_state_across(&[user.clone(), bare.clone()], &images, sid), LiveState::Live(_)));
        // another id is free; a stale entry (pid reused) is free; a non-Claude image is unknown
        assert!(matches!(live_state_across(&[user.clone(), bare.clone()], &images, "cccccccc-2222-3333-4444-555555555555"), LiveState::Free));
        assert!(matches!(live_state_across(&[user.clone(), bare.clone()], &[], sid), LiveState::Unknown(_)));
        live_entry(&user, sid, Some(1));
        assert!(matches!(live_state_across(&[user, bare], &images, sid), LiveState::Free));
        let _ = std::fs::remove_dir_all(&root);
    }
}
