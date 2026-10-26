//! Stdio child-process manager for Rendered sessions: spawns the `codex
//! app-server` JSON-lines process, forwards its stdout line by line as
//! `agent-event`, writes stdin on request, and owns the process TREE's
//! lifetime through a Windows Job Object with kill-on-close — so Vidar's
//! forced exit 500 ms after close (main.rs) takes node, codex.exe and any
//! tool they started with it. Claude Rendered tabs are hosted by Falcon and
//! never spawned here (see src-falcon and falcon.rs).
//!
//! Ownership: every spawn gets a process-wide generation; events carry it and
//! `agent_send`/`kill_agent` refuse a mismatch, so a late line from an old
//! process can never reach — or kill — a tab that has since been re-spawned
//! under the same id. Protocol interpretation and permission policy live in
//! the frontend adapter, never here.
//!
//! Follows pty.rs's patterns with one change: `kill_agent` is async (a 5 s graceful wait must not block
//! IPC dispatch). The spawn-then-assign window (a child could fork before
//! AssignProcessToJobObject) is accepted and documented: assignment follows
//! CreateProcess by microseconds and node needs tens of milliseconds before
//! it spawns codex. Hardening, if ever needed: CREATE_SUSPENDED + resume
//! after assignment. The job wrapper itself lives in proc_job.rs.
//!
//! A bare Codex tab (launch profile, bare/) differs only in what is spawned and with which env:
//! `node <codex.js from the profile's resolver> app-server` under exactly the built env, its own
//! `CODEX_HOME` kept on the session for status.rs, and a `VIDAR_CTL_TOKEN` registered for it.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::proc_job::Job;

const LINE_CAP: usize = 8 * 1024 * 1024;
const LOG_CAP: u64 = 1024 * 1024;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const POLL: Duration = Duration::from_millis(20);
static NEXT_GEN: AtomicU64 = AtomicU64::new(1);
// Only log I/O is serialized, including overlapping generations of one tab.
static LOG_WRITE: Mutex<()> = Mutex::new(());

// pty.rs's list: Vidar may itself run inside an agent's tool shell, and the
// sidecar's CLI must not inherit that conversation's markers.
use crate::pty::SCRUBBED_ENV;
// The `agent-exit` envelope is defined in falcon.rs: the Falcon shell compiles
// that file but has no `agent` module, so the one shared type lives there.
use crate::falcon::AgentExit;

type Sessions = Arc<Mutex<HashMap<String, Arc<AgentProc>>>>;

#[derive(Default)]
pub struct AgentManager {
    sessions: Sessions,
}

impl AgentManager {
    /// The `CODEX_HOME` a live bare tab runs on (status.rs reads that tab's rollouts and config
    /// there); `None` for a default tab or an unknown id.
    pub fn codex_home(&self, id: &str) -> Option<PathBuf> {
        lock(&self.sessions).get(id).and_then(|p| p.codex_home.clone())
    }
}

struct AgentProc {
    gen: u64,
    /// A bare tab's own `CODEX_HOME` (bare/ profile); `None` = the default `~\.codex`.
    codex_home: Option<PathBuf>,
    /// A bare tab's `VIDAR_CTL_TOKEN`; the reader drops this token alone, never the tab's others.
    ctl_token: Option<String>,
    child: Mutex<Child>,
    // A pipe write may block. It must never hold the child or manager lock.
    stdin: Mutex<Option<ChildStdin>>,
    job: Mutex<Option<Job>>,
    stopping: AtomicBool,
    /// A bare tab's thread id capture for its session record (model R4).
    thread: Mutex<ThreadCapture>,
}

/// Which app-server reply names a bare tab's own thread: only the reply to a `thread/start` or
/// `thread/resume` this tab sent, matched by JSON-RPC id. A `thread/read` or `thread/list` reply also
/// carries `result.thread`, so a shape match alone could hand the record another thread's id.
#[derive(Default)]
struct ThreadCapture {
    pending: Vec<serde_json::Value>,
    known: bool,
}

impl ThreadCapture {
    /// An outgoing line: remembers the request id of a thread start or resume until the first reply.
    fn on_send(&mut self, line: &str) {
        if self.known || !(line.contains("thread/start") || line.contains("thread/resume")) {
            return;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return };
        if matches!(v.get("method").and_then(|m| m.as_str()), Some("thread/start" | "thread/resume")) {
            if let Some(id) = v.get("id").filter(|id| !id.is_null()) {
                self.pending.push(id.clone());
            }
        }
    }

