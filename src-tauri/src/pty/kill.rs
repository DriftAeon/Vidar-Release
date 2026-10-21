/* ---- tearing a pty tree down ----
   Shared by kill_pty and adopt_session. Window close kills
   nothing: GUI apps launched from a raw tab must outlive Vidar.
   Two rules: the tab map's lock is never held across a taskkill or a wait
   (a sync kill on the UI thread froze the window for the whole teardown), and
   teardown uses deadlines so a wedged tree can finish Close or refuse Resume. */

use std::collections::{HashMap, HashSet};
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::Child;
use windows::Win32::Foundation::{
    CloseHandle, ERROR_INVALID_PARAMETER, FILETIME, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_ACCESS_RIGHTS,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

use super::CREATE_NO_WINDOW;
use crate::procs::ProcRow;

/// How long taskkill gets to answer before the call fails.
pub(crate) const KILL_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the root gets to be reaped after taskkill and kill().
const REAP_TIMEOUT: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(25);

/// What follows a teardown. Close logs failures and finishes after a bounded
/// attempt on the root handle and recorded identities, so the session's flow
/// and ConPTY handles can close. Resume (Raw/Rendered switch, adopt)
/// keeps failures and retry identities because an agent resumes on success.
/// Every Resume attempt refuses while the tree is unrecorded. On a first attempt
/// with the root already gone, nothing was walked, so nothing can be recorded
/// and Resume proceeds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Intent {
    Close,
    Resume,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ProcessIdentity {
    pid: u32,
    created: u64,
}

/// State to keep alongside the child in a restored slot, even after shell exit.
#[derive(Default)]
pub(crate) struct KillRetry {
    root: Option<ProcessIdentity>,
    descendants: Vec<ProcessIdentity>,
    /// Sticky: once a snapshot recorded the tree, a later failed snapshot on
    /// retry does not forget it.
    tree_recorded: bool,
    /// The last kill took the Falcon-sparing path (per-PID taskkill, no /T).
    spared: bool,
}

impl KillRetry {
    fn recorded(&self) -> Vec<ProcessIdentity> {
        self.root.iter().chain(&self.descendants).copied().collect()
    }
}

#[derive(Clone, Copy)]
enum ProcessObservation {
    Gone,
    Present(u64),
    Unknown,
}

/// The recorded PIDs not proven gone. Missing observations and unreadable
/// identities are not proof of exit.
fn recorded_survivors(
    previous: &[ProcessIdentity],
    snapshot: &HashMap<u32, ProcessObservation>,
) -> Vec<u32> {
    previous
        .iter()
        .filter(|p| match snapshot.get(&p.pid) {
            Some(ProcessObservation::Gone) => false,
            Some(ProcessObservation::Present(created)) => *created == p.created,
            _ => true,
        })
        .map(|p| p.pid)
        .collect()
}

fn recorded_gone(
    previous: &[ProcessIdentity],
    snapshot: &HashMap<u32, ProcessObservation>,
) -> bool {
    recorded_survivors(previous, snapshot).is_empty()
}

fn survivors_error(pids: &[u32]) -> String {
    let list = pids.iter().map(u32::to_string).collect::<Vec<_>>().join(", ");
    format!("a recorded process is still running or could not be verified (pid {list})")
}

const SHELL_UNVERIFIED: &str = "the shell identity could not be verified";
const TREE_UNVERIFIED: &str = "the process tree snapshot could not be verified";
const SHELL_EXITED_UNRECORDED: &str = "the shell exited before its process tree was recorded; close the tab to end it";

fn root_exit_verified(
    root: ProcessIdentity,
    seen: ProcessObservation,
    tree_recorded: bool,
) -> Result<bool, String> {
    let gone = recorded_gone(&[root], &HashMap::from([(root.pid, seen)]));
    if gone && !tree_recorded {
        // An exited shell cannot prove that an unrecorded tree has exited.
        Err(SHELL_EXITED_UNRECORDED.into())
    } else {
        Ok(gone)
    }
}

/// Close logs teardown problems so the slot and ConPTY handles can drop;
/// Resume keeps the error and the slot's recorded identities for a retry.
fn close_outcome(intent: Intent, e: String) -> Result<(), String> {
    match intent {
        Intent::Resume => Err(e),
        Intent::Close => {
            eprintln!("pty close: {e}; teardown finishes");
            Ok(())
        }
    }
}

/// The retained-state branch's root check. Ok(true): the earlier stop is
/// finished. A never-recorded tree whose root is gone is refused on every
/// Resume attempt and finished by Close (a closed tab is the way out of a
/// wedged slot). The root identity stays retained, so a reused PID is never
/// taken for the shell.
fn retained_root_step(
    retry: &KillRetry,
    root: ProcessIdentity,
    seen: ProcessObservation,
    intent: Intent,
) -> Result<bool, String> {
    root_exit_verified(root, seen, retry.tree_recorded)
        .or_else(|e| close_outcome(intent, e).map(|()| true))
}

/// Adopt's outcome. No recorded tree: the kill's own refusal stands. Spared
/// path: verification of every recorded identity is the proof, since a
/// per-PID taskkill can fail on a helper that exited after the snapshot
/// (inferred). Plain /T path: verification and the taskkill result both count.
fn adopt_outcome(
    kill: Result<(), String>,
    retry: &KillRetry,
    verify: impl FnOnce(&KillRetry) -> Result<(), String>,
) -> Result<(), String> {
    if !retry.tree_recorded {
        return kill;
    }
    verify(retry)?;
    if retry.spared {
        Ok(())
    } else {
        kill
    }
}

/// A retry terminates only a process still holding the recorded identity.
fn same_identity(recorded: ProcessIdentity, seen: ProcessObservation) -> bool {
    matches!(seen, ProcessObservation::Present(created) if created == recorded.created)
}

/// `signaled`: the zero-timeout wait's answer (None when the wait failed).
/// A signaled handle is an exited process whatever its exit code, so a
/// process that exited with 259 (STILL_ACTIVE) does not read as running.
fn classify(signaled: Option<bool>, created: Option<u64>) -> ProcessObservation {
    match (signaled, created) {
        (Some(true), _) => ProcessObservation::Gone,
        (Some(false), Some(created)) => ProcessObservation::Present(created),
        _ => ProcessObservation::Unknown,
    }
}

/// Open `pid` with `rights` (plus query and synchronize). Err carries the
/// observation when the open itself settles it.
fn open_process(pid: u32, rights: PROCESS_ACCESS_RIGHTS) -> Result<HANDLE, ProcessObservation> {
    let rights = rights | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
    // SAFETY: plain FFI call; a returned handle is owned and closed by the caller.
    match unsafe { OpenProcess(rights, false, pid) } {
        Ok(handle) => Ok(handle),
        Err(e) if e.code() == windows::core::HRESULT::from_win32(ERROR_INVALID_PARAMETER.0) => {
            Err(ProcessObservation::Gone)
        }
        Err(_) => Err(ProcessObservation::Unknown),
    }
}

/// Query creation time and liveness on the same handle, so PID reuse between
/// the queries cannot make an unrelated process look like the recorded one.
/// SAFETY: `handle` must be a valid process handle opened by open_process.
unsafe fn observe_handle(handle: HANDLE) -> ProcessObservation {
    let mut created = FILETIME::default();
    let (mut exit, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    // SAFETY: valid handle per the contract above; out-params are stack values.
    let (times, wait) = unsafe {
        (
            GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user),
            WaitForSingleObject(handle, 0),
        )
    };
    let signaled = if wait == WAIT_OBJECT_0 {
        Some(true)
    } else if wait == WAIT_TIMEOUT {
        Some(false)
    } else {
        None
    };
    let created = times
        .is_ok()
        .then(|| ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64);
    classify(signaled, created)
}

fn observe(pid: u32) -> ProcessObservation {
    let handle = match open_process(pid, PROCESS_ACCESS_RIGHTS(0)) {
        Ok(handle) => handle,
        Err(seen) => return seen,
    };
    // SAFETY: the handle came from open_process and is closed once here.
    unsafe {
        let seen = observe_handle(handle);
        let _ = CloseHandle(handle);
        seen
    }
}

/// Terminate `recorded` through the handle its identity was checked on, so a
/// reused PID is never killed. Failures surface in the caller's verification.
fn terminate_if_same(recorded: ProcessIdentity) {
    let Ok(handle) = open_process(recorded.pid, PROCESS_TERMINATE) else {
        return;
    };
    // SAFETY: the handle came from open_process and is closed once here.
    unsafe {
        if same_identity(recorded, observe_handle(handle)) {
            let _ = TerminateProcess(handle, 1);
        }
        let _ = CloseHandle(handle);
    }
}

fn retry_survivors(retry: &KillRetry) -> Vec<u32> {
    let recorded = retry.recorded();
    let snapshot = recorded.iter().map(|p| (p.pid, observe(p.pid))).collect();
    recorded_survivors(&recorded, &snapshot)
}

fn verify_retry(retry: &KillRetry, deadline: Instant) -> Result<(), String> {
    loop {
        let survivors = retry_survivors(retry);
        if survivors.is_empty() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(survivors_error(&survivors));
        }
        thread::sleep(POLL);
    }
}

