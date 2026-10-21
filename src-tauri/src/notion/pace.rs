//! The process-wide send budget (plan § D2, delta S5, S6): one slot every 350 ms (about 2.86
//! requests a second, under Notion's 3 a second average), and a hold after a 429 or 529 during
//! which every call answers `rate` with the seconds left and sends nothing. The clock is
//! injected so tests run a fresh pacer on a fake clock, never the process static.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// The gap between two sends.
pub const SLOT: Duration = Duration::from_millis(350);
/// Hold bounds in seconds; a missing or unreadable wait holds the minimum.
pub const HOLD_MIN_SECS: u64 = 1;
pub const HOLD_MAX_SECS: u64 = 600;

pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
    fn sleep(&self, d: Duration);
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn sleep(&self, d: Duration) {
        std::thread::sleep(d);
    }
}

#[derive(Default)]
struct State {
    /// When the latest reserved slot starts.
    last: Option<Instant>,
    hold_until: Option<Instant>,
}

pub struct Pacer {
    clock: Box<dyn Clock>,
    state: Mutex<State>,
}

impl Pacer {
    pub fn new(clock: Box<dyn Clock>) -> Self {
        Pacer { clock, state: Mutex::new(State::default()) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        // A poisoned lock still holds valid instants; keep pacing rather than fail every call.
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn now(&self) -> Instant {
        self.clock.now()
    }

    /// Waits for the next slot, or refuses with whole seconds to wait (at least 1): the hold
    /// left, or, when the slot would start past `budget`, the time until the queue frees (no
    /// slot is reserved then). A hold that began during the wait also refuses.
    pub fn turn(&self, budget: Duration) -> Result<(), u64> {
        let wait = {
            let mut s = self.lock();
            let now = self.clock.now();
            if let Some(until) = s.hold_until {
                if until > now {
                    return Err(ceil_secs(until - now));
                }
                s.hold_until = None;
            }
            let start = match s.last {
                Some(last) if last + SLOT > now => last + SLOT,
                _ => now,
            };
            if start - now > budget {
                return Err(ceil_secs(start - now));
            }
            s.last = Some(start);
            start - now
        };
        if !wait.is_zero() {
            self.clock.sleep(wait);
            let s = self.lock();
            let now = self.clock.now();
            if let Some(until) = s.hold_until.filter(|&until| until > now) {
                return Err(ceil_secs(until - now));
            }
        }
        Ok(())
    }

    /// Starts a hold of `secs`, clamped to 1-600 s; returns the clamped value.
    pub fn hold(&self, secs: u64) -> u64 {
        let secs = secs.clamp(HOLD_MIN_SECS, HOLD_MAX_SECS);
        let until = self.clock.now() + Duration::from_secs(secs);
        let mut s = self.lock();
        s.hold_until = Some(match s.hold_until {
            Some(prev) if prev > until => prev,
            _ => until,
        });
        secs
    }

    /// Ends any hold (Connect and Disconnect, delta S6).
    pub fn clear(&self) {
        self.lock().hold_until = None;
    }

    #[cfg(test)]
    pub fn held(&self) -> bool {
        let now = self.clock.now();
        self.lock().hold_until.is_some_and(|until| until > now)
    }
}

/// Whole seconds, rounded up, at least 1.
fn ceil_secs(d: Duration) -> u64 {
    (d.as_secs() + u64::from(d.subsec_nanos() > 0)).max(1)
}

/// The one pacer every live command shares.
pub fn shared() -> &'static Pacer {
    static SHARED: OnceLock<Pacer> = OnceLock::new();
    SHARED.get_or_init(|| Pacer::new(Box::new(SystemClock)))
}

#[cfg(test)]
pub mod testing {
    use super::*;
    use std::sync::Arc;

    type Hook = Box<dyn FnOnce() + Send>;

    /// A clock that only moves when slept on or advanced; records every sleep. A frozen clock
    /// does not move on sleep (so slots queue up); a hook runs once, after the next sleep.
    #[derive(Clone)]
    pub struct FakeClock {
        inner: Arc<Mutex<(Instant, Vec<Duration>)>>,
        frozen: bool,
        hook: Arc<Mutex<Option<Hook>>>,
    }

