use std::{
    mem::size_of,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::Sender,
        Arc,
    },
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewWindowBuilder};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{FILETIME, HANDLE, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileW, FlushFileBuffers, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL,
            FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_GENERIC_READ, FILE_GENERIC_WRITE, OPEN_EXISTING,
            PIPE_ACCESS_DUPLEX,
        },
        System::{
            Pipes::{
                ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe,
                GetNamedPipeServerProcessId, WaitNamedPipeW, PIPE_READMODE_BYTE,
                PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
            },
            Threading::{
                CreateEventW, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, SetEvent,
                WaitForMultipleObjects, WaitForSingleObject, INFINITE, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
            IO::CancelIoEx,
        },
    },
};

use crate::{
    registry::FalconRegistry,
    security::{wide, win_error, OwnedHandle, UserSecurity},
    serve::peer::{activation_allowed, filetime_now, Peer, PeerPolicy},
};

const MAX_FRAME: usize = 16 * 1024;

/// How long an activation client has to deliver its request, and separately
/// to take its response. Activation callers write one tiny frame right after
/// connecting, so this only ever ends a connection that is not going to.
const ACTIVATION_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

/// How long an activation response may wait in the pipe for its reader before
/// the instance is disconnected anyway.
const ACTIVATION_FLUSH_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

/// `FlushFileBuffers`, abandoned after `grace`.
///
/// On a pipe the flush blocks until the peer has read everything, so a peer
/// that never reads holds it forever. It runs on its own thread holding its own
/// `Arc`; the caller returns on the deadline and disconnects, which is what
/// releases that thread (the same shape as `serve::writer::flush_within`).
fn flush_within(pipe: &std::sync::Arc<OwnedHandle>, grace: std::time::Duration) {
    let pipe = std::sync::Arc::clone(pipe);
    let (finished, waited) = std::sync::mpsc::channel::<()>();
    if std::thread::Builder::new()
        .spawn(move || {
            let _signal_on_exit = finished;
            unsafe {
                let _ = FlushFileBuffers(pipe.handle());
            }
        })
        .is_err()
    {
        return;
    }
    let _ = waited.recv_timeout(grace);
}

/// Windows' own ceiling for `CreateNamedPipeW`'s instance count
/// (`PIPE_UNLIMITED_INSTANCES`). The previous literal 16 was reachable by
/// Vidar alone: one connection per hosted tab plus control and bus
/// A new instance is only created after the previous one
/// connects, so the next `CreateNamedPipeW` past the cap fails with
/// `ERROR_PIPE_BUSY` and, before this fix, ended the accept thread for good.
const PIPE_MAX_INSTANCES: u32 = 255;

/// How long an accept loop waits before retrying `CreateNamedPipeW` after a
/// post-startup failure, and the cap that backoff doubles toward. The first
/// attempt (`first == true`) still fails the caller's `ready` channel and
/// returns, because that failure means the endpoint itself cannot be served;
/// a later failure (pipe-instance exhaustion, a transient OS error) must not
/// end the loop, or the session/activation endpoint is gone until the host is
/// killed, which kills every live session.
pub(crate) const PIPE_ACCEPT_RETRY_MIN: std::time::Duration = std::time::Duration::from_millis(100);
pub(crate) const PIPE_ACCEPT_RETRY_MAX: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Debug, Deserialize, Serialize)]
struct Request {
    protocol: u32,
    secret: String,
    command: String,
    /// Only `shutdown` reads it: end the host even with live sessions. Absent = false, so
    /// an older client's request still parses (and `shutdown` from it is refused while live).
    #[serde(default)]
    force: bool,
}

/// Callback answering "is any hosted session still running?" (`Host::has_live_sessions`).
pub type LiveSessions = std::sync::Arc<dyn Fn() -> bool + Send + Sync>;

