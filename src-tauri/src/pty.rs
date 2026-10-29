use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agent_spec::Agent;

/// 16 OS-random bytes as lowercase hex: the `VIDAR_CTL_TOKEN` a PTY tab
/// presents to the control surface (control/policy.rs).
fn mint_ctl_token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| format!("ctl token: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub struct PtySession {
    /// Feeds the tab's writer thread (spawn_writer); dropping the session ends it.
    input: Sender<Vec<u8>>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// Which spawn this entry is: the reader's exit only cleans up after its own.
    gen: u64,
    /// The frontend's attachment tag (spawn_pty's ptyGen), carried as `gen` in
    /// pty-output/pty-exit so events need no spawn reply to be matched.
    pty_gen: u64,
    flow: Arc<flow::Flow>,
    /// Tree identities from a failed kill, so a retry verifies the same tree.
    kill_retry: kill::KillRetry,
    /// Set by this spawn's reader when it hits EOF, before its exit block;
    /// taken (under spawn_lock) by whoever emits pty-exit for it: the reader,
    /// or stop_tab after a failed kill restored the slot. Per session, so a
    /// replacement under the same id starts clear.
    exit_pending: Arc<AtomicBool>,
}

static NEXT_GEN: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Slot<PtySession>>>,
    // Field report from another portable-pty embedder: concurrent ConPTY spawns
    // can leave a pty with a stalled output pipe. One pty in v0.1, but the
    // serialization is free and v1 will multi-spawn.
    spawn_lock: Mutex<()>,
}

#[derive(Clone, Serialize)]
struct PtyOutput {
    id: String,
    gen: u64,
    data: String, // base64 so split multibyte sequences survive the JSON hop
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: String,
    gen: u64,
}

fn reader_exit_is_current<T>(
    slot: Option<&Slot<T>>,
    gen: u64,
    generation: impl FnOnce(&T) -> u64,
) -> bool {
    match slot {
        None => true,
        Some(Slot::Live(s)) => generation(s) == gen,
        Some(Slot::Stopping) => false,
    }
}

/// After a failed kill restored `slot`: does its reader's exit still owe a
/// pty-exit? Takes the flag, so the reader and stop_tab never both emit.
fn failed_stop_owes_exit<T>(slot: Option<&Slot<T>>, pending: impl FnOnce(&T) -> &AtomicBool) -> bool {
    match slot {
        Some(Slot::Live(s)) => pending(s).swap(false, Ordering::SeqCst),
        _ => false,
    }
}

fn size(rows: u16, cols: u16) -> PtySize {
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

// Child processes inherit Vidar's environment, and Vidar may itself have been
// launched FROM an agent's tool shell (tools\release\swap-release.ps1 run by a Claude
// or Codex session). Those shells mark themselves so tool output comes back
// plain: Claude exports NO_COLOR=1 plus its child-session markers; Codex's
// exec sandbox sets TERM=dumb and a blank COLORTERM (a
// Claude resumed from a Codex-launched Vidar came up in an all-white tab, because
// the child inherits its caller's env and only NO_COLOR was scrubbed).
//
// A terminal emulator's sessions must look like a fresh top-level shell, not
// like children of whatever happened to start the app. Scrubbed, not overridden:
// removing these restores normal detection rather than forcing colour on — a
// real Windows Terminal tab has neither TERM nor COLORTERM set, and chalk's
// detector picks truecolor on win32 once TERM=dumb is out of the way.
// Shared with agent.rs (the sidecar spawn). Codex's own markers (CODEX_CI,
// CODEX_SESSION_ID, CODEX_SANDBOX_*) also ride through; left alone until what a
// resumed codex does with them is known. VIDAR_ROOT is scrubbed like VIDAR_CTL_TOKEN:
// spawn_pty sets its own after the scrub, and nothing else should inherit a stale one
// (an adopted shell, the sidecar, the Falcon host, a Vidar started from a Vidar tab).
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS carries the DevTools port (swap-release -Debug); a Vidar
// started from a tab must not inherit it, since the port hands spawn_pty to any local process.
pub const SCRUBBED_ENV: &[&str] = &[
    "NO_COLOR",
    "TERM",
    "COLORTERM",
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_PID",
    "VIDAR_CTL_TOKEN",
    "VIDAR_CTL_SECRET",
    "VIDAR_ROOT",
    // The tab name rides beside VIDAR_TAB (set per spawn below); never inherited from a parent tab.
    "VIDAR_TAB_NAME",
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    // A Vidar started from a Falcon-hosted session carries that session's id;
    // a raw tab, the sidecar or a new Falcon host must not claim it.
    "FALCON_SESSION",
];

/// A tab name as `VIDAR_TAB_NAME`: trimmed, capped at 128 chars, and left out entirely when blank
/// or holding a control character (cosmetic, so it never fails a spawn). Same rule as
/// `src-falcon/src/claude.rs`; the PTY and Codex spawns both use this one.
pub fn clean_tab_name(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|n| !n.is_empty() && !n.chars().any(char::is_control))
        .map(|n| n.chars().take(128).collect())
}

