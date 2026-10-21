//! The Tauri commands that drive hosted sessions: spawn, list, adopt, send,
//! retract, steer, detach and kill. A spawn names its agent (Claude by
//! default); hosted Codex is spawned or adopted only on a host whose
//! negotiate reply listed `codex_turns` (`ops::agent_refusal`).

use std::sync::{atomic::Ordering, Arc};

#[cfg(not(falcon_shell))]
use serde_json::json;
use serde_json::Value;
use tauri::{AppHandle, State};

use super::connection::Connection;
use super::events::start_event_reader;
use super::ops::*;
use super::reader_control::ReaderControl;
use super::{read_registry, reusable_lease, Agent, Falcon, Hosted, Op, SpawnParams};
// `falcon.rs` imports the shared protocol under a different root per build.
#[cfg(falcon_shell)]
use crate::protocol::CAPABILITY_CODEX_BARE;
#[cfg(not(falcon_shell))]
use super::protocol::{CodexBareSpawn, CAPABILITY_CODEX_BARE, CODEX_BARE_SPAWN_KEY};

/// Views this process still holds (`Falcon::held_views`). Non-empty at
/// frontend boot means a webview reload; `launcher/readopt.ts` moves each onto
/// a new tab through `falcon_adopt` and detaches the rest.
#[cfg(not(falcon_shell))]
#[tauri::command]
pub fn falcon_hosted_held(
    falcon: State<'_, Arc<Falcon>>,
) -> Result<Vec<super::HeldView>, String> {
    falcon.held_views()
}

/// The Falcon session id behind one hosted tab, if any (`Hosted.session`).
/// Vidar-only: the shell build has exactly one tab and never asks this.
#[cfg(not(falcon_shell))]
#[tauri::command]
pub fn falcon_hosted_session(
    falcon: State<'_, Arc<Falcon>>,
    id: String,
) -> Result<Option<String>, String> {
    let hosted = falcon.hosted.lock().map_err(|_| "falcon client poisoned")?;
    Ok(hosted.get(&id).map(|entry| entry.session.clone()))
}

/// Is a Falcon host running and answering? The pipe negotiation can wait out
/// `REQUEST_TIMEOUT`, so it runs on the blocking pool, never the main thread.
/// Never rejects: every failure, a join error included, reads false.
#[tauri::command]
pub async fn falcon_available(falcon: State<'_, Arc<Falcon>>) -> Result<bool, String> {
    let falcon = falcon.inner().clone();
    let probe = tauri::async_runtime::spawn_blocking(move || {
        read_registry(&falcon.paths)
            .map(|r| Connection::open(&r).is_ok())
            .unwrap_or(false)
    });
    Ok(probe.await.unwrap_or(false))
}

/// Async wrapper: the launch path (`ensure_host`, `spawn_blocking` inside
/// `Falcon::control`) can take up to 5s, which must never run on the Tauri
/// main thread (precedent: `falcon_dock_ask_blocking`, above).
#[tauri::command]
pub async fn falcon_spawn(
    app: AppHandle,
    falcon: State<'_, Arc<Falcon>>,
    id: String,
    cwd: String,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: String,
    resume: Option<String>,
    rules_file: Option<String>,
    tab_name: Option<String>,
    gateway: Option<String>,
    profile: Option<String>,
    agent: Option<String>,
    row_key: Option<String>,
) -> Result<Value, String> {
    let falcon = falcon.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        falcon_spawn_blocking(
            app,
            falcon,
            agent,
            id,
            cwd,
            model,
            effort,
            permission_mode,
            resume,
            rules_file,
            tab_name,
            gateway,
            profile,
            row_key,
        )
    })
    .await
    .map_err(|e| format!("spawn task failed: {e}"))?
}

