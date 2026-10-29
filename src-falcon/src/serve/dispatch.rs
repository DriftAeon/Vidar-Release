//! Request dispatch for a negotiated connection: the protocol-v1 gate, then
//! one handler per verb. `converse` owns the connection; this owns the verbs.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use serde_json::{json, Value};

use super::{
    lock,
    mutation::{command, guard_mutation},
    spawn_session,
    unattended::watch_requests_left_unattended,
    Client, Host,
};
use crate::{
    protocol::{
        effort_levels, Agent, BusFrame, Event, EventBody, Lease, Op, Request, Response,
        ServerFrame, SpawnParams, ALLOWED_BEHAVIORS, ALLOWED_MODES, MAX_SESSION_FRAME,
        PROTOCOL_V1, PROTOCOL_V2,
    },
    session::{self, Subscriber},
};

/// Records per `hydrate` page, and the encoded byte budget for one page.
///
/// The count alone was NOT a bound, which was a P1: a record may legally be up
/// to the journal's 16 MiB cap, so three large diagnostic records make a
/// 256-record page that cannot be serialized onto the wire. The frame write
/// then fails, the writer thread exits, and the client gets no response at all.
/// The budget leaves room for the response envelope around the records.
const HYDRATE_PAGE: usize = 256;
const HYDRATE_BYTES: usize = MAX_SESSION_FRAME / 2;

pub(super) fn dispatch(
    host: &Arc<Host>,
    client: &Arc<Client>,
    client_name: &str,
    protocol: u32,
    attached: &Mutex<HashMap<String, u64>>,
    request: Request,
) -> Response {
    let id = request.id;
    if protocol == PROTOCOL_V1 {
        if let Some(session_id) = target_session(&request.op) {
            if host
                .registry
                .get(session_id)
                .is_some_and(|s| v1_hides(&s.agent))
            {
                return Response::failed(id, "protocol v1 cannot access Codex sessions");
            }
        }
    }
    match request.op {
        // Handled by the caller; reaching here means a second negotiate.
        Op::Negotiate { .. } => Response::failed(id, "already negotiated"),

        Op::List => list(host, id, protocol),

        Op::Spawn(params) => spawn(host, id, protocol, params),

        Op::Attach { session } => attach(host, client, attached, id, session),

        Op::Hydrate {
            session,
            after,
            through,
        } => hydrate(host, id, session, after, through),

        Op::Detach { session } => detach(host, attached, id, session),

        Op::AcquireControl { session } => acquire_control(host, client, client_name, id, session),

        Op::ReleaseControl { session, lease } => release_control(host, id, session, lease),

        Op::Close { session, lease } => close(host, id, session, lease),

        Op::Terminate { session, lease } => terminate(host, id, session, lease),

        Op::Release { session } => release(host, id, session),

        Op::Submit {
            session,
            generation,
            lease,
            content,
        } => submit(host, id, session, generation, lease, content),

        Op::RetractPrompt {
            session,
            generation,
            lease,
            prompt,
        } => retract_prompt(host, id, session, generation, lease, prompt),

        Op::SteerPrompt {
            session,
            generation,
            lease,
            prompt,
        } => steer_prompt(host, id, session, generation, lease, prompt),

        Op::Interrupt {
            session,
            generation,
            lease,
        } => interrupt(host, client_name, id, session, generation, lease),

        Op::Query {
            session,
            generation,
            method,
            params,
        } => query(host, attached, id, session, generation, method, params),

        Op::PermissionResponse {
            session,
            generation,
            lease,
            request: permission,
            behavior,
            message,
            updated_input,
        } => permission_response(
            host,
            client_name,
            id,
            session,
            generation,
            lease,
            permission,
            behavior,
            message,
            updated_input,
        ),

        Op::SetModel {
            session,
            generation,
            lease,
            model,
        } => set_model(host, client_name, id, session, generation, lease, model),

        Op::SetEffort {
            session,
            generation,
            lease,
            level,
        } => set_effort(host, client_name, id, session, generation, lease, level),

        Op::SetPermissionMode {
            session,
            generation,
            lease,
            mode,
        } => set_permission_mode(host, client_name, id, session, generation, lease, mode),

        // Neither op below touches a session or a lease — negotiate is the
        // only gate, already enforced by `converse` before `dispatch` runs.
        Op::Subscribe { topics } => subscribe(host, client, id, topics),

        Op::Publish {
            topic,
            id: message_id,
            payload,
            reply_to,
        } => publish(host, client_name, id, topic, message_id, payload, reply_to),
    }
}

