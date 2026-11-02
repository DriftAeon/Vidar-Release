//! The Slack-local rate hold (docs/projects/slack/inbox-tab-plan.md § Rust): a 429 or `ratelimited`
//! sets `hold_until`, clamped to 1-600 s, and every send checks it first, not once per command.
//! `held_for` is pure over an explicit `now` so tests need no clock.

use std::sync::Mutex;
use std::time::Instant;

use crate::net::RateHold;
#[cfg(test)]
use std::time::Duration;

/// The hold when Slack answers 429 without a usable `Retry-After`.
pub const HOLD_DEFAULT_SECS: u64 = 30;

#[derive(Debug, Default)]
pub struct Hold {
    until: Mutex<RateHold>,
}

impl Hold {
    pub fn new() -> Self {
        Hold::default()
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, RateHold> {
        self.until.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Holds sends for `secs` (clamped to 1-600) from `now`, never shortening a longer hold; returns the
    /// seconds now held.
    pub fn set(&self, now: Instant, secs: u64) -> u64 {
        let mut slot = self.slot();
        let secs = slot.set(now, secs);
        let left = slot.left(now);
        drop(slot);
        left.unwrap_or(secs)
    }

    /// Whole seconds left (rounded up, at least 1) while held, `None` once free.
    pub fn held_for(&self, now: Instant) -> Option<u64> {
        self.slot().left(now)
    }

    pub fn clear(&self) {
        self.slot().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hold_clamps_and_expires() {
        let h = Hold::new();
        let t0 = Instant::now();
        assert_eq!(h.held_for(t0), None);
        assert_eq!(h.set(t0, 0), 1);
        assert_eq!(h.set(t0, 9999), 600);
        assert_eq!(h.set(t0, 5), 600, "a shorter hold never shortens");
        assert_eq!(h.held_for(t0 + Duration::from_millis(1500)), Some(599));
        assert_eq!(h.held_for(t0 + Duration::from_secs(600)), None);
        h.clear();
        assert_eq!(h.held_for(t0), None);
    }
}
