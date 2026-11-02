//! A rate hold as a plain value: no lock, no clock. Slack wraps it in a `Mutex`; Notion keeps it in
//! its pacer state. Clamped to 1-600 s, never shortened, whole seconds rounded up.

use std::time::{Duration, Instant};

pub const HOLD_MIN_SECS: u64 = 1;
pub const HOLD_MAX_SECS: u64 = 600;

#[derive(Debug, Default, Clone, Copy)]
pub struct RateHold {
    until: Option<Instant>,
}

impl RateHold {
    /// Holds for `secs` (clamped to 1-600) from `now`, never shortening a longer hold; returns the
    /// clamped request.
    pub fn set(&mut self, now: Instant, secs: u64) -> u64 {
        let secs = secs.clamp(HOLD_MIN_SECS, HOLD_MAX_SECS);
        let until = now + Duration::from_secs(secs);
        if self.until.map_or(true, |cur| until > cur) {
            self.until = Some(until);
        }
        secs
    }

    /// Whole seconds left (rounded up, at least 1) while held, `None` once free.
    pub fn left(&self, now: Instant) -> Option<u64> {
        let left = self.until?.checked_duration_since(now).filter(|d| !d.is_zero())?;
        Some(ceil_secs(left))
    }

    pub fn clear(&mut self) {
        self.until = None;
    }
}

/// Whole seconds, rounded up, at least 1.
pub fn ceil_secs(d: Duration) -> u64 {
    (d.as_secs() + u64::from(d.subsec_nanos() > 0)).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hold_clamps_never_shortens_and_expires() {
        let mut h = RateHold::default();
        let t0 = Instant::now();
        assert_eq!(h.left(t0), None);
        assert_eq!(h.set(t0, 0), 1);
        assert_eq!(h.set(t0, 9999), 600);
        assert_eq!(h.set(t0, 5), 5, "returns the clamped request");
        assert_eq!(h.left(t0 + Duration::from_millis(1500)), Some(599));
        assert_eq!(h.left(t0 + Duration::from_secs(600)), None);
        h.clear();
        assert_eq!(h.left(t0), None);
    }

    #[test]
    fn ceil_secs_rounds_up_with_a_floor_of_one() {
        assert_eq!(ceil_secs(Duration::ZERO), 1);
        assert_eq!(ceil_secs(Duration::from_millis(1)), 1);
        assert_eq!(ceil_secs(Duration::from_millis(1001)), 2);
        assert_eq!(ceil_secs(Duration::from_secs(3)), 3);
    }
}
