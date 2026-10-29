//! Runner-agnostic child plumbing for FLOW nodes: the Job Object, `FlowChild`, event emission,
//! the close watchdog, cancel, reap and `start_node_process`. Anything specific to one runner
//! (the Claude sidecar protocol, its executables and env) lives in that runner's file and is
//! reached through `Runner` / `RunnerSpec`.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::bare::BareCodex;
use super::{claude, codex, codex_mcp};
use crate::bare::Env;
use super::{FlowNodeEventPayload, FlowPermissionPayload, FlowRunNodeStatus};

pub(super) const POLL: Duration = Duration::from_millis(20);
pub(super) const GRACE: Duration = Duration::from_secs(5);
/// §4.1: node output text is capped at 64 KiB, keeping the tail.
pub(super) const OUTPUT_CAP_BYTES: usize = 64 * 1024;

pub(super) type Sessions = Arc<Mutex<HashMap<String, Arc<FlowChild>>>>;

/// Which runner a node starts on, with that runner's spawn inputs.
pub(super) enum RunnerSpec {
    /// The sidecar script, the env it runs on (`None`: Vidar's env minus the scrub, as the
    /// transport tests use), the stage's sidecar args (the profile mapping on the node's vault
    /// home: `--flow --profile --root --home` and the vault's payload, plugins and MCP file) and
    /// the warnings from building them.
    Claude { sidecar: PathBuf, env: Option<Env>, args: Vec<String>, warnings: Vec<String> },
    /// The Codex npm entrypoint, run as `node <js> app-server`, the Codex home whose config
    /// the pre-spawn MCP check reads (`None`: no check), and the Bare spawn inputs (`None`:
    /// Vidar's env minus the scrub, as the transport tests use).
    Codex { js: PathBuf, home: Option<PathBuf>, bare: Option<BareCodex> },
}

/// The runner a live `FlowChild` was started on; picks the runner-specific protocol steps.
#[derive(Clone, Copy)]
pub(super) enum Runner {
    Claude,
    Codex,
}

// The Job Object (kill-on-close) lives in `crate::job`, shared with the rune generator.
pub(super) use crate::job::Job;

pub(super) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}
// ---------------------------------------------------------------------------
// One child per node per attempt (§4.3: "not a long-lived multi-turn conversation").
// ---------------------------------------------------------------------------

pub(super) struct FlowChild {
    pub(super) runner: Runner,
    pub(super) run_id: String,
    node_id: String,
    attempt: u32,
    pub(super) child: Mutex<Child>,
    // A pipe write may block; must never hold the child lock (agent.rs's pattern).
    pub(super) stdin: Mutex<Option<ChildStdin>>,
    job: Mutex<Option<Job>>,
    pub(super) pending: Mutex<HashSet<String>>,
    pub(super) result_seen: AtomicBool,
    pub(super) canceled: AtomicBool,
    pub(super) is_error: Mutex<Option<bool>>,
    pub(super) cost_usd: Mutex<Option<f64>>,
    pub(super) final_text: Mutex<Option<String>>,
    stderr_tail: Mutex<String>,
    // A non-fatal `{type:sidecar,subtype:error}` line (Codex: an `error` notification or a
    // refused request) never flips status mid-run; it is held here and folded into the
    // terminal event's error only if the run actually ends in Error.
    pub(super) sidecar_error: Mutex<Option<String>>,
    // The `result` message's own failure reason (subtype +
    // first `errors[]` entry), kept separate from the stderr tail so reap()
    // appends rather than replaces.
    pub(super) result_error_reason: Mutex<Option<String>>,
    // The latest cumulative assistant text, updated on every line
    // (not gated by the throttle) so a crash with no `result` still has
    // something better than nothing for reap()'s final text.
    pub(super) live_text: Mutex<String>,
    // Codex only: JSON-RPC ids, thread/turn ids and the open server requests (empty for Claude).
    pub(super) rpc: Mutex<codex::Rpc>,
    // Run warnings from the spawn inputs (user MCP servers left out of a node); Flow has
    // no warning event, so they join the node's error if it fails.
    warnings: Vec<String>,
    // Captured once at spawn time (from the real AppHandle in production, from a
    // channel in the transport test) so flow_answer_permission — frozen with no
    // AppHandle parameter, §2 — can still emit "running again" when its node's
    // pending set empties.
    emit: Box<dyn Fn(FlowNodeEventPayload) + Send + Sync>,
}

pub(super) fn emit_event(
    child: &FlowChild,
    status: FlowRunNodeStatus,
    text: Option<String>,
    cost_usd: Option<f64>,
    error: Option<String>,
    permission: Option<FlowPermissionPayload>,
) {
    emit_event_with_file(child, status, text, cost_usd, error, permission, None);
}

