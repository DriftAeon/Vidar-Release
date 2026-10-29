//! Handing queued prompts to the child: one per turn (`pump`) and a steer
//! into the running turn (`steer_prompt`). Split from `session.rs`: the write
//! order and the in-flight accounting are their own concern; the queue itself
//! stays on [`Session`].
//!
//! The order is record, then write. `PromptDispatched` is journaled under the
//! queue lock before the line goes to the child, so no line the child answers
//! with (Codex's `turn/started`, a turn's end) can reach the journal or an
//! attaching client ahead of it, and a host that dies mid-write still left the
//! dispatch fact. A dispatch the child never took is withdrawn by a second
//! record: `PromptRequeued` when the prompt goes back to the queue (a steer),
//! `PromptUndelivered` when it leaves it (`pump`, whose caller is told).

use super::{lock, AgentDriver, Dispatched, Session};
use crate::journal::{Body, Record, LONE_RECORD_CAP};
use crate::protocol::EventBody;

/// Falcon's prompt queue for one session.
///
/// `pump` hands the child exactly one prompt per turn. Anything else and the
/// agent interleaves turns, and a retraction becomes meaningless because
/// everything is already in flight. The one exception is an explicit steer,
/// which the user asked to fold into the running turn.
#[derive(Default)]
pub(super) struct PromptQueue {
    pub(super) waiting: std::collections::VecDeque<QueuedPrompt>,
    /// The prompts the running turn holds: the one `pump` started it with,
    /// then any [`Session::steer_prompt`] folded into it. A turn is in flight
    /// while this is non-empty, which is what stops `pump` from dispatching
    /// the next prompt; the turn's `result` clears all of them at once,
    /// because a folded prompt ends with the turn it joined.
    ///
    /// Journal side: every entry has exactly one `PromptDispatched` record,
    /// `steered: true` for a fold. Replay retires a dispatched prompt from the
    /// queue whatever the flag, and nothing re-sends from the journal (a host
    /// restart ends the child), so a folded prompt is never delivered twice.
    /// One the agent never took is put back by a `PromptRequeued`.
    pub(super) in_flight: Vec<String>,
    /// Folded prompts the agent may still refuse (hosted Codex answers a
    /// `turn/steer`, possibly after the turn it named has ended): kept so a
    /// refusal puts the prompt back where it was (`requeue_refused_steers`).
    /// One still unanswered at the next turn end, or at the child's close,
    /// is released then (`release_unanswered`).
    pub(super) folded: std::collections::HashMap<String, QueuedPrompt>,
    /// The next prompt's place in submission order.
    pub(super) next_order: u64,
}

impl PromptQueue {
    /// Where a prompt taken out of the queue goes back: before the first
    /// waiting prompt submitted after it, so the order it was queued in holds.
    fn place_of(&self, held: &QueuedPrompt) -> usize {
        self.waiting
            .iter()
            .position(|waiting| waiting.order > held.order)
            .unwrap_or(self.waiting.len())
    }
}

#[derive(Clone)]
pub(super) struct QueuedPrompt {
    pub(super) id: String,
    pub(super) content: serde_json::Value,
    /// Submission order, for putting it back (`PromptQueue::place_of`).
    pub(super) order: u64,
}

impl Session {
    /// The child finished a turn; the next queued prompt may go. Clears every
    /// prompt the turn held, folded ones included; a fold whose steer the
    /// agent has not answered yet stays refusable past its turn's end. One
    /// still unanswered from the turn before this one is released here.
    pub fn turn_finished(&self) {
        let mut queue = lock(&self.queue);
        queue.in_flight.clear();
        let released = self.release_unanswered(&mut queue, UNANSWERED_BY_TURN_END);
        queue
            .folded
            .retain(|prompt, _| self.driver.steer_pending(prompt));
        drop(queue);
        announce_unanswered(self, &released, UNANSWERED_BY_TURN_END);
    }

    /// The child closed its stdout: no steer it has not answered will be
    /// answered, so the ones the driver released go as `turn_finished`'s do.
    /// Called by the stdout reader after `stdout_closed`.
    pub fn release_unanswered_steers(&self) {
        let mut queue = lock(&self.queue);
        let released = self.release_unanswered(&mut queue, UNANSWERED_BY_CLOSE);
        drop(queue);
        announce_unanswered(self, &released, UNANSWERED_BY_CLOSE);
    }

