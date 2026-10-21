//! Open-a-tab bridge, Rust half: a desk tab asks the USER to open a companion
//! tab, and Vidar puts the ask on screen with Approve / Deny and a comment box.
//! Shape-for-shape review.rs — claim once, validate, emit, record the verdict —
//! with one deliberate difference: this bridge composes no command line and
//! carries no brief, model or cwd. The only thing a request can ask for is a
//! `kind`, and the frontend maps that to a launcher entry it already has.
//! Nothing here can widen into arbitrary execution.
//!
//! Files (all under bridge\open; only dispatch\ is swept):
//!   dispatch\<id>.json     request, published by a requester via rename
//!   dispatch\<id>.claimed  the same file after we took it (never re-read)
//!   dispatch\stale\…       anything found at startup or rejected, with a reason
//!   <id>\pending.json      written right after the claim, before the emit
//!   <id>\result.json       the user's verdict via open_result
//!
//! Trust boundary: anything that can write bridge\open can put a dialog on the
//! user's screen, so the human IS the gate here — there is no armed-tab check,
//! because a request that is refused costs one click and a request that is
//! granted was granted by the person looking at it. `reason` is displayed as
//! text, never interpreted, and is allowlisted to printable ASCII so the audit
//! record and the dialog agree.
//!
//! The claim / park / pending / poll mechanics live in dispatch_bridge.rs
//! shared with review.rs. The kind/reason allowlists,
//! `validate`, the bus path and `answer_once` stay in this file.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::control::publish_bus_reply;
use crate::dispatch_bridge::{self, valid_id, write_atomic, Accepted, Bridge};
use crate::fsx::now_ms;

fn open_dir() -> PathBuf {
    crate::paths::open_dir()
}
fn bridge() -> Bridge {
    Bridge {
        root: open_dir(),
        dispatch: crate::paths::open_dispatch_dir(),
        stale: crate::paths::open_stale_dir(),
    }
}
/// What may be asked for. Each maps to a launcher entry the frontend already
/// resolves; adding one here is additive and still opens nothing on its own.
const KINDS: [&str; 3] = ["astra", "dock", "jettison"];
pub(crate) const MAX_REASON: usize = 200;

#[derive(Default)]
pub struct OpenState {
    ready: AtomicBool,
    /// Asks that arrived over the bus, not yet answered: id -> (the topic the
    /// answer goes to, when it was inserted). `open_result` checks here first;
    /// a hit is answered by publishing to it and removing
    /// the entry, a miss falls through to the file path (`answer_once` on
    /// `pending.json`). An entry the user never answers (dialog dismissed
    /// some other way, tab closed) would otherwise leak forever; `insert`
    /// sweeps entries older than `BUS_PENDING_TTL` first.
    bus_pending: Mutex<HashMap<String, (PendingReply, Instant)>>,
}

/// Where and as what a bus ask's answer goes back. `msg_id` is the bus
/// message id the requester generated (`bus-client.mjs` `request()`), not the
/// ask's own `id`: the client resolves its reply by `frame.id === msg_id`, so
/// answering under the ask id never matched (the card was answered and the
/// script waited out its timeout).
pub struct PendingReply {
    reply_to: String,
    msg_id: String,
}

/// How long an unanswered bus ask's `reply_to` is kept before `bus_pending`
/// drops it as abandoned.
const BUS_PENDING_TTL: Duration = Duration::from_secs(300);

