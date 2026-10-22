//! Hosted Codex turns over the session's one prompt queue: `turn/start` per
//! dispatched prompt, the turn id bound from its response or `turn/started`,
//! `turn/completed` matched to that id, and `turn/steer` into the bound turn.
//!
//! The queue is the session's (`session/dispatch.rs`); this file only decides
//! what a prompt's line is and which child line ends the turn the queue is
//! waiting on. Codex's own `thread/queue/*` is not used: a second queue would
//! make retraction and replay disagree about what is waiting.

use crate::journal::CodexRecord;
use crate::protocol::Outcome;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};

/// Completions seen while the running turn had no id yet. A `turn/start`
/// response may arrive after its own `turn/completed` (a very short turn), and
/// that turn must still release the queue. Only the latest few can be it.
const UNBOUND_COMPLETIONS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Start,
    Steer,
}

#[derive(Debug)]
struct Request {
    prompt: String,
    kind: Kind,
    /// For a steer, the `turn/start` request id of the turn it folds into.
    turn_start: Option<u64>,
    /// A steer whose turn ended before Codex answered it: still refusable
    /// (Codex refuses a steer for an ended turn), released as unanswered at
    /// the next turn end or when the child closes (`end_running`).
    orphaned: bool,
}

/// The turn the queue is waiting on: started by `prompt` with request `start`,
/// bound to `turn` once Codex names it.
#[derive(Debug)]
struct Running {
    prompt: String,
    start: u64,
    turn: Option<String>,
}

#[derive(Default)]
pub(super) struct Turns {
    /// `turn/start` and `turn/steer` requests awaiting their response.
    requests: HashMap<u64, Request>,
    running: Option<Running>,
    unbound_completions: VecDeque<String>,
    /// The policy each armed `turn/start` carried, journaled only once the
    /// write is known to have (possibly) landed.
    policies: HashMap<String, CodexRecord>,
    /// Facts for the journal, drained by the stdout reader after each line.
    records: Vec<CodexRecord>,
    /// Prompts whose `turn/steer` Codex refused, for the session to put back
    /// in its queue; drained with the records.
    refused_steers: Vec<String>,
    /// Prompts whose orphaned `turn/steer` was still unanswered at the next
    /// turn end or the child's close: released, for the session to journal
    /// as undelivered; drained with the records.
    unanswered_steers: Vec<String>,
    /// The one `turn/interrupt` sent for a turn (`interrupt.rs`): a second
    /// Stop for the same turn joins it rather than writing another.
    stop: Option<Stop>,
    /// Why the child stopped answering, once it has: wakes every waiter.
    closed: Option<String>,
}

/// A command's outcome as the client hears it.
pub(super) type Settled = (Outcome, Option<String>);

/// The interrupt sent for the turn begun by request `start`, under command
/// id `cid`; `outcome` once Codex answered or the write settled it.
#[derive(Debug)]
struct Stop {
    start: u64,
    cid: u64,
    outcome: Option<Settled>,
}

/// What an interrupt can do about the turn that was running when it came.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Target {
    /// Codex has named it: interrupt this turn id.
    Bound(String),
    /// Still unnamed: wait for its response or `turn/started`.
    Unbound,
    /// It ended (completed or refused) before Codex named it.
    Gone,
}

/// Longest skill name and path, in bytes, a prompt may carry.
const SKILL_NAME_MAX: usize = 128;
const SKILL_PATH_MAX: usize = 4096;

/// One `skill` block rebuilt as `{type,name,path}`. Shape only: no catalog or
/// `SKILL.md` check, Codex decides whether the skill exists.
fn skill_item(block: &Value) -> Result<Value, String> {
    let field = |key: &str| block.get(key).and_then(Value::as_str).unwrap_or("");
    let (name, path) = (field("name"), field("path"));
    if name.is_empty()
        || name.len() > SKILL_NAME_MAX
        || name.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("a skill block has an invalid name".into());
    }
    let absolute = std::path::Path::new(path).is_absolute()
        || path.starts_with('/')
        || path.starts_with("\\\\");
    if path.len() > SKILL_PATH_MAX || !absolute || path.chars().any(char::is_control) {
        return Err("a skill block has an invalid path".into());
    }
    Ok(json!({ "type": "skill", "name": name, "path": path }))
}

