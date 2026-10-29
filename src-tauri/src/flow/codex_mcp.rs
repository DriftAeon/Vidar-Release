//! Per-node MCP servers for a Codex Flow node.
//!
//! Selection: the node's permission allowlist entries `mcp__<server>__<tool>`, split as the
//! Claude runner does (`claude.rs` `mcp_server_of`). Each entry becomes one argv override
//! `-c mcp_servers.<server>.tools.<tool>.approval_mode="approve"`, so the allowlisted tool runs
//! without an approval under `approvalPolicy: "untrusted"`. Names go into a dotted config key,
//! so both must match `^[A-Za-z0-9_-]+$` or the node fails before spawn.
//!
//! Config: a server the node's Codex config lacks fails the node before spawn. The override
//! alone creates an `mcp_servers.<s>` table with no transport, and Codex 0.162.1 then exits
//! before `initialize` with "invalid transport" (probed 2026-10-15).
//!
//! Readiness: after `thread/start`, one `mcpServerStatus/list {threadId, serverName}` per
//! required server (never unfiltered: that waits on and restarts every configured server).
//! The filtered list blocks until the server settles, and Codex bounds startup itself (30 s, or
//! the server's `startup_timeout_sec`), so the Vidar-side timeout per call is that bound + 5 s.
//!
//! Approvals: every MCP tool call Codex asks about arrives as `mcpServer/elicitation/request`
//! with `_meta.codex_approval_kind == "mcp_tool_call"` and always becomes a permission card
//! shaped like the Claude runner's MCP card (tool `mcp__<server>__<tool>`, input = the tool
//! arguments). Allowlisted tools never ask: the argv override approves them inside Codex.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use crate::codex_config::CodexConfig;

/// The list timeout when the config sets no `startup_timeout_sec` (Codex's own 30 s + 5 s).
pub(super) const LIST_TIMEOUT: Duration = Duration::from_secs(35);
/// Slack over the server's own `startup_timeout_sec`, so Codex's timer always fires first.
const LIST_SLACK_SECS: u64 = 5;
pub(super) const ELICITATION: &str = "mcpServer/elicitation/request";
/// Cap on Codex-supplied error text before it joins a node error.
const ERROR_CAP_BYTES: usize = 1024;

/// Per-server Vidar-side list timeouts; a server missing here uses `LIST_TIMEOUT`.
pub(super) type ListTimeouts = HashMap<String, Duration>;

pub(super) fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// `(server, tool)` of an `mcp__<server>__<tool>` entry; `None` for any other entry.
fn split(entry: &str) -> Option<(&str, &str)> {
    let rest = entry.strip_prefix("mcp__")?;
    let (server, tool) = rest.split_once("__")?;
    (!server.is_empty() && !tool.is_empty()).then_some((server, tool))
}

/// Every MCP entry of the allowlist, deduplicated in order. Errors on the first entry whose
/// server or tool name could not be passed safely as a `-c` key.
fn entries(tool_allowlist: &[String]) -> Result<Vec<(String, String)>, String> {
    let mut out: Vec<(String, String)> = Vec::new();
    for entry in tool_allowlist {
        // Not an exact `mcp__<server>__<tool>` entry: no server, as in the Claude runner.
        let Some((server, tool)) = split(entry) else { continue };
        if !valid_name(server) || !valid_name(tool) {
            return Err(bad_entry(entry));
        }
        let pair = (server.to_string(), tool.to_string());
        if !out.contains(&pair) {
            out.push(pair);
        }
    }
    Ok(out)
}

fn bad_entry(entry: &str) -> String {
    format!("MCP allowlist entry \"{entry}\" is not valid for Codex: server and tool names may use only letters, digits, _ and -")
}

