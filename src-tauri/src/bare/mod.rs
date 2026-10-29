//! src-tauri\src\bare\mod.rs — launch profiles for agent tabs. Wiring only:
//! the rejection rule, profile loading and the spawn line; the env lives in `env.rs`, the home
//! (location, ACL, lock, generated settings) in `home.rs`, the per-launch record in `manifest.rs`,
//! a row's rune sets built into the payload in `layer.rs`.
//! Two agents: Raw Claude (`admit`/`prepare`, a PTY line, pty.rs) and Rendered Codex
//! (`admit_rendered`/`prepare_codex`, `node codex.js app-server`, agent.rs), plus the
//! Falcon-hosted Rendered Claude tab (`admit_hosted`/`prepare_hosted_for`: the home only; Falcon
//! builds the env from the same `env.rs` and the sidecar maps the profile).
//!
//! A Claude spawn may name its row (`LaunchOpts::row_key`): when that vidar.json row carries
//! `sets`, the payload is `<home>\layer\payload-<hash12>.md`, built at spawn, instead of the
//! profile's static `payload.md`; a failed build refuses the spawn. Every Claude spawn, Raw or
//! hosted, runs on its set combination's config dir (`agent_homes::pick`; the empty combination
//! and the adopted one are the profile's own `claude-config`) and carries what its sets resolve to
//! (`set_loadout::resolve`, fold W2 L2a): skills and agents copied flat into that dir (`copies.rs`,
//! its own ledger), guards copied beside them and wired as `settings.json` hooks with the sets'
//! permissions and output style (`claude_launch.rs`), module MCP in the strict `--mcp-config` file
//! (`claude_mcp.rs`). Flow's nodes run on their vault's home (`flow_vault.rs`), never a set's.
//!
//! A Codex spawn may name its row too, once `admit_row_key` has bound the key to a Codex Bare
//! row. When that row has `sets`, or vidar.json `bareSkills` copies skills into
//! `<CODEX_HOME>\skills` (its own ledger, `copies.rs`), the profile's `setsPayload` is built into
//! `<home>\layer\payload-<hash12>.md` (the sets, then a `$name` skills listing); config.toml
//! stays the static payload. The Rendered adapter sends it as `developerInstructions` on
//! `thread/start` (the in-process spawn reply carries the text; the Falcon host reads the payload
//! file), with no length cap. The Raw TUI line writes it to
//! `<codex-home>\vidar-<hash12>.config.toml` (`home::write_codex_profile`) and passes
//! `--profile vidar-<hash12>` after its `rawArgs`: no length cap.
//!
//! A profiled Raw tab sends `profile` and no shell or args: the backend owns the spawn line,
//! `pwsh -NoProfile -Command & '<claude.exe>' <profile args>` (no -NoExit: the tab ends with
//! Claude, never a shell holding the bare env without its flags), with an env built from the
//! allowlist and a freshly generated home. Any failure refuses the spawn with the error as the
//! tab's message; nothing ever falls back to a default launch.
//!
//! A profiled Raw Codex tab is the Codex TUI on the same home and config.toml as the Rendered
//! Bare row: `node <codex.js> <rawArgs> [--profile vidar-<hash12>]`, spawned directly
//! (no pwsh host, `Surface::Tui`); pty.rs refuses a home-folder cwd before the prepare writes it
//! as the trusted project.

mod agent_homes;
pub(crate) mod bundles;
pub mod claude_dir;
use claude_dir::listed_sets;
mod claude_launch;
mod claude_line;
mod claude_mcp;
mod claude_profile;
use claude_profile::point_env_at;
mod codex_builtin;
mod codex_caps;
mod codex_hooks;
mod codex_hosted;
pub(crate) mod codex_mcp;
mod codex_profile;
pub(crate) mod codex_runes_loaded;
// Shared with Falcon by `#[path]`; `read_admitted`/`admit_and_read` are the host's half.
#[allow(dead_code)]
pub(crate) mod codex_payload;
pub(crate) mod codex_roles;
pub mod codex_trust;
mod codex_user_trust;
mod codex_verify;
pub(crate) mod copies;
mod env;
pub(crate) mod flow_vault;
pub(crate) mod guards;
pub(crate) mod home;
mod home_path;
mod home_toml;
#[cfg(test)]
mod home_model_tests;
#[cfg(test)]
mod style_and_builtin_tests;
mod identity;
pub(crate) mod kit;
pub(crate) mod library_delete;
pub(crate) mod item_import;
mod launch_row;
pub(crate) mod layer;
mod login_link;
mod login_link_claude;
mod login_link_codex;
#[cfg(not(test))] pub(crate) use login_link::start_login_sweep;
mod recall_skill;
pub(crate) mod manifest;
pub(crate) mod rune_items;
pub(crate) mod set_layer;
pub(crate) mod set_loadout;
pub(crate) mod sets_list;
pub(crate) mod vault;
pub(crate) mod vault_spawn;

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use agent_homes::Agent;
pub use env::Env;
pub use claude_launch::{prepare, prepare_hosted_for};
#[cfg(test)]
pub(crate) use claude_launch::{prepare_hosted_with, prepare_with};
pub use set_layer::Ambient;
pub use launch_row::{admit_row_key, row_key_of, LaunchSetRef};
pub(crate) use codex_verify::{codex_warning, read_accepted};
pub use codex_hosted::{prepare_codex_hosted, CodexHostedLaunch};
#[cfg(test)]
pub(crate) use codex_verify::{Accepted, AcceptedMap};
use codex_verify::verify_new_codex;
use launch_row::vault_for;
use vault_spawn::SessionSeed;

