//! Everything Claude-specific in a FLOW node run: the sidecar path and spawn, executable and env
//! resolution, the prompt line, and the sidecar's stdin/stdout line protocol (permission
//! requests, `result`, `sidecar` lines) mapped onto `FlowChild` state and node events.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::child::{
    cap_text, emit_event, fail_child, maybe_close_stdin, send_raw, FlowChild, Job, RunnerSpec, OUTPUT_CAP_BYTES,
};
use super::env::{
    apply_env_plan, build_node_env, registry_gateway_model, registry_value, resolve_executables, EnvPlan,
};
use super::{FlowPermissionPayload, FlowRunNodeStatus};
use crate::bare::Env;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// §4.1/§4.3 step 4: live text events are throttled to at most 4 Hz per node.
const THROTTLE: Duration = Duration::from_millis(250);

/// The registry module whose `agent.flow.script` is the Claude sidecar (the claude pack).
const CLAUDE_MODULE: &str = "claude";

/// Production's runner spec: the sidecar the listed claude module declares in `agent.flow.script`
/// (validated as one of its own `owns` files), under the Vidar root.
/// The sidecar runs on the home the node's vault builds (`bare/flow_vault.rs`): its payload, plugins
/// and MCP file ride the stage args, and Err with u1's string when a Claude model has no login there.
/// Gateway stages load the vault through the same `admit_hosted` path.
pub(super) fn spec(need: super::bare::Need, vault: &str, tab: &str) -> Result<RunnerSpec, String> {
    let node = crate::bare::flow_vault::claude_node(vault, tab)?;
    super::bare::verify_login(&node.config_dir, need)?;
    let registry = serde_json::to_value(crate::modules::listed()).map_err(|e| e.to_string())?;
    let script = flow_script_from(&registry, CLAUDE_MODULE).ok_or("Claude module not installed: no flow script")?;
    Ok(spec_from(node, script_path(&crate::paths::root(), &script)))
}

fn spec_from(node: crate::bare::flow_vault::ClaudeNode, sidecar: PathBuf) -> RunnerSpec {
    RunnerSpec::Claude { sidecar, env: Some(node.env), args: node.args, warnings: node.warnings }
}

/// The Claude agent, named by the one module id this file holds.
pub(super) fn agent() -> crate::agent_spec::Agent {
    crate::agent_spec::parse(CLAUDE_MODULE).expect("the claude module id is an agent id")
}

/// Pure: `agent.flow.script` of module `id` in a serialized `modules_list` result.
fn flow_script_from(registry: &Value, id: &str) -> Option<String> {
    registry
        .get("modules")?
        .as_array()?
        .iter()
        .find(|m| m.get("id").and_then(Value::as_str) == Some(id))?
        .get("agent")?
        .get("flow")?
        .get("script")?
        .as_str()
        .map(str::to_string)
}

/// A repo-relative `/` path joined under `root` one segment at a time.
fn script_path(root: &Path, script: &str) -> PathBuf {
    script.split('/').fold(root.to_path_buf(), |p, seg| p.join(seg))
}

/// Spawns the Claude sidecar: resolves node and claude executables, builds the scrubbed env
/// plan, then runs the sidecar under a Job Object.
pub(super) fn spawn(
    sidecar: &Path,
    model: &str,
    cwd: &str,
    permission_mode: &str,
    extra_args: &[String],
    bare_env: Option<&Env>,
) -> Result<(Child, Job), String> {
    let (node_exe, claude_exe) = resolve_executables()?;
    // Names only (values are never needed for the scrub); vars_os avoids
    // std::env::vars()'s panic on a non-Unicode value.
    let inherited: HashMap<String, String> = std::env::vars_os()
        .map(|(k, _)| (k.to_string_lossy().into_owned(), String::new()))
        .collect();
    let env_plan = build_node_env(model, &inherited, &registry_value, &registry_gateway_model)?;
    spawn_sidecar(sidecar, &node_exe, &claude_exe, cwd, model, permission_mode, &env_plan, extra_args, bare_env)
}

/// §4.3 step 3: the one prompt line written to the sidecar's stdin.
pub(super) fn prompt_line(prompt: &str) -> Value {
    serde_json::json!({ "type": "user", "content": prompt })
}

