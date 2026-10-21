//! Pure reconstruction: journal records in, session state out. No I/O, no
//! clock, no side effects.
//!
//! This is the file that makes hydration safe. Plan v3 requires a rebuilding
//! client to be *mechanically unable* to send, approve, flush, interrupt, or
//! refresh time-derived state — not merely careful about it. The way that is
//! enforced is that reduction lives here, where there is nothing to call: no
//! `Child`, no pipe, no `Instant::now()`, no `AgentTransport`.
//!
//! FROZEN CONTRACT: the types and signatures below are the boundary with
//! `journal.rs`. Do not change them. Do not add an I/O dependency to this
//! file — if reduction appears to need one, the design is wrong and that is
//! worth reporting rather than working around.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::journal::{Body, CodexRecord, JournalError, Record, Snapshot};
use crate::protocol::{EventBody, Outcome};

/// Everything needed to rebuild a live view without touching the child.
///
/// Ordering matters for equality: two states reduced from the same records
/// must compare equal, so collections are ordered (`BTreeMap`, `Vec`), never
/// `HashMap`.
// This whole module is a proven-in-unit-tests, not-yet-wired reducer: no
// production caller hydrates from it live yet.
#[allow(dead_code)]
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
pub struct State {
    pub session: String,
    pub agent: String,
    pub cwd: String,
    pub pid: u32,
    pub generation: u64,
    pub conversation: Option<String>,
    pub model: Option<String>,
    /// The model selected for later Codex turns, not a verified live model.
    #[serde(default)]
    pub policy_model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    pub permission_mode: String,
    /// Published events in order, as the renderer would have received them.
    pub events: Vec<crate::protocol::EventBody>,
    /// Commands that have not settled. Settled ones move to
    /// [`State::settled_commands`].
    pub in_flight: BTreeMap<u64, InFlight>,
    /// The terminal answer for every command that has settled this generation.
    ///
    /// This is the point of [`Outcome::DeliveryUnknown`] existing as a separate
    /// outcome: a client that reconnects must be able to tell "never delivered,
    /// safe to resend" from "may already have produced a turn, do not resend".
    /// If replay dropped the answer, the only way to tell them apart would be to
    /// ask the child again, which is exactly the retry the plan forbids.
    ///
    /// Unbounded, deliberately, like [`State::events`]: the
    /// journal is built "without building compaction", and an answer may not be
    /// discarded on a guess about who has already read it. One entry is a
    /// client name, a command kind, an outcome and an optional message — tens of
    /// bytes against an event log holding whole agent turns, so this is not the
    /// term that decides when compaction becomes urgent.
    pub settled_commands: BTreeMap<u64, Settled>,
    /// Permissions still awaiting a terminal agent record. A failed response
    /// delivery leaves the entry here on purpose.
    pub pending_permissions: BTreeMap<String, Permission>,
    /// Accepted but not yet dispatched, in queue order.
    pub queued_prompts: Vec<QueuedPrompt>,
    /// `Some` once the child has exited.
    pub exited: Option<Option<i32>>,
    /// The client that currently holds the controller lease, or `None` if
    /// nobody does — the session's starting condition, and also what is left
    /// behind by a release, explicit or implicit (the holder's connection
    /// dying). Session-scoped, not child-scoped: unlike `in_flight` and
    /// `pending_permissions`, a new generation does not clear this, because
    /// who is driving the session has nothing to do with which child process
    /// happens to be running underneath it.
    pub controller: Option<String>,
    /// The revision `controller` was last set at. Per `journal.rs`, this is
    /// "the fence a transfer commits against" — a rebuilding client
    /// needs it, not just the holder name, so that a future acquire or
    /// release it sends can be checked against the lease it actually
    /// observed rather than racing a stale view of who holds it.
    pub controller_revision: u64,
    /// Hosted Codex: the latest turn a dispatched prompt was bound to, as
    /// `(prompt, turn)`. Child-scoped like `in_flight`. Not cleared by the
    /// turn's end: that is an agent line, which replay does not interpret.
    #[serde(default)]
    pub codex_turn: Option<(String, String)>,
    /// Highest sequence folded in.
    pub through_seq: u64,
}

#[allow(dead_code)] // see State above: unwired reducer
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct InFlight {
    pub client: String,
    pub kind: String,
    pub payload: serde_json::Value,
}

/// What became of a mutating command, kept after it left [`State::in_flight`].
///
/// `client` and `kind` are carried over from the command's `CommandAccepted`
/// record so a rebuilding client can find its own commands without having kept
/// anything across the disconnect. They are empty when the settle had no
/// matching accepted record in this journal — a shape that should not occur,
/// since the two are paired at append time, but one that must not cost the
/// outcome itself.
#[allow(dead_code)] // see State above: unwired reducer
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Settled {
    pub client: String,
    pub kind: String,
    pub outcome: Outcome,
    pub message: Option<String>,
}

#[allow(dead_code)] // see State above: unwired reducer
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Permission {
    pub tool: String,
    pub input: serde_json::Value,
    pub truncated: bool,
    /// Last non-terminal state seen: `opened` or `responded`.
    pub state: String,
}

#[allow(dead_code)] // see State above: unwired reducer
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct QueuedPrompt {
    pub prompt: String,
    pub content: serde_json::Value,
}

/// The permission lifecycle vocabulary, kept identical to the live driver's
/// (`claude.rs::observe_falcon`). `settled` and `cancelled` are terminal;
/// `failed` is a delivery failure that deliberately re-opens the request
/// rather than dropping it.
// see State above: unwired reducer
#[allow(dead_code)]
const PERMISSION_OPENED: &str = "opened";
#[allow(dead_code)] // unwired reducer, see State
const PERMISSION_RESPONDED: &str = "responded";
/// The sidecar's `canUseTool` callback returned. Deliberately NOT terminal: the
/// SDK writes the control response itself *after* the callback returns, and
/// drops that write silently once its query has cleaned up, so a returned
/// callback is no evidence the CLI ever received the answer.
#[allow(dead_code)]
const PERMISSION_RETURNED: &str = "returned";
#[allow(dead_code)] // unwired reducer, see State
const PERMISSION_SETTLED: &str = "settled";
#[allow(dead_code)] // unwired reducer, see State
const PERMISSION_CANCELLED: &str = "cancelled";
/// The child exited with this request still outstanding. Terminal, and has no
/// sidecar record — only `ClaudeDriver::abandon` produces it.
#[allow(dead_code)]
const PERMISSION_CANCELLED_BY_EXIT: &str = "cancelled-by-exit";
#[allow(dead_code)] // unwired reducer, see State
const PERMISSION_FAILED: &str = "failed";

/// Fold one record into `state`.
///
/// Must be total and deterministic: the same record sequence always yields the
/// same state, with no dependence on wall-clock time or map iteration order.
///
/// Rejects a record that does not continue the sequence — `seq` must be
/// exactly `state.through_seq + 1`. Silently tolerating a gap here would
/// defeat the whole point of the sequence.
///
/// Two rules decide whether the body is applied at all:
/// - **Generation.** A record older than the state's generation is consumed
///   (it still occupies its sequence slot) but must not mutate anything: a
///   dying child's late record may not touch the state of its replacement.
///   A record at or ahead of the current generation applies and the state
///   adopts `record.generation`, so the next older record is rejected by the
///   same rule.
/// - **Reconstructive.** A body [`is_reconstructive`] answers `false` for is a
///   no-op, so a compaction that drops it cannot change the reduced state.
///
/// A third check applies only to `ControllerChanged`, and only to a record
/// that clears both rules above: `session.rs` guarantees the revision is
/// strictly increasing across the whole session, so a record whose revision
/// does not continue past `state.controller_revision` cannot have been
/// written by a correctly behaving host. That is journal corruption, not a
/// gap or a stale generation, and is refused the same way `journal.rs`'s own
/// frame scan refuses damage it cannot make sense of: with
/// [`JournalError::Malformed`], the variant this file had no prior occasion
/// to return itself.
#[allow(dead_code)] // see State above: unwired reducer
pub fn reduce(state: &mut State, record: &Record) -> Result<(), JournalError> {
    let expected = state.through_seq.saturating_add(1);
    if record.seq != expected {
        return Err(JournalError::SequenceGap {
            expected,
            found: record.seq,
        });
    }
    if record.generation >= state.generation && is_reconstructive(&record.body) {
        if let Body::ControllerChanged { revision, .. } = &record.body {
            if *revision <= state.controller_revision {
                return Err(JournalError::Malformed {
                    after_seq: state.through_seq,
                    why: format!(
                        "controller revision {revision} did not advance past {}: \
                         revision is monotonic per session, so this record could \
                         not have been written by a correct host",
                        state.controller_revision
                    ),
                });
            }
        }
        apply(state, record);
    }
    // A stale or non-reconstructive record still consumed its sequence number.
    // Leaving `through_seq` behind would manufacture a gap for the next record.
    state.through_seq = record.seq;
    Ok(())
}