/// A prompt's content as Codex `UserInput` items: a string, or Claude-shaped
/// `text` blocks plus at most one `skill` block (which needs a text block
/// beside it). Anything else is refused rather than dropped, so a prompt is
/// never sent with part of it missing.
pub(super) fn input(content: &Value) -> Result<Vec<Value>, String> {
    let text = |text: &str| json!({ "type": "text", "text": text });
    match content {
        Value::String(body) => Ok(vec![text(body)]),
        Value::Array(blocks) if !blocks.is_empty() => {
            let items = blocks
                .iter()
                .map(|block| match block.get("type").and_then(Value::as_str) {
                    Some("text") => block
                        .get("text")
                        .and_then(Value::as_str)
                        .map(text)
                        .ok_or_else(|| "a text block has no text".to_string()),
                    Some("skill") => skill_item(block),
                    other => Err(format!(
                        "unsupported: hosted Codex takes text and skill prompts only (got a {} block)",
                        other.unwrap_or("untyped")
                    )),
                })
                .collect::<Result<Vec<_>, _>>()?;
            let skills = items.iter().filter(|i| i["type"] == "skill").count();
            if skills > 1 {
                return Err("a prompt takes at most one skill block".into());
            }
            if skills == items.len() {
                return Err("a skill block needs a text block beside it".into());
            }
            Ok(items)
        }
        _ => Err("unsupported: hosted Codex takes text prompts only".into()),
    }
}

/// The `turn/start` line: the thread, the input, the mode's turn policy and
/// the pinned model if any (the same params the in-process adapter sends).
pub(super) fn start_line(
    id: u64,
    thread: &str,
    input: Vec<Value>,
    policy: Map<String, Value>,
    model: Option<&str>,
) -> Value {
    let mut params = Map::new();
    params.insert("threadId".into(), Value::String(thread.into()));
    params.insert("input".into(), Value::Array(input));
    params.extend(policy);
    if let Some(model) = model.filter(|model| !model.is_empty()) {
        params.insert("model".into(), Value::String(model.into()));
    }
    json!({ "jsonrpc": "2.0", "method": "turn/start", "id": id, "params": params })
}

/// The `turn/steer` line into the bound turn. `expectedTurnId` makes Codex
/// refuse it if that turn has already ended, instead of starting a new one.
pub(super) fn steer_line(id: u64, thread: &str, turn: &str, input: Vec<Value>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "turn/steer",
        "id": id,
        "params": { "threadId": thread, "expectedTurnId": turn, "input": input }
    })
}

/// The `turn/interrupt` line for the bound turn (the params the in-process
/// adapter sends).
pub(super) fn interrupt_line(id: u64, thread: &str, turn: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "turn/interrupt",
        "id": id,
        "params": { "threadId": thread, "turnId": turn }
    })
}

/// A JSON-RPC error's message, or the whole error when it has none.
fn reason(error: &Value) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| error.to_string())
}

impl Turns {
    pub fn is_start_response(&self, message: &Value) -> bool {
        message
            .get("id")
            .and_then(Value::as_u64)
            .and_then(|id| self.requests.get(&id))
            .is_some_and(|request| request.kind == Kind::Start)
    }
    /// Arm before the write: stdout can answer during it.
    pub fn arm_start(&mut self, id: u64, prompt: &str, policy: CodexRecord) {
        self.requests.insert(
            id,
            Request {
                prompt: prompt.into(),
                kind: Kind::Start,
                turn_start: None,
                orphaned: false,
            },
        );
        self.running = Some(Running {
            prompt: prompt.into(),
            start: id,
            turn: None,
        });
        self.policies.insert(prompt.into(), policy);
    }

    /// The bound turn a steer folds into. `Err` while the running turn has no
    /// id yet: the steer is refused and the prompt stays queued, so the turn
    /// end pumps it as an ordinary prompt.
    pub fn steer_target(&self) -> Result<String, String> {
        match &self.running {
            Some(Running {
                turn: Some(turn), ..
            }) => Ok(turn.clone()),
            Some(_) => Err("the running Codex turn has no id yet; the prompt stays queued".into()),
            None => Err("no Codex turn is running to steer into".into()),
        }
    }

    pub fn arm_steer(&mut self, id: u64, prompt: &str) {
        self.requests.insert(
            id,
            Request {
                prompt: prompt.into(),
                kind: Kind::Steer,
                turn_start: self.running_start(),
                orphaned: false,
            },
        );
    }