/// The tab id becomes a filename (status.rs: bridge\sessions\<id>.json) and an
/// env value. Keep it a leaf, including on Windows. Same rule as agent.rs.
pub(crate) fn valid_tab_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A tab-map slot. `Stopping` holds the id while a kill runs outside the
/// lock: a concurrent kill, adopt or spawn sees it and refuses, rather than
/// finding no entry and resuming beside a tree that is still dying.
pub(crate) enum Slot<T> {
    Live(T),
    Stopping,
}

impl<T> Slot<T> {
    pub(crate) fn live(&self) -> Option<&T> {
        match self {
            Slot::Live(t) => Some(t),
            Slot::Stopping => None,
        }
    }
}

pub(crate) const STOPPING: &str = "terminal is stopping";

/// spawn_pty's admission: a leaf-safe id that no entry already holds (a
/// second insert would drop the first session's handles while its tree runs;
/// a stopping one is still dying).
pub(crate) fn admit<T>(map: &HashMap<String, Slot<T>>, id: &str) -> Result<(), String> {
    if !valid_tab_id(id) {
        return Err("invalid tab id".into());
    }
    match map.get(id) {
        Some(Slot::Live(_)) => Err("pty already exists for this tab".into()),
        Some(Slot::Stopping) => Err(STOPPING.into()),
        None => Ok(()),
    }
}