    /// Journal every folded prompt the driver released unanswered as
    /// `PromptUndelivered`, under the queue lock. Not requeued: the agent
    /// may have applied it, and a re-sent prompt would duplicate a real user
    /// turn. Returns the prompts released, for `announce_unanswered`.
    fn release_unanswered(&self, queue: &mut PromptQueue, reason: &str) -> Vec<String> {
        let mut released = Vec::new();
        for prompt in self.driver.take_unanswered_steers() {
            if queue.folded.remove(&prompt).is_none() {
                continue;
            }
            self.record_quietly(Body::PromptUndelivered {
                prompt: prompt.clone(),
                reason: reason.into(),
            });
            released.push(prompt);
        }
        released
    }

    /// Hand the child the next prompt, if it is free to take one.
    ///
    /// **Never call this from the stdout reader thread's blocking path.** It
    /// writes to the child but deliberately does NOT wait for the sidecar's
    /// terminal outcome: that outcome arrives on stdout, so waiting for it
    /// from the reader would deadlock the session against itself. The client
    /// already has its answer — the prompt was accepted onto the queue — so
    /// there is nothing here that needs the round trip.
    pub fn pump(&self) -> Dispatched {
        let mut queue = lock(&self.queue);
        if !queue.in_flight.is_empty() {
            return Dispatched::Idle;
        }
        let Some(next) = queue.waiting.pop_front() else {
            return Dispatched::Idle;
        };
        // `submit` refuses a prompt the driver cannot start before queuing
        // it, so this is a backstop; it fails like a refused write.
        let encoded = match self
            .driver
            .prompt_line(&next.id, &next.content)
            .and_then(|line| encode(&line))
        {
            Ok(encoded) => encoded,
            Err(why) => {
                self.driver.dispatched(&next.id, false);
                self.record_quietly(Body::PromptUndelivered {
                    prompt: next.id.clone(),
                    reason: why.clone(),
                });
                return Dispatched::Failed(next.id, why);
            }
        };
        // `submit` measured hosted Codex's `turn/start` with the model,
        // effort and mode of that moment; the line is rebuilt now with the
        // current ones, which a set-model or set-mode since may have
        // lengthened past the child's line cap. The writer would refuse it
        // and the prompt would leave the queue. It stays at the head instead,
        // undispatched, with a diagnostic: changing the settings back or
        // retracting it frees the queue. One no setting could make fit goes
        // on to the writer's refusal and leaves the queue, as before.
        let held_by_settings = encoded.len() > crate::process::LINE_CAP
            && match &self.driver {
                AgentDriver::Claude(_) => false,
                AgentDriver::Codex(driver) => driver.could_fit(&next.content),
            };
        if held_by_settings {
            self.driver.dispatched(&next.id, false);
            let bytes = encoded.len();
            let prompt = next.id.clone();
            queue.waiting.push_front(next);
            drop(queue);
            self.publish(EventBody::Diagnostic {
                text: format!(
                    "queued prompt {prompt} stays queued: as a turn it is now {bytes} bytes, over \
                     the {} byte line limit; change the model or mode back, or retract it",
                    crate::process::LINE_CAP
                ),
            });
            return Dispatched::Idle;
        }
        queue.in_flight.push(next.id.clone());
        self.record_quietly(Body::PromptDispatched {
            prompt: next.id.clone(),
            steered: false,
        });
        drop(queue);
        self.hand_over(next, encoded, false, false)
    }

    /// Hand one waiting prompt to the child now, even while a turn runs: the
    /// steer. Agent-agnostic here: the line comes from the driver
    /// (`AgentDriver::steer_line`), so each runtime folds it its own way (the
    /// Claude sidecar pushes it with priority `next`, which the CLI takes in
    /// at its next tool boundary without interrupting the turn or its
    /// background tasks). An agent with no steer refuses, and the prompt
    /// keeps waiting.
    ///
    /// With no turn in flight it is an ordinary dispatch (`prompt_line`) that
    /// starts one. `Err` if the prompt is not waiting (already dispatched,
    /// retracted, or unknown). A write refused outright puts the prompt back
    /// where it was, still waiting (`PromptRequeued`), and the turn end will
    /// pump it. So does a steer the agent refuses after it was written
    /// (`requeue_refused_steers`).
    pub fn steer_prompt(&self, prompt: &str) -> Result<Dispatched, String> {
        let mut queue = lock(&self.queue);
        if queue.in_flight.iter().any(|held| held == prompt) {
            return Err(format!("prompt {prompt} has already been dispatched"));
        }
        let Some(at) = queue.waiting.iter().position(|held| held.id == prompt) else {
            return Err(format!("no queued prompt {prompt}"));
        };
        let steered = !queue.in_flight.is_empty();
        let line = if steered {
            self.driver.steer_line(prompt, &queue.waiting[at].content)?
        } else {
            self.driver
                .prompt_line(prompt, &queue.waiting[at].content)?
        };
        let encoded = match encode(&line) {
            Ok(encoded) => encoded,
            Err(why) => {
                // Still waiting where it was: nothing was taken or recorded.
                self.driver.dispatched(prompt, false);
                return Ok(Dispatched::Failed(prompt.to_string(), why));
            }
        };
        let held = queue.waiting.remove(at).expect("position is in range");
        queue.in_flight.push(held.id.clone());
        if steered {
            // Before the write: the agent's refusal can arrive during it.
            queue.folded.insert(held.id.clone(), held.clone());
        }
        self.record_quietly(Body::PromptDispatched {
            prompt: held.id.clone(),
            steered,
        });
        drop(queue);
        Ok(self.hand_over(held, encoded, true, steered))
    }

