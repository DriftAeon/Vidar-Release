use super::*;

#[derive(Clone, Copy, Debug)]
enum Reap {
    Exited,
    Pending,
    Error,
}

#[derive(Clone, Debug)]
struct FakeChild {
    reap: Reap,
    kills: usize,
    kill_error: bool,
}

impl FakeChild {
    fn new(reap: Reap) -> Self {
        Self { reap, kills: 0, kill_error: false }
    }
}

impl portable_pty::ChildKiller for FakeChild {
    fn kill(&mut self) -> std::io::Result<()> {
        self.kills += 1;
        if self.kill_error {
            Err(std::io::Error::other("injected kill failure"))
        } else {
            Ok(())
        }
    }

    fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
        Box::new(self.clone())
    }
}

impl Child for FakeChild {
    fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
        match self.reap {
            Reap::Exited => Ok(Some(portable_pty::ExitStatus::with_exit_code(0))),
            Reap::Pending => Ok(None),
            Reap::Error => Err(std::io::Error::other("injected wait failure")),
        }
    }

    fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
        panic!("teardown must use bounded try_wait")
    }

    fn process_id(&self) -> Option<u32> { None }

    fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> { None }
}

fn retained_retry() -> KillRetry {
    KillRetry {
        root: Some(ProcessIdentity { pid: 10, created: 90 }),
        descendants: vec![ProcessIdentity { pid: 11, created: 100 }],
        tree_recorded: true,
        ..KillRetry::default()
    }
}

fn assert_tree_failure(error: String) {
    for intent in [Intent::Close, Intent::Resume] {
        let mut child = FakeChild::new(Reap::Exited);
        let mut retry = retained_retry();
        let identities = retry.recorded();
        let mut verifications = 0;
        let result = terminate_steps(
            &mut child, &mut retry, intent, Duration::ZERO,
            |_, _| Err(error.clone()),
            |_, _| { verifications += 1; Ok(()) },
            |_| panic!("no survivors to terminate"),
        );
        assert_eq!(result, if intent == Intent::Close { Ok(()) } else { Err(error.clone()) });
        assert_eq!(child.kills, usize::from(intent == Intent::Close));
        assert_eq!(verifications, usize::from(intent == Intent::Close));
        assert_eq!(retry.recorded(), identities, "failed teardown forgot identities");
    }
}

#[test]
fn close_shell_unverified_continues_by_child_handle_resume_refuses() {
    // This error precedes snapshot/taskkill in kill_tree_recording. Inject it
    // at that boundary to verify Close still reaches the owned child handle.
    assert_tree_failure(SHELL_UNVERIFIED.into());
}

#[test]
fn close_taskkill_failure_or_timeout_continues_resume_refuses() {
    for error in [taskkill_outcome(Some(1)).unwrap_err(), "taskkill timed out".into()] {
        assert_tree_failure(error);
    }
}

#[test]
fn close_reap_timeout_or_wait_error_still_verifies_resume_refuses() {
    for reap in [Reap::Pending, Reap::Error] {
        for intent in [Intent::Close, Intent::Resume] {
            let mut child = FakeChild::new(reap);
            let mut retry = retained_retry();
            let identities = retry.recorded();
            let mut verifications = 0;
            let result = terminate_steps(
                &mut child, &mut retry, intent, Duration::ZERO,
                |_, _| Ok(()),
                |_, _| { verifications += 1; Ok(()) },
                |_| panic!("no survivors to terminate"),
            );
            assert_eq!(result.is_ok(), intent == Intent::Close);
            assert_eq!(child.kills, 1);
            assert_eq!(verifications, usize::from(intent == Intent::Close));
            assert_eq!(retry.recorded(), identities);
        }
    }
}

#[test]
fn close_recorded_survivors_get_one_identity_cleanup_even_after_reap_error() {
    for reap in [Reap::Exited, Reap::Error] {
        for intent in [Intent::Close, Intent::Resume] {
            let mut child = FakeChild::new(reap);
            let mut retry = retained_retry();
            let identities = retry.recorded();
            let mut verifications = 0;
            let mut targeted = Vec::new();
            let result = terminate_steps(
                &mut child, &mut retry, intent, Duration::ZERO,
                |_, _| Ok(()),
                |_, _| { verifications += 1; Err(survivors_error(&[11])) },
                |identity| targeted.push(identity),
            );
            assert_eq!(result.is_ok(), intent == Intent::Close);
            assert_eq!(targeted, if intent == Intent::Close { identities.clone() } else { vec![] });
            assert_eq!(verifications, if intent == Intent::Close { 2 } else if matches!(reap, Reap::Error) { 0 } else { 1 });
            assert_eq!(retry.recorded(), identities);
        }
    }
}

