//! The Claude driver: the bundled runtime, the sidecar command line, and the
//! per-session state that makes a command outcome mean something.
//!
//! Envelopes here are deliberately Claude-specific. Codex gets its own driver
//! in a later plan, and protocol v1 must not grow a general agent abstraction
//! to accommodate an agent nobody has written yet.
//!
//! Why command ids exist: writing bytes to a child's stdin proves nothing about
//! whether the CLI accepted them. The sidecar's `--falcon` mode echoes a
//! terminal outcome per command id, so Falcon can answer `applied` or `failed`
//! honestly — and answer [`Outcome::DeliveryUnknown`] when it cannot tell,
//! rather than retrying a write that may already have produced a turn.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{sync_channel, Receiver, SyncSender},
        Arc, Mutex, MutexGuard,
    },
};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    process::{find_on_path, Child, WriteStatus},
    protocol::{Outcome, SpawnParams},
    session::driver_props::{sha256_file, Observed, PermissionState, COMMAND_TIMEOUT},
};

mod spawn_args;

/// The immutable runtime a bundle pins: the sidecar script, its staged SDK, and
/// the content-addressed `claude.exe`. None of it may resolve into the checkout.
#[derive(Debug, Clone)]
pub struct ClaudeRuntime {
    pub node: PathBuf,
    pub sidecar: PathBuf,
    pub claude_exe: PathBuf,
    /// `<vidar root>\runtime\rules\built`, the only place a `rules_file` may
    /// live. The root comes from the host's own `--registry` (`main.rs`),
    /// never from a client; `None` refuses every `rules_file`.
    pub rules_built: Option<PathBuf>,
    /// Absolute `pwsh.exe`, resolved once from Falcon's own PATH (like `node`)
    /// so a gateway sidecar never looks it up from the session folder. `None`
    /// refuses every gateway spawn and nothing else.
    pub pwsh: Option<PathBuf>,
}

/// Under the Vidar root; `contracts/paths.json` id `rules` plus `built`.
pub const RULES_BUILT: &str = r"runtime\rules\built";

/// Launch profiles a hosted Claude spawn may carry (twin: `src-tauri/src/bare/mod.rs` `PROFILES`).
pub const PROFILES: &[&str] = &["bare"];

/// What a profiled spawn adds: the home it runs in and the env laid over the allowlist base.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BareSpawn {
    pub home: PathBuf,
    pub env: Vec<(String, String)>,
}

/// A profiled spawn's home and env from `<root>\profiles\<profile>\claude.json`: the home is
/// Vidar's own placement (`bare_home::resolve_for`, the same code `bare/home.rs` uses), the env
/// the profile's `overlay` then its `rendered.overlay`, `{{root}}`/`{{home}}` filled, plus
/// `HOMEDRIVE`/`HOMEPATH` from its `USERPROFILE`. Refuses a profile that lacks the rendered block
/// or an isolation switch, and a home Vidar has not prepared (no `claude-config` folder): the
/// CLI would otherwise create it with an inherited ACL. A per-spawn `config_dir`
/// (`SpawnParams.claude_config_dir`) is admitted by [`admit_claude_config`] after the overlay's
/// own dir passed, and replaces `CLAUDE_CONFIG_DIR` and `VIDAR_AGENT_HOME`; None keeps the overlay.
pub fn bare_spawn(root: &Path, local_app_data: Option<&Path>, profile: &str, config_dir: Option<&str>) -> Result<BareSpawn, String> {
    let lad = local_app_data
        .filter(|p| p.is_absolute())
        .ok_or("LOCALAPPDATA is unset or not absolute; the bare home cannot be placed")?;
    let home = crate::bare_home::resolve_for(root, lad);
    let path = root.join("profiles").join(profile).join("claude.json");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("launch profile {}: {e}", path.display()))?;
    let doc: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("launch profile {}: {e}", path.display()))?;
    if doc.get("id").and_then(Value::as_str) != Some(profile) || doc.get("agent").and_then(Value::as_str) != Some("claude") {
        return Err(format!("launch profile {} is not the Claude {profile:?} profile", path.display()));
    }
    let rendered = doc
        .get("rendered")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("launch profile {profile:?} has no rendered block"))?;
    let (root_s, home_s) = (root.to_string_lossy().into_owned(), home.to_string_lossy().into_owned());
    let fill = |s: &str| s.replace("{{root}}", &root_s).replace("{{home}}", &home_s);
    let mut env: Vec<(String, String)> = Vec::new();
    for (index, layer) in [doc.get("overlay"), rendered.get("overlay")].into_iter().enumerate() {
        let Some(map) = layer.and_then(Value::as_object) else { continue };
        for (k, v) in map {
            // The home is Vidar's placement: the rendered layer may not move it.
            if index == 1 && ["CLAUDE_CONFIG_DIR", "USERPROFILE"].iter().any(|n| k.eq_ignore_ascii_case(n)) {
                return Err(format!("launch profile {profile:?} rendered.overlay may not set {}", k.to_uppercase()));
            }
            let v = v.as_str().ok_or_else(|| format!("launch profile {profile:?}: overlay {k} is not a string"))?;
            env.retain(|(name, _)| !name.eq_ignore_ascii_case(k));
            env.push((k.clone(), fill(v)));
        }
    }
    let get = |name: &str| env.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
    if get("CLAUDE_CODE_DISABLE_CLAUDE_MDS").as_deref() != Some("1") {
        return Err(format!("launch profile {profile:?} lacks CLAUDE_CODE_DISABLE_CLAUDE_MDS=1; spawn refused"));
    }
    let config = get("CLAUDE_CONFIG_DIR").map(PathBuf::from).filter(|p| p.is_absolute())
        .ok_or_else(|| format!("launch profile {profile:?} sets no absolute CLAUDE_CONFIG_DIR; spawn refused"))?;
    let parts = |p: &Path| -> Vec<String> {
        p.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect()
    };
    let (config_parts, home_parts) = (parts(&config), parts(&home));
    if config_parts.len() <= home_parts.len()
        || config_parts[..home_parts.len()] != home_parts[..]
        || config_parts.iter().any(|c| c == "..")
    {
        return Err(format!("launch profile {profile:?} sets CLAUDE_CONFIG_DIR outside the bare home; spawn refused"));
    }
    if !config.is_dir() {
        return Err(format!("bare home {} is not prepared; spawn refused", config.display()));
    }
    if let Some((drive, path)) = get("USERPROFILE").as_deref().and_then(crate::bare_env::split_home) {
        env.push(("HOMEDRIVE".into(), drive));
        env.push(("HOMEPATH".into(), path));
    }
    if let Some(raw) = config_dir {
        let admitted = admit_claude_config(raw, &home, &config)?.to_string_lossy().into_owned();
        for (k, v) in env.iter_mut() {
            if ["CLAUDE_CONFIG_DIR", "VIDAR_AGENT_HOME"].iter().any(|n| k.eq_ignore_ascii_case(n)) {
                *v = admitted.clone();
            }
        }
    }
    Ok(BareSpawn { home, env })
}

/// The folder under the bare home that holds one Claude config dir per set combination (Vidar's
/// `bare/agent_homes.rs`).
pub const CLAUDE_HOMES_DIR: &str = "claude-homes";

/// Admit a client-named Claude config dir: no leading `-`, absolute, no `..`, under the bare home
/// by path prefix (the overlay's rule) and an existing folder, then either the overlay's own dir
/// (`overlay`) or exactly `<home>\claude-homes\<12 lowercase hex>`, as sent and again on the
/// canonical folder, so a junction redirecting `claude-homes` or the combination folder is refused.
/// Returns the folder as sent (a combination folder's canonical twin checked equal).
pub fn admit_claude_config(raw: &str, home: &Path, overlay: &Path) -> Result<PathBuf, String> {
    const OUTSIDE: &str = "Claude config dir is not the profile's own or a combination folder under the bare home's claude-homes directory; spawn refused";
    if raw.starts_with('-') {
        return Err("Claude config dir starts with '-'; spawn refused".into());
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("Claude config dir is not an absolute path; spawn refused".into());
    }
    let parts = |p: &Path| -> Vec<String> {
        p.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect()
    };
    let (dir_parts, home_parts) = (parts(&path), parts(home));
    if dir_parts.len() <= home_parts.len() || dir_parts[..home_parts.len()] != home_parts[..] || dir_parts.iter().any(|c| c == "..") {
        return Err("Claude config dir is outside the bare home; spawn refused".into());
    }
    if !path.is_dir() {
        return Err(format!("Claude config dir {raw} does not exist; spawn refused"));
    }
    if dir_parts == parts(overlay) {
        return Ok(path);
    }
    let is_hash12 = |s: &str| s.len() == 12 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    let name = match &dir_parts[home_parts.len()..] {
        [dir, name] if dir == CLAUDE_HOMES_DIR && is_hash12(path.file_name().and_then(|n| n.to_str()).unwrap_or_default()) => name.clone(),
        _ => return Err(OUTSIDE.into()),
    };
    let canon = |p: &Path| std::fs::canonicalize(p).map(|c| parts(&crate::process::plain_path(&c)));
    let fail = |e: std::io::Error| format!("Claude config dir {raw} unavailable: {e}; spawn refused");
    let (home_c, homes_c, dir_c) = (canon(home).map_err(fail)?, canon(&home.join(CLAUDE_HOMES_DIR)).map_err(fail)?, canon(&path).map_err(fail)?);
    let mut want = home_c;
    want.push(CLAUDE_HOMES_DIR.into());
    if homes_c != want {
        return Err(format!("{OUTSIDE} (the {CLAUDE_HOMES_DIR} directory is redirected)"));
    }
    want.push(name);
    if dir_c != want {
        return Err(format!("{OUTSIDE} (the combination folder is redirected)"));
    }
    Ok(path)
}

#[derive(Debug, Deserialize)]
struct RuntimeManifest {
    /// Absent in a bundle built without Claude (a codex-only bundle).
    #[serde(default)]
    claude: Option<ClaudeManifest>,
}

#[derive(Debug, Deserialize)]
struct ClaudeManifest {
    /// Bundle-relative path to the frozen sidecar script.
    sidecar: String,
    /// Bundle-relative path to the staged SDK entrypoint.
    sdk: String,
    /// SHA-256 of the `claude.exe` this bundle was built against.
    exe_sha256: String,
    /// The store entry's plain filename. Required: no built-in default.
    #[serde(default)]
    store_exe: Option<String>,
    /// How to find the user's own install. Required: no built-in default.
    #[serde(default)]
    installed: Option<InstalledManifest>,
}

#[derive(Debug, Deserialize)]
struct InstalledManifest {
    #[serde(default)]
    names: Option<Vec<String>>,
    #[serde(default)]
    candidates: Option<Vec<String>>,
}

/// Validated lookup data from the manifest. No built-in defaults: this binary carries no Claude
/// executable name, so a `claude` block must name every piece itself.
#[derive(Debug, PartialEq, Eq)]
struct ClaudeLookup {
    store_exe: String,
    names: Vec<String>,
    candidates: Vec<String>,
}

fn is_exe_filename(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['/', '\\', ':'])
        && !name.contains("..")
        && name.to_ascii_lowercase().ends_with(".exe")
}

