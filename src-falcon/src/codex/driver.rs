//! Host-owned app-server initialization and thread readiness.

use crate::{
    journal::{Body, CodexRecord},
    process::{Child, WriteStatus},
    protocol::{Outcome, SpawnParams},
    session::driver_props::{Observed, PermissionState},
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{Condvar, Mutex, MutexGuard},
    time::{Duration, Instant},
};

mod answers;
mod approvals;
mod history;
pub(crate) use history::Update as HistoryUpdate;
mod interrupt;
mod policy;
mod query;
mod requests;
mod turns;

const READY_TIMEOUT: Duration = Duration::from_secs(30);
const INITIALIZE_ID: u64 = 0;
const THREAD_ID: u64 = 1;
// `observe` consumes ids 0 and 1 as startup responses, so commands start above them.
const FIRST_COMMAND_ID: u64 = THREAD_ID + 1;

#[derive(Debug, Clone)]
enum ReadyState {
    Pending,
    Ready(String),
    Failed(String),
}

struct State {
    ready: ReadyState,
    model: Option<String>,
    started: bool,
    initialized: bool,
    thread_requested: bool,
    deadline: Instant,
}

#[derive(Clone)]
struct PromptPolicy {
    model: Option<String>,
    effort: Option<String>,
    mode: String,
}

pub struct CodexDriver {
    state: Mutex<State>,
    changed: Condvar,
    cwd: String,
    requested_model: Option<String>,
    resume: Option<String>,
    /// The admitted rune payload, sent as `developerInstructions` on every `thread/start`
    /// and `thread/resume` (Codex 0.164.0's resume params accept it).
    developer_instructions: Option<String>,
    permission_mode: String,
    policy: Mutex<PromptPolicy>,
    policy_records: Mutex<Vec<Body>>,
    next_command: std::sync::atomic::AtomicU64,
    /// Request IDs whose answers belong to the host, including timed-out ones.
    host_replies: Mutex<HashSet<u64>>,
    queries: Mutex<query::Queries>,
    turns: Mutex<turns::Turns>,
    /// Signalled whenever `turns` changes: an interrupt waits on it for the
    /// turn id and then for Codex's answer.
    turns_changed: Condvar,
    /// Server requests the host has answered itself (`requests.rs`).
    requests: Mutex<requests::Requests>,
    /// Cards (approvals and questions) and where each stands (`approvals.rs`).
    approvals: Mutex<approvals::Approvals>,
    history: Mutex<history::History>,
    history_published: std::sync::atomic::AtomicBool,
    /// How many times an interrupt has started waiting, so tests can step
    /// the stdout side only once the request side is parked.
    #[cfg(test)]
    turn_waits: std::sync::atomic::AtomicUsize,
}

impl CodexDriver {
    /// Hosted Codex runs turns from the session's prompt queue (`turns.rs`),
    /// so the host advertises `codex_turns` when Codex resolves
    /// (`serve::negotiate`).
    pub const RUNS_TURNS: bool = true;

    pub fn new(params: &SpawnParams) -> Self {
        Self {
            state: Mutex::new(State {
                ready: ReadyState::Pending,
                model: None,
                started: false,
                initialized: false,
                thread_requested: false,
                deadline: Instant::now() + READY_TIMEOUT,
            }),
            changed: Condvar::new(),
            cwd: params.cwd.clone(),
            requested_model: params.model.clone(),
            resume: params.resume.clone(),
            developer_instructions: None,
            permission_mode: params.permission_mode.clone(),
            policy: Mutex::new(PromptPolicy {
                model: params.model.clone(),
                effort: params.effort.clone(),
                mode: params.permission_mode.clone(),
            }),
            policy_records: Mutex::new(Vec::new()),
            next_command: std::sync::atomic::AtomicU64::new(FIRST_COMMAND_ID),
            host_replies: Mutex::new(HashSet::new()),
            queries: Mutex::new(query::Queries::default()),
            turns: Mutex::new(turns::Turns::default()),
            turns_changed: Condvar::new(),
            requests: Mutex::new(requests::Requests::default()),
            approvals: Mutex::new(approvals::Approvals::default()),
            history: Mutex::new(history::History::default()),
            history_published: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            turn_waits: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// Carry the admitted rune payload on this driver's `thread/start` requests.
    pub fn with_developer_instructions(mut self, text: Option<String>) -> Self {
        self.developer_instructions = text;
        self
    }

    /// `thread/start` (and `thread/resume`) params: the mode's policy, plus the payload when one was admitted.
    fn start_params(&self, mode: &str) -> Result<serde_json::Map<String, Value>, String> {
        let mut params = policy::thread_params(&self.cwd, mode, self.requested_model.as_deref())?;
        if let Some(text) = self.developer_instructions.as_ref() {
            params.insert("developerInstructions".into(), Value::String(text.clone()));
        }
        Ok(params)
    }

    /// Park on `turns_changed` for at most `timeout`.
    fn wait_turns<'a>(
        &self,
        turns: MutexGuard<'a, turns::Turns>,
        timeout: Duration,
    ) -> MutexGuard<'a, turns::Turns> {
        #[cfg(test)]
        self.turn_waits
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.turns_changed
            .wait_timeout(turns, timeout)
            .unwrap_or_else(|error| error.into_inner())
            .0
    }

