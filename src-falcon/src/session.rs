//! Session ownership: the reservation, the lifecycle, and the subscriber fan-out.
//!
//! Falcon is the durable host, so exclusivity is decided here rather than at
//! the caller. Two writers on one Claude conversation interleave its transcript
//! (see `agent.rs`), and a host that
//! survives its clients cannot re-derive that rule from a menu being open.
//!
//! The reservation is atomic: [`Registry::reserve`] holds one lock across the
//! "is this conversation free" test and the insertion, so two clients racing to
//! resume the same conversation cannot both win. It fails closed — an unknown
//! resume state is a refusal, never an attempt.
//!
//! Every later step is an *ownership* check on the same table: an entry names
//! the session that holds it from the moment it exists, adoption refuses a
//! conversation another session holds rather than taking it, and a release only
//! removes entries its own session owns. Both failure directions corrupt a
//! transcript — a lost entry lets a second client resume a live conversation,
//! and a stolen one does the same thing from the other end — so nothing outside
//! [`Reservations`] touches the map.
//!
//! Scope: one hosted agent kind (Claude), no journal, no controller
//! lease. Every subscriber currently sees every event for a session it attached
//! to; the single-controller token and the durable journal arrive in slices 2
//! and 3 and replace the fan-out, not the reservation.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, MutexGuard,
    },
};

use crate::{
    claude::{ClaudeDriver, Observed, PermissionState},
    codex::CodexDriver,
    journal::{Body, Journal, JournalError, Snapshot},
    process::Child,
    protocol::{Event, EventBody, Lease, LeaseRefusal, Outcome, SessionSummary},
};

pub enum AgentDriver {
    Claude(ClaudeDriver),
    Codex(CodexDriver),
}