/// `shutdown` ends every hosted session mid-turn, so any caller holding the secret is
/// refused while one is live unless it says `force` (security audit W2-6). The idle exit
/// does not come through here: it fires only when no session is live.
pub(crate) fn shutdown_allowed(live: bool, force: bool) -> Result<(), String> {
    if live && !force {
        Err("shutdown refused: hosted sessions are live (send force to end them)".into())
    } else {
        Ok(())
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Response {
    pub ok: bool,
    pub endpoint: String,
    pub pid: u32,
    pub bundle_id: String,
    pub command: String,
    pub window_created: Option<bool>,
    pub error: Option<String>,
}

pub fn serve(
    endpoint_kind: &'static str,
    endpoint: String,
    registry: FalconRegistry,
    security: &'static UserSecurity,
    app: AppHandle,
    allow_exit: Arc<AtomicBool>,
    live_sessions: LiveSessions,
    peers: PeerPolicy,
    ready: Sender<Result<(), String>>,
) {
    std::thread::spawn(move || {
        let mut first = true;
        let mut backoff = PIPE_ACCEPT_RETRY_MIN;
        loop {
            // Overlapped, so the request read below can carry a deadline. A
            // synchronous `ReadFile` has none: a client that connected and
            // never wrote held this thread and a pipe instance forever.
            let pipe = match create_server_full(&endpoint, security, first, MAX_FRAME, true) {
                Ok(pipe) => pipe,
                Err(error) => {
                    if first {
                        let _ = ready.send(Err(error));
                        return;
                    }
                    eprintln!(
                        "{endpoint_kind} accept failed, retrying in {backoff:?}: {error}"
                    );
                    std::thread::sleep(backoff);
                    backoff = (backoff * 2).min(PIPE_ACCEPT_RETRY_MAX);
                    continue;
                }
            };
            backoff = PIPE_ACCEPT_RETRY_MIN;
            if first {
                let _ = ready.send(Ok(()));
                first = false;
            }
            if let Err(error) = connect_overlapped(pipe.0) {
                eprintln!("{endpoint_kind} connect failed: {error}");
                continue;
            }
            let connected_at = filetime_now();
            let connection_peers = peers.clone();
            let connection_registry = registry.clone();
            let connection_app = app.clone();
            let connection_allow_exit = allow_exit.clone();
            let connection_live = live_sessions.clone();
            std::thread::spawn(move || {
                let pipe = std::sync::Arc::new(pipe);
                let handle = pipe.handle();
                // Held to the end of this thread: the open process handle keeps
                // the peer's PID from being reused while it is served.
                let peer = connection_peers.identify(handle, connected_at);
                let deadline = std::time::Instant::now() + ACTIVATION_DEADLINE;
                let response = match read_json_overlapped_by::<Request>(handle, MAX_FRAME, deadline) {
                    Ok(request) => handle_request(
                        endpoint_kind,
                        &peer,
                        request,
                        &connection_registry,
                        &connection_app,
                        &connection_allow_exit,
                        &connection_live,
                    ),
                    Err(error) => failure(endpoint_kind, &connection_registry, "invalid", error),
                };
                // The response gets a fresh deadline of its own: the handler
                // may legitimately take a while (it can create a window).
                let deadline = std::time::Instant::now() + ACTIVATION_DEADLINE;
                match write_json_overlapped_by(handle, &response, MAX_FRAME, deadline) {
                    // The response is in the pipe's buffer; give the peer a
                    // bounded moment to collect it before the disconnect
                    // discards it. A plain `FlushFileBuffers` here waited for
                    // a peer that never reads, forever.
                    Ok(()) => flush_within(&pipe, ACTIVATION_FLUSH_GRACE),
                    // Nothing went out, so there is nothing to flush.
                    Err(error) => eprintln!("{endpoint_kind} response failed: {error}"),
                }
                // Every path ends here: the disconnect also releases a flush
                // still parked on this instance, and the last `Arc` closes it.
                unsafe {
                    let _ = DisconnectNamedPipe(handle);
                }
            });
        }
    });
}

pub fn probe(
    path: &Path,
    endpoint_kind: &str,
    command: &str,
    secret_override: Option<String>,
    force: bool,
) -> Result<Response, String> {
    let registry = crate::registry::read(path)?;
    let endpoint = match endpoint_kind {
        "activation" => &registry.activation_endpoint,
        "session" => &registry.session_endpoint,
        _ => return Err(format!("unknown endpoint {endpoint_kind}")),
    };
    let pipe = connect(endpoint)?;
    bind_server_identity(pipe.0, &registry)?;
    let request = Request {
        protocol: 1,
        secret: secret_override.unwrap_or_else(|| registry.attach_secret.clone()),
        command: command.to_owned(),
        force,
    };
    write_json(pipe.0, &request)?;
    read_json(pipe.0)
}

fn handle_request(
    endpoint: &str,
    peer: &Peer,
    request: Request,
    registry: &FalconRegistry,
    app: &AppHandle,
    allow_exit: &AtomicBool,
    live_sessions: &LiveSessions,
) -> Response {
    if request.secret != registry.attach_secret {
        return failure(
            endpoint,
            registry,
            &request.command,
            "authentication failed".into(),
        );
    }
    if request.protocol < registry.protocol_min || request.protocol > registry.protocol_max {
        return failure(
            endpoint,
            registry,
            &request.command,
            "protocol mismatch".into(),
        );
    }
    if endpoint == "session" && request.command != "ping" {
        return failure(
            endpoint,
            registry,
            &request.command,
            "session proof accepts ping only".into(),
        );
    }
    // The secret proves only "same user"; show, hide and shutdown also need the
    // full role (security H3, `serve::peer`). Pings go unlogged: Vidar's
    // readiness poll sends them in a loop.
    if request.command != "ping" {
        eprintln!(
            "falcon: {endpoint} {} from pid {} role {} ({})",
            request.command,
            peer.pid,
            peer.role.as_str(),
            peer.detail
        );
    }
    if let Err(error) = activation_allowed(peer.role, &request.command, &peer.detail) {
        return failure(endpoint, registry, &request.command, error);
    }

    match request.command.as_str() {
        "ping" => success(endpoint, registry, &request.command, None),
        "show" if endpoint == "activation" => {
            match create_window(app, Path::new(&registry.profile_directory)) {
                Ok(created) => success(endpoint, registry, &request.command, Some(created)),
                Err(error) => failure(endpoint, registry, &request.command, error),
            }
        }
        "hide" if endpoint == "activation" => match destroy_window(app) {
            Ok(existed) => success(endpoint, registry, &request.command, Some(existed)),
            Err(error) => failure(endpoint, registry, &request.command, error),
        },
        "shutdown" if endpoint == "activation" => {
            if let Err(error) = shutdown_allowed(live_sessions(), request.force) {
                return failure(endpoint, registry, &request.command, error);
            }
            let response = success(endpoint, registry, &request.command, None);
            let handle = app.clone();
            allow_exit.store(true, Ordering::SeqCst);
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(100));
                handle.exit(0);
            });
            response
        }
        _ => failure(
            endpoint,
            registry,
            &request.command,
            "unsupported command".into(),
        ),
    }
}

