//! Host lifetime: the idle watchdog that exits an unused host, and the sweep
//! that ends sessions nobody ever used, and the one that ends sessions whose
//! tab went away (orphans).

use std::{
    collections::HashMap,
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};

use super::Host;
use crate::{
    protocol::{Agent, EventBody},
    session::Session,
};

/// How often the watchdog re-checks. Cheap: a map read and an atomic load.
const IDLE_POLL: Duration = Duration::from_secs(15);

/// Exit once nothing has depended on this host for `grace`.
///
/// Plan v3, "Host rendezvous and lifetime": *"Falcon remains alive while any
/// hosted session exists or any client is attached. With neither, it exits
/// after an idle grace period."*
///
/// This is not tidiness. Falcon holds a single-host mutex on stable, well-known
/// endpoints, so a host that outlives its purpose silently squats them: every
/// later host dies at startup with "another Falcon host owns the stable
/// endpoints", while the registry still names a process that is long gone. That
/// state is genuinely confusing to debug from the outside — it produced a false
/// "the build hangs at the handshake" diagnosis — and it
/// accumulates one squatter per crashed or abandoned run.
///
/// `on_idle` performs the authenticated shutdown; the watchdog decides when.
pub fn start_idle_watchdog(host: Arc<Host>, grace: Duration, on_idle: impl Fn() + Send + 'static) {
    // Either grace can be the reason this thread needs to exist: the host-
    // level exit below, or the per-session sweep further down. Zero on both
    // means nothing here ever fires, so there is nothing to poll for.
    if grace.is_zero()
        && host.unused_session_grace.is_zero()
        && host.orphan_session_grace.is_zero()
        && host.vidar_orphan_grace.is_zero()
    {
        return;
    }
    std::thread::Builder::new()
        .name("falcon-idle-watchdog".into())
        .spawn(move || {
            let mut idle_since: Option<Instant> = None;
            let mut unused_since: HashMap<String, Instant> = HashMap::new();
            let mut orphaned_since: HashMap<String, OrphanClock> = HashMap::new();
            let mut exited_since: HashMap<String, Instant> = HashMap::new();
            let mut stopping_since: HashMap<String, Instant> = HashMap::new();
            loop {
                std::thread::sleep(IDLE_POLL);
                if !grace.is_zero() {
                    if host.in_use() {
                        // Any use at all resets the clock; the grace period is
                        // measured from the last dependency, not from startup.
                        idle_since = None;
                    } else {
                        let since = *idle_since.get_or_insert_with(Instant::now);
                        if since.elapsed() >= grace {
                            if commit_to_exit(&host) {
                                eprintln!(
                                    "falcon: idle for {}s with no sessions and no clients; exiting",
                                    grace.as_secs()
                                );
                                on_idle();
                                return;
                            }
                            // Something arrived between the check and the
                            // commit: that is use, so the clock restarts.
                            idle_since = None;
                        }
                    }
                }
                sweep_unused_sessions(&host, &mut unused_since);
                sweep_orphaned_sessions(&host, &mut orphaned_since);
                sweep_exited_sessions(&host, &mut exited_since);
                retry_stuck_stops(&host.registry.sessions(), &mut stopping_since, STOP_RETRY_AFTER);
            }
        })
        .ok();
}

/// Raise `host.exiting`, then re-check `in_use`. `true` means the exit is
/// committed: from here every new connection and spawn is refused.
///
/// The idle check alone was check-then-act: a client accepted between "not in
/// use" and `on_idle` was served by a host already on its way out. The accept
/// path counts the client BEFORE it reads `exiting`, and this raises `exiting`
/// BEFORE it reads the count, so (all `SeqCst`) at least one side sees the
/// other: either the client is refused, or this sees it and stands down.
pub(super) fn commit_to_exit(host: &Host) -> bool {
    host.exiting.store(true, Ordering::SeqCst);
    if host.in_use() {
        host.exiting.store(false, Ordering::SeqCst);
        return false;
    }
    true
}

/// How long a session may sit `stopping` but not exited before its stop is
/// re-run: `STOP_GRACE` (5 s, `process.rs`, the graceful stop's bound) plus
/// one poll, so the first stop has always had its full chance.
const STOP_RETRY_AFTER: Duration = Duration::from_secs(5 + IDLE_POLL.as_secs());

