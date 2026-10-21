//! src-tauri\src\control\session.rs — `ctl.state`: Vidar's own tab registry
//! lives in the frontend (`sessions.ts`), so this just hands the request to
//! it and lets `src\control\listen.ts` answer through `control_result`.
//! `read`/`prompt`/`spawn` land here in slice B; `spawn`/`prompt` details
//! carry `notify`/`report`/`deliver_to` (falcon-crew W1a).

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::policy::Requester;
use crate::open::valid_reason;

pub fn state(app: &AppHandle, id: &str, requester: &Requester, payload: &Value) -> Result<(), String> {
    let want_json = payload.get("json").and_then(Value::as_bool).unwrap_or(false);
    app.emit("ctl-state", json!({ "id": id, "json": want_json, "requester": requester.to_json() }))
        .map_err(|e| e.to_string())
}

pub fn read(app: &AppHandle, id: &str, requester: &Requester, payload: &Value) -> Result<(), String> {
    let bytes = payload.get("bytes").and_then(Value::as_u64).unwrap_or(4000).min(64_000);
    app.emit("ctl-read", json!({ "id": id, "bytes": bytes, "requester": requester.to_json() }))
        .map_err(|e| e.to_string())
}

/// Prompt text bound (bytes): arbitrary agent input, not a UI label, so no
/// ASCII rule; only a size cap and no NUL.
const MAX_TEXT: usize = 65_536;

fn valid_text(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_TEXT && !s.contains('\0')
}

/// Optional `valid_reason`-bounded string field: absent/null is `None`.
fn opt_reason<'a>(payload: &'a Value, key: &str) -> Result<Option<&'a str>, String> {
    match payload.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_str().filter(|s| valid_reason(s)).map(Some).ok_or_else(|| format!("bad {key}")),
    }
}

/// `notify`: absent/null is `false`; present must be a bool.
fn parse_notify(payload: &Value) -> Result<bool, String> {
    match payload.get("notify") {
        None | Some(Value::Null) => Ok(false),
        Some(v) => v.as_bool().ok_or_else(|| "bad notify".to_string()),
    }
}

/// The requester's tab id, as already resolved (`policy::resolve` +
/// `attach_hosted_tab`); a Falcon session with no known tab gives `null`.
fn deliver_to(requester: &Requester) -> Option<&str> {
    match requester {
        Requester::Token(tab) => Some(tab),
        Requester::FalconSession { tab, .. } => tab.as_deref(),
    }
}

/// `ctl.prompt` details: `{ tab, text, notify, report, deliver_to }`.
/// Unknown payload keys are dropped by construction.
fn prompt_details(requester: &Requester, payload: &Value) -> Result<Value, String> {
    let tab = payload.get("tab").and_then(Value::as_str).filter(|s| !s.is_empty())
        .ok_or_else(|| "bad tab".to_string())?;
    let text = payload.get("text").and_then(Value::as_str).filter(|s| valid_text(s))
        .ok_or_else(|| "bad text".to_string())?;
    let notify = parse_notify(payload)?;
    let report = super::wait::parse_report(payload)?;
    Ok(json!({ "tab": tab, "text": text, "notify": notify, "report": report, "deliver_to": deliver_to(requester) }))
}

/// `ctl.spawn` details: `{ agent, model, effort, cwd, text, title, brief, notify,
/// report, deliver_to }` (`brief` is display only); absent optionals serialise as `null`, `notify` as a bool.
/// `agent`/`model`/`cwd`/`title`/`brief` use `open.rs::valid_reason`, `report` the
/// `wait.rs` rule. Unknown payload keys are dropped by construction.
fn spawn_details(requester: &Requester, payload: &Value) -> Result<Value, String> {
    let agent = payload.get("agent").and_then(Value::as_str).filter(|s| valid_reason(s))
        .ok_or_else(|| "bad agent".to_string())?;
    let model = opt_reason(payload, "model")?;
    let cwd = opt_reason(payload, "cwd")?;
    let effort = match payload.get("effort") {
        None | Some(Value::Null) => None,
        Some(v) => {
            let levels: Vec<&str> = serde_json::from_str(include_str!("../../../contracts/effort-levels.json"))
                .expect("contracts/effort-levels.json is a JSON array of strings");
            Some(v.as_str().filter(|s| levels.contains(s)).ok_or_else(|| "bad effort".to_string())?)
        }
    };
    let text = match payload.get("text") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_str().filter(|s| valid_text(s)).ok_or_else(|| "bad text".to_string())?),
    };
    let title = opt_reason(payload, "title")?;
    let brief = opt_reason(payload, "brief")?;
    let notify = parse_notify(payload)?;
    let report = super::wait::parse_report(payload)?;
    Ok(json!({
        "agent": agent, "model": model, "effort": effort, "cwd": cwd, "text": text, "title": title,
        "brief": brief, "notify": notify, "report": report, "deliver_to": deliver_to(requester),
    }))
}

