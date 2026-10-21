//! FLOW run orchestration, chain-only in v1.
//! One concern: FLOW run orchestration. Owns a small, self-contained child-process
//! spawn primitive (Job Object kill-on-close, env scrub — modeled on agent.rs's
//! pattern, not calling into it) and its own FlowManager state. Does **not** call
//! `agent::spawn_agent`: that function's own module doc, VERIFIED agent.rs:1-7,
//! scopes it to the `codex app-server` process and states Claude sessions are
//! "never spawned here".
//!
//! `flow_run_node`/`flow_answer_permission`/
//! `flow_cancel_node`/`flow_cancel_run` are registered in main.rs, which also manages
//! `FlowManager` state.
//!
//! The Rust runner fills the `sdk` backend body per §4.3/§4.4. Event delivery
//! is decoupled from `AppHandle` on purpose: every `FlowChild` carries its own
//! `emit: Box<dyn Fn(FlowNodeEventPayload) + Send + Sync>` closure, captured once
//! at spawn time from the real `AppHandle`. That is what lets `flow_answer_permission`
//! (frozen with no `AppHandle` parameter, §2) emit "running again" when a node's
//! pending-permission set empties, and it is what lets the transport test (§7) drive
//! `start_node_process` directly against the fake sidecar with a channel-backed
//! `emit` instead of standing up a real Tauri app.

//! Layout: this file is the runner-agnostic wiring (commands, event payloads, manager state);
//! `flow/child.rs` owns the child process lifetime, `flow/claude.rs` the Claude sidecar and
//! `flow/codex.rs` the Codex app-server.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::control::policy::PolicyState;

// §4.4 node env plan and executable resolution live in flow/env.rs; the Claude runner uses them.
// flow/bare.rs puts every node on the Bare home (run 2026-10-19-codex-primary, U2).
mod bare;
mod child;
mod claude;
mod claude_mcp;
mod codex;
mod codex_mcp;
mod env;
pub mod permission;
use self::child::{cancel_child, emit_event, lock, maybe_close_stdin, start_node_process, FlowChild, Runner, Sessions};

/// `flow_run_node`'s default `cwd` when a node has no `cwd` addon, so `engine.ts` need not
/// hardcode a repo path. Resolved through `crate::paths::root()` (the runtime root resolved
/// from the exe), so this and the six other repo-root call sites can't drift apart.
fn repo_root() -> PathBuf {
    crate::paths::root()
}