/// Whether protocol v1 clients cannot see a session of this agent (Codex arrived with v2).
fn v1_hides(agent: &str) -> bool {
    let Some(agent) = Agent::from_wire(agent) else {
        return false;
    };
    match agent {
        Agent::Claude => false,
        Agent::Codex => true,
    }
}

fn list(host: &Arc<Host>, id: u64, protocol: u32) -> Response {
    Response::applied(
        id,
        json!({ "sessions": host.registry.list().into_iter().filter(|s| protocol >= PROTOCOL_V2 || !v1_hides(&s.agent)).collect::<Vec<_>>() }),
    )
}

fn spawn(host: &Arc<Host>, id: u64, protocol: u32, params: SpawnParams) -> Response {
    let agent = match (protocol, params.agent) {
        (PROTOCOL_V1, None) => Agent::Claude,
        (_, None) => return Response::failed(id, "protocol v2 spawn requires an explicit agent"),
        (PROTOCOL_V1, Some(agent)) => match agent {
            Agent::Claude => agent,
            Agent::Codex => {
                return Response::failed(id, "protocol v1 cannot spawn Codex sessions")
            }
        },
        (_, Some(agent)) => agent,
    };
    if !host
        .falcon
        .supported_agents
        .iter()
        .any(|a| a == agent.as_str())
    {
        return Response::failed(id, format!("agent {} is not supported", agent.as_str()));
    }
    // Belt to the accept path's braces: a committed idle exit refuses new
    // work rather than starting a child the exit is about to orphan.
    if host.exiting.load(std::sync::atomic::Ordering::SeqCst) {
        return Response::failed(id, "host is exiting; reconnect to start a new host");
    }
    match spawn_session(host, agent, params) {
        Ok(spawned) => {
            let mut payload = json!({ "session": spawned.summary });
            if let Some(bare) = spawned.codex_bare {
                payload[crate::protocol::CODEX_BARE_SPAWN_KEY] = json!(bare);
            }
            Response::applied(id, payload)
        }
        Err(error) => Response::failed(id, error),
    }
}

fn attach(
    host: &Arc<Host>,
    client: &Arc<Client>,
    attached: &Mutex<HashMap<String, u64>>,
    id: u64,
    session: String,
) -> Response {
    let mut held = lock(attached);
    if held.contains_key(&session) {
        return Response::failed(id, "this connection is already attached");
    }
    let subscriber: Subscriber = {
        let client = Arc::clone(client);
        Arc::new(move |event: Event| {
            // A failed push means the client is gone; the connection
            // thread's cleanup detaches. Nothing here may block a reader.
            let _ = client.send(ServerFrame::Event(event));
        })
    };
    // One serialized cut: the subscriber is installed and the boundary
    // captured under the same lock `publish_durable` takes, so no event
    // can fall between "in the journal" and "delivered live", and none
    // can arrive twice. The client rebuilds through `through`, then
    // everything it receives is strictly after it.
    // Looked up and attached under the registry lock, so the exited-session
    // sweep cannot release it between the two.
    let Some((found, token, through)) = host.registry.attach(&session, subscriber) else {
        return Response::failed(id, "no such session");
    };
    let snapshot = match found.snapshot() {
        Ok(snapshot) => snapshot,
        // A journal that cannot be read fails the attach visibly and
        // leaves the child alone, rather than handing back a view that
        // silently starts from nothing.
        Err(error) => {
            found.detach(token);
            return Response::failed(id, format!("hydration unavailable: {error}"));
        }
    };
    held.insert(session, token);
    Response::applied(
        id,
        json!({
            "session": found.summary(),
            "through": through,
            "snapshot": snapshot,
        }),
    )
}