/// Launch profiles this build knows. Anything else is refused before a home is touched.
pub const PROFILES: &[&str] = &["bare"];

/// Design 9 rejection, before any home is prepared: an unknown profile id, a vendor row with a
/// profile, or a profiled spawn that carries its own shell or args (a frontend still injecting).
/// The backend sees no row key, so a vendor row is recognised by the launcher it carries; the
/// frontend also names the row's agent (its roster id), which must be Claude or Codex. A role row
/// (Astra) is a Codex row carrying its own args, so the args rule refuses it here too.
pub fn admit(profile: &str, agent: Option<&str>, shell: Option<&str>, args: Option<&[String]>) -> Result<(), String> {
    if !PROFILES.contains(&profile) {
        return Err(format!("Unknown launch profile {profile:?}; spawn refused"));
    }
    if agent.and_then(crate::agent_spec::parse).is_none() {
        return Err(format!("The {profile:?} profile is for Raw Claude and Raw Codex rows only (agent {agent:?}); spawn refused"));
    }
    let carried = shell.into_iter().chain(args.unwrap_or_default().iter().map(String::as_str));
    if carried.into_iter().any(|a| a.to_ascii_lowercase().contains("vendor-tab.ps1")) {
        return Err(format!("A vendor row cannot carry the {profile:?} profile; spawn refused"));
    }
    if shell.is_some() || args.is_some() {
        return Err(format!("A {profile:?} spawn carries no shell or args (Vidar builds them); spawn refused"));
    }
    Ok(())
}

#[derive(Deserialize)]
struct Named {
    name: String,
}

#[derive(Deserialize)]
struct Host {
    name: String,
    args: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    id: String,
    agent: String,
    binary: Named,
    verified_version: String,
    host: Host,
    args: Vec<String>,
    payload: String,
    /// The payload template a row's rune sets fill (`{{sets}}`); only read when a row has sets.
    #[serde(default)]
    sets_payload: Option<String>,
    settings_template: String,
    settings_target: String,
    home_dirs: Vec<String>,
    overlay: BTreeMap<String, String>,
    plugins: Vec<String>,
    /// The Falcon-hosted Rendered Bare tab's additions (P5); the Raw line never reads it.
    #[serde(default)]
    rendered: Option<RenderedBlock>,
    /// Login files hardlinked to the one store beside the homes (`login_link.rs`, slice 2 A-D4).
    #[serde(default)]
    shared_login: Vec<login_link::SharedLogin>,
}

/// `rendered` in a Claude profile: the env overlay Falcon lays over the profile's own (Falcon and
/// the sidecar read the file themselves). Its `plugins` list must stay empty: a hosted session's
/// plugins are its vault's plugin runes, sent by name (`HostedLaunch.plugin_names`).
#[derive(Deserialize)]
struct RenderedBlock {
    plugins: Vec<String>,
}

fn under(base: &Path, rel: &str) -> PathBuf {
    rel.split(['/', '\\']).filter(|s| !s.is_empty()).fold(base.to_path_buf(), |p, s| p.join(s))
}

pub(crate) use claude_profile::claude_homes_for_profile_with;
use claude_profile::{check_config_in_home, check_isolation, claude_legacy_dir, config_dir_of, load_profile, log_mirror_skip, mirror_claude_seen, read_remote_control};

// The payload's marker line and the hash it must carry (`codex_payload`, Falcon's check too).
use codex_payload::payload_marker;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// pwsh single-quoted literal.
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// First token of `claude --version` (`2.1.296 (Claude Code)`) when it is a dotted number.
fn parse_version(stdout: &str) -> Option<String> {
    let t = stdout.split_whitespace().next()?;
    (t.split('.').count() >= 2 && t.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())))
        .then(|| t.to_string())
}

/// `<exe> --version` under the bare env (never Vidar's), no console, killed after 5 s. Cached per
/// path, size and mtime, so only the first bare spawn after a Claude update pays for it. An
/// unreadable version is never cached: the next spawn tries again.
fn read_version(exe: &Path, env: &Env) -> Option<String> {
    type Key = (PathBuf, u64, Option<SystemTime>);
    static CACHE: Mutex<Vec<(Key, String)>> = Mutex::new(Vec::new());
    let meta = std::fs::metadata(exe).ok()?;
    let key: Key = (exe.to_path_buf(), meta.len(), meta.modified().ok());
    if let Some((_, v)) = CACHE.lock().ok()?.iter().find(|(k, _)| *k == key) {
        return Some(v.clone());
    }
    let v = run_version(exe, env)?;
    if let Ok(mut c) = CACHE.lock() {
        c.push((key, v.clone()));
    }
    Some(v)
}

fn run_version(exe: &Path, env: &Env) -> Option<String> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(exe);
    cmd.arg("--version").env_clear().stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    for (k, v) in env.iter() {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().ok()?;
    let mut out = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let buf = rx.recv_timeout(Duration::from_secs(1)).ok()?;
    parse_version(&String::from_utf8_lossy(&buf))
}

/// `name` on the built env's `Path` (exact filename, aliases included).
fn find_on_env_path(env: &Env, name: &str) -> Option<PathBuf> {
    let dirs: Vec<PathBuf> = std::env::split_paths(env.get("Path")?).filter(|d| !d.as_os_str().is_empty()).collect();
    crate::which::find_in(&dirs, name)
}