    /// An app-server stdout line: the thread id when it is the reply to a pending start or resume.
    fn on_reply(&mut self, line: &[u8]) -> Option<String> {
        if self.known || self.pending.is_empty() {
            return None;
        }
        let v = serde_json::from_slice::<serde_json::Value>(line).ok()?;
        let at = self.pending.iter().position(|id| v.get("id") == Some(id))?;
        self.pending.remove(at);
        let thread = v.pointer("/result/thread/id").and_then(|t| t.as_str()).filter(|t| !t.is_empty())?;
        self.known = true;
        self.pending.clear();
        Some(thread.to_string())
    }
}

// Poison must not disable best-effort process cleanup.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl AgentProc {
    fn terminate_tree(&self) {
        if let Some(job) = lock(&self.job).take() {
            job.terminate();
            drop(job); // kill-on-close also covers a failed explicit termination
        }
    }

    /// Graceful first: close stdin (EOF ends the sidecar's prompt stream and
    /// cancels its pending permission prompts), wait up to 5 s, then the job.
    fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            // Do not let a child that stopped reading stdin prevent forced kill.
            match self.stdin.try_lock() {
                Ok(mut stdin) => {
                    stdin.take();
                }
                Err(TryLockError::Poisoned(e)) => {
                    e.into_inner().take();
                }
                Err(TryLockError::WouldBlock) => {}
            }
            match lock(&self.child).try_wait() {
                Ok(Some(_)) | Err(_) => break,
                Ok(None) => {}
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            thread::sleep(POLL.min(remaining));
        }
        // Even a gracefully exited root may have surviving descendants.
        self.terminate_tree();
        let mut child = lock(&self.child);
        if !matches!(child.try_wait(), Ok(Some(_))) {
            let _ = child.kill();
        }
        let _ = child.wait(); // no grace wait here: termination has been requested
    }
}

