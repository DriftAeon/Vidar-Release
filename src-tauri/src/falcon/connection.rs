//! The session-pipe connection: negotiate, length-prefixed frames, and one
//! bounded request/reply exchange.

use std::{
    io::{Read, Write},
    sync::Arc,
    time::Duration,
};

use serde::Deserialize;
use serde_json::{json, Value};

use super::reader_control::ReaderControl;
use super::{
    FalconRegistry, Op, Outcome, Response, CLIENT_NAME, CLIENT_PROTOCOL, MAX_FRAME,
    REQUEST_TIMEOUT,
};

/// The protocol version to claim in a negotiate/activation request: the lower of what
/// this client speaks and what the host accepts, refused client-side if that still
/// falls under the host's floor (see `CLIENT_PROTOCOL`'s doc for why).
pub(super) fn negotiated_protocol(registry: &FalconRegistry) -> Result<u32, String> {
    let protocol = CLIENT_PROTOCOL.min(registry.protocol_max);
    if protocol < registry.protocol_min {
        return Err(format!(
            "falcon host requires protocol {} or higher; this client speaks up to {CLIENT_PROTOCOL}",
            registry.protocol_min
        ));
    }
    Ok(protocol)
}

/// Server identity check for a freshly opened session pipe (pid, creation
/// time, image against the registry). Vidar uses `host_identity`'s port; the
/// shell build has no `host_identity` and calls the host crate's own copy.
#[cfg(not(falcon_shell))]
fn verify_server(pipe: &std::fs::File, registry: &FalconRegistry) -> Result<(), String> {
    super::host_identity::bind_server_identity(pipe, registry)
}

#[cfg(falcon_shell)]
fn verify_server(pipe: &std::fs::File, registry: &FalconRegistry) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    crate::ipc::bind_server_identity(
        windows::Win32::Foundation::HANDLE(pipe.as_raw_handle()),
        registry,
    )
}

pub(super) struct Connection {
    pub(super) pipe: std::fs::File,
    /// The host's negotiate-reply `capabilities` (protocol.rs `CAPABILITIES`).
    /// Empty for an older host and for a connection that did not negotiate.
    pub(super) capabilities: Vec<String>,
}

impl Connection {
    /// A connection over an already-open pipe that has not negotiated, so it
    /// claims no capabilities.
    pub(super) fn raw(pipe: std::fs::File) -> Self {
        Self {
            pipe,
            capabilities: Vec::new(),
        }
    }

    /// Open and negotiate. Fails closed: a refused negotiation is an error, not
    /// a connection to retry blindly.
    pub(super) fn open(registry: &FalconRegistry) -> Result<Self, String> {
        use std::os::windows::fs::OpenOptionsExt;
        // A named pipe client is just a file open. No FILE_FLAG_OVERLAPPED:
        // see the module header for why this connection never needs it.
        let pipe = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .attributes(0)
            .open(&registry.session_endpoint)
            .map_err(|error| format!("connect {}: {error}", registry.session_endpoint))?;
        // Prove the pipe's server is the registered host BEFORE the attach
        // secret goes out on it: a squatter on the pipe name would otherwise
        // receive the secret. Same check the activation pipe makes.
        verify_server(&pipe, registry)?;
        let protocol = negotiated_protocol(registry)?;
        let mut connection = Self::raw(pipe);
        let reply = connection.request(
            1,
            Op::Negotiate {
                protocol,
                client: CLIENT_NAME.to_string(),
                secret: registry.attach_secret.clone(),
            },
            REQUEST_TIMEOUT,
        )?;
        if reply.outcome != Outcome::Applied {
            return Err(format!(
                "falcon refused this client: {}",
                reply.error.unwrap_or_else(|| "no reason given".into())
            ));
        }
        connection.capabilities = reply
            .payload
            .as_ref()
            .and_then(|payload| payload.get("capabilities"))
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        Ok(connection)
    }

    pub(super) fn write_frame(&mut self, value: &Value) -> Result<(), String> {
        let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        if body.is_empty() || body.len() > MAX_FRAME {
            return Err(format!("frame of {} bytes is out of range", body.len()));
        }
        self.pipe
            .write_all(&(body.len() as u32).to_le_bytes())
            .and_then(|()| self.pipe.write_all(&body))
            .map_err(|error| format!("write to falcon: {error}"))
    }

    pub(super) fn read_frame(&mut self) -> Result<Value, String> {
        let mut length = [0u8; 4];
        self.pipe
            .read_exact(&mut length)
            .map_err(|error| format!("read from falcon: {error}"))?;
        let length = u32::from_le_bytes(length) as usize;
        if length == 0 || length > MAX_FRAME {
            return Err(format!("falcon sent a frame of {length} bytes"));
        }
        let mut body = vec![0u8; length];
        self.pipe
            .read_exact(&mut body)
            .map_err(|error| format!("read from falcon: {error}"))?;
        serde_json::from_slice(&body).map_err(|error| format!("falcon sent bad JSON: {error}"))
    }