/// Drops entries older than `BUS_PENDING_TTL` as of `now`. Pure so the expiry
/// rule can be unit tested without a clock dependency.
fn purge_expired_pending<T>(pending: &mut HashMap<String, (T, Instant)>, now: Instant) {
    pending.retain(|_, (_, inserted_at)| now.saturating_duration_since(*inserted_at) < BUS_PENDING_TTL);
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenAsk {
    id: String,
    kind: String,
    reason: String,
    requester: String,
    /// Only `jettison` carries this: which Falcon session to pull out of a
    /// Vidar tab. `dock` names its session through the handoff file instead
    /// (`falcon_dock_ask_blocking`), so this stays absent there.
    #[serde(default)]
    session: Option<String>,
}

/// An ask never survives a restart: the tab that asked, and the moment it asked
/// about, are both gone. A dialog resurrected at startup has no context.
pub fn quarantine_stale() {
    bridge().quarantine_stale("found at startup: the tab that asked no longer exists");
}

/// Vidar tab ids look like `s12-abcd` (sessions.ts createSession).
fn valid_tab_id(s: &str) -> bool {
    let Some((num, boot)) = s.split_once('-') else { return false };
    num.len() >= 2
        && num.starts_with('s')
        && num[1..].bytes().all(|b| b.is_ascii_digit())
        && !boot.is_empty()
        && boot.len() <= 16
        && boot.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// One line of printable ASCII. It is shown to the user as the whole
/// justification for the click, so an empty or control-laden one is refused
/// rather than displayed blank.
pub(crate) fn valid_reason(s: &str) -> bool {
    !s.trim().is_empty()
        && s.len() <= MAX_REASON
        && s.bytes().all(|b| (0x20..0x7f).contains(&b))
}

/// A validated ask, independent of how it arrived (file poller or bus).
#[derive(Debug)]
pub struct Ask {
    pub id: String,
    pub kind: String,
    pub reason: String,
    pub requester: String,
    pub session: Option<String>,
}

/// Shape and content validation shared by the file poller (`scan`, below)
/// and the bus handler (`handle_bus_ask`): kind allowlist, reason 1-200
/// printable ASCII, requester shape, id shape, the jettison-carries-session
/// rule. File-specific checks — id matches the file stem, id not already
/// used as a `bridge\open\<id>` directory — have no meaning for a bus ask
/// (no file, no directory of its own) and stay in `validate` below.
fn validate_ask(v: &Value) -> Result<Ask, String> {
    let d: OpenAsk = serde_json::from_value(v.clone()).map_err(|e| e.to_string())?;
    if !valid_id(&d.id) {
        return Err("id must be 8 lowercase hex".into());
    }
    if !KINDS.contains(&d.kind.as_str()) {
        return Err(format!("kind must be one of {}", KINDS.join(", ")));
    }
    if !valid_reason(&d.reason) {
        return Err(format!("reason must be 1-{MAX_REASON} printable ASCII characters"));
    }
    if !valid_tab_id(&d.requester) {
        return Err("requester must be a Vidar tab id (s<n>-<boot>)".into());
    }
    if d.kind == "jettison" {
        match d.session.as_deref() {
            Some(s) if valid_reason(s) => {}
            _ => return Err("jettison requires a session (1-200 printable ASCII)".into()),
        }
    }
    Ok(Ask { id: d.id, kind: d.kind, reason: d.reason, requester: d.requester, session: d.session })
}

/// `open_dir` is bridge\open (a temp root in tests).
fn validate(open_dir: &Path, d: &OpenAsk, file_stem: &str) -> Result<(), String> {
    let v = serde_json::to_value(d).map_err(|e| e.to_string())?;
    validate_ask(&v)?;
    if d.id != file_stem {
        return Err("id does not match the file name".into());
    }
    if open_dir.join(&d.id).exists() {
        return Err("id already used: ids are never reused".into());
    }
    Ok(())
}

/// Bus handler for topic `ask.open`. Called from the bus
/// reader thread (`falcon::bus_subscribe`) on every matching frame; a frame
/// with no `reply_to` is dropped — there is nowhere to answer it, and this
/// bridge only ever acts on requests, never fire-and-forget publishes.
pub fn handle_bus_ask(app: &AppHandle, frame: &Value) {
    let Some(reply_to) = frame.get("reply_to").and_then(Value::as_str) else {
        return;
    };
    let reply_to = reply_to.to_string();
    let msg_id = frame.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let payload = frame.get("payload").cloned().unwrap_or(Value::Null);

    let ask = match validate_ask(&payload) {
        Ok(ask) => ask,
        Err(reason) => {
            publish_bus_reply(app, &reply_to, &msg_id, serde_json::json!({ "ok": false, "reason": reason }));
            return;
        }
    };
    // Only `astra` is on the bus path; `dock`/`jettison` stay
    // file-only.
    if ask.kind != "astra" {
        publish_bus_reply(
            app,
            &reply_to,
            &msg_id,
            serde_json::json!({ "ok": false, "reason": "kind not on the bus yet" }),
        );
        return;
    }

    let claimed_at_ms = now_ms();
    let state = app.state::<OpenState>();
    if let Ok(mut pending) = state.bus_pending.lock() {
        purge_expired_pending(&mut pending, Instant::now());
        pending.insert(ask.id.clone(), (PendingReply { reply_to, msg_id }, Instant::now()));
    }
    drop(state);
    let tab_payload = serde_json::json!({
        "id": ask.id, "kind": ask.kind, "reason": ask.reason,
        "requester": ask.requester, "session": ask.session, "claimedAtMs": claimed_at_ms
    });
    let _ = app.emit("open-ask", tab_payload);
}

/// This bridge's acceptance rule for one claimed file request: `validate`,
/// then the pending record and the emitted payload.
fn accept(open_dir: &Path, d: OpenAsk, stem: &str) -> Result<Accepted<Value>, String> {
    validate(open_dir, &d, stem)?;
    let claimed_at_ms = now_ms();
    let pending = serde_json::json!({
        "id": d.id, "kind": d.kind, "reason": d.reason,
        "requester": d.requester, "session": d.session, "claimed_at_ms": claimed_at_ms
    });
    let payload = serde_json::json!({
        "id": d.id, "kind": d.kind, "reason": d.reason,
        "requester": d.requester, "session": d.session, "claimedAtMs": claimed_at_ms
    });
    Ok(Accepted { id: d.id.clone(), pending, payload })
}

fn scan(app: &AppHandle) {
    let b = bridge();
    b.scan(
        |d, stem| accept(&b.root, d, stem),
        |payload| {
            let _ = app.emit("open-ask", payload);
        },
    );
}

pub fn start_dispatch_poller(app: AppHandle) {
    dispatch_bridge::start_poller(app, |app| app.state::<OpenState>().ready.load(Ordering::Relaxed), scan);
}

/// Frontend: "my open-ask listener is attached". Idempotent.
#[tauri::command]
pub fn open_ready(state: State<OpenState>) {
    state.ready.store(true, Ordering::Relaxed);
}

/// Answer one ask, exactly once. `dir` is the ask's `bridge\open\<id>` folder.
///
/// The claim is `remove_file(pending.json)`, not a check that it exists: the
/// remove IS the lock. Exactly one caller gets `Ok`, every later one gets
/// `NotFound` and stops before writing. Checking-then-writing left a window
/// where two calls both passed the check and the second clobbered a verdict the
/// asker had already read. `write_atomic` used to also
/// deleted the destination before renaming, so a clobber left `result.json`
/// briefly absent; it now renames over via `fsx::atomic_write`, but the
/// exactly-once rule still rests on this remove, not on the write.
fn answer_once(dir: &Path, body: &str) -> Result<(), String> {
    match fs::remove_file(dir.join("pending.json")) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err("already answered: an ask is answered exactly once".into())
        }
        Err(e) => return Err(format!("could not claim the ask: {e}")),
    }
    write_atomic(&dir.join("result.json"), body)
}