fn falcon_spawn_blocking(
    app: AppHandle,
    falcon: Arc<Falcon>,
    agent: Option<String>,
    id: String,
    cwd: String,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: String,
    resume: Option<String>,
    rules_file: Option<String>,
    tab_name: Option<String>,
    gateway: Option<String>,
    profile: Option<String>,
    row_key: Option<String>,
) -> Result<Value, String> {
    let rules_file = none_if_blank(rules_file);
    let tab_name = none_if_blank(tab_name).map(|n| n.trim().to_string());
    let profile = none_if_blank(profile);
    let gateway = none_if_blank(gateway);
    let row_key = none_if_blank(row_key);
    row_key_shape(row_key.as_deref(), profile.as_deref())?;
    let agent = spawn_agent(agent.as_deref())?;
    // Shape first, so a malformed id never gets as far as preparing a home.
    if let Some(r) = resume.as_deref() {
        if r.len() != 36 || !r.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
            return Err("resume id is not a UUID".into());
        }
    }
    if agent == Agent::Codex {
        // Hosted Codex Bare rides the same opt-in as hosted Codex (Q1): the webview routes it
        // here only with the gate on, and a stale or hand-made call is refused before the host.
        #[cfg(not(falcon_shell))]
        if profile.is_some() && !hosted_codex_gate(crate::config::load().config.falcon.as_ref()) {
            return Err(HOSTED_CODEX_OFF.into());
        }
        // Asked of the host, before any child: a host that runs Codex but not
        // its turns would start a tab that can never take a prompt.
        let capabilities = host_capabilities(&falcon)?;
        if let Some(refusal) = agent_refusal(agent, &capabilities) {
            return Err(refusal);
        }
        // Refused here, before a bare home is prepared for a session the host
        // would refuse anyway (`codex.rs` `spawn_request`, `serve/spawn.rs`).
        let codex_bare = capabilities.iter().any(|c| c == CAPABILITY_CODEX_BARE);
        codex_spawn_shape(rules_file.as_deref(), profile.as_deref(), gateway.as_deref(), codex_bare)?;
    }
    // A profiled (bare) spawn: admitted and its home prepared before the host is
    // asked, so a refusal never starts a child. Vidar-only: `bare` is not compiled into the shell,
    // which has no home to prepare and refuses the spawn instead.
    #[cfg(falcon_shell)]
    if profile.is_some() {
        return Err("the Falcon shell does not start profiled (bare) sessions; open the tab from Vidar".into());
    }
    #[cfg(not(falcon_shell))]
    let mut hosted_launch = match profile.as_deref() {
        // Codex Bare: the row key must name a Codex Bare row, then u1's folder order
        // (`prepare_codex_hosted`): the cwd resolved and refused at or above the user
        // profile before config.toml trusts it. Falcon resolves Codex itself.
        Some(p) if agent == Agent::Codex => {
            crate::bare::admit_rendered(p, Some("codex"), rules_file.as_deref())?;
            let row_key = crate::bare::admit_row_key(row_key.clone(), Some(p), None)?;
            let opts = crate::bare::LaunchOpts { row_key: row_key.as_deref(), ..Default::default() };
            Some(BareLaunch::Codex(crate::bare::prepare_codex_hosted(p, &opts, &cwd)?))
        }
        Some(p) => {
            crate::bare::admit_hosted(p, rules_file.as_deref(), gateway.as_deref())?;
            let opts = crate::bare::LaunchOpts { row_key: row_key.as_deref(), ..Default::default() };
            Some(BareLaunch::Claude(crate::bare::prepare_hosted_for(p, &opts)?))
        }
        None => None,
    };
    if let Some(r) = resume.as_deref() {
        // Exclusivity is decided here, at spawn, not at menu-open: two processes on
        // one session id interleave the transcript.
        // Falcon's own Registry::reserve only refuses a conversation hosted THERE;
        // a raw tab, a second Vidar or an external claude is only seen from here.
        // Vidar-only: `status` (and the `procs` it walks) is not compiled into the
        // shell, which broke `falcon-build.ps1` after 9e0b9a6. The shell never spawns
        // with a resume id (it adopts), so it refuses one instead of skipping the check.
        // That registry is Claude's own; a Codex thread is reserved by the
        // host alone (`Registry::reserve`).
        #[cfg(not(falcon_shell))]
        let live = match agent {
            Agent::Claude => crate::status::session_live_state(r),
            Agent::Codex => crate::status::LiveState::Free,
        };
        #[cfg(not(falcon_shell))]
        match live {
            crate::status::LiveState::Free => {}
            crate::status::LiveState::Live(note) => {
                return Err(format!("session is already {note}"))
            }
            crate::status::LiveState::Unknown(why) => {
                return Err(format!("session state unknown ({why}) — not resuming"))
            }
        }
        #[cfg(falcon_shell)]
        let _ = r;
        #[cfg(falcon_shell)]
        return Err("the Falcon shell adopts sessions; it does not resume by id".into());
    }
    // Control-bus identity proof (`control/policy.rs`). Vidar-only: the shell
    // has no bus surface to prove an identity to, so it spawns without one.
    // Plain hosted Codex gets none: the host builds its env without one
    // (`codex.rs` `spawn_request`), so a minted secret would only linger. Codex Bare
    // gets one: Falcon pushes it as VIDAR_CTL_SECRET beside FALCON_SESSION.
    #[cfg(not(falcon_shell))]
    let ctl_secret = match (agent, profile.is_some()) {
        (Agent::Claude, _) | (Agent::Codex, true) => Some(crate::control::secrets::mint()?),
        (Agent::Codex, false) => None,
    };
    #[cfg(falcon_shell)]
    let ctl_secret: Option<String> = None;
    // A row with sets (or, for Codex, a skills listing): the payload the prepare built under
    // the home's `layer\`.
    #[cfg(not(falcon_shell))]
    let payload_file = hosted_launch
        .as_ref()
        .and_then(BareLaunch::payload_file)
        .map(|p| p.to_string_lossy().into_owned());
    #[cfg(falcon_shell)]
    let payload_file: Option<String> = None;
    // A Claude row's rune-set plugin folders (`bare/set_plugin.rs`), admitted again by the host.
    #[cfg(not(falcon_shell))]
    let set_plugin_dirs: Vec<String> = hosted_launch
        .as_ref()
        .map(BareLaunch::set_plugin_dirs)
        .unwrap_or_default();
    #[cfg(falcon_shell)]
    let set_plugin_dirs: Vec<String> = Vec::new();
    let payload = falcon.control(Op::Spawn(SpawnParams {
        agent: Some(agent),
        cwd,
        permission_mode,
        model,
        effort,
        resume,
        ctl_secret: ctl_secret.clone(),
        rules_file: rules_file.clone(),
        tab_name,
        gateway: gateway.as_ref().map(|g| serde_json::from_value(Value::String(g.clone())))
            .transpose().map_err(|_| "Invalid Claude Gateway Id")?,
        profile: profile.clone(),
        payload_file: payload_file.clone(),
        row_key: row_key.clone(),
        set_plugin_dirs,
    }))?;
    let summary = payload
        .get("session")
        .ok_or("falcon did not return a session")?;
    let session = summary
        .get("session")
        .and_then(Value::as_str)
        .ok_or("falcon session has no id")?
        .to_string();
    // A host older than `rules_file` ignores the field and launches without
    // rules; no echo in the spawn reply's summary means exactly that.
    if let Err(stale) = rules_echo_check(rules_file.as_deref(), summary) {
        end_unhonoured_spawn(&falcon, &session);
        return Err(stale);
    }
    if gateway.is_some() && summary.get("gateway").and_then(Value::as_str) != gateway.as_deref() {
        end_unhonoured_spawn(&falcon, &session);
        return Err("Falcon did not honour gateway routing; rebuild the host before retrying".into());
    }
    // An older host ignores `profile` and starts a default (non-bare) session: no echo, no tab.
    if let Err(stale) = profile_echo_check(profile.as_deref(), summary) {
        let ended = if end_unhonoured_spawn(&falcon, &session) { "the session was ended" } else { "ending the session failed" };
        return Err(format!("{stale} ({ended})"));
    }
    // An older host ignores `payload_file` and launches on the profile's own payload: the row's
    // sets would be missing, so no echo, no tab.
    if let Err(stale) = payload_echo_check(payload_file.as_deref(), summary) {
        let ended = if end_unhonoured_spawn(&falcon, &session) { "the session was ended" } else { "ending the session failed" };
        return Err(format!("{stale} ({ended})"));
    }
    // Codex Bare: what the host ran (`codex_bare` beside `session`) becomes the record's binary
    // and the tab's version/shell warning. A host that ran it without saying what is ended.
    #[cfg(not(falcon_shell))]
    if let Some(BareLaunch::Codex(launch)) = hosted_launch.as_mut() {
        match codex_bare_reply(&payload) {
            Ok(ran) => {
                launch.record_host(&ran.executable, ran.version.as_deref(), ran.pwsh.as_deref());
            }
            Err(stale) => {
                let ended = if end_unhonoured_spawn(&falcon, &session) { "the session was ended" } else { "ending the session failed" };
                return Err(format!("{stale} ({ended})"));
            }
        }
    }
    #[cfg(not(falcon_shell))]
    let bare_warnings = hosted_launch.as_ref().map(BareLaunch::bare_warnings).unwrap_or_default();
    #[cfg(falcon_shell)]
    let bare_warnings: Vec<String> = Vec::new();
    // The launch record, before the lease: names only, from the env Falcon built.
    #[cfg(not(falcon_shell))]
    if let Some(launch) = hosted_launch.as_mut() {
        let names: Vec<&str> = summary
            .get("env_names")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        if let Err(error) = launch.write_manifest(&id, &session, names) {
            let ended = if end_unhonoured_spawn(&falcon, &session) { "the session was ended" } else { "ending the session failed" };
            return Err(format!("{error} ({ended})"));
        }
    }
    // The host has answered: a Codex Bare home's lock (held since its config.toml was written)
    // is free for the next spawn.
    #[cfg(not(falcon_shell))]
    drop(hosted_launch);
    // Keyed by the session id, which Falcon only assigns in the spawn reply,
    // so this lands right after it, before the lease or any prompt. A child
    // that calls the bus earlier, or a failed write, is refused `no requester`
    // (fail closed); the tab itself still works.
    #[cfg(not(falcon_shell))]
    if let Some(secret) = ctl_secret.as_deref() {
        // One retry: a transient lock on the file (rename refused) would
        // otherwise leave the session refused on the bus for its whole life.
        let stored = crate::control::secrets::put(&session, secret)
            .or_else(|_| crate::control::secrets::put(&session, secret));
        if let Err(error) = stored {
            eprintln!("[falcon] ctl secret for {session} not stored: {error}");
        }
    }
    #[cfg(falcon_shell)]
    let _ = ctl_secret;
    // From here a failure must end the session it spawned: otherwise it stays
    // on the host with no owner until something closes it.
    let end_spawned = |error: String| {
        let ended = if end_unhonoured_spawn(&falcon, &session) { "the session was ended" } else { "ending the session failed" };
        format!("{error} ({ended})")
    };
    let host_generation = summary
        .get("generation")
        .and_then(Value::as_u64)
        .ok_or_else(|| end_spawned("falcon session has no generation".into()))?;

    // Take the lease before anything can be sent. A spawned session nobody
    // controls is a session this tab cannot drive, and the failure would not
    // surface until the user's first message. Pending until the insert below,
    // so a concurrent `falcon_list` idle-out cannot drop this lease's pipe.
    let pending = falcon.pending_lease();
    let (acquired, lease_epoch) = falcon
        .control_at(Op::AcquireControl {
            session: session.clone(),
        })
        .map_err(end_spawned)?;
    let lease = parse_lease(acquired).map_err(end_spawned)?;
    let view_generation = falcon.next_view_generation();
    let reader = Arc::new(ReaderControl::new());

    falcon
        .hosted
        .lock()
        .map_err(|_| "falcon client poisoned")?
        .insert(
            id.clone(),
            Hosted {
                session: session.clone(),
                host_generation,
                view_generation,
                lease,
                lease_epoch,
                reader: Arc::clone(&reader),
            },
        );
    drop(pending);

    // The event connection is separate and read-only; it needs no lease, and
    // its reads can block forever without touching the control path.
    if let Err(error) =
        start_event_reader(app, &falcon, id.clone(), session, view_generation, reader)
    {
        let _ = falcon.detach_local(&id, view_generation);
        return Err(error);
    }
    Ok(spawn_reply(view_generation, &bare_warnings))
}