/// Holds the per-run child-process handles, output buffers and
/// pending-permission state.
#[derive(Default)]
pub struct FlowManager {
    // Keyed by "<runId>:<nodeId>" — v1 is chain-only, so at most one live attempt
    // per node at a time; a retried node's new attempt replaces the map entry once
    // the previous attempt's reaper has removed it.
    sessions: Sessions,
    next_token: Arc<AtomicU64>,
    // The first Bare home/login verdict per run and node kind (flow/bare.rs `check_once`).
    bare_checks: bare::Checks,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
// Idle/Queued are TS-only states (engine.ts sets a node's run record to them before ever
// calling flow_run_node, §2) — Rust never constructs them, but the variants stay for wire-format
// parity with the frozen FlowRunNodeStatus union every event's `status` field must serialize as.
#[allow(dead_code)] // Idle/Queued are never constructed; the enum mirrors the full TS union
pub enum FlowRunNodeStatus {     // serializes to exactly the TS FlowRunNodeStatus strings
    Idle, Queued, Running, AwaitingApproval, Ok, Error, Canceled,
}                                // never glob-imported (its `Ok` would shadow Result::Ok)

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowNodeEventPayload {
    pub run_id: String,
    pub node_id: String,
    pub attempt: u32,                                    // 1-based, echoes flow_run_node's argument
    pub status: FlowRunNodeStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission: Option<FlowPermissionPayload>,
    // no skip: serializes null when the full-output file was not written
    pub output_file: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowPermissionPayload {
    pub id: String,
    pub tool_use_id: Option<String>,                     // no skip: serializes null, TS is `string | null`
    pub tool: String,
    pub input: serde_json::Value,
    pub suggestions: Vec<serde_json::Value>,             // `[]` when the sidecar line has none
}
// Both structs match the codebase's existing wire-format convention for every payload
// emitted to the frontend (`#[serde(rename_all = "camelCase")]`, as on `AdoptResult` in
// pty/handover.rs) — without it these fields would serialize as run_id/cost_usd/… and every
// field on the frozen camelCase TS side (FlowNodeEvent/FlowPermissionRequest, run.ts)
// would read back as undefined at runtime, a gap `cargo check`/`npm run build` cannot catch.

// ---------------------------------------------------------------------------
// Tauri commands (frozen signatures, §2)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn flow_run_node(       // async: PATH probe, `reg query` and spawn must not run on the
    app: AppHandle,               // main thread; the blocking part goes through
    state: State<'_, FlowManager>,// tauri::async_runtime::spawn_blocking. New, flow.rs-owned, not AgentManager.
    run_id: String,
    node_id: String,
    attempt: u32,
    backend: String,              // "sdk" (Claude sidecar) or "codex" (Codex app-server)
    model: String,                // provider model id: a claude id or a module's flowModels id
    prompt: String,                // the already-rendered prompt text (§3 renderPrompt), never a template
    cwd: String,                   // empty = no "cwd" addon on the node; defaults to repo_root() below
    tool_allowlist: Vec<String>,  // "permission-allowlist" addon values; auto-approved without a UI pause
    permission_mode: String,      // the run's resolved mode; re-validated here, Codex ignores it
) -> Result<u64, String> {
    let permission_mode = permission::effective(&permission_mode, &model).to_string();
    // Ok(u64) = spawn token: FlowManager-monotonic, returned once the child is spawned
    // and the prompt line written. Diagnostic only (logged by engine.ts); events are
    // matched by runId/nodeId/attempt. Err covers pre-spawn failures (no node.exe /
    // claude.exe, unknown backend, missing vendor key, no Bare home or login).
    let need = bare::need_for(&backend, &model).ok_or_else(|| format!("backend not yet wired: {backend}"))?;
    // Every node runs on the Bare home; the first missing home or login fails the run's
    // later nodes of that kind with the same message, before anything is built or spawned.
    let spec = bare::check_once(&state.bare_checks, &run_id, need, || match backend.as_str() {
        "sdk" => claude::spec(need),
        "codex" => codex::spec(),
        _ => Err(format!("backend not yet wired: {backend}")),
    })?;
    // Codex nodes only: the token the Bare config's `vidar_drive` server forwards.
    let ctl_token = bare::ctl_token_of(&spec);
    let cwd = if cwd.trim().is_empty() { repo_root().display().to_string() } else { cwd };
    if !Path::new(&cwd).is_dir() {
        return Err(format!("cwd is not a directory: {cwd}"));
    }
    let sessions = Arc::clone(&state.sessions);
    let token = state.next_token.fetch_add(1, Ordering::SeqCst);
    let key = format!("{run_id}:{node_id}");
    if let Some(t) = &ctl_token {
        crate::control::policy::register(&app.state::<PolicyState>(), t.clone(), bare::ctl_tab(&run_id, &node_id));
    }
    let drop_token = {
        let app = app.clone();
        let ctl_token = ctl_token.clone();
        move || {
            if let Some(t) = &ctl_token {
                crate::control::policy::unregister_token(&app.state::<PolicyState>(), t);
            }
        }
    };
    let on_end = drop_token.clone();
    let emit: Box<dyn Fn(FlowNodeEventPayload) + Send + Sync> =
        Box::new(move |payload| {
            if matches!(payload.status, FlowRunNodeStatus::Ok | FlowRunNodeStatus::Error | FlowRunNodeStatus::Canceled) {
                on_end();
            }
            let _ = app.emit("flow-node-event", payload);
        });
    let started = tauri::async_runtime::spawn_blocking(move || {
        start_node_process(
            sessions,
            key,
            run_id,
            node_id,
            attempt,
            model,
            prompt,
            cwd,
            tool_allowlist,
            permission_mode,
            spec,
            Vec::new(),
            emit,
        )
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    if started.is_err() {
        drop_token();
    }
    started.map(|()| token)
}

#[tauri::command]
pub fn flow_answer_permission(    // writes one permission_response line; answers one request by id
    state: State<FlowManager>,
    run_id: String,
    node_id: String,
    permission_id: String,
    allow: bool,
) -> Result<(), String> {
    let key = format!("{run_id}:{node_id}");
    let child = lock(&state.sessions)
        .get(&key)
        .cloned()
        .ok_or("no such flow node")?;
    let had = child
        .pending
        .lock()
        .map_err(|_| "pending lock poisoned".to_string())?
        .remove(&permission_id);
    if !had {
        return Err(format!("no pending permission {permission_id}"));
    }
    match child.runner {
        Runner::Claude => claude::send_permission_response(&child, &permission_id, allow, None),
        Runner::Codex => codex::send_permission_response(&child, &permission_id, allow),
    }
    let pending_empty = child.pending.lock().map(|p| p.is_empty()).unwrap_or(true);
    if pending_empty {
        if child.result_seen.load(Ordering::SeqCst) {
            maybe_close_stdin(&child);
        } else {
            // §4.3 step 4: "when the set empties flow.rs emits running again".
            emit_event(&child, FlowRunNodeStatus::Running, None, None, None, None);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn flow_cancel_node(
    state: State<'_, FlowManager>,
    run_id: String,
    node_id: String,
) -> Result<(), String> {
    // §4.3 step 6 sequence. Idempotent: Ok(()) when that node has no live child.
    let key = format!("{run_id}:{node_id}");
    let child = lock(&state.sessions).get(&key).cloned();
    let Some(child) = child else { return Ok(()) };
    tauri::async_runtime::spawn_blocking(move || cancel_child(&child))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn flow_cancel_run(
    state: State<'_, FlowManager>,
    run_id: String,
) -> Result<(), String> {
    // Cancels every live child FlowManager holds under run_id (§4.3 step 6 each), whatever
    // the stored record says. Idempotent. Used by the run's Cancel button and by
    // mount-time reconcile (§4.1).
    let children: Vec<Arc<FlowChild>> = lock(&state.sessions)
        .values()
        .filter(|c| c.run_id == run_id)
        .cloned()
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        for child in children {
            cancel_child(&child);
        }
    })
    .await
    .map_err(|e| e.to_string())
}

// flow_pending_approvals is removed: v1 does not
// rehydrate approvals across a reload, it interrupts the run (§4.1). The name is free for
// v2 if resumable runs arrive.
#[cfg(test)]
mod tests {
    use super::child::{RunnerSpec, GRACE, OUTPUT_CAP_BYTES};
    use super::*;
    use std::collections::HashMap;
    use std::sync::{mpsc, Mutex};
    use std::time::{Duration, Instant};

    // ---- transport, against tests/fixtures/flow-fake-sidecar.mjs ----

    // Derive both paths from the crate's own manifest dir rather than
    // hardcoding a checkout path such as `C:\Work\Example`, so the suite works in any worktree/checkout.
    fn fixture_path() -> PathBuf {
        PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            r"\..\tests\fixtures\flow-fake-sidecar.mjs"
        ))
    }

    fn repo_root() -> String {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("CARGO_MANIFEST_DIR has a parent")
            .display()
            .to_string()
    }

    fn real_sidecar_path() -> PathBuf {
        PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), r"\..\tools\claude-sidecar.mjs"))
    }

    /// §7 finding 1 verification / cancel test: true even for an exited process
    /// (a stale pid could be reused by an unrelated process, but immediately
    /// after cancel that race is negligible for a test).
    fn pid_is_alive(pid: u32) -> bool {
        use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let mut code = 0u32;
            let alive = GetExitCodeProcess(handle, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32;
            let _ = CloseHandle(handle);
            alive
        }
    }

    struct Harness {
        sessions: Sessions,
        rx: mpsc::Receiver<FlowNodeEventPayload>,
        key: String,
        run_id: String,
        node_id: String,
        // Kept alive for the harness's lifetime: flow_answer_permission's frozen
        // signature takes `State<FlowManager>` (Runtime-independent, tauri::state.rs),
        // and `tauri::test::mock_app()`'s state manager is the only public way to
        // mint one outside the real Tauri runtime (no `AppHandle` needed either way,
        // matching the module doc's decoupling of `emit` from `AppHandle`).
        app: tauri::App<tauri::test::MockRuntime>,
    }