fn emit_event_with_file(
    child: &FlowChild,
    status: FlowRunNodeStatus,
    text: Option<String>,
    cost_usd: Option<f64>,
    error: Option<String>,
    permission: Option<FlowPermissionPayload>,
    output_file: Option<String>,
) {
    (child.emit)(FlowNodeEventPayload {
        run_id: child.run_id.clone(),
        node_id: child.node_id.clone(),
        attempt: child.attempt,
        status,
        text,
        cost_usd,
        error,
        permission,
        output_file,
    });
}
fn write_line(stdin: &mut ChildStdin, value: &Value) -> std::io::Result<()> {
    stdin.write_all(value.to_string().as_bytes())?;
    stdin.write_all(b"\n")?;
    stdin.flush()
}

pub(super) fn send_raw(child: &FlowChild, value: &Value) {
    if let Ok(mut guard) = child.stdin.lock() {
        if let Some(stdin) = guard.as_mut() {
            let _ = write_line(stdin, value);
        }
    }
}

/// Like `send_raw`, but surfaces the write failure instead of swallowing it —
/// used only for the initial prompt line, where a failure means the spawn
/// itself should be reported as an error rather than silently going nowhere.
fn send_raw_checked(child: &FlowChild, value: &Value) -> std::io::Result<()> {
    let mut guard = child
        .stdin
        .lock()
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "stdin lock poisoned"))?;
    match guard.as_mut() {
        Some(stdin) => write_line(stdin, value),
        None => Err(std::io::Error::new(std::io::ErrorKind::Other, "stdin already closed")),
    }
}
/// Keeps the tail, never splits a UTF-8 character; the `[truncated]…` prefix names
/// what happened rather than silently shortening (§4.1).
pub(super) fn cap_text(s: &str, cap: usize) -> String {
    if s.len() <= cap {
        return s.to_string();
    }
    let mut start = s.len() - cap;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("[truncated]…{}", &s[start..])
}
/// §4.3 step 5: once a `result` has arrived and no permission is pending for the
/// node, close the child's stdin — that EOF ends the sidecar's own prompt stream.
/// Closing stdin also arms a watchdog: if the child has not exited by itself
/// within `GRACE`, the watchdog hard-kills it through the Job Object, which
/// unblocks the stdout reader (EOF) and lets `reap` proceed. Takes `Arc<FlowChild>`
/// (not `&FlowChild`) so the watchdog thread can outlive this call.
pub(super) fn maybe_close_stdin(child: &Arc<FlowChild>) {
    let pending_empty = child.pending.lock().map(|p| p.is_empty()).unwrap_or(true);
    if child.result_seen.load(Ordering::SeqCst) && pending_empty {
        let closed_now = {
            let mut guard = lock(&child.stdin);
            guard.take().is_some()
        };
        if closed_now {
            spawn_close_watchdog(child);
        }
    }
}

/// §4.3 step 5: waits up to `GRACE` for the child to exit on its own after stdin
/// closed, then hard-kills it via the Job Object. Runs on its own thread so
/// `maybe_close_stdin`'s callers (the stdout reader, `flow_answer_permission`)
/// never block on it. Idempotent alongside `cancel_child`/`reap`'s own
/// `terminate_job` calls: `job` is a `Mutex<Option<Job>>`, so whichever caller
/// takes it first wins and the others no-op.
fn spawn_close_watchdog(child: &Arc<FlowChild>) {
    let watchdog = Arc::clone(child);
    let name = format!("flow-close-watchdog-{}:{}", watchdog.run_id, watchdog.node_id);
    let spawned = thread::Builder::new().name(name).spawn(move || {
        let deadline = Instant::now() + GRACE;
        loop {
            match lock(&watchdog.child).try_wait() {
                // The root process exiting on
                // its own does not guarantee every descendant it spawned has too — one still
                // holding an inherited copy of the sidecar's stdout/stderr write handle keeps
                // `forward_stdout`'s reader thread blocked on that pipe's EOF forever, and `reap`'s
                // own `terminate_job` safety net only runs *after* that thread joins. Kill the Job
                // Object here too, on the root-exited path, not only after a full GRACE timeout —
                // `terminate_job` is idempotent (guarded by `job`'s `Mutex<Option<Job>>`), so this
                // never races `reap`'s or `cancel_child`'s own call.
                Ok(Some(_)) | Err(_) => break,
                Ok(None) => {}
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            thread::sleep(POLL.min(remaining));
        }
        terminate_job(&watchdog);
        let mut c = lock(&watchdog.child);
        if !matches!(c.try_wait(), Ok(Some(_))) {
            let _ = c.kill();
        }
    });
    // A failure to spawn the watchdog thread is not fatal to the run (the reaper
    // still reaps whenever the child does eventually exit); it just loses the
    // 5s hard-kill guarantee for this one attempt.
    let _ = spawned;
}
/// Drains stderr on its own thread into an 8 KiB tail — an undrained stderr pipe
/// can block the child (§4.3 step 4).
fn drain_stderr_tail(mut stderr: impl Read, child: &FlowChild) {
    let mut buf = [0u8; 4096];
    let mut tail: Vec<u8> = Vec::new();
    loop {
        match stderr.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                tail.extend_from_slice(&buf[..n]);
                if tail.len() > 8192 {
                    let drop_n = tail.len() - 8192;
                    tail.drain(0..drop_n);
                }
            }
        }
    }
    if let Ok(mut guard) = child.stderr_tail.lock() {
        *guard = String::from_utf8_lossy(&tail).into_owned();
    }
}