/// The spawn command's reply: the view generation, plus the Bare warnings Raw would print on its
/// spawn line (`bare_warnings`, omitted when empty) for the Rendered tab's notice area.
fn spawn_reply(view_generation: u64, bare_warnings: &[String]) -> Value {
    let mut reply = serde_json::json!({ "view_generation": view_generation });
    if !bare_warnings.is_empty() {
        reply["bare_warnings"] = serde_json::json!(bare_warnings);
    }
    reply
}

/// The spawn's agent: omitted or blank is Claude (every caller before hosted
/// Codex); otherwise the protocol's own lowercase name, anything else refused.
fn spawn_agent(agent: Option<&str>) -> Result<Agent, String> {
    match agent.map(str::trim).filter(|a| !a.is_empty()) {
        None => Ok(Agent::Claude),
        Some(name) => serde_json::from_value(Value::String(name.to_string()))
            .map_err(|_| format!("falcon cannot host a {name:?} session")),
    }
}

/// The agent a listed `SessionSummary` names, when it is one this client
/// knows; an unknown name is left to the host, as before.
fn summary_agent(summary: &Value) -> Option<Agent> {
    let name = summary.get("agent").and_then(Value::as_str)?;
    serde_json::from_value(Value::String(name.to_string())).ok()
}

/// What a hosted Codex spawn cannot carry. Rules-file Codex tabs stay in-process (refresh doc
/// § Design Changes, Out); a launch profile (Codex Bare) needs a host that listed `codex_bare`;
/// gateway routing is Claude's.
fn codex_spawn_shape(
    rules_file: Option<&str>,
    profile: Option<&str>,
    gateway: Option<&str>,
    codex_bare: bool,
) -> Result<(), String> {
    if rules_file.is_some() {
        return Err("a rules file is not supported for hosted Codex sessions".into());
    }
    if profile.is_some() && !codex_bare {
        return Err(format!("a launch profile needs a Falcon host with the '{CAPABILITY_CODEX_BARE}' capability. {STALE_HOST}"));
    }
    if gateway.is_some() {
        return Err("gateway routing requires Claude".into());
    }
    Ok(())
}

