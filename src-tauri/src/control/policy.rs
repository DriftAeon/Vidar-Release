//! src-tauri\src\control\policy.rs — verb classes, per-verb per-requester rate
//! caps, and the PTY token map. Gating lives here, not in the agent's context: a caller never sees
//! a schema, just a `line` back.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

pub type TabId = String;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Class {
    Observe,
    Workbench,
    /// Goes through an approval card (`control\card.rs`); `route()`
    /// sends `prompt`/`spawn`/`ask` to their own modules, each of which
    /// calls `card::request`.
    Act,
    /// `pend`/`unpend`: answered at once, stored in `pending-asks.json`, no card.
    Post,
    Denied,
}

/// Verb -> class (plan `Verbs` table). Unknown verbs fall through to
/// `Denied`; `prompt`/`spawn`/`ask` classify as `Act`, and each has its own
/// `route()` arm that goes through `card::request`.
pub fn class_of(verb: &str) -> Class {
    match verb {
        "state" => Class::Observe,
        "read" | "wait" | "flow-status" | "flow-wait" => Class::Observe,
        "show" | "focus" | "flow-save" => Class::Workbench,
        "prompt" | "spawn" | "ask" | "flow" => Class::Act,
        "pend" | "unpend" => Class::Post,
        _ => Class::Denied,
    }
}

fn cap_per_min(class: Class) -> u32 {
    match class {
        Class::Observe => 60,
        Class::Workbench => 20,
        Class::Post => 6,
        Class::Act | Class::Denied => 0,
    }
}

/// Who asked, once resolved. `Token` already names a real Vidar tab (the PTY
/// token map below). `FalconSession` names a Falcon session id plus, when
/// `falcon.hosted` has it (a tab this Vidar spawned hosted), the tab id behind
/// it (`attach_hosted_tab`). With no `tab`, the frontend's own session -> tab
/// lookup (`sessions.ts`, adopted tabs) is the only check, so
/// `src\control\listen.ts` re-checks before acting.
#[derive(Clone, Debug, PartialEq)]
pub enum Requester {
    Token(TabId),
    FalconSession { session: String, tab: Option<TabId> },
}

impl Requester {
    /// Rate-limit key: unique per requester either way.
    pub fn key(&self) -> &str {
        match self {
            Requester::Token(tab) => tab,
            Requester::FalconSession { session, .. } => session,
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            Requester::Token(tab) => json!({ "kind": "token", "tab": tab }),
            Requester::FalconSession { session, tab: Some(tab) } => {
                json!({ "kind": "falcon_session", "session": session, "tab": tab })
            }
            Requester::FalconSession { session, tab: None } => {
                json!({ "kind": "falcon_session", "session": session })
            }
        }
    }
}

/// Fills a `FalconSession` requester's `tab` from `lookup` (session -> Vidar
/// tab id; in production `Falcon::hosted_tab_for_session`). A miss leaves the
/// bare session identity, which the frontend still resolves for adopted tabs.
/// `Token` requesters pass through untouched.
pub fn attach_hosted_tab(requester: Requester, lookup: impl FnOnce(&str) -> Option<TabId>) -> Requester {
    match requester {
        Requester::FalconSession { session, tab: None } => {
            let tab = lookup(&session);
            Requester::FalconSession { session, tab }
        }
        other => other,
    }
}

#[derive(Default)]
pub struct PolicyState {
    /// `VIDAR_CTL_TOKEN` -> tab id, minted and registered in `pty.rs`.
    tokens: Mutex<HashMap<String, TabId>>,
    hits: Mutex<HashMap<(String, Class), Vec<Instant>>>,
}

/// Register a PTY tab's minted token (`pty.rs`, beside `VIDAR_TAB`).
pub fn register(state: &PolicyState, token: String, tab: TabId) {
    if let Ok(mut tokens) = state.tokens.lock() {
        tokens.insert(token, tab);
    }
}

/// Drop every token naming `tab` — called where the PTY is dropped.
pub fn unregister(state: &PolicyState, tab: &str) {
    if let Ok(mut tokens) = state.tokens.lock() {
        tokens.retain(|_, t| t != tab);
    }
}

