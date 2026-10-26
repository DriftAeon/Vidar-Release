//! Unit tests for `session.rs`, kept out of line so the module file holds only
//! production code.

use super::*;
use crate::journal::Record;

#[test]
fn a_resumed_conversation_can_only_be_reserved_once() {
    let registry = Registry::default();
    let first = registry.reserve("agent-a", Some("c-1")).expect("first");
    let second = registry.reserve("agent-a", Some("c-1"));
    let error = match second {
        Ok(_) => panic!("duplicate resume must fail closed"),
        Err(error) => error,
    };
    assert!(error.contains("already hosted"), "{error}");
    drop(first);
    // Releasing the failed spawn's claim frees the conversation again.
    assert!(registry.reserve("agent-a", Some("c-1")).is_ok());
}

#[test]
fn fresh_conversations_do_not_collide_with_each_other() {
    let registry = Registry::default();
    let first = registry.reserve("agent-a", None).expect("first");
    let second = registry.reserve("agent-a", None).expect("second");
    assert_ne!(first.id, second.id);
    assert_ne!(first.generation, second.generation);
}

#[test]
fn different_agents_may_hold_the_same_conversation_id() {
    let registry = Registry::default();
    let _agent_a = registry.reserve("agent-a", Some("c-1")).expect("agent-a");
    assert!(registry.reserve("agent-b", Some("c-1")).is_ok());
}

fn holder(registry: &Registry, conversation: &str) -> Option<String> {
    lock(&registry.inner)
        .reservations
        .holder("agent-a", conversation)
}

#[test]
fn a_pending_reservation_names_the_session_it_is_for() {
    // The claim is identifiable from the moment it exists; an anonymous
    // placeholder is a conversation held by nobody, which is what lets a
    // later ownership check pass for the wrong session.
    let registry = Registry::default();
    let reservation = registry.reserve("agent-a", Some("c-1")).expect("reserve");
    assert_eq!(holder(&registry, "c-1").as_deref(), Some(&*reservation.id));
}

#[test]
fn a_failed_spawn_frees_the_conversation_it_reserved() {
    // The spawn path takes the reservation before the child exists; every
    // failure after that point drops it without committing.
    let registry = Registry::default();
    let reservation = registry.reserve("agent-a", Some("c-1")).expect("reserve");
    drop(reservation);
    assert_eq!(holder(&registry, "c-1"), None);
    let again = registry.reserve("agent-a", Some("c-1")).expect("reusable");
    assert_eq!(holder(&registry, "c-1").as_deref(), Some(&*again.id));
}

#[test]
fn racing_reserves_of_one_conversation_yield_exactly_one_winner() {
    // The sequential test proves the check; this proves the check and the
    // insertion are one critical section under real contention.
    const RACERS: usize = 8;
    let registry = Registry::default();
    let winners: Mutex<Vec<Reservation<'_>>> = Mutex::new(Vec::new());
    let start = std::sync::Barrier::new(RACERS);
    std::thread::scope(|scope| {
        for _ in 0..RACERS {
            scope.spawn(|| {
                start.wait();
                if let Ok(reservation) = registry.reserve("agent-a", Some("c-race")) {
                    // Held until every racer has tried: a winner that freed
                    // its claim early would let a loser win as well, and the
                    // test would pass for the wrong reason.
                    lock(&winners).push(reservation);
                }
            });
        }
    });
    let held = lock(&winners);
    assert_eq!(held.len(), 1, "exactly one caller may host a conversation");
    assert_eq!(holder(&registry, "c-race").as_deref(), Some(&*held[0].id));
}

#[test]
fn an_empty_conversation_id_is_never_reserved_or_adopted() {
    // An empty key would collide across unrelated sessions, so both doors
    // refuse it rather than record a meaningless claim.
    let registry = Registry::default();
    assert!(registry.reserve("agent-a", Some("")).is_err());
    assert!(registry.reserve("agent-a", Some("   ")).is_err());
    let error = registry
        .adopt_conversation("s00000001", "")
        .expect_err("empty adoption must fail");
    assert!(error.contains("empty"), "{error}");
}

#[test]
fn adoption_by_an_unregistered_session_is_reported_not_swallowed() {
    // The P1: this used to return silently, so a fresh session whose CLI
    // reported its conversation before the session was published never took
    // the reservation — and a second client could then resume it alongside.
    let registry = Registry::default();
    let error = registry
        .adopt_conversation("s00000001", "c-1")
        .expect_err("adoption without a session must fail");
    assert!(error.contains("not registered"), "{error}");
    assert_eq!(holder(&registry, "c-1"), None);
}

#[test]
fn releasing_an_unknown_session_is_refused() {
    let registry = Registry::default();
    assert!(registry.release("s00000001").is_err());
}

#[test]
fn freeing_conversations_drops_the_claim_and_keeps_others() {
    // The exit path frees a session's claims without needing a client to
    // send `release`. A reserved-but-uncommitted id has no session entry,
    // which is the shape this can test without an OS process; the exited
    // check on a registered session is the same one `release` runs.
    let registry = Registry::default();
    let mine = registry.reserve("agent-a", Some("c-1")).expect("reserve");
    let theirs = registry.reserve("agent-a", Some("c-2")).expect("reserve");
    assert_eq!(holder(&registry, "c-1").as_deref(), Some(mine.id.as_str()));

    let freed = registry.free_conversations(&mine.id).expect("free");
    assert_eq!(freed, 1);
    assert_eq!(holder(&registry, "c-1"), None, "the claim is gone");
    assert_eq!(
        holder(&registry, "c-2").as_deref(),
        Some(theirs.id.as_str()),
        "another session's claim is untouched"
    );
    assert_eq!(
        registry.free_conversations(&mine.id).expect("free again"),
        0,
        "idempotent"
    );
    // Now a resume of c-1 is accepted instead of refused.
    let resumed = registry
        .reserve("agent-a", Some("c-1"))
        .expect("c-1 is free again");
    assert_eq!(
        holder(&registry, "c-1").as_deref(),
        Some(resumed.id.as_str())
    );
    drop((mine, theirs, resumed));
}

// The rest of the lifecycle lives one layer down, on the table `release`
// and `adopt_conversation` delegate to: both need a registered `Session`,
// and a `Session` needs a real `Child` (an OS process handle), which a unit
// test cannot fabricate. These drive the exact calls those two make.

#[test]
fn adopting_a_conversation_another_session_holds_is_refused_not_stolen() {
    let mut reservations = Reservations::default();
    reservations
        .claim(("agent-a", "c-1".into()), "s00000001")
        .expect("first claim");
    let error = reservations
        .claim(("agent-a", "c-1".into()), "s00000002")
        .expect_err("a second session must not take it");
    assert!(
        error.contains("already hosted by session s00000001"),
        "{error}"
    );
    assert_eq!(
        reservations.holder("agent-a", "c-1").as_deref(),
        Some("s00000001"),
        "the refusal must leave the original holder in place"
    );
}

#[test]
fn adoption_is_idempotent_for_the_session_that_already_holds_it() {
    // `system/init` can be observed more than once across a session's life,
    // and a resumed session already owns the key before the CLI reports it.
    let mut reservations = Reservations::default();
    reservations
        .claim(("agent-a", "c-1".into()), "s00000001")
        .expect("first");
    reservations
        .claim(("agent-a", "c-1".into()), "s00000001")
        .expect("re-adoption by the owner is a no-op");
    assert_eq!(
        reservations.holder("agent-a", "c-1").as_deref(),
        Some("s00000001")
    );
}

#[test]
fn release_frees_only_the_releasing_sessions_conversations() {
    // The second P1: release used to remove `(agent, session.conversation)`
    // outright. If that key belonged to another session it was freed here,
    // and a second process could then run on a transcript the first still
    // holds.
    let mut reservations = Reservations::default();
    reservations
        .claim(("agent-a", "c-1".into()), "s00000001")
        .expect("a");
    reservations
        .claim(("agent-a", "c-2".into()), "s00000002")
        .expect("b");
    let freed = reservations.release_all("s00000001");
    assert_eq!(freed, 1);
    assert_eq!(reservations.holder("agent-a", "c-1"), None);
    assert_eq!(
        reservations.holder("agent-a", "c-2").as_deref(),
        Some("s00000002"),
        "releasing one session must not free another's conversation"
    );
}

#[test]
fn a_single_key_is_freed_only_by_its_owner() {
    // What `Reservation::drop` does: an uncommitted claim frees itself and
    // nothing else.
    let mut reservations = Reservations::default();
    let key = ("agent-a", "c-1".to_string());
    reservations.claim(key.clone(), "s00000001").expect("claim");
    assert!(!reservations.release_key(&key, "s00000002"));
    assert_eq!(
        reservations.holder("agent-a", "c-1").as_deref(),
        Some("s00000001")
    );
    assert!(reservations.release_key(&key, "s00000001"));
    assert_eq!(reservations.holder("agent-a", "c-1"), None);
    assert!(!reservations.release_key(&key, "s00000001"), "already gone");
}

#[test]
fn a_session_that_reports_a_second_conversation_keeps_both_until_release() {
    // Adoption never frees the earlier conversation: the child may still
    // append to it. The cost is a refused resume until release, and release
    // sweeps by holder, so nothing is stranded.
    let mut reservations = Reservations::default();
    reservations
        .claim(("agent-a", "c-1".into()), "s00000001")
        .expect("first");
    reservations
        .claim(("agent-a", "c-2".into()), "s00000001")
        .expect("second");
    assert!(reservations
        .claim(("agent-a", "c-1".into()), "s00000002")
        .is_err());
    assert_eq!(reservations.release_all("s00000001"), 2);
    assert_eq!(reservations.holder("agent-a", "c-1"), None);
    assert_eq!(reservations.holder("agent-a", "c-2"), None);
}

/// A throwaway directory for a test journal, removed on drop. Mirrors
/// `journal::tests::Temp`; not shared with it because that one is private
/// to `journal.rs` and this module may only touch `session.rs`.
pub(crate) struct TempJournalDir {
    path: std::path::PathBuf,
}

impl TempJournalDir {
    fn new(tag: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("falcon-session-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create temp journal dir");
        Self { path }
    }
}