impl AgentDriver {
    pub fn claude(params: &crate::protocol::SpawnParams) -> Self {
        Self::Claude(ClaudeDriver::new(params))
    }
    pub fn codex(params: &crate::protocol::SpawnParams) -> Self {
        Self::Codex(CodexDriver::new(params))
    }
    pub fn model(&self) -> Option<String> {
        match self {
            Self::Claude(d) => d.model(),
            Self::Codex(d) => d.model(),
        }
    }
    pub fn permission_mode(&self) -> String {
        match self {
            Self::Claude(d) => d.permission_mode(),
            Self::Codex(d) => d.permission_mode(),
        }
    }
    pub fn pending_permissions(&self) -> Vec<String> {
        match self {
            Self::Claude(d) => d.pending_permissions(),
            Self::Codex(d) => d.pending_permissions(),
        }
    }
    pub fn is_opened(&self, id: &str) -> bool {
        match self {
            Self::Claude(d) => d.is_opened(id),
            Self::Codex(d) => d.is_opened(id),
        }
    }
    pub fn permission_states(&self) -> Vec<(String, PermissionState)> {
        match self {
            Self::Claude(d) => d.permission_states(),
            Self::Codex(d) => d.permission_states(),
        }
    }
    /// The permission id when `message` raises a permission request (Claude's
    /// `permission_request`, a Codex card's `sr:<id>`): the unattended
    /// watcher's cue.
    pub fn permission_request(&self, message: &serde_json::Value) -> Option<String> {
        match self {
            Self::Claude(_) => (message.get("type").and_then(serde_json::Value::as_str)
                == Some("permission_request"))
            .then(|| message.get("id").and_then(serde_json::Value::as_str))
            .flatten()
            .map(str::to_string),
            Self::Codex(_) => CodexDriver::permission_request(message),
        }
    }
    /// Whether an unattended permission shows the Falcon shell before its
    /// grace runs out. Hosted Codex denies after the grace without showing
    /// it (refresh doc, Q2).
    pub fn shows_shell_unattended(&self) -> bool {
        matches!(self, Self::Claude(_))
    }
    /// Background tasks the agent is still running outside any turn. Codex
    /// reports none: its turns are the whole of its work.
    pub fn open_tasks(&self) -> usize {
        match self {
            Self::Claude(d) => d.open_tasks(),
            Self::Codex(_) => 0,
        }
    }
    /// Whether a prompt with this content could start a turn: `submit`
    /// refuses before anything is queued or journaled when it could not.
    pub fn check_prompt(&self, content: &serde_json::Value) -> Result<(), String> {
        match self {
            Self::Claude(_) => Ok(()),
            Self::Codex(d) => d.check_prompt(content),
        }
    }
    /// The line that hands the child queued prompt `prompt` to start a turn,
    /// or `Err` when this agent cannot start one now. Codex arms the turn it
    /// starts here, so the caller reports the write's fate to `dispatched`.
    pub fn prompt_line(
        &self,
        prompt: &str,
        content: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        match self {
            Self::Claude(_) => Ok(ClaudeDriver::prompt_line(content)),
            Self::Codex(d) => d.prompt_line(prompt, content),
        }
    }
    /// Whether this child line ends the running turn, which frees the queue
    /// for the next prompt. Each agent says it its own way: Claude with a
    /// `result` line; Codex with the bound turn's `turn/completed` (or a
    /// refused `turn/start`). Called once per forwarded line, in order.
    pub fn ends_turn(&self, message: &serde_json::Value) -> bool {
        match self {
            Self::Claude(_) => {
                message.get("type").and_then(serde_json::Value::as_str) == Some("result")
            }
            Self::Codex(d) => d.ends_turn(message),
        }
    }
    /// The line that folds a prompt into the running turn, or `Err` when the
    /// agent cannot steer now: then the steer is refused and the prompt keeps
    /// waiting. Codex refuses until the running turn has an id.
    pub fn steer_line(
        &self,
        prompt: &str,
        content: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        match self {
            Self::Claude(_) => Ok(ClaudeDriver::steer_line(content)),
            Self::Codex(d) => d.steer_line(prompt, content),
        }
    }
    /// The write of a `prompt_line`/`steer_line` settled; `delivered` when
    /// it landed or may have. Returns records to journal after the dispatch.
    pub fn dispatched(&self, prompt: &str, delivered: bool) -> Vec<Body> {
        match self {
            Self::Claude(_) => Vec::new(),
            Self::Codex(d) => d.dispatched(prompt, delivered),
        }
    }
    /// Answer a child request the host disposes of itself (hosted Codex: the
    /// shared server-request table's refusals and unknown methods), before
    /// the line is published; returns the record to journal. Claude: none.
    pub fn answer_request(&self, child: &Child, message: &serde_json::Value) -> Vec<Body> {
        match self {
            Self::Claude(_) => Vec::new(),
            Self::Codex(d) => {
                d.answer_request(message, |line| child.write_line_status(&line.to_string()))
            }
        }
    }
    /// Turn facts the agent derived from its last lines, for the journal.
    pub fn take_records(&self) -> Vec<Body> {
        match self {
            Self::Claude(_) => Vec::new(),
            Self::Codex(d) => d.take_records(),
        }
    }
    /// Folded prompts the agent refused since the last call (hosted Codex: a
    /// `turn/steer` answered with an error), oldest first. Claude never
    /// answers a steer, so it refuses none.
    pub fn take_refused_steers(&self) -> Vec<String> {
        match self {
            Self::Claude(_) => Vec::new(),
            Self::Codex(d) => d.take_refused_steers(),
        }
    }
    /// Folded prompts the agent never answered by the turn end after their
    /// own, or by its close (hosted Codex), released since the last call.
    /// Claude answers no steer, so it holds none.
    pub fn take_unanswered_steers(&self) -> Vec<String> {
        match self {
            Self::Claude(_) => Vec::new(),
            Self::Codex(d) => d.take_unanswered_steers(),
        }
    }
    /// Whether the agent may still answer `prompt`'s steer.
    pub fn steer_pending(&self, prompt: &str) -> bool {
        match self {
            Self::Claude(_) => false,
            Self::Codex(d) => d.steer_pending(prompt),
        }
    }
    pub fn reserve_command(&self) -> u64 {
        match self {
            Self::Claude(d) => d.reserve_command(),
            Self::Codex(d) => d.reserve_command(),
        }
    }
    pub fn command_as(
        &self,
        cid: u64,
        child: &Child,
        message: serde_json::Value,
    ) -> (Outcome, Option<String>) {
        match self {
            Self::Claude(d) => d.command_as(cid, child, message),
            Self::Codex(d) => d.command_as(cid, child, message),
        }
    }
    /// A read-only Codex request, returned directly to its caller.
    pub fn query(
        &self,
        child: &Child,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, (Outcome, String)> {
        match self {
            Self::Claude(_) => Err((Outcome::Failed, "queries require a Codex session".into())),
            Self::Codex(d) => d.query_with(method, params, |line| {
                child.write_line_status(&line.to_string())
            }),
        }
    }
    pub fn observe(&self, message: &serde_json::Value) -> (Observed, Option<String>) {
        match self {
            Self::Claude(d) => d.observe(message),
            Self::Codex(d) => d.observe(message),
        }
    }
    pub fn abandon(&self, why: &str) -> Vec<String> {
        match self {
            Self::Claude(d) => d.abandon(why),
            Self::Codex(d) => d.abandon(why),
        }
    }
    pub fn start(&self, child: &Child) -> Result<(), String> {
        match self {
            Self::Claude(_) => Ok(()),
            Self::Codex(d) => d.start(child),
        }
    }
    pub fn wait_ready(&self) -> Result<String, String> {
        match self {
            Self::Claude(_) => Err("Claude has no app-server readiness phase".into()),
            Self::Codex(d) => d.wait_ready(),
        }
    }
    pub fn malformed(&self, line: &str) {
        if let Self::Codex(d) = self {
            d.malformed(line);
        }
    }
    pub fn stdout_closed(&self) {
        if let Self::Codex(d) = self {
            d.stdout_closed();
        }
    }
}

/// The host's agent-neutral `user` line, the vocabulary every child is handed
/// a prompt in; a driver may add to it (`ClaudeDriver::steer_line`).
pub fn user_line(content: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "type": "user", "content": content })
}

static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);
static NEXT_SUBSCRIBER: AtomicU64 = AtomicU64::new(1);

/// How a hosted session is identified to clients. Opaque and unguessable is not
/// required — the pipe is already authenticated — but it must be a filename-safe
/// leaf, because the journal is named after it.
///
/// The host incarnation is part of the id, and that is a correctness property,
/// not decoration. Generations restart at 1 in every new host process, so an id
/// built from the counter alone is reused across host lifetimes: a client that
/// reconnects after Falcon restarted and forwards a mutation it queued earlier
/// would address a *different* session that happens to share the pair. Binding
/// the incarnation makes that command name a session that does not exist, which
/// fails closed at lookup with no extra check on any call path — including
/// `close`, `release` and `terminate`, which carry no generation at all.
///
/// A hosted session cannot outlive its host anyway (the Job dies with Falcon),
/// so an id that is unique per host loses nothing real.
fn session_id(incarnation: &str, generation: u64) -> String {
    format!("s{incarnation}-{generation:08}")
}

pub type Subscriber = Arc<dyn Fn(Event) + Send + Sync>;