#[test]
fn close_kills_a_recorded_survivor_by_identity_and_ignores_a_reused_pid() {
    struct KillOnDrop(std::process::Child);
    impl Drop for KillOnDrop {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut survivor = KillOnDrop(sleeper());
    let pid = survivor.0.id();
    let ProcessObservation::Present(created) = observe(pid) else { panic!("missing sleeper identity") };
    let mut child = FakeChild::new(Reap::Exited);
    let mut retry = KillRetry {
        descendants: vec![ProcessIdentity { pid, created: created.wrapping_add(1) }],
        tree_recorded: true,
        ..KillRetry::default()
    };
    terminate_if_same(retry.descendants[0]);
    assert!(survivor.0.try_wait().unwrap().is_none(), "mismatching identity killed");
    retry.descendants[0].created = created;
    let result = terminate_steps(
        &mut child, &mut retry, Intent::Close, Duration::from_secs(2),
        |_, _| Ok(()), verify_retry, terminate_if_same,
    );
    // KillOnDrop reaps the fixture even if an assertion below panics.
    let seen = observe(pid);
    assert_eq!(result, Ok(()));
    assert!(matches!(seen, ProcessObservation::Gone), "recorded survivor left alive");
}

#[test]
fn close_kill_handle_failure_is_logged_and_drops_the_slot() {
    // portable-pty 0.9.0 WinChild::kill always returns Ok; only the fake child fails here.
    let mut child = FakeChild::new(Reap::Error);
    child.kill_error = true;
    let map = Mutex::new(HashMap::from([("s1-ab".into(), Slot::Live((child, retained_retry())))]));
    assert_eq!(take_or_restore(&map, "s1-ab", |(child, retry)| {
        terminate_steps(child, retry, Intent::Close, Duration::ZERO,
            |_, _| Ok(()), |_, _| Ok(()), |_| panic!("no survivors"))
    }), Ok(()));
    assert!(!map.lock().unwrap().contains_key("s1-ab"));
}

#[test]
fn close_outcome_finishes_each_failure_resume_keeps_its_error() {
    for error in [SHELL_UNVERIFIED.into(), TREE_UNVERIFIED.into(),
        "wait failed".into(), survivors_error(&[11]), "taskkill timed out".into()] {
        assert_eq!(close_outcome(Intent::Close, error.clone()), Ok(()));
        assert_eq!(close_outcome(Intent::Resume, error.clone()), Err(error));
    }
}

#[test]
fn previous_tree_kill_failure_root_gone_descendant_alive_is_not_success() {
    let previous = [ProcessIdentity { pid: 11, created: 100 }];
    let snapshot = HashMap::from([
        (10, ProcessObservation::Gone),
        (11, ProcessObservation::Present(100)),
    ]);
    assert!(!recorded_gone(&previous, &snapshot));
}

#[test]
fn previous_tree_kill_failure_all_recorded_gone_is_success() {
    let previous = [ProcessIdentity { pid: 11, created: 100 }, ProcessIdentity { pid: 12, created: 110 }];
    let snapshot = HashMap::from([
        (10, ProcessObservation::Gone),
        (11, ProcessObservation::Gone),
        (12, ProcessObservation::Gone),
    ]);
    assert!(recorded_gone(&previous, &snapshot));
}

#[test]
fn recorded_identity_rejects_unknown_and_accepts_reused_pid_as_original_gone() {
    let previous = [ProcessIdentity { pid: 11, created: 100 }];
    assert!(!recorded_gone(&previous, &HashMap::new()));
    assert!(!recorded_gone(&previous, &HashMap::from([(11, ProcessObservation::Unknown)])));
    assert!(recorded_gone(&previous, &HashMap::from([(11, ProcessObservation::Present(200))])));
}

#[test]
fn a_retry_terminates_only_a_process_holding_the_recorded_identity() {
    let recorded = ProcessIdentity { pid: 11, created: 100 };
    assert!(same_identity(recorded, ProcessObservation::Present(100)));
    assert!(!same_identity(recorded, ProcessObservation::Present(200)), "reused pid killed");
    assert!(!same_identity(recorded, ProcessObservation::Gone));
    assert!(!same_identity(recorded, ProcessObservation::Unknown));
}

#[test]
fn the_retry_refusal_names_each_surviving_pid() {
    let previous = [
        ProcessIdentity { pid: 11, created: 100 },
        ProcessIdentity { pid: 12, created: 110 },
        ProcessIdentity { pid: 13, created: 120 },
        ProcessIdentity { pid: 14, created: 130 },
    ];
    let snapshot = HashMap::from([
        (11, ProcessObservation::Present(100)),
        (12, ProcessObservation::Gone),
        (13, ProcessObservation::Unknown),
        (14, ProcessObservation::Present(999)),
    ]);
    let survivors = recorded_survivors(&previous, &snapshot);
    assert_eq!(survivors, vec![11, 13]);
    assert_eq!(
        survivors_error(&survivors),
        "a recorded process is still running or could not be verified (pid 11, 13)"
    );
}

#[test]
fn adopt_verifies_the_shell_and_siblings_even_after_claude_exits() {
    let retry = KillRetry {
        root: Some(ProcessIdentity { pid: 10, created: 90 }),
        descendants: vec![
            ProcessIdentity { pid: 11, created: 100 },
            ProcessIdentity { pid: 12, created: 110 },
        ],
        tree_recorded: true,
        ..KillRetry::default()
    };
    let mut snapshot = HashMap::from([
        (10, ProcessObservation::Present(90)),
        (11, ProcessObservation::Gone), // Claude exited; shell and sibling did not.
        (12, ProcessObservation::Present(110)),
    ]);
    assert_eq!(recorded_survivors(&retry.recorded(), &snapshot), vec![10, 12]);
    snapshot.insert(10, ProcessObservation::Gone);
    assert_eq!(recorded_survivors(&retry.recorded(), &snapshot), vec![12]);
    snapshot.insert(12, ProcessObservation::Unknown);
    assert_eq!(recorded_survivors(&retry.recorded(), &snapshot), vec![12]);
    snapshot.insert(12, ProcessObservation::Present(999));
    assert!(recorded_gone(&retry.recorded(), &snapshot));
}

#[test]
fn an_unusable_tree_snapshot_is_retried_once_then_refused() {
    for missing_root in [HashMap::new(), HashMap::from([
        (11, ProcRow { parent: 10, exe: "node.exe".into() }),
    ])] {
        let mut calls = 0;
        let result = tree_snapshot(10, || {
            calls += 1;
            missing_root.clone()
        });
        assert_eq!(result.unwrap_err(), TREE_UNVERIFIED);
        assert_eq!(calls, 2);
    }
}

#[test]
fn a_tree_snapshot_recovered_on_retry_can_be_used() {
    for first_usable in [true, false] {
        let mut calls = 0;
        let result = tree_snapshot(10, || {
            calls += 1;
            if first_usable || calls == 2 {
                HashMap::from([(10, ProcRow { parent: 1, exe: "pwsh.exe".into() })])
            } else {
                HashMap::new()
            }
        });
        assert!(result.unwrap().contains_key(&10));
        assert_eq!(calls, if first_usable { 1 } else { 2 });
    }
}

#[test]
fn shell_exit_after_snapshot_failure_does_not_verify_unknown_descendants() {
    let root = ProcessIdentity { pid: 10, created: 90 };
    for seen in [ProcessObservation::Gone, ProcessObservation::Present(999)] {
        assert_eq!(root_exit_verified(root, seen, false), Err(SHELL_EXITED_UNRECORDED.into()));
        assert_eq!(root_exit_verified(root, seen, true), Ok(true));
    }
    // A matching live shell can still provide a fresh snapshot on retry.
    assert_eq!(root_exit_verified(root, ProcessObservation::Present(90), false), Ok(false));
    assert_eq!(root_exit_verified(root, ProcessObservation::Unknown, false), Ok(false));
}

#[test]
fn an_unrecorded_tree_whose_shell_exited_is_refused_by_resume_and_finished_by_close() {
    let root = ProcessIdentity { pid: 10, created: 90 };
    for seen in [ProcessObservation::Gone, ProcessObservation::Present(999)] {
        let retry = KillRetry { root: Some(root), ..KillRetry::default() };
        for attempt in 0..3 {
            assert_eq!(
                retained_root_step(&retry, root, seen, Intent::Resume),
                Err(SHELL_EXITED_UNRECORDED.into()),
                "resume accepted attempt {attempt}"
            );
        }
        assert_eq!(retained_root_step(&retry, root, seen, Intent::Close), Ok(true), "close wedged");
        assert_eq!(retry.root, Some(root), "reused pid must not become the root");
    }
    // A live matching shell is not settled by Close either: it is re-snapshotted.
    let retry = KillRetry { root: Some(root), ..KillRetry::default() };
    for intent in [Intent::Close, Intent::Resume] {
        assert_eq!(retained_root_step(&retry, root, ProcessObservation::Present(90), intent), Ok(false));
    }
}

#[test]
fn a_recorded_tree_stays_recorded_across_a_retry() {
    // Retry after a recorded tree (then a failed snapshot): the shell's
    // exit settles the root at once, with no refusal and no reset.
    let root = ProcessIdentity { pid: 10, created: 90 };
    let retry = KillRetry {
        root: Some(root),
        descendants: vec![ProcessIdentity { pid: 11, created: 100 }],
        tree_recorded: true,
        ..KillRetry::default()
    };
    for intent in [Intent::Close, Intent::Resume] {
        assert_eq!(retained_root_step(&retry, root, ProcessObservation::Present(90), intent), Ok(false));
        assert!(retry.tree_recorded, "retry reset the recorded flag");
        assert_eq!(retained_root_step(&retry, root, ProcessObservation::Gone, intent), Ok(true));
    }
}

/// A real, harmless process to tear down: the snapshot is faked empty, so
/// the root is never "in" it and no taskkill /T runs.
fn sleeper() -> std::process::Child {
    Command::new("ping")
        .args(["-n", "30", "127.0.0.1"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn ping")
}

type TestSlot = (std::process::Child, KillRetry);

fn teardown(
    map: &Mutex<HashMap<String, Slot<TestSlot>>>,
    intent: Intent,
    snapshot_calls: &mut u32,
) -> Result<(), String> {
    take_or_restore(map, "s1-ab", |(child, retry)| {
        terminate_with(child, KILL_TIMEOUT, retry, intent, || {
            *snapshot_calls += 1;
            HashMap::new()
        })
    })
}

#[test]
fn close_after_a_failed_snapshot_kills_the_shell_and_drops_the_slot() {
    let child = sleeper();
    let pid = child.id();
    let map = Mutex::new(HashMap::from([("s1-ab".to_string(), Slot::Live((child, KillRetry::default())))]));
    let mut calls = 0;
    assert_eq!(teardown(&map, Intent::Close, &mut calls), Ok(()));
    assert_eq!(calls, 2, "snapshot not retried once before giving up");
    assert!(!map.lock().unwrap().contains_key("s1-ab"), "slot not dropped, handles still open");
    assert!(matches!(observe(pid), ProcessObservation::Gone), "shell left running");
}

#[test]
fn resume_refuses_every_attempt_while_the_tree_is_unrecorded() {
    let child = sleeper();
    let pid = child.id();
    let map = Mutex::new(HashMap::from([("s1-ab".to_string(), Slot::Live((child, KillRetry::default())))]));
    let mut calls = 0;
    // Shell alive: each attempt re-snapshots, refuses, and kills nothing.
    for attempt in 1..=2 {
        assert_eq!(teardown(&map, Intent::Resume, &mut calls), Err(TREE_UNVERIFIED.into()), "attempt {attempt}");
        assert_eq!(calls, 2 * attempt);
        assert!(matches!(observe(pid), ProcessObservation::Present(_)), "resume killed the shell");
    }
    // Shell gone, tree still unrecorded: the old accept-on-second-try is
    // gone; a resume would start beside whatever the shell left behind.
    {
        let mut m = map.lock().unwrap();
        let Some(Slot::Live((child, retry))) = m.get_mut("s1-ab") else { panic!("slot not restored") };
        assert!(!retry.tree_recorded);
        let _ = child.kill();
        let _ = child.wait();
    }
    for _ in 0..2 {
        assert_eq!(teardown(&map, Intent::Resume, &mut calls), Err(SHELL_EXITED_UNRECORDED.into()));
        assert!(map.lock().unwrap().get("s1-ab").and_then(Slot::live).is_some(), "slot dropped on refusal");
    }
    assert_eq!(calls, 4, "a gone root must not be re-snapshotted");
    // Closing the tab afterwards finishes the teardown.
    assert_eq!(teardown(&map, Intent::Close, &mut calls), Ok(()));
    assert!(!map.lock().unwrap().contains_key("s1-ab"));
}

#[test]
fn close_straight_after_a_resume_refusal_drops_the_slot_and_kills_the_shell() {
    let child = sleeper();
    let pid = child.id();
    let map = Mutex::new(HashMap::from([("s1-ab".to_string(), Slot::Live((child, KillRetry::default())))]));
    let mut calls = 0;
    assert_eq!(teardown(&map, Intent::Resume, &mut calls), Err(TREE_UNVERIFIED.into()));
    assert!(matches!(observe(pid), ProcessObservation::Present(_)), "resume killed the shell");
    assert_eq!(teardown(&map, Intent::Close, &mut calls), Ok(()));
    assert!(!map.lock().unwrap().contains_key("s1-ab"), "slot not dropped");
    assert!(matches!(observe(pid), ProcessObservation::Gone), "shell left running");
}

#[test]
fn adopt_refuses_an_unrecorded_tree_without_verifying() {
    let retry = KillRetry::default();
    let mut verified = false;
    let out = adopt_outcome(Err(TREE_UNVERIFIED.into()), &retry, |_| {
        verified = true;
        Ok(())
    });
    assert_eq!(out, Err(TREE_UNVERIFIED.into()));
    assert!(!verified);
}

#[test]
fn adopt_on_the_spared_path_succeeds_once_verification_passes() {
    let mut retry = KillRetry { tree_recorded: true, spared: true, ..KillRetry::default() };
    let failed = || Err::<(), String>("taskkill exit Some(1)".into());
    assert_eq!(adopt_outcome(failed(), &retry, |_| Ok(())), Ok(()));
    assert_eq!(
        adopt_outcome(failed(), &retry, |_| Err(survivors_error(&[12]))),
        Err(survivors_error(&[12]))
    );
    // The plain /T path keeps the taskkill error even when verified.
    retry.spared = false;
    assert_eq!(adopt_outcome(failed(), &retry, |_| Ok(())), failed());
    assert_eq!(adopt_outcome(Ok(()), &retry, |_| Ok(())), Ok(()));
}

#[test]
fn a_signaled_handle_is_gone_whatever_its_exit_code() {
    assert!(matches!(classify(Some(true), Some(100)), ProcessObservation::Gone));
    assert!(matches!(classify(Some(true), None), ProcessObservation::Gone));
    assert!(matches!(classify(Some(false), Some(100)), ProcessObservation::Present(100)));
    assert!(matches!(classify(Some(false), None), ProcessObservation::Unknown));
    assert!(matches!(classify(None, Some(100)), ProcessObservation::Unknown));
}

#[test]
fn failed_tree_identities_travel_with_the_restored_slot() {
    let map = Mutex::new(HashMap::from([("s1-ab".to_string(), Slot::Live(KillRetry::default()))]));
    let identity = ProcessIdentity { pid: 11, created: 100 };
    assert!(take_or_restore(&map, "s1-ab", |retry| {
        retry.descendants.push(identity);
        Err("tree kill failed".into())
    }).is_err());
    assert!(take_or_restore(&map, "s1-ab", |retry| {
        assert_eq!(retry.descendants, vec![identity]);
        Err("descendant still running".into())
    }).is_err());
    assert!(map.lock().unwrap().get("s1-ab").and_then(Slot::live).is_some());
    assert!(admit(&map.lock().unwrap(), "s1-ab").is_err());
}

fn live(map: &Mutex<HashMap<String, Slot<u32>>>, id: &str) -> Option<u32> {
    map.lock().unwrap().get(id).and_then(Slot::live).copied()
}

#[test]
fn take_or_restore_marks_the_slot_stopping_and_releases_the_lock_before_the_kill() {
    let map: Mutex<HashMap<String, Slot<u32>>> = Mutex::new(HashMap::from([
        ("s1-ab".to_string(), Slot::Live(1)),
        ("s2-ab".to_string(), Slot::Live(2)),
    ]));
    let mut seen = None;
    let ran = take_or_restore(&map, "s1-ab", |v| {
        // The kill step: the map must be lockable (no guard held) and the
        // slot marked Stopping, so write_pty/resize_pty see no live entry.
        let g = map.try_lock().expect("tab-map lock held across the kill");
        assert!(matches!(g.get("s1-ab"), Some(Slot::Stopping)), "slot not marked during the kill");
        assert!(g.get("s2-ab").and_then(Slot::live).is_some());
        seen = Some(*v);
        Ok(())
    });
    assert_eq!(ran, Ok(()));
    assert_eq!(seen, Some(1));
    assert!(!map.lock().unwrap().contains_key("s1-ab"), "slot not removed on Ok");
    let mut again = false;
    assert_eq!(take_or_restore(&map, "s1-ab", |_| { again = true; Ok(()) }), Ok(()));
    assert!(!again, "second take finds nothing");
}

#[test]
fn a_concurrent_take_or_spawn_during_the_kill_is_refused() {
    // Double-click kill_pty racing an adopt: the second call must
    // not see "no entry" and return Ok while the first kill is still running.
    let map: Mutex<HashMap<String, Slot<u32>>> = Mutex::new(HashMap::from([("s1-ab".to_string(), Slot::Live(1))]));
    let mut inner = None;
    let mut admitted = None;
    let first = take_or_restore(&map, "s1-ab", |_| {
        inner = Some(take_or_restore(&map, "s1-ab", |_| Ok(())));
        admitted = Some(admit(&map.lock().unwrap(), "s1-ab"));
        Err("still running".into())
    });
    assert!(first.is_err());
    assert_eq!(inner.unwrap().unwrap_err(), STOPPING);
    assert_eq!(admitted.unwrap().unwrap_err(), STOPPING);
    assert_eq!(live(&map, "s1-ab"), Some(1), "entry not restored after the failed kill");
}

#[test]
fn a_refused_kill_puts_the_entry_back_so_a_retry_refuses_too() {
    let map: Mutex<HashMap<String, Slot<u32>>> = Mutex::new(HashMap::from([("s1-ab".to_string(), Slot::Live(7))]));
    let first = take_or_restore(&map, "s1-ab", |_| Err("still running".into()));
    assert_eq!(first.unwrap_err(), "still running");
    assert_eq!(live(&map, "s1-ab"), Some(7), "entry not restored");
    // The retry finds the entry and runs the kill again (not a silent Ok).
    let mut ran = false;
    let second = take_or_restore(&map, "s1-ab", |_| { ran = true; Err("still running".into()) });
    assert!(ran && second.is_err());
    assert_eq!(live(&map, "s1-ab"), Some(7));
}

#[test]
fn a_panicking_kill_does_not_leave_the_slot_stopping() {
    let map: Mutex<HashMap<String, Slot<u32>>> = Mutex::new(HashMap::from([("s1-ab".to_string(), Slot::Live(7))]));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = take_or_restore(&map, "s1-ab", |_| panic!("kill blew up"));
    }));
    assert!(r.is_err());
    let m = map.lock().unwrap_or_else(|e| e.into_inner());
    assert!(!m.contains_key("s1-ab"), "Stopping slot left behind");
}