/// The folder a PTY starts in: the explicit cwd when it is an existing folder, else `fallback`
/// (vidar.json defaultCwd / home). None → the child inherits Vidar's cwd. A missing explicit
/// folder must not reach portable-pty: it swaps in USERPROFILE on its own (cmdbuilder.rs
/// `current_directory`), which put Astra Code's Codex in `~` on 2026-10-10.
fn spawn_dir(cwd: Option<String>, fallback: impl FnOnce() -> Option<PathBuf>) -> Option<PathBuf> {
    cwd.map(PathBuf::from).filter(|p| p.is_dir()).or_else(fallback)
}

/// A profiled PTY spawn's prepared launch: Raw Claude (a pwsh line) or Raw Codex (the TUI under
/// node). Holds the home lock until dropped, after the spawn.
enum BareSpawn {
    /// A pwsh line (Raw Claude).
    Line(crate::bare::Launch),
    /// The TUI under node (Raw Codex).
    Tui(crate::bare::CodexLaunch),
}

impl BareSpawn {
    fn program(&self) -> &Path {
        match self {
            BareSpawn::Line(l) => &l.program,
            BareSpawn::Tui(l) => &l.program,
        }
    }
    fn args(&self) -> &[String] {
        match self {
            BareSpawn::Line(l) => &l.args,
            BareSpawn::Tui(l) => &l.args,
        }
    }
    fn env(&self) -> &crate::bare::Env {
        match self {
            BareSpawn::Line(l) => &l.env,
            BareSpawn::Tui(l) => &l.env,
        }
    }
    fn write_manifest<'a>(&mut self, tab: &str, env_names: impl IntoIterator<Item = &'a str>) -> Result<PathBuf, String> {
        match self {
            BareSpawn::Line(l) => l.write_manifest(tab, env_names),
            BareSpawn::Tui(l) => l.write_manifest(tab, env_names),
        }
    }
    /// The TUI launch warning as a yellow terminal line; a pwsh line's rides the line instead.
    fn banner(&self) -> Option<String> {
        match self {
            BareSpawn::Line(_) => None,
            BareSpawn::Tui(l) => l.warning.as_ref().map(|w| codex_banner(w)),
        }
    }
}

fn codex_banner(warning: &str) -> String {
    format!("\x1b[33m[Vidar Bare: {warning}]\x1b[0m\r\n")
}

/// A Raw Codex Bare tab's folder, refused before `prepare` runs on it: `dir` (else Vidar's own
/// cwd, which the child would inherit) must not be the user profile or a parent of it, by the
/// resolved home (`refuse_home_cwd`) and by `USERPROFILE` (`refuse_profile_cwd`). The prepare
/// writes this same folder into config.toml as the trusted project, and the PTY starts in it.
pub(crate) fn codex_bare_prepare<T>(dir: Option<PathBuf>, prepare: impl FnOnce(&str) -> Result<T, String>) -> Result<(PathBuf, T), String> {
    let dir = dir
        .or_else(|| std::env::current_dir().ok())
        .ok_or("Bare Codex refused: no launch folder; pick a project folder")?;
    crate::codex_cwd::refuse_home_cwd(&dir)?;
    let cwd = dir.to_string_lossy().into_owned();
    crate::bare::refuse_profile_cwd(&cwd, std::env::var("USERPROFILE").ok().as_deref())?;
    let launch = prepare(&cwd)?;
    Ok((dir, launch))
}

