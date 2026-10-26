//! Everything Codex-specific in a FLOW node run: `node <codex.js> app-server` spawn, the
//! JSON-RPC handshake (`initialize` → `initialized` → `thread/start` → `turn/start`), the
//! app-server event map onto `FlowChild` state and node events, and the answers to its
//! server requests. Shapes mirror `src/agents/codex-permissions.ts`, `codex-methods.ts` and
//! `codex-requests.ts` (pinned to app-server 0.162.1).
//!
//! Approvals: the thread runs `approvalPolicy: "untrusted"` with sandbox `workspace-write`,
//! so commands and file changes surface as Flow permission cards like a Claude node off its
//! allowlist. The node's Bash and Edit allowlist entries auto-accept, but never a request that
//! asks to leave the sandbox (`is_escalation`), and never `item/permissions/requestApproval`.
//! MCP servers named in the allowlist load per node (`codex_mcp`): a pre-spawn config check,
//! argv approval overrides, a filtered readiness list before `turn/start`, and a card for
//! every MCP tool call Codex asks about (allowlisted tools never ask).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::child::{
    cap_text, emit_event, lock, maybe_close_stdin, send_raw, FlowChild, Job, RunnerSpec,
    OUTPUT_CAP_BYTES,
};
use super::codex_mcp::{self, StartedCalls};
use super::env::{apply_env_plan, EnvPlan};
use super::{FlowPermissionPayload, FlowRunNodeStatus};
use crate::bare::Env;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Same 4 Hz live-text throttle as the Claude runner.
const THROTTLE: Duration = Duration::from_millis(250);
/// The Flow model id that sends no `model`, so the app-server uses its configured default.
pub(super) const DEFAULT_MODEL: &str = "codex-default";
/// Stricter than the Codex tab's `on-request`: commands and file changes ask first.
const APPROVAL_POLICY: &str = "untrusted";
const SANDBOX: &str = "workspace-write";

/// Per-child JSON-RPC state: our own request ids, the thread/turn ids the handshake learns, the
/// node inputs `turn/start` needs, and the open server requests keyed by permission id
/// (`codex:<json-rpc id>`), each keeping its raw id, method and params for the answer shape.
#[derive(Default)]
pub(super) struct Rpc {
    next_id: u64,
    calls: HashMap<u64, &'static str>,
    prompt: String,
    cwd: String,
    model: Option<String>,
    thread_id: Option<String>,
    turn_id: Option<String>,
    requests: HashMap<String, ServerRequest>,
    /// Open `mcpServerStatus/list` calls (our id → server); `turn/start` waits until empty.
    mcp_lists: HashMap<u64, String>,
    /// Per-server list timeouts from the pre-spawn config check.
    list_timeouts: codex_mcp::ListTimeouts,
}

impl Rpc {
    pub(super) fn with_list_timeouts(list_timeouts: codex_mcp::ListTimeouts) -> Self {
        Rpc { list_timeouts, ..Rpc::default() }
    }
}

struct ServerRequest {
    id: Value,
    method: String,
    params: Value,
}

/// Production's runner spec: every Codex node runs on Flow's own Bare home, `flow-codex` (run
/// 2026-10-19-codex-primary U2; W2-L2d), never the user's default `~\.codex` nor a rune set's
/// home, with a fresh control token for its config's `vidar_drive` server.
pub(super) fn spec(cwd: &str) -> Result<RunnerSpec, String> {
    super::bare::codex_spec(&super::bare::mint_ctl_token()?, cwd)
}