pub struct Session {
    pub id: String,
    pub generation: u64,
    pub agent: &'static str,
    pub cwd: String,
    /// The Claude conversation this session holds. `None` until the sidecar
    /// reports one, which is why the reservation is keyed separately.
    pub conversation: Mutex<Option<String>>,
    pub child: Child,
    pub driver: AgentDriver,
    /// The durable record. Locked inside the subscriber lock in
    /// [`Session::publish_durable`]; never the other way round, so the two can
    /// never deadlock against each other.
    journal: Mutex<Journal>,
    /// The last journal position durably appended, of any record kind. This is
    /// the attach cut and the hydration bound.
    journal_cursor: AtomicU64,
    /// The last *event* sequence delivered to clients. Dense and gapless by
    /// construction: it counts only what was fanned out.
    ///
    /// Two counters, deliberately. They were one, and that silently broke the
    /// client contract: journalling a command between two events advanced the
    /// shared counter without broadcasting, so a client saw event 12 then 14
    /// and could not distinguish that from a dropped event — which is exactly
    /// the signal it uses to detect a failed attach. Collapsing them again, or
    /// relaxing the proof's adjacency check to match, would hide a contract
    /// change rather than fix one.
    sequence: AtomicU64,
    subscribers: Mutex<HashMap<u64, Subscriber>>,
    /// Resume history must precede live output, including for an attach made mid-load.
    history_barrier: Mutex<Option<Vec<DeferredHistoryEvent>>>,
    history_flow: Mutex<()>,
    exited: Mutex<Option<i32>>,
    /// Who is driving this session, if anyone.
    ///
    /// Session-scoped, not child-scoped: who holds the wheel has nothing to do
    /// with which child process is currently running, so a new generation does
    /// not clear it.
    controller: Mutex<Option<Controller>>,
    /// Monotonic across the session's whole life, advanced on every lease
    /// change — acquire AND release alike.
    ///
    /// Never reset. It is what lets a holder that was superseded be refused
    /// with a specific reason instead of a generic mismatch, and it is the
    /// fence a transfer prepares and commits against.
    controller_revision: AtomicU64,
    /// Orders `ControllerChanged` appends by revision without holding
    /// `controller` across the write. Every lease change takes this first,
    /// allocates its revision under `controller`, drops `controller`, then
    /// appends, so the next change allocates and appends after this one. Lock
    /// order (first of all, before the registry's `inner`): see `lease.rs`.
    controller_journal: Mutex<()>,
    /// Last lease acquirer, kept past release (reported in `SessionSummary`).
    last_holder: Mutex<Option<String>>,
    /// The admitted `SpawnParams.rules_file`, echoed in `SessionSummary`. Set
    /// once by `serve::spawn` right after construction, Claude sessions only.
    pub rules_file: std::sync::OnceLock<String>,
    /// The admitted `SpawnParams.tab_name`, echoed in `SessionSummary` so a
    /// re-adopting Vidar keeps the tab's name. Set once by `serve::spawn`.
    pub tab_name: std::sync::OnceLock<String>,
    /// The admitted `SpawnParams.gateway` (a gateway module id), echoed in
    /// `SessionSummary` so a re-adopt and a `/clear` respawn keep the gateway
    /// identity. Set once by `serve::spawn`; never carries a credential.
    pub gateway: std::sync::OnceLock<crate::protocol::Gateway>,
    /// The admitted `SpawnParams.profile` and the env names its child got, echoed in
    /// `SessionSummary` (Vidar's honoured-profile proof and its manifest). Set once by `serve::spawn`.
    pub profile: std::sync::OnceLock<String>,
    pub env_names: std::sync::OnceLock<Vec<String>>,
    /// Admitted `--payload` path and `row_key`, echoed like `profile` (re-adopt rebuilds the row).
    pub payload_file: std::sync::OnceLock<String>, pub row_key: std::sync::OnceLock<String>,
    /// Prompts accepted from clients, owned by Falcon rather than the sidecar.
    queue: Mutex<PromptQueue>,
    /// Why this session can no longer promise durability, once it cannot.
    ///
    /// Set on the first journal append failure and never cleared: a session
    /// that has lost a record cannot get it back, and pretending otherwise
    /// after one successful write would be worse than staying degraded.
    degraded: Mutex<Option<String>>,
    /// Permission request ids that already have (or are getting) an unattended
    /// watcher, whether spawned at observe time or later when a controller
    /// that was holding the lease releases it. Prevents a second watcher from
    /// being spawned for the same request from either site.
    unattended_watched: Mutex<std::collections::HashSet<String>>,
    /// Set once, under the registry lock, when the idle sweep commits to
    /// ending this session ([`Registry::reserve_idle_stop`]); from then on
    /// attach and control acquisition refuse it. Never cleared.
    stopping: AtomicBool,
}

// The prompt queue (`PromptQueue`, `QueuedPrompt`): `session/dispatch.rs`.

enum DeferredHistoryEvent {
    Event(EventBody),
    Record(Body),
}

/// What happened to a prompt handed to the child.
#[derive(Debug, PartialEq, Eq)]
pub enum Dispatched {
    /// Nothing was sent: either a turn is already in flight or the queue is
    /// empty. Not an error.
    Idle,
    Sent(String),
    /// The write failed outright; the prompt was NOT delivered and has been
    /// dropped from the queue.
    Failed(String, String),
    /// The write may or may not have landed. The prompt is treated as
    /// dispatched, because re-sending it could duplicate a real prompt — the
    /// one failure mode a user notices immediately.
    Unknown(String),
}

/// The live half of a controller lease: what [`crate::protocol::Lease`] is
/// checked against.
#[derive(Debug, Clone)]
struct Controller {
    token: String,
    revision: u64,
    /// The client name, for the journal and for `list`. Untrusted and
    /// cosmetic — it identifies, it does not authorise. The token does that.
    holder: String,
    /// The connection that acquired it. A lease outliving its connection would
    /// strand the session under a controller that cannot be reached, so
    /// teardown releases by this and nothing else.
    connection: u64,
}