impl Drop for AgentProc {
    fn drop(&mut self) {
        self.terminate_tree();
        let mut child = lock(&self.child);
        if !matches!(child.try_wait(), Ok(Some(_))) {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

#[derive(Clone, Serialize)]
#[serde(untagged)]
enum AgentEvent {
    Line { id: String, gen: u64, line: String },
    Dropped { id: String, gen: u64, dropped: u64 },
}

fn get_proc(state: &AgentManager, id: &str, gen: u64) -> Result<Arc<AgentProc>, String> {
    let sessions = lock(&state.sessions);
    let proc = sessions.get(id).ok_or("no such agent")?;
    if proc.gen != gen {
        return Err("stale generation".into());
    }
    Ok(Arc::clone(proc))
}

fn remove_own(sessions: &Sessions, id: &str, gen: u64) {
    let mut sessions = lock(sessions);
    if sessions.get(id).is_some_and(|p| p.gen == gen) {
        sessions.remove(id);
    }
}

fn valid_tab_id(id: &str) -> bool {
    // The tab id becomes a filename. Keep it a leaf, including on Windows.
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Where the installed Codex lives: the `codex` shim on PATH is a .ps1 that
/// runs `node <npm>\node_modules\@openai\codex\bin\codex.js`; that script then
/// starts the native binary. Spawning node on the script directly avoids the
/// shell and keeps the whole tree inside the Job Object.
///
/// `%APPDATA%\npm` is tried first; any other npm prefix (nvm-windows, a custom
/// prefix) is found beside its shim on the process `Path`, as Bare's D7 resolver does.
pub(crate) fn codex_js() -> Result<PathBuf, String> {
    let bin = codex_binary_block();
    codex_js_from(
        std::env::var_os("APPDATA").as_deref(),
        std::env::var_os("Path").as_deref(),
        bin.as_ref(),
    )
}

/// The `binary` block of `profiles/bare/codex.json` (shims, script, package); None when unreadable.
fn codex_binary_block() -> Option<crate::bare::CodexBinary> {
    let path = crate::paths::root().join("profiles").join("bare").join("codex.json");
    let v: serde_json::Value = crate::fsx::read_json(&path).ok()?;
    serde_json::from_value(v.get("binary")?.clone()).ok()
}

/// Pure core of `codex_js`: the values come in, so tests inject them.
fn codex_js_from(
    appdata: Option<&std::ffi::OsStr>,
    path: Option<&std::ffi::OsStr>,
    bin: Option<&crate::bare::CodexBinary>,
) -> Result<PathBuf, String> {
    let appdata_js = appdata.map(|a| {
        PathBuf::from(a)
            .join("npm")
            .join("node_modules")
            .join("@openai")
            .join("codex")
            .join("bin")
            .join("codex.js")
    });
    if let Some(p) = appdata_js.as_ref().filter(|p| p.is_file()) {
        return Ok(p.clone());
    }
    if let (Some(path), Some(bin)) = (path, bin) {
        let mut env = crate::bare::Env::default();
        env.set("Path", path);
        if let Some((js, _)) = crate::bare::resolve_codex(&env, bin) {
            return Ok(js);
        }
    }
    let at = appdata_js.map_or_else(|| "%APPDATA%\\npm (APPDATA not set)".to_string(), |p| p.display().to_string());
    Err(format!("codex.js not found at {at} or beside a codex.ps1 or codex.cmd shim on the Path"))
}

/// The control surface's requester secret for a bare tab (same shape as pty.rs: 16 OS-random bytes).
fn mint_ctl_token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| format!("ctl token: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// How the child's env is made: the default tab subtracts `SCRUBBED_ENV` from Vidar's env; a bare
/// tab gets exactly the built env (bare/env.rs) plus the tab variables, never Vidar's own.
enum BaseEnv {
    Scrubbed,
    Exact(crate::bare::Env),
}

/// The `spawn_codex_appserver` reply: the process generation, and the built rune payload's text for a
/// Bare row that has one (None otherwise; the default spawn never has one).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSpawned {
    gen: u64,
    developer_instructions: Option<String>,
    /// A Bare launch's notice-area warnings (the untrusted-folder one rides `codex_trust_offer`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    bare_warnings: Vec<String>,
}

/// Spawn `codex app-server` for a tab. No mode flags: approval policy and
/// sandbox are thread/turn parameters, chosen by the frontend adapter from
/// the same allowlist (`default | acceptEdits | plan`), never `never`.
/// `profile` ("bare", the Codex Rendered Bare row, `agent` = "codex"): the binary, env, home,
/// generated config.toml and manifest come from `profiles/bare/codex.json` (bare/); any failure
/// refuses the spawn, never a default launch. No profile is the default spawn, unchanged.
/// `row_key` (the launcher's `rowKey`) must name a Codex Bare row (`bare::admit_row_key`); its
/// rune sets and the copied Bare skills come back as `developerInstructions` in the reply, which the
/// webview adapter sends on `thread/start` (no length cap; the Raw TUI line uses a `--profile`
/// file, `bare::home::write_codex_profile`).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn spawn_codex_appserver(
    app: AppHandle,
    id: String,
    cwd: String,
    rules_file: Option<String>,
    tab_name: Option<String>,
    profile: Option<String>,
    agent: Option<String>,
    row_key: Option<String>,
    sets: Option<Vec<crate::bare::LaunchSetRef>>,
    vault: Option<String>,
) -> Result<CodexSpawned, String> {
    // Off the main thread: a Bare prepare reads versions and waits on a home lock.
    tauri::async_runtime::spawn_blocking(move || {
        spawn_codex_appserver_blocking(app, id, cwd, rules_file, tab_name, profile, agent, row_key, sets, vault)
    })
    .await
    .map_err(|e| format!("spawn task failed: {e}"))?
}

#[allow(clippy::too_many_arguments)]
fn spawn_codex_appserver_blocking(
    app: AppHandle,
    id: String,
    cwd: String,
    rules_file: Option<String>,
    tab_name: Option<String>,
    profile: Option<String>,
    agent: Option<String>,
    row_key: Option<String>,
    sets: Option<Vec<crate::bare::LaunchSetRef>>,
    vault: Option<String>,
) -> Result<CodexSpawned, String> {
    let state = app.state::<AgentManager>();
    let vault = vault.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    if vault.is_some() && profile.is_none() {
        return Err("A Rune Vault rides only a Bare spawn; spawn refused".into());
    }
    if !Path::new(&cwd).is_dir() {
        return Err(format!("cwd is not a directory: {cwd}"));
    }
    crate::codex_cwd::refuse_home_cwd(Path::new(&cwd))?;
    // A row key names a Codex Bare row (its rune sets, bare/layer.rs); a blank one is none.
    let row_key = crate::bare::admit_row_key(row_key, profile.as_deref(), None)?;
    let mut env = vec![("VIDAR_TAB".to_string(), id.clone())];
    if let Some(name) = crate::pty::clean_tab_name(tab_name.as_deref()) {
        env.push(("VIDAR_TAB_NAME".to_string(), name));
    }
    let Some(profile) = profile else {
        let js = codex_js()?;
        let mut args = vec![js.to_string_lossy().into_owned(), "app-server".into()];
        // Re-validated here (canonical, under the built dir, `<hash12>.md`): the webview's path is not trusted.
        if let Some(file) = rules_file.filter(|f| !f.trim().is_empty()) {
            args.extend(crate::rules::codex::appserver_args(&file).map_err(|e| format!("Rules file refused: {e}"))?);
        }
        let gen = spawn_agent(app.clone(), &state, id, "node".into(), args, cwd, env, BaseEnv::Scrubbed, None, None, None)?;
        return Ok(CodexSpawned { gen, developer_instructions: None, bare_warnings: Vec::new() });
    };
    if !valid_tab_id(&id) {
        return Err("invalid tab id".into());
    }
    crate::bare::admit_rendered(&profile, agent.as_deref(), rules_file.as_deref())?;
    crate::bare::refuse_profile_cwd(&cwd, std::env::var("USERPROFILE").ok().as_deref())?;
    // A named vault is the whole loadout (model R2); the transition pick is read only without one.
    let custom_sets = if vault.is_some() { None } else { sets.as_deref() };
    let opts = crate::bare::LaunchOpts { row_key: row_key.as_deref(), custom_sets, vault: vault.as_deref(), ..Default::default() };
    // Bare spawns stay serialized in-process, held until the home lock drops with `launch`.
    let prepare_guard = crate::pty::BARE_PREPARE.lock().unwrap_or_else(|e| e.into_inner());
    let mut launch = crate::bare::prepare_codex(&profile, &opts, &cwd)?;
    let token = mint_ctl_token()?;
    env.push(("VIDAR_CTL_TOKEN".to_string(), token.clone()));
    // The record names the final env (built names plus the tab variables); no record, no spawn.
    let mut names: Vec<String> = launch.env.iter().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
    names.extend(env.iter().map(|(k, _)| k.clone()));
    let manifest = launch.write_manifest(&id, names.iter().map(String::as_str))?;
    // Written by the stderr drain once it has opened (and possibly truncated) the log.
    let banner = launch.warning.as_ref().map(|w| format!("[Vidar Bare: {w}]"));
    let policy = app.state::<crate::control::policy::PolicyState>();
    crate::control::policy::register(&policy, token.clone(), id.clone());
    let program = launch.program.to_string_lossy().into_owned();
    let bare_warnings = launch.bare_warnings();
    let untrusted_dir = launch.is_untrusted().then(|| cwd.clone());
    let result = spawn_agent(
        app.clone(),
        &state,
        id.clone(),
        program,
        launch.args.clone(),
        cwd,
        env,
        BaseEnv::Exact(launch.env.clone()),
        Some(launch.codex_home.clone()),
        Some(token.clone()),
        banner,
    );
    if result.is_err() {
        // Only this launch's token: a refused duplicate must not clear the live process's own.
        crate::control::policy::unregister_token(&policy, &token);
        let _ = fs::remove_file(&manifest); // no process, so no launch record
    }
    // The card's Trust Folder action reads this; a failed spawn leaves no tab to offer it to.
    crate::bare::codex_trust::register(&id, untrusted_dir.filter(|_| result.is_ok()));
    let developer_instructions = launch.developer_instructions.take();
    drop(launch); // releases the home lock
    drop(prepare_guard);
    result.map(|gen| CodexSpawned { gen, developer_instructions, bare_warnings })
}

// Not a `#[tauri::command]`: a private fn with two callers, both in `spawn_codex_appserver`
// above (default tab and bare tab); the webview never invokes it by name.
#[allow(clippy::too_many_arguments)]
fn spawn_agent(
    app: AppHandle,
    state: &AgentManager,
    id: String,
    program: String,
    args: Vec<String>,
    cwd: String,
    env: Vec<(String, String)>,
    base: BaseEnv,
    codex_home: Option<PathBuf>,
    ctl_token: Option<String>,
    banner: Option<String>,
) -> Result<u64, String> {
    if !valid_tab_id(&id) {
        return Err("invalid tab id".into());
    }

    // This is map ownership synchronization, not a ConPTY spawn mutex.
    // Keep the reservation until reader installation so duplicate calls cannot
    // start two writers to one conversation. Closing entries remain reserved.
    let mut sessions = lock(&state.sessions);
    if sessions.contains_key(&id) {
        return Err("agent already exists or is closing".into());
    }
    let gen = NEXT_GEN
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1))
        .map_err(|_| "agent generation exhausted".to_string())?;
    let job = Job::new()?;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match base {
        BaseEnv::Scrubbed => {
            for key in SCRUBBED_ENV {
                cmd.env_remove(key);
            }
        }
        BaseEnv::Exact(built) => {
            cmd.env_clear();
            for (key, value) in built.iter() {
                cmd.env(key, value);
            }
        }
    }
    for (key, value) in env {
        cmd.env(key, value);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    // Never return an unassigned child as a successful spawn (see module doc
    // for the accepted spawn-then-assign window).
    if let Err(error) = job.assign(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("assign agent job: {error}"));
    }
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let proc = Arc::new(AgentProc {
        gen,
        codex_home,
        ctl_token,
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        job: Mutex::new(Some(job)),
        stopping: AtomicBool::new(false),
        thread: Mutex::new(ThreadCapture::default()),
    });
    let stdout = stdout.ok_or("missing agent stdout")?;
    let stderr = stderr.ok_or("missing agent stderr")?;
    if lock(&proc.stdin).is_none() {
        return Err("missing agent stdin".into());
    }

    let log_id = id.clone();
    let stderr_thread = thread::Builder::new()
        .name(format!("agent-stderr-{gen}"))
        .spawn(move || drain_stderr(stderr, &log_id, banner.as_deref()))
        .map_err(|e| e.to_string())?;
    sessions.insert(id.clone(), Arc::clone(&proc));
    let reader_proc = Arc::clone(&proc);
    let reader_sessions = Arc::clone(&state.sessions);
    let reader_id = id.clone();
    let reader = thread::Builder::new()
        .name(format!("agent-stdout-{gen}"))
        .spawn(move || {
            // A bare tab's session record takes its thread id from the start/resume reply (R4).
            let mut on_line = |line: &[u8]| {
                if reader_proc.codex_home.is_none() {
                    return;
                }
                let Some(thread) = lock(&reader_proc.thread).on_reply(line) else { return };
                if let Err(error) = crate::bare::vault::session::append_thread_id(&crate::paths::root(), &reader_id, None, &thread) {
                    eprintln!("agent {reader_id}: session record thread id: {error}");
                }
            };
            let result = forward_stdout(stdout, &app, &reader_id, gen, &mut on_line);
            if let Err(error) = result {
                eprintln!("agent {reader_id}: stdout read failed: {error}");
                reader_proc.stop();
            }
            // Never hold the child lock across a blocking wait: kill_agent must
            // still be able to terminate a child that closes stdout but stays alive.
            let code = loop {
                let status = { lock(&reader_proc.child).try_wait() };
                match status {
                    Ok(Some(status)) => break status.code(),
                    Ok(None) => thread::sleep(POLL),
                    Err(error) => {
                        eprintln!("agent {reader_id}: reap failed: {error}");
                        reader_proc.stop();
                        break None;
                    }
                }
            };
            reader_proc.stopping.store(true, Ordering::SeqCst);
            reader_proc.terminate_tree();
            let _ = stderr_thread.join();
            remove_own(&reader_sessions, &reader_id, gen);
            // A bare tab's requester secret dies with its process; per token, so a newer
            // generation on the same id keeps its own.
            if let Some(token) = &reader_proc.ctl_token {
                crate::control::policy::unregister_token(&app.state::<crate::control::policy::PolicyState>(), token);
            }
            // Only this reader emits exit, including when kill_agent reaped first.
            let _ = app.emit(
                "agent-exit",
                AgentExit {
                    id: reader_id,
                    gen,
                    code: code.map(i64::from),
                },
            );
        });
    if let Err(error) = reader {
        sessions.remove(&id);
        drop(sessions);
        proc.terminate_tree();
        return Err(format!("start agent reader: {error}"));
    }
    Ok(gen)
}

/// The first-message lock (model R3), called by `agent_send` and `falcon_send` before a user turn is
/// delivered: the session record (`bare/vault/session.rs`, written at spawn or adopt) names the vault
/// and the hash the session loaded, and `Store::lock(id, FirstMessage, hash)` locks it there. A vault
/// already locked at that hash stands; another hash, or a vault gone, refuses the send. No record (a
/// default tab, a session from before vaults) delivers unlocked. `falcon_session`, when given, must
/// match the record, never a tab's older one. `memo` names one spawn (tab and generation or Falcon
/// session): after its first pass, later turns skip the store.
pub(crate) fn lock_first_send(tab: &str, falcon_session: Option<&str>, memo: &str) -> Result<(), String> {
    use std::collections::HashSet;
    use std::sync::OnceLock;
    static PASSED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let passed = PASSED.get_or_init(|| Mutex::new(HashSet::new()));
    if lock(passed).contains(memo) {
        return Ok(());
    }
    let root = crate::paths::root();
    let record = crate::bare::vault::session::find(&root, tab, falcon_session, None)?
        .filter(|r| falcon_session.is_none() || r.falcon_session.as_deref() == falcon_session);
    if let Some(r) = record {
        crate::bare::vault::store::Store::open(&root)
            .lock(&r.vault.id, crate::bare::vault::LockedBy::FirstMessage, &r.vault.hash)
            .map_err(|e| format!("Rune Vault lock refused ({e}); message not sent"))?;
    }
    lock(passed).insert(memo.to_string());
    Ok(())
}

/// A Codex app-server line that starts a turn (`turn/start`): the one the vault locks on.
fn starts_turn(line: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|v| v.get("method").and_then(|m| m.as_str()).map(|m| m == "turn/start"))
        .unwrap_or(false)
}