/// Spawns `node <js> app-server` under a Job Object. On the Bare home (`bare`: its `node` and
/// env) the child gets exactly that env; otherwise Vidar's env minus `SCRUBBED_ENV` and the tab
/// markers. No gateway env either way (Codex brings its own login).
pub(super) fn spawn(js: &Path, cwd: &str, extra_args: &[String], bare: Option<(&Path, &Env)>) -> Result<(Child, Job), String> {
    // Same guard as Codex tabs: never the user profile (or a parent) as the workspace.
    crate::codex_cwd::refuse_home_cwd(Path::new(cwd))?;
    let node = match bare {
        Some((node, _)) => node.to_path_buf(),
        None => crate::which::find_on_path_exact("node.exe").ok_or("node.exe not found on PATH")?,
    };
    let mut remove: Vec<String> = crate::pty::SCRUBBED_ENV.iter().map(|s| s.to_string()).collect();
    remove.extend(["VIDAR_TAB", "VIDAR_TAB_NAME"].map(String::from));
    let plan = EnvPlan { remove, set: Vec::new() };
    let mut cmd = Command::new(node);
    cmd.arg(js)
        .arg("app-server")
        .args(extra_args)
        .current_dir(cwd)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match bare {
        Some((_, env)) => {
            cmd.env_clear();
            for (k, v) in env.iter() {
                cmd.env(k, v);
            }
        }
        None => apply_env_plan(&mut cmd, &plan),
    }
    let job = Job::new()?;
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    if let Err(error) = job.assign(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("assign flow job: {error}"));
    }
    Ok((child, job))
}

