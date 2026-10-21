//! src-tauri\src\rules\generate\progress.rs — the `rules-generate-progress` events of a chunked run
//! (docs/runs/2026-10-18-rune-gen-per-source/plan.md § Progress events, amendments 10 and 11). Shapes are pinned by
//! `tests/fixtures/rune-gen-progress.json` and its reducer `src/runes/bare/progress.ts`: camelCase, a `stage` tag,
//! `runes` and `part` present as `null` when empty.

use serde::Serialize;

/// The Tauri event name the frontend listens on.
pub const EVENT: &str = "rules-generate-progress";

/// `Part K of N` of a file split across chunks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Part {
    pub k: usize,
    pub of: usize,
}

/// One file in a chunk; `part` is `None` when the chunk holds the whole file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlanFile {
    pub path: String,
    pub part: Option<Part>,
}

/// One chunk of the plan, in call order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlanChunk {
    pub files: Vec<PlanFile>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChunkState {
    Running,
    Retrying,
    Done,
    Failed,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeState {
    Running,
    Done,
    Failed,
}

/// A progress event without its run id; `Event` adds it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "stage", rename_all = "camelCase")]
pub enum ProgressEvent {
    #[serde(rename_all = "camelCase")]
    Plan { chunks: Vec<PlanChunk> },
    #[serde(rename_all = "camelCase")]
    Chunk { index: usize, state: ChunkState, runes: Option<usize> },
    #[serde(rename_all = "camelCase")]
    Merge { state: MergeState },
}

/// The wire form: the run id beside the flattened event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub run_id: String,
    #[serde(flatten)]
    pub event: ProgressEvent,
}

#[cfg(test)]
#[path = "progress_tests.rs"]
mod tests;
