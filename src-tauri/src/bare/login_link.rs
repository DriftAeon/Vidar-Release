//! src-tauri\src\bare\login_link.rs — one login across every Bare home (Bare slice 2 Part A,
//! `docs/projects/bare/slice2-plan.md` A-D1 to A-D6). Each home's login file name (the profile's
//! `sharedLogin` entries) is hardlinked to `<local app data>\Vidar\homes\_shared\<agent>\<name>`,
//! so a moved or fresh install root reuses the login a sibling home already holds. Codex's
//! `auth.json` (in the profile's `CODEX_HOME`) is shared the same way as `_shared\codex\auth.json`
//! (`sync_codex`, run 2026-10-21-onboarding); its entry is built here, not read from the profile.
//!
//! Trust boundary: this module never opens a login file's contents. It reads names, reparse
//! attributes, file IDs (volume serial + file index, opened for attributes only), link counts and
//! DACLs, and it links, unlinks and renames names. The state it keeps per home and agent
//! (`<home>\logs\login-link.json` for Claude, `login-link-<agent>.json` for any other) is the file
//! ID last seen at sync, never bytes.
//!
//! Sync, under the caller's `HomeLock`, then `_shared\.vidar-lock` (always that order):
//! - shared missing, home has the file → adopt: the file takes an explicit private DACL, is
//!   linked into the store under a temp name, then renamed onto the store name;
//! - shared present, home missing → link the home name to it (a tab logout is undone, Open A3);
//!   when a sibling home (another folder under `homes`, not `_shared`) holds a different login
//!   file newer than the store's, that file is adopted into the store first. A CLI refreshing by
//!   rename splits its home off the store, so the store can hold a rotated, dead refresh token;
//!   linking a fresh home to it made the CLI's refresh fail (2026-10-21);
//! - both missing → the newest sibling home's login file, if any, seeds the store, then links;
//!   a sibling adopted by link is re-checked by file ID, and a file that moved meanwhile leaves
//!   this home unlinked with a warning (Orion S5);
//! - same file ID → nothing;
//! - IDs differ → the side whose ID changed since this home's last sync wins; no record yet → the
//!   store wins, and the launch warning names the `.split` left in the home; both changed → a
//!   skip: each keeps its own file, the record stays, the spawn goes on with a launch warning (a
//!   conflict never overwrites a file that changed; slice2-plan, 2026-10-21). The loser, when
//!   still linked elsewhere, only loses this name; a sole copy keeps a `<name>.split` name, one
//!   per name (Open A1). Neither side's name is ever missing mid-swap: a failed step puts the
//!   home's own name back. Last-write times (sibling adoption only) come from file metadata,
//!   never contents.
//!
//! Refusals (Orion r1 S2): a reparse point on any folder from `Vidar` down to either name, a
//! store folder or file granting anyone beyond the user, SYSTEM and Administrators, a bad
//! `sharedLogin` entry. Every other failure (a link, rename or ACL set, the store
//! lock, the bookkeeping) leaves the home's own file in use, logs a line, and the spawn goes on
//! with a launch warning. One line per change goes to `<home>\logs\login-link.log` (names and IDs).

use std::collections::BTreeMap;
use std::io::Write;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};

use super::home::{self, acl, HomeLock};

/// One `sharedLogin` entry in a profile (A-D4): `file` is relative to the home and sits under a
/// `homeDirs` entry; the store matches it by file name under `_shared\<agent>`.
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct SharedLogin {
    pub agent: String,
    pub file: String,
}

/// A file's identity: volume serial plus file index. Equal IDs are the same file (one hardlink set).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileId {
    volume: u32,
    index: u64,
}

impl std::fmt::Display for FileId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:08x}:{:016x}", self.volume, self.index)
    }
}

const STATE: &str = "login-link.json";
const LOG: &str = "login-link.log";
/// The Codex entry `sync_codex` builds: `<CODEX_HOME>\auth.json`, shared as `_shared\codex\auth.json`.
const CODEX_AGENT: &str = "codex";
const CODEX_LOGIN: &str = "auth.json";
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
const FILE_READ_ATTRIBUTES: u32 = 0x80;
const FILE_SHARE_ALL: u32 = 0x7;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

/// Why a step stopped: `Refuse` ends the spawn; `Skip` leaves this home's own file in use and
/// the spawn goes on with a warning.
enum Fail {
    Refuse(String),
    Skip(String),
}

type Step<T> = Result<T, Fail>;

/// One entry's outcome: the ID to record (`None`: forget the key), its log line, its warning.
struct Done {
    id: Option<FileId>,
    line: Option<String>,
    warning: Option<String>,
}

fn skip(what: String) -> impl FnOnce(std::io::Error) -> Fail {
    move |e| Fail::Skip(format!("{what}: {e}"))
}

#[cfg(test)]
thread_local! {
    /// Tests only: the named step (`link`, `adopt`) fails as an I/O error would.
    pub(crate) static FAULT: std::cell::Cell<&'static str> = const { std::cell::Cell::new("") };
}

fn injected(at: &str) -> std::io::Result<()> {
    #[cfg(test)]
    if FAULT.with(|f| f.get()) == at {
        return Err(std::io::Error::other(format!("injected {at} failure")));
    }
    let _ = at;
    Ok(())
}