pub(crate) fn create_window(app: &AppHandle, profile_directory: &Path) -> Result<bool, String> {
    let handle = app.clone();
    let profile_directory = profile_directory.to_path_buf();
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let result = if handle.get_webview_window("falcon-proof").is_some() {
            Ok(false)
        } else {
            let config = handle
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "falcon-proof")
                .cloned()
                .ok_or_else(|| "Falcon config has no falcon-proof window".to_string());
            config.and_then(|config| {
                WebviewWindowBuilder::from_config(&handle, &config)
                    .map_err(|error| format!("window config: {error:?}"))?
                    .data_directory(profile_directory)
                    // A reload must fetch the swapped asset set, never WebView2's cached copy.
                    .on_web_resource_request(|_request, response| {
                        response.headers_mut().insert(
                            tauri::http::header::CACHE_CONTROL,
                            tauri::http::HeaderValue::from_static("no-store"),
                        );
                    })
                    .build()
                    .map(|_| true)
                    .map_err(|error| format!("window build: {error:?}"))
            })
        };
        let result = result.and_then(|created| {
            if let Some(window) = handle.get_webview_window("falcon-proof") {
                window
                    .show()
                    .map_err(|error| format!("window show: {error}"))?;
                // Focus only a newly created window. An already-open shell may
                // be behind the user's other work on purpose (an unattended
                // auto-show should surface it, not steal focus from whatever
                // they were already doing in it).
                if created {
                    window
                        .set_focus()
                        .map_err(|error| format!("window focus: {error}"))?;
                }
            }
            Ok(created)
        });
        let _ = send.send(result);
    })
    .map_err(|error| error.to_string())?;
    // Bounded: a main thread that never gets to run this closure (shutdown,
    // deadlock elsewhere) must not park the unattended watcher forever. A
    // timeout is treated the same as any other show failure.
    receive
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| error.to_string())?
}

fn destroy_window(app: &AppHandle) -> Result<bool, String> {
    // Authenticated hide bypasses the WebView close-request callback. Release
    // the shell's connections before destroying its view, just as titlebar
    // close does; hosted children remain owned by Falcon.
    app.state::<Arc<crate::falcon_client::Falcon>>()
        .detach_all()?;
    let handle = app.clone();
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let result = match handle.get_webview_window("falcon-proof") {
            Some(window) => match window.destroy() {
                Ok(()) => Ok(true),
                Err(_error) if handle.get_webview_window("falcon-proof").is_none() => Ok(true),
                Err(error) => Err(format!("window destroy: {error:?}")),
            },
            None => Ok(false),
        };
        let _ = send.send(result);
    })
    .map_err(|error| error.to_string())?;
    receive.recv().map_err(|error| error.to_string())?
}

/// `overlapped` opts the handle into asynchronous I/O.
///
/// This is not a performance choice, it is a correctness one. A handle opened
/// for synchronous I/O has every operation on it serialized by the file object,
/// so a `WriteFile` issued from one thread waits for a `ReadFile` already
/// blocked on another. The session endpoint does exactly that — a writer thread
/// pushes events while the connection thread waits for the next request — and
/// with a synchronous handle it deadlocks: the first response never leaves and
/// the client waits forever. The activation endpoint is strictly one request
/// then one response on a single thread, but is overlapped too: that is what
/// lets its request read carry a deadline.
pub(crate) fn create_server_full(
    endpoint: &str,
    security: &UserSecurity,
    first: bool,
    buffer: usize,
    overlapped: bool,
) -> Result<OwnedHandle, String> {
    let name = wide(endpoint);
    let mut access = PIPE_ACCESS_DUPLEX;
    if first {
        access |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    }
    if overlapped {
        access |= windows::Win32::Storage::FileSystem::FILE_FLAG_OVERLAPPED;
    }
    // PIPE_REJECT_REMOTE_CLIENTS on both endpoints: a remote client is refused
    // by the pipe itself, before any frame is read.
    let mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
    // The kernel buffer is an advisory hint, not the frame bound; a large frame
    // simply takes more round trips through it.
    let buffer = buffer.min(64 * 1024) as u32;
    let handle = unsafe {
        CreateNamedPipeW(
            PCWSTR(name.as_ptr()),
            access,
            mode,
            PIPE_MAX_INSTANCES,
            buffer,
            buffer,
            0,
            Some(security.attributes()),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(win_error(windows::core::Error::from_win32()))
    } else {
        Ok(OwnedHandle(handle))
    }
}

pub(crate) fn connect(endpoint: &str) -> Result<OwnedHandle, String> {
    let name = wide(endpoint);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let ready = unsafe { WaitNamedPipeW(PCWSTR(name.as_ptr()), 200).as_bool() };
        let last_error = if ready {
            let connected = unsafe {
                CreateFileW(
                    PCWSTR(name.as_ptr()),
                    FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0,
                    Default::default(),
                    None,
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    None,
                )
            };
            match connected {
                Ok(handle) => return Ok(OwnedHandle(handle)),
                Err(error) => win_error(error),
            }
        } else {
            win_error(windows::core::Error::from_win32())
        };
        if std::time::Instant::now() >= deadline {
            return Err(format!("timed out connecting to {endpoint}: {last_error}"));
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

pub(crate) fn bind_server_identity(pipe: HANDLE, registry: &FalconRegistry) -> Result<(), String> {
    let mut server_pid = 0u32;
    unsafe {
        GetNamedPipeServerProcessId(pipe, &mut server_pid).map_err(win_error)?;
    }
    if server_pid != registry.pid {
        return Err(format!(
            "connected server PID {server_pid} != registry PID {}",
            registry.pid
        ));
    }

    let process = unsafe {
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, server_pid).map_err(win_error)?
    };
    let process = OwnedHandle(process);
    let created = process_creation_identity(process.0)?;
    if created != registry.process_created_100ns {
        return Err("connected server creation identity does not match registry".into());
    }
    let image = process_image(process.0)?;
    let expected = std::fs::canonicalize(&registry.executable)
        .map_err(|error| format!("canonicalize registered executable: {error}"))?;
    let actual = std::fs::canonicalize(&image)
        .map_err(|error| format!("canonicalize connected executable: {error}"))?;
    if actual != expected {
        return Err(format!(
            "connected server image {} != {}",
            actual.display(),
            expected.display()
        ));
    }
    Ok(())
}

pub fn current_process_creation_identity() -> Result<u64, String> {
    process_creation_identity(unsafe { windows::Win32::System::Threading::GetCurrentProcess() })
}

pub fn process_creation_identity(process: HANDLE) -> Result<u64, String> {
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe {
        GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user)
            .map_err(win_error)?;
    }
    Ok(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
}

pub(crate) fn process_image(process: HANDLE) -> Result<String, String> {
    let mut buffer = vec![0u16; 32768];
    let mut length = buffer.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
        .map_err(win_error)?;
    }
    String::from_utf16(&buffer[..length as usize]).map_err(|error| error.to_string())
}

fn read_json<T: for<'de> Deserialize<'de>>(handle: HANDLE) -> Result<T, String> {
    read_json_bounded(handle, MAX_FRAME)
}

fn write_json<T: Serialize>(handle: HANDLE, value: &T) -> Result<(), String> {
    write_json_bounded(handle, value, MAX_FRAME)
}

/// Length-prefixed JSON with an explicit bound.
///
/// The bound is per endpoint, not global: the activation pipe carries tiny
/// control frames and keeps a 16 KB cap, while a session frame has to be able
/// to hold a full agent line plus its envelope.
pub(crate) fn read_json_bounded<T: for<'de> Deserialize<'de>>(
    handle: HANDLE,
    max: usize,
) -> Result<T, String> {
    let mut length_bytes = [0u8; size_of::<u32>()];
    read_exact(handle, &mut length_bytes)?;
    let length = u32::from_le_bytes(length_bytes) as usize;
    if length == 0 || length > max {
        return Err(format!("frame length {length} exceeds 1..={max}"));
    }
    let mut body = vec![0u8; length];
    read_exact(handle, &mut body)?;
    serde_json::from_slice(&body).map_err(|error| error.to_string())
}

pub(crate) fn write_json_bounded<T: Serialize>(
    handle: HANDLE,
    value: &T,
    max: usize,
) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if body.is_empty() || body.len() > max {
        return Err(format!("frame length {} exceeds 1..={max}", body.len()));
    }
    write_all(handle, &(body.len() as u32).to_le_bytes())?;
    write_all(handle, &body)
}