/// Shown when a Codex Bare spawn reaches the backend with `falcon.hostedCodex` off.
#[cfg(not(falcon_shell))]
const HOSTED_CODEX_OFF: &str = "Hosted Codex Bare is off: turn falcon.hostedCodex on in vidar.json";

/// The `falcon.hostedCodex` opt-in from vidar.json's `falcon` value, as the webview reads it
/// (`src/launcher/readopt.ts`): on only for `{ "hostedCodex": true }`.
#[cfg(not(falcon_shell))]
fn hosted_codex_gate(falcon: Option<&Value>) -> bool {
    falcon.and_then(|f| f.get("hostedCodex")).and_then(Value::as_bool) == Some(true)
}

/// A Codex Bare spawn reply's `codex_bare` (protocol.rs `CodexBareSpawn`): what the host ran.
/// Missing or malformed means a host that cannot say, so the spawn is not honoured.
#[cfg(not(falcon_shell))]
fn codex_bare_reply(payload: &Value) -> Result<CodexBareSpawn, String> {
    let raw = payload
        .get(CODEX_BARE_SPAWN_KEY)
        .ok_or_else(|| format!("Falcon did not report the Codex it ran. {STALE_HOST}"))?;
    serde_json::from_value(raw.clone()).map_err(|e| format!("Falcon's {CODEX_BARE_SPAWN_KEY} reply is malformed ({e}). {STALE_HOST}"))
}

/// A profiled spawn's prepared home: Claude's (Falcon builds the env, the sidecar maps the
/// profile) or Codex's (config.toml and payload written, the home lock held until dropped).
#[cfg(not(falcon_shell))]
enum BareLaunch {
    Claude(crate::bare::HostedLaunch),
    Codex(crate::bare::CodexHostedLaunch),
}

#[cfg(not(falcon_shell))]
impl BareLaunch {
    fn payload_file(&self) -> Option<&std::path::PathBuf> {
        match self {
            BareLaunch::Claude(l) => l.payload_file.as_ref(),
            BareLaunch::Codex(l) => l.payload_file.as_ref(),
        }
    }

    /// Claude only: Codex Bare carries no plugins.
    fn set_plugin_dirs(&self) -> Vec<String> {
        match self {
            BareLaunch::Claude(l) => l.set_plugin_dirs.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
            BareLaunch::Codex(_) => Vec::new(),
        }
    }

    fn bare_warnings(&self) -> Vec<String> {
        match self {
            BareLaunch::Claude(l) => l.bare_warnings(),
            BareLaunch::Codex(l) => l.bare_warnings(),
        }
    }

    fn write_manifest<'a>(&mut self, tab: &str, falcon_session: &str, env_names: impl IntoIterator<Item = &'a str>) -> Result<std::path::PathBuf, String> {
        match self {
            BareLaunch::Claude(l) => l.write_manifest(tab, falcon_session, env_names),
            BareLaunch::Codex(l) => l.write_manifest(tab, falcon_session, env_names),
        }
    }
}

/// A row key names a profiled row (its rune sets, `bare/layer.rs`); the same refusal as a Raw
/// spawn's (`pty.rs`).
fn row_key_shape(row_key: Option<&str>, profile: Option<&str>) -> Result<(), String> {
    if row_key.is_some() && profile.is_none() {
        return Err("A row key rides only a profiled spawn; spawn refused".into());
    }
    Ok(())
}

/// The connected host's negotiate-reply capabilities. With no control
/// connection yet, one `list` opens it (launching the host on demand, as a
/// spawn would); the pending mark keeps that `list` from idling the
/// connection out before it is read.
fn host_capabilities(falcon: &Falcon) -> Result<Vec<String>, String> {
    let held = |falcon: &Falcon| -> Result<Option<Vec<String>>, String> {
        let control = falcon.control.lock().map_err(|_| "falcon client poisoned")?;
        Ok(control.as_ref().map(|c| c.capabilities.clone()))
    };
    if let Some(capabilities) = held(falcon)? {
        return Ok(capabilities);
    }
    let _pending = falcon.pending_lease();
    falcon.control(Op::List)?;
    held(falcon)?.ok_or_else(|| "falcon control disconnected".to_string())
}

/// An empty or blank `rules_file` means none (as `agent.rs` treats it), never a path to admit.
fn none_if_blank(rules_file: Option<String>) -> Option<String> {
    rules_file.filter(|f| !f.trim().is_empty())
}