    /// Send one request and read until its reply, bounded by `timeout`.
    ///
    /// Frames that are not this reply are skipped rather than trusted: the
    /// control connection never attaches, so none should arrive, but "the next
    /// frame is my answer" is the assumption that breaks the moment anything
    /// pushes an event.
    pub(super) fn request(&mut self, id: u64, op: Op, timeout: Duration) -> Result<Reply, String> {
        let what = op.name();
        let frame = request_frame(id, &op)?;
        self.write_frame(&frame)?;

        // Bounded: this pipe is opened without FILE_FLAG_OVERLAPPED (module
        // header), so the read itself cannot carry a timeout — read on its
        // own thread and bound the WAIT instead, the same shape
        // `activation_request` uses. On timeout the reader thread is tracked
        // by the same `ReaderControl` the event reader uses (`start_event_
        // reader`), rather than abandoned: a Windows named pipe instance
        // stays connected as long as any handle to it is open, so an
        // abandoned thread blocked in `read_frame` would leave this
        // duplicated handle open and the pipe would never actually
        // disconnect — the two comments elsewhere in this file that assume
        // "broken pipe -> lease released" (`detach_local`, `control`) would be
        // false on the timeout path.
        // `ReaderControl::cancel` calls `CancelSynchronousIo` on the reader
        // thread's own OS thread until it observes the thread has exited,
        // which unblocks the pending `ReadFile`, lets the thread return, and
        // drops its `Connection` (hence its duplicated pipe handle) — that is
        // what actually closes the pipe.
        let reader_pipe = self
            .pipe
            .try_clone()
            .map_err(|error| format!("duplicate falcon pipe handle: {error}"))?;
        let mut reader = Connection::raw(reader_pipe);
        let reader_control = Arc::new(ReaderControl::new());
        let reader_thread = Arc::clone(&reader_control);
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _finished = match reader_thread.enter() {
                Ok(finished) => finished,
                Err(error) => {
                    let _ = send.send(Err(error));
                    return;
                }
            };
            let result = loop {
                let frame = match reader.read_frame() {
                    Ok(frame) => frame,
                    Err(error) => break Err(error),
                };
                if let Some(reply) = reply_from_frame(&frame, id) {
                    break Ok(reply);
                }
            };
            let _ = send.send(result);
        });
        match receive.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                reader_control.cancel();
                Err(format!("falcon did not answer {what} within {timeout:?}"))
            }
        }
    }
}

/// The frame `request` writes for `op`: the op's own serialisation with the
/// request `id` added last, the key order the hand-built literals had.
pub(super) fn request_frame(id: u64, op: &Op) -> Result<Value, String> {
    let mut frame =
        serde_json::to_value(op).map_err(|error| format!("encode falcon request: {error}"))?;
    if let Some(object) = frame.as_object_mut() {
        object.insert("id".into(), json!(id));
    }
    Ok(frame)
}

/// `request`'s reply for request `id`, or `None` for any other frame.
///
/// Parsed as the host's own `Response`. A response frame that type cannot read
/// (an outcome this build does not know, a non-string error) is still the
/// answer, read the way the earlier client read it: not applied.
pub(super) fn reply_from_frame(frame: &Value, id: u64) -> Option<Reply> {
    if frame.get("t").and_then(Value::as_str) != Some("response") {
        return None;
    }
    if frame.get("request").and_then(Value::as_u64) != Some(id) {
        return None;
    }
    Some(match Response::deserialize(frame) {
        Ok(response) => Reply {
            outcome: response.outcome,
            payload: response.payload,
            error: response.error,
        },
        Err(_) => Reply {
            outcome: Outcome::Failed,
            payload: frame.get("payload").cloned(),
            // No error text: name the raw outcome ("deferred", …) rather
            // than let `applied` report a bare "failed".
            error: frame
                .get("error")
                .and_then(Value::as_str)
                .or_else(|| frame.get("outcome").and_then(Value::as_str))
                .map(str::to_string),
        },
    })
}

pub(super) struct Reply {
    pub(super) outcome: Outcome,
    pub(super) payload: Option<Value>,
    pub(super) error: Option<String>,
}

impl Reply {
    /// The payload of an applied reply, or the server's own refusal text.
    ///
    /// Falcon refuses by name — "no controller holds this session", "stale
    /// generation N" — so its message is more useful than anything this client
    /// could synthesise, and it is passed through unchanged.
    pub(super) fn applied(self, what: &str) -> Result<Value, String> {
        if self.outcome == Outcome::Applied {
            return Ok(self.payload.unwrap_or(Value::Null));
        }
        let outcome = self.outcome;
        Err(format!(
            "{what}: {}",
            self.error.unwrap_or_else(|| {
                serde_json::to_value(outcome)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_string))
                    .unwrap_or_default()
            })
        ))
    }
}