/// The prepare call site: checks the entries, then syncs them when `home` sits in a
/// `…\Vidar\homes` folder (`home_path::shared_for`); any other home shares nothing. `Ok` carries
/// the launch warnings.
pub fn sync_profile(home: &Path, entries: &[SharedLogin], home_dirs: &[String], lock: &HomeLock) -> Result<Vec<String>, String> {
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    validate(entries, home_dirs)?;
    match super::home_path::shared_for(home) {
        Some(shared) => sync(home, &shared, entries, lock),
        None => Ok(Vec::new()),
    }
}

/// The Codex prepare call site: `<codex_home>\auth.json` synced like Claude's login, when
/// `codex_home` sits under `home` (any other `CODEX_HOME`, or a home outside `…\Vidar\homes`,
/// shares nothing). `home_dirs` is the Codex profile's.
pub fn sync_codex(home: &Path, codex_home: &Path, home_dirs: &[String], lock: &HomeLock) -> Result<Vec<String>, String> {
    let Ok(rel) = codex_home.strip_prefix(home) else { return Ok(Vec::new()) };
    if rel.as_os_str().is_empty() || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return Ok(Vec::new());
    }
    let file = format!("{}/{CODEX_LOGIN}", rel.to_string_lossy().replace('\\', "/"));
    sync_profile(home, &[SharedLogin { agent: CODEX_AGENT.into(), file }], home_dirs, lock)
}

/// The warnings' lead per agent; Claude's keep their original wording.
fn label(agent: &str) -> &'static str {
    if agent.eq_ignore_ascii_case(CODEX_AGENT) {
        "Shared Codex login"
    } else {
        "Shared login"
    }
}

/// Each agent's own sync record under `<home>\logs`; Claude's keeps its original name.
fn record_name(agent: &str) -> String {
    if agent.eq_ignore_ascii_case("claude") {
        STATE.to_string()
    } else {
        format!("login-link-{}.json", agent.to_ascii_lowercase())
    }
}

/// Whether a record key (`<agent>/<file>`) belongs to `agent`.
fn owned(key: &str, agent: &str) -> bool {
    key.split('/').next().is_some_and(|a| a.eq_ignore_ascii_case(agent))
}

fn parts(rel: &str) -> Vec<String> {
    rel.split(['/', '\\']).filter(|s| !s.is_empty()).map(str::to_ascii_lowercase).collect()
}

/// A-D4: a simple agent name; a relative file with no `.`/`..`/root/drive part, under `homeDirs`;
/// one file name per agent (two entries would share one store file).
fn validate(entries: &[SharedLogin], home_dirs: &[String]) -> Result<(), String> {
    for (i, e) in entries.iter().enumerate() {
        let bad = |why: &str| Err(format!("Launch profile sharedLogin {:?} / {:?}: {why}; spawn refused", e.agent, e.file));
        if e.agent.is_empty() || !e.agent.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return bad("the agent must be a plain name");
        }
        let p = Path::new(&e.file);
        if e.file.is_empty() || !p.components().all(|c| matches!(c, Component::Normal(_))) || e.file.contains(':') {
            return bad("the file must be relative, with no `.` or `..` part");
        }
        let f = parts(&e.file);
        let under_dir = home_dirs.iter().map(|d| parts(d)).any(|d| !d.is_empty() && f.len() > d.len() && f.starts_with(&d));
        if !under_dir {
            return bad("the file must sit under a homeDirs entry");
        }
        let same = |o: &SharedLogin| o.agent.eq_ignore_ascii_case(&e.agent) && parts(&o.file).last() == f.last();
        if entries[..i].iter().any(same) {
            return bad("another entry of this agent has the same file name");
        }
    }
    Ok(())
}

/// Links each entry's home name to the store under `shared`. `_lock` proves the home is held; the
/// store lock is taken after it. Bookkeeping never refuses: an unreadable state file is no record,
/// a failed state or log write is a warning.
pub fn sync(home: &Path, shared: &Path, entries: &[SharedLogin], _lock: &HomeLock) -> Result<Vec<String>, String> {
    let logs = home.join("logs");
    // One record per agent (Claude's and Codex's never share a file); each keeps only its own keys.
    let mut agents: Vec<String> = Vec::new();
    for e in entries {
        if !agents.iter().any(|a| a.eq_ignore_ascii_case(&e.agent)) {
            agents.push(e.agent.clone());
        }
    }
    let mut state: BTreeMap<String, FileId> = BTreeMap::new();
    for a in &agents {
        let r: BTreeMap<String, FileId> = crate::fsx::read_json(&logs.join(record_name(a))).unwrap_or_default();
        state.extend(r.into_iter().filter(|(k, _)| owned(k, a)));
    }
    let (mut lines, mut warnings) = (Vec::new(), Vec::new());
    let result = sync_entries(home, shared, entries, &mut state, &mut lines, &mut warnings);
    for a in &agents {
        let mine: BTreeMap<&String, &FileId> = state.iter().filter(|(k, _)| owned(k, a)).collect();
        let kept = std::fs::create_dir_all(&logs)
            .map_err(|e| e.to_string())
            .and_then(|_| serde_json::to_vec_pretty(&mine).map_err(|e| e.to_string()))
            .and_then(|json| crate::fsx::atomic_write(&logs.join(record_name(a)), &json).map_err(|e| e.to_string()));
        if let Err(e) = kept {
            warnings.push(format!("{} record not saved ({e}); the next launch re-checks this home", label(a)));
        }
    }
    if let Err(e) = append_log(&logs.join(LOG), &lines) {
        let lead = entries.first().map_or("Shared login", |e| label(&e.agent));
        warnings.push(format!("{lead} log not written: {e}"));
    }
    result.map(|_| warnings)
}