/// Allocates one of our request ids and builds the request line (not yet written).
fn request_line(child: &FlowChild, method: &'static str, params: Value) -> Value {
    let id = {
        let mut rpc = lock(&child.rpc);
        rpc.next_id += 1;
        let id = rpc.next_id;
        rpc.calls.insert(id, method);
        id
    };
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

fn request(child: &FlowChild, method: &'static str, params: Value) {
    send_raw(child, &request_line(child, method, params));
}

fn respond(child: &FlowChild, id: &Value, result: Value) {
    send_raw(child, &json!({ "jsonrpc": "2.0", "id": id, "result": result }));
}

fn respond_error(child: &FlowChild, id: &Value, message: &str) {
    send_raw(child, &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": message } }));
}

/// The first line written (child.rs's prompt slot): stashes the node inputs `thread/start` and
/// `turn/start` need, then returns `initialize`. The prompt itself rides `turn/start` once the
/// thread exists.
pub(super) fn prompt_line(child: &FlowChild, prompt: &str, cwd: &str, model: &str) -> Value {
    {
        let mut rpc = lock(&child.rpc);
        rpc.prompt = prompt.to_string();
        rpc.cwd = cwd.to_string();
        rpc.model = (!model.trim().is_empty() && model != DEFAULT_MODEL).then(|| model.to_string());
    }
    request_line(
        child,
        "initialize",
        json!({
            "clientInfo": { "name": "vidar-flow", "title": "Vidar Flow", "version": "0.1.0" },
            "capabilities": { "experimentalApi": true },
        }),
    )
}

/// `thread/start` params: cwd, the Flow approval policy and sandbox, and the model if pinned.
/// `ephemeral`: no rollout file, so Flow threads never reach a Resume list (Codex 0.163.0
/// answers `ephemeral: true, path: null`; probed in a scratch home, 2026-10-19).
fn thread_params(rpc: &Rpc) -> Value {
    let mut params = json!({
        "cwd": rpc.cwd,
        "approvalPolicy": APPROVAL_POLICY,
        "approvalsReviewer": "user",
        "sandbox": SANDBOX,
        "ephemeral": true,
    });
    if let Some(model) = &rpc.model {
        params["model"] = Value::String(model.clone());
    }
    params
}

/// Cancel step (a): `turn/interrupt` when a turn is live; stdin closes right after.
pub(super) fn send_interrupt(child: &FlowChild) {
    let ids = {
        let rpc = lock(&child.rpc);
        rpc.thread_id.clone().zip(rpc.turn_id.clone())
    };
    if let Some((thread_id, turn_id)) = ids {
        request(child, "turn/interrupt", json!({ "threadId": thread_id, "turnId": turn_id }));
    }
}

/// `flow_answer_permission`'s Codex arm (the id is already removed from `pending`): answers the
/// held server request in its method's shape.
pub(super) fn send_permission_response(child: &FlowChild, permission_id: &str, allow: bool) {
    let Some(req) = lock(&child.rpc).requests.remove(permission_id) else { return };
    respond(child, &req.id, answer(&req.method, &req.params, allow));
}

fn answer(method: &str, params: &Value, allow: bool) -> Value {
    if method == codex_mcp::ELICITATION {
        return codex_mcp::answer(allow);
    }
    if method == "item/permissions/requestApproval" {
        let permissions = if allow { params.get("permissions").cloned().unwrap_or(json!({})) } else { json!({}) };
        return json!({ "permissions": permissions, "scope": "turn" });
    }
    json!({ "decision": if allow { "accept" } else { "decline" } })
}

fn present(params: &Value, field: &str) -> bool {
    match params.get(field) {
        None | Some(Value::Null) => false,
        Some(Value::String(s)) => !s.trim().is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(_) => true,
    }
}

/// A request that asks for more than the `workspace-write` sandbox: extra permissions, network,
/// a write root, or a stated reason (Codex attaches one to escalation and retry-unsandboxed
/// asks). Such a request is never auto-accepted, whatever the allowlist says.
fn is_escalation(method: &str, params: &Value) -> bool {
    match method {
        "item/commandExecution/requestApproval" => [
            "reason",
            "additionalPermissions",
            "networkApprovalContext",
            "proposedNetworkPolicyAmendments",
        ]
        .iter()
        .any(|f| present(params, f)),
        "item/fileChange/requestApproval" => ["reason", "grantRoot"].iter().any(|f| present(params, f)),
        // Always a card: the pairing to a tool name is a best guess Vidar never approves on, and
        // an allowlisted tool never asks (the argv override approves it inside Codex).
        codex_mcp::ELICITATION => true,
        _ => true,
    }
}

fn permission_key(id: &Value) -> String {
    match id {
        Value::String(s) => format!("codex:{s}"),
        other => format!("codex:{other}"),
    }
}

fn hold_note(child: &FlowChild, note: String) {
    if let Ok(mut g) = child.sidecar_error.lock() {
        *g = Some(note);
    }
}

/// Ends the node from our side: a failed handshake call or a finished turn.
fn finish(child: &Arc<FlowChild>, error: Option<String>, final_text: Option<String>) {
    if let Some(reason) = &error {
        if let Ok(mut g) = child.result_error_reason.lock() {
            *g = Some(reason.clone());
        }
    }
    if let Ok(mut g) = child.is_error.lock() {
        *g = Some(error.is_some());
    }
    if let Ok(mut g) = child.final_text.lock() {
        *g = final_text;
    }
    // The turn is over, so no request can still be answered (same reasoning as the Claude
    // runner's `result`): stale ids must not hold stdin open.
    if let Ok(mut pending) = child.pending.lock() {
        pending.clear();
    }
    lock(&child.rpc).requests.clear();
    child.result_seen.store(true, Ordering::SeqCst);
    maybe_close_stdin(child);
}

/// One server → client request: auto-answers, auto-accepts an allowlisted non-escalating
/// approval, or queues a permission card.
fn handle_server_request(
    child: &Arc<FlowChild>,
    tool_allowlist: &[String],
    id: Value,
    method: &str,
    params: Value,
    changes: &HashMap<String, Value>,
    started: &StartedCalls,
) {
    let mut tool_use_id = params.get("itemId").and_then(Value::as_str).map(str::to_string);
    let (tool, input): (String, Value) = match method {
        // An MCP tool call: always a card shaped like the Claude runner's MCP card.
        codex_mcp::ELICITATION if codex_mcp::is_tool_call(&params) => {
            let (tool, input, item) = codex_mcp::card(&params, started);
            tool_use_id = item;
            (tool, input)
        }
        "item/commandExecution/requestApproval" => (
            "Bash".into(),
            json!({
                "command": params.get("command").cloned().unwrap_or(Value::Null),
                "cwd": params.get("cwd").cloned().unwrap_or(Value::Null),
                "reason": params.get("reason").cloned().unwrap_or(Value::Null),
            }),
        ),
        "item/fileChange/requestApproval" => {
            let item = params.get("itemId").and_then(Value::as_str).unwrap_or("");
            let mut input = json!({ "changes": changes.get(item).cloned().unwrap_or(json!([])) });
            for field in ["reason", "grantRoot"] {
                if present(&params, field) {
                    input[field] = params[field].clone();
                }
            }
            ("Edit".into(), input)
        }
        "item/permissions/requestApproval" => (
            "Permissions".into(),
            json!({
                "permissions": params.get("permissions").cloned().unwrap_or(Value::Null),
                "cwd": params.get("cwd").cloned().unwrap_or(Value::Null),
                "reason": params.get("reason").cloned().unwrap_or(Value::Null),
                "scope": "turn",
            }),
        ),
        // No user in a flow: the same refusals the Codex tab falls back to (codex-methods.ts).
        "item/tool/requestUserInput" => return respond(child, &id, json!({ "answers": {} })),
        // Any other elicitation (a server asking for form input): nobody to fill it in.
        codex_mcp::ELICITATION => return respond(child, &id, json!({ "action": "decline" })),
        "item/tool/call" => {
            return respond(
                child,
                &id,
                json!({ "contentItems": [{ "type": "inputText", "text": "Vidar Flow does not host dynamic tools" }], "success": false }),
            )
        }
        "applyPatchApproval" | "execCommandApproval" => {
            return respond(child, &id, json!({ "decision": { "denied": { "rejection": "Vidar Flow does not support legacy approvals" } } }))
        }
        _ => {
            respond_error(child, &id, &format!("{method} is not supported by Vidar Flow"));
            hold_note(child, format!("refused Codex request {method}"));
            return;
        }
    };
    let allowlisted = tool != "Permissions"
        && tool_allowlist.iter().any(|t| *t == tool)
        && !is_escalation(method, &params);
    if allowlisted {
        return respond(child, &id, answer(method, &params, true));
    }
    let key = permission_key(&id);
    lock(&child.rpc)
        .requests
        .insert(key.clone(), ServerRequest { id, method: method.to_string(), params });
    if let Ok(mut pending) = child.pending.lock() {
        pending.insert(key.clone());
    }
    let payload = FlowPermissionPayload { id: key, tool_use_id, tool, input, suggestions: Vec::new() };
    emit_event(child, FlowRunNodeStatus::AwaitingApproval, None, None, None, Some(payload));
}

/// A response to one of our own requests: advances the handshake, or ends the node when a
/// handshake call fails.
fn handle_response(child: &Arc<FlowChild>, value: &Value, tool_allowlist: &[String]) {
    let Some(id) = value.get("id").and_then(Value::as_u64) else { return };
    let (method, mcp_server) = {
        let mut rpc = lock(&child.rpc);
        let Some(method) = rpc.calls.remove(&id) else { return };
        (method, rpc.mcp_lists.remove(&id))
    };
    if let Some(err) = value.get("error") {
        if method == "turn/interrupt" {
            return;
        }
        let message = err.get("message").and_then(Value::as_str).unwrap_or("error");
        if let Some(server) = mcp_server {
            if child.result_seen.load(Ordering::SeqCst) {
                return;
            }
            let message = codex_mcp::cap_error(message);
            return finish(child, Some(format!("MCP server \"{server}\" is unavailable: {message}")), None);
        }
        let partial = child.live_text.lock().ok().map(|g| g.clone()).filter(|s| !s.is_empty());
        return finish(child, Some(format!("{method} failed: {message}")), partial);
    }
    let result = value.get("result").cloned().unwrap_or(Value::Null);
    match method {
        "initialize" => {
            send_raw(child, &json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }));
            let params = thread_params(&lock(&child.rpc));
            request(child, "thread/start", params);
        }
        "thread/start" => {
            let Some(thread_id) = result.pointer("/thread/id").and_then(Value::as_str).map(str::to_string) else {
                return finish(child, Some("thread/start returned no thread id".to_string()), None);
            };
            lock(&child.rpc).thread_id = Some(thread_id.clone());
            let servers = codex_mcp::required_servers(tool_allowlist);
            if servers.is_empty() {
                return start_turn(child);
            }
            for server in servers {
                list_server(child, &thread_id, server);
            }
        }
        "mcpServerStatus/list" => {
            // The first unavailable server already ended the node; later answers are moot.
            let Some(server) = mcp_server.filter(|_| !child.result_seen.load(Ordering::SeqCst)) else { return };
            if let Err(reason) = codex_mcp::readiness(&server, &result) {
                return finish(child, Some(reason), None);
            }
            let ready = lock(&child.rpc).mcp_lists.is_empty();
            if ready && !child.result_seen.load(Ordering::SeqCst) {
                start_turn(child);
            }
        }
        "turn/start" => {
            if let Some(turn_id) = result.pointer("/turn/id").and_then(Value::as_str) {
                let mut rpc = lock(&child.rpc);
                if rpc.turn_id.is_none() {
                    rpc.turn_id = Some(turn_id.to_string());
                }
            }
        }
        _ => {}
    }
}