/// A profiled spawn's profile and agent: the agent parses once, and a profiled spawn naming an
/// agent Vidar does not know (or none) refuses (a spawn with no profile is no Bare spawn, whatever
/// it names).
fn bare_target<'a>(profile: Option<&'a str>, agent: Option<&str>) -> Result<Option<(&'a str, Agent)>, String> {
    let Some(profile) = profile else { return Ok(None) };
    match agent.and_then(crate::agent_spec::parse) {
        Some(a) => Ok(Some((profile, a))),
        None => Err(format!("The {profile:?} profile is for Raw Claude and Raw Codex rows only (agent {agent:?}); spawn refused")),
    }
}

/// Serializes Raw and Codex app-server Bare spawns in-process: two prepares on one home would
/// otherwise overlap and the second wait on `.vidar-lock` up to 5 s, then refuse. Takers: the Raw
/// spawn here, `agent.rs` (Codex app-server), `codex_models.rs`, and the Falcon-hosted prepares
/// (`falcon/session_commands.rs`, Claude and Codex Bare). Nothing under `bare::` takes it, so a
/// taker must not call another. Lock order: this, then `spawn_lock`.
pub(crate) static BARE_PREPARE: Mutex<()> = Mutex::new(());

/// Runs off the main thread (a Bare prepare reads versions and waits on a home lock), so a
/// slow spawn does not queue every later write, resize and kill behind it.
#[tauri::command]
pub async fn spawn_pty(
    app: AppHandle,
    id: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    cwd: Option<String>,
    args: Option<Vec<String>>,
    tab_name: Option<String>,
    pty_gen: u64,
    profile: Option<String>,
    agent: Option<String>,
    row_key: Option<String>,
    sets: Option<Vec<crate::bare::LaunchSetRef>>,
    vault: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        spawn_pty_blocking(&app, id, cols, rows, shell, cwd, args, tab_name, pty_gen, profile, agent, row_key, sets, vault)
    })
    .await
    .map_err(|e| format!("spawn task failed: {e}"))?
}