/// Re-run the stop of every session the idle sweep committed to ending
/// ([`Registry::reserve_idle_stop`](crate::session::Registry::reserve_idle_stop))
/// that is still not exited `after` it was first seen stopping. Returns the
/// ids it retried.
///
/// `stopping` is never cleared on a live child: clearing it would hand a
/// client a session the sweep already tried to kill. But a stop that failed
/// left a session nobody can attach to, control or terminate, keeping the
/// host up through `Host::in_use`. So the stop is retried, forcefully (the
/// graceful step already had its chance), every `after` until the stdout
/// reader marks it exited.
pub(super) fn retry_stuck_stops(
    sessions: &[Arc<Session>],
    stopping_since: &mut HashMap<String, Instant>,
    after: Duration,
) -> Vec<String> {
    stopping_since.retain(|id, _| {
        sessions
            .iter()
            .any(|session| session.id == *id && session.stopping() && session.exited().is_none())
    });
    let mut retried = Vec::new();
    for session in sessions {
        if !session.stopping() || session.exited().is_some() {
            continue;
        }
        let since = stopping_since
            .entry(session.id.clone())
            .or_insert_with(Instant::now);
        if since.elapsed() >= after {
            eprintln!(
                "falcon {}: idle stop did not end the session within {}s; stopping it again",
                session.id,
                since.elapsed().as_secs()
            );
            session.child.terminate_tree();
            *since = Instant::now();
            retried.push(session.id.clone());
        }
    }
    retried
}

/// How long an exited session stays registered once nothing is attached to it
/// or holds its lease. Long enough for a client to read its last state, short
/// enough that a day of tabs does not accumulate.
const EXITED_RELEASE_GRACE: Duration = Duration::from_secs(600);

/// Drop the registry entry of every session that has exited and had no
/// subscriber and no controller for [`EXITED_RELEASE_GRACE`]. That frees its
/// child and journal handles, its driver state and its summary in `list`.
///
/// In-memory only: the journal FILE is never deleted or pruned here. Journals
/// are session history, and their retention is the user's call.
pub(super) fn sweep_exited_sessions(host: &Host, exited_since: &mut HashMap<String, Instant>) {
    let sessions = host.registry.sessions();
    exited_since.retain(|id, _| sessions.iter().any(|session| session.id == *id));
    for session in sessions {
        if session.exited().is_none()
            || session.attached() > 0
            || session.controller_holder().is_some()
        {
            exited_since.remove(&session.id);
            continue;
        }
        let since = *exited_since
            .entry(session.id.clone())
            .or_insert_with(Instant::now);
        if since.elapsed() >= EXITED_RELEASE_GRACE {
            // The reads above only pick a candidate; an attach can land after
            // them. The release re-checks under the registry lock, which the
            // attach path also takes.
            match host.registry.release_if_unattended(&session.id) {
                Ok(true) => eprintln!(
                    "falcon {}: exited over {}s ago with nothing attached; released (journal kept)",
                    session.id,
                    EXITED_RELEASE_GRACE.as_secs()
                ),
                Ok(false) => {}
                Err(error) => eprintln!("falcon {}: release after exit failed: {error}", session.id),
            }
            exited_since.remove(&session.id);
        }
    }
}

/// End every session that never got a conversation id and has had neither a
/// controller nor a subscriber for `host.unused_session_grace`. Riding the
/// same 15s poll as the idle-host watchdog above rather than a timer of its
/// own: this only matters while the host is up, and staying up is exactly
/// what that poll already tracks.
///
/// `unused_since` is this thread's own memory of when each session was last
/// seen NOT unused; attaching a client, a controller being acquired, or the
/// sidecar reporting a conversation id all remove the session from the
/// unused set on the very next poll, which resets its clock the same way
/// `idle_since` resets on any use.
pub(super) fn sweep_unused_sessions(host: &Host, unused_since: &mut HashMap<String, Instant>) {
    let grace = host.unused_session_grace;
    if grace.is_zero() {
        return;
    }
    for session in host.registry.sessions() {
        if session.exited().is_some()
            || session.conversation().is_some()
            || session.controller_holder().is_some()
            || session.attached() > 0
        {
            unused_since.remove(&session.id);
            continue;
        }
        let since = *unused_since
            .entry(session.id.clone())
            .or_insert_with(Instant::now);
        // The reads above only pick a candidate; an attach or lease can land
        // after them. The decision is re-made under the registry lock, which
        // marks the session stopping so those are refused from then on.
        if unused_past_grace(&session, since, grace)
            && host
                .registry
                .reserve_idle_stop(&session, |current| unused_past_grace(current, since, grace))
        {
            end_unused_session(&session, grace);
            unused_since.remove(&session.id);
        }
    }
}