fn sync_entries(home: &Path, shared: &Path, entries: &[SharedLogin], state: &mut BTreeMap<String, FileId>, lines: &mut Vec<String>, warnings: &mut Vec<String>) -> Result<(), String> {
    // The `Vidar` folder: every folder from it down to either name is checked for a reparse point.
    let top = shared.parent().and_then(Path::parent).unwrap_or(shared).to_path_buf();
    let store = refuse_reparse_down(&top, home)
        .and_then(|_| refuse_reparse_down(&top, shared))
        .and_then(|_| private_dir(shared))
        .and_then(|_| home::lock(shared, home::LOCK_WAIT).map_err(Fail::Skip));
    let _store = match store {
        Ok(l) => l,
        Err(Fail::Refuse(err)) => {
            lines.push(format!("refused store: {err}"));
            return Err(err);
        }
        Err(Fail::Skip(err)) => {
            lines.push(format!("skipped store: {err}"));
            let lead = entries.first().map_or("Shared login", |e| label(&e.agent));
            warnings.push(format!("{lead} not linked ({err}); this home keeps its own login file"));
            return Ok(());
        }
    };
    let siblings = sibling_homes(home, shared);
    for e in entries {
        let dir = shared.join(&e.agent);
        let key = format!("{}/{}", e.agent, parts(&e.file).join("/"));
        let name = Path::new(&e.file).file_name().map(|n| n.to_os_string()).unwrap_or_default();
        let others: Vec<PathBuf> = siblings.iter().map(|s| super::under(s, &e.file)).collect();
        let outcome = refuse_reparse_down(&top, &dir)
            .and_then(|_| private_dir(&dir))
            .and_then(|_| sync_one(&top, label(&e.agent), &key, &super::under(home, &e.file), &dir.join(&name), state.get(&key).copied(), &others));
        match outcome {
            Ok(done) => {
                match done.id {
                    Some(id) => state.insert(key, id),
                    None => state.remove(&key),
                };
                lines.extend(done.line);
                warnings.extend(done.warning);
            }
            Err(Fail::Refuse(err)) => {
                lines.push(format!("refused {key}: {err}"));
                return Err(err);
            }
            Err(Fail::Skip(err)) => {
                lines.push(format!("skipped {key}: {err}"));
                warnings.push(format!("{} {key} not linked ({err}); this home keeps its own login file", label(&e.agent)));
            }
        }
    }
    Ok(())
}

fn append_log(path: &Path, lines: &[String]) -> Result<(), String> {
    if lines.is_empty() {
        return Ok(());
    }
    let ms = crate::fsx::now_ms();
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    for l in lines {
        writeln!(f, "{ms} {l}").map_err(|e| format!("{}: {e}", path.display()))?;
    }
    Ok(())
}

/// One entry: the ID to record, the log line for any change, and a warning (led by `lead`,
/// `label`'s per-agent wording) for a split.
#[allow(clippy::too_many_arguments)]
fn sync_one(top: &Path, lead: &str, key: &str, h: &Path, s: &Path, rec: Option<FileId>, others: &[PathBuf]) -> Step<Done> {
    refuse_reparse_down(top, h)?;
    refuse_reparse_down(top, s)?;
    let (hs, ss) = (seen(h).map_err(Fail::Skip)?, seen(s).map_err(Fail::Skip)?);
    if ss.is_some() {
        check_file(s)?;
    }
    let ids = |a: &Option<(FileId, u32)>| a.map_or("none".to_string(), |(id, n)| format!("{id} links={n}"));
    let what = format!("{key} home={} shared={}", ids(&hs), ids(&ss));
    let done = |id, line: String, warning| Ok(Done { id: Some(id), line: Some(line), warning });
    match (hs, ss) {
        (None, None) => {
            // Nothing linked yet and no store: a sibling home's newest login seeds it (Orion S1).
            let Some((p, id)) = newest_sibling(top, others, None) else {
                return Ok(Done { id: None, line: None, warning: None });
            };
            match adopt_sibling(lead, key, &p, s, id, None)? {
                Ok(line) => {
                    link_name(s, h, id)?;
                    done(id, format!("{line}link {what}"), None)
                }
                Err(moved) => Ok(moved),
            }
        }
        (Some((a, _)), None) => {
            let aside = adopt(h, s, None)?;
            done(a, format!("adopt {what}{aside}"), None)
        }
        (None, Some((b, bn))) => {
            // A sibling's newer login goes into the store first, so a fresh home never links to a
            // copy whose refresh token another home already rotated. An unreadable store
            // last-write time links the store as it is.
            let mut store = b;
            let mut line = String::new();
            let floor = written(s).ok().map(|t| (b, t));
            if let Some((p, id)) = floor.and_then(|f| newest_sibling(top, others, Some(f))) {
                match adopt_sibling(lead, key, &p, s, id, Some(bn))? {
                    Ok(l) => line = l,
                    Err(moved) => return Ok(moved),
                }
                store = id;
            }
            link_name(s, h, store)?;
            done(store, format!("{line}link {what}"), None)
        }
        (Some((a, _)), Some((b, _))) if a == b => Ok(Done { id: Some(a), line: None, warning: None }),
        (Some((a, an)), Some((b, bn))) => {
            // A conflict never overwrites a file that changed since this home's last sync
            // (slice2-plan, 2026-10-21): a failed CLI refresh is always the newest write, so no
            // last-write order decides between two changed files (Orion M1).
            let home_changed = rec.is_some_and(|r| r != a);
            let shared_changed = rec.is_some_and(|r| r != b);
            if home_changed && shared_changed {
                let warning = format!(
                    "{lead} {key}: this tab keeps its own sign-in, because this home's login file and the shared one both changed since the last sync"
                );
                // The record stays: neither side may later win over the other by default.
                return Ok(Done { id: rec, line: Some(format!("keep-both {what}")), warning: Some(warning) });
            }
            if home_changed {
                let aside = adopt(h, s, Some(bn))?;
                return done(a, format!("home-wins {what}{aside}"), None);
            }
            // The store changed, or no record yet: the store wins.
            let split = replace_home(s, h, b, an)?;
            let aside = split.as_ref().map_or(format!(" unlinked={}", h.display()), |p| format!(" split={}", p.display()));
            // No record: this home's differing login was never seen synced, so say where it went.
            let warning = split.filter(|_| rec.is_none()).map(|p| {
                format!("{lead} {key}: this home's own differing login file was set aside as {}; the shared login is in use", p.display())
            });
            done(b, format!("shared-wins {what}{aside}"), warning)
        }
    }
}