/// The argv overrides for the node's allowlisted MCP tools; called before spawn, so a bad name
/// fails the node with nothing started.
pub(super) fn approval_args(tool_allowlist: &[String]) -> Result<Vec<String>, String> {
    Ok(entries(tool_allowlist)?
        .into_iter()
        .flat_map(|(s, t)| ["-c".to_string(), format!("mcp_servers.{s}.tools.{t}.approval_mode=\"approve\"")])
        .collect())
}

/// The servers `turn/start` waits on, in allowlist order. Invalid entries were refused before
/// spawn, so they are simply skipped here.
pub(super) fn required_servers(tool_allowlist: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (server, _) in entries(tool_allowlist).unwrap_or_default() {
        if !out.contains(&server) {
            out.push(server);
        }
    }
    out
}

/// Pre-spawn: reads the node's Codex config (the home layer, plus `<cwd>\.codex\config.toml`
/// when present) and fails on the first required server neither layer defines. Returns each
/// server's list timeout. No home, or a home config that cannot be read, skips the check:
/// Codex then reports its own config error. A server in `carried` (passed per spawn by
/// `flow/bare.rs`) counts as defined, with the default list timeout.
pub(super) fn preflight(home: Option<&Path>, cwd: &str, tool_allowlist: &[String], carried: &[String]) -> Result<ListTimeouts, String> {
    let (carried_here, servers): (Vec<String>, Vec<String>) =
        required_servers(tool_allowlist).into_iter().partition(|s| carried.contains(s));
    let mut out: ListTimeouts = carried_here.into_iter().map(|s| (s, LIST_TIMEOUT)).collect();
    if servers.is_empty() {
        return Ok(out);
    }
    let Some(home) = home else { return Ok(out) };
    let Ok(home_layer) = crate::codex_config::read(home) else { return Ok(out) };
    let project_layer = crate::codex_config::read(&Path::new(cwd).join(".codex")).ok().flatten();
    let layers: Vec<CodexConfig> = project_layer.into_iter().chain(home_layer).collect();
    out.extend(list_timeouts(&servers, &layers)?);
    Ok(out)
}

/// Pure: per-server timeouts from the config layers (first layer wins), or the unavailable
/// error for the first server no layer defines.
fn list_timeouts(servers: &[String], layers: &[CodexConfig]) -> Result<ListTimeouts, String> {
    let mut out = ListTimeouts::new();
    for server in servers {
        let found = layers.iter().find(|c| c.mcp_servers.iter().any(|m| m.name == *server));
        let Some(found) = found else {
            return Err(format!("MCP server \"{server}\" is unavailable: not in Codex config.toml"));
        };
        // Same pin rule as the Rack: an unpinned package runner is never spawned. Every server
        // here is required by the node's allowlist, so a refusal fails the node.
        if let Some(entry) = found.mcp_servers.iter().find(|m| m.name == *server) {
            if entry.transport == "stdio" {
                if let Some(reason) = crate::mcp::pin::unpinned_runner(&entry.target, &entry.args) {
                    return Err(format!("MCP server \"{server}\" is refused: {reason}"));
                }
            }
        }
        let startup = found.mcp_startup_timeout_sec.get(server).copied();
        let timeout = match startup.filter(|s| s.is_finite() && *s >= 0.0) {
            Some(secs) => Duration::from_secs(secs.ceil() as u64 + LIST_SLACK_SECS),
            None => LIST_TIMEOUT,
        };
        out.insert(server.clone(), timeout);
    }
    Ok(out)
}

pub(super) fn list_params(thread_id: &str, server: &str) -> Value {
    json!({ "threadId": thread_id, "serverName": server })
}

