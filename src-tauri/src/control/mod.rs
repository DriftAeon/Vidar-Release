//! src-tauri\src\control\mod.rs — the `ctl.*` bus surface: one command any
//! hosted agent's tab can run to see, show, or focus, no MCP schema on any
//! turn. `route` is called
//! inline from the bus reader thread (falcon.rs's `bus_subscribe` closure,
//! `main.rs`), so it must never block: each verb either answers
//! synchronously (bad args, a confinement refusal) or emits a `ctl-*` event
//! to the frontend and parks `(reply_to, msg_id)` here, keyed by a request id
//! this module mints (an internal correlation counter, not a security token —
//! see `pty.rs`'s `VIDAR_CTL_TOKEN` for the one that is). The frontend answers
//! later through `control_result`, which pops the entry and publishes the
//! reply — the same deferral `open.rs` already used for `ask.open`.

pub mod ask;
pub mod card;
pub mod flow;
pub mod pending_ask;
pub mod policy;
pub mod secrets;
pub mod session;
pub mod wait;
pub mod workbench;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// Subscribed once alongside `ask.open` (`main.rs`); Falcon's bus treats the
/// trailing `.*` as a prefix pattern, so every `ctl.<verb>` frame matches.
pub const TOPIC: &str = "ctl.*";

/// A pending entry older than this is presumed timed out on the client side
/// (`client.mjs`'s own `timeoutMs`) — swept on the next insert rather than
/// answered, since there is nothing left to answer.
const PENDING_TTL: Duration = Duration::from_secs(60);
/// `Act`-class entries outlive `PENDING_TTL` (a human answering a card can
/// take a while) but are not exempt from the sweep outright (an abandoned
/// ask would leak forever) — they are bounded by
/// the card's own `card::CARD_TTL` plus a minute of slack for the sweep to
/// actually run, not the shorter client-timeout window everything else uses.
const ACT_TTL: Duration = Duration::from_secs(card::CARD_TTL.as_secs() + 60);
/// In-flight cap for every verb except `wait`: once this many non-wait
/// entries are live, a new one is refused synchronously instead of parked.
/// Waits have their own pool below, so parked waits (up to an hour each)
/// never starve the other verbs.
const PENDING_CAP: usize = 8;
/// Live waits one requester (`Requester::key()`: a tab's CLI and its MCP
/// server share it) may hold at once.
const WAIT_CAP_PER_REQUESTER: usize = 4;
/// Live waits across all requesters.
const WAIT_CEILING: usize = 16;

/// `admits()`'s answer for a new entry.
#[derive(Debug, PartialEq)]
enum Admit {
    Yes,
    Busy,
    /// A wait from the same requester on the same tab: park the new one; once
    /// its verb returns `Ok`, the named entry is answered `err superseded`.
    Supersede(String),
}

/// Whether a new entry fits. Non-wait: under `PENDING_CAP` non-wait entries.
/// Wait (`wait_tab` is `Some` for every wait, `None` otherwise): an existing
/// wait from `requester` on the same tab is superseded (it frees its own
/// slot, so no cap check); else under `WAIT_CAP_PER_REQUESTER` for this
/// requester and `WAIT_CEILING` overall. Called after the TTL sweep.
fn admits(pending: &HashMap<String, PendingReply>, requester: &str, wait_tab: Option<&str>) -> Admit {
    let Some(tab) = wait_tab else {
        let live = pending.values().filter(|e| e.wait_tab.is_none()).count();
        return if live < PENDING_CAP { Admit::Yes } else { Admit::Busy };
    };
    if let Some((id, _)) = pending
        .iter()
        .find(|(_, e)| e.requester == requester && e.wait_tab.as_deref() == Some(tab))
    {
        return Admit::Supersede(id.clone());
    }
    let waits = || pending.values().filter(|e| e.wait_tab.is_some());
    if waits().filter(|e| e.requester == requester).count() >= WAIT_CAP_PER_REQUESTER
        || waits().count() >= WAIT_CEILING
    {
        return Admit::Busy;
    }
    Admit::Yes
}