#[test]
fn taskkill_exit_128_is_an_already_gone_success() {
    assert!(taskkill_outcome(Some(0)).is_ok());
    assert!(taskkill_outcome(Some(128)).is_ok());
    assert!(taskkill_outcome(Some(1)).is_err());
    assert!(taskkill_outcome(Some(255)).is_err());
    assert!(taskkill_outcome(None).is_err());
}

#[test]
fn a_falcon_host_under_the_shell_is_spared_with_its_subtree() {
    let row = |parent: u32, exe: &str| ProcRow { parent, exe: exe.into() };
    // 10 pwsh -> 11 node(claude) -> 12 conhost ; 10 -> 20 falcon -> 21 pwsh -> 22 node
    let map = HashMap::from([
        (10, row(1, "pwsh.exe")),
        (11, row(10, "node.exe")),
        (12, row(11, "conhost.exe")),
        (20, row(10, "falcon.exe")),
        (21, row(20, "pwsh.exe")),
        (22, row(21, "node.exe")),
        (30, row(1, "other.exe")),
    ]);
    let same_age = |_: u32| Some(100u64);
    let falcon = |_: u32, r: &ProcRow| r.exe == "falcon.exe";
    let mut kill = tree_sparing(&map, 10, same_age, falcon).expect("falcon under the shell");
    kill.sort();
    assert_eq!(kill, vec![11, 12]);
    assert_eq!(tree_sparing(&map, 11, same_age, falcon), None, "no falcon: plain /T path");
    // A falcon.exe the predicate rejects (not Vidar's bundle) is killed with the rest.
    assert_eq!(tree_sparing(&map, 10, same_age, |_, _| false), None);
}