/// One overlapped operation, waited to completion.
///
/// Each call gets its own `OVERLAPPED` and its own manual-reset event, so
/// concurrent reads and writes on the same handle never share completion state.
/// The wait makes this look blocking to the caller — which is what the callers
/// want — while leaving the handle itself asynchronous, so the two directions
/// do not serialize against each other.
struct Overlapped {
    inner: Box<windows::Win32::System::IO::OVERLAPPED>,
    _event: OwnedHandle,
}

impl Overlapped {
    fn new() -> Result<Self, String> {
        let event = unsafe { CreateEventW(None, true, false, PCWSTR::null()) }
            .map_err(|error| format!("overlapped event: {}", win_error(error)))?;
        let event = OwnedHandle::new(event);
        let mut inner = Box::new(windows::Win32::System::IO::OVERLAPPED::default());
        inner.hEvent = event.handle();
        Ok(Self {
            inner,
            _event: event,
        })
    }

    fn pointer(&mut self) -> *mut windows::Win32::System::IO::OVERLAPPED {
        &mut *self.inner
    }

    /// Wait for the operation to finish, returning bytes transferred.
    fn wait(&mut self, handle: HANDLE) -> Result<u32, String> {
        let mut moved = 0u32;
        unsafe {
            windows::Win32::System::IO::GetOverlappedResult(handle, &*self.inner, &mut moved, true)
        }
        .map_err(|error| win_error(error))?;
        Ok(moved)
    }

    /// Wait for the operation, abandoning it if `shutdown` is raised.
    ///
    /// With no signal this is [`Overlapped::wait`] — a plain wait to
    /// completion. With one, the wait covers the completion event and the
    /// signal together, so a shutdown raised at any moment ends it promptly,
    /// *including* one raised before the operation was ever issued: the signal
    /// is manual-reset, so it is still standing when this wait begins.
    ///
    /// On that path the operation is cancelled by pointer — this one, not every
    /// operation on the handle — and then **reaped before returning**. The
    /// `OVERLAPPED` and the caller's buffer must outlive the kernel's use of
    /// them, and `CancelIoEx` only requests an end; `GetOverlappedResult` is
    /// what observes one. Returning without reaping would free a buffer the
    /// kernel may still write into.
    fn wait_until(&mut self, handle: HANDLE, shutdown: Option<HANDLE>) -> Result<u32, String> {
        let Some(signal) = shutdown else {
            return self.wait(handle);
        };
        let completion = self.inner.hEvent;
        let waited = unsafe { WaitForMultipleObjects(&[completion, signal], false, INFINITE) };
        // WAIT_OBJECT_0 is zero, so the index of the handle that fired is the
        // raw value: 0 is the operation, 1 is the shutdown signal.
        if waited.0 == 0 {
            return self.wait(handle);
        }
        unsafe {
            let _ = CancelIoEx(handle, Some(&*self.inner));
        }
        let _ = self.wait(handle);
        if waited.0 == 1 {
            Err("connection is shutting down".into())
        } else {
            Err(format!("overlapped wait failed: {}", waited.0))
        }
    }

    /// Wait for the operation until `deadline`, then cancel it. Same reaping
    /// discipline as [`Overlapped::wait_until`]: cancelled by pointer, and
    /// observed finished before the buffer can be freed.
    fn wait_by(&mut self, handle: HANDLE, deadline: std::time::Instant) -> Result<u32, String> {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        // INFINITE is u32::MAX; stay below it so a long deadline stays finite.
        let millis = left.as_millis().min(u128::from(u32::MAX - 1)) as u32;
        let waited = unsafe { WaitForSingleObject(self.inner.hEvent, millis) };
        if waited.0 == 0 {
            return self.wait(handle);
        }
        unsafe {
            let _ = CancelIoEx(handle, Some(&*self.inner));
        }
        let _ = self.wait(handle);
        Err(format!(
            "peer did not complete the transfer within its deadline (wait {})",
            waited.0
        ))
    }
}