#[derive(Default)]
pub struct ControlState {
    pending: Mutex<HashMap<String, PendingReply>>,
    next_id: AtomicU64,
    /// Set by `drain_pending` on window close: from then on `route` answers
    /// `err bus gone` at once instead of parking anything.
    closing: AtomicBool,
}

struct PendingReply {
    reply_to: String,
    msg_id: String,
    inserted_at: Instant,
    /// Sweep bound for this entry: `PENDING_TTL`, `ACT_TTL`, or a `wait`'s
    /// own timeout plus slack (`wait::pending_ttl`).
    ttl: Duration,
    /// `Requester::key()` of whoever asked; waits are capped per requester.
    requester: String,
    /// `Some(tab)` for a `wait` (counted in the wait pool, superseded by the
    /// same requester's next wait on that tab); `None` for every other verb.
    wait_tab: Option<String>,
}

/// Bus handler for every `ctl.<verb>` frame. Resolves the requester and the
/// per-verb rate cap, then hands off to the verb's module; that module either
/// returns `Err` (answered synchronously, below) or emits its `ctl-*` event
/// and returns `Ok` (answered later via `control_result`).
pub fn route(app: &AppHandle, frame: &Value) {
    let Some(topic) = frame.get("topic").and_then(Value::as_str) else { return };
    let Some(verb) = topic.strip_prefix("ctl.") else { return };
    let Some(reply_to) = frame.get("reply_to").and_then(Value::as_str) else { return };
    let reply_to = reply_to.to_string();
    let msg_id = frame.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let payload = frame.get("payload").cloned().unwrap_or(Value::Null);

    if app.state::<ControlState>().closing.load(Ordering::SeqCst) {
        publish_bus_reply(app, &reply_to, &msg_id, json!({ "ok": false, "line": "err bus gone" }));
        return;
    }

    let class = policy::class_of(verb);
    if class == policy::Class::Denied {
        publish_bus_reply(app, &reply_to, &msg_id, json!({ "ok": false, "line": "err unknown verb" }));
        return;
    }

    let policy_state = app.state::<policy::PolicyState>();
    let requester = match policy::resolve(&policy_state, &payload) {
        // A spawned hosted tab's session -> tab truth is `falcon.hosted`, not
        // the frontend's `falconSession` (set only for adopted tabs).
        Ok(r) => {
            let falcon = app.state::<std::sync::Arc<crate::falcon::Falcon>>();
            policy::attach_hosted_tab(r, |session| falcon.hosted_tab_for_session(session))
        }
        Err(reason) => {
            publish_bus_reply(app, &reply_to, &msg_id, json!({ "ok": false, "line": format!("err {reason}") }));
            return;
        }
    };
    if let Err(reason) = policy::check_rate(&policy_state, class, requester.key()) {
        publish_bus_reply(app, &reply_to, &msg_id, json!({ "ok": false, "line": format!("err {reason}") }));
        return;
    }
    drop(policy_state);

    // `pend`/`unpend` answer at once and never park: outside PENDING_CAP and ACT_TTL.
    if class == policy::Class::Post {
        let result = if verb == "unpend" {
            pending_ask::withdraw(app, &requester, &payload)
        } else {
            pending_ask::post(app, &requester, &payload)
        };
        let line = match result {
            Ok(line) => json!({ "ok": true, "line": line }),
            Err(reason) => json!({ "ok": false, "line": format!("err {reason}") }),
        };
        publish_bus_reply(app, &reply_to, &msg_id, line);
        return;
    }

    let control_state = app.state::<ControlState>();
    let id = control_state.next_id.fetch_add(1, Ordering::SeqCst).to_string();
    let mut busy = false;
    let mut gone = false;
    let mut supersedes: Option<String> = None;
    // Every wait lands in the wait pool; a missing or bad tab still gets a key
    // here and is refused by `wait::wait` before any supersede happens.
    let wait_tab = wait_key(verb, &payload, &id);
    // `wait` blocks for up to its own timeout (10 min default), far past
    // `PENDING_TTL`; its entry lives as long as that timeout plus slack.
    let entry_ttl = if class == policy::Class::Act {
        ACT_TTL
    } else if verb == "wait" || verb == "flow-wait" {
        wait::pending_ttl(&payload)
    } else {
        PENDING_TTL
    };
    if let Ok(mut pending) = control_state.pending.lock() {
        // The client has already given up on anything this old (`client.mjs`
        // `timeoutMs`); drop it rather than ever answer it. `Act`-class
        // entries get the longer `ACT_TTL` instead of a full exemption: a
        // human answering a card can outlive `PENDING_TTL` by a wide margin,
        // but an abandoned one must not outlive the card's own `CARD_TTL` by
        // more than a minute of sweep slack.
        let now = Instant::now();
        pending.retain(|_, entry| now.saturating_duration_since(entry.inserted_at) < entry.ttl);
        // Re-checked under the lock: `drain_pending` sets `closing` before it
        // takes the map, so nothing parks after the drain.
        let admit = if control_state.closing.load(Ordering::SeqCst) {
            gone = true;
            Admit::Busy
        } else {
            admits(&pending, requester.key(), wait_tab.as_deref())
        };
        match admit {
            Admit::Busy => busy = true,
            admit => {
                if let Admit::Supersede(old) = admit {
                    supersedes = Some(old);
                }
                pending.insert(
                    id.clone(),
                    PendingReply {
                        reply_to: reply_to.clone(),
                        msg_id: msg_id.clone(),
                        inserted_at: now,
                        ttl: entry_ttl,
                        requester: requester.key().to_string(),
                        wait_tab: wait_tab.clone(),
                    },
                );
            }
        }
    }
    drop(control_state);
    if busy {
        let line = if gone { "err bus gone" } else { "err busy" };
        publish_bus_reply(app, &reply_to, &msg_id, json!({ "ok": false, "line": line }));
        return;
    }

    let outcome = if class == policy::Class::Act {
        // `prompt`, `spawn` and `ask` each validate their own
        // details shape (`session::prompt`/`session::spawn`/`ask::ask`) then
        // call `card::request` themselves — every `Act` verb now goes through
        // the same 3-slot cap and `CARD_TTL` (ask must not bypass `card::request`
        // and emit `ctl-card` itself, sharing the control counter as its card
        // id). Every `Act` verb has a
        // real arm; the fallthrough stays as a guard for a future verb
        // classed `Act` in `policy.rs` before it lands one here.
        match verb {
            "prompt" => session::prompt(app, &id, &requester, &payload),
            "spawn" => session::spawn(app, &id, &requester, &payload),
            "ask" => ask::ask(app, &id, &requester, &payload),
            "flow" => flow::start(app, &id, &requester, &payload),
            _ => card::request(app, &id, &requester, verb, payload.clone()),
        }
    } else {
        match verb {
            "state" => session::state(app, &id, &requester, &payload),
            "read" => session::read(app, &id, &requester, &payload),
            "wait" => wait::wait(app, &id, &requester, &payload),
            "flow-save" => flow::save(app, &id, &requester, &payload),
            "flow-status" => flow::observe(app, &id, &requester, &payload, false),
            "flow-wait" => flow::observe(app, &id, &requester, &payload, true),
            "show" => workbench::show(app, &id, &requester, &payload),
            "focus" => workbench::focus(app, &id, &requester, &payload),
            _ => Err("unknown verb".to_string()),
        }
    };
    match outcome {
        // Synchronous refusal: nothing will ever call `control_result` for
        // this id, so answer now and drop the pending entry ourselves. A
        // wait it would have superseded stays live.
        Err(reason) => expire_pending(app, &id, &reason),
        Ok(()) => {
            if let Some(old) = supersedes {
                cancel_wait(app, &old, "superseded");
            }
        }
    }
}

