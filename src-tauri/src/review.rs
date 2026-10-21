//! Astra review bridge, Rust half: pick up dispatch requests a Claude session
//! drops under bridge\review\dispatch, hand each one to the frontend exactly
//! once, and record the frontend's verdict. The frontend owns tab identity
//! (names live only there) and does the typing; this side only guarantees
//! "at most once" and leaves an audit trail on disk.
//!
//! Files (all under bridge\review; the folder survives restarts — findings
//! must — only dispatch\ is swept):
//!   dispatch\<id>.json          request, published by the requester via rename
//!   dispatch\<id>.claimed       the same file after we took it (never re-read)
//!   dispatch\stale\…            anything found at startup or rejected, with a reason
//!   <id>\pending.json           written right after the claim, before the emit
//!   <id>\dispatch-result.json   frontend verdict via review_result
//!   <id>\done.json              written by tools\desks\codex-notify.ps1, not by us
//!
//! Claim-by-rename before emit: a crash between the two loses the request
//! (the requester times out and says so) rather than typing it twice after a
//! restart. Lost is the better failure (plan review, risk 4).
//!
//! The claim / park / pending / poll mechanics live in dispatch_bridge.rs
//! shared with open.rs; the `Dispatch` shape and
//! `validate` below are this bridge's own and are the whole acceptance rule.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::dispatch_bridge::{self, valid_id, Accepted, Bridge};
use crate::fsx::now_ms;

fn bridge() -> Bridge {
    Bridge {
        root: crate::paths::review_dir(),
        dispatch: crate::paths::review_dispatch_dir(),
        stale: crate::paths::review_stale_dir(),
    }
}
const MAX_TEXT: usize = 4000;
const MAX_TAB: usize = 64;
/// How long the dispatch card may wait for the user, from the claim. Same 280 s as
/// `control::card::CARD_TTL` (a copy here: that constant shrinks to 50 ms under `cfg(test)`).
const CARD_TTL_MS: u64 = 280_000;

/// Set by the frontend once its `review-dispatch` listener is attached. The
/// poller does not claim anything before that: a request that lands during
/// startup just waits on disk instead of being emitted into the void.
#[derive(Default)]
pub struct ReviewState {
    ready: AtomicBool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Dispatch {
    id: String,
    tab: String,
    text: String,
    requester: String,
}

/// What the frontend receives on `review-dispatch`: the request plus the card's clock
/// (`claimedAtMs` is when we claimed it, `expiresAtMs` when the card stops being answerable).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchPayload {
    id: String,
    tab: String,
    text: String,
    requester: String,
    claimed_at_ms: u64,
    expires_at_ms: u64,
}

fn payload(d: Dispatch, claimed_at_ms: u64) -> DispatchPayload {
    DispatchPayload {
        id: d.id,
        tab: d.tab,
        text: d.text,
        requester: d.requester,
        claimed_at_ms,
        expires_at_ms: claimed_at_ms + CARD_TTL_MS,
    }
}

/// Unicode general category Cf, listed out (std has `is_control` for Cc only).
fn is_format_char(c: char) -> bool {
    matches!(u32::from(c),
        0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x0890..=0x0891 | 0x08E2 | 0x180E
        | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF
        | 0xFFF9..=0xFFFB | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3
        | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)
}

/// Cc, Cf and the line/paragraph separators: nothing the card could show faithfully.
fn is_unsafe_char(c: char) -> bool {
    c.is_control() || is_format_char(c) || c == '\u{2028}' || c == '\u{2029}'
}

/// Anything sitting in dispatch\ when Vidar starts is from a previous life:
/// the tab it named is gone. Parked, never typed, never deleted.
pub fn quarantine_stale() {
    bridge().quarantine_stale("found at startup: the tab it named no longer exists");
}

pub(crate) fn validate(d: &Dispatch, file_stem: &str) -> Result<(), String> {
    if !valid_id(&d.id) {
        return Err("id must be 8 lowercase hex".into());
    }
    if d.id != file_stem {
        return Err("id does not match the file name".into());
    }
    if d.tab.is_empty() || d.tab.len() > MAX_TAB {
        return Err("tab name empty or too long".into());
    }
    if d.text.is_empty() || d.text.len() > MAX_TEXT {
        return Err("text empty or over 4000 bytes".into());
    }
    // One line, no control characters: the TUI would treat a newline as a
    // paste line break and anything else as a key chord.
    // The card shows these bytes to the user: format characters and U+2028/2029 would hide or reflow them.
    if d.text.chars().any(is_unsafe_char) {
        return Err("text must be a single line with no control characters".into());
    }
    if d.requester.is_empty() || d.requester.len() > 64 {
        return Err("requester empty or too long".into());
    }
    if d.requester.chars().any(is_unsafe_char) {
        return Err("requester must not contain control or format characters".into());
    }
    Ok(())
}