/// True once `session` has spent at least `grace` with no conversation id,
/// no controller and no subscriber, measured from `unused_since`. Split out
/// from the sweep above so the three conditions and the timing are each
/// independently testable without waiting out a real grace period.
pub(super) fn unused_past_grace(session: &Session, unused_since: Instant, grace: Duration) -> bool {
    session.exited().is_none()
        && session.conversation().is_none()
        && session.controller_holder().is_none()
        && session.attached() == 0
        // A prompt can be submitted, the lease released and the client gone
        // all within one poll: the clock never saw it, the queue does.
        && !session.has_pending_work()
        && unused_since.elapsed() >= grace
}

/// Ends a session the sweep has judged unused past its grace: a diagnostic
/// naming why, journalled the same reconstructive way the conversation-
/// collision refusal in the stdout reader above records its own reason, then
/// terminating the child. The session's own stdout-reader thread (spawned at
/// `spawn_session` time) observes the exit and does the rest —
/// `mark_exited`, `Body::Exited`, `EventBody::Exit` — exactly as it does for
/// any other end, so this needs no new journal variant. The sweep calls it only
/// once [`Registry::reserve_idle_stop`](crate::session::Registry::reserve_idle_stop)
/// has committed, and outside the registry lock.
pub(super) fn end_unused_session(session: &Session, grace: Duration) {
    eprintln!(
        "falcon {}: unused (no conversation, no controller, no subscriber) for over {}s; ending it",
        session.id,
        grace.as_secs()
    );
    session.publish(EventBody::Diagnostic {
        text: format!(
            "session unused (no conversation, no controller, no subscriber) for over {}s; ended",
            grace.as_secs()
        ),
    });
    session.child.terminate_tree();
}