#[allow(clippy::too_many_arguments)]
fn spawn_pty_blocking(
    app: &AppHandle,
    id: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    cwd: Option<String>,
    args: Option<Vec<String>>,
    tab_name: Option<String>,
    pty_gen: u64,
    profile: Option<String>,
    agent: Option<String>,
    row_key: Option<String>,
    sets: Option<Vec<crate::bare::LaunchSetRef>>,
    vault: Option<String>,
) -> Result<(), String> {
    let state = app.state::<PtyManager>();
    let vault = vault.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    if vault.is_some() && profile.is_none() {
        return Err("A Rune Vault rides only a Bare spawn; spawn refused".into());
    }
    // Held for the whole body when the spawn is profiled (see BARE_PREPARE).
    let _bare_prepare = profile
        .is_some()
        .then(|| BARE_PREPARE.lock().unwrap_or_else(|e| e.into_inner()));
    // A launch profile (bare/): refused before any home is prepared when unknown, on a row that
    // is neither Claude nor Codex, on a vendor row, or carrying its own shell/args. No profile is the default spawn, unchanged.
    // A row key only names a profiled row (its rune sets, bare/layer.rs); a blank one is none.
    let row_key = crate::bare::row_key_of(row_key);
    if row_key.is_some() && profile.is_none() {
        return Err("A row key rides only a profiled spawn; spawn refused".into());
    }
    if let Some(p) = profile.as_deref() {
        crate::bare::admit(p, agent.as_deref(), shell.as_deref(), args.as_deref())?;
    }
    let target = bare_target(profile.as_deref(), agent.as_deref())?;
    // A Codex Bare key must name a Codex Bare row (as the Rendered spawn checks it, agent.rs).
    let row_key = match target {
        None => row_key,
        Some((p, agent)) => match agent {
            Agent::Codex => crate::bare::admit_row_key(row_key, Some(p), None)?,
            Agent::Claude => row_key,
        },
    };
    // The folder first: a Codex Bare prepare writes it into config.toml as the trusted project,
    // so the home-folder refusals run on this same folder before that write.
    let mut dir = spawn_dir(cwd, crate::config::default_cwd);
    // Home, settings and spawn line for a profiled tab; any failure refuses, never a default launch.
    // Before spawn_lock: the version read and the home lock wait must not stall every other spawn
    // and the PTY reader threads' exit path, which take that lock too.
    // A named vault is the whole loadout (model R2); the transition pick is read only without one.
    // Raw locks at spawn (`bare::vault_spawn::lock_at_spawn`).
    let custom_sets = if vault.is_some() { None } else { sets.as_deref() };
    let opts = crate::bare::LaunchOpts { row_key: row_key.as_deref(), custom_sets, vault: vault.as_deref(), ..Default::default() };
    let mut bare = match target {
        None => None,
        Some((p, agent)) => Some(match agent {
            Agent::Codex => {
                let (d, launch) = codex_bare_prepare(dir.take(), |cwd| crate::bare::prepare_codex_tui(p, &opts, cwd))?;
                dir = Some(d);
                BareSpawn::Tui(launch)
            }
            Agent::Claude => BareSpawn::Line(crate::bare::prepare(p, &opts)?),
        }),
    };

    let _guard = state.spawn_lock.lock().unwrap_or_else(|e| e.into_inner());
    // Held under spawn_lock until the insert below, so two calls cannot both pass.
    kill::admit(&state.sessions.lock().unwrap_or_else(|e| e.into_inner()), &id)?;
    crate::codex_cwd::refuse_home_pty(shell.as_deref(), args.as_deref(), dir.as_deref())?;

    let pair = native_pty_system()
        .openpty(size(rows, cols))
        .map_err(|e| e.to_string())?;

    let mut cmd = match &bare {
        None => {
            let mut cmd = CommandBuilder::new(shell.unwrap_or_else(|| "pwsh.exe".into()));
            if let Some(args) = args {
                cmd.args(args);
            }
            cmd
        }
        Some(launch) => {
            let mut cmd = CommandBuilder::new(launch.program());
            cmd.args(launch.args());
            cmd
        }
    };
    if let Some(dir) = dir {
        cmd.cwd(dir);
    }
    match &bare {
        // Scrub first: the list includes TERM/COLORTERM, which are set below.
        None => {
            for k in SCRUBBED_ENV {
                cmd.env_remove(k);
            }
        }
        // Built, never subtracted (bare/env.rs): the tab variables below are added on top.
        Some(launch) => {
            cmd.env_clear();
            for (k, v) in launch.env().iter() {
                cmd.env(k, v);
            }
        }
    }
    // portable-pty won't inherit Windows Terminal's env (no WT_SESSION for the
    // win32 fallback); Node color detection (Ink/chalk) keys off these.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Rides through to Claude's statusline script, which writes a per-tab copy
    // of its payload to bridge\sessions\<tab>.json — see status.rs.
    cmd.env("VIDAR_TAB", &id);
    // The tab's name at spawn, so the agent can say who it is; a later rename is not reflected.
    if let Some(name) = clean_tab_name(tab_name.as_deref()) {
        cmd.env("VIDAR_TAB_NAME", name);
    }
    // The Vidar folder, for launcher rows that call a Vidar script from args
    // (`& "$env:VIDAR_ROOT/tools/vendor/vendor-tab.ps1"`); args are never token-expanded.
    cmd.env("VIDAR_ROOT", crate::paths::root());
    // The control surface's requester secret (control/policy.rs): VIDAR_TAB is
    // a name any process can claim, this is 16 OS-random bytes only this tree
    // was given. Registered before spawn so a first-command call can resolve.
    let token = mint_ctl_token()?;
    cmd.env("VIDAR_CTL_TOKEN", &token);
    // The launch record (create-new) names the final env, tab variables included; no record, no spawn.
    if let Some(launch) = bare.as_mut() {
        let names: Vec<String> = cmd.iter_full_env_as_str().map(|(k, _)| k.to_string()).collect();
        launch.write_manifest(&id, names.iter().map(String::as_str))?;
    }
    let policy = app.state::<crate::control::policy::PolicyState>();
    crate::control::policy::register(&policy, token, id.clone());

    // Any failure from here on unregisters the token: a tab that never got a
    // pty must not leave a live requester secret behind.
    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            crate::control::policy::unregister(&policy, &id);
            return Err(e.to_string());
        }
    };
    drop(pair.slave);

    let pipes = pair
        .master
        .try_clone_reader()
        .and_then(|r| pair.master.take_writer().map(|w| (r, w)));
    let (mut reader, writer) = match pipes {
        Ok(p) => p,
        Err(e) => {
            // No slot holds this child. Close-intent terminate always returns Ok
            // (failures are logged and the owned handle is killed inside), so no
            // fallback kill is needed.
            let _ = kill::terminate(&mut *child, kill::KILL_TIMEOUT);
            crate::control::policy::unregister(&policy, &id);
            return Err(e.to_string());
        }
    };

    let gen = NEXT_GEN.fetch_add(1, Ordering::Relaxed);
    let flow = Arc::new(flow::Flow::default());
    let ev_flow = Arc::clone(&flow);
    let ev_app = app.clone();
    let ev_id = id.clone();
    let exit_pending = Arc::new(AtomicBool::new(false));
    let ev_pending = Arc::clone(&exit_pending);
    // A Raw Codex Bare tab has no pwsh host to print its version or shell warning: it rides as the
    // tab's first output chunk, ahead of anything the child writes.
    let banner = bare.as_ref().and_then(BareSpawn::banner);
    thread::spawn(move || {
        if let Some(text) = banner {
            let _ = ev_app.emit("pty-output", PtyOutput { id: ev_id.clone(), gen: pty_gen, data: B64.encode(text.as_bytes()) });
        }
        let mut buf = [0u8; 8192];
        loop {
            if ev_flow.wait_ready(flow::PAUSE_CEILING) {
                // The frontend gate is still paused: let it re-pause at high water.
                let _ = ev_app.emit(FLOW_RESUMED, ev_id.clone());
            }
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = ev_app.emit(
                        "pty-output",
                        PtyOutput { id: ev_id.clone(), gen: pty_gen, data: B64.encode(&buf[..n]) },
                    );
                }
            }
        }
        // Seen by stop_tab if this exit lands while a kill holds the slot and fails.
        ev_pending.store(true, Ordering::SeqCst);
        // Natural exit: the token dies with the tree, not at tab close. Under
        // spawn_lock so a respawn under the same id (Rendered -> Raw) is either
        // fully in the map, and skipped here, or not yet registered. A Stopping
        // slot is left to the kill, which cleans up only if it succeeds. Emit
        // under the same lock so a replacement cannot precede the exit emission;
        // delivery of an already queued event still needs frontend generation matching.
        let mgr = ev_app.state::<PtyManager>();
        {
            let _spawn = mgr.spawn_lock.lock().unwrap_or_else(|e| e.into_inner());
            let ours = reader_exit_is_current(
                mgr.sessions.lock().unwrap_or_else(|e| e.into_inner()).get(&ev_id),
                gen,
                |s| s.gen,
            );
            if ours {
                crate::control::policy::unregister(
                    &ev_app.state::<crate::control::policy::PolicyState>(),
                    &ev_id,
                );
                crate::status::forget_tab(&ev_id);
                if ev_pending.swap(false, Ordering::SeqCst) {
                    let _ = ev_app.emit("pty-exit", PtyExit { id: ev_id.clone(), gen: pty_gen });
                }
            }
        }
    });

    let (input, _) = spawn_writer(writer);
    state
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, Slot::Live(PtySession {
            input,
            master: pair.master,
            child,
            gen,
            pty_gen,
            flow,
            kill_retry: kill::KillRetry::default(),
            exit_pending,
        }));
    Ok(())
}