/// `<root>\plugins\<name>`, refused unless the name is plain and the folder exists.
fn plugin_dir(root: &Path, name: &str) -> Result<PathBuf, String> {
    let dir = root.join("plugins").join(name);
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') || !dir.is_dir() {
        return Err(format!("Bare plugin {name:?} not found at {}; spawn refused", dir.display()));
    }
    Ok(dir)
}

/// Per-spawn options for the Claude prepares (Raw and hosted) and the Codex one.
#[derive(Default, Clone, Copy)]
pub struct LaunchOpts<'a> {
    /// The launching row's `key`. Since L2a nothing reads it: a row's `sets` never reach a session
    /// (model R1). Kept so the IPC callers' shape holds until L3a. A Codex spawn's key is admitted
    /// first (`admit_row_key`).
    #[allow(dead_code)]
    pub row_key: Option<&'a str>,
    /// The vidar.json the row is read from; `None` is `paths::config_path()` (tests set it).
    pub config: Option<&'a Path>,
    /// The normal `.claude.json` the seen-counters mirror reads. The public `prepare` and
    /// `prepare_hosted_for` fill it from the real home; `None` (tests) logs a skip.
    pub claude_json: Option<&'a Path>,
    /// The Rune Vault the spawn loads (`launch_row::vault_for`); a `stock-*` id is made from its
    /// template. Unknown refuses.
    pub vault: Option<&'a str>,
    /// Transition until L3a sends a vault id: the spawn IPC's `sets` list, turned into a Custom vault
    /// (`Store::create_custom`). Read only when `vault` is `None`; neither refuses.
    pub custom_sets: Option<&'a [LaunchSetRef]>,
}

/// The vidar.json a spawn reads: the opts' file, else the live one. A test without `config`
/// reads no file, never the checkout's live vidar.json (its `bareGuards` name machine paths).
fn config_of(opts: &LaunchOpts) -> PathBuf {
    match opts.config {
        Some(p) => p.to_path_buf(),
        None if cfg!(test) => std::env::temp_dir().join("vidar-bare-tests-no-config.json"),
        None => crate::paths::config_path(),
    }
}

/// The payload a Claude spawn hands over: the profile's static file, or the row's sets built
/// into `<home>\layer\` under the caller's lock.
struct PayloadChoice {
    path: PathBuf,
    bytes: Vec<u8>,
    marker: String,
    sets: Vec<String>,
    warnings: Vec<String>,
}

/// `text` is the vault's rendered runes (`set_loadout::resolve_vault`), filled into the profile's
/// `setsPayload`; `None` keeps the static payload. `sets` (the vault's `library/set` runesets) is
/// recorded either way.
fn choose_payload(lock: &home::HomeLock, p: &Profile, root: &Path, home_dir: &Path, text: Option<&str>, sets: &[String], guard: &home::Guard) -> Result<PayloadChoice, String> {
    if let Some(text) = text {
        let rel = p.sets_payload.as_deref().ok_or_else(|| format!("Launch profile {:?} has no setsPayload, so rune sets cannot load; Bare spawn refused", p.id))?;
        let tpl_path = under(root, rel);
        let template = crate::fsx::read_text(&tpl_path).map_err(|e| format!("Bare sets payload {}: {e}; Bare spawn refused", tpl_path.display()))?;
        let b = layer::build_text_payload(lock, root, home_dir, &template, text, guard)?;
        return Ok(PayloadChoice { path: b.path, bytes: b.bytes, marker: b.marker, sets: sets.to_vec(), warnings: Vec::new() });
    }
    let path = under(root, &p.payload);
    let text = crate::fsx::read_text(&path).map_err(|e| format!("Bare payload {}: {e}", path.display()))?;
    let (marker, _) = payload_marker(&text)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("Bare payload {}: {e}", path.display()))?;
    Ok(PayloadChoice { path, bytes, marker, sets: sets.to_vec(), warnings: Vec::new() })
}

impl PayloadChoice {
    fn record(&self) -> manifest::Payload {
        manifest::Payload {
            path: self.path.to_string_lossy().into_owned(),
            sha256: hex(&Sha256::digest(&self.bytes)),
            marker: self.marker.clone(),
            sets: self.sets.clone(),
            warnings: self.warnings.clone(),
        }
    }
}

/// Seams for the tests: binary lookup and version read.
pub struct Probes<'a> {
    pub find: &'a dyn Fn(&Env, &str) -> Option<PathBuf>,
    pub version: &'a dyn Fn(&Path, &Env) -> Option<String>,
    /// The user's own `remoteControlAtStartup` (true only when set to boolean true).
    pub remote_control: &'a dyn Fn() -> bool,
}

/// `settings.json` text -> whether `remoteControlAtStartup` is boolean true; anything else is off.
pub fn parse_remote_control(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text).ok().and_then(|v| v.get("remoteControlAtStartup").and_then(|b| b.as_bool())).unwrap_or(false)
}

/// A prepared bare launch. Holds the home lock until dropped (after the spawn).
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Env,
    manifest: manifest::Manifest,
    file_stamp: String,
    manifests_dir: PathBuf,
    /// The session record `write_manifest` adds (model R4); `None` only for the test no-vault spawn.
    seed: Option<SessionSeed>,
    _lock: home::HomeLock,
}

