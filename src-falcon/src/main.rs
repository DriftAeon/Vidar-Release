// No console window on a release host (matches src-tauri/src/main.rs). The
// --probe subcommand's println! still reaches a parent that captures stdout
// (the slice scripts do); with nothing attached it is dropped, not a panic.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod claude;
mod codex;
mod frontend;
mod ipc;
mod journal;
mod process;
mod protocol;
mod registry;
mod replay;
mod security;
mod serve;
mod session;

#[cfg(test)]
mod bridge_golden;

#[path = "../../src-tauri/src/falcon.rs"]
mod falcon_client;

#[path = "../../src-tauri/src/runlog.rs"]
mod runlog;

// Layout constants (FRONTENDS, FRONTEND_POINTER) for frontend.rs; falcon.rs keeps its own
// private copy of this module, so the shell compiles the file a second time.
#[path = "../../src-tauri/src/falcon/layout.rs"]
mod layout;

// A profiled (bare) Claude spawn: Vidar's own env builder and home placement, mounted rather than
// copied so the hosted env and home match the Raw bare tab's (`claude.rs` `bare_spawn`). The shell
// uses only part of env.rs (the Codex helpers are Vidar's).
#[path = "../../src-tauri/src/bare/env.rs"]
#[allow(dead_code)]
mod bare_env;
#[path = "../../src-tauri/src/bare/home_path.rs"]
mod bare_home;
// A Codex Bare row's payload admission, shared with Vidar (`codex.rs` Bare spawn). The file's TOML
// encoder and 12,000 limit serve Vidar's Classic rules library only, so the host leaves them unused.
#[allow(dead_code)]
#[path = "../../src-tauri/src/bare/codex_payload.rs"]
mod codex_payload;

use std::{
    env,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use registry::FalconRegistry;
use security::{wide, OwnedHandle, UserSecurity};
use uuid::Uuid;
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{GetLastError, ERROR_ALREADY_EXISTS},
        System::Threading::CreateMutexW,
    },
};

/// Long enough that a client reconnecting between operations never races it,
/// short enough that an abandoned host clears the stable endpoints on its own.
const DEFAULT_IDLE_GRACE: Duration = Duration::from_secs(300);

/// Grace before an unattended permission (no controller attached) is denied
/// by timeout. `--unattended-permission-secs 0` auto-shows but never times
/// out — for deliberately parking a request under observation, never for
/// normal operation.
const DEFAULT_UNATTENDED_PERMISSION_GRACE: Duration = Duration::from_secs(120);

/// Grace before a session that never got a conversation id, and has neither
/// a controller nor a subscriber, ends itself — the tab that spawned it was
/// closed before the sidecar's first turn, so there is nothing to dock back
/// to. `--unused-session-secs 0` disables the sweep.
const DEFAULT_UNUSED_SESSION_GRACE: Duration = Duration::from_secs(300);

/// Grace before a session WITH a conversation id, but no controller, no
/// subscriber and no pending work (queued/in-flight prompt, open permission,
/// unattended watcher, open background task), ends itself.
///
/// This rule runs only while NO client is connected, and its clock restarts
/// whenever one is. Vidar keeps a bus connection for as long as it runs; a
/// relaunch reconnects and re-adopts the sessions it held last
/// (`src/launcher/readopt.ts`), and a session Vidar dropped while connected is
/// the Vidar-held rule's (`DEFAULT_VIDAR_ORPHAN_GRACE`), so a parked or
/// jettisoned session is never reaped while Vidar is up. Once Vidar has closed, an unattended session
/// is ended after this grace, bounding an abandoned host at about 10 min (this
/// + the 300 s idle exit) instead of hours. Ending it keeps the journal and
/// frees the conversation claim, so a resume by conversation id still works.
/// `--orphan-session-secs 0` disables it.
/// 900 s until 2026-10-05; the user cut it to 300 s (a closed Vidar costs a resume, not work).
const DEFAULT_ORPHAN_SESSION_GRACE: Duration = Duration::from_secs(300);

