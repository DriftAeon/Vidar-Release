//! Flow control boundary: bounded, allowlisted start; separate observe routes.
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use super::{card, policy::Requester};

const MAX_REQUEST: usize = 65_536;
fn checked<'a>(payload: &'a Value, action: &str) -> Result<&'a serde_json::Map<String, Value>, String> {
    let map = payload.as_object().ok_or("bad flow payload")?;
    if serde_json::to_vec(payload).map_err(|_| "bad flow payload")?.len() > MAX_REQUEST { return Err("flow request exceeds 65536 bytes".into()); }
    let allowed: &[&str] = match action {
        "start" => &["action", "template_id", "input", "graph", "cwd", "token", "falcon_session", "secret"],
        "save" => &["action", "graph", "cwd", "token", "falcon_session", "secret"],
        "status" => &["run_id", "token", "falcon_session", "secret"],
        "wait" => &["run_id", "timeout_ms", "token", "falcon_session", "secret"],
        _ => return Err("bad flow action".into()),
    };
    if map.keys().any(|k| !allowed.contains(&k.as_str())) { return Err("unknown flow field".into()); }
    Ok(map)
}

pub fn start(app: &AppHandle, id: &str, requester: &Requester, payload: &Value) -> Result<(), String> {
    let map = checked(payload, "start")?;
    if map.get("action").and_then(Value::as_str) != Some("start") { return Err("bad flow action".into()); }
    let cwd = map.get("cwd").and_then(Value::as_str).filter(|s| !s.is_empty() && !s.contains('\0')).ok_or("bad cwd")?;
    if cwd.len() > 4096 { return Err("bad cwd".into()); }
    let details = match (map.get("template_id"), map.get("input"), map.get("graph")) {
        (Some(Value::String(template_id)), Some(Value::String(input)), None)
            if !template_id.is_empty() && !input.is_empty() && !input.contains('\0') => json!({"action":"start", "template_id": template_id, "input": input, "cwd": cwd}),
        (None, None, Some(graph)) if graph.is_object() => json!({"action":"start", "graph": graph, "cwd": cwd}),
        _ => return Err("choose one graph or template with Input".into()),
    };
    card::request(app, id, requester, "flow", details)
}

/// Save-only: no card. The frontend prepares, validates and commits the graph, then replies.
pub fn save(app: &AppHandle, id: &str, requester: &Requester, payload: &Value) -> Result<(), String> {
    let map = checked(payload, "save")?;
    if map.get("action").and_then(Value::as_str) != Some("save") { return Err("bad flow action".into()); }
    let cwd = map.get("cwd").and_then(Value::as_str).filter(|s| !s.is_empty() && !s.contains('\0') && s.len() <= 4096).ok_or("bad cwd")?;
    let graph = map.get("graph").filter(|g| g.is_object()).ok_or("save needs a graph")?;
    app.emit("ctl-flow-save", json!({ "id": id, "graph": graph, "cwd": cwd, "requester": requester.to_json() }))
        .map_err(|e| e.to_string())
}

pub fn observe(app: &AppHandle, id: &str, requester: &Requester, payload: &Value, wait: bool) -> Result<(), String> {
    let map = checked(payload, if wait { "wait" } else { "status" })?;
    let run_id = map.get("run_id").and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 64
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')).ok_or("bad run id")?;
    let timeout_ms = if wait { super::wait::timeout_ms(payload) } else { 0 };
    app.emit(if wait { "ctl-flow-wait" } else { "ctl-flow-status" }, json!({
        "id": id, "runId": run_id, "timeoutMs": timeout_ms,
        "root": crate::paths::flow_store_dir().to_string_lossy(), "requester": requester.to_json()
    })).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allowlist_and_bounds() {
        assert!(checked(&json!({"action":"start","graph":{},"cwd":"C:\\x","evil":1}), "start").is_err());
        assert!(checked(&json!({"action":"start","input":"x".repeat(65536)}), "start").is_err());
        assert!(checked(&json!({"run_id":"r","extra":true}), "status").is_err());
        assert!(checked(&json!({"action":"save","graph":{},"cwd":"C:\\x"}), "save").is_ok());
        assert!(checked(&json!({"action":"save","graph":{},"cwd":"C:\\x","input":"x"}), "save").is_err());
    }
}
