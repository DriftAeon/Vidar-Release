//! src-tauri\src\rules\generate\pipeline_tests.rs — scheduler rules with fake attempts, no processes.

use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

const TINY: Duration = Duration::from_millis(20);

fn nap(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

#[derive(Default)]
struct Log(Mutex<Vec<ProgressEvent>>);

impl Log {
    fn push(&self, e: ProgressEvent) {
        self.0.lock().unwrap().push(e);
    }
    fn states(&self, index: usize) -> Vec<ChunkState> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                ProgressEvent::Chunk { index: i, state, .. } if *i == index => Some(*state),
                _ => None,
            })
            .collect()
    }
}

#[test]
fn in_flight_never_exceeds_cap() {
    let live = AtomicUsize::new(0);
    let peak = AtomicUsize::new(0);
    let log = Log::default();
    let out = run(
        12,
        3,
        TINY,
        |i, _| {
            let now = live.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            nap(15);
            live.fetch_sub(1, Ordering::SeqCst);
            Ok(i)
        },
        |_| 1,
        || false,
        || {},
        |e| log.push(e),
    )
    .unwrap();
    assert_eq!(out, (0..12).collect::<Vec<_>>());
    assert!(peak.load(Ordering::SeqCst) <= 3);
    assert!(peak.load(Ordering::SeqCst) >= 2);
}

#[test]
fn chunk_zero_runs_alone_before_the_delay() {
    let zero_done = AtomicBool::new(false);
    let early = AtomicBool::new(false);
    let started = Instant::now();
    let out = run(
        4,
        4,
        Duration::from_millis(2000),
        |i, _| {
            if i == 0 {
                nap(60);
                zero_done.store(true, Ordering::SeqCst);
            } else if !zero_done.load(Ordering::SeqCst) {
                early.store(true, Ordering::SeqCst);
            }
            Ok(i)
        },
        |_| 0,
        || false,
        || {},
        |_| {},
    )
    .unwrap();
    assert_eq!(out.len(), 4);
    assert!(!early.load(Ordering::SeqCst), "a sibling started before chunk 0 finished");
    assert!(started.elapsed() < Duration::from_millis(2000), "siblings waited for the delay");
}

#[test]
fn delay_releases_siblings_while_chunk_zero_runs() {
    let sibling_before_zero_done = AtomicBool::new(false);
    let zero_done = AtomicBool::new(false);
    run(
        2,
        2,
        TINY,
        |i, _| {
            if i == 0 {
                nap(250);
                zero_done.store(true, Ordering::SeqCst);
            } else if !zero_done.load(Ordering::SeqCst) {
                sibling_before_zero_done.store(true, Ordering::SeqCst);
            }
            Ok(i)
        },
        |_| 0,
        || false,
        || {},
        |_| {},
    )
    .unwrap();
    assert!(sibling_before_zero_done.load(Ordering::SeqCst));
}

#[test]
fn output_error_retries_once_then_fails_naming_its_index() {
    let tries = Mutex::new(Vec::new());
    let halts = AtomicUsize::new(0);
    let log = Log::default();
    let err = run(
        3,
        3,
        TINY,
        |i, t| {
            if i == 1 {
                tries.lock().unwrap().push(t);
                return Err("output: bad".to_string());
            }
            nap(5);
            Ok(i)
        },
        |_| 1,
        || false,
        || {
            halts.fetch_add(1, Ordering::SeqCst);
        },
        |e| log.push(e),
    )
    .unwrap_err();
    assert_eq!(err, "output: bad");
    assert_eq!(*tries.lock().unwrap(), vec![0, 1]);
    assert_eq!(halts.load(Ordering::SeqCst), 1);
    assert_eq!(
        log.states(1),
        vec![ChunkState::Running, ChunkState::Retrying, ChunkState::Failed]
    );
}

#[test]
fn output_error_then_success_lands() {
    let out = run(
        1,
        1,
        TINY,
        |_, t| if t == 0 { Err("output: once".to_string()) } else { Ok(7) },
        |v| *v,
        || false,
        || {},
        |_| {},
    )
    .unwrap();
    assert_eq!(out, vec![7]);
}