/// Apply an accepted record. `record.at_ms` is deliberately unused: no field of
/// [`State`] is time-derived, which is what makes replay free of a clock.
#[allow(dead_code)] // see State above: unwired reducer
fn apply(state: &mut State, record: &Record) {
    state.generation = record.generation;
    match &record.body {
        Body::Started {
            session,
            agent,
            cwd,
            model,
            permission_mode,
            conversation,
            pid,
        } => {
            state.session = session.clone();
            state.agent = agent.clone();
            state.cwd = cwd.clone();
            state.model = model.clone();
            state.policy_model = model.clone();
            state.effort = None;
            state.permission_mode = permission_mode.clone();
            state.conversation = conversation.clone();
            state.pid = *pid;
            // Child-scoped state cannot survive the child. Commands written to
            // the previous process will never settle, and its permission
            // requests will never reach a terminal state, so a new generation
            // starts with both empty and not exited. The event log and the
            // prompt queue are Falcon's, not the child's, and are preserved.
            state.in_flight.clear();
            state.pending_permissions.clear();
            // Settled answers go too, and for a sharper reason than staleness:
            // command ids come from a per-child counter that restarts at 1
            // (`claude.rs`, `next_command: AtomicU64::new(1)`), so the new
            // generation reuses them. Keeping the old child's answers would let
            // a client read one as the answer to its own command 1 — a wrong
            // answer, which is worse than none. A client cannot carry a command
            // across a generation anyway: `Registry::get_current` refuses a
            // stale generation before the command reaches a child.
            state.settled_commands.clear();
            state.codex_turn = None;
            state.exited = None;
        }
        Body::Event { body } => {
            state.events.push(body.clone());
        }
        Body::CommandAccepted {
            command,
            client,
            kind,
            payload,
        } => {
            state.in_flight.insert(
                *command,
                InFlight {
                    client: client.clone(),
                    kind: kind.clone(),
                    payload: payload.clone(),
                },
            );
        }
        Body::CommandSettled {
            command,
            outcome,
            message,
        } => {
            // Terminal whatever the outcome — `failed` and `delivery-unknown`
            // are answers, not retries, so the command is no longer in flight.
            // The answer is kept: it is what a reconnecting client asks for.
            let accepted = state.in_flight.remove(command);
            if *outcome == Outcome::Applied && state.agent == "codex" {
                if let Some(accepted) = &accepted {
                    match accepted.kind.as_str() {
                        "set_model" => {
                            state.policy_model =
                                accepted.payload["model"].as_str().map(str::to_string);
                        }
                        "set_effort" => {
                            state.effort = accepted.payload["level"].as_str().map(str::to_string);
                        }
                        "set_permission_mode" => {
                            if let Some(mode) = accepted.payload["mode"].as_str() {
                                state.permission_mode = mode.into();
                            }
                        }
                        _ => {}
                    }
                }
            }
            state.settled_commands.insert(
                *command,
                Settled {
                    client: accepted
                        .as_ref()
                        .map(|entry| entry.client.clone())
                        .unwrap_or_default(),
                    kind: accepted
                        .as_ref()
                        .map(|entry| entry.kind.clone())
                        .unwrap_or_default(),
                    outcome: *outcome,
                    message: message.clone(),
                },
            );
        }
        Body::PermissionOpened {
            request,
            tool,
            input,
            truncated,
        } => {
            state.pending_permissions.insert(
                request.clone(),
                Permission {
                    tool: tool.clone(),
                    input: input.clone(),
                    truncated: *truncated,
                    state: PERMISSION_OPENED.to_string(),
                },
            );
        }
        Body::PermissionState {
            request,
            state: next,
        } => match next.as_str() {
            PERMISSION_SETTLED | PERMISSION_CANCELLED | PERMISSION_CANCELLED_BY_EXIT => {
                state.pending_permissions.remove(request);
            }
            // `returned` joins these deliberately: the callback finished, but
            // nothing confirms the CLI received the answer, so the request is
            // still outstanding and a rebuilt UI must still show its card.
            PERMISSION_RESPONDED | PERMISSION_OPENED | PERMISSION_RETURNED => {
                if let Some(entry) = state.pending_permissions.get_mut(request) {
                    entry.state = next.clone();
                }
            }
            PERMISSION_FAILED => {
                // The response never reached the agent, so the request is
                // awaiting one again. Same mapping as the live driver.
                if let Some(entry) = state.pending_permissions.get_mut(request) {
                    entry.state = PERMISSION_OPENED.to_string();
                }
            }
            // An unknown state is not a licence to guess at a terminal one.
            // Leaving the request pending is the safe direction: a card shown
            // for a request the agent has finished with is a cosmetic wart, a
            // card dropped for one it is still blocked on strands the session.
            _ => {}
        },
        Body::PromptQueued { prompt, content } => {
            match state
                .queued_prompts
                .iter_mut()
                .find(|queued| queued.prompt == *prompt)
            {
                // Requeueing a live id keeps its place in the queue; only the
                // content is replaced, so order never depends on a re-send.
                Some(existing) => existing.content = content.clone(),
                None => state.queued_prompts.push(QueuedPrompt {
                    prompt: prompt.clone(),
                    content: content.clone(),
                }),
            }
        }
        // A steered (folded) dispatch retires the prompt exactly like an
        // ordinary one: it reached the child, so a rebuilt view must never
        // offer it again, and nothing re-sends from replay.
        Body::PromptRetracted { prompt }
        | Body::PromptDispatched { prompt, .. }
        | Body::PromptUndelivered { prompt, .. } => {
            state
                .queued_prompts
                .retain(|queued| queued.prompt != *prompt);
        }
        // The live queue put it back at `at` under its lock, after every
        // queue change journaled before it, so the same index lands it in
        // the same place here.
        Body::PromptRequeued {
            prompt,
            content,
            at,
        } => {
            state
                .queued_prompts
                .retain(|queued| queued.prompt != *prompt);
            let at = (*at).min(state.queued_prompts.len());
            state.queued_prompts.insert(
                at,
                QueuedPrompt {
                    prompt: prompt.clone(),
                    content: content.clone(),
                },
            );
        }
        Body::ConversationAdopted { conversation } => {
            state.conversation = Some(conversation.clone());
        }
        Body::ModelChanged { model } => {
            state.model = Some(model.clone());
        }
        Body::PermissionModeChanged { mode } => {
            state.permission_mode = mode.clone();
        }
        Body::ControllerChanged { revision, holder } => {
            // Monotonicity was already checked in `reduce` before this record
            // was allowed to reach `apply`; here the record is trusted.
            state.controller_revision = *revision;
            state.controller = holder.clone();
        }
        Body::Exited { code } => {
            // Only this typed host record sets exit. An `Event { Exit }` is the
            // sidecar's report of the same fact and is logged, not inferred from.
            state.exited = Some(*code);
        }
        // Diagnostic bookkeeping only: it records what the unattended watcher
        // did, not a fact `State` tracks. `PermissionState` records already
        // carry any pending/settled change the deny itself caused.
        Body::PermissionUnattended { .. } => {}
        Body::Codex { codex } => match codex {
            CodexRecord::TurnBound { prompt, turn } => {
                state.codex_turn = Some((prompt.clone(), turn.clone()));
            }
            // This is the policy the dispatched turn carried, even if a
            // later setter changes the policy for another turn.
            CodexRecord::PromptPolicy {
                mode,
                model,
                effort,
                ..
            } => {
                state.permission_mode = mode.clone();
                state.policy_model = model.clone();
                state.effort = effort.clone();
            }
            // A refused start already left the queue with its
            // `PromptDispatched`, and a refused steer comes back with its
            // `PromptRequeued`; the refusal itself is its agent line's to
            // show. A server request the host answered stays closed. A
            // card's late diff is for the view, not `PermissionState`.
            CodexRecord::TurnRefused { .. }
            | CodexRecord::ServerRequestAnswered { .. }
            | CodexRecord::ApprovalDiff { .. } => {}
        },
    }
}