/// A Claude profile's env over `inherited`: the allowlist, the overlay with `{{root}}`/`{{home}}`
/// filled, `HOMEDRIVE`/`HOMEPATH` from its `USERPROFILE`. The bare spawn and the login card's
/// `claude auth login` (claude_login.rs) both build it here.
fn profile_env(p: &Profile, root: &Path, home_dir: &Path, inherited: impl IntoIterator<Item = (OsString, OsString)>) -> Env {
    let (root_s, home_s) = (root.to_string_lossy().into_owned(), home_dir.to_string_lossy().into_owned());
    let fill = |s: &str| s.replace("{{root}}", &root_s).replace("{{home}}", &home_s);
    let mut env = env::allowlisted(inherited);
    for (k, v) in &p.overlay {
        env.set(k, fill(v));
    }
    let profile_dir = fill(&p.overlay.get("USERPROFILE").cloned().unwrap_or_default());
    if let Some((drive, path)) = env::split_home(&profile_dir) {
        env.set("HOMEDRIVE", drive);
        env.set("HOMEPATH", path);
    }
    env
}

/// The env `claude auth login` runs under for a profiled tab: the same builder as the profile's
/// spawn, so the login lands in the profile's home and no inherited credential var rides along.
/// Touches no home (no dirs, lock or settings): the login only writes the config dir.
pub fn login_env(profile: &str, inherited: impl IntoIterator<Item = (OsString, OsString)>) -> Result<Env, String> {
    login_env_with(profile, &crate::paths::root(), &home::resolve()?, inherited)
}

pub fn login_env_with(profile_id: &str, root: &Path, home_dir: &Path, inherited: impl IntoIterator<Item = (OsString, OsString)>) -> Result<Env, String> {
    if !PROFILES.contains(&profile_id) {
        return Err(format!("No Claude home for the {profile_id:?} profile; login refused"));
    }
    let p = load_profile(root, profile_id)?;
    check_config_in_home(&p, root, home_dir)?;
    Ok(profile_env(&p, root, home_dir, inherited))
}

impl Launch {
    /// Records the launch (create-new) with the final env names, tab variables included. An
    /// error refuses the spawn: a bare tab never runs unrecorded.
    pub fn write_manifest<'a>(&mut self, tab: &str, env_names: impl IntoIterator<Item = &'a str>) -> Result<PathBuf, String> {
        self.manifest.tab = tab.to_string();
        self.manifest.env_names = env_names.into_iter().map(str::to_string).collect();
        let written = manifest::write(&self.manifests_dir, &self.file_stamp, &self.manifest)?;
        vault_spawn::write_record(self.seed.as_ref(), tab, None, Path::new(&self.manifest.homes.claude_config))?;
        Ok(written)
    }
}

// ---- Claude Rendered (Falcon-hosted, falcon/session_commands.rs) ----

/// Design 9 for a hosted Rendered Claude spawn: a known profile, carrying no rules file (a bare
/// tab's layer comes from the profile) and no gateway (a vendor tab is its own identity). Claude
/// only: a profiled Codex spawn takes `admit_rendered` and `prepare_codex_hosted` instead.
pub fn admit_hosted(profile: &str, rules_file: Option<&str>, gateway: Option<&str>) -> Result<(), String> {
    if !PROFILES.contains(&profile) {
        return Err(format!("Unknown launch profile {profile:?}; spawn refused"));
    }
    if rules_file.is_some_and(|f| !f.trim().is_empty()) {
        return Err(format!("A {profile:?} spawn carries no rules file (its layer comes from the profile); spawn refused"));
    }
    if gateway.is_some_and(|g| !g.trim().is_empty()) {
        return Err(format!("A {profile:?} spawn carries no gateway; spawn refused"));
    }
    Ok(())
}

/// A prepared hosted bare launch: the home is ready (the lock is released once `settings.json`
/// is written); Falcon builds the env and the sidecar maps the profile.
pub struct HostedLaunch {
    /// The row's built payload (`<home>\layer\payload-<hash12>.md`), for `SpawnParams.payload_file`;
    /// `None` when the row has no sets and the sidecar reads the profile's own payload.
    pub payload_file: Option<PathBuf>,
    /// Strict MCP config under the Bare home's layer, present on every launch.
    pub mcp_file: Option<PathBuf>,
    /// The launch's `CLAUDE_CONFIG_DIR` (its set combination's home, or the profile's own), for
    /// `SpawnParams.claude_config_dir`; checked by `check_claude_config_dir` before it is set.
    pub claude_config_dir: Option<PathBuf>,
    /// The vault's plugin rune names, for `SpawnParams.plugin_names`: Falcon admits each from
    /// `<root>\plugins\<name>` and the sidecar loads it.
    pub plugin_names: Vec<String>,
    /// The vault's model rune; beats the row's model at spawn (`falcon/session_commands.rs`).
    pub model: Option<String>,
    manifest: manifest::Manifest,
    file_stamp: String,
    manifests_dir: PathBuf,
    seed: Option<SessionSeed>,
}

impl HostedLaunch {
    /// The warnings Raw prints on its spawn line (rune build, guards, copies, login, git identity),
    /// in Raw's order; the hosted tab shows them in its notice area. There is no binary warning:
    /// Falcon resolves claude.exe.
    pub fn bare_warnings(&self) -> Vec<String> {
        self.manifest.payload.warnings.iter().chain(&self.manifest.warnings).cloned().collect()
    }