impl Drop for TempJournalDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// A real but trivial child, spawned only so a test can build a real
/// [`Session`] end to end. `cmd.exe /c exit` is present on every Windows
/// host and exits almost immediately; [`Child`]'s `Drop` tears down its Job
/// non-blockingly, so leaving it running past the test is harmless.
pub(crate) fn spawn_test_child() -> Child {
    let request = crate::process::SpawnRequest {
        program: std::path::PathBuf::from(r"C:\Windows\System32\cmd.exe"),
        args: vec!["/c".into(), "exit".into()],
        cwd: std::env::temp_dir(),
        env: Vec::new(),
        env_base: crate::process::EnvBase::Inherit,
    };
    crate::process::spawn(&request).expect("spawn test child").0
}

fn started_record() -> Body {
    Body::Started {
        session: "s-attach-cut".into(),
        agent: "agent-a".into(),
        cwd: r"C:\Work\Example".into(),
        model: None,
        permission_mode: "default".into(),
        conversation: None,
        pid: 4242,
    }
}

/// A session that loses a journal append stops promising durability, and
/// never un-promises it back.
///
/// The degrade is entered directly: the only real trigger left is an I/O
/// failure (a too-large record no longer degrades, see below), and a full
/// disk cannot be produced portably in a unit test.
#[test]
fn a_lost_append_degrades_the_session_permanently() {
    let (_temp, session) = uncontrolled_session("degraded");
    assert_eq!(session.degraded(), None, "a fresh session is not degraded");

    session.enter_degraded("journal io: fsync record: disk full");
    session.enter_degraded("a later failure must not overwrite the first");
    let why = session.degraded().expect("degraded once entered");
    assert!(why.contains("disk full"), "the first reason is kept: {why}");

    // A later append that SUCCEEDS must not clear it. A session that has
    // lost a record cannot get it back, and recovering on the next
    // successful write would silently resume promising a durability the
    // journal can no longer deliver.
    session
        .enqueue_prompt(serde_json::json!("small"))
        .expect("an ordinary prompt still appends");
    assert_eq!(
        session.degraded(),
        Some(why),
        "degraded is permanent; one good write does not undo a lost record"
    );
}

/// A record over [`crate::journal::MAX_RECORD`] is refused before anything
/// is written, so durability is intact and the session must not degrade.
/// Regression: an 8 MB child line made lossy (or escaped) past the cap used to
/// mark the session degraded for the rest of its life.
#[test]
fn a_too_large_record_is_refused_without_degrading() {
    let (_temp, session) = uncontrolled_session("too-large");
    let oversized = "x".repeat(crate::journal::MAX_RECORD + 1);

    // A mutation carrying it is refused, and only that mutation.
    let refused = session
        .enqueue_prompt(serde_json::json!(oversized.clone()))
        .expect_err("a record over the cap must be refused by the journal");
    assert!(matches!(refused, JournalError::TooLarge { .. }), "{refused}");
    assert_eq!(session.degraded(), None, "a refused record is not lost durability");

    // An event carrying it is replaced by an Overflow naming the loss.
    session
        .publish_durable(EventBody::Diagnostic { text: oversized })
        .expect("the overflow stands in for the line");
    assert_eq!(session.degraded(), None, "still not degraded");
    let (records, more) = session
        .hydrate_from(0, u64::MAX, 1000, usize::MAX)
        .expect("hydrate");
    assert!(!more);
    let last = records.last().expect("a record");
    assert!(
        matches!(
            &last.body,
            Body::Event {
                body: EventBody::Overflow { bytes }
            } if *bytes as usize > crate::journal::MAX_RECORD
        ),
        "the journal holds an Overflow in place of the line: {:?}",
        last.body
    );

    session
        .enqueue_prompt(serde_json::json!("small"))
        .expect("the next append is as safe as the last");
}

/// Regression: append accepted records up to `MAX_RECORD` while hydrate
/// refused any lone record over [`crate::journal::LONE_RECORD_CAP`], so a
/// record in that band was journaled and then failed every hydrate forever.
/// Append now shares the hydrate cap: the band takes the Overflow path.
#[test]
fn a_record_between_the_hydrate_cap_and_max_record_overflows_and_hydrates() {
    use crate::journal::{LONE_RECORD_CAP, MAX_RECORD};
    assert!(LONE_RECORD_CAP < MAX_RECORD, "the band exists");
    let (_temp, session) = uncontrolled_session("hydrate-band");
    // The encoded record is the text plus its envelope: inside the band.
    let text = "x".repeat(LONE_RECORD_CAP + 1);
    session
        .publish_durable(EventBody::Diagnostic { text })
        .expect("the overflow stands in for the line");
    assert_eq!(session.degraded(), None, "a refused record is not lost durability");

    let (records, more) = session
        .hydrate_from(0, u64::MAX, 1000, 16 * 1024)
        .expect("a band record must not fail hydrate");
    assert!(!more);
    let last = records.last().expect("a record");
    assert!(
        matches!(
            &last.body,
            Body::Event {
                body: EventBody::Overflow { bytes }
            } if (*bytes as usize) > LONE_RECORD_CAP && (*bytes as usize) <= MAX_RECORD
        ),
        "the journal holds an Overflow in place of the band line: {:?}",
        last.body
    );
}

/// Falcon owns the queue: a prompt is retractable while it waits, and the
/// child is handed exactly one at a time. While the sidecar held the
/// queue, both of these were impossible — a prompt was gone the instant it
/// was written.
#[test]
fn only_one_queued_prompt_is_in_flight_at_a_time() {
    let (_temp, session) = uncontrolled_session("queue-one");
    let first = session
        .enqueue_prompt(serde_json::json!("first"))
        .expect("queue the first prompt");
    let second = session
        .enqueue_prompt(serde_json::json!("second"))
        .expect("queue the second prompt");
    assert_eq!(
        session.queued_prompts(),
        vec![first.clone(), second.clone()]
    );

    // The test child is not a sidecar, so the write itself may fail; what
    // is under test is that exactly ONE prompt leaves the queue per pump.
    let _ = session.pump();
    assert_eq!(
        session.queued_prompts(),
        vec![second.clone()],
        "one pump must take exactly one prompt"
    );
}

/// A prompt still waiting can be retracted; one already handed to the
/// child cannot, because the agent may already be acting on it and
/// reporting a retraction that did not happen is the worse failure.
#[test]
fn a_waiting_prompt_can_be_retracted_but_a_dispatched_one_cannot() {
    let (_temp, session) = uncontrolled_session("queue-retract");
    let first = session
        .enqueue_prompt(serde_json::json!("first"))
        .expect("queue");
    let second = session
        .enqueue_prompt(serde_json::json!("second"))
        .expect("queue");

    session
        .retract_prompt(&second)
        .expect("a prompt still waiting can be retracted");
    assert_eq!(session.queued_prompts(), vec![first.clone()]);

    assert!(
        session.retract_prompt(&second).is_err(),
        "retracting the same prompt twice must be refused, not silently accepted"
    );
    assert!(
        session.retract_prompt("p-never-existed").is_err(),
        "an unknown prompt id must be refused by name"
    );
}

/// The queue does not drain itself while a turn is running. Only the
/// turn's `result` releases the next prompt.
#[test]
fn a_second_pump_during_a_turn_dispatches_nothing() {
    // A child that stays open: `cmd /c exit` can close its stdin before the
    // first write lands, which failed this test on a hosted runner.
    let (_temp, session) = listening_session("queue-inflight");
    session
        .enqueue_prompt(serde_json::json!("first"))
        .expect("queue");
    let second = session
        .enqueue_prompt(serde_json::json!("second"))
        .expect("queue");

    // Asserted, not guarded by an `if`. A conditional body here would make
    // the whole test silently vacuous the day the test child stopped
    // accepting a line, and the test would still report green.
    let first_dispatch = session.pump();
    assert!(
        matches!(first_dispatch, Dispatched::Sent(_) | Dispatched::Unknown(_)),
        "the test child must accept the first prompt for this test to mean \
         anything, got {first_dispatch:?}"
    );
    assert_eq!(
        session.pump(),
        Dispatched::Idle,
        "a turn is in flight; nothing more may be dispatched"
    );
    assert_eq!(session.queued_prompts(), vec![second.clone()]);

    session.turn_finished();
    assert_ne!(
        session.pump(),
        Dispatched::Idle,
        "the turn ended, so the next prompt must go"
    );
    assert!(session.queued_prompts().is_empty());
}

/// A prompt whose write is refused outright must not be recorded as
/// dispatched.
///
/// Recording first was a real defect, and a silent one: replay retires a
/// dispatched prompt, so the prompt vanished from the queue, from `list`,
/// from retraction and from any rebuilt view, having never reached the
/// agent — while the client was told it was accepted and queued.
///
/// The refusal is real, not mocked: `stop()` marks the child stopping, and
/// `write_line_status` rejects a write on a stopping child without touching
/// the pipe.
#[test]
fn a_refused_write_is_not_recorded_as_dispatched() {
    let (_temp, session) = uncontrolled_session("queue-refused");
    let prompt = session
        .enqueue_prompt(serde_json::json!("never delivered"))
        .expect("queue");

    // Close the child so the next write is definitely refused.
    let _ = session.child.stop();

    match session.pump() {
        Dispatched::Failed(failed, _) => assert_eq!(failed, prompt),
        other => panic!("a write to a stopped child must be refused, got {other:?}"),
    }
    assert!(
        session.queued_prompts().is_empty(),
        "a prompt that could not be delivered is not still waiting"
    );

    // The dispatch is recorded before the write (so no child answer can
    // precede it), then withdrawn: the journal must not leave it standing.
    let (records, _more) = session
        .hydrate_from(
            0,
            session.journal_cursor.load(Ordering::SeqCst),
            256,
            1 << 20,
        )
        .expect("hydrate");
    let fate: Vec<&str> = records
        .iter()
        .filter_map(|record| match &record.body {
            Body::PromptDispatched { prompt: id, .. } if *id == prompt => Some("dispatched"),
            Body::PromptUndelivered { prompt: id, .. } if *id == prompt => Some("undelivered"),
            _ => None,
        })
        .collect();
    assert_eq!(
        fate,
        vec!["dispatched", "undelivered"],
        "a refused write must be recorded as dispatched first and then withdrawn"
    );
    let state = crate::replay::hydrate(None, &records).expect("replay");
    assert!(
        state.queued_prompts.is_empty(),
        "replay agrees with the live queue: the prompt is gone"
    );
}

/// A session whose child stays alive and reads stdin until it is closed
/// (`findstr` matching nothing), so several prompts in a row are really
/// written: the default test child exits at once and a later write may fail.
fn listening_session(tag: &str) -> (TempJournalDir, Arc<Session>) {
    listening_session_with(tag, AgentDriver::Claude(ClaudeDriver::default()))
}