/// §4.3 step 6 (a): the interrupt line cancel writes before closing stdin.
pub(super) fn send_interrupt(child: &FlowChild) {
    send_raw(child, &serde_json::json!({ "type": "interrupt" }));
}

/// §4.3 step 4 permission_request handling: writes one `permission_response` line.
pub(super) fn send_permission_response(child: &FlowChild, id: &str, allow: bool, message: Option<&str>) {
    let mut obj = serde_json::json!({
        "type": "permission_response",
        "id": id,
        "behavior": if allow { "allow" } else { "deny" },
    });
    if let Some(m) = message {
        obj["message"] = Value::String(m.to_string());
    }
    send_raw(child, &obj);
}

fn extract_text_blocks(value: &Value) -> String {
    let mut s = String::new();
    if let Some(blocks) = value.pointer("/message/content").and_then(Value::as_array) {
        for b in blocks {
            if b.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(t) = b.get("text").and_then(Value::as_str) {
                    s.push_str(t);
                }
            }
        }
    }
    s
}

/// §4.3 step 4: auto-deny AskUserQuestion/ExitPlanMode, auto-allow anything in the
/// node's tool_allowlist, else queue it and surface `awaiting-approval`.
fn handle_permission_request(child: &Arc<FlowChild>, tool_allowlist: &[String], value: &Value) {
    let Some(id) = value.get("id").and_then(Value::as_str).map(str::to_string) else { return };
    let tool_use_id = value.get("toolUseId").and_then(Value::as_str).map(str::to_string);
    let tool = value.get("tool").and_then(Value::as_str).unwrap_or("").to_string();
    let input = value.get("input").cloned().unwrap_or(Value::Null);
    let suggestions = value
        .get("suggestions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    if tool == "AskUserQuestion" || tool == "ExitPlanMode" {
        send_permission_response(child, &id, false, Some("No user in a flow; decide and continue"));
        return;
    }
    if tool_allowlist.iter().any(|t| t == &tool) {
        send_permission_response(child, &id, true, None);
        return;
    }
    if let Ok(mut pending) = child.pending.lock() {
        pending.insert(id.clone());
    }
    let payload = FlowPermissionPayload { id, tool_use_id, tool, input, suggestions };
    emit_event(child, FlowRunNodeStatus::AwaitingApproval, None, None, None, Some(payload));
}

/// The server of an exact `mcp__<server>__<tool>` allowlist entry.
fn mcp_server_of(entry: &str) -> Option<&str> {
    let rest = entry.strip_prefix("mcp__")?;
    let (server, tool) = rest.split_once("__")?;
    (!server.is_empty() && !tool.is_empty()).then_some(server)
}

/// The allowlist's MCP servers, deduplicated in order.
fn required_mcp_servers(tool_allowlist: &[String]) -> Vec<&str> {
    let mut seen: Vec<&str> = Vec::new();
    for server in tool_allowlist.iter().filter_map(|t| mcp_server_of(t)) {
        if !seen.contains(&server) {
            seen.push(server);
        }
    }
    seen
}

/// The sidecar's `--require-mcp` argument for the allowlist's MCP servers, or nothing when it has
/// none. The sidecar then holds the first prompt until they connect: a user- or project-scope server
/// is still `pending` at the CLI's first turn, which would run without its tools.
pub(super) fn required_mcp_args(tool_allowlist: &[String]) -> Vec<String> {
    let servers = required_mcp_servers(tool_allowlist);
    if servers.is_empty() {
        return Vec::new();
    }
    vec!["--require-mcp".to_string(), Value::from(servers).to_string()]
}

/// Pure: checks the SDK `system/init` message against the allowlist's MCP servers. Returns the
/// error text for the first required server that is missing or not `connected`. With the sidecar's
/// `--require-mcp` wait in front, a `pending` here means the wait did not run.
fn unavailable_mcp_server(tool_allowlist: &[String], init: &Value) -> Option<String> {
    let reported = init.get("mcp_servers").and_then(Value::as_array);
    for server in required_mcp_servers(tool_allowlist) {
        let entry = reported.and_then(|a| {
            a.iter().find(|s| s.get("name").and_then(Value::as_str) == Some(server))
        });
        match entry {
            None => return Some(format!("MCP server \"{server}\" is unavailable: not reported by the SDK")),
            Some(s) => {
                let status = s.get("status").and_then(Value::as_str).unwrap_or("unknown");
                if status != "connected" {
                    return Some(format!("MCP server \"{server}\" is unavailable: status {status}"));
                }
            }
        }
    }
    None
}

