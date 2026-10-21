//! The `--probe` CLI: a disposable protocol-v1 test client for the session
//! endpoint. Client side only; nothing here runs inside the host.

use std::{collections::HashMap, sync::Arc, time::Duration};

use serde_json::{json, Value};

use crate::{
    ipc::{read_json_bounded, write_json_bounded},
    protocol::{Agent, EventBody, Op, Request, ServerFrame, MAX_SESSION_FRAME, PROTOCOL_V1},
    security::OwnedHandle,
};

/// Drive the session endpoint as a disposable protocol-v1 client.
///
/// `operations` is a JSON array of `Op` values (no `id`; they are numbered
/// here). Every frame received is printed as one JSON line, so a PowerShell
/// proof can assert on responses and pushed events alike. After the last
/// response, pushed events are drained for `linger` milliseconds — a submit's
/// interesting output arrives *after* its response.
pub fn probe_session(
    registry_path: &std::path::Path,
    operations: &std::path::Path,
    secret_override: Option<String>,
    protocol_override: Option<u32>,
    linger: u64,
) -> Result<(), String> {
    let falcon = crate::registry::read(registry_path)?;
    let text = std::fs::read_to_string(operations)
        .map_err(|error| format!("read {}: {error}", operations.display()))?;
    // Parsed as raw JSON, not as `Op`, because an operation may need a value
    // the server has not produced yet. The controller lease is the reason: it
    // is bound to a connection, so acquiring it and using it must happen on ONE
    // connection, and its token only exists at run time. A statically typed ops
    // file simply cannot express that, which would make the lease unprovable
    // live. See `bind_from_response` for what a run can refer to.
    let ops: Vec<Value> =
        serde_json::from_str(&text).map_err(|error| format!("parse operations: {error}"))?;

    let pipe = crate::ipc::connect(&falcon.session_endpoint)?;
    // Bind the connection back to the registered server before trusting it:
    // validating a PID and then opening an unrelated pipe proves nothing.
    crate::ipc::bind_server_identity(pipe.handle(), &falcon)?;

    let mut id = 0u64;
    // Returns the id it used, so the caller correlates against exactly that.
    let mut send = |op: Op| -> Result<u64, String> {
        id += 1;
        write_json_bounded(pipe.handle(), &Request { id, op }, MAX_SESSION_FRAME)?;
        Ok(id)
    };

    // This probe is the retained protocol-v1 compatibility client. New-version
    // proofs opt in with --protocol instead of silently changing its wire.
    let negotiated_protocol = protocol_override.unwrap_or(PROTOCOL_V1);
    let sent = send(Op::Negotiate {
        protocol: negotiated_protocol,
        client: "falcon-session-probe".into(),
        secret: secret_override.unwrap_or_else(|| falcon.attach_secret.clone()),
    })?;
    if !await_response(&pipe, sent)? {
        return Err("negotiation refused".into());
    }

    let mut failures = 0usize;
    let mut bindings: HashMap<String, Value> = HashMap::new();
    for mut op in ops {
        substitute(&mut op, &bindings)?;
        // An op that refuses on purpose is part of a proof, so the ops file can
        // mark it: `"expect": "failed"` inverts this operation's verdict
        // without inverting the run's. Without it, proving that a mutation
        // WITHOUT the lease is refused would fail the whole probe.
        let expect_failure = op
            .get("expect")
            .and_then(Value::as_str)
            .is_some_and(|expect| expect == "failed");
        if let Some(object) = op.as_object_mut() {
            object.remove("expect");
        }
        let mut typed: Op = serde_json::from_value(op.clone())
            .map_err(|error| format!("operation {op} is not a valid request: {error}"))?;
        prepare_client_op(negotiated_protocol, &mut typed)?;
        let sent = send(typed)?;
        let (applied, payload) = await_response_with_payload(&pipe, sent)?;
        if applied != !expect_failure {
            failures += 1;
        }
        if applied {
            bind_from_response(&op, payload.as_ref(), &mut bindings);
        }
    }

    if linger > 0 {
        // Reads block with no timeout, so the drain runs on its own thread and
        // the process exits when either the turn ends or the window closes.
        // `linger` is therefore a maximum, not a fixed wait.
        let code = if failures > 0 { 1 } else { 0 };
        let drain = Arc::new(pipe);
        std::thread::spawn(move || loop {
            let frame: ServerFrame = match read_json_bounded(drain.handle(), MAX_SESSION_FRAME) {
                Ok(frame) => frame,
                Err(_) => std::process::exit(code),
            };
            let _ = print_one(&frame);
            // A `result` line closes a Claude turn: nothing further is coming
            // for this prompt, so a disposable client need not wait out its
            // whole window.
            if let ServerFrame::Event(event) = &frame {
                if let EventBody::Agent { line } = &event.body {
                    if line.get("type").and_then(Value::as_str) == Some("result") {
                        std::process::exit(code);
                    }
                }
            }
        });
        std::thread::sleep(Duration::from_millis(linger));
        std::process::exit(code);
    }
    if failures > 0 {
        return Err(format!("{failures} operation(s) did not apply"));
    }
    Ok(())
}