fn listening_session_with(tag: &str, driver: AgentDriver) -> (TempJournalDir, Arc<Session>) {
    let temp = TempJournalDir::new(tag);
    let journal = Journal::open(&temp.path, &format!("s-{tag}")).expect("open journal");
    let registry = Registry::default();
    let reservation = registry.reserve("agent-a", None).expect("reserve");
    let request = crate::process::SpawnRequest {
        program: std::path::PathBuf::from(r"C:\Windows\System32\findstr.exe"),
        args: vec!["/r".into(), "^NEVER-MATCHES$".into()],
        cwd: std::env::temp_dir(),
        env: Vec::new(),
        env_base: crate::process::EnvBase::Inherit,
    };
    let child = crate::process::spawn(&request).expect("spawn findstr").0;
    let session = new_session(
        &reservation,
        "agent-a",
        r"C:\work".into(),
        None,
        child,
        driver,
        journal,
    );
    (temp, session)
}

#[test]
fn session_summary_preserves_the_exact_set_pick_for_readopt() {
    use crate::protocol::{SessionSummary, SetRef};
    for (tag, sets) in [
        ("sets-absent", None),
        ("sets-empty", Some(vec![])),
        ("sets-two", Some(vec![
            SetRef { library: None, set: "base".into() },
            SetRef { library: Some("team".into()), set: "review".into() },
        ])),
    ] {
        let (_temp, session) = listening_session(tag);
        if let Some(ref picked) = sets { session.sets.set(picked.clone()).unwrap(); }
        let wire = serde_json::to_value(session.summary()).unwrap();
        let readopt: SessionSummary = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(readopt.sets, sets);
        assert_eq!(wire.get("sets").is_some(), sets.is_some());
    }
}

fn dispatch_records(records: &[Record]) -> Vec<(String, bool)> {
    records
        .iter()
        .filter_map(|record| match &record.body {
            Body::PromptDispatched { prompt, steered } => Some((prompt.clone(), *steered)),
            _ => None,
        })
        .collect()
}

/// The steer: a waiting prompt goes to the child while a turn is in flight,
/// recorded `steered`, and joins the turn rather than waiting for its end.
/// The prompts behind it keep waiting, and the turn's `result` releases them.
#[test]
fn steer_while_a_turn_is_in_flight_dispatches_at_once() {
    let (_temp, session) = listening_session("steer-in-flight");
    let first = session.enqueue_prompt(serde_json::json!("first")).unwrap();
    let second = session.enqueue_prompt(serde_json::json!("second")).unwrap();
    let third = session.enqueue_prompt(serde_json::json!("third")).unwrap();
    let started = session.pump();
    assert!(matches!(started, Dispatched::Sent(_)), "{started:?}");

    let steered = session.steer_prompt(&third).expect("a waiting prompt can be steered");
    assert_eq!(steered, Dispatched::Sent(third.clone()));
    assert_eq!(session.queued_prompts(), vec![second.clone()]);
    assert!(session.retract_prompt(&third).is_err(), "a folded prompt is dispatched");
    assert!(session.steer_prompt(&third).is_err(), "steering twice is refused");
    assert_eq!(session.pump(), Dispatched::Idle, "the turn still runs");

    session.turn_finished();
    assert_eq!(session.pump(), Dispatched::Sent(second.clone()));

    let records = lock(&session.journal).records_after(0).unwrap();
    assert_eq!(
        dispatch_records(&records),
        vec![(first, false), (third, true), (second, false)]
    );
    session.child.terminate_tree();
}

/// The Claude steer line is the user line with priority `next`, from the
/// driver; the turn-starting line carries no priority.
#[test]
fn the_claude_driver_writes_the_steer_line_with_priority_next() {
    let driver = AgentDriver::Claude(ClaudeDriver::default());
    let content = serde_json::json!("go left");
    let mut want = user_line(&content);
    want["priority"] = serde_json::json!("next");
    assert_eq!(driver.steer_line("p", &content).unwrap(), want);
    assert_eq!(driver.prompt_line("p", &content), Ok(user_line(&content)));
    assert_eq!(user_line(&content)["type"], serde_json::json!("user"));
}

/// A listening session on a hosted Codex driver whose thread is ready.
pub(crate) fn codex_session(tag: &str) -> (TempJournalDir, Arc<Session>) {
    let params = crate::protocol::SpawnParams {
        agent: Some(crate::protocol::Agent::Codex),
        cwd: r"C:\work".into(),
        model: None,
        effort: None,
        permission_mode: "default".into(),
        resume: None,
        ctl_secret: None,
        rules_file: None,
        tab_name: None,
        gateway: None,
        profile: None,
        payload_file: None, mcp_file: None,
        row_key: None, sets: None,
        set_plugin_dirs: Vec::new(), codex_home: None, claude_config_dir: None, plugin_names: Vec::new(),
    };
    let driver = AgentDriver::codex(&params);
    if let AgentDriver::Codex(codex) = &driver {
        codex.ready_for_test("thread-1");
    }
    listening_session_with(tag, driver)
}

#[test]
fn adopting_during_codex_history_sees_the_outcome_before_live_output() {
    let temp = TempJournalDir::new("codex-history-barrier");
    let registry = Registry::default();
    let reservation = registry.reserve("codex", Some("thread-1")).unwrap();
    let journal = Journal::open(&temp.path, "s-codex-history-barrier").unwrap();
    let params = crate::protocol::SpawnParams {
        agent: Some(crate::protocol::Agent::Codex), cwd: r"C:\work".into(),
        model: None, effort: None, permission_mode: "default".into(),
        resume: Some("thread-1".into()), ctl_secret: None, rules_file: None,
        tab_name: None, gateway: None, profile: None, payload_file: None, mcp_file: None, row_key: None, sets: None,
        set_plugin_dirs: Vec::new(), codex_home: None, claude_config_dir: None, plugin_names: Vec::new(),
    };
    let session = new_session(
        &reservation, "codex", params.cwd.clone(), params.resume.clone(),
        spawn_test_child(), AgentDriver::codex(&params), journal,
    );
    session.publish_history(EventBody::Agent {
        line: serde_json::json!({"method":"falcon/history","params":{"phase":"start"}}),
    }, false);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let received = Arc::clone(&seen);
    let (_token, through) = session.attach(Arc::new(move |event: Event| {
        lock(&received).push(event.body);
    }));
    session.publish(EventBody::Diagnostic { text: "live diagnostic".into() });
    session.publish(EventBody::Agent { line: serde_json::json!({"method":"turn/started"}) });
    assert!(lock(&seen).is_empty(), "adopter saw live output during history");
    session.publish_history(EventBody::Agent {
        line: serde_json::json!({"method":"falcon/history","params":{"phase":"end","count":0}}),
    }, true);
    let seen = lock(&seen);
    assert_eq!(seen.len(), 3);
    assert!(matches!(&seen[0], EventBody::Agent { line } if line["params"]["phase"] == "end"));
    assert!(matches!(&seen[1], EventBody::Diagnostic { text } if text == "live diagnostic"));
    assert!(matches!(&seen[2], EventBody::Agent { line } if line["method"] == "turn/started"));
    drop(seen);
    let (history, _) = session.hydrate_from(0, through, 100, 1024 * 1024).unwrap();
    assert!(history.iter().any(|record| matches!(&record.body,
        Body::Event { body: EventBody::Agent { line } } if line["params"]["phase"] == "start")));
    session.child.terminate_tree();
}

/// What the stdout reader does with a forwarded child line
/// (`serve/spawn.rs`): answer and journal a request the host disposes of,
/// ask the driver whether it ends the turn, journal the turn facts, and on a
/// turn end free the queue and pump.
fn feed(session: &Session, line: serde_json::Value) -> Option<Dispatched> {
    for body in session.driver.answer_request(&session.child, &line) {
        session.record_quietly(body);
    }
    let ended = session.driver.ends_turn(&line);
    for body in session.driver.take_records() {
        session.record_quietly(body);
    }
    let requeued = session.requeue_refused_steers();
    if ended {
        session.turn_finished();
    }
    (ended || requeued).then(|| session.pump())
}

fn turn_event(method: &str, turn: &str) -> serde_json::Value {
    serde_json::json!({
        "method": method,
        "params": {"threadId": "thread-1", "turn": {"id": turn}}
    })
}

fn codex_records(records: &[Record]) -> Vec<crate::journal::CodexRecord> {
    records
        .iter()
        .filter_map(|record| match &record.body {
            Body::Codex { codex } => Some(codex.clone()),
            _ => None,
        })
        .collect()
}

/// The next queued Codex prompt goes only after the bound turn's
/// `turn/completed`; a completion of any other turn, including a late one of
/// the turn before, releases nothing.
#[test]
fn the_next_codex_prompt_goes_only_after_the_bound_turn_completes() {
    use crate::journal::CodexRecord;
    let (_temp, session) = codex_session("codex-turns");
    let a = session.enqueue_prompt(serde_json::json!("a")).unwrap();
    let b = session.enqueue_prompt(serde_json::json!("b")).unwrap();
    let c = session.enqueue_prompt(serde_json::json!("c")).unwrap();
    assert_eq!(session.pump(), Dispatched::Sent(a.clone()));

    assert_eq!(feed(&session, turn_event("turn/started", "t1")), None);
    assert_eq!(feed(&session, turn_event("turn/completed", "t0")), None);
    assert_eq!(feed(&session, serde_json::json!({"type": "result"})), None);
    assert_eq!(session.pump(), Dispatched::Idle, "t1 still runs");
    assert_eq!(
        feed(&session, turn_event("turn/completed", "t1")),
        Some(Dispatched::Sent(b.clone()))
    );

    // t1's late completion, before and after b's turn is bound.
    assert_eq!(feed(&session, turn_event("turn/completed", "t1")), None);
    assert_eq!(feed(&session, turn_event("turn/started", "t2")), None);
    assert_eq!(feed(&session, turn_event("turn/completed", "t1")), None);
    assert_eq!(session.queued_prompts(), vec![c.clone()]);
    assert_eq!(
        feed(&session, turn_event("turn/completed", "t2")),
        Some(Dispatched::Sent(c.clone()))
    );

    let records = lock(&session.journal).records_after(0).unwrap();
    assert_eq!(
        dispatch_records(&records),
        vec![(a.clone(), false), (b.clone(), false), (c.clone(), false)]
    );
    let codex = codex_records(&records);
    let bound: Vec<&CodexRecord> = codex
        .iter()
        .filter(|record| matches!(record, CodexRecord::TurnBound { .. }))
        .collect();
    assert_eq!(
        bound,
        vec![
            &CodexRecord::TurnBound {
                prompt: a.clone(),
                turn: "t1".into()
            },
            &CodexRecord::TurnBound {
                prompt: b.clone(),
                turn: "t2".into()
            },
        ]
    );
    let policies = codex
        .iter()
        .filter(|record| matches!(record, CodexRecord::PromptPolicy { .. }))
        .count();
    assert_eq!(policies, 3, "one policy snapshot per dispatched prompt");
    session.child.terminate_tree();
}