/// End every session that HAS a conversation id but has had no controller,
/// no subscriber and nothing waiting on it ([`Session::has_pending_work`])
/// for `host.orphan_session_grace` — the tab that hosted it closed and nobody
/// docked it back (one such session kept Falcon up for about 3 h,
/// because [`sweep_unused_sessions`] skips any session with a conversation and
/// [`Host::in_use`](super::Host) counts every live session).
///
/// Only the child process ends. The journal is never touched beyond the
/// diagnostic and the stdout reader's usual exit records, the reader frees the
/// conversation claim on exit (`Registry::free_conversations`), and the
/// agent's own transcript is outside Falcon entirely — so a later spawn with
/// `resume` = that conversation id is accepted and picks up where it stopped.
///
/// Two rules share this sweep, the clock and the end path (ruling
/// `docs/projects/falcon/falcon-idle-reap.md` §Decision 2-5):
///
/// - **No client connected**: every orphan ends after
///   `host.orphan_session_grace` (300 s default since 2026-10-05). Vidar holds a bus connection for its
///   whole lifetime, so this rule alone never ends a session the user parked
///   or jettisoned while Vidar is up.
/// - **A client connected**: only a Vidar-held orphan ([`vidar_held`]: a
///   Claude session whose last lease holder was Vidar, with no live jettison
///   handoff naming it) can end. With a `vidar` client among them
///   (`host.vidar_clients`) its grace is `host.vidar_orphan_grace` (300 s):
///   Vidar releases the lease when it drops a tab's view, so such a session is
///   one Vidar no longer shows, a reload ghost or a smoke's leftover. With only
///   the shell connected it keeps the orphan-session grace (ruling §3). The shell's own
///   sessions (`last_holder == "falcon-shell"`) never match.
///
/// A session that qualifies under neither rule this poll loses its clock, so
/// a plain orphan's clock still restarts whenever a client connects. Every
/// clock first seen with no `vidar` client restarts once one connects: a
/// relaunching Vidar gets its full 300 s to re-adopt, however long it was
/// closed.
///
/// Same clock discipline as the unused sweep: any poll that sees the session
/// attended or busy removes it from `orphaned_since`, restarting its grace.
/// A journal that moved since the last poll restarts it too: that catches
/// activity no pending-work flag saw, including an exchange that began and
/// ended between two polls.
pub(super) fn sweep_orphaned_sessions(host: &Host, orphaned_since: &mut HashMap<String, OrphanClock>) {
    if host.orphan_session_grace.is_zero() && host.vidar_orphan_grace.is_zero() {
        return;
    }
    let clients = host.clients.load(Ordering::SeqCst) > 0;
    let vidar = host.vidar_clients.load(Ordering::SeqCst) > 0;
    let jettisoning = host
        .jettison_handoff
        .as_deref()
        .and_then(|path| pending_jettison(path, now_ms()));
    let sessions = host.registry.sessions();
    orphaned_since.retain(|id, _| sessions.iter().any(|session| session.id == *id));
    for session in sessions {
        let Some((grace, reason)) =
            orphan_rule(host, &session, clients, vidar, jettisoning.as_deref())
        else {
            orphaned_since.remove(&session.id);
            continue;
        };
        let journal = session.journal_position();
        let clock = orphaned_since
            .entry(session.id.clone())
            .or_insert_with(|| OrphanClock::start(journal, vidar));
        // A moved journal is activity; a `vidar` client arriving since the
        // last poll is a relaunch that has not re-adopted yet.
        if clock.journal != journal || (vidar && !clock.vidar) {
            *clock = OrphanClock::start(journal, vidar);
        }
        clock.vidar = vidar;
        let since = clock.since;
        // Candidate only; the decision is re-made under the registry lock, as
        // in `sweep_unused_sessions`.
        if orphaned_past_grace(&session, since, grace)
            && host
                .registry
                .reserve_idle_stop(&session, |current| orphaned_past_grace(current, since, grace))
        {
            end_orphaned_session(&session, grace, reason);
            orphaned_since.remove(&session.id);
        }
    }
}

/// Why a session is being ended as an orphan; names the rule in the diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OrphanReason {
    /// No client connected, nobody on the session ([`is_orphaned`]).
    Unattended,
    /// Vidar dropped its view and nothing else picked the session up.
    VidarHeldIdle,
}

impl OrphanReason {
    fn label(self) -> &'static str {
        match self {
            Self::Unattended => "orphaned",
            Self::VidarHeldIdle => "vidar-held idle",
        }
    }
}

/// Which rule (if any) applies to `session` this poll, and its grace.
/// `clients`: any connection; `vidar`: a connection that negotiated as
/// [`VIDAR_CLIENT`]. `jettisoning` is the session id a live jettison handoff names.
pub(super) fn orphan_rule(
    host: &Host,
    session: &Session,
    clients: bool,
    vidar: bool,
    jettisoning: Option<&str>,
) -> Option<(Duration, OrphanReason)> {
    if !is_orphaned(session) {
        return None;
    }
    let held = vidar_held(session) && jettisoning != Some(session.id.as_str());
    let (grace, reason) = match (held, vidar, clients) {
        (true, true, _) => (host.vidar_orphan_grace, OrphanReason::VidarHeldIdle),
        (true, false, _) => (host.orphan_session_grace, OrphanReason::VidarHeldIdle),
        (false, _, true) => return None,
        (false, _, false) => (host.orphan_session_grace, OrphanReason::Unattended),
    };
    (!grace.is_zero()).then_some((grace, reason))
}

/// The client name Vidar negotiates with (`CLIENT_NAME`,
/// `src-tauri/src/falcon.rs`); the shell build names itself `falcon-shell`.
pub(super) const VIDAR_CLIENT: &str = "vidar";

/// A Claude session whose last lease holder was Vidar (not the shell).
/// `last_holder` is set at lease acquisition and survives the release; read
/// through `summary()` because `session.rs` sits at its module-size line.
fn vidar_held(session: &Session) -> bool {
    session.agent == Agent::Claude.as_str()
        && session.summary().last_holder.as_deref() == Some(VIDAR_CLIENT)
}