fn maybe_emit_text(child: &FlowChild, live_text: &str, last_emit: &mut Instant) {
    if last_emit.elapsed() < THROTTLE {
        return;
    }
    *last_emit = Instant::now();
    let capped = cap_text(live_text, OUTPUT_CAP_BYTES);
    emit_event(child, FlowRunNodeStatus::Running, Some(capped), None, None, None);
}

/// Reads the child's stdout line by line on its own thread (§4.3 step 4). Node
/// output text is exactly: concatenated `text` blocks of top-level assistant
/// messages (`parent_tool_use_id == null`), in arrival order; everything else
/// (`stream_event`, `system`, `user`/tool_result, tool_use JSON, subagent
/// messages, `effort`, `rate_limit_event`, `sidecar` ready/models/closed) is
/// never stored.
pub(super) fn forward_stdout(stdout: impl Read, child: &Arc<FlowChild>, tool_allowlist: &[String]) {
    let mut live_text = String::new();
    let mut last_assistant: Option<String> = None;
    let mut started = false;
    let mut last_emit = Instant::now() - THROTTLE;
    let mut reader = BufReader::new(stdout);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        // `BufRead::lines()` returns `Err` on a non-UTF-8 line and the
        // old `let Ok(line) = line else { break }` treated that the same as a real I/O error —
        // one malformed line silently stopped reading the rest of the attempt's stdout, including
        // its eventual `result`. `read_until` plus `from_utf8_lossy` tolerates a bad line instead;
        // only a real read error (or EOF) ends the loop.
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
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
        match value.get("type").and_then(Value::as_str).unwrap_or("") {
            "assistant" => {
                let top_level = value
                    .get("parent_tool_use_id")
                    .map(Value::is_null)
                    .unwrap_or(true);
                if !top_level {
                    continue;
                }
                let text = extract_text_blocks(&value);
                if text.is_empty() {
                    continue;
                }
                if !live_text.is_empty() {
                    live_text.push('\n');
                }
                live_text.push_str(&text);
                last_assistant = Some(text);
                if let Ok(mut g) = child.live_text.lock() {
                    *g = live_text.clone();
                }
                maybe_emit_text(child, &live_text, &mut last_emit);
            }
            "permission_request" => handle_permission_request(child, tool_allowlist, &value),
            "result" => {
                let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("");
                let is_error = value
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(subtype != "success");
                let cost = value.get("total_cost_usd").and_then(Value::as_f64);
                // Flow's sidecar runs with SDK session persistence on (no `--no-session-persistence`), so the call
                // also leaves a transcript. Not under test: `paths::root()` would be the checkout's own runtime folder.
                #[cfg(not(test))]
                crate::usage_ledger::append(&crate::paths::usage_ledger_path(), &crate::usage_ledger::from_claude_result(&value, "flow", true, None));
                let final_text = if subtype == "success" {
                    value.get("result").and_then(Value::as_str).map(str::to_string)
                } else {
                    last_assistant.clone()
                };
                if is_error {
                    let first_err = value
                        .get("errors")
                        .and_then(Value::as_array)
                        .and_then(|a| a.first())
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let mut reason = if subtype.is_empty() {
                        "result error".to_string()
                    } else {
                        format!("result {subtype}")
                    };
                    if let Some(e) = first_err {
                        reason.push_str(": ");
                        reason.push_str(&e);
                    }
                    if let Ok(mut g) = child.result_error_reason.lock() {
                        *g = Some(reason);
                    }
                }
                if let Ok(mut g) = child.is_error.lock() {
                    *g = Some(is_error);
                }
                if let Ok(mut g) = child.cost_usd.lock() {
                    *g = cost;
                }
                if let Ok(mut g) = child.final_text.lock() {
                    *g = final_text;
                }
                // A result ends the single turn, so no permission
                // can still be live afterward — an SDK-aborted canUseTool that the
                // sidecar resolved locally without a stdout line would otherwise
                // leave a stale id in `pending` and block `maybe_close_stdin` forever.
                if let Ok(mut pending) = child.pending.lock() {
                    pending.clear();
                }
                child.result_seen.store(true, Ordering::SeqCst);
                maybe_close_stdin(child);
            }
            "system" => {
                if value.get("subtype").and_then(Value::as_str) == Some("init") {
                    if let Some(message) = unavailable_mcp_server(tool_allowlist, &value) {
                        fail_child(child, message);
                        break;
                    }
                }
            }
            "sidecar" => {
                let subtype = value.get("subtype").and_then(Value::as_str);
                if subtype == Some("mcp_unavailable") {
                    // The sidecar's --require-mcp wait ended without the server; it exits after this line.
                    let message = value
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("MCP server is unavailable")
                        .to_string();
                    fail_child(child, message);
                    break;
                }
                if subtype == Some("error") {
                    // Most sidecar error lines are not fatal and the
                    // node may still end Ok; never flip status mid-run on this alone.
                    // Hold it for reap() to fold into the terminal event only if the
                    // run actually ends in Error.
                    let message = value
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("sidecar error")
                        .to_string();
                    if let Ok(mut g) = child.sidecar_error.lock() {
                        *g = Some(message);
                    }
                }
            }
            _ => {} // stream_event / system / user (tool_result) / tool_use / subagent / effort / rate_limit_event
        }
    }
}

