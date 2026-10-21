//! Unreal bench tab reader (slice 1): project, editor, build and Live Coding state for a cwd.
//!
//! Stateless and read-only: every poll re-reads the logs. Shape is `bench-tab-plan.md` D4,
//! mirrored by `UnrealStatus` in `src/ipc.ts`.

mod discover;
mod parse;
mod status;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnrealStatus {
    pub project: Option<Project>,
    pub editor: Editor,
    pub build: Option<Build>,
    pub live_coding: Option<LiveCoding>,
    pub diags: Vec<Diag>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Project {
    /// Folder name.
    pub name: String,
    pub root: String,
    /// `.uproject` file name.
    pub uproject: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Editor {
    Running,
    Closed,
    Unclean,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BuildResult {
    Succeeded,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LiveResult {
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Build {
    pub result: BuildResult,
    /// Epoch milliseconds (file time of the UBT log).
    pub at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LiveCoding {
    pub result: LiveResult,
    /// Epoch milliseconds (UTC stamp of the log line).
    pub at: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Log,
    Ubt,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Diag {
    pub file: Option<String>,
    pub line: Option<u32>,
    pub severity: Severity,
    pub text: String,
    pub source: Source,
}

async fn blocking<T: Send + 'static>(what: &str, f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("{what} task failed: {e}"))?
}

/// A read error comes back as the `Err` string (the TS side shows one error line); it never panics.
#[tauri::command]
pub async fn unreal_status(cwd: String) -> Result<UnrealStatus, String> {
    blocking("unreal_status", move || status::status_blocking(&cwd)).await
}
