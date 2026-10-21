//! Protocol-v1 serving on the authenticated session endpoint.
//!
//! A connection is multiplexed. The client sends [`Request`]s; this server
//! writes a [`ServerFrame::Response`] per request and pushes
//! [`ServerFrame::Event`] frames for every session the connection has attached
//! to. Every frame, response and event alike, goes through one bounded queue per
//! connection drained by a single writer thread: that both prevents frames from
//! interleaving and guarantees no host thread ever blocks on a slow client.
//!
//! Thread shape matters, and is the one non-obvious constraint here.
//! [`ClaudeDriver::command`] blocks waiting for the sidecar's terminal outcome,
//! and that outcome arrives on the session's stdout. So the per-session stdout
//! reader must be a *different* thread from the one handling requests. It is:
//! readers are spawned once per session at spawn time and live as long as the
//! child, while request handling happens on the connection's own thread. A
//! design that parsed child output on the connection thread would deadlock on
//! the first command.
//!
//! Every event fans out to every attached client. The single-controller
//! token and the durable journal replace this fan-out —
//! they do not replace the reservation, which is already authoritative.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc::{sync_channel, Sender, SyncSender, TrySendError},
        Arc, Mutex, MutexGuard, OnceLock,
    },
    time::Duration,
};

use serde_json::{json, Value};
use windows::Win32::System::Pipes::DisconnectNamedPipe;

use crate::{
    claude::ClaudeRuntime,
    codex::CodexRuntime,
    // Server side is overlapped (concurrent reader and writer threads on one
    // handle); the disposable client is strictly sequential, so it keeps the
    // simpler synchronous helpers.
    ipc::{
        create_server_full, create_shutdown_signal, raise_shutdown, read_json_overlapped_until,
        shutdown_raised,
    },
    protocol::{
        Agent, Op, Request, Response, ServerFrame, MAX_SESSION_FRAME, PROTOCOL_V1, PROTOCOL_V2,
        PROTOCOL_VERSION,
    },
    registry::FalconRegistry,
    security::{OwnedHandle, UserSecurity},
    session::Registry,
};

mod bus;
mod dispatch;
mod idle;
mod mutation;
pub(crate) mod peer;
mod probe;
mod slots;
mod spawn;
mod unattended;
mod writer;
// Hosted Codex end to end against the scripted app-server fixture.
#[cfg(test)]
#[path = "serve/journeys/tests.rs"]
mod journeys;

pub use bus::BusHub;
pub use idle::start_idle_watchdog;
pub use probe::probe_session;

use dispatch::dispatch;
use slots::{ClientSlot, LeaseHold, VidarSlot};
use spawn::spawn_session;
use writer::{flush_within, start_writer, FLUSH_GRACE, WRITER_DRAIN};

pub enum AgentRuntime {
    Claude(ClaudeRuntime),
    Codex(CodexRuntime),
}
impl AgentRuntime {
    fn agent(&self) -> Agent {
        match self {
            Self::Claude(_) => Agent::Claude,
            Self::Codex(_) => Agent::Codex,
        }
    }
}

/// Everything a connection needs to act on the host.
pub struct Host {
    pub falcon: FalconRegistry,
    pub registry: Registry,
    pub runtimes: Vec<AgentRuntime>,
    /// Directory holding one journal per session.
    pub journal_root: std::path::PathBuf,
    /// Connections currently being served. Part of the liveness test below, so
    /// a host with no sessions but an attached client is not idle.
    pub clients: AtomicUsize,
    /// Of `clients`, the connections that negotiated as `vidar` (not the
    /// shell). Only these arm the 300 s Vidar-held rule
    /// ([`idle::sweep_orphaned_sessions`]); counted by [`VidarSlot`].
    pub vidar_clients: AtomicUsize,
    /// Raised by the idle watchdog once it commits to exiting
    /// ([`idle::commit_to_exit`]); the accept and spawn paths refuse while it
    /// is set, so nothing new starts on a host that is going away.
    pub exiting: AtomicBool,
    /// Auto-show the Falcon shell for a permission request with no controller
    /// attached. Unset until the app handle exists (`main.rs`'s `.setup`,
    /// which runs after this `Host` is built); a request arriving before then
    /// is treated the same as a failed show — see
    /// [`unattended::watch_unattended_permission`].
    pub show_shell: OnceLock<Box<dyn Fn() -> Result<bool, String> + Send + Sync>>,
    /// Grace before an unattended permission is denied by timeout. Zero means
    /// poll forever — it still auto-shows, it simply never times out.
    pub unattended_grace: Duration,
    /// Grace before a session that never got a conversation id, and has
    /// neither a controller nor a subscriber, ends itself. Zero disables the
    /// sweep. See [`idle::sweep_unused_sessions`].
    pub unused_session_grace: Duration,
    /// Grace before a session that has a conversation id but no controller,
    /// no subscriber and no pending work ends itself; its journal stays for
    /// resume. This rule runs only while `clients` is zero; it also bounds a
    /// Vidar-held orphan whenever no `vidar` client is connected. Zero disables it.
    /// See [`idle::sweep_orphaned_sessions`].
    pub orphan_session_grace: Duration,
    /// Grace for a Vidar-held orphan (Claude, last lease holder `vidar`,
    /// nothing attached or pending) while a `vidar` client IS connected. Zero
    /// disables that rule. See [`idle::sweep_orphaned_sessions`].
    pub vidar_orphan_grace: Duration,
    /// `handoff-jettison.json` in the Falcon dir that holds the registry's dir; a live
    /// record exempts the session it names from the Vidar-held rule. `None`
    /// skips the check (tests).
    pub jettison_handoff: Option<std::path::PathBuf>,
    /// Live pub/sub over the session pipe.
    pub bus: BusHub,
    /// Which pipe peers earn the full role ([`peer`]); everyone else is bus-only.
    pub peers: peer::PeerPolicy,
}

impl Host {
    /// Is anything depending on this host right now?
    ///
    /// A session that has already exited does not count: its state
    /// is purely in memory, so holding the process open preserves nothing. Once
    /// the journal is wired that state lives on disk and survives the exit
    /// anyway.
    /// A hosted session whose child has not exited (the activation `shutdown` guard).
    pub(crate) fn has_live_sessions(&self) -> bool {
        self.registry.list().iter().any(|session| session.exited.is_none())
    }

    fn in_use(&self) -> bool {
        if self.clients.load(Ordering::SeqCst) > 0 {
            return true;
        }
        self.registry
            .list()
            .iter()
            .any(|session| session.exited.is_none())
    }
}

/// How many frames may be queued for one client before it is judged too slow.
/// A Claude turn is chatty, so this is generous; the point is that it is
/// finite.
const CLIENT_BACKLOG: usize = 4096;

/// One connected client.
///
/// Every frame — response and event alike — goes through one bounded queue
/// drained by a single writer thread. That shape is load-bearing twice over:
///
/// - **Nothing blocks on a client.** `send` is a non-blocking `try_send`, so a
///   client that stops reading can never stall the session's stdout reader, the
///   subscriber list, or the child itself. An earlier version called
///   `WriteFile` directly from the subscriber callback while the subscriber
///   mutex was held, so one wedged client could halt the agent and every other
///   client with it.
/// - **Frames cannot interleave.** Only the writer thread touches the pipe's
///   write path, so a length prefix and its body are always adjacent without
///   needing a lock around the write at all.
///
/// A client that exceeds [`CLIENT_BACKLOG`] is disconnected rather than waited
/// for: dropping a subscriber is recoverable, wedging the host is not.
///
/// Both claims above are asserted, not merely stated — see
/// `a_client_that_never_reads_cannot_block_the_publisher`. An invariant left as
/// prose decays silently; this one already did once, when a comment here read
/// "Nothing here may block a reader" above code that blocked.
struct Client {
    /// Identifies this connection for the controller lease, which is bound to
    /// a connection rather than to a client name — names are untrusted and two
    /// windows of the same app share one.
    id: u64,
    outbound: SyncSender<ServerFrame>,
    dead: AtomicBool,
    /// Raised when pipe I/O in flight must be abandoned rather than waited on.
    /// Both directions wait on it alongside their own completion, so neither
    /// thread's lifetime depends on the peer ever reading again.
    shutdown: Arc<OwnedHandle>,
}

impl Client {
    fn send(&self, frame: ServerFrame) -> Result<(), String> {
        if self.dead.load(Ordering::SeqCst) {
            return Err("client disconnected".into());
        }
        match self.outbound.try_send(frame) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                self.disconnect();
                Err(format!("client exceeded {CLIENT_BACKLOG} queued frames"))
            }
            Err(TrySendError::Disconnected(_)) => {
                self.disconnect();
                Err("client writer has stopped".into())
            }
        }
    }

    /// Mark the connection dead AND wake both threads working on it.
    ///
    /// Flagging alone was a leak: the connection thread sits in an overlapped
    /// `ReadFile` with no deadline, and a client that holds its pipe open while
    /// neither reading nor sending never wakes it. Its subscription, its
    /// queued frames, its two threads and its slot in the host's client count
    /// were all retained indefinitely — and the listener's pipe instance limit
    /// is finite (255, `ipc::PIPE_MAX_INSTANCES`), so enough such clients take
    /// the endpoint down for everyone.
    ///
    /// The wake is a standing signal, not a one-shot `CancelIoEx(handle, None)`.
    /// The one-shot version bounded nothing: it cancelled only what was
    /// outstanding *at that instant*, so a disconnect landing between two reads
    /// left the next one to block forever, and it cancelled operations
    /// belonging to the other direction indiscriminately. Each operation now
    /// watches the signal beside its own completion and cancels only itself.
    ///
    /// This is the hard path — it can truncate a frame in flight. It is called
    /// only where the client is already finished: its queue overflowed, or its
    /// writer stopped. The clean path does not go through here.
    fn disconnect(&self) {
        self.dead.store(true, Ordering::SeqCst);
        raise_shutdown(&self.shutdown);
    }

    /// `true` while neither this client nor the teardown has given up on it.
    fn live(&self) -> bool {
        !self.dead.load(Ordering::SeqCst) && !shutdown_raised(&self.shutdown)
    }
}

