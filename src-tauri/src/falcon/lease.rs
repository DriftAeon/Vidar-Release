//! The controller lease on the client side: marking one in flight, acquiring
//! it on a connection, and re-acquiring after a control reconnect. Split from
//! `falcon.rs`; reaches the parent through `super::` only
//! (`.claude\rules\falcon-rs.md`).

use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

use super::{Connection, Falcon, Lease, Op, REQUEST_TIMEOUT};

/// Held by a spawn/adopt from before it takes a lease until its view is in
/// `hosted` (or it gave up); see `Falcon::pending_leases`.
pub(crate) struct PendingLease<'a>(&'a AtomicUsize);

impl Drop for PendingLease<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Re-acquire attempts after a control reconnect. The host frees the old
/// connection's leases on its own teardown, which can trail our reconnect, so
/// a refusal ("already controlled by vidar") is retried. A host built before
/// 2026-10-06 frees them only after draining the old writer (up to 5 s) and
/// flushing (up to 2 s); a newer one frees them when the request returns. The
/// retry is bounded by time, not a count, to cover the older host.
const REACQUIRE_WINDOW: Duration = Duration::from_secs(8);
const REACQUIRE_BACKOFF_FIRST: Duration = Duration::from_millis(200);
const REACQUIRE_BACKOFF_MAX: Duration = Duration::from_millis(1600);

/// The wait before retry number `retries + 1`, doubling from
/// [`REACQUIRE_BACKOFF_FIRST`] up to [`REACQUIRE_BACKOFF_MAX`]; `None` once
/// that wait would carry `elapsed` past [`REACQUIRE_WINDOW`].
pub(super) fn reacquire_wait(elapsed: Duration, retries: u32) -> Option<Duration> {
    let wait = REACQUIRE_BACKOFF_FIRST
        .saturating_mul(1u32 << retries.min(4))
        .min(REACQUIRE_BACKOFF_MAX);
    (elapsed + wait <= REACQUIRE_WINDOW).then_some(wait)
}

/// The one refusal worth a retry: the old connection still holds the lease
/// (`src-falcon/src/session.rs` `acquire_control`). Anything else ("no such
/// session" and kin) will not change by waiting.
pub(super) fn lease_contended(refusal: &str) -> bool {
    refusal.contains("is already controlled by")
}

impl Falcon {
    /// Mark a lease in flight; the idle-out keeps the control pipe until the
    /// returned guard drops.
    pub(crate) fn pending_lease(&self) -> PendingLease<'_> {
        self.pending_leases.fetch_add(1, Ordering::SeqCst);
        PendingLease(&self.pending_leases)
    }

    /// One `acquire-control` for `session` on `connection`. Outer `Err`: the
    /// pipe broke or timed out (caller drops it). Inner `Err`: the host refused.
    pub(super) fn acquire_on(
        &self,
        connection: &mut Connection,
        session: &str,
    ) -> Result<Result<Lease, String>, String> {
        let reply = connection.request(
            self.next_id(),
            Op::AcquireControl {
                session: session.to_string(),
            },
            REQUEST_TIMEOUT,
        )?;
        Ok(reply
            .applied("acquire-control")
            .and_then(super::ops::parse_lease))
    }

    /// Is the view `tab`@`view_generation` still there with a lease from an
    /// older epoch? Read under the control lock, so `epoch` is current.
    fn lease_stale(&self, tab: &str, view_generation: u64, epoch: u64) -> bool {
        self.hosted
            .lock()
            .ok()
            .and_then(|hosted| {
                hosted
                    .get(tab)
                    .filter(|entry| entry.view_generation == view_generation)
                    .map(|entry| entry.lease_epoch != epoch)
            })
            .unwrap_or(false)
    }

    /// After a control reconnect: take a fresh lease on the new epoch for
    /// every hosted view whose lease died with the old connection. Called with
    /// the control lock NOT held: it takes the lock per view, one request each,
    /// and re-checks staleness under it, so other tabs' sends interleave and a
    /// view another thread already re-acquired is skipped. One attempt each; a
    /// refusal leaves the view stale and `hosted_request` retries it. A broken
    /// pipe drops the connection and stops.
    pub(super) fn reacquire_stale(&self) {
        let stale: Vec<(String, u64, String)> = {
            let epoch = self.control_epoch.load(Ordering::SeqCst);
            match self.hosted.lock() {
                Ok(hosted) => hosted
                    .iter()
                    .filter(|(_, entry)| entry.lease_epoch != epoch)
                    .map(|(tab, entry)| (tab.clone(), entry.view_generation, entry.session.clone()))
                    .collect(),
                Err(_) => return,
            }
        };
        for (tab, view_generation, session) in stale {
            let Ok(mut control) = self.control.lock() else {
                return;
            };
            let epoch = self.control_epoch.load(Ordering::SeqCst);
            let Some(connection) = control.as_mut() else {
                return;
            };
            if !self.lease_stale(&tab, view_generation, epoch) {
                continue;
            }
            match self.acquire_on(connection, &session) {
                Ok(Ok(lease)) => {
                    self.store_lease(connection, &tab, view_generation, &session, lease, epoch);
                }
                Ok(Err(refusal)) => eprintln!("[falcon] re-acquire {session} after reconnect: {refusal}"),
                Err(_) => {
                    *control = None;
                    return;
                }
            }
        }
    }

    /// Record a re-acquired lease on its view. If the view went away (or was
    /// replaced) meanwhile, the lease is released again so nothing untracked
    /// holds the session. Returns whether the view took it.
    pub(super) fn store_lease(
        &self,
        connection: &mut Connection,
        tab: &str,
        view_generation: u64,
        session: &str,
        lease: Lease,
        epoch: u64,
    ) -> bool {
        if let Ok(mut hosted) = self.hosted.lock() {
            if let Some(entry) = hosted
                .get_mut(tab)
                .filter(|entry| entry.view_generation == view_generation)
            {
                entry.lease = lease;
                entry.lease_epoch = epoch;
                return true;
            }
        }
        let _ = connection.request(
            self.next_id(),
            Op::ReleaseControl {
                session: session.to_string(),
                lease,
            },
            REQUEST_TIMEOUT,
        );
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only the host's "already controlled" refusal is retried; a gone session is not.
    #[test]
    fn only_a_contended_lease_is_retried() {
        assert!(lease_contended(
            "acquire-control: session s1-00000001 is already controlled by vidar"
        ));
        assert!(!lease_contended("acquire-control: no such session s1-00000001"));
        assert!(!lease_contended("acquire-control: refused"));
    }

    /// Regression: five 200 ms retries (~0.8 s) gave up long before the host
    /// frees an old connection's leases (writer drain ≤5 s + flush ≤2 s). The
    /// retry now spans the whole window with a growing backoff.
    #[test]
    fn the_reacquire_retry_spans_the_host_teardown() {
        let mut elapsed = Duration::ZERO;
        let mut waits = Vec::new();
        while let Some(wait) = reacquire_wait(elapsed, waits.len() as u32) {
            waits.push(wait);
            elapsed += wait;
        }
        assert_eq!(waits[0], Duration::from_millis(200), "starts at 200 ms");
        assert!(waits.windows(2).all(|pair| pair[1] >= pair[0]), "{waits:?}");
        assert!(waits.iter().all(|wait| *wait <= REACQUIRE_BACKOFF_MAX));
        assert!(elapsed <= REACQUIRE_WINDOW, "{elapsed:?}");
        assert!(elapsed >= Duration::from_secs(7), "covers drain + flush: {elapsed:?}");
    }
}