/// Emitted (payload: tab id) when Rust ends a pause the frontend did not ask
/// to end, by input or the pause ceiling; the gate drops its paused state
/// (sessions/flow-gate.ts `resumed`) so it can pause again at high water.
const FLOW_RESUMED: &str = "pty-flow-resumed";

/// Output backpressure from the frontend's watermarks (pty/flow.rs). An absent
/// tab is not an error: the call races tab close.
#[tauri::command]
pub fn pty_flow(state: State<PtyManager>, id: String, paused: bool) -> Result<(), String> {
    if let Some(s) = state.sessions.lock().unwrap_or_else(|e| e.into_inner()).get(&id).and_then(Slot::live) {
        s.flow.set_paused(paused);
    }
    Ok(())
}

/// Input unpauses the reader first: a paused reader stalls conhost, which
/// stops draining input, and a write would wait with nothing left to resume
/// it. The bytes go to the tab's writer thread, never written here: this runs
/// on the UI thread, and a blocked write froze the window.
#[tauri::command]
pub fn write_pty(app: AppHandle, state: State<PtyManager>, id: String, data: String) -> Result<(), String> {
    if send_input(&state.sessions, &id, data.into_bytes(), |s| (&*s.flow, &s.input))? {
        let _ = app.emit(FLOW_RESUMED, id);
    }
    Ok(())
}