pub fn serve_session(
    endpoint: String,
    host: Arc<Host>,
    security: &'static UserSecurity,
    ready: Sender<Result<(), String>>,
) {
    std::thread::spawn(move || {
        let mut first = true;
        let mut backoff = crate::ipc::PIPE_ACCEPT_RETRY_MIN;
        loop {
            let pipe = match create_server_full(&endpoint, security, first, MAX_SESSION_FRAME, true)
            {
                Ok(pipe) => pipe,
                Err(error) => {
                    if first {
                        let _ = ready.send(Err(error));
                        return;
                    }
                    eprintln!("session accept failed, retrying in {backoff:?}: {error}");
                    std::thread::sleep(backoff);
                    backoff = (backoff * 2).min(crate::ipc::PIPE_ACCEPT_RETRY_MAX);
                    continue;
                }
            };
            backoff = crate::ipc::PIPE_ACCEPT_RETRY_MIN;
            if first {
                let _ = ready.send(Ok(()));
                first = false;
            }
            // Overlapped handle, so the connect must be waited on explicitly.
            if let Err(error) = crate::ipc::connect_overlapped(pipe.handle()) {
                eprintln!("session connect failed: {error}");
                continue;
            }
            let connected_at = peer::filetime_now();
            let host = Arc::clone(&host);
            // Counted before the thread starts, so a connection can never be
            // invisible to the idle watchdog in the gap before it runs. The
            // guard is moved into the thread and released by its drop, so every
            // exit path — including a panic — is balanced.
            let slot = ClientSlot::take(&host);
            // Read only after the slot is counted: see `idle::commit_to_exit`
            // for why that order closes the idle exit's check-then-act gap.
            if host.exiting.load(Ordering::SeqCst) {
                drop(slot);
                unsafe {
                    let _ = DisconnectNamedPipe(pipe.handle());
                }
                continue;
            }
            let shutdown = match create_shutdown_signal() {
                Ok(signal) => Arc::new(signal),
                Err(error) => {
                    eprintln!("session shutdown signal failed: {error}");
                    continue; // `slot` drops here: the count stays balanced
                }
            };
            std::thread::spawn(move || {
                let _slot = slot;
                let pipe = Arc::new(pipe);
                let (outbound, inbound) = sync_channel(CLIENT_BACKLOG);
                let writer = start_writer(Arc::clone(&pipe), inbound, Arc::clone(&shutdown));
                // Never reused within a host's life, so a lease can never be
                // matched against a different connection that happens to
                // occupy the same slot later.
                static NEXT_CONNECTION: AtomicU64 = AtomicU64::new(1);
                let connection = NEXT_CONNECTION.fetch_add(1, Ordering::SeqCst);
                let client = Arc::new(Client {
                    id: connection,
                    outbound,
                    dead: AtomicBool::new(false),
                    shutdown: Arc::clone(&shutdown),
                });
                let attached = Mutex::new(HashMap::<String, u64>::new());
                // Dropped as soon as `converse` returns, or on unwind if it
                // panics. Declared before the call so a panic inside it still
                // frees the lease. Dispatch is synchronous inside `converse`,
                // so once it returns nothing on this connection uses the
                // lease; holding it through the writer drain and flush below
                // (up to 7 s) only made a reconnecting client's re-acquire
                // fail as contended.
                let lease = LeaseHold {
                    host: Arc::clone(&host),
                    connection,
                };
                converse(&host, &pipe, &client, &attached, connected_at);
                drop(lease);

                // Teardown. Every step below is bounded, and nothing is
                // cancelled while the client might still be owed a frame.
                //
                // 1. Detach first. A subscriber holds an `Arc<Client>`, so
                //    while one is registered the client — and its queue, and
                //    therefore the writer's `recv` — is kept alive no matter
                //    what this thread does.
                for (id, token) in lock(&attached).drain() {
                    if let Some(session) = host.registry.get(&id) {
                        session.detach(token);
                    }
                }
                // Same step, same reason: a bus subscription holds an
                // `Arc<Client>` too, and RAII on it would delay the writer
                // drain below by however long that clone stayed alive.
                host.bus.unsubscribe(connection);
                // The lease was already released by `drop(lease)` above; see
                // `LeaseHold` for why it is a guard, not a teardown line.
                // A client that failed mid-conversation has already had its I/O
                // abandoned by `disconnect`. One that left cleanly has not, and
                // must not be: a version-mismatched client is promised exactly
                // one answer, and the previous teardown cancelled that answer
                // out from under the writer — sometimes after its length prefix
                // had gone, leaving a truncated frame.
                let left_cleanly = client.live();
                // 2. Close the queue. Step 1 dropped the last other
                //    `Arc<Client>`, so this is what the writer's `recv` sees.
                drop(client);
                // 3. Let the writer finish what it holds, but not forever. If
                //    it cannot, raise the signal: that is the only thing that
                //    stops a peer which stopped reading from owning this thread
                //    and its pipe instance indefinitely.
                let drained = match writer.settle_within(WRITER_DRAIN) {
                    Ok(drained) => drained,
                    Err(writer) => {
                        raise_shutdown(&shutdown);
                        writer.join()
                    }
                };
                // 4. Flush only when there is something to flush for: the
                //    writer delivered every queued frame AND the client never
                //    failed. Even then the wait is bounded — "healthy" is not
                //    the same as "still reading", and a peer can hold a
                //    response unread while being perfectly well-behaved up to
                //    that point.
                if left_cleanly && drained {
                    flush_within(&pipe, FLUSH_GRACE);
                }
                unsafe {
                    let _ = DisconnectNamedPipe(pipe.handle());
                }
            });
        }
    });
}

/// Read requests until the client goes away. The first frame must be a
/// successful `negotiate`; anything else is refused without touching a session.
fn converse(
    host: &Arc<Host>,
    pipe: &OwnedHandle,
    client: &Arc<Client>,
    attached: &Mutex<HashMap<String, u64>>,
    connected_at: u64,
) {
    let mut negotiated = None;
    // The name the client gave at negotiate, recorded on every command it
    // accepts so replay can say WHICH client asked for a thing. Untrusted and
    // cosmetic — it identifies, it does not authorise.
    let mut client_name = String::from("unknown");
    let mut _vidar_slot: Option<VidarSlot> = None;
    // What authorises: the pipe peer, identified once at the first successful
    // negotiate and held (with its process handle) for the connection.
    let mut who: Option<peer::Peer> = None;
    loop {
        // A publisher can give up on this client at any moment — its queue
        // overflows, or its writer dies. The read below watches the same signal
        // it raises, so the check here is only an early out; correctness does
        // not depend on winning the race, which is the whole point of the
        // signal being a standing event rather than a one-shot cancel.
        if !client.live() {
            return;
        }
        let request: Request = match read_json_overlapped_until(
            pipe.handle(),
            MAX_SESSION_FRAME,
            Some(client.shutdown.handle()),
        ) {
            Ok(request) => request,
            // End of pipe is the normal way a client leaves; a malformed frame
            // is not recoverable mid-stream, because the length prefix is lost.
            Err(_) => return,
        };
        let id = request.id;
        let response = if let Op::Negotiate {
            protocol,
            client: name,
            secret,
        } = &request.op
        {
            match negotiate(host, *protocol, secret) {
                Ok(payload) => {
                    negotiated = Some(*protocol);
                    client_name = name.chars().take(64).collect();
                    let role = who
                        .get_or_insert_with(|| {
                            let found = host.peers.identify(pipe.handle(), connected_at);
                            eprintln!(
                                "falcon: session connection {} client {client_name:?} pid {} role {} ({})",
                                client.id,
                                found.pid,
                                found.role.as_str(),
                                found.detail
                            );
                            found
                        })
                        .role;
                    // Only a full-role peer may hold the Vidar slot (it arms the
                    // Vidar-held reap rule); the name alone is untrusted.
                    if role == peer::Role::Full
                        && client_name == idle::VIDAR_CLIENT
                        && _vidar_slot.is_none()
                    {
                        _vidar_slot = Some(VidarSlot::take(host));
                    }
                    Response::applied(id, payload)
                }
                Err(error) => Response::failed(id, error),
            }
        } else if negotiated.is_none() {
            Response::failed(id, "negotiate must be the first request")
        } else {
            let role = who.as_ref().map_or(peer::Role::Bus, |who| who.role);
            let detail = who.as_ref().map_or("no peer identity", |who| who.detail.as_str());
            match peer::admits(role, &request.op, detail) {
                Err(error) => Response::failed(id, error),
                Ok(()) => dispatch(
                    host,
                    client,
                    &client_name,
                    negotiated.expect("checked above"),
                    attached,
                    request,
                ),
            }
        };
        if client.send(ServerFrame::Response(response)).is_err() {
            return;
        }
        // A refused negotiation ends the connection: an unauthenticated or
        // version-mismatched client gets exactly one answer, and the live host
        // and its sessions are left untouched.
        if negotiated.is_none() {
            return;
        }
    }
}

fn negotiate(host: &Arc<Host>, protocol: u32, secret: &str) -> Result<Value, String> {
    // Constant-time comparison is not the control here; the pipe ACL is. The
    // secret defeats an unrelated local process that guessed the pipe name, and
    // the threat model excludes a process already running as this user.
    if secret != host.falcon.attach_secret {
        return Err("authentication failed".into());
    }
    if !(PROTOCOL_V1..=PROTOCOL_VERSION).contains(&protocol) {
        return Err(format!(
            "protocol {protocol} unsupported; this host speaks {PROTOCOL_V1} through {PROTOCOL_VERSION}"
        ));
    }
    let mut payload = json!({
        "protocol": protocol,
        "host_pid": host.falcon.pid,
        "bundle_id": host.falcon.bundle_id,
        "incarnation": host.falcon.process_created_100ns,
    });
    if protocol >= PROTOCOL_V2 {
        payload["supported_agents"] = json!(host.falcon.supported_agents);
        payload["capabilities"] = json!(host_capabilities(&host.falcon.supported_agents));
    }
    Ok(payload)
}

/// The v2 negotiate `capabilities`: the fixed set, plus `codex_turns`,
/// `codex_query` and `codex_bare` only when Codex resolved on this host and
/// its driver runs turns.
fn host_capabilities(supported_agents: &[String]) -> Vec<&'static str> {
    let mut capabilities = crate::protocol::CAPABILITIES.to_vec();
    let codex = supported_agents.iter().any(|a| a == Agent::Codex.as_str());
    if codex && crate::codex::CodexDriver::RUNS_TURNS {
        capabilities.push(crate::protocol::CAPABILITY_CODEX_TURNS);
        capabilities.push(crate::protocol::CAPABILITY_CODEX_QUERY);
        capabilities.push(crate::protocol::CAPABILITY_CODEX_BARE);
    }
    capabilities
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