/// Clears a `Stopping` slot if `f` unwinds, so a panicked kill cannot leave
/// the id refusing forever.
struct StopGuard<'a, T> {
    map: &'a Mutex<HashMap<String, Slot<T>>>,
    id: &'a str,
    armed: bool,
}

impl<T> Drop for StopGuard<'_, T> {
    fn drop(&mut self) {
        if self.armed {
            let mut m = self.map.lock().unwrap_or_else(|e| e.into_inner());
            if matches!(m.get(self.id), Some(Slot::Stopping)) {
                m.remove(self.id);
            }
        }
    }
}

/// Swap `id`'s entry for `Stopping`, release the lock, THEN run `f` on it.
/// Ok: the slot is removed and the entry drops after the lock is released.
/// Err: the entry goes back, so a retry (second adopt, body switch) runs the
/// kill again instead of resuming beside a live tree. A concurrent call while
/// `f` runs gets Err(STOPPING). Ok(()) when there was no entry.
pub(crate) fn take_or_restore<T>(
    map: &Mutex<HashMap<String, Slot<T>>>,
    id: &str,
    f: impl FnOnce(&mut T) -> Result<(), String>,
) -> Result<(), String> {
    let mut entry = {
        let mut m = map.lock().unwrap_or_else(|e| e.into_inner());
        match m.get_mut(id) {
            None => return Ok(()),
            Some(Slot::Stopping) => return Err(STOPPING.into()),
            Some(slot) => match std::mem::replace(slot, Slot::Stopping) {
                Slot::Live(t) => t,
                Slot::Stopping => unreachable!("matched Live above"),
            },
        }
    };
    let mut guard = StopGuard { map, id, armed: true };
    let result = f(&mut entry);
    guard.armed = false;
    let dropped = {
        let mut m = map.lock().unwrap_or_else(|e| e.into_inner());
        if !matches!(m.get(id), Some(Slot::Stopping)) {
            Some(entry) // nothing else writes a Stopping slot; defensive only
        } else if result.is_err() {
            m.insert(id.to_string(), Slot::Live(entry));
            None
        } else {
            m.remove(id);
            Some(entry)
        }
    };
    drop(dropped); // handles close outside the lock
    result
}