/// write_pty's body: unpause the tab's reader and queue the bytes, under the
/// map lock (a send never blocks, and one lock keeps concurrent calls in
/// order). True when a pause was ended. Generic for the test.
fn send_input<T>(
    map: &Mutex<HashMap<String, Slot<T>>>,
    id: &str,
    data: Vec<u8>,
    parts: impl Fn(&T) -> (&flow::Flow, &Sender<Vec<u8>>),
) -> Result<bool, String> {
    let sessions = map.lock().unwrap_or_else(|e| e.into_inner());
    let (flow, input) = parts(sessions.get(id).and_then(Slot::live).ok_or("no such pty")?);
    let resumed = flow.set_paused(false);
    input.send(data).map_err(|_| "pty input closed")?;
    Ok(resumed)
}

/// One writer thread per tab, fed in order from the returned sender. It ends
/// when every sender is dropped (the session left the map) or a write fails
/// (the pty closed); later sends then fail with "pty input closed".
fn spawn_writer<W: Write + Send + 'static>(mut w: W) -> (Sender<Vec<u8>>, thread::JoinHandle<()>) {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let h = thread::spawn(move || {
        while let Ok(buf) = rx.recv() {
            if w.write_all(&buf).is_err() {
                break;
            }
        }
    });
    (tx, h)
}

/// Is a process with this exact exe basename (lowercase, e.g. "codex.exe")
/// running somewhere under the tab's shell? The review bridge asks this right
/// before typing into a tab: a name on the tab is a claim, the process tree is
/// the fact. Err when the tab has no pty or its shell has already gone.
#[tauri::command]
pub fn pty_has_descendant(state: State<PtyManager>, id: String, exe: String) -> Result<bool, String> {
    let shell_pid = {
        let sessions = state.sessions.lock().unwrap();
        let s = sessions.get(&id).and_then(Slot::live).ok_or("no such pty")?;
        s.child.process_id().ok_or("shell has no pid (exited?)")?
    };
    let map = crate::procs::snapshot();
    Ok(crate::procs::descendant_named(&map, shell_pid, &exe.to_ascii_lowercase()).is_some())
}

#[tauri::command]
pub fn resize_pty(
    state: State<PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    let s = sessions.get(&id).and_then(Slot::live).ok_or("no such pty")?;
    s.master.resize(size(rows, cols)).map_err(|e| e.to_string())
}

/// Kill the tree and reap the root, bounded (pty/kill.rs), then close the
/// flow so a paused reader cannot hold ClosePseudoConsole when the handles
/// drop. Runs with the slot marked Stopping (kill::take_or_restore puts the
/// entry back on Err, flow still open); on success the session's handles drop
/// after this returns, outside any lock.
fn end_session(s: &mut PtySession, intent: kill::Intent) -> Result<(), String> {
    kill::terminate_retry(&mut *s.child, kill::KILL_TIMEOUT, &mut s.kill_retry, intent)?;
    s.flow.close();
    Ok(())
}

/// kill_pty's teardown. The control token and per-tab
/// status go only once the kill succeeded: a restored entry keeps both.
/// A failed kill whose shell already hit EOF still marks the tab dead: the
/// reader skipped its pty-exit while the slot was Stopping. `intent`: Close
/// for a closed tab, Resume when an agent resumes on success (kill.rs).
fn stop_tab(app: &AppHandle, id: &str, intent: kill::Intent) -> Result<(), String> {
    let mgr = app.state::<PtyManager>();
    if let Err(e) = kill::take_or_restore(&mgr.sessions, id, |s| end_session(s, intent)) {
        let _spawn = mgr.spawn_lock.lock().unwrap_or_else(|e| e.into_inner());
        let owed_gen = {
            let sessions = mgr.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let slot = sessions.get(id);
            if failed_stop_owes_exit(slot, |s| &*s.exit_pending) {
                slot.and_then(Slot::live).map(|s| s.pty_gen)
            } else {
                None
            }
        };
        if let Some(gen) = owed_gen {
            let _ = app.emit("pty-exit", PtyExit { id: id.to_string(), gen });
        }
        return Err(e);
    }
    crate::control::policy::unregister(&app.state::<crate::control::policy::PolicyState>(), id);
    crate::status::forget_tab(id);
    Ok(())
}

