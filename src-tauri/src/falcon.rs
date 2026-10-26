//! Vidar's client for the Falcon session host (protocol v1).
//!
//! Falcon hosts the Claude child in its own process, so a session survives Vidar
//! closing. This module is the bridge: it speaks Falcon's typed protocol and
//! re-emits everything as the SAME `agent-event` / `agent-exit` envelope
//! `agent.rs` already emits.
//!
//! That re-emission is the design, not a shortcut. Falcon's `agent` events carry
//! the sidecar's own stdout line, so the Rendered body's listener, its
//! generation binding and its adapter all keep working untouched. The only
//! thing that had to be named on the TypeScript side is the three actions
//! (`AgentTransport`), because those genuinely differ.
//!
//! One honest caveat: Falcon parses that line into JSON and this client
//! re-serialises it, so what reaches the adapter is semantically equal but not
//! byte-identical — key order and whitespace may differ. Everything downstream
//! parses the line rather than matching it as text, so that is safe today; a
//! consumer that ever hashes or diffs the raw string would be the thing that
//! breaks, and should read Falcon's journal instead.
//!
//! **Two connections, deliberately.** The controller lease is bound to the
//! connection that acquired it, and a connection with a blocked read cannot also
//! write: a Windows pipe handle opened without `FILE_FLAG_OVERLAPPED` serialises
//! every operation on it, so a `WriteFile` queues behind a `ReadFile` that is
//! waiting for the next event. Falcon lost an afternoon to exactly that
//! deadlock. Rather than repeat its overlapped I/O here, this client uses the
//! protocol as designed:
//!
//! - **control** — holds the lease, strictly request→response, never attaches,
//!   so its reads are always bounded by a reply that is already coming.
//! - **events** — attaches read-only and does nothing but read.
//!
//! Read-only attach is a first-class protocol operation, so the second
//! connection costs nothing and needs no lease. If the control connection drops,
//! Falcon frees the lease by design and the session stays alive and hosted.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

// Only `Falcon::bus_stop` (Vidar-only) is atomic-bool now; the reader flags
// moved to `falcon/reader_control.rs`.
#[cfg(not(falcon_shell))]
use std::sync::atomic::AtomicBool;

use serde::Serialize;
#[cfg(test)]
use serde_json::json;
use serde_json::Value;

/// The one `agent-exit` envelope, emitted by the Falcon-hosted readers below
/// and by the in-process reader in `agent.rs` (which imports it from here).
/// It lives in this file because this is the only module both the Vidar crate
/// and the Falcon shell compile (`#[path]`, see `.claude\rules\falcon-rs.md`);
/// the shell has no `agent` module. Wire shape (rendered.ts):
/// `{ id: string, gen: number, code: number | null }`. `code` is i64 so a
/// Falcon host code outside i32 passes through unchanged.
#[derive(Clone, Serialize)]
pub(crate) struct AgentExit {
    pub(crate) id: String,
    pub(crate) gen: u64,
    pub(crate) code: Option<i64>,
}

/// Every bridge path this client touches, joined from one Vidar root. The
/// root is fixed at construction (`Falcon::new`): Vidar passes `paths::root()`,
/// the shell build derives root and shape from the `--registry` path its host
/// was launched with (`from_registry_path`), since this file must not reach
/// `crate::paths` (the shell crate has no such module). The relative layout
/// lives in `falcon/layout.rs` (pinned to `contracts/paths.json`)
/// and is the contract with `tools\release\falcon-*.ps1`, `tools\falcon\dock.ps1`
/// and `open.rs`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FalconPaths {
    root: PathBuf,
    /// `layout::RUNTIME`, which every path below joins.
    shape: layout::Shape,
}

impl FalconPaths {
    /// Always `RUNTIME` (`<root>\runtime\bridge\falcon`), matching
    /// `Resolve-VidarPath falcon` (`tools\lib\Paths.ps1`), which the falcon
    /// scripts use. The shell uses `from_registry_path`.
    #[cfg(any(not(falcon_shell), test))]
    pub fn new(root: PathBuf) -> Self {
        Self { root, shape: layout::RUNTIME }
    }

    /// Root and shape back from a registry path built by `registry()`
    /// (`layout::match_registry`); refuses any other layout rather than guessing.
    #[cfg(any(falcon_shell, test))]
    pub fn from_registry_path(registry: &Path) -> Result<Self, String> {
        let (root, shape) = layout::match_registry(registry)?;
        Ok(Self { root, shape })
    }

    /// The bridge dir of this shape; the shell's host runlog goes under it.
    #[cfg(falcon_shell)]
    pub fn bridge_dir(&self) -> PathBuf {
        self.root.join(self.shape.bridge)
    }

    /// `--registry`, relative to the root per `shape`; `from_registry_path` inverts it.
    fn registry(&self) -> PathBuf {
        self.root.join(self.shape.registry)
    }

    /// `tools\release\falcon-build.ps1`'s content-addressed store (`--store`).
    #[cfg(not(falcon_shell))]
    fn store(&self) -> PathBuf {
        self.root.join(self.shape.falcon).join(layout::STORE)
    }

    /// Written by `tools\release\falcon-refresh.ps1` only after its ping succeeds, so
    /// this always names a bundle that has already run once.
    #[cfg(not(falcon_shell))]
    fn bundle_pointer(&self) -> PathBuf {
        self.root.join(self.shape.falcon).join(layout::POINTER)
    }

    /// Fallback when the pointer is absent or stale: every immutable bundle
    /// `falcon-build.ps1` has ever produced.
    #[cfg(not(falcon_shell))]
    pub(crate) fn bundles_dir(&self) -> PathBuf {
        self.root.join(self.shape.falcon).join(layout::BUNDLES)
    }

    fn handoff(&self, direction: &str) -> Result<PathBuf, String> {
        match direction {
            "jettison" => Ok(self.root.join(self.shape.falcon).join(layout::HANDOFF_JETTISON)),
            "dock" => Ok(self.root.join(self.shape.falcon).join(layout::HANDOFF_DOCK)),
            other => Err(format!("unknown handoff direction \"{other}\"")),
        }
    }

    /// Only `falcon_dock_ask_blocking` reads these two, and that command is
    /// registered only by the shell build (`src-falcon\src\main.rs`).
    /// Vidar's `vidar-state.json` in this shape (`uiState`); shell-only, for `falcon_theme`.
    #[cfg(falcon_shell)]
    fn ui_state(&self) -> PathBuf {
        self.root.join(self.shape.ui_state)
    }

    #[cfg(falcon_shell)]
    fn open_dir(&self) -> PathBuf {
        self.root.join(self.shape.bridge).join(layout::OPEN)
    }

    #[cfg(falcon_shell)]
    fn open_dispatch_dir(&self) -> PathBuf {
        self.root.join(self.shape.bridge).join(layout::OPEN_DISPATCH)
    }

    #[cfg(falcon_shell)]
    fn dock_request(&self) -> PathBuf {
        self.root.join(self.shape.falcon).join(layout::DOCK_REQUEST)
    }

    #[cfg(falcon_shell)]
    fn dock_request_claimed(&self) -> PathBuf {
        self.root.join(self.shape.falcon).join(layout::DOCK_REQUEST_CLAIMED)
    }

    #[cfg(falcon_shell)]
    fn dock_result(&self) -> PathBuf {
        self.root.join(self.shape.falcon).join(layout::DOCK_RESULT)
    }
}

/// Negotiated client name: the shell build (compiled with `falcon_shell` via
/// `src-falcon/build.rs`) identifies itself as `falcon-shell`; Vidar itself as `vidar`.
pub const CLIENT_NAME: &str = if cfg!(falcon_shell) {
    "falcon-shell"
} else {
    "vidar"
};

/// The newest protocol version this build of `falcon.rs` understands. Negotiation
/// previously sent `registry.protocol_max` — the *host's* ceiling — verbatim, so an older
/// client attaching to a newer host silently claimed a protocol it does not implement.
/// Send `min(CLIENT_PROTOCOL, registry.protocol_max)` instead, and refuse
/// client-side when that is still below the host's `protocol_min` (`src-falcon/src/ipc.rs`'s
/// `request.protocol < registry.protocol_min || request.protocol > registry.protocol_max`
/// range check is the authority this mirrors). Deliberately hand-kept, not tied to
/// `src-falcon/src/protocol.rs::PROTOCOL_VERSION` even though both builds share that
/// file: a host version bump must not silently raise what this client claims to speak.
/// Raise it only when this file implements the new version.
pub(crate) const CLIENT_PROTOCOL: u32 = 2;