    /// Records the launch (create-new) once Falcon's reply names the session and the env it
    /// built. An error ends the session (`end_unhonoured_spawn`): a bare tab never runs unrecorded.
    pub fn write_manifest<'a>(&mut self, tab: &str, falcon_session: &str, env_names: impl IntoIterator<Item = &'a str>) -> Result<PathBuf, String> {
        self.manifest.tab = tab.to_string();
        self.manifest.falcon_session = Some(falcon_session.to_string());
        self.manifest.env_names = env_names.into_iter().map(str::to_string).collect();
        let written = manifest::write_hosted(&self.manifests_dir, &self.file_stamp, &self.manifest, self.mcp_file.as_deref())?;
        vault_spawn::write_record(self.seed.as_ref(), tab, Some(falcon_session), Path::new(&self.manifest.homes.claude_config))?;
        Ok(written)
    }
}

// ---- Codex Rendered (in-process app-server, agent.rs) ----

/// Design 9 for the in-process Rendered spawn (agent.rs `spawn_codex_appserver`): a known profile
/// on the Codex row only, carrying no rules file (a bare tab's layer comes from the profile).
/// Claude Rendered is Falcon-hosted and never reaches this path; Codex Raw goes through `admit`,
/// which still refuses every non-Claude row.
pub fn refuse_profile_cwd(cwd: &str, user_profile: Option<&str>) -> Result<(), String> {
    use home::norm_cwd as norm;
    let (up, c) = (user_profile.map(norm).filter(|u| !u.is_empty()), norm(cwd));
    // A drive root normalises to "c:" and is a parent too; an empty cwd is not a directory anyway.
    if up.is_some_and(|up| !c.is_empty() && (up == c || up.starts_with(&format!("{c}\\")))) {
        return Err(format!("Bare Codex refused: cwd {cwd} is the user profile or one of its parents; open the tab in the sandbox trial-repo"));
    }
    refuse_vidar_cwd(cwd, &crate::paths::root())
}

/// A folder as lowercase components: `norm_cwd` spelling, then `.` dropped and `..` applied.
fn cwd_parts(p: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in home::norm_cwd(p).split('\\') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            _ => out.push(part.to_string()),
        }
    }
    out
}

