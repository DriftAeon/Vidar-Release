//! src-tauri\src\control\wait.rs — `ctl.wait <tab>`: block until another tab's
//! turn ends. Observe-class,
//! no card: it only reads the state chip a rendered tab already publishes
//! (`driveSnapshot()`). Rust validates and parks like every other verb; the
//! poll itself lives in the frontend (`src\control\watch.ts`), which answers
//! through `control_result` with `done …`, `err dead` or `err timeout`.

use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::policy::Requester;
use crate::open::valid_reason;

/// `vidar.mjs wait` default (plan: "10 min default").
const DEFAULT_TIMEOUT_MS: u64 = 600_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
/// Upper bound so one parked wait cannot pin a `PENDING_CAP` slot indefinitely.
const MAX_TIMEOUT_MS: u64 = 3_600_000;
/// `--report` is echoed back only, never read or confined (plan review gate
/// 4); bounded so the reply stays one line.
const MAX_REPORT: usize = 400;
/// The frontend answers `err timeout` at the deadline; this slack keeps the
/// parked entry alive past it so that answer still has somewhere to go.
const SWEEP_SLACK: Duration = Duration::from_secs(60);

/// `payload.timeout_ms`, clamped; absent or not a number means the default.
pub fn timeout_ms(payload: &Value) -> u64 {
    payload.get("timeout_ms").and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
}

/// How long `mod.rs` keeps this wait's pending entry before its sweep may
/// drop it (a plain Observe entry would be swept after `PENDING_TTL`, 60 s).
pub fn pending_ttl(payload: &Value) -> Duration {
    Duration::from_millis(timeout_ms(payload)) + SWEEP_SLACK
}

/// `payload.report`: absent or null is `None`; otherwise a non-blank string of
/// at most `MAX_REPORT` bytes with no control characters, else `bad report`.
/// Shared with `session.rs` (`ctl.spawn`/`ctl.prompt`).
pub(crate) fn parse_report(payload: &Value) -> Result<Option<&str>, String> {
    match payload.get("report") {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_str()
            .filter(|s| !s.trim().is_empty() && s.len() <= MAX_REPORT && !s.chars().any(char::is_control))
            .map(Some)
            .ok_or_else(|| "bad report".to_string()),
    }
}

pub fn wait(app: &AppHandle, id: &str, requester: &Requester, payload: &Value) -> Result<(), String> {
    let tab = payload.get("tab").and_then(Value::as_str).filter(|s| valid_reason(s))
        .ok_or_else(|| "bad tab".to_string())?;
    let report = parse_report(payload)?;
    app.emit(
        "ctl-wait",
        json!({
            "id": id,
            "tab": tab,
            "report": report,
            "timeoutMs": timeout_ms(payload),
            "requester": requester.to_json(),
        }),
    )
    .map_err(|e| e.to_string())
}
