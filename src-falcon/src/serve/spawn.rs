//! Session spawn and the per-session child readers.
//!
//! The stdout reader is its own thread, never the connection's request thread:
//! `command` blocks on an outcome that arrives on that stdout (see the module
//! note in `serve.rs`).

use std::{collections::HashMap, sync::Arc, time::Duration};

use serde_json::Value;

use super::{
    unattended::{spawn_unattended_watcher, unattended_permission_target},
    AgentRuntime, Host,
};
use crate::{
    journal::{Body, Journal},
    process::{self, ChildOutput},
    protocol::{Agent, EventBody, SessionSummary},
    session::{self, driver_props::Observed, AgentDriver, Session},
};

/// A spawned session's summary, plus what a Codex Bare spawn ran (its reply's `codex_bare`).
pub(super) struct Spawned {
    pub summary: SessionSummary,
    pub codex_bare: Option<crate::protocol::CodexBareSpawn>,
}

pub(super) fn spawn_session(
    host: &Arc<Host>,
    agent: Agent,
    params: crate::protocol::SpawnParams,
) -> Result<Spawned, String> {
    if params.gateway.is_some() {
        match agent {
            Agent::Claude => {}
            Agent::Codex => return Err("gateway requires Claude".into()),
        }
    }
    // Reserve before anything runs: the reservation is what makes a duplicate
    // resume fail closed, and it releases itself if this function fails.
    let reservation = host
        .registry
        .reserve(agent.as_str(), params.resume.as_deref())?;
    let runtime = host
        .runtimes
        .iter()
        .find(|r| r.agent() == agent)
        .ok_or_else(|| format!("agent {} is not available", agent.as_str()))?;
    let (request, mut codex_bare) = match runtime {
        AgentRuntime::Claude(runtime) => (runtime.spawn_request(&params, &reservation.id)?, None),
        AgentRuntime::Codex(runtime) => {
            let spawn = runtime.spawn_request(&params, &reservation.id)?;
            (spawn.request, spawn.bare)
        }
    };

    // Open the journal BEFORE spawning. A session whose journal cannot be
    // opened must not run at all: it would publish events nothing could replay,
    // which is exactly the state append-before-publish exists to prevent. Doing
    // it first means that failure costs nothing — no child exists yet.
    let mut journal = Journal::open(&host.journal_root, &reservation.id)
        .map_err(|error| format!("open journal for {}: {error}", reservation.id))?;

    let (child, output, env_names) = process::spawn_recording(&request)?;
    let driver = match agent {
        Agent::Claude => AgentDriver::claude(&params),
        Agent::Codex => {
            let text = codex_bare.as_mut().and_then(|b| b.developer_instructions.take());
            AgentDriver::codex_with(&params, text)
        }
    };

    // The opening record, before anything can be published. Replay needs it
    // first: it is what establishes the generation every later record is
    // checked against.
    journal
        .append(
            reservation.generation,
            Body::Started {
                session: reservation.id.clone(),
                agent: agent.as_str().into(),
                cwd: params.cwd.clone(),
                model: params.model.clone(),
                permission_mode: params.permission_mode.clone(),
                conversation: params.resume.clone(),
                pid: child.pid(),
            },
        )
        .map_err(|error| format!("journal the session start: {error}"))?;

    let session = session::new_session(
        &reservation,
        agent.as_str(),
        params.cwd.clone(),
        params.resume.clone(),
        child,
        driver,
        journal,
    );
    if let Some(sets) = params.sets.as_ref() {
        let _ = session.sets.set(sets.clone());
    }
    let hosts_app_server = match agent {
        Agent::Claude => false,
        Agent::Codex => true,
    };
    if hosts_app_server {
        // `CodexRuntime::spawn_request` admitted the profile and built this child's env from it:
        // the echo is Vidar's proof (an older host refuses the profile), the names its manifest,
        // the payload path the admitted canonical one, never the client's string.
        let mut codex_echo = None;
        if let (Some(profile), Some(bare)) = (params.profile.as_ref(), codex_bare) {
            if request.env_base == process::EnvBase::Allowlist {
                let _ = session.profile.set(profile.clone());
                let _ = session.env_names.set(env_names);
                if let Some(admitted) = bare.payload_file {
                    let _ = session.payload_file.set(admitted);
                }
                if let Some(row_key) = params.row_key.as_ref() {
                    let _ = session.row_key.set(row_key.clone());
                }
                codex_echo = Some(bare.spawn);
            }
        }
        // Start the readers before the handshake: app-server can answer within
        // the same scheduler slice, and no pipe may be allowed to fill while
        // the spawning connection waits for readiness.
        start_readers(host, Arc::clone(&session), output);
        if let Err(error) = session.driver.start(&session.child) {
            session.child.terminate_tree();
            return Err(format!("start Codex app-server: {error}"));
        }
        let conversation = match session.driver.wait_ready() {
            Ok(conversation) => conversation,
            Err(error) => {
                session.child.terminate_tree();
                return Err(error);
            }
        };
        if let Err(error) = session.record(Body::ConversationAdopted {
            conversation: conversation.clone(),
        }) {
            session.child.terminate_tree();
            return Err(format!("journal Codex readiness: {error}"));
        }
        reservation.commit(Arc::clone(&session));
        if let Err(error) = host.registry.adopt_conversation(&session.id, &conversation) {
            session.child.terminate_tree();
            return Err(error);
        }
        return Ok(Spawned { summary: session.summary(), codex_bare: codex_echo });
    }

    // Claude only: `ClaudeRuntime::spawn_request` admitted it and passed it to
    // the sidecar. The echo is Vidar's proof this host honoured it (B1).
    // The echo is the admitted canonical path from the request's own argv, not the client's string.
    if params.rules_file.is_some() {
        if let Some(admitted) = request
            .args
            .iter()
            .position(|a| a == "--rules-file")
            .and_then(|at| request.args.get(at + 1))
        {
            let _ = session.rules_file.set(admitted.clone());
        }
    }
    // The name the child was given as VIDAR_TAB_NAME (`ClaudeRuntime::spawn_request` admitted it);
    // echoed so a re-adopt after a Vidar swap titles the tab the same.
    if let Some((_, name)) = request.env.iter().find(|(k, _)| k == "VIDAR_TAB_NAME") {
        let _ = session.tab_name.set(name.clone());
    }
    if let Some(gateway) = params.gateway {
        let _ = session.gateway.set(gateway);
    }
    // `ClaudeRuntime::spawn_request` admitted the profile and built this child's env from it:
    // the echo is Vidar's proof (an older host ignores the field), the names its manifest.
    if let Some(profile) = params.profile.as_ref() {
        if request.env_base == process::EnvBase::Allowlist {
            let _ = session.profile.set(profile.clone());
            let _ = session.env_names.set(env_names);
            // The payload echo is the admitted canonical path from the argv, like `rules_file`.
            if params.payload_file.is_some() {
                if let Some(admitted) = request
                    .args
                    .iter()
                    .position(|a| a == "--payload")
                    .and_then(|at| request.args.get(at + 1))
                {
                    let _ = session.payload_file.set(admitted.clone());
                }
            }
            if params.mcp_file.is_some() {
                if let Some(admitted) = request.args.windows(2)
                    .find(|pair| pair[0] == "--mcp-file")
                    .map(|pair| pair[1].clone())
                {
                    let _ = session.mcp_file.set(admitted);
                }
            }
            if let Some(row_key) = params.row_key.as_ref() {
                let _ = session.row_key.set(row_key.clone());
            }
            // The admitted config dir is the child's CLAUDE_CONFIG_DIR (`claude::bare_spawn`).
            if params.claude_config_dir.is_some() {
                if let Some((_, dir)) = request.env.iter().find(|(k, _)| k.eq_ignore_ascii_case("CLAUDE_CONFIG_DIR")) {
                    let _ = session.claude_config_dir.set(dir.clone());
                }
            }
        }
    }
    let summary = session.summary();
    // Register BEFORE starting readers. The reverse order loses data: the CLI's
    // `system/init` can arrive within milliseconds, and `adopt_conversation`
    // silently does nothing when the session is not yet in the registry — so a
    // fresh conversation could permanently miss its reservation and a second
    // client could later resume it alongside this one. Publishing first costs
    // nothing, because no event can exist before the readers below.
    reservation.commit(Arc::clone(&session));
    start_readers(host, session, output);
    Ok(Spawned { summary, codex_bare: None })
}