fn hydrate(host: &Arc<Host>, id: u64, session: String, after: u64, through: u64) -> Response {
    let Some(found) = host.registry.get(&session) else {
        return Response::failed(id, "no such session");
    };
    match found.hydrate_from(after, through, HYDRATE_PAGE, HYDRATE_BYTES) {
        Ok((records, more)) => Response::applied(id, json!({ "records": records, "more": more })),
        Err(error) => Response::failed(id, format!("hydration failed: {error}")),
    }
}

fn detach(
    host: &Arc<Host>,
    attached: &Mutex<HashMap<String, u64>>,
    id: u64,
    session: String,
) -> Response {
    let token = lock(attached).remove(&session);
    match (token, host.registry.get(&session)) {
        (Some(token), Some(found)) => {
            found.detach(token);
            // Detach is not a lifecycle operation: the child keeps running.
            Response::applied(id, json!({ "detached": true, "pid": found.child.pid() }))
        }
        (Some(_), None) => Response::applied(id, json!({ "detached": true })),
        (None, _) => Response::failed(id, "this connection is not attached"),
    }
}

fn acquire_control(
    host: &Arc<Host>,
    client: &Arc<Client>,
    client_name: &str,
    id: u64,
    session: String,
) -> Response {
    // Looked up and leased under the registry lock, so the exited-session
    // sweep cannot release it between the two (as in `attach`).
    let token = uuid::Uuid::new_v4().simple().to_string();
    match host
        .registry
        .acquire_control(&session, client.id, client_name, token)
    {
        Some(Ok(lease)) => Response::applied(
            id,
            json!({ "token": lease.token, "revision": lease.revision }),
        ),
        Some(Err(error)) => Response::failed(id, error),
        None => Response::failed(id, "no such session"),
    }
}

fn release_control(host: &Arc<Host>, id: u64, session: String, lease: Lease) -> Response {
    match host.registry.get(&session) {
        Some(found) => match found.release_control(&lease) {
            Ok(revision) => {
                watch_requests_left_unattended(host, &found);
                Response::applied(id, json!({ "released": true, "revision": revision }))
            }
            Err(refusal) => Response::failed(id, refusal.message(found.controller_revision())),
        },
        None => Response::failed(id, "no such session"),
    }
}

fn close(host: &Arc<Host>, id: u64, session: String, lease: Lease) -> Response {
    match host.registry.get(&session) {
        // Graceful: EOF, bounded wait, then the Job. The reader thread is
        // what publishes `exit`, so it is emitted exactly once.
        Some(found) => match found.check_control(&lease) {
            Ok(()) => {
                let code = found.child.stop();
                Response::applied(id, json!({ "closed": true, "code": code }))
            }
            Err(refusal) => Response::failed(id, refusal.message(found.controller_revision())),
        },
        None => Response::failed(id, "no such session"),
    }
}

fn terminate(host: &Arc<Host>, id: u64, session: String, lease: Lease) -> Response {
    match host.registry.get(&session) {
        Some(found) => match found.check_control(&lease) {
            Ok(()) => {
                found.child.terminate_tree();
                Response::applied(id, json!({ "terminated": true }))
            }
            Err(refusal) => Response::failed(id, refusal.message(found.controller_revision())),
        },
        None => Response::failed(id, "no such session"),
    }
}

fn release(host: &Arc<Host>, id: u64, session: String) -> Response {
    match host.registry.release(&session) {
        Ok(()) => Response::applied(id, json!({ "released": true })),
        Err(error) => Response::failed(id, error),
    }
}

