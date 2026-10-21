//! Host-on-demand (Vidar only): pick a bundle, spawn the host, wait for its
//! activation pipe to answer, and the `falcon_show` command on that pipe.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

// `Instant` is only used by `ensure_host` below, which is Vidar-only (the
// shell build never starts a host).
#[cfg(not(falcon_shell))]
use std::time::Instant;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

use super::connection::{negotiated_protocol, Connection};
use super::host_identity::{bind_server_identity, host_alive};
use super::{read_registry, Falcon, FalconPaths};

/// Host-on-demand: launched, found and probed only by Vidar itself, never by
/// the shell build (`falcon-shell` connects to a host, it does not start one).
#[cfg(not(falcon_shell))]
mod launch {
    /// Raw u32 flags in `agent.rs`'s style (`CREATE_NO_WINDOW`, agent.rs:48).
    pub const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    pub const DETACHED_PROCESS: u32 = 0x0000_0008;
    pub const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
}
#[cfg(not(falcon_shell))]
use launch::{CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS};

#[cfg(not(falcon_shell))]
#[derive(Deserialize)]
struct BundlePointer {
    /// Resolved under `bundles_dir`; the pointer's absolute `executable` is not
    /// read, since it goes stale if the falcon dir moves.
    bundle_id: String,
}

#[cfg(not(falcon_shell))]
#[derive(Deserialize)]
struct RuntimeManifest {
    bundle_id: String,
    created_utc: String,
    /// Schema 4 lists the runtimes a bundle carries; older manifests omit it.
    #[serde(default)]
    runtimes: Option<Vec<String>>,
}

#[cfg(not(falcon_shell))]
impl RuntimeManifest {
    /// A manifest without `runtimes` is schema < 4: claude + codex.
    fn runtime_count(&self) -> usize {
        self.runtimes.as_ref().map_or(2, Vec::len)
    }
}

/// Which bundle to launch: the pointer `falcon-refresh.ps1` writes after its
/// own ping succeeds, by its `bundle_id` under `bundles_dir`, or — if that is
/// absent, not a plain directory name, or names a bundle that is gone — the
/// bundle under `bundles_dir` with the most runtimes (a manifest without
/// `runtimes` counts as two), then the newest by `created_utc` (ISO `o`, so it
/// sorts lexically). Takes explicit paths rather than a `FalconPaths` so a unit test
/// can point it at a temp dir.
#[cfg(not(falcon_shell))]
pub(super) fn pick_bundle(pointer_path: &Path, bundles_dir: &Path) -> Result<(String, PathBuf), String> {
    if let Ok(text) = std::fs::read_to_string(pointer_path) {
        if let Ok(pointer) = serde_json::from_str::<BundlePointer>(&text) {
            let mut parts = Path::new(&pointer.bundle_id).components();
            let plain = matches!(
                (parts.next(), parts.next()),
                (Some(std::path::Component::Normal(_)), None)
            );
            let exe = bundles_dir.join(&pointer.bundle_id).join("falcon.exe");
            if plain && exe.is_file() {
                return Ok((pointer.bundle_id, exe));
            }
            // Stale pointer: the bundle it names is gone. Fall through to the scan.
        }
    }

    let entries = std::fs::read_dir(bundles_dir).map_err(|error| {
        format!(
            "No Falcon bundles at {}: {error}. Rebuild or reinstall Vidar.",
            bundles_dir.display()
        )
    })?;
    // (runtime count, created_utc, bundle_id, exe): the fuller bundle wins, then the newest.
    let mut newest: Option<(usize, String, String, PathBuf)> = None;
    for entry in entries.flatten() {
        let manifest_path = entry.path().join("runtime-manifest.json");
        let Ok(text) = std::fs::read_to_string(&manifest_path) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<RuntimeManifest>(&text) else {
            continue;
        };
        let exe = entry.path().join("falcon.exe");
        if !exe.is_file() {
            continue;
        }
        let better = match &newest {
            None => true,
            Some((count, created, ..)) => {
                (manifest.runtime_count(), manifest.created_utc.as_str())
                    > (*count, created.as_str())
            }
        };
        if better {
            let count = manifest.runtime_count();
            newest = Some((count, manifest.created_utc, manifest.bundle_id, exe));
        }
    }
    newest
        .map(|(_, _, bundle_id, exe)| (bundle_id, exe))
        .ok_or_else(|| {
            format!(
                "No Falcon bundle with a falcon.exe under {}. Rebuild or reinstall Vidar.",
                bundles_dir.display()
            )
        })
}

/// Whether a launchable Falcon bundle exists — the same pick `ensure_host`
/// makes, without launching anything. Read by the Dependencies probe (deps.rs),
/// which passes the Vidar root.
#[cfg(not(falcon_shell))]
pub(crate) fn bundle_present(root: &Path) -> bool {
    let paths = FalconPaths::new(root.to_path_buf());
    pick_bundle(&paths.bundle_pointer(), &paths.bundles_dir()).is_ok()
}