impl Session {
    /// Durably record an event, then publish it to every attached subscriber.
    ///
    /// Append-before-publish is the ordering the whole recovery story rests on:
    /// no client is ever shown something the journal would not replay after a
    /// crash.
    ///
    /// Two numbers move here and they mean different things. The journal
    /// position is where this record landed; the event `seq` a subscriber sees
    /// is a dense count of what was actually broadcast. A client checks its
    /// event stream for gaps, and hydrates from the journal position the attach
    /// handed it — so the two must not be conflated.
    ///
    /// Both the append and the fan-out happen under the subscriber lock. That
    /// is what makes [`Session::attach`] a *cut*: an attach taking the same
    /// lock cannot interleave with a publish, so the sequence it captures is
    /// exactly the boundary between "hydrate from the journal" and "arrives
    /// live". Two reader threads also cannot deliver a lower sequence after a
    /// higher one, which a client would be unable to distinguish from
    /// corruption.
    ///
    /// If the append fails, the event is NOT published: showing a client
    /// something unrecoverable is precisely the lie this ordering prevents. The
    /// failure is reported so the caller can mark recovery degraded.
    pub fn publish_durable(&self, body: EventBody) -> Result<u64, JournalError> {
        let subscribers = lock(&self.subscribers);
        let mut journal = lock(&self.journal);
        let (position, body) = match journal.append(self.generation, Body::Event { body: body.clone() }) {
            Ok(position) => (position, body),
            // One record too large to journal is a lost line, not lost
            // durability: nothing was written, the sequence was not consumed,
            // and the next append is as safe as the last. Publish the loss in
            // its place, the same way the line reader reports a line over its
            // cap, rather than marking the whole session degraded for good.
            Err(JournalError::TooLarge { bytes, .. }) => {
                let overflow = EventBody::Overflow {
                    bytes: bytes as u64,
                };
                match journal.append(
                    self.generation,
                    Body::Event {
                        body: overflow.clone(),
                    },
                ) {
                    Ok(position) => (position, overflow),
                    Err(error) => {
                        self.enter_degraded(&error.to_string());
                        return Err(error);
                    }
                }
            }
            Err(error) => {
                // Marked while both locks are still held, which is safe only
                // because `enter_degraded` does nothing but set a flag. It
                // deliberately does NOT publish an event to say so: publishing
                // requires a durable append, and that is the thing that just
                // failed. Clients learn from `list` and from the named refusal
                // on their next mutation — both honest, neither pretending to
                // a durability we no longer have.
                self.enter_degraded(&error.to_string());
                return Err(error);
            }
        };
        self.journal_cursor.store(position, Ordering::SeqCst);
        // Only published records advance the event sequence, so it stays dense.
        let seq = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let event = Event {
            session: self.id.clone(),
            generation: self.generation,
            seq,
            body,
        };
        for subscriber in subscribers.values() {
            subscriber(event.clone());
        }
        Ok(seq)
    }

    /// Append semantic state and publish it through the same serialized cut
    /// as agent output. Both active and reconnecting renderers must observe
    /// queue and permission transitions, including transitions with no stdout.
    pub fn record(&self, body: Body) -> Result<u64, JournalError> {
        // Same lock order as `publish_durable`: subscribers, then journal.
        // Taking the journal alone would be safe today, but establishing one
        // order everywhere is what keeps it safe after the next change.
        let subscribers = lock(&self.subscribers);
        let mut journal = lock(&self.journal);
        let wire_body =
            serde_json::to_value(&body).expect("journal records have a JSON representation");
        let position = match journal.append(self.generation, body) {
            Ok(position) => position,
            // Refused before anything was written: the caller's command or
            // prompt is refused with this error, and durability is intact.
            Err(error @ JournalError::TooLarge { .. }) => return Err(error),
            Err(error) => {
                self.enter_degraded(&error.to_string());
                return Err(error);
            }
        };
        // Persist before delivery. The original body appears once in history;
        // the Record envelope exists only on the live wire.
        self.journal_cursor.store(position, Ordering::SeqCst);
        drop(journal);
        let seq = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let event = Event {
            session: self.id.clone(),
            generation: self.generation,
            seq,
            body: EventBody::Record { body: wire_body },
        };
        for subscriber in subscribers.values() {
            subscriber(event.clone());
        }
        Ok(position)
    }

    /// Record that durability is lost, keeping the FIRST reason.
    ///
    /// The first failure is the diagnostic one; later failures are usually the
    /// same disk saying the same thing, and overwriting would lose the cause.
    /// Only sets a flag — see the call site in [`Session::publish_durable`] for
    /// why it must not do anything more.
    fn enter_degraded(&self, why: &str) {
        let mut degraded = lock(&self.degraded);
        if degraded.is_some() {
            return;
        }
        *degraded = Some(why.to_string());
        eprintln!(
            "falcon {}: journal append failed ({why}); session is degraded and \
             will refuse further mutations",
            self.id
        );
    }

    /// Why this session stopped accepting mutations, if it has.
    ///
    /// A degraded session is deliberately kept alive and readable rather than
    /// killed: the child is still running and the user's work is still on
    /// screen. What it must not do is accept anything new, because it can no
    /// longer prove what it accepted.
    pub fn degraded(&self) -> Option<String> {
        lock(&self.degraded).clone()
    }