/// A queued Codex prompt that fit the line cap at submit but no longer does
/// once a set-model lengthens its `turn/start` stays at the head of the
/// queue, undispatched, instead of leaving it as undelivered; it goes once
/// the settings let it fit again.
#[test]
fn a_codex_prompt_pushed_over_the_line_cap_by_a_setting_stays_queued() {
    let (_temp, session) = codex_session("codex-line-cap");
    let AgentDriver::Codex(codex) = &session.driver else {
        unreachable!()
    };
    let set_model = |model: &str| {
        let message = serde_json::json!({"type": "set_model", "model": model});
        codex.command_as(0, &session.child, message)
    };
    assert_eq!(set_model("m").0, crate::protocol::Outcome::Applied);
    let probe = codex.prompt_line("probe", &serde_json::json!("")).unwrap();
    codex.dispatched("probe", false);
    // A few bytes of slack for a wider request id later.
    let fits = crate::process::LINE_CAP - probe.to_string().len() - 8;
    let prompt = session
        .enqueue_prompt(serde_json::json!("x".repeat(fits)))
        .unwrap();
    assert_eq!(set_model(&"m".repeat(80)).0, crate::protocol::Outcome::Applied);
    assert_eq!(session.pump(), Dispatched::Idle);
    assert_eq!(session.queued_prompts(), vec![prompt.clone()], "still waiting");
    let records = lock(&session.journal).records_after(0).unwrap();
    assert!(dispatch_records(&records).is_empty(), "never dispatched");
    assert!(!records.iter().any(|record| matches!(
        &record.body,
        Body::PromptUndelivered { prompt: id, .. } if *id == prompt
    )));
    assert_eq!(set_model("m").0, crate::protocol::Outcome::Applied);
    // An 8 MiB write may outlast the one-second bound: it went either way.
    let sent = session.pump();
    assert!(
        matches!(&sent, Dispatched::Sent(id) | Dispatched::Unknown(id) if *id == prompt),
        "{sent:?}"
    );
    session.child.terminate_tree();
}

/// A Codex steer before the running turn has an id is refused and the
/// prompt stays queued, nothing written or recorded; once the turn is bound
/// the same steer folds into it.
#[test]
fn a_codex_steer_before_the_turn_id_stays_queued() {
    let (_temp, session) = codex_session("steer-codex");
    let first = session.enqueue_prompt(serde_json::json!("first")).unwrap();
    let waiting = session.enqueue_prompt(serde_json::json!("later")).unwrap();
    assert_eq!(session.pump(), Dispatched::Sent(first.clone()));

    let error = session.steer_prompt(&waiting).expect_err("no turn id yet");
    assert!(error.contains("stays queued"), "{error}");
    assert_eq!(session.queued_prompts(), vec![waiting.clone()]);
    let records = lock(&session.journal).records_after(0).unwrap();
    assert_eq!(dispatch_records(&records), vec![(first.clone(), false)]);

    feed(&session, turn_event("turn/started", "t1"));
    assert_eq!(
        session.steer_prompt(&waiting),
        Ok(Dispatched::Sent(waiting.clone()))
    );
    assert!(session.queued_prompts().is_empty());
    let records = lock(&session.journal).records_after(0).unwrap();
    assert_eq!(
        dispatch_records(&records),
        vec![(first, false), (waiting, true)]
    );
    session.child.terminate_tree();
}

/// The id of the `turn/steer` just written: the last command id reserved.
fn last_command(session: &Session) -> u64 {
    session.driver.reserve_command() - 1
}

/// The queue a client adopting the session rebuilds from the journal pages
/// it hydrates.
fn replayed_queue(session: &Session) -> Vec<String> {
    let (records, _) = session
        .hydrate_from(0, session.journal_position(), 1024, 1 << 20)
        .unwrap();
    let state = crate::replay::hydrate(None, &records).unwrap();
    state
        .queued_prompts
        .iter()
        .map(|queued| queued.prompt.clone())
        .collect()
}

/// Codex refuses a written steer ("turn ended"): the prompt never joined the
/// turn, so it goes back to its place in the queue, journaled, and replay
/// agrees with the live queue. While the turn still runs it waits for the
/// turn end; it is retractable again, and the turn end pumps it in order.
#[test]
fn a_refused_codex_steer_goes_back_to_its_queue_place() {
    use crate::journal::CodexRecord;
    let (_temp, session) = codex_session("steer-refused");
    let first = session.enqueue_prompt(serde_json::json!("first")).unwrap();
    let second = session.enqueue_prompt(serde_json::json!("second")).unwrap();
    let third = session.enqueue_prompt(serde_json::json!("third")).unwrap();
    let fourth = session.enqueue_prompt(serde_json::json!("fourth")).unwrap();
    assert_eq!(session.pump(), Dispatched::Sent(first.clone()));
    feed(&session, turn_event("turn/started", "t1"));

    assert_eq!(session.steer_prompt(&third), Ok(Dispatched::Sent(third.clone())));
    let steer = last_command(&session);
    assert_eq!(session.queued_prompts(), vec![second.clone(), fourth.clone()]);
    assert_eq!(replayed_queue(&session), session.queued_prompts());

    let refused = serde_json::json!({"id": steer, "error": {"message": "turn ended"}});
    assert_eq!(feed(&session, refused), Some(Dispatched::Idle), "t1 still runs");
    assert_eq!(
        session.queued_prompts(),
        vec![second.clone(), third.clone(), fourth.clone()]
    );
    assert_eq!(replayed_queue(&session), session.queued_prompts());
    let records = lock(&session.journal).records_after(0).unwrap();
    assert!(records.iter().any(|record| matches!(&record.body,
        Body::PromptRequeued { prompt, at: 1, .. } if *prompt == third)));
    assert!(codex_records(&records).contains(&CodexRecord::TurnRefused {
        prompt: third.clone(),
        reason: "turn ended".into(),
    }));

    // Waiting again in every sense: retractable, and pumped in order.
    session.retract_prompt(&fourth).expect("still waiting");
    assert_eq!(
        feed(&session, turn_event("turn/completed", "t1")),
        Some(Dispatched::Sent(second.clone()))
    );
    assert_eq!(session.queued_prompts(), vec![third.clone()]);
    assert_eq!(replayed_queue(&session), session.queued_prompts());
    session.child.terminate_tree();
}

/// The refusal can come after the turn it named has ended and the next
/// prompt has gone: the steered prompt still comes back, ahead of the prompts
/// submitted after it, and with nothing to wait on behind a running turn it
/// waits for the next turn end.
#[test]
fn a_steer_refused_after_its_turn_ended_still_comes_back() {
    let (_temp, session) = codex_session("steer-refused-late");
    let first = session.enqueue_prompt(serde_json::json!("first")).unwrap();
    let second = session.enqueue_prompt(serde_json::json!("second")).unwrap();
    let third = session.enqueue_prompt(serde_json::json!("third")).unwrap();
    assert_eq!(session.pump(), Dispatched::Sent(first.clone()));
    feed(&session, turn_event("turn/started", "t1"));
    assert_eq!(session.steer_prompt(&second), Ok(Dispatched::Sent(second.clone())));
    let steer = last_command(&session);

    assert_eq!(
        feed(&session, turn_event("turn/completed", "t1")),
        Some(Dispatched::Sent(third.clone()))
    );
    assert!(session.driver.steer_pending(&second), "orphaned, still refusable");
    let refused = serde_json::json!({"id": steer, "error": {"message": "turn ended"}});
    assert_eq!(feed(&session, refused), Some(Dispatched::Idle), "third's turn runs");
    assert_eq!(session.queued_prompts(), vec![second.clone()]);
    assert_eq!(replayed_queue(&session), session.queued_prompts());

    feed(&session, turn_event("turn/started", "t2"));
    assert_eq!(
        feed(&session, turn_event("turn/completed", "t2")),
        Some(Dispatched::Sent(second.clone()))
    );
    assert!(replayed_queue(&session).is_empty());
    let records = lock(&session.journal).records_after(0).unwrap();
    assert!(!records.iter().any(|record| matches!(&record.body,
        Body::PromptUndelivered { prompt, .. } if *prompt == second)));
    session.child.terminate_tree();
}

/// Records about `prompt`, and the Diagnostic texts, in journal order.
fn prompt_trail(session: &Session, prompt: &str) -> (Vec<String>, Vec<String>) {
    let records = lock(&session.journal).records_after(0).unwrap();
    let mut trail = Vec::new();
    let mut diagnostics = Vec::new();
    for record in &records {
        match &record.body {
            Body::PromptDispatched { prompt: p, .. } if p == prompt => trail.push("dispatched".into()),
            Body::PromptRequeued { prompt: p, .. } if p == prompt => trail.push("requeued".into()),
            Body::PromptUndelivered { prompt: p, reason } if p == prompt => {
                trail.push(format!("undelivered: {reason}"))
            }
            Body::Event { body: EventBody::Diagnostic { text } } => diagnostics.push(text.clone()),
            _ => {}
        }
    }
    (trail, diagnostics)
}

/// A steer Codex accepts after its turn ended was applied: dropped, with
/// nothing journaled or announced for it, and nothing released later.
#[test]
fn a_steer_accepted_after_its_turn_ended_is_dropped_quietly() {
    let (_temp, session) = codex_session("steer-accepted-late");
    let first = session.enqueue_prompt(serde_json::json!("first")).unwrap();
    let second = session.enqueue_prompt(serde_json::json!("second")).unwrap();
    let third = session.enqueue_prompt(serde_json::json!("third")).unwrap();
    assert_eq!(session.pump(), Dispatched::Sent(first.clone()));
    feed(&session, turn_event("turn/started", "t1"));
    assert_eq!(session.steer_prompt(&second), Ok(Dispatched::Sent(second.clone())));
    let steer = last_command(&session);
    assert_eq!(
        feed(&session, turn_event("turn/completed", "t1")),
        Some(Dispatched::Sent(third.clone()))
    );
    let accepted = serde_json::json!({"id": steer, "result": {"turnId": "t1"}});
    assert_eq!(feed(&session, accepted), None);
    assert!(!session.driver.steer_pending(&second));
    feed(&session, turn_event("turn/started", "t2"));
    assert_eq!(feed(&session, turn_event("turn/completed", "t2")), Some(Dispatched::Idle));
    assert_eq!(prompt_trail(&session, &second), (vec!["dispatched".to_string()], vec![]));
    assert!(lock(&session.queue).folded.is_empty());
    assert!(replayed_queue(&session).is_empty());
    session.child.terminate_tree();
}