// Deliberately NOT routed through `command`. A prompt is queued by
// Falcon and answered later; `command` writes to the child and blocks
// on the sidecar's terminal outcome, which is the right shape for
// interrupts and settings and the wrong one for a turn.
fn submit(
    host: &Arc<Host>,
    id: u64,
    session: String,
    generation: u64,
    lease: Lease,
    content: Value,
) -> Response {
    let found = match guard_mutation(host, id, &session, generation, &lease) {
        Err(refusal) => return refusal,
        Ok(found) => found,
    };
    // A prompt the agent cannot start a turn with (hosted Codex: no thread
    // yet, or content that is not text) is refused here, before anything is
    // journaled: a queued prompt it can never send would sit in the queue
    // and in every replay of it.
    if let Err(why) = found.driver.check_prompt(&content) {
        return Response::failed(id, format!("cannot submit: {why}"));
    }
    let prompt = match found.enqueue_prompt(content) {
        Err(error) => return Response::failed(id, format!("cannot journal the prompt: {error}")),
        Ok(prompt) => prompt,
    };
    // Dispatch here only if the child is free. If a turn is running, the
    // reader thread pumps at the driver's turn end.
    match found.pump() {
        // A refused write means the prompt is NOT queued and NOT delivered —
        // `pump` has already dropped it. An earlier version hardcoded
        // `"queued": true` here and answered `applied`, so a prompt that
        // never reached the agent was reported accepted and then could not
        // be listed or retracted because it no longer existed.
        session::Dispatched::Failed(failed, why) if failed == prompt => {
            Response::failed(id, format!("prompt {failed} could not be delivered: {why}"))
        }
        // A different prompt failing is not this request's answer, but it
        // must not vanish silently either.
        session::Dispatched::Failed(failed, why) => {
            found.publish(EventBody::Diagnostic {
                text: format!("queued prompt {failed} was not delivered: {why}"),
            });
            Response::applied(
                id,
                json!({ "prompt": prompt, "queued": true, "dispatched": false }),
            )
        }
        dispatched => Response::applied(
            id,
            json!({
                "prompt": prompt,
                "queued": true,
                "dispatched": matches!(
                    dispatched,
                    session::Dispatched::Sent(_) | session::Dispatched::Unknown(_)
                ),
            }),
        ),
    }
}

fn retract_prompt(
    host: &Arc<Host>,
    id: u64,
    session: String,
    generation: u64,
    lease: Lease,
    prompt: String,
) -> Response {
    match guard_mutation(host, id, &session, generation, &lease) {
        Err(refusal) => refusal,
        Ok(found) => match found.retract_prompt(&prompt) {
            Ok(()) => Response::applied(id, json!({ "retracted": prompt })),
            Err(error) => Response::failed(id, error),
        },
    }
}

// Same gates as `submit`, and the same no-round-trip shape: the prompt is
// written and recorded, and the agent's own output says what it made of it.
fn steer_prompt(
    host: &Arc<Host>,
    id: u64,
    session: String,
    generation: u64,
    lease: Lease,
    prompt: String,
) -> Response {
    match guard_mutation(host, id, &session, generation, &lease) {
        Err(refusal) => refusal,
        Ok(found) => match found.steer_prompt(&prompt) {
            Err(error) => Response::failed(id, error),
            // Not steered: back in the queue for the turn end's pump, or
            // already pumped by `hand_over` when that turn ended before the
            // steer was written (it then starts the next turn).
            Ok(session::Dispatched::Failed(_, why)) => {
                Response::failed(id, format!("prompt {prompt} could not be steered: {why}"))
            }
            Ok(dispatched) => Response::applied(
                id,
                json!({
                    "prompt": prompt,
                    "steered": true,
                    "delivery_unknown": matches!(dispatched, session::Dispatched::Unknown(_)),
                }),
            ),
        },
    }
}

fn interrupt(
    host: &Arc<Host>,
    client_name: &str,
    id: u64,
    session: String,
    generation: u64,
    lease: Lease,
) -> Response {
    command(host, id, client_name, &session, generation, &lease, |_| {
        Ok(json!({ "type": "interrupt" }))
    })
}

fn query(
    host: &Arc<Host>,
    attached: &Mutex<HashMap<String, u64>>,
    id: u64,
    session: String,
    generation: u64,
    method: String,
    params: Value,
) -> Response {
    if !lock(attached).contains_key(&session) {
        return Response::failed(id, "query requires an attached session");
    }
    let Some(found) = host.registry.get(&session) else {
        return Response::failed(id, "no such session");
    };
    if found.generation != generation {
        return Response::failed(id, "stale session generation");
    }
    if found.exited().is_some() {
        return Response::failed(id, "session has exited");
    }
    match found.driver.query(&found.child, &method, params) {
        Ok(response) => Response::applied(id, json!({ "response": response })),
        Err((crate::protocol::Outcome::DeliveryUnknown, why)) => {
            Response::delivery_unknown(id, why)
        }
        Err((_, why)) => Response::failed(id, why),
    }
}

