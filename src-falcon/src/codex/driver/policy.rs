//! Codex app-server policy per session mode, read from the contract the
//! in-process adapter reads too (`contracts/codex-policy.json`,
//! `src/agents/codex-permissions.ts`), so a hosted thread starts under the
//! same approval policy, reviewer and sandbox as an in-process one.

use serde_json::{Map, Value};
use std::sync::OnceLock;

fn contract() -> &'static Value {
    static CONTRACT: OnceLock<Value> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!("../../../../contracts/codex-policy.json"))
            .expect("contracts/codex-policy.json is JSON")
    })
}

/// Every permission mode the contract names.
pub fn modes() -> Vec<&'static str> {
    contract()["modes"]
        .as_object()
        .map(|modes| modes.keys().map(String::as_str).collect())
        .unwrap_or_default()
}

/// The mode's `approvalPolicy`, `approvalsReviewer` and `sandbox`, or `Err`
/// for a mode the contract does not name (never a default: a guessed sandbox
/// is a wider one).
pub fn thread_policy(mode: &str) -> Result<Map<String, Value>, String> {
    let entry = contract()
        .pointer(&format!("/modes/{mode}"))
        .and_then(Value::as_object)
        .ok_or_else(|| format!("Codex has no policy for permission mode {mode:?}"))?;
    let mut policy = Map::new();
    for key in ["approvalPolicy", "approvalsReviewer", "sandbox"] {
        let value = entry
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("Codex policy for {mode:?} has no {key}"))?;
        policy.insert(key.into(), Value::String(value.into()));
    }
    Ok(policy)
}

/// `thread/start` and `thread/resume` params: cwd, the mode's policy, and the
/// pinned model if any. Same shape as the TS `threadParams`.
pub fn thread_params(
    cwd: &str,
    mode: &str,
    model: Option<&str>,
) -> Result<Map<String, Value>, String> {
    let mut params = Map::new();
    params.insert("cwd".into(), Value::String(cwd.into()));
    params.extend(thread_policy(mode)?);
    if let Some(model) = model.filter(|model| !model.is_empty()) {
        params.insert("model".into(), Value::String(model.into()));
    }
    Ok(params)
}

/// `turn/start` policy: the mode's `approvalPolicy` and `approvalsReviewer`,
/// and `sandboxPolicy.type` mapped from its thread sandbox through
/// `turnSandbox`. Same shape as the TS `codexTurnPolicy`.
pub fn turn_policy(mode: &str) -> Result<Map<String, Value>, String> {
    let mut policy = thread_policy(mode)?;
    let sandbox = policy.remove("sandbox").unwrap_or(Value::Null);
    let turn_sandbox = sandbox
        .as_str()
        .and_then(|sandbox| contract().pointer(&format!("/turnSandbox/{sandbox}")))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Codex policy has no turn sandbox for {sandbox}"))?;
    policy.insert(
        "sandboxPolicy".into(),
        serde_json::json!({ "type": turn_sandbox }),
    );
    Ok(policy)
}

pub fn reviewer_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("review") || lower.contains("approval")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The golden both languages check: `tests/falcon-codex-policy.test.mjs`
    /// builds the same cases through the TS `threadParams`.
    #[test]
    fn rust_builds_the_thread_params_the_shared_fixture_pins() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/falcon-codex/thread-params.json"
        ))
        .unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let built = thread_params(
                case["cwd"].as_str().unwrap(),
                case["mode"].as_str().unwrap(),
                case["model"].as_str(),
            )
            .unwrap();
            assert_eq!(Value::Object(built), case["params"], "{case}");
        }
    }

    #[test]
    fn every_permission_mode_has_a_policy_and_no_other_does() {
        let modes: Vec<String> =
            serde_json::from_str(include_str!("../../../../contracts/permission-modes.json"))
                .unwrap();
        for mode in &modes {
            thread_policy(mode).unwrap();
        }
        let named = contract()["modes"].as_object().unwrap();
        assert_eq!(named.len(), modes.len());
        assert!(thread_policy("bypassPermissions").is_err());
    }

    #[test]
    fn turn_policy_maps_the_thread_sandbox_like_the_ts_turn_policy() {
        assert_eq!(
            Value::Object(turn_policy("plan").unwrap()),
            serde_json::json!({
                "approvalPolicy": "on-request",
                "approvalsReviewer": "user",
                "sandboxPolicy": { "type": "readOnly" }
            })
        );
        assert_eq!(
            turn_policy("auto").unwrap()["sandboxPolicy"],
            serde_json::json!({ "type": "workspaceWrite" })
        );
        assert!(turn_policy("bypassPermissions").is_err());
    }
}