/// A connection's shutdown signal: a manual-reset event both directions watch.
///
/// Manual-reset is the load-bearing part. A bare `CancelIoEx` on the handle
/// only affects operations already outstanding, so a shutdown landing in the
/// window between "check the flag" and "issue the read" was simply lost, and
/// the read that followed blocked with nothing left to wake it. A standing
/// signal has no such window — an operation issued after the raise sees it on
/// its first wait.
pub(crate) fn create_shutdown_signal() -> Result<OwnedHandle, String> {
    let event = unsafe { CreateEventW(None, true, false, PCWSTR::null()) }
        .map_err(|error| format!("shutdown event: {}", win_error(error)))?;
    Ok(OwnedHandle::new(event))
}

/// Raise a shutdown signal. Idempotent, and never lowered again.
pub(crate) fn raise_shutdown(signal: &OwnedHandle) {
    unsafe {
        let _ = SetEvent(signal.handle());
    }
}

/// `true` once [`raise_shutdown`] has been called on this signal.
pub(crate) fn shutdown_raised(signal: &OwnedHandle) -> bool {
    unsafe { WaitForSingleObject(signal.handle(), 0).0 == 0 }
}

/// `true` when the error only means "started, not finished".
fn is_pending(error: &windows::core::Error) -> bool {
    // ERROR_IO_PENDING as an HRESULT.
    error.code().0 as u32 == 0x8007_03E5
}

/// Duplicate a handle so it can be moved to another thread.
///
/// A raw `HANDLE` is a pointer and therefore not `Send`; `OwnedHandle` carries
/// the `unsafe impl` that makes it movable and closes it exactly once. A
/// duplicate refers to the same pipe instance, so both threads act on one
/// connection — which is the point.
#[allow(dead_code)] // only called from #[cfg(test)] fixtures below; not built in release
pub(crate) fn duplicate_for_thread(handle: HANDLE) -> Result<OwnedHandle, String> {
    use windows::Win32::Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS};
    use windows::Win32::System::Threading::GetCurrentProcess;

    let mut copy = HANDLE::default();
    unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            handle,
            GetCurrentProcess(),
            &mut copy,
            0,
            false,
            DUPLICATE_SAME_ACCESS,
        )
    }
    .map_err(|error| format!("duplicate handle: {}", win_error(error)))?;
    Ok(OwnedHandle::new(copy))
}

/// Wait for a client on an overlapped server handle.
///
/// `ConnectNamedPipe(h, None)` is only valid on a synchronous handle; on an
/// asynchronous one it must be given an `OVERLAPPED` and waited on. A client
/// that connected between `CreateNamedPipeW` and this call reports
/// `ERROR_PIPE_CONNECTED`, which is success, not failure.
pub(crate) fn connect_overlapped(handle: HANDLE) -> Result<(), String> {
    // ERROR_PIPE_CONNECTED is 535 (0x217); as an HRESULT that is 0x8007_0217.
    const ERROR_PIPE_CONNECTED_HRESULT: u32 = 0x8007_0217;
    let mut operation = Overlapped::new()?;
    match unsafe { ConnectNamedPipe(handle, Some(operation.pointer())) } {
        Ok(()) => Ok(()),
        Err(error) if is_pending(&error) => operation.wait(handle).map(|_| ()),
        // Already connected: nothing to wait for.
        Err(error) if error.code().0 as u32 == ERROR_PIPE_CONNECTED_HRESULT => Ok(()),
        Err(error) => Err(win_error(error)),
    }
}

pub(crate) fn read_exact_overlapped_until(
    handle: HANDLE,
    buffer: &mut [u8],
    shutdown: Option<HANDLE>,
) -> Result<(), String> {
    read_exact_overlapped_with(handle, buffer, |operation| {
        operation.wait_until(handle, shutdown)
    })
}

fn read_exact_overlapped_with(
    handle: HANDLE,
    buffer: &mut [u8],
    mut wait: impl FnMut(&mut Overlapped) -> Result<u32, String>,
) -> Result<(), String> {
    let mut filled = 0usize;
    while filled < buffer.len() {
        let mut operation = Overlapped::new()?;
        let mut immediate = 0u32;
        let slice = &mut buffer[filled..];
        let result = unsafe {
            ReadFile(
                handle,
                Some(slice),
                Some(&mut immediate),
                Some(operation.pointer()),
            )
        };
        let moved = match result {
            Ok(()) => wait(&mut operation)?,
            Err(error) if is_pending(&error) => wait(&mut operation)?,
            Err(error) => return Err(win_error(error)),
        };
        if moved == 0 {
            return Err("unexpected end of pipe".into());
        }
        filled += moved as usize;
    }
    Ok(())
}

pub(crate) fn write_all_overlapped_until(
    handle: HANDLE,
    buffer: &[u8],
    shutdown: Option<HANDLE>,
) -> Result<(), String> {
    write_all_overlapped_with(handle, buffer, |operation| {
        operation.wait_until(handle, shutdown)
    })
}

fn write_all_overlapped_with(
    handle: HANDLE,
    buffer: &[u8],
    mut wait: impl FnMut(&mut Overlapped) -> Result<u32, String>,
) -> Result<(), String> {
    let mut written = 0usize;
    while written < buffer.len() {
        let mut operation = Overlapped::new()?;
        let mut immediate = 0u32;
        let slice = &buffer[written..];
        let result = unsafe {
            WriteFile(
                handle,
                Some(slice),
                Some(&mut immediate),
                Some(operation.pointer()),
            )
        };
        let moved = match result {
            Ok(()) => wait(&mut operation)?,
            Err(error) if is_pending(&error) => wait(&mut operation)?,
            Err(error) => return Err(win_error(error)),
        };
        if moved == 0 {
            return Err("pipe write made no progress".into());
        }
        written += moved as usize;
    }
    Ok(())
}