fn start_readers(host: &Arc<Host>, session: Arc<Session>, output: ChildOutput) {
    let ChildOutput { stdout, stderr } = output;

    let history_pending = match &session.driver {
        AgentDriver::Claude(_) => false,
        AgentDriver::Codex(driver) => !driver.history_done(),
    };
    if history_pending {
        let waiting = Arc::clone(&session);
        let _ = std::thread::Builder::new()
            .name(format!("falcon-history-{}", session.id))
            .spawn(move || loop {
                std::thread::sleep(Duration::from_secs(1));
                if waiting.codex_history_timeout() { break; }
            });
    }

    let diagnostics = Arc::clone(&session);
    let _ = std::thread::Builder::new()
        .name(format!("falcon-stderr-{}", session.id))
        .spawn(move || {
            let _ = stderr.for_each_line(
                |line| {
                    // Also to the host's own stderr: a session that dies before
                    // any client attaches would otherwise fail completely
                    // silently, because published events with no subscriber go
                    // nowhere until the slice-2 journal exists.
                    eprintln!("falcon {}: child stderr: {line}", diagnostics.id);
                    diagnostics.publish(EventBody::Diagnostic {
                        text: line.to_string(),
                    })
                },
                |bytes| {
                    diagnostics.publish(EventBody::Overflow {
                        bytes: bytes as u64,
                    })
                },
            );
        });

    let host = Arc::clone(host);
    let _ = std::thread::Builder::new()
        .name(format!("falcon-stdout-{}", session.id))
        .spawn(move || {
            // Last permission state journalled per request; this thread is the
            // session's only stdout reader, so a local map is session-scoped.
            let mut journalled_states: HashMap<String, String> = HashMap::new();
            let result = stdout.for_each_line(
                |line| {
                    let Ok(value) = serde_json::from_str::<Value>(line) else {
                        session.driver.malformed(line);
                        // Not JSON: diagnostic, never silently dropped.
                        session.publish(EventBody::Diagnostic {
                            text: line.to_string(),
                        });
                        return;
                    };
                    let (observed, conversation) = session.driver.observe(&value);
                    if session.codex_history_line(&value) { return; }
                    // A permission opened with nobody holding the lease has no
                    // one who *can* answer it: a subscriber without a lease
                    // cannot respond, so this is unattended by the contract's
                    // own definition, not merely quiet. Spawn a watcher rather
                    // than handling it inline — `command_as`, which the
                    // eventual deny goes through, waits for an outcome that
                    // arrives back on this very reader thread, so calling it
                    // here would deadlock.
                    if let Some(request) = unattended_permission_target(&session, &value) {
                        spawn_unattended_watcher(&host, &session, request);
                    }
                    // Permission lifecycle is reconstructive: a rebuilt client
                    // must know which approval cards are still outstanding.
                    // Journalled from the driver's own view, so the record and
                    // the live state cannot disagree.
                    // Hosted Codex hands over only the cards that moved: its
                    // settled cards accumulate over a long session.
                    let states = match &session.driver {
                        AgentDriver::Claude(_) => session.driver.permission_states(),
                        AgentDriver::Codex(driver) => driver.permission_changes(),
                    };
                    for (request, state) in states {
                        // The journal stores the state as its wire string, so
                        // the record and the sidecar's own vocabulary stay one
                        // spelling rather than two that can drift apart.
                        let Some(state) = serde_json::to_value(state)
                            .ok()
                            .and_then(|value| value.as_str().map(str::to_string))
                        else {
                            continue;
                        };
                        // Claude's driver reports every permission on every
                        // line (hosted Codex only the moved ones), so only a
                        // change is a fact worth a journal record.
                        if permission_state_changed(&mut journalled_states, &request, &state) {
                            session.record_quietly(Body::PermissionState { request, state });
                        }
                    }
                    if let Some(conversation) = conversation {
                        session.record_quietly(Body::ConversationAdopted {
                            conversation: conversation.clone(),
                        });
                        if let Err(why) =
                            host.registry.adopt_conversation(&session.id, &conversation)
                        {
                            // This child is running on a conversation another
                            // session holds. Two writers interleave and corrupt
                            // one transcript, so the only safe answer is to stop
                            // this child — the conversation's existing owner is
                            // the one with a valid claim, and it is still live.
                            eprintln!(
                                "falcon {}: refusing conversation {conversation}: {why}; \
                                 terminating this child",
                                session.id
                            );
                            session.publish(EventBody::Diagnostic {
                                text: format!(
                                    "conversation {conversation} is held by another session \
                                     ({why}); this session has been terminated to protect the \
                                     transcript"
                                ),
                            });
                            session.child.terminate_tree();
                        }
                    }
                    if matches!(observed, Observed::Forward) {
                        // A request the host answers itself (hosted Codex:
                        // refusals, unknown methods) is answered and
                        // journaled before its line is published, view or not.
                        for body in session.driver.answer_request(&session.child, &value) {
                            session.record_quietly(body);
                        }
                        // The turn end (the driver's to recognise: Claude's
                        // `result`) is what frees the child to take the next
                        // queued prompt. Pumped AFTER the event is published
                        // so a client sees the turn end before the next
                        // turn's output, and safe on this thread only because
                        // `pump` never waits for the sidecar's outcome — that
                        // outcome would arrive here.
                        let turn_ended = session.driver.ends_turn(&value);
                        session.publish(EventBody::Agent { line: value });
                        // Turn facts the line produced (hosted Codex: the
                        // turn bound or refused), after the line itself.
                        for body in session.driver.take_records() {
                            session.record_quietly(body);
                        }
                        // A steer the agent refused goes back to the queue;
                        // its turn may already be over, so pump for it too.
                        let requeued = session.requeue_refused_steers();
                        if turn_ended {
                            session.turn_finished();
                        }
                        if turn_ended || requeued {
                            if let session::Dispatched::Failed(prompt, why) = session.pump() {
                                session.publish(EventBody::Diagnostic {
                                    text: format!(
                                        "queued prompt {prompt} was not delivered: {why}"
                                    ),
                                });
                            }
                        }
                    } else {
                        // Startup replies are consumed, but a policy downgrade
                        // caused by one still belongs in the journal.
                        for body in session.driver.take_records() {
                            session.record_quietly(body);
                        }
                    }
                },
                |bytes| {
                    session.codex_history_failed("app-server line exceeded the history cap");
                    session.publish(EventBody::Overflow {
                        bytes: bytes as u64,
                    })
                },
            );
            if let Err(error) = result {
                session.publish(EventBody::Diagnostic {
                    text: format!("stdout reader failed: {error}"),
                });
            }
            session.codex_history_closed();
            session.driver.stdout_closed();
            // A steer orphaned by its turn's end can no longer be answered.
            session.release_unanswered_steers();
            // Stdout closing usually precedes exit by a moment.
            // Stdout closing is NOT process exit: a child may close its stdout
            // and keep running, and its descendants certainly can. Marking the
            // session exited here would let `release` drop the reservation
            // while the child still holds the conversation, and a second client
            // could then resume it alongside the live one. So wait for the
            // process handle itself, however long that takes — an explicit
            // close or terminate is what ends this wait.
            let code = loop {
                if let Some(code) = process::wait_for(&session.child, Duration::from_secs(5)) {
                    break code;
                }
                eprintln!(
                    "falcon {}: stdout ended but pid {} is still alive; still waiting",
                    session.id,
                    session.child.pid()
                );
            };
            eprintln!(
                "falcon {}: child pid {} exited with {code:?}",
                session.id,
                session.child.pid()
            );
            // Mark exited BEFORE abandoning. `command()` rejects immediately on
            // an exited session, so setting the flag first means a request
            // racing this teardown is refused at once instead of registering a
            // waiter nobody will ever settle and blocking for the full timeout.
            // Terminate the Job BEFORE marking exited. The root exiting says
            // nothing about its descendants: a grandchild can close stdout,
            // keep running, and outlive its parent. `mark_exited` is what
            // permits `release`, and releasing frees the conversation for
            // another session — so without this, a surviving descendant could
            // still be writing the transcript a newly resumed session has just
            // claimed. Explicit Close already terminates the Job; natural exit
            // has to reach the same state or the two paths disagree about what
            // "this session is over" means.
            session.child.terminate_tree();
            session.mark_exited(Some(code));
            // The tree is gone and the session is exited, so nothing can append
            // to this transcript: hand the conversation back now rather than
            // waiting for a `release` no client sends. The entry itself stays
            // for `list` and a later explicit release.
            match host.registry.free_conversations(&session.id) {
                Ok(0) => {}
                Ok(freed) => eprintln!(
                    "falcon {}: freed {freed} conversation claim(s) on exit",
                    session.id
                ),
                Err(why) => eprintln!(
                    "falcon {}: conversation claim not freed on exit: {why}",
                    session.id
                ),
            }
            // Release anyone already blocked on an outcome that can no longer
            // arrive; delivered commands settle as delivery-unknown, not failed.
            // The ids it cancelled are journalled, so a rebuilt client shows
            // those cards as closed-by-exit rather than waiting on them forever.
            for request in session.driver.abandon("the agent process exited") {
                session.record_quietly(Body::PermissionState {
                    request,
                    state: "cancelled-by-exit".into(),
                });
            }
            session.record_quietly(Body::Exited { code: Some(code) });
            // This is the only place `exit` is published, so it is emitted once
            // even when an explicit close already reaped the child.
            session.publish(EventBody::Exit { code: Some(code) });
        });
}