/// Adopts a sibling home's login `p` (seen as `id`) into the store, then re-reads the store's ID
/// (Orion S5): a sibling CLI that renamed between the look and the link put another file in. `Ok`
/// carries the log prefix; the inner `Err` is the outcome for a moved file: this home stays
/// unlinked and its record is dropped, so the next launch links whatever the store then holds.
fn adopt_sibling(lead: &str, key: &str, p: &Path, s: &Path, id: FileId, store_links: Option<u32>) -> Step<Result<String, Done>> {
    raced(p);
    let aside = adopt(p, s, store_links)?;
    let from = p.display();
    match seen(s) {
        Ok(Some((now, _))) if now == id => Ok(Ok(format!("adopt-sibling {key} from={from} id={id}{aside}; "))),
        now => {
            let got = now.ok().flatten().map_or("none".to_string(), |(n, _)| n.to_string());
            Ok(Err(Done {
                id: None,
                line: Some(format!("adopt-sibling-moved {key} from={from} want={id} got={got}{aside}")),
                warning: Some(format!(
                    "{lead} {key} not linked: another home's login file changed while it was being shared, so this tab starts without a login file; the next launch links the shared one"
                )),
            }))
        }
    }
}

/// Tests only (`FAULT` = `sibling-race`): a sibling CLI refreshes by rename between the look and
/// the link. The file written is a fake.
fn raced(p: &Path) {
    #[cfg(test)]
    if FAULT.with(|f| f.get()) == "sibling-race" {
        let tmp = beside(p, ".race");
        std::fs::write(&tmp, "RACED").unwrap();
        std::fs::rename(&tmp, p).unwrap();
    }
    let _ = p;
}

/// The other home folders beside `home` under `homes` (never `_shared`). An unreadable `homes`
/// folder is no siblings.
fn sibling_homes(home: &Path, shared: &Path) -> Vec<PathBuf> {
    let Some(homes) = shared.parent() else { return Vec::new() };
    let Ok(rd) = std::fs::read_dir(homes) else { return Vec::new() };
    let own = home.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase());
    let store = shared.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase());
    let mut out: Vec<PathBuf> = rd
        .flatten()
        .filter(|d| d.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink()))
        .filter(|d| {
            let n = Some(d.file_name().to_string_lossy().to_ascii_lowercase());
            n != own && n != store
        })
        .map(|d| d.path())
        .collect();
    out.sort();
    out
}

/// A file's last-write time, from its metadata (never its contents).
fn written(p: &Path) -> Step<std::time::SystemTime> {
    std::fs::symlink_metadata(p).and_then(|m| m.modified()).map_err(skip(format!("Bare login {} last-write time", p.display())))
}

/// The newest sibling login file; with a store (its ID and last-write time), only one that is not
/// the store file and is newer than it. A sibling with a reparse point anywhere on its path, or
/// unreadable metadata, is passed over (its own spawn refuses or warns), never followed.
fn newest_sibling(top: &Path, others: &[PathBuf], store: Option<(FileId, std::time::SystemTime)>) -> Option<(PathBuf, FileId)> {
    let mut best: Option<(PathBuf, FileId, std::time::SystemTime)> = None;
    for p in others {
        if refuse_reparse_down(top, p).is_err() {
            continue;
        }
        let Ok(Some((id, _))) = seen(p) else { continue };
        let Ok(t) = written(p) else { continue };
        let over_store = store.is_none_or(|(sid, floor)| id != sid && t > floor);
        if over_store && best.as_ref().is_none_or(|b| t > b.2) {
            best = Some((p.clone(), id, t));
        }
    }
    best.map(|(p, id, _)| (p, id))
}

/// `p` with `suffix` added to its file name.
fn beside(p: &Path, suffix: &str) -> PathBuf {
    let mut name = p.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    p.with_file_name(name)
}

/// Clears a name this module owns (a temp or `.split` name); a reparse point refuses.
fn clear(p: &Path) -> Step<()> {
    refuse_reparse(p)?;
    match std::fs::remove_file(p) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(Fail::Skip(format!("clear {}: {e}", p.display()))),
        _ => Ok(()),
    }
}

