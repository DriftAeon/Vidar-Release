//! src-tauri\src\control\card.rs — the approval card `Class::Act` verbs park
//! behind: a
//! global 3-pending cap, its own TTL independent of `mod.rs`'s `PENDING_TTL`
//! sweep, so a lost card expires and frees its slot instead of wedging the
//! count into permanent `err busy` forever.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::policy::Requester;

/// In-flight card cap: once the map holds this many live cards, a new
/// request is refused synchronously (same shape as
/// `mod.rs`'s `PENDING_CAP`).
const CARD_CAP: usize = 3;
/// A card older than this self-expires on the next sweep. Kept inside the
/// 300 s client default (`client.mjs::VERB_TIMEOUT_MS`) so a card always
/// expires before the client gives up waiting.
#[cfg(not(test))]
pub const CARD_TTL: Duration = Duration::from_secs(280);
#[cfg(test)]
pub const CARD_TTL: Duration = Duration::from_millis(50);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Default)]
pub struct CardState {
    cards: Mutex<HashMap<String, CardEntry>>,
    next_id: AtomicU64,
}

struct CardEntry {
    control_id: String,
    created_at: Instant,
}

/// Mint an approval card for `control_id` (the `mod.rs` pending-map key this
/// card answers). Sweeps expired cards first — each swept entry unparks its
/// `mod.rs` pending entry with `err expired` — then refuses `err busy` if the
/// map is still full, otherwise emits `ctl-card` for the frontend to render.
pub fn request<R: Runtime>(
    app: &AppHandle<R>,
    control_id: &str,
    requester: &Requester,
    verb: &str,
    details: Value,
) -> Result<(), String> {
    let state = app.state::<CardState>();
    let now = Instant::now();

    // Sweep and cap-check happen under the lock; the guard drops at the end
    // of this block, before `expire_pending`/`emit` (publish) run below — a
    // held mutex across a publish is a deadlock shape, even
    // though nothing here recurses back into `card::request` today.
    let (expired, full) = {
        let mut cards = state.cards.lock().map_err(|_| "card lock poisoned".to_string())?;
        let mut expired = Vec::new();
        cards.retain(|card_id, entry| {
            if now.saturating_duration_since(entry.created_at) < CARD_TTL {
                true
            } else {
                expired.push((card_id.clone(), entry.control_id.clone()));
                false
            }
        });
        let full = cards.len() >= CARD_CAP;
        (expired, full)
    };

    for (expired_card_id, control_id) in expired {
        super::expire_pending(app, &control_id, "expired");
        // Tells the frontend to drop the stale modal: an
        // Approve after this would otherwise still run `promptTab`/`spawnTab`.
        let _ = app.emit("ctl-card-cancel", json!({ "cardId": expired_card_id }));
    }

    if full {
        return Err("busy".to_string());
    }

    let card_id = {
        let mut cards = state.cards.lock().map_err(|_| "card lock poisoned".to_string())?;
        let card_id = state.next_id.fetch_add(1, Ordering::SeqCst).to_string();
        cards.insert(
            card_id.clone(),
            CardEntry { control_id: control_id.to_string(), created_at: now },
        );
        card_id
    };

    let _ = app.emit("ctl-card", card_payload(control_id, &card_id, verb, requester, details, now_ms()));
    Ok(())
}

/// The `ctl-card` event body. `claimedAtMs` is stamped when the card is minted,
/// not by the frontend at receipt, and `expiresAtMs` is that instant plus
/// `CARD_TTL`: the frontend's expiry timers (`askgate.ts::askGate`,
/// `control/listen.ts`) read it instead of carrying their own copy of the TTL.
fn card_payload(
    control_id: &str,
    card_id: &str,
    verb: &str,
    requester: &Requester,
    details: Value,
    claimed_at_ms: u64,
) -> Value {
    json!({
        "id": control_id,
        "cardId": card_id,
        "verb": verb,
        "requester": requester.to_json(),
        "details": details,
        "claimedAtMs": claimed_at_ms,
        "expiresAtMs": claimed_at_ms + CARD_TTL.as_millis() as u64,
    })
}

/// Frees a card's slot immediately once the frontend answers it, rather than
/// waiting for the next sweep to notice (`mod.rs::control_result`).
pub fn settle(state: &CardState, card_id: &str) {
    if let Ok(mut cards) = state.cards.lock() {
        cards.remove(card_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;

    fn req() -> Requester {
        Requester::FalconSession { session: "test-session".to_string(), tab: None }
    }

    #[test]
    fn caps_at_three_then_expires_to_free_a_slot() {
        let app = mock_app();

        for i in 0..CARD_CAP {
            let id = format!("ctl-{i}");
            assert!(request(&app, &id, &req(), "prompt", json!({})).is_ok());
        }

        // Fourth concurrent request finds the cap full.
        assert_eq!(
            request(&app, "ctl-3", &req(), "prompt", json!({})),
            Err("busy".to_string())
        );

        // Advance past CARD_TTL (50ms under #[cfg(test)]) so the next
        // request's sweep clears every existing card first.
        sleep(CARD_TTL + Duration::from_millis(20));

        assert!(request(&app, "ctl-4", &req(), "prompt", json!({})).is_ok());
    }

    #[test]
    fn payload_carries_expiry_as_claimed_plus_ttl() {
        let v = card_payload("ctl-9", "7", "prompt", &req(), json!({ "k": 1 }), 1_000);
        assert_eq!(v["claimedAtMs"], json!(1_000u64));
        assert_eq!(v["expiresAtMs"], json!(1_000u64 + CARD_TTL.as_millis() as u64));
        assert_eq!(v["cardId"], json!("7"));
        assert_eq!(v["id"], json!("ctl-9"));
        assert!(v.get("expires_at_ms").is_none(), "wire key is camelCase");
    }

    fn mock_app() -> AppHandle<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(CardState::default());
        app.manage(super::super::ControlState::default());
        app.handle().clone()
    }
}