/// A steer Codex never answers stays refusable past its own turn's end and
/// is released at the next one: journaled undelivered (not requeued, since
/// it may have been applied) and announced, so the view says why its block
/// went away.
#[test]
fn an_orphaned_steer_unanswered_at_the_next_turn_end_is_undelivered() {
    let (_temp, session) = codex_session("steer-orphan");
    let first = session.enqueue_prompt(serde_json::json!("first")).unwrap();
    let second = session.enqueue_prompt(serde_json::json!("second")).unwrap();
    let third = session.enqueue_prompt(serde_json::json!("third")).unwrap();
    assert_eq!(session.pump(), Dispatched::Sent(first.clone()));
    feed(&session, turn_event("turn/started", "t1"));
    assert_eq!(session.steer_prompt(&second), Ok(Dispatched::Sent(second.clone())));
    assert_eq!(
        feed(&session, turn_event("turn/completed", "t1")),
        Some(Dispatched::Sent(third.clone()))
    );
    assert_eq!(prompt_trail(&session, &second).0, vec!["dispatched".to_string()]);

    feed(&session, turn_event("turn/started", "t2"));
    assert_eq!(feed(&session, turn_event("turn/completed", "t2")), Some(Dispatched::Idle));
    assert!(!session.driver.steer_pending(&second));
    let reason = "the agent never answered the steer, and the following turn has ended";
    assert_eq!(
        prompt_trail(&session, &second),
        (
            vec!["dispatched".to_string(), format!("undelivered: {reason}")],
            vec![format!("Steered prompt {second} may not have been delivered: {reason}.")]
        )
    );
    assert!(lock(&session.queue).folded.is_empty());
    assert!(replayed_queue(&session).is_empty());
    session.child.terminate_tree();
}

/// The steer race: the stdout reader ends the turn after the steer is armed
/// and before its line is written. The write gate sees the ended turn and
/// writes nothing. Deterministic at the gate; `steer_prompt` itself arms and
/// writes in one call, so the interleaving is driven through its parts.
#[test]
fn a_steer_whose_turn_ends_before_the_write_is_not_written() {
    let (_temp, session) = codex_session("steer-race");
    let first = session.enqueue_prompt(serde_json::json!("first")).unwrap();
    assert_eq!(session.pump(), Dispatched::Sent(first.clone()));
    feed(&session, turn_event("turn/started", "t1"));
    let AgentDriver::Codex(driver) = &session.driver else {
        panic!("a Codex session");
    };
    driver
        .steer_line("p-race", &serde_json::json!("race"))
        .expect("armed");
    let live = driver.write_steer("p-race", || crate::process::WriteStatus::Written);
    assert!(live.is_some(), "written while its turn runs");
    feed(&session, turn_event("turn/completed", "t1"));
    let written = driver.write_steer("p-race", || panic!("written for an ended turn"));
    assert!(written.is_none());
    session.child.terminate_tree();
}

/// The same race through `hand_over`: the turn ends after `steer_prompt`
/// armed the steer and its pump finds nothing waiting. The gate refuses the
/// write, the prompt is requeued and the client is told it could not be
/// steered; then `hand_over` pumps it, so it starts the next turn instead of
/// waiting for a turn end that never comes. `steer_prompt`'s arming half is
/// done by hand, as it is one call.
#[test]
fn a_steer_whose_turn_ends_first_is_requeued_then_starts_the_next_turn() {
    let (_temp, session) = codex_session("steer-race-pump");
    let first = session.enqueue_prompt(serde_json::json!("first")).unwrap();
    let second = session.enqueue_prompt(serde_json::json!("second")).unwrap();
    assert_eq!(session.pump(), Dispatched::Sent(first.clone()));
    feed(&session, turn_event("turn/started", "t1"));

    // `steer_prompt` up to the write: armed, in flight, folded, recorded.
    let line = session
        .driver
        .steer_line(&second, &serde_json::json!("second"))
        .expect("armed");
    let held = {
        let mut queue = lock(&session.queue);
        let held = queue.waiting.pop_front().expect("second waits");
        queue.in_flight.push(held.id.clone());
        queue.folded.insert(held.id.clone(), held.clone());
        session.record_quietly(Body::PromptDispatched {
            prompt: held.id.clone(),
            steered: true,
        });
        held
    };
    assert_eq!(
        feed(&session, turn_event("turn/completed", "t1")),
        Some(Dispatched::Idle),
        "the reader's pump finds nothing waiting"
    );

    let encoded = serde_json::to_string(&line).unwrap();
    let reply = session.hand_over(held, encoded, true, true);
    assert_eq!(
        reply,
        Dispatched::Failed(second.clone(), dispatch::TURN_ENDED_FIRST.to_string())
    );
    assert_eq!(
        prompt_trail(&session, &second).0,
        vec!["dispatched", "requeued", "dispatched"],
        "requeued, then pumped"
    );
    assert_eq!(lock(&session.queue).in_flight, vec![second.clone()]);
    assert!(session.queued_prompts().is_empty());
    assert!(replayed_queue(&session).is_empty());
    let records = lock(&session.journal).records_after(0).unwrap();
    assert!(records.iter().any(|record| matches!(&record.body,
        Body::PromptDispatched { prompt, steered: false } if *prompt == second)));
    session.child.terminate_tree();
}

/// An accepted steer ends with its turn: nothing comes back, and nothing is
/// kept for a refusal that can no longer come.
#[test]
fn an_accepted_codex_steer_is_not_requeued() {
    let (_temp, session) = codex_session("steer-accepted");
    let first = session.enqueue_prompt(serde_json::json!("first")).unwrap();
    let second = session.enqueue_prompt(serde_json::json!("second")).unwrap();
    assert_eq!(session.pump(), Dispatched::Sent(first));
    feed(&session, turn_event("turn/started", "t1"));
    assert_eq!(session.steer_prompt(&second), Ok(Dispatched::Sent(second.clone())));
    let steer = last_command(&session);
    assert_eq!(
        feed(&session, serde_json::json!({"id": steer, "result": {"turnId": "t1"}})),
        None
    );
    assert_eq!(feed(&session, turn_event("turn/completed", "t1")), Some(Dispatched::Idle));
    assert!(lock(&session.queue).folded.is_empty());
    assert!(session.queued_prompts().is_empty());
    assert!(replayed_queue(&session).is_empty());
    session.child.terminate_tree();
}