/// Ordinary tab waits supersede by tab. Flow waits use their own request id.
fn wait_key(verb: &str, payload: &Value, id: &str) -> Option<String> {
    match verb {
        "wait" => Some(payload.get("tab").and_then(Value::as_str).unwrap_or("").to_string()),
        "flow-wait" => Some(id.to_string()),
        _ => None,
    }
}

/// Ends a parked wait from the Rust side: answers `err <reason>` on its bus
/// and emits `ctl-wait-cancel { id }` so `src\control\listen.ts` aborts the
/// watcher behind it. A no-op if the entry is already gone (answered or
/// swept). Generic over `R` like `expire_pending`.
pub(crate) fn cancel_wait<R: Runtime>(app: &AppHandle<R>, id: &str, reason: &str) {
    let control_state = app.state::<ControlState>();
    let entry = control_state.pending.lock().ok().and_then(|mut p| p.remove(id));
    drop(control_state);
    if let Some(entry) = entry {
        publish_bus_reply(app, &entry.reply_to, &entry.msg_id, json!({ "ok": false, "line": format!("err {reason}") }));
        let _ = app.emit("ctl-wait-cancel", json!({ "id": id }));
    }
}

/// Vidar is closing (`main.rs` CloseRequested): sets `closing` so `route`
/// parks nothing more, takes every pending entry out under the lock, then
/// answers each `err <reason>` (waits also get `ctl-wait-cancel`). Falcon
/// outlives Vidar, so without this a parked client runs to its own timeout.
/// Publishes nothing when the bus is unreachable without launching a host:
/// an exiting Vidar must never start one.
pub fn drain_pending(app: &AppHandle, reason: &str) {
    let control_state = app.state::<ControlState>();
    control_state.closing.store(true, Ordering::SeqCst);
    let entries = control_state
        .pending
        .lock()
        .map(|mut p| std::mem::take(&mut *p))
        .unwrap_or_default();
    drop(control_state);
    let falcon = app.state::<std::sync::Arc<crate::falcon::Falcon>>();
    if entries.is_empty() || !falcon.bus_reachable_without_launch() {
        return;
    }
    drop(falcon);
    for (id, entry) in entries {
        publish_bus_reply(app, &entry.reply_to, &entry.msg_id, json!({ "ok": false, "line": format!("err {reason}") }));
        if entry.wait_tab.is_some() {
            let _ = app.emit("ctl-wait-cancel", json!({ "id": id }));
        }
    }
}