#[test]
fn timeout_is_not_retried() {
    let calls = AtomicUsize::new(0);
    let err = run(
        1,
        1,
        TINY,
        |_, _| -> Result<usize, String> {
            calls.fetch_add(1, Ordering::SeqCst);
            Err("timeout: after 360 s".to_string())
        },
        |_| 0,
        || false,
        || {},
        |_| {},
    )
    .unwrap_err();
    assert_eq!(err, "timeout: after 360 s");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn failure_halts_once_starts_nothing_new_and_stops_siblings() {
    let halted = AtomicBool::new(false);
    let halts = AtomicUsize::new(0);
    let late_start = AtomicBool::new(false);
    let log = Log::default();
    let err = run(
        6,
        2,
        TINY,
        |i, _| {
            if halted.load(Ordering::SeqCst) {
                late_start.store(true, Ordering::SeqCst);
            }
            match i {
                0 => {
                    nap(5);
                    Ok(i)
                }
                1 => {
                    nap(40);
                    Err("login: expired".to_string())
                }
                _ => {
                    // The sibling ends once halted, as a terminated child does.
                    while !halted.load(Ordering::SeqCst) {
                        nap(2);
                    }
                    Err("spawn: killed".to_string())
                }
            }
        },
        |_| 1,
        || false,
        || {
            halts.fetch_add(1, Ordering::SeqCst);
            halted.store(true, Ordering::SeqCst);
        },
        |e| log.push(e),
    )
    .unwrap_err();
    assert_eq!(err, "login: expired");
    assert_eq!(halts.load(Ordering::SeqCst), 1);
    assert!(!late_start.load(Ordering::SeqCst), "an attempt started after the halt");
    assert_eq!(log.states(1).last(), Some(&ChunkState::Failed));
    assert_eq!(log.states(2).last(), Some(&ChunkState::Stopped));
    for i in 3..6 {
        assert!(log.states(i).is_empty(), "chunk {i} started");
    }
}

#[test]
fn a_panicking_attempt_fails_the_run_halts_and_stops_siblings() {
    let halted = AtomicBool::new(false);
    let halts = AtomicUsize::new(0);
    let log = Log::default();
    let err = run(
        4,
        2,
        TINY,
        |i, _| -> Result<usize, String> {
            match i {
                0 => {
                    nap(5);
                    Ok(i)
                }
                1 => {
                    nap(30);
                    panic!("boom");
                }
                _ => {
                    while !halted.load(Ordering::SeqCst) {
                        nap(2);
                    }
                    Err("spawn: killed".to_string())
                }
            }
        },
        |_| 1,
        || false,
        || {
            halts.fetch_add(1, Ordering::SeqCst);
            halted.store(true, Ordering::SeqCst);
        },
        |e| log.push(e),
    )
    .unwrap_err();
    assert_eq!(err, "spawn: generator thread panicked");
    assert_eq!(halts.load(Ordering::SeqCst), 1);
    assert_eq!(log.states(1).last(), Some(&ChunkState::Failed));
    assert_eq!(log.states(2).last(), Some(&ChunkState::Stopped));
    assert!(log.states(3).is_empty(), "nothing starts after the halt");
}

#[test]
fn no_retry_starts_after_a_failure() {
    // An `output:` error arriving after another chunk already failed is not retried.
    let retries = AtomicUsize::new(0);
    let err = run(
        2,
        2,
        TINY,
        |i, t| -> Result<usize, String> {
            if t == 1 {
                retries.fetch_add(1, Ordering::SeqCst);
            }
            if i == 0 {
                nap(30);
                return Err("timeout: first".to_string());
            }
            nap(120);
            Err("output: late".to_string())
        },
        |_| 0,
        || false,
        || {},
        |_| {},
    )
    .unwrap_err();
    assert_eq!(err, "timeout: first");
    assert_eq!(retries.load(Ordering::SeqCst), 0);
}

#[test]
fn stop_starts_nothing_new_and_returns_cancelled() {
    let stopped = AtomicBool::new(false);
    let starts = AtomicUsize::new(0);
    let err = run(
        5,
        1,
        TINY,
        |i, _| {
            starts.fetch_add(1, Ordering::SeqCst);
            nap(20);
            stopped.store(true, Ordering::SeqCst);
            Ok(i)
        },
        |_| 0,
        || stopped.load(Ordering::SeqCst),
        || {},
        |_| {},
    )
    .unwrap_err();
    assert_eq!(err, "cancelled");
    assert_eq!(starts.load(Ordering::SeqCst), 1);
}

#[test]
fn stop_turns_inflight_errors_into_stopped_rows() {
    let stopped = AtomicBool::new(false);
    let log = Log::default();
    let err = run(
        1,
        1,
        TINY,
        |_, _| -> Result<usize, String> {
            nap(10);
            stopped.store(true, Ordering::SeqCst);
            Err("spawn: terminated".to_string())
        },
        |_| 0,
        || stopped.load(Ordering::SeqCst),
        || {},
        |e| log.push(e),
    )
    .unwrap_err();
    assert_eq!(err, "cancelled");
    assert_eq!(log.states(0), vec![ChunkState::Running, ChunkState::Stopped]);
}

#[test]
fn results_are_index_ordered_and_done_carries_the_count() {
    let log = Log::default();
    let out = run(
        5,
        5,
        TINY,
        |i, _| {
            nap(((5 - i) * 8) as u64);
            Ok(i * 10)
        },
        |v| *v,
        || false,
        || {},
        |e| log.push(e),
    )
    .unwrap();
    assert_eq!(out, vec![0, 10, 20, 30, 40]);
    let events = log.0.lock().unwrap();
    assert!(events.contains(&ProgressEvent::Chunk { index: 3, state: ChunkState::Done, runes: Some(30) }));
}
