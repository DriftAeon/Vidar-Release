//! src-tauri\src\rules\generate\pipeline.rs — the chunk scheduler.
//! At most `cap` attempts run at once; chunk 0 starts alone and the rest follow when it finishes or `fanout_delay`
//! passes (the first call refreshes the login, so parallel starts would race it). An `output:` error retries once;
//! any other error, or a second `output:`, is the run's failure: the first one wins, `halt` runs once, nothing new
//! starts, and siblings report `stopped` as they return. A true `stop()` is a cancel: nothing new starts and the
//! result is `cancelled`. Errors are returned unchanged (the caller prefixes the part name).

use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use super::progress::{ChunkState, ProgressEvent};

/// Concurrent chunk calls, both agents.
pub const CAP: usize = 5;
/// How long chunk 0 runs alone at most.
pub const FANOUT_DELAY: Duration = Duration::from_secs(15);

/// How often a waiting worker re-checks `stop()` and the fan-out delay.
const POLL: Duration = Duration::from_millis(50);

struct State<T> {
    next: usize,
    in_flight: usize,
    first_done: bool,
    started: Option<Instant>,
    failure: Option<String>,
    cancelled: bool,
    results: Vec<Option<T>>,
}

/// Runs `n` attempts and returns their results in index order. `attempt(index, try)` is called with try 0, and
/// try 1 after an `output:` error; `count` is the rune count reported with `done`.
#[allow(clippy::too_many_arguments)]
pub fn run<T: Send>(
    n: usize,
    cap: usize,
    fanout_delay: Duration,
    attempt: impl Fn(usize, usize) -> Result<T, String> + Sync,
    count: impl Fn(&T) -> usize + Sync,
    stop: impl Fn() -> bool + Sync,
    halt: impl Fn() + Sync,
    emit: impl Fn(ProgressEvent) + Sync,
) -> Result<Vec<T>, String> {
    if n == 0 {
        return Ok(Vec::new());
    }
    let cap = cap.max(1);
    let state = Mutex::new(State {
        next: 0,
        in_flight: 0,
        first_done: false,
        started: None,
        failure: None,
        cancelled: false,
        results: (0..n).map(|_| None).collect(),
    });
    let wake = Condvar::new();
    let chunk = |index: usize, state: ChunkState, runes: Option<usize>| {
        emit(ProgressEvent::Chunk { index, state, runes })
    };

    // Claims the next index when the rules allow; None once nothing more will start.
    let claim = || -> Option<usize> {
        let mut s = state.lock().unwrap();
        loop {
            if s.failure.is_some() || s.cancelled || s.next >= n {
                return None;
            }
            if stop() {
                s.cancelled = true;
                wake.notify_all();
                return None;
            }
            let released = s.next == 0
                || s.first_done
                || s.started.is_some_and(|t| t.elapsed() >= fanout_delay);
            if released && s.in_flight < cap {
                let index = s.next;
                s.next += 1;
                s.in_flight += 1;
                if index == 0 {
                    s.started = Some(Instant::now());
                }
                return Some(index);
            }
            s = wake.wait_timeout(s, POLL).unwrap().0;
        }
    };

    // True when a failure or cancel is recorded (or `stop()` says so): no retry may start.
    let over = || -> bool {
        let mut s = state.lock().unwrap();
        if s.failure.is_none() && !s.cancelled && stop() {
            s.cancelled = true;
        }
        s.failure.is_some() || s.cancelled
    };

    let finish = |index: usize, outcome: Result<T, String>| {
        let mut halting = false;
        let mut s = state.lock().unwrap();
        s.in_flight -= 1;
        if index == 0 {
            s.first_done = true;
        }
        match outcome {
            Ok(value) => {
                let runes = count(&value);
                s.results[index] = Some(value);
                drop(s);
                chunk(index, ChunkState::Done, Some(runes));
            }
            Err(error) => {
                if s.failure.is_some() || s.cancelled || stop() {
                    // A sibling of the failure, or a cancel: its error is the stop, not a failure of its own.
                    if s.failure.is_none() {
                        s.cancelled = true;
                    }
                    drop(s);
                    chunk(index, ChunkState::Stopped, None);
                } else {
                    s.failure = Some(error);
                    halting = true;
                    drop(s);
                    chunk(index, ChunkState::Failed, None);
                }
            }
        }
        if halting {
            halt();
        }
        wake.notify_all();
    };

    std::thread::scope(|scope| {
        for _ in 0..cap.min(n) {
            scope.spawn(|| {
                while let Some(index) = claim() {
                    chunk(index, ChunkState::Running, None);
                    // A panicking attempt is a normal failure: the run halts and siblings stop.
                    let guarded = |try_: usize| {
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| attempt(index, try_)))
                            .unwrap_or_else(|_| Err("spawn: generator thread panicked".to_string()))
                    };
                    let mut outcome = guarded(0);
                    if matches!(&outcome, Err(e) if e.starts_with("output:")) && !over() {
                        chunk(index, ChunkState::Retrying, None);
                        outcome = guarded(1);
                    }
                    finish(index, outcome);
                }
            });
        }
    });

    let s = state.into_inner().unwrap();
    if let Some(error) = s.failure {
        return Err(error);
    }
    if s.results.iter().any(Option::is_none) {
        return Err("cancelled".to_string());
    }
    Ok(s.results.into_iter().flatten().collect())
}

#[cfg(test)]
#[path = "pipeline_tests.rs"]
mod tests;
