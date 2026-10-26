//! Golden tests at the host's cross-language seams. The fixtures under tests/golden/ are also read
//! by tests/golden/bridge-golden.test.mjs (the sidecar and the frontend side) and type-checked by
//! tests/golden/shapes.golden.ts, so a shape change on one side fails a test on the other.

use serde_json::Value;

use crate::claude::ClaudeDriver;
use crate::protocol::SessionSummary;

fn golden(text: &str) -> Value {
    serde_json::from_str(text).expect("golden fixture is JSON")
}

/// `list` payload: every golden session parses and serialises back to the same object, so a
/// field renamed, added or dropped on this side no longer matches what the frontend is typed for.
#[test]
fn falcon_list_sessions_round_trip_exactly() {
    let fixture = golden(include_str!("../../tests/golden/falcon-list.json"));
    let sessions = fixture["sessions"].as_array().expect("sessions array");
    assert!(!sessions.is_empty());
    for s in sessions {
        let parsed: SessionSummary =
            serde_json::from_value(s.clone()).expect("SessionSummary parses the golden session");
        assert_eq!(serde_json::to_value(&parsed).unwrap(), *s);
    }
    // The shell's negotiated name is what a Jettisoned session carries in `last_holder`; the
    // frontend's re-adopt skips it (tests/golden/bridge-golden.test.mjs).
    assert_eq!(sessions[1]["last_holder"], crate::falcon_client::CLIENT_NAME);
}

/// The production struct as an exhaustive literal (no `..`): a field added to `SessionSummary`
/// fails to compile here until the fixture's last session (every optional `Some` except `gateway`,
/// which the host refuses beside a profile: the session before it carries that one) carries it too.
#[test]
fn falcon_list_full_session_matches_an_exhaustive_literal() {
    let fixture = golden(include_str!("../../tests/golden/falcon-list.json"));
    let full = fixture["sessions"].as_array().expect("sessions array").last().expect("a session").clone();
    let literal = SessionSummary {
        session: "s-c93d05aa".into(),
        generation: 2,
        agent: "claude".into(),
        cwd: "D:\\work\\third".into(),
        conversation: Some("0a7e3c59-8b2f-4f6d-a1c4-5e9d7b3f2c10".into()),
        pid: 6060,
        model: Some("claude-sonnet-5-5".into()),
        permission_mode: "default".into(),
        attached: 0,
        exited: Some(0),
        queued_prompts: vec!["first".into(), "second".into()],
        pending_permissions: vec!["perm-2".into()],
        degraded: Some("journal append failed".into()),
        last_holder: Some("vidar".into()),
        rules_file: Some("D:\\work\\vidar\\runtime\\rules\\built\\0123456789ab.md".into()),
        tab_name: Some("Amber Raptor".into()),
        // The host refuses a gateway on a profiled session, so the gateway has its own fixture session.
        gateway: None,
        profile: Some("bare".into()),
        env_names: Some(vec!["=C:".into(), "CLAUDE_CONFIG_DIR".into(), "FALCON_SESSION".into(), "Path".into()]),
        payload_file: Some(
            "C:\\Users\\test\\AppData\\Local\\Vidar\\homes\\1c49ff625c89a9b8\\layer\\payload-0123456789ab.md".into(),
        ),
        row_key: Some("claude-bare".into()),
        mcp_file: Some("C:\\Users\\test\\AppData\\Local\\Vidar\\homes\\1c49ff625c89a9b8\\layer\\mcp-0123456789ab.json".into()),
        sets: Some(vec![crate::protocol::SetRef { library: Some("vidar".into()), set: "base".into() }]),
        claude_config_dir: None,
    };
    assert_eq!(serde_json::to_value(&literal).unwrap(), full);
}

/// Sidecar `--falcon` records, replayed in order: each line's effect on the driver is the one the
/// fixture names. An unrecognised field or state is silently ignored here, which is the drift
/// this pins (the sidecar header: "or the record is silently ignored").
#[test]
fn sidecar_falcon_records_drive_the_driver_as_named() {
    let fixture = golden(include_str!("../../tests/golden/sidecar-falcon-records.json"));
    let driver = ClaudeDriver::default();
    for (i, step) in fixture["steps"].as_array().expect("steps array").iter().enumerate() {
        driver.observe(&step["line"]);
        let expect = &step["expect"];
        if let Some(want) = expect.get("permissions") {
            let got: serde_json::Map<String, Value> = driver
                .permission_states()
                .into_iter()
                .map(|(id, state)| (id, serde_json::to_value(state).unwrap()))
                .collect();
            assert_eq!(Value::Object(got), *want, "step {i}: permission states");
        }
        if let Some(want) = expect.get("mode") {
            assert_eq!(driver.permission_mode(), want.as_str().unwrap(), "step {i}: mode");
        }
        if let Some(want) = expect.get("model") {
            assert_eq!(driver.model().as_deref(), want.as_str(), "step {i}: model");
        }
    }
}
