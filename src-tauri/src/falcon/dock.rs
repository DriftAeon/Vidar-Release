//! Shell-only Dock plumbing: the script-driven dock request/result files and
//! the open-ask that asks Vidar to take a hosted session into a tab.

use std::{
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use super::reader_control::ReaderControl;
use super::{
    now_ms, read_registry, write_atomic, Connection, Falcon, FalconPaths, Op, REQUEST_TIMEOUT,
};

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
    let root: Value = serde_json::from_str(crate::fsx::strip_bom(&text)).ok()?;
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

/// The ask both transports carry (`open.rs` `OpenAsk`): the bus requires `session`.
#[cfg(falcon_shell)]
fn dock_payload(id: &str, session: &str) -> Value {
    json!({
        "id": id,
        "kind": "dock",
        "reason": "Dock a hosted session from the Falcon shell",
        "requester": "s0-falcon",
        "session": session,
    })
}

/// How long one dock ask may wait for Vidar's verdict, from the moment a
/// subscriber took the publish.
#[cfg(falcon_shell)]
const BUS_ASK_DEADLINE: Duration = Duration::from_secs(25);
/// How long an undelivered publish (no `ask.open` subscriber) is retried.
/// Sized past Vidar's subscriber restart path (`falcon/bus.rs`): 2 s backoff,
/// then `ensure_host` (up to 5 s to ready, `host_launch.rs`), then the
/// subscribe request (ms; bounded by `REQUEST_TIMEOUT`). About 7 s worst case
/// for a normal restart, so 15 s leaves roughly double.
#[cfg(falcon_shell)]
const BUS_DELIVERY_RETRY: Duration = Duration::from_secs(15);

/// What the shell does with Vidar's bus reply.
#[cfg(falcon_shell)]
#[derive(Debug, PartialEq, Eq)]
enum Classified {
    Verdict(String),
    /// Any refusal, including an old Vidar's "kind not on the bus yet".
    Err(String),
}

#[cfg(falcon_shell)]
fn classify(reply: &Value) -> Classified {
    if let Some(verdict) = reply.get("verdict").and_then(Value::as_str) {
        return Classified::Verdict(verdict.to_string());
    }
    match reply.get("reason").and_then(Value::as_str) {
        Some(reason) => Classified::Err(reason.to_string()),
        None => Classified::Err("dock ask refused".into()),
    }
}

#[cfg(falcon_shell)]
#[derive(Debug)]
enum BusFail {
    /// No subscriber took the publish within `BUS_DELIVERY_RETRY`: Vidar is not running.
    Undelivered,
    /// No reply within the deadline.
    NoAnswer,
    Other(String),
}

/// Cancels the reader thread on every exit path, so its pipe handle closes
/// (dropping a `Connection` does not unblock `read_frame`; a leaked in-process
/// connection would keep the host from idle-exiting).
#[cfg(falcon_shell)]
struct ReaderGuard(Arc<ReaderControl>);

#[cfg(falcon_shell)]
impl Drop for ReaderGuard {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

/// Publish `payload` on `ask.open` and wait for the reply on
/// `ask.open.reply.<msg_id>`. Subscribes on one connection, publishes on a second
/// opened only after the subscribe reply, so the reply cannot be missed.
#[cfg(falcon_shell)]
fn bus_ask(paths: &FalconPaths, msg_id: &str, payload: Value) -> Result<Value, BusFail> {
    let other = BusFail::Other;
    let registry = read_registry(paths).map_err(other)?;
    let reply_topic = format!("ask.open.reply.{msg_id}");

    let mut sub = Connection::open(&registry).map_err(BusFail::Other)?;
    sub.request(
        2,
        Op::Subscribe {
            topics: vec![reply_topic.clone()],
        },
        REQUEST_TIMEOUT,
    )
    .and_then(|reply| reply.applied("subscribe"))
    .map_err(BusFail::Other)?;

    let reader_pipe = sub
        .pipe
        .try_clone()
        .map_err(|e| BusFail::Other(format!("duplicate falcon pipe handle: {e}")))?;
    let mut reader = Connection::raw(reader_pipe);
    let control = Arc::new(ReaderControl::new());
    let _guard = ReaderGuard(Arc::clone(&control));
    let thread_control = Arc::clone(&control);
    let (send, receive) = std::sync::mpsc::channel();
    let want = msg_id.to_string();
    std::thread::spawn(move || {
        let _finished = match thread_control.enter() {
            Ok(finished) => finished,
            Err(error) => {
                let _ = send.send(Err(error));
                return;
            }
        };
        let result = loop {
            let frame = match reader.read_frame() {
                Ok(frame) => frame,
                Err(error) => break Err(error),
            };
            if frame.get("t").and_then(Value::as_str) == Some("bus")
                && frame.get("id").and_then(Value::as_str) == Some(want.as_str())
            {
                break Ok(frame.get("payload").cloned().unwrap_or(Value::Null));
            }
        };
        let _ = send.send(result);
    });

    let mut publisher = Connection::open(&registry).map_err(BusFail::Other)?;
    let started = Instant::now();
    let mut request_id = 2u64;
    loop {
        request_id += 1;
        let delivered = publisher
            .request(
                request_id,
                Op::Publish {
                    topic: "ask.open".into(),
                    id: msg_id.to_string(),
                    payload: payload.clone(),
                    reply_to: Some(reply_topic.clone()),
                },
                REQUEST_TIMEOUT,
            )
            .and_then(|reply| reply.applied("publish"))
            .map_err(BusFail::Other)?
            .get("delivered")
            .and_then(Value::as_u64)
            .ok_or_else(|| BusFail::Other("publish reply carried no delivery count".into()))?;
        if delivered > 0 {
            break;
        }
        if started.elapsed() >= BUS_DELIVERY_RETRY {
            return Err(BusFail::Undelivered);
        }
        std::thread::sleep(Duration::from_millis(250));
    }

    let remaining = BUS_ASK_DEADLINE;
    match receive.recv_timeout(remaining) {
        Ok(Ok(reply)) => Ok(reply),
        Ok(Err(error)) => Err(BusFail::Other(error)),
        Err(_) => Err(BusFail::NoAnswer),
    }
}

#[cfg(falcon_shell)]
fn falcon_dock_ask_blocking(paths: &FalconPaths, session: &str) -> Result<String, String> {
    let id = mint_dispatch_id();
    match bus_ask(paths, &id, dock_payload(&id, session)) {
        Ok(reply) => match classify(&reply) {
            Classified::Verdict(verdict) => Ok(verdict),
            Classified::Err(reason) => Err(reason),
        },
        Err(BusFail::Undelivered) => Err("Vidar is not running".into()),
        Err(BusFail::NoAnswer) => Err("no answer".into()),
        Err(BusFail::Other(reason)) => Err(reason),
    }
}

#[cfg(all(test, falcon_shell))]
mod tests {
    use super::*;

    #[test]
    fn classify_verdict_reply() {
        let reply = json!({"ok": true, "tab": "t1", "verdict": "approved", "at_ms": 1});
        assert_eq!(classify(&reply), Classified::Verdict("approved".into()));
    }

    #[test]
    fn classify_old_vidar_is_an_error() {
        let reply = json!({"ok": false, "reason": "kind not on the bus yet"});
        assert_eq!(classify(&reply), Classified::Err("kind not on the bus yet".into()));
    }

    #[test]
    fn classify_other_refusal_is_an_error() {
        let reply = json!({"ok": false, "reason": "dock needs a session"});
        assert_eq!(classify(&reply), Classified::Err("dock needs a session".into()));
        assert_eq!(classify(&json!({"ok": false})), Classified::Err("dock ask refused".into()));
    }

    #[test]
    fn payload_carries_the_session() {
        let p = dock_payload("ab", "s1-00000001");
        assert_eq!(p["kind"], "dock");
        assert_eq!(p["session"], "s1-00000001");
        assert_eq!(p["requester"], "s0-falcon");
    }
}