/// Run taskkill with `args`, bounded. Output goes to null and only the exit
/// code is read: a piped stderr read after exit could deadlock on a full pipe
/// and surface as a false timeout. Exit 128 ("not found" / "no running
/// instance") is success: the process is already gone, which is the goal.
fn run_taskkill(args: &[String], timeout: Duration) -> Result<(), String> {
    let mut child = Command::new("taskkill")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("taskkill failed to start: {e}"))?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("taskkill: no answer after {} ms", timeout.as_millis()));
            }
            Ok(None) => thread::sleep(POLL),
            Err(e) => return Err(format!("taskkill: {e}")),
        }
    };
    taskkill_outcome(status.code())
}

fn taskkill_outcome(code: Option<i32>) -> Result<(), String> {
    match code {
        Some(0) | Some(128) => Ok(()),
        other => Err(format!("taskkill exit {other:?}")),
    }
}

/// `taskkill /F /T /PID <pid>`, bounded. An absent process is success.
pub(crate) fn taskkill_tree(pid: u32, timeout: Duration) -> Result<(), String> {
    run_taskkill(&["/F".into(), "/T".into(), "/PID".into(), pid.to_string()], timeout)
}

/// The descendant identities and whether any process `is_spare` accepts
/// (with its whole subtree) was excluded. With no spared process the caller
/// can use a plain /T kill. A row counts as a child only if it was
/// created no earlier than its parent (`created`, FILETIME): a live process
/// whose parent pid is stale, now reused by the shell, is not its child.
/// Unknown creation times exclude the row. Bounded and cycle-safe like
/// procs::descendant_named.
fn tree_plan(
    map: &HashMap<u32, ProcRow>,
    root: u32,
    created: impl Fn(u32) -> Option<u64>,
    is_spare: impl Fn(u32, &ProcRow) -> bool,
) -> (Vec<ProcessIdentity>, bool) {
    let mut times: HashMap<u32, Option<u64>> = HashMap::new();
    let mut created_at = |pid: u32| *times.entry(pid).or_insert_with(|| created(pid));
    let mut kill = Vec::new();
    let mut spared = false;
    let mut frontier = vec![root];
    let mut seen = HashSet::from([root]);
    while let Some(cur) = frontier.pop() {
        if seen.len() > 512 {
            break;
        }
        for (pid, row) in map {
            if row.parent != cur || *pid == cur || seen.contains(pid) {
                continue;
            }
            let child_t = match (created_at(cur), created_at(*pid)) {
                (Some(parent_t), Some(child_t)) if child_t >= parent_t => child_t,
                _ => continue, // stale parent pid, or not ours to verify
            };
            seen.insert(*pid);
            if is_spare(*pid, row) {
                spared = true; // neither killed nor walked into
            } else {
                kill.push(ProcessIdentity { pid: *pid, created: child_t });
                frontier.push(*pid);
            }
        }
    }
    (kill, spared)
}

#[cfg(test)]
fn tree_sparing(
    map: &HashMap<u32, ProcRow>,
    root: u32,
    created: impl Fn(u32) -> Option<u64>,
    is_spare: impl Fn(u32, &ProcRow) -> bool,
) -> Option<Vec<u32>> {
    let (kill, spared) = tree_plan(map, root, created, is_spare);
    spared.then(|| kill.into_iter().map(|p| p.pid).collect())
}

/// Is `image` (a full Win32 image path) a falcon.exe from Vidar's own bundle
/// store (`<bundles>\<bundle_id>\falcon.exe`, falcon/host_launch.rs)? Case-
/// and separator-insensitive.
pub(crate) fn is_bundle_falcon(image: &str, bundles_dir: &str) -> bool {
    let norm = |s: &str| s.replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase();
    let (image, dir) = (norm(image), norm(bundles_dir));
    let Some(rest) = image.strip_prefix(&dir).and_then(|r| r.strip_prefix('\\')) else {
        return false;
    };
    matches!(rest.split_once('\\'), Some((bundle, "falcon.exe")) if !bundle.is_empty())
}