/// The runtime folder's name, read from the paths contract (`bridge` sits directly under it).
fn runtime_part() -> String {
    let rel = crate::paths::rel("bridge");
    rel.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// True when `cwd` is the Vidar root, one of its ancestors, or inside `<root>\runtime` outside
/// `runtime\worktrees\<name>` (a bare `runtime\worktrees` is refused too). Parts are compared.
fn vidar_cwd_hit(cwd: &[String], root: &[String]) -> bool {
    if cwd.len() <= root.len() {
        return cwd == &root[..cwd.len()];
    }
    if cwd[..root.len()] != *root || cwd[root.len()] != runtime_part() {
        return false;
    }
    !(cwd.len() > root.len() + 2 && cwd[root.len() + 1] == "worktrees")
}

/// The refusal for Vidar's folder; the Rendered tab's card matches it (`VIDAR_CWD_REFUSED` in
/// src/panels/rendered/lifecycle.ts) and offers a worktree.
pub const VIDAR_CWD_REFUSED: &str = "Codex Can't Start in Vidar's Folder: Its Sandbox Could Write Vidar's Launch Files";

/// A Codex Bare sandbox can write its launch folder, so that folder must not hold Vidar's own
/// trusted launch surfaces (vidar.json, runtime\bridge\falcon\frontend): refuses the Vidar root,
/// any ancestor of it and anything under `<root>\runtime` except `runtime\worktrees\<name>` and
/// below. Compared by text, then again by canonical path where the folder exists (a junction).
pub fn refuse_vidar_cwd(cwd: &str, root: &Path) -> Result<(), String> {
    let root_s = root.to_string_lossy();
    let root_parts = cwd_parts(&root_s);
    let mut forms = vec![cwd_parts(cwd)];
    if let Ok(c) = std::fs::canonicalize(cwd.trim()) {
        forms.push(cwd_parts(&c.to_string_lossy()));
    }
    let mut roots = vec![root_parts];
    if let Ok(c) = std::fs::canonicalize(root) {
        roots.push(cwd_parts(&c.to_string_lossy()));
    }
    if cwd.trim().is_empty() {
        return Ok(());
    }
    if forms.iter().any(|f| roots.iter().any(|r| vidar_cwd_hit(f, r))) {
        return Err(VIDAR_CWD_REFUSED.to_string());
    }
    Ok(())
}

pub use codex_profile::{admit_rendered, codex_homes_for_profile_with, home_unopened, CodexProbes};
use codex_profile::{codex_home_of, load_codex_profile};

/// Where the profile finds Codex (D7), never through `APPDATA` (the sandbox redirects it): the npm
/// shim folder on the allowlisted `Path` that holds one of `shims`, then `script` and `package`
/// under it.
#[derive(Deserialize)]
pub struct CodexBinary {
    pub shims: Vec<String>,
    pub script: String,
    pub package: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexProfile {
    id: String,
    agent: String,
    binary: CodexBinary,
    verified_version: String,
    host: Named,
    /// The app-server line's args (Rendered, `Surface::AppServer`).
    args: Vec<String>,
    /// The TUI line's args (Raw, `Surface::Tui`); a profile without them has no Raw row.
    #[serde(default)]
    raw_args: Option<Vec<String>>,
    /// The one-shot `codex exec` line's args (`Surface::Exec`, the runes probe); the prompt rides after.
    #[serde(default)]
    exec_args: Option<Vec<String>>,
    payload: String,
    /// The template a row's rune sets and the copied skills listing fill (`{{sets}}`); read only
    /// when the spawn builds instructions.
    #[serde(default)]
    sets_payload: Option<String>,
    config_template: String,
    config_target: String,
    home_dirs: Vec<String>,
    overlay: BTreeMap<String, String>,
    /// Read only to refuse it (Orion r1 S4): Codex's `auth.json` is shared by
    /// `login_link::sync_codex` itself, never from a profile entry (Falcon refuses one too).
    #[serde(default)]
    shared_login: Vec<login_link::SharedLogin>,
}

/// Fills a profile string's `{{root}}` and `{{home}}` (the live spawn and the lookup share it).
fn fill_placeholders(s: &str, root: &Path, home_dir: &Path) -> String {
    s.replace("{{root}}", &root.to_string_lossy()).replace("{{home}}", &home_dir.to_string_lossy())
}

/// A Bare Codex profile's `CODEX_HOME` with no live session, for readers (MCP Rack, Loadout).
/// Read-only: Err when the profile row or the home folder is missing, and it never creates a
/// home (a new `CODEX_HOME` triggers UAC and resets the sandbox passwords).
pub fn codex_home_for_profile(profile_id: &str) -> Result<PathBuf, String> {
    codex_home_for_profile_with(profile_id, &crate::paths::root(), &home::resolve()?)
}

pub fn codex_home_for_profile_with(profile_id: &str, root: &Path, home_dir: &Path) -> Result<PathBuf, String> {
    let p = load_codex_profile(root, profile_id)?;
    let dir = codex_home_of(&p, root, home_dir).ok_or_else(|| format!("Bare Codex profile {profile_id:?} sets no CODEX_HOME"))?;
    match dir.is_dir() {
        true => Ok(dir),
        false => Err(codex_profile::unopened_message(&dir)),
    }
}

/// One agent home of a Bare profile with the sets of its combination (empty on the legacy home
/// unless the seed maps one onto it).
#[derive(Debug, Clone, PartialEq)]
pub struct AgentHomeInfo {
    pub dir: PathBuf,
    pub sets: Vec<String>,
}

pub type CodexHomeInfo = AgentHomeInfo;

/// Every Codex home of a Bare profile for readers: the legacy home first, then each indexed
/// combination home (W3 L9). Read-only like `codex_home_for_profile`: Err when the profile or its
/// legacy home is missing, and nothing is created.
pub fn codex_homes_for_profile(profile_id: &str) -> Result<Vec<CodexHomeInfo>, String> {
    codex_homes_for_profile_with(profile_id, &crate::paths::root(), &home::resolve()?)
}

/// D7 resolver: the first allowlisted `Path` folder holding a shim and the script beside it, and
/// the version from the package's `package.json` (no process is run).
pub fn resolve_codex(env: &Env, bin: &CodexBinary) -> Option<(PathBuf, Option<String>)> {
    let dirs = std::env::split_paths(env.get("Path")?).filter(|d| !d.as_os_str().is_empty()).collect::<Vec<_>>();
    for dir in dirs {
        if !bin.shims.iter().any(|s| dir.join(s).is_file()) {
            continue;
        }
        let js = under(&dir, &bin.script);
        if js.is_file() {
            let version = crate::fsx::read_json::<serde_json::Value>(&under(&dir, &bin.package))
                .ok()
                .and_then(|v| v.get("version")?.as_str().map(str::to_string));
            return Some((js, version));
        }
    }
    None
}

/// Which Codex line a prepare builds: the in-process app-server (Rendered, agent.rs) or the TUI
/// in a PTY (Raw, pty.rs). The only difference is the profile's `args` vs `rawArgs`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    AppServer,
    Tui,
    /// `codex exec` one-shot (profile `execArgs`), payload as a profile file like the TUI; only the
    /// runes probe (`probe_runes_tests`) builds it.
    #[cfg_attr(not(test), allow(dead_code))]
    Exec,
}

/// A prepared bare Codex launch: `node <codex.js> app-server` (or the TUI's `rawArgs`) with the
/// built env. Holds the home lock until dropped (after the spawn).
pub struct CodexLaunch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Env,
    /// The tab's `CODEX_HOME` (status.rs reads the tab's own rollouts and config from it).
    pub codex_home: PathBuf,
    /// D7: a version other than the verified one, or an unreadable one; the launch goes ahead.
    pub warning: Option<String>,
    /// The built payload's text for the app-server surface: the Rendered adapter sends it as
    /// `developerInstructions` on `thread/start`. None on the Raw TUI line (a `--profile` file) and
    /// for a row with a static payload.
    pub developer_instructions: Option<String>,
    manifest: manifest::Manifest,
    file_stamp: String,
    manifests_dir: PathBuf,
    seed: Option<SessionSeed>,
    _lock: home::HomeLock,
}

impl CodexLaunch {
    /// Same contract as `Launch::write_manifest`: no record, no spawn.
    pub fn write_manifest<'a>(&mut self, tab: &str, env_names: impl IntoIterator<Item = &'a str>) -> Result<PathBuf, String> {
        self.manifest.tab = tab.to_string();
        self.manifest.env_names = env_names.into_iter().map(str::to_string).collect();
        let written = manifest::write(&self.manifests_dir, &self.file_stamp, &self.manifest)?;
        vault_spawn::write_record(self.seed.as_ref(), tab, None, &self.codex_home)?;
        Ok(written)
    }
}