/// The user's verdict for one ask. `ok` is true only when they approved AND the
/// tab actually opened; `verdict` records which of the two happened, so a denial
/// and a failed spawn are never confused in the record the asker reads.
/// Async wrapper: the bus-reply path runs `falcon.bus_publish` on the
/// cached control connection (`falcon::Falcon::control`), which can launch
/// or wait on the host for up to 5s — must never run on the Tauri main
/// thread (same reason as `falcon_list`, `falcon/session_commands.rs`).
#[tauri::command]
pub async fn open_result(
    app: AppHandle,
    id: String,
    ok: bool,
    tab: Option<String>,
    verdict: String,
    comment: Option<String>,
    reason: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_result_blocking(&app, id, ok, tab, verdict, comment, reason)
    })
    .await
    .map_err(|e| format!("open_result task failed: {e}"))?
}

fn open_result_blocking(
    app: &AppHandle,
    id: String,
    ok: bool,
    tab: Option<String>,
    verdict: String,
    comment: Option<String>,
    reason: Option<String>,
) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("bad id".into());
    }
    if !["approved", "denied", "failed"].contains(&verdict.as_str()) {
        return Err("verdict must be approved, denied or failed".into());
    }
    let at_ms = now_ms();
    let v = serde_json::json!({
        "ok": ok, "tab": tab, "verdict": &verdict,
        "comment": comment, "reason": reason, "at_ms": at_ms
    });

    // The bus path first: an id claimed there has no `pending.json` to
    // answer (the bus handler never writes one).
    let bus_reply_to = {
        let state = app.state::<OpenState>();
        state.bus_pending.lock().ok().and_then(|mut pending| pending.remove(&id)).map(|(reply, _)| reply)
    };
    if let Some(reply) = bus_reply_to {
        publish_bus_reply(app, &reply.reply_to, &reply.msg_id, v);
        return Ok(());
    }
    answer_once(&open_dir().join(&id), &v.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasons() {
        assert!(valid_reason("you asked for a review of the launch bridge diff"));
        assert!(!valid_reason(""));
        assert!(!valid_reason("   "));
        assert!(!valid_reason("two\nlines"));
        assert!(!valid_reason("curly \u{201d} quote"));
        assert!(!valid_reason(&"x".repeat(MAX_REASON + 1)));
    }

    #[test]
    fn tab_ids() {
        assert!(valid_tab_id("s4-hvyi"));
        assert!(!valid_tab_id("s4-HVYI"));
    }

    /// A kind outside the allowlist is parked,
    /// through the shared scan, with no pending record and no emit.
    #[test]
    fn unknown_kind_is_still_rejected_by_the_file_scan() {
        use crate::dispatch_bridge::tests::{stale_reasons, temp_bridge};
        let b = temp_bridge("open");
        let req = ask_json("launch", "please");
        fs::write(b.dispatch.join("0123abcd.json"), req.to_string()).unwrap();
        let mut emitted = 0;
        b.scan(|d, stem| accept(&b.root, d, stem), |_: Value| emitted += 1);
        assert_eq!(emitted, 0);
        assert!(!b.root.join("0123abcd").exists());
        assert_eq!(stale_reasons(&b), ["kind must be one of astra, dock, jettison"]);
        let _ = fs::remove_dir_all(&b.root);
    }

    #[test]
    fn purge_expired_pending_drops_only_entries_past_the_ttl() {
        let base = Instant::now();
        let mut pending: HashMap<String, (String, Instant)> = HashMap::new();
        pending.insert("fresh".into(), ("t.reply.fresh".into(), base));
        pending.insert("stale".into(), ("t.reply.stale".into(), base));
        let now = base + BUS_PENDING_TTL + Duration::from_secs(1);
        purge_expired_pending(&mut pending, now);
        // Both were inserted at `base`; this asserts the boundary is
        // inclusive of the TTL, not that one survives and one doesn't — redo
        // with a fresh entry actually inserted near `now` to prove that.
        assert!(pending.is_empty(), "both entries are older than the TTL by `now`");

        let mut pending: HashMap<String, (String, Instant)> = HashMap::new();
        pending.insert("old".into(), ("t.reply.old".into(), base));
        pending.insert("new".into(), ("t.reply.new".into(), now));
        purge_expired_pending(&mut pending, now);
        assert!(!pending.contains_key("old"), "older than TTL should be dropped");
        assert!(pending.contains_key("new"), "just inserted should survive");
    }

    fn ask_json(kind: &str, reason: &str) -> serde_json::Value {
        serde_json::json!({
            "id": "0123abcd", "kind": kind, "reason": reason,
            "requester": "s4-hvyi", "session": null
        })
    }

    #[test]
    fn validate_ask_accepts_a_well_formed_astra_ask() {
        let ask = validate_ask(&ask_json("astra", "you asked for a review")).unwrap();
        assert_eq!(ask.id, "0123abcd");
        assert_eq!(ask.kind, "astra");
        assert_eq!(ask.requester, "s4-hvyi");
    }

    #[test]
    fn validate_ask_rejects_a_bad_kind() {
        let err = validate_ask(&ask_json("launch", "reason")).unwrap_err();
        assert!(err.contains("kind must be one of"), "{err}");
    }

    #[test]
    fn validate_ask_rejects_a_reason_over_200_chars() {
        let err = validate_ask(&ask_json("astra", &"x".repeat(MAX_REASON + 1))).unwrap_err();
        assert!(err.contains("reason must be"), "{err}");
    }

    #[test]
    fn validate_ask_rejects_non_ascii_reason() {
        let err = validate_ask(&ask_json("astra", "curly \u{201d} quote")).unwrap_err();
        assert!(err.contains("reason must be"), "{err}");
    }

    /// answer_once takes a &Path so this runs against a temp folder, never the
    /// live bridge\open (open_dir() resolves to an absolute path under the repo root).
    #[test]
    fn an_ask_is_answered_exactly_once() {
        let dir = std::env::temp_dir().join(format!("vidar-open-test-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("pending.json"), "{}").unwrap();

        assert!(answer_once(&dir, r#"{"verdict":"approved"}"#).is_ok());
        let first = fs::read_to_string(dir.join("result.json")).unwrap();
        assert!(first.contains("approved"));

        let second = answer_once(&dir, r#"{"verdict":"denied"}"#);
        assert!(second.is_err(), "a second answer must be refused");
        assert!(second.unwrap_err().contains("already answered"));
        // the first verdict is still the one on disk, byte for byte
        assert_eq!(fs::read_to_string(dir.join("result.json")).unwrap(), first);
        assert!(!dir.join("pending.json").exists(), "the claim is consumed");

        let _ = fs::remove_dir_all(&dir);
    }

    /// No pending record at all (bad id, or a folder that was never claimed).
    #[test]
    fn answering_an_unknown_ask_is_refused() {
        let dir = std::env::temp_dir().join(format!("vidar-open-none-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        assert!(answer_once(&dir, "{}").is_err());
        assert!(!dir.join("result.json").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
