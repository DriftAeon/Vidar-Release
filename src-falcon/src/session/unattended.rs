//! Registry operations that must be atomic with a session's attachment state.
//! Split from `session.rs`: the sweep's release and a client's attach race each
//! other, and the registry lock is what serializes them.
//!
//! Lock order: registry `inner`, then the session's `subscribers` or
//! `controller`; the lease order lock comes before all of them (the full order
//! is in `lease.rs`). Nothing takes those session locks and then the registry's.
//! The idle-stop re-check also reads the session's prompt queue, watcher set
//! and driver state under the registry lock; none of those is held while the
//! registry lock is taken either.

use std::sync::{atomic::Ordering, Arc};

use super::{lock, Lease, Registry, Session, Subscriber};

impl Registry {
    /// Attach `subscriber` to session `id` while the registry lock is held, so
    /// the session cannot be released between the lookup and the attach.
    /// `None` when no such session is registered (any more).
    ///
    /// A plain `get` then [`Session::attach`] could hand a client a session the
    /// exited-session sweep removed in between: attached, but no longer listed,
    /// and never released again.
    ///
    /// A session the idle sweep has committed to ending
    /// ([`Registry::reserve_idle_stop`]) also answers `None`: it is on its way
    /// out, and an attach now would watch it die.
    pub fn attach(&self, id: &str, subscriber: Subscriber) -> Option<(Arc<Session>, u64, u64)> {
        let inner = lock(&self.inner);
        let session = Arc::clone(inner.sessions.get(id)?);
        if session.stopping.load(Ordering::SeqCst) {
            return None;
        }
        let (token, through) = session.attach(subscriber);
        Some((session, token, through))
    }

    /// [`Session::acquire_control`] on session `id`, leasing in memory under
    /// the registry lock for the same reason as [`Registry::attach`]: a plain
    /// `get` could lease a session the exited-session sweep is releasing. `None` when no
    /// such session is registered (any more).
    ///
    /// The registry lock is never held while waiting on the disk. The session
    /// is looked up (and a held lease answered) under it, then it is dropped
    /// while the lease order lock is taken, since a concurrent release holds
    /// that lock across its own append. It is then re-taken to re-check the
    /// session is still listed and to lease in memory, and dropped again before
    /// this acquire's own append. The sweep's re-check still sees the lease: it
    /// is set before the registry lock is dropped. A session the idle sweep is
    /// ending answers `None`, checked under both registry lock holds.
    pub fn acquire_control(
        &self,
        id: &str,
        connection: u64,
        holder: &str,
        token: String,
    ) -> Option<Result<Lease, String>> {
        let session = {
            let inner = lock(&self.inner);
            let session = Arc::clone(inner.sessions.get(id)?);
            if session.stopping.load(Ordering::SeqCst) {
                return None;
            }
            // Already held: answer now rather than queue behind a lease record
            // write that cannot change the answer for a rival.
            if let Some(held) = session.held_lease(connection) {
                return Some(held);
            }
            session
        };
        let order = session.lease_order();
        let inner = lock(&self.inner);
        let listed = inner
            .sessions
            .get(id)
            .is_some_and(|listed| Arc::ptr_eq(listed, &session));
        if !listed || session.stopping.load(Ordering::SeqCst) {
            // Released, or committed to an idle stop, by a sweep while this
            // waited on the order lock.
            return None;
        }
        let leased = session.lease_control(order, connection, holder, token);
        drop(inner);
        Some(leased.map(|(lease, record)| {
            if let Some(record) = record {
                record.write();
            }
            lease
        }))
    }

    /// [`Registry::release`], but only while the session has exited AND has no
    /// subscriber and no controller, all re-checked under the registry lock.
    /// `Ok(false)` means it is in use again and stays listed.
    ///
    /// The sweep's own reads happen before this and without the lock; they
    /// only choose a candidate. This is where the decision is made.
    pub fn release_if_unattended(&self, id: &str) -> Result<bool, String> {
        let mut inner = lock(&self.inner);
        let session = inner.sessions.get(id).ok_or("no such session")?;
        if session.exited().is_none() {
            return Err("session is still running; close or terminate it first".into());
        }
        if session.attached() > 0 || session.controller_holder().is_some() {
            return Ok(false);
        }
        inner.sessions.remove(id);
        // Only what this session owns, as in `Registry::release`.
        inner.reservations.release_all(id);
        Ok(true)
    }

    /// Commit the idle sweep to ending `session`, but only while `still_idle`
    /// holds, re-evaluated under the registry lock. `true` marks the session
    /// stopping: from here [`Registry::attach`] and
    /// [`Registry::acquire_control`] refuse it, so the caller can publish its
    /// diagnostic and stop the child outside the lock. `false` means it is no
    /// longer listed, already stopping, or in use again.
    ///
    /// The sweep's own reads only choose a candidate; an attach or lease can
    /// land after them, and acting on them killed the newcomer's session. Prompt
    /// admission needs a lease, so refusing the lease covers it too.
    pub fn reserve_idle_stop(
        &self,
        session: &Arc<Session>,
        still_idle: impl FnOnce(&Session) -> bool,
    ) -> bool {
        let inner = lock(&self.inner);
        let listed = inner
            .sessions
            .get(&session.id)
            .is_some_and(|listed| Arc::ptr_eq(listed, session));
        if !listed || session.stopping.load(Ordering::SeqCst) || !still_idle(session) {
            return false;
        }
        session.stopping.store(true, Ordering::SeqCst);
        true
    }
}