/// Shown verbatim to the user when the host dropped a requested `rules_file`.
const STALE_HOST: &str = "Falcon host is out of date: run tools/release/falcon-refresh.ps1 (this ends every hosted session)";

/// The B1 stale-host proof: a spawn that asked for `rules_file` must get it
/// back in the reply's `SessionSummary.rules_file`.
fn rules_echo_check(requested: Option<&str>, summary: &Value) -> Result<(), String> {
    let echoed = summary.get("rules_file").and_then(Value::as_str);
    match (requested, echoed) {
        (Some(_), None) => Err(STALE_HOST.into()),
        _ => Ok(()),
    }
}

/// A profiled spawn must get its profile back in the reply's `SessionSummary.profile`: the host
/// built the session's env from it. Anything else is a default session and is ended.
fn profile_echo_check(requested: Option<&str>, summary: &Value) -> Result<(), String> {
    match requested {
        Some(p) if summary.get("profile").and_then(Value::as_str) != Some(p) => {
            Err(format!("Falcon did not honour the {p:?} profile. {STALE_HOST}"))
        }
        _ => Ok(()),
    }
}

/// A spawn that sent a row's `payload_file` must get it back in the reply's
/// `SessionSummary.payload_file` (the host's admitted canonical path, so presence is the proof).
fn payload_echo_check(requested: Option<&str>, summary: &Value) -> Result<(), String> {
    match (requested, summary.get("payload_file").and_then(Value::as_str)) {
        (Some(_), None) => Err(format!("Falcon did not honour the row's payload. {STALE_HOST}")),
        _ => Ok(()),
    }
}

/// End a session the host spawned without something it was asked for (rules, gateway, profile)
/// or that Vidar could not record. It is nobody's yet, so this takes the lease only to close it;
/// best effort, since the refusal is returned either way. True when the close succeeded.
fn end_unhonoured_spawn(falcon: &Falcon, session: &str) -> bool {
    // Held across acquire + close so a concurrent `falcon_list` idle-out cannot drop the pipe
    // between them (same guard as the normal path in `falcon_spawn`).
    let _pending = falcon.pending_lease();
    let closed = falcon
        .control_at(Op::AcquireControl {
            session: session.to_string(),
        })
        .and_then(|(acquired, _)| parse_lease(acquired))
        .and_then(|lease| {
            falcon
                .control(Op::Close {
                    session: session.to_string(),
                    lease: lease.clone(),
                })
                // Graceful close refused: end the child outright rather than leave it running rule-less.
                .or_else(|_| {
                    falcon.control(Op::Terminate {
                        session: session.to_string(),
                        lease,
                    })
                })
        });
    if let Err(error) = &closed {
        eprintln!("[falcon] unhonoured session {session} not closed: {error}");
    }
    forget_ctl_secret(session);
    closed.is_ok()
}

/// Sessions this host is holding, whether or not Vidar started them.
///
/// This is the whole point of Falcon: after Vidar closes and reopens, the
/// children are still running and still hosted, and this is how they are found
/// again. Returned verbatim as Falcon's own `SessionSummary` so the picker can
/// show cwd, model, conversation and queued prompts without this client
/// deciding what matters.
#[tauri::command]
pub async fn falcon_list(falcon: State<'_, Arc<Falcon>>) -> Result<Value, String> {
    let falcon = falcon.inner().clone();
    tauri::async_runtime::spawn_blocking(move || falcon_list_blocking(&falcon))
        .await
        .map_err(|e| format!("list task failed: {e}"))?
}

#[cfg(falcon_shell)]
fn falcon_list_blocking(falcon: &Falcon) -> Result<Value, String> {
    falcon.control(Op::List)
}

#[cfg(not(falcon_shell))]
fn falcon_list_blocking(falcon: &Falcon) -> Result<Value, String> {
    // The negotiate capabilities live on the control connection, which a
    // lease-free `list` idles out before returning. The pending mark keeps it
    // open until they are read; the idle-out then runs here instead, under the
    // same rule, so the host's idle clock starts exactly as before.
    let pending = falcon.pending_lease();
    let listed = falcon.control(Op::List);
    let capabilities = held_capabilities(falcon);
    drop(pending);
    if let Ok(mut control) = falcon.control.lock() {
        if falcon.control_idle() {
            *control = None;
        }
    }
    let mut result = listed?;
    // Surface a host launched inside Vidar's job as part of the
    // same list call the launcher's Hosted row already awaits.
    let warning = falcon
        .host_warning
        .lock()
        .ok()
        .and_then(|guard| guard.clone());
    with_vidar_fields(&mut result, warning, capabilities);
    Ok(result)
}

/// The cached control connection's negotiate capabilities; None with no connection.
#[cfg(not(falcon_shell))]
fn held_capabilities(falcon: &Falcon) -> Option<Vec<String>> {
    let control = falcon.control.lock().ok()?;
    control.as_ref().map(|c| c.capabilities.clone())
}

/// `falcon_list`'s Vidar-only fields beside the host's `{ sessions }`: `host_warning`, and
/// `capabilities` (null when the connection was gone before they were read), which the
/// frontend checks before a Codex tab picks Falcon (`codex_turns`).
#[cfg(not(falcon_shell))]
fn with_vidar_fields(result: &mut Value, warning: Option<String>, capabilities: Option<Vec<String>>) {
    if let Some(object) = result.as_object_mut() {
        object.insert("host_warning".into(), json!(warning));
        object.insert("capabilities".into(), json!(capabilities));
    }
}