/// The host's `interrupt` command on a real hosted-Codex child: sent before
/// the turn id, it is written once Codex names the turn and settles on
/// Codex's answer. (What goes on the wire, and only once:
/// `codex::driver::interrupt::tests`.)
#[test]
fn a_codex_interrupt_before_the_turn_id_settles_after_it() {
    let (_temp, session) = codex_session("interrupt-codex");
    let first = session.enqueue_prompt(serde_json::json!("first")).unwrap();
    assert_eq!(session.pump(), Dispatched::Sent(first));
    let AgentDriver::Codex(codex) = &session.driver else {
        unreachable!("a Codex session");
    };
    let cid = session.driver.reserve_command();
    let settled = std::thread::scope(|scope| {
        let stop = scope.spawn(|| {
            session.driver.command_as(
                cid,
                &session.child,
                serde_json::json!({ "type": "interrupt" }),
            )
        });
        assert!(!codex.interrupt_awaits_answer(cid));
        feed(&session, turn_event("turn/started", "t1"));
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !codex.interrupt_awaits_answer(cid) {
            assert!(std::time::Instant::now() < until, "the interrupt was never sent");
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        feed(&session, serde_json::json!({ "id": cid, "result": {} }));
        stop.join().unwrap()
    });
    assert_eq!(settled, (crate::protocol::Outcome::Applied, None));
    session.child.terminate_tree();
}

/// With no view attached, an unknown server request on a real hosted-Codex
/// child is answered and journaled once, and a card is left for the approval
/// mapping. (The answer line itself: `codex::driver::requests::tests`.)
#[test]
fn a_codex_unknown_server_request_is_journaled_once_with_no_view() {
    use crate::journal::CodexRecord;
    let (_temp, session) = codex_session("server-request-codex");
    let unknown = serde_json::json!({ "id": 40, "method": "future/thing" });
    feed(&session, unknown.clone());
    feed(&session, unknown);
    feed(
        &session,
        serde_json::json!({ "id": 41, "method": "item/fileChange/requestApproval" }),
    );
    let records = lock(&session.journal).records_after(0).unwrap();
    assert_eq!(
        codex_records(&records),
        vec![CodexRecord::ServerRequestAnswered {
            request: "sr:40".into(),
            method: "future/thing".into(),
            disposition: "unknown".into(),
            delivery: "written".into(),
            error: None,
        }]
    );
    session.child.terminate_tree();
}

/// A hosted Codex card on a real child stays pending with no view and no
/// lease, is answered once through `AgentDriver::command_as`, and a second
/// answer reads as already answered; the exit then cancels it.
#[test]
fn a_codex_card_waits_with_no_view_and_answers_once() {
    let (_temp, session) = codex_session("approval-codex");
    let card = serde_json::json!({
        "id": 12,
        "method": "item/permissions/requestApproval",
        "params": { "threadId": "thread-1", "turnId": "t1", "permissions": { "network": {} } }
    });
    session.driver.observe(&card);
    assert!(feed(&session, card.clone()).is_none());
    assert_eq!(session.driver.permission_request(&card), Some("sr:12".into()));
    assert_eq!(session.driver.pending_permissions(), vec!["sr:12".to_string()]);
    let answer = serde_json::json!({ "type": "permission_response", "id": "sr:12", "behavior": "allow" });
    let cid = session.driver.reserve_command();
    assert_eq!(
        session.driver.command_as(cid, &session.child, answer.clone()),
        (Outcome::Applied, None)
    );
    let cid = session.driver.reserve_command();
    assert_eq!(
        session.driver.command_as(cid, &session.child, answer),
        (
            Outcome::Failed,
            Some("no pending permission sr:12".into())
        )
    );
    assert!(session.driver.pending_permissions().is_empty());
    assert_eq!(session.driver.abandon("exit"), vec!["sr:12".to_string()]);
    session.child.terminate_tree();
}

/// With no turn running a steer is an ordinary dispatch that starts one.
#[test]
fn steer_with_no_turn_in_flight_starts_one() {
    let (_temp, session) = listening_session("steer-idle");
    let only = session.enqueue_prompt(serde_json::json!("only")).unwrap();
    assert_eq!(session.steer_prompt(&only), Ok(Dispatched::Sent(only.clone())));
    assert_eq!(session.pump(), Dispatched::Idle, "the steered prompt holds the turn");
    let records = lock(&session.journal).records_after(0).unwrap();
    assert_eq!(dispatch_records(&records), vec![(only, false)]);
    session.child.terminate_tree();
}

/// A steer whose write is refused leaves the prompt waiting where it was, so
/// the turn end still pumps it. The journal says the same: dispatched first
/// (recorded before the write), then requeued at the same index, so replay
/// rebuilds the live queue.
#[test]
fn a_refused_steer_keeps_the_prompt_queued() {
    let (_temp, session) = uncontrolled_session("steer-refused");
    let first = session.enqueue_prompt(serde_json::json!("a")).unwrap();
    let second = session.enqueue_prompt(serde_json::json!("b")).unwrap();
    lock(&session.queue).in_flight.push("p-running".into());
    let _ = session.child.stop();
    match session.steer_prompt(&first) {
        Ok(Dispatched::Failed(failed, _)) => assert_eq!(failed, first),
        other => panic!("a write to a stopped child must be refused, got {other:?}"),
    }
    assert_eq!(session.queued_prompts(), vec![first.clone(), second]);
    assert_eq!(lock(&session.queue).in_flight, vec!["p-running".to_string()]);
    assert!(lock(&session.queue).folded.is_empty());
    let records = lock(&session.journal).records_after(0).unwrap();
    assert_eq!(dispatch_records(&records), vec![(first.clone(), true)]);
    assert!(records.iter().any(|record| matches!(&record.body,
        Body::PromptRequeued { prompt, at: 0, .. } if *prompt == first)));
    let state = crate::replay::hydrate(None, &records).expect("replay");
    let replayed: Vec<String> = state
        .queued_prompts
        .iter()
        .map(|queued| queued.prompt.clone())
        .collect();
    assert_eq!(replayed, session.queued_prompts());
}

/// After a restart the journal is all there is. Replay retires the folded
/// prompt like any dispatch, so a rebuilt queue never offers it again and
/// nothing can send it a second time.
#[test]
fn replay_after_a_restart_does_not_resend_a_folded_prompt() {
    let tag = "steer-replay";
    let (temp, session) = listening_session(tag);
    session.enqueue_prompt(serde_json::json!("first")).unwrap();
    let waiting = session.enqueue_prompt(serde_json::json!("second")).unwrap();
    let folded = session.enqueue_prompt(serde_json::json!("fold me")).unwrap();
    assert!(matches!(session.pump(), Dispatched::Sent(_)));
    session.steer_prompt(&folded).unwrap();
    session.child.terminate_tree();
    drop(session);

    let reopened = Journal::open(&temp.path, &format!("s-{tag}")).expect("reopen");
    let mut state = crate::replay::State::default();
    for record in reopened.records_after(0).unwrap() {
        crate::replay::reduce(&mut state, &record).unwrap();
    }
    let queued: Vec<String> = state.queued_prompts.iter().map(|q| q.prompt.clone()).collect();
    assert_eq!(queued, vec![waiting], "only the never-dispatched prompt is still queued");
    let records = reopened.records_after(0).unwrap();
    let folds = dispatch_records(&records)
        .into_iter()
        .filter(|(prompt, _)| *prompt == folded)
        .collect::<Vec<_>>();
    assert_eq!(folds, vec![(folded, true)], "one dispatch record, marked steered");
}

/// An empty queue is not an error, and pumping it does not invent work.
#[test]
fn pumping_an_empty_queue_is_idle_not_an_error() {
    let (_temp, session) = uncontrolled_session("queue-empty");
    assert_eq!(session.pump(), Dispatched::Idle);
    assert!(session.queued_prompts().is_empty());
}

/// `SessionSummary::pending_permissions` is how a client with more than
/// one hosted session tells which one needs attention without attaching
/// to each — so an opened request must be listed, and a settled one must
/// not linger and point the user at a request that no longer exists.
#[test]
fn session_summary_lists_opened_permissions() {
    let (_temp, session) = uncontrolled_session("summary-pending-permissions");
    session
        .driver
        .observe(&serde_json::json!({"type": "permission_request", "id": "opened-1"}));
    session.driver.observe(&serde_json::json!({
        "type": "falcon",
        "subtype": "permission",
        "id": "settled-1",
        "state": "settled",
    }));
    let summary = session.summary();
    assert!(
        summary
            .pending_permissions
            .contains(&"opened-1".to_string()),
        "an opened permission must be listed, got {:?}",
        summary.pending_permissions
    );
    assert!(
        !summary
            .pending_permissions
            .contains(&"settled-1".to_string()),
        "a settled permission must not linger, got {:?}",
        summary.pending_permissions
    );
}

/// A live session with no controller, for the lease tests.
pub(crate) fn uncontrolled_session(tag: &str) -> (TempJournalDir, Arc<Session>) {
    let temp = TempJournalDir::new(tag);
    let journal = Journal::open(&temp.path, &format!("s-{tag}")).expect("open journal");
    let registry = Registry::default();
    let reservation = registry.reserve("agent-a", None).expect("reserve");
    let session = new_session(
        &reservation,
        "agent-a",
        r"C:\Work\Example".into(),
        None,
        spawn_test_child(),
        AgentDriver::Claude(ClaudeDriver::default()),
        journal,
    );
    // The journal dir must outlive the session, so it is handed back.
    (temp, session)
}

/// A dispatched turn with no `result` yet is pending work for the orphan
/// sweep, and `turn_finished` releases it. Set directly: `pump` needs a child
/// that takes stdin, and the test child exits at once.
#[test]
fn a_turn_in_flight_is_pending_work_until_it_finishes() {
    let (_temp, session) = uncontrolled_session("pending-in-flight");
    assert!(!session.has_pending_work());
    lock(&session.queue).in_flight.push("p1".into());
    assert!(session.has_pending_work(), "a turn in flight is pending work");
    session.turn_finished();
    assert!(!session.has_pending_work());
}

#[test]
fn semantic_records_cross_the_attach_cut_once_and_in_order() {
    let (_temp, session) = uncontrolled_session("semantic-cut");
    let prompt = session
        .enqueue_prompt(serde_json::json!("survive detach"))
        .unwrap();
    let delivered = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&delivered);
    let (token, through) = session.attach(Arc::new(move |event| {
        sink.lock().unwrap().push(event);
    }));
    session.retract_prompt(&prompt).unwrap();
    let (history, more) = session.hydrate_from(0, through, 100, 1024 * 1024).unwrap();
    assert!(!more);
    assert!(history.iter().any(|record| matches!(&record.body,
        Body::PromptQueued { prompt: id, .. } if id == &prompt)));
    assert!(!history
        .iter()
        .any(|record| matches!(&record.body, Body::PromptRetracted { .. })));
    let events = delivered.lock().unwrap();
    assert_eq!(events.len(), 1, "only the post-cut retraction is live");
    assert!(matches!(&events[0].body, EventBody::Record { body }
        if body["record"] == "prompt-retracted" && body["prompt"] == prompt));
    drop(events);
    session.detach(token);
    session.child.terminate_tree();
}

/// Regression: a record larger than the page's byte budget (but within the
/// journal's cap) failed hydrate as TooLarge on every retry, so that session
/// could never rehydrate. It now rides alone on its own page, and paging
/// still makes progress and terminates.
#[test]
fn a_record_over_the_page_budget_hydrates_alone_on_its_page() {
    let (_temp, session) = uncontrolled_session("hydrate-over-budget");
    let big = "x".repeat(64 * 1024);
    for text in ["before".to_string(), big.clone(), "after".to_string()] {
        session
            .publish_durable(EventBody::Diagnostic { text })
            .expect("publish");
    }
    let through = session.journal_cursor.load(Ordering::SeqCst);
    let is_big = |record: &Record| {
        matches!(&record.body, Body::Event { body: EventBody::Diagnostic { text } } if text.len() == big.len())
    };

    let budget = 16 * 1024;
    let mut after = 0u64;
    let mut seen = Vec::new();
    for _ in 0..64 {
        let (records, more) = session
            .hydrate_from(after, through, 256, budget)
            .expect("a record over the budget must not fail the page");
        if records.iter().any(|record| is_big(record)) {
            assert_eq!(records.len(), 1, "the over-budget record rides alone");
        }
        assert!(!records.is_empty() || !more, "a page with more to come made no progress");
        if let Some(last) = records.last() {
            after = last.seq;
        }
        seen.extend(records);
        if !more {
            break;
        }
    }
    assert_eq!(after, through, "paging reached the end");
    assert_eq!(seen.iter().filter(|record| is_big(record)).count(), 1);
    session.child.terminate_tree();
}

/// Regression: a journal written before 847b995 can hold a record over
/// `LONE_RECORD_CAP` (but within `MAX_RECORD`). Hydrate failed on it every
/// time, so that session could never rehydrate. It now pages an `Overflow`
/// in its place at the same seq and carries on past it.
#[test]
fn a_legacy_record_over_the_frame_cap_hydrates_as_an_overflow() {
    use crate::journal::{LONE_RECORD_CAP, MAX_RECORD};
    let (_temp, session) = uncontrolled_session("hydrate-legacy-oversize");
    session
        .publish_durable(EventBody::Diagnostic { text: "before".into() })
        .expect("publish");
    let legacy_seq = lock(&session.journal)
        .append_legacy(
            session.generation,
            Body::Event {
                body: EventBody::Diagnostic {
                    text: "x".repeat(LONE_RECORD_CAP + 1),
                },
            },
        )
        .expect("the old cap accepted it");
    session
        .publish_durable(EventBody::Diagnostic { text: "after".into() })
        .expect("publish");
    let through = session.journal_cursor.load(Ordering::SeqCst);
    assert_eq!(through, legacy_seq + 1);

    let mut after = 0u64;
    let mut seen = Vec::new();
    for _ in 0..16 {
        let (records, more) = session
            .hydrate_from(after, through, 256, 1024 * 1024)
            .expect("a legacy oversized record must not fail hydrate");
        if let Some(last) = records.last() {
            after = last.seq;
        }
        seen.extend(records);
        if !more {
            break;
        }
    }
    let seqs: Vec<u64> = seen.iter().map(|record| record.seq).collect();
    assert_eq!(seqs, vec![legacy_seq - 1, legacy_seq, legacy_seq + 1]);
    assert!(
        matches!(&seen[1].body, Body::Event { body: EventBody::Overflow { bytes } }
            if (*bytes as usize) > LONE_RECORD_CAP && (*bytes as usize) <= MAX_RECORD),
        "the oversized record is replaced by an Overflow: {:?}",
        seen[1].body
    );
    assert_eq!(seen[1].generation, session.generation);
    assert!(matches!(&seen[2].body, Body::Event { body: EventBody::Diagnostic { text } } if text == "after"));
    session.child.terminate_tree();
}