/// Grace before a Vidar-held orphan ends while a client IS connected: a
/// Claude session whose last lease holder was Vidar, with no subscriber, no
/// controller, no pending work and no live jettison handoff naming it (a
/// reload ghost or a smoke's leftover). With no client connected the 300 s
/// grace above applies instead. `--vidar-orphan-secs 0` disables it.
/// Ruling: `docs/projects/falcon/falcon-idle-reap.md` §Decision 2-4.
const DEFAULT_VIDAR_ORPHAN_GRACE: Duration = Duration::from_secs(300);

/// The jettison handoff, in the Falcon dir above the registry's dir in both layouts
/// (twin: `layout::HANDOFF_JETTISON` in `src-tauri/src/falcon/layout.rs`,
/// private to the client module).
const JETTISON_HANDOFF: &str = "handoff-jettison.json";

fn main() {
    let args: Vec<String> = env::args().collect();
    let probing = matches!(args.get(1).map(String::as_str), Some("--probe" | "--session-probe"));
    if !probing {
        if let Some(paths) = value_after(&args, "--registry")
            .and_then(|registry| falcon_client::FalconPaths::from_registry_path(std::path::Path::new(&registry)).ok())
        {
            runlog::init(&paths.bridge_dir().join("logs"), "falcon");
        }
    }
    if let Err(error) = run() {
        eprintln!("falcon: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    if args.get(1).map(String::as_str) == Some("--probe") {
        return run_probe(&args[2..]);
    }

    if args.get(1).map(String::as_str) == Some("--session-probe") {
        return run_session_probe(&args[2..]);
    }

    let registry_path = required_arg(&args, "--registry")?;
    let bundle_id = required_arg(&args, "--bundle-id")?;
    // The content-addressed runtime store is passed explicitly rather than
    // derived from the executable's path: a bundle must not infer where the
    // store lives from how deep in the tree it happens to sit.
    let store = required_arg(&args, "--store")?;
    // Seconds with no hosted session and no attached client before the host
    // exits. 0 disables it — useful when deliberately parking a host for
    // observation, never for normal operation.
    let idle_grace = match value_after(&args, "--idle-grace-secs") {
        Some(value) => Duration::from_secs(
            value
                .parse::<u64>()
                .map_err(|error| format!("--idle-grace-secs: {error}"))?,
        ),
        None => DEFAULT_IDLE_GRACE,
    };
    let unattended_grace = match value_after(&args, "--unattended-permission-secs") {
        Some(value) => Duration::from_secs(
            value
                .parse::<u64>()
                .map_err(|error| format!("--unattended-permission-secs: {error}"))?,
        ),
        None => DEFAULT_UNATTENDED_PERMISSION_GRACE,
    };
    let unused_session_grace = match value_after(&args, "--unused-session-secs") {
        Some(value) => Duration::from_secs(
            value
                .parse::<u64>()
                .map_err(|error| format!("--unused-session-secs: {error}"))?,
        ),
        None => DEFAULT_UNUSED_SESSION_GRACE,
    };
    let orphan_session_grace = match value_after(&args, "--orphan-session-secs") {
        Some(value) => Duration::from_secs(
            value
                .parse::<u64>()
                .map_err(|error| format!("--orphan-session-secs: {error}"))?,
        ),
        None => DEFAULT_ORPHAN_SESSION_GRACE,
    };
    let vidar_orphan_grace = match value_after(&args, "--vidar-orphan-secs") {
        Some(value) => Duration::from_secs(
            value
                .parse::<u64>()
                .map_err(|error| format!("--vidar-orphan-secs: {error}"))?,
        ),
        None => DEFAULT_VIDAR_ORPHAN_GRACE,
    };
    // Smoke-only: full role for this host's own falcon.exe (its --probe and
    // --session-probe clients) and one more exact image, honoured only on a
    // root under the temp directory (`serve::peer::PeerPolicy::admit_probe`).
    // spawn_host never passes either.
    let admit_probe = args.iter().any(|arg| arg == "--admit-probe");
    let admit_image = value_after(&args, "--admit-image").map(PathBuf::from);
    run_host(
        PathBuf::from(registry_path),
        bundle_id,
        PathBuf::from(store),
        idle_grace,
        unattended_grace,
        unused_session_grace,
        orphan_session_grace,
        vidar_orphan_grace,
        admit_probe,
        admit_image,
    )
}

/// A disposable protocol-v1 client. Reads a JSON array of operations, sends
/// each in order, and prints every frame the host returns as one JSON line.
///
/// This is the "disposable client": it exercises
/// the real protocol without Vidar, and without the frontend existing yet.
fn run_session_probe(args: &[String]) -> Result<(), String> {
    let registry_path = value_after(args, "--registry")
        .ok_or_else(|| "--session-probe requires --registry PATH".to_string())?;
    let operations = value_after(args, "--ops")
        .ok_or_else(|| "--session-probe requires --ops PATH".to_string())?;
    let secret = value_after(args, "--secret");
    let protocol = value_after(args, "--protocol")
        .map(|value| value.parse::<u32>().map_err(|error| error.to_string()))
        .transpose()?;
    // How long to keep draining pushed events after the last response.
    let linger = value_after(args, "--linger-ms")
        .map(|value| value.parse::<u64>().map_err(|error| error.to_string()))
        .transpose()?
        .unwrap_or(0);
    serve::probe_session(
        &PathBuf::from(registry_path),
        &PathBuf::from(operations),
        secret,
        protocol,
        linger,
    )
}

fn run_probe(args: &[String]) -> Result<(), String> {
    let registry_path = value_after(args, "--registry")
        .ok_or_else(|| "--probe requires --registry PATH".to_string())?;
    let endpoint = value_after(args, "--endpoint").unwrap_or_else(|| "activation".into());
    let command = value_after(args, "--command").unwrap_or_else(|| "ping".into());
    let secret = value_after(args, "--secret");
    let force = args.iter().any(|a| a == "--force");
    let response = ipc::probe(&PathBuf::from(registry_path), &endpoint, &command, secret, force)?;
    println!(
        "{}",
        serde_json::to_string(&response).map_err(|error| error.to_string())?
    );
    if response.ok {
        Ok(())
    } else {
        Err(response.error.unwrap_or_else(|| "probe rejected".into()))
    }
}

fn run_host(
    registry_path: PathBuf,
    bundle_id: String,
    store: PathBuf,
    idle_grace: Duration,
    unattended_grace: Duration,
    unused_session_grace: Duration,
    orphan_session_grace: Duration,
    vidar_orphan_grace: Duration,
    admit_probe: bool,
    admit_image: Option<PathBuf>,
) -> Result<(), String> {
    // The shell's own client needs the Vidar folder (bridge\falcon handoff and
    // dock files, bridge\open). The host CLI carries no root flag, so older
    // Vidar builds keep launching newer bundles: it comes back out of
    // `--registry` (<vidar>\runtime\bridge\falcon\runtime\registry.json, or the
    // legacy <vidar>\bridge\falcon\runtime\registry.json), and so does the
    // shape. A registry path in any other layout stops the host before it takes
    // the mutex or publishes anything.
    let vidar_paths = falcon_client::FalconPaths::from_registry_path(&registry_path)?;
    let (vidar_root, _) = layout::match_registry(&registry_path)?;
    // Per-folder pipe and mutex names: a second Vidar install on this logon
    // gets its own host instead of contending for one set of endpoints.
    let names = falcon_client::host_names::for_root(&vidar_root);
    let security = Box::leak(Box::new(UserSecurity::current_user()?));
    registry::prepare_registry_parent(&registry_path, security)?;
    let local_app_data =
        env::var_os("LOCALAPPDATA").ok_or_else(|| "LOCALAPPDATA is unavailable".to_string())?;
    // Same string as tauri.conf.json `identifier`; falcon-prune.ps1 reads the
    // identifier from there to find these per-bundle profiles.
    let profile_directory = PathBuf::from(local_app_data)
        .join("com.aeondrift.falcon")
        .join(&bundle_id);
    std::fs::create_dir_all(&profile_directory)
        .map_err(|error| format!("create WebView profile: {error}"))?;
    security::reject_reparse(&profile_directory)?;
    let mutex_name = wide(&names.host_mutex);
    let mutex = unsafe {
        CreateMutexW(
            Some(security.attributes()),
            true,
            PCWSTR(mutex_name.as_ptr()),
        )
        .map_err(|error| error.to_string())?
    };
    let mutex = OwnedHandle(mutex);
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        return Err("another Falcon host owns this Vidar folder's endpoints".into());
    }

    let executable = env::current_exe()
        .and_then(std::fs::canonicalize)
        .map_err(|error| format!("resolve executable: {error}"))?;
    let mut registry = FalconRegistry {
        schema_version: 1,
        activation_endpoint: names.activation_endpoint.clone(),
        session_endpoint: names.session_endpoint.clone(),
        pid: std::process::id(),
        process_created_100ns: ipc::current_process_creation_identity()?,
        executable: executable.to_string_lossy().into_owned(),
        profile_directory: profile_directory.to_string_lossy().into_owned(),
        protocol_min: 1,
        protocol_max: protocol::PROTOCOL_VERSION,
        supported_agents: Vec::new(),
        bundle_id,
        attach_secret: Uuid::new_v4().simple().to_string(),
    };
    let allow_exit = Arc::new(AtomicBool::new(false));

    // Resolve and verify the bundle's Claude and Codex runtimes before
    // publishing the registry, each on its own: one runtime is enough to host,
    // and `supported_agents` advertises only what resolved. A host with neither
    // must not advertise itself as ready to host anything.
    let bundle_directory = executable
        .parent()
        .ok_or_else(|| "executable has no parent directory".to_string())?
        .to_path_buf();
    let (runtimes, supported_agents) = assemble_runtimes(
        claude::ClaudeRuntime::resolve(&bundle_directory, &store),
        codex::CodexRuntime::resolve(&bundle_directory, &store),
        &vidar_root,
    )?;
    registry.supported_agents = supported_agents;
    // Full role: this process, or exactly <root>\vidar.exe /
    // <root>\src-tauri\target\{release,debug}\vidar.exe (security H3).
    let mut peers = serve::peer::PeerPolicy::for_root(&vidar_root);
    if admit_probe {
        let mut images = vec![executable.clone()];
        images.extend(admit_image);
        eprintln!("{}", peers.admit_probe(&vidar_root, &env::temp_dir(), &images));
    } else if let Some(image) = admit_image {
        eprintln!("falcon: --admit-image {} ignored without --admit-probe", image.display());
    }
    let host = Arc::new(serve::Host {
        falcon: registry.clone(),
        // Tag session ids with this host's creation stamp so a restarted Falcon
        // never reissues an identifier a client might still be holding.
        registry: session::Registry::for_incarnation(registry.process_created_100ns),
        runtimes,
        clients: std::sync::atomic::AtomicUsize::new(0),
        vidar_clients: std::sync::atomic::AtomicUsize::new(0),
        exiting: std::sync::atomic::AtomicBool::new(false),
        // Beside the registry, under the same user-only ACL the runtime
        // directory already carries.
        journal_root: registry_path
            .parent()
            .ok_or_else(|| "registry has no parent directory".to_string())?
            .join("journals"),
        show_shell: std::sync::OnceLock::new(),
        unattended_grace,
        unused_session_grace,
        orphan_session_grace,
        vidar_orphan_grace,
        // <falcon>\runtime\registry.json -> <falcon>\handoff-jettison.json
        jettison_handoff: registry_path
            .parent()
            .and_then(std::path::Path::parent)
            .map(|falcon| falcon.join(JETTISON_HANDOFF)),
        bus: serve::BusHub::new(),
        peers,
    });
    std::fs::create_dir_all(&host.journal_root)
        .map_err(|error| format!("create journal directory: {error}"))?;

    // The live frontend: a verified staged set served ahead of the embedded assets.
    let mut context = tauri::generate_context!();
    let frontend_state = frontend::install(&mut context, &registry_path, &bundle_directory);

    let app = tauri::Builder::default()
        .manage(Arc::new(falcon_client::Falcon::from_paths(vidar_paths)))
        .manage(Arc::clone(&frontend_state))
        .invoke_handler(tauri::generate_handler![
            falcon_client::falcon_available,
            falcon_client::falcon_spawn,
            falcon_client::falcon_list,
            falcon_client::falcon_adopt,
            falcon_client::falcon_send,
            falcon_client::falcon_retract,
            falcon_client::falcon_steer,
            falcon_client::falcon_detach,
            falcon_client::falcon_kill,
            falcon_client::falcon_handoff_write,
            falcon_client::falcon_handoff_peek,
            falcon_client::falcon_handoff_clear,
            falcon_client::falcon_dock_ask,
            falcon_client::falcon_dock_request_claim,
            falcon_client::falcon_dock_request_release,
            falcon_client::falcon_dock_result_write,
            falcon_client::falcon_theme,
            frontend::falcon_frontend_status,
            frontend::falcon_frontend_reload,
            frontend::falcon_frontend_booted,
        ])
        .setup({
            let registry = registry.clone();
            let registry_path = registry_path.clone();
            let allow_exit = allow_exit.clone();
            let host = Arc::clone(&host);
            let frontend_state = Arc::clone(&frontend_state);
            let profile_directory = profile_directory.clone();
            move |app| {
                // A staged frontend served from startup is guarded until its page acknowledges.
                frontend_state.arm_watchdog(app.handle().clone());
                let (ready_send, ready_receive) = std::sync::mpsc::channel();
                ipc::serve(
                    "activation",
                    registry.activation_endpoint.clone(),
                    registry.clone(),
                    security,
                    app.handle().clone(),
                    allow_exit.clone(),
                    {
                        let host = Arc::clone(&host);
                        Arc::new(move || host.has_live_sessions())
                    },
                    host.peers.clone(),
                    ready_send.clone(),
                );
                // The unattended-permission watcher's only way to show the
                // shell: built here because the AppHandle does not exist until
                // `.setup` runs, but the `Host` it lives on was built earlier.
                // Set BEFORE `serve_session` starts accepting requests — a
                // permission request racing the gap between the two would
                // otherwise find no show_shell and be denied at once.
                let _ = host.show_shell.set({
                    let handle = app.handle().clone();
                    let profile_directory = profile_directory.clone();
                    Box::new(move || ipc::create_window(&handle, &profile_directory))
                });
                serve::serve_session(
                    registry.session_endpoint.clone(),
                    Arc::clone(&host),
                    security,
                    ready_send,
                );
                // A host that outlives its last session and client would hold
                // the single-host mutex on the stable endpoints forever, so
                // every later host dies at startup while the registry names a
                // process that no longer exists. Exiting on idle is what stops
                // an abandoned run becoming a squatter.
                serve::start_idle_watchdog(Arc::clone(&host), idle_grace, {
                    let handle = app.handle().clone();
                    let allow_exit = allow_exit.clone();
                    move || {
                        // Same authenticated-shutdown path the activation
                        // endpoint uses: set the flag, then ask Tauri to exit.
                        allow_exit.store(true, Ordering::SeqCst);
                        handle.exit(0);
                    }
                });
                for _ in 0..2 {
                    ready_receive
                        .recv()
                        .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))??;
                }
                registry::publish(&registry_path, &registry, security)
                    .map_err(Box::<dyn std::error::Error>::from)?;
                Ok(())
            }
        })
        .build(context)
        .map_err(|error| error.to_string())?;

    app.run(move |_handle, event| {
        let _keep_mutex_alive = &mutex;
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !allow_exit.load(Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
    });
    Ok(())
}