/// Falcon's own `MAX_SESSION_FRAME`, from the shared wire module. A frame over
/// this is a protocol error, not something to grow a buffer for.
const MAX_FRAME: usize = MAX_SESSION_FRAME;

/// Bound on `Connection::request`'s wait for its reply. Every caller already
/// drops its connection on any `Err` from `request` (`control`,
/// `bus_connect_and_subscribe`, `start_event_reader`'s `attach`/`detach`) —
/// the same "broken connection must not be reused" rule that already handles
/// a closed pipe — so a wedged host surfaces the same way instead of hanging
/// this call forever. `hosted_request` uses `COMMAND_REQUEST_TIMEOUT`
/// instead; every other op except `spawn` uses this bound — see
/// `SPAWN_REQUEST_TIMEOUT` for why that one is different.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Bound for `hosted_request`'s wait, which carries `interrupt`,
/// `permission-response`, `set-model` and `set-permission-mode` — every op
/// the host answers only after `command()`'s `dispatch_recorded` returns,
/// which is itself bound by the host's own `COMMAND_TIMEOUT` (30s,
/// `src-falcon\src\claude.rs`). Before this constant, those ops shared the
/// 10s `REQUEST_TIMEOUT`, so a legitimate ~10-30s outcome (a slow permission
/// reply, a busy sidecar) timed out client-side first. That drops the
/// control connection (`hosted_request`'s `*control = None`), which bumps
/// `control_epoch` and releases every hosted tab's lease — not
/// just the one that was slow. Keep this above `COMMAND_TIMEOUT` with
/// margin. The shared wire module does not carry timeouts; the ordering is
/// checked by a test in `src-falcon\src\main.rs` (shell build).
pub(crate) const COMMAND_REQUEST_TIMEOUT: Duration = Duration::from_secs(40);

/// Bound for the one op (`spawn`, `control`) that legitimately runs longer
/// than `REQUEST_TIMEOUT`: for a Codex session the host's own
/// `spawn_session` waits on `wait_ready()` up to its `READY_TIMEOUT` (30s,
/// `src-falcon\src\codex.rs`) before replying (`src-falcon\src\serve.rs`,
/// `spawn_session`'s `Agent::Codex` branch). `REQUEST_TIMEOUT` would fire
/// while the host is still legitimately working, report failure to the
/// caller, and then have the host succeed behind its back — a live session
/// this client believes is dead. Comfortably clears 30s with margin.
const SPAWN_REQUEST_TIMEOUT: Duration = Duration::from_secs(40);

// Falcon's wire types and registry record, single-sourced from the host.
// Vidar compiles the host's own files by `#[path]`; the shell build already has
// them as crate modules, and its copy of this file uses those instead. Both
// files are leaves (serde only): `protocol.rs` gates its tests on
// `falcon_shell`, and the registry record sits apart from `registry.rs`'s Win32
// code. Items only the host uses are expected dead here.
#[cfg(not(falcon_shell))]
#[allow(dead_code)] // protocol.rs is shared with the host; the client uses only part of it
#[path = "../../src-falcon/src/protocol.rs"]
mod protocol;
#[cfg(not(falcon_shell))]
#[path = "../../src-falcon/src/registry/record.rs"]
mod registry_record;
#[cfg(not(falcon_shell))]
use self::{
    protocol::{
        Lease, Op, Outcome, Response, SpawnParams, CAPABILITY_STEER, MAX_SESSION_FRAME,
    },
    registry_record::FalconRegistry,
};
#[cfg(falcon_shell)]
use crate::{
    protocol::{
        Lease, Op, Outcome, Response, SpawnParams, CAPABILITY_STEER, MAX_SESSION_FRAME,
    },
    registry::FalconRegistry,
};
// The wire's agent: the Bare resolver's boundary (`bare::set_loadout::resolve`) and the key
// `bare/agent_homes.rs` files each agent's homes under.
#[cfg(not(falcon_shell))]
pub(crate) use self::protocol::Agent;
#[cfg(falcon_shell)]
pub(crate) use crate::protocol::Agent;

// Children: `#[path]` because this file is also mounted by path from the shell
// crate; they reach this module through `super::` only (`.claude\rules\falcon-rs.md`).
#[path = "falcon/reader_control.rs"]
mod reader_control;
#[path = "falcon/connection.rs"]
mod connection;
#[path = "falcon/ops.rs"]
mod ops;
#[path = "falcon/events.rs"]
mod events;
#[path = "falcon/session_commands.rs"]
mod session_commands;
#[cfg(not(falcon_shell))]
#[path = "falcon/host_identity.rs"]
mod host_identity;
#[cfg(not(falcon_shell))]
#[path = "falcon/host_launch.rs"]
mod host_launch;
#[cfg(falcon_shell)]
#[path = "falcon/dock.rs"]
mod dock;
#[path = "falcon/layout.rs"]
mod layout;
// The host's per-folder pipe and mutex names; the shell's main.rs derives them
// through here, Vidar only tests them (clients read the names from registry.json).
#[path = "falcon/host_names.rs"]
pub(crate) mod host_names;
#[path = "falcon/handoff.rs"]
mod handoff;
#[cfg(not(falcon_shell))]
#[path = "falcon/bus.rs"]
mod bus;
#[path = "falcon/lease.rs"]
mod lease;

pub use self::session_commands::*;
// Handoff + falcon_handoff_write/peek/clear (+ their __cmd__ items).
pub use self::handoff::*;
// falcon_show (+ its __cmd__), bundle_present (pub(crate)), pick_bundle for the tests.
#[cfg(not(falcon_shell))]
pub use self::host_launch::*;
#[cfg(falcon_shell)]
pub use self::dock::*;
use self::{
    connection::Connection,
    lease::{lease_contended, reacquire_wait},
    reader_control::ReaderControl,
};
#[cfg(not(falcon_shell))]
use self::host_identity::host_alive;
#[cfg(test)]
use self::{
    connection::reply_from_frame,
    events::event_body,
    ops::{retract_operation, steer_operation, to_operation},
};
#[cfg(all(test, not(falcon_shell)))]
use self::connection::request_frame;
// tests::host_launch::host_alive_is_false_for_a_process_that_is_not_falcon_exe.
#[cfg(all(test, not(falcon_shell)))]
use self::host_identity::process_creation_identity;
#[cfg(all(test, not(falcon_shell)))]
use windows::Win32::{
    Foundation::CloseHandle,
    System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
};

/// One view this process holds, as `falcon_hosted_held` reports it.
#[cfg(not(falcon_shell))]
#[derive(Serialize)]
pub struct HeldView {
    pub tab: String,
    pub session: String,
    pub gen: u64,
}

/// The lease a held view can hand to its new tab: only one issued on the
/// current control connection. A reset connection already released it on the
/// host, so the adopt acquires afresh instead.
fn reusable_lease(held: Option<Hosted>, epoch: u64) -> Option<(Lease, u64)> {
    held.filter(|entry| entry.lease_epoch == epoch)
        .map(|entry| (entry.lease, entry.lease_epoch))
}

/// One hosted tab: which Falcon session it is, and the lease that drives it.
struct Hosted {
    session: String,
    /// Generation understood by Falcon and carried on host mutations.
    host_generation: u64,
    /// Vidar-local generation used to fence readers after a tab id is reused.
    view_generation: u64,
    lease: Lease,
    lease_epoch: u64,
    reader: Arc<ReaderControl>,
}

pub struct Falcon {
    /// Where the bridge lives; fixed at construction (`Falcon::new`).
    paths: FalconPaths,
    /// The control connection. Held across a whole request→response exchange,
    /// which is what makes correlation unnecessary: nothing else is in flight.
    control: Mutex<Option<Connection>>,
    hosted: Mutex<HashMap<String, Hosted>>,
    next_request: AtomicU64,
    next_view_generation: AtomicU64,
    control_epoch: AtomicU64,
    /// Spawns/adopts between taking a lease and inserting into `hosted`
    /// (`PendingLease`). The idle-out drops the control connection only when
    /// this is zero AND `hosted` is empty: otherwise a concurrent `list` saw an
    /// empty map and closed the pipe the just-acquired lease lives on.
    pending_leases: AtomicUsize,
    /// Serialises host launches: a second caller that arrives while one is in
    /// flight waits here rather than racing a second `Command::spawn`.
    #[cfg(not(falcon_shell))]
    launch: Mutex<()>,
    /// Set when `ensure_host` had to fall back to a launch inside Vidar's own
    /// job (no `CREATE_BREAKAWAY_FROM_JOB`); cleared on the next launch that
    /// breaks away cleanly. Surfaced to the launcher via `falcon_list`.
    #[cfg(not(falcon_shell))]
    host_warning: Mutex<Option<String>>,
    /// Set from Vidar's exit path (`main.rs` `RunEvent::Exit`) to end the
    /// `bus_subscribe` reconnect loop; unset for the lifetime of a run that
    /// never sees a clean exit event.
    #[cfg(not(falcon_shell))]
    bus_stop: AtomicBool,
}