#[allow(clippy::too_many_arguments)] // 10 args: one per permission_response protocol field
fn permission_response(
    host: &Arc<Host>,
    client_name: &str,
    id: u64,
    session: String,
    generation: u64,
    lease: Lease,
    permission: String,
    behavior: String,
    message: Option<String>,
    updated_input: Option<Value>,
) -> Response {
    command(
        host,
        id,
        client_name,
        &session,
        generation,
        &lease,
        move |_| {
            if !ALLOWED_BEHAVIORS.contains(&behavior.as_str()) {
                return Err(format!("permission behavior not allowed: {behavior}"));
            }
            let mut line = json!({
                "type": "permission_response",
                "id": permission,
                "behavior": behavior,
            });
            if let Some(object) = line.as_object_mut() {
                if let Some(message) = message {
                    object.insert("message".into(), json!(message));
                }
                if let Some(input) = updated_input {
                    object.insert("updatedInput".into(), input);
                }
            }
            Ok(line)
        },
    )
}

fn set_model(
    host: &Arc<Host>,
    client_name: &str,
    id: u64,
    session: String,
    generation: u64,
    lease: Lease,
    model: String,
) -> Response {
    command(
        host,
        id,
        client_name,
        &session,
        generation,
        &lease,
        move |_| {
            let model = model.trim();
            if model.is_empty() || model.len() > 80 {
                return Err("model name missing or too long".into());
            }
            Ok(json!({ "type": "set_model", "model": model }))
        },
    )
}

/// Refused before the session is resolved: the level is plain input, and the
/// allowlist (`contracts/effort-levels.json`) is the trust boundary.
fn set_effort(
    host: &Arc<Host>,
    client_name: &str,
    id: u64,
    session: String,
    generation: u64,
    lease: Lease,
    level: String,
) -> Response {
    if !effort_levels().contains(&level.as_str()) {
        return Response::failed(id, format!("effort level not allowed: {level}"));
    }
    command(
        host,
        id,
        client_name,
        &session,
        generation,
        &lease,
        move |_| Ok(json!({ "type": "set_effort", "level": level })),
    )
}

fn set_permission_mode(
    host: &Arc<Host>,
    client_name: &str,
    id: u64,
    session: String,
    generation: u64,
    lease: Lease,
    mode: String,
) -> Response {
    command(
        host,
        id,
        client_name,
        &session,
        generation,
        &lease,
        move |_| {
            if !ALLOWED_MODES.contains(&mode.as_str()) {
                return Err(format!("permission mode not allowed: {mode}"));
            }
            Ok(json!({ "type": "set_permission_mode", "mode": mode }))
        },
    )
}

fn subscribe(host: &Arc<Host>, client: &Arc<Client>, id: u64, topics: Vec<String>) -> Response {
    host.bus.subscribe(client.id, client, topics);
    Response::applied(id, json!({ "subscribed": true }))
}

fn publish(
    host: &Arc<Host>,
    client_name: &str,
    id: u64,
    topic: String,
    message_id: String,
    payload: Value,
    reply_to: Option<String>,
) -> Response {
    let delivered = host.bus.publish(&BusFrame {
        topic,
        id: message_id,
        from: client_name.to_string(),
        payload,
        reply_to,
    });
    Response::applied(id, json!({ "delivered": delivered }))
}

fn target_session(op: &Op) -> Option<&str> {
    match op {
        Op::Attach { session }
        | Op::Hydrate { session, .. }
        | Op::Detach { session }
        | Op::AcquireControl { session }
        | Op::ReleaseControl { session, .. }
        | Op::Close { session, .. }
        | Op::Release { session }
        | Op::Terminate { session, .. }
        | Op::Submit { session, .. }
        | Op::RetractPrompt { session, .. }
        | Op::SteerPrompt { session, .. }
        | Op::Interrupt { session, .. }
        | Op::Query { session, .. }
        | Op::PermissionResponse { session, .. }
        | Op::SetModel { session, .. }
        | Op::SetEffort { session, .. }
        | Op::SetPermissionMode { session, .. } => Some(session),
        // Listed, not wildcarded: a new op that names a session must be
        // placed here, or a v1 client could reach a Codex session through it.
        Op::Negotiate { .. }
        | Op::List
        | Op::Spawn(_)
        | Op::Subscribe { .. }
        | Op::Publish { .. } => None,
    }
}