    impl FakeClock {
        pub fn new() -> Self {
            FakeClock { inner: Arc::new(Mutex::new((Instant::now(), Vec::new()))), frozen: false, hook: Arc::default() }
        }

        pub fn frozen() -> Self {
            FakeClock { frozen: true, ..FakeClock::new() }
        }

        pub fn after_sleep(&self, f: impl FnOnce() + Send + 'static) {
            *self.hook.lock().unwrap() = Some(Box::new(f));
        }

        pub fn advance(&self, d: Duration) {
            self.inner.lock().unwrap().0 += d;
        }

        pub fn sleeps(&self) -> Vec<Duration> {
            self.inner.lock().unwrap().1.clone()
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> Instant {
            self.inner.lock().unwrap().0
        }

        fn sleep(&self, d: Duration) {
            {
                let mut g = self.inner.lock().unwrap();
                if !self.frozen {
                    g.0 += d;
                }
                g.1.push(d);
            }
            let hook = self.hook.lock().unwrap().take();
            if let Some(f) = hook {
                f();
            }
        }
    }

    pub fn pacer() -> (Pacer, FakeClock) {
        let clock = FakeClock::new();
        (Pacer::new(Box::new(clock.clone())), clock)
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{pacer, FakeClock};
    use super::*;
    use std::sync::Arc;

    const B: Duration = Duration::from_secs(20);

    #[test]
    fn pace_spaces_sends_and_holds_after_429() {
        let (p, clock) = pacer();
        assert_eq!(p.turn(B), Ok(()));
        assert_eq!(p.turn(B), Ok(()));
        assert_eq!(p.turn(B), Ok(()));
        assert_eq!(clock.sleeps(), vec![SLOT, SLOT]);

        clock.advance(Duration::from_secs(2));
        assert_eq!(p.turn(B), Ok(()));
        assert_eq!(clock.sleeps().len(), 2, "a send after a quiet gap does not wait");

        assert_eq!(p.hold(30), 30);
        assert!(p.held());
        assert_eq!(p.turn(B), Err(30));
        clock.advance(Duration::from_millis(29_500));
        assert_eq!(p.turn(B), Err(1));
        clock.advance(Duration::from_millis(500));
        assert_eq!(p.turn(B), Ok(()));
        assert!(!p.held());

        assert_eq!(p.hold(0), HOLD_MIN_SECS);
        p.clear();
        assert_eq!(p.hold(86_400), HOLD_MAX_SECS);
        assert_eq!(p.turn(B), Err(HOLD_MAX_SECS));
        p.clear();
        assert!(!p.held());
        assert_eq!(p.turn(B), Ok(()));
    }

    #[test]
    fn full_queue_refuses_without_reserving() {
        let clock = FakeClock::frozen();
        let p = Pacer::new(Box::new(clock.clone()));
        let budget = Duration::from_secs(1);
        for _ in 0..3 {
            assert_eq!(p.turn(budget), Ok(()));
        }
        // Slots at 0, 350 and 700 ms are taken; the next starts at 1050 ms, past the budget.
        assert_eq!(p.turn(budget), Err(2));
        assert_eq!(p.turn(Duration::ZERO), Err(2));
        assert_eq!(clock.sleeps(), vec![SLOT, SLOT * 2]);
        // The refusals reserved nothing: the next call still gets the 1050 ms slot.
        assert_eq!(p.turn(B), Ok(()));
        assert_eq!(clock.sleeps(), vec![SLOT, SLOT * 2, SLOT * 3]);
    }

    #[test]
    fn hold_that_starts_during_the_wait_refuses() {
        let clock = FakeClock::new();
        let p = Arc::new(Pacer::new(Box::new(clock.clone())));
        assert_eq!(p.turn(B), Ok(()));
        let weak = Arc::downgrade(&p);
        clock.after_sleep(move || {
            weak.upgrade().unwrap().hold(30);
        });
        assert_eq!(p.turn(B), Err(30), "the hold began while this call waited for its slot");
        assert_eq!(clock.sleeps(), vec![SLOT]);
        p.clear();
        assert_eq!(p.turn(B), Ok(()));
    }
}