#[tauri::command]
pub fn agent_send(
    state: State<AgentManager>,
    id: String,
    gen: u64,
    line: String,
) -> Result<(), String> {
    let proc = get_proc(&state, &id, gen)?;
    // R3: a Bare tab's first turn locks its vault before the line reaches the agent (D-d: a refusal
    // keeps the composer's text). Outside the stdin lock: the store does file I/O.
    if proc.codex_home.is_some() && starts_turn(&line) {
        lock_first_send(&id, None, &format!("{id}\0{gen}"))?;
    }
    // Before the write, so the reply cannot beat the pending id.
    if proc.codex_home.is_some() {
        lock(&proc.thread).on_send(&line);
    }
    let mut stdin = lock(&proc.stdin);
    if proc.stopping.load(Ordering::SeqCst) {
        return Err("agent is stopping".into());
    }
    let writer = stdin.as_mut().ok_or("agent stdin closed")?;
    writer
        .write_all(line.as_bytes())
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(|e| e.to_string())
}

/// Async so the ≤ 5 s graceful wait runs on a blocking worker, not the IPC
/// dispatcher. Gen mismatch → Err and nothing is killed.
#[tauri::command]
pub async fn kill_agent(state: State<'_, AgentManager>, id: String, gen: u64) -> Result<(), String> {
    let proc = get_proc(&state, &id, gen)?;
    let sessions = Arc::clone(&state.sessions);
    tauri::async_runtime::spawn_blocking(move || {
        proc.stop();
        remove_own(&sessions, &id, gen);
        crate::bare::codex_trust::forget(&id);
    })
    .await
    .map_err(|e| e.to_string())
}

