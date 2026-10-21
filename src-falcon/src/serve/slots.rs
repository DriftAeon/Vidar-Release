//! Per-connection RAII guards: the controller lease and the host's client
//! counts, each released exactly once on every path out of a connection.
//! Split from `serve.rs`: balance-on-drop is its own concern.

use std::sync::{atomic::Ordering, Arc};

use super::{unattended::watch_requests_left_unattended, Host};

/// Releases this connection's controller lease on every path out, including a
/// panic in `converse`.
///
/// Straight-line teardown code was not enough. A lease that outlives its
/// connection leaves a session nobody can drive and nobody can take over —
/// `acquire_control` never steals — which is unrecoverable without restarting
/// the host. That is too severe an outcome to hang on "the teardown line is
/// reached", so it hangs on unwinding instead.
///
/// This and [`ClientSlot`] both depend on the panic strategy being `unwind`:
/// under `panic = "abort"` neither `Drop` runs and both guarantees are silently
/// gone. No profile in `Cargo.toml` sets `panic`, so the
/// default applies. Setting it would need both of these rewritten, not merely
/// recompiled.
///
/// Swept across every session rather than tracked alongside `attached`, because
/// holding the lease does not require an attach and a per-connection list could
/// miss one. The registry is small; correctness beats the scan.
pub(super) struct LeaseHold {
    pub(super) host: Arc<Host>,
    pub(super) connection: u64,
}

impl Drop for LeaseHold {
    fn drop(&mut self) {
        for session in self.host.registry.all() {
            if session.release_control_for(self.connection).is_some() {
                watch_requests_left_unattended(&self.host, &session);
            }
        }
    }
}

/// Decrements the host's client count exactly once, on every path out of a
/// connection — including a panic or a failed thread spawn.
///
/// The count gates the idle watchdog, so a leaked increment keeps an abandoned
/// host alive forever, and a double decrement underflows a `usize`. It is taken
/// in the accept loop rather than inside the connection thread so a connection
/// is never invisible to the watchdog in the gap before that thread runs.
pub(super) struct ClientSlot(Arc<Host>);

impl ClientSlot {
    pub(super) fn take(host: &Arc<Host>) -> Self {
        host.clients.fetch_add(1, Ordering::SeqCst);
        Self(Arc::clone(host))
    }
}

impl Drop for ClientSlot {
    fn drop(&mut self) {
        self.0.clients.fetch_sub(1, Ordering::SeqCst);
    }
}

/// `host.vidar_clients` held for a connection that negotiated as `vidar`;
/// taken at most once per connection and released when `converse` returns
/// or unwinds, the same balance discipline as [`ClientSlot`].
pub(super) struct VidarSlot<'a>(&'a Host);

impl<'a> VidarSlot<'a> {
    pub(super) fn take(host: &'a Host) -> Self {
        host.vidar_clients.fetch_add(1, Ordering::SeqCst);
        Self(host)
    }
}

impl Drop for VidarSlot<'_> {
    fn drop(&mut self) {
        self.0.vidar_clients.fetch_sub(1, Ordering::SeqCst);
    }
}