/// Drop one token only. A bare agent spawn uses this, so a refused duplicate spawn on a live
/// tab id cannot clear the live process's token.
pub fn unregister_token(state: &PolicyState, token: &str) {
    if let Ok(mut tokens) = state.tokens.lock() {
        tokens.remove(token);
    }
}

/// `{ token }` must match a registered PTY token; `{ falcon_session, secret }`
/// must carry the secret Vidar minted for that session at spawn
/// (`control::secrets`, exported to the child as `VIDAR_CTL_SECRET`); anything
/// else — a `{ token }` that matches nothing, a missing or wrong secret, a
/// session with no stored secret — is `no requester`.
pub fn resolve(state: &PolicyState, payload: &Value) -> Result<Requester, String> {
    resolve_with(state, payload, super::secrets::get)
}

/// `resolve` with the session -> stored-digest lookup injected (tests). The
/// store holds `sha256(secret)`; the given secret is hashed before the
/// constant-time compare, so the file's contents are not a usable secret.
pub(crate) fn resolve_with(
    state: &PolicyState,
    payload: &Value,
    stored_digest: impl FnOnce(&str) -> Option<String>,
) -> Result<Requester, String> {
    if let Some(token) = payload.get("token").and_then(Value::as_str) {
        let tab = state.tokens.lock().ok().and_then(|tokens| tokens.get(token).cloned());
        return tab.map(Requester::Token).ok_or_else(|| "no requester".to_string());
    }
    if let Some(session) = payload.get("falcon_session").and_then(Value::as_str) {
        if session.is_empty() {
            return Err("no requester".to_string());
        }
        let Some(given) = payload.get("secret").and_then(Value::as_str) else {
            return Err("no requester".to_string());
        };
        let Some(stored) = stored_digest(session) else {
            return Err("no requester".to_string());
        };
        if given.is_empty() {
            return Err("no requester".to_string());
        }
        let given = super::secrets::digest(given);
        if !super::secrets::is_digest(&stored)
            || !constant_time_eq(given.as_bytes(), stored.as_bytes())
        {
            return Err("no requester".to_string());
        }
        return Ok(Requester::FalconSession { session: session.to_string(), tab: None });
    }
    Err("no requester".to_string())
}