/// Adopt a session that is already running into this tab.
///
/// The reattach path, and deliberately NOT a spawn: the child exists, its
/// conversation is already reserved, and spawning would either be refused by the
/// reservation or start a second agent on one transcript. It takes the lease the
/// same way a fresh spawn does, because a session Vidar is displaying but cannot
/// drive is worse than one it never adopted.
#[tauri::command]
pub async fn falcon_adopt(
    app: AppHandle,
    falcon: State<'_, Arc<Falcon>>,
    id: String,
    session: String,
) -> Result<u64, String> {
    let falcon = falcon.inner().clone();
    tauri::async_runtime::spawn_blocking(move || falcon_adopt_blocking(app, falcon, id, session))
        .await
        .map_err(|e| format!("adopt task failed: {e}"))?
}

fn falcon_adopt_blocking(
    app: AppHandle,
    falcon: Arc<Falcon>,
    id: String,
    session: String,
) -> Result<u64, String> {
    let listed = falcon.control(Op::List)?;
    let summary = listed
        .get("sessions")
        .and_then(Value::as_array)
        .and_then(|sessions| {
            sessions
                .iter()
                .find(|s| s.get("session").and_then(Value::as_str) == Some(session.as_str()))
        })
        .ok_or_else(|| format!("falcon is not hosting {session}"))?;
    if summary.get("exited").and_then(Value::as_i64).is_some() {
        return Err(format!("session {session} has already exited"));
    }
    // A Codex session this host cannot run turns for (an older host spawned it
    // for someone else) is not adopted: the tab could never take a prompt.
    if let Some(agent) = summary_agent(summary) {
        if let Some(refusal) = agent_refusal(agent, &host_capabilities(&falcon)?) {
            return Err(refusal);
        }
    }
    let host_generation = summary
        .get("generation")
        .and_then(Value::as_u64)
        .ok_or("hosted session has no generation")?;

    // A view this process already holds for `session` (a webview reload dropped
    // its tab, not this entry) moves here with its lease: a second
    // `acquire-control` would ask for a lease this connection already holds.
    // Its old reader detached in `take_held`; the reader below re-attaches,
    // so the host's `attached` count ends where it started.
    // Pending from before the held view leaves `hosted` until the insert below:
    // a concurrent `falcon_list` idle-out would otherwise drop the lease.
    let pending = falcon.pending_lease();
    let held = falcon.take_held(&session, &id)?;
    let reused = held.is_some();
    let (lease, lease_epoch) =
        match reusable_lease(held, falcon.control_epoch.load(Ordering::SeqCst)) {
            Some(kept) => kept,
            None => {
                if reused {
                    eprintln!("[falcon] held view of {session} had a stale lease; acquiring");
                }
                let (acquired, epoch) = falcon.control_at(Op::AcquireControl {
                    session: session.clone(),
                })?;
                (parse_lease(acquired)?, epoch)
            }
        };
    let view_generation = falcon.next_view_generation();
    let reader = Arc::new(ReaderControl::new());

    falcon
        .hosted
        .lock()
        .map_err(|_| "falcon client poisoned")?
        .insert(
            id.clone(),
            Hosted {
                session: session.clone(),
                host_generation,
                view_generation,
                lease,
                lease_epoch,
                reader: Arc::clone(&reader),
            },
        );
    drop(pending);
    if let Err(error) =
        start_event_reader(app, &falcon, id.clone(), session, view_generation, reader)
    {
        let _ = falcon.detach_local(&id, view_generation);
        return Err(error);
    }
    Ok(view_generation)
}

/// Async wrapper: `hosted_request` blocks on the shared control pipe for up
/// to `COMMAND_REQUEST_TIMEOUT`, which must never run on the Tauri main
/// thread (precedent: `falcon_spawn`, above).
#[tauri::command]
pub async fn falcon_send(
    falcon: State<'_, Arc<Falcon>>,
    id: String,
    gen: u64,
    line: String,
) -> Result<(), String> {
    let parsed: Value =
        serde_json::from_str(&line).map_err(|error| format!("agent line is not JSON: {error}"))?;
    let falcon = falcon.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        falcon
            .hosted_request(&id, gen, |entry| to_operation(&parsed, entry))
            .map(|_| ())
    })
    .await
    .map_err(|e| format!("send task failed: {e}"))?
}

#[tauri::command]
pub async fn falcon_retract(
    falcon: State<'_, Arc<Falcon>>,
    id: String,
    gen: u64,
    prompt: String,
) -> Result<(), String> {
    let falcon = falcon.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        falcon
            .hosted_request(&id, gen, |entry| Ok(retract_operation(entry, &prompt)))
            .map(|_| ())
    })
    .await
    .map_err(|e| format!("retract task failed: {e}"))?
}

/// Fold a queued prompt into the running turn (the Steer button). Refused
/// locally, nothing sent, when the connected host's negotiate reply did not
/// list `steer` (`hosted_request` checks `ops::capability_refusal`).
#[tauri::command]
pub async fn falcon_steer(
    falcon: State<'_, Arc<Falcon>>,
    id: String,
    gen: u64,
    prompt: String,
) -> Result<(), String> {
    let falcon = falcon.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        falcon
            .hosted_request(&id, gen, |entry| Ok(steer_operation(entry, &prompt)))
            .map(|_| ())
    })
    .await
    .map_err(|e| format!("steer task failed: {e}"))?
}

/// Stop rendering and controlling a hosted session without stopping its child.
/// Async wrapper: `detach_local` waits on the shared control mutex, which a
/// slow send can hold for up to `COMMAND_REQUEST_TIMEOUT`; that wait must not
/// run on the Tauri main thread (same shape as `falcon_send`).
#[tauri::command]
pub async fn falcon_detach(
    falcon: State<'_, Arc<Falcon>>,
    id: String,
    gen: u64,
) -> Result<(), String> {
    let falcon = falcon.inner().clone();
    tauri::async_runtime::spawn_blocking(move || falcon.detach_local(&id, gen))
        .await
        .map_err(|e| format!("detach task failed: {e}"))?
}