impl Falcon {
    /// `root` is the Vidar folder (`paths::root()`); the shape comes from the
    /// disk (`FalconPaths::new`). No `Default`: a client without a root would
    /// have to guess one. The shell uses `from_paths`.
    #[cfg(any(not(falcon_shell), test))]
    pub fn new(root: PathBuf) -> Self {
        Self::from_paths(FalconPaths::new(root))
    }

    /// The shell's constructor: `paths` from `FalconPaths::from_registry_path`,
    /// so its shape is the one its host was launched in.
    pub fn from_paths(paths: FalconPaths) -> Self {
        Self {
            paths,
            control: Mutex::default(),
            hosted: Mutex::default(),
            next_request: AtomicU64::default(),
            next_view_generation: AtomicU64::default(),
            control_epoch: AtomicU64::default(),
            pending_leases: AtomicUsize::default(),
            #[cfg(not(falcon_shell))]
            launch: Mutex::default(),
            #[cfg(not(falcon_shell))]
            host_warning: Mutex::default(),
            #[cfg(not(falcon_shell))]
            bus_stop: AtomicBool::default(),
        }
    }
}

fn read_registry(paths: &FalconPaths) -> Result<FalconRegistry, String> {
    let path = paths.registry();
    let text = std::fs::read_to_string(&path).map_err(|error| {
        format!("no falcon host registered ({}): {error}", path.display())
    })?;
    serde_json::from_str(&text).map_err(|error| format!("falcon registry is unreadable: {error}"))
}

// Shared by `falcon/handoff.rs` and `falcon/dock.rs` (both via `super::`).
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Unique tmp in the same directory, then rename (`.claude\rules\bridge-rs.md`).
/// Rename-only: `std::fs::rename` on Windows already replaces the destination
/// (`MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`), so a manual
/// `remove_file` first only opened a window where a concurrent reader saw
/// `NotFound` mid-write.
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let dir = path.parent().ok_or("no parent")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("bad name")?;
    let tmp = dir.join(format!(".{name}.{}.tmp", now_ms()));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