#[test]
fn a_stale_parent_pid_is_not_a_child() {
    let row = |parent: u32, exe: &str| ProcRow { parent, exe: exe.into() };
    // 10 pwsh (born t=500) -> 11 node (t=600) -> 13 conhost (t=650)
    // 12 and 14 list parent 10 but predate it: their real parent died and
    // its pid was reused by the shell. 15 has no readable creation time.
    let map = HashMap::from([
        (10, row(1, "pwsh.exe")),
        (11, row(10, "node.exe")),
        (12, row(10, "explorer.exe")),
        (13, row(11, "conhost.exe")),
        (14, row(10, "falcon.exe")),
        (15, row(10, "svchost.exe")),
        (20, row(10, "falcon.exe")),
        (21, row(12, "notepad.exe")),
    ]);
    let born = |p: u32| match p {
        10 => Some(500),
        11 => Some(600),
        12 => Some(100),
        13 => Some(650),
        14 => Some(400),
        20 => Some(500), // same tick as the parent still counts
        21 => Some(700),
        _ => None,
    };
    let mut kill = tree_sparing(&map, 10, born, |_, r| r.exe == "falcon.exe").expect("20 is spared");
    kill.sort();
    assert_eq!(kill, vec![11, 13], "stale-parent rows (12, its child 21, 14) and unknown 15 leaked in");
}

