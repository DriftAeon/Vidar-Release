//! Hosted Codex interrupt: `turn/interrupt` for the turn that was running
//! when the client asked, sent once Codex has named that turn.
//!
//! An interrupt that comes before the turn id (the user pressed Stop right
//! after sending) waits on this request thread for the bind, then goes out
//! exactly once. It never carries over to a later turn: if the turn ends
//! unnamed (a refused `turn/start`, or a turn that completed before its
//! response), there is nothing to interrupt and nothing is written.

use super::{lock, turns, CodexDriver};
use crate::{process::WriteStatus, protocol::Outcome, session::driver_props::COMMAND_TIMEOUT};
use serde_json::Value;
use std::time::Instant;

impl CodexDriver {
    /// Write `turn/interrupt` under command id `cid` and wait for Codex's
    /// answer. One deadline covers the wait for the turn id and the answer.
    pub(super) fn interrupt_with(
        &self,
        cid: u64,
        mut write: impl FnMut(&Value) -> WriteStatus,
    ) -> (Outcome, Option<String>) {
        let thread = match self.thread() {
            Ok(thread) => thread,
            Err(error) => return (Outcome::Failed, Some(error)),
        };
        let deadline = Instant::now() + COMMAND_TIMEOUT;
        let mut turns = lock(&self.turns);
        let Some(start) = turns.running_start() else {
            return (
                Outcome::Failed,
                Some("no Codex turn is running to interrupt".into()),
            );
        };
        let turn = loop {
            if let Some(why) = turns.closed() {
                return (Outcome::Failed, Some(format!("not interrupted: {why}")));
            }
            match turns.target(start) {
                turns::Target::Bound(turn) => break turn,
                turns::Target::Gone => {
                    return (
                        Outcome::Failed,
                        Some(
                            "the Codex turn ended before it was named; nothing to interrupt".into(),
                        ),
                    )
                }
                turns::Target::Unbound => {}
            }
            let now = Instant::now();
            if now >= deadline {
                return (
                    Outcome::Failed,
                    Some(format!(
                        "Codex did not name the running turn within {}s; the interrupt was not sent",
                        COMMAND_TIMEOUT.as_secs()
                    )),
                );
            }
            turns = self.wait_turns(turns, deadline - now);
        };
        // One interrupt per turn: a Stop that finds this turn's interrupt
        // already sent writes nothing and settles with that one's outcome,
        // so two Stops never get conflicting answers about one turn.
        if let Some(lead) = turns.joinable_stop(start) {
            return self.await_interrupt(turns, lead, deadline);
        }
        turns.arm_interrupt(cid, start);
        drop(turns);
        lock(&self.host_replies).insert(cid);

        let unsent = match write(&turns::interrupt_line(cid, &thread, &turn)) {
            WriteStatus::Written => None,
            WriteStatus::NotWritten(why) => {
                lock(&self.host_replies).remove(&cid);
                Some((Outcome::Failed, Some(why)))
            }
            WriteStatus::PossiblyDelivered(why) => Some((Outcome::DeliveryUnknown, Some(why))),
        };
        if let Some(settled) = unsent {
            // Settled for any Stop already joined to this one.
            lock(&self.turns).settle_interrupt(cid, settled.clone());
            self.turns_changed.notify_all();
            return settled;
        }
        self.await_interrupt(lock(&self.turns), cid, deadline)
    }

    /// Wait for interrupt `cid`'s outcome, as its sender or as a Stop joined
    /// to it. A timeout settles it for everyone still waiting on it.
    fn await_interrupt(
        &self,
        mut turns: std::sync::MutexGuard<'_, turns::Turns>,
        cid: u64,
        deadline: Instant,
    ) -> turns::Settled {
        loop {
            if let Some(settled) = turns.interrupt_settled(cid) {
                return settled;
            }
            if let Some(why) = turns.closed().map(str::to_string) {
                return (Outcome::DeliveryUnknown, Some(why));
            }
            let now = Instant::now();
            if now >= deadline {
                let settled = (
                    Outcome::DeliveryUnknown,
                    Some(format!(
                        "no answer to turn/interrupt {cid} within {}s",
                        COMMAND_TIMEOUT.as_secs()
                    )),
                );
                turns.settle_interrupt(cid, settled.clone());
                drop(turns);
                self.turns_changed.notify_all();
                return settled;
            }
            turns = self.wait_turns(turns, deadline - now);
        }
    }