/// A jettison handoff older than this is ignored by the shell too
/// (`HANDOFF_STALE_MS`, `src-tauri/src/falcon/handoff.rs`).
const HANDOFF_STALE_MS: u64 = 120_000;

/// The session a live jettison handoff names, if any. The handoff file
/// (`handoff-jettison.json`, written by Vidar right after it detaches — the
/// shell's 2 s poll adopts on sight, so it cannot go first — cleared by
/// the shell once its adopt succeeds) is `{session, draft, direction, at_ms}`.
/// Absent, unreadable, mistyped or stale: `None`, same as the shell's peek.
pub(super) fn pending_jettison(path: &std::path::Path, now: u64) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let record: serde_json::Value = serde_json::from_str(&text).ok()?;
    if record.get("direction")?.as_str()? != "jettison" {
        return None;
    }
    let at = record.get("at_ms")?.as_u64()?;
    if now.saturating_sub(at) > HANDOFF_STALE_MS {
        return None;
    }
    Some(record.get("session")?.as_str()?.to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// When a session was first seen orphaned, its journal position then, and
/// whether a `vidar` client was connected at the clock's last start or poll.
#[derive(Debug, Clone, Copy)]
pub(super) struct OrphanClock {
    pub(super) since: Instant,
    pub(super) journal: u64,
    pub(super) vidar: bool,
}

impl OrphanClock {
    fn start(journal: u64, vidar: bool) -> Self {
        Self {
            since: Instant::now(),
            journal,
            vidar,
        }
    }
}

/// Live, has a conversation, and nobody is driving, watching or waiting on it.
fn is_orphaned(session: &Session) -> bool {
    session.exited().is_none()
        && session.conversation().is_some()
        && session.controller_holder().is_none()
        && session.attached() == 0
        && !session.has_pending_work()
}

/// [`is_orphaned`] re-checked at decision time, plus the timing. Split out so
/// a test can backdate `orphaned_since` instead of waiting out the grace.
pub(super) fn orphaned_past_grace(
    session: &Session,
    orphaned_since: Instant,
    grace: Duration,
) -> bool {
    is_orphaned(session) && orphaned_since.elapsed() >= grace
}

/// Ends an orphaned session: a journalled diagnostic, then the graceful
/// [`Child::stop`](crate::process::Child::stop) (stdin closed so the CLI can
/// flush its transcript, up to 5 s, then the Job). Unlike an unused session an
/// orphan has a conversation worth ending cleanly, and the watchdog thread can
/// afford the wait. The stdout reader does the rest (`mark_exited`, freeing
/// the conversation claim, `Body::Exited`). Called, like
/// [`end_unused_session`], only after the registry reservation committed.
pub(super) fn end_orphaned_session(session: &Session, grace: Duration, reason: OrphanReason) {
    let conversation = session.conversation().unwrap_or_default();
    let why = reason.label();
    eprintln!(
        "falcon {}: {why} (conversation {conversation}, no controller, no subscriber, no \
         pending work) for over {}s; ending it, journal kept for resume",
        session.id,
        grace.as_secs()
    );
    session.publish(EventBody::Diagnostic {
        text: format!(
            "session {why} (no controller, no subscriber, no pending work) for over {}s; \
             ended. Resume conversation {conversation} to continue",
            grace.as_secs()
        ),
    });
    let _ = session.child.stop();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        protocol::Event,
        session::{tests::live_session, Registry},
    };

    const GRACE: Duration = Duration::from_secs(300);

    fn long_ago() -> Instant {
        Instant::now() - GRACE - Duration::from_secs(1)
    }

    fn unused(since: Instant) -> impl Fn(&Session) -> bool {
        move |current| unused_past_grace(current, since, GRACE)
    }

    fn orphaned(since: Instant) -> impl Fn(&Session) -> bool {
        move |current| orphaned_past_grace(current, since, GRACE)
    }

    /// Regression (audit-2 M1): the unused sweep read eligibility without a
    /// lock, then terminated the child, so an attach landing in that gap had
    /// its session killed. The reservation re-runs the real predicate under
    /// the registry lock and stands down.
    #[test]
    fn an_attach_between_the_unused_check_and_the_stop_keeps_the_session() {
        let registry = Registry::default();
        let (_temp, session) = live_session("idle-unused-attach", &registry);
        let id = session.id.clone();
        let since = long_ago();

        // The sweep's unlocked check: a stop candidate.
        assert!(unused_past_grace(&session, since, GRACE));
        // A client attaches in the gap.
        let (_found, token, _through) = registry
            .attach(&id, Arc::new(|_event: Event| {}))
            .expect("still registered");

        assert!(!registry.reserve_idle_stop(&session, unused(since)));
        assert!(!session.stopping());
        assert!(
            registry.acquire_control(&id, 1, "vidar", "kept".into()).is_some(),
            "a session the sweep stood down from stays usable"
        );
        session.detach(token);
        session.child.terminate_tree();
    }

    /// The orphan path's twin: a lease taken in the gap stands it down.
    #[test]
    fn a_lease_between_the_orphan_check_and_the_stop_keeps_the_session() {
        let registry = Registry::default();
        let (_temp, session) = live_session("idle-orphan-lease", &registry);
        *session.conversation.lock().expect("conversation lock") = Some("c1".into());
        let id = session.id.clone();
        let since = long_ago();

        assert!(orphaned_past_grace(&session, since, GRACE));
        registry
            .acquire_control(&id, 1, "vidar", "gap".into())
            .expect("still registered")
            .expect("lease granted");

        assert!(!registry.reserve_idle_stop(&session, orphaned(since)));
        assert!(registry.attach(&id, Arc::new(|_event: Event| {})).is_some());
        session.child.terminate_tree();
    }

    /// Orion should-fix 1: a prompt left queued by a client that leased,
    /// submitted, released and detached within one poll keeps an unused
    /// session out of the sweep.
    #[test]
    fn pending_work_keeps_an_unused_session() {
        let registry = Registry::default();
        let (_temp, session) = live_session("idle-unused-pending", &registry);
        let since = long_ago();
        assert!(unused_past_grace(&session, since, GRACE));

        session
            .enqueue_prompt(serde_json::json!("still waiting"))
            .expect("enqueue");
        assert!(!unused_past_grace(&session, since, GRACE));
        assert!(!registry.reserve_idle_stop(&session, unused(since)));
        session.child.terminate_tree();
    }

    /// Orion should-fix 2: a session left `stopping` and not exited gets its
    /// stop re-run once `after` has passed since it was first seen, again each
    /// `after`, and never once it has exited. `stopping` is never cleared.
    #[test]
    fn a_stuck_idle_stop_is_retried_until_the_session_exits() {
        let registry = Registry::default();
        let (_temp, stuck) = live_session("idle-stop-stuck", &registry);
        let (_temp2, live) = live_session("idle-stop-live", &registry);
        assert!(registry.reserve_idle_stop(&stuck, unused(long_ago())));
        let sessions = registry.sessions();
        let mut since = HashMap::new();

        // First sight starts the clock; nothing is retried yet.
        assert!(retry_stuck_stops(&sessions, &mut since, STOP_RETRY_AFTER).is_empty());
        assert_eq!(since.len(), 1, "only the stopping session is clocked");

        // Past the bound: retried, and the clock restarts.
        *since.get_mut(&stuck.id).expect("clocked") -= STOP_RETRY_AFTER;
        assert_eq!(
            retry_stuck_stops(&sessions, &mut since, STOP_RETRY_AFTER),
            vec![stuck.id.clone()]
        );
        assert!(retry_stuck_stops(&sessions, &mut since, STOP_RETRY_AFTER).is_empty());
        assert!(stuck.stopping(), "stopping is never cleared on a live child");

        // Once the reader marks it exited, it is done and forgotten.
        stuck.mark_exited(Some(0));
        *since.get_mut(&stuck.id).expect("clocked") -= STOP_RETRY_AFTER;
        assert!(retry_stuck_stops(&sessions, &mut since, STOP_RETRY_AFTER).is_empty());
        assert!(since.is_empty());

        stuck.child.terminate_tree();
        live.child.terminate_tree();
    }
}