fn required_arg(args: &[String], name: &str) -> Result<String, String> {
    value_after(args, name).ok_or_else(|| format!("missing {name} VALUE"))
}

/// Builds the host's runtimes from each agent's resolve result. An agent that
/// fails to resolve is logged and left out of `supported_agents`; the host
/// refuses to publish its registry only when no runtime resolves at all.
fn assemble_runtimes(
    claude_result: Result<claude::ClaudeRuntime, String>,
    codex_result: Result<codex::CodexRuntime, String>,
    vidar_root: &std::path::Path,
) -> Result<(Vec<serve::AgentRuntime>, Vec<String>), String> {
    let mut runtimes = Vec::new();
    let mut supported = Vec::new();
    let mut failures = Vec::new();
    match claude_result {
        Ok(mut runtime) => {
            // The only root a client's `rules_file` is admitted under: the Vidar
            // folder this host's own `--registry` names, never a client value.
            runtime.rules_built = Some(vidar_root.join(claude::RULES_BUILT));
            supported.push(protocol::Agent::Claude.as_str().into());
            runtimes.push(serve::AgentRuntime::Claude(runtime));
        }
        Err(error) => {
            eprintln!("falcon: Claude runtime unavailable: {error}");
            failures.push(format!("Claude: {error}"));
        }
    }
    match codex_result {
        Ok(runtime) => {
            // The only root a profiled (Bare) Codex spawn reads its profile from: this host's
            // own `--registry` folder, never a client value.
            codex::set_vidar_root(vidar_root);
            supported.push(protocol::Agent::Codex.as_str().into());
            runtimes.push(serve::AgentRuntime::Codex(runtime));
        }
        Err(error) => {
            // Bundles without a valid closure stay useful for the other agent,
            // but must never advertise this one's readiness.
            eprintln!("falcon: Codex runtime unavailable: {error}");
            failures.push(format!("Codex: {error}"));
        }
    }
    if runtimes.is_empty() {
        return Err(format!(
            "no agent runtime resolved ({})",
            failures.join("; ")
        ));
    }
    Ok((runtimes, supported))
}