/// Adopts the home's file into the store: an explicit private DACL, a link under a temp name,
/// then a rename onto the store name, so the store name is never missing (Orion r1 S2). A sole
/// store copy (`store_links == Some(1)`) keeps a `.split` name. Returns the log suffix.
fn adopt(h: &Path, s: &Path, store_links: Option<u32>) -> Step<String> {
    acl::set_private_file(h).map_err(|e| Fail::Skip(format!("Bare login {e}")))?;
    let tmp = beside(s, ".vidar-adopt");
    clear(&tmp)?;
    std::fs::hard_link(h, &tmp).map_err(skip(format!("link {} -> {}", tmp.display(), h.display())))?;
    let undo = |made: &[&Path]| made.iter().for_each(|p| drop(std::fs::remove_file(p)));
    if let Err(e) = check_file(&tmp) {
        undo(&[tmp.as_path()]);
        return Err(e);
    }
    let split = beside(s, ".split");
    let keep_split = store_links == Some(1);
    if keep_split {
        let kept = clear(&split).and_then(|_| std::fs::hard_link(s, &split).map_err(skip(format!("link {}", split.display()))));
        if let Err(e) = kept {
            undo(&[tmp.as_path()]);
            return Err(e);
        }
    }
    if let Err(e) = injected("adopt").and_then(|_| std::fs::rename(&tmp, s)) {
        undo(&[tmp.as_path(), split.as_path()][..if keep_split { 2 } else { 1 }]);
        return Err(Fail::Skip(format!("rename {} -> {}: {e}", tmp.display(), s.display())));
    }
    Ok(match store_links {
        Some(1) => format!(" split={}", split.display()),
        Some(_) => format!(" unlinked={}", s.display()),
        None => String::new(),
    })
}

/// The store wins over the home's name: it moves aside (`<name>.split` for a sole copy, a temp
/// name when still linked elsewhere), the store is linked in, and a failed link renames it back.
/// Returns the `.split` path when one is left.
fn replace_home(s: &Path, h: &Path, want: FileId, links: u32) -> Step<Option<PathBuf>> {
    let keep = links <= 1;
    let aside = beside(h, if keep { ".split" } else { ".vidar-old" });
    clear(&aside)?;
    std::fs::rename(h, &aside).map_err(skip(format!("set aside {}", h.display())))?;
    if let Err(Fail::Skip(e) | Fail::Refuse(e)) = link_name(s, h, want) {
        return Err(Fail::Skip(match std::fs::rename(&aside, h) {
            Ok(()) => e,
            Err(r) => format!("{e}; restoring {} from {} failed: {r}", h.display(), aside.display()),
        }));
    }
    if !keep {
        // A stray temp name is cleared by the next sync; the old file is still linked elsewhere.
        let _ = std::fs::remove_file(&aside);
    }
    Ok(keep.then_some(aside))
}

/// Links the home name to the store file and checks it took (a lost race removes the new name).
fn link_name(s: &Path, h: &Path, want: FileId) -> Step<()> {
    injected("link")
        .and_then(|_| std::fs::hard_link(s, h))
        .map_err(skip(format!("link {} -> {}", h.display(), s.display())))?;
    match seen(h) {
        Ok(Some((id, _))) if id == want => Ok(()),
        _ => {
            let _ = std::fs::remove_file(h);
            Err(Fail::Skip(format!("{}: the new name is not the shared file", h.display())))
        }
    }
}

fn refuse_reparse(p: &Path) -> Step<()> {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 => {
            Err(Fail::Refuse(format!("Bare login {} is a reparse point (link or junction); spawn refused", p.display())))
        }
        _ => Ok(()),
    }
}

/// `leaf` and every folder above it up to and including `top` (Orion r1 S3): a junctioned
/// `claude-config`, home, `homes` or store folder refuses, not only the leaf.
fn refuse_reparse_down(top: &Path, leaf: &Path) -> Step<()> {
    for p in leaf.ancestors() {
        refuse_reparse(p)?;
        if p == top {
            break;
        }
    }
    Ok(())
}

/// A store folder: never a reparse point, created private when missing, strictly private always.
fn private_dir(dir: &Path) -> Step<()> {
    refuse_reparse(dir)?;
    if !dir.exists() {
        if let Err(e) = acl::create_private_dir(dir, &[]) {
            if !dir.is_dir() {
                return Err(Fail::Skip(e));
            }
        }
    }
    acl::check_private(dir).map_err(|e| Fail::Refuse(format!("Shared login store: {e}")))
}

fn check_file(s: &Path) -> Step<()> {
    acl::check_private(s).map_err(|e| Fail::Refuse(format!("Shared login file: {e}")))
}

/// The file ID and link count of `p`, opened for attributes only (never its data); `None` when
/// the name is absent.
pub(crate) fn seen(p: &Path) -> Result<Option<(FileId, u32)>, String> {
    match std::fs::symlink_metadata(p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Bare login {}: {e}", p.display())),
        Ok(m) if m.is_dir() => return Err(format!("Bare login {} is a folder", p.display())),
        Ok(_) => {}
    }
    let f = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_ALL)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(p)
        .map_err(|e| format!("Bare login {}: {e}", p.display()))?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(f.as_raw_handle()), &mut info) }.map_err(|e| format!("Bare login {}: file ID: {e}", p.display()))?;
    let index = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
    Ok(Some((FileId { volume: info.dwVolumeSerialNumber, index }, info.nNumberOfLinks)))
}