/// A whole length-prefixed frame read over an overlapped handle, abandoned
/// (cancelled and reaped) once `deadline` passes.
fn read_json_overlapped_by<T: for<'de> Deserialize<'de>>(
    handle: HANDLE,
    max: usize,
    deadline: std::time::Instant,
) -> Result<T, String> {
    let mut length_bytes = [0u8; size_of::<u32>()];
    read_exact_overlapped_with(handle, &mut length_bytes, |operation| {
        operation.wait_by(handle, deadline)
    })?;
    let length = u32::from_le_bytes(length_bytes) as usize;
    if length == 0 || length > max {
        return Err(format!("frame length {length} exceeds 1..={max}"));
    }
    let mut body = vec![0u8; length];
    read_exact_overlapped_with(handle, &mut body, |operation| {
        operation.wait_by(handle, deadline)
    })?;
    serde_json::from_slice(&body).map_err(|error| error.to_string())
}

/// [`read_json_overlapped_by`]'s write half.
fn write_json_overlapped_by<T: Serialize>(
    handle: HANDLE,
    value: &T,
    max: usize,
    deadline: std::time::Instant,
) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if body.is_empty() || body.len() > max {
        return Err(format!("frame length {} exceeds 1..={max}", body.len()));
    }
    let mut frame = (body.len() as u32).to_le_bytes().to_vec();
    frame.extend_from_slice(&body);
    write_all_overlapped_with(handle, &frame, |operation| {
        operation.wait_by(handle, deadline)
    })
}

/// [`read_json_bounded`] over an overlapped handle.
#[allow(dead_code)] // only called from #[cfg(test)] fixtures below; not built in release
pub(crate) fn read_json_overlapped<T: for<'de> Deserialize<'de>>(
    handle: HANDLE,
    max: usize,
) -> Result<T, String> {
    read_json_overlapped_until(handle, max, None)
}

/// [`read_json_overlapped`] that gives up when `shutdown` is raised.
pub(crate) fn read_json_overlapped_until<T: for<'de> Deserialize<'de>>(
    handle: HANDLE,
    max: usize,
    shutdown: Option<HANDLE>,
) -> Result<T, String> {
    let mut length_bytes = [0u8; size_of::<u32>()];
    read_exact_overlapped_until(handle, &mut length_bytes, shutdown)?;
    let length = u32::from_le_bytes(length_bytes) as usize;
    if length == 0 || length > max {
        return Err(format!("frame length {length} exceeds 1..={max}"));
    }
    let mut body = vec![0u8; length];
    read_exact_overlapped_until(handle, &mut body, shutdown)?;
    serde_json::from_slice(&body).map_err(|error| error.to_string())
}

/// [`write_json_bounded`] over an overlapped handle.
#[allow(dead_code)] // only called from #[cfg(test)] fixtures below; not built in release
pub(crate) fn write_json_overlapped<T: Serialize>(
    handle: HANDLE,
    value: &T,
    max: usize,
) -> Result<(), String> {
    write_json_overlapped_until(handle, value, max, None)
}

/// [`write_json_overlapped`] that gives up when `shutdown` is raised.
///
/// A frame is a length prefix followed by a body, so abandoning one between the
/// two leaves a truncated frame on the wire. That is acceptable only because
/// the signal is raised exclusively on paths where the connection is already
/// finished — never to end a healthy client's last response.
pub(crate) fn write_json_overlapped_until<T: Serialize>(
    handle: HANDLE,
    value: &T,
    max: usize,
    shutdown: Option<HANDLE>,
) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if body.is_empty() || body.len() > max {
        return Err(format!("frame length {} exceeds 1..={max}", body.len()));
    }
    write_all_overlapped_until(handle, &(body.len() as u32).to_le_bytes(), shutdown)?;
    write_all_overlapped_until(handle, &body, shutdown)
}

fn read_exact(handle: HANDLE, mut buffer: &mut [u8]) -> Result<(), String> {
    while !buffer.is_empty() {
        let mut read = 0u32;
        unsafe {
            ReadFile(handle, Some(buffer), Some(&mut read), None).map_err(win_error)?;
        }
        if read == 0 {
            return Err("unexpected end of pipe".into());
        }
        let (_, rest) = buffer.split_at_mut(read as usize);
        buffer = rest;
    }
    Ok(())
}

fn write_all(handle: HANDLE, mut buffer: &[u8]) -> Result<(), String> {
    while !buffer.is_empty() {
        let mut written = 0u32;
        unsafe {
            WriteFile(handle, Some(buffer), Some(&mut written), None).map_err(win_error)?;
        }
        if written == 0 {
            return Err("pipe write made no progress".into());
        }
        buffer = &buffer[written as usize..];
    }
    Ok(())
}

fn success(
    endpoint: &str,
    registry: &FalconRegistry,
    command: &str,
    window_created: Option<bool>,
) -> Response {
    Response {
        ok: true,
        endpoint: endpoint.into(),
        pid: registry.pid,
        bundle_id: registry.bundle_id.clone(),
        command: command.into(),
        window_created,
        error: None,
    }
}