/// Launch the Falcon host from `exe`, detached from Vidar's console and
/// process group. `breakaway` asks to leave Vidar's own Job Object too, so
/// the host outlives a forced Vidar exit; a caller inside a job that forbids
/// breakaway (os error 5) retries with `breakaway = false` and accepts that
/// the host then dies with Vidar.
#[cfg(not(falcon_shell))]
fn spawn_host(
    paths: &FalconPaths,
    exe: &Path,
    bundle_id: &str,
    cwd: &Path,
    breakaway: bool,
) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new(exe);
    // Host CLI contract: the shell derives the Vidar root from
    // `--registry` (`FalconPaths::from_registry_path`), no new flag.
    cmd.arg("--registry")
        .arg(paths.registry())
        .arg("--bundle-id")
        .arg(bundle_id)
        .arg("--store")
        .arg(paths.store())
    .current_dir(cwd)
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null());
    for key in crate::pty::SCRUBBED_ENV {
        cmd.env_remove(key);
    }
    let mut flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    if breakaway {
        flags |= CREATE_BREAKAWAY_FROM_JOB;
    }
    cmd.creation_flags(flags).spawn()
}

/// Ask the host over the activation endpoint — a second, unrelated pipe from
/// the session endpoint this module otherwise speaks. Not `Connection::open`:
/// the activation protocol is a single request/response (`{protocol, secret,
/// command}` / `{ok, error, ...}`), not the session pipe's `op`-tagged
/// negotiate handshake, so only the frame plumbing (`write_frame`/
/// `read_frame`) is shared. Shared by `falcon_show` (`command: "show"`) and
/// the host-launch readiness poll (`command: "ping"`, `ensure_host`). Both
/// callers are Vidar-only.
#[cfg(not(falcon_shell))]
fn activation_request(
    paths: &FalconPaths,
    command: &str,
    timeout: Duration,
) -> Result<Value, String> {
    use std::os::windows::fs::OpenOptionsExt;
    let registry = read_registry(paths)?;
    let pipe = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .attributes(0)
        .open(&registry.activation_endpoint)
        .map_err(|error| format!("connect {}: {error}", registry.activation_endpoint))?;
    bind_server_identity(&pipe, &registry)?;
    let protocol = negotiated_protocol(&registry)?;
    let mut connection = Connection::raw(pipe);
    connection.write_frame(&json!({
        "protocol": protocol,
        "secret": registry.attach_secret,
        "command": command,
    }))?;
    // Bounded: this pipe is opened without FILE_FLAG_OVERLAPPED (module
    // header), so the read itself cannot carry a timeout — read on its own
    // thread and bound the WAIT instead, the same shape `ipc.rs::create_window`
    // uses to bound a blocking exchange (`ipc.rs:252-254`, `recv_timeout`).
    // A wedged host must not leave a Jettison — already detached — hanging
    // The reader thread is abandoned on timeout; the
    // pipe is this call's own, so nothing else is waiting on it.
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = send.send(connection.read_frame());
    });
    let reply = match receive.recv_timeout(timeout) {
        Ok(reply) => reply?,
        Err(_) => {
            return Err(format!(
                "falcon did not answer {command} within {timeout:?}"
            ))
        }
    };
    if reply.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(reply
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("refused")
            .to_string());
    }
    Ok(reply)
}

/// Cheap first half of a readiness check: is the activation pipe even
/// accepting a connection yet? `CreateFile` on a named pipe either succeeds
/// or fails at once (`ERROR_FILE_NOT_FOUND`/`ERROR_PIPE_BUSY`), it does not
/// block waiting for a server — so this costs nothing while the host is
/// still starting, unlike `activation_request`, which pays for a reader
/// thread and up to a second's wait per call (the launch
/// poll would otherwise spawn one abandoned thread per 100ms tick).
#[cfg(not(falcon_shell))]
fn pipe_connectable(path: &str) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .attributes(0)
        .open(path)
        .is_ok()
}

/// Full readiness: registered, alive, its activation pipe already accepts a
/// connection, and it answers a ping. Only the last step spawns a reader
/// thread, and only once the first three already passed.
#[cfg(not(falcon_shell))]
fn activation_ready(paths: &FalconPaths) -> bool {
    let Ok(registry) = read_registry(paths) else {
        return false;
    };
    host_alive(&registry)
        && pipe_connectable(&registry.activation_endpoint)
        && activation_request(paths, "ping", Duration::from_secs(1)).is_ok()
}

// Not registered by the shell build's `generate_handler!`
// (`src-falcon\src\main.rs`); the shell has no launcher window to show.
#[cfg(not(falcon_shell))]
#[tauri::command]
pub async fn falcon_show(falcon: State<'_, Arc<Falcon>>) -> Result<Option<bool>, String> {
    let paths = falcon.paths.clone();
    tauri::async_runtime::spawn_blocking(move || falcon_show_blocking(&paths))
        .await
        .map_err(|e| format!("show task failed: {e}"))?
}