impl Falcon {
    fn next_id(&self) -> u64 {
        self.next_request.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn next_view_generation(&self) -> u64 {
        self.next_view_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// May the control connection be dropped as idle? Only with no hosted view
    /// and no lease in flight. Callers hold the control lock, so a spawn that
    /// marked itself pending before its `acquire-control` is always seen.
    #[cfg_attr(falcon_shell, allow(dead_code))]
    fn control_idle(&self) -> bool {
        let hosted_empty = self
            .hosted
            .lock()
            .map(|hosted| hosted.is_empty())
            .unwrap_or(false);
        hosted_empty && self.pending_leases.load(Ordering::SeqCst) == 0
    }

    /// Run one request on the control connection, opening it if needed.
    ///
    /// The lock is held across the whole exchange. That is what lets this client
    /// skip request/response correlation entirely, and it is also what keeps the
    /// lease coherent: every mutation goes out on the one connection that holds
    /// it, in order.
    ///
    /// Vidar (`not(falcon_shell)`) additionally: launches a host on demand
    /// when none is registered and alive before opening (never on a live
    /// cached connection — `host_alive` costs a syscall, skip it when the
    /// last request already proved the pipe answers); retries a request once
    /// when the host was not alive at entry, because it could not have
    /// applied it; and drops the connection after a request once no tab is
    /// hosted, so an idle Vidar holds no client and the host's own idle timer
    /// runs it down. The shell build keeps today's plain connect-or-error.
    fn control(&self, op: Op) -> Result<Value, String> {
        self.control_at(op).map(|(value, _)| value)
    }

    /// `control`, plus the epoch of the connection that answered, read under
    /// the control lock: a lease must be stamped with the connection it lives
    /// on, and a reconnect by another thread between `control` returning and
    /// a separate `control_epoch` load stamped an old lease as current.
    fn control_at(&self, op: Op) -> Result<(Value, u64), String> {
        let mut reconnected = false;
        let result = self.control_at_locked(op, &mut reconnected);
        // Views whose lease died with the previous connection get a new one
        // here instead of failing their next send; after the lock is released,
        // so the re-acquires never stall another tab's request.
        if reconnected {
            self.reacquire_stale();
        }
        result
    }

    fn control_at_locked(&self, op: Op, reconnected: &mut bool) -> Result<(Value, u64), String> {
        let id = self.next_id();
        let mut guard = self.control.lock().map_err(|_| "falcon client poisoned")?;

        #[cfg(not(falcon_shell))]
        let host_was_alive_at_entry = if guard.is_none() {
            let alive = read_registry(&self.paths)
                .map(|registry| host_alive(&registry))
                .unwrap_or(false);
            if !alive {
                self.ensure_host()?;
            }
            alive
        } else {
            true
        };

        if guard.is_none() {
            let registry = read_registry(&self.paths)?;
            *guard = Some(Connection::open(&registry)?);
            self.control_epoch.fetch_add(1, Ordering::SeqCst);
            *reconnected = true;
        }

        let what = op.name();
        #[cfg(not(falcon_shell))]
        let is_list = matches!(op, Op::List);
        // `spawn` alone gets the long bound: see `SPAWN_REQUEST_TIMEOUT`'s doc
        // comment for why the host can legitimately take up to 30s on it.
        let request_timeout = if matches!(op, Op::Spawn(_)) {
            SPAWN_REQUEST_TIMEOUT
        } else {
            REQUEST_TIMEOUT
        };
        #[cfg(not(falcon_shell))]
        let op_for_retry = op.clone();

        let connection = guard.as_mut().expect("just opened");
        // `mut` is only needed by the `host_warning` patch-up below, which is
        // Vidar-only; the shell build never mutates `result`.
        #[cfg_attr(falcon_shell, allow(unused_mut))]
        let mut result = match connection.request(id, op, request_timeout) {
            Ok(reply) => reply.applied(what),
            Err(error) => {
                // A broken connection must not be reused: the next caller would
                // fail on a half-written frame and blame its own request. The
                // lease is gone with it, which Falcon handles by design.
                *guard = None;
                Err(error)
            }
        };

        #[cfg(not(falcon_shell))]
        if result.is_err() && !host_was_alive_at_entry {
            // The host could not have applied this request before we started
            // it just now (ensure_host, above), so retrying once cannot
            // double-apply it.
            if let Ok(registry) = read_registry(&self.paths) {
                if host_alive(&registry) {
                    if let Ok(mut retry_conn) = Connection::open(&registry) {
                        self.control_epoch.fetch_add(1, Ordering::SeqCst);
                        let retry_id = self.next_id();
                        result = match retry_conn.request(retry_id, op_for_retry, request_timeout) {
                            Ok(reply) => {
                                *guard = Some(retry_conn);
                                reply.applied(what)
                            }
                            Err(retry_error) => Err(retry_error),
                        };
                    }
                }
            }
        }

        // Idle-out: only after a lease-free query, never after an op that
        // acquires or carries a lease (`spawn`, `acquire-control` — the two
        // `control()` issues; every hosted-tab mutation goes through
        // `hosted_request`, not here, so it never sees this drop). Dropping
        // right after `spawn`/`acquire-control` would throw away the very
        // connection the lease just acquired lives on, before the caller has
        // even inserted the tab into `hosted`:
        // the tab's first `falcon_send` failed "falcon control disconnected".
        // A spawn/adopt between its `acquire-control` and its `hosted` insert
        // counts as hosted (`pending_leases`): an empty map alone dropped the
        // lease it had just taken.
        #[cfg(not(falcon_shell))]
        if is_list && self.control_idle() {
            *guard = None;
        }

        let epoch = self.control_epoch.load(Ordering::SeqCst);
        result.map(|value| (value, epoch))
    }

    /// Run a mutation for one hosted tab under a lease issued on the current
    /// control connection. The request that broke a pipe still fails (its
    /// delivery is unknown, so it is never resent); the NEXT request reconnects
    /// and takes a fresh lease for this view on the new epoch, so one failed
    /// exchange no longer strands every hosted tab. Never launches a host: a
    /// dead host took its sessions with it.
    fn hosted_request(
        &self,
        id: &str,
        view_generation: u64,
        build: impl FnOnce(&Hosted) -> Result<Op, String>,
    ) -> Result<Value, String> {
        let mut reconnected = false;
        let result = self.hosted_request_locked(id, view_generation, build, &mut reconnected);
        // The other views' leases died with the old connection too; re-taken
        // after the lock is released (see `reacquire_stale`).
        if reconnected {
            self.reacquire_stale();
        }
        result
    }

    fn hosted_request_locked(
        &self,
        id: &str,
        view_generation: u64,
        build: impl FnOnce(&Hosted) -> Result<Op, String>,
        reconnected: &mut bool,
    ) -> Result<Value, String> {
        // The tab first: an unknown tab or a stale generation never opens a pipe.
        {
            let hosted = self.hosted.lock().map_err(|_| "falcon client poisoned")?;
            let entry = hosted
                .get(id)
                .ok_or_else(|| format!("tab {id} has no falcon session"))?;
            if entry.view_generation != view_generation {
                return Err(format!(
                    "stale generation {view_generation}; tab {id} is at {}",
                    entry.view_generation
                ));
            }
        }
        // Marker strings "falcon control disconnected"/"falcon control changed"
        // are matched by `src/panels/sessions/hosted-close.ts`; keep them.
        let started = std::time::Instant::now();
        let mut retries = 0u32;
        let mut control = loop {
            let mut control = self.control.lock().map_err(|_| "falcon client poisoned")?;
            if control.is_none() {
                let registry = read_registry(&self.paths)
                    .map_err(|error| format!("falcon control disconnected: {error}"))?;
                let connection = Connection::open(&registry)
                    .map_err(|error| format!("falcon control disconnected: {error}"))?;
                *control = Some(connection);
                self.control_epoch.fetch_add(1, Ordering::SeqCst);
                *reconnected = true;
            }
            // Re-read every pass: the epoch is stable only while the lock is
            // held, and between passes another thread may have reconnected or
            // re-acquired this view's lease.
            let epoch = self.control_epoch.load(Ordering::SeqCst);
            let stale_session = {
                let hosted = self.hosted.lock().map_err(|_| "falcon client poisoned")?;
                let entry = hosted
                    .get(id)
                    .filter(|entry| entry.view_generation == view_generation)
                    .ok_or_else(|| format!("tab {id} has no falcon session"))?;
                (entry.lease_epoch != epoch).then(|| entry.session.clone())
            };
            let Some(session) = stale_session else {
                break control;
            };
            let connection = control.as_mut().expect("opened above");
            match self.acquire_on(connection, &session) {
                Ok(Ok(lease)) => {
                    if !self.store_lease(connection, id, view_generation, &session, lease, epoch) {
                        return Err(format!("tab {id} has no falcon session"));
                    }
                    break control;
                }
                // The host frees the old connection's lease on its own
                // teardown, which can trail our reconnect: that one refusal is
                // retried, with the lock released across the backoff.
                Ok(Err(refusal)) if lease_contended(&refusal) => {
                    let Some(wait) = reacquire_wait(started.elapsed(), retries) else {
                        return Err(format!(
                            "falcon control changed and the lease was not re-acquired ({refusal}); detach and reattach the session"
                        ));
                    };
                    drop(control);
                    retries += 1;
                    std::thread::sleep(wait);
                }
                Ok(Err(refusal)) => {
                    return Err(format!(
                        "falcon control changed and the lease was not re-acquired ({refusal}); detach and reattach the session"
                    ));
                }
                Err(error) => {
                    // Pipe error text ("read from falcon:" / "write to falcon:")
                    // or a timeout ("did not answer") passes through as is, so
                    // hosted-close.ts keeps the tab on a timeout.
                    *control = None;
                    return Err(format!("re-acquiring the falcon lease failed: {error}"));
                }
            }
        };
        let connection = control.as_mut().expect("held since the loop");

        let mut hosted = self.hosted.lock().map_err(|_| "falcon client poisoned")?;
        let entry = hosted
            .get_mut(id)
            .filter(|entry| entry.view_generation == view_generation)
            .ok_or_else(|| format!("tab {id} has no falcon session"))?;
        let op = build(entry)?;
        drop(hosted);
        // Refused here, connection kept: an op the host did not advertise
        // would make it drop this pipe and every lease on it.
        if let Some(refusal) = ops::capability_refusal(&op, &connection.capabilities) {
            return Err(refusal);
        }
        let request = self.next_id();
        match connection.request(request, op, COMMAND_REQUEST_TIMEOUT) {
            Ok(reply) => reply.applied("falcon mutation"),
            Err(error) => {
                *control = None;
                Err(error)
            }
        }
    }

    /// Remove a local view and release its lease if the connection that issued
    /// it is still current. Losing that connection already releases the lease
    /// on the host, so an old token must not be sent on a replacement pipe.
    fn detach_local(&self, id: &str, view_generation: u64) -> Result<(), String> {
        let removed = {
            let mut hosted = self.hosted.lock().map_err(|_| "falcon client poisoned")?;
            match hosted.get(id) {
                Some(entry) if entry.view_generation == view_generation => hosted.remove(id),
                _ => None,
            }
        };
        let Some(entry) = removed else {
            return Ok(());
        };
        entry.reader.cancel();

        let result = (|| {
            let mut control = self.control.lock().map_err(|_| "falcon client poisoned")?;
            if entry.lease_epoch != self.control_epoch.load(Ordering::SeqCst) {
                return Ok(());
            }
            let Some(connection) = control.as_mut() else {
                return Ok(());
            };
            let request = self.next_id();
            match connection.request(
                request,
                Op::ReleaseControl {
                    session: entry.session.clone(),
                    lease: entry.lease.clone(),
                },
                REQUEST_TIMEOUT,
            ) {
                Ok(reply) => reply.applied("release-control").map(|_| ()),
                Err(_) => {
                    // The host binds leases to connections. Once this pipe is
                    // broken the lease is released by server teardown.
                    *control = None;
                    Ok(())
                }
            }
        })();

        // The transition to no hosted tabs at all: idle the connection here
        // too, not only on the next `list` (`control`), so a Vidar
        // that closes its last tab starts the host's 300s idle clock at
        // once rather than waiting for the launcher to be opened again.
        // Checked under the control lock, like `control`'s list idle-out, so a
        // spawn/adopt with a lease in flight keeps the pipe.
        #[cfg(not(falcon_shell))]
        if let Ok(mut control) = self.control.lock() {
            if self.control_idle() {
                *control = None;
            }
        }

        result
    }

    /// Detach every local view while leaving every Falcon child hosted.
    /// Called only from `src-falcon\src\ipc.rs` (the shell's own detach path).
    #[cfg(falcon_shell)]
    pub fn detach_all(&self) -> Result<(), String> {
        let views = self
            .hosted
            .lock()
            .map_err(|_| "falcon client poisoned")?
            .iter()
            .map(|(id, entry)| (id.clone(), entry.view_generation))
            .collect::<Vec<_>>();
        let mut first_error = None;
        for (id, generation) in views {
            if let Err(error) = self.detach_local(&id, generation) {
                first_error.get_or_insert(error);
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// Reverse of `falcon_hosted_session`: the Vidar tab id hosting `session`,
    /// if this Vidar spawned or adopted it into `hosted`. Used by the `ctl.*`
    /// requester resolution (`control\mod.rs`), since a spawned hosted tab
    /// never carries `falconSession` in the frontend. Vidar-only: the shell
    /// build has no control surface.
    #[cfg(not(falcon_shell))]
    pub fn hosted_tab_for_session(&self, session: &str) -> Option<String> {
        let hosted = self.hosted.lock().ok()?;
        hosted
            .iter()
            .find(|(_, entry)| entry.session == session)
            .map(|(tab, _)| tab.clone())
    }

    /// The Falcon session the Vidar tab `tab` hosts (`falcon_hosted_session`'s lookup), for
    /// readers that find a session's launch manifest by its session (`bare::claude_dir`).
    #[cfg(not(falcon_shell))]
    pub fn hosted_session_of(&self, tab: &str) -> Option<String> {
        self.hosted.lock().ok()?.get(tab).map(|entry| entry.session.clone())
    }

    /// Every view this process still holds. At frontend boot a non-empty set
    /// means a webview reload, not a first launch: the reload dropped the tabs,
    /// not this map (`docs\projects\falcon\falcon-idle-reap.md` §Decision 1).
    #[cfg(not(falcon_shell))]
    pub fn held_views(&self) -> Result<Vec<HeldView>, String> {
        let hosted = self.hosted.lock().map_err(|_| "falcon client poisoned")?;
        Ok(hosted
            .iter()
            .map(|(tab, entry)| HeldView {
                tab: tab.clone(),
                session: entry.session.clone(),
                gen: entry.view_generation,
            })
            .collect())
    }

    /// Take the view this process holds for `session` under any tab other than
    /// `tab`, cancelling its event reader (which sends `detach` on its own
    /// event connection, so the host's `attached` count drops by that one
    /// subscriber before the adopting tab's reader attaches). Matches on the
    /// session alone: `last_holder` is this process, so it decides nothing.
    fn take_held(&self, session: &str, tab: &str) -> Result<Option<Hosted>, String> {
        let taken = {
            let mut hosted = self.hosted.lock().map_err(|_| "falcon client poisoned")?;
            let key = hosted
                .iter()
                .find(|(key, entry)| entry.session == session && key.as_str() != tab)
                .map(|(key, _)| key.clone());
            key.and_then(|key| hosted.remove(&key))
        };
        if let Some(entry) = &taken {
            entry.reader.cancel();
        }
        Ok(taken)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosted() -> Hosted {
        Hosted {
            session: "s1-00000001".into(),
            host_generation: 3,
            view_generation: 11,
            lease: Lease {
                token: "tok".into(),
                revision: 7,
            },
            lease_epoch: 1,
            reader: Arc::new(ReaderControl::new()),
        }
    }

    /// An unknown tab fails on the tab, before any pipe is opened: with no
    /// host registered, the error is not the "control disconnected" marker
    /// that makes hosted-close.ts drop the tab.
    #[test]
    fn an_unknown_tab_fails_before_opening_the_pipe() {
        let root = std::env::temp_dir().join("vidar-falcon-test-no-host");
        let falcon = Falcon::new(root);
        let error = falcon
            .hosted_request("t-missing", 1, |_| Err("never built".into()))
            .expect_err("no such tab");
        assert!(error.contains("has no falcon session"), "{error}");
        assert!(falcon.control.lock().unwrap().is_none(), "a pipe was opened");
    }

    /// A host that did not advertise `steer` never sees the op: the refusal
    /// comes before a byte is written, and the control connection (with every
    /// hosted lease on it) is kept. A file stands in for the pipe, so any
    /// write would show as bytes.
    #[test]
    fn steer_to_a_host_without_the_capability_sends_nothing_and_keeps_the_pipe() {
        let root = std::env::temp_dir().join("vidar-falcon-steer-uncapable");
        std::fs::create_dir_all(&root).unwrap();
        let pipe_path = root.join("pipe.bin");
        let pipe = std::fs::File::create(&pipe_path).unwrap();
        let falcon = Falcon::new(root.clone());
        *falcon.control.lock().unwrap() = Some(Connection::raw(pipe));
        falcon.control_epoch.store(1, Ordering::SeqCst);
        falcon.hosted.lock().unwrap().insert("tab-1".into(), hosted());

        let error = falcon
            .hosted_request("tab-1", 11, |entry| Ok(steer_operation(entry, "p-1")))
            .expect_err("an older host must be refused locally");
        assert!(error.contains("does not serve steer-prompt"), "{error}");
        assert!(falcon.control.lock().unwrap().is_some(), "the connection was dropped");
        assert_eq!(std::fs::metadata(&pipe_path).unwrap().len(), 0, "bytes reached the host");
        *falcon.control.lock().unwrap() = None;
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An op as the wire object `request` sends, minus the request id.
    fn wire(op: &Op) -> Value {
        serde_json::to_value(op).expect("an op always serialises")
    }

    /// Every operation carries the session, the generation AND the lease.
    ///
    /// Falcon refuses a mutation missing any of them, so an omission here would
    /// not be a wrong answer — it would be a tab that silently cannot send.
    #[test]
    fn every_operation_carries_the_session_generation_and_lease() {
        let hosted = hosted();
        for line in [
            json!({ "type": "user", "content": "hi" }),
            json!({ "type": "interrupt" }),
            json!({ "type": "permission_response", "id": "p1", "behavior": "allow" }),
            json!({ "type": "set_model", "model": "sonnet" }),
            json!({ "type": "set_effort", "level": "high" }),
            json!({ "type": "set_permission_mode", "mode": "plan" }),
        ] {
            let op = wire(&to_operation(&line, &hosted).expect("a known line must map"));
            assert_eq!(op["session"], json!("s1-00000001"), "in {op}");
            assert_eq!(op["generation"], json!(3), "in {op}");
            assert_eq!(op["lease"]["token"], json!("tok"), "in {op}");
            assert_eq!(op["lease"]["revision"], json!(7), "in {op}");
            assert!(op["op"].is_string(), "every line needs an op name: {op}");
        }
    }

    /// The field names Falcon actually deserialises. Getting one wrong fails at
    /// the far end with a parse error, which reads like a protocol break rather
    /// than a typo here.
    #[test]
    fn a_permission_response_keeps_falcons_field_names() {
        let line = json!({
            "type": "permission_response",
            "id": "perm-1",
            "behavior": "deny",
            "message": "no",
            "updatedInput": { "path": "x" },
        });
        let op = wire(&to_operation(&line, &hosted()).expect("map"));
        assert_eq!(op["op"], json!("permission-response"));
        // Falcon names it `request`, the sidecar names it `id`.
        assert_eq!(op["request"], json!("perm-1"));
        assert_eq!(op["behavior"], json!("deny"));
        assert_eq!(op["message"], json!("no"));
        // Falcon names it `updated_input`, the sidecar `updatedInput`.
        assert_eq!(op["updated_input"], json!({ "path": "x" }));
    }

    // `command_request_timeout_exceeds_the_hosts_command_timeout` in
    // src-falcon/src/main.rs (`falcon_client_protocol_tests`) asserts this against the
    // live `claude::COMMAND_TIMEOUT` instead of a hardcoded copy here — src-tauri
    // doesn't have that module to compare against.

    /// Optional fields are omitted, not sent as null.
    #[test]
    fn an_absent_optional_field_is_left_out_entirely() {
        let line = json!({ "type": "permission_response", "id": "p", "behavior": "allow" });
        let op = wire(&to_operation(&line, &hosted()).expect("map"));
        assert!(op.get("message").is_none(), "got {op}");
        assert!(op.get("updated_input").is_none(), "got {op}");
    }

    /// An unknown line is refused BY NAME rather than dropped.
    ///
    /// Silently discarding a line the user believes was sent is the exact
    /// failure this host exists to prevent, and it is what a `_ => {}` arm here
    /// would produce.
    #[test]
    fn an_unknown_line_is_refused_by_name() {
        let error = to_operation(&json!({ "type": "teleport" }), &hosted())
            .expect_err("an unmapped line must not be silently dropped");
        assert!(
            error.contains("teleport"),
            "the refusal must name it: {error}"
        );

        let error = to_operation(&json!({ "content": "no type at all" }), &hosted())
            .expect_err("a line with no type must be refused");
        assert!(error.contains("type"), "got {error}");
    }

    /// Opening and negotiating against a REAL running Falcon host.
    ///
    /// Ignored by default because it needs a host, not because it is optional:
    /// this is the one assumption in this file that cannot be checked by
    /// reading it — that a Windows named pipe can be opened as a plain
    /// `std::fs::File` and framed over, rather than needing the `windows` crate
    /// and an explicit `CreateFileW`. Run it with a host up:
    ///
    /// ```text
    /// pwsh tools\falcon\falcon-vidar-smoke.ps1
    /// ```
    #[test]
    #[ignore = "needs a running Falcon host; see tools\\falcon-vidar-smoke.ps1"]
    fn a_live_host_accepts_this_client() {
        // FALCON_SMOKE_ROOT: the smoke's throwaway root under %TEMP%, whose
        // host admits this test binary (--admit-probe --admit-image). Unset,
        // the checkout's own bridge: both crates sit one below the Vidar root.
        let root = match std::env::var_os("FALCON_SMOKE_ROOT") {
            Some(root) => std::path::PathBuf::from(root),
            None => Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("CARGO_MANIFEST_DIR has a parent")
                .to_path_buf(),
        };
        let registry = read_registry(&FalconPaths::new(root))
            .expect("a falcon host must be registered");
        let mut connection = Connection::open(&registry).expect("negotiate against the live host");
        // `list` is read-only and needs no lease, so this proves the framing
        // and the request/response correlation without touching a session.
        let reply = connection
            .request(2, Op::List, REQUEST_TIMEOUT)
            .expect("list must answer");
        let payload = reply.applied("list").expect("list must apply");
        assert!(
            payload.get("sessions").is_some(),
            "a list reply must carry sessions, got {payload}"
        );
    }

    /// `user` content is forwarded verbatim, including Messages content blocks.
    #[test]
    fn submit_forwards_content_verbatim() {
        let blocks = json!([{ "type": "text", "text": "hello" }]);
        let op = wire(
            &to_operation(
                &json!({ "type": "user", "content": blocks.clone() }),
                &hosted(),
            )
            .expect("map"),
        );
        assert_eq!(op["op"], json!("submit"));
        assert_eq!(op["content"], blocks);
    }

    #[test]
    fn retract_uses_the_host_generation_and_exact_prompt_id() {
        let op = wire(&retract_operation(&hosted(), "prompt-42"));
        assert_eq!(op["op"], json!("retract-prompt"));
        assert_eq!(op["session"], json!("s1-00000001"));
        assert_eq!(op["generation"], json!(3));
        assert_eq!(op["lease"]["token"], json!("tok"));
        assert_eq!(op["prompt"], json!("prompt-42"));
    }

    /// Cross-process contract: every op this client sends, built from
    /// the host's types, against the frame the hand-built `json!` literals
    /// produced at 4a4a0ff. An already-running older host keeps serving a
    /// swapped Vidar, so names, casing, omission, `null` and number types must
    /// not move. Vidar-only: exact key order depends on its `preserve_order`.
    ///
    /// The five mutation ops `to_operation` builds put `op` first now; they had
    /// it after `lease`. Key order is the one difference, so those compare as
    /// JSON values, pin the new string, and prove the host parses the old one.
    #[cfg(not(falcon_shell))]
    #[test]
    fn client_ops_serialise_exactly_as_the_old_literals() {
        let h = hosted();
        let line = |value: Value| to_operation(&value, &h).expect("a known line must map");
        let lease = || Lease {
            token: "tok".into(),
            revision: 7,
        };
        let uuid = "c4ee6c0d-1111-2222-3333-444444444444";
        let cases: Vec<(Op, &str, Option<&str>)> = vec![
            (
                Op::Negotiate { protocol: 2, client: "vidar".into(), secret: "sec".into() },
                r#"{"op":"negotiate","protocol":2,"client":"vidar","secret":"sec","id":1}"#,
                None,
            ),
            (Op::List, r#"{"op":"list","id":1}"#, None),
            (
                Op::Spawn(SpawnParams {
                    agent: Some(Agent::Claude),
                    cwd: r"C:\work".into(),
                    permission_mode: "default".into(),
                    model: None,
                    effort: None,
                    resume: None,
                    ctl_secret: None,
                    rules_file: None,
                    tab_name: None,
                    gateway: None,
                    profile: None,
                    payload_file: None,
                    row_key: None,
                    set_plugin_dirs: Vec::new(), codex_home: None, claude_config_dir: None, plugin_names: Vec::new(),
                    sets: None,
                    mcp_file: None,
                }),
                r#"{"op":"spawn","agent":"claude","cwd":"C:\\work","permission_mode":"default","id":1}"#,
                None,
            ),
            (
                Op::Spawn(SpawnParams {
                    agent: Some(Agent::Claude),
                    cwd: r"C:\work".into(),
                    permission_mode: "plan".into(),
                    model: Some("sonnet".into()),
                    effort: None,
                    resume: Some(uuid.into()),
                    ctl_secret: None,
                    rules_file: None,
                    tab_name: None,
                    gateway: None,
                    profile: None,
                    payload_file: None,
                    row_key: None,
                    set_plugin_dirs: Vec::new(), codex_home: None, claude_config_dir: None, plugin_names: Vec::new(),
                    sets: None,
                    mcp_file: None,
                }),
                r#"{"op":"spawn","agent":"claude","cwd":"C:\\work","permission_mode":"plan","model":"sonnet","resume":"c4ee6c0d-1111-2222-3333-444444444444","id":1}"#,
                None,
            ),
            (
                Op::AcquireControl { session: "s1".into() },
                r#"{"op":"acquire-control","session":"s1","id":1}"#,
                None,
            ),
            (
                Op::ReleaseControl { session: "s1".into(), lease: lease() },
                r#"{"op":"release-control","session":"s1","lease":{"token":"tok","revision":7},"id":1}"#,
                None,
            ),
            (
                Op::Close { session: "s1".into(), lease: lease() },
                r#"{"op":"close","session":"s1","lease":{"token":"tok","revision":7},"id":1}"#,
                None,
            ),
            (
                Op::Hydrate { session: "s1".into(), after: 0, through: 9 },
                r#"{"op":"hydrate","session":"s1","after":0,"through":9,"id":1}"#,
                None,
            ),
            (Op::Attach { session: "s1".into() }, r#"{"op":"attach","session":"s1","id":1}"#, None),
            (Op::Detach { session: "s1".into() }, r#"{"op":"detach","session":"s1","id":1}"#, None),
            (
                Op::Subscribe { topics: vec!["ask.*".into()] },
                r#"{"op":"subscribe","topics":["ask.*"],"id":1}"#,
                None,
            ),
            (
                Op::Publish {
                    topic: "ask.open".into(),
                    id: "m1".into(),
                    payload: json!({ "a": 1 }),
                    reply_to: None,
                },
                r#"{"op":"publish","topic":"ask.open","msg_id":"m1","payload":{"a":1},"id":1}"#,
                None,
            ),
            (
                Op::Publish {
                    topic: "ask.open".into(),
                    id: "m1".into(),
                    payload: json!({ "a": 1 }),
                    reply_to: Some("ask.reply".into()),
                },
                r#"{"op":"publish","topic":"ask.open","msg_id":"m1","payload":{"a":1},"reply_to":"ask.reply","id":1}"#,
                None,
            ),
            (
                retract_operation(&h, "p-42"),
                r#"{"op":"retract-prompt","session":"s1-00000001","generation":3,"lease":{"token":"tok","revision":7},"prompt":"p-42","id":1}"#,
                None,
            ),
            (
                line(json!({ "type": "user", "content": "hi" })),
                r#"{"session":"s1-00000001","generation":3,"lease":{"token":"tok","revision":7},"op":"submit","content":"hi","id":1}"#,
                Some(r#"{"op":"submit","session":"s1-00000001","generation":3,"lease":{"token":"tok","revision":7},"content":"hi","id":1}"#),
            ),
            (
                line(json!({ "type": "interrupt" })),
                r#"{"session":"s1-00000001","generation":3,"lease":{"token":"tok","revision":7},"op":"interrupt","id":1}"#,
                Some(r#"{"op":"interrupt","session":"s1-00000001","generation":3,"lease":{"token":"tok","revision":7},"id":1}"#),
            ),
            (
                line(json!({ "type": "permission_response", "id": "p1", "behavior": "allow" })),
                r#"{"session":"s1-00000001","generation":3,"lease":{"token":"tok","revision":7},"op":"permission-response","request":"p1","behavior":"allow","id":1}"#,
                Some(r#"{"op":"permission-response","session":"s1-00000001","generation":3,"lease":{"token":"tok","revision":7},"request":"p1","behavior":"allow","id":1}"#),
            ),
            (
                line(json!({
                    "type": "permission_response", "id": "p1", "behavior": "deny",
                    "message": "no", "updatedInput": null,
                })),
                r#"{"session":"s1-00000001","generation":3,"lease":{"token":"tok","revision":7},"op":"permission-response","request":"p1","behavior":"deny","message":"no","updated_input":null,"id":1}"#,
                Some(r#"{"op":"permission-response","session":"s1-00000001","generation":3,"lease":{"token":"tok","revision":7},"request":"p1","behavior":"deny","message":"no","updated_input":null,"id":1}"#),
            ),
            (
                line(json!({ "type": "set_model", "model": "sonnet" })),
                r#"{"session":"s1-00000001","generation":3,"lease":{"token":"tok","revision":7},"op":"set-model","model":"sonnet","id":1}"#,
                Some(r#"{"op":"set-model","session":"s1-00000001","generation":3,"lease":{"token":"tok","revision":7},"model":"sonnet","id":1}"#),
            ),
            (
                // New with W5 (effort): no pre-reorder literal exists, so the current bytes are the contract.
                line(json!({ "type": "set_effort", "level": "high" })),
                r#"{"op":"set-effort","session":"s1-00000001","generation":3,"lease":{"token":"tok","revision":7},"level":"high","id":1}"#,
                None,
            ),
            (
                line(json!({ "type": "set_permission_mode", "mode": "plan" })),
                r#"{"session":"s1-00000001","generation":3,"lease":{"token":"tok","revision":7},"op":"set-permission-mode","mode":"plan","id":1}"#,
                Some(r#"{"op":"set-permission-mode","session":"s1-00000001","generation":3,"lease":{"token":"tok","revision":7},"mode":"plan","id":1}"#),
            ),
        ];
        for (op, old, reordered) in cases {
            let frame = request_frame(1, &op).expect("encode");
            let sent = serde_json::to_string(&frame).unwrap();
            assert_eq!(sent, reordered.unwrap_or(old), "exact bytes");
            let old_value: Value = serde_json::from_str(old).unwrap();
            assert_eq!(frame, old_value, "same JSON as the old literal: {old}");
            if reordered.is_some() {
                serde_json::from_str::<protocol::Request>(old)
                    .unwrap_or_else(|error| panic!("the host must still parse {old}: {error}"));
            }
        }
    }

    /// Cross-process contract: recorded host response frames for each
    /// outcome, read through the host's `Response`. The client acts only on
    /// `applied`; anything else, including an outcome this build does not
    /// know, is a refusal carrying the host's own error text.
    #[test]
    fn host_response_frames_parse_to_their_outcome() {
        let read = |text: &str| reply_from_frame(&serde_json::from_str(text).unwrap(), 5);

        let applied = read(r#"{"t":"response","request":5,"outcome":"applied","payload":{"sessions":[]}}"#)
            .expect("its own response");
        assert!(applied.outcome == Outcome::Applied);
        assert_eq!(applied.applied("list").unwrap(), json!({ "sessions": [] }));

        let failed = read(r#"{"t":"response","request":5,"outcome":"failed","error":"stale generation 2"}"#)
            .expect("its own response");
        assert!(failed.outcome == Outcome::Failed);
        assert_eq!(failed.applied("submit").unwrap_err(), "submit: stale generation 2");

        let unknown = read(r#"{"t":"response","request":5,"outcome":"delivery-unknown","error":"write may have landed"}"#)
            .expect("its own response");
        assert!(unknown.outcome == Outcome::DeliveryUnknown);
        assert_eq!(unknown.applied("submit").unwrap_err(), "submit: write may have landed");

        let future = read(r#"{"t":"response","request":5,"outcome":"deferred","error":"later"}"#)
            .expect("still the answer");
        assert!(future.outcome == Outcome::Failed);
        assert_eq!(future.applied("submit").unwrap_err(), "submit: later");

        assert!(read(r#"{"t":"response","request":6,"outcome":"applied"}"#).is_none());
        assert!(read(r#"{"t":"event","session":"s1","generation":1,"seq":1,"kind":"exit","code":0}"#).is_none());
    }

    #[cfg(falcon_shell)]
    #[test]
    fn detach_all_removes_views_and_sets_their_reader_fences() {
        // Never touches the bridge; a temp root keeps it off the live one.
        let falcon = Falcon::new(std::env::temp_dir().join("vidar-falcon-detach-all"));
        let entry = hosted();
        let reader = Arc::clone(&entry.reader);
        falcon.hosted.lock().unwrap().insert("tab-1".into(), entry);

        falcon.detach_all().expect("detach local views");

        assert!(falcon.hosted.lock().unwrap().is_empty());
        assert!(reader.is_cancelled());
    }

    /// F4 regression: a spawn/adopt that holds a lease but has not inserted
    /// into `hosted` yet must keep the control pipe through a concurrent
    /// `list` (or last-tab detach) idle-out.
    #[test]
    fn a_pending_lease_keeps_the_control_pipe_through_a_list() {
        let falcon = Falcon::new(std::env::temp_dir().join("vidar-falcon-pending-lease"));
        assert!(falcon.control_idle(), "nothing hosted, nothing pending: idle");
        let pending = falcon.pending_lease();
        assert!(!falcon.control_idle(), "lease in flight: list must keep the pipe");
        let second = falcon.pending_lease();
        drop(pending);
        assert!(!falcon.control_idle(), "one still in flight");
        falcon.hosted.lock().unwrap().insert("tab-1".into(), hosted());
        drop(second);
        assert!(!falcon.control_idle(), "inserted view keeps it");
        falcon.hosted.lock().unwrap().clear();
        assert!(falcon.control_idle());
    }

    /// Reload ghosts (falcon-idle-reap.md §Decision 1): adopting a session this
    /// process still holds moves the view and keeps its lease, so no second
    /// `acquire-control`; the old reader is cancelled (its event connection
    /// detaches) before the new one attaches.
    #[test]
    fn adopting_a_held_view_moves_it_and_keeps_its_lease() {
        let falcon = Falcon::new(std::env::temp_dir().join("vidar-falcon-take-held"));
        let entry = hosted();
        let reader = Arc::clone(&entry.reader);
        falcon.hosted.lock().unwrap().insert("s1-old".into(), entry);

        assert!(falcon.take_held("s1-00000001", "s1-old").unwrap().is_none(), "own tab is not held elsewhere");
        let held = falcon.take_held("s1-00000001", "s2-new").unwrap();
        assert!(falcon.hosted.lock().unwrap().is_empty());
        assert!(reader.is_cancelled());

        let (lease, epoch) = reusable_lease(held, 1).expect("same connection: lease reused");
        assert_eq!((lease.token.as_str(), lease.revision, epoch), ("tok", 7, 1));
        assert!(reusable_lease(Some(hosted()), 2).is_none(), "a reset connection acquires afresh");
    }

    /// Cross-process contract: Vidar launches the host with
    /// `--registry <root>\runtime\bridge\falcon\runtime\registry.json` and the shell gets its root and shape
    /// back from that path alone; any other layout is refused.
    #[test]
    fn the_shell_recovers_the_vidar_root_from_the_registry_path() {
        let root = PathBuf::from("D:\\Somewhere Else\\Vidar");
        let paths = FalconPaths::new(root.clone());
        assert_eq!(paths.registry(), root.join(layout::RUNTIME.registry));
        assert_eq!(
            FalconPaths::from_registry_path(&paths.registry()).expect("round trip"),
            paths
        );
        for bad in [
            "D:\\Vidar\\bridge\\falcon\\registry.json",
            "D:\\Vidar\\bridge\\other\\runtime\\registry.json",
            "bridge\\falcon\\runtime\\registry.json",
            ".\\bridge\\falcon\\runtime\\registry.json",
            "..\\bridge\\falcon\\runtime\\registry.json",
            "\\bridge\\falcon\\runtime\\registry.json",
            "C:bridge\\falcon\\runtime\\registry.json",
        ] {
            let error = FalconPaths::from_registry_path(Path::new(bad)).expect_err(bad);
            assert!(error.contains("cannot find the Vidar folder"), "{bad}: {error}");
        }
    }

    /// The hydrated journal shape a real replay sees: the event fields live
    /// under `body.body`, not `body` itself. Missing this is the P1 that made
    /// replay drop every agent line while live streaming kept working.
    #[test]
    fn event_body_unwraps_a_hydrated_event_record() {
        let body = json!({
            "record": "event",
            "body": { "kind": "agent", "line": { "type": "sidecar" } },
        });
        let event = event_body(&body).expect("an event record must unwrap");
        assert_eq!(event.get("kind").and_then(Value::as_str), Some("agent"));
        assert_eq!(
            event["line"]["type"].as_str(),
            Some("sidecar"),
            "got {event}"
        );
    }

    /// A non-event durable record (e.g. `prompt-queued`) has no inner event
    /// body at all, and must not be mistaken for one.
    #[test]
    fn event_body_is_none_for_a_non_event_record() {
        let body = json!({ "record": "prompt-queued", "prompt": "p1" });
        assert!(event_body(&body).is_none());
    }

    /// Host-launch tests: the shell build never compiles `pick_bundle`/
    /// `host_alive` (they are `#[cfg(not(falcon_shell))]`, item 1), so this
    /// whole group is gated the same way — `src-falcon`'s own `cargo test`
    /// compiles this file too (`#[path]`) with `falcon_shell` set.
    #[cfg(not(falcon_shell))]
    mod host_launch {
        use super::*;
        use std::fs;

        fn temp_bundle_root(label: &str) -> PathBuf {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            std::env::temp_dir().join(format!("vidar-falcon-{label}-{nanos}"))
        }

        fn write_manifest(bundle_dir: &Path, bundle_id: &str, created_utc: &str) {
            fs::create_dir_all(bundle_dir).unwrap();
            fs::write(bundle_dir.join("falcon.exe"), b"stub").unwrap();
            fs::write(
                bundle_dir.join("runtime-manifest.json"),
                json!({ "bundle_id": bundle_id, "created_utc": created_utc }).to_string(),
            )
            .unwrap();
        }

        /// A pointer naming a bundle whose `falcon.exe` still exists wins over the
        /// scan, even when a newer bundle also exists.
        #[test]
        fn pick_bundle_prefers_the_pointer() {
            let root = temp_bundle_root("pointer");
            let bundles = root.join("bundles");
            write_manifest(&bundles.join("old"), "old", "2026-09-01T00:00:00.000Z");
            write_manifest(&bundles.join("new"), "new", "2026-09-15T00:00:00.000Z");
            let pointer = root.join("current.json");
            fs::write(
            &pointer,
            json!({ "bundle_id": "old", "executable": bundles.join("old").join("falcon.exe").to_string_lossy() })
                .to_string(),
        )
        .unwrap();

            let (bundle_id, exe) = pick_bundle(&pointer, &bundles).expect("pointer bundle");
            assert_eq!(bundle_id, "old");
            assert_eq!(exe, bundles.join("old").join("falcon.exe"));
            let _ = fs::remove_dir_all(&root);
        }

        /// After the falcon dir moves, the pointer's absolute `executable` names
        /// the old tree; its `bundle_id` still resolves under `bundles_dir` and
        /// wins over the newer scanned bundle.
        #[test]
        fn pick_bundle_resolves_the_pointer_by_id_not_its_stale_executable() {
            let root = temp_bundle_root("moved");
            let bundles = root.join("bundles");
            write_manifest(&bundles.join("old"), "old", "2026-09-01T00:00:00.000Z");
            write_manifest(&bundles.join("new"), "new", "2026-09-15T00:00:00.000Z");
            let stale = root.join("gone").join("bundles").join("old").join("falcon.exe");
            let pointer = root.join("current.json");
            fs::write(
                &pointer,
                json!({ "bundle_id": "old", "executable": stale.to_string_lossy() }).to_string(),
            )
            .unwrap();

            let (bundle_id, exe) = pick_bundle(&pointer, &bundles).expect("pointer bundle");
            assert_eq!(bundle_id, "old");
            assert_eq!(exe, bundles.join("old").join("falcon.exe"));
            let _ = fs::remove_dir_all(&root);
        }

        /// No pointer (or a stale one): the scan falls back to the bundle with the
        /// newest `created_utc`.
        #[test]
        fn pick_bundle_falls_back_to_the_newest_scanned_bundle() {
            let root = temp_bundle_root("scan");
            let bundles = root.join("bundles");
            write_manifest(&bundles.join("old"), "old", "2026-09-01T00:00:00.000Z");
            write_manifest(&bundles.join("new"), "new", "2026-09-15T00:00:00.000Z");
            let pointer = root.join("current.json"); // never written: absent pointer

            let (bundle_id, exe) = pick_bundle(&pointer, &bundles).expect("newest bundle");
            assert_eq!(bundle_id, "new");
            assert_eq!(exe, bundles.join("new").join("falcon.exe"));
            let _ = fs::remove_dir_all(&root);
        }

        fn write_runtimes_manifest(bundle_dir: &Path, bundle_id: &str, created_utc: &str, runtimes: Option<&[&str]>) {
            write_manifest(bundle_dir, bundle_id, created_utc);
            let mut manifest = json!({ "bundle_id": bundle_id, "created_utc": created_utc });
            if let Some(runtimes) = runtimes {
                manifest["runtimes"] = json!(runtimes);
            }
            fs::write(bundle_dir.join("runtime-manifest.json"), manifest.to_string()).unwrap();
        }

        /// A newer codex-only bundle loses the scan to an older two-runtime one.
        #[test]
        fn pick_bundle_scan_prefers_the_fuller_bundle_over_a_newer_codex_only_one() {
            let root = temp_bundle_root("fuller");
            let bundles = root.join("bundles");
            write_runtimes_manifest(&bundles.join("full"), "full", "2026-09-01T00:00:00.000Z", Some(&["claude", "codex"]));
            write_runtimes_manifest(&bundles.join("codex"), "codex", "2026-09-15T00:00:00.000Z", Some(&["codex"]));
            let pointer = root.join("current.json");

            let (bundle_id, _) = pick_bundle(&pointer, &bundles).expect("fuller bundle");
            assert_eq!(bundle_id, "full");
            let _ = fs::remove_dir_all(&root);
        }

        /// A codex-only bundle that is the only one is still picked.
        #[test]
        fn pick_bundle_scan_picks_a_lone_codex_only_bundle() {
            let root = temp_bundle_root("codex-only");
            let bundles = root.join("bundles");
            write_runtimes_manifest(&bundles.join("codex"), "codex", "2026-09-15T00:00:00.000Z", Some(&["codex"]));
            let pointer = root.join("current.json");

            let (bundle_id, _) = pick_bundle(&pointer, &bundles).expect("codex-only bundle");
            assert_eq!(bundle_id, "codex");
            let _ = fs::remove_dir_all(&root);
        }

        /// A manifest without `runtimes` (schema < 4) counts as two runtimes, so it
        /// ties a two-runtime schema-4 bundle and the newer one wins, and it beats
        /// a newer codex-only bundle.
        #[test]
        fn pick_bundle_counts_a_pre_schema_4_manifest_as_two_runtimes() {
            let root = temp_bundle_root("legacy");
            let bundles = root.join("bundles");
            write_runtimes_manifest(&bundles.join("legacy"), "legacy", "2026-09-01T00:00:00.000Z", None);
            write_runtimes_manifest(&bundles.join("codex"), "codex", "2026-09-15T00:00:00.000Z", Some(&["codex"]));
            let pointer = root.join("current.json");
            let (bundle_id, _) = pick_bundle(&pointer, &bundles).expect("legacy bundle");
            assert_eq!(bundle_id, "legacy");

            write_runtimes_manifest(&bundles.join("two"), "two", "2026-09-10T00:00:00.000Z", Some(&["claude", "codex"]));
            let (bundle_id, _) = pick_bundle(&pointer, &bundles).expect("newer two-runtime bundle");
            assert_eq!(bundle_id, "two");
            let _ = fs::remove_dir_all(&root);
        }

        /// A bundle directory with a manifest but no `falcon.exe` is refused, not
        /// silently selected.
        #[test]
        fn pick_bundle_refuses_when_no_bundle_has_an_executable() {
            let root = temp_bundle_root("missing-exe");
            let bundles = root.join("bundles");
            let dir = bundles.join("broken");
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("runtime-manifest.json"),
                json!({ "bundle_id": "broken", "created_utc": "2026-09-15T00:00:00.000Z" })
                    .to_string(),
            )
            .unwrap();
            let pointer = root.join("current.json");

            assert!(pick_bundle(&pointer, &bundles).is_err());
            let _ = fs::remove_dir_all(&root);
        }

        /// The running test binary's own pid and creation time match the
        /// registry, but its image is not `falcon.exe` — refused on the image
        /// check, not silently accepted on pid alone.
        #[test]
        fn host_alive_is_false_for_a_process_that_is_not_falcon_exe() {
            let pid = std::process::id();
            let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
                .expect("open self");
            let created = process_creation_identity(process).expect("creation time");
            unsafe {
                let _ = CloseHandle(process);
            }
            let registry = FalconRegistry {
                pid,
                process_created_100ns: created,
                ..registry_stub()
            };
            assert!(!host_alive(&registry));
        }

        /// A pid that does not exist (or is not ours to query) is not alive.
        #[test]
        fn host_alive_is_false_for_an_unopenable_pid() {
            assert!(!host_alive(&registry_stub()));
        }

        fn registry_stub() -> FalconRegistry {
            FalconRegistry {
                schema_version: 1,
                activation_endpoint: String::new(),
                session_endpoint: String::new(),
                pid: 0,
                process_created_100ns: 0,
                executable: String::new(),
                profile_directory: String::new(),
                protocol_min: 1,
                protocol_max: 1,
                supported_agents: Vec::new(),
                bundle_id: String::new(),
                attach_secret: String::new(),
            }
        }
    }
}