/// Tests only: sets `file`'s DACL to `dir`'s, to plant a foreign ACE on a store file.
#[cfg(test)]
pub(crate) fn take_dir_dacl(file: &Path, dir: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Security::{GetFileSecurityW, SetFileSecurityW, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};
    let wide = |p: &Path| p.as_os_str().encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (wd, wf) = (wide(dir), wide(file));
    let err = || format!("cannot set {} from {}", file.display(), dir.display());
    unsafe {
        let mut need = 0u32;
        let _ = GetFileSecurityW(PCWSTR(wd.as_ptr()), DACL_SECURITY_INFORMATION.0, None, 0, &mut need);
        let mut buf = vec![0u64; (need as usize).div_ceil(8).max(1)];
        let psd = PSECURITY_DESCRIPTOR(buf.as_mut_ptr() as *mut _);
        if need == 0 || !GetFileSecurityW(PCWSTR(wd.as_ptr()), DACL_SECURITY_INFORMATION.0, Some(psd), need, &mut need).as_bool() {
            return Err(err());
        }
        if !SetFileSecurityW(PCWSTR(wf.as_ptr()), DACL_SECURITY_INFORMATION, psd).as_bool() {
            return Err(err());
        }
    }
    Ok(())
}

/// Conflicts and sibling adoption: fake login files in temp folders; contents are read back only
/// by the assertions.
#[cfg(test)]
mod conflict_tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    const CRED: &str = "claude-config/.credentials.json";

    /// Which login a test runs on: Claude's through its profile entry, Codex's through `sync_codex`.
    struct Kind {
        agent: &'static str,
        dir: &'static str,
        file: &'static str,
    }
    const CLAUDE: Kind = Kind { agent: "claude", dir: "claude-config", file: ".credentials.json" };
    const CODEX: Kind = Kind { agent: "codex", dir: "codex-home", file: "auth.json" };

    impl Kind {
        fn run(&self, h: &Path, lock: &HomeLock) -> Result<Vec<String>, String> {
            match self.agent {
                "claude" => sync_profile(h, &[SharedLogin { agent: "claude".into(), file: CRED.into() }], &dirs(), lock),
                _ => sync_codex(h, &h.join(self.dir), &dirs(), lock),
            }
        }
        fn cred(&self, h: &Path) -> PathBuf {
            h.join(self.dir).join(self.file)
        }
        fn split(&self, p: &Path) -> PathBuf {
            p.with_file_name(format!("{}.split", self.file))
        }
        /// Every warning of this kind leads with its own wording.
        fn lead(&self, warnings: &[String]) {
            let lead = if self.agent == "codex" { "Shared Codex login " } else { "Shared login " };
            assert!(warnings.iter().all(|w| w.starts_with(lead)), "{warnings:?}");
        }
    }

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> TempDir {
            let nanos = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let p = std::env::temp_dir().join(format!("vidar-login-{tag}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        fn homes(&self) -> PathBuf {
            self.0.join("lad").join("Vidar").join("homes")
        }
        fn store(&self, k: &Kind) -> PathBuf {
            self.homes().join("_shared").join(k.agent).join(k.file)
        }
        fn home(&self, key: &str) -> (PathBuf, HomeLock) {
            let h = self.homes().join(key);
            home::prepare_dirs(&h, &dirs()).unwrap();
            let lock = home::lock(&h, home::LOCK_WAIT).unwrap();
            (h, lock)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn dirs() -> Vec<String> {
        vec!["claude-config".into(), "codex-home".into(), "logs".into()]
    }

    fn id(p: &Path) -> FileId {
        seen(p).unwrap().expect("name present").0
    }

    /// What a CLI refreshing by temp file plus rename does, stamped `age` in the past.
    fn rewrite_by_rename(p: &Path, text: &str, age: Duration) {
        let tmp = p.with_extension("tmp");
        std::fs::write(&tmp, text).unwrap();
        std::fs::rename(&tmp, p).unwrap();
        stamp(p, age);
    }

    fn stamp(p: &Path, age: Duration) {
        let f = std::fs::OpenOptions::new().write(true).open(p).unwrap();
        f.set_modified(SystemTime::now() - age).unwrap();
    }

    const HOUR: Duration = Duration::from_secs(3600);

    // Each case runs for Claude (`<name>`) and Codex (`codex_<name>`) on the same sync.

    fn after_a_refresh_split(k: &Kind) {
        let t = TempDir::new("fresh");
        let (a, la) = t.home("aaaaaaaaaaaaaaaa");
        std::fs::write(k.cred(&a), "OLD").unwrap();
        stamp(&k.cred(&a), 2 * HOUR);
        k.run(&a, &la).unwrap();
        let (b, lb) = t.home("bbbbbbbbbbbbbbbb");
        k.run(&b, &lb).unwrap();
        // B's CLI refreshes by rename: B splits off, the store keeps the rotated (dead) token.
        rewrite_by_rename(&k.cred(&b), "NEW", Duration::ZERO);
        let stale = id(&t.store(k));
        assert_ne!(stale, id(&k.cred(&b)));
        let (c, lc) = t.home("cccccccccccccccc");
        k.run(&c, &lc).unwrap();
        assert_eq!(id(&k.cred(&c)), id(&k.cred(&b)), "the fresh home got the stale store");
        assert_eq!(id(&t.store(k)), id(&k.cred(&b)));
        assert_eq!(id(&k.cred(&a)), stale, "A keeps its own name to the old file");
        let log = std::fs::read_to_string(c.join("logs").join(LOG)).unwrap();
        assert!(log.contains("adopt-sibling") && !log.contains("NEW") && !log.contains("OLD"), "{log}");
    }

    #[test]
    fn after_a_refresh_split_a_fresh_home_links_the_newest_sibling() {
        after_a_refresh_split(&CLAUDE);
    }

    #[test]
    fn codex_after_a_refresh_split_a_fresh_home_links_the_newest_sibling() {
        after_a_refresh_split(&CODEX);
    }

    fn both_changed(k: &Kind) {
        for home_newer in [true, false] {
            let t = TempDir::new("both");
            let (a, la) = t.home("aaaaaaaaaaaaaaaa");
            std::fs::write(k.cred(&a), "ONE").unwrap();
            stamp(&k.cred(&a), 3 * HOUR);
            k.run(&a, &la).unwrap();
            let (b, lb) = t.home("bbbbbbbbbbbbbbbb");
            k.run(&b, &lb).unwrap();
            let (home_age, store_age) = if home_newer { (Duration::ZERO, HOUR) } else { (HOUR, Duration::ZERO) };
            rewrite_by_rename(&k.cred(&a), "HOME", home_age);
            rewrite_by_rename(&t.store(k), "STORE", store_age);
            let (ha, hs) = (id(&k.cred(&a)), id(&t.store(k)));
            for _ in 0..2 {
                let warnings = k.run(&a, &la).expect("both changed must not refuse the spawn");
                assert!(warnings.len() == 1 && warnings[0].contains("keeps its own sign-in"), "{warnings:?}");
                k.lead(&warnings);
                assert_eq!((id(&k.cred(&a)), id(&t.store(k))), (ha, hs), "a changed file was overwritten");
            }
            assert_eq!(std::fs::read_to_string(k.cred(&a)).unwrap(), "HOME");
            assert_eq!(std::fs::read_to_string(t.store(k)).unwrap(), "STORE");
            assert!(!k.split(&k.cred(&a)).exists());
            assert!(!k.split(&t.store(k)).exists());
            let log = std::fs::read_to_string(a.join("logs").join(LOG)).unwrap();
            assert!(log.contains("keep-both") && !log.contains("HOME") && !log.contains("STORE"), "{log}");
        }
    }

    #[test]
    fn both_changed_keeps_each_file_whichever_is_newer() {
        both_changed(&CLAUDE);
    }

    #[test]
    fn codex_both_changed_keeps_each_file_whichever_is_newer() {
        both_changed(&CODEX);
    }

    fn unrecorded_loses(k: &Kind) {
        let t = TempDir::new("unrecorded");
        let (a, la) = t.home("aaaaaaaaaaaaaaaa");
        std::fs::write(k.cred(&a), "STORE").unwrap();
        stamp(&k.cred(&a), HOUR);
        k.run(&a, &la).unwrap();
        let (e, le) = t.home("eeeeeeeeeeeeeeee");
        std::fs::write(k.cred(&e), "NEWEST").unwrap();
        let store = id(&t.store(k));
        let warnings = k.run(&e, &le).unwrap();
        assert_eq!((id(&k.cred(&e)), id(&t.store(k))), (store, store));
        let split = k.split(&k.cred(&e));
        assert_eq!(std::fs::read_to_string(&split).unwrap(), "NEWEST", "the sole home copy is kept");
        assert!(warnings.len() == 1 && warnings[0].contains(&split.display().to_string()), "{warnings:?}");
        k.lead(&warnings);
    }

    #[test]
    fn an_unrecorded_home_newer_than_the_store_still_loses_to_it() {
        unrecorded_loses(&CLAUDE);
    }

    #[test]
    fn codex_an_unrecorded_home_newer_than_the_store_still_loses_to_it() {
        unrecorded_loses(&CODEX);
    }

    fn no_store_adopts(k: &Kind) {
        let t = TempDir::new("nostore");
        // A lone fresh home with no siblings links nothing.
        let (a, la) = t.home("aaaaaaaaaaaaaaaa");
        assert!(k.run(&a, &la).unwrap().is_empty());
        assert!(!k.cred(&a).exists() && !t.store(k).exists());
        // Two homes hold logins the store never saw; the newer one seeds it.
        let (b, _lb) = t.home("bbbbbbbbbbbbbbbb");
        std::fs::write(k.cred(&b), "OLDER").unwrap();
        stamp(&k.cred(&b), 2 * HOUR);
        let (c, _lc) = t.home("cccccccccccccccc");
        std::fs::write(k.cred(&c), "NEWER").unwrap();
        stamp(&k.cred(&c), HOUR);
        k.run(&a, &la).unwrap();
        let newer = id(&k.cred(&c));
        assert_eq!((id(&k.cred(&a)), id(&t.store(k))), (newer, newer));
        assert_eq!(seen(&k.cred(&b)).unwrap().unwrap().1, 1, "the older sibling is left alone");
        let log = std::fs::read_to_string(a.join("logs").join(LOG)).unwrap();
        assert!(log.contains("adopt-sibling") && !log.contains("NEWER"), "{log}");
    }

    #[test]
    fn with_no_store_a_fresh_home_adopts_the_newest_sibling() {
        no_store_adopts(&CLAUDE);
    }

    #[test]
    fn codex_with_no_store_a_fresh_home_adopts_the_newest_sibling() {
        no_store_adopts(&CODEX);
    }

    fn sibling_moves(k: &Kind) {
        let t = TempDir::new("race");
        let (a, la) = t.home("aaaaaaaaaaaaaaaa");
        std::fs::write(k.cred(&a), "OLD").unwrap();
        stamp(&k.cred(&a), 2 * HOUR);
        k.run(&a, &la).unwrap();
        let (b, lb) = t.home("bbbbbbbbbbbbbbbb");
        k.run(&b, &lb).unwrap();
        rewrite_by_rename(&k.cred(&b), "NEW", HOUR);
        let stale = id(&t.store(k));
        let (c, lc) = t.home("cccccccccccccccc");
        FAULT.with(|f| f.set("sibling-race"));
        let warnings = k.run(&c, &lc);
        FAULT.with(|f| f.set(""));
        let warnings = warnings.unwrap();
        assert!(warnings.len() == 1 && warnings[0].contains("not linked") && warnings[0].contains("changed while"), "{warnings:?}");
        k.lead(&warnings);
        assert!(!k.cred(&c).exists(), "the home was linked on a stale ID");
        assert_eq!(id(&t.store(k)), id(&k.cred(&b)), "the store holds the sibling's current file");
        assert_eq!(id(&k.cred(&a)), stale);
        let log = std::fs::read_to_string(c.join("logs").join(LOG)).unwrap();
        assert!(log.contains("adopt-sibling-moved"), "{log}");
        // The next launch links what the store now holds.
        assert!(k.run(&c, &lc).unwrap().is_empty());
        assert_eq!(id(&k.cred(&c)), id(&t.store(k)));
    }

    #[test]
    fn a_sibling_that_moves_mid_adopt_leaves_the_home_unlinked() {
        sibling_moves(&CLAUDE);
    }

    #[test]
    fn codex_a_sibling_that_moves_mid_adopt_leaves_the_home_unlinked() {
        sibling_moves(&CODEX);
    }

    fn stale_store(k: &Kind) {
        let t = TempDir::new("sibling");
        let (a, la) = t.home("aaaaaaaaaaaaaaaa");
        std::fs::write(k.cred(&a), "STORE").unwrap();
        stamp(&k.cred(&a), HOUR);
        k.run(&a, &la).unwrap();
        // A sibling outside the link set, older than the store: the store is linked as it is.
        let (b, _lb) = t.home("bbbbbbbbbbbbbbbb");
        std::fs::write(k.cred(&b), "OLDER").unwrap();
        stamp(&k.cred(&b), 2 * HOUR);
        let store = id(&t.store(k));
        let (c, lc) = t.home("cccccccccccccccc");
        k.run(&c, &lc).unwrap();
        assert_eq!((id(&k.cred(&c)), id(&t.store(k))), (store, store));
        // A newer sibling: adopted before the next fresh home links.
        stamp(&k.cred(&b), Duration::ZERO);
        let (d, ld) = t.home("dddddddddddddddd");
        k.run(&d, &ld).unwrap();
        assert_eq!((id(&k.cred(&d)), id(&t.store(k))), (id(&k.cred(&b)), id(&k.cred(&b))));
        assert_eq!(id(&k.cred(&c)), store, "a home already linked keeps its name until its own sync");
    }

    #[test]
    fn a_stale_store_never_overrides_a_newer_sibling_and_an_older_one_is_ignored() {
        stale_store(&CLAUDE);
    }

    #[test]
    fn codex_a_stale_store_never_overrides_a_newer_sibling_and_an_older_one_is_ignored() {
        stale_store(&CODEX);
    }

    #[test]
    fn codex_and_claude_keep_separate_stores_and_records() {
        let t = TempDir::new("separate");
        let (a, la) = t.home("aaaaaaaaaaaaaaaa");
        std::fs::write(CLAUDE.cred(&a), "CLAUDE").unwrap();
        std::fs::write(CODEX.cred(&a), "CODEX").unwrap();
        CLAUDE.run(&a, &la).unwrap();
        CODEX.run(&a, &la).unwrap();
        assert_eq!(id(&t.store(&CLAUDE)), id(&CLAUDE.cred(&a)));
        assert_eq!(id(&t.store(&CODEX)), id(&CODEX.cred(&a)));
        assert_ne!(id(&t.store(&CLAUDE)), id(&t.store(&CODEX)));
        let logs = a.join("logs");
        let claude: BTreeMap<String, FileId> = crate::fsx::read_json(&logs.join(STATE)).unwrap();
        let codex: BTreeMap<String, FileId> = crate::fsx::read_json(&logs.join("login-link-codex.json")).unwrap();
        assert_eq!(claude.keys().collect::<Vec<_>>(), vec!["claude/claude-config/.credentials.json"]);
        assert_eq!(codex.keys().collect::<Vec<_>>(), vec!["codex/codex-home/auth.json"]);
        // A second Codex sync leaves Claude's record as it was.
        CODEX.run(&a, &la).unwrap();
        let again: BTreeMap<String, FileId> = crate::fsx::read_json(&logs.join(STATE)).unwrap();
        assert_eq!(again, claude);
    }

    #[test]
    fn a_codex_home_outside_the_bare_home_shares_nothing() {
        let t = TempDir::new("codex-outside");
        let (a, la) = t.home("aaaaaaaaaaaaaaaa");
        let elsewhere = t.0.join("codex-elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("auth.json"), "TOKEN").unwrap();
        assert!(sync_codex(&a, &elsewhere, &dirs(), &la).unwrap().is_empty());
        assert!(sync_codex(&a, &a, &dirs(), &la).unwrap().is_empty());
        assert!(!t.homes().join("_shared").exists(), "a store was made for an outside CODEX_HOME");
    }
}