/// True when the given state differs from the last one journalled for `request`, and
/// records it as the new last state. A request not yet seen always counts as a
/// change.
fn permission_state_changed(last: &mut HashMap<String, String>, request: &str, state: &str) -> bool {
    if last.get(request).map(String::as_str) == Some(state) {
        return false;
    }
    last.insert(request.to_string(), state.to_string());
    true
}

#[cfg(test)]
mod permission_journal_tests {
    use super::*;

    /// The Vidar-side replay dedupe (`falcon/events.rs`) reads these field names.
    #[test]
    fn permission_state_wire_shape() {
        let body = Body::PermissionState {
            request: "r1".into(),
            state: "settled".into(),
        };
        // Pointers, not a json! literal: the paths-contract scan reads a bare
        // quoted state field name as the runtime/state layout dir.
        let value = serde_json::to_value(&body).unwrap();
        assert_eq!(value.as_object().map(|o| o.len()), Some(3));
        assert_eq!(value.pointer("/record").and_then(|v| v.as_str()), Some("permission-state"));
        assert_eq!(value.pointer("/request").and_then(|v| v.as_str()), Some("r1"));
        assert_eq!(value.pointer("/state").and_then(|v| v.as_str()), Some("settled"));
    }

    #[test]
    fn journals_only_state_changes_per_request() {
        let mut last = HashMap::new();
        let mut journalled = Vec::new();
        for (request, state) in [
            ("a", "opened"),
            ("b", "opened"),
            ("a", "settled"),
            ("a", "settled"),
            ("b", "opened"),
            ("a", "opened"),
            ("a", "settled"),
            ("b", "settled"),
        ] {
            if permission_state_changed(&mut last, request, state) {
                journalled.push((request, state));
            }
        }
        assert_eq!(
            journalled,
            vec![
                ("a", "opened"),
                ("b", "opened"),
                ("a", "settled"),
                ("a", "opened"),
                ("a", "settled"),
                ("b", "settled"),
            ]
        );
    }
}
