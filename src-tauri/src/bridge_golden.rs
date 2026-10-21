//! Golden tests at Vidar's Rust<->frontend seams. The fixtures under tests/golden/ are also read by
//! tests/golden/bridge-golden.test.mjs and type-checked against the frontend types by
//! tests/golden/shapes.golden.ts, so a shape change on one side fails a test on the other.

use serde_json::Value;

fn golden(text: &str) -> Value {
    serde_json::from_str(text).expect("golden fixture is JSON")
}

/// `<file>.decision.json`: the on-disk gate verdict (copied from runtime\bridge\display) parses
/// and is written back byte-for-byte in shape, and the `read_display_decision` view wraps it.
#[test]
fn display_decision_round_trips_exactly() {
    let fixture = golden(include_str!("../../tests/golden/display-decision.json"));
    let d: crate::bridge::Decision =
        serde_json::from_value(fixture.clone()).expect("Decision parses the golden file");
    assert_eq!(serde_json::to_value(&d).unwrap(), fixture);
    // Exhaustive literal (no `..`): a field added to `Decision` fails to compile here until the
    // fixture and the frontend type carry it.
    let literal = crate::bridge::Decision {
        file: "latest-pill-bda4f498.html".into(),
        sha256: "09cde7653c607f3f3df7faf55886bd8e694494d5a118a616e497b80f35d9095a".into(),
        verdict: "approve".into(),
        comment: "A. filled accent is good".into(),
        at_ms: 1791166180236,
        request: Some("bda4f498".into()),
    };
    assert_eq!(serde_json::to_value(&literal).unwrap(), fixture);
}

/// `read_display_decision` result: the view's JSON is exactly the shared fixture that the Node test
/// and shapes.golden.ts check against `DecisionView`.
#[test]
fn display_decision_view_matches_the_golden_view() {
    let fixture = golden(include_str!("../../tests/golden/display-decision-view.json"));
    let decision: crate::bridge::Decision =
        serde_json::from_value(fixture["decision"].clone()).expect("Decision parses the view's decision");
    let view = crate::bridge::DecisionView { decision, current: true };
    assert_eq!(serde_json::to_value(&view).unwrap(), fixture);
}

/// `review\dispatch\<id>.json` as astra-dispatch.ps1 publishes it (a real claimed file, paths
/// scrubbed): `Dispatch` denies unknown fields, so a key added on the PowerShell side parks every
/// request. It must parse, pass the acceptance rule, and round-trip as the `review-dispatch` payload.
#[test]
fn review_dispatch_parses_and_passes_the_acceptance_rule() {
    let text = include_str!("../../tests/golden/review-dispatch.json");
    let fixture = golden(text);
    let d: crate::review::Dispatch = serde_json::from_str(text).expect("Dispatch parses the golden request");
    crate::review::validate(&d, fixture["id"].as_str().unwrap()).expect("golden request is accepted");
    assert_eq!(serde_json::to_value(&d).unwrap(), fixture);
}

/// Startup re-adopt keys on `last_holder` equal to this build's negotiated client name; the
/// frontend's `shouldReadopt` hard-codes the same string (tests/golden/bridge-golden.test.mjs).
#[test]
fn falcon_list_readopt_holder_is_this_client() {
    let fixture = golden(include_str!("../../tests/golden/falcon-list.json"));
    assert_eq!(fixture["sessions"][0]["last_holder"], crate::falcon::CLIENT_NAME);
}