impl ClaudeLookup {
    fn from_manifest(manifest: &ClaudeManifest) -> Result<Self, String> {
        let store_exe = match &manifest.store_exe {
            Some(name) if is_exe_filename(name) => name.clone(),
            Some(name) => {
                return Err(format!("manifest store exe must be a plain .exe filename: {name}"))
            }
            None => return Err("manifest names no store exe".into()),
        };
        let Some(installed) = manifest.installed.as_ref() else {
            return Err("manifest names no installed-CLI lookup".into());
        };
        let Some(names) = installed.names.clone() else {
            return Err("manifest installed names is missing".into());
        };
        if names.is_empty() {
            return Err("manifest installed names is empty".into());
        }
        if let Some(bad) = names.iter().find(|name| !is_exe_filename(name)) {
            return Err(format!("manifest installed name must be a plain .exe filename: {bad}"));
        }
        let Some(candidates) = installed.candidates.clone() else {
            return Err("manifest installed candidates is missing".into());
        };
        if let Some(bad) = candidates
            .iter()
            .find(|c| c.contains("..") || !c.to_ascii_lowercase().ends_with(".exe"))
        {
            return Err(format!("manifest installed candidate must be a .exe path: {bad}"));
        }
        Ok(Self { store_exe, names, candidates })
    }
}

impl ClaudeRuntime {
    /// Resolve and verify the bundle's Claude runtime.
    ///
    /// The executable lives in a content-addressed store shared by every
    /// bundle, so N bundles cost one 222 MB copy; the manifest names it by
    /// hash and this verifies that hash before anything is spawned. A CLI
    /// update produces a new hash and therefore a new bundle, instead of
    /// mutating what a running host already resolved.
    ///
    /// The user's own installed `claude.exe` comes first, on dev machines and
    /// release zips alike, so a CLI self-update reaches new tabs without a
    /// host rebuild. A release zip ships no store (redistributing the binary
    /// is not ours to do); the pinned entry is only the fallback when no
    /// installed `claude.exe` is found; see [`choose_claude_exe`]. Nothing is
    /// ever downloaded.
    pub fn resolve(bundle: &Path, store: &Path) -> Result<Self, String> {
        Self::resolve_with(bundle, store, installed_claude_exe)
    }

    /// The only root a client's `rules_file` is admitted under: the Vidar folder this host's
    /// own `--registry` names, never a client value.
    pub fn bind_root(&mut self, vidar_root: &Path) {
        self.rules_built = Some(vidar_root.join(RULES_BUILT));
    }

    fn resolve_with(
        bundle: &Path,
        store: &Path,
        installed: impl FnOnce(&[String], &[String]) -> Result<PathBuf, String>,
    ) -> Result<Self, String> {
        let manifest_path = bundle.join("runtime-manifest.json");
        let text = std::fs::read_to_string(&manifest_path)
            .map_err(|error| format!("read {}: {error}", manifest_path.display()))?;
        let manifest: RuntimeManifest = serde_json::from_str(&text)
            .map_err(|error| format!("parse {}: {error}", manifest_path.display()))?;

        let Some(claude) = manifest.claude.as_ref() else {
            return Err("claude is not in this bundle".into());
        };
        let lookup = ClaudeLookup::from_manifest(claude)?;

        let sidecar = bundle.join(&claude.sidecar);
        if !sidecar.is_file() {
            return Err(format!("bundle sidecar missing: {}", sidecar.display()));
        }
        let sdk = bundle.join(&claude.sdk);
        if !sdk.is_file() {
            return Err(format!("bundle SDK missing: {}", sdk.display()));
        }

        let (claude_exe, source) = choose_claude_exe(
            installed(&lookup.names, &lookup.candidates),
            || pinned_claude_exe(store, &claude.exe_sha256, &lookup.store_exe),
        )?;
        eprintln!(
            "falcon: the Claude CLI from {}: {}",
            source.label(),
            claude_exe.display()
        );

        // Hand the child ordinary paths. A `\\?\` prefix inherited from a
        // canonicalized bundle directory is accepted by Win32 but not by node,
        // which dies resolving its own main script (see `plain_path`).
        Ok(Self {
            node: find_on_path("node")?,
            sidecar: crate::process::plain_path(&sidecar),
            claude_exe: crate::process::plain_path(&claude_exe),
            rules_built: None,
            pwsh: find_on_path("pwsh.exe").ok(),
        })
    }
}

#[derive(Default)]
pub struct ClaudeDriver {
    model: Mutex<Option<String>>,
    permission_mode: Mutex<String>,
    next_command: AtomicU64,
    waiting: Mutex<HashMap<u64, Waiting>>,
    permissions: Mutex<HashMap<String, PermissionState>>,
    /// Task ids the CLI started (`system/task_started`) and has not yet ended
    /// (`system/task_notification`, a terminal `task_updated`, or absence from
    /// a `background_tasks_changed` snapshot). Ambient tasks are never added:
    /// the SDK marks live-update watchers and housekeeping `ambient`, "not
    /// activity", and one can outlive every real task.
    open_tasks: Mutex<HashSet<String>>,
}

#[derive(Debug, Clone)]
struct CommandResult {
    outcome: Outcome,
    message: Option<String>,
}

/// One in-flight command. `delivered` flips once its bytes are in the child's
/// stdin, which is what decides whether an abandoned command is a definite
/// failure or an honest unknown.
struct Waiting {
    sender: SyncSender<CommandResult>,
    delivered: Arc<AtomicBool>,
}

impl ClaudeDriver {
    pub fn new(params: &SpawnParams) -> Self {
        Self {
            model: Mutex::new(params.model.clone()),
            permission_mode: Mutex::new(params.permission_mode.clone()),
            next_command: AtomicU64::new(1),
            waiting: Mutex::new(HashMap::new()),
            permissions: Mutex::new(HashMap::new()),
            open_tasks: Mutex::new(HashSet::new()),
        }
    }

    /// How many non-ambient tasks (background subagents, background Bash,
    /// workflows) the CLI has started and not yet reported ended. A turn's
    /// `result` does not end them, and their completion can wake a new turn
    /// that never went through Falcon's prompt queue.
    pub fn open_tasks(&self) -> usize {
        lock(&self.open_tasks).len()
    }

    /// Task bookkeeping from the SDK's typed system messages (sdk.d.ts
    /// `SDKTaskStartedMessage`, `SDKTaskNotificationMessage`,
    /// `SDKTaskUpdatedMessage`, `SDKBackgroundTasksChangedMessage`), which the
    /// sidecar forwards unchanged.
    fn observe_task(&self, message: &Value, subtype: &str) {
        let id = message.get("task_id").and_then(Value::as_str);
        let ambient = |value: &Value| value.get("ambient").and_then(Value::as_bool) == Some(true);
        match subtype {
            "task_started" => {
                if let Some(id) = id.filter(|_| !ambient(message)) {
                    lock(&self.open_tasks).insert(id.to_string());
                }
            }
            "task_notification" => {
                if let Some(id) = id {
                    lock(&self.open_tasks).remove(id);
                }
            }
            "task_updated" => {
                let status = message
                    .get("patch")
                    .and_then(|patch| patch.get("status"))
                    .and_then(Value::as_str);
                if let (Some(id), Some("completed" | "failed" | "killed")) = (id, status) {
                    lock(&self.open_tasks).remove(id);
                }
            }
            // REPLACE semantics per the SDK. It lists background tasks only, so
            // it can drop a foreground one early; that is harmless, because a
            // foreground task blocks its turn and the turn is in flight.
            "background_tasks_changed" => {
                if let Some(tasks) = message.get("tasks").and_then(Value::as_array) {
                    *lock(&self.open_tasks) = tasks
                        .iter()
                        .filter(|task| !ambient(task))
                        .filter_map(|task| task.get("task_id").and_then(Value::as_str))
                        .map(str::to_string)
                        .collect();
                }
            }
            _ => {}
        }
    }

    pub fn model(&self) -> Option<String> {
        lock(&self.model).clone()
    }

    pub fn permission_mode(&self) -> String {
        lock(&self.permission_mode).clone()
    }