/// `turn/start` with the node's prompt, once the thread exists and its MCP servers are ready.
fn start_turn(child: &FlowChild) {
    let (thread_id, prompt) = {
        let rpc = lock(&child.rpc);
        (rpc.thread_id.clone().unwrap_or_default(), rpc.prompt.clone())
    };
    request(child, "turn/start", json!({ "threadId": thread_id, "input": [{ "type": "text", "text": prompt }] }));
}

/// One filtered readiness query, with a watcher that fails the node if Codex never answers
/// within the server's list timeout (5 s past Codex's own startup bound).
fn list_server(child: &Arc<FlowChild>, thread_id: &str, server: String) {
    let line = request_line(child, "mcpServerStatus/list", codex_mcp::list_params(thread_id, &server));
    let Some(id) = line.get("id").and_then(Value::as_u64) else { return };
    let timeout = {
        let mut rpc = lock(&child.rpc);
        rpc.mcp_lists.insert(id, server.clone());
        rpc.list_timeouts.get(&server).copied().unwrap_or(codex_mcp::LIST_TIMEOUT)
    };
    send_raw(child, &line);
    let watched = Arc::clone(child);
    let watch_server = server.clone();
    let spawned = std::thread::Builder::new().name(format!("flow-mcp-list-{id}")).spawn(move || {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
            if watched.result_seen.load(Ordering::SeqCst)
                || watched.canceled.load(Ordering::SeqCst)
                || !lock(&watched.rpc).mcp_lists.contains_key(&id)
            {
                return;
            }
        }
        if lock(&watched.rpc).mcp_lists.remove(&id).is_some() && !watched.result_seen.load(Ordering::SeqCst) {
            finish(&watched, Some(codex_mcp::timed_out(&watch_server, timeout)), None);
        }
    });
    // No watcher means no bound on the wait: end the node now rather than run unbounded.
    if let Err(error) = spawned {
        if lock(&child.rpc).mcp_lists.remove(&id).is_some() && !child.result_seen.load(Ordering::SeqCst) {
            finish(child, Some(format!("MCP server \"{server}\" is unavailable: cannot watch its startup: {error}")), None);
        }
    }
}