/// Pure: the readiness verdict for one server from its filtered `mcpServerStatus/list` result.
/// Only `connected` passes; `toolsError` rides along as the reason when Codex gives one.
pub(super) fn readiness(server: &str, result: &Value) -> Result<(), String> {
    let entry = result
        .get("data")
        .and_then(Value::as_array)
        .and_then(|a| a.iter().find(|s| s.get("name").and_then(Value::as_str) == Some(server)));
    let Some(entry) = entry else {
        return Err(format!("MCP server \"{server}\" is unavailable: not reported by Codex"));
    };
    let status = entry.get("runtimeStatus").and_then(Value::as_str).unwrap_or("no status");
    if status == "connected" {
        return Ok(());
    }
    match entry.get("toolsError").and_then(Value::as_str).filter(|e| !e.trim().is_empty()) {
        Some(why) => Err(format!("MCP server \"{server}\" is unavailable: {status}: {}", cap_error(why))),
        None => Err(format!("MCP server \"{server}\" is unavailable: {status}")),
    }
}

/// Codex-supplied error text, capped before it joins a node error.
pub(super) fn cap_error(text: &str) -> String {
    super::child::cap_text(text, ERROR_CAP_BYTES)
}

pub(super) fn timed_out(server: &str, timeout: Duration) -> String {
    format!("MCP server \"{server}\" is unavailable: no status from Codex after {} s", timeout.as_secs())
}

/// True for the elicitation Codex sends to approve one MCP tool call.
pub(super) fn is_tool_call(params: &Value) -> bool {
    params.pointer("/_meta/codex_approval_kind").and_then(Value::as_str) == Some("mcp_tool_call")
}

/// One in-flight mcpToolCall from `item/started`.
pub(super) struct StartedCall {
    id: String,
    server: String,
    tool: String,
    arguments: Value,
}

/// Every in-flight mcpToolCall (started, not yet completed). The elicitation carries no item id
/// or tool name, so `card` pairs it by server and arguments.
pub(super) type StartedCalls = Vec<StartedCall>;

/// A JSON-encoded string argument payload compares as the value it encodes.
fn normalized(v: &Value) -> Value {
    match v {
        Value::String(s) => serde_json::from_str(s).unwrap_or_else(|_| v.clone()),
        Value::Null => json!({}),
        other => other.clone(),
    }
}

/// Records an `item/started` item when it is an mcpToolCall.
pub(super) fn note_started(started: &mut StartedCalls, item: &Value) {
    if item.get("type").and_then(Value::as_str) != Some("mcpToolCall") {
        return;
    }
    let field = |k: &str| item.get(k).and_then(Value::as_str).map(str::to_string);
    if let (Some(id), Some(server), Some(tool)) = (field("id"), field("server"), field("tool")) {
        let arguments = normalized(item.get("arguments").unwrap_or(&Value::Null));
        started.retain(|c| c.id != id);
        started.push(StartedCall { id, server, tool, arguments });
    }
}

/// Drops the call an `item/completed` item ends (any item type; ids are unique).
pub(super) fn note_completed(started: &mut StartedCalls, item: &Value) {
    if let Some(id) = item.get("id").and_then(Value::as_str) {
        started.retain(|c| c.id != id);
    }
}

/// The card for an `mcp_tool_call` elicitation, shaped like the Claude runner's MCP card:
/// `(tool "mcp__<server>__<tool>", input = the tool arguments, item id)`. It pairs only when
/// exactly one in-flight call has this server and these arguments; otherwise the tool is
/// `mcp__<server>` with no item id (the card names only the server), never a guess.
pub(super) fn card(params: &Value, started: &StartedCalls) -> (String, Value, Option<String>) {
    let server = params.get("serverName").and_then(Value::as_str).unwrap_or("");
    let meta = params.get("_meta");
    let tool_params = meta.and_then(|m| m.get("tool_params")).filter(|v| !v.is_null());
    let mut matches = started.iter().filter(|c| {
        c.server == server && tool_params.is_some_and(|p| normalized(p) == c.arguments)
    });
    let paired = match (matches.next(), matches.next()) {
        (Some(only), None) => Some(only),
        _ => None,
    };
    let tool = match paired {
        Some(call) => format!("mcp__{server}__{}", call.tool),
        None => format!("mcp__{server}"),
    };
    let input = tool_params
        .or_else(|| meta.and_then(|m| m.get("tool_params_display").filter(|v| !v.is_null())))
        .cloned()
        .unwrap_or(json!({}));
    (tool, input, paired.map(|c| c.id.clone()))
}