/// Kill everything under and including `pid`, except a Falcon host Vidar
/// launched from its bundle store: `/T` would take falcon.exe and every
/// session it hosts. A falcon.exe from anywhere else is not spared. With no
/// such host below, one `taskkill /F /T`; with one, the other descendants by
/// pid (no /T) and then the root. A process spawned between the snapshot and
/// the kill escapes that second path. An empty or failed snapshot (the root
/// not in it) is retried once, then refused before killing anything: /T could
/// reach a host it cannot see. Recorded identities are verified after killing.
pub(crate) fn kill_tree_sparing_falcon(pid: u32, timeout: Duration) -> Result<(), String> {
    let mut retry = KillRetry::default();
    // Adopt keeps the shell on a snapshot failure: killing it alone would
    // orphan Claude and leave the session unadoptable.
    let result = kill_tree_recording(pid, timeout, &mut retry, Intent::Resume, crate::procs::snapshot);
    // Even a failed taskkill can have killed Claude while leaving siblings.
    // Refuse with their PIDs rather than treating Claude's exit as tree exit.
    adopt_outcome(result, &retry, |r| verify_retry(r, Instant::now() + REAP_TIMEOUT))
}

fn tree_snapshot(
    pid: u32,
    mut snapshot: impl FnMut() -> HashMap<u32, ProcRow>,
) -> Result<HashMap<u32, ProcRow>, String> {
    for _ in 0..2 {
        let procs = snapshot();
        if procs.contains_key(&pid) {
            return Ok(procs);
        }
    }
    Err(TREE_UNVERIFIED.into())
}

/// After an unusable snapshot, Close terminates the root by PID plus recorded
/// identity (`terminate_if_same`; no /T, so no unseen Falcon host is reached;
/// the owned-handle kill follows in `terminate_steps`) and returns Ok so teardown finishes;
/// Resume kills nothing and refuses, so a retry can take a fresh snapshot of
/// the live shell. `snapshot` is procs::snapshot outside tests.
fn kill_tree_recording(
    pid: u32,
    timeout: Duration,
    retry: &mut KillRetry,
    intent: Intent,
    snapshot: impl FnMut() -> HashMap<u32, ProcRow>,
) -> Result<(), String> {
    let root = if let Some(root) = retry.root {
        // A partial kill can leave recorded descendants outside the root's /T
        // reach (orphaned, or the root already gone): kill each one whose
        // identity still matches. terminate_retry verifies them, bounded.
        for p in &retry.descendants {
            terminate_if_same(*p);
        }
        let seen = observe(root.pid);
        if retained_root_step(retry, root, seen, intent)? {
            return Ok(());
        }
        if !same_identity(root, seen) {
            return Err(SHELL_UNVERIFIED.into());
        }
        root
    } else {
        let root = match observe(pid) {
            ProcessObservation::Present(created) => ProcessIdentity { pid, created },
            ProcessObservation::Gone => return Ok(()),
            ProcessObservation::Unknown => return Err(SHELL_UNVERIFIED.into()),
        };
        // Retain the identity even on snapshot failure. A later shell exit or
        // PID reuse must not turn that failure into a verified kill of an
        // unknown tree. Only a first attempt starts unrecorded: on retry the
        // flag is sticky.
        retry.root = Some(root);
        retry.tree_recorded = false;
        root
    };
    let procs = match tree_snapshot(pid, snapshot) {
        Ok(procs) => procs,
        Err(e) => {
            if intent == Intent::Close {
                terminate_if_same(root);
            }
            return close_outcome(intent, e);
        }
    };
    let bundles = crate::falcon::FalconPaths::new(crate::paths::root()).bundles_dir();
    let bundles = bundles.to_string_lossy();
    let spare = |p: u32, row: &ProcRow| {
        row.exe == "falcon.exe"
            && crate::procs::image_path(p).is_some_and(|img| is_bundle_falcon(&img, &bundles))
    };
    let (others, spared) = tree_plan(&procs, pid, crate::procs::creation_time, spare);
    for identity in &others {
        if !retry.descendants.contains(identity) {
            retry.descendants.push(*identity);
        }
    }
    retry.tree_recorded = true;
    retry.spared = spared;
    if !spared {
        return taskkill_tree(pid, timeout);
    }
    let mut args = vec!["/F".to_string()];
    for p in others.iter().map(|p| p.pid).chain(std::iter::once(pid)) {
        args.push("/PID".into());
        args.push(p.to_string());
    }
    run_taskkill(&args, timeout)
}