    /// Permissions that still need a decision — `Opened` only. `Responded`
    /// and `Returned` have moved (an answer is in flight or delivered) even
    /// though neither is terminal; this list is "needs a decision", not
    /// "not yet settled" (`protocol.rs:339-342`).
    pub fn pending_permissions(&self) -> Vec<String> {
        lock(&self.permissions)
            .iter()
            .filter(|(_, state)| matches!(state, PermissionState::Opened))
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Whether `id` is a permission this driver has seen and still considers
    /// freshly opened — the unattended watcher's cue that nothing has moved
    /// it (an answer, a settle, or a cancel) since it was raised. An unknown
    /// id is not opened.
    pub fn is_opened(&self, id: &str) -> bool {
        matches!(
            lock(&self.permissions).get(id),
            Some(PermissionState::Opened)
        )
    }

    /// Every permission this session has seen and where it stands, for the
    /// journal and for anything that has to report more than "pending".
    pub fn permission_states(&self) -> Vec<(String, PermissionState)> {
        let mut states: Vec<(String, PermissionState)> = lock(&self.permissions)
            .iter()
            .map(|(id, state)| (id.clone(), *state))
            .collect();
        states.sort_by(|a, b| a.0.cmp(&b.0));
        states
    }

    /// Write one command and wait for its terminal outcome.
    ///
    /// A write failure is `Failed`: nothing was accepted. A write that
    /// succeeded but produced no outcome inside the timeout is
    /// `DeliveryUnknown` — the bytes are in the pipe and may have been acted
    /// on, so the honest answer is that Falcon cannot tell. It never retries.
    /// Reserve the session-wide command id this driver will use next.
    ///
    /// Exposed so the caller can journal an acceptance under the SAME identity
    /// the dispatch will carry. A client's request id is per-connection and
    /// restarts at 1, so keying durable records on it lets two clients — or one
    /// client across a reconnect — overwrite each other's acceptance and
    /// outcome. There is exactly one command identity, and it is this one.
    pub fn reserve_command(&self) -> u64 {
        self.next_command.fetch_add(1, Ordering::SeqCst)
    }

    /// The sidecar line that starts a turn with a queued prompt.
    pub fn prompt_line(content: &serde_json::Value) -> serde_json::Value {
        crate::session::user_line(content)
    }

    /// The sidecar line that folds a prompt into the running turn: the same
    /// `user` line with priority `next`, which the CLI takes in at its next
    /// tool boundary without interrupting the turn (`now` would abort it).
    /// The sidecar pushes every `user` line as `next` anyway; the field here
    /// states the intent on the wire and in any dump.
    pub fn steer_line(content: &serde_json::Value) -> serde_json::Value {
        let mut line = crate::session::user_line(content);
        line["priority"] = serde_json::Value::from("next");
        line
    }

    // A `command()` convenience that reserved its own id used to live here. It
    // was removed rather than left unused: dispatching under an id the caller
    // never saw means the command cannot be journalled under the identity it
    // ran with, which is exactly the defect `reserve_command` exists to fix. A
    // serving path must reserve first, journal the acceptance, then dispatch
    // with `command_as`. Leaving a shortcut that skips the journal is an
    // invitation to silently reintroduce it.

    /// [`ClaudeDriver::command`] using an id already reserved by the caller.
    pub fn command_as(
        &self,
        cid: u64,
        child: &Child,
        mut message: Value,
    ) -> (Outcome, Option<String>) {
        let (receiver, delivered) = self.register(cid);
        if let Some(object) = message.as_object_mut() {
            object.insert("cid".into(), json!(cid));
        }
        let line = match serde_json::to_string(&message) {
            Ok(line) => line,
            Err(error) => {
                self.forget(cid);
                return (Outcome::Failed, Some(error.to_string()));
            }
        };
        // Mark delivered BEFORE the write, not after. The child's exit can call
        // `abandon` at any moment, and in the window between `write_line`
        // returning and this flag being set it would see a command that really
        // did reach the child and settle it as `Failed` — inviting exactly the
        // retry this flag exists to prevent. Setting it early is safe because
        // every non-`Written` status below overrides it explicitly.
        delivered.store(true, Ordering::SeqCst);
        match child.write_line_status(&line) {
            WriteStatus::Written => {}
            // Nothing was written and nothing will be, so a retry is safe.
            WriteStatus::NotWritten(why) => {
                self.forget(cid);
                return (Outcome::Failed, Some(why));
            }
            // Bytes may be in the pipe and the child may have acted on them.
            WriteStatus::PossiblyDelivered(why) => {
                self.forget(cid);
                return (Outcome::DeliveryUnknown, Some(why));
            }
        }
        match receiver.recv_timeout(COMMAND_TIMEOUT) {
            Ok(result) => (result.outcome, result.message),
            Err(_) => {
                self.forget(cid);
                (
                    Outcome::DeliveryUnknown,
                    Some(format!(
                        "no outcome for command {cid} within {}s",
                        COMMAND_TIMEOUT.as_secs()
                    )),
                )
            }
        }
    }

    fn register(&self, cid: u64) -> (Receiver<CommandResult>, Arc<AtomicBool>) {
        let (sender, receiver) = sync_channel(1);
        let delivered = Arc::new(AtomicBool::new(false));
        lock(&self.waiting).insert(
            cid,
            Waiting {
                sender,
                delivered: Arc::clone(&delivered),
            },
        );
        (receiver, delivered)
    }

    fn forget(&self, cid: u64) {
        lock(&self.waiting).remove(&cid);
    }

    /// Inspect one sidecar stdout line, updating driver state.
    ///
    /// Returns the conversation id when the CLI first reports one, so the
    /// registry can claim the reservation for a conversation Falcon itself
    /// started.
    pub fn observe(&self, message: &Value) -> (Observed, Option<String>) {
        let kind = message.get("type").and_then(Value::as_str).unwrap_or("");
        let subtype = message.get("subtype").and_then(Value::as_str).unwrap_or("");

        if kind == "falcon" {
            self.observe_falcon(message, subtype);
            return (Observed::Consumed, None);
        }
        if kind == "permission_request" {
            if let Some(id) = message.get("id").and_then(Value::as_str) {
                lock(&self.permissions).insert(id.to_string(), PermissionState::Opened);
            }
            return (Observed::Forward, None);
        }
        if kind == "sidecar" && subtype == "ready" {
            if let Some(model) = message.get("model").and_then(Value::as_str) {
                *lock(&self.model) = Some(model.to_string());
            }
            return (Observed::Forward, None);
        }
        if kind == "system" && subtype == "init" {
            // `session_id` on the init message is the CLI's own conversation id,
            // and the first point a fresh conversation has one.
            let conversation = message
                .get("session_id")
                .and_then(Value::as_str)
                .filter(|id| crate::protocol::valid_conversation_id(id))
                .map(str::to_string);
            if let Some(model) = message.get("model").and_then(Value::as_str) {
                *lock(&self.model) = Some(model.to_string());
            }
            return (Observed::Forward, conversation);
        }
        if kind == "system" {
            self.observe_task(message, subtype);
        }
        (Observed::Forward, None)
    }

    fn observe_falcon(&self, message: &Value, subtype: &str) {
        match subtype {
            "outcome" => {
                let Some(cid) = message.get("cid").and_then(Value::as_u64) else {
                    return;
                };
                let applied = message.get("state").and_then(Value::as_str) == Some("applied");
                let text = message
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                // Commit the label only once the CLI has confirmed the change.
                if applied {
                    if let Some(mode) = message.get("mode").and_then(Value::as_str) {
                        *lock(&self.permission_mode) = mode.to_string();
                    }
                    if let Some(model) = message.get("model").and_then(Value::as_str) {
                        *lock(&self.model) = Some(model.to_string());
                    }
                }
                if let Some(waiting) = lock(&self.waiting).remove(&cid) {
                    let _ = waiting.sender.try_send(CommandResult {
                        outcome: if applied {
                            Outcome::Applied
                        } else {
                            Outcome::Failed
                        },
                        message: text,
                    });
                }
            }
            "permission" => {
                let Some(id) = message.get("id").and_then(Value::as_str) else {
                    return;
                };
                let state = match message.get("state").and_then(Value::as_str) {
                    Some("opened") => PermissionState::Opened,
                    Some("responded") => PermissionState::Responded,
                    // The callback returned. Not terminal: the sidecar cannot
                    // see whether the SDK delivered the answer, so the request
                    // stays pending until the agent shows it consumed it.
                    Some("returned") => PermissionState::Returned,
                    Some("settled") => PermissionState::Settled,
                    Some("cancelled") => PermissionState::Cancelled,
                    // A failed response leaves the request pending on purpose.
                    Some("failed") => PermissionState::Opened,
                    // An unknown state is not a licence to guess at a terminal
                    // one; the request keeps whatever it had.
                    _ => return,
                };
                // A terminal state is never walked back by a later record.
                let mut permissions = lock(&self.permissions);
                if permissions
                    .get(id)
                    .is_some_and(|current| current.is_terminal())
                {
                    return;
                }
                permissions.insert(id.to_string(), state);
            }
            _ => {}
        }
    }

    /// Settle every in-flight command AND every outstanding permission. Called
    /// when the child exits, so a caller blocked on an outcome gets an answer
    /// instead of the full timeout, and a permission nobody can ever answer
    /// stops being reported as pending.
    ///
    /// A command whose bytes already reached the child settles as
    /// [`Outcome::DeliveryUnknown`], never `Failed`. The child may well have
    /// acted on it before dying, and `Failed` is an invitation to retry — which
    /// the IPC contract forbids precisely because it could duplicate a turn.
    /// Only a command abandoned before delivery is a definite failure.
    ///
    /// Permissions get the same honesty: an outstanding one becomes
    /// [`PermissionState::CancelledByExit`], never `Settled`. The exit is what
    /// ended it, and the record has to say so — the request may well have been
    /// answered by a user whose answer the dead CLI never acted on. Returns the
    /// ids it cancelled, in id order, so the caller can journal them.
    pub fn abandon(&self, why: &str) -> Vec<String> {
        for (_, waiting) in lock(&self.waiting).drain() {
            let outcome = if waiting.delivered.load(Ordering::SeqCst) {
                Outcome::DeliveryUnknown
            } else {
                Outcome::Failed
            };
            let _ = waiting.sender.try_send(CommandResult {
                outcome,
                message: Some(why.to_string()),
            });
        }
        let mut cancelled = Vec::new();
        for (id, state) in lock(&self.permissions).iter_mut() {
            if !state.is_terminal() {
                *state = PermissionState::CancelledByExit;
                cancelled.push(id.clone());
            }
        }
        cancelled.sort();
        cancelled
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

/// Where the `claude.exe` a host spawns came from; logged at startup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeSource {
    /// The bundle's hash-verified entry in `store\claude\<sha256>\`.
    PinnedStore,
    /// The user's own install (PATH, then the installer's default location).
    Installed,
}

impl ClaudeSource {
    pub fn label(self) -> &'static str {
        match self {
            Self::PinnedStore => "pinned store",
            Self::Installed => "installed claude",
        }
    }
}

/// The pinned store entry, only if present and its bytes match the pin.
fn pinned_claude_exe(store: &Path, exe_sha256: &str, store_exe: &str) -> Result<PathBuf, String> {
    let expected = exe_sha256.to_ascii_lowercase();
    let claude_exe = store.join("claude").join(&expected).join(store_exe);
    if !claude_exe.is_file() {
        return Err(format!(
            "content-addressed Claude CLI missing: {}",
            claude_exe.display()
        ));
    }
    let actual = sha256_file(&claude_exe)?;
    if actual != expected {
        return Err(format!(
            "Claude CLI hash {actual} does not match the bundle's {expected}"
        ));
    }
    Ok(claude_exe)
}

/// The user's installed `claude.exe`, looked up the way the Dependencies probe
/// does for `claude` (`contracts/dependencies.json`): PATH first, then the
/// native installer's `%USERPROFILE%\.local\bin\claude.exe`. Only `.exe`: the
/// SDK spawns the path directly, so a `claude.cmd`/`.ps1` shim is no use here.
fn installed_claude_exe(names: &[String], candidates: &[String]) -> Result<PathBuf, String> {
    for name in names {
        if let Ok(found) = find_on_path(name) {
            return Ok(found);
        }
    }
    for candidate in candidates {
        if let Some(path) = expand_env(candidate) {
            if path.is_file() {
                return Ok(path);
            }
        }
    }
    Err(format!(
        "{} not on PATH and not at {}",
        names.join("/"),
        candidates.join(", ")
    ))
}

/// Expand `%VAR%` segments from the environment; `None` if one is unset.
fn expand_env(template: &str) -> Option<PathBuf> {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = after.find('%')?;
        out.push_str(&std::env::var(&after[..end]).ok()?);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Some(PathBuf::from(out))
}

/// Resolution order: the installed CLI if found, else the pinned store entry
/// if present and hash-valid, else an error naming both places that were
/// looked at. `pinned` is only evaluated when no installed CLI is found, so
/// the store entry is not hashed on a machine that has the CLI installed.
fn choose_claude_exe(
    installed: Result<PathBuf, String>,
    pinned: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<(PathBuf, ClaudeSource), String> {
    let installed_error = match installed {
        Ok(path) => return Ok((path, ClaudeSource::Installed)),
        Err(error) => error,
    };
    match pinned() {
        Ok(path) => {
            eprintln!("falcon: no installed Claude CLI found; using the pinned store");
            Ok((path, ClaudeSource::PinnedStore))
        }
        Err(pinned_error) => Err(format!(
            "no usable Claude CLI: installed: {installed_error}; pinned store: {pinned_error}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::SpawnRequest;
    use sha2::{Digest, Sha256};

    fn params(mode: &str) -> SpawnParams {
        SpawnParams {
            agent: None,
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            model: None,
            effort: None,
            permission_mode: mode.into(),
            resume: None,
            ctl_secret: None,
            rules_file: None,
            tab_name: None,
            gateway: None,
            profile: None,
            payload_file: None,
            mcp_file: None,
            row_key: None,
            sets: None,
            set_plugin_dirs: Vec::new(), codex_home: None, claude_config_dir: None, plugin_names: Vec::new(),
        }
    }

    /// `rules_fixture` plus the shipped bare profile and a prepared home under a fixture
    /// `LOCALAPPDATA`, holding `layer\payload-0123456789ab.md`. Returns the payload's path too.
    fn payload_fixture() -> (tempdir::Dir, ClaudeRuntime, PathBuf, PathBuf, PathBuf) {
        let (root, rt, _) = rules_fixture();
        let profile_dir = root.path().join("profiles").join("bare");
        std::fs::create_dir_all(&profile_dir).unwrap();
        let shipped = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("profiles").join("bare").join("claude.json");
        std::fs::copy(shipped, profile_dir.join("claude.json")).unwrap();
        let lad = root.path().join("lad");
        let home = crate::bare_home::resolve_for(root.path(), &lad);
        std::fs::create_dir_all(home.join("claude-config")).unwrap();
        std::fs::create_dir_all(home.join("layer")).unwrap();
        let payload = home.join("layer").join("payload-0123456789ab.md");
        std::fs::write(&payload, "payload").unwrap();
        (root, rt, lad, home, payload)
    }

    fn bare_params(payload: Option<&Path>) -> SpawnParams {
        let mut p = params("default");
        p.profile = Some("bare".into());
        p.payload_file = payload.map(|f| f.to_string_lossy().into_owned());
        p
    }

    #[test]
    fn a_profile_spawn_hands_the_payload_file_to_the_sidecar() {
        let (_root, rt, lad, _home, payload) = payload_fixture();
        let request = rt.spawn_request_in(&bare_params(Some(&payload)), "s1", Some(&lad)).unwrap();
        let at = request.args.iter().position(|a| a == "--payload").expect("--payload flag");
        let passed = &request.args[at + 1];
        assert!(!passed.starts_with(r"\\?\"), "plain path for node: {passed}");
        assert_eq!(std::fs::canonicalize(passed).unwrap(), std::fs::canonicalize(&payload).unwrap());
        assert!(request.args.iter().any(|a| a == "--profile"));
        // No payload sent: the sidecar keeps the profile's static one.
        let request = rt.spawn_request_in(&bare_params(None), "s1", Some(&lad)).unwrap();
        assert!(!request.args.iter().any(|a| a == "--payload"));
    }

    #[test]
    fn mcp_file_is_admitted_only_directly_under_the_bare_layer() {
        let (root, rt, lad, home, _) = payload_fixture();
        let name = "mcp-0123456789ab.json";
        let file = home.join("layer").join(name);
        std::fs::write(&file, r#"{"mcpServers":{}}"#).unwrap();
        let mut p = bare_params(None);
        p.mcp_file = Some(file.to_string_lossy().into_owned());
        let request = rt.spawn_request_in(&p, "s1", Some(&lad)).unwrap();
        let at = request.args.iter().position(|a| a == "--mcp-file").unwrap();
        assert_eq!(std::fs::canonicalize(&request.args[at + 1]).unwrap(), std::fs::canonicalize(&file).unwrap());
        for dir in [home.clone(), root.path().to_path_buf()] {
            let outside = dir.join(name);
            std::fs::write(&outside, "{}").unwrap();
            p.mcp_file = Some(outside.to_string_lossy().into_owned());
            assert!(rt.spawn_request_in(&p, "s1", Some(&lad)).unwrap_err().contains("outside the bare home's layer"));
        }
        let bad = home.join("layer").join("mcp-0123456789AB.json");
        std::fs::write(&bad, "{}").unwrap();
        p.mcp_file = Some(bad.to_string_lossy().into_owned());
        assert!(rt.spawn_request_in(&p, "s1", Some(&lad)).unwrap_err().contains("mcp-<hash12>.json"));
    }

    #[test]
    fn a_payload_file_outside_the_home_layer_is_refused() {
        let (root, rt, lad, home, payload) = payload_fixture();
        let refuse = |raw: &str| {
            let mut p = bare_params(None);
            p.payload_file = Some(raw.into());
            rt.spawn_request_in(&p, "s1", Some(&lad)).expect_err(raw)
        };
        // Same name, beside `layer\` in the home and in the Vidar root.
        for dir in [home.clone(), root.path().to_path_buf()] {
            let outside = dir.join("payload-0123456789ab.md");
            std::fs::write(&outside, "payload").unwrap();
            let e = refuse(&outside.to_string_lossy());
            assert!(e.contains("outside the bare home's layer directory"), "{e}");
        }
        // A name off the rule, inside `layer\`.
        for name in ["0123456789ab.md", "payload-0123456789AB.md", "payload-0123456789a.md", "payload-0123456789ab.txt"] {
            let file = home.join("layer").join(name);
            std::fs::write(&file, "payload").unwrap();
            let e = refuse(&file.to_string_lossy());
            assert!(e.contains("payload-<hash12>.md"), "{name}: {e}");
        }
        let e = refuse(r"layer\payload-0123456789ab.md");
        assert!(e.contains("not an absolute path"), "{e}");
        let dotted = home.join("layer").join("..").join("layer").join("payload-0123456789ab.md");
        assert!(refuse(&dotted.to_string_lossy()).contains("'..'"));
        assert!(refuse("-payload-0123456789ab.md").contains("starts with '-'"));
        let missing = home.join("layer").join("payload-fedcba987654.md");
        assert!(refuse(&missing.to_string_lossy()).contains("unavailable"));
        // A directory with the payload's name is not a file.
        let dir = home.join("layer").join("payload-aaaaaaaaaaaa.md");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(refuse(&dir.to_string_lossy()).contains("outside the bare home's layer directory"));
        // Without a profile there is no payload to replace.
        let mut p = params("default");
        p.payload_file = Some(payload.to_string_lossy().into_owned());
        let e = rt.spawn_request_in(&p, "s1", Some(&lad)).unwrap_err();
        assert!(e.contains("needs a launch profile"), "{e}");
    }

    /// The home's `layer\` a junction to a folder outside the home: the rule compares against
    /// `canonicalize(home)` joined with `layer`, never `canonicalize(layer)`, so it is refused.
    #[test]
    fn a_payload_file_through_a_junctioned_layer_is_refused() {
        let (root, rt, lad, home, _) = payload_fixture();
        let outside = root.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("payload-0123456789ab.md"), "payload").unwrap();
        let layer = home.join("layer");
        std::fs::remove_dir_all(&layer).unwrap();
        let made = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(&layer).arg(&outside).output();
        if !made.as_ref().is_ok_and(|o| o.status.success()) || !layer.exists() {
            eprintln!("SKIP a_payload_file_through_a_junctioned_layer_is_refused: could not create a junction");
            return;
        }
        let via = layer.join("payload-0123456789ab.md");
        let e = rt.spawn_request_in(&bare_params(Some(&via)), "s1", Some(&lad)).unwrap_err();
        assert!(e.contains("outside the bare home's layer directory"), "{e}");
    }

    /// `<parent>\<name>\.claude-plugin\plugin.json`, the folder returned.
    fn set_plugin_in(parent: &Path, name: &str) -> PathBuf {
        let dir = parent.join(name);
        std::fs::create_dir_all(dir.join(".claude-plugin")).unwrap();
        std::fs::write(dir.join(".claude-plugin").join("plugin.json"), "{\"name\":\"s\"}").unwrap();
        dir
    }

    fn set_plugin_args(request: &SpawnRequest) -> Vec<String> {
        request.args.windows(2).filter(|w| w[0] == "--set-plugin").map(|w| w[1].clone()).collect()
    }

    #[test]
    fn admitted_set_plugins_reach_the_sidecar_in_order() {
        let (_root, rt, lad, home, _) = payload_fixture();
        let plugins = home.join("layer").join("plugins");
        let a = set_plugin_in(&plugins, "Core.v2_x-0123456789ab");
        let b = set_plugin_in(&plugins, "core-2-fedcba987654");
        let mut p = bare_params(None);
        p.set_plugin_dirs = vec![a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned()];
        let passed = set_plugin_args(&rt.spawn_request_in(&p, "s1", Some(&lad)).unwrap());
        assert_eq!(passed.len(), 2, "{passed:?}");
        assert!(passed.iter().all(|d| !d.starts_with(r"\\?\")), "plain paths for node: {passed:?}");
        assert_eq!(std::fs::canonicalize(&passed[0]).unwrap(), std::fs::canonicalize(&a).unwrap());
        assert_eq!(std::fs::canonicalize(&passed[1]).unwrap(), std::fs::canonicalize(&b).unwrap());
        // Without a profile they are dropped, and the spawn still goes.
        let mut plain = params("default");
        plain.set_plugin_dirs = vec![a.to_string_lossy().into_owned()];
        assert!(set_plugin_args(&rt.spawn_request_in(&plain, "s1", Some(&lad)).unwrap()).is_empty());
    }

    #[test]
    fn a_bad_set_plugin_is_dropped_and_the_spawn_goes() {
        let (root, rt, lad, home, _) = payload_fixture();
        let plugins = home.join("layer").join("plugins");
        let good = set_plugin_in(&plugins, "core-0123456789ab");
        let admit = |raw: &Path| ClaudeRuntime::admit_set_plugin_dir(&raw.to_string_lossy(), &home);
        assert!(admit(&good).is_ok());
        // Well named, outside `layer\plugins\`: beside it in layer\, in the home, in the root.
        for parent in [home.join("layer"), home.clone(), root.path().to_path_buf()] {
            let outside = set_plugin_in(&parent, "core-0123456789ab");
            assert!(admit(&outside).unwrap_err().contains("outside"), "{}", outside.display());
        }
        // Names off the rule, inside `layer\plugins\`.
        for name in ["core", "core-0123456789AB", "core-0123456789a", "-0123456789ab", "co re-0123456789ab", ".stage-1-core-0123456789ab.x"] {
            let dir = set_plugin_in(&plugins, name);
            assert!(admit(&dir).unwrap_err().contains("<set>-<hash12>"), "{name}");
        }
        // No plugin.json, or a folder in its place.
        let bare_dir = plugins.join("empty-aaaaaaaaaaaa");
        std::fs::create_dir_all(&bare_dir).unwrap();
        assert!(admit(&bare_dir).unwrap_err().contains("plugin.json"));
        let dir_json = plugins.join("dirjson-bbbbbbbbbbbb");
        std::fs::create_dir_all(dir_json.join(".claude-plugin").join("plugin.json")).unwrap();
        assert!(admit(&dir_json).unwrap_err().contains("plugin.json"));
        // Shape checks before any filesystem access.
        assert!(ClaudeRuntime::admit_set_plugin_dir(r"layer\plugins\core-0123456789ab", &home).unwrap_err().contains("absolute"));
        assert!(ClaudeRuntime::admit_set_plugin_dir("-core-0123456789ab", &home).unwrap_err().contains("'-'"));
        let dotted = plugins.join("..").join("plugins").join("core-0123456789ab");
        assert!(admit(&dotted).unwrap_err().contains("'..'"));
        assert!(admit(&plugins.join("gone-cccccccccccc")).unwrap_err().contains("unavailable"));
        // Through the spawn: only the good one is passed, and the spawn is not refused.
        let mut p = bare_params(None);
        p.set_plugin_dirs = vec![
            home.join("core-0123456789ab").to_string_lossy().into_owned(),
            good.to_string_lossy().into_owned(),
            bare_dir.to_string_lossy().into_owned(),
        ];
        let passed = set_plugin_args(&rt.spawn_request_in(&p, "s1", Some(&lad)).unwrap());
        assert_eq!(passed.len(), 1, "{passed:?}");
        assert_eq!(std::fs::canonicalize(&passed[0]).unwrap(), std::fs::canonicalize(&good).unwrap());
    }

    /// A junction anywhere from the home down: `layer\plugins\` pointing outside, or a plugin
    /// folder entry pointing at a well-named sibling or at a folder outside.
    #[test]
    fn a_set_plugin_through_a_junction_is_dropped() {
        let (root, _rt, _lad, home, _) = payload_fixture();
        let junction = |link: &Path, target: &Path| {
            let made = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(link).arg(target).output();
            made.as_ref().is_ok_and(|o| o.status.success()) && link.exists()
        };
        let plugins = home.join("layer").join("plugins");
        let real = set_plugin_in(&plugins, "real-0123456789ab");
        let admit = |raw: &Path| ClaudeRuntime::admit_set_plugin_dir(&raw.to_string_lossy(), &home);
        // A folder entry junctioned to its sibling: same parent, other name.
        let alias = plugins.join("alias-0123456789ab");
        if !junction(&alias, &real) {
            eprintln!("SKIP a_set_plugin_through_a_junction_is_dropped: could not create a junction");
            return;
        }
        assert!(admit(&alias).is_err());
        // A folder entry junctioned outside the home, target named alike.
        let outside = root.path().join("outside");
        let far = set_plugin_in(&outside, "far-0123456789ab");
        let near = plugins.join("far-0123456789ab");
        assert!(junction(&near, &far));
        assert!(admit(&near).unwrap_err().contains("outside"));
        // `.claude-plugin` junctioned to a folder holding a plugin.json.
        let inner = set_plugin_in(&plugins, "inner-0123456789ab");
        std::fs::remove_dir_all(inner.join(".claude-plugin")).unwrap();
        assert!(junction(&inner.join(".claude-plugin"), &far.join(".claude-plugin")));
        assert!(admit(&inner).unwrap_err().contains("reparse"));
        // The whole `plugins\` junctioned outside.
        std::fs::remove_dir_all(&plugins).unwrap_or_else(|_| {
            // remove_dir_all may refuse the junctions inside; clear them first.
            for j in [&alias, &near, &inner.join(".claude-plugin")] {
                let _ = std::fs::remove_dir(j);
            }
            std::fs::remove_dir_all(&plugins).unwrap();
        });
        assert!(junction(&plugins, &outside));
        assert!(admit(&plugins.join("far-0123456789ab")).unwrap_err().contains("outside"));
    }

    #[test]
    fn a_plugin_name_is_admitted_from_the_root_plugins_folder() {
        let (root, rt, lad, home, _) = payload_fixture();
        let a = root.path().join("plugins").join("vidar-app");
        let b = root.path().join("plugins").join("0gate");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let old = set_plugin_in(&home.join("layer").join("plugins"), "core-0123456789ab");
        let mut p = bare_params(None);
        p.set_plugin_dirs = vec![old.to_string_lossy().into_owned()];
        p.plugin_names = vec!["vidar-app".into(), "0gate".into()];
        let passed = set_plugin_args(&rt.spawn_request_in(&p, "s1", Some(&lad)).unwrap());
        // Today's home-layer plugin first, then the names in order.
        assert_eq!(passed.len(), 3, "{passed:?}");
        assert!(passed.iter().all(|d| !d.starts_with(r"\\?\")), "plain paths for node: {passed:?}");
        assert_eq!(std::fs::canonicalize(&passed[0]).unwrap(), std::fs::canonicalize(&old).unwrap());
        assert_eq!(std::fs::canonicalize(&passed[1]).unwrap(), std::fs::canonicalize(&a).unwrap());
        assert_eq!(std::fs::canonicalize(&passed[2]).unwrap(), std::fs::canonicalize(&b).unwrap());
        // An old request without the field: only today's plugin.
        p.plugin_names.clear();
        assert_eq!(set_plugin_args(&rt.spawn_request_in(&p, "s1", Some(&lad)).unwrap()).len(), 1);
    }

    #[test]
    fn a_bad_plugin_name_refuses_the_spawn() {
        let (root, rt, lad, _home, _) = payload_fixture();
        let plugins = root.path().join("plugins");
        std::fs::create_dir_all(plugins.join("good")).unwrap();
        std::fs::write(plugins.join("afile"), "x").unwrap();
        let abs = plugins.join("good").to_string_lossy().into_owned();
        let refuse = |names: &[&str]| {
            let mut p = bare_params(None);
            p.plugin_names = names.iter().map(|n| n.to_string()).collect();
            rt.spawn_request_in(&p, "s1", Some(&lad)).expect_err("must refuse")
        };
        let long = "a".repeat(65);
        for bad in [r"..\x", "../x", abs.as_str(), "Good", "GOOD", "", "-x", "a b", "a.b", r"good\x", long.as_str()] {
            assert!(refuse(&["good", bad]).contains("is not [a-z0-9]"), "{bad:?}");
        }
        assert!(refuse(&["gone"]).contains("missing"));
        assert!(refuse(&["afile"]).contains("not a directory"));
        // Without a profile the names are refused, not dropped.
        let mut plain = params("default");
        plain.plugin_names = vec!["good".into()];
        assert!(rt.spawn_request_in(&plain, "s1", Some(&lad)).unwrap_err().contains("need a launch profile"));
        assert!(ClaudeRuntime::admit_plugin_name(&"a".repeat(64), root.path()).unwrap_err().contains("missing"));
    }

    /// A junction under `plugins\` (the named entry) or `plugins\` itself junctioned elsewhere.
    #[test]
    fn a_plugin_name_through_a_junction_is_refused() {
        let (root, rt, lad, _home, _) = payload_fixture();
        let junction = |link: &Path, target: &Path| {
            let made = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(link).arg(target).output();
            made.as_ref().is_ok_and(|o| o.status.success()) && link.exists()
        };
        let plugins = root.path().join("plugins");
        let outside = root.path().join("outside");
        std::fs::create_dir_all(outside.join("far")).unwrap();
        std::fs::create_dir_all(&plugins).unwrap();
        if !junction(&plugins.join("far"), &outside.join("far")) {
            eprintln!("SKIP a_plugin_name_through_a_junction_is_refused: could not create a junction");
            return;
        }
        let refuse = |name: &str| {
            let mut p = bare_params(None);
            p.plugin_names = vec![name.into()];
            rt.spawn_request_in(&p, "s1", Some(&lad)).expect_err("must refuse")
        };
        assert!(refuse("far").contains("reparse"));
        std::fs::remove_dir(plugins.join("far")).unwrap();
        std::fs::remove_dir_all(&plugins).unwrap();
        assert!(junction(&plugins, &outside));
        assert!(refuse("far").contains("reparse"));
    }

    /// A fake Vidar root holding `runtime\rules\built\0123456789ab.md`, plus a
    /// runtime whose `rules_built` points at it.
    fn rules_fixture() -> (tempdir::Dir, ClaudeRuntime, PathBuf) {
        let root = tempdir::Dir::new();
        let built = root.path().join(RULES_BUILT);
        std::fs::create_dir_all(&built).unwrap();
        let file = built.join("0123456789ab.md");
        std::fs::write(&file, "rule").unwrap();
        let mut rt = runtime();
        rt.rules_built = Some(built);
        (root, rt, file)
    }

    fn rules_error(rt: &ClaudeRuntime, raw: &str) -> String {
        let mut p = params("default");
        p.rules_file = Some(raw.into());
        rt.spawn_request(&p, "s1").expect_err("must refuse")
    }

    #[test]
    fn gateway_spawn_requires_local_preparation_and_keeps_plain_args() {
        let mut p = params("default");
        p.gateway = crate::protocol::Gateway::new("acme");
        assert!(runtime().spawn_request(&p, "s1").is_err());
        let (root, rt, _) = rules_fixture();
        assert!(rt.spawn_request(&p, "s1").is_err());
        let dir = root.path().join("tools/vendor");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("vendor-prepare.ps1"), "# fixture").unwrap();
        let plain = rt.spawn_request(&params("default"), "s1").unwrap();
        let gateway = rt.spawn_request(&p, "s1").unwrap();
        assert_eq!(&gateway.args[..plain.args.len()], plain.args.as_slice());
        assert_eq!(&gateway.args[plain.args.len()..plain.args.len()+3],
            ["--gateway", "acme", "--vendor-preparer"]);
        assert_eq!(&gateway.args[plain.args.len()+4..],
            ["--pwsh", r"C:\Program Files\PowerShell\7\pwsh.exe"]);
        assert_eq!(gateway.env, plain.env);
        let mut no_pwsh = rt.clone();
        no_pwsh.pwsh = None;
        assert!(no_pwsh.spawn_request(&p, "s1").is_err());
        assert!(no_pwsh.spawn_request(&params("default"), "s1").is_ok());
    }

    #[test]
    fn a_profile_spawn_refuses_an_unknown_id_and_rules_or_gateway() {
        let (_root, rt, file) = rules_fixture();
        let mut p = params("default");
        p.profile = Some("lean".into());
        assert!(rt.spawn_request(&p, "s1").unwrap_err().contains("unknown launch profile"));
        p.profile = Some("bare".into());
        p.rules_file = Some(file.to_string_lossy().into_owned());
        assert!(rt.spawn_request(&p, "s1").unwrap_err().contains("no rules file"));
        p.rules_file = None;
        p.gateway = crate::protocol::Gateway::new("acme");
        assert!(rt.spawn_request(&p, "s1").unwrap_err().contains("no gateway"));
        // No profile file under the fixture root: refused, never a default launch.
        p.gateway = None;
        assert!(rt.spawn_request(&p, "s1").is_err());
        assert!(runtime().spawn_request(&p, "s1").unwrap_err().contains("Vidar root"));
    }

    /// The shell places the home with Vidar's own code (`bare/home_path.rs`), so a hosted bare
    /// session and a Raw bare tab of one install share a home. The keys are the ones pinned by
    /// `src-tauri/src/bare/home.rs` `home_paths_match_the_js_table` and the JS twin.
    #[test]
    fn falcon_homes_equal_the_vidar_resolver() {
        let lad = Path::new(r"C:\Users\Test User\AppData\Local");
        for (root, key) in [
            (r"D:\Tools\Vidar", "1c49ff625c89a9b8"),
            (r"C:\Program Files\My Vidar\App", "096f91e36c966a48"),
            (r"E:\Mixed\Case\ViDaR", "161d7d325fd5bbcf"),
        ] {
            let err = bare_spawn(Path::new(root), Some(lad), "bare", None).unwrap_err();
            assert!(err.contains("launch profile"), "{err}");
            assert_eq!(
                crate::bare_home::resolve_for(Path::new(root), lad),
                lad.join("Vidar").join("homes").join(key)
            );
        }
        assert!(bare_spawn(Path::new(r"D:\Tools\Vidar"), None, "bare", None).unwrap_err().contains("LOCALAPPDATA"));
        assert!(bare_spawn(Path::new(r"D:\Tools\Vidar"), Some(Path::new("rel")), "bare", None).unwrap_err().contains("LOCALAPPDATA"));
    }

    /// The shipped profile against a fake root and prepared home: the overlay, the rendered
    /// overlay and HOMEDRIVE/HOMEPATH, all under the resolver's home.
    #[test]
    fn the_shipped_profile_maps_to_the_bare_home_and_env() {
        let root = tempdir::Dir::new();
        let profile_dir = root.path().join("profiles").join("bare");
        std::fs::create_dir_all(&profile_dir).unwrap();
        let shipped = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("profiles").join("bare").join("claude.json");
        std::fs::copy(shipped, profile_dir.join("claude.json")).unwrap();
        let lad = root.path().join("lad");
        let home = crate::bare_home::resolve_for(root.path(), &lad);
        assert!(bare_spawn(root.path(), Some(&lad), "bare", None).unwrap_err().contains("not prepared"));
        std::fs::create_dir_all(home.join("claude-config")).unwrap();
        let bare = bare_spawn(root.path(), Some(&lad), "bare", None).unwrap();
        assert_eq!(bare.home, home);
        let get = |n: &str| bare.env.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone());
        let h = home.to_string_lossy();
        assert_eq!(get("CLAUDE_CONFIG_DIR"), Some(format!("{h}\\claude-config")));
        assert_eq!(get("VIDAR_AGENT_HOME"), Some(format!("{h}\\claude-config")));
        assert_eq!(get("USERPROFILE"), Some(format!("{h}\\user-home")));
        assert_eq!(get("CLAUDE_CODE_ENABLE_FUNCTION_HOOKS").as_deref(), Some("1"));
        assert_eq!(get("CLAUDE_CODE_DISABLE_CLAUDE_MDS").as_deref(), Some("1"));
        assert!(get("HOMEDRIVE").is_some() && get("HOMEPATH").is_some());
        assert!(bare.env.iter().all(|(_, v)| !v.contains("{{")), "unfilled placeholder");
    }

    /// An edited profile cannot move the Claude config out of the home, by overlay value or by
    /// the rendered layer overriding it.
    #[test]
    fn a_profile_cannot_move_the_config_or_profile_dir() {
        let shipped = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("profiles").join("bare").join("claude.json"),
        )
        .unwrap();
        let attempt = |edit: &dyn Fn(&mut Value)| -> String {
            let root = tempdir::Dir::new();
            let dir = root.path().join("profiles").join("bare");
            std::fs::create_dir_all(&dir).unwrap();
            let mut doc: Value = serde_json::from_str(&shipped).unwrap();
            edit(&mut doc);
            std::fs::write(dir.join("claude.json"), doc.to_string()).unwrap();
            let lad = root.path().join("lad");
            std::fs::create_dir_all(crate::bare_home::resolve_for(root.path(), &lad).join("claude-config")).unwrap();
            bare_spawn(root.path(), Some(&lad), "bare", None).unwrap_err()
        };
        for name in ["CLAUDE_CONFIG_DIR", "USERPROFILE"] {
            let e = attempt(&|d| d["rendered"]["overlay"][name] = r"C:\elsewhere".into());
            assert_eq!(e, format!("launch profile \"bare\" rendered.overlay may not set {name}"));
        }
        for outside in [r"C:\Users\someone\.claude", r"{{home}}\..\.claude", "{{home}}"] {
            let e = attempt(&|d| d["overlay"]["CLAUDE_CONFIG_DIR"] = outside.into());
            assert!(e.contains("outside the bare home"), "{outside}: {e}");
        }
    }

    /// A fake root with the shipped profile and a prepared home: (root, LOCALAPPDATA, home).
    fn shipped_home() -> (tempdir::Dir, PathBuf, PathBuf) {
        let root = tempdir::Dir::new();
        let profile_dir = root.path().join("profiles").join("bare");
        std::fs::create_dir_all(&profile_dir).unwrap();
        let shipped = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("profiles").join("bare").join("claude.json");
        std::fs::copy(shipped, profile_dir.join("claude.json")).unwrap();
        let lad = root.path().join("lad");
        let home = crate::bare_home::resolve_for(root.path(), &lad);
        std::fs::create_dir_all(home.join("claude-config")).unwrap();
        (root, lad, home)
    }

    fn env_of<'a>(bare: &'a BareSpawn, name: &str) -> Option<&'a str> {
        bare.env.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    #[test]
    fn no_claude_config_dir_keeps_the_overlay_dir() {
        let (root, lad, home) = shipped_home();
        let bare = bare_spawn(root.path(), Some(&lad), "bare", None).unwrap();
        let own = home.join("claude-config").to_string_lossy().into_owned();
        assert_eq!(env_of(&bare, "CLAUDE_CONFIG_DIR"), Some(own.as_str()));
        assert_eq!(env_of(&bare, "VIDAR_AGENT_HOME"), Some(own.as_str()));
    }

    #[test]
    fn an_admitted_combination_dir_replaces_the_overlay_dir() {
        let (root, lad, home) = shipped_home();
        let combo = home.join(CLAUDE_HOMES_DIR).join("0123456789ab");
        std::fs::create_dir_all(&combo).unwrap();
        let raw = combo.to_string_lossy().into_owned();
        let bare = bare_spawn(root.path(), Some(&lad), "bare", Some(&raw)).unwrap();
        assert_eq!(env_of(&bare, "CLAUDE_CONFIG_DIR"), Some(raw.as_str()));
        assert_eq!(env_of(&bare, "VIDAR_AGENT_HOME"), Some(raw.as_str()));
        assert_eq!(env_of(&bare, "CLAUDE_CODE_DISABLE_CLAUDE_MDS"), Some("1"), "the rest of the overlay stays");
        // The overlay's own dir, named explicitly, is admitted too.
        let own = home.join("claude-config").to_string_lossy().into_owned();
        let bare = bare_spawn(root.path(), Some(&lad), "bare", Some(&own)).unwrap();
        assert_eq!(env_of(&bare, "CLAUDE_CONFIG_DIR"), Some(own.as_str()));
    }

    #[test]
    fn a_claude_config_dir_outside_the_home_is_refused() {
        let (root, lad, home) = shipped_home();
        let outside = root.path().join("elsewhere").join(CLAUDE_HOMES_DIR).join("0123456789ab");
        std::fs::create_dir_all(&outside).unwrap();
        for raw in [outside.to_string_lossy().into_owned(), home.to_string_lossy().into_owned(), format!(r"{}\claude-homes\..\..\x", home.display())] {
            let e = bare_spawn(root.path(), Some(&lad), "bare", Some(&raw)).unwrap_err();
            assert!(e.contains("outside the bare home") && e.contains("spawn refused"), "{raw}: {e}");
        }
        for raw in ["claude-homes\\0123456789ab", "-x"] {
            let e = bare_spawn(root.path(), Some(&lad), "bare", Some(raw)).unwrap_err();
            assert!(e.contains("spawn refused"), "{raw}: {e}");
        }
    }

    #[test]
    fn a_missing_claude_config_dir_is_refused() {
        let (root, lad, home) = shipped_home();
        let raw = home.join(CLAUDE_HOMES_DIR).join("0123456789ab").to_string_lossy().into_owned();
        let e = bare_spawn(root.path(), Some(&lad), "bare", Some(&raw)).unwrap_err();
        assert!(e.contains("does not exist") && e.contains("spawn refused"), "{e}");
    }

    #[test]
    fn a_sibling_of_claude_homes_is_refused() {
        let (root, lad, home) = shipped_home();
        let homes = home.join(CLAUDE_HOMES_DIR);
        let deep = homes.join("0123456789ab").join("inner");
        for d in [home.join("claude-homes-2").join("0123456789ab"), home.join("codex-homes").join("0123456789ab"), homes.join("NotAHash"), deep.clone()] {
            std::fs::create_dir_all(&d).unwrap();
        }
        let cases = [
            home.join("claude-homes-2").join("0123456789ab"),
            home.join("codex-homes").join("0123456789ab"),
            home.join("user-home"),
            homes.clone(),
            homes.join("NotAHash"),
            deep,
        ];
        std::fs::create_dir_all(home.join("user-home")).unwrap();
        for d in cases {
            let raw = d.to_string_lossy().into_owned();
            let e = bare_spawn(root.path(), Some(&lad), "bare", Some(&raw)).unwrap_err();
            assert!(e.contains("claude-homes directory") && e.contains("spawn refused"), "{raw}: {e}");
        }
    }

    #[test]
    fn a_claude_config_dir_needs_a_profile() {
        let (_root, rt, _file) = rules_fixture();
        let mut p = params("default");
        p.claude_config_dir = Some(r"C:\x".into());
        assert_eq!(rt.spawn_request(&p, "s1").unwrap_err(), "a Claude config dir needs a launch profile");
    }

    #[test]
    fn rules_file_appends_sidecar_flag() {
        let (_root, rt, file) = rules_fixture();
        let mut p = params("default");
        p.rules_file = Some(file.to_string_lossy().into_owned());
        let request = rt.spawn_request(&p, "s1").unwrap();
        let at = request.args.iter().position(|a| a == "--rules-file").expect("flag");
        let passed = PathBuf::from(&request.args[at + 1]);
        assert_eq!(
            std::fs::canonicalize(passed).unwrap(),
            std::fs::canonicalize(&file).unwrap()
        );
        assert!(!request.args[at + 1].starts_with(r"\\?\"), "plain path for node");
        let request = rt.spawn_request(&params("default"), "s1").unwrap();
        assert!(!request.args.iter().any(|a| a == "--rules-file"));
    }

    #[test]
    fn rules_file_relative_refused() {
        let (_root, rt, _) = rules_fixture();
        let error = rules_error(&rt, r"runtime\rules\built\0123456789ab.md");
        assert!(error.contains("not an absolute path"), "{error}");
    }

    #[test]
    fn rules_file_outside_built_dir_refused() {
        let (root, rt, _) = rules_fixture();
        let outside = root.path().join("0123456789ab.md");
        std::fs::write(&outside, "rule").unwrap();
        let error = rules_error(&rt, &outside.to_string_lossy());
        assert!(error.contains("outside the built rules directory"), "{error}");
        // A host without a rules directory admits nothing.
        let (_r, mut bare, file) = rules_fixture();
        bare.rules_built = None;
        let error = rules_error(&bare, &file.to_string_lossy());
        assert!(error.contains("no rules directory"), "{error}");
    }

    #[test]
    fn rules_file_dot_dot_refused() {
        let (_root, rt, file) = rules_fixture();
        let built = file.parent().unwrap();
        // Lands back on the real file, so only the `..` check can refuse it.
        let sneaky = built.join("..").join("built").join("0123456789ab.md");
        let error = rules_error(&rt, &sneaky.to_string_lossy());
        assert!(error.contains("'..'"), "{error}");
    }

    #[test]
    fn rules_file_leading_dash_refused() {
        let (_root, rt, _) = rules_fixture();
        let error = rules_error(&rt, "--dangerously-skip-permissions");
        assert!(error.contains("starts with '-'"), "{error}");
    }

    #[test]
    fn model_starting_with_dash_refused() {
        let mut p = params("default");
        p.model = Some(" --rules-file".into());
        let error = runtime().spawn_request(&p, "s1").unwrap_err();
        assert!(error.contains("must not start with '-'"), "{error}");
        p.model = Some("sonnet".into());
        assert!(runtime().spawn_request(&p, "s1").is_ok());
    }

    #[test]
    fn rules_file_missing_refused() {
        let (_root, rt, file) = rules_fixture();
        let missing = file.parent().unwrap().join("ffffffffffff.md");
        let error = rules_error(&rt, &missing.to_string_lossy());
        assert!(error.contains("rules file unavailable"), "{error}");
    }

    /// `built\` itself a junction to a directory outside the root: canonicalizing resolves it, so
    /// the admitted file's parent is not the canonical built dir of the host's own root.
    #[test]
    fn rules_file_through_junction_refused() {
        let (root, mut rt, _) = rules_fixture();
        let outside = root.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("0123456789ab.md"), "rule").unwrap();
        let link = root.path().join("link-built");
        let made = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output();
        if !made.as_ref().is_ok_and(|o| o.status.success()) || !link.exists() {
            eprintln!("SKIP rules_file_through_junction_refused: could not create a junction");
            return;
        }
        // The host's built dir is the real one; the client names the file through the junction.
        let via = link.join("0123456789ab.md");
        let error = rules_error(&rt, &via.to_string_lossy());
        assert!(error.contains("outside the built rules directory"), "{error}");
        // And with the host's built dir itself the junction, a file elsewhere is still refused.
        rt.rules_built = Some(link.clone());
        let elsewhere = root.path().join("0123456789ab.md");
        std::fs::write(&elsewhere, "rule").unwrap();
        let error = rules_error(&rt, &elsewhere.to_string_lossy());
        assert!(error.contains("outside the built rules directory"), "{error}");
        let _ = std::process::Command::new("cmd").args(["/c", "rmdir"]).arg(&link).output();
    }

    #[test]
    fn rules_file_non_hash_name_refused() {
        let (_root, rt, file) = rules_fixture();
        let built = file.parent().unwrap();
        for name in ["rules.md", "0123456789AB.md", "0123456789ab.txt", "0123456789abc.md"] {
            let other = built.join(name);
            std::fs::write(&other, "rule").unwrap();
            let error = rules_error(&rt, &other.to_string_lossy());
            assert!(error.contains("not <hash12>.md"), "{name}: {error}");
        }
    }

    #[test]
    fn effort_is_allowlisted_and_only_pushed_when_set() {
        let mut p = params("default");
        p.effort = Some("high".into());
        let request = runtime().spawn_request(&p, "s1").unwrap();
        let at = request.args.iter().position(|a| a == "--effort").expect("flag");
        assert_eq!(request.args[at + 1], "high");

        p.effort = Some("bogus".into());
        let error = runtime().spawn_request(&p, "s1").expect_err("must refuse");
        assert!(error.contains("effort level not allowed"), "{error}");

        let request = runtime().spawn_request(&params("default"), "s1").unwrap();
        assert!(!request.args.iter().any(|a| a == "--effort"));
    }

    fn env_value<'a>(request: &'a SpawnRequest, name: &str) -> Option<&'a str> {
        request
            .env
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn a_ctl_secret_reaches_the_child_env_only_when_given() {
        let secret = "0123456789abcdef0123456789abcdef";
        let mut p = params("default");
        p.ctl_secret = Some(secret.into());
        let request = runtime().spawn_request(&p, "s1").unwrap();
        assert_eq!(env_value(&request, "VIDAR_CTL_SECRET"), Some(secret));
        assert_eq!(env_value(&request, "FALCON_SESSION"), Some("s1"));

        let request = runtime().spawn_request(&params("default"), "s1").unwrap();
        assert_eq!(env_value(&request, "VIDAR_CTL_SECRET"), None);
        // Absent from the additions and listed in SCRUBBED_ENV, so a value in
        // Falcon's own environment never reaches the child.
        assert!(crate::process::SCRUBBED_ENV.contains(&"VIDAR_CTL_SECRET"));
    }

    #[test]
    fn a_tab_name_reaches_the_child_env_only_when_usable() {
        let mut p = params("default");
        p.tab_name = Some("  Amber Raptor ".into());
        let request = runtime().spawn_request(&p, "s1").unwrap();
        assert_eq!(env_value(&request, "VIDAR_TAB_NAME"), Some("Amber Raptor"));

        for bad in ["", "   ", "a\nb", "a\0b"] {
            p.tab_name = Some(bad.into());
            let request = runtime().spawn_request(&p, "s1").unwrap();
            assert_eq!(env_value(&request, "VIDAR_TAB_NAME"), None, "{bad:?}");
        }
        let request = runtime().spawn_request(&params("default"), "s1").unwrap();
        assert_eq!(env_value(&request, "VIDAR_TAB_NAME"), None);
        assert!(crate::process::SCRUBBED_ENV.contains(&"VIDAR_TAB_NAME"));
    }

    #[test]
    fn a_malformed_ctl_secret_is_refused() {
        let mut p = params("default");
        p.ctl_secret = Some("not hex\0".into());
        let error = runtime().spawn_request(&p, "s1").expect_err("must refuse");
        assert!(error.contains("ctl secret"), "{error}");
    }

    fn runtime() -> ClaudeRuntime {
        ClaudeRuntime {
            node: PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
            sidecar: PathBuf::from(r"C:\bundle\sidecar\claude-sidecar.mjs"),
            claude_exe: PathBuf::from(r"C:\store\claude\abc\claude.exe"),
            rules_built: None,
            pwsh: Some(PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe")),
        }
    }

    #[test]
    fn bypass_modes_have_no_route_through_the_driver() {
        for mode in ["bypassPermissions", "dontAsk", "yolo"] {
            let error = runtime()
                .spawn_request(&params(mode), "s1")
                .expect_err("must refuse");
            assert!(error.contains("permission mode not allowed"), "{error}");
        }
    }

    #[test]
    fn a_non_uuid_resume_is_refused_before_anything_runs() {
        let mut p = params("default");
        p.resume = Some("../../other-session".into());
        let error = runtime().spawn_request(&p, "s1").expect_err("must refuse");
        assert!(error.contains("not a UUID"), "{error}");
    }

    #[test]
    fn the_command_line_points_at_the_bundle_not_the_checkout() {
        let request = runtime().spawn_request(&params("plan"), "s1").unwrap();
        assert_eq!(request.args[0], r"C:\bundle\sidecar\claude-sidecar.mjs");
        assert!(request.args.contains(&"--falcon".to_string()));
        assert!(request
            .args
            .iter()
            .any(|a| a == r"C:\store\claude\abc\claude.exe"));
        assert!(request.args.iter().all(|a| !a.contains("node_modules")));
    }

    #[test]
    fn an_outcome_commits_the_mode_label_only_when_applied() {
        let driver = ClaudeDriver::new(&params("default"));
        driver.observe(&json!({
            "type": "falcon", "subtype": "outcome", "cid": 1,
            "state": "failed", "mode": "plan", "message": "nope"
        }));
        assert_eq!(driver.permission_mode(), "default");
        driver.observe(&json!({
            "type": "falcon", "subtype": "outcome", "cid": 2,
            "state": "applied", "mode": "plan"
        }));
        assert_eq!(driver.permission_mode(), "plan");
    }

    /// The unattended watcher polls this, not `pending_permissions`: a
    /// permission that has moved past `Opened` — answered, returned, or
    /// otherwise settled — is no longer this driver's to auto-deny, even
    /// while it is still technically pending.
    #[test]
    fn a_responded_permission_is_no_longer_opened() {
        let driver = ClaudeDriver::new(&params("default"));
        assert!(!driver.is_opened("p1"), "an unknown id is not opened");
        driver.observe(&json!({"type": "permission_request", "id": "p1"}));
        assert!(driver.is_opened("p1"));
        driver.observe(&json!({
            "type": "falcon", "subtype": "permission", "id": "p1", "state": "responded"
        }));
        assert!(
            !driver.is_opened("p1"),
            "responded must no longer read as opened"
        );
    }

    #[test]
    fn a_failed_response_leaves_the_permission_pending() {
        let driver = ClaudeDriver::new(&params("default"));
        driver.observe(&json!({"type": "permission_request", "id": "p1"}));
        assert_eq!(driver.pending_permissions(), vec!["p1".to_string()]);
        driver.observe(&json!({
            "type": "falcon", "subtype": "permission", "id": "p1", "state": "failed"
        }));
        assert_eq!(
            driver.pending_permissions(),
            vec!["p1".to_string()],
            "a failed delivery must not settle the request"
        );
        driver.observe(&json!({
            "type": "falcon", "subtype": "permission", "id": "p1", "state": "settled"
        }));
        assert!(driver.pending_permissions().is_empty());
    }

    /// The whole point of the P2 fix: "my callback returned" is not delivery.
    /// It has moved off `Opened` though, so `pending_permissions` (needs a
    /// decision) no longer lists it; `permission_states` still tracks it as
    /// non-terminal via `Returned`.
    #[test]
    fn a_returned_callback_is_not_a_settled_permission() {
        let driver = ClaudeDriver::new(&params("default"));
        driver.observe(&json!({"type": "permission_request", "id": "p1"}));
        for state in ["responded", "returned"] {
            driver.observe(&json!({
                "type": "falcon", "subtype": "permission", "id": "p1", "state": state
            }));
            assert!(
                driver.pending_permissions().is_empty(),
                "{state} must not read as needing a decision"
            );
        }
        assert_eq!(
            driver.permission_states(),
            vec![("p1".to_string(), PermissionState::Returned)]
        );
        // only an agent signal settles it
        driver.observe(&json!({
            "type": "falcon", "subtype": "permission", "id": "p1",
            "state": "settled", "signal": "tool_result"
        }));
        assert!(driver.pending_permissions().is_empty());
    }

    #[test]
    fn pending_permissions_lists_opened_only() {
        let driver = ClaudeDriver::new(&params("default"));
        driver.observe(&json!({"type": "permission_request", "id": "p1"}));
        driver.observe(&json!({"type": "permission_request", "id": "p2"}));
        driver.observe(&json!({"type": "permission_request", "id": "p3"}));
        driver.observe(&json!({
            "type": "falcon", "subtype": "permission", "id": "p2", "state": "responded"
        }));
        driver.observe(&json!({
            "type": "falcon", "subtype": "permission", "id": "p3", "state": "returned"
        }));
        assert_eq!(driver.pending_permissions(), vec!["p1".to_string()]);
    }

    #[test]
    fn an_unknown_permission_state_is_not_a_licence_to_guess() {
        let driver = ClaudeDriver::new(&params("default"));
        driver.observe(&json!({"type": "permission_request", "id": "p1"}));
        driver.observe(&json!({
            "type": "falcon", "subtype": "permission", "id": "p1", "state": "teleported"
        }));
        assert_eq!(
            driver.permission_states(),
            vec![("p1".to_string(), PermissionState::Opened)]
        );
    }

    #[test]
    fn a_child_exit_cancels_every_outstanding_permission() {
        let driver = ClaudeDriver::new(&params("default"));
        for id in ["p-open", "p-returned", "p-done"] {
            driver.observe(&json!({"type": "permission_request", "id": id}));
        }
        driver.observe(&json!({
            "type": "falcon", "subtype": "permission", "id": "p-returned", "state": "returned"
        }));
        driver.observe(&json!({
            "type": "falcon", "subtype": "permission", "id": "p-done",
            "state": "settled", "signal": "result"
        }));

        let cancelled = driver.abandon("the agent process exited");

        assert_eq!(
            cancelled,
            vec!["p-open".to_string(), "p-returned".to_string()]
        );
        assert!(
            driver.pending_permissions().is_empty(),
            "nothing can answer a permission once the child is gone"
        );
        assert_eq!(
            driver.permission_states(),
            vec![
                ("p-done".to_string(), PermissionState::Settled),
                ("p-open".to_string(), PermissionState::CancelledByExit),
                ("p-returned".to_string(), PermissionState::CancelledByExit),
            ],
            "an exit cancels; it never settles, and never rewrites a terminal state"
        );
        // A record arriving after the exit does not resurrect or relabel it.
        driver.observe(&json!({
            "type": "falcon", "subtype": "permission", "id": "p-open", "state": "returned"
        }));
        assert_eq!(
            driver.permission_states()[1].1,
            PermissionState::CancelledByExit
        );
    }

    #[test]
    fn cancelled_by_exit_serializes_as_its_own_state() {
        assert_eq!(
            serde_json::to_string(&PermissionState::CancelledByExit).unwrap(),
            "\"cancelled-by-exit\""
        );
        assert_eq!(
            serde_json::to_string(&PermissionState::Returned).unwrap(),
            "\"returned\""
        );
    }

    /// Build a synthetic bundle + store so the manifest contract is tested
    /// without depending on a 222 MB release build being present.
    fn synthetic_bundle(
        exe_body: &[u8],
        declared: Option<&str>,
    ) -> (tempdir::Dir, PathBuf, PathBuf) {
        let root = tempdir::Dir::new();
        let bundle = root.path().join("bundle");
        let store = root.path().join("store");
        let sdk = bundle.join("sidecar/node_modules/@anthropic-ai/claude-agent-sdk");
        std::fs::create_dir_all(&sdk).unwrap();
        std::fs::write(bundle.join("sidecar/claude-sidecar.mjs"), b"// sidecar").unwrap();
        std::fs::write(sdk.join("sdk.mjs"), b"// sdk").unwrap();

        let real = format!("{:x}", Sha256::digest(exe_body));
        let exe_dir = store.join("claude").join(declared.unwrap_or(&real));
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::write(exe_dir.join("claude.exe"), exe_body).unwrap();

        let manifest = json!({
            "claude": {
                "sidecar": "sidecar/claude-sidecar.mjs",
                "sdk": "sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
                "exe_sha256": declared.unwrap_or(&real),
                "store_exe": "claude.exe",
                "installed": {
                    "names": ["claude.exe"],
                    "candidates": [r"%USERPROFILE%\.local\bin\claude.exe"]
                },
            }
        });
        std::fs::write(
            bundle.join("runtime-manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        (root, bundle, store)
    }

    #[test]
    fn resolve_accepts_the_manifest_shape_the_build_script_emits() {
        let (_root, bundle, store) = synthetic_bundle(b"pretend claude.exe", None);
        let runtime = ClaudeRuntime::resolve_with(&bundle, &store, |_, _| Err("none".into()))
            .expect("resolve");
        assert!(runtime.sidecar.ends_with("claude-sidecar.mjs"));
        assert!(runtime.claude_exe.ends_with("claude.exe"));
        // The store is content-addressed: the directory name is the digest.
        assert!(runtime
            .claude_exe
            .to_string_lossy()
            .contains(&format!("{:x}", Sha256::digest(b"pretend claude.exe"))));
    }

    #[test]
    fn the_pin_refuses_an_executable_whose_bytes_do_not_match() {
        // A store entry filed under one digest but holding different bytes is
        // exactly what content addressing is supposed to catch. The refusal
        // refuses the corrupt entry when it is the fallback.
        let wrong = format!("{:x}", Sha256::digest(b"a different binary"));
        let (_root, _bundle, store) = synthetic_bundle(b"pretend claude.exe", Some(&wrong));
        let error = pinned_claude_exe(&store, &wrong, "claude.exe").expect_err("must refuse");
        assert!(error.contains("does not match the bundle's"), "{error}");
    }

    #[test]
    fn claude_exe_resolution_prefers_the_install_then_the_pin_then_errors() {
        let pin = PathBuf::from(r"C:\store\claude\abc\claude.exe");
        let own = PathBuf::from(r"C:\Users\friend\.local\bin\claude.exe");

        // Installed present and store present: the install; the store is never read.
        let (path, source) = choose_claude_exe(Ok(own.clone()), || {
            panic!("pinned lookup must not run when the install is found")
        })
        .unwrap();
        assert_eq!((path, source), (own, ClaudeSource::Installed));

        // Installed missing, store valid: the store.
        let (path, source) =
            choose_claude_exe(Err("not on PATH".into()), || Ok(pin.clone())).unwrap();
        assert_eq!((path, source), (pin, ClaudeSource::PinnedStore));

        // Both missing: the error names both places looked at.
        let error = choose_claude_exe(Err("not on PATH".into()), || Err("pin missing".into()))
            .expect_err("must refuse");
        assert!(error.contains("pin missing") && error.contains("not on PATH"), "{error}");
    }

    fn manifest_from(value: serde_json::Value) -> ClaudeManifest {
        let manifest: RuntimeManifest = serde_json::from_value(value).unwrap();
        manifest.claude.expect("claude block")
    }

    fn claude_block(extra: serde_json::Value) -> serde_json::Value {
        let mut block = json!({
            "sidecar": "s.mjs", "sdk": "k.mjs", "exe_sha256": "ab",
            "store_exe": "claude.exe",
            "installed": {"names": ["claude.exe"], "candidates": [r"%USERPROFILE%\.local\bin\claude.exe"]}
        });
        for (key, value) in extra.as_object().unwrap() {
            block[key] = value.clone();
        }
        json!({"claude": block})
    }

    #[test]
    fn a_bundle_without_a_claude_block_resolves_to_not_in_this_bundle() {
        let (_root, bundle, store) = synthetic_bundle(b"pretend claude.exe", None);
        std::fs::write(
            bundle.join("runtime-manifest.json"),
            br#"{"schema":4,"runtimes":["codex"]}"#,
        )
        .unwrap();
        let error = ClaudeRuntime::resolve(&bundle, &store).expect_err("must refuse");
        assert!(error.contains("not in this bundle"), "{error}");
    }

    #[test]
    fn a_claude_block_without_installed_fails_from_manifest() {
        let mut block = claude_block(json!({}));
        block["claude"].as_object_mut().unwrap().remove("installed");
        let error = ClaudeLookup::from_manifest(&manifest_from(block)).expect_err("must refuse");
        assert!(error.contains("installed"), "{error}");

        let mut block = claude_block(json!({}));
        block["claude"].as_object_mut().unwrap().remove("store_exe");
        assert!(ClaudeLookup::from_manifest(&manifest_from(block)).is_err());

        for key in ["names", "candidates"] {
            let mut block = claude_block(json!({}));
            block["claude"]["installed"].as_object_mut().unwrap().remove(key);
            assert!(ClaudeLookup::from_manifest(&manifest_from(block)).is_err(), "{key}");
        }
    }

    #[test]
    fn the_manifest_values_are_taken_as_written() {
        let lookup =
            ClaudeLookup::from_manifest(&manifest_from(claude_block(json!({})))).unwrap();
        assert_eq!(lookup.store_exe, "claude.exe");
        assert_eq!(lookup.names, vec!["claude.exe".to_string()]);
        assert_eq!(lookup.candidates.len(), 1);
    }

    #[test]
    fn the_manifest_installed_block_overrides_the_defaults() {
        let value = claude_block(json!({
            "store_exe": "claude-x.exe",
            "installed": {"names": ["a.exe", "b.exe"], "candidates": ["%X%/a.exe"]}
        }));
        let lookup = ClaudeLookup::from_manifest(&manifest_from(value)).unwrap();
        assert_eq!(lookup.store_exe, "claude-x.exe");
        assert_eq!(lookup.names, vec!["a.exe".to_string(), "b.exe".to_string()]);
        assert_eq!(lookup.candidates.len(), 1);
    }

    #[test]
    fn non_exe_or_path_shaped_names_are_refused() {
        for bad in ["claude.cmd", "claude.ps1", r"..\claude.exe", "sub/claude.exe", r"C:\x\claude.exe", ""] {
            let value = claude_block(json!({"installed": {"names": [bad], "candidates": ["%X%/a.exe"]}}));
            assert!(ClaudeLookup::from_manifest(&manifest_from(value)).is_err(), "{bad}");
            let value = claude_block(json!({"store_exe": bad}));
            assert!(ClaudeLookup::from_manifest(&manifest_from(value)).is_err(), "{bad}");
        }
    }

    #[test]
    fn expand_env_fills_percent_variables_and_refuses_unset_ones() {
        std::env::set_var("FALCON_TEST_CLAUDE_DIR", r"C:\u");
        assert_eq!(
            expand_env(r"%FALCON_TEST_CLAUDE_DIR%\bin\c.exe"),
            Some(PathBuf::from(r"C:\u\bin\c.exe"))
        );
        assert_eq!(expand_env(r"%FALCON_TEST_UNSET_VAR_X%\c.exe"), None);
    }

    #[test]
    fn resolve_refuses_a_bundle_missing_its_staged_sdk() {
        let (_root, bundle, store) = synthetic_bundle(b"pretend claude.exe", None);
        std::fs::remove_file(
            bundle.join("sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"),
        )
        .unwrap();
        let error = ClaudeRuntime::resolve(&bundle, &store).expect_err("must refuse");
        assert!(error.contains("bundle SDK missing"), "{error}");
    }

    /// Minimal scoped temp directory; the crate has no dev-dependencies and
    /// this is not worth adding one for.
    mod tempdir {
        use std::path::{Path, PathBuf};
        use std::sync::atomic::{AtomicU64, Ordering};

        static COUNTER: AtomicU64 = AtomicU64::new(0);

        pub struct Dir(PathBuf);

        impl Dir {
            pub fn new() -> Self {
                let unique = format!(
                    "falcon-test-{}-{}",
                    std::process::id(),
                    COUNTER.fetch_add(1, Ordering::SeqCst)
                );
                let path = std::env::temp_dir().join(unique);
                std::fs::create_dir_all(&path).unwrap();
                Self(path)
            }

            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn falcon_records_are_bookkeeping_and_never_reach_a_client() {
        let driver = ClaudeDriver::new(&params("default"));
        let (observed, _) = driver.observe(&json!({
            "type": "falcon", "subtype": "outcome", "cid": 1, "state": "applied"
        }));
        assert!(matches!(observed, Observed::Consumed));
        let (observed, conversation) = driver.observe(&json!({
            "type": "system", "subtype": "init",
            "session_id": "c4ee6c0d-1111-2222-3333-444444444444"
        }));
        assert!(matches!(observed, Observed::Forward));
        assert_eq!(
            conversation.as_deref(),
            Some("c4ee6c0d-1111-2222-3333-444444444444")
        );
    }

    /// Open-task bookkeeping against the SDK's task message shapes (sdk.d.ts
    /// `SDKTaskStartedMessage`, `SDKTaskNotificationMessage`,
    /// `SDKTaskUpdatedMessage`, `SDKBackgroundTasksChangedMessage`). Each row
    /// starts from `before` open ids, observes one message, and names the
    /// open set that must follow.
    #[test]
    fn task_messages_open_and_close_the_idle_blocking_set() {
        fn changed(tasks: Value) -> Value {
            json!({"type": "system", "subtype": "background_tasks_changed",
                   "tasks": tasks, "uuid": "u", "session_id": "s"})
        }
        fn updated(id: &str, status: &str) -> Value {
            json!({"type": "system", "subtype": "task_updated", "task_id": id,
                   "patch": {"status": status}, "uuid": "u", "session_id": "s"})
        }
        let rows: Vec<(&str, Vec<&str>, Value, Vec<&str>)> = vec![
            (
                "task_started opens",
                vec![],
                json!({"type": "system", "subtype": "task_started", "task_id": "t1",
                       "description": "bg", "uuid": "u", "session_id": "s"}),
                vec!["t1"],
            ),
            (
                "ambient task_started does not open",
                vec![],
                json!({"type": "system", "subtype": "task_started", "task_id": "t1",
                       "description": "watch", "ambient": true, "uuid": "u", "session_id": "s"}),
                vec![],
            ),
            (
                "task_notification closes",
                vec!["t1", "t2"],
                json!({"type": "system", "subtype": "task_notification", "task_id": "t1",
                       "status": "completed", "output_file": "o", "summary": "done",
                       "uuid": "u", "session_id": "s"}),
                vec!["t2"],
            ),
            ("task_updated completed closes", vec!["t1"], updated("t1", "completed"), vec![]),
            ("task_updated failed closes", vec!["t1"], updated("t1", "failed"), vec![]),
            ("task_updated killed closes", vec!["t1"], updated("t1", "killed"), vec![]),
            ("task_updated running keeps", vec!["t1"], updated("t1", "running"), vec!["t1"]),
            (
                "background_tasks_changed replaces with non-ambient ids",
                vec!["stale", "flips"],
                changed(json!([
                    {"task_id": "new1", "task_type": "local_agent", "description": "a"},
                    {"task_id": "new2", "task_type": "local_bash", "description": "b",
                     "ambient": false},
                    {"task_id": "flips", "task_type": "local_bash", "description": "c",
                     "ambient": true}
                ])),
                vec!["new1", "new2"],
            ),
        ];
        for (name, before, message, after) in rows {
            let driver = ClaudeDriver::new(&params("default"));
            *lock(&driver.open_tasks) = before.iter().map(|id| id.to_string()).collect();
            let (observed, _) = driver.observe(&message);
            assert!(matches!(observed, Observed::Forward), "{name}: must forward");
            let expected: HashSet<String> = after.iter().map(|id| id.to_string()).collect();
            assert_eq!(*lock(&driver.open_tasks), expected, "{name}");
            assert_eq!(driver.open_tasks(), after.len(), "{name}");
        }
    }
}