    /// Put back every folded prompt the agent refused since the last call
    /// (hosted Codex: an error answering its `turn/steer`, e.g. "turn ended").
    /// It never joined the turn, so it goes back to its place in the queue,
    /// journaled so replay and a rebuilt view see it waiting again. `true`
    /// when any came back: the caller pumps, since the turn it was folded
    /// into may already have ended. Called by the stdout reader after the
    /// line's turn facts are journaled.
    pub fn requeue_refused_steers(&self) -> bool {
        let mut any = false;
        for prompt in self.driver.take_refused_steers() {
            let mut queue = lock(&self.queue);
            let Some(held) = queue.folded.remove(&prompt) else {
                continue;
            };
            queue.in_flight.retain(|id| *id != prompt);
            self.put_back(&mut queue, held);
            any = true;
        }
        any
    }

    /// Write one prompt the caller has already moved into `in_flight` and
    /// recorded as dispatched. Shared by `pump` and `steer_prompt` so both
    /// keep one record-then-write order and one failure mapping; `requeue`
    /// says where a prompt the child never took goes (`steer_prompt`: back
    /// to the queue; `pump`: out of it, reported to its caller).
    ///
    /// A `steered` Codex line goes through `CodexDriver::write_steer`: the stdout
    /// reader can end the turn after `steer_prompt` armed the steer and
    /// dropped the queue lock, and a steer written for an ended turn would
    /// tell the client `steered: true` for a prompt Codex is about to
    /// refuse. The driver holds its turn state across the write, so either
    /// the turn still runs when the line goes, or nothing is written and
    /// the prompt is requeued like a refused write, then pumped, since that
    /// turn's end may have found nothing to start. The hold is one bounded
    /// write (the one-second bound below); the reader only waits for it.
    pub(super) fn hand_over(
        &self,
        held: QueuedPrompt,
        encoded: String,
        requeue: bool,
        steered: bool,
    ) -> Dispatched {
        // `PromptDispatched` is already journaled. Recording it after the
        // write left a window where the child's answer (`turn/started`) could
        // land first and an attaching client saw a turn with its prompt still
        // queued. A write refused outright is withdrawn below rather than left
        // standing: replay retires a dispatched prompt, and one that never
        // reached the agent must not vanish from the queue, `list`, retraction
        // or a rebuilt view.
        // A shorter bound than `WRITE_TIMEOUT` on purpose. `pump` is called
        // from the stdout reader thread on every turn end, and that thread is
        // what delivers events to EVERY attached client — so a stalled stdin
        // pipe would freeze the whole session's output for the full write
        // timeout, not just this prompt. A dispatch that cannot be handed over
        // in a second is reported rather than waited on; the client is told.
        let write = || {
            self.child
                .write_line_within(&encoded, std::time::Duration::from_secs(1))
        };
        // Claude's steer names no turn, so it always writes.
        let status = match &self.driver {
            AgentDriver::Claude(_) => write(),
            AgentDriver::Codex(driver) => {
                if steered {
                    driver.write_steer(&held.id, write).unwrap_or_else(|| {
                        crate::process::WriteStatus::NotWritten(TURN_ENDED_FIRST.into())
                    })
                } else {
                    write()
                }
            }
        };
        match status {
            crate::process::WriteStatus::Written => {
                self.record_driver_facts(&held.id);
                Dispatched::Sent(held.id)
            }
            crate::process::WriteStatus::NotWritten(why) => {
                // Definitely not delivered. The prompt leaves the flight, so
                // the next one may go. From `pump` it is gone from the queue
                // and the caller MUST report that rather than answering
                // "queued"; `steer_prompt` puts it back instead.
                self.driver.dispatched(&held.id, false);
                let id = held.id.clone();
                let mut queue = lock(&self.queue);
                queue.in_flight.retain(|flying| *flying != id);
                queue.folded.remove(&id);
                if requeue {
                    self.put_back(&mut queue, held);
                } else {
                    self.record_quietly(Body::PromptUndelivered {
                        prompt: id.clone(),
                        reason: why.clone(),
                    });
                }
                drop(queue);
                if why == TURN_ENDED_FIRST {
                    // The reader ended the turn while this steer was armed,
                    // and its pump may already have found nothing waiting:
                    // pump the prompt put back, or it waits for a turn end
                    // that never comes. Off the reader thread (the client's
                    // `steer` request); `pump` takes the queue lock, then
                    // the driver's turns, the same order as everywhere.
                    if let Dispatched::Failed(prompt, why) = self.pump() {
                        self.publish(EventBody::Diagnostic {
                            text: format!("queued prompt {prompt} was not delivered: {why}"),
                        });
                    }
                }
                Dispatched::Failed(id, why)
            }
            crate::process::WriteStatus::PossiblyDelivered(_) => {
                // Left recorded as dispatched because it may genuinely have
                // landed, and left in flight on purpose: re-sending a prompt
                // that did land would duplicate a real user turn, which is far
                // more visible than one that stalls until the next `result`.
                self.record_driver_facts(&held.id);
                Dispatched::Unknown(held.id)
            }
        }
    }

