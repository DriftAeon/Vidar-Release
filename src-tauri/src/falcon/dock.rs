//! Shell-only Dock plumbing: the script-driven dock request/result files and
//! the open-ask that asks Vidar to take a hosted session into a tab.

use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use super::{now_ms, write_atomic, Falcon, FalconPaths};

/* ---- tools\falcon\dock.ps1 -> the shell (bridge\falcon\dock-request.json / dock-result.json) ----
 *
 * Vidar's own `open.rs` poller cannot be the dock trigger here: it sweeps
 * `bridge\open\dispatch` from inside Vidar, but a script-driven Dock must
 * make the SHELL detach first (the shell, not Vidar, holds the lease and the
 * attached RenderedBody), so the shell polls this file itself and only then
 * runs the same path `falcon_dock_ask` already drives. One file, not a
 * `bridge\open` ask: this is shell-to-shell (the caller and the shell are the
 * same trust boundary Falcon already draws), never a companion-tab request. */

// The whole dock-request block below is shell-only: `tools\falcon\dock.ps1` polls
// the shell process, and only the shell build registers these commands
// (`src-falcon\src\main.rs`). Vidar itself never claims or answers a dock
// request. Paths: `FalconPaths::dock_request` and siblings.
/// Same bound as an ask-gate claim (`open.rs`'s `HANDOFF_STALE_MS`/queue
/// expiry): a request left by a caller that already gave up is never
/// actioned late.
#[cfg(falcon_shell)]
const DOCK_REQUEST_STALE_MS: u64 = 120_000;

#[cfg(falcon_shell)]
#[derive(Debug, Clone, Deserialize)]
struct DockRequest {
    session: String,
    ts: u64,
    id: String,
}

/// What the shell's poll gets back: `None` when there was nothing to claim,
/// `Some` once a request has been claimed (rename to `.claimed`, at most
/// once — `open.rs::scan`'s convention) whether or not it turned out fresh,
/// so the caller can settle `tools\falcon\dock.ps1`'s wait with a reason instead of
/// silently dropping a stale file on the floor. `id` is carried through to
/// `falcon_dock_result_write` so a stale result from an earlier request can
/// never be read as this one's verdict.
#[cfg(falcon_shell)]
#[derive(Debug, Clone, Serialize)]
pub struct DockRequestClaim {
    session: String,
    id: String,
    fresh: bool,
}

/// The `theme` pref from Vidar's `vidar-state.json`, or `None` when the file,
/// the key or a string value is missing or unreadable; the shell keeps its
/// current theme then. Read-only, and the only slice of the state it exposes.
#[cfg(falcon_shell)]
#[tauri::command]
pub fn falcon_theme(falcon: State<'_, Arc<Falcon>>) -> Option<String> {
    let text = std::fs::read_to_string(falcon.paths.ui_state()).ok()?;
    let root: Value = serde_json::from_str(text.strip_prefix('\u{FEFF}').unwrap_or(&text)).ok()?;
    root.get("theme")?.as_str().map(str::to_owned)
}

#[cfg(falcon_shell)]
#[tauri::command]
pub fn falcon_dock_request_claim(
    falcon: State<'_, Arc<Falcon>>,
) -> Result<Option<DockRequestClaim>, String> {
    let path = falcon.paths.dock_request();
    if !path.exists() {
        return Ok(None);
    }
    let claimed = falcon.paths.dock_request_claimed();
    // Rename is the claim, same as open.rs::scan: a second poll tick that
    // finds nothing here just does nothing, it never re-reads `.claimed`.
    if std::fs::rename(&path, &claimed).is_err() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&claimed).map_err(|e| e.to_string())?;
    let req: DockRequest = match serde_json::from_str::<DockRequest>(&text) {
        Ok(req) => req,
        Err(_) => {
            // Malformed claimed request: write a verdict the caller can see
            // the reason for instead of returning Err, which would leave
            // dock-result.json unwritten and the caller waiting out its
            // timeout blind.
            let body = serde_json::json!({
                "session": Value::Null,
                "id": Value::Null,
                "ok": false,
                "reason": "malformed request",
            });
            let _ = write_atomic(&falcon.paths.dock_result(), &body.to_string());
            let _ = std::fs::remove_file(&claimed);
            return Ok(None);
        }
    };
    let fresh = now_ms().saturating_sub(req.ts) <= DOCK_REQUEST_STALE_MS;
    Ok(Some(DockRequestClaim {
        session: req.session,
        id: req.id,
        fresh,
    }))
}