    /// The request thread waits for initialize while the stdout reader calls
    /// `observe`. See `startup_waits_for_initialize_before_sending_thread`.
    pub fn start(&self, child: &Child) -> Result<(), String> {
        self.start_with(|message| {
            let remaining = lock(&self.state)
                .deadline
                .saturating_duration_since(Instant::now());
            child.write_line_within(&message.to_string(), remaining)
        })
    }

    fn start_with(&self, mut write: impl FnMut(&Value) -> WriteStatus) -> Result<(), String> {
        {
            let mut state = lock(&self.state);
            if state.started || !matches!(state.ready, ReadyState::Pending) {
                return Err("Codex startup already attempted or terminated".into());
            }
            state.started = true;
        }
        let messages = match self.startup_messages() {
            Ok(messages) => messages,
            Err(error) => {
                self.fail(error.clone());
                return Err(error);
            }
        };
        self.write_with(&mut write, &messages[0])?;
        self.wait_for(true)?;
        self.write_with(&mut write, &messages[1])?;
        // Arm correlation before writing: stdout can answer during the write.
        lock(&self.state).thread_requested = true;
        self.write_with(&mut write, &messages[2])?;
        if self.permission_mode == "auto" && self.resume.is_none() {
            if let Err(error) = self.wait_ready() {
                if !policy::reviewer_error(&error) {
                    return Err(error);
                }
                self.downgrade_auto();
                lock(&self.state).ready = ReadyState::Pending;
                let params = self.start_params("default")?;
                let retry = json!({
                    "jsonrpc": "2.0", "method": "thread/start", "id": THREAD_ID, "params": params
                });
                self.write_with(&mut write, &retry)?;
            }
        }
        Ok(())
    }

