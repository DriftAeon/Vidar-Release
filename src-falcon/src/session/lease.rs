//! The controller lease: acquire, release, and the ordered `ControllerChanged`
//! record each change leaves in the journal. Split from `session.rs`: the
//! order lock that keeps those records in revision order without holding
//! `controller` (or the registry lock) across a disk write is its own concern.
//!
//! Lock order, the one place it is written down: a session's
//! `controller_journal`, then the registry's `inner`, then the session's
//! `controller`, then `subscribers`, then `journal`. Every lease change takes
//! `controller_journal` FIRST and holds it across its append; `controller` is
//! held under it only for the in-memory change. Nothing waits on
//! `controller_journal` while holding `inner` or `controller`:
//! `Registry::acquire_control` drops `inner` before taking the order lock and
//! re-takes it afterwards.

use std::sync::{atomic::Ordering, MutexGuard};

use super::{lock, Controller, Session};
use crate::{
    journal::Body,
    protocol::{Lease, LeaseRefusal},
};

/// A lease change already made in memory whose `ControllerChanged` record is
/// still to be appended. Holds the session's `controller_journal` order lock,
/// so no later lease change can even allocate its revision before this record
/// is written; `controller` itself is free.
#[must_use = "the lease change is not journalled until `write` runs"]
pub(crate) struct LeaseRecord<'a> {
    session: &'a Session,
    body: Body,
    _order: MutexGuard<'a, ()>,
}

impl LeaseRecord<'_> {
    /// Append the record, then let the next lease change append its own.
    ///
    /// Quiet because losing the record must not fail an otherwise good lease
    /// change; the reducer treats the revision, not this record's presence,
    /// as the truth.
    pub(crate) fn write(self) {
        let LeaseRecord {
            session,
            body,
            _order,
        } = self;
        session.record_quietly(body);
    }
}

impl Session {
    /// Take the controller lease, if it is free.
    ///
    /// Never steals. Taking control from a live holder is the slice-4 transfer,
    /// which fences the source at a journal barrier first; a bare steal here
    /// would leave two UIs both believing they drive this session.
    ///
    /// Re-acquiring from the connection that already holds it is idempotent and
    /// returns the SAME lease rather than issuing a new one. A retry after a
    /// lost reply must not invalidate the lease the client is already using —
    /// that would turn a dropped response into a broken session.
    ///
    /// Test-only: the host always goes through [`super::Registry::acquire_control`].
    #[cfg(test)]
    pub fn acquire_control(
        &self,
        connection: u64,
        holder: &str,
        token: String,
    ) -> Result<Lease, String> {
        let (lease, record) = self.lease_control(self.lease_order(), connection, holder, token)?;
        if let Some(record) = record {
            record.write();
        }
        Ok(lease)
    }

    /// The order lock every lease change takes before `controller`.
    ///
    /// The revision is allocated under it, and it is held until that revision's
    /// record is appended, so revisions reach the journal in the order they
    /// were allocated. Without it a second change could allocate N+2 and append
    /// it before N+1; `replay.rs` treats a non-advancing revision as
    /// `JournalError::Malformed`, so that would write a permanently
    /// unhydratable journal.
    pub(crate) fn lease_order(&self) -> MutexGuard<'_, ()> {
        lock(&self.controller_journal)
    }

    /// What an acquire by `connection` answers while the lease is held: the
    /// same lease for its own holder, a refusal for anyone else. `None` when
    /// the lease is free. Takes only `controller`, never the order lock, so a
    /// caller can answer a held lease without queueing behind a record write.
    pub(crate) fn held_lease(&self, connection: u64) -> Option<Result<Lease, String>> {
        self.held_by(lock(&self.controller).as_ref(), connection)
    }

    fn held_by(
        &self,
        current: Option<&Controller>,
        connection: u64,
    ) -> Option<Result<Lease, String>> {
        let existing = current?;
        if existing.connection == connection {
            return Some(Ok(Lease {
                token: existing.token.clone(),
                revision: existing.revision,
            }));
        }
        Some(Err(format!(
            "session {} is already controlled by {}",
            self.id, existing.holder
        )))
    }

    /// [`Session::acquire_control`] without the journal append, under an
    /// `order` guard from [`Session::lease_order`] the caller took first. The
    /// lease is taken in memory and the pending record is handed back, so a
    /// caller holding the registry lock can release it before the write.
    /// `None` record for an idempotent re-acquire, which changes nothing.
    pub(crate) fn lease_control<'a>(
        &'a self,
        order: MutexGuard<'a, ()>,
        connection: u64,
        holder: &str,
        token: String,
    ) -> Result<(Lease, Option<LeaseRecord<'a>>), String> {
        let mut current = lock(&self.controller);
        if let Some(held) = self.held_by(current.as_ref(), connection) {
            return held.map(|lease| (lease, None));
        }
        let revision = self.controller_revision.fetch_add(1, Ordering::SeqCst) + 1;
        *current = Some(Controller {
            token: token.clone(),
            revision,
            holder: holder.to_string(),
            connection,
        });
        *lock(&self.last_holder) = Some(holder.to_string());
        drop(current);
        let record = LeaseRecord {
            session: self,
            body: Body::ControllerChanged {
                revision,
                holder: Some(holder.to_string()),
            },
            _order: order,
        };
        Ok((Lease { token, revision }, Some(record)))
    }

    /// Give up the lease. Refused if `lease` is not the one currently held.
    ///
    /// NOT idempotent, deliberately. A second release of the same lease returns
    /// `Vacant`, because by then the lease is genuinely gone and the caller is
    /// acting on a stale belief worth reporting — silently succeeding would
    /// hide a client that lost track of its own state. `Vacant` from a release
    /// is informational; `Vacant` from a mutation is a refusal.
    pub fn release_control(&self, lease: &Lease) -> Result<u64, LeaseRefusal> {
        let order = self.lease_order();
        let revision = {
            let mut current = lock(&self.controller);
            self.check_lease(current.as_ref(), lease)?;
            *current = None;
            self.controller_revision.fetch_add(1, Ordering::SeqCst) + 1
        };
        self.released_record(order, revision).write();
        Ok(revision)
    }

    /// Release whatever lease `connection` holds, if it holds one.
    ///
    /// The implicit release on teardown. A client that crashes mid-turn must
    /// not leave a session permanently undriveable, so the lease dies with the
    /// connection that acquired it rather than waiting for a polite release
    /// that is never coming.
    pub fn release_control_for(&self, connection: u64) -> Option<u64> {
        let order = self.lease_order();
        let revision = {
            let mut current = lock(&self.controller);
            if current.as_ref().map(|held| held.connection) != Some(connection) {
                return None;
            }
            *current = None;
            self.controller_revision.fetch_add(1, Ordering::SeqCst) + 1
        };
        self.released_record(order, revision).write();
        Some(revision)
    }

    fn released_record<'a>(&'a self, order: MutexGuard<'a, ()>, revision: u64) -> LeaseRecord<'a> {
        LeaseRecord {
            session: self,
            body: Body::ControllerChanged {
                revision,
                holder: None,
            },
            _order: order,
        }
    }
}