#[cfg(test)]
mod tests {
    use super::idle::{
        end_orphaned_session, end_unused_session, orphaned_past_grace, sweep_orphaned_sessions,
        unused_past_grace, OrphanClock, OrphanReason,
    };
    use super::probe::prepare_client_op;
    use super::unattended::{
        unattended_permission_target, watch_requests_left_unattended, watch_unattended_permission,
    };
    use super::*;
    use crate::ipc::{read_json_bounded, write_json_bounded};
    use crate::journal::{Body, Journal};
    use crate::process;
    use crate::protocol::Lease;
    use crate::session::{self, AgentDriver, Session};
    use crate::protocol::{BusFrame, Event, EventBody, Op, Request};

    /// A `Client` with no pipe behind it, for the tests that exercise the queue
    /// alone. The shutdown signal is a real event, so `live()` answers honestly.
    fn detached_client(outbound: SyncSender<ServerFrame>) -> Client {
        detached_client_with_id(1, outbound)
    }

    /// As [`detached_client`], with the connection id the bus tests key on.
    fn detached_client_with_id(id: u64, outbound: SyncSender<ServerFrame>) -> Client {
        Client {
            id,
            outbound,
            dead: AtomicBool::new(false),
            shutdown: Arc::new(create_shutdown_signal().expect("shutdown event")),
        }
    }

    /// The invariant the `Client` doc claims, asserted rather than promised: a
    /// client that never drains its queue must not block the thread publishing
    /// to it. Before this, the subscriber callback wrote to the pipe
    /// synchronously while holding the subscriber mutex, so one wedged client
    /// stalled the session's stdout reader and every other client with it.
    #[test]
    fn a_client_that_never_reads_cannot_block_the_publisher() {
        // No pipe, no writer thread: nothing drains this queue, which is the
        // worst case a real wedged client can present.
        let (outbound, _held) = sync_channel(CLIENT_BACKLOG);
        let client = detached_client(outbound);
        let frame = || {
            ServerFrame::Event(Event {
                session: "s1".into(),
                generation: 1,
                seq: 1,
                body: EventBody::Exit { code: Some(0) },
            })
        };

        let started = Instant::now();
        let mut accepted = 0usize;
        // Far more than the backlog: every one of these must return promptly.
        for _ in 0..(CLIENT_BACKLOG * 2) {
            if client.send(frame()).is_ok() {
                accepted += 1;
            }
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "publishing to a wedged client took {:?}; it must never block",
            started.elapsed()
        );
        // It accepts up to the bound, then refuses — it does not grow forever.
        assert_eq!(accepted, CLIENT_BACKLOG);
        assert!(
            client.dead.load(Ordering::SeqCst),
            "a client over its backlog must be marked dead, not waited for"
        );
        // Once dead it stays refused, so no later frame can block either.
        assert!(client.send(frame()).is_err());
    }

    fn test_host() -> Host {
        Host {
            falcon: crate::registry::FalconRegistry {
                schema_version: 1,
                activation_endpoint: r"\\.\pipe\test-activation".into(),
                session_endpoint: r"\\.\pipe\test-session".into(),
                pid: 1,
                process_created_100ns: 42,
                executable: r"C:\test\falcon.exe".into(),
                profile_directory: r"C:\test\profile".into(),
                protocol_min: 1,
                protocol_max: PROTOCOL_VERSION,
                supported_agents: vec![Agent::Claude.as_str().into()],
                bundle_id: "test".into(),
                attach_secret: "secret".into(),
            },
            registry: Registry::for_incarnation(42),
            runtimes: vec![AgentRuntime::Claude(ClaudeRuntime {
                node: r"C:\test\node.exe".into(),
                sidecar: r"C:\test\sidecar.mjs".into(),
                claude_exe: r"C:\test\claude.exe".into(),
                rules_built: None,
                pwsh: None,
            })],
            clients: AtomicUsize::new(0),
            vidar_clients: AtomicUsize::new(0),
            exiting: AtomicBool::new(false),
            journal_root: std::env::temp_dir().join("falcon-test-journals"),
            show_shell: OnceLock::new(),
            unattended_grace: Duration::from_millis(200),
            unused_session_grace: Duration::from_secs(300),
            orphan_session_grace: Duration::from_secs(900),
            vidar_orphan_grace: Duration::from_secs(300),
            jettison_handoff: None,
            bus: BusHub::new(),
            peers: peer::PeerPolicy::none(),
        }
    }

    /// A stub `show_shell`: counts calls via `calls`, always answering
    /// `result`. Used in place of a real `ipc::create_window`, which needs a
    /// live `AppHandle` these tests do not have.
    fn stub_show_shell(
        calls: Arc<AtomicUsize>,
        result: Result<bool, String>,
    ) -> Box<dyn Fn() -> Result<bool, String> + Send + Sync> {
        Box::new(move || {
            calls.fetch_add(1, Ordering::SeqCst);
            result.clone()
        })
    }

    /// The idle watchdog exists so an abandoned host stops squatting the stable
    /// endpoints. Its decision rests entirely on `in_use`, so that is what gets
    /// asserted: a host with no sessions and no clients is idle, and an
    /// attached client alone is enough to keep it alive.
    #[test]
    fn a_host_with_no_sessions_and_no_clients_is_idle() {
        let host = test_host();
        assert!(!host.in_use(), "nothing depends on this host");

        host.clients.fetch_add(1, Ordering::SeqCst);
        assert!(
            host.in_use(),
            "an attached client alone must keep the host alive, even with no sessions"
        );

        host.clients.fetch_sub(1, Ordering::SeqCst);
        assert!(
            !host.in_use(),
            "the last client leaving makes it idle again"
        );
    }

    /// A zero grace disables the watchdog rather than exiting immediately —
    /// otherwise `-idle-grace-secs 0`, meant to park a host for observation,
    /// would kill it at once.
    #[test]
    fn a_zero_grace_never_fires() {
        let fired = Arc::new(AtomicBool::new(false));
        let seen = Arc::clone(&fired);
        start_idle_watchdog(Arc::new(test_host()), Duration::ZERO, move || {
            seen.store(true, Ordering::SeqCst)
        });
        std::thread::sleep(Duration::from_millis(200));
        assert!(!fired.load(Ordering::SeqCst));
    }

    /// A healthy client is not penalised by the bound.
    #[test]
    fn frames_within_the_backlog_are_all_accepted_in_order() {
        let (outbound, inbound) = sync_channel(CLIENT_BACKLOG);
        let client = detached_client(outbound);
        for seq in 1..=10u64 {
            client
                .send(ServerFrame::Event(Event {
                    session: "s1".into(),
                    generation: 1,
                    seq,
                    body: EventBody::Exit { code: None },
                }))
                .expect("within backlog");
        }
        let seen: Vec<u64> = (0..10)
            .map(|_| match inbound.recv().unwrap() {
                ServerFrame::Event(event) => event.seq,
                other => panic!("expected an event, got {other:?}"),
            })
            .collect();
        assert_eq!(seen, (1..=10).collect::<Vec<u64>>());
        assert!(!client.dead.load(Ordering::SeqCst));
    }

    use std::time::Instant;

