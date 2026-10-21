/* ---- output flow control ----
   The reader thread emits every chunk the child writes; xterm.js silently
   drops input once ~50 MB is pending (WriteBuffer.ts), so a chatty child could
   flood IPC and lose output. The frontend tracks bytes not yet parsed by xterm
   and calls pty_flow(paused) at its high/low watermarks (sessions/output.ts);
   a paused reader stops reading, ConPTY's pipe fills, and the child blocks on
   write — real backpressure. Closing always unpauses: ClosePseudoConsole can
   wait for the output pipe to drain, and a kill must never wait on a frontend. */

use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

/// A lost resume (webview reload, failed invoke) must not wedge a tab forever:
/// a pause lasts at most this long, then the reader carries on.
pub(crate) const PAUSE_CEILING: Duration = Duration::from_secs(10);

#[derive(Default)]
struct FlowState {
    paused: bool,
    closed: bool,
}

#[derive(Default)]
pub(crate) struct Flow {
    state: Mutex<FlowState>,
    cv: Condvar,
}

impl Flow {
    /// Returns whether the reader was paused before this call. A `false` that
    /// ends a pause the frontend did not ask to end (input) must be reported
    /// back to it (`pty-flow-resumed`), or its gate stays paused and never
    /// re-pauses at high water.
    pub(crate) fn set_paused(&self, paused: bool) -> bool {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let was = s.paused;
        s.paused = paused;
        drop(s);
        self.cv.notify_all();
        was
    }

    /// Ends any pause for good; set when the session is being torn down.
    pub(crate) fn close(&self) {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.closed = true;
        drop(s);
        self.cv.notify_all();
    }

    /// Called by the reader before each read: returns at once unless paused,
    /// else on resume, close, or `ceiling`. True when the ceiling ended the
    /// pause: the caller tells the frontend, whose gate is still paused.
    pub(crate) fn wait_ready(&self, ceiling: Duration) -> bool {
        let deadline = Instant::now() + ceiling;
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while s.paused && !s.closed {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                s.paused = false;
                return true;
            }
            s = self.cv.wait_timeout(s, left).unwrap_or_else(|e| e.into_inner()).0;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn unpaused_returns_at_once() {
        let f = Flow::default();
        let t = Instant::now();
        f.wait_ready(Duration::from_secs(5));
        assert!(t.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn paused_reader_resumes_on_resume_and_on_close() {
        for end in ["resume", "close"] {
            let f = Arc::new(Flow::default());
            f.set_paused(true);
            let r = Arc::clone(&f);
            let h = thread::spawn(move || {
                let t = Instant::now();
                r.wait_ready(Duration::from_secs(20));
                t.elapsed()
            });
            thread::sleep(Duration::from_millis(100));
            if end == "resume" { f.set_paused(false); } else { f.close() }
            let waited = h.join().unwrap();
            assert!(waited >= Duration::from_millis(90), "{end}: did not block");
            assert!(waited < Duration::from_secs(5), "{end}: did not wake");
        }
    }

    #[test]
    fn a_lost_resume_ends_at_the_ceiling() {
        let f = Flow::default();
        f.set_paused(true);
        let t = Instant::now();
        assert!(f.wait_ready(Duration::from_millis(80)), "ceiling end not reported");
        assert!(t.elapsed() >= Duration::from_millis(70));
        // the ceiling clears the pause, so the next read does not block again
        let t = Instant::now();
        assert!(!f.wait_ready(Duration::from_secs(5)), "an unpaused wait is not a ceiling end");
        assert!(t.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn set_paused_reports_whether_a_pause_was_ended() {
        let f = Flow::default();
        assert!(!f.set_paused(false), "nothing to end");
        assert!(!f.set_paused(true));
        assert!(f.set_paused(false), "input ended a pause: the frontend must hear of it");
    }
}