    /// Whatever the driver records about a line that landed (or may have):
    /// hosted Codex, the policy its `turn/start` carried.
    fn record_driver_facts(&self, prompt: &str) {
        for body in self.driver.dispatched(prompt, true) {
            self.record_quietly(body);
        }
    }

    /// Back into the waiting queue at its place in submission order, recorded
    /// under the same queue lock so replay's index matches.
    fn put_back(&self, queue: &mut PromptQueue, held: QueuedPrompt) {
        let at = queue.place_of(&held);
        self.record_quietly(requeued(&held, at));
        queue.waiting.insert(at, held);
    }
}

/// The `PromptRequeued` for `held`. It is a few bytes larger than the
/// `PromptQueued` that carried the same content, so content that journaled
/// at the cap could not journal again and replay would lose a prompt the live
/// queue holds. Such content is swapped for the marker hydrate shows, sized
/// with every number at its widest.
fn requeued(held: &QueuedPrompt, at: usize) -> Body {
    let body = Body::PromptRequeued {
        prompt: held.id.clone(),
        content: held.content.clone(),
        at,
    };
    let widest = Record {
        seq: u64::MAX,
        generation: u64::MAX,
        at_ms: u64::MAX,
        body,
    };
    match serde_json::to_vec(&widest).map(|encoded| encoded.len()) {
        Ok(bytes) if bytes <= LONE_RECORD_CAP => widest.body,
        bytes => Body::PromptRequeued {
            prompt: held.id.clone(),
            content: serde_json::Value::String(super::hydrate::oversized_prompt_marker(
                bytes.unwrap_or(usize::MAX),
            )),
            at,
        },
    }
}

/// Why a steer was not written: its turn ended after it was armed.
pub(super) const TURN_ENDED_FIRST: &str = "the running turn ended before the steer was written; \
                                           the prompt stays queued";

/// `PromptUndelivered` reasons for a folded prompt the agent never answered.
/// The Rendered view keys its notice on the shared stem and the close ending
/// (`src/panels/rendered/host-payload.ts`, `releasedSteerNotice`).
const UNANSWERED_BY_TURN_END: &str = "the agent never answered the steer, and the following turn \
                                      has ended";
const UNANSWERED_BY_CLOSE: &str = "the agent never answered the steer before the session closed";

/// The journal's record of a released steer, for every attached client. It
/// says "may not": Codex may have applied a steer it never answered. The
/// view draws its own notice on the user's block from `prompt-undelivered`.
fn announce_unanswered(session: &Session, released: &[String], reason: &str) {
    for prompt in released {
        session.publish(EventBody::Diagnostic {
            text: format!("Steered prompt {prompt} may not have been delivered: {reason}."),
        });
    }
}

fn encode(line: &serde_json::Value) -> Result<String, String> {
    serde_json::to_string(line).map_err(|error| error.to_string())
}