#[cfg(not(falcon_shell))]
fn falcon_show_blocking(paths: &FalconPaths) -> Result<Option<bool>, String> {
    let reply = activation_request(paths, "show", Duration::from_secs(5))?;
    Ok(reply.get("window_created").and_then(Value::as_bool))
}

impl Falcon {
    /// Start the Falcon host if none is registered and alive, or wait for a
    /// concurrent caller's launch to finish (the mutex, not a retry loop: a
    /// waiter that queues behind it finds the host already up). Never on the
    /// Tauri main thread — every caller (`control`, hence `falcon_spawn`/
    /// `falcon_list`/`falcon_adopt`) already runs inside `spawn_blocking`.
    #[cfg(not(falcon_shell))]
    pub(super) fn ensure_host(&self) -> Result<(), String> {
        let _guard = self.launch.lock().map_err(|_| "falcon client poisoned")?;

        if let Ok(registry) = read_registry(&self.paths) {
            if host_alive(&registry) {
                return Ok(());
            }
        }

        // The old host is gone: any view still in `hosted` claims a session
        // this new host was never told about. Their
        // readers die on the already-broken pipe regardless; this just stops
        // them from being offered as live tabs in the meantime.
        if let Ok(mut hosted) = self.hosted.lock() {
            hosted.clear();
        }

        let (bundle_id, exe) =
            pick_bundle(&self.paths.bundle_pointer(), &self.paths.bundles_dir())?;
        let bundle_dir = exe
            .parent()
            .ok_or_else(|| {
                format!(
                    "bundle executable {} has no parent directory",
                    exe.display()
                )
            })?
            .to_path_buf();

        let (mut child, warning) = match spawn_host(&self.paths, &exe, &bundle_id, &bundle_dir, true) {
            Ok(child) => (child, None),
            Err(error) if error.raw_os_error() == Some(5) => {
                // Vidar's own Job Object forbids breakaway; fall back inside it
                // and say so — the host then dies with Vidar.
                let child = spawn_host(&self.paths, &exe, &bundle_id, &bundle_dir, false)
                    .map_err(|error| format!("spawn falcon host: {error}"))?;
                (
                    child,
                    Some("host launched inside Vidar's job; it will die with Vidar".to_string()),
                )
            }
            Err(error) => return Err(format!("spawn falcon host: {error}")),
        };

        // Set before the poll: a fallback launch that
        // then times out below must still report why, not just "not ready".
        if let Ok(mut current) = self.host_warning.lock() {
            *current = warning;
        }

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            // Readiness first every iteration: our own child losing
            // the single-host mutex to a racing launch that is already up is
            // success, not failure, so `try_wait` must never be
            // read as failure before this has had its say.
            if activation_ready(&self.paths) {
                break;
            }
            if let Ok(Some(status)) = child.try_wait() {
                // Check once more: a host may have become ready in the gap
                // between the poll above and this wait.
                if activation_ready(&self.paths) {
                    break;
                }
                return Err(format!("falcon host exited at once ({status})"));
            }
            if Instant::now() >= deadline {
                return Err("falcon host did not become ready within 5s".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        // `child` is deliberately dropped here: std never kills a child on
        // drop (module precedent: agent.rs's own children are only ever
        // killed through their Job Object), and this host is meant to
        // outlive Vidar.
        Ok(())
    }
}

/// Checks a real checkout's bundle staged by `npm run build:falcon` (tools/falcon/build.mjs) against
/// the pick Vidar makes. Ignored by default: it reads a folder outside the test's control.
/// Run: `$env:VIDAR_STAGED_ROOT='<checkout>'; cargo test --manifest-path src-tauri/Cargo.toml staged_source_bundle -- --ignored`
#[cfg(all(test, not(falcon_shell)))]
mod staged_source_bundle {
    use super::*;

    #[test]
    #[ignore = "needs VIDAR_STAGED_ROOT naming a checkout that ran npm run build:falcon"]
    fn pick_bundle_selects_the_bundle_build_falcon_staged() {
        let root = PathBuf::from(std::env::var("VIDAR_STAGED_ROOT").expect("VIDAR_STAGED_ROOT"));
        let paths = FalconPaths::new(root.clone());
        let pointer: Value =
            serde_json::from_str(&std::fs::read_to_string(paths.bundle_pointer()).expect("current.json")).expect("pointer json");
        let staged = pointer["bundle_id"].as_str().expect("bundle_id").to_string();
        assert!(staged.starts_with("src-"), "current.json names {staged}, not a build:falcon bundle");

        let (picked, exe) = pick_bundle(&paths.bundle_pointer(), &paths.bundles_dir()).expect("pick by pointer");
        assert_eq!(picked, staged);
        assert_eq!(exe, paths.bundles_dir().join(&staged).join("falcon.exe"));
        assert!(bundle_present(&root));

        // Without the pointer the scan must land on it too: its manifest parses as RuntimeManifest,
        // counts two runtimes and is the newest of that count.
        let missing = root.join("no-such-pointer.json");
        let (scanned, _) = pick_bundle(&missing, &paths.bundles_dir()).expect("pick by scan");
        assert_eq!(scanned, staged);
    }
}