fn value_after(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|value| value == name)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

#[cfg(test)]
mod soft_start_tests {
    use super::assemble_runtimes;

    #[test]
    fn host_with_zero_runtimes_refuses_to_publish() {
        let error = assemble_runtimes(
            Err("no claude".into()),
            Err("no codex".into()),
            std::path::Path::new("."),
        )
        .err()
        .expect("zero runtimes must refuse");
        assert!(error.contains("no agent runtime resolved"), "{error}");
        assert!(
            error.contains("no claude") && error.contains("no codex"),
            "{error}"
        );
    }
}

#[cfg(test)]
mod falcon_client_protocol_tests {
    // falcon_client is src-tauri/src/falcon.rs, included above by #[path] — this asserts the
    // client's hardcoded ceiling (CLIENT_PROTOCOL) never silently drifts from the host's own
    // protocol::PROTOCOL_VERSION (a mismatch here would only surface at runtime
    // negotiation, not at build time).
    use crate::falcon_client::CLIENT_PROTOCOL;
    use crate::protocol::PROTOCOL_VERSION;

    #[test]
    fn client_protocol_matches_host_protocol_version() {
        assert_eq!(CLIENT_PROTOCOL, PROTOCOL_VERSION);
    }

    /// `hosted_request` must outlast the host's own
    /// `claude::COMMAND_TIMEOUT` or a slow-but-alive reply times out
    /// client-side first, dropping the shared control pipe and releasing
    /// every hosted tab's lease. Compares against the live constant (not a
    /// hardcoded copy) so the two can never silently drift apart.
    #[test]
    fn command_request_timeout_exceeds_the_hosts_command_timeout() {
        use crate::claude::COMMAND_TIMEOUT;
        use crate::falcon_client::COMMAND_REQUEST_TIMEOUT;
        assert!(
            COMMAND_REQUEST_TIMEOUT > COMMAND_TIMEOUT,
            "COMMAND_REQUEST_TIMEOUT ({COMMAND_REQUEST_TIMEOUT:?}) must exceed the host's \
             claude::COMMAND_TIMEOUT ({COMMAND_TIMEOUT:?}), or a slow-but-alive command reply \
             times out client-side first and drops the shared control pipe"
        );
    }
}
