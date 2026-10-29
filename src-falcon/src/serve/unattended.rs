//! The unattended-permission watcher: auto-show the shell for a permission
//! request no controller can answer (Claude only; hosted Codex does not show
//! it), and deny it once the grace runs out. The deny is the provider's own:
//! Claude's sidecar line, or the Codex card's contract refusal.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use serde_json::{json, Value};

use super::{mutation::dispatch_recorded, Host};
use crate::{journal::Body, session::Session};

/// How often [`watch_unattended_permission`] re-checks while waiting.
const UNATTENDED_POLL: Duration = Duration::from_millis(250);

/// The reader's own gate, factored out so it is one predicate rather than an
/// inline condition duplicated between production and its tests: an observed
/// line starts the unattended watcher only when it is a permission request
/// naming an id, and only when nobody currently holds the lease. A
/// subscriber without a lease cannot answer, so "no controller" is the
/// correct and only test for unattended — not "no subscribers".
pub(super) fn unattended_permission_target(session: &Session, value: &Value) -> Option<String> {
    // The driver names the request: Claude's `permission_request`, a hosted
    // Codex card.
    let request = session.driver.permission_request(value)?;
    if session.controller_holder().is_some() {
        return None;
    }
    Some(request)
}

/// The single choke point for "the controller just became `None`": called
/// from both release paths — the explicit `ReleaseControl` op and
/// [`super::slots::LeaseHold`]'s drop on connection teardown — right after each confirms
/// the lease actually changed hands to vacant.
///
/// A request can be raised while a controller holds the lease (the
/// observe-time spawn skips it, per [`unattended_permission_target`]) and
/// then never get a watcher if that controller later detaches without
/// answering it. This is what catches that: for every permission the driver
/// still holds as `Opened` and not already claimed by a watcher, spawn one
/// here, with the grace measured from now rather than from whenever the
/// permission was originally opened.
pub(super) fn watch_requests_left_unattended(host: &Arc<Host>, session: &Arc<Session>) {
    for (request, state) in session.driver.permission_states() {
        if matches!(state, crate::session::driver_props::PermissionState::Opened) {
            spawn_unattended_watcher(host, session, request);
        }
    }
}

/// Spawn [`watch_unattended_permission`] for `request`, unless it already has
/// a watcher — the observe-time call site and the lease-release call site
/// share [`Session::claim_unattended_watch`], so whichever gets there first
/// wins and the other is a no-op. Kept off the reader thread by the caller:
/// this only spawns.
pub(super) fn spawn_unattended_watcher(host: &Arc<Host>, session: &Arc<Session>, request: String) {
    if !session.claim_unattended_watch(&request) {
        return;
    }
    let host = Arc::clone(host);
    let thread_session = Arc::clone(session);
    let request_for_thread = request.clone();
    let spawned = std::thread::Builder::new()
        .name(format!("falcon-unattended-{}-{}", session.id, request))
        .spawn(move || {
            // Clears the claim on every exit path, including a panic inside
            // `watch_unattended_permission` — a straight-line call-then-clear
            // leaks the claim on unwind and permanently blocks a later
            // occurrence of the same request id from ever being watched again.
            let _guard = UnattendedWatchGuard {
                session: thread_session,
                request: request_for_thread,
            };
            watch_unattended_permission(host, Arc::clone(&_guard.session), _guard.request.clone());
        });
    if let Err(error) = spawned {
        eprintln!("falcon: failed to spawn unattended watcher: {error}");
        // The thread that would have cleared this claim never started.
        session.clear_unattended_watch(&request);
    }
}

/// Releases an unattended-watcher's claim on the request it is watching, on
/// every exit path from its thread — including a panic. See
/// [`spawn_unattended_watcher`].
struct UnattendedWatchGuard {
    session: Arc<Session>,
    request: String,
}

impl Drop for UnattendedWatchGuard {
    fn drop(&mut self) {
        self.session.clear_unattended_watch(&self.request);
    }
}