/// Compares without an early exit on the first differing byte. A length
/// mismatch returns at once: the length (64, a digest) is public.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Sliding one-minute window per (requester, class); `Act`/`Denied` have no
/// cap here (0 means unmetered — `Act` waits on the slice B approval card,
/// `Denied` never reaches this call).
pub fn check_rate(state: &PolicyState, class: Class, requester: &str) -> Result<(), String> {
    let cap = cap_per_min(class);
    if cap == 0 {
        return Ok(());
    }
    let now = Instant::now();
    let mut hits = state.hits.lock().map_err(|_| "policy lock poisoned".to_string())?;
    let key = (requester.to_string(), class);
    // Sweep the whole map to the same time bound: a window every hit has
    // aged out of is dead weight regardless of which key it belongs to — an
    // attacker-chosen (Falcon session) requester key would otherwise squat
    // in the map forever.
    hits.retain(|_, w| {
        w.retain(|t| now.saturating_duration_since(*t) < Duration::from_secs(60));
        !w.is_empty()
    });
    let window = hits.entry(key).or_default();
    if window.len() as u32 >= cap {
        return Err("rate limit".to_string());
    }
    window.push(now);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "0123456789abcdef0123456789abcdef";

    fn stored(session: &str) -> Option<String> {
        session.starts_with("s-").then(|| crate::control::secrets::digest(SECRET))
    }

    #[test]
    fn unregister_token_drops_one_token_and_leaves_the_live_one() {
        // A refused duplicate spawn on a live tab id drops only its own token.
        let state = PolicyState::default();
        register(&state, "live".into(), "tab-1".into());
        register(&state, "refused".into(), "tab-1".into());
        unregister_token(&state, "refused");
        assert_eq!(resolve_with(&state, &json!({ "token": "live" }), stored), Ok(Requester::Token("tab-1".into())));
        assert_eq!(resolve_with(&state, &json!({ "token": "refused" }), stored), Err("no requester".to_string()));
    }

    #[test]
    fn the_stored_digest_is_not_a_usable_secret() {
        let digest = crate::control::secrets::digest(SECRET);
        let r = resolve_with(&PolicyState::default(), &json!({ "falcon_session": "s-1", "secret": digest }), stored);
        assert_eq!(r, Err("no requester".to_string()), "presenting the file's value must not resolve");
    }

    #[test]
    fn a_plaintext_stored_value_never_matches_as_plaintext() {
        let r = resolve_with(&PolicyState::default(), &json!({ "falcon_session": "s-1", "secret": SECRET }), |_| {
            Some(SECRET.to_string())
        });
        assert_eq!(r, Err("no requester".to_string()));
    }

    #[test]
    fn an_empty_given_secret_is_refused_even_against_its_digest() {
        let r = resolve_with(&PolicyState::default(), &json!({ "falcon_session": "s-1", "secret": "" }), |_| {
            Some(crate::control::secrets::digest(""))
        });
        assert_eq!(r, Err("no requester".to_string()));
    }

    fn falcon(session: &str) -> Requester {
        resolve_with(&PolicyState::default(), &json!({ "falcon_session": session, "secret": SECRET }), stored)
            .unwrap()
    }

    #[test]
    fn falcon_session_without_secret_is_refused() {
        let r = resolve_with(&PolicyState::default(), &json!({ "falcon_session": "s-1" }), stored);
        assert_eq!(r, Err("no requester".to_string()));
        let r = resolve_with(&PolicyState::default(), &json!({ "falcon_session": "s-1", "secret": 7 }), stored);
        assert_eq!(r, Err("no requester".to_string()));
    }

    #[test]
    fn falcon_session_with_wrong_secret_is_refused() {
        let wrong = "0123456789abcdef0123456789abcdee";
        let r = resolve_with(&PolicyState::default(), &json!({ "falcon_session": "s-1", "secret": wrong }), stored);
        assert_eq!(r, Err("no requester".to_string()));
        let r = resolve_with(&PolicyState::default(), &json!({ "falcon_session": "s-1", "secret": "short" }), stored);
        assert_eq!(r, Err("no requester".to_string()));
    }

    #[test]
    fn falcon_session_with_no_stored_secret_is_refused() {
        let r = resolve_with(&PolicyState::default(), &json!({ "falcon_session": "x-1", "secret": SECRET }), stored);
        assert_eq!(r, Err("no requester".to_string()));
        let r = resolve_with(&PolicyState::default(), &json!({ "falcon_session": "s-1", "secret": "" }), |_| {
            Some(String::new())
        });
        assert_eq!(r, Err("no requester".to_string()), "an empty stored secret never matches");
    }

    #[test]
    fn falcon_session_with_matching_secret_is_accepted() {
        assert_eq!(falcon("s-1"), Requester::FalconSession { session: "s-1".into(), tab: None });
    }

    #[test]
    fn hosted_session_gets_its_tab() {
        let r = attach_hosted_tab(falcon("s-1"), |s| (s == "s-1").then(|| "tab-7".to_string()));
        assert_eq!(r, Requester::FalconSession { session: "s-1".into(), tab: Some("tab-7".into()) });
        assert_eq!(r.key(), "s-1");
        assert_eq!(r.to_json(), json!({ "kind": "falcon_session", "session": "s-1", "tab": "tab-7" }));
    }

    #[test]
    fn unknown_session_keeps_bare_identity() {
        let r = attach_hosted_tab(falcon("s-2"), |_| None);
        assert_eq!(r, Requester::FalconSession { session: "s-2".into(), tab: None });
        assert_eq!(r.to_json(), json!({ "kind": "falcon_session", "session": "s-2" }));
    }

    #[test]
    fn token_requester_is_not_looked_up() {
        let state = PolicyState::default();
        register(&state, "tok".into(), "tab-1".into());
        let r = resolve(&state, &json!({ "token": "tok" })).unwrap();
        let r = attach_hosted_tab(r, |_| panic!("token requester must not hit the hosted map"));
        assert_eq!(r, Requester::Token("tab-1".into()));
    }

    #[test]
    fn empty_session_is_no_requester() {
        assert!(resolve_with(&PolicyState::default(), &json!({ "falcon_session": "", "secret": SECRET }), |_| {
            Some(crate::control::secrets::digest(SECRET))
        })
        .is_err());
    }
}