/// Drop `session`'s control-bus secret once the session has ended, so its
/// digest does not outlive it in `ctlSecrets`. Called on a kill and on the
/// host's `exit` event (live or replayed); removing an absent entry is a no-op.
/// The shell mints no secrets (see `falcon_spawn_blocking`), so it has none to drop.
pub(super) fn forget_ctl_secret(session: &str) {
    #[cfg(not(falcon_shell))]
    if let Err(error) = crate::control::secrets::remove(session) {
        eprintln!("[falcon] ctl secret for {session} not removed: {error}");
    }
    #[cfg(falcon_shell)]
    let _ = session;
}

#[tauri::command]
pub async fn falcon_kill(
    falcon: State<'_, Arc<Falcon>>,
    id: String,
    gen: u64,
) -> Result<(), String> {
    let falcon = falcon.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let exists = falcon
            .hosted
            .lock()
            .map_err(|_| "falcon client poisoned")?
            .get(&id)
            .is_some_and(|entry| entry.view_generation == gen);
        if !exists {
            return Ok(());
        }
        let mut closed = None;
        falcon.hosted_request(&id, gen, |entry| {
            closed = Some(entry.session.clone());
            Ok(Op::Close {
                session: entry.session.clone(),
                lease: entry.lease.clone(),
            })
        })?;
        if let Some(session) = closed {
            forget_ctl_secret(&session);
        }
        falcon.detach_local(&id, gen)
    })
    .await
    .map_err(|e| format!("kill task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A rules-bearing spawn whose reply summary lacks the echo is a stale
    /// host: refused with the exact refresh line. With the echo, or with no
    /// rules asked for, the spawn stands.
    #[test]
    fn spawn_without_rules_echo_is_refused() {
        let rules = r"C:\v\runtime\rules\built\0123456789ab.md";
        let old_host = serde_json::json!({ "session": "s1", "generation": 1 });
        assert_eq!(
            rules_echo_check(Some(rules), &old_host).unwrap_err(),
            "Falcon host is out of date: run tools/release/falcon-refresh.ps1 (this ends every hosted session)"
        );
        let new_host = serde_json::json!({ "session": "s1", "generation": 1, "rules_file": rules });
        assert!(rules_echo_check(Some(rules), &new_host).is_ok());
        assert!(rules_echo_check(None, &old_host).is_ok());
    }

    /// A profiled spawn whose reply lacks the profile (an older host started a default session)
    /// is refused; the caller ends that session before any lease (`end_unhonoured_spawn`).
    #[test]
    fn spawn_without_profile_echo_is_refused() {
        let old_host = serde_json::json!({ "session": "s1", "generation": 1 });
        let e = profile_echo_check(Some("bare"), &old_host).unwrap_err();
        assert!(e.contains("did not honour") && e.contains("falcon-refresh"), "{e}");
        let wrong = serde_json::json!({ "session": "s1", "generation": 1, "profile": "lean" });
        assert!(profile_echo_check(Some("bare"), &wrong).is_err());
        let new_host = serde_json::json!({ "session": "s1", "generation": 1, "profile": "bare" });
        assert!(profile_echo_check(Some("bare"), &new_host).is_ok());
        assert!(profile_echo_check(None, &old_host).is_ok());
    }

    /// A payload-bearing spawn whose reply lacks the echo (an older host launched on the profile's
    /// own payload, without the row's sets) is refused; the caller ends that session.
    #[test]
    fn spawn_without_payload_echo_is_refused() {
        let payload = r"C:\h\layer\payload-0123456789ab.md";
        let old_host = serde_json::json!({ "session": "s1", "generation": 1, "profile": "bare" });
        let e = payload_echo_check(Some(payload), &old_host).unwrap_err();
        assert!(e.contains("did not honour the row's payload") && e.contains("falcon-refresh"), "{e}");
        let new_host = serde_json::json!({ "session": "s1", "generation": 1, "profile": "bare", "payload_file": payload });
        assert!(payload_echo_check(Some(payload), &new_host).is_ok());
        assert!(payload_echo_check(None, &old_host).is_ok());
    }

    #[test]
    fn spawn_reply_carries_bare_warnings_only_when_there_are_some() {
        let with = spawn_reply(7, &["no guard hooks".to_string(), "git identity".to_string()]);
        assert_eq!(with, serde_json::json!({ "view_generation": 7, "bare_warnings": ["no guard hooks", "git identity"] }));
        let without = spawn_reply(7, &[]);
        assert_eq!(without, serde_json::json!({ "view_generation": 7 }));
        assert!(without.get("bare_warnings").is_none());
    }

    #[test]
    fn spawn_agent_defaults_to_claude_and_names_codex() {
        assert_eq!(spawn_agent(None), Ok(Agent::Claude));
        assert_eq!(spawn_agent(Some(" ")), Ok(Agent::Claude));
        assert_eq!(spawn_agent(Some("claude")), Ok(Agent::Claude));
        assert_eq!(spawn_agent(Some("codex")), Ok(Agent::Codex));
        let e = spawn_agent(Some("gemini")).unwrap_err();
        assert!(e.contains("\"gemini\""), "{e}");
        assert!(spawn_agent(Some("Codex")).is_err(), "the wire name is lowercase");
    }

    #[test]
    fn a_listed_session_names_its_agent() {
        let codex = serde_json::json!({ "session": "s1", "agent": "codex" });
        assert_eq!(summary_agent(&codex), Some(Agent::Codex));
        let claude = serde_json::json!({ "session": "s1", "agent": "claude" });
        assert_eq!(summary_agent(&claude), Some(Agent::Claude));
        assert_eq!(summary_agent(&serde_json::json!({ "agent": "other" })), None);
        assert_eq!(summary_agent(&serde_json::json!({ "session": "s1" })), None);
    }

    /// The spawn op a Codex tab sends carries the agent on the wire.
    #[test]
    fn a_codex_spawn_names_its_agent_on_the_wire() {
        let op = Op::Spawn(SpawnParams {
            agent: Some(spawn_agent(Some("codex")).unwrap()),
            cwd: r"C:\w".into(),
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
            set_plugin_dirs: Vec::new(),
        });
        let wire = serde_json::to_value(&op).unwrap();
        assert_eq!(wire["agent"], "codex", "{wire}");
    }

    /// A row key without a profile names no row Vidar builds; blank counts as none.
    #[test]
    fn a_row_key_without_profile_is_refused() {
        let e = row_key_shape(Some("claude-bare"), None).unwrap_err();
        assert_eq!(e, "A row key rides only a profiled spawn; spawn refused");
        assert!(row_key_shape(Some("claude-bare"), Some("bare")).is_ok());
        assert!(row_key_shape(None, None).is_ok());
        assert_eq!(none_if_blank(Some(" ".into())), None, "a blank key is no key");
    }

    #[test]
    fn hosted_codex_refuses_rules_profile_and_gateway() {
        assert!(codex_spawn_shape(None, None, None, false).is_ok());
        assert!(codex_spawn_shape(Some("r.md"), None, None, false).unwrap_err().contains("rules file"));
        assert!(codex_spawn_shape(None, Some("bare"), None, false).unwrap_err().contains("launch profile"));
        assert!(codex_spawn_shape(None, None, Some("g"), false).unwrap_err().contains("requires Claude"));
    }

    /// `codex_bare` admits a launch profile (Codex Bare) and nothing else: rules and gateway
    /// still refuse, and plain hosted Codex is the same shape with or without it.
    #[test]
    fn codex_spawn_shape_admits_a_profile_only_with_codex_bare() {
        let without = codex_spawn_shape(None, Some("bare"), None, false).unwrap_err();
        assert!(without.contains("'codex_bare' capability") && without.contains("falcon-refresh.ps1"), "{without}");
        assert!(codex_spawn_shape(None, Some("bare"), None, true).is_ok());
        assert!(codex_spawn_shape(None, None, None, true).is_ok());
        assert!(codex_spawn_shape(Some("r.md"), Some("bare"), None, true).unwrap_err().contains("rules file"));
        assert!(codex_spawn_shape(None, Some("bare"), Some("g"), true).unwrap_err().contains("requires Claude"));
    }

    #[cfg(not(falcon_shell))]
    #[test]
    fn the_hosted_codex_gate_is_on_only_for_hosted_codex_true() {
        assert!(hosted_codex_gate(Some(&serde_json::json!({ "hostedCodex": true }))));
        for off in [serde_json::json!({}), serde_json::json!({ "hostedCodex": "true" }), serde_json::json!({ "hostedCodex": false }), serde_json::json!(true)] {
            assert!(!hosted_codex_gate(Some(&off)), "{off}");
        }
        assert!(!hosted_codex_gate(None));
    }

    /// The spawn reply's `codex_bare` as Falcon writes it (serve/dispatch.rs): parsed, optional
    /// fields absent allowed; a reply without it, or a malformed one, is a stale host.
    #[cfg(not(falcon_shell))]
    #[test]
    fn a_codex_bare_spawn_reply_names_what_the_host_ran() {
        let reply = serde_json::json!({
            "session": { "session": "s1", "generation": 1, "profile": "bare" },
            "codex_bare": { "executable": r"C:\npm\codex.exe", "source": "installed", "version": "0.163.0", "pwsh": r"C:\pwsh\pwsh.exe" }
        });
        let ran = codex_bare_reply(&reply).unwrap();
        assert_eq!((ran.executable.as_str(), ran.source.as_str()), (r"C:\npm\codex.exe", "installed"));
        assert_eq!((ran.version.as_deref(), ran.pwsh.as_deref()), (Some("0.163.0"), Some(r"C:\pwsh\pwsh.exe")));
        let bare = codex_bare_reply(&serde_json::json!({ "codex_bare": { "executable": "x", "source": "bundle" } })).unwrap();
        assert_eq!((bare.version, bare.pwsh), (None, None));
        assert!(codex_bare_reply(&serde_json::json!({ "session": {} })).unwrap_err().contains("did not report the Codex"));
        assert!(codex_bare_reply(&serde_json::json!({ "codex_bare": { "source": "bundle" } })).unwrap_err().contains("malformed"));
    }

    /// `falcon_list` keeps the host's payload and adds `host_warning` and `capabilities`
    /// (null when the connection was gone), which a Codex tab checks for `codex_turns`.
    #[cfg(not(falcon_shell))]
    #[test]
    fn falcon_list_adds_warning_and_capabilities() {
        let mut listed = serde_json::json!({ "sessions": [] });
        with_vidar_fields(&mut listed, None, Some(vec!["codex_turns".into()]));
        assert_eq!(
            listed,
            serde_json::json!({ "sessions": [], "host_warning": null, "capabilities": ["codex_turns"] })
        );
        let mut gone = serde_json::json!({ "sessions": [] });
        with_vidar_fields(&mut gone, Some("w".into()), None);
        assert_eq!(gone["capabilities"], Value::Null);
        assert_eq!(gone["host_warning"], "w");
    }

    #[test]
    fn blank_rules_file_is_none() {
        assert_eq!(none_if_blank(Some(String::new())), None);
        assert_eq!(none_if_blank(Some("  ".into())), None);
        assert_eq!(none_if_blank(None), None);
        assert_eq!(none_if_blank(Some("a.md".into())), Some("a.md".into()));
    }
}