    /// Accept a prompt into Falcon's queue, durably, and return its id.
    ///
    /// Journalled before it is queued, for the same reason command acceptance
    /// is: a prompt the client was told was accepted must survive a crash, and
    /// a queue that only exists in memory is exactly what this replaces.
    pub fn enqueue_prompt(&self, content: serde_json::Value) -> Result<String, JournalError> {
        let id = format!("p{}", uuid::Uuid::new_v4().simple());
        self.record(Body::PromptQueued {
            prompt: id.clone(),
            content: content.clone(),
        })?;
        let mut queue = lock(&self.queue);
        let order = queue.next_order;
        queue.next_order += 1;
        queue.waiting.push_back(QueuedPrompt {
            id: id.clone(),
            content,
            order,
        });
        Ok(id)
    }

    /// Drop a queued prompt. `Err` if it is not waiting — already dispatched,
    /// already retracted, or never existed.
    pub fn retract_prompt(&self, prompt: &str) -> Result<(), String> {
        let mut queue = lock(&self.queue);
        if queue.in_flight.iter().any(|held| held == prompt) {
            return Err(format!("prompt {prompt} has already been dispatched"));
        }
        let Some(at) = queue.waiting.iter().position(|held| held.id == prompt) else {
            return Err(format!("no queued prompt {prompt}"));
        };
        // Append BEFORE the effect, matching `enqueue_prompt`. Removing first
        // and recording quietly was the inverse: a failed append left the
        // journal saying a prompt was still queued when it had been dropped,
        // so a rebuilt view would offer to retract something that no longer
        // existed. The queue lock is held across the append so a concurrent
        // queue change cannot land between the record and the effect, the
        // same reason a lease change holds its order lock across its record.
        self.record(Body::PromptRetracted {
            prompt: prompt.to_string(),
        })
        .map_err(|error| format!("cannot journal the retraction: {error}"))?;
        queue.waiting.remove(at);
        Ok(())
    }

    // `pump`, `steer_prompt` and `turn_finished` (handing prompts to the
    // child, and the turn end that frees it): `session/dispatch.rs`.

    /// Prompts still waiting, oldest first. For `list` and for tests.
    pub fn queued_prompts(&self) -> Vec<String> {
        lock(&self.queue)
            .waiting
            .iter()
            .map(|held| held.id.clone())
            .collect()
    }

    /// Check a lease against the one currently held, without changing anything.
    pub fn check_control(&self, lease: &Lease) -> Result<(), LeaseRefusal> {
        let current = lock(&self.controller);
        self.check_lease(current.as_ref(), lease)
    }

    /// The revision a refusal should report, so a client can re-acquire.
    pub fn controller_revision(&self) -> u64 {
        self.controller_revision.load(Ordering::SeqCst)
    }

    /// The current holder's name, for `list`. Cosmetic.
    pub fn controller_holder(&self) -> Option<String> {
        lock(&self.controller)
            .as_ref()
            .map(|held| held.holder.clone())
    }

    /// Claim `request` for an unattended watcher. Returns `true` the first
    /// time it is called for a given id, `false` on every call after — the
    /// observe-time spawn and the lease-release spawn share this set so
    /// neither can double-watch the same request.
    pub fn claim_unattended_watch(&self, request: &str) -> bool {
        lock(&self.unattended_watched).insert(request.to_string())
    }

    /// Release `request`'s claim once its watcher has exited, so a LATER
    /// occurrence of the same request id (a new permission, not a retry of
    /// this one) is not permanently blocked from being watched.
    pub fn clear_unattended_watch(&self, request: &str) {
        lock(&self.unattended_watched).remove(request);
    }

    /// Something in Falcon is still waiting on this child: a turn is in
    /// flight or a prompt is queued behind one, a permission has not reached
    /// a terminal state (`Opened`, `Responded` and `Returned` all still block
    /// the CLI), an unattended watcher is running for one, or the agent still
    /// has a background task open (a subagent or background Bash outlives
    /// its turn's `result`, and its completion can wake a turn that never
    /// passes through the queue). No orphan rule in `serve/idle.rs` ends a
    /// session while this holds.
    ///
    /// Conservative by design: a prompt left in flight by an uncertain
    /// dispatch stays in flight until the next `result`, so such a session is
    /// never reaped as an orphan. Keeping a host up is recoverable; killing a
    /// turn mid-flight is not.
    pub fn has_pending_work(&self) -> bool {
        if self.driver.open_tasks() > 0 {
            return true;
        }
        {
            let queue = lock(&self.queue);
            if !queue.in_flight.is_empty() || !queue.waiting.is_empty() {
                return true;
            }
        }
        if !lock(&self.unattended_watched).is_empty() {
            return true;
        }
        self.driver
            .permission_states()
            .iter()
            .any(|(_, state)| !state.is_terminal())
    }

    fn check_lease(&self, current: Option<&Controller>, lease: &Lease) -> Result<(), LeaseRefusal> {
        let Some(current) = current else {
            return Err(LeaseRefusal::Vacant);
        };
        // Both halves must match. The revision check is not redundant with the
        // token check today — a token is fresh per acquisition, so a wrong
        // revision against a right token cannot come from a lease this server
        // issued — but it is the fence a transfer will advance, and
        // dropping it now would remove the check that transfer depends on.
        if current.token != lease.token || current.revision != lease.revision {
            return Err(LeaseRefusal::Mismatch);
        }
        Ok(())
    }

    /// [`Session::record`], with an append failure reported rather than returned.
    pub fn record_quietly(&self, body: Body) {
        let mut barrier = lock(&self.history_barrier);
        if let Some(pending) = barrier.as_mut() {
            pending.push(DeferredHistoryEvent::Record(body));
            return;
        }
        drop(barrier);
        if let Err(error) = self.record(body) {
            eprintln!("falcon {}: journal append failed: {error}", self.id);
        }
    }