    /// Initialize (with `experimentalApi`, as the in-process adapter asks),
    /// `initialized`, then the thread request under the mode's policy from
    /// the shared contract. `Err` for a mode the contract does not name: the
    /// child is never started on a guessed sandbox.
    fn startup_messages(&self) -> Result<Vec<Value>, String> {
        let initialize = json!({
            "jsonrpc": "2.0",
            "method": "initialize",
            "id": INITIALIZE_ID,
            "params": {
                "clientInfo": {
                    "name": "falcon",
                    "title": "Falcon",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": { "experimentalApi": true }
            }
        });

        let (method, params) = if let Some(thread) = self.resume.as_deref() {
            let mut params = self.start_params(&self.permission_mode)?;
            params.insert("threadId".into(), Value::String(thread.to_string()));
            params.insert("excludeTurns".into(), Value::Bool(true));
            ("thread/resume", params)
        } else {
            ("thread/start", self.start_params(&self.permission_mode)?)
        };
        Ok(vec![
            initialize,
            json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }),
            json!({ "jsonrpc": "2.0", "method": method, "id": THREAD_ID, "params": params }),
        ])
    }

    /// The thread turns run on, once startup has bound it.
    fn thread(&self) -> Result<String, String> {
        match &lock(&self.state).ready {
            ReadyState::Ready(thread) => Ok(thread.clone()),
            ReadyState::Pending => Err("the Codex thread is not ready yet".into()),
            ReadyState::Failed(error) => Err(error.clone()),
        }
    }

    /// Whether a prompt with this content could start a turn: checked by
    /// `submit` before anything is queued or journaled.
    pub fn check_prompt(&self, content: &Value) -> Result<(), String> {
        let thread = self.thread()?;
        if self.resume.is_some()
            && !self.history_published.load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err("Codex resume history is still loading".into());
        }
        let input = turns::input(content)?;
        let snapshot = lock(&self.policy);
        let policy = policy::turn_policy(&snapshot.mode)?;
        // The child writer refuses a line over the cap, so a prompt whose
        // `turn/start` line is longer could never send. A queued prompt is
        // built later under a wider request id, so measure with the widest
        // (u64::MAX) and the current model, effort and mode: an upper bound.
        let mut line = turns::start_line(u64::MAX, &thread, input, policy, snapshot.model.as_deref());
        if let Some(effort) = snapshot.effort.as_deref() {
            line["params"]["effort"] = json!(effort);
        }
        let bytes = line.to_string().len();
        if bytes > crate::process::LINE_CAP {
            return Err(format!(
                "the prompt is {bytes} bytes as a turn, over the {} byte line limit",
                crate::process::LINE_CAP
            ));
        }
        Ok(())
    }

    /// Whether this prompt's `turn/start` would fit the child line cap under
    /// some mode with no model or effort pinned: if not, no setting change
    /// can ever let it send (`Session::pump` drops it rather than holding
    /// the queue behind it).
    pub fn could_fit(&self, content: &Value) -> bool {
        let (Ok(thread), Ok(input)) = (self.thread(), turns::input(content)) else {
            return false;
        };
        policy::modes().into_iter().any(|mode| {
            policy::turn_policy(mode).is_ok_and(|policy| {
                let line = turns::start_line(0, &thread, input.clone(), policy, None);
                line.to_string().len() <= crate::process::LINE_CAP
            })
        })
    }

    /// The `turn/start` line for this prompt, armed so its response and
    /// `turn/started` bind the turn the queue then waits on.
    pub fn prompt_line(&self, prompt: &str, content: &Value) -> Result<Value, String> {
        let thread = self.thread()?;
        let input = turns::input(content)?;
        let snapshot = lock(&self.policy);
        let policy = policy::turn_policy(&snapshot.mode)?;
        let model = snapshot.model.clone();
        let id = self.reserve_command();
        let mut line = turns::start_line(id, &thread, input, policy, model.as_deref());
        if let Some(effort) = snapshot.effort.as_deref() {
            line["params"]["effort"] = json!(effort);
        }
        lock(&self.turns).arm_start(
            id,
            prompt,
            CodexRecord::PromptPolicy {
                prompt: prompt.into(),
                mode: snapshot.mode.clone(),
                model,
                effort: snapshot.effort.clone(),
            },
        );
        Ok(line)
    }

    /// The `turn/steer` line folding this prompt into the bound turn. `Err`
    /// before Codex has named the running turn: the prompt stays queued.
    pub fn steer_line(&self, prompt: &str, content: &Value) -> Result<Value, String> {
        let thread = self.thread()?;
        let input = turns::input(content)?;
        let mut turns = lock(&self.turns);
        let turn = turns.steer_target()?;
        let id = self.reserve_command();
        turns.arm_steer(id, prompt);
        Ok(turns::steer_line(id, &thread, &turn, input))
    }

    /// The write of an armed prompt line settled. Returns the records to
    /// journal (the start's policy) when it was, or may have been, delivered.
    pub fn dispatched(&self, prompt: &str, delivered: bool) -> Vec<Body> {
        let records = lock(&self.turns).dispatched(prompt, delivered);
        self.turns_changed.notify_all();
        records
            .into_iter()
            .map(|codex| Body::Codex { codex })
            .collect()
    }

    /// Whether `message` ends the turn the queue waits on: the bound turn's
    /// `turn/completed`, or a refused `turn/start`. Called once per forwarded
    /// line, in order, from the stdout reader.
    pub fn ends_turn(&self, message: &Value) -> bool {
        let Ok(thread) = self.thread() else {
            return false;
        };
        let start_response = lock(&self.turns).is_start_response(message);
        if start_response
            && message
                .pointer("/error/message")
                .and_then(Value::as_str)
                .is_some_and(policy::reviewer_error)
        {
            self.downgrade_auto();
        }
        let ended = lock(&self.turns).step(&thread, message);
        self.turns_changed.notify_all();
        ended
    }

    /// Answer a server request the disposition table has the host answer
    /// (a refusal, the unsupported error, or an unknown method's -32601),
    /// once per request id, whether or not a view is attached; an answer not
    /// written frees the id for a repeat of the request. Called by the
    /// stdout reader before the line is published; returns the record to
    /// journal. Cards, notifications and responses write nothing.
    pub fn answer_request(
        &self,
        message: &Value,
        write: impl FnOnce(&Value) -> WriteStatus,
    ) -> Vec<Body> {
        let Some(claim) = lock(&self.requests).claim(message) else {
            return Vec::new();
        };
        let status = write(&claim.line);
        if let WriteStatus::NotWritten(_) = &status {
            lock(&self.requests).release(&claim.key);
        }
        vec![Body::Codex {
            codex: claim.record(&status),
        }]
    }

    /// Turn and card facts the last lines produced, for the journal.
    pub fn take_records(&self) -> Vec<Body> {
        let mut records = lock(&self.turns).take_records();
        records.extend(lock(&self.approvals).take_records());
        let mut bodies: Vec<Body> = records
            .into_iter()
            .map(|codex| Body::Codex { codex })
            .collect();
        bodies.extend(std::mem::take(&mut *lock(&self.policy_records)));
        bodies
    }

    /// Prompts whose `turn/steer` Codex refused since the last call.
    pub fn take_refused_steers(&self) -> Vec<String> {
        lock(&self.turns).take_refused_steers()
    }

    /// Prompts whose `turn/steer` was still unanswered at the turn end after
    /// its own, or at the child's close, released since the last call.
    pub fn take_unanswered_steers(&self) -> Vec<String> {
        lock(&self.turns).take_unanswered_steers()
    }

    /// Run `write` (the armed steer's line going to the child) only while
    /// the turn it folds into still runs, holding the turn state across it:
    /// the stdout reader cannot end that turn between the check and the
    /// write. `None` when the turn already ended: nothing was written.
    /// `write` must not call back into this driver (the lock is held).
    pub fn write_steer(
        &self,
        prompt: &str,
        write: impl FnOnce() -> WriteStatus,
    ) -> Option<WriteStatus> {
        let turns = lock(&self.turns);
        turns.steer_live(prompt).then(write)
    }

    /// Whether `prompt`'s `turn/steer` still awaits Codex's answer.
    pub fn steer_pending(&self, prompt: &str) -> bool {
        lock(&self.turns).steer_pending(prompt)
    }

    /// The consumed startup reply names the thread to the renderer. A resumed
    /// thread then yields host history envelopes until its terminal outcome.
    pub fn history_line(&self, message: &Value, child: &Child) -> Option<history::Update> {
        lock(&self.history).step(self, message, |request| {
            child.write_line_status(&request.to_string())
        })
    }

    pub fn history_closed(&self) -> Option<history::Update> {
        if self.resume.is_some() { lock(&self.history).closed() } else { None }
    }

    pub fn history_failed(&self, reason: &str) -> Option<history::Update> {
        if self.resume.is_some() { lock(&self.history).failed(reason) } else { None }
    }

    pub fn history_timeout(&self) -> Option<history::Update> {
        if self.resume.is_some() { lock(&self.history).timeout() } else { None }
    }

    pub fn history_done(&self) -> bool {
        self.resume.is_none() || lock(&self.history).done
    }

    pub fn history_was_published(&self) {
        self.history_published.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// The card key (`sr:<id>`) when `message` raises a card, which the
    /// unattended watcher denies if nobody holds the lease to answer it.
    pub fn permission_request(message: &Value) -> Option<String> {
        approvals::card_request(message)
    }

    #[cfg(test)]
    pub(crate) fn ready_for_test(&self, thread: &str) {
        lock(&self.state).ready = ReadyState::Ready(thread.into());
    }

    fn write_with(
        &self,
        write: &mut impl FnMut(&Value) -> WriteStatus,
        value: &Value,
    ) -> Result<(), String> {
        // One deadline covers initialize, both follow-up writes, and readiness.
        let state = lock(&self.state);
        if let ReadyState::Failed(error) = &state.ready {
            return Err(error.clone());
        }
        if Instant::now() >= state.deadline {
            drop(state);
            self.fail("Codex startup deadline expired".into());
            return Err("Codex startup deadline expired".into());
        }
        drop(state);
        let error = match write(value) {
            WriteStatus::Written => return Ok(()),
            WriteStatus::NotWritten(error) => error,
            WriteStatus::PossiblyDelivered(error) => {
                format!("Codex startup delivery is unknown; refusing readiness: {error}")
            }
        };
        self.fail(error.clone());
        Err(error)
    }

    pub fn wait_ready(&self) -> Result<String, String> {
        self.wait_for(false)
    }

    fn wait_for(&self, initialize_only: bool) -> Result<String, String> {
        let mut state = lock(&self.state);
        loop {
            match &state.ready {
                ReadyState::Ready(thread) => return Ok(thread.clone()),
                ReadyState::Failed(error) => return Err(error.clone()),
                ReadyState::Pending => {}
            }
            if initialize_only && state.initialized {
                return Ok(String::new());
            }
            let now = Instant::now();
            if now >= state.deadline {
                let error = format!(
                    "Codex app-server was not ready within {}s",
                    READY_TIMEOUT.as_secs()
                );
                state.ready = ReadyState::Failed(error.clone());
                self.changed.notify_all();
                return Err(error);
            }
            let remaining = state.deadline - now;
            let (next, _) = self
                .changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(|error| error.into_inner());
            state = next;
        }
    }

    pub fn model(&self) -> Option<String> {
        lock(&self.state).model.clone()
    }

    pub fn permission_mode(&self) -> String {
        lock(&self.policy).mode.clone()
    }

    pub fn observe(&self, message: &Value) -> (Observed, Option<String>) {
        // Server requests have their own IDs; they are not our RPC responses.
        // Cards open (and settle) here, before the line is published.
        if message.get("method").is_some() {
            lock(&self.approvals).observe(message);
            return (Observed::Forward, None);
        }
        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            return (Observed::Forward, None);
        };
        if lock(&self.host_replies).remove(&id) {
            let query = { lock(&self.queries).pending.remove(&id) };
            if let Some(reply) = query {
                let _ = reply.send(message.clone());
            } else {
                // An interrupt's answer settles its waiter even though it is
                // not a client event. A late answer is consumed as well.
                self.ends_turn(message);
            }
            return (Observed::Consumed, None);
        }
        if id != INITIALIZE_ID && id != THREAD_ID {
            return (Observed::Forward, None);
        }
        {
            let state = lock(&self.state);
            if !matches!(state.ready, ReadyState::Pending)
                || (id == INITIALIZE_ID && state.initialized)
            {
                return (Observed::Consumed, None);
            }
            if Instant::now() >= state.deadline {
                drop(state);
                self.fail("Codex startup deadline expired".into());
                return (Observed::Consumed, None);
            }
            let expected = if id == INITIALIZE_ID {
                state.started
            } else {
                state.thread_requested
            };
            if !expected {
                drop(state);
                self.fail("Codex received a startup response before its request".into());
                return (Observed::Consumed, None);
            }
        }

        if let Some(error) = message.get("error") {
            let detail = error
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| error.to_string());
            self.fail(format!(
                "Codex {} failed: {detail}",
                if id == INITIALIZE_ID {
                    "initialize"
                } else {
                    "thread readiness"
                }
            ));
            return (Observed::Consumed, None);
        }

        if id == INITIALIZE_ID {
            if !message.get("result").is_some_and(Value::is_object) {
                self.fail("Codex initialize response has no result object".into());
            } else {
                lock(&self.state).initialized = true;
                self.changed.notify_all();
            }
            return (Observed::Consumed, None);
        }

        let Some(thread) = message
            .pointer("/result/thread/id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
        else {
            self.fail("Codex thread response has no thread id".into());
            return (Observed::Consumed, None);
        };
        let mut state = lock(&self.state);
        if matches!(state.ready, ReadyState::Pending) {
            if self
                .resume
                .as_deref()
                .is_some_and(|requested| requested != thread)
            {
                state.ready = ReadyState::Failed("Codex resumed a different thread".into());
                self.changed.notify_all();
                return (Observed::Consumed, None);
            }
            if let Some(model) = message
                .pointer("/result/model")
                .or_else(|| message.pointer("/result/thread/model"))
                .and_then(Value::as_str)
            {
                state.model = Some(model.to_string());
                let mut policy = lock(&self.policy);
                if policy.model.is_none() {
                    policy.model = Some(model.to_string());
                }
            }
            if lock(&self.policy).mode == "auto"
                && message
                    .pointer("/result/approvalsReviewer")
                    .and_then(Value::as_str)
                    == Some("user")
            {
                self.downgrade_auto();
            }
            state.ready = ReadyState::Ready(thread.to_string());
            self.changed.notify_all();
        }
        (Observed::Consumed, None)
    }

    pub fn malformed(&self, line: &str) {
        self.fail(format!("Codex app-server emitted malformed JSON: {line}"));
    }

    pub fn stdout_closed(&self) {
        self.fail("Codex app-server stdout closed before readiness".into());
        self.close_turns("the Codex app-server closed its stdout");
    }

    /// The child exited: wake every waiter and cancel every open card,
    /// returning the cards cancelled so the caller journals them.
    pub fn abandon(&self, why: &str) -> Vec<String> {
        self.fail(why.to_string());
        self.close_turns(why);
        lock(&self.approvals).abandon()
    }

    /// No answer will come any more: wake whatever waits on one.
    fn close_turns(&self, why: &str) {
        lock(&self.turns).close(why);
        self.turns_changed.notify_all();
        lock(&self.queries).pending.clear();
    }

    fn fail(&self, error: String) {
        let mut state = lock(&self.state);
        if matches!(state.ready, ReadyState::Pending) {
            state.ready = ReadyState::Failed(error);
            self.changed.notify_all();
        }
    }

    /// Cards still awaiting a decision.
    pub fn pending_permissions(&self) -> Vec<String> {
        lock(&self.approvals).pending()
    }
    pub fn is_opened(&self, id: &str) -> bool {
        lock(&self.approvals).is_opened(id)
    }
    pub fn permission_states(&self) -> Vec<(String, PermissionState)> {
        lock(&self.approvals).states()
    }
    /// The cards that moved since the last call, for the stdout reader's
    /// journal (`Approvals::take_changes`).
    pub fn permission_changes(&self) -> Vec<(String, PermissionState)> {
        lock(&self.approvals).take_changes()
    }
    pub fn reserve_command(&self) -> u64 {
        self.next_command
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    }
    /// A host command in the sidecar vocabulary, as Codex. `interrupt`
    /// becomes `turn/interrupt` (`interrupt.rs`), `permission_response` the
    /// card's answer (`approvals.rs`); policy setters update the next turn.
    pub fn command_as(&self, cid: u64, child: &Child, message: Value) -> (Outcome, Option<String>) {
        match message.get("type").and_then(Value::as_str) {
            Some("interrupt") => {
                self.interrupt_with(cid, |line| child.write_line_status(&line.to_string()))
            }
            Some("permission_response") => {
                self.respond_with(&message, |line| child.write_line_status(&line.to_string()))
            }
            Some("set_model" | "set_effort" | "set_permission_mode") => self.set_policy(&message),
            _ => (
                Outcome::Failed,
                Some("Codex commands are unavailable yet".into()),
            ),
        }
    }

    fn set_policy(&self, message: &Value) -> (Outcome, Option<String>) {
        let result = match message["type"].as_str() {
            Some("set_model") => {
                let model = message["model"].as_str().unwrap_or("").trim();
                if model.is_empty() || model.len() > 80 {
                    Err("model name missing or too long".to_string())
                } else {
                    lock(&self.policy).model = Some(model.into());
                    Ok(())
                }
            }
            Some("set_effort") => {
                let level = message["level"].as_str().unwrap_or("");
                if !crate::protocol::effort_levels().contains(&level) {
                    Err(format!("effort level not allowed: {level}"))
                } else {
                    lock(&self.policy).effort = Some(level.into());
                    Ok(())
                }
            }
            Some("set_permission_mode") => {
                let mode = message["mode"].as_str().unwrap_or("");
                match policy::turn_policy(mode) {
                    Ok(_) => {
                        lock(&self.policy).mode = mode.into();
                        Ok(())
                    }
                    Err(error) => Err(error),
                }
            }
            _ => unreachable!(),
        };
        match result {
            Ok(()) => (Outcome::Applied, None),
            Err(error) => (Outcome::Failed, Some(error)),
        }
    }

    fn downgrade_auto(&self) {
        let mut policy = lock(&self.policy);
        if policy.mode == "auto" {
            policy.mode = "default".into();
            lock(&self.policy_records).push(Body::PermissionModeChanged {
                mode: "default".into(),
            });
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

#[cfg(test)]
mod tests;