fn maybe_emit_text(child: &FlowChild, live_text: &str, last_emit: &mut Instant) {
    if last_emit.elapsed() < THROTTLE {
        return;
    }
    *last_emit = Instant::now();
    emit_event(child, FlowRunNodeStatus::Running, Some(cap_text(live_text, OUTPUT_CAP_BYTES)), None, None, None);
}

/// Reads the app-server's stdout line by line. Node output text is the agent messages of the
/// turn: deltas build the live text, the last completed agent message is the final text.
/// Tool activity, reasoning, token usage and rate-limit lines are never stored; there is no cost.
pub(super) fn forward_stdout(stdout: impl Read, child: &Arc<FlowChild>, tool_allowlist: &[String]) {
    let mut live_text = String::new();
    let mut live_item: Option<String> = None;
    let mut last_agent: Option<String> = None;
    let mut changes: HashMap<String, Value> = HashMap::new();
    let mut mcp_calls = StartedCalls::new();
    let mut started = false;
    let mut last_emit = Instant::now() - THROTTLE;
    let mut reader = BufReader::new(stdout);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = String::from_utf8_lossy(&buf);
        let line = line.trim_end_matches(['\r', '\n']);
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else { continue };
        if !started {
            started = true;
            emit_event(child, FlowRunNodeStatus::Running, None, None, None, None);
        }
        let method = value.get("method").and_then(Value::as_str).map(str::to_string);
        let id = value.get("id").cloned().filter(|v| !v.is_null());
        let params = value.get("params").cloned().unwrap_or(Value::Null);
        match (method, id) {
            (None, Some(_)) => handle_response(child, &value, tool_allowlist),
            (Some(method), Some(id)) => {
                handle_server_request(child, tool_allowlist, id, &method, params, &changes, &mcp_calls)
            }
            (Some(method), None) => match method.as_str() {
                "item/agentMessage/delta" => {
                    let item = params.get("itemId").and_then(Value::as_str).unwrap_or("").to_string();
                    let delta = params.get("delta").and_then(Value::as_str).unwrap_or("");
                    if live_item.as_deref() != Some(item.as_str()) {
                        if !live_text.is_empty() {
                            live_text.push('\n');
                        }
                        live_item = Some(item);
                    }
                    live_text.push_str(delta);
                    if let Ok(mut g) = child.live_text.lock() {
                        *g = live_text.clone();
                    }
                    maybe_emit_text(child, &live_text, &mut last_emit);
                }
                "item/started" => {
                    let item = params.get("item").cloned().unwrap_or(Value::Null);
                    codex_mcp::note_started(&mut mcp_calls, &item);
                    if item.get("type").and_then(Value::as_str) == Some("fileChange") {
                        if let (Some(id), Some(c)) = (item.get("id").and_then(Value::as_str), item.get("changes")) {
                            changes.insert(id.to_string(), c.clone());
                        }
                    }
                }
                "item/completed" => {
                    let item = params.get("item").cloned().unwrap_or(Value::Null);
                    codex_mcp::note_completed(&mut mcp_calls, &item);
                    if item.get("type").and_then(Value::as_str) != Some("agentMessage") {
                        continue;
                    }
                    let text = item.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                    let id = item.get("id").and_then(Value::as_str).unwrap_or("");
                    // A message that arrived whole (no deltas) still joins the live text.
                    if !text.is_empty() && live_item.as_deref() != Some(id) {
                        if !live_text.is_empty() {
                            live_text.push('\n');
                        }
                        live_text.push_str(&text);
                        live_item = Some(id.to_string());
                        if let Ok(mut g) = child.live_text.lock() {
                            *g = live_text.clone();
                        }
                        maybe_emit_text(child, &live_text, &mut last_emit);
                    }
                    if !text.is_empty() {
                        last_agent = Some(text);
                    }
                }
                "turn/started" => {
                    if let Some(turn_id) = params.pointer("/turn/id").and_then(Value::as_str) {
                        lock(&child.rpc).turn_id = Some(turn_id.to_string());
                    }
                }
                "turn/completed" => {
                    let turn = params.get("turn").cloned().unwrap_or(Value::Null);
                    let error = turn_error(&turn);
                    let text = last_agent.clone().or_else(|| (!live_text.is_empty()).then(|| live_text.clone()));
                    finish(child, error, text);
                }
                // Held, never fatal on its own: `willRetry` errors recover, and a fatal one is
                // followed by a failed `turn/completed`.
                "error" => {
                    let message = params.pointer("/error/message").and_then(Value::as_str).unwrap_or("?");
                    let retry = if params.get("willRetry").and_then(Value::as_bool) == Some(true) { " (retrying)" } else { "" };
                    hold_note(child, format!("Codex error: {message}{retry}"));
                }
                // The server withdrew a request (answered elsewhere or its turn ended).
                "serverRequest/resolved" => {
                    let Some(rid) = params.get("requestId") else { continue };
                    let key = permission_key(rid);
                    lock(&child.rpc).requests.remove(&key);
                    let (had, empty) = match child.pending.lock() {
                        Ok(mut p) => (p.remove(&key), p.is_empty()),
                        Err(_) => (false, false),
                    };
                    if had && empty && !child.result_seen.load(Ordering::SeqCst) {
                        emit_event(child, FlowRunNodeStatus::Running, None, None, None, None);
                    }
                }
                _ => {} // tool items, reasoning, usage, rate limits, thread status: not node output
            },
            (None, None) => {}
        }
    }
}