    /// [`Session::publish_durable`], with an append failure reported to the
    /// host's stderr rather than returned. For callers on a reader thread that
    /// have nowhere to propagate it.
    pub fn publish(&self, body: EventBody) {
        let mut barrier = lock(&self.history_barrier);
        if let Some(pending) = barrier.as_mut() {
            pending.push(DeferredHistoryEvent::Event(body));
            return;
        }
        drop(barrier);
        if let Err(error) = self.publish_durable(body) {
            eprintln!(
                "falcon {}: journal append failed, event not published: {error}",
                self.id
            );
        }
    }

    /// Attach a subscriber and capture the cut in one step.
    ///
    /// Returns the token and `through`, a *journal position* — the same
    /// number line as `journal_cursor`, not the event `seq` on
    /// [`Event`]. The client hydrates from the journal up to `through`, then
    /// simply accepts every event delivered live from here on; it must not
    /// filter those live events by comparing their `seq` to `through`, because
    /// the two counters advance independently (see the field comments above)
    /// and an event's `seq` can be less than or equal to a `through` produced
    /// before that event ever existed. What makes this a clean cut is not a
    /// numeric comparison, it is the lock: this runs under the same lock as
    /// [`Session::publish_durable`], so an attach taking it cannot interleave
    /// with a publish, and every event from here on is delivered live exactly
    /// once, never folded into the hydration range and never skipped.
    pub fn attach(&self, subscriber: Subscriber) -> (u64, u64) {
        let mut subscribers = lock(&self.subscribers);
        let token = NEXT_SUBSCRIBER.fetch_add(1, Ordering::SeqCst);
        let through = self.journal_cursor.load(Ordering::SeqCst);
        subscribers.insert(token, subscriber);
        (token, through)
    }

    /// The current journal position — the same cut [`Session::attach`] would
    /// capture right now. `pub(crate)` for tests outside this module that
    /// need to hydrate everything appended so far without a live attach.
    #[allow(dead_code)] // called only from serve.rs's #[cfg(test)] fixtures
    pub(crate) fn journal_position(&self) -> u64 {
        self.journal_cursor.load(Ordering::SeqCst)
    }

    /// The journal's newest valid snapshot. Paging records out is
    /// `hydrate_from`, in `session/hydrate.rs`.
    pub fn snapshot(&self) -> Result<Option<Snapshot>, JournalError> {
        lock(&self.journal).read_snapshot()
    }

    pub fn detach(&self, token: u64) -> bool {
        lock(&self.subscribers).remove(&token).is_some()
    }

    pub fn attached(&self) -> usize {
        lock(&self.subscribers).len()
    }

    /// The Claude conversation this session holds, once the sidecar has
    /// reported one. `None` until then — see the field doc on
    /// [`Session::conversation`].
    pub fn conversation(&self) -> Option<String> {
        lock(&self.conversation).clone()
    }

    pub fn mark_exited(&self, code: Option<i32>) {
        *lock(&self.exited) = Some(code.unwrap_or(-1));
    }

    pub fn exited(&self) -> Option<i32> {
        *lock(&self.exited)
    }

    /// The idle sweep has committed to ending this session (`stopping`).
    pub fn stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    pub fn summary(&self) -> SessionSummary {
        SessionSummary {
            session: self.id.clone(),
            generation: self.generation,
            agent: self.agent.into(),
            cwd: self.cwd.clone(),
            conversation: lock(&self.conversation).clone(),
            pid: self.child.pid(),
            model: self.driver.model(),
            permission_mode: self.driver.permission_mode(),
            attached: self.attached(),
            exited: self.exited(),
            queued_prompts: self.queued_prompts(),
            pending_permissions: self.driver.pending_permissions(),
            degraded: self.degraded(),
            last_holder: lock(&self.last_holder).clone(),
            rules_file: self.rules_file.get().cloned(),
            tab_name: self.tab_name.get().cloned(),
            gateway: self.gateway.get().copied(),
            profile: self.profile.get().cloned(), env_names: self.env_names.get().cloned(),
            payload_file: self.payload_file.get().cloned(), row_key: self.row_key.get().cloned(),
        }
    }
}

#[derive(Default)]
pub struct Registry {
    inner: Mutex<Inner>,
    /// Short, filename-safe tag for this host process, mixed into every session
    /// id. See [`session_id`] for why identity must not be reused across hosts.
    incarnation: String,
}

impl Registry {
    /// Build a registry tagged with this host's incarnation — in practice the
    /// process creation time, which `ipc::current_process_creation_identity`
    /// already supplies and which a restarted host cannot repeat.
    pub fn for_incarnation(incarnation: u64) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            // 8 hex digits of the creation stamp: enough to separate host
            // lifetimes, short enough to keep a journal filename readable.
            incarnation: format!("{:08x}", incarnation & 0xffff_ffff),
        }
    }
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, Arc<Session>>,
    reservations: Reservations,
}