/// Pops `id`'s pending entry, if still present, and publishes `err <reason>`
/// on the bus it came in on. Shared by `route()`'s synchronous-refusal path
/// and `card.rs`'s TTL sweep (an unanswered card unparks its `mod.rs` entry
/// the same way).
/// Generic over `R` (not just the shipped `Wry` runtime) purely so
/// `card.rs`'s `#[test]` can call it through a `tauri::test::mock_app()`
/// handle; every real call site still resolves `R = Wry` same as before.
pub(crate) fn expire_pending<R: Runtime>(app: &AppHandle<R>, id: &str, reason: &str) {
    let control_state = app.state::<ControlState>();
    let entry = control_state.pending.lock().ok().and_then(|mut p| p.remove(id));
    if let Some(entry) = entry {
        publish_bus_reply(app, &entry.reply_to, &entry.msg_id, json!({ "ok": false, "line": format!("err {reason}") }));
    }
}

/// Publish one reply frame. Best-effort: a failure here has no caller to
/// report to (the asker's own timeout is the fallback, same as everywhere
/// else on this bus). Shared by both bridges. Generic over `R` for the same reason as
/// `expire_pending` above.
pub(crate) fn publish_bus_reply<R: Runtime>(app: &AppHandle<R>, reply_to: &str, id: &str, body: Value) {
    let falcon = app.state::<std::sync::Arc<crate::falcon::Falcon>>();
    let _ = falcon.bus_publish(reply_to, id, body, None);
}