/// The node error for a finished turn: only an explicit `"completed"` status is success, so a
/// missing or non-string status fails rather than passing as Ok.
fn turn_error(turn: &Value) -> Option<String> {
    let Some(status) = turn.get("status").and_then(Value::as_str) else {
        return Some("turn completed without a status".to_string());
    };
    (status != "completed").then(|| match turn.pointer("/error/message").and_then(Value::as_str) {
        Some(m) => format!("turn {status}: {m}"),
        None => format!("turn {status}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flow_threads_are_ephemeral() {
        let rpc = Rpc { cwd: "C:\\w".to_string(), ..Rpc::default() };
        let params = thread_params(&rpc);
        assert_eq!(params["ephemeral"], json!(true));
        assert_eq!(params["sandbox"], json!(SANDBOX));
    }

    #[test]
    fn turn_without_status_is_an_error() {
        assert!(turn_error(&json!({})).is_some());
        assert!(turn_error(&Value::Null).is_some());
        assert!(turn_error(&json!({ "status": 3 })).is_some());
        assert_eq!(turn_error(&json!({ "status": "completed" })), None);
        assert_eq!(
            turn_error(&json!({ "status": "failed", "error": { "message": "boom" } })).as_deref(),
            Some("turn failed: boom")
        );
        assert_eq!(turn_error(&json!({ "status": "interrupted" })).as_deref(), Some("turn interrupted"));
    }

    #[test]
    fn plain_command_ask_is_not_an_escalation() {
        let p = json!({ "command": "git status", "cwd": "C:\\x", "reason": null, "additionalPermissions": null });
        assert!(!is_escalation("item/commandExecution/requestApproval", &p));
    }

    #[test]
    fn escalation_markers_are_each_enough() {
        for field in ["reason", "additionalPermissions", "networkApprovalContext"] {
            let mut p = json!({ "command": "curl x" });
            p[field] = json!("needs network");
            assert!(is_escalation("item/commandExecution/requestApproval", &p), "{field}");
        }
        assert!(is_escalation("item/fileChange/requestApproval", &json!({ "grantRoot": "C:\\" })));
        assert!(is_escalation("item/permissions/requestApproval", &json!({})));
        // An MCP tool-call elicitation always shows a card.
        assert!(is_escalation(codex_mcp::ELICITATION, &json!({ "serverName": "s" })));
    }

    #[test]
    fn answer_shapes_follow_the_method() {
        let perms = json!({ "permissions": { "network": { "enabled": true } } });
        assert_eq!(
            answer("item/permissions/requestApproval", &perms, false),
            json!({ "permissions": {}, "scope": "turn" })
        );
        assert_eq!(
            answer("item/permissions/requestApproval", &perms, true),
            json!({ "permissions": { "network": { "enabled": true } }, "scope": "turn" })
        );
        assert_eq!(answer("item/commandExecution/requestApproval", &json!({}), true), json!({ "decision": "accept" }));
        assert_eq!(answer("item/fileChange/requestApproval", &json!({}), false), json!({ "decision": "decline" }));
        assert_eq!(answer(codex_mcp::ELICITATION, &json!({}), true), json!({ "action": "accept" }));
        assert_eq!(answer(codex_mcp::ELICITATION, &json!({}), false), json!({ "action": "decline" }));
    }

    /// A home-folder cwd fails the node before anything spawns, with the Codex tab's refusal.
    #[test]
    fn home_cwd_is_refused_before_spawn() {
        let Some(home) = crate::paths::home() else { return };
        let got = spawn(Path::new("Q:\\absent\\codex.js"), &home.display().to_string(), &[], None);
        assert_eq!(got.err().as_deref(), Some(crate::codex_cwd::HOME_CWD_REFUSED));
    }

    #[test]
    fn permission_key_prefixes_the_rpc_id() {
        assert_eq!(permission_key(&json!(7)), "codex:7");
        assert_eq!(permission_key(&json!("a1")), "codex:a1");
    }
}