/// The elicitation answer. `action` is the schema's only required field; a bare accept ran the
/// tool on 0.162.1, as did one with an empty form (both probed live), so no form is sent.
pub(super) fn answer(allow: bool) -> Value {
    json!({ "action": if allow { "accept" } else { "decline" } })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn allowlist_becomes_one_approval_override_per_tool() {
        let args = approval_args(&list(&["Bash", "mcp__vprobe__echo_probe", "mcp__vprobe__echo_probe", "mcp__a-b__t_2"])).unwrap();
        assert_eq!(
            args,
            list(&[
                "-c",
                "mcp_servers.vprobe.tools.echo_probe.approval_mode=\"approve\"",
                "-c",
                "mcp_servers.a-b.tools.t_2.approval_mode=\"approve\"",
            ])
        );
        assert!(approval_args(&list(&["Bash", "Edit"])).unwrap().is_empty());
        assert_eq!(required_servers(&list(&["mcp__b__x", "mcp__a__y", "mcp__b__z"])), list(&["b", "a"]));
    }

    #[test]
    fn names_outside_the_key_charset_are_refused() {
        for bad in ["mcp__v.probe__echo", "mcp__vprobe__echo\"x", "mcp__v probe__t", "mcp__vprobe__a=b"] {
            let err = approval_args(&list(&["Bash", bad])).unwrap_err();
            assert!(err.contains(bad), "{bad}: {err}");
        }
        // Not a server/tool entry at all: skipped, as the Claude runner skips it.
        assert!(approval_args(&list(&["mcp__vprobe__", "mcp__x"])).unwrap().is_empty());
    }

    #[test]
    fn readiness_follows_the_runtime_status() {
        let ok = json!({ "data": [{ "name": "vprobe", "runtimeStatus": "connected", "toolsError": null }] });
        assert_eq!(readiness("vprobe", &ok), Ok(()));
        assert_eq!(
            readiness("vnever", &json!({ "data": [], "nextCursor": null })).unwrap_err(),
            "MCP server \"vnever\" is unavailable: not reported by Codex"
        );
        let failed = json!({ "data": [{ "name": "vdead", "runtimeStatus": "failed", "toolsError": "MCP startup failed: x" }] });
        assert_eq!(readiness("vdead", &failed).unwrap_err(), "MCP server \"vdead\" is unavailable: failed: MCP startup failed: x");
        for status in ["cancelled", "disabled", "authenticationRequired", "starting"] {
            let v = json!({ "data": [{ "name": "s", "runtimeStatus": status }] });
            assert_eq!(readiness("s", &v).unwrap_err(), format!("MCP server \"s\" is unavailable: {status}"));
        }
        let null = json!({ "data": [{ "name": "s", "runtimeStatus": null }] });
        assert_eq!(readiness("s", &null).unwrap_err(), "MCP server \"s\" is unavailable: no status");
    }

    #[test]
    fn card_pairs_the_started_call_and_uses_the_tool_params() {
        let mut started = StartedCalls::new();
        note_started(&mut started, &json!({ "type": "agentMessage", "id": "m" }));
        note_started(
            &mut started,
            &json!({ "type": "mcpToolCall", "id": "exec-1", "server": "vprobe", "tool": "echo_probe", "arguments": { "text": "hi" } }),
        );
        let params = json!({
            "serverName": "vprobe",
            "_meta": { "codex_approval_kind": "mcp_tool_call", "tool_params": { "text": "hi" },
                       "tool_params_display": [{ "name": "text", "value": "hi" }] },
            "message": "Allow?",
        });
        assert!(is_tool_call(&params));
        let (tool, input, item) = card(&params, &started);
        assert_eq!(tool, "mcp__vprobe__echo_probe");
        assert_eq!(input, json!({ "text": "hi" }));
        assert_eq!(item.as_deref(), Some("exec-1"));
        let (tool, _, item) = card(&json!({ "serverName": "other" }), &started);
        assert_eq!((tool.as_str(), item), ("mcp__other", None));
        assert!(!is_tool_call(&json!({ "serverName": "vprobe", "_meta": null })));
    }

    fn elicitation(server: &str, tool_params: Value) -> Value {
        json!({ "serverName": server, "_meta": { "codex_approval_kind": "mcp_tool_call", "tool_params": tool_params } })
    }

    fn started_call(id: &str, server: &str, tool: &str, arguments: Value) -> Value {
        json!({ "type": "mcpToolCall", "id": id, "server": server, "tool": tool, "arguments": arguments })
    }

    /// Two calls in flight on one server: the elicitation's arguments pick the right one.
    #[test]
    fn card_pairs_by_arguments_with_two_calls_in_flight() {
        let mut started = StartedCalls::new();
        note_started(&mut started, &started_call("exec-1", "s", "delete", json!({ "path": "x" })));
        note_started(&mut started, &started_call("exec-2", "s", "echo", json!({ "text": "hi" })));
        let (tool, input, item) = card(&elicitation("s", json!({ "path": "x" })), &started);
        assert_eq!((tool.as_str(), item.as_deref()), ("mcp__s__delete", Some("exec-1")));
        assert_eq!(input, json!({ "path": "x" }));
        let (tool, _, item) = card(&elicitation("s", json!({ "text": "hi" })), &started);
        assert_eq!((tool.as_str(), item.as_deref()), ("mcp__s__echo", Some("exec-2")));
        // A JSON-string argument payload compares as the value it encodes.
        note_started(&mut started, &started_call("exec-3", "s", "read", json!(r#"{"n":1}"#)));
        let (tool, _, _) = card(&elicitation("s", json!({ "n": 1 })), &started);
        assert_eq!(tool, "mcp__s__read");
    }

    /// No match, or more than one: the card names only the server, with no item id.
    #[test]
    fn card_never_guesses() {
        let mut started = StartedCalls::new();
        note_started(&mut started, &started_call("exec-1", "s", "echo", json!({ "text": "hi" })));
        let (tool, _, item) = card(&elicitation("s", json!({ "text": "other" })), &started);
        assert_eq!((tool.as_str(), item), ("mcp__s", None));
        let (tool, _, item) = card(&elicitation("t", json!({ "text": "hi" })), &started);
        assert_eq!((tool.as_str(), item), ("mcp__t", None));
        note_started(&mut started, &started_call("exec-2", "s", "shout", json!({ "text": "hi" })));
        let (tool, _, item) = card(&elicitation("s", json!({ "text": "hi" })), &started);
        assert_eq!((tool.as_str(), item), ("mcp__s", None));
    }

    #[test]
    fn completed_call_is_cleared() {
        let mut started = StartedCalls::new();
        note_started(&mut started, &started_call("exec-1", "s", "echo", json!({ "text": "hi" })));
        note_started(&mut started, &started_call("exec-2", "s", "shout", json!({ "text": "hi" })));
        note_completed(&mut started, &json!({ "type": "mcpToolCall", "id": "exec-2" }));
        assert_eq!(started.len(), 1);
        let (tool, _, item) = card(&elicitation("s", json!({ "text": "hi" })), &started);
        assert_eq!((tool.as_str(), item.as_deref()), ("mcp__s__echo", Some("exec-1")));
        note_completed(&mut started, &json!({ "type": "mcpToolCall", "id": "exec-1" }));
        assert!(started.is_empty());
    }

    fn config(toml: &str) -> CodexConfig {
        crate::codex_config::parse(toml, None).unwrap()
    }

    #[test]
    fn list_timeouts_follow_startup_timeout_sec_and_refuse_unknown_servers() {
        let home = config("[mcp_servers.a]\ncommand = \"a\"\nstartup_timeout_sec = 7.5\n[mcp_servers.b]\nurl = \"http://x\"\n");
        let project = config("[mcp_servers.b]\ncommand = \"b\"\nstartup_timeout_sec = 60\n");
        let got = list_timeouts(&list(&["a", "b"]), &[project, home.clone()]).unwrap();
        assert_eq!(got["a"], Duration::from_secs(13));
        assert_eq!(got["b"], Duration::from_secs(65));
        let got = list_timeouts(&list(&["b"]), &[home.clone()]).unwrap();
        assert_eq!(got["b"], LIST_TIMEOUT);
        assert_eq!(
            list_timeouts(&list(&["a", "vnosuch"]), &[home]).unwrap_err(),
            "MCP server \"vnosuch\" is unavailable: not in Codex config.toml"
        );
        assert_eq!(timed_out("a", Duration::from_secs(13)), "MCP server \"a\" is unavailable: no status from Codex after 13 s");
    }

    #[test]
    fn list_timeouts_refuse_unpinned_runners_only() {
        let cfg = config(
            "[mcp_servers.bad]\ncommand = \"npx\"\nargs = [\"-y\", \"foo\"]\n\
             [mcp_servers.pinned]\ncommand = \"npx\"\nargs = [\"-y\", \"foo@1.2.3\"]\n\
             [mcp_servers.plain]\ncommand = \"node\"\nargs = [\"server.js\"]\n\
             [mcp_servers.web]\nurl = \"http://x\"\n",
        );
        let err = list_timeouts(&list(&["bad"]), &[cfg.clone()]).unwrap_err();
        assert!(err.starts_with("MCP server \"bad\" is refused: "), "{err}");
        assert!(list_timeouts(&list(&["pinned", "plain", "web"]), &[cfg]).is_ok());
    }

    #[test]
    fn preflight_reads_the_home_config() {
        let dir = std::env::temp_dir().join(format!("vidar-flow-preflight-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.toml"), "[mcp_servers.okprobe]\ncommand = \"node\"\n").unwrap();
        let cwd = dir.display().to_string();
        let ok = preflight(Some(&dir), &cwd, &list(&["mcp__okprobe__echo"]), &[]).unwrap();
        assert_eq!(ok["okprobe"], LIST_TIMEOUT);
        let err = preflight(Some(&dir), &cwd, &list(&["mcp__okprobe__echo", "mcp__vnosuch__t"]), &[]).unwrap_err();
        assert_eq!(err, "MCP server \"vnosuch\" is unavailable: not in Codex config.toml");
        // A server carried per spawn counts as defined.
        let carried = preflight(Some(&dir), &cwd, &list(&["mcp__okprobe__echo", "mcp__wiki__t"]), &list(&["wiki"])).unwrap();
        assert_eq!(carried["wiki"], LIST_TIMEOUT);
        assert_eq!(carried["okprobe"], LIST_TIMEOUT);
        // No MCP entries, or no home: nothing to check.
        assert!(preflight(Some(&dir), &cwd, &list(&["Bash"]), &[]).unwrap().is_empty());
        assert!(preflight(None, &cwd, &list(&["mcp__vnosuch__t"]), &[]).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tools_error_is_capped() {
        let long = "x".repeat(5000);
        let failed = json!({ "data": [{ "name": "s", "runtimeStatus": "failed", "toolsError": long }] });
        let err = readiness("s", &failed).unwrap_err();
        assert!(err.len() < 1200, "{}", err.len());
        assert!(err.starts_with("MCP server \"s\" is unavailable: failed: [truncated]"), "{err}");
    }

    #[test]
    fn answers_accept_or_decline() {
        assert_eq!(answer(true), json!({ "action": "accept" }));
        assert_eq!(answer(false), json!({ "action": "decline" }));
    }
}
