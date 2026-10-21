//! A connection's writer thread: the single drain of its outbound queue onto
//! the pipe, and the bounded flush teardown runs before disconnecting.

use std::{
    sync::{mpsc::Receiver, Arc},
    time::Duration,
};

use windows::Win32::Storage::FileSystem::FlushFileBuffers;

use crate::{
    ipc::{shutdown_raised, write_json_overlapped_until},
    protocol::{ServerFrame, MAX_SESSION_FRAME},
    security::OwnedHandle,
};

/// Drain `outbound` onto the pipe until the queue closes or a write fails.
///
/// Returns `true` only if it left because the queue closed with every frame
/// written — that is, the client received everything it was promised. Teardown
/// uses that to decide whether a flush is worth waiting for.
pub(super) fn start_writer(
    pipe: Arc<OwnedHandle>,
    outbound: Receiver<ServerFrame>,
    shutdown: Arc<OwnedHandle>,
) -> Writer {
    let (finished, settled) = std::sync::mpsc::channel::<()>();
    let thread = std::thread::spawn(move || {
        let _signal_on_exit = finished;
        while let Ok(frame) = outbound.recv() {
            if shutdown_raised(&shutdown) {
                return false;
            }
            if write_json_overlapped_until(
                pipe.handle(),
                &frame,
                MAX_SESSION_FRAME,
                Some(shutdown.handle()),
            )
            .is_err()
            {
                // The client is gone or wedged; draining further is pointless.
                return false;
            }
        }
        true
    });
    Writer { thread, settled }
}

/// The writer thread, plus a way to notice it has stopped without blocking on
/// it.
///
/// `JoinHandle` has no timed join, and joining an unbounded writer is exactly
/// what teardown must not do. The channel carries nothing: the writer drops its
/// sender as it exits, so `recv_timeout` reports `Disconnected` the moment the
/// thread is finished and `Timeout` while it is still working.
pub(super) struct Writer {
    thread: std::thread::JoinHandle<bool>,
    settled: Receiver<()>,
}

impl Writer {
    /// `Ok(drained)` if the writer stopped within `grace`; `Err(self)` if it is
    /// still going, leaving the caller to raise the shutdown signal and retry.
    pub(super) fn settle_within(self, grace: Duration) -> Result<bool, Self> {
        match self.settled.recv_timeout(grace) {
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Ok(self.join()),
            _ => Err(self),
        }
    }

    /// Join unconditionally. Bounded only once the shutdown signal is raised.
    pub(super) fn join(self) -> bool {
        self.thread.join().unwrap_or(false)
    }
}

/// How long a departing client's queued frames get to reach it before the
/// connection is abandoned. Long enough for a real reader to drain a backlog,
/// short enough that a wedged one cannot hold a pipe instance — there are 16.
pub(super) const WRITER_DRAIN: Duration = Duration::from_secs(5);

/// How long `FlushFileBuffers` may wait for the peer to read what it was sent.
pub(super) const FLUSH_GRACE: Duration = Duration::from_secs(2);

/// Wait for the peer to consume what is buffered, but only for `grace`.
///
/// `FlushFileBuffers` on a pipe blocks until the client has read everything,
/// which makes it unbounded by construction — a peer that stops reading holds
/// it forever, and that peer is precisely the case teardown exists to survive.
/// It still has to happen, because `DisconnectNamedPipe` discards whatever the
/// peer has not collected and a refused negotiation's answer is usually still
/// sitting in that buffer. So it runs somewhere abandonable: the caller returns
/// on the deadline and disconnects anyway, which is itself what releases this
/// thread. The handle is kept alive by this thread's own `Arc`.
pub(super) fn flush_within(pipe: &Arc<OwnedHandle>, grace: Duration) {
    let pipe = Arc::clone(pipe);
    let (finished, waited) = std::sync::mpsc::channel::<()>();
    if std::thread::Builder::new()
        .spawn(move || {
            let _signal_on_exit = finished;
            unsafe {
                let _ = FlushFileBuffers(pipe.handle());
            }
        })
        .is_err()
    {
        return;
    }
    // Nothing is ever sent: the only outcome is `Disconnected` when the thread
    // exits, or `Timeout` when it has not.
    let _ = waited.recv_timeout(grace);
}