    /// Start a real listener on a throwaway endpoint and return the host whose
    /// client count the teardown tests assert on.
    fn start_test_host(name: &str) -> (Arc<Host>, String) {
        let endpoint = format!(
            r"\\.\pipe\falcon-test-{}-{}-{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let mut base = test_host();
        base.falcon.session_endpoint = endpoint.clone();
        let host = Arc::new(base);
        // `serve_session` wants a `&'static` descriptor because the real one
        // outlives the process; leaking one per test is the honest equivalent.
        let security: &'static UserSecurity = Box::leak(Box::new(
            UserSecurity::current_user().expect("security descriptor"),
        ));
        let (ready, started) = std::sync::mpsc::channel();
        serve_session(endpoint.clone(), Arc::clone(&host), security, ready);
        started
            .recv_timeout(Duration::from_secs(5))
            .expect("listener never reported")
            .expect("listener failed to start");
        (host, endpoint)
    }

    /// Poll until the host has let go of every connection, or give up.
    fn waited_for_no_clients(host: &Arc<Host>, within: Duration) -> bool {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            if host.clients.load(Ordering::SeqCst) == 0 {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        false
    }

    /// A client that never reads must not be able to keep a connection — and
    /// therefore one of the endpoint's 16 pipe instances — forever.
    ///
    /// This is the shape that defeated the previous teardown. The client is
    /// well-behaved right up to the end: it negotiates successfully, so nothing
    /// ever marks it dead, and the writer drains its queue without error. It
    /// simply never collects the response. `FlushFileBuffers` on a pipe waits
    /// for the peer to read everything buffered, so a teardown that calls it on
    /// this thread waits for an event that will never happen, and the client
    /// count never comes back down.
    #[test]
    fn a_client_that_stops_reading_cannot_hold_the_host_open() {
        let (host, endpoint) = start_test_host("wedged");
        let client = crate::ipc::connect(&endpoint).expect("client connect");

        // Negotiate, and deliberately never read the answer.
        write_json_bounded(
            client.handle(),
            &json!({
                "id": 1,
                "op": "negotiate",
                "protocol": PROTOCOL_VERSION,
                "client": "test",
                "secret": "secret",
            }),
            MAX_SESSION_FRAME,
        )
        .expect("send negotiate");

        // End the conversation from the server's point of view: a well-formed
        // frame that is not a `Request` is a fatal parse error, so `converse`
        // returns with the response still sitting unread in the pipe buffer.
        write_json_bounded(
            client.handle(),
            &json!({ "not": "a request" }),
            MAX_SESSION_FRAME,
        )
        .expect("send garbage");

        assert!(
            waited_for_no_clients(&host, Duration::from_secs(20)),
            "the host still counts a client that stopped reading; teardown is \
             waiting on the peer it is supposed to be surviving"
        );
        // Held to here on purpose: closing it early would release the flush and
        // hide the very thing under test.
        drop(client);
    }

    /// The refusal the protocol promises a version-mismatched client actually
    /// arrives, intact, and the host then lets go of the connection.
    ///
    /// Teardown used to cancel all I/O on the handle unconditionally, including
    /// on this path — so the one answer this client is owed could be cut in
    /// half, the length prefix having already gone out as a separate write.
    #[test]
    fn a_refused_negotiation_reaches_the_client_before_teardown() {
        let (host, endpoint) = start_test_host("refusal");
        let client = crate::ipc::connect(&endpoint).expect("client connect");

        write_json_bounded(
            client.handle(),
            &json!({
                "id": 7,
                "op": "negotiate",
                "protocol": PROTOCOL_VERSION + 1,
                "client": "test",
                "secret": "secret",
            }),
            MAX_SESSION_FRAME,
        )
        .expect("send negotiate");

        let frame: Value =
            read_json_bounded(client.handle(), MAX_SESSION_FRAME).expect("the promised refusal");
        assert_eq!(frame["t"], "response");
        assert_eq!(frame["request"], 7);
        assert_eq!(frame["outcome"], "failed");
        assert!(
            frame["error"]
                .as_str()
                .is_some_and(|error| error.contains("protocol")),
            "a refusal must say what was wrong, got {frame}"
        );

        assert!(
            waited_for_no_clients(&host, Duration::from_secs(20)),
            "a refused client must be released, not retained"
        );
        drop(client);
    }

    #[test]
    fn a_first_frame_that_is_not_negotiate_is_named_as_such() {
        // The wire shape the refusal path depends on.
        let text = r#"{"id":1,"op":"list"}"#;
        let request: Request = serde_json::from_str(text).unwrap();
        assert!(!matches!(request.op, Op::Negotiate { .. }));
    }

    #[test]
    fn negotiate_carries_the_secret_on_the_wire() {
        let text = r#"{"id":1,"op":"negotiate","protocol":1,"client":"vidar","secret":"s"}"#;
        let request: Request = serde_json::from_str(text).unwrap();
        match request.op {
            Op::Negotiate {
                protocol,
                client,
                secret,
            } => {
                assert_eq!(protocol, 1);
                assert_eq!(client, "vidar");
                assert_eq!(secret, "s");
            }
            other => panic!("expected negotiate, got {other:?}"),
        }
    }

    #[test]
    fn negotiation_is_version_specific_and_only_v2_gets_capabilities() {
        let host = Arc::new(test_host());
        let v1 = negotiate(&host, PROTOCOL_V1, "secret").unwrap();
        assert_eq!(v1["protocol"], PROTOCOL_V1);
        assert!(v1.get("supported_agents").is_none());
        assert!(v1.get("capabilities").is_none());
        let v2 = negotiate(&host, PROTOCOL_VERSION, "secret").unwrap();
        assert_eq!(v2["protocol"], PROTOCOL_VERSION);
        assert_eq!(v2["supported_agents"], json!(["claude"]));
        assert_eq!(v2["capabilities"], json!(["steer"]));
    }

    #[test]
    fn v1_client_never_sends_agent_fields() {
        let params = |agent| crate::protocol::SpawnParams {
            agent,
            cwd: r"C:\work".into(),
            model: None,
            effort: None,
            permission_mode: "default".into(),
            resume: None,
            ctl_secret: None,
            rules_file: None,
            tab_name: None,
            gateway: None,
            profile: None,
            payload_file: None,
            row_key: None,
            set_plugin_dirs: Vec::new(),
        };
        let mut claude = Op::Spawn(params(Some(Agent::Claude)));
        prepare_client_op(PROTOCOL_V1, &mut claude).unwrap();
        let Op::Spawn(claude) = claude else {
            panic!("spawn")
        };
        assert_eq!(claude.agent, None);
        let mut codex = Op::Spawn(params(Some(Agent::Codex)));
        assert!(prepare_client_op(PROTOCOL_V1, &mut codex).is_err());
    }

    #[test]
    fn v2_requires_an_explicit_supported_agent() {
        let host = Arc::new(test_host());
        let (outbound, _inbound) = sync_channel(CLIENT_BACKLOG);
        let client = Arc::new(detached_client(outbound));
        let response = dispatch(
            &host,
            &client,
            "test",
            PROTOCOL_VERSION,
            &Mutex::new(HashMap::new()),
            Request {
                id: 1,
                op: Op::Spawn(crate::protocol::SpawnParams {
                    agent: None,
                    cwd: r"C:\work".into(),
                    model: None,
                    effort: None,
                    permission_mode: "default".into(),
                    resume: None,
                    ctl_secret: None,
                    rules_file: None,
                    tab_name: None,
                    gateway: None,
                    profile: None,
                    payload_file: None,
                    row_key: None,
                    set_plugin_dirs: Vec::new(),
                }),
            },
        );
        assert_eq!(response.outcome, crate::protocol::Outcome::Failed);
        assert!(response.error.unwrap().contains("explicit agent"));
        assert_eq!(host.falcon.supported_agents, vec!["claude"]);
    }

    #[test]
    fn v1_cannot_list_or_operate_on_a_codex_session() {
        // Removes the journal dir on drop, panic included. Declared before `host` so it drops
        // after it: the session (and its open journal) lives in the host's registry.
        struct TempRoot(std::path::PathBuf);
        impl Drop for TempRoot {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let temp = TempRoot(std::env::temp_dir().join(format!(
            "falcon-v1-filter-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        )));
        let root = temp.0.clone();
        std::fs::create_dir_all(&root).unwrap();
        let host = Arc::new(test_host());
        let reservation = host.registry.reserve("codex", None).unwrap();
        let journal = Journal::open(&root, &reservation.id).unwrap();
        let params = crate::protocol::SpawnParams {
            agent: Some(Agent::Codex),
            cwd: r"C:\Work\Example".into(),
            model: None,
            effort: None,
            permission_mode: "default".into(),
            resume: None,
            ctl_secret: None,
            rules_file: None,
            tab_name: None,
            gateway: None,
            profile: None,
            payload_file: None,
            row_key: None,
            set_plugin_dirs: Vec::new(),
        };
        let session = session::new_session(
            &reservation,
            "codex",
            r"C:\Work\Example".into(),
            None,
            session::tests::spawn_test_child(),
            AgentDriver::codex(&params),
            journal,
        );
        let sid = session.id.clone();
        let generation = session.generation;
        reservation.commit(session);

        let (outbound, _inbound) = sync_channel(CLIENT_BACKLOG);
        let client = Arc::new(detached_client(outbound));
        let attached = Mutex::new(HashMap::new());
        let list = dispatch(
            &host,
            &client,
            "test",
            PROTOCOL_V1,
            &attached,
            Request {
                id: 1,
                op: Op::List,
            },
        );
        assert_eq!(list.payload.unwrap()["sessions"], json!([]));

        let lease = Lease {
            token: "x".into(),
            revision: 0,
        };
        let ops = vec![
            Op::Attach {
                session: sid.clone(),
            },
            Op::Hydrate {
                session: sid.clone(),
                after: 0,
                through: 0,
            },
            Op::Detach {
                session: sid.clone(),
            },
            Op::AcquireControl {
                session: sid.clone(),
            },
            Op::ReleaseControl {
                session: sid.clone(),
                lease: lease.clone(),
            },
            Op::Close {
                session: sid.clone(),
                lease: lease.clone(),
            },
            Op::Release {
                session: sid.clone(),
            },
            Op::Terminate {
                session: sid.clone(),
                lease: lease.clone(),
            },
            Op::Submit {
                session: sid.clone(),
                generation,
                lease: lease.clone(),
                content: json!("hi"),
            },
            Op::RetractPrompt {
                session: sid.clone(),
                generation,
                lease: lease.clone(),
                prompt: "p".into(),
            },
            Op::SteerPrompt {
                session: sid.clone(),
                generation,
                lease: lease.clone(),
                prompt: "p".into(),
            },
            Op::Interrupt {
                session: sid.clone(),
                generation,
                lease: lease.clone(),
            },
            Op::Query {
                session: sid.clone(),
                generation,
                method: "model/list".into(),
                params: json!({}),
            },
            Op::PermissionResponse {
                session: sid.clone(),
                generation,
                lease: lease.clone(),
                request: "r".into(),
                behavior: "deny".into(),
                message: None,
                updated_input: None,
            },
            Op::SetModel {
                session: sid.clone(),
                generation,
                lease: lease.clone(),
                model: "m".into(),
            },
            Op::SetEffort {
                session: sid.clone(),
                generation,
                lease: lease.clone(),
                level: "high".into(),
            },
            Op::SetPermissionMode {
                session: sid.clone(),
                generation,
                lease,
                mode: "default".into(),
            },
        ];
        for (index, op) in ops.into_iter().enumerate() {
            let response = dispatch(
                &host,
                &client,
                "test",
                PROTOCOL_V1,
                &attached,
                Request {
                    id: index as u64 + 2,
                    op,
                },
            );
            assert_eq!(response.outcome, crate::protocol::Outcome::Failed);
            assert!(response.error.unwrap().contains("cannot access Codex"));
        }
        let v2 = dispatch(
            &host,
            &client,
            "test",
            PROTOCOL_VERSION,
            &attached,
            Request {
                id: 99,
                op: Op::List,
            },
        );
        assert_eq!(v2.payload.unwrap()["sessions"][0]["agent"], "codex");
    }

    /// A hosted Codex session whose thread is not ready refuses Submit from a
    /// client holding control: nothing is journaled or queued, so no replay
    /// shows a prompt that could never be sent.
    #[test]
    fn a_codex_submit_is_refused_until_the_thread_is_ready() {
        struct TempRoot(std::path::PathBuf);
        impl Drop for TempRoot {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let temp = TempRoot(std::env::temp_dir().join(format!(
            "falcon-codex-submit-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        )));
        std::fs::create_dir_all(&temp.0).unwrap();
        let host = Arc::new(test_host());
        let reservation = host.registry.reserve("codex", None).unwrap();
        let journal = Journal::open(&temp.0, &reservation.id).unwrap();
        let params = crate::protocol::SpawnParams {
            agent: Some(Agent::Codex),
            cwd: r"C:\work".into(),
            model: None,
            effort: None,
            permission_mode: "default".into(),
            resume: None,
            ctl_secret: None,
            rules_file: None,
            tab_name: None,
            gateway: None,
            profile: None,
            payload_file: None,
            row_key: None,
            set_plugin_dirs: Vec::new(),
        };
        let session = session::new_session(
            &reservation,
            "codex",
            r"C:\work".into(),
            None,
            session::tests::spawn_test_child(),
            AgentDriver::codex(&params),
            journal,
        );
        let sid = session.id.clone();
        let generation = session.generation;
        reservation.commit(session);

        let (outbound, _inbound) = sync_channel(CLIENT_BACKLOG);
        let client = Arc::new(detached_client(outbound));
        let attached = Mutex::new(HashMap::new());
        let send = |id: u64, op: Op| {
            dispatch(&host, &client, "test", PROTOCOL_V2, &attached, Request { id, op })
        };
        let control = send(1, Op::AcquireControl { session: sid.clone() });
        let payload = control.payload.expect("control is granted");
        let lease = Lease {
            token: payload["token"].as_str().unwrap().into(),
            revision: payload["revision"].as_u64().unwrap(),
        };
        let submit = send(
            2,
            Op::Submit {
                session: sid.clone(),
                generation,
                lease,
                content: json!("hello"),
            },
        );
        assert_eq!(submit.outcome, crate::protocol::Outcome::Failed);
        let error = submit.error.unwrap();
        assert!(error.contains("cannot submit") && error.contains("not ready"), "{error}");
        let found = host.registry.get(&sid).unwrap();
        assert!(found.queued_prompts().is_empty());
        let records = found.hydrate_from(0, u64::MAX, 256, MAX_SESSION_FRAME).unwrap().0;
        assert!(
            !serde_json::to_string(&records).unwrap().contains("hello"),
            "nothing about the prompt is journaled"
        );
        found.child.terminate_tree();
    }

    /// `codex_turns` follows the driver, not just the agent list: listed only
    /// when Codex resolved and its driver runs turns.
    #[test]
    fn codex_turns_is_listed_only_when_codex_resolves_and_runs_turns() {
        let claude_only = host_capabilities(&["claude".into()]);
        assert!(!claude_only.contains(&crate::protocol::CAPABILITY_CODEX_TURNS));
        assert!(!claude_only.contains(&crate::protocol::CAPABILITY_CODEX_QUERY));
        assert!(claude_only.contains(&crate::protocol::CAPABILITY_STEER));
        let both = host_capabilities(&["claude".into(), "codex".into()]);
        assert_eq!(
            both.contains(&crate::protocol::CAPABILITY_CODEX_TURNS),
            crate::codex::CodexDriver::RUNS_TURNS
        );
        assert_eq!(
            both.contains(&crate::protocol::CAPABILITY_CODEX_QUERY),
            crate::codex::CodexDriver::RUNS_TURNS
        );
    }

    /// `codex_bare` rides with `codex_turns`: never on a host whose Codex did not resolve.
    #[test]
    fn codex_bare_is_listed_only_when_codex_resolves() {
        let bare = crate::protocol::CAPABILITY_CODEX_BARE;
        assert!(!host_capabilities(&["claude".into()]).contains(&bare));
        assert!(!host_capabilities(&[]).contains(&bare));
        assert_eq!(
            host_capabilities(&["codex".into()]).contains(&bare),
            crate::codex::CodexDriver::RUNS_TURNS
        );
    }

    #[test]
    fn set_effort_refuses_a_level_outside_the_contract() {
        let host = Arc::new(test_host());
        let (outbound, _inbound) = sync_channel(CLIENT_BACKLOG);
        let client = Arc::new(detached_client(outbound));
        let attached = Mutex::new(HashMap::new());
        let response = dispatch(
            &host,
            &client,
            "test",
            PROTOCOL_VERSION,
            &attached,
            Request {
                id: 1,
                op: Op::SetEffort {
                    session: "s-1".into(),
                    generation: 0,
                    lease: Lease {
                        token: "x".into(),
                        revision: 0,
                    },
                    level: "bogus".into(),
                },
            },
        );
        assert_eq!(response.outcome, crate::protocol::Outcome::Failed);
        assert!(response
            .error
            .unwrap()
            .contains("effort level not allowed: bogus"));
    }

    // ---- unattended permissions ----------------------------------------

    /// Every `PermissionUnattended` outcome recorded for one session, in
    /// journal order.
    fn unattended_outcomes(session: &Session) -> Vec<String> {
        let (records, _more) = session
            .hydrate_from(0, session.journal_position(), 256, 1 << 20)
            .expect("hydrate");
        records
            .iter()
            .filter_map(|record| match &record.body {
                Body::PermissionUnattended { outcome, .. } => Some(outcome.clone()),
                _ => None,
            })
            .collect()
    }

    /// The `reason` of the first `PermissionUnattended` record whose outcome
    /// is `wanted`, in journal order.
    fn unattended_reason(session: &Session, wanted: &str) -> Option<String> {
        let (records, _more) = session
            .hydrate_from(0, session.journal_position(), 256, 1 << 20)
            .expect("hydrate");
        records.iter().find_map(|record| match &record.body {
            Body::PermissionUnattended {
                outcome, reason, ..
            } if outcome == wanted => reason.clone(),
            _ => None,
        })
    }

    /// Every `Diagnostic` text journalled for one session, in journal order.
    fn diagnostics(session: &Session) -> Vec<String> {
        let (records, _more) = session
            .hydrate_from(0, session.journal_position(), 256, 1 << 20)
            .expect("hydrate");
        records
            .iter()
            .filter_map(|record| match &record.body {
                Body::Event {
                    body: EventBody::Diagnostic { text },
                } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    /// `unused_past_grace` is what the sweep's timing rests on: unused,
    /// unattached, past the grace must be swept, and either a conversation id
    /// or a controller must keep the session out of it regardless of how
    /// long it has been idle. Backdating `unused_since` stands in for the
    /// real 5-minute wait — the predicate only ever looks at the elapsed gap.
    #[test]
    fn unused_past_grace_and_ending_it() {
        let grace = Duration::from_secs(300);
        let long_ago = Instant::now() - Duration::from_secs(301);

        let (_temp, unused) = session::tests::uncontrolled_session("unused-past-grace");
        assert!(
            unused_past_grace(&unused, long_ago, grace),
            "no conversation, no controller, no subscriber, past its grace: must be swept"
        );
        end_unused_session(&unused, grace);
        assert!(
            diagnostics(&unused)
                .iter()
                .any(|text| text.contains("unused")),
            "ending it must journal why, reconstructively, before the child is torn down"
        );

        let (_temp, with_conversation) =
            session::tests::uncontrolled_session("unused-conversation");
        *with_conversation
            .conversation
            .lock()
            .expect("conversation lock") = Some("c1".into());
        assert!(
            !unused_past_grace(&with_conversation, long_ago, grace),
            "a conversation id must keep the session out of the sweep"
        );

        let (_temp, with_controller) = session::tests::uncontrolled_session("unused-controller");
        with_controller
            .acquire_control(1, "vidar", "token".into())
            .expect("acquire control");
        assert!(
            !unused_past_grace(&with_controller, long_ago, grace),
            "a controller must keep the session out of the sweep"
        );
    }

    /// A session with a conversation, no controller, no subscriber
    /// and nothing pending is ended once past the orphan grace, and ending it
    /// only appends to its journal — every record written before is still
    /// there, so the transcript it would be resumed from is intact.
    #[test]
    fn an_orphan_past_its_grace_is_ended_and_keeps_its_journal() {
        let grace = Duration::from_secs(900);
        let long_ago = Instant::now() - Duration::from_secs(901);
        let (_temp, orphan) = session::tests::uncontrolled_session("orphan-past-grace");
        *orphan.conversation.lock().expect("conversation lock") = Some("c-orphan".into());
        orphan.record_quietly(Body::ConversationAdopted {
            conversation: "c-orphan".into(),
        });
        let (before, _) = orphan
            .hydrate_from(0, orphan.journal_position(), 256, 1 << 20)
            .expect("hydrate before");

        assert!(
            !orphaned_past_grace(&orphan, Instant::now(), grace),
            "inside its grace an orphan is left alone"
        );
        assert!(
            orphaned_past_grace(&orphan, long_ago, grace),
            "conversation, no controller, no subscriber, nothing pending, past grace: ended"
        );
        end_orphaned_session(&orphan, grace, OrphanReason::Unattended);

        assert!(
            process::wait_for(&orphan.child, Duration::from_secs(5)).is_some(),
            "the child tree must be gone"
        );
        let (after, _) = orphan
            .hydrate_from(0, orphan.journal_position(), 256, 1 << 20)
            .expect("hydrate after");
        assert!(after.len() > before.len(), "ending appends its reason");
        assert_eq!(
            &after[..before.len()],
            &before[..],
            "no record written before the end may be lost or rewritten"
        );
        assert!(diagnostics(&orphan)
            .iter()
            .any(|text| text.contains("orphaned") && text.contains("c-orphan")));
    }

    /// The orphan sweep must never end a session somebody is still waiting
    /// on or connected to: a queued prompt, an open permission, a subscriber
    /// or a controller each keep it out, however long it has been quiet.
    #[test]
    fn an_orphan_with_pending_work_or_a_client_is_not_ended() {
        let grace = Duration::from_secs(900);
        let long_ago = Instant::now() - Duration::from_secs(901);
        let with_conversation = |tag: &str| {
            let (temp, session) = session::tests::uncontrolled_session(tag);
            *session.conversation.lock().expect("conversation lock") = Some("c1".into());
            (temp, session)
        };

        let (_temp, queued) = with_conversation("orphan-queued");
        queued
            .enqueue_prompt(json!("still waiting"))
            .expect("enqueue");
        assert!(
            !orphaned_past_grace(&queued, long_ago, grace),
            "a queued prompt is pending work"
        );

        let (_temp, permission) = with_conversation("orphan-permission");
        permission
            .driver
            .observe(&json!({"type": "permission_request", "id": "p1"}));
        assert!(
            !orphaned_past_grace(&permission, long_ago, grace),
            "an open permission is pending work: the CLI is mid-turn, blocked on it"
        );

        let (_temp, subscribed) = with_conversation("orphan-subscribed");
        let _ = subscribed.attach(Arc::new(|_event: Event| {}));
        assert!(
            !orphaned_past_grace(&subscribed, long_ago, grace),
            "a subscriber keeps it"
        );

        let (_temp, controlled) = with_conversation("orphan-controlled");
        controlled
            .acquire_control(1, "vidar", "token".into())
            .expect("acquire control");
        assert!(
            !orphaned_past_grace(&controlled, long_ago, grace),
            "a controller keeps it"
        );

        let (_temp, watched) = with_conversation("orphan-unattended");
        assert!(watched.claim_unattended_watch("p1"));
        assert!(
            !orphaned_past_grace(&watched, long_ago, grace),
            "a running unattended watcher is pending work"
        );
    }

    /// A background subagent or Bash task outlives its turn's `result`, so
    /// the queue is empty while the CLI still works (and may wake itself
    /// with a new turn). An open task keeps the session; the SDK's typed
    /// `task_notification` for the same id releases it. Shapes are sdk.d.ts
    /// `SDKTaskStartedMessage` / `SDKTaskNotificationMessage`.
    #[test]
    fn an_orphan_with_an_open_background_task_is_not_ended() {
        let grace = Duration::from_secs(900);
        let long_ago = Instant::now() - Duration::from_secs(901);
        let (_temp, session) = session::tests::uncontrolled_session("orphan-task");
        *session.conversation.lock().expect("conversation lock") = Some("c1".into());

        session.driver.observe(&json!({
            "type": "system", "subtype": "task_started", "task_id": "t1",
            "description": "background agent", "is_backgrounded": true,
        }));
        assert!(
            !orphaned_past_grace(&session, long_ago, grace),
            "an open background task is pending work"
        );

        session.driver.observe(&json!({
            "type": "system", "subtype": "task_notification", "task_id": "t1",
            "status": "completed", "summary": "done", "output_file": "",
        }));
        assert!(
            orphaned_past_grace(&session, long_ago, grace),
            "its notification closes it, and nothing else holds the session"
        );
    }

    /// An orphan registered in `host`'s own registry, so the sweep sees it.
    /// The returned root removes the journal dir on drop; keep it alive for
    /// as long as the host.
    fn hosted_orphan(host: &Host, tag: &str) -> (TempJournalRoot, Arc<Session>) {
        let root = TempJournalRoot(std::env::temp_dir().join(format!(
            "falcon-orphan-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        )));
        std::fs::create_dir_all(&root.0).unwrap();
        let reservation = host.registry.reserve("claude", None).unwrap();
        let journal = Journal::open(&root.0, &reservation.id).unwrap();
        let session = session::new_session(
            &reservation,
            "claude",
            std::env::temp_dir().to_string_lossy().into_owned(),
            None,
            session::tests::spawn_test_child(),
            AgentDriver::Claude(crate::claude::ClaudeDriver::default()),
            journal,
        );
        *session.conversation.lock().expect("conversation lock") = Some("c1".into());
        reservation.commit(Arc::clone(&session));
        (root, session)
    }

    struct TempJournalRoot(std::path::PathBuf);
    impl Drop for TempJournalRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn backdated(session: &Session) -> OrphanClock {
        OrphanClock {
            since: Instant::now() - Duration::from_secs(901),
            journal: session.journal_position(),
            vidar: false,
        }
    }

    /// Vidar holds a bus connection for its whole lifetime, so while any
    /// client is connected the sweep must not run and every clock is dropped.
    /// The second half is the control: the same orphan, same backdated clock,
    /// no client, is ended.
    #[test]
    fn a_connected_client_blocks_the_orphan_sweep() {
        let host = test_host();
        let (_root, orphan) = hosted_orphan(&host, "client-gate");
        let mut clocks = HashMap::from([(orphan.id.clone(), backdated(&orphan))]);

        host.clients.fetch_add(1, Ordering::SeqCst);
        sweep_orphaned_sessions(&host, &mut clocks);
        assert!(!orphan.child.is_stopping(), "a connected client blocks the sweep");
        assert!(clocks.is_empty(), "a connected client resets every orphan clock");

        host.clients.fetch_sub(1, Ordering::SeqCst);
        clocks.insert(orphan.id.clone(), backdated(&orphan));
        sweep_orphaned_sessions(&host, &mut clocks);
        assert!(orphan.child.is_stopping(), "no client, past grace: ended");
        assert!(clocks.is_empty());
    }

    /// Activity no pending-work flag saw (anything shorter than a poll) still
    /// moves the journal; a moved journal restarts the orphan's clock.
    #[test]
    fn a_journal_advance_restarts_the_orphan_clock() {
        let host = test_host();
        let (_root, orphan) = hosted_orphan(&host, "journal-advance");
        let mut clocks = HashMap::from([(orphan.id.clone(), backdated(&orphan))]);
        clocks.insert("gone".into(), backdated(&orphan));

        orphan.record_quietly(Body::ConversationAdopted {
            conversation: "c1".into(),
        });
        sweep_orphaned_sessions(&host, &mut clocks);
        assert!(!orphan.child.is_stopping(), "a moved journal is activity");
        let clock = clocks.get(&orphan.id).expect("still tracked");
        assert!(clock.since.elapsed() < Duration::from_secs(60), "clock restarted");
        assert_eq!(clock.journal, orphan.journal_position());
        assert!(
            !clocks.contains_key("gone"),
            "a session no longer in the registry drops its clock"
        );
    }

    /// A hosted orphan whose last lease holder was `holder`, lease released
    /// (what Vidar does when it drops a tab's view).
    fn dropped_by(host: &Host, tag: &str, holder: &str) -> (TempJournalRoot, Arc<Session>) {
        let (root, session) = hosted_orphan(host, tag);
        session
            .acquire_control(7, holder, "token".into())
            .expect("acquire control");
        session.release_control_for(7).expect("release control");
        (root, session)
    }

    /// An orphan clock `secs` old at the session's current journal position,
    /// already seen with a `vidar` client connected (no restart pending).
    fn aged(session: &Session, secs: u64) -> OrphanClock {
        OrphanClock {
            since: Instant::now() - Duration::from_secs(secs),
            journal: session.journal_position(),
            vidar: true,
        }
    }

    /// A connection that negotiated as `vidar`, as `converse` counts it.
    fn connect_vidar(host: &Host) {
        host.clients.fetch_add(1, Ordering::SeqCst);
        host.vidar_clients.fetch_add(1, Ordering::SeqCst);
    }

    /// Review fix (2026-10-02): a relaunch after Vidar was closed 600 s must
    /// get its full 300 s to re-adopt. The first `vidar` client restarts the
    /// clock; 300 s later, still unattached, the session ends.
    #[test]
    fn a_vidar_connect_restarts_the_held_clock() {
        let host = test_host();
        let (_root, session) = dropped_by(&host, "vidar-relaunch", "vidar");
        let mut clocks = HashMap::from([(
            session.id.clone(),
            OrphanClock {
                vidar: false,
                ..aged(&session, 600)
            },
        )]);
        connect_vidar(&host);
        sweep_orphaned_sessions(&host, &mut clocks);
        assert!(!session.child.is_stopping(), "first sweep after the connect: kept");
        let clock = clocks.get_mut(&session.id).expect("still tracked");
        assert!(clock.since.elapsed() < Duration::from_secs(60), "clock restarted");
        assert!(clock.vidar);

        clock.since = Instant::now() - Duration::from_secs(301);
        sweep_orphaned_sessions(&host, &mut clocks);
        assert!(session.child.is_stopping(), "300 s after the connect, unattached: ended");
    }

    /// Ruling §3 (review fix 2026-10-02): a Falcon shell window is a client
    /// but not Vidar, so with only the shell connected a Vidar-held session
    /// keeps the 900 s grace.
    #[test]
    fn with_only_the_shell_connected_a_vidar_held_session_waits_out_900s() {
        let host = test_host();
        let (_root, session) = dropped_by(&host, "vidar-shell-only", "vidar");
        host.clients.fetch_add(1, Ordering::SeqCst);
        let mut clocks = HashMap::from([(session.id.clone(), aged(&session, 301))]);
        sweep_orphaned_sessions(&host, &mut clocks);
        assert!(!session.child.is_stopping(), "shell only: 300 s is not enough");

        clocks.insert(session.id.clone(), aged(&session, 901));
        sweep_orphaned_sessions(&host, &mut clocks);
        assert!(session.child.is_stopping(), "shell only, past 900 s: ended");
    }

    /// Ruling §2-3: with Vidar connected, a Claude session Vidar dropped and
    /// nobody picked up ends after 300 s, naming the conversation and reason.
    #[test]
    fn a_vidar_held_idle_session_past_300s_with_a_client_is_reaped() {
        let host = test_host();
        let (_root, session) = dropped_by(&host, "vidar-reaped", "vidar");
        let mut clocks = HashMap::from([(session.id.clone(), aged(&session, 301))]);
        connect_vidar(&host);
        sweep_orphaned_sessions(&host, &mut clocks);
        assert!(session.child.is_stopping(), "vidar-held, idle, past 300 s: ended");
        assert!(clocks.is_empty());
        assert!(diagnostics(&session)
            .iter()
            .any(|text| text.contains("vidar-held idle") && text.contains("c1")));
    }

    #[test]
    fn a_vidar_held_idle_session_under_300s_is_kept() {
        let host = test_host();
        let (_root, session) = dropped_by(&host, "vidar-young", "vidar");
        let mut clocks = HashMap::from([(session.id.clone(), aged(&session, 299))]);
        connect_vidar(&host);
        sweep_orphaned_sessions(&host, &mut clocks);
        assert!(!session.child.is_stopping(), "inside the 300 s grace");
        assert!(clocks.contains_key(&session.id), "its clock keeps running");
    }

    /// Ruling §4: a Jettisoned session (shell holds it parked) is never the
    /// Vidar-held rule's, however long it sits.
    #[test]
    fn a_shell_held_session_is_never_reaped_while_a_client_is_connected() {
        let host = test_host();
        let (_root, session) = dropped_by(&host, "shell-held", "falcon-shell");
        let mut clocks = HashMap::from([(session.id.clone(), aged(&session, 100_000))]);
        host.clients.fetch_add(1, Ordering::SeqCst);
        sweep_orphaned_sessions(&host, &mut clocks);
        assert!(!session.child.is_stopping());
        assert!(clocks.is_empty(), "a rule that does not apply drops the clock");
    }

    #[test]
    fn a_vidar_held_session_with_pending_work_is_never_reaped() {
        let host = test_host();
        let (_root, session) = dropped_by(&host, "vidar-pending", "vidar");
        session.enqueue_prompt(json!("still waiting")).expect("enqueue");
        let mut clocks = HashMap::from([(session.id.clone(), aged(&session, 100_000))]);
        connect_vidar(&host);
        sweep_orphaned_sessions(&host, &mut clocks);
        assert!(!session.child.is_stopping(), "a queued prompt is pending work");
    }

    /// Ruling §3: with no client connected the 900 s grace applies, so a swap
    /// with the close lock on does not lose an idle Vidar-held session at 300 s.
    #[test]
    fn with_no_client_a_vidar_held_session_waits_out_900s() {
        let host = test_host();
        let (_root, session) = dropped_by(&host, "vidar-no-client", "vidar");
        let mut clocks = HashMap::from([(session.id.clone(), aged(&session, 301))]);
        sweep_orphaned_sessions(&host, &mut clocks);
        assert!(!session.child.is_stopping(), "no client: 300 s is not enough");

        clocks.insert(session.id.clone(), aged(&session, 901));
        sweep_orphaned_sessions(&host, &mut clocks);
        assert!(session.child.is_stopping(), "no client, past 900 s: ended");
        assert!(diagnostics(&session)
            .iter()
            .any(|text| text.contains("vidar-held idle")));
    }

    /// Ruling §4: Vidar detaches before the shell takes the lease, so a live
    /// jettison handoff naming the session exempts it; a stale one does not.
    #[test]
    fn a_live_jettison_handoff_exempts_its_session() {
        let mut host = test_host();
        let dir = TempJournalRoot(std::env::temp_dir().join(format!(
            "falcon-handoff-{}",
            uuid::Uuid::new_v4().simple()
        )));
        std::fs::create_dir_all(&dir.0).unwrap();
        let file = dir.0.join("handoff-jettison.json");
        host.jettison_handoff = Some(file.clone());
        let (_root, session) = dropped_by(&host, "vidar-jettison", "vidar");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let record = |at_ms: u64| {
            json!({"session": session.id, "draft": "", "direction": "jettison", "at_ms": at_ms})
                .to_string()
        };
        connect_vidar(&host);

        std::fs::write(&file, record(now)).unwrap();
        let mut clocks = HashMap::from([(session.id.clone(), aged(&session, 301))]);
        sweep_orphaned_sessions(&host, &mut clocks);
        assert!(!session.child.is_stopping(), "a jettison in flight is exempt");

        std::fs::write(&file, record(now - 121_000)).unwrap();
        clocks.insert(session.id.clone(), aged(&session, 301));
        sweep_orphaned_sessions(&host, &mut clocks);
        assert!(session.child.is_stopping(), "a stale handoff exempts nothing");
    }

    /// Every `CommandAccepted` record for one session, in journal order.
    fn accepted_commands(session: &Session) -> Vec<(String, serde_json::Value)> {
        let (records, _more) = session
            .hydrate_from(0, session.journal_position(), 256, 1 << 20)
            .expect("hydrate");
        records
            .iter()
            .filter_map(|record| match &record.body {
                Body::CommandAccepted {
                    client, payload, ..
                } => Some((client.clone(), payload.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn an_unattended_permission_shows_the_shell_and_an_answer_cancels_the_deny() {
        let (_temp, session) = session::tests::uncontrolled_session("unattended-answered");
        session
            .driver
            .observe(&json!({"type": "permission_request", "id": "p1"}));
        let calls = Arc::new(AtomicUsize::new(0));
        let mut host = test_host();
        host.unattended_grace = Duration::from_secs(5);
        host.show_shell
            .set(stub_show_shell(Arc::clone(&calls), Ok(true)))
            .ok();
        let host = Arc::new(host);

        // What settles it here is an actual answer reaching the driver — not
        // a controller attaching — so this exercises branch (a), not (b).
        let answered = Arc::clone(&session);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            answered.driver.observe(&json!({
                "type": "falcon", "subtype": "permission", "id": "p1", "state": "responded"
            }));
        });

        watch_unattended_permission(Arc::clone(&host), Arc::clone(&session), "p1".into());

        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "the shell must be shown exactly once"
        );
        assert_eq!(
            unattended_outcomes(&session),
            vec!["shown".to_string()],
            "an answer must cancel the deny silently, not deny and not journal 'attended'"
        );
    }

    #[test]
    fn a_failed_show_denies_at_once() {
        let (_temp, session) = session::tests::uncontrolled_session("unattended-show-failed");
        session
            .driver
            .observe(&json!({"type": "permission_request", "id": "p1"}));
        // A refused write settles the deny immediately rather than waiting on
        // a child that will never answer it.
        let _ = session.child.stop();
        let calls = Arc::new(AtomicUsize::new(0));
        let host = test_host();
        host.show_shell
            .set(stub_show_shell(
                Arc::clone(&calls),
                Err("no window available".into()),
            ))
            .ok();
        let host = Arc::new(host);

        let started = Instant::now();
        watch_unattended_permission(Arc::clone(&host), Arc::clone(&session), "p1".into());
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "a failed show must deny at once, not wait out any grace"
        );

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            unattended_outcomes(&session),
            vec!["show-failed".to_string(), "denied-show-failed".to_string()]
        );
        assert_eq!(
            unattended_reason(&session, "denied-show-failed"),
            Some("failed".to_string()),
            "the deny record must carry the CommandSettled outcome, not the (usually absent) message; \
             this session's child was already stopped, so the deny write itself fails"
        );

        let denies: Vec<_> = accepted_commands(&session)
            .into_iter()
            .filter(|(client, payload)| {
                client == "falcon-unattended" && payload.get("behavior") == Some(&json!("deny"))
            })
            .collect();
        assert_eq!(
            denies.len(),
            1,
            "expected exactly one dispatched deny, got {denies:?}"
        );
    }

    #[test]
    fn an_unanswered_permission_is_denied_after_the_grace() {
        let (_temp, session) = session::tests::uncontrolled_session("unattended-timeout");
        session
            .driver
            .observe(&json!({"type": "permission_request", "id": "p1"}));
        let _ = session.child.stop();
        let calls = Arc::new(AtomicUsize::new(0));
        let host = test_host(); // 200 ms grace
        host.show_shell
            .set(stub_show_shell(Arc::clone(&calls), Ok(true)))
            .ok();
        let host = Arc::new(host);

        let started = Instant::now();
        watch_unattended_permission(Arc::clone(&host), Arc::clone(&session), "p1".into());
        let elapsed = started.elapsed();
        assert!(
            elapsed >= Duration::from_millis(200),
            "must not deny before the grace elapses, took {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "must not wait anywhere near the 30s command timeout, took {elapsed:?}"
        );

        assert_eq!(
            unattended_outcomes(&session),
            vec!["shown".to_string(), "denied-timeout".to_string()]
        );
        assert_eq!(
            unattended_reason(&session, "denied-timeout"),
            Some("failed".to_string()),
            "the deny record must carry the CommandSettled outcome, not the (usually absent) message; \
             this session's child was already stopped, so the deny write itself fails"
        );
    }

    /// Hosted Codex (refresh doc Q2): an unattended card is denied after the
    /// grace without the shell being shown, with the card's own deny, once.
    #[test]
    fn an_unattended_codex_card_is_denied_without_showing_the_shell() {
        let (_temp, session) = session::tests::codex_session("unattended-codex");
        let card = json!({
            "id": 3,
            "method": "item/commandExecution/requestApproval",
            "params": { "threadId": "thread-1", "turnId": "t1", "command": "ls" }
        });
        session.driver.observe(&card);
        assert_eq!(
            unattended_permission_target(&session, &card),
            Some("sr:3".into())
        );
        let calls = Arc::new(AtomicUsize::new(0));
        let host = test_host(); // 200 ms grace
        host.show_shell
            .set(stub_show_shell(Arc::clone(&calls), Ok(true)))
            .ok();
        let host = Arc::new(host);

        let started = Instant::now();
        watch_unattended_permission(Arc::clone(&host), Arc::clone(&session), "sr:3".into());
        assert!(started.elapsed() >= Duration::from_millis(200));
        assert_eq!(calls.load(Ordering::SeqCst), 0, "hosted Codex never shows the shell");
        assert_eq!(
            unattended_outcomes(&session),
            vec!["denied-timeout".to_string()]
        );
        assert_eq!(
            unattended_reason(&session, "denied-timeout"),
            Some("applied".to_string())
        );
        let denies = accepted_commands(&session)
            .into_iter()
            .filter(|(client, payload)| {
                client == "falcon-unattended" && payload.get("behavior") == Some(&json!("deny"))
            })
            .count();
        assert_eq!(denies, 1);
        assert!(!session.driver.is_opened("sr:3"));
        // A second watcher finds nothing left to deny.
        watch_unattended_permission(Arc::clone(&host), Arc::clone(&session), "sr:3".into());
        assert_eq!(unattended_outcomes(&session).len(), 1);
        session.child.terminate_tree();
    }

    #[test]
    fn a_controlled_session_never_auto_shows() {
        let (_temp, session) = session::tests::uncontrolled_session("unattended-controlled");
        session
            .driver
            .observe(&json!({"type": "permission_request", "id": "p1"}));
        session
            .acquire_control(1, "vidar", "token".into())
            .expect("acquire control");

        let calls = Arc::new(AtomicUsize::new(0));
        let mut host = test_host();
        host.unattended_grace = Duration::from_millis(100);
        host.show_shell
            .set(stub_show_shell(Arc::clone(&calls), Ok(true)))
            .ok();
        let host = Arc::new(host);

        // The exact gate the reader uses: a held lease must never even reach
        // `watch_unattended_permission`, so there is nothing to call it with.
        let value = json!({"type": "permission_request", "id": "p1"});
        assert!(unattended_permission_target(&session, &value).is_none());

        std::thread::sleep(host.unattended_grace * 2);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "a controlled session must never auto-show"
        );
        assert!(
            unattended_outcomes(&session).is_empty(),
            "a controlled session must never journal an unattended outcome"
        );
    }

    #[test]
    fn a_controller_attaching_during_the_wait_cancels_the_deny() {
        let (_temp, session) = session::tests::uncontrolled_session("unattended-attended");
        session
            .driver
            .observe(&json!({"type": "permission_request", "id": "p1"}));
        let calls = Arc::new(AtomicUsize::new(0));
        let mut host = test_host();
        host.unattended_grace = Duration::from_secs(5);
        host.show_shell
            .set(stub_show_shell(Arc::clone(&calls), Ok(true)))
            .ok();
        let host = Arc::new(host);

        // The lease changes hands, but nobody answers the permission itself —
        // branch (b), not (a). Attended no longer ends the wait by itself (a
        // controller holding the lease keeps the watcher polling with no
        // deadline), so this settles the request afterward purely to end the
        // test: the assertion is about the "attended" record, not about the
        // call returning on attach.
        // Held well past one `UNATTENDED_POLL` tick (250 ms) so the loop's
        // polling is certain to observe it attached, rather than racing a
        // window narrower than the poll interval.
        let attaching = Arc::clone(&session);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            attaching
                .acquire_control(1, "vidar", "token".into())
                .expect("acquire control");
            std::thread::sleep(Duration::from_millis(350));
            attaching.driver.observe(&json!({
                "type": "falcon", "subtype": "permission", "id": "p1", "state": "responded"
            }));
        });

        watch_unattended_permission(Arc::clone(&host), Arc::clone(&session), "p1".into());

        assert_eq!(
            unattended_outcomes(&session),
            vec!["shown".to_string(), "attended".to_string()]
        );
    }

    /// The net rule from the fix: a deny fires only while no controller holds
    /// the lease, AND the deadline restarts from the moment the lease goes
    /// vacant again — not from the original request. A request that sat
    /// attended past the original deadline must get a full grace window after
    /// release, not a deny 250 ms after the lease frees up.
    #[test]
    fn an_attach_then_detach_still_denies_at_the_deadline() {
        let (_temp, session) = session::tests::uncontrolled_session("unattended-attach-detach");
        session
            .driver
            .observe(&json!({"type": "permission_request", "id": "p1"}));
        let _ = session.child.stop();
        let calls = Arc::new(AtomicUsize::new(0));
        let mut host = test_host();
        host.unattended_grace = Duration::from_millis(400);
        host.show_shell
            .set(stub_show_shell(Arc::clone(&calls), Ok(true)))
            .ok();
        let host = Arc::new(host);

        // Attach at ~50 ms, release at ~300 ms — well past the ORIGINAL
        // 400 ms deadline (measured from watcher start), so a watcher that
        // failed to reset the deadline on release would deny almost at once.
        let toggling = Arc::clone(&session);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            let lease = toggling
                .acquire_control(1, "vidar", "token".into())
                .expect("acquire control");
            std::thread::sleep(Duration::from_millis(250));
            toggling.release_control(&lease).expect("release control");
        });

        let started = Instant::now();
        let watcher = {
            let host = Arc::clone(&host);
            let session = Arc::clone(&session);
            std::thread::spawn(move || {
                watch_unattended_permission(host, session, "p1".into());
            })
        };

        // At 500 ms — 200 ms after the ~300 ms release — the restarted grace
        // (400 ms from release) has not elapsed, so no deny may have fired
        // yet even though the original deadline (400 ms from start) has long
        // passed.
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(
            accepted_commands(&session).len(),
            0,
            "the deadline restarts on release; the original deadline must not apply"
        );

        watcher.join().expect("watcher thread panicked");
        assert!(
            started.elapsed() < Duration::from_millis(900),
            "the deny must land about one grace after the release, got {:?}",
            started.elapsed()
        );

        assert_eq!(
            unattended_outcomes(&session),
            vec![
                "shown".to_string(),
                "attended".to_string(),
                "denied-timeout".to_string()
            ]
        );
        let denies = accepted_commands(&session)
            .into_iter()
            .filter(|(client, payload)| {
                client == "falcon-unattended" && payload.get("behavior") == Some(&json!("deny"))
            })
            .count();
        assert_eq!(denies, 1, "exactly one deny must be dispatched");
    }

    /// The other half of the net rule: a controller still holding the lease
    /// at the deadline must not be denied, even though the deadline itself
    /// has passed — the deny only fires once the lease actually goes vacant.
    #[test]
    fn a_controller_holding_the_lease_at_the_deadline_blocks_the_deny() {
        let (_temp, session) =
            session::tests::uncontrolled_session("unattended-holds-through-deadline");
        session
            .driver
            .observe(&json!({"type": "permission_request", "id": "p1"}));
        let _ = session.child.stop();
        let calls = Arc::new(AtomicUsize::new(0));
        let mut host = test_host();
        host.unattended_grace = Duration::from_millis(200);
        host.show_shell
            .set(stub_show_shell(Arc::clone(&calls), Ok(true)))
            .ok();
        let host = Arc::new(host);

        let lease = {
            std::thread::sleep(Duration::from_millis(100));
            session
                .acquire_control(1, "vidar", "token".into())
                .expect("acquire control")
        };

        let watcher = {
            let host = Arc::clone(&host);
            let session = Arc::clone(&session);
            std::thread::spawn(move || {
                watch_unattended_permission(host, session, "p1".into());
            })
        };

        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(
            accepted_commands(&session).len(),
            0,
            "the deadline passed while a controller held the lease; no deny may fire"
        );

        session.release_control(&lease).expect("release control");
        watcher.join().expect("watcher thread panicked");

        assert_eq!(
            unattended_outcomes(&session),
            vec![
                "shown".to_string(),
                "attended".to_string(),
                "denied-timeout".to_string()
            ]
        );
    }

    /// A request raised while a controller holds the lease gets no watcher at
    /// observe time (`unattended_permission_target` returns `None`), so it
    /// must be picked up by the release path instead once that controller
    /// detaches without answering it.
    #[test]
    fn a_request_raised_under_a_controller_is_watched_after_release() {
        let (_temp, session) =
            session::tests::uncontrolled_session("unattended-raised-under-controller");
        let lease = session
            .acquire_control(1, "vidar", "token".into())
            .expect("acquire control");
        session
            .driver
            .observe(&json!({"type": "permission_request", "id": "p1"}));
        let _ = session.child.stop();

        // The observe-time gate: with a controller attached, nothing spawns.
        let value = json!({"type": "permission_request", "id": "p1"});
        assert!(unattended_permission_target(&session, &value).is_none());

        let calls = Arc::new(AtomicUsize::new(0));
        let mut host = test_host();
        host.unattended_grace = Duration::from_millis(200);
        host.show_shell
            .set(stub_show_shell(Arc::clone(&calls), Ok(true)))
            .ok();
        let host = Arc::new(host);

        session.release_control(&lease).expect("release control");
        // The choke point every release path funnels through.
        watch_requests_left_unattended(&host, &session);

        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline
            && !unattended_outcomes(&session).contains(&"denied-timeout".to_string())
        {
            std::thread::sleep(Duration::from_millis(20));
        }

        assert_eq!(
            unattended_outcomes(&session),
            vec!["shown".to_string(), "denied-timeout".to_string()]
        );
    }

    /// Zero grace means auto-show still happens but the watcher never times
    /// out; it only ends once the request is moot, so the test settles that
    /// itself rather than waiting forever.
    #[test]
    fn grace_zero_shows_and_never_denies() {
        let (_temp, session) = session::tests::uncontrolled_session("unattended-grace-zero");
        session
            .driver
            .observe(&json!({"type": "permission_request", "id": "p1"}));
        let calls = Arc::new(AtomicUsize::new(0));
        let mut host = test_host();
        host.unattended_grace = Duration::ZERO;
        host.show_shell
            .set(stub_show_shell(Arc::clone(&calls), Ok(true)))
            .ok();
        let host = Arc::new(host);

        let watcher = {
            let host = Arc::clone(&host);
            let session = Arc::clone(&session);
            std::thread::spawn(move || {
                watch_unattended_permission(host, session, "p1".into());
            })
        };

        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "zero grace must still auto-show"
        );
        assert_eq!(
            unattended_outcomes(&session),
            vec!["shown".to_string()],
            "zero grace must never deny"
        );

        // Stop the child and mark the session exited so `moot` trips and the
        // watcher thread returns, instead of polling forever.
        let _ = session.child.stop();
        session.mark_exited(Some(0));
        watcher.join().expect("watcher thread panicked");
    }

    fn bus_frame(topic: &str) -> BusFrame {
        BusFrame {
            topic: topic.into(),
            id: "msg-1".into(),
            from: "test".into(),
            payload: json!({}),
            reply_to: None,
        }
    }

    #[test]
    fn publish_reaches_a_matching_subscriber_and_not_a_non_matching_one() {
        let bus = BusHub::new();
        let (match_out, match_in) = sync_channel(4);
        let matching = Arc::new(detached_client_with_id(1, match_out));
        bus.subscribe(1, &matching, vec!["ask.open".into()]);
        let (other_out, other_in) = sync_channel(4);
        let other = Arc::new(detached_client_with_id(2, other_out));
        bus.subscribe(2, &other, vec!["ask.dock".into()]);

        let delivered = bus.publish(&bus_frame("ask.open"));

        assert_eq!(delivered, 1);
        match match_in
            .try_recv()
            .expect("matching subscriber must receive it")
        {
            ServerFrame::Bus(frame) => assert_eq!(frame.topic, "ask.open"),
            other => panic!("expected a bus frame, got {other:?}"),
        }
        assert!(
            other_in.try_recv().is_err(),
            "a non-matching subscriber must not receive it"
        );
    }

    #[test]
    fn a_prefix_pattern_matches_only_its_prefix() {
        let bus = BusHub::new();
        let (out, inbound) = sync_channel(4);
        let sub = Arc::new(detached_client_with_id(1, out));
        bus.subscribe(1, &sub, vec!["ask.*".into()]);

        assert_eq!(bus.publish(&bus_frame("ask.open")), 1);
        inbound
            .try_recv()
            .expect("prefix pattern must match ask.open");

        assert_eq!(
            bus.publish(&bus_frame("asking")),
            0,
            "ask.* must not match a topic that merely starts with \"ask\""
        );
        assert!(inbound.try_recv().is_err());
    }

    #[test]
    fn subscribe_replaces_this_connections_existing_patterns() {
        let bus = BusHub::new();
        let (out, inbound) = sync_channel(4);
        let sub = Arc::new(detached_client_with_id(1, out));
        bus.subscribe(1, &sub, vec!["ask.open".into()]);
        bus.subscribe(1, &sub, vec!["ask.dock".into()]);

        assert_eq!(
            bus.publish(&bus_frame("ask.open")),
            0,
            "the first subscribe's pattern must be gone, not accumulated"
        );
        assert_eq!(bus.publish(&bus_frame("ask.dock")), 1);
        inbound
            .try_recv()
            .expect("the replacement pattern must match");
    }

    #[test]
    fn unsubscribe_removes_the_connections_subs() {
        let bus = BusHub::new();
        let (out, inbound) = sync_channel(4);
        let sub = Arc::new(detached_client_with_id(1, out));
        bus.subscribe(1, &sub, vec!["ask.open".into()]);

        bus.unsubscribe(1);

        assert_eq!(bus.publish(&bus_frame("ask.open")), 0);
        assert!(inbound.try_recv().is_err());
    }

    #[test]
    fn publish_with_no_subscribers_delivers_zero() {
        let bus = BusHub::new();
        assert_eq!(bus.publish(&bus_frame("ask.open")), 0);
    }
}
