//! src-tauri\src\rules\generate\progress_tests.rs — the event types serialize to the shapes in
//! `tests/fixtures/rune-gen-progress.json`, compared as parsed JSON.

use super::*;
use serde_json::Value;

fn fixture() -> Vec<Value> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/rune-gen-progress.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn wire(event: ProgressEvent) -> Value {
    serde_json::to_value(Event { run_id: "0a1b2c3d".into(), event }).unwrap()
}

fn chunk(index: usize, state: ChunkState, runes: Option<usize>) -> Value {
    wire(ProgressEvent::Chunk { index, state, runes })
}

fn file(path: &str, part: Option<(usize, usize)>) -> PlanFile {
    PlanFile::new(path.into(), part.map(|(k, of)| Part { k, of }))
}

#[test]
fn event_name_is_pinned() {
    assert_eq!(EVENT, "rules-generate-progress");
}

#[test]
fn plan_matches_fixture() {
    let plan = ProgressEvent::Plan {
        chunks: vec![
            PlanChunk { files: vec![file("~\\CLAUDE.md", None), file("~\\rules\\ui.md", None)] },
            PlanChunk { files: vec![file("~\\memory", Some((1, 2)))] },
            PlanChunk { files: vec![file("~\\memory", Some((2, 2)))] },
        ],
    };
    assert_eq!(wire(plan), fixture()[0]);
}

#[test]
fn chunk_events_match_fixture() {
    let f = fixture();
    assert_eq!(chunk(0, ChunkState::Running, None), f[1]);
    assert_eq!(chunk(1, ChunkState::Retrying, None), f[3]);
    assert_eq!(chunk(0, ChunkState::Done, Some(12)), f[4]);
    assert_eq!(chunk(2, ChunkState::Failed, None), f[6]);
    assert_eq!(chunk(2, ChunkState::Stopped, None), f[7]);
}

#[test]
fn runes_is_null_not_omitted() {
    let v = chunk(0, ChunkState::Running, None);
    assert!(v.as_object().unwrap().contains_key("runes"));
    assert!(v["runes"].is_null());
}

#[test]
fn merge_events_match_fixture() {
    let f = fixture();
    assert_eq!(wire(ProgressEvent::Merge { state: MergeState::Running }), f[8]);
    assert_eq!(wire(ProgressEvent::Merge { state: MergeState::Done }), f[9]);
    assert_eq!(wire(ProgressEvent::Merge { state: MergeState::Failed }), f[10]);
}