/// Tree first, while the root still exists so taskkill can enumerate its
/// descendants (a killed root orphans them to a new parent), then the root,
/// then a bounded reap. Resume preserves a failed tree kill before touching
/// the root; Close continues by handle and makes one bounded cleanup attempt
/// on recorded identities. Call terminate_retry with retained state for Resume
/// retries. Snapshot races remain above.
/// `terminate` serves a child no slot holds (nothing resumes): Close.
pub(crate) fn terminate<C: Child + ?Sized>(child: &mut C, timeout: Duration) -> Result<(), String> {
    terminate_retry(child, timeout, &mut KillRetry::default(), Intent::Close)
}

pub(crate) fn terminate_retry<C: Child + ?Sized>(
    child: &mut C,
    timeout: Duration,
    retry: &mut KillRetry,
    intent: Intent,
) -> Result<(), String> {
    terminate_with(child, timeout, retry, intent, crate::procs::snapshot)
}

fn terminate_with<C: Child + ?Sized>(
    child: &mut C,
    timeout: Duration,
    retry: &mut KillRetry,
    intent: Intent,
    snapshot: impl FnMut() -> HashMap<u32, ProcRow>,
) -> Result<(), String> {
    terminate_steps(
        child, retry, intent, REAP_TIMEOUT,
        |child, retry| {
            if let Some(pid) = retry.root.map(|p| p.pid).or_else(|| child.process_id()) {
                kill_tree_recording(pid, timeout, retry, intent, snapshot)
            } else {
                Ok(())
            }
        },
        verify_retry,
        terminate_if_same,
    )
}

/// The same teardown ordering with injected OS operations and a short deadline
/// in tests. The Close failure tests exercise this path without taskkill races.
fn terminate_steps<C: Child + ?Sized>(
    child: &mut C,
    retry: &mut KillRetry,
    intent: Intent,
    reap_timeout: Duration,
    tree: impl FnOnce(&mut C, &mut KillRetry) -> Result<(), String>,
    mut verify: impl FnMut(&KillRetry, Instant) -> Result<(), String>,
    mut terminate_recorded: impl FnMut(ProcessIdentity),
) -> Result<(), String> {
    let mut problems = Vec::new();
    if let Err(e) = tree(child, retry) {
        if intent == Intent::Resume {
            return Err(e);
        }
        problems.push(e);
    }
    if let Err(e) = child.kill() {
        if intent == Intent::Close {
            problems.push(format!("kill: {e}"));
        }
    }
    let deadline = Instant::now() + reap_timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                problems.push(format!("shell still running {} ms after kill", reap_timeout.as_millis()));
                break;
            }
            Ok(None) => thread::sleep(POLL),
            Err(e) => {
                problems.push(format!("wait: {e}"));
                break;
            }
        }
    }
    if problems.is_empty() || intent == Intent::Close {
        if let Err(e) = verify(retry, deadline) {
            problems.push(e);
            if intent == Intent::Close {
                // Each identity is checked on the termination handle. Gone or
                // reused PIDs are ignored; unknown identities are never killed.
                for identity in retry.recorded() {
                    terminate_recorded(identity);
                }
                if let Err(e) = verify(retry, Instant::now() + reap_timeout) {
                    problems.push(format!("after recorded cleanup: {e}"));
                }
            }
        }
    }
    if problems.is_empty() {
        *retry = KillRetry::default();
        Ok(())
    } else {
        close_outcome(intent, problems.join("; "))
    }
}

#[cfg(test)]
#[path = "kill/tests.rs"]
mod tests;