#[test]
fn only_a_bundle_store_falcon_is_spared() {
    let dir = r"D:\v\runtime\falcon\bundles";
    assert!(is_bundle_falcon(r"D:\v\runtime\falcon\bundles\b-123\falcon.exe", dir));
    assert!(is_bundle_falcon(r"d:\V\RUNTIME\falcon\bundles\b-123\FALCON.EXE", &format!("{dir}\\")));
    assert!(is_bundle_falcon("D:/v/runtime/falcon/bundles/b/falcon.exe", dir));
    for bad in [
        r"D:\v\src-falcon\target\debug\falcon.exe",
        r"D:\v\runtime\falcon\bundles\falcon.exe",
        r"D:\v\runtime\falcon\bundles\b\sub\falcon.exe",
        r"D:\v\runtime\falcon\bundles2\b\falcon.exe",
        r"D:\v\runtime\falcon\bundles\b\notfalcon.exe",
    ] {
        assert!(!is_bundle_falcon(bad, dir), "{bad} spared");
    }
}

#[test]
fn valid_tab_id_accepts_frontend_ids_and_rejects_paths() {
    assert!(valid_tab_id("s1-k3x9"));
    assert!(valid_tab_id("s12-abcd_2"));
    for bad in ["", "..", "a/b", "a\\b", "s1.json", "c:x", "s1 x", &"a".repeat(129)] {
        assert!(!valid_tab_id(bad), "{bad:?} accepted");
    }
    assert!(valid_tab_id(&"a".repeat(128)));
}

#[test]
fn admit_refuses_a_duplicate_and_a_bad_id() {
    let map = HashMap::from([("s1-ab".to_string(), Slot::Live(()))]);
    assert!(admit(&map, "s2-ab").is_ok());
    assert_eq!(admit(&map, "s1-ab").unwrap_err(), "pty already exists for this tab");
    assert_eq!(admit(&map, "../x").unwrap_err(), "invalid tab id");
}