/// Prepares the real home (the per-install home under LOCALAPPDATA) from Vidar's own env.
/// `cwd` is the tab's launch folder: Bare writes it into config.toml as a trusted project.
pub fn prepare_codex(profile: &str, opts: &LaunchOpts, cwd: &str) -> Result<CodexLaunch, String> {
    let probes = CodexProbes::live();
    let root = crate::paths::root();
    let launch = prepare_codex_in(profile, &root, &home::resolve()?, std::env::vars_os(), &Ambient::from_env(), &home::Guard::from_vidar_env(), &probes, opts, Some(cwd))?;
    verify_new_codex(&launch, &root);
    Ok(launch)
}

/// `prepare_codex` for the Raw TUI in a PTY (pty.rs): the same home, env and config.toml, the
/// profile's `rawArgs` instead of `app-server`. The caller has already refused a home-folder `cwd`.
pub fn prepare_codex_tui(profile: &str, opts: &LaunchOpts, cwd: &str) -> Result<CodexLaunch, String> {
    let probes = CodexProbes::live();
    let root = crate::paths::root();
    let launch = prepare_codex_for(Surface::Tui, profile, &root, &home::resolve()?, std::env::vars_os(), &Ambient::from_env(), &home::Guard::from_vidar_env(), &probes, opts, Some(cwd))?;
    verify_new_codex(&launch, &root);
    Ok(launch)
}

/// A Codex spawn's built instructions: the loaded vault's rendered runes (`text`, from
/// `set_loadout::resolve_vault`) and copied skill-rune listing, filled into the profile's
/// `setsPayload`; `sets` (the vault's runesets) is recorded on the built payload. An empty result
/// refuses the spawn.
#[allow(clippy::too_many_arguments)]
fn codex_instructions(lock: &home::HomeLock, p: &CodexProfile, root: &Path, home_dir: &Path, vault_text: Option<&str>, sets: &[String], skills: &str, guard: &home::Guard) -> Result<Option<layer::BuiltPayload>, String> {
    if vault_text.is_none_or(|text| text.trim().is_empty()) && skills.trim().is_empty() {
        return Err("Rune Vault built an empty Codex payload; Bare spawn refused".into());
    }
    let rel = p.sets_payload.as_deref().ok_or_else(|| format!("Launch profile {:?} has no setsPayload, so rune sets cannot load; Bare spawn refused", p.id))?;
    let tpl_path = under(root, rel);
    let template = crate::fsx::read_text(&tpl_path).map_err(|e| format!("Bare sets payload {}: {e}; Bare spawn refused", tpl_path.display()))?;
    // The template's source comment documents the vault contract; only rune content is delivered.
    let template = template.lines().filter(|line| !line.starts_with("<!-- This Codex session loaded a Rune Vault;"))
        .collect::<Vec<_>>().join("\n").replace("{{root}}", &root.to_string_lossy());
    if template.trim() != "{{sets}}" {
        return Err("Codex vault payload template contains text outside the Rune Vault; Bare spawn refused".into());
    }
    let body = [vault_text.unwrap_or("").trim_end(), skills.trim_end()]
        .into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n\n")
        // The stock identity rune's control CLI line names `{{root}}`, as the template once did.
        .replace("{{root}}", &root.to_string_lossy());
    let mut built = layer::build_text_payload(lock, root, home_dir, &template, &body, guard)?;
    built.sets = sets.to_vec();
    Ok(Some(built))
}

/// The program the bare Codex `notify` hook runs (`tools\desks\codex-notify.ps1` needs pwsh 7).
const PWSH: &str = "pwsh.exe";

/// Shown when no unpackaged pwsh survives the WindowsApps drop (Codex's shell is then Windows PowerShell 5.1).
const SHELL_51_WARNING: &str = "Codex Bare Shell Is Windows PowerShell 5.1: Install PowerShell 7 From the MSI (the Store Build Cannot Run in the Sandbox)";

/// Prepares a Codex Bare home and its spawn from `profile_id` under `root`.
#[cfg(test)]
pub fn prepare_codex_with(
    profile_id: &str,
    root: &Path,
    home_dir: &Path,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    ambient: &Ambient,
    guard: &home::Guard,
    probes: &CodexProbes,
    opts: &LaunchOpts,
) -> Result<CodexLaunch, String> {
    prepare_codex_in(profile_id, root, home_dir, inherited, ambient, guard, probes, opts, None)
}

/// `prepare_codex_with` for a launch folder: `cwd` becomes config.toml's one trusted `[projects]` entry.
#[allow(clippy::too_many_arguments)]
pub fn prepare_codex_in(
    profile_id: &str,
    root: &Path,
    home_dir: &Path,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    ambient: &Ambient,
    guard: &home::Guard,
    probes: &CodexProbes,
    opts: &LaunchOpts,
    cwd: Option<&str>,
) -> Result<CodexLaunch, String> {
    prepare_codex_for(Surface::AppServer, profile_id, root, home_dir, inherited, ambient, guard, probes, opts, cwd)
}