    /// Whether interrupt `cid` is written and waits for Codex's answer.
    #[cfg(test)]
    pub(crate) fn interrupt_awaits_answer(&self, cid: u64) -> bool {
        lock(&self.turns).awaits_interrupt(cid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    const THREAD: &str = "thread-1";

    fn driver() -> Arc<CodexDriver> {
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
        let driver = CodexDriver::new(&params);
        driver.ready_for_test(THREAD);
        Arc::new(driver)
    }

    fn event(method: &str, turn: &str) -> Value {
        json!({"method": method, "params": {"threadId": THREAD, "turn": {"id": turn}}})
    }

    type Wire = Arc<Mutex<Vec<Value>>>;

    /// Run an interrupt on its own thread (the request thread), recording
    /// what it writes.
    fn interrupt(
        driver: &Arc<CodexDriver>,
        cid: u64,
    ) -> (Wire, std::thread::JoinHandle<(Outcome, Option<String>)>) {
        let wire: Wire = Arc::default();
        let (driver, written) = (Arc::clone(driver), Arc::clone(&wire));
        let handle = std::thread::spawn(move || {
            driver.interrupt_with(cid, |line| {
                lock(&written).push(line.clone());
                WriteStatus::Written
            })
        });
        (wire, handle)
    }

    /// Until the interrupt thread is parked waiting for the turn id.
    fn wait_parked(driver: &CodexDriver, waits_before: usize) {
        let until = Instant::now() + Duration::from_secs(5);
        while driver.turn_waits.load(std::sync::atomic::Ordering::SeqCst) <= waits_before {
            assert!(Instant::now() < until, "the interrupt never waited");
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    fn waits(driver: &CodexDriver) -> usize {
        driver.turn_waits.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn wait_for_lines(wire: &Wire, count: usize) {
        let until = Instant::now() + Duration::from_secs(5);
        while lock(wire).len() < count {
            assert!(
                Instant::now() < until,
                "expected {count} line(s), got {:?}",
                lock(wire)
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// The brief's case: Stop before `turn/started` goes out exactly once,
    /// after it, for the named turn; the late start response (a second bind
    /// source) sends nothing more, and Codex's answer settles it `Applied`.
    #[test]
    fn an_interrupt_before_turn_started_goes_out_exactly_once_after_it() {
        let driver = driver();
        let start = driver.prompt_line("p1", &json!("go")).unwrap();
        let start_id = start["id"].as_u64().unwrap();
        let cid = driver.reserve_command();
        let (wire, handle) = interrupt(&driver, cid);

        wait_parked(&driver, 0);
        assert!(
            lock(&wire).is_empty(),
            "nothing goes out before the turn id"
        );
        assert!(!driver.ends_turn(&event("turn/started", "t1")));
        wait_for_lines(&wire, 1);
        assert!(!driver.ends_turn(&json!({"id": start_id, "result": {"turn": {"id": "t1"}}})));
        assert!(matches!(
            driver.observe(&json!({"id": cid, "result": {}})).0,
            crate::session::driver_props::Observed::Consumed
        ));
        assert_eq!(handle.join().unwrap(), (Outcome::Applied, None));
        assert_eq!(
            *lock(&wire),
            vec![json!({
                "jsonrpc": "2.0",
                "method": "turn/interrupt",
                "id": cid,
                "params": {"threadId": THREAD, "turnId": "t1"}
            })]
        );
        assert!(
            driver.ends_turn(&json!({"method": "turn/completed", "params": {"threadId": THREAD, "turn": {"id": "t1", "status": "interrupted"}}})),
            "the interrupted turn ends by its own completion"
        );
    }

    #[test]
    fn an_interrupt_after_the_turn_id_goes_out_at_once() {
        let driver = driver();
        driver.prompt_line("p1", &json!("go")).unwrap();
        driver.ends_turn(&event("turn/started", "t1"));
        let cid = driver.reserve_command();
        let (wire, handle) = interrupt(&driver, cid);
        wait_for_lines(&wire, 1);
        assert_eq!(lock(&wire)[0]["params"]["turnId"], json!("t1"));
        driver.ends_turn(&json!({"id": cid, "error": {"message": "turn already over"}}));
        assert_eq!(
            handle.join().unwrap(),
            (Outcome::Failed, Some("turn already over".into()))
        );
        assert!(
            !driver.ends_turn(&json!({"id": cid, "result": {}})),
            "settled once"
        );
    }

    #[test]
    fn nothing_is_written_with_no_turn_or_a_turn_that_ends_unnamed() {
        let driver = driver();
        let (wire, handle) = interrupt(&driver, 90);
        let (outcome, why) = handle.join().unwrap();
        assert_eq!(outcome, Outcome::Failed);
        assert!(why.unwrap().contains("no Codex turn"));

        // A refused start: the turn the interrupt waited on never ran.
        let start = driver.prompt_line("p1", &json!("go")).unwrap();
        let before = waits(&driver);
        let (_, handle) = interrupt(&driver, 91);
        wait_parked(&driver, before);
        assert!(driver.ends_turn(&json!({"id": start["id"], "error": {"message": "no"}})));
        let (outcome, why) = handle.join().unwrap();
        assert_eq!(outcome, Outcome::Failed);
        assert!(why.unwrap().contains("nothing to interrupt"));

        // The next turn is not the one the interrupt was for.
        driver.prompt_line("p2", &json!("again")).unwrap();
        driver.ends_turn(&event("turn/started", "t2"));
        assert!(lock(&wire).is_empty());
    }

    #[test]
    fn a_child_exit_wakes_a_waiting_interrupt() {
        let driver = driver();
        driver.prompt_line("p1", &json!("go")).unwrap();
        let (wire, handle) = interrupt(&driver, 92);
        wait_parked(&driver, 0);
        driver.abandon("the agent process exited");
        let (outcome, why) = handle.join().unwrap();
        assert_eq!(outcome, Outcome::Failed);
        assert!(why.unwrap().contains("exited"));
        assert!(lock(&wire).is_empty());
    }

    #[test]
    fn an_unwritten_interrupt_is_failed_and_disarmed() {
        let driver = driver();
        driver.prompt_line("p1", &json!("go")).unwrap();
        driver.ends_turn(&event("turn/started", "t1"));
        let settled = driver.interrupt_with(93, |_| WriteStatus::NotWritten("pipe closed".into()));
        assert_eq!(settled, (Outcome::Failed, Some("pipe closed".into())));
        assert!(!driver.interrupt_awaits_answer(93));
        // A failed interrupt joins nothing: the next Stop writes its own.
        let (wire, handle) = interrupt(&driver, 94);
        wait_for_lines(&wire, 1);
        assert_eq!(lock(&wire)[0]["id"], json!(94));
        driver.observe(&json!({"id": 94, "result": {}}));
        assert_eq!(handle.join().unwrap(), (Outcome::Applied, None));
    }

    /// Two Stop requests for one bound turn: one `turn/interrupt` goes out,
    /// and both settle with Codex's one answer. A Stop after it settled
    /// joins the same outcome; the next turn gets its own interrupt.
    #[test]
    fn two_stops_for_one_turn_write_one_interrupt_and_share_its_answer() {
        let driver = driver();
        driver.prompt_line("p1", &json!("go")).unwrap();
        let before = waits(&driver);
        let (first_wire, first) = interrupt(&driver, 95);
        wait_parked(&driver, before);
        let before = waits(&driver);
        let (second_wire, second) = interrupt(&driver, 96);
        wait_parked(&driver, before);
        driver.ends_turn(&event("turn/started", "t1"));
        let until = Instant::now() + Duration::from_secs(5);
        while lock(&first_wire).len() + lock(&second_wire).len() < 1 {
            assert!(Instant::now() < until, "no interrupt went out");
            std::thread::sleep(Duration::from_millis(5));
        }
        std::thread::sleep(Duration::from_millis(50));
        let sent: Vec<Value> = lock(&first_wire)
            .iter()
            .chain(lock(&second_wire).iter())
            .cloned()
            .collect();
        assert_eq!(sent.len(), 1, "one interrupt per turn: {sent:?}");
        let cid = sent[0]["id"].clone();
        assert!(matches!(
            driver.observe(&json!({"id": cid, "result": {}})).0,
            crate::session::driver_props::Observed::Consumed
        ));
        assert_eq!(first.join().unwrap(), (Outcome::Applied, None));
        assert_eq!(second.join().unwrap(), (Outcome::Applied, None));

        // Settled already: a third Stop joins it and writes nothing.
        let third = driver.interrupt_with(97, |_| panic!("a second interrupt for t1"));
        assert_eq!(third, (Outcome::Applied, None));

        // The next turn is a new stop.
        driver.ends_turn(&event("turn/completed", "t1"));
        driver.prompt_line("p2", &json!("again")).unwrap();
        driver.ends_turn(&event("turn/started", "t2"));
        let (wire, handle) = interrupt(&driver, 98);
        wait_for_lines(&wire, 1);
        assert_eq!(lock(&wire)[0]["params"]["turnId"], json!("t2"));
        driver.observe(&json!({"id": 98, "error": {"message": "no"}}));
        assert_eq!(handle.join().unwrap(), (Outcome::Failed, Some("no".into())));
    }
}