/// The frontend's answer to a verb it was asked to perform
/// (`src\control\listen.ts`): pops the pending entry and publishes
/// `{ ok, line }` on the bus the original request came in on.
#[tauri::command]
pub fn control_result(
    app: AppHandle,
    state: State<ControlState>,
    card_state: State<card::CardState>,
    id: String,
    ok: bool,
    line: String,
    card_id: Option<String>,
    verdict: Option<String>,
) {
    let entry = state.pending.lock().ok().and_then(|mut p| p.remove(&id));
    if let Some(entry) = entry {
        let mut body = json!({ "ok": ok, "line": line });
        if let Some(verdict) = verdict { body["verdict"] = json!(verdict); }
        publish_bus_reply(&app, &entry.reply_to, &entry.msg_id, body);
    }
    if let Some(card_id) = card_id {
        card::settle(&card_state, &card_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(requester: &str, wait_tab: Option<&str>) -> PendingReply {
        PendingReply {
            reply_to: String::new(),
            msg_id: String::new(),
            inserted_at: Instant::now(),
            ttl: PENDING_TTL,
            requester: requester.to_string(),
            wait_tab: wait_tab.map(str::to_string),
        }
    }

    #[test]
    fn waits_are_capped_per_requester_under_a_ceiling_and_leave_other_verbs_their_pool() {
        let mut pending = HashMap::new();
        // Per requester: 4 waits on distinct tabs, the 5th is busy.
        for t in 0..WAIT_CAP_PER_REQUESTER {
            let tab = format!("t{t}");
            assert_eq!(admits(&pending, "r0", Some(&tab)), Admit::Yes);
            pending.insert(format!("r0-{tab}"), entry("r0", Some(&tab)));
        }
        assert_eq!(admits(&pending, "r0", Some("t9")), Admit::Busy, "a 5th wait from one requester is busy");
        // Same requester, same tab: supersede, even at the cap.
        assert_eq!(admits(&pending, "r0", Some("t0")), Admit::Supersede("r0-t0".to_string()));
        // Another requester waiting on the same tab is its own wait.
        assert_eq!(admits(&pending, "r1", Some("t0")), Admit::Yes);
        // Fill other requesters to the ceiling; then even a fresh requester is busy.
        for r in 1..(WAIT_CEILING / WAIT_CAP_PER_REQUESTER) {
            for t in 0..WAIT_CAP_PER_REQUESTER {
                let (req, tab) = (format!("r{r}"), format!("t{t}"));
                assert_eq!(admits(&pending, &req, Some(&tab)), Admit::Yes);
                pending.insert(format!("{req}-{tab}"), entry(&req, Some(&tab)));
            }
        }
        assert_eq!(admits(&pending, "fresh", Some("t0")), Admit::Busy, "ceiling holds across requesters");
        // A full wait pool leaves every non-wait slot open; that pool keeps its own cap.
        for i in 0..PENDING_CAP {
            assert_eq!(admits(&pending, "r0", None), Admit::Yes);
            pending.insert(format!("o{i}"), entry("r0", None));
        }
        assert_eq!(admits(&pending, "r9", None), Admit::Busy, "non-wait cap still holds");
    }

    #[test]
    fn flow_waits_on_one_run_keep_separate_bus_pending_slots() {
        let payload = json!({ "run_id": "same-run" });
        let first = wait_key("flow-wait", &payload, "request-1").unwrap();
        let second = wait_key("flow-wait", &payload, "request-2").unwrap();
        let mut pending = HashMap::new();
        assert_eq!(admits(&pending, "same-requester", Some(&first)), Admit::Yes);
        pending.insert("request-1".to_string(), entry("same-requester", Some(&first)));
        assert_eq!(admits(&pending, "same-requester", Some(&second)), Admit::Yes);
        pending.insert("request-2".to_string(), entry("same-requester", Some(&second)));
        assert_eq!(pending.len(), 2);
        assert!(pending.remove("request-1").is_some());
        assert!(pending.remove("request-2").is_some());
        assert!(pending.is_empty());
    }
}