    /// Whether `prompt`'s armed steer still folds into the running turn:
    /// not answered, and that turn has not ended. Checked under the same
    /// lock as the steer's write (`CodexDriver::write_steer`), so the stdout
    /// reader cannot end the turn between the check and the write.
    pub fn steer_live(&self, prompt: &str) -> bool {
        let Some(start) = self.running_start() else {
            return false;
        };
        self.requests.values().any(|request| {
            request.kind == Kind::Steer
                && request.prompt == prompt
                && !request.orphaned
                && request.turn_start == Some(start)
        })
    }

    /// The write's fate for an armed prompt. Delivered (or possibly):
    /// the policy the line carried goes to the journal. Not delivered: the
    /// arming is undone, so no response can ever be matched to it.
    pub fn dispatched(&mut self, prompt: &str, delivered: bool) -> Vec<CodexRecord> {
        let policy = self.policies.remove(prompt);
        if delivered {
            return policy.into_iter().collect();
        }
        self.requests.retain(|_, request| request.prompt != prompt);
        if self
            .running
            .as_ref()
            .is_some_and(|running| running.prompt == prompt && running.turn.is_none())
        {
            self.running = None;
        }
        Vec::new()
    }

    pub fn take_records(&mut self) -> Vec<CodexRecord> {
        std::mem::take(&mut self.records)
    }

    pub fn take_refused_steers(&mut self) -> Vec<String> {
        std::mem::take(&mut self.refused_steers)
    }

    pub fn take_unanswered_steers(&mut self) -> Vec<String> {
        std::mem::take(&mut self.unanswered_steers)
    }

    /// Whether a `turn/steer` for `prompt` still awaits its response.
    pub fn steer_pending(&self, prompt: &str) -> bool {
        self.requests
            .values()
            .any(|request| request.kind == Kind::Steer && request.prompt == prompt)
    }

    /// The `turn/start` request id of the running turn, if one runs.
    pub fn running_start(&self) -> Option<u64> {
        self.running.as_ref().map(|running| running.start)
    }

    /// Where the turn begun by request `start` stands for an interrupt.
    pub fn target(&self, start: u64) -> Target {
        match &self.running {
            Some(running) if running.start == start => match &running.turn {
                Some(turn) => Target::Bound(turn.clone()),
                None => Target::Unbound,
            },
            _ => Target::Gone,
        }
    }

    /// The command id of the interrupt already sent for the turn begun by
    /// `start`, which a second Stop joins: pending, applied or of unknown
    /// delivery. One that definitely failed (refused by Codex, or never
    /// written) joins nothing, so the next Stop can try again.
    pub fn joinable_stop(&self, start: u64) -> Option<u64> {
        self.stop
            .as_ref()
            .filter(|stop| stop.start == start)
            .filter(|stop| !matches!(stop.outcome, Some((Outcome::Failed, _))))
            .map(|stop| stop.cid)
    }

    /// Arm before the write: stdout can answer during it. Replaces the
    /// stop of an earlier turn, or a failed one for this turn.
    pub fn arm_interrupt(&mut self, cid: u64, start: u64) {
        self.stop = Some(Stop {
            start,
            cid,
            outcome: None,
        });
    }

    /// Settle interrupt `cid` from this side (its write's fate, a timeout),
    /// unless Codex's answer already did.
    pub fn settle_interrupt(&mut self, cid: u64, outcome: Settled) {
        if let Some(stop) = self.stop.as_mut().filter(|stop| stop.cid == cid) {
            stop.outcome.get_or_insert(outcome);
        }
    }

    /// Interrupt `cid`'s outcome once settled, for its sender and every Stop
    /// that joined it.
    pub fn interrupt_settled(&self, cid: u64) -> Option<Settled> {
        self.stop
            .as_ref()
            .filter(|stop| stop.cid == cid)
            .and_then(|stop| stop.outcome.clone())
    }

    #[cfg(test)]
    pub fn awaits_interrupt(&self, cid: u64) -> bool {
        self.stop
            .as_ref()
            .is_some_and(|stop| stop.cid == cid && stop.outcome.is_none())
    }