/// Stops every live in-process agent (same teardown as `kill_agent`). Run at relaunch,
/// before restore: a webview reload leaves app-servers alive that no tab owns any more.
/// Returns how many were stopped.
#[tauri::command]
pub async fn agent_reap_all(state: State<'_, AgentManager>) -> Result<u32, String> {
    let live: Vec<(String, Arc<AgentProc>)> = lock(&state.sessions)
        .iter()
        .map(|(id, p)| (id.clone(), Arc::clone(p)))
        .collect();
    let sessions = Arc::clone(&state.sessions);
    tauri::async_runtime::spawn_blocking(move || {
        let n = live.len() as u32;
        for (id, proc) in live {
            proc.stop();
            remove_own(&sessions, &id, proc.gen);
        }
        n
    })
    .await
    .map_err(|e| e.to_string())
}

// Chunk framing bounds allocation even for a producer that never emits LF.
// Size excludes LF, includes any CR; CRLF is normalized only for forwarded text.
/// `on_line` sees each in-cap line before it is forwarded.
fn forward_stdout(mut reader: impl Read, app: &AppHandle, id: &str, gen: u64, on_line: &mut dyn FnMut(&[u8])) -> io::Result<()> {
    let mut chunk = [0u8; 8192];
    let mut line = Vec::new();
    let mut bytes = 0u64;
    loop {
        let n = match reader.read(&mut chunk) {
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            other => other?,
        };
        if n == 0 {
            if bytes != 0 {
                if bytes <= LINE_CAP as u64 {
                    on_line(&line);
                }
                emit_line(app, id, gen, &mut line, bytes);
            }
            return Ok(());
        }
        for &byte in &chunk[..n] {
            if byte == b'\n' {
                if bytes <= LINE_CAP as u64 {
                    on_line(&line);
                }
                emit_line(app, id, gen, &mut line, bytes);
                bytes = 0;
            } else {
                bytes = bytes.saturating_add(1);
                if bytes <= LINE_CAP as u64 {
                    line.push(byte);
                } else {
                    line.clear();
                }
            }
        }
    }
}