/// Rebuild from an optional snapshot plus the records that follow it.
///
/// `records` must begin at `snapshot.through_seq + 1` (or at 1 when there is
/// no snapshot). A snapshot whose state does not deserialize, or whose
/// `through_seq` does not line up with `records`, is a
/// [`JournalError::SnapshotMismatch`] — never a reason to quietly start over.
#[allow(dead_code)] // see State above: unwired reducer
pub fn hydrate(snapshot: Option<&Snapshot>, records: &[Record]) -> Result<State, JournalError> {
    let mut state = match snapshot {
        Some(snapshot) => {
            let state: State = serde_json::from_value(snapshot.state.clone()).map_err(|error| {
                JournalError::SnapshotMismatch {
                    why: format!(
                        "state at seq {} does not deserialize: {error}",
                        snapshot.through_seq
                    ),
                }
            })?;
            // The header is written beside the body; disagreement means one of
            // the two is from a different session, generation, or moment.
            if state.through_seq != snapshot.through_seq {
                return Err(JournalError::SnapshotMismatch {
                    why: format!(
                        "header says through_seq {}, state says {}",
                        snapshot.through_seq, state.through_seq
                    ),
                });
            }
            if state.session != snapshot.session {
                return Err(JournalError::SnapshotMismatch {
                    why: format!(
                        "header says session {}, state says {}",
                        snapshot.session, state.session
                    ),
                });
            }
            if state.generation != snapshot.generation {
                return Err(JournalError::SnapshotMismatch {
                    why: format!(
                        "header says generation {}, state says {}",
                        snapshot.generation, state.generation
                    ),
                });
            }
            // A snapshot that does not meet the records it is being replayed
            // against fails the attach; starting from zero would hide it.
            if let Some(first) = records.first() {
                if first.seq != snapshot.through_seq.saturating_add(1) {
                    return Err(JournalError::SnapshotMismatch {
                        why: format!(
                            "snapshot at seq {} but records resume at {}",
                            snapshot.through_seq, first.seq
                        ),
                    });
                }
            }
            state
        }
        None => State::default(),
    };
    for record in records {
        reduce(&mut state, record)?;
    }
    Ok(state)
}

/// Capture `state` as a snapshot at its current sequence.
#[allow(dead_code)] // see State above: unwired reducer
pub fn snapshot(state: &State) -> Result<Snapshot, JournalError> {
    let value = serde_json::to_value(state).map_err(|error| JournalError::SnapshotMismatch {
        why: format!(
            "state at seq {} does not serialize: {error}",
            state.through_seq
        ),
    })?;
    Ok(Snapshot {
        session: state.session.clone(),
        through_seq: state.through_seq,
        generation: state.generation,
        state: value,
    })
}