/// `prepare_codex_in` for either surface; a Tui prepare on a profile without `rawArgs` refuses
/// before the home is touched.
#[allow(clippy::too_many_arguments)]
pub fn prepare_codex_for(
    surface: Surface,
    profile_id: &str,
    root: &Path,
    home_dir: &Path,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    ambient: &Ambient,
    guard: &home::Guard,
    probes: &CodexProbes,
    opts: &LaunchOpts,
    cwd: Option<&str>,
) -> Result<CodexLaunch, String> {
    let p = load_codex_profile(root, profile_id)?;
    let line_args = match surface {
        Surface::AppServer => p.args.clone(),
        Surface::Tui => p.raw_args.clone().ok_or_else(|| format!("Launch profile {profile_id:?} has no rawArgs, so it has no Raw Codex row; spawn refused"))?,
        Surface::Exec => p.exec_args.clone().ok_or_else(|| format!("Launch profile {profile_id:?} has no execArgs, so it has no one-shot Codex line; spawn refused"))?,
    };
    // The TUI and exec take the payload as a profile file; the app-server surface hands the text back
    // for the Rendered adapter to send on `thread/start`. Neither has a length cap.
    let route = match surface {
        Surface::AppServer => codex_hosted::PayloadRoute::ThreadStart,
        Surface::Tui | Surface::Exec => codex_hosted::PayloadRoute::ProfileFile,
    };
    let h = codex_hosted::prepare_home(p, root, home_dir, inherited, ambient, guard, probes.find, probes.resolver(), opts, cwd, route, false)?;
    let fill = |s: &str| fill_placeholders(s, root, home_dir);
    let (p, env) = (&h.p, &h.env);
    let node = (probes.find)(env, &p.host.name).ok_or_else(|| format!("{} is not on the allowlisted Path; bare spawn refused", p.host.name))?;
    let (js, version) = (probes.resolver())(env, &p.binary).ok_or_else(|| {
        format!("{} not found beside a {} shim on the allowlisted Path; bare spawn refused", p.binary.script, p.binary.shims.join(" or "))
    })?;
    let accepted = read_accepted(&crate::paths::codex_accepted_path());
    let warning = codex_hosted::join_warnings(codex_warning(version.as_deref(), &p.verified_version, &accepted), h.shell_warning.clone());
    // Raw only: a project `developer_instructions` outranks the profile file that carries the runes.
    let override_warning = h.profile.as_ref().and_then(|_| codex_hosted::project_override_warning(cwd));
    let warning = codex_hosted::join_warnings(warning, override_warning);
    // The in-process banner carries it; the hosted route reads the manifest payload warnings.
    // The manifest's binary warning stays without it: the payload warnings carry the trust warning
    // already, and a launch record reads both (it showed twice in the Runes tab).
    let binary_warning = warning.clone();
    let warning = codex_hosted::join_warnings(warning, h.trust_warning.clone());
    let warning = codex_hosted::join_warnings(warning, (!h.login_warnings.is_empty()).then(|| h.login_warnings.join("; ")));
    let warning = codex_hosted::join_warnings(warning, (!h.unsupported_warnings.is_empty()).then(|| h.unsupported_warnings.join("; ")));
    // MCP `-c` overrides ahead of the subcommand; the record names env values, never holds them.
    let line = |mcp: &[String]| std::iter::once(js.to_string_lossy().into_owned()).chain(mcp.iter().cloned()).chain(line_args.iter().map(|a| fill(a))).collect::<Vec<_>>();
    let (mut args, mut recorded_args) = (line(&h.mcp.args), line(&h.mcp.recorded));
    if let Some(name) = h.profile.clone() {
        let flag = ["--profile".to_string(), name];
        args.extend(flag.clone());
        recorded_args.extend(flag);
    }
    let developer_instructions = match (surface, h.built.as_ref()) {
        (Surface::AppServer, Some(b)) => Some(String::from_utf8_lossy(&b.bytes).into_owned()),
        _ => None,
    };
    let binary = manifest::Binary { path: js.to_string_lossy().into_owned(), version, verified_version: p.verified_version.clone(), warning: binary_warning };
    let (m, file_stamp) = h.manifest(binary, node.to_string_lossy().into_owned(), recorded_args);
    let body = match surface {
        Surface::AppServer => "rendered",
        Surface::Tui => "raw",
        Surface::Exec => "exec",
    };
    // Raw has no first-message hook, so the TUI locks its vault at spawn.
    if let (Surface::Tui, Some(v)) = (surface, h.vault.as_ref()) {
        vault_spawn::lock_at_spawn(root, v)?;
    }
    let seed = SessionSeed::new(root, codex_profile::AGENT, body, h.vault.as_ref(), &h.loadout_hash);
    Ok(CodexLaunch {
        program: node,
        args,
        env: h.env,
        codex_home: h.codex_home,
        warning,
        developer_instructions,
        manifest: m,
        file_stamp,
        manifests_dir: home_dir.join("manifests"),
        seed,
        _lock: h.lock,
    })
}

/// The `verifiedVersion` pinned in `profiles/bare/<agent>.json`: the one literal tests read, so a pin
/// bump never touches a test.
#[cfg(test)]
pub(crate) fn pinned(agent: &str) -> String {
    let path = crate::paths::root().join("profiles").join("bare").join(format!("{agent}.json"));
    let v: serde_json::Value = crate::fsx::read_json(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    v["verifiedVersion"].as_str().expect("verifiedVersion").to_string()
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod env_parity;
#[cfg(test)]
#[cfg(test)]
mod probe_runes_tests;
#[cfg(all(test, feature = "vault-gate"))]
mod vault_gate_tests;