pub(super) fn prepare_client_op(protocol: u32, op: &mut Op) -> Result<(), String> {
    if protocol == PROTOCOL_V1 {
        if let Op::Spawn(params) = op {
            match params.agent {
                None | Some(Agent::Claude) => params.agent = None,
                Some(Agent::Codex) => {
                    return Err("refusing to send a Codex spawn through protocol v1".into())
                }
            }
        }
    }
    Ok(())
}

/// Replace any string that is exactly `$name` with the bound value.
///
/// Whole-value replacement, not string interpolation, so a binding can be a
/// number or an object — `$generation` must arrive as a number and `$lease` as
/// `{token, revision}`, and splicing either into a string would produce a frame
/// the server correctly refuses.
/// An unbound `$name` is an ERROR, never passed through. Leaving it in place
/// sent the literal text `"$session"` to the server, which refused it for the
/// wrong reason — a proof step that fails for a reason the proof did not intend
/// is indistinguishable from one that fails for the reason it did.
fn substitute(value: &mut Value, bindings: &HashMap<String, Value>) -> Result<(), String> {
    match value {
        Value::String(text) => {
            if let Some(name) = text.strip_prefix('$') {
                let bound = bindings.get(name).ok_or_else(|| {
                    format!(
                        "operation refers to ${name}, which no earlier response bound \
                         (bound so far: {})",
                        {
                            let mut names: Vec<&str> =
                                bindings.keys().map(String::as_str).collect();
                            names.sort_unstable();
                            if names.is_empty() {
                                "nothing".into()
                            } else {
                                names.join(", ")
                            }
                        }
                    )
                })?;
                *value = bound.clone();
            }
        }
        Value::Array(items) => {
            for item in items {
                substitute(item, bindings)?;
            }
        }
        Value::Object(map) => {
            for (_, item) in map.iter_mut() {
                substitute(item, bindings)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Record what a successful response makes available to later operations.
///
/// Deliberately small and explicit rather than a general path language: every
/// name here exists because a slice-2 proof needs it, and a binding nobody
/// needs is a feature to maintain for nothing.
fn bind_from_response(op: &Value, payload: Option<&Value>, bindings: &mut HashMap<String, Value>) {
    let Some(payload) = payload else { return };
    match op.get("op").and_then(Value::as_str) {
        Some("spawn") => {
            if let Some(summary) = payload.get("session") {
                if let Some(id) = summary.get("session") {
                    bindings.insert("session".into(), id.clone());
                }
                if let Some(generation) = summary.get("generation") {
                    bindings.insert("generation".into(), generation.clone());
                }
            }
        }
        Some("acquire-control") => {
            if let (Some(token), Some(revision)) = (payload.get("token"), payload.get("revision")) {
                bindings.insert(
                    "lease".into(),
                    json!({ "token": token, "revision": revision }),
                );
            }
        }
        Some("submit") => {
            if let Some(prompt) = payload.get("prompt") {
                bindings.insert("prompt".into(), prompt.clone());
            }
        }
        Some("attach") => {
            // The cut THIS attach returned. A proof that hydrates must use its
            // own cut: an earlier connection's is a lower bound, and hydrating
            // through it silently returns only the history that existed then —
            // which looks exactly like the newer records never being written.
            if let Some(through) = payload.get("through") {
                bindings.insert("through".into(), through.clone());
            }
        }
        _ => {}
    }
}

/// [`await_response`], also handing back the payload so a later operation can
/// refer to it.
fn await_response_with_payload(
    pipe: &OwnedHandle,
    request: u64,
) -> Result<(bool, Option<Value>), String> {
    loop {
        let frame: ServerFrame = read_json_bounded(pipe.handle(), MAX_SESSION_FRAME)?;
        print_one(&frame)?;
        if let ServerFrame::Response(response) = &frame {
            if response.request == request {
                return Ok((
                    matches!(response.outcome, crate::protocol::Outcome::Applied),
                    response.payload.clone(),
                ));
            }
        }
    }
}

/// Read frames until the response for `request` arrives, printing everything on
/// the way.
///
/// Correlation is not optional here: once a session is attached, pushed events
/// interleave with responses, so "the next frame is my answer" is wrong the
/// moment the agent says anything.
fn await_response(pipe: &OwnedHandle, request: u64) -> Result<bool, String> {
    loop {
        let frame: ServerFrame = read_json_bounded(pipe.handle(), MAX_SESSION_FRAME)?;
        print_one(&frame)?;
        if let ServerFrame::Response(response) = &frame {
            if response.request == request {
                return Ok(matches!(
                    response.outcome,
                    crate::protocol::Outcome::Applied
                ));
            }
        }
    }
}

#[allow(dead_code)] // parked probe helper: no caller today, kept beside await_response/print_one
fn print_frame(pipe: &OwnedHandle) -> Result<(), String> {
    let frame: ServerFrame = read_json_bounded(pipe.handle(), MAX_SESSION_FRAME)?;
    print_one(&frame)
}

fn print_one(frame: &ServerFrame) -> Result<(), String> {
    use std::io::Write;
    println!(
        "{}",
        serde_json::to_string(frame).map_err(|error| error.to_string())?
    );
    let _ = std::io::stdout().flush();
    Ok(())
}