/// Regression: a legacy oversized `PromptQueued` hydrated as an `Overflow`, so the
/// `PromptDispatched` after it named a prompt the client never saw. It now stays a
/// `PromptQueued` with a marker for its content.
#[test]
fn a_legacy_oversized_queued_prompt_hydrates_as_a_marked_queued_prompt() {
    use crate::journal::LONE_RECORD_CAP;
    let (_temp, session) = uncontrolled_session("hydrate-legacy-prompt");
    let seq = lock(&session.journal)
        .append_legacy(
            session.generation,
            Body::PromptQueued {
                prompt: "p1".into(),
                content: serde_json::json!("x".repeat(LONE_RECORD_CAP + 1)),
            },
        )
        .expect("the old cap accepted it");
    let (records, _) = session
        .hydrate_from(0, seq, 256, 1024 * 1024)
        .expect("hydrate");
    let last = records.last().expect("a record");
    match &last.body {
        Body::PromptQueued { prompt, content } => {
            assert_eq!(prompt, "p1");
            let text = content.as_str().expect("a marker string");
            assert!(text.starts_with("[A ") && text.ends_with(" MiB prompt is too large to replay]"), "{text}");
        }
        other => panic!("the queued prompt must survive as a queued prompt: {other:?}"),
    }
    session.child.terminate_tree();
}

/// The exited-session sweep reads `attached()` and `controller_holder()`
/// without the registry lock, then releases. An attach landing between those
/// reads and the release must keep the session listed: the release re-checks
/// under the registry lock, and the attach takes that same lock.
#[test]
fn an_attach_between_the_sweep_check_and_release_keeps_the_session_listed() {
    let temp = TempJournalDir::new("release-race");
    let journal = Journal::open(&temp.path, "s-release-race").expect("open journal");
    let registry = Registry::default();
    let reservation = registry.reserve("agent-a", None).expect("reserve");
    let session = new_session(
        &reservation,
        "agent-a",
        temp.path.display().to_string().into(),
        None,
        spawn_test_child(),
        AgentDriver::Claude(ClaudeDriver::default()),
        journal,
    );
    let id = session.id.clone();
    reservation.commit(Arc::clone(&session));
    session.mark_exited(Some(0));

    // The sweep's unlocked check: a release candidate.
    assert_eq!(session.attached(), 0);
    assert!(session.controller_holder().is_none());

    // A client attaches in the gap.
    let (_found, token, _through) = registry
        .attach(&id, Arc::new(|_event: Event| {}))
        .expect("still registered");

    assert_eq!(registry.release_if_unattended(&id), Ok(false));
    assert!(
        registry.get(&id).is_some(),
        "an attached session must stay listed"
    );

    // Once nothing is attached, the same call releases it, and a later attach
    // finds nothing rather than an unlisted session.
    session.detach(token);
    assert_eq!(registry.release_if_unattended(&id), Ok(true));
    assert!(registry.get(&id).is_none());
    assert!(registry.attach(&id, Arc::new(|_event: Event| {})).is_none());
    session.child.terminate_tree();
}

/// A live (never marked exited) session committed into `registry`, for the
/// idle-stop tests here and in `serve/idle.rs`. The journal dir is handed back
/// because it must outlive the session.
pub(crate) fn live_session(tag: &str, registry: &Registry) -> (TempJournalDir, Arc<Session>) {
    let temp = TempJournalDir::new(tag);
    let journal = Journal::open(&temp.path, &format!("s-{tag}")).expect("open journal");
    let reservation = registry.reserve("agent-a", None).expect("reserve");
    let session = new_session(
        &reservation,
        "agent-a",
        temp.path.display().to_string().into(),
        None,
        spawn_test_child(),
        AgentDriver::Claude(ClaudeDriver::default()),
        journal,
    );
    reservation.commit(Arc::clone(&session));
    (temp, session)
}

/// Once the stop is reserved, attach and control acquisition are refused
/// (as "no such session" at the protocol layer), and a second reservation
/// does not end the session twice. Eligibility itself is the sweep's
/// predicate, tested with the real ones in `serve/idle.rs`; here it is fixed.
#[test]
fn a_reserved_idle_stop_refuses_attach_and_acquire() {
    let registry = Registry::default();
    let (_temp, session) = live_session("idle-stop-refuse", &registry);
    let id = session.id.clone();
    let idle = |_: &Session| true;

    assert!(registry.reserve_idle_stop(&session, idle));
    assert!(session.stopping());
    assert!(registry.attach(&id, Arc::new(|_event: Event| {})).is_none());
    assert!(registry
        .acquire_control(&id, 1, "vidar", token("late"))
        .is_none());
    assert_eq!(session.attached(), 0);
    assert!(session.controller_holder().is_none());
    assert!(!registry.reserve_idle_stop(&session, idle));
    session.child.terminate_tree();
}

/// Regression: `Registry::acquire_control` appended its `ControllerChanged`
/// record while holding the registry lock, so one slow journal write stalled
/// `get`/`list`/`attach` for every client. The append now runs after the
/// registry lock is released, and the sweep's re-check still sees the lease.
#[test]
fn a_slow_lease_record_does_not_stall_the_registry() {
    use std::sync::mpsc;
    use std::time::Duration;

    let temp = TempJournalDir::new("lease-registry-stall");
    let journal = Journal::open(&temp.path, "s-lease-registry-stall").expect("open journal");
    let registry = Registry::default();
    let reservation = registry.reserve("agent-a", None).expect("reserve");
    let session = new_session(
        &reservation,
        "agent-a",
        temp.path.display().to_string().into(),
        None,
        spawn_test_child(),
        AgentDriver::Claude(ClaudeDriver::default()),
        journal,
    );
    let id = session.id.clone();
    reservation.commit(Arc::clone(&session));
    session.mark_exited(Some(0));

    // A journal write that does not finish until the test lets it.
    let stalled_journal = lock(&session.journal);
    std::thread::scope(|scope| {
        let acquirer = scope.spawn(|| registry.acquire_control(&id, 1, "vidar", token("slow")));

        // The lease lands in memory before the write; wait for it.
        let mut waited = 0;
        while session.controller_holder().is_none() {
            assert!(waited < 500, "the lease was never taken");
            std::thread::sleep(Duration::from_millis(10));
            waited += 1;
        }

        // With the append blocked, the registry lock and the lease lock must
        // both be free: a lookup answers, and a second client's acquire is
        // refused by name rather than queued behind the write. (`list` and
        // the sweep also read `attached()`, which shares the subscribers lock
        // every journal append takes; that is not the registry lock.)
        let (sender, receiver) = mpsc::channel();
        let registry = &registry;
        let id = &id;
        scope.spawn(move || {
            let found = registry.get(id).map(|found| found.controller_holder());
            let rival = registry.acquire_control(id, 2, "falcon", token("rival"));
            sender.send((found, rival)).ok();
        });
        let (found, rival) = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("the registry stalled behind a lease record write");
        assert_eq!(found, Some(Some("vidar".to_string())));
        assert!(
            matches!(&rival, Some(Err(why)) if why.contains("already controlled")),
            "{rival:?}"
        );

        drop(stalled_journal);
        let lease = acquirer
            .join()
            .expect("acquirer")
            .expect("registered")
            .expect("lease");
        assert_eq!(lease.revision, 1);
    });
    assert_eq!(
        registry.release_if_unattended(&id),
        Ok(false),
        "the sweep must see the lease"
    );
    assert_eq!(registry.list().len(), 1);

    let through = session.journal_cursor.load(Ordering::SeqCst);
    let (history, _) = session.hydrate_from(0, through, 100, 1024 * 1024).unwrap();
    assert!(
        history.iter().any(|record| matches!(&record.body,
            Body::ControllerChanged { revision: 1, holder: Some(holder) } if holder == "vidar")),
        "the lease record is journalled once the write is let through: {history:?}"
    );
    session.child.terminate_tree();
}

/// The relaunch race: the old connection's release is mid-append (holding the
/// lease order lock) while the new connection acquires through the registry.
/// The acquire used to wait on that order lock while holding the registry
/// lock, so `get` stalled behind the release's disk write.
#[test]
fn an_acquire_behind_a_slow_release_does_not_stall_the_registry() {
    use std::sync::mpsc;
    use std::time::Duration;

    let temp = TempJournalDir::new("lease-release-stall");
    let journal = Journal::open(&temp.path, "s-lease-release-stall").expect("open journal");
    let registry = Registry::default();
    let reservation = registry.reserve("agent-a", None).expect("reserve");
    let session = new_session(
        &reservation,
        "agent-a",
        temp.path.display().to_string().into(),
        None,
        spawn_test_child(),
        AgentDriver::Claude(ClaudeDriver::default()),
        journal,
    );
    let id = session.id.clone();
    reservation.commit(Arc::clone(&session));
    session.acquire_control(1, "old", token("old")).expect("lease");

    let stalled_journal = lock(&session.journal);
    std::thread::scope(|scope| {
        let releaser = scope.spawn(|| session.release_control_for(1));
        let mut waited = 0;
        while session.controller_holder().is_some() {
            assert!(waited < 500, "the release never landed in memory");
            std::thread::sleep(Duration::from_millis(10));
            waited += 1;
        }
        let acquirer = scope.spawn(|| registry.acquire_control(&id, 2, "new", token("new")));
        // Let the acquire reach the order lock the stalled release holds.
        std::thread::sleep(Duration::from_millis(100));

        let (sender, receiver) = mpsc::channel();
        let (registry, id) = (&registry, &id);
        scope.spawn(move || {
            sender.send(registry.get(id).is_some()).ok();
        });
        let found = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("the registry stalled behind a release's lease record");
        assert!(found);

        drop(stalled_journal);
        assert_eq!(releaser.join().expect("releaser"), Some(2));
        let lease = acquirer
            .join()
            .expect("acquirer")
            .expect("registered")
            .expect("lease");
        assert_eq!(lease.revision, 3);
    });
    session.child.terminate_tree();
}

