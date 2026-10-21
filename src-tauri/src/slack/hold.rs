//! The Slack-local rate hold (docs/projects/slack/inbox-tab-plan.md § Rust): a 429 or `ratelimited`
//! sets `hold_until`, clamped to 1-600 s, and every send checks it first, not once per command.
//! `held_for` is pure over an explicit `now` so tests need no clock.

use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const HOLD_MIN_SECS: u64 = 1;
pub const HOLD_MAX_SECS: u64 = 600;
/// The hold when Slack answers 429 without a usable `Retry-After`.
pub const HOLD_DEFAULT_SECS: u64 = 30;

#[derive(Debug, Default)]
pub struct Hold {
    until: Mutex<Option<Instant>>,
}

impl Hold {
    pub fn new() -> Self {
        Hold::default()
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Option<Instant>> {
        self.until.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Holds sends for `secs` (clamped to 1-600) from `now`, never shortening a longer hold; returns the
    /// seconds now held.
    pub fn set(&self, now: Instant, secs: u64) -> u64 {
        let secs = secs.clamp(HOLD_MIN_SECS, HOLD_MAX_SECS);
        let until = now + Duration::from_secs(secs);
        let mut slot = self.slot();
        if slot.map_or(true, |cur| until > cur) {
            *slot = Some(until);
        }
        drop(slot);
        self.held_for(now).unwrap_or(secs)
    }

    /// Whole seconds left (rounded up, at least 1) while held, `None` once free.
    pub fn held_for(&self, now: Instant) -> Option<u64> {
        let until = (*self.slot())?;
        let left = until.checked_duration_since(now).filter(|d| !d.is_zero())?;
        Some(left.as_secs() + u64::from(left.subsec_nanos() > 0))
    }

    pub fn clear(&self) {
        *self.slot() = None;
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