/// The spawn primitive: takes the sidecar path as a parameter (production's fixed
/// repo path, or the transport test's fixture) so the process-spawn shape is one
/// piece of code for both. `extra_args` lets the transport test pass `--hang`. With `bare_env`
/// the child gets exactly that env plus the plan's `set` entries, nothing of Vidar's own.
#[allow(clippy::too_many_arguments)] // one per spawn input, as start_node_process
fn spawn_sidecar(
    sidecar: &Path,
    node_exe: &Path,
    claude_exe: &Path,
    cwd: &str,
    model: &str,
    permission_mode: &str,
    env_plan: &EnvPlan,
    extra_args: &[String],
    bare_env: Option<&Env>,
) -> Result<(Child, Job), String> {
    let mut cmd = sidecar_command(sidecar, node_exe, claude_exe, cwd, model, permission_mode, env_plan, extra_args, bare_env);
    let job = Job::new()?;
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    if let Err(error) = job.assign(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("assign flow job: {error}"));
    }
    Ok((child, job))
}

/// The sidecar's command line and env, unspawned: fixed args, then `extra_args` (the stage's
/// payload/servers args and `--require-mcp`, or a test's `--hang`).
#[allow(clippy::too_many_arguments)] // as spawn_sidecar
fn sidecar_command(
    sidecar: &Path,
    node_exe: &Path,
    claude_exe: &Path,
    cwd: &str,
    model: &str,
    permission_mode: &str,
    env_plan: &EnvPlan,
    extra_args: &[String],
    bare_env: Option<&Env>,
) -> Command {
    let mut cmd = Command::new(node_exe);
    cmd.arg(sidecar)
        .arg("--cwd")
        .arg(cwd)
        .arg("--model")
        .arg(model)
        .arg("--permission-mode")
        .arg(permission_mode)
        .arg("--claude")
        .arg(claude_exe)
        .args(extra_args)
        .current_dir(cwd)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match bare_env {
        Some(env) => super::bare::apply_claude_env(&mut cmd, env, env_plan),
        None => apply_env_plan(&mut cmd, env_plan),
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shipped claude pack names the sidecar the Flow runner spawns.
    #[test]
    fn sidecar_comes_from_the_claude_pack_flow_script() {
        let pack: Value = serde_json::from_str(include_str!("../../../content/packs/claude/pack.json")).unwrap();
        let registry = serde_json::json!({ "modules": [{ "id": "codex" }, pack["module"].clone()] });
        let script = flow_script_from(&registry, CLAUDE_MODULE).expect("claude flow script");
        assert_eq!(script, "tools/claude-sidecar.mjs");
        assert_eq!(script_path(Path::new(r"C:\R"), &script), PathBuf::from(r"C:\R\tools\claude-sidecar.mjs"));
        assert_eq!(flow_script_from(&serde_json::json!({ "modules": [{ "id": "codex" }] }), CLAUDE_MODULE), None);
    }

    fn allow(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|s| s.to_string()).collect()
    }

    /// The sidecar learns the allowlist's servers, deduplicated in order; none means no argument.
    #[test]
    fn required_mcp_args_name_each_server_once() {
        let list = allow(&["mcp__proxy__a", "Read", "mcp__proxy__b", "mcp__rider__c"]);
        assert_eq!(required_mcp_args(&list), vec!["--require-mcp".to_string(), r#"["proxy","rider"]"#.to_string()]);
        assert!(required_mcp_args(&allow(&["Read", "mcp__bad"])).is_empty());
    }

    /// The sidecar argv for a node: the fixed args, then the vault home's stage args (`--flow
    /// --profile .. --root .. --home ..`, never `--flow-payload` or `--mcp-servers`), then `--require-mcp`.
    #[test]
    fn spawn_args_name_the_vault_home_and_no_flow_payload() {
        let stage: Vec<String> = [
            "--flow", "--profile", "bare", "--root", r"C:\V", "--home", r"C:\H", "--payload", r"C:\H\layer\payload-0123456789ab.md",
            "--set-plugin", r"C:\V\plugins\p", "--mcp-file", r"C:\H\layer\mcp-0123456789ab.json",
        ]
        .map(String::from)
        .into();
        let mut extra = stage.clone();
        extra.extend(required_mcp_args(&allow(&["mcp__proxy__a"])));
        let cmd = sidecar_command(
            Path::new(r"C:\V\tools\claude-sidecar.mjs"),
            Path::new(r"C:\n\node.exe"),
            Path::new(r"C:\c\claude.exe"),
            r"C:\w",
            "m",
            "auto",
            &EnvPlan::default(),
            &extra,
            None,
        );
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        let fixed = [r"C:\V\tools\claude-sidecar.mjs", "--cwd", r"C:\w", "--model", "m", "--permission-mode", "auto", "--claude", r"C:\c\claude.exe"];
        let mut want: Vec<String> = fixed.iter().map(|s| s.to_string()).collect();
        want.extend(stage);
        want.extend(["--require-mcp".to_string(), r#"["proxy"]"#.to_string()]);
        assert_eq!(args, want);
        assert!(!args.iter().any(|a| a == "--flow-payload" || a == "--mcp-servers"));
    }

    /// The spec's argv is the one `flow_vault` builds: `--flow` first, the vault home after `--home`.
    #[test]
    fn the_spec_adds_the_flow_marker_ahead_of_the_profile() {
        let node = crate::bare::flow_vault::ClaudeNode {
            env: Env::default(),
            args: ["--flow", "--profile", "bare", "--root", r"C:\V", "--home", r"C:\H"].map(String::from).into(),
            config_dir: PathBuf::from(r"C:\H\claude-homes\0123456789ab"),
            warnings: vec!["w".into()],
        };
        let RunnerSpec::Claude { args, warnings, env, .. } = spec_from(node, PathBuf::from("s.mjs")) else { panic!("a Claude spec") };
        assert_eq!(args[..3], ["--flow", "--profile", "bare"]);
        assert_eq!(args[5], "--home");
        assert_eq!(warnings, ["w"]);
        assert!(env.is_some());
    }

    /// The init backstop: connected passes; pending (the wait did not run) or failed fails in the same shape.
    #[test]
    fn init_check_fails_on_any_status_but_connected() {
        let list = allow(&["mcp__proxy__a"]);
        let init = |status: &str| serde_json::json!({ "mcp_servers": [{ "name": "proxy", "status": status }] });
        assert_eq!(unavailable_mcp_server(&list, &init("connected")), None);
        assert_eq!(
            unavailable_mcp_server(&list, &init("failed")).as_deref(),
            Some("MCP server \"proxy\" is unavailable: status failed")
        );
        assert_eq!(
            unavailable_mcp_server(&list, &init("pending")).as_deref(),
            Some("MCP server \"proxy\" is unavailable: status pending")
        );
    }
}