/// Which record bodies are reconstructive. Anything answering `false` here may
/// be dropped from a compacted journal without changing the reduced state, and
/// the reducer must treat it as a no-op.
///
/// Only one body is droppable: a stderr line. `Overflow` stays — it is the
/// only evidence that a child line was dropped, and losing it would make the
/// rebuilt transcript claim a completeness it does not have. `ControllerChanged`
/// stays for the same shape of reason: it is the only record of who holds the
/// lease and at what revision, so dropping one from a compacted journal would
/// let a rebuilt view show a stale or absent controller as current fact.
#[allow(dead_code)] // see State above: unwired reducer
pub fn is_reconstructive(body: &Body) -> bool {
    !matches!(
        body,
        Body::Event {
            body: EventBody::Diagnostic { .. }
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(seq: u64, generation: u64, body: Body) -> Record {
        Record {
            seq,
            generation,
            // Time is carried but never read; the value is arbitrary on purpose.
            at_ms: 1_700_000_000_000 + seq,
            body,
        }
    }

    fn started(session: &str) -> Body {
        Body::Started {
            session: session.into(),
            agent: "claude".into(),
            cwd: r"C:\Work\Example".into(),
            model: Some("sonnet".into()),
            permission_mode: "default".into(),
            conversation: None,
            pid: 4242,
        }
    }

    fn agent_event(text: &str) -> Body {
        Body::Event {
            body: EventBody::Agent {
                line: json!({ "type": "assistant", "text": text }),
            },
        }
    }

    fn fold(records: &[Record]) -> State {
        hydrate(None, records).expect("records fold cleanly")
    }

    #[test]
    fn codex_policy_setters_replay_once_after_applied_settlement() {
        let mut start = started("codex-policy");
        if let Body::Started { agent, model, .. } = &mut start {
            *agent = "codex".into();
            *model = Some("old".into());
        }
        let mut records = vec![record(1, 1, start)];
        for (id, kind, payload) in [
            (2, "set_model", json!({"type":"set_model","model":"new"})),
            (3, "set_effort", json!({"type":"set_effort","level":"high"})),
            (
                4,
                "set_permission_mode",
                json!({"type":"set_permission_mode","mode":"auto"}),
            ),
        ] {
            let next = records.len() as u64 + 1;
            records.push(record(
                next,
                1,
                Body::CommandAccepted {
                    command: id,
                    client: "owner".into(),
                    kind: kind.into(),
                    payload,
                },
            ));
            records.push(record(
                next + 1,
                1,
                Body::CommandSettled {
                    command: id,
                    outcome: Outcome::Applied,
                    message: None,
                },
            ));
        }
        let state = fold(&records);
        assert_eq!(state.model.as_deref(), Some("old"));
        assert_eq!(state.policy_model.as_deref(), Some("new"));
        assert_eq!(state.effort.as_deref(), Some("high"));
        assert_eq!(state.permission_mode, "auto");
        assert_eq!(state.settled_commands.len(), 3);
        assert!(state.in_flight.is_empty());
        let snapshot = snapshot(&state).unwrap();
        assert_eq!(hydrate(Some(&snapshot), &[]).unwrap(), state);
    }

    /// Codex turn records keep their wire shape, bind the latest turn, and a
    /// new generation clears it like any child-scoped state.
    #[test]
    fn codex_turn_records_bind_the_latest_turn_until_a_new_generation() {
        let codex = |codex| Body::Codex { codex };
        let bound = codex(CodexRecord::TurnBound {
            prompt: "p-1".into(),
            turn: "t-1".into(),
        });
        assert_eq!(
            serde_json::to_value(&bound).unwrap(),
            json!({"record": "codex", "codex": {"kind": "turn-bound", "prompt": "p-1", "turn": "t-1"}})
        );
        let policy = codex(CodexRecord::PromptPolicy {
            prompt: "p-2".into(),
            mode: "plan".into(),
            model: None,
            effort: None,
        });
        assert_eq!(
            serde_json::to_value(&policy).unwrap(),
            json!({"record": "codex", "codex": {"kind": "prompt-policy", "prompt": "p-2", "mode": "plan"}})
        );
        let records = vec![
            record(1, 1, started("s")),
            record(2, 1, bound),
            record(3, 1, policy),
            record(
                4,
                1,
                codex(CodexRecord::TurnRefused {
                    prompt: "p-2".into(),
                    reason: "no".into(),
                }),
            ),
        ];
        let state = fold(&records);
        assert_eq!(state.codex_turn, Some(("p-1".into(), "t-1".into())));
        let mut next = records.clone();
        next.push(record(5, 2, started("s")));
        assert_eq!(fold(&next).codex_turn, None);
    }

    /// A sequence exercising every reconstructive body at least once.
    fn full_history() -> Vec<Record> {
        let bodies = vec![
            started("s00000007"),
            Body::ControllerChanged {
                revision: 1,
                holder: Some("vidar".into()),
            },
            Body::Event {
                body: EventBody::Diagnostic {
                    text: "sidecar warming".into(),
                },
            },
            agent_event("hello"),
            Body::ConversationAdopted {
                conversation: "c4ee6c0d-1111-2222-3333-444444444444".into(),
            },
            Body::PromptQueued {
                prompt: "p-1".into(),
                content: json!("first"),
            },
            Body::PromptQueued {
                prompt: "p-2".into(),
                content: json!("second"),
            },
            Body::PromptQueued {
                prompt: "p-3".into(),
                content: json!("third"),
            },
            Body::CommandAccepted {
                command: 11,
                client: "vidar".into(),
                kind: "submit".into(),
                payload: json!({ "content": "first" }),
            },
            Body::PromptDispatched {
                prompt: "p-1".into(),
                steered: false,
            },
            Body::PermissionOpened {
                request: "req-a".into(),
                tool: "Bash".into(),
                input: json!({ "command": "cargo test" }),
                truncated: false,
            },
            Body::PermissionOpened {
                request: "req-b".into(),
                tool: "Edit".into(),
                input: json!({ "path": "replay.rs" }),
                truncated: true,
            },
            Body::PermissionState {
                request: "req-a".into(),
                state: PERMISSION_RESPONDED.into(),
            },
            Body::PermissionState {
                request: "req-a".into(),
                state: PERMISSION_FAILED.into(),
            },
            Body::PermissionState {
                request: "req-b".into(),
                state: PERMISSION_SETTLED.into(),
            },
            Body::CommandSettled {
                command: 11,
                outcome: Outcome::Applied,
                message: None,
            },
            Body::CommandAccepted {
                command: 12,
                client: "vidar".into(),
                kind: "interrupt".into(),
                payload: json!({}),
            },
            Body::CommandAccepted {
                command: 13,
                client: "vidar".into(),
                kind: "submit".into(),
                payload: json!({ "content": "second" }),
            },
            Body::CommandSettled {
                command: 13,
                outcome: Outcome::DeliveryUnknown,
                message: Some("write to child failed after partial send".into()),
            },
            Body::CommandAccepted {
                command: 14,
                client: "other-client".into(),
                kind: "set-model".into(),
                payload: json!({ "model": "opus" }),
            },
            Body::CommandSettled {
                command: 14,
                outcome: Outcome::Failed,
                message: Some("the CLI refused the model".into()),
            },
            Body::ModelChanged {
                model: "opus".into(),
            },
            Body::PermissionModeChanged {
                mode: "acceptEdits".into(),
            },
            Body::PromptRetracted {
                prompt: "p-2".into(),
            },
            Body::Event {
                body: EventBody::Overflow { bytes: 4096 },
            },
            Body::Event {
                body: EventBody::Exit { code: Some(0) },
            },
            Body::Exited { code: Some(0) },
        ];
        bodies
            .into_iter()
            .enumerate()
            .map(|(index, body)| record(index as u64 + 1, 3, body))
            .collect()
    }

    // ---- sequence ------------------------------------------------------

    #[test]
    fn first_record_must_be_sequence_one() {
        let mut state = State::default();
        let error = reduce(&mut state, &record(2, 1, started("s1"))).unwrap_err();
        assert!(
            matches!(
                error,
                JournalError::SequenceGap {
                    expected: 1,
                    found: 2
                }
            ),
            "{error}"
        );
        assert_eq!(state, State::default(), "a rejected record changed state");
    }

    #[test]
    fn an_interior_gap_is_rejected_and_leaves_the_state_at_the_last_good_record() {
        let mut state = State::default();
        reduce(&mut state, &record(1, 1, started("s1"))).unwrap();
        reduce(&mut state, &record(2, 1, agent_event("one"))).unwrap();
        let before = state.clone();
        let error = reduce(&mut state, &record(4, 1, agent_event("three"))).unwrap_err();
        assert!(
            matches!(
                error,
                JournalError::SequenceGap {
                    expected: 3,
                    found: 4
                }
            ),
            "{error}"
        );
        assert_eq!(state, before);
        // And the correct next record still applies afterwards.
        reduce(&mut state, &record(3, 1, agent_event("two"))).unwrap();
        assert_eq!(state.through_seq, 3);
        assert_eq!(state.events.len(), 2);
    }

    #[test]
    fn a_replayed_record_is_a_gap_not_an_idempotent_reapply() {
        let mut state = State::default();
        reduce(&mut state, &record(1, 1, started("s1"))).unwrap();
        let again = record(1, 1, started("s1"));
        let error = reduce(&mut state, &again).unwrap_err();
        assert!(
            matches!(
                error,
                JournalError::SequenceGap {
                    expected: 2,
                    found: 1
                }
            ),
            "{error}"
        );
    }

    #[test]
    fn hydrate_without_a_snapshot_requires_records_to_start_at_one() {
        let records = vec![record(3, 1, agent_event("orphan"))];
        let error = hydrate(None, &records).unwrap_err();
        assert!(
            matches!(
                error,
                JournalError::SequenceGap {
                    expected: 1,
                    found: 3
                }
            ),
            "{error}"
        );
    }

    // ---- generation ----------------------------------------------------

    #[test]
    fn a_stale_generation_record_cannot_mutate_the_replacement() {
        let mut state = State::default();
        reduce(&mut state, &record(1, 4, started("s00000004"))).unwrap();
        reduce(&mut state, &record(2, 4, agent_event("live"))).unwrap();
        let before = state.clone();

        // A late record from the dead child: consumed, ignored.
        reduce(&mut state, &record(3, 3, agent_event("ghost"))).unwrap();
        reduce(&mut state, &record(4, 3, Body::Exited { code: Some(1) })).unwrap();
        reduce(
            &mut state,
            &record(
                5,
                3,
                Body::PermissionOpened {
                    request: "ghost".into(),
                    tool: "Bash".into(),
                    input: json!({}),
                    truncated: false,
                },
            ),
        )
        .unwrap();

        assert_eq!(state.events, before.events);
        assert_eq!(state.exited, None);
        assert!(state.pending_permissions.is_empty());
        assert_eq!(state.generation, 4);
        // The stale records still occupied their sequence slots.
        assert_eq!(state.through_seq, 5);
    }

    #[test]
    fn a_new_generation_clears_child_scoped_state_and_keeps_the_journal_owned_state() {
        let mut state = State::default();
        let setup = [
            started("s00000001"),
            agent_event("before"),
            Body::PromptQueued {
                prompt: "p-1".into(),
                content: json!("queued"),
            },
            Body::CommandAccepted {
                command: 1,
                client: "vidar".into(),
                kind: "submit".into(),
                payload: json!({}),
            },
            Body::CommandAccepted {
                command: 2,
                client: "vidar".into(),
                kind: "interrupt".into(),
                payload: json!({}),
            },
            Body::CommandSettled {
                command: 2,
                outcome: Outcome::DeliveryUnknown,
                message: None,
            },
            Body::PermissionOpened {
                request: "req".into(),
                tool: "Bash".into(),
                input: json!({}),
                truncated: false,
            },
            Body::Exited { code: Some(1) },
        ];
        let after_setup = setup.len() as u64;
        for (index, body) in setup.into_iter().enumerate() {
            reduce(&mut state, &record(index as u64 + 1, 1, body)).unwrap();
        }
        assert_eq!(state.in_flight.len(), 1);
        assert_eq!(state.settled_commands.len(), 1);
        assert_eq!(state.pending_permissions.len(), 1);
        assert_eq!(state.exited, Some(Some(1)));

        reduce(
            &mut state,
            &record(after_setup + 1, 2, started("s00000002")),
        )
        .unwrap();
        assert_eq!(state.generation, 2);
        assert_eq!(state.session, "s00000002");
        assert!(state.in_flight.is_empty(), "commands outlived their child");
        assert!(
            state.settled_commands.is_empty(),
            "answers outlived the command ids they were about"
        );
        assert!(
            state.pending_permissions.is_empty(),
            "permissions outlived their child"
        );
        assert_eq!(state.exited, None);
        // Falcon's own state survives the respawn.
        assert_eq!(state.events.len(), 1);
        assert_eq!(state.queued_prompts.len(), 1);
    }

    #[test]
    fn adopting_a_newer_generation_makes_the_previous_one_stale() {
        let mut state = State::default();
        reduce(&mut state, &record(1, 1, started("s1"))).unwrap();
        // No Started for generation 2; the record still adopts it forward.
        reduce(&mut state, &record(2, 2, agent_event("newer"))).unwrap();
        assert_eq!(state.generation, 2);
        reduce(&mut state, &record(3, 1, agent_event("older"))).unwrap();
        assert_eq!(state.events.len(), 1, "an older record was applied");
    }

    // ---- permissions ---------------------------------------------------

    /// The two states added when the sidecar learned to be honest about
    /// delivery. Handled asymmetrically on purpose, so it is asserted here
    /// rather than assumed.
    #[test]
    fn returned_keeps_a_permission_pending_and_cancelled_by_exit_does_not() {
        let mut state = State::default();
        let mut seq = 0u64;
        let mut feed = |state: &mut State, body: Body| {
            seq += 1;
            reduce(
                state,
                &Record {
                    seq,
                    generation: 1,
                    at_ms: 0,
                    body,
                },
            )
            .expect("reduce")
        };

        feed(
            &mut state,
            Body::PermissionOpened {
                request: "p1".into(),
                tool: "Bash".into(),
                input: serde_json::json!({}),
                truncated: false,
            },
        );
        feed(
            &mut state,
            Body::PermissionState {
                request: "p1".into(),
                state: PERMISSION_RETURNED.into(),
            },
        );
        assert!(
            state.pending_permissions.contains_key("p1"),
            "a returned callback proves nothing about delivery; the request is still outstanding"
        );
        assert_eq!(
            state.pending_permissions["p1"].state, PERMISSION_RETURNED,
            "the state is still recorded, just not treated as terminal"
        );

        feed(
            &mut state,
            Body::PermissionState {
                request: "p1".into(),
                state: PERMISSION_CANCELLED_BY_EXIT.into(),
            },
        );
        assert!(
            !state.pending_permissions.contains_key("p1"),
            "the child exited; this request can never be answered"
        );
    }

    #[test]
    fn a_failed_delivery_leaves_the_permission_pending_and_awaiting_a_response() {
        let mut state = State::default();
        reduce(&mut state, &record(1, 1, started("s1"))).unwrap();
        reduce(
            &mut state,
            &record(
                2,
                1,
                Body::PermissionOpened {
                    request: "req-a".into(),
                    tool: "Bash".into(),
                    input: json!({ "command": "rm -rf" }),
                    truncated: false,
                },
            ),
        )
        .unwrap();
        reduce(
            &mut state,
            &record(
                3,
                1,
                Body::PermissionState {
                    request: "req-a".into(),
                    state: PERMISSION_RESPONDED.into(),
                },
            ),
        )
        .unwrap();
        assert_eq!(
            state.pending_permissions["req-a"].state,
            PERMISSION_RESPONDED
        );

        reduce(
            &mut state,
            &record(
                4,
                1,
                Body::PermissionState {
                    request: "req-a".into(),
                    state: PERMISSION_FAILED.into(),
                },
            ),
        )
        .unwrap();
        let entry = state
            .pending_permissions
            .get("req-a")
            .expect("a failed delivery dropped the pending permission");
        assert_eq!(entry.state, PERMISSION_OPENED);
        assert_eq!(entry.tool, "Bash");
        assert!(!entry.truncated);
    }

    #[test]
    fn terminal_permission_states_remove_the_entry() {
        for terminal in [PERMISSION_SETTLED, PERMISSION_CANCELLED] {
            let mut state = State::default();
            reduce(&mut state, &record(1, 1, started("s1"))).unwrap();
            reduce(
                &mut state,
                &record(
                    2,
                    1,
                    Body::PermissionOpened {
                        request: "req".into(),
                        tool: "Edit".into(),
                        input: json!({}),
                        truncated: true,
                    },
                ),
            )
            .unwrap();
            reduce(
                &mut state,
                &record(
                    3,
                    1,
                    Body::PermissionState {
                        request: "req".into(),
                        state: terminal.into(),
                    },
                ),
            )
            .unwrap();
            assert!(
                state.pending_permissions.is_empty(),
                "{terminal} left the permission pending"
            );
        }
    }

    /// The unattended watcher's own record is diagnostic: it survives replay
    /// (unlike a stderr line) but never moves `pending_permissions` — only a
    /// `PermissionState` record does that, and the deny it dispatches
    /// produces one of those separately.
    #[test]
    fn permission_unattended_records_replay_without_changing_pending() {
        let mut state = State::default();
        reduce(&mut state, &record(1, 1, started("s1"))).unwrap();
        reduce(
            &mut state,
            &record(
                2,
                1,
                Body::PermissionOpened {
                    request: "req".into(),
                    tool: "Bash".into(),
                    input: json!({}),
                    truncated: false,
                },
            ),
        )
        .unwrap();
        let before = state.pending_permissions.clone();

        reduce(
            &mut state,
            &record(
                3,
                1,
                Body::PermissionUnattended {
                    request: "req".into(),
                    outcome: "shown".into(),
                    reason: None,
                },
            ),
        )
        .unwrap();
        assert_eq!(
            state.pending_permissions, before,
            "shown must not move pending state"
        );

        reduce(
            &mut state,
            &record(
                4,
                1,
                Body::PermissionUnattended {
                    request: "req".into(),
                    outcome: "denied-timeout".into(),
                    reason: Some("denied by falcon".into()),
                },
            ),
        )
        .unwrap();
        assert_eq!(
            state.pending_permissions, before,
            "denied-timeout must not move pending state either; the deny's own \
             PermissionState record does that"
        );
        assert_eq!(
            state.through_seq, 4,
            "the record still consumes a sequence number"
        );
    }

    #[test]
    fn permission_states_for_unknown_or_unknown_named_requests_are_no_ops() {
        let mut state = State::default();
        reduce(&mut state, &record(1, 1, started("s1"))).unwrap();
        reduce(
            &mut state,
            &record(
                2,
                1,
                Body::PermissionOpened {
                    request: "req".into(),
                    tool: "Bash".into(),
                    input: json!({}),
                    truncated: false,
                },
            ),
        )
        .unwrap();
        let before = state.clone();

        // Unknown request id.
        reduce(
            &mut state,
            &record(
                3,
                1,
                Body::PermissionState {
                    request: "nobody".into(),
                    state: PERMISSION_RESPONDED.into(),
                },
            ),
        )
        .unwrap();
        // Unknown state name: not a licence to guess at terminal.
        reduce(
            &mut state,
            &record(
                4,
                1,
                Body::PermissionState {
                    request: "req".into(),
                    state: "wobbled".into(),
                },
            ),
        )
        .unwrap();
        assert_eq!(state.pending_permissions, before.pending_permissions);
        assert_eq!(state.through_seq, 4);
    }

    // ---- commands ------------------------------------------------------

    #[test]
    fn every_outcome_settles_a_command_out_of_flight() {
        for outcome in [Outcome::Applied, Outcome::Failed, Outcome::DeliveryUnknown] {
            let mut state = State::default();
            reduce(&mut state, &record(1, 1, started("s1"))).unwrap();
            reduce(
                &mut state,
                &record(
                    2,
                    1,
                    Body::CommandAccepted {
                        command: 9,
                        client: "vidar".into(),
                        kind: "submit".into(),
                        payload: json!({ "content": "hi" }),
                    },
                ),
            )
            .unwrap();
            assert_eq!(state.in_flight[&9].kind, "submit");
            reduce(
                &mut state,
                &record(
                    3,
                    1,
                    Body::CommandSettled {
                        command: 9,
                        outcome,
                        message: Some("done".into()),
                    },
                ),
            )
            .unwrap();
            assert!(
                state.in_flight.is_empty(),
                "{outcome:?} left the command in flight"
            );
            assert_eq!(
                state.settled_commands[&9],
                Settled {
                    client: "vidar".into(),
                    kind: "submit".into(),
                    outcome,
                    message: Some("done".into()),
                },
                "{outcome:?} was not kept as the command's answer"
            );
        }
    }

    #[test]
    fn a_rebuilt_client_can_tell_delivery_unknown_from_failed() {
        // The reason DeliveryUnknown is a separate outcome: "never delivered,
        // safe to resend" must survive replay distinguishably from "may already
        // have produced a turn, do not resend".
        let state = fold(&full_history());
        assert_eq!(
            state.settled_commands[&13].outcome,
            Outcome::DeliveryUnknown
        );
        assert_eq!(
            state.settled_commands[&13].message.as_deref(),
            Some("write to child failed after partial send")
        );
        assert_eq!(state.settled_commands[&14].outcome, Outcome::Failed);
        assert_ne!(
            state.settled_commands[&13].outcome,
            state.settled_commands[&14].outcome
        );

        // And it survives the snapshot boundary, which is where a reconnecting
        // client actually reads it from.
        let taken = snapshot(&state).expect("snapshot");
        let rebuilt = hydrate(Some(&taken), &[]).expect("hydrate");
        assert_eq!(rebuilt.settled_commands, state.settled_commands);
    }

    #[test]
    fn the_answer_carries_who_sent_the_command_and_what_it_was() {
        let state = fold(&full_history());
        assert_eq!(state.settled_commands[&14].client, "other-client");
        assert_eq!(state.settled_commands[&14].kind, "set-model");
        // The payload is not carried: these entries are unbounded, and the
        // client already knows what it sent.
        assert_eq!(state.in_flight[&12].payload, json!({}));
    }

    #[test]
    fn a_settle_without_an_accepted_record_still_keeps_its_answer() {
        let mut state = State::default();
        reduce(&mut state, &record(1, 1, started("s1"))).unwrap();
        reduce(
            &mut state,
            &record(
                2,
                1,
                Body::CommandSettled {
                    command: 5,
                    outcome: Outcome::DeliveryUnknown,
                    message: Some("orphan".into()),
                },
            ),
        )
        .unwrap();
        let answer = &state.settled_commands[&5];
        assert_eq!(answer.outcome, Outcome::DeliveryUnknown);
        assert_eq!(answer.message.as_deref(), Some("orphan"));
        // Unknown rather than invented.
        assert!(answer.client.is_empty());
        assert!(answer.kind.is_empty());
    }

    #[test]
    fn exit_is_taken_from_the_typed_record_not_inferred_from_the_event() {
        let mut state = State::default();
        reduce(&mut state, &record(1, 1, started("s1"))).unwrap();
        reduce(
            &mut state,
            &record(
                2,
                1,
                Body::Event {
                    body: EventBody::Exit { code: Some(3) },
                },
            ),
        )
        .unwrap();
        assert_eq!(
            state.exited, None,
            "exit was inferred from a published event"
        );
        assert_eq!(state.events.len(), 1);
        reduce(&mut state, &record(3, 1, Body::Exited { code: Some(3) })).unwrap();
        assert_eq!(state.exited, Some(Some(3)));
    }

    // ---- controller ------------------------------------------------------

    #[test]
    fn acquisition_then_release_leaves_no_holder_but_keeps_the_advanced_revision() {
        let mut state = State::default();
        assert_eq!(state.controller, None);
        assert_eq!(state.controller_revision, 0);

        reduce(&mut state, &record(1, 1, started("s1"))).unwrap();
        reduce(
            &mut state,
            &record(
                2,
                1,
                Body::ControllerChanged {
                    revision: 1,
                    holder: Some("vidar".into()),
                },
            ),
        )
        .unwrap();
        assert_eq!(state.controller.as_deref(), Some("vidar"));
        assert_eq!(state.controller_revision, 1);

        // The implicit release when the controlling connection dies looks the
        // same on the wire as an explicit one: `holder` goes to `None`.
        reduce(
            &mut state,
            &record(
                3,
                1,
                Body::ControllerChanged {
                    revision: 2,
                    holder: None,
                },
            ),
        )
        .unwrap();
        assert_eq!(
            state.controller, None,
            "the lease was released but the holder stuck around"
        );
        assert_eq!(
            state.controller_revision, 2,
            "release is a lease change like acquisition and must advance the fence"
        );
    }

    #[test]
    fn a_second_acquisition_after_a_release_is_reflected_correctly() {
        let mut state = State::default();
        reduce(&mut state, &record(1, 1, started("s1"))).unwrap();
        for (seq, revision, holder) in [(2, 1, Some("vidar")), (3, 2, None), (4, 3, Some("astra"))]
        {
            reduce(
                &mut state,
                &record(
                    seq,
                    1,
                    Body::ControllerChanged {
                        revision,
                        holder: holder.map(str::to_string),
                    },
                ),
            )
            .unwrap();
        }
        assert_eq!(
            state.controller.as_deref(),
            Some("astra"),
            "the second acquirer, not the first, is the current holder"
        );
        assert_eq!(state.controller_revision, 3);
    }

    #[test]
    fn a_backwards_or_repeated_revision_is_refused_rather_than_accepted() {
        for bad_revision in [1u64, 0u64] {
            let mut state = State::default();
            reduce(&mut state, &record(1, 1, started("s1"))).unwrap();
            reduce(
                &mut state,
                &record(
                    2,
                    1,
                    Body::ControllerChanged {
                        revision: 1,
                        holder: Some("vidar".into()),
                    },
                ),
            )
            .unwrap();
            let before = state.clone();

            let error = reduce(
                &mut state,
                &record(
                    3,
                    1,
                    Body::ControllerChanged {
                        revision: bad_revision,
                        holder: Some("astra".into()),
                    },
                ),
            )
            .unwrap_err();
            assert!(
                matches!(error, JournalError::Malformed { after_seq: 2, .. }),
                "revision {bad_revision} after 1 should be refused as corruption: {error}"
            );
            assert_eq!(
                state, before,
                "a refused record must not have mutated the state, including through_seq"
            );
        }
    }

    // ---- prompt queue --------------------------------------------------

    #[test]
    fn the_queue_keeps_its_order_across_retract_and_dispatch() {
        let mut state = State::default();
        let bodies = vec![
            started("s1"),
            Body::PromptQueued {
                prompt: "p-1".into(),
                content: json!("one"),
            },
            Body::PromptQueued {
                prompt: "p-2".into(),
                content: json!("two"),
            },
            Body::PromptQueued {
                prompt: "p-3".into(),
                content: json!("three"),
            },
            Body::PromptQueued {
                prompt: "p-4".into(),
                content: json!("four"),
            },
            Body::PromptRetracted {
                prompt: "p-2".into(),
            },
            Body::PromptDispatched {
                prompt: "p-1".into(),
                steered: false,
            },
            // Retracting something already gone is not an error.
            Body::PromptRetracted {
                prompt: "p-2".into(),
            },
            Body::PromptQueued {
                prompt: "p-5".into(),
                content: json!("five"),
            },
        ];
        for (index, body) in bodies.into_iter().enumerate() {
            reduce(&mut state, &record(index as u64 + 1, 1, body)).unwrap();
        }
        let order: Vec<&str> = state
            .queued_prompts
            .iter()
            .map(|queued| queued.prompt.as_str())
            .collect();
        assert_eq!(order, ["p-3", "p-4", "p-5"]);
        assert_eq!(state.queued_prompts[0].content, json!("three"));
    }

    #[test]
    fn requeueing_a_live_id_keeps_its_place_and_replaces_its_content() {
        let mut state = State::default();
        let bodies = vec![
            started("s1"),
            Body::PromptQueued {
                prompt: "p-1".into(),
                content: json!("one"),
            },
            Body::PromptQueued {
                prompt: "p-2".into(),
                content: json!("two"),
            },
            Body::PromptQueued {
                prompt: "p-1".into(),
                content: json!("one, edited"),
            },
        ];
        for (index, body) in bodies.into_iter().enumerate() {
            reduce(&mut state, &record(index as u64 + 1, 1, body)).unwrap();
        }
        assert_eq!(state.queued_prompts.len(), 2);
        assert_eq!(state.queued_prompts[0].prompt, "p-1");
        assert_eq!(state.queued_prompts[0].content, json!("one, edited"));
        assert_eq!(state.queued_prompts[1].prompt, "p-2");
    }

    // ---- snapshot ------------------------------------------------------

    #[test]
    fn snapshot_plus_later_records_equals_replaying_everything() {
        let records = full_history();
        let whole = fold(&records);
        // Every cut point, not just a convenient one.
        for cut in 0..=records.len() {
            let prefix = fold(&records[..cut]);
            let taken = snapshot(&prefix).expect("snapshot");
            assert_eq!(taken.through_seq, cut as u64);
            let rebuilt = hydrate(Some(&taken), &records[cut..])
                .unwrap_or_else(|error| panic!("hydrate at cut {cut}: {error}"));
            assert_eq!(rebuilt, whole, "cut {cut} diverged from a full replay");
        }
    }

    #[test]
    fn a_snapshot_with_no_following_records_hydrates_to_itself() {
        let records = full_history();
        let whole = fold(&records);
        let taken = snapshot(&whole).expect("snapshot");
        assert_eq!(hydrate(Some(&taken), &[]).unwrap(), whole);
    }

    #[test]
    fn a_snapshot_of_a_snapshot_is_stable() {
        let records = full_history();
        let whole = fold(&records);
        let once = snapshot(&whole).expect("snapshot");
        let rebuilt = hydrate(Some(&once), &[]).expect("hydrate");
        let twice = snapshot(&rebuilt).expect("snapshot");
        assert_eq!(once, twice);
    }

    #[test]
    fn a_snapshot_state_that_does_not_deserialize_is_a_mismatch() {
        let mut broken = snapshot(&fold(&full_history())).expect("snapshot");
        broken.state = json!({ "session": "s1", "nonsense": true });
        let error = hydrate(Some(&broken), &[]).unwrap_err();
        assert!(
            matches!(error, JournalError::SnapshotMismatch { .. }),
            "{error}"
        );

        let mut not_even_an_object = broken.clone();
        not_even_an_object.state = json!("truncated write");
        let error = hydrate(Some(&not_even_an_object), &[]).unwrap_err();
        assert!(
            matches!(error, JournalError::SnapshotMismatch { .. }),
            "{error}"
        );
    }

    #[test]
    fn a_snapshot_header_that_disagrees_with_its_state_is_a_mismatch() {
        let state = fold(&full_history());
        for mutate in [
            (|snapshot: &mut Snapshot| snapshot.through_seq += 1) as fn(&mut Snapshot),
            |snapshot: &mut Snapshot| snapshot.session = "s-elsewhere".into(),
            |snapshot: &mut Snapshot| snapshot.generation += 1,
        ] {
            let mut taken = snapshot(&state).expect("snapshot");
            mutate(&mut taken);
            let error = hydrate(Some(&taken), &[]).unwrap_err();
            assert!(
                matches!(error, JournalError::SnapshotMismatch { .. }),
                "{error}"
            );
        }
    }

    #[test]
    fn records_that_do_not_meet_the_snapshot_are_a_mismatch_not_a_fresh_start() {
        let records = full_history();
        let prefix = fold(&records[..5]);
        let taken = snapshot(&prefix).expect("snapshot");

        // A hole between the snapshot and the records.
        let error = hydrate(Some(&taken), &records[6..]).unwrap_err();
        assert!(
            matches!(error, JournalError::SnapshotMismatch { .. }),
            "{error}"
        );
        // Records that start before the snapshot: already folded in.
        let error = hydrate(Some(&taken), &records[3..]).unwrap_err();
        assert!(
            matches!(error, JournalError::SnapshotMismatch { .. }),
            "{error}"
        );
        // And the aligned case still works.
        assert_eq!(
            hydrate(Some(&taken), &records[5..]).unwrap(),
            fold(&records)
        );
    }

    #[test]
    fn a_gap_inside_the_records_after_a_snapshot_is_still_a_sequence_gap() {
        let records = full_history();
        let taken = snapshot(&fold(&records[..5])).expect("snapshot");
        let mut tail = records[5..].to_vec();
        tail.remove(1);
        let error = hydrate(Some(&taken), &tail).unwrap_err();
        assert!(matches!(error, JournalError::SequenceGap { .. }), "{error}");
    }

    // ---- determinism ---------------------------------------------------

    #[test]
    fn the_same_records_always_reduce_to_the_same_state() {
        let records = full_history();
        let first = fold(&records);
        let second = fold(&records);
        assert_eq!(first, second);
        // Ordered collections mean the serialized form is stable too, which is
        // what makes a snapshot comparable at all.
        assert_eq!(
            serde_json::to_string(&snapshot(&first).unwrap()).unwrap(),
            serde_json::to_string(&snapshot(&second).unwrap()).unwrap()
        );
    }

    #[test]
    fn map_contents_serialize_in_key_order_regardless_of_insertion_order() {
        let mut forwards = State::default();
        let mut backwards = State::default();
        let ids = [30u64, 10, 20];
        for (index, command) in ids.iter().enumerate() {
            reduce(
                &mut forwards,
                &record(
                    index as u64 + 1,
                    1,
                    Body::CommandAccepted {
                        command: *command,
                        client: "vidar".into(),
                        kind: "submit".into(),
                        payload: json!({}),
                    },
                ),
            )
            .unwrap();
        }
        for (index, command) in ids.iter().rev().enumerate() {
            reduce(
                &mut backwards,
                &record(
                    index as u64 + 1,
                    1,
                    Body::CommandAccepted {
                        command: *command,
                        client: "vidar".into(),
                        kind: "submit".into(),
                        payload: json!({}),
                    },
                ),
            )
            .unwrap();
        }
        assert_eq!(forwards, backwards);
        assert_eq!(
            forwards.in_flight.keys().copied().collect::<Vec<_>>(),
            [10, 20, 30]
        );
    }

    // ---- compaction ----------------------------------------------------

    /// Exhaustive on purpose: a new [`Body`] variant must fail to compile here
    /// until it is classified and covered by `every_body_variant()`.
    fn variant_name(body: &Body) -> &'static str {
        match body {
            Body::Started { .. } => "started",
            Body::Event { .. } => "event",
            Body::CommandAccepted { .. } => "command-accepted",
            Body::CommandSettled { .. } => "command-settled",
            Body::PermissionOpened { .. } => "permission-opened",
            Body::PermissionState { .. } => "permission-state",
            Body::PromptQueued { .. } => "prompt-queued",
            Body::PromptRetracted { .. } => "prompt-retracted",
            Body::PromptDispatched { .. } => "prompt-dispatched",
            Body::PromptRequeued { .. } => "prompt-requeued",
            Body::PromptUndelivered { .. } => "prompt-undelivered",
            Body::ConversationAdopted { .. } => "conversation-adopted",
            Body::ModelChanged { .. } => "model-changed",
            Body::PermissionModeChanged { .. } => "permission-mode-changed",
            Body::ControllerChanged { .. } => "controller-changed",
            Body::Exited { .. } => "exited",
            Body::PermissionUnattended { .. } => "permission-unattended",
            Body::Codex { .. } => "codex",
        }
    }

    fn every_body_variant() -> Vec<Body> {
        vec![
            started("s1"),
            agent_event("line"),
            Body::Event {
                body: EventBody::Diagnostic {
                    text: "stderr".into(),
                },
            },
            Body::Event {
                body: EventBody::Overflow { bytes: 1 },
            },
            Body::Event {
                body: EventBody::Exit { code: None },
            },
            Body::CommandAccepted {
                command: 1,
                client: "vidar".into(),
                kind: "submit".into(),
                payload: json!({}),
            },
            Body::CommandSettled {
                command: 1,
                outcome: Outcome::Applied,
                message: None,
            },
            Body::PermissionOpened {
                request: "req".into(),
                tool: "Bash".into(),
                input: json!({}),
                truncated: false,
            },
            Body::PermissionState {
                request: "req".into(),
                state: PERMISSION_SETTLED.into(),
            },
            Body::PromptQueued {
                prompt: "p".into(),
                content: json!("text"),
            },
            Body::PromptRetracted { prompt: "p".into() },
            Body::PromptDispatched {
                prompt: "p".into(),
                steered: true,
            },
            Body::PromptRequeued {
                prompt: "p".into(),
                content: json!("text"),
                at: 0,
            },
            Body::PromptUndelivered {
                prompt: "p".into(),
                reason: "pipe closed".into(),
            },
            Body::ConversationAdopted {
                conversation: "c4ee6c0d-1111-2222-3333-444444444444".into(),
            },
            Body::ModelChanged {
                model: "opus".into(),
            },
            Body::PermissionModeChanged {
                mode: "plan".into(),
            },
            Body::ControllerChanged {
                revision: 1,
                holder: Some("vidar".into()),
            },
            Body::Exited { code: Some(0) },
            Body::PermissionUnattended {
                request: "req".into(),
                outcome: "denied-timeout".into(),
                reason: Some("no outcome for command 1 within 30s".into()),
            },
            Body::Codex {
                codex: CodexRecord::TurnBound {
                    prompt: "p".into(),
                    turn: "t".into(),
                },
            },
        ]
    }

    #[test]
    fn the_variant_list_covers_every_body() {
        let mut seen: Vec<&'static str> = every_body_variant()
            .iter()
            .map(variant_name)
            .collect::<Vec<_>>();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(
            seen.len(),
            18,
            "every_body_variant() no longer covers every Body variant: {seen:?}"
        );
    }

    #[test]
    fn a_non_reconstructive_body_changes_nothing_but_the_sequence() {
        for body in every_body_variant() {
            if is_reconstructive(&body) {
                continue;
            }
            // Reduce it into a state with something to disturb.
            let mut state = fold(&full_history());
            let before = state.clone();
            let seq = state.through_seq + 1;
            let generation = state.generation;
            reduce(&mut state, &record(seq, generation, body.clone())).unwrap();
            state.through_seq = before.through_seq;
            assert_eq!(
                state,
                before,
                "{} is droppable but mutated the state",
                variant_name(&body)
            );
        }
    }

    #[test]
    fn dropping_the_non_reconstructive_records_leaves_the_same_state() {
        let records = full_history();
        let full = fold(&records);

        // Compaction: drop the droppable bodies and renumber densely, which is
        // what a compacted journal looks like.
        let compacted: Vec<Record> = records
            .iter()
            .filter(|record| is_reconstructive(&record.body))
            .enumerate()
            .map(|(index, record)| Record {
                seq: index as u64 + 1,
                ..record.clone()
            })
            .collect();
        assert!(
            compacted.len() < records.len(),
            "the fixture has no droppable records to prove anything with"
        );

        let mut rebuilt = fold(&compacted);
        assert_ne!(rebuilt.through_seq, full.through_seq);
        // Sequence is journal bookkeeping, not reconstructed state; everything
        // else must match exactly.
        rebuilt.through_seq = full.through_seq;
        assert_eq!(rebuilt, full);
    }

    #[test]
    fn only_the_stderr_event_is_droppable() {
        for body in every_body_variant() {
            let droppable = !is_reconstructive(&body);
            let expected = matches!(
                &body,
                Body::Event {
                    body: EventBody::Diagnostic { .. }
                }
            );
            assert_eq!(
                droppable,
                expected,
                "{} classified wrongly",
                variant_name(&body)
            );
        }
    }

    #[test]
    fn a_diagnostic_line_never_reaches_the_published_event_log() {
        let state = fold(&full_history());
        assert!(
            !state
                .events
                .iter()
                .any(|event| matches!(event, EventBody::Diagnostic { .. })),
            "a droppable event was reduced into the event log"
        );
        // Overflow is kept: it is the only record that a line was lost.
        assert!(state
            .events
            .iter()
            .any(|event| matches!(event, EventBody::Overflow { .. })));
    }

    // ---- a whole history -----------------------------------------------

    #[test]
    fn a_full_history_reduces_to_the_state_a_client_would_rebuild() {
        let state = fold(&full_history());
        assert_eq!(state.session, "s00000007");
        assert_eq!(state.agent, "claude");
        assert_eq!(state.pid, 4242);
        assert_eq!(state.generation, 3);
        assert_eq!(
            state.conversation.as_deref(),
            Some("c4ee6c0d-1111-2222-3333-444444444444")
        );
        assert_eq!(state.model.as_deref(), Some("opus"));
        assert_eq!(state.permission_mode, "acceptEdits");
        assert_eq!(state.through_seq, 27);
        assert_eq!(state.exited, Some(Some(0)));
        assert_eq!(state.controller.as_deref(), Some("vidar"));
        assert_eq!(state.controller_revision, 1);
        // p-1 dispatched, p-2 retracted.
        let order: Vec<&str> = state
            .queued_prompts
            .iter()
            .map(|queued| queued.prompt.as_str())
            .collect();
        assert_eq!(order, ["p-3"]);
        // req-a responded then failed delivery: still pending, re-opened.
        // req-b settled: gone.
        assert_eq!(state.pending_permissions.len(), 1);
        assert_eq!(state.pending_permissions["req-a"].state, PERMISSION_OPENED);
        // Command 12 still in flight; 11, 13 and 14 settled with their answers.
        assert_eq!(state.in_flight.keys().copied().collect::<Vec<_>>(), [12]);
        assert_eq!(
            state.settled_commands.keys().copied().collect::<Vec<_>>(),
            [11, 13, 14]
        );
        assert_eq!(state.settled_commands[&11].outcome, Outcome::Applied);
        // Three published events: the agent line, the overflow, the exit. The
        // stderr diagnostic is not one of them.
        assert_eq!(state.events.len(), 3);
    }
}