/// `(agent, conversation id) -> owning session id`, for every conversation this
/// host holds. Separate from `sessions` so a reservation can be taken before
/// the child exists and released independently of the session entry.
///
/// The value is never anonymous: [`Registry::reserve`] writes the id of the
/// session it is about to build, so a pending spawn's claim is as identifiable
/// as a committed one. Every mutation below is an ownership check.
#[derive(Default)]
struct Reservations(HashMap<(&'static str, String), String>);

impl Reservations {
    /// Claim `key` for `holder`. Idempotent for the holder it already names,
    /// refused for anyone else: adoption fails closed instead of stealing, and
    /// the loser of a race learns who won.
    fn claim(&mut self, key: (&'static str, String), holder: &str) -> Result<(), String> {
        if let Some(existing) = self.0.get(&key) {
            if existing == holder {
                return Ok(());
            }
            return Err(format!(
                "conversation {} is already hosted by session {existing}",
                key.1
            ));
        }
        self.0.insert(key, holder.to_string());
        Ok(())
    }

    /// Release one key, and only when `holder` owns it. Returns whether it did.
    fn release_key(&mut self, key: &(&'static str, String), holder: &str) -> bool {
        if self.0.get(key).map(String::as_str) != Some(holder) {
            return false;
        }
        self.0.remove(key);
        true
    }

    /// Release every key `holder` owns. A session can own more than one: a CLI
    /// that reports a second conversation keeps the first (see
    /// [`Registry::adopt_conversation`]), and this is where those are freed.
    fn release_all(&mut self, holder: &str) -> usize {
        let before = self.0.len();
        self.0.retain(|_, owner| owner.as_str() != holder);
        before - self.0.len()
    }

    #[cfg(test)]
    fn holder(&self, agent: &'static str, conversation: &str) -> Option<String> {
        self.0.get(&(agent, conversation.to_string())).cloned()
    }
}

/// A reservation taken but not yet committed to a session. Dropping it without
/// [`Reservation::commit`] releases the conversation — so a spawn that fails
/// after reserving cannot strand the conversation as permanently busy.
pub struct Reservation<'registry> {
    registry: &'registry Registry,
    key: Option<(&'static str, String)>,
    pub id: String,
    pub generation: u64,
}

impl Reservation<'_> {
    pub fn commit(mut self, session: Arc<Session>) {
        let mut inner = lock(&self.registry.inner);
        if let Some(key) = self.key.take() {
            // Already ours: `reserve` wrote this session's id, adoption refuses
            // an occupied key, and a release only removes keys its own session
            // owns — and this id is not a registered session until the line
            // below, so no release can name it. `claim` re-asserts that rather
            // than trusting it, and is a no-op when the entry is already ours.
            //
            // Skipped once the child has already exited (the Codex handshake
            // window: `start_readers` runs before this commit, so an exit
            // landing in between finds no session entry yet and
            // `free_conversations` frees the key with nothing to refuse it).
            // Re-claiming here would resurrect exactly the stranded claim
            // `free_conversations` exists to prevent, with no process behind
            // it and no client that will ever send `release`.
            if session.exited().is_none() {
                let _ = inner.reservations.claim(key, &self.id);
            }
        }
        inner.sessions.insert(self.id.clone(), session);
    }
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            // Ownership-checked like every other removal: an uncommitted
            // reservation frees its own claim and nobody else's.
            let id = self.id.clone();
            lock(&self.registry.inner)
                .reservations
                .release_key(&key, &id);
        }
    }
}

impl Registry {
    /// Reserve a session slot, atomically refusing a conversation that is
    /// already hosted here.
    ///
    /// `conversation` is `None` for a fresh conversation: nothing to collide
    /// with yet, and the id the sidecar reports later is recorded on the
    /// session rather than reserved retroactively. That is a deliberate slice-1
    /// limit — a *fresh* conversation cannot be double-hosted because only
    /// Falcon can start one, whereas a *resume* names an existing transcript
    /// two clients could both ask for.
    pub fn reserve(
        &self,
        agent: &'static str,
        conversation: Option<&str>,
    ) -> Result<Reservation<'_>, String> {
        if conversation.is_some_and(|id| id.trim().is_empty()) {
            return Err("conversation id is empty".into());
        }
        // Allocate the id before the lock so the claim can name its owner. An
        // anonymous placeholder cannot be told apart from a second caller's, and
        // every later step here is an ownership check — a claim nobody owns is
        // the hole those checks exist to close. `NEXT_GENERATION` is atomic on
        // its own, so this costs nothing but a burnt number on the refusal path.
        let generation = NEXT_GENERATION.fetch_add(1, Ordering::SeqCst);
        let id = session_id(&self.incarnation, generation);
        let mut inner = lock(&self.inner);
        let key = match conversation {
            Some(conversation) => {
                let key = (agent, conversation.to_string());
                // The slot is taken from here on, so a second caller racing this
                // one loses even before the child starts.
                inner.reservations.claim(key.clone(), &id)?;
                Some(key)
            }
            None => None,
        };
        Ok(Reservation {
            registry: self,
            key,
            id,
            generation,
        })
    }

    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        lock(&self.inner).sessions.get(id).cloned()
    }

    /// Session plus generation check in one step. A stale generation must never
    /// reach a replacement child: a command written by a client that still
    /// believes in the previous process would land in the wrong conversation.
    #[allow(dead_code)] // parked: documented in replay.rs's comments, no caller wired yet
    pub fn get_current(&self, id: &str, generation: u64) -> Result<Arc<Session>, String> {
        let session = self.get(id).ok_or("no such session")?;
        if session.generation != generation {
            return Err(format!(
                "stale generation {generation}; session {id} is at {}",
                session.generation
            ));
        }
        Ok(session)
    }

    /// Every live session, for callers that need more than the cosmetic
    /// [`SessionSummary`] — the unused-session sweep in `serve.rs` reads
    /// `conversation`/`controller_holder`/`attached` directly off these.
    pub fn sessions(&self) -> Vec<Arc<Session>> {
        lock(&self.inner).sessions.values().cloned().collect()
    }

    pub fn list(&self) -> Vec<SessionSummary> {
        let sessions: Vec<Arc<Session>> = lock(&self.inner).sessions.values().cloned().collect();
        let mut summaries: Vec<SessionSummary> =
            sessions.iter().map(|session| session.summary()).collect();
        summaries.sort_by(|a, b| a.session.cmp(&b.session));
        summaries
    }

    /// Drop the session entry and its reservation. Refuses while the child is
    /// alive: releasing a live session would let a second client resume the
    /// same conversation beside it.
    pub fn release(&self, id: &str) -> Result<(), String> {
        let mut inner = lock(&self.inner);
        let session = inner.sessions.get(id).ok_or("no such session")?;
        if session.exited().is_none() {
            return Err("session is still running; close or terminate it first".into());
        }
        inner.sessions.remove(id);
        // Only what this session owns, found by holder rather than by the
        // conversation it happens to be labelled with. Removing
        // `(agent, session.conversation)` outright — the previous behaviour —
        // frees whatever sits under that key, including another session's live
        // claim, and two processes on one transcript is exactly the thing this
        // file exists to prevent. The sweep also covers a session that owns
        // more than one conversation.
        inner.reservations.release_all(id);
        Ok(())
    }

    /// Free every conversation `id` holds while keeping the session entry, so
    /// a resume of the same conversation is accepted the moment the child is
    /// gone. Called from the exit path, after the Job is terminated and the
    /// session marked exited. Without it the claim outlived the process: Vidar
    /// never sends `Op::Release`, and the launcher hides exited sessions, so an
    /// exited tab locked its conversation until the host was restarted
    /// Refused while the child is alive for the same reason
    /// [`Registry::release`] is. Returns how many keys were freed.
    pub fn free_conversations(&self, id: &str) -> Result<usize, String> {
        let mut inner = lock(&self.inner);
        if let Some(session) = inner.sessions.get(id) {
            if session.exited().is_none() {
                return Err("session is still running; close or terminate it first".into());
            }
        }
        Ok(inner.reservations.release_all(id))
    }

    /// Record the conversation id the sidecar reported and claim the
    /// reservation for it. A fresh conversation reaches its id this way.
    ///
    /// A checked claim, not an overwrite: if another session holds this
    /// conversation the adoption is refused and reported, because taking it
    /// would put two processes on one transcript with nothing left to notice.
    /// An unregistered session is an error for the same reason — it used to
    /// return silently, which let a conversation end up held by nobody.
    pub fn adopt_conversation(&self, id: &str, conversation: &str) -> Result<(), String> {
        if conversation.trim().is_empty() {
            return Err(format!("session {id} reported an empty conversation id"));
        }
        let mut inner = lock(&self.inner);
        let session = inner.sessions.get(id).cloned().ok_or_else(|| {
            format!("session {id} is not registered; conversation {conversation} was not claimed")
        })?;
        // A late `system/init` from a child that has already exited must not
        // re-take a key the exit path just freed: that would recreate the
        // stranded claim with no process behind it.
        if session.exited().is_some() {
            return Err(format!(
                "session {id} has exited; conversation {conversation} was not claimed"
            ));
        }
        // Claim first: a session must never be labelled with a conversation it
        // was refused. Idempotent when this session already owns the key, and
        // it re-inserts an entry that somehow went missing.
        inner
            .reservations
            .claim((session.agent, conversation.to_string()), id)?;
        // A session that reports a second conversation keeps the first claim as
        // well. Freeing it here would hand a transcript this child may still
        // append to back to the pool; holding it costs one refused resume until
        // the session is released, which is the direction to fail in.
        *lock(&session.conversation) = Some(conversation.to_string());
        Ok(())
    }

    pub fn all(&self) -> Vec<Arc<Session>> {
        lock(&self.inner).sessions.values().cloned().collect()
    }
}