/// Restore a claimed request to `dock-request.json` (undo the claim rename)
/// instead of settling it with a verdict, for the one caller that discovers
/// the claim was not actually for the session this shell is showing — a race
/// between two shell windows, not a real refusal (inferred: single-shell not
/// proven, but restoring is free either way).
#[cfg(falcon_shell)]
#[tauri::command]
pub fn falcon_dock_request_release(falcon: State<'_, Arc<Falcon>>) -> Result<(), String> {
    let claimed = falcon.paths.dock_request_claimed();
    if !claimed.exists() {
        return Ok(());
    }
    std::fs::rename(&claimed, falcon.paths.dock_request()).map_err(|e| e.to_string())
}

/// Written once per claimed request, whatever the outcome (stale, wrong
/// session, or the Dock path itself failed) — `tools\falcon\dock.ps1` waits on this
/// file existing, not on success. Also removes the claimed request file: once
/// a result is written the claim is fully settled, so `.claimed` must not
/// linger and outlive the run.
#[cfg(falcon_shell)]
#[tauri::command]
pub fn falcon_dock_result_write(
    falcon: State<'_, Arc<Falcon>>,
    session: String,
    id: String,
    ok: bool,
    reason: Option<String>,
) -> Result<(), String> {
    let body = serde_json::json!({ "session": session, "id": id, "ok": ok, "reason": reason });
    write_atomic(&falcon.paths.dock_result(), &body.to_string())?;
    let _ = std::fs::remove_file(falcon.paths.dock_request_claimed());
    Ok(())
}

#[cfg(falcon_shell)]
fn mint_dispatch_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mixed = (nanos as u64) ^ ((nanos >> 64) as u64);
    format!("{:08x}", (mixed >> 32) as u32 ^ mixed as u32)
}

/// Ask Vidar (over the open-ask bridge, `open.rs`) to auto-approve docking one
/// hosted session into a tab. `session` names which one for the caller; the
/// bridge itself carries no session id, only `kind`/`reason` — Vidar reads
/// which session via the handoff `falcon_handoff_write` already left.
///
/// Threading: an async command with the wait in `spawn_blocking`, the same
/// shape `mcp.rs::list_mcp_tools`/`proxy_status` already use, so this file
/// wait never runs on the Tauri main thread.
#[cfg(falcon_shell)]
#[tauri::command]
pub async fn falcon_dock_ask(
    falcon: State<'_, Arc<Falcon>>,
    session: String,
) -> Result<String, String> {
    let paths = falcon.paths.clone();
    tauri::async_runtime::spawn_blocking(move || falcon_dock_ask_blocking(&paths, &session))
        .await
        .map_err(|e| format!("dock ask task failed: {e}"))?
}

#[cfg(falcon_shell)]
fn falcon_dock_ask_blocking(paths: &FalconPaths, session: &str) -> Result<String, String> {
    let _ = session; // carried via the handoff file; named here only per the call site
    let id = mint_dispatch_id();
    let ask = json!({
        "id": id,
        "kind": "dock",
        "reason": "Dock a hosted session from the Falcon shell",
        "requester": "s0-falcon",
    });
    let dispatch_path = paths.open_dispatch_dir().join(format!("{id}.json"));
    write_atomic(&dispatch_path, &ask.to_string())?;

    // Claim detection checks three places, not just `pending.json`:
    // `open_result`/`answer_once` REMOVES `pending.json` as its own lock
    // before writing `result.json` (`open.rs::answer_once`), so a claim that
    // is approved within one poll tick can already have both `pending.json`
    // gone and `result.json` not fully visible yet — checking `pending.json`
    // alone raced that window and returned "Vidar is not running" for a dock
    // that had, in fact, already succeeded (review proof, root cause). The
    // `.claimed` file (`open.rs::scan`, the rename target at claim time) is
    // never removed once a claim validates and is only ever MOVED away by
    // `park` on a rejection — so its presence in `dispatch\`, not `stale\`,
    // is claimed-and-live regardless of how far the answer has progressed;
    // `park`'s destination (`dispatch\stale\`) is deliberately not checked
    // here, since a parked ask is not a claim in flight.
    let pending_path = paths.open_dir().join(&id).join("pending.json");
    let result_path = paths.open_dir().join(&id).join("result.json");
    let claimed_path = paths.open_dispatch_dir().join(format!("{id}.claimed"));
    let mut claimed = false;
    for _ in 0..20 {
        if pending_path.exists() || result_path.exists() || claimed_path.exists() {
            claimed = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    if !claimed {
        let _ = std::fs::remove_file(&dispatch_path);
        return Err("Vidar is not running".into());
    }

    for _ in 0..80 {
        if let Ok(text) = std::fs::read_to_string(&result_path) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if let Some(verdict) = value.get("verdict").and_then(Value::as_str) {
                    return Ok(verdict.to_string());
                }
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err("no answer".into())
}