/// Kill the TREE and wait for it, the same way kill_pty does: a body
/// switch (Raw → Rendered) resumes the same agent session the moment this
/// returns, and two live processes on one session id interleave their
/// transcripts. Errors are reported, not swallowed: a body switch must not
/// resume into a tree that is still running. Async on the blocking pool: a
/// plain command runs on the UI thread, and taskkill + wait froze the window.
/// `close`: true only from a tab close (nothing resumes); absent or false is
/// Resume, the fail-closed default for the body switch.
#[tauri::command]
pub async fn kill_pty(app: AppHandle, id: String, close: Option<bool>) -> Result<(), String> {
    let intent = if close == Some(true) { kill::Intent::Close } else { kill::Intent::Resume };
    tauri::async_runtime::spawn_blocking(move || stop_tab(&app, &id, intent))
        .await
        .map_err(|e| format!("kill task failed: {e}"))?
}

// Adopt an external Claude session into a tab: the handover command (pty/handover.rs).
mod handover;
pub use self::handover::*;
// Teardown helpers (bounded taskkill, Stopping slot) and output backpressure.
mod flow;
mod kill;
use self::kill::Slot;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::Receiver;
    use std::time::{Duration, Instant};

    #[test]
    fn bare_agent_is_parsed_and_an_unknown_one_refused() {
        assert_eq!(bare_target(Some("bare"), Some("codex")), Ok(Some(("bare", Agent::Codex))));
        assert_eq!(bare_target(Some("bare"), Some("claude")), Ok(Some(("bare", Agent::Claude))));
        assert_eq!(bare_target(None, Some("grok")), Ok(None));
        assert!(bare_target(Some("bare"), Some("grok")).is_err());
        assert!(bare_target(Some("bare"), None).is_err());
    }

    #[test]
    fn event_payloads_carry_the_frontend_attachment_tag() {
        // `gen` on the wire is the ptyGen spawn_pty was given, not NEXT_GEN.
        let pty_gen = 42_u64;
        let output = serde_json::to_value(PtyOutput {
            id: "s1".into(), gen: pty_gen, data: B64.encode(b"hello"),
        }).unwrap();
        let exit = serde_json::to_value(PtyExit { id: "s1".into(), gen: pty_gen }).unwrap();
        assert_eq!(output, serde_json::json!({ "id": "s1", "gen": 42, "data": "aGVsbG8=" }));
        assert_eq!(exit, serde_json::json!({ "id": "s1", "gen": 42 }));
    }

    #[test]
    fn a_missing_explicit_cwd_takes_the_vidar_fallback_not_portable_ptys_home() {
        let real = std::env::temp_dir();
        let missing = real.join("vidar-spawn-dir-test-does-not-exist");
        let fallback = PathBuf::from(r"Q:\fallback");
        let fb = || Some(fallback.clone());
        let s = |p: &PathBuf| Some(p.to_string_lossy().into_owned());
        assert_eq!(spawn_dir(s(&real), fb), Some(real.clone()));
        assert_eq!(spawn_dir(s(&missing), fb), Some(fallback.clone()));
        assert_eq!(spawn_dir(None, fb), Some(fallback.clone()));
        assert_eq!(spawn_dir(s(&missing), || None), None);
    }

    #[test]
    fn obsolete_reader_cannot_emit_exit() {
        let replacement = Slot::Live(2_u64);
        assert!(!reader_exit_is_current(Some(&replacement), 1, |gen| *gen));
        assert!(!reader_exit_is_current(Some(&Slot::<u64>::Stopping), 1, |gen| *gen));
        assert!(reader_exit_is_current(Some(&replacement), 2, |gen| *gen));
        assert!(reader_exit_is_current::<u64>(None, 1, |gen| *gen));
    }

    #[test]
    fn a_failed_kill_after_reader_eof_owes_one_exit() {
        let done = Slot::Live(AtomicBool::new(true));
        assert!(failed_stop_owes_exit(Some(&done), |f| f));
        assert!(!failed_stop_owes_exit(Some(&done), |f| f), "exit emitted twice");
        // Reader still running, or a replacement session with its own fresh flag.
        assert!(!failed_stop_owes_exit(Some(&Slot::Live(AtomicBool::new(false))), |f| f));
        assert!(!failed_stop_owes_exit(Some(&Slot::<AtomicBool>::Stopping), |f| f));
        assert!(!failed_stop_owes_exit::<AtomicBool>(None, |f| f));
    }

    struct Tab {
        flow: Arc<flow::Flow>,
        input: Sender<Vec<u8>>,
    }

    /// A writer that records every write and can be held shut to simulate a
    /// pty that stops draining input.
    struct Gate {
        out: Arc<Mutex<Vec<u8>>>,
        open: Receiver<()>,
        blocked: bool,
    }
    impl Write for Gate {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.blocked {
                let _ = self.open.recv();
                self.blocked = false;
            }
            self.out.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_tab_name_is_trimmed_capped_and_dropped_when_unusable() {
        assert_eq!(clean_tab_name(Some("  Amber Raptor ")).as_deref(), Some("Amber Raptor"));
        assert_eq!(clean_tab_name(Some(&"x".repeat(200))).map(|n| n.chars().count()), Some(128));
        for bad in ["", "   ", "a\nb", "a\u{1b}[31mb", "a\0b"] {
            assert_eq!(clean_tab_name(Some(bad)), None, "{bad:?}");
        }
        assert_eq!(clean_tab_name(None), None);
    }

    #[test]
    fn input_unpauses_the_reader_and_never_waits_on_the_write() {
        let flow = Arc::new(flow::Flow::default());
        flow.set_paused(true);
        let out = Arc::new(Mutex::new(Vec::new()));
        let (open_tx, open) = mpsc::channel();
        let (input, writer) = spawn_writer(Gate { out: Arc::clone(&out), open, blocked: true });
        let map = Mutex::new(HashMap::from([("s1-ab".to_string(), Slot::Live(Tab { flow: Arc::clone(&flow), input }))]));

        let reader = Arc::clone(&flow);
        let h = thread::spawn(move || {
            let t = Instant::now();
            reader.wait_ready(Duration::from_secs(20));
            t.elapsed()
        });
        thread::sleep(Duration::from_millis(100));

        // The first write blocks in the writer thread; every send still returns at once.
        let t = Instant::now();
        assert!(send_input(&map, "s1-ab", b"first".to_vec(), |t| (&*t.flow, &t.input)).unwrap(), "pause end not reported");
        for i in 0..200 {
            assert!(!send_input(&map, "s1-ab", format!(",{i}").into_bytes(), |t| (&*t.flow, &t.input)).unwrap());
        }
        assert!(t.elapsed() < Duration::from_secs(2), "send waited on a blocked write");
        let waited = h.join().unwrap();
        assert!(waited < Duration::from_secs(5), "paused reader not woken by input");
        let _held = map.try_lock().expect("tab-map lock held after the send");
        drop(_held);

        // Unblock, end the session: the thread drains in keystroke order and exits.
        open_tx.send(()).unwrap();
        map.lock().unwrap().clear();
        writer.join().unwrap();
        let expected: String = std::iter::once("first".to_string()).chain((0..200).map(|i| format!(",{i}"))).collect();
        assert_eq!(String::from_utf8(out.lock().unwrap().clone()).unwrap(), expected);
    }

    #[test]
    fn input_to_a_missing_stopping_or_closed_tab_errs() {
        let empty = Mutex::new(HashMap::<String, Slot<Tab>>::new());
        assert!(send_input(&empty, "x", vec![1], |t| (&*t.flow, &t.input)).is_err());
        let stopping = Mutex::new(HashMap::from([("x".to_string(), Slot::<Tab>::Stopping)]));
        assert!(send_input(&stopping, "x", vec![1], |t| (&*t.flow, &t.input)).is_err());
        // A writer whose pty closed ends its thread; later input reports it.
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (input, writer) = spawn_writer(Broken);
        let map = Mutex::new(HashMap::from([("x".to_string(), Slot::Live(Tab { flow: Arc::default(), input }))]));
        assert!(send_input(&map, "x", vec![1], |t| (&*t.flow, &t.input)).is_ok());
        writer.join().unwrap();
        assert_eq!(send_input(&map, "x", vec![2], |t| (&*t.flow, &t.input)).unwrap_err(), "pty input closed");
    }
}

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