/// Show the shell for a permission request opened with no controller
/// attached, and deny it if nobody takes the lease before the grace elapses.
/// Never auto-allows — every branch below ends in a journal record, and the
/// only way out other than a deny is a controller acquiring the lease while
/// this waits.
///
/// Runs on its own thread, spawned by the stdout reader right after it
/// observes the request. It must never call [`dispatch_recorded`] (nor
/// anything that reaches `command_as`) from the reader itself: that waits for
/// an outcome which arrives back on that same reader thread, which is exactly
/// the deadlock this function's own thread exists to avoid.
pub(super) fn watch_unattended_permission(host: Arc<Host>, session: Arc<Session>, request: String) {
    // Measured from the request, before `show_shell` runs: a slow shell must
    // not buy the request extra grace. Zero grace polls forever: auto-show
    // still happens, it simply never times out.
    let mut deadline =
        (!host.unattended_grace.is_zero()).then(|| Instant::now() + host.unattended_grace);

    // Per provider: hosted Codex waits out the grace without showing the
    // shell, so nothing is recorded until the deny or an answer.
    if session.driver.shows_shell_unattended() {
        let shown = match host.show_shell.get() {
            Some(show_shell) => show_shell(),
            None => Err("no shell to show".into()),
        };
        if let Err(error) = shown {
            session.record_quietly(Body::PermissionUnattended {
                request: request.clone(),
                outcome: "show-failed".into(),
                reason: Some(error),
            });
            deny_unattended(
                &session,
                &request,
                "denied-show-failed",
                "the Falcon shell could not be shown",
            );
            return;
        }
        session.record_quietly(Body::PermissionUnattended {
            request: request.clone(),
            outcome: "shown".into(),
            reason: None,
        });
    }

    // Journalled once: a controller sitting on the lease across many polls
    // must not spam the journal with repeated "attended" records.
    let mut journalled_attended = false;
    // Whether the previous iteration saw a controller attached — the cue for
    // detecting the held-to-vacant edge below.
    let mut held = false;
    // The loop's only exit other than a settle (`moot`) is this deny, and it
    // fires only on an iteration where, right here and now, no controller
    // holds the lease AND the deadline has passed — so a controller
    // attaching in the last poll window, or one that is still holding the
    // lease at the deadline, is never raced into a deny: this same check
    // simply runs again next iteration once the lease goes vacant.
    //
    // A request that sat attended past the original deadline must not be
    // denied the instant the lease frees up — the controller may have just
    // released it after acting. So the deadline restarts, measured from the
    // moment the lease actually goes vacant again, every time it does.
    loop {
        if unattended_permission_moot(&session, &request) {
            return;
        }
        if session.controller_holder().is_some() {
            if !journalled_attended {
                session.record_quietly(Body::PermissionUnattended {
                    request: request.clone(),
                    outcome: "attended".into(),
                    reason: None,
                });
                journalled_attended = true;
            }
            held = true;
        } else {
            if held {
                deadline = (!host.unattended_grace.is_zero())
                    .then(|| Instant::now() + host.unattended_grace);
                held = false;
            }
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                deny_unattended(
                    &session,
                    &request,
                    "denied-timeout",
                    "no controller attached; timed out waiting for a response",
                );
                return;
            }
        }
        // Sleep no longer than the deadline itself: a fixed poll tick past an
        // already-known deadline would add up to one whole tick of pure
        // latency to every deny, on top of whatever it took to notice the
        // lease went vacant.
        let sleep_for = match deadline {
            Some(deadline) => deadline
                .saturating_duration_since(Instant::now())
                .min(UNATTENDED_POLL),
            None => UNATTENDED_POLL,
        };
        std::thread::sleep(sleep_for);
    }
}

/// (a) from the contract: nothing left for the watcher to do — the request
/// already moved past `Opened` (answered, cancelled, or otherwise settled) or
/// the child is gone.
fn unattended_permission_moot(session: &Session, request: &str) -> bool {
    session.exited().is_some() || !session.driver.is_opened(request)
}

/// Deny `request` through the same reserve/journal/dispatch/journal path a
/// real client's answer takes — no lease check, because there is no
/// controller to hold one — then journal the watcher's own disposition with
/// the settled outcome as `reason`.
///
/// Checks `exited()` and `is_opened()` itself and returns without dispatching
/// anything if either fails, so both callers — the timeout path and the
/// show-failed path — inherit the same guard rather than each needing to
/// remember it.
fn deny_unattended(session: &Arc<Session>, request: &str, outcome: &str, reason: &str) {
    if session.exited().is_some() || !session.driver.is_opened(request) {
        return;
    }
    let line = json!({
        "type": "permission_response",
        "id": request,
        "behavior": "deny",
        "message": format!("Denied by Falcon: no controller attached; {reason}"),
    });
    let settled = dispatch_recorded(session, "falcon-unattended", line);
    // `reason` names what the deny's own dispatch settled as (applied,
    // failed, delivery-unknown) — not `settled.1`, the optional message,
    // which is `None` on the common success path and would otherwise leave
    // this record's `reason` empty for exactly the deny that worked.
    let outcome_reason = serde_json::to_value(settled.0)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string));
    session.record_quietly(Body::PermissionUnattended {
        request: request.to_string(),
        outcome: outcome.into(),
        reason: outcome_reason,
    });
}