/// A line over `LINE_CAP` becomes a `Dropped` marker carrying its byte count (the Rendered tab
/// shows it as a notice), never a silent skip; the stream carries on with the next line. The
/// Falcon host does the same through `EventBody::Overflow` (src-falcon process.rs).
fn line_event(id: &str, gen: u64, line: &mut Vec<u8>, bytes: u64) -> AgentEvent {
    if bytes > LINE_CAP as u64 {
        AgentEvent::Dropped {
            id: id.into(),
            gen,
            dropped: bytes,
        }
    } else {
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        AgentEvent::Line {
            id: id.into(),
            gen,
            line: String::from_utf8_lossy(line).into_owned(),
        }
    }
}

fn emit_line(app: &AppHandle, id: &str, gen: u64, line: &mut Vec<u8>, bytes: u64) {
    let _ = app.emit("agent-event", line_event(id, gen, line, bytes));
    line.clear();
}

/// `banner` (a bare launch's version warning) is written as the log's first new line, after the
/// open-time truncation, so a log over the cap cannot erase it.
fn drain_stderr(mut reader: impl Read, id: &str, banner: Option<&str>) {
    let open = || -> io::Result<_> {
        let _guard = lock(&LOG_WRITE);
        let log_dir = crate::paths::agent_log_dir();
        fs::create_dir_all(&log_dir)?;
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(log_dir.join(format!("agent-{id}.log")))?;
        let len = file.metadata()?.len();
        if len > LOG_CAP {
            file.set_len(0)?;
        }
        file.seek(SeekFrom::End(0))?;
        if let Some(text) = banner {
            writeln!(file, "{text}")?;
        }
        Ok(file)
    };
    let mut file = open()
        .map_err(|error| {
            eprintln!("agent {id}: stderr logging disabled: {error}");
        })
        .ok();
    let mut chunk = [0u8; 8192];
    loop {
        let n = match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let result = if let Some(file) = file.as_mut() {
            (|| -> io::Result<()> {
                let _guard = lock(&LOG_WRITE);
                // Recheck EOF because an old generation may still be draining
                // after kill removed its map entry and a new tab run started.
                let end = file.seek(SeekFrom::End(0))?;
                if end.saturating_add(n as u64) > LOG_CAP {
                    file.set_len(0)?;
                    file.seek(SeekFrom::Start(0))?;
                }
                file.write_all(&chunk[..n])
            })()
        } else {
            Ok(())
        };
        if let Err(error) = result {
            eprintln!("agent {id}: stderr logging disabled: {error}");
            file = None; // keep draining; report only the first logging failure
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_turn_start_locks_a_codex_vault() {
        assert!(starts_turn(r#"{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{}}"#));
        assert!(!starts_turn(r#"{"id":1,"method":"thread/start","params":{}}"#));
        assert!(!starts_turn(r#"{"id":2,"result":{}}"#));
        assert!(!starts_turn("not json"));
    }

    fn codex_bin() -> crate::bare::CodexBinary {
        crate::bare::CodexBinary {
            shims: vec!["codex.ps1".into(), "codex.cmd".into()],
            script: "node_modules/@openai/codex/bin/codex.js".into(),
            package: "node_modules/@openai/codex/package.json".into(),
        }
    }

    /// `<base>/<sub>` shaped like an npm global folder; `shim` None leaves the shim out.
    fn fake_prefix(base: &Path, sub: &str, shim: Option<&str>) -> PathBuf {
        let dir = base.join(sub);
        let bin = dir.join("node_modules").join("@openai").join("codex").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("codex.js"), "//js").unwrap();
        if let Some(s) = shim {
            std::fs::write(dir.join(s), "#shim").unwrap();
        }
        dir
    }

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vidar-codexjs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn codex_js_prefers_appdata_over_the_path_shim() {
        let t = scratch("appdata");
        let appdata = t.join("roaming");
        fake_prefix(&appdata, "npm", None);
        let other = fake_prefix(&t, "nvm", Some("codex.cmd"));
        let path = std::env::join_paths([&other]).unwrap();
        let got = codex_js_from(Some(appdata.as_os_str()), Some(&path), Some(&codex_bin())).unwrap();
        assert!(got.starts_with(&appdata), "{got:?}");
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn codex_js_falls_back_to_a_path_shim_folder_when_appdata_misses() {
        let t = scratch("path");
        let other = fake_prefix(&t, "nvm", Some("codex.cmd"));
        let path = std::env::join_paths([&t.join("empty"), &other]).unwrap();
        let got = codex_js_from(Some(t.join("roaming").as_os_str()), Some(&path), Some(&codex_bin())).unwrap();
        assert_eq!(got, other.join("node_modules").join("@openai").join("codex").join("bin").join("codex.js"));
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn codex_js_error_names_both_places() {
        let t = scratch("miss");
        let noshim = fake_prefix(&t, "noshim", None);
        let path = std::env::join_paths([&noshim]).unwrap();
        let appdata = t.join("roaming");
        let err = codex_js_from(Some(appdata.as_os_str()), Some(&path), Some(&codex_bin())).unwrap_err();
        assert!(err.starts_with("codex.js not found at "), "{err}");
        assert!(err.contains(&appdata.display().to_string()), "{err}");
        assert!(err.ends_with("or beside a codex.ps1 or codex.cmd shim on the Path"), "{err}");
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn only_the_reply_to_this_tabs_thread_start_or_resume_names_its_thread() {
        let mut c = ThreadCapture::default();
        // A reply with no pending request, and a thread/read reply, are not this tab's thread.
        assert_eq!(c.on_reply(br#"{"id":1,"result":{"thread":{"id":"t-early"}}}"#), None);
        c.on_send(r#"{"id":2,"method":"thread/read","params":{"threadId":"t-other"}}"#);
        assert_eq!(c.on_reply(br#"{"id":2,"result":{"thread":{"id":"t-other"}}}"#), None);
        c.on_send(r#"{"id":3,"method":"thread/start","params":{}}"#);
        assert_eq!(c.on_reply(br#"{"id":9,"result":{"thread":{"id":"t-wrong"}}}"#), None);
        assert_eq!(c.on_reply(b"{\"id\":3,\"result\":{\"thread\":{\"id\":\"t-own\"}}}\r").as_deref(), Some("t-own"));
        // Once known, a later start in the same process never replaces it.
        c.on_send(r#"{"id":4,"method":"thread/resume","params":{"threadId":"t-next"}}"#);
        assert_eq!(c.on_reply(br#"{"id":4,"result":{"thread":{"id":"t-next"}}}"#), None);
    }

    #[test]
    fn a_line_over_the_cap_becomes_a_dropped_marker_with_its_size() {
        let mut line = Vec::new();
        let over = LINE_CAP as u64 + 1;
        match line_event("t", 3, &mut line, over) {
            AgentEvent::Dropped { id, gen, dropped } => {
                assert_eq!((id.as_str(), gen, dropped), ("t", 3, over));
            }
            _ => panic!("an over-cap line must be marked, not forwarded"),
        }
    }

    #[test]
    fn a_line_at_the_cap_is_forwarded_and_its_cr_trimmed() {
        let mut line = b"{\"a\":1}\r".to_vec();
        let bytes = line.len() as u64;
        match line_event("t", 1, &mut line, bytes) {
            AgentEvent::Line { line, .. } => assert_eq!(line, "{\"a\":1}"),
            _ => panic!("an in-cap line must be forwarded"),
        }
    }
}