/// This bridge's acceptance rule for one claimed request: `validate`, then
/// the pending record and the emitted payload (the request itself).
fn accept(d: Dispatch, stem: &str) -> Result<Accepted<DispatchPayload>, String> {
    validate(&d, stem)?;
    let claimed = now_ms();
    let pending = serde_json::json!({ "id": d.id, "tab": d.tab, "requester": d.requester, "claimed_at_ms": claimed });
    Ok(Accepted { id: d.id.clone(), pending, payload: payload(d, claimed) })
}

fn scan(app: &AppHandle) {
    bridge().scan(accept, |d| {
        let _ = app.emit("review-dispatch", d);
    });
}

pub fn start_dispatch_poller(app: AppHandle) {
    dispatch_bridge::start_poller(app, |app| app.state::<ReviewState>().ready.load(Ordering::Relaxed), scan);
}

/// Frontend: "my review-dispatch listener is attached". Idempotent.
#[tauri::command]
pub fn review_ready(state: State<ReviewState>) {
    state.ready.store(true, Ordering::Relaxed);
}

/// Frontend verdict for one dispatch: typed into `tab`, or refused with a
/// reason. Written atomically; the requester's waiter reads it once.
#[tauri::command]
pub fn review_result(id: String, ok: bool, tab: Option<String>, reason: Option<String>, tab_cwd: Option<String>) -> Result<(), String> {
    // Only ids this process actually claimed get a verdict;
    // record_verdict checks the id shape and the pending record.
    bridge().record_verdict(&id, &result_json(ok, tab, reason, tab_cwd, now_ms()))
}

/// The dispatch-result record. `tabCwd` is the armed tab's cwd on an approved dispatch (the
/// notify hook's done path matches the event cwd against it); absent otherwise.
fn result_json(ok: bool, tab: Option<String>, reason: Option<String>, tab_cwd: Option<String>, at_ms: u64) -> serde_json::Value {
    let mut v = serde_json::json!({ "ok": ok, "tab": tab, "reason": reason, "at_ms": at_ms });
    if let Some(c) = tab_cwd {
        v["tabCwd"] = serde_json::Value::String(c);
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch_bridge::tests::{stale_reasons, temp_bridge};
    use std::fs;

    /// A multi-line text is parked, through the
    /// shared scan, with no pending record and no emit.
    #[test]
    fn multiline_text_is_still_rejected() {
        let b = temp_bridge("review");
        let req = r#"{"id":"0123abcd","tab":"Astra","text":"one\ntwo","requester":"me"}"#;
        fs::write(b.dispatch.join("0123abcd.json"), req).unwrap();
        let mut emitted = 0;
        b.scan(accept, |_: DispatchPayload| emitted += 1);
        assert_eq!(emitted, 0);
        assert!(!b.root.join("0123abcd").exists());
        assert_eq!(stale_reasons(&b), ["text must be a single line with no control characters"]);
        let _ = fs::remove_dir_all(&b.root);
    }

    fn dispatch(text: &str, requester: &str) -> Dispatch {
        Dispatch { id: "0123abcd".into(), tab: "astra".into(), text: text.into(), requester: requester.into() }
    }

    #[test]
    fn requester_and_text_reject_control_format_and_separator_characters() {
        assert!(validate(&dispatch("review it", "sess-1"), "0123abcd").is_ok());
        for bad in ['\u{0007}', '\u{200B}', '\u{202E}', '\u{FEFF}', '\u{00AD}', '\u{2028}', '\u{2029}', '\u{E0041}', '\u{1D173}', '\u{13430}'] {
            let with = format!("a{bad}b");
            assert!(validate(&dispatch("review it", &with), "0123abcd").is_err(), "requester U+{:04X}", bad as u32);
            assert!(validate(&dispatch(&with, "sess-1"), "0123abcd").is_err(), "text U+{:04X}", bad as u32);
        }
        // Ordinary non-ASCII letters and spaces stay legal.
        assert!(validate(&dispatch("revue de caf\u{00E9} \u{65E5}\u{672C}", "s\u{00FC}ss"), "0123abcd").is_ok());
    }

    #[test]
    fn emitted_payload_carries_the_card_clock() {
        let p = payload(dispatch("t", "r"), 1_000);
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["claimedAtMs"], 1_000);
        assert_eq!(v["expiresAtMs"], 1_000 + 280_000);
        assert_eq!(v["requester"], "r");
        assert!(v.get("claimed_at_ms").is_none());
    }

    #[test]
    fn result_record_has_tab_cwd_only_when_given() {
        let with = result_json(true, Some("t1".into()), None, Some("C:\\x\\display".into()), 5);
        assert_eq!(with["tabCwd"], "C:\\x\\display");
        let without = result_json(false, None, Some("denied no".into()), None, 5);
        assert!(without.get("tabCwd").is_none());
        assert_eq!(without["ok"], false);
    }
}