/// Build a session around an already-opened journal.
///
/// The journal is opened by the caller and passed in, rather than opened here,
/// so a failure to open it stops the spawn before a child exists. A session
/// whose journal could not be opened must not run: it would be publishing
/// events nothing could replay, which is the state the durability ordering is
/// meant to make impossible.
///
/// The caller is expected to have appended the opening [`Body::Started`] record
/// already, for the same reason — it is the first thing replay needs.
pub fn new_session(
    reservation: &Reservation<'_>,
    agent: &'static str,
    cwd: String,
    conversation: Option<String>,
    child: Child,
    driver: AgentDriver,
    journal: Journal,
) -> Arc<Session> {
    let journal_cursor = AtomicU64::new(journal.last_seq());
    let resume_history = agent == "codex" && conversation.is_some();
    // A new session starts uncontrolled at revision 0. The spawning client does not get the
    // lease implicitly: it asks, like everyone else, so there is exactly one code path that
    // issues a lease and exactly one journal record shape that records it.
    let controller = Mutex::new(None);
    let controller_revision = AtomicU64::new(0);
    Arc::new(Session {
        id: reservation.id.clone(),
        generation: reservation.generation,
        agent,
        cwd,
        conversation: Mutex::new(conversation),
        child,
        driver,
        journal: Mutex::new(journal),
        journal_cursor,
        // Events are counted from zero for this generation: a client's gapless
        // check is over what it was sent, not over the journal's history.
        sequence: AtomicU64::new(0),
        subscribers: Mutex::new(HashMap::new()),
        history_barrier: Mutex::new(if resume_history {
            Some(Vec::new())
        } else {
            None
        }),
        history_flow: Mutex::new(()),
        exited: Mutex::new(None),
        controller,
        controller_revision,
        controller_journal: Mutex::new(()),
        last_holder: Mutex::new(None),
        rules_file: std::sync::OnceLock::new(),
        tab_name: std::sync::OnceLock::new(),
        gateway: std::sync::OnceLock::new(),
        profile: std::sync::OnceLock::new(),
        env_names: std::sync::OnceLock::new(),
        payload_file: std::sync::OnceLock::new(), row_key: std::sync::OnceLock::new(),
        queue: Mutex::new(PromptQueue::default()),
        degraded: Mutex::new(None),
        unattended_watched: Mutex::new(std::collections::HashSet::new()),
        stopping: AtomicBool::new(false),
    })
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

mod dispatch;
use dispatch::{PromptQueue, QueuedPrompt};
mod hydrate;
mod history;
mod lease;
mod unattended;

#[cfg(test)]
pub(crate) mod tests;