/// Terminate-tree helper shared by cancel and the reaper's safety net.
fn terminate_job(child: &FlowChild) {
    if let Some(job) = child.job.lock().ok().and_then(|mut g| g.take()) {
        job.terminate();
        drop(job);
    }
}

/// Ends a child that cannot do its job (not a user cancel): records `message` as the error
/// reap() reports, then kills the process tree. `canceled` stays false, so the node ends Error.
pub(super) fn fail_child(child: &FlowChild, message: String) {
    if let Ok(mut g) = child.sidecar_error.lock() {
        *g = Some(message);
    }
    if let Ok(mut guard) = child.stdin.lock() {
        guard.take();
    }
    terminate_job(child);
    let mut c = lock(&child.child);
    if !matches!(c.try_wait(), Ok(Some(_))) {
        let _ = c.kill();
    }
}

/// §4.3 step 6, frozen sequence, shared by `flow_cancel_node` and `flow_cancel_run`:
/// (a) write `{"type":"interrupt"}`, (b) close stdin, (c) wait up to 5s, (d) hard-kill
/// via the Job Object. Idempotent: a child already exited just falls through the wait.
pub(super) fn cancel_child(child: &FlowChild) {
    child.canceled.store(true, Ordering::SeqCst);
    match child.runner {
        Runner::Claude => claude::send_interrupt(child),
        Runner::Codex => codex::send_interrupt(child),
    }
    if let Ok(mut guard) = child.stdin.lock() {
        guard.take();
    }
    let deadline = Instant::now() + GRACE;
    loop {
        match lock(&child.child).try_wait() {
            Ok(Some(_)) | Err(_) => break,
            Ok(None) => {}
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        thread::sleep(POLL.min(remaining));
    }
    terminate_job(child);
    let mut c = lock(&child.child);
    if !matches!(c.try_wait(), Ok(Some(_))) {
        let _ = c.kill();
    }
    let _ = c.wait();
}

/// Waits for the process to actually exit (after the reader/stderr threads have
/// already joined), emits the node's one final, unthrottled event, and removes the
/// entry from `sessions` — mirrors agent.rs's stdout-reader-then-reap shape.
fn reap(child: &Arc<FlowChild>, sessions: &Sessions, key: &str) {
    let code = loop {
        match lock(&child.child).try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => thread::sleep(POLL),
            Err(_) => break None,
        }
    };
    terminate_job(child); // safety net: a gracefully exited root may leave descendants
    let status = if child.canceled.load(Ordering::SeqCst) {
        FlowRunNodeStatus::Canceled
    } else if child.result_seen.load(Ordering::SeqCst) {
        let is_error = child.is_error.lock().ok().and_then(|g| *g).unwrap_or(false);
        if is_error { FlowRunNodeStatus::Error } else { FlowRunNodeStatus::Ok }
    } else {
        FlowRunNodeStatus::Error
    };
    let full_text = child
        .final_text
        .lock()
        .ok()
        .and_then(|g| g.clone())
        // A crash with no `result` line still has whatever assistant
        // text arrived before it, rather than nothing.
        .or_else(|| {
            child
                .live_text
                .lock()
                .ok()
                .map(|g| g.clone())
                .filter(|s| !s.is_empty())
        });
    // Full uncapped text goes to disk before the cap; a failure is logged and
    // surfaces as `output_file: null`, never fatal to the run. No text still
    // writes "" so a previous attempt's file is removed, not left stale.
    let output_file = {
        let body = full_text.clone().unwrap_or_default();
        let (run_id, node_id) = (child.run_id.clone(), child.node_id.clone());
        let non_empty = !body.is_empty();
        let joined = tauri::async_runtime::block_on(tauri::async_runtime::spawn_blocking(
            move || {
                crate::flow_output::write_output(&run_id, &node_id, &body)?;
                Ok::<String, String>(crate::flow_output::output_path(&run_id, &node_id)?
                    .to_string_lossy()
                    .into_owned())
            },
        ));
        match joined {
            Ok(Ok(path)) => non_empty.then_some(path),
            Ok(Err(e)) => {
                eprintln!("flow: output file write failed: {e}");
                None
            }
            Err(e) => {
                eprintln!("flow: output file write panicked: {e}");
                None
            }
        }
    };
    let text = full_text.map(|t| cap_text(&t, OUTPUT_CAP_BYTES));
    let cost = child.cost_usd.lock().ok().and_then(|g| *g);
    let error = if matches!(status, FlowRunNodeStatus::Error) {
        // Build the reason first, then *append* the stderr tail
        // rather than letting it replace the reason — both carry information.
        let reason = if child.result_seen.load(Ordering::SeqCst) {
            child
                .result_error_reason
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .unwrap_or_else(|| "node error".to_string())
        } else if let Some(sidecar_err) =
            child.sidecar_error.lock().ok().and_then(|g| g.clone())
        {
            sidecar_err
        } else {
            format!("process exited with no result (code {code:?})")
        };
        let tail = child.stderr_tail.lock().ok().map(|g| g.clone()).unwrap_or_default();
        let mut error = if tail.trim().is_empty() {
            reason
        } else {
            format!("{reason}\n--- stderr (tail) ---\n{tail}")
        };
        if !child.warnings.is_empty() {
            error.push_str("\n--- warnings ---\n");
            error.push_str(&child.warnings.join("\n"));
        }
        Some(error)
    } else {
        None
    };
    // Remove the `sessions` entry before emitting the terminal event,
    // not after — engine.ts's retry (start_node_process) runs synchronously from its own handler
    // for this same event, keyed by the same "<runId>:<nodeId>"; emitting first left a
    // microsecond window where a preempted reap thread had the terminal event delivered but the
    // old entry still live, so a retry racing that window was rejected as "already has a live
    // attempt" and turned into a spurious node error instead of starting.
    {
        let mut guard = lock(sessions);
        if guard.get(key).is_some_and(|c| Arc::ptr_eq(c, child)) {
            guard.remove(key);
        }
    }
    emit_event_with_file(child, status, text, cost, error, None, output_file);
}
/// The core runner, decoupled from `AppHandle` (see the module doc): resolves the
/// two executables, builds the env plan, spawns, writes the one prompt line, then
/// starts the stdout/stderr/reaper threads. Returns once the child is spawned and
/// the prompt line is written (§2's `flow_run_node` doc comment).
#[allow(clippy::too_many_arguments)] // 12 args: one per node-run input, no params struct yet
pub(super) fn start_node_process(
    sessions: Sessions,
    key: String,
    run_id: String,
    node_id: String,
    attempt: u32,
    model: String,
    prompt: String,
    cwd: String,
    tool_allowlist: Vec<String>,
    permission_mode: String,
    spec: RunnerSpec,
    extra_args: Vec<String>,
    emit: Box<dyn Fn(FlowNodeEventPayload) + Send + Sync>,
) -> Result<(), String> {
    // A stale live entry under this exact key would otherwise be silently
    // overwritten, orphaning it from flow_cancel_node/flow_cancel_run.
    if lock(&sessions).contains_key(&key) {
        return Err(format!("flow node {key} already has a live attempt"));
    }

    let mut list_timeouts = codex_mcp::ListTimeouts::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut instructions: Option<String> = None;
    let (runner, (mut child, job)) = match &spec {
        RunnerSpec::Claude { sidecar, env, args: stage_args, warnings: stage_warnings } => {
            // The stage's vault-home args, then the allowlist's MCP servers, which ride argv so the
            // sidecar waits for them before the first turn.
            let mut args = extra_args.clone();
            args.extend(stage_args.iter().cloned());
            warnings = stage_warnings.clone();
            args.extend(claude::required_mcp_args(&tool_allowlist));
            (Runner::Claude, claude::spawn(sidecar, &model, &cwd, &permission_mode, &args, env.as_ref())?)
        }
        RunnerSpec::Codex { js, home, bare } => {
            // The vault's overrides (network, MCP) first, then the allowlist's MCP tools; a name
            // unsafe for a `-c` key, or a server the vault's Codex config does not define, fails
            // here, before anything spawns.
            let mut args = extra_args.clone();
            if let Some(b) = bare {
                args.extend(b.args.iter().cloned());
                warnings = b.warnings.clone();
                instructions = b.instructions.clone();
            }
            args.extend(codex_mcp::approval_args(&tool_allowlist)?);
            list_timeouts = codex_mcp::preflight(home.as_deref(), &cwd, &tool_allowlist, &[])?;
            let on_bare = bare.as_ref().map(|b| (b.node.as_path(), &b.env));
            (Runner::Codex, codex::spawn(js, &cwd, &args, on_bare)?)
        }
    };
    for w in &warnings {
        eprintln!("flow: {key}: {w}");
    }

    let stdin = child.stdin.take().ok_or("missing flow child stdin")?;
    let stdout = child.stdout.take().ok_or("missing flow child stdout")?;
    let stderr = child.stderr.take().ok_or("missing flow child stderr")?;

    let flow_child = Arc::new(FlowChild {
        runner,
        run_id,
        node_id,
        attempt,
        child: Mutex::new(child),
        stdin: Mutex::new(Some(stdin)),
        job: Mutex::new(Some(job)),
        pending: Mutex::new(HashSet::new()),
        result_seen: AtomicBool::new(false),
        canceled: AtomicBool::new(false),
        is_error: Mutex::new(None),
        cost_usd: Mutex::new(None),
        final_text: Mutex::new(None),
        stderr_tail: Mutex::new(String::new()),
        sidecar_error: Mutex::new(None),
        result_error_reason: Mutex::new(None),
        live_text: Mutex::new(String::new()),
        rpc: Mutex::new(codex::Rpc::with_list_timeouts(list_timeouts).with_instructions(instructions)),
        warnings,
        emit,
    });
    lock(&sessions).insert(key.clone(), Arc::clone(&flow_child));

    // Start draining stdout/stderr *before* writing the prompt
    // line. Windows' anonymous pipes have small buffers and Node's stdio writes
    // are synchronous there, so if nothing were reading yet, a large enough
    // upstream write (or the child writing before it reads stdin) could block
    // both sides. Writing first (the old order) also meant a broken-pipe error
    // from an early-dead sidecar surfaced with no stderr to explain it.
    let stderr_child = Arc::clone(&flow_child);
    let stderr_thread = thread::Builder::new()
        .name(format!("flow-stderr-{key}"))
        .spawn(move || drain_stderr_tail(stderr, &stderr_child))
        .map_err(|e| e.to_string())?;

    let out_child = Arc::clone(&flow_child);
    let reader = thread::Builder::new()
        .name(format!("flow-stdout-{key}"))
        .spawn(move || match out_child.runner {
            Runner::Claude => claude::forward_stdout(stdout, &out_child, &tool_allowlist),
            Runner::Codex => codex::forward_stdout(stdout, &out_child, &tool_allowlist),
        })
        .map_err(|e| e.to_string())?;

    // §4.3 step 3: the one prompt line, now that both reader threads are
    // draining. The sidecar's stdin readline listener is wired before its
    // query() starts, so this is queued safely even before its own "ready" line.
    let line = match flow_child.runner {
        Runner::Claude => claude::prompt_line(&prompt),
        // Codex: `initialize`; the prompt rides `turn/start` once the handshake reaches it.
        Runner::Codex => codex::prompt_line(&flow_child, &prompt, &cwd, &model),
    };
    if let Err(write_err) = send_raw_checked(&flow_child, &line) {
        // Give the stderr thread a moment to pick up whatever explains the write
        // failure (e.g. the sidecar died on an SDK import error) before killing.
        thread::sleep(Duration::from_millis(200));
        terminate_job(&flow_child);
        {
            let mut c = lock(&flow_child.child);
            if !matches!(c.try_wait(), Ok(Some(_))) {
                let _ = c.kill();
            }
            let _ = c.wait();
        }
        lock(&sessions).remove(&key);
        let tail = flow_child.stderr_tail.lock().ok().map(|g| g.clone()).unwrap_or_default();
        let reason = format!("write prompt line: {write_err}");
        return Err(if tail.trim().is_empty() {
            reason
        } else {
            format!("{reason}\n--- stderr (tail) ---\n{tail}")
        });
    }

    let reap_child = Arc::clone(&flow_child);
    let reap_sessions = Arc::clone(&sessions);
    thread::Builder::new()
        .name(format!("flow-reap-{key}"))
        .spawn(move || {
            let _ = reader.join();
            let _ = stderr_thread.join();
            reap(&reap_child, &reap_sessions, &key);
        })
        .map_err(|e| e.to_string())?;

    Ok(())
}