    /// The child is gone; nothing it has not answered yet will be answered.
    /// Orphaned steers are released as unanswered (`take_unanswered_steers`),
    /// and so are the running turn's unanswered steers: that turn dies with
    /// the child and never reaches `end_running`, so without this they would
    /// never be orphaned and their folded prompts would stay forever.
    pub fn close(&mut self, why: &str) {
        self.closed.get_or_insert_with(|| why.to_string());
        if let Some(start) = self.running_start() {
            for request in self.requests.values_mut() {
                if request.kind == Kind::Steer && request.turn_start == Some(start) {
                    request.orphaned = true;
                }
            }
        }
        self.release_orphans();
    }

    pub fn closed(&self) -> Option<&str> {
        self.closed.as_deref()
    }

    /// Fold one child line in; `true` when it ends the turn the queue waits
    /// on. Only that turn's `turn/completed` does, or the refusal of the
    /// `turn/start` that would have begun it (no turn runs, so nothing else
    /// would ever release the queue).
    pub fn step(&mut self, thread: &str, message: &Value) -> bool {
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return self.response(message);
        };
        // A server request (method and id) is not a turn event.
        if message.get("id").is_some() {
            return false;
        }
        // A child thread's turns (subagents) share this connection.
        if message
            .pointer("/params/threadId")
            .and_then(Value::as_str)
            .is_some_and(|other| other != thread)
        {
            return false;
        }
        let Some(turn) = message.pointer("/params/turn/id").and_then(Value::as_str) else {
            return false;
        };
        match method {
            "turn/started" => self.bind(None, turn),
            "turn/completed" => self.complete(turn),
            _ => false,
        }
    }

    fn response(&mut self, message: &Value) -> bool {
        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            return false;
        };
        // An interrupt's answer settles its waiter; the turn ends only by its
        // own `turn/completed` (status `interrupted`).
        if self.stop.as_ref().is_some_and(|stop| stop.cid == id) {
            let settled = match message.get("error") {
                Some(error) => (Outcome::Failed, Some(reason(error))),
                None => (Outcome::Applied, None),
            };
            self.settle_interrupt(id, settled);
            return false;
        }
        let Some(request) = self.requests.remove(&id) else {
            return false;
        };
        if let Some(error) = message.get("error") {
            let reason = reason(error);
            // A refused steer never joined the turn: its prompt goes back to
            // the queue rather than ending with a turn it was never part of.
            if request.kind == Kind::Steer {
                self.refused_steers.push(request.prompt.clone());
            }
            self.records.push(CodexRecord::TurnRefused {
                prompt: request.prompt,
                reason,
            });
            let refused_start = request.kind == Kind::Start
                && self
                    .running
                    .as_ref()
                    .is_some_and(|running| running.start == id);
            if refused_start {
                // Bound already by `turn/started`, the turn may hold steers:
                // the same turn-end handling as a completion.
                self.end_running();
            }
            return refused_start;
        }
        match (
            request.kind,
            message.pointer("/result/turn/id").and_then(Value::as_str),
        ) {
            (Kind::Start, Some(turn)) => self.bind(Some(id), turn),
            _ => false,
        }
    }

    /// Bind the running turn to `turn`, from the start response (`start`
    /// names the request) or from `turn/started` (whichever comes first).
    /// `true` if that turn has already completed.
    fn bind(&mut self, start: Option<u64>, turn: &str) -> bool {
        let Some(running) = self.running.as_mut() else {
            return false;
        };
        if start.is_some_and(|start| start != running.start) || running.turn.is_some() {
            return false;
        }
        running.turn = Some(turn.into());
        self.records.push(CodexRecord::TurnBound {
            prompt: running.prompt.clone(),
            turn: turn.into(),
        });
        let Some(at) = self
            .unbound_completions
            .iter()
            .position(|done| done == turn)
        else {
            return false;
        };
        self.unbound_completions.remove(at);
        self.end_running();
        true
    }

    fn complete(&mut self, turn: &str) -> bool {
        match &self.running {
            Some(running) if running.turn.as_deref() == Some(turn) => {
                self.end_running();
                true
            }
            Some(running) if running.turn.is_none() => {
                if self.unbound_completions.len() == UNBOUND_COMPLETIONS {
                    self.unbound_completions.pop_front();
                }
                self.unbound_completions.push_back(turn.into());
                false
            }
            // An older turn's late completion: the queue waits on this one.
            _ => false,
        }
    }

    /// The running turn ended (completed, or its start refused). A steer into
    /// it that Codex has not answered yet is kept, marked orphaned: Codex
    /// answers a steer for an ended turn with a refusal, which still requeues
    /// it (`refused_steers`), and a late success drops it as applied. Orphans
    /// of an earlier turn still unanswered now are released first, handed to
    /// the session to journal as undelivered and announce (`unanswered_steers`).
    fn end_running(&mut self) {
        let Some(running) = self.running.take() else {
            return;
        };
        self.release_orphans();
        for request in self.requests.values_mut() {
            if request.kind == Kind::Steer && request.turn_start == Some(running.start) {
                request.orphaned = true;
            }
        }
    }

    /// Drop every orphaned steer's request (a later answer matches nothing)
    /// and hand its prompt back, oldest first.
    fn release_orphans(&mut self) {
        let mut released: Vec<(u64, String)> = Vec::new();
        self.requests.retain(|id, request| {
            if request.orphaned {
                released.push((*id, request.prompt.clone()));
            }
            !request.orphaned
        });
        released.sort_unstable_by_key(|(id, _)| *id);
        self.unanswered_steers
            .extend(released.into_iter().map(|(_, prompt)| prompt));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const THREAD: &str = "thread-1";

    fn policy(prompt: &str) -> CodexRecord {
        CodexRecord::PromptPolicy {
            prompt: prompt.into(),
            mode: "default".into(),
            model: None,
            effort: None,
        }
    }

    fn started(turn: &str) -> Value {
        json!({"method": "turn/started", "params": {"threadId": THREAD, "turn": {"id": turn}}})
    }

    fn completed(turn: &str) -> Value {
        json!({"method": "turn/completed", "params": {"threadId": THREAD, "turn": {"id": turn, "status": "completed"}}})
    }

    fn start_ok(id: u64, turn: &str) -> Value {
        json!({"id": id, "result": {"turn": {"id": turn}}})
    }

    #[test]
    fn only_the_bound_turns_completion_ends_it() {
        let mut turns = Turns::default();
        turns.arm_start(2, "p1", policy("p1"));
        assert!(!turns.step(THREAD, &start_ok(2, "t1")));
        assert!(!turns.step(THREAD, &started("t1")), "already bound");
        assert!(!turns.step(THREAD, &completed("t0")), "not the bound turn");
        assert!(
            !turns.step("other", &completed("t1")),
            "another thread's turn"
        );
        assert!(turns.step(THREAD, &completed("t1")));
        assert_eq!(
            turns.take_records(),
            vec![CodexRecord::TurnBound {
                prompt: "p1".into(),
                turn: "t1".into()
            }]
        );
    }

    #[test]
    fn a_late_completion_of_an_older_turn_does_not_release_the_next() {
        let mut turns = Turns::default();
        turns.arm_start(2, "p1", policy("p1"));
        turns.step(THREAD, &start_ok(2, "t1"));
        assert!(turns.step(THREAD, &completed("t1")));
        turns.arm_start(3, "p2", policy("p2"));
        // Before the new turn is bound, and after.
        assert!(!turns.step(THREAD, &completed("t1")));
        assert!(!turns.step(THREAD, &started("t2")));
        assert!(!turns.step(THREAD, &completed("t1")));
        assert!(turns.step(THREAD, &completed("t2")));
    }

    #[test]
    fn turn_started_binds_before_the_response() {
        let mut turns = Turns::default();
        turns.arm_start(2, "p1", policy("p1"));
        assert!(!turns.step(THREAD, &started("t1")));
        assert_eq!(turns.steer_target(), Ok("t1".into()));
        assert!(!turns.step(THREAD, &start_ok(2, "t1")));
        assert!(turns.step(THREAD, &completed("t1")));
        assert_eq!(turns.take_records().len(), 1, "bound once");
    }

    #[test]
    fn a_response_after_its_own_completion_still_releases() {
        let mut turns = Turns::default();
        turns.arm_start(2, "p1", policy("p1"));
        assert!(!turns.step(THREAD, &completed("t1")));
        assert!(turns.step(THREAD, &start_ok(2, "t1")));
    }

    #[test]
    fn a_refused_start_releases_the_queue_and_is_recorded() {
        let mut turns = Turns::default();
        turns.arm_start(2, "p1", policy("p1"));
        let refused = json!({"id": 2, "error": {"code": -32600, "message": "no"}});
        assert!(turns.step(THREAD, &refused));
        assert_eq!(
            turns.take_records(),
            vec![CodexRecord::TurnRefused {
                prompt: "p1".into(),
                reason: "no".into()
            }]
        );
        assert!(!turns.step(THREAD, &refused), "answered once");
    }

    #[test]
    fn a_steer_waits_for_the_turn_id_and_a_refused_steer_ends_nothing() {
        let mut turns = Turns::default();
        assert!(turns.steer_target().is_err(), "no turn");
        turns.arm_start(2, "p1", policy("p1"));
        let early = turns.steer_target().unwrap_err();
        assert!(early.contains("stays queued"), "{early}");
        turns.step(THREAD, &start_ok(2, "t1"));
        assert_eq!(turns.steer_target(), Ok("t1".into()));
        turns.arm_steer(3, "p2");
        turns.take_records();
        assert!(turns.steer_pending("p2"));
        // The turn can end before Codex answers the steer.
        assert!(turns.step(THREAD, &completed("t1")));
        assert!(turns.steer_pending("p2"), "still refusable after the turn ended");
        assert!(turns.take_unanswered_steers().is_empty(), "not released at its own end");
        let refused = json!({"id": 3, "error": {"message": "turn ended"}});
        assert!(!turns.step(THREAD, &refused));
        assert_eq!(
            turns.take_records(),
            vec![CodexRecord::TurnRefused {
                prompt: "p2".into(),
                reason: "turn ended".into()
            }]
        );
        // Handed back for the session to requeue (`session/tests.rs`
        // covers the queue, the journal and replay), exactly once.
        assert_eq!(turns.take_refused_steers(), vec!["p2".to_string()]);
        assert!(!turns.steer_pending("p2"));
        assert!(!turns.step(THREAD, &refused), "answered once");
        assert!(turns.take_refused_steers().is_empty());

        // An accepted steer, and a refused start, hand nothing back.
        turns.arm_start(4, "p3", policy("p3"));
        turns.step(THREAD, &start_ok(4, "t2"));
        turns.arm_steer(5, "p4");
        turns.step(THREAD, &json!({"id": 5, "result": {"turnId": "t2"}}));
        assert!(!turns.steer_pending("p4"));
        turns.arm_start(6, "p5", policy("p5"));
        turns.step(THREAD, &json!({"id": 6, "error": {"message": "no"}}));
        assert!(turns.take_refused_steers().is_empty());
    }

    #[test]
    fn an_orphaned_steer_is_released_at_the_next_turn_end() {
        let mut turns = Turns::default();
        turns.arm_start(2, "p1", policy("p1"));
        turns.step(THREAD, &start_ok(2, "t1"));
        turns.arm_steer(3, "p2");
        assert!(turns.steer_live("p2"));
        assert!(turns.step(THREAD, &completed("t1")));
        assert!(turns.steer_pending("p2"), "orphaned, still refusable");
        assert!(!turns.steer_live("p2"), "its turn is over");
        assert!(turns.take_unanswered_steers().is_empty());

        // The next turn's steer is not the orphan's: only the orphan goes.
        turns.arm_start(4, "p3", policy("p3"));
        turns.step(THREAD, &start_ok(4, "t2"));
        turns.arm_steer(5, "p4");
        assert!(turns.step(THREAD, &completed("t2")));
        assert_eq!(turns.take_unanswered_steers(), vec!["p2".to_string()]);
        assert!(turns.take_unanswered_steers().is_empty(), "handed back once");
        assert!(!turns.steer_pending("p2"));
        assert!(turns.steer_pending("p4"), "orphaned by t2, released later");
        turns.take_records();
        // The released orphan's late answer matches nothing.
        let refused = json!({"id": 3, "error": {"message": "turn ended"}});
        assert!(!turns.step(THREAD, &refused));
        assert!(turns.take_records().is_empty());
        assert!(turns.take_refused_steers().is_empty());

        // The child's close releases what is left.
        turns.close("gone");
        assert_eq!(turns.take_unanswered_steers(), vec!["p4".to_string()]);
    }

    #[test]
    fn an_orphaned_steers_late_success_is_dropped_as_applied() {
        let mut turns = Turns::default();
        turns.arm_start(2, "p1", policy("p1"));
        turns.step(THREAD, &start_ok(2, "t1"));
        turns.arm_steer(3, "p2");
        turns.take_records();
        assert!(turns.step(THREAD, &completed("t1")));
        assert!(!turns.step(THREAD, &json!({"id": 3, "result": {"turnId": "t1"}})));
        assert!(!turns.steer_pending("p2"));
        assert!(turns.take_records().is_empty());
        assert!(turns.take_refused_steers().is_empty());
        turns.arm_start(4, "p3", policy("p3"));
        turns.step(THREAD, &start_ok(4, "t2"));
        assert!(turns.step(THREAD, &completed("t2")));
        assert!(turns.take_unanswered_steers().is_empty(), "nothing to release");
    }

    #[test]
    fn the_close_releases_a_steer_folded_into_the_turn_that_dies_with_it() {
        let mut turns = Turns::default();
        turns.arm_start(2, "p1", policy("p1"));
        turns.step(THREAD, &start_ok(2, "t1"));
        turns.arm_steer(3, "p2");
        // The child dies mid-turn: no `turn/completed`, no steer answer.
        turns.close("gone");
        assert_eq!(turns.take_unanswered_steers(), vec!["p2".to_string()]);
        assert!(!turns.steer_pending("p2"));
    }

    #[test]
    fn a_refused_bound_start_orphans_its_steers() {
        let mut turns = Turns::default();
        turns.arm_start(2, "p1", policy("p1"));
        turns.step(THREAD, &started("t1"));
        turns.arm_steer(3, "p2");
        assert!(turns.step(THREAD, &json!({"id": 2, "error": {"message": "no"}})));
        assert!(!turns.steer_live("p2"));
        assert!(turns.steer_pending("p2"), "orphaned like a completion's");
        turns.arm_start(4, "p3", policy("p3"));
        turns.step(THREAD, &start_ok(4, "t2"));
        assert!(turns.step(THREAD, &completed("t2")));
        assert_eq!(turns.take_unanswered_steers(), vec!["p2".to_string()]);
    }

    #[test]
    fn an_undelivered_start_is_disarmed_and_a_delivered_one_records_its_policy() {
        let mut turns = Turns::default();
        turns.arm_start(2, "p1", policy("p1"));
        assert!(turns.dispatched("p1", false).is_empty());
        assert!(!turns.step(THREAD, &start_ok(2, "t1")), "no longer armed");
        assert!(turns.steer_target().is_err());
        turns.arm_start(3, "p2", policy("p2"));
        assert_eq!(turns.dispatched("p2", true), vec![policy("p2")]);
    }

    #[test]
    fn server_requests_are_not_turn_events() {
        let mut turns = Turns::default();
        turns.arm_start(2, "p1", policy("p1"));
        turns.step(THREAD, &start_ok(2, "t1"));
        let request = json!({"method": "turn/completed", "id": 9, "params": {"threadId": THREAD, "turn": {"id": "t1"}}});
        assert!(!turns.step(THREAD, &request));
    }

    #[test]
    fn input_takes_text_and_refuses_anything_else() {
        assert_eq!(
            input(&json!("hi")).unwrap(),
            vec![json!({"type": "text", "text": "hi"})]
        );
        assert_eq!(
            input(&json!([{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]))
                .unwrap()
                .len(),
            2
        );
        assert!(input(&json!([{"type": "image", "source": {}}]))
            .unwrap_err()
            .contains("text and skill prompts only"));
        assert!(input(&json!([])).is_err());
        assert!(input(&json!({"text": "x"})).is_err());
    }

    #[test]
    fn input_takes_one_skill_beside_text_and_refuses_the_rest() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../../../tests/fixtures/falcon-codex/skill-prompt.json"))
                .unwrap();
        for case in fixture["accept"].as_array().unwrap() {
            assert_eq!(
                Value::Array(input(&case["blocks"]).unwrap()),
                case["input"]
            );
        }
        let refuse = fixture["refuse"].as_array().unwrap();
        assert!(!refuse.is_empty());
        for case in refuse {
            assert!(input(&case["blocks"]).is_err(), "{}", case["why"]);
        }
        let long_name = "n".repeat(SKILL_NAME_MAX + 1);
        let long_path = format!("C:/{}", "p".repeat(SKILL_PATH_MAX));
        for (name, path) in [(long_name.as_str(), "C:/a"), ("a", long_path.as_str())] {
            let content = json!([{"type": "text", "text": "x"}, {"type": "skill", "name": name, "path": path}]);
            assert!(input(&content).is_err());
        }
    }
}