fn failure(endpoint: &str, registry: &FalconRegistry, command: &str, error: String) -> Response {
    Response {
        ok: false,
        endpoint: endpoint.into(),
        pid: registry.pid,
        bundle_id: registry.bundle_id.clone(),
        command: command.into(),
        window_created: None,
        error: Some(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    /// The invariant a whole afternoon was lost to, asserted directly.
    ///
    /// A pipe handle opened for synchronous I/O has every operation on it
    /// serialized by the file object, so a `WriteFile` issued on one thread
    /// waits behind a `ReadFile` already blocked on another. That is exactly
    /// the server's shape — a writer thread pushing frames while the connection
    /// thread waits for the next request — and on a synchronous handle it
    /// deadlocks: the first response never leaves and every client hangs
    /// forever. 118 unit tests stayed green through it, because not one of them
    /// put a byte through a pipe.
    ///
    /// This spawns exactly that shape and requires the write to complete while
    /// the read is outstanding.
    #[test]
    fn a_write_completes_while_a_read_is_blocked_on_the_same_handle() {
        let security = UserSecurity::current_user().expect("security descriptor");
        let endpoint = format!(
            r"\\.\pipe\falcon-test-overlapped-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        let server_endpoint = endpoint.clone();
        let (ready_send, ready_receive) = channel();
        let (done_send, done_receive) = channel();
        let server = std::thread::spawn(move || {
            let pipe = create_server_full(&server_endpoint, &security, true, 64 * 1024, true)
                .expect("create server");
            ready_send.send(()).ok();
            connect_overlapped(pipe.handle()).expect("connect");

            // The connection thread blocks reading, exactly as `converse` does.
            // `HANDLE` is a raw pointer and so not `Send`; wrapping it in the
            // same `OwnedHandle` the rest of the crate uses is what carries it
            // across the boundary, and the duplicate is closed with the wrapper.
            let reader_handle = duplicate_for_thread(pipe.handle()).expect("duplicate handle");
            let reader = std::thread::spawn(move || {
                let _: Result<serde_json::Value, String> =
                    read_json_overlapped(reader_handle.handle(), 64 * 1024);
            });

            // Give the read time to be genuinely outstanding, then write from
            // this thread. On a synchronous handle this never returns.
            std::thread::sleep(std::time::Duration::from_millis(150));
            let wrote = write_json_overlapped(
                pipe.handle(),
                &serde_json::json!({ "hello": "client" }),
                64 * 1024,
            );
            done_send.send(wrote.is_ok()).ok();
            let _ = reader.join();
        });

        ready_receive.recv().expect("server ready");
        let client = connect(&endpoint).expect("client connect");

        // If the server deadlocked, this times out and the test fails loudly
        // rather than hanging the suite forever.
        let wrote_ok = done_receive
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("server write did not complete: the handle is serializing read against write");
        assert!(wrote_ok, "server write failed");

        let frame: serde_json::Value =
            read_json_bounded(client.handle(), 64 * 1024).expect("client read");
        assert_eq!(frame["hello"], "client");

        // Unblock the server's reader so its thread can finish.
        let _ = write_json_bounded(
            client.handle(),
            &serde_json::json!({ "bye": true }),
            64 * 1024,
        );
        let _ = server.join();
    }

    /// A connected pipe with a silent peer, for the shutdown tests. The client
    /// handle is returned only so it stays open: the moment it closes, the read
    /// under test would end by itself and prove nothing.
    fn silent_peer(name: &str) -> (OwnedHandle, OwnedHandle) {
        let security = UserSecurity::current_user().expect("security descriptor");
        let endpoint = format!(
            r"\\.\pipe\falcon-test-{}-{}-{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let server =
            create_server_full(&endpoint, &security, true, 64 * 1024, true).expect("create server");
        let (ready, connected) = channel();
        let waiting = duplicate_for_thread(server.handle()).expect("duplicate handle");
        std::thread::spawn(move || {
            ready.send(connect_overlapped(waiting.handle())).ok();
        });
        let client = connect(&endpoint).expect("client connect");
        connected
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("server never accepted")
            .expect("connect failed");
        (server, client)
    }

    /// A shutdown raised *before* the read is issued must still end it.
    ///
    /// This is the race a one-shot `CancelIoEx(handle, None)` cannot win.
    /// Cancellation only affects operations already outstanding, so a shutdown
    /// landing in the window between "the connection is finished" and "issue
    /// the next read" was simply lost, and that read then waited on a peer that
    /// was never going to speak again — holding the connection, its threads and
    /// its slot in the host's client count forever. A manual-reset event has no
    /// such window: it is still standing when the operation begins.
    #[test]
    fn a_read_ends_when_shutdown_was_raised_before_it_started() {
        let (server, client) = silent_peer("shutdown-before");
        let shutdown = create_shutdown_signal().expect("shutdown event");
        raise_shutdown(&shutdown);
        assert!(shutdown_raised(&shutdown));

        let started = std::time::Instant::now();
        let result: Result<serde_json::Value, String> =
            read_json_overlapped_until(server.handle(), 64 * 1024, Some(shutdown.handle()));
        assert!(result.is_err(), "a read under shutdown must not succeed");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the read took {:?}; a standing shutdown signal must end it at once",
            started.elapsed()
        );
        drop(client);
    }

    /// A shutdown raised *during* an outstanding read ends it promptly, and the
    /// read is reaped rather than abandoned — its buffer and `OVERLAPPED` go
    /// out of scope the moment this returns.
    #[test]
    fn a_read_ends_when_shutdown_is_raised_while_it_waits() {
        let (server, client) = silent_peer("shutdown-during");
        let shutdown = Arc::new(create_shutdown_signal().expect("shutdown event"));

        let signal = Arc::clone(&shutdown);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(200));
            raise_shutdown(&signal);
        });

        let started = std::time::Instant::now();
        let result: Result<serde_json::Value, String> =
            read_json_overlapped_until(server.handle(), 64 * 1024, Some(shutdown.handle()));
        assert!(result.is_err(), "a read under shutdown must not succeed");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the read took {:?}; raising the signal must cancel it",
            started.elapsed()
        );
        drop(client);
    }

    /// The mechanism the shutdown signal replaced, kept as a test so it is not
    /// tried again.
    ///
    /// `CancelIoEx(handle, None)` cancels the operations outstanding at the
    /// instant it is called. Calling it and *then* issuing a read — the exact
    /// interleaving a disconnect between two requests produces — cancels
    /// nothing, and that read waits on a peer which will never speak again.
    /// Asserted positively and bounded: the read is required NOT to return.
    #[test]
    fn a_one_shot_cancel_does_not_wake_a_read_issued_after_it() {
        let (server, client) = silent_peer("one-shot-cancel");
        unsafe {
            let _ = CancelIoEx(server.handle(), None);
        }

        let reading = duplicate_for_thread(server.handle()).expect("duplicate handle");
        let (returned, watched) = channel();
        std::thread::spawn(move || {
            let result: Result<serde_json::Value, String> =
                read_json_overlapped(reading.handle(), 64 * 1024);
            returned.send(result.is_err()).ok();
        });

        assert!(
            watched
                .recv_timeout(std::time::Duration::from_secs(2))
                .is_err(),
            "a one-shot cancel now appears to wake a later read; if that is \
             genuinely true the standing shutdown signal could be simplified away"
        );

        // Close the peer so the parked read ends and its thread can exit.
        drop(client);
        assert_eq!(
            watched.recv_timeout(std::time::Duration::from_secs(5)),
            Ok(true),
            "the parked read should end once the peer closes"
        );
    }

    /// An activation client that connects and never writes: the deadline read
    /// ends on time, and the cancelled read is reaped rather than left
    /// outstanding — the same instance then carries a real frame intact.
    #[test]
    fn a_deadline_read_ends_and_is_reaped_when_the_peer_never_writes() {
        let (server, client) = silent_peer("deadline-read");
        let started = std::time::Instant::now();
        let deadline = started + std::time::Duration::from_millis(200);
        let result: Result<serde_json::Value, String> =
            read_json_overlapped_by(server.handle(), 64 * 1024, deadline);
        assert!(result.is_err(), "a read past its deadline must not succeed");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the read took {:?}; its deadline was 200ms",
            started.elapsed()
        );

        write_json_bounded(client.handle(), &serde_json::json!({ "late": 1 }), 64 * 1024)
            .expect("client write");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let frame: serde_json::Value = read_json_overlapped_by(server.handle(), 64 * 1024, deadline)
            .expect("a reaped read must leave the instance usable");
        assert_eq!(frame["late"], 1);
    }

    /// A peer that never reads: a write larger than the pipe's buffer ends on
    /// its deadline instead of pending forever.
    #[test]
    fn a_deadline_write_ends_when_the_peer_never_reads() {
        let security = UserSecurity::current_user().expect("security descriptor");
        let endpoint = format!(
            r"\\.\pipe\falcon-test-deadline-write-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let server =
            create_server_full(&endpoint, &security, true, 4096, true).expect("create server");
        let (ready, connected) = channel();
        let waiting = duplicate_for_thread(server.handle()).expect("duplicate handle");
        std::thread::spawn(move || {
            ready.send(connect_overlapped(waiting.handle())).ok();
        });
        let client = connect(&endpoint).expect("client connect");
        connected
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("server never accepted")
            .expect("connect failed");

        let big = serde_json::json!({ "pad": "x".repeat(1024 * 1024) });
        let started = std::time::Instant::now();
        let deadline = started + std::time::Duration::from_millis(200);
        let result = write_json_overlapped_by(server.handle(), &big, 2 * 1024 * 1024, deadline);
        assert!(result.is_err(), "a write nobody reads must not complete");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the write took {:?}; its deadline was 200ms",
            started.elapsed()
        );
        drop(client);
    }

    /// The activation tail: a response sits unread in the buffer, and the
    /// bounded flush returns after its grace instead of waiting on the peer.
    /// The disconnect that follows releases the parked flush thread.
    #[test]
    fn the_activation_flush_is_bounded_when_the_peer_never_reads() {
        let (server, client) = silent_peer("flush-grace");
        let server = std::sync::Arc::new(server);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        write_json_overlapped_by(server.handle(), &serde_json::json!({ "unread": true }), 64 * 1024, deadline)
            .expect("a small response fits the buffer");

        let started = std::time::Instant::now();
        flush_within(&server, std::time::Duration::from_millis(200));
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the flush took {:?}; its grace was 200ms",
            started.elapsed()
        );
        unsafe {
            let _ = DisconnectNamedPipe(server.handle());
        }
        drop(client);
    }

    #[test]
    fn request_frame_is_bounded() {
        let request = Request {
            protocol: 1,
            secret: "x".repeat(MAX_FRAME),
            command: "ping".into(),
            force: false,
        };
        let body = serde_json::to_vec(&request).unwrap();
        assert!(body.len() > MAX_FRAME);
    }

    #[test]
    fn shutdown_is_refused_while_sessions_are_live() {
        let error = shutdown_allowed(true, false).unwrap_err();
        assert!(error.contains("refused"), "{error}");
    }

    #[test]
    fn shutdown_is_allowed_with_no_live_sessions() {
        assert!(shutdown_allowed(false, false).is_ok());
    }

    #[test]
    fn shutdown_is_allowed_with_force_even_when_live() {
        assert!(shutdown_allowed(true, true).is_ok());
    }

    #[test]
    fn a_request_without_force_parses_as_not_forced() {
        let request: Request =
            serde_json::from_str(r#"{"protocol":1,"secret":"s","command":"shutdown"}"#).unwrap();
        assert!(!request.force);
        let forced: Request =
            serde_json::from_str(r#"{"protocol":1,"secret":"s","command":"shutdown","force":true}"#).unwrap();
        assert!(forced.force);
    }

}