    fn state(h: &Harness) -> State<'_, FlowManager> {
        use tauri::Manager;
        h.app.state::<FlowManager>()
    }

    fn start(prompt: &str, tool_allowlist: Vec<String>, extra_args: Vec<String>) -> Harness {
        start_with(
            prompt,
            "claude-sonnet-5",
            tool_allowlist,
            RunnerSpec::Claude { sidecar: fixture_path(), env: None, args: Vec::new(), warnings: Vec::new() },
            extra_args,
        )
    }

    /// The Codex runner against tests/fixtures/flow-fake-appserver.mjs.
    fn start_codex(prompt: &str, tool_allowlist: Vec<String>) -> Harness {
        let js = PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            r"\..\tests\fixtures\flow-fake-appserver.mjs"
        ));
        start_with(prompt, "codex-default", tool_allowlist, RunnerSpec::Codex { js, home: None, bare: None }, Vec::new())
    }

    fn start_with(
        prompt: &str,
        model: &str,
        tool_allowlist: Vec<String>,
        spec: RunnerSpec,
        extra_args: Vec<String>,
    ) -> Harness {
        let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::channel::<FlowNodeEventPayload>();
        let tx = Mutex::new(tx);
        let emit: Box<dyn Fn(FlowNodeEventPayload) + Send + Sync> =
            Box::new(move |p| { let _ = tx.lock().unwrap().send(p); });
        let run_id = "run1".to_string();
        let node_id = "n1".to_string();
        let key = format!("{run_id}:{node_id}");
        start_node_process(
            Arc::clone(&sessions),
            key.clone(),
            run_id.clone(),
            node_id.clone(),
            1,
            model.to_string(),
            prompt.to_string(),
            repo_root(),
            tool_allowlist,
            "default".to_string(),
            spec,
            extra_args,
            emit,
        )
        .expect("start_node_process");
        let app = tauri::test::mock_app();
        {
            use tauri::Manager;
            app.manage(FlowManager {
                sessions: Arc::clone(&sessions),
                next_token: Arc::new(AtomicU64::new(0)),
                bare_checks: Default::default(),
            });
        }
        Harness { sessions, rx, key, run_id, node_id, app }
    }

    fn recv_until(
        rx: &mpsc::Receiver<FlowNodeEventPayload>,
        timeout: Duration,
        mut pred: impl FnMut(&FlowNodeEventPayload) -> bool,
    ) -> Option<FlowNodeEventPayload> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            match rx.recv_timeout(remaining.min(Duration::from_millis(200))) {
                Ok(e) if pred(&e) => return Some(e),
                Ok(_) => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return None,
            }
        }
    }

    #[test]
    fn result_result_becomes_final_output() {
        let h = start("echo", vec![], vec![]);
        let done = recv_until(&h.rx, Duration::from_secs(10), |e| {
            matches!(e.status, FlowRunNodeStatus::Ok | FlowRunNodeStatus::Error)
        });
        let done = done.expect("final event");
        assert!(matches!(done.status, FlowRunNodeStatus::Ok));
        assert_eq!(done.text.as_deref(), Some("hello-done"));
    }

    /// Collects every event up to and including the first terminal one — unlike
    /// `recv_until`, nothing observed along the way is discarded, so a caller can
    /// assert both "no such event ever arrived" and "the run finished" from one pass.
    fn collect_until_terminal(
        rx: &mpsc::Receiver<FlowNodeEventPayload>,
        timeout: Duration,
    ) -> Vec<FlowNodeEventPayload> {
        let mut events = Vec::new();
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return events;
            }
            match rx.recv_timeout(remaining.min(Duration::from_millis(200))) {
                Ok(e) => {
                    let terminal = matches!(
                        e.status,
                        FlowRunNodeStatus::Ok | FlowRunNodeStatus::Error | FlowRunNodeStatus::Canceled
                    );
                    events.push(e);
                    if terminal {
                        return events;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return events,
            }
        }
    }

    #[test]
    fn allowlisted_tool_is_auto_allowed_no_ui_pause() {
        let h = start("allow:Read", vec!["Read".to_string()], vec![]);
        let events = collect_until_terminal(&h.rx, Duration::from_secs(10));
        let statuses: Vec<_> = events.iter().map(|e| e.status).collect();
        assert!(
            !events.iter().any(|e| matches!(e.status, FlowRunNodeStatus::AwaitingApproval)),
            "allowlisted tool must not pause for approval: {statuses:?}",
        );
        let done = events.last().expect("final event");
        assert!(matches!(done.status, FlowRunNodeStatus::Ok));
        // The fixture echoes the behavior/message it actually
        // received, so auto-allow sending anything other than allow/no-message
        // would fail this, not just "some non-awaiting-approval event arrived".
        assert_eq!(done.text.as_deref(), Some("after-allow-done:allow:"));
    }

    const MCP_TOOL: &str = "mcp__proxy__unreal_call_tool";

    #[test]
    fn mcp_connected_server_proceeds_without_approval_card() {
        let h = start(
            &format!("mcp:proxy=connected|{MCP_TOOL}"),
            vec![MCP_TOOL.to_string()],
            vec![],
        );
        let events = collect_until_terminal(&h.rx, Duration::from_secs(10));
        assert!(!events.iter().any(|e| matches!(e.status, FlowRunNodeStatus::AwaitingApproval)));
        let done = events.last().expect("final event");
        assert!(matches!(done.status, FlowRunNodeStatus::Ok));
        assert_eq!(done.text.as_deref(), Some("mcp-done:allow"));
    }

    #[test]
    fn mcp_disconnected_server_fails_the_node_with_its_name() {
        let h = start(
            &format!("mcp:proxy=failed|{MCP_TOOL}"),
            vec![MCP_TOOL.to_string()],
            vec![],
        );
        let events = collect_until_terminal(&h.rx, Duration::from_secs(10));
        let done = events.last().expect("final event");
        assert!(matches!(done.status, FlowRunNodeStatus::Error), "{:?}", done.status);
        let err = done.error.as_deref().unwrap_or("");
        assert!(err.contains("\"proxy\"") && err.contains("failed"), "{err}");
    }

    #[test]
    fn mcp_missing_server_fails_the_node_with_its_name() {
        let h = start(
            &format!("mcp:other=connected|{MCP_TOOL}"),
            vec![MCP_TOOL.to_string()],
            vec![],
        );
        let events = collect_until_terminal(&h.rx, Duration::from_secs(10));
        let done = events.last().expect("final event");
        assert!(matches!(done.status, FlowRunNodeStatus::Error), "{:?}", done.status);
        assert!(done.error.as_deref().unwrap_or("").contains("\"proxy\""));
    }

    /// The runner passes `--require-mcp`; the fixture runs the real sidecar wait over these snapshots.
    fn mcp_wait_args(snapshots: &str) -> Vec<String> {
        vec!["--fake-mcp-statuses".to_string(), snapshots.to_string()]
    }

    #[test]
    fn mcp_pending_then_connected_server_proceeds() {
        let h = start(
            &format!("mcp:proxy=connected|{MCP_TOOL}"),
            vec![MCP_TOOL.to_string()],
            mcp_wait_args(r#"[{"proxy":"pending"},{"proxy":"pending"},{"proxy":"connected"}]"#),
        );
        let events = collect_until_terminal(&h.rx, Duration::from_secs(10));
        let done = events.last().expect("final event");
        assert!(matches!(done.status, FlowRunNodeStatus::Ok), "{:?} {:?}", done.status, done.error);
        assert_eq!(done.text.as_deref(), Some("mcp-done:allow"));
    }

    #[test]
    fn mcp_still_pending_server_fails_after_the_wait() {
        let h = start(
            &format!("mcp:proxy=connected|{MCP_TOOL}"),
            vec![MCP_TOOL.to_string()],
            mcp_wait_args(r#"[{"proxy":"pending"}]"#),
        );
        let events = collect_until_terminal(&h.rx, Duration::from_secs(10));
        let done = events.last().expect("final event");
        assert!(matches!(done.status, FlowRunNodeStatus::Error), "{:?}", done.status);
        let err = done.error.as_deref().unwrap_or("");
        assert!(err.contains("MCP server \"proxy\" is unavailable: still pending after"), "{err}");
    }

    #[test]
    fn mcp_failed_during_the_wait_fails_with_its_status() {
        let h = start(
            &format!("mcp:proxy=connected|{MCP_TOOL}"),
            vec![MCP_TOOL.to_string()],
            mcp_wait_args(r#"[{"proxy":"pending"},{"proxy":"needs-auth"}]"#),
        );
        let events = collect_until_terminal(&h.rx, Duration::from_secs(10));
        let done = events.last().expect("final event");
        assert!(matches!(done.status, FlowRunNodeStatus::Error), "{:?}", done.status);
        assert_eq!(done.error.as_deref(), Some("MCP server \"proxy\" is unavailable: status needs-auth"));
    }

    #[test]
    fn mcp_check_ignores_non_mcp_allowlist_entries() {
        let h = start("mcp:|Read", vec!["Read".to_string()], vec![]);
        let events = collect_until_terminal(&h.rx, Duration::from_secs(10));
        assert!(matches!(events.last().expect("final event").status, FlowRunNodeStatus::Ok));
    }

    #[test]
    fn ask_user_question_is_auto_denied() {
        // Not allowlisted and named AskUserQuestion: must resolve without ever
        // surfacing an awaiting-approval event.
        let h = start("deny:AskUserQuestion", vec![], vec![]);
        let events = collect_until_terminal(&h.rx, Duration::from_secs(10));
        let statuses: Vec<_> = events.iter().map(|e| e.status).collect();
        assert!(
            !events.iter().any(|e| matches!(e.status, FlowRunNodeStatus::AwaitingApproval)),
            "AskUserQuestion must never pause for approval: {statuses:?}",
        );
        let done = events.last().expect("final event");
        assert!(matches!(done.status, FlowRunNodeStatus::Ok));
        assert_eq!(
            done.text.as_deref(),
            Some("after-allow-done:deny:No user in a flow; decide and continue"),
        );
    }

    #[test]
    fn non_allowlisted_tool_relays_as_awaiting_approval_and_resumes() {
        let h = start("allow:Bash", vec![], vec![]);
        let pause = recv_until(&h.rx, Duration::from_secs(5), |e| {
            matches!(e.status, FlowRunNodeStatus::AwaitingApproval)
        })
        .expect("awaiting-approval event");
        let permission = pause.permission.expect("permission payload");
        assert_eq!(permission.tool, "Bash");

        flow_answer_permission(
            state(&h),
            h.run_id.clone(),
            h.node_id.clone(),
            permission.id,
            true,
        )
        .expect("answer permission");

        let done = recv_until(&h.rx, Duration::from_secs(10), |e| {
            matches!(e.status, FlowRunNodeStatus::Ok | FlowRunNodeStatus::Error)
        })
        .expect("final event");
        assert!(matches!(done.status, FlowRunNodeStatus::Ok));
        assert_eq!(done.text.as_deref(), Some("after-allow-done:allow:"));
    }

    #[test]
    fn two_open_requests_queue_separately() {
        let h = start("two-tools", vec![], vec![]);
        let first = recv_until(&h.rx, Duration::from_secs(5), |e| {
            matches!(e.status, FlowRunNodeStatus::AwaitingApproval)
        })
        .expect("first awaiting-approval event");
        let second = recv_until(&h.rx, Duration::from_secs(5), |e| {
            matches!(e.status, FlowRunNodeStatus::AwaitingApproval)
        })
        .expect("second awaiting-approval event");
        let id1 = first.permission.unwrap().id;
        let id2 = second.permission.unwrap().id;
        assert_ne!(id1, id2);

        flow_answer_permission(state(&h), h.run_id.clone(), h.node_id.clone(), id1, true)
            .expect("answer first");
        flow_answer_permission(state(&h), h.run_id.clone(), h.node_id.clone(), id2, true)
            .expect("answer second");

        let done = recv_until(&h.rx, Duration::from_secs(10), |e| {
            matches!(e.status, FlowRunNodeStatus::Ok | FlowRunNodeStatus::Error)
        })
        .expect("final event");
        assert!(matches!(done.status, FlowRunNodeStatus::Ok));
        assert_eq!(done.text.as_deref(), Some("two-tools-done"));
    }

    #[test]
    fn noise_lines_never_reach_output_text() {
        let h = start("noise", vec![], vec![]);
        let events = collect_until_terminal(&h.rx, Duration::from_secs(10));
        // Actually inspect the Running events' text, not just
        // the final text (which comes from `result.result`, never the noise) —
        // the old assertion here would pass even if noise leaked into live text.
        for e in events
            .iter()
            .filter(|e| matches!(e.status, FlowRunNodeStatus::Running) && e.text.is_some())
        {
            assert_eq!(e.text.as_deref(), Some("real-text"), "noise leaked into a Running event");
        }
        let done = events.last().expect("final event");
        assert_eq!(done.text.as_deref(), Some("real-text-done"));
    }

    #[test]
    fn running_without_text_precedes_first_text() {
        let h = start("noise", vec![], vec![]);
        let events = collect_until_terminal(&h.rx, Duration::from_secs(10));
        let running: Vec<_> = events
            .iter()
            .filter(|e| matches!(e.status, FlowRunNodeStatus::Running))
            .collect();
        assert!(!running.is_empty(), "no Running event at all");
        assert!(running[0].text.is_none(), "first Running event must carry no text");
        if let Some(first_text) = running.iter().position(|e| e.text.is_some()) {
            assert!(first_text > 0);
        }
    }

    #[test]
    fn big_stderr_does_not_stall_the_child() {
        let h = start("big-stderr", vec![], vec![]);
        let done = recv_until(&h.rx, Duration::from_secs(10), |e| {
            matches!(e.status, FlowRunNodeStatus::Ok | FlowRunNodeStatus::Error)
        })
        .expect("final event");
        assert!(matches!(done.status, FlowRunNodeStatus::Ok));
    }

    #[test]
    fn hang_mode_is_hard_killed_after_grace() {
        // §7 blocker fix: the fixture's --hang mode now genuinely hangs (a real
        // setInterval, not just "ignore EOF and let the event loop empty out"),
        // and flow.rs now arms a watchdog when it closes stdin after the result.
        // This asserts both halves: the terminal event lands within the grace
        // window (not instantly, and not never), and the child pid is gone.
        let h = start("echo", vec![], vec!["--hang".to_string()]);
        let child = lock(&h.sessions).get(&h.key).cloned().expect("live child");
        let pid = lock(&child.child).id();
        let started = Instant::now();
        let done = recv_until(&h.rx, Duration::from_secs(GRACE.as_secs() + 5), |e| {
            !matches!(e.status, FlowRunNodeStatus::Running | FlowRunNodeStatus::AwaitingApproval)
        })
        .expect("reaper must eventually report a terminal status");
        let elapsed = started.elapsed();
        assert!(matches!(done.status, FlowRunNodeStatus::Ok | FlowRunNodeStatus::Error));
        assert!(
            elapsed >= GRACE - Duration::from_millis(500),
            "hard-kill fired before the grace window elapsed: {elapsed:?}",
        );
        assert!(
            elapsed < GRACE + Duration::from_secs(3),
            "hard-kill took far longer than the grace window: {elapsed:?}",
        );
        assert!(!pid_is_alive(pid), "child process should be gone after the hard-kill");
    }

    #[test]
    fn stale_pending_permission_does_not_block_teardown_after_a_result() {
        // The sidecar resolves an SDK-aborted canUseTool locally
        // with no stdout line, so flow.rs's `pending` set for it never empties on
        // its own. A `result` line must clear it anyway so stdin still closes.
        let h = start("abandon-permission", vec![], vec![]);
        let done = recv_until(&h.rx, Duration::from_secs(10), |e| {
            matches!(e.status, FlowRunNodeStatus::Ok | FlowRunNodeStatus::Error)
        });
        assert!(
            done.is_some(),
            "a result with an unanswered pending permission must still reach a terminal event",
        );
    }

    #[test]
    fn sidecar_error_line_never_flips_status_mid_run() {
        // A non-fatal sidecar error line must not itself produce
        // a status:Error event when the run goes on to finish Ok.
        let h = start("sidecar-error-then-ok", vec![], vec![]);
        let events = collect_until_terminal(&h.rx, Duration::from_secs(10));
        let statuses: Vec<_> = events.iter().map(|e| e.status).collect();
        let done = events.last().expect("final event");
        assert!(
            matches!(done.status, FlowRunNodeStatus::Ok),
            "unexpected final status: {statuses:?}",
        );
        assert!(
            events[..events.len() - 1]
                .iter()
                .all(|e| !matches!(e.status, FlowRunNodeStatus::Error)),
            "a non-fatal sidecar error line flipped status mid-run: {statuses:?}",
        );
    }

    #[test]
    fn is_error_result_ends_error_with_last_assistant_text_and_reason() {
        // An `is_error` result with no `result` text field
        // falls back to the last assistant text, and the error carries the
        // result's own reason (subtype + first `errors[]` entry), not just
        // "node error".
        let h = start("is-error", vec![], vec![]);
        let done = recv_until(&h.rx, Duration::from_secs(10), |e| {
            matches!(e.status, FlowRunNodeStatus::Ok | FlowRunNodeStatus::Error)
        })
        .expect("final event");
        assert!(matches!(done.status, FlowRunNodeStatus::Error));
        assert_eq!(done.text.as_deref(), Some("partial-progress"));
        let err = done.error.expect("error message");
        assert!(err.contains("error"), "error should name the result subtype: {err}");
        assert!(err.contains("boom"), "error should carry the result's errors[] entry: {err}");
    }

    #[test]
    fn cancel_node_terminates_within_grace_and_pid_is_gone() {
        // Cancel path (interrupt, close,
        // grace, Canceled). Cancels a node sitting on an open permission.
        let h = start("allow:Bash", vec![], vec![]);
        recv_until(&h.rx, Duration::from_secs(5), |e| {
            matches!(e.status, FlowRunNodeStatus::AwaitingApproval)
        })
        .expect("awaiting-approval event");
        let child = lock(&h.sessions).get(&h.key).cloned().expect("live child");
        let pid = lock(&child.child).id();
        let started = Instant::now();
        cancel_child(&child);
        let elapsed = started.elapsed();
        assert!(
            elapsed < GRACE + Duration::from_secs(3),
            "cancel_child overran its own grace window: {elapsed:?}",
        );
        let done = recv_until(&h.rx, Duration::from_secs(10), |e| {
            matches!(
                e.status,
                FlowRunNodeStatus::Ok | FlowRunNodeStatus::Error | FlowRunNodeStatus::Canceled
            )
        })
        .expect("final event");
        assert!(matches!(done.status, FlowRunNodeStatus::Canceled));
        assert!(!pid_is_alive(pid), "child process should be gone after cancel");
    }

    #[test]
    fn big_text_is_capped_with_truncated_prefix() {
        // The 64 KiB tail cap.
        let h = start("big-text", vec![], vec![]);
        let done = recv_until(&h.rx, Duration::from_secs(10), |e| {
            matches!(e.status, FlowRunNodeStatus::Ok | FlowRunNodeStatus::Error)
        })
        .expect("final event");
        let text = done.text.expect("final text");
        assert!(text.starts_with("[truncated]…"), "missing truncation prefix: {}", &text[..40.min(text.len())]);
        assert!(text.len() <= OUTPUT_CAP_BYTES + "[truncated]…".len());
    }

    #[test]
    fn throttle_drops_rapid_running_events() {
        // The 4 Hz throttle. Five assistant
        // messages arrive well within one 250ms window, so the throttle should
        // collapse them to (usually) exactly one Running event, and always fewer
        // than five.
        let h = start("rapid-text", vec![], vec![]);
        let events = collect_until_terminal(&h.rx, Duration::from_secs(10));
        let running = events
            .iter()
            .filter(|e| matches!(e.status, FlowRunNodeStatus::Running))
            .count();
        assert!(running < 5, "expected the throttle to drop some of 5 near-simultaneous updates, got {running}");
        let done = events.last().expect("final event");
        assert_eq!(done.text.as_deref(), Some("rapid-done"));
    }

    #[test]
    fn live_text_survives_a_crash_with_no_result() {
        // A crash with no `result` line keeps the live text;
        // reap() falls back to the accumulated live_text.
        let h = start("crash-with-partial", vec![], vec![]);
        let done = recv_until(&h.rx, Duration::from_secs(10), |e| {
            matches!(e.status, FlowRunNodeStatus::Ok | FlowRunNodeStatus::Error)
        })
        .expect("final event");
        assert!(matches!(done.status, FlowRunNodeStatus::Error));
        assert_eq!(done.text.as_deref(), Some("partial-before-crash"));
    }

    #[test]
    fn no_scrubbed_env_var_reaches_the_spawned_child() {
        // The fixture reports the *names* of any scrubbed
        // variable it can see, never values; this run's own ambient environment
        // (which, run under a Claude session, plausibly carries CLAUDECODE /
        // CLAUDE_CODE_SESSION_ID right now) is exactly the case the scrub exists for.
        let h = start("env", vec![], vec![]);
        let done = recv_until(&h.rx, Duration::from_secs(10), |e| {
            matches!(e.status, FlowRunNodeStatus::Ok | FlowRunNodeStatus::Error)
        })
        .expect("final event");
        let text = done.text.expect("result text");
        let parsed: serde_json::Value = serde_json::from_str(&text).expect("json result");
        let scrubbed = parsed["scrubbed"].as_array().cloned().unwrap_or_default();
        assert!(scrubbed.is_empty(), "scrubbed vars reached the child: {scrubbed:?}");
        assert_eq!(parsed["contextGate"].as_str(), Some("0"));
    }

    #[test]
    fn live_sidecar_smoke() {
        // Opt-in (§7, §8): costs one Haiku turn on the subscription. Skipped (and
        // says so) unless VIDAR_FLOW_LIVE=1 — this harness never sets that itself.
        if std::env::var("VIDAR_FLOW_LIVE").ok().as_deref() != Some("1") {
            eprintln!(
                "skipping live_sidecar_smoke: set VIDAR_FLOW_LIVE=1 to run it against the real \
                 tools/claude-sidecar.mjs (costs one Haiku turn on the subscription)",
            );
            return;
        }
        let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::channel::<FlowNodeEventPayload>();
        let tx = Mutex::new(tx);
        let emit: Box<dyn Fn(FlowNodeEventPayload) + Send + Sync> =
            Box::new(move |p| { let _ = tx.lock().unwrap().send(p); });
        start_node_process(
            Arc::clone(&sessions),
            "live:n1".to_string(),
            "live".to_string(),
            "n1".to_string(),
            1,
            "claude-haiku-4-5-20251001".to_string(),
            "Read the file CLAUDE.md in the current directory and reply with just the word done."
                .to_string(),
            repo_root(),
            vec!["Read".to_string()],
            "default".to_string(),
            RunnerSpec::Claude { sidecar: real_sidecar_path(), env: None, args: Vec::new(), warnings: Vec::new() },
            Vec::new(),
            emit,
        )
        .expect("start_node_process (live)");
        let done = recv_until(&rx, Duration::from_secs(60), |e| {
            matches!(e.status, FlowRunNodeStatus::Ok | FlowRunNodeStatus::Error)
        })
        .expect("final event from the live sidecar");
        assert!(
            matches!(done.status, FlowRunNodeStatus::Ok),
            "live sidecar run should succeed: {:?}",
            done.error,
        );
    }

    // ---- Codex runner, against tests/fixtures/flow-fake-appserver.mjs ----

    fn terminal(rx: &mpsc::Receiver<FlowNodeEventPayload>) -> FlowNodeEventPayload {
        recv_until(rx, Duration::from_secs(10), |e| {
            matches!(e.status, FlowRunNodeStatus::Ok | FlowRunNodeStatus::Error)
        })
        .expect("final event")
    }

    #[test]
    fn codex_handshake_order_and_text_end_ok() {
        let h = start_codex("handshake", vec![]);
        let done = terminal(&h.rx);
        assert!(matches!(done.status, FlowRunNodeStatus::Ok), "{:?}", done.error);
        assert_eq!(
            done.text.as_deref(),
            Some("initialize>initialized>thread/start>turn/start|untrusted|workspace-write|model=none"),
        );
    }

    #[test]
    fn codex_retrying_error_does_not_end_the_node() {
        let h = start_codex("retry-error", vec![]);
        let events = collect_until_terminal(&h.rx, Duration::from_secs(10));
        let statuses: Vec<_> = events.iter().map(|e| e.status).collect();
        let done = events.last().expect("final event");
        assert!(matches!(done.status, FlowRunNodeStatus::Ok), "{statuses:?}");
        assert_eq!(done.text.as_deref(), Some("recovered"));
        assert!(
            events[..events.len() - 1].iter().all(|e| !matches!(e.status, FlowRunNodeStatus::Error)),
            "a willRetry error flipped status mid-run: {statuses:?}",
        );
    }

    #[test]
    fn codex_failed_turn_ends_error_with_its_message() {
        let h = start_codex("fail", vec![]);
        let done = terminal(&h.rx);
        assert!(matches!(done.status, FlowRunNodeStatus::Error));
        let err = done.error.expect("error");
        assert!(err.contains("boom"), "{err}");
    }

    #[test]
    fn codex_approval_id_round_trips_and_an_unknown_id_is_refused() {
        let h = start_codex("approve-cmd", vec![]);
        let pause = recv_until(&h.rx, Duration::from_secs(5), |e| {
            matches!(e.status, FlowRunNodeStatus::AwaitingApproval)
        })
        .expect("awaiting-approval event");
        let permission = pause.permission.expect("permission payload");
        assert_eq!(permission.tool, "Bash");
        assert_eq!(permission.id, "codex:100");
        assert_eq!(permission.input["command"].as_str(), Some("git status"));

        let unknown = flow_answer_permission(state(&h), h.run_id.clone(), h.node_id.clone(), "codex:999".into(), true);
        assert!(unknown.is_err(), "an unknown permission id must be refused");

        flow_answer_permission(state(&h), h.run_id.clone(), h.node_id.clone(), permission.id, true)
            .expect("answer permission");
        let done = terminal(&h.rx);
        assert!(matches!(done.status, FlowRunNodeStatus::Ok), "{:?}", done.error);
        assert_eq!(done.text.as_deref(), Some("decision:accept"));
    }

    #[test]
    fn codex_allowlisted_command_is_auto_accepted() {
        let h = start_codex("approve-cmd", vec!["Bash".to_string()]);
        let events = collect_until_terminal(&h.rx, Duration::from_secs(10));
        assert!(
            !events.iter().any(|e| matches!(e.status, FlowRunNodeStatus::AwaitingApproval)),
            "an allowlisted plain command must not pause",
        );
        assert_eq!(events.last().and_then(|e| e.text.as_deref()), Some("decision:accept"));
    }

    #[test]
    fn codex_sandbox_escalation_is_never_auto_accepted() {
        let h = start_codex("escalate-cmd", vec!["Bash".to_string()]);
        let pause = recv_until(&h.rx, Duration::from_secs(5), |e| {
            matches!(e.status, FlowRunNodeStatus::AwaitingApproval)
        })
        .expect("an escalation must pause even with Bash allowlisted");
        let permission = pause.permission.expect("permission payload");
        flow_answer_permission(state(&h), h.run_id.clone(), h.node_id.clone(), permission.id, false)
            .expect("answer permission");
        let done = terminal(&h.rx);
        assert_eq!(done.text.as_deref(), Some("decision:decline"));
    }

    #[test]
    fn codex_request_user_input_is_auto_declined() {
        let h = start_codex("user-input", vec![]);
        let events = collect_until_terminal(&h.rx, Duration::from_secs(10));
        assert!(
            !events.iter().any(|e| matches!(e.status, FlowRunNodeStatus::AwaitingApproval)),
            "requestUserInput must never pause",
        );
        let done = events.last().expect("final event");
        assert!(matches!(done.status, FlowRunNodeStatus::Ok));
        assert_eq!(done.text.as_deref(), Some(r#"{"answers":{}}"#));
    }

    // ---- per-node MCP servers (codex_mcp.rs) ----

    #[test]
    fn codex_mcp_connected_server_holds_turn_start_until_listed() {
        let h = start_codex("handshake", vec!["mcp__okprobe__echo_probe".to_string(), "mcp__okprobe__other".to_string()]);
        let done = terminal(&h.rx);
        assert!(matches!(done.status, FlowRunNodeStatus::Ok), "{:?}", done.error);
        assert_eq!(
            done.text.as_deref(),
            Some("initialize>initialized>thread/start>mcpServerStatus/list>turn/start|untrusted|workspace-write|model=none"),
        );
    }

    #[test]
    fn codex_mcp_failed_server_ends_the_node_with_status_and_stderr() {
        let h = start_codex("handshake", vec!["mcp__okprobe__echo_probe".to_string(), "mcp__deadprobe__x".to_string()]);
        let done = terminal(&h.rx);
        assert!(matches!(done.status, FlowRunNodeStatus::Error));
        let err = done.error.expect("error");
        assert!(
            err.starts_with("MCP server \"deadprobe\" is unavailable: failed: MCP startup failed: connection closed"),
            "{err}"
        );
        assert!(err.contains("dead server deadprobe exited"), "stderr missing: {err}");
        assert!(done.text.is_none(), "the turn must never start");
    }

    #[test]
    fn codex_mcp_unreported_server_ends_the_node() {
        let h = start_codex("handshake", vec!["mcp__vnever__echo".to_string()]);
        let done = terminal(&h.rx);
        assert!(matches!(done.status, FlowRunNodeStatus::Error));
        let err = done.error.expect("error");
        assert!(err.starts_with("MCP server \"vnever\" is unavailable: not reported by Codex"), "{err}");
    }

    fn start_codex_direct(tool_allowlist: Vec<String>, home: Option<PathBuf>) -> (Sessions, Result<(), String>) {
        let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
        let js = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), r"\..\tests\fixtures\flow-fake-appserver.mjs"));
        let got = start_node_process(
            Arc::clone(&sessions),
            "run1:n1".into(),
            "run1".into(),
            "n1".into(),
            1,
            "codex-default".into(),
            "handshake".into(),
            repo_root(),
            tool_allowlist,
            "default".into(),
            RunnerSpec::Codex { js, home, bare: None },
            Vec::new(),
            Box::new(|_| {}),
        );
        (sessions, got)
    }

    #[test]
    fn codex_mcp_bad_name_fails_before_spawn() {
        let (sessions, got) = start_codex_direct(vec!["mcp__v.probe__echo".to_string()], None);
        let err = got.expect_err("a dotted server name must fail the node");
        assert!(err.contains("mcp__v.probe__echo"), "{err}");
        assert!(lock(&sessions).is_empty(), "nothing may spawn");
    }

    /// A server missing from the Codex config fails before spawn (Codex itself would exit
    /// before `initialize` on the override's transport-less table).
    #[test]
    fn codex_mcp_unknown_server_fails_before_spawn() {
        let home = std::env::temp_dir().join(format!("vidar-flow-unknown-server-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("config.toml"), "[mcp_servers.okprobe]\ncommand = \"node\"\n").unwrap();
        let (sessions, got) = start_codex_direct(
            vec!["mcp__okprobe__echo_probe".to_string(), "mcp__vnosuch__t".to_string()],
            Some(home.clone()),
        );
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(got.unwrap_err(), "MCP server \"vnosuch\" is unavailable: not in Codex config.toml");
        assert!(lock(&sessions).is_empty(), "nothing may spawn");
    }

    #[test]
    fn codex_mcp_argv_carries_the_approval_override() {
        let h = start_codex("argv", vec!["Bash".to_string(), "mcp__okprobe__echo_probe".to_string()]);
        let done = terminal(&h.rx);
        assert!(matches!(done.status, FlowRunNodeStatus::Ok), "{:?}", done.error);
        assert_eq!(done.text.as_deref(), Some("-c mcp_servers.okprobe.tools.echo_probe.approval_mode=\"approve\""));
    }

    fn mcp_card_then(allow: bool) -> FlowNodeEventPayload {
        let h = start_codex("mcp-call", vec![]);
        let pause = recv_until(&h.rx, Duration::from_secs(5), |e| {
            matches!(e.status, FlowRunNodeStatus::AwaitingApproval)
        })
        .expect("a non-allowlisted MCP tool call must show a card");
        let permission = pause.permission.expect("permission payload");
        assert_eq!(permission.id, "codex:102");
        assert_eq!(permission.tool, "mcp__okprobe__echo_probe");
        assert_eq!(permission.tool_use_id.as_deref(), Some("exec-1"));
        assert_eq!(permission.input, serde_json::json!({ "text": "hi" }));
        flow_answer_permission(state(&h), h.run_id.clone(), h.node_id.clone(), permission.id, allow)
            .expect("answer permission");
        terminal(&h.rx)
    }

    #[test]
    fn codex_mcp_tool_call_elicitation_is_a_card_and_answers_in_shape() {
        let allowed = mcp_card_then(true);
        assert_eq!(allowed.text.as_deref(), Some(r#"{"action":"accept"}"#));
        let denied = mcp_card_then(false);
        assert_eq!(denied.text.as_deref(), Some(r#"{"action":"decline"}"#));
    }

    /// Codex's argv override covers allowlisted tools, so an elicitation that still arrives is
    /// never auto-accepted on Vidar's side: it shows a card like any other.
    #[test]
    fn codex_mcp_allowlisted_tool_call_elicitation_still_shows_a_card() {
        let h = start_codex("mcp-call", vec!["mcp__okprobe__echo_probe".to_string()]);
        let pause = recv_until(&h.rx, Duration::from_secs(5), |e| {
            matches!(e.status, FlowRunNodeStatus::AwaitingApproval)
        })
        .expect("an MCP tool-call elicitation must always show a card");
        let permission = pause.permission.expect("permission payload");
        assert_eq!(permission.tool, "mcp__okprobe__echo_probe");
        flow_answer_permission(state(&h), h.run_id.clone(), h.node_id.clone(), permission.id, false)
            .expect("answer permission");
        assert_eq!(terminal(&h.rx).text.as_deref(), Some(r#"{"action":"decline"}"#));
    }

    /// Two calls in flight on one server, one allowlisted: the card names the tool the
    /// elicitation's arguments match, and nothing auto-accepts.
    #[test]
    fn codex_mcp_two_calls_in_flight_card_names_the_right_tool() {
        let h = start_codex("mcp-call-2", vec!["mcp__okprobe__echo".to_string()]);
        let pause = recv_until(&h.rx, Duration::from_secs(5), |e| {
            matches!(e.status, FlowRunNodeStatus::AwaitingApproval)
        })
        .expect("the delete call must show a card");
        let permission = pause.permission.expect("permission payload");
        assert_eq!(permission.id, "codex:104");
        assert_eq!(permission.tool, "mcp__okprobe__delete");
        assert_eq!(permission.tool_use_id.as_deref(), Some("exec-1"));
        assert_eq!(permission.input, serde_json::json!({ "path": "x" }));
        flow_answer_permission(state(&h), h.run_id.clone(), h.node_id.clone(), permission.id, false)
            .expect("answer permission");
        assert_eq!(terminal(&h.rx).text.as_deref(), Some(r#"{"action":"decline"}"#));
    }

    #[test]
    fn codex_other_elicitation_is_still_declined() {
        let h = start_codex("elicit-form", vec![]);
        let events = collect_until_terminal(&h.rx, Duration::from_secs(10));
        assert!(
            !events.iter().any(|e| matches!(e.status, FlowRunNodeStatus::AwaitingApproval)),
            "a form elicitation must never pause",
        );
        assert_eq!(events.last().and_then(|e| e.text.as_deref()), Some(r#"{"action":"decline"}"#));
    }
}