/// Lease changes append in revision order even though `controller` is no
/// longer held across the write: a release racing an acquire's deferred
/// record waits on the order lock instead of appending first.
#[test]
fn lease_records_append_in_revision_order() {
    use std::sync::mpsc;
    use std::time::Duration;

    let (_temp, session) = uncontrolled_session("lease-order");
    std::thread::scope(|scope| {
        let (lease, record) = session
            .lease_control(session.lease_order(), 1, "vidar", token("t"))
            .expect("acquire");
        let record = record.expect("a fresh acquire leaves a record");
        let (sender, receiver) = mpsc::channel();
        let session = &session;
        scope.spawn(move || {
            sender.send(session.release_control(&lease)).ok();
        });
        assert!(
            matches!(
                receiver.recv_timeout(Duration::from_millis(200)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ),
            "the release must wait for the acquire's record"
        );
        record.write();
        let released = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("the release never ran once the record was written");
        assert_eq!(released, Ok(2));
    });
    let through = session.journal_cursor.load(Ordering::SeqCst);
    let (history, _) = session.hydrate_from(0, through, 1000, 1024 * 1024).unwrap();
    let revisions: Vec<u64> = history
        .iter()
        .filter_map(|record| match &record.body {
            Body::ControllerChanged { revision, .. } => Some(*revision),
            _ => None,
        })
        .collect();
    assert_eq!(revisions, vec![1, 2]);
    session.child.terminate_tree();
}

fn token(text: &str) -> String {
    text.to_string()
}

/// A session nobody has claimed refuses mutations by name, rather than
/// letting the first caller through by default.
#[test]
fn an_unclaimed_session_refuses_a_mutation_as_vacant() {
    let (_temp, session) = uncontrolled_session("lease-vacant");
    let refusal = session
        .check_control(&Lease {
            token: token("anything"),
            revision: 1,
        })
        .expect_err("an unclaimed session must not accept a mutation");
    assert_eq!(refusal, LeaseRefusal::Vacant);
    assert_eq!(
        session.controller_revision(),
        0,
        "nothing has changed hands"
    );
    assert_eq!(session.controller_holder(), None);
}

/// The claim the doc makes: acquire NEVER steals. Taking control from a
/// live holder is the slice-4 transfer, which fences the source at a
/// journal barrier first; a bare steal here would leave two UIs both
/// believing they drive this session.
#[test]
fn acquiring_control_never_steals_from_a_live_holder() {
    let (_temp, session) = uncontrolled_session("lease-nosteal");
    let held = session
        .acquire_control(1, "vidar", token("first"))
        .expect("a free session can be claimed");

    let refused = session
        .acquire_control(2, "falcon", token("second"))
        .expect_err("a second connection must not take a live lease");
    assert!(
        refused.contains("vidar"),
        "the refusal must name who holds it, got {refused}"
    );

    // The original lease is untouched: still valid, still the same numbers.
    session
        .check_control(&held)
        .expect("the incumbent keeps driving");
    assert_eq!(session.controller_holder().as_deref(), Some("vidar"));
}

/// A retry after a lost reply must not invalidate the lease the client is
/// already using — that would turn a dropped response into a broken
/// session. Re-acquiring from the same connection returns the SAME lease.
#[test]
fn re_acquiring_from_the_same_connection_returns_the_same_lease() {
    let (_temp, session) = uncontrolled_session("lease-retry");
    let first = session
        .acquire_control(9, "vidar", token("issued-once"))
        .expect("claim");
    let again = session
        .acquire_control(9, "vidar", token("a-different-token"))
        .expect("a retry from the same connection must succeed");

    assert_eq!(first, again, "a retry must not issue a new lease");
    assert_eq!(
        session.controller_revision(),
        first.revision,
        "an idempotent retry must not advance the revision"
    );
    session.check_control(&first).expect("still valid");
}

/// `Stale` and `Mismatch` are deliberately different answers: a stale
/// holder should re-acquire and retry, a mismatched one must not. This is
/// the shape a client that cached an older revision produces, and the
/// shape a slice-4 transfer will produce.
#[test]
fn a_lease_must_match_on_both_its_token_and_its_revision() {
    let (_temp, session) = uncontrolled_session("lease-stale");
    let held = session
        .acquire_control(1, "vidar", token("correct"))
        .expect("claim");

    // Both halves are checked. Note this is the ONLY way to construct a
    // wrong-revision lease: the server never issues one, which is exactly
    // why the old `Stale` refusal was unreachable in production and why
    // this test must not be read as proving a client could ever see it.
    let wrong_revision = Lease {
        token: held.token.clone(),
        revision: held.revision - 1,
    };
    assert_eq!(
        session
            .check_control(&wrong_revision)
            .expect_err("a revision this server never issued must be refused"),
        LeaseRefusal::Mismatch
    );

    let forged = Lease {
        token: token("forged"),
        revision: held.revision,
    };
    assert_eq!(
        session
            .check_control(&forged)
            .expect_err("a forged token must be refused"),
        LeaseRefusal::Mismatch
    );
}

/// A client that crashes mid-turn must not leave a session nobody can
/// drive and nobody can take over — that is unrecoverable without
/// restarting the host. The lease dies with its connection.
#[test]
fn a_lease_dies_with_the_connection_that_acquired_it() {
    let (_temp, session) = uncontrolled_session("lease-connection");
    let held = session
        .acquire_control(42, "vidar", token("doomed"))
        .expect("claim");

    assert_eq!(
        session.release_control_for(7),
        None,
        "an unrelated connection going away must not free someone else's lease"
    );
    session.check_control(&held).expect("still held");

    let freed = session
        .release_control_for(42)
        .expect("the holder's own connection frees it");
    assert!(freed > held.revision, "freeing it advances the revision");
    assert_eq!(session.controller_holder(), None);
    // Vidar's startup re-adopt reads this after a swap drops its connection.
    assert_eq!(session.summary().last_holder.as_deref(), Some("vidar"));

    // And the session is genuinely claimable again, by anyone.
    session
        .acquire_control(43, "falcon", token("next"))
        .expect("a freed session can be claimed by another connection");
    assert_eq!(session.summary().last_holder.as_deref(), Some("falcon"));
}

/// Every lease change advances the revision — acquire AND release alike.
/// That monotonicity is what lets a superseded holder be refused with a
/// specific reason, and it is the fence a transfer commits against.
#[test]
fn every_lease_change_advances_the_revision() {
    let (_temp, session) = uncontrolled_session("lease-revision");
    assert_eq!(session.controller_revision(), 0);

    let first = session.acquire_control(1, "a", token("t1")).expect("claim");
    assert_eq!(first.revision, 1);
    let released = session.release_control(&first).expect("release");
    assert_eq!(
        released, 2,
        "a release advances it too, not just an acquire"
    );
    let second = session
        .acquire_control(2, "b", token("t2"))
        .expect("reclaim");
    assert_eq!(second.revision, 3);
    assert!(
        session.check_control(&first).is_err(),
        "the old lease must not work after the session changed hands"
    );
}

/// Releasing with someone else's lease is refused, and leaves the real
/// holder driving.
#[test]
fn releasing_with_another_clients_lease_is_refused() {
    let (_temp, session) = uncontrolled_session("lease-release-other");
    let held = session
        .acquire_control(1, "vidar", token("mine"))
        .expect("claim");

    let refusal = session
        .release_control(&Lease {
            token: token("theirs"),
            revision: held.revision,
        })
        .expect_err("another client's lease must not release this one");
    assert_eq!(refusal, LeaseRefusal::Mismatch);

    session
        .check_control(&held)
        .expect("the real holder still drives");
    assert_eq!(session.controller_holder().as_deref(), Some("vidar"));
}

/// Pins the hazard the doc comments above now describe: `through` (a
/// journal position) and `Event::seq` (a dense event count) are different
/// number lines, so a consumer must not compare them. This builds the
/// exact sequence that produces the collision — a silent record, then an
/// attach, then the first live event — and asserts the actual numbers
/// rather than a boolean, so the test documents the collision instead of
/// merely asserting that "something" holds.
#[test]
fn an_attach_cut_is_not_comparable_to_an_event_sequence() {
    let temp = TempJournalDir::new("attach-cut");
    let mut journal = Journal::open(&temp.path, "s-attach-cut").expect("open journal");
    // A silent record: journalled (so the cursor moves) but never
    // broadcast (so the event sequence does not). Real sessions always
    // open with exactly this kind of record.
    journal
        .append(1, started_record())
        .expect("append the opening Started record");

    let registry = Registry::default();
    let reservation = registry.reserve("agent-a", None).expect("reserve");
    let child = spawn_test_child();
    let session = new_session(
        &reservation,
        "agent-a",
        r"C:\Work\Example".into(),
        None,
        child,
        AgentDriver::Claude(ClaudeDriver::default()),
        journal,
    );

    // The Started record is the only thing ever appended so far, so the
    // journal cursor — and therefore the attach cut — sits at journal
    // position 1, while no event has ever been published.
    let delivered_seq: Arc<Mutex<Option<u64>>> = Arc::new(Mutex::new(None));
    let recorder = Arc::clone(&delivered_seq);
    let (_token, through) = session.attach(Arc::new(move |event: Event| {
        *recorder.lock().unwrap() = Some(event.seq);
    }));
    assert_eq!(
        through, 1,
        "through is the journal position of the Started record, not an event count"
    );

    // The first event this session ever publishes gets seq 1 on the event
    // number line, delivered live to the subscriber attach just installed.
    session
        .publish_durable(EventBody::Diagnostic {
            text: "first live event".into(),
        })
        .expect("publish the first event");
    let delivered_seq = delivered_seq.lock().unwrap().expect("event delivered live");
    assert_eq!(
        delivered_seq, 1,
        "seq of the first event delivered strictly after attach"
    );

    // The hazard, pinned as numbers: `through` (1) is not less than the
    // `seq` of an event delivered strictly after the attach that returned
    // it (1). A consumer that filtered live events with `seq > through`
    // would compute `1 > 1 == false` and silently drop this event, even
    // though it arrived live and was never part of any hydration range.
    assert!(
        delivered_seq <= through,
        "the hazard did not reproduce: delivered seq {delivered_seq} > through {through}"
    );
}
