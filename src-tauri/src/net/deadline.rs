//! Runs blocking work on its own named thread and waits at most a deadline. Past it the thread
//! is abandoned: it finishes on its own (WinHTTP handles close when the call returns) and its
//! result is dropped. Lifted from `jira/commands.rs` `with_deadline`, made generic.

use std::sync::mpsc;
use std::time::Duration;

/// Why no value came back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Elapsed {
    /// The deadline passed first.
    Timeout,
    /// The worker thread did not start.
    NoThread,
    /// The worker ended without a value (it panicked).
    Stopped,
}

pub fn with_deadline<T: Send + 'static>(
    name: &'static str,
    d: Duration,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Elapsed> {
    let (tx, rx) = mpsc::channel();
    let spawned = std::thread::Builder::new().name(name.into()).spawn(move || {
        let _ = tx.send(work());
    });
    if spawned.is_err() {
        return Err(Elapsed::NoThread);
    }
    match rx.recv_timeout(d) {
        Ok(value) => Ok(value),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(Elapsed::Timeout),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(Elapsed::Stopped),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn past_deadline_returns_elapsed() {
        let slow = with_deadline("net-test-slow", Duration::from_millis(20), || {
            std::thread::sleep(Duration::from_millis(500));
            1
        });
        assert_eq!(slow, Err(Elapsed::Timeout));
        let quick = with_deadline("net-test-quick", Duration::from_secs(5), || 7);
        assert_eq!(quick, Ok(7));
    }
}