/// `ctl.prompt`: validates (`prompt_details`), then parks behind the approval
/// card (`card::request`) with the real details shape.
pub fn prompt(app: &AppHandle, id: &str, requester: &Requester, payload: &Value) -> Result<(), String> {
    let details = prompt_details(requester, payload)?;
    super::card::request(app, id, requester, "prompt", details)
}

/// `ctl.spawn`: validates (`spawn_details`), then parks behind the approval
/// card with the composed args as `details`. The card is the only gate, and
/// nothing here registers a wait.
pub fn spawn(app: &AppHandle, id: &str, requester: &Requester, payload: &Value) -> Result<(), String> {
    let details = spawn_details(requester, payload)?;
    super::card::request(app, id, requester, "spawn", details)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_validation() {
        let me = Requester::Token("tab-9".into());
        let big = "a".repeat(MAX_TEXT + 1);
        let refused: Vec<(&str, Value)> = vec![
            ("spawn empty text", json!({ "agent": "test-agent", "text": "" })),
            ("spawn 65537 B text", json!({ "agent": "test-agent", "text": big })),
            ("spawn NUL text", json!({ "agent": "test-agent", "text": "a\0b" })),
            ("spawn bad title", json!({ "agent": "test-agent", "title": "\u{7f}bad" })),
            ("spawn bad brief", json!({ "agent": "test-agent", "brief": "\u{7f}bad" })),
            ("spawn bad report", json!({ "agent": "test-agent", "report": "a\nb" })),
            ("spawn bad notify", json!({ "agent": "test-agent", "notify": "yes" })),
            ("spawn bogus effort", json!({ "agent": "test-agent", "effort": "bogus" })),
        ];
        for (name, p) in &refused {
            assert!(spawn_details(&me, p).is_err(), "{name} should be refused");
        }
        let prompt_refused: Vec<(&str, Value)> = vec![
            ("prompt empty text", json!({ "tab": "t", "text": "" })),
            ("prompt 65537 B text", json!({ "tab": "t", "text": big })),
            ("prompt NUL text", json!({ "tab": "t", "text": "\0" })),
            ("prompt bad report", json!({ "tab": "t", "text": "x", "report": "r".repeat(401) })),
        ];
        for (name, p) in &prompt_refused {
            assert!(prompt_details(&me, p).is_err(), "{name} should be refused");
        }

        let full = json!({
            "agent": "test-agent", "model": "opus", "effort": "xhigh", "cwd": "C:/x", "text": "go", "title": "Lane 1",
            "brief": "docs/b.md", "notify": true, "report": "docs/r.md", "extra": 1, "deliver_to": "tab-evil",
        });
        assert_eq!(spawn_details(&me, &full).unwrap(), json!({
            "agent": "test-agent", "model": "opus", "effort": "xhigh", "cwd": "C:/x", "text": "go", "title": "Lane 1",
            "brief": "docs/b.md", "notify": true, "report": "docs/r.md", "deliver_to": "tab-9",
        }));
        let bare = spawn_details(&me, &json!({ "agent": "test-agent" })).unwrap();
        assert_eq!(bare, json!({
            "agent": "test-agent", "model": null, "effort": null, "cwd": null, "text": null, "title": null,
            "brief": null, "notify": false, "report": null, "deliver_to": "tab-9",
        }));
        let p = prompt_details(&me, &json!({ "tab": "t", "text": "hi", "junk": true, "deliver_to": "tab-evil" })).unwrap();
        assert_eq!(p, json!({ "tab": "t", "text": "hi", "notify": false, "report": null, "deliver_to": "tab-9" }));
    }
}
