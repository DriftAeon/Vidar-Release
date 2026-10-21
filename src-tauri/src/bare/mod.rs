//! src-tauri\src\bare\mod.rs — launch profiles for agent tabs (plan Design 1-9). Wiring only:
//! the rejection rule, profile loading and the spawn line; the env lives in `env.rs`, the home
//! (location, ACL, lock, generated settings) in `home.rs`, the per-launch record in `manifest.rs`,
//! a row's rune sets built into the payload in `layer.rs` (Bare slice 1).
//! Two agents: Raw Claude (`admit`/`prepare`, a PTY line, pty.rs) and Rendered Codex
//! (`admit_rendered`/`prepare_codex`, `node codex.js app-server`, agent.rs; plan § P6), plus the
//! Falcon-hosted Rendered Claude tab (`admit_hosted`/`prepare_hosted_for`: the home only; Falcon
//! builds the env from the same `env.rs` and the sidecar maps the profile; plan § P5).
//!
//! A Claude spawn may name its row (`LaunchOpts::row_key`): when that vidar.json row carries
//! `sets`, the payload is `<home>\layer\payload-<hash12>.md`, built at spawn, instead of the
//! profile's static `payload.md`; a failed build refuses the spawn. Every Claude spawn, Raw or
//! hosted, copies vidar.json's `bareGuards` scripts into `<home>\layer\hooks\` and appends them to
//! the generated settings (`guards.rs`); a missing or misnamed script refuses the spawn. Then it
//! syncs vidar.json's `bareSkills` and `bareAgents` into the profile's `CLAUDE_CONFIG_DIR`
//! (`copies.rs`); a copy problem is a warning, never a refusal.
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
//! as the trusted project. Flow reads the same home through `codex_env_for_profile`, read-only.

pub(crate) mod actives;
mod actives_gen;
pub mod claude_dir;
mod codex_hooks;
mod codex_hosted;
pub(crate) mod codex_mcp;
// Shared with Falcon by `#[path]`; `read_admitted`/`admit_and_read` are the host's half.
#[allow(dead_code)]
pub(crate) mod codex_payload;
pub(crate) mod codex_roles;
mod codex_user_trust;
mod codex_verify;
pub(crate) mod copies;
mod env;
mod guards;
pub(crate) mod home;
mod home_path;
mod identity;
pub(crate) mod layer;
mod login_link;
pub(crate) mod manifest;
pub(crate) mod set_layer;
pub(crate) mod set_plugin;

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::Deserialize;
use sha2::{Digest, Sha256};

pub use env::Env;
pub(crate) use codex_verify::{codex_warning, read_accepted};
pub use codex_hosted::{prepare_codex_hosted, CodexHostedLaunch};
#[cfg(test)]
pub(crate) use codex_verify::{Accepted, AcceptedMap};
use codex_verify::verify_new_codex;

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
    if !matches!(agent, Some("claude" | "codex")) {
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

/// `rendered` in a Claude profile: the plugin set the hosted sidecar loads and the env overlay
/// Falcon lays over the profile's own (Falcon and the sidecar read the file themselves; Vidar
/// checks the plugins exist before it prepares the home, and records them).
#[derive(Deserialize)]
struct RenderedBlock {
    plugins: Vec<String>,
}

fn under(base: &Path, rel: &str) -> PathBuf {
    rel.split(['/', '\\']).filter(|s| !s.is_empty()).fold(base.to_path_buf(), |p, s| p.join(s))
}

fn load_profile(root: &Path, id: &str) -> Result<Profile, String> {
    let path = root.join("profiles").join(id).join("claude.json");
    let p: Profile = crate::fsx::read_json(&path).map_err(|e| format!("Launch profile {}: {e}", path.display()))?;
    if p.id != id || p.agent != "claude" {
        return Err(format!("Launch profile {}: id {:?} / agent {:?} do not match a Raw Claude {id:?} row", path.display(), p.id, p.agent));
    }
    Ok(p)
}

/// The two isolation switches a bare launch must carry, checked on the profile before any home is
/// touched: an edited profile that drops either is refused, never launched half-isolated.
fn check_isolation(p: &Profile) -> Result<(), String> {
    if !p.args.windows(2).any(|w| w[0] == "--setting-sources" && w[1] == "user") {
        return Err(format!("Launch profile {:?} lacks `--setting-sources user`; spawn refused", p.id));
    }
    if p.overlay.get("CLAUDE_CODE_DISABLE_CLAUDE_MDS").map(String::as_str) != Some("1") {
        return Err(format!("Launch profile {:?} lacks CLAUDE_CODE_DISABLE_CLAUDE_MDS=1; spawn refused", p.id));
    }
    Ok(())
}

/// A profile's `CLAUDE_CONFIG_DIR` (after `{{root}}`/`{{home}}`) must sit under the bare home: an
/// edited profile pointing it at the user's real `.claude` is refused before any home is touched.
fn check_config_in_home(p: &Profile, root: &Path, home_dir: &Path) -> Result<(), String> {
    let Some(raw) = p.overlay.get("CLAUDE_CONFIG_DIR") else { return Ok(()) };
    let filled = raw.replace("{{root}}", &root.to_string_lossy()).replace("{{home}}", &home_dir.to_string_lossy());
    let comps = |s: &str| -> Vec<String> {
        s.split(['/', '\\']).filter(|c| !c.is_empty()).map(str::to_lowercase).collect()
    };
    let (config, home) = (comps(&filled), comps(&home_dir.to_string_lossy()));
    if config.len() <= home.len() || config[..home.len()] != home[..] || config.iter().any(|c| c == "..") {
        return Err(format!("Launch profile {:?} sets CLAUDE_CONFIG_DIR outside the bare home; spawn refused", p.id));
    }
    Ok(())
}

/// The profile's `CLAUDE_CONFIG_DIR` with `{{root}}`/`{{home}}` filled: where skills and agents copy.
fn config_dir_of(p: &Profile, root: &Path, home_dir: &Path) -> Option<PathBuf> {
    let raw = p.overlay.get("CLAUDE_CONFIG_DIR")?;
    Some(PathBuf::from(raw.replace("{{root}}", &root.to_string_lossy()).replace("{{home}}", &home_dir.to_string_lossy())))
}

/// Before a Bare Claude spawn: the normal `~/.claude.json`'s seen-counters raised into the Bare one
/// (`home::mirror_claude_seen`). Never blocks the spawn; a skip is a line in
/// `<home>\logs\claude-seen-mirror.log` (stderr is invisible in release). `normal` is the source
/// `.claude.json` the caller resolved (`LaunchOpts::claude_json`); tests pass a temp file and the
/// real home is never read here.
fn mirror_claude_seen(p: &Profile, root: &Path, home_dir: &Path, normal: Option<&Path>) {
    let Some(dir) = config_dir_of(p, root, home_dir) else { return };
    let skipped = match normal {
        None => Some("no normal .claude.json path resolved".to_string()),
        Some(normal) => home::mirror_claude_seen(normal, &dir.join(".claude.json")).err(),
    };
    if let Some(e) = skipped {
        log_mirror_skip(home_dir, &e);
    }
}

/// One line per skipped mirror, appended like `login-link.log` (`<ms> <text>`). Best effort.
fn log_mirror_skip(home_dir: &Path, why: &str) {
    use std::io::Write;
    let logs = home_dir.join("logs");
    let _ = std::fs::create_dir_all(&logs);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(logs.join("claude-seen-mirror.log")) {
        let _ = writeln!(f, "{} bare claude seen-state mirror skipped: {why}", crate::fsx::now_ms());
    }
}

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
    /// The launching row's `key`: its `sets` come from the last vidar.json entry with that key.
    /// A Codex spawn's key is admitted first (`admit_row_key`): it must name a Codex Bare row.
    pub row_key: Option<&'a str>,
    /// The vidar.json the row is read from; `None` is `paths::config_path()` (tests set it).
    pub config: Option<&'a Path>,
    /// The normal `.claude.json` the seen-counters mirror reads. The public `prepare` and
    /// `prepare_hosted_for` fill it from the real home; `None` (tests) logs a skip.
    pub claude_json: Option<&'a Path>,
}

/// A spawn's row key, trimmed; empty or blank is no key (as `falcon_spawn`'s `none_if_blank`).
pub fn row_key_of(raw: Option<String>) -> Option<String> {
    raw.map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
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

/// The built-in Codex Bare rows (`src/launcher/roster.ts`), Rendered and Raw: id `codex`, profile `bare`.
const CODEX_BARE_ROWS: &[&str] = &["codex-rendered-bare", "codex-bare"];

/// A Codex Bare spawn's row key (Rendered or Raw), admitted before the profile prepare (review e2cc19e2): blank
/// is none; a key without a profile refuses; a key must name a Codex Bare row, so a caller cannot
/// feed a Claude or non-Bare row's sets into Codex Bare. The row is folded from vidar.json
/// `agents` as `src/config-agents.ts` overlays it: a built-in (`codex-rendered-bare`, `codex-bare`) starts as
/// id `codex`, profile `bare`; each entry with that key lays its given `id` (non-empty) and
/// `profile` (non-null) over the row, a `disabled: true` one removes it, and an unknown key's first
/// entry adds it. The row must end as id `codex`, profile `bare`, and the spawn's own profile must
/// be `bare` (review d13bc628). The fold reads keyed entries only, with no keyless legacy matching
/// or root-disable cascade: the launcher never spawns a row it removed, and a Rust false-reject
/// fails visibly rather than admitting the wrong sets. `config` `None` is the live vidar.json
/// (none in tests, as `config_of`).
pub fn admit_row_key(raw: Option<String>, profile: Option<&str>, config: Option<&Path>) -> Result<Option<String>, String> {
    let Some(key) = row_key_of(raw) else { return Ok(None) };
    let Some(profile) = profile else {
        return Err("A row key rides only a profiled spawn; spawn refused".into());
    };
    if profile != "bare" {
        return Err(format!("Row {key:?} is not a Codex Bare row; Bare spawn refused"));
    }
    let path = config_of(&LaunchOpts { row_key: None, config, claude_json: None });
    let root: serde_json::Value = match crate::fsx::read_text(&path) {
        Ok(t) => serde_json::from_str(crate::fsx::strip_bom(&t)).map_err(|e| format!("vidar.json {} is unreadable ({e}); Bare spawn refused", path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::Value::Null,
        Err(e) => return Err(format!("vidar.json {} is unreadable ({e}); Bare spawn refused", path.display())),
    };
    // (id, profile) of the row as the launcher would show it; `None` = no such row.
    let mut row: Option<(String, Option<String>)> = CODEX_BARE_ROWS.contains(&key.as_str()).then(|| ("codex".to_string(), Some("bare".to_string())));
    let entries = root.get("agents").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
    for e in entries.iter().filter(|e| e.get("key").and_then(serde_json::Value::as_str) == Some(key.as_str())) {
        let id = e.get("id").and_then(serde_json::Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
        let given_profile = e.get("profile").filter(|v| !v.is_null()).map(|v| v.as_str().map(str::to_string).unwrap_or_default());
        if e.get("disabled").and_then(serde_json::Value::as_bool) == Some(true) {
            row = None;
            continue;
        }
        row = Some(match row {
            Some((rid, rprofile)) => (id.unwrap_or(rid), given_profile.or(rprofile)),
            None => (id.unwrap_or_default(), given_profile),
        });
    }
    match row {
        Some((id, Some(p))) if id == "codex" && p == "bare" => Ok(Some(key)),
        _ => Err(format!("Row {key:?} is not a Codex Bare row; Bare spawn refused")),
    }
}

/// The row's sets, read before any home is touched; `None` when there is no key or no sets.
fn row_sets_for(opts: &LaunchOpts) -> Result<Option<layer::RowSets>, String> {
    let Some(key) = opts.row_key.map(str::trim).filter(|k| !k.is_empty()) else { return Ok(None) };
    let row = layer::row_sets(&config_of(opts), key)?;
    Ok((!row.sets.is_empty()).then_some(row))
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

fn choose_payload(lock: &home::HomeLock, p: &Profile, root: &Path, home_dir: &Path, row: Option<&layer::RowSets>, guard: &home::Guard, carried: &[String]) -> Result<PayloadChoice, String> {
    if let Some(row) = row {
        let rel = p.sets_payload.as_deref().ok_or_else(|| format!("Launch profile {:?} has no setsPayload, so rune sets cannot load; Bare spawn refused", p.id))?;
        let tpl_path = under(root, rel);
        let template = crate::fsx::read_text(&tpl_path).map_err(|e| format!("Bare sets payload {}: {e}; Bare spawn refused", tpl_path.display()))?;
        let b = layer::build_payload(lock, root, home_dir, &template, row, guard, carried)?;
        return Ok(PayloadChoice { path: b.path, bytes: b.bytes, marker: b.marker, sets: b.sets, warnings: b.warnings });
    }
    let path = under(root, &p.payload);
    let text = crate::fsx::read_text(&path).map_err(|e| format!("Bare payload {}: {e}", path.display()))?;
    let (marker, _) = payload_marker(&text)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("Bare payload {}: {e}", path.display()))?;
    Ok(PayloadChoice { path, bytes, marker, sets: Vec::new(), warnings: Vec::new() })
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

/// Reads the user's real Claude `settings.json` (`CLAUDE_CONFIG_DIR` from Vidar's env, else `~\.claude`).
fn read_remote_control() -> bool {
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()).map(PathBuf::from).or_else(crate::paths::claude_dir);
    dir.and_then(|d| std::fs::read_to_string(d.join("settings.json")).ok()).map(|t| parse_remote_control(&t)).unwrap_or(false)
}

/// A prepared bare launch. Holds the home lock until dropped (after the spawn).
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Env,
    manifest: manifest::Manifest,
    file_stamp: String,
    manifests_dir: PathBuf,
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

/// Prepares the real home (the per-install home under LOCALAPPDATA) from Vidar's own env.
pub fn prepare(profile: &str, opts: &LaunchOpts) -> Result<Launch, String> {
    let probes = Probes { find: &find_on_env_path, version: &read_version, remote_control: &read_remote_control };
    let normal = claude_dir::claude_json_for(None);
    prepare_with(
        profile,
        &crate::paths::root(),
        &home::resolve()?,
        std::env::vars_os(),
        &home::Guard::from_vidar_env(),
        &probes,
        &LaunchOpts { claude_json: normal.as_deref(), ..*opts },
    )
}

pub fn prepare_with(
    profile_id: &str,
    root: &Path,
    home_dir: &Path,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    guard: &home::Guard,
    probes: &Probes,
    opts: &LaunchOpts,
) -> Result<Launch, String> {
    let p = load_profile(root, profile_id)?;
    check_isolation(&p)?;
    check_config_in_home(&p, root, home_dir)?;
    let row = row_sets_for(opts)?;
    let bare_guards = guards::read(&config_of(opts))?;
    let (root_s, home_s) = (root.to_string_lossy().into_owned(), home_dir.to_string_lossy().into_owned());
    home::prepare_dirs(home_dir, &p.home_dirs)?;
    // Sources read and hashed before the lock (fold 4: LOCK_WAIT is 5 s).
    let layer_plan = copies::plan(&config_of(opts), home_dir);
    let lock = home::lock(home_dir, home::LOCK_WAIT)?;
    let login_warnings = login_link::sync_profile(home_dir, &p.shared_login, &p.home_dirs, &lock)?;
    let git = identity::write(&lock, home_dir, guard);
    // Before settings: a refused row build or guard copy leaves settings.json as it was.
    let copied = guards::copy(&lock, home_dir, &bare_guards)?;
    let (skills, copy_warnings) = copies::sync_named(&lock, home_dir, config_dir_of(&p, root, home_dir).as_deref(), layer_plan);
    // Each set's skills, agents and guards ride one plugin per set (`--plugin-dir` below); its guard
    // scripts count as carried, so a rune's `enforced-by` claim on them stays.
    let set_plugins = set_plugin::build(&lock, root, home_dir, row.as_ref(), set_layer::user_home().as_deref());
    let mut carried = copied.files.clone();
    carried.extend(set_plugins.guard_files.iter().cloned());
    let payload = choose_payload(&lock, &p, root, home_dir, row.as_ref(), guard, &carried)?;
    let settings = under(home_dir, &p.settings_target);
    home::generate_settings(&under(root, &p.settings_template), &settings, root, home_dir, guard, &copied.hooks)?;
    mirror_claude_seen(&p, root, home_dir, opts.claude_json);

    let fill = |s: &str| s.replace("{{root}}", &root_s).replace("{{home}}", &home_s);
    let env = profile_env(&p, root, home_dir, inherited);
    let profile_dir = fill(&p.overlay.get("USERPROFILE").cloned().unwrap_or_default());

    let host = (probes.find)(&env, &p.host.name).ok_or_else(|| format!("{} is not on the allowlisted Path; bare spawn refused", p.host.name))?;
    let claude = (probes.find)(&env, &p.binary.name).ok_or_else(|| format!("{} is not on the allowlisted Path; bare spawn refused", p.binary.name))?;
    let version = (probes.version)(&claude, &env);
    let warning = match &version {
        Some(v) if *v == p.verified_version => None,
        Some(v) => Some(format!("Claude {v} differs from the verified {}; launching anyway. Verify: node tools/bare/verify-pin.mjs", p.verified_version)),
        None => Some(format!("Claude version unreadable (verified {}); launching anyway", p.verified_version)),
    };

    let mut claude_args = Vec::new();
    for a in &p.args {
        if a == "{{plugins}}" {
            for name in &p.plugins {
                let dir = plugin_dir(root, name)?;
                claude_args.push("--plugin-dir".to_string());
                claude_args.push(dir.to_string_lossy().into_owned());
            }
            for dir in set_plugins.dirs() {
                claude_args.push("--plugin-dir".to_string());
                claude_args.push(dir.to_string_lossy().into_owned());
            }
        } else if a == "{{remoteControl}}" {
            if (probes.remote_control)() {
                claude_args.push("--remote-control".to_string());
            }
        } else {
            claude_args.push(fill(&a.replace("{{payload}}", &payload.path.to_string_lossy())));
        }
    }
    let mut line = String::new();
    for w in warning.iter().chain(&payload.warnings).chain(&set_plugins.warnings).chain(&copy_warnings).chain(&login_warnings).chain(&git.warning) {
        line.push_str(&format!("Write-Host {} -ForegroundColor Yellow; ", ps_quote(&format!("[Vidar Bare: {w}]"))));
    }
    line.push_str("& ");
    line.push_str(&std::iter::once(claude.to_string_lossy().into_owned()).chain(claude_args).map(|a| ps_quote(&a)).collect::<Vec<_>>().join(" "));
    let mut args = p.host.args.clone();
    args.push(line);

    let (created_utc, file_stamp) = manifest::stamps();
    let m = manifest::Manifest {
        profile: p.id.clone(),
        agent: p.agent.clone(),
        tab: String::new(),
        created_utc,
        vidar_pid: std::process::id(),
        binary: manifest::Binary {
            path: claude.to_string_lossy().into_owned(),
            version,
            verified_version: p.verified_version.clone(),
            warning,
        },
        program: host.to_string_lossy().into_owned(),
        args: args.clone(),
        env_names: Vec::new(),
        homes: manifest::Homes {
            home: home_s.clone(),
            claude_config: fill(p.overlay.get("CLAUDE_CONFIG_DIR").map(String::as_str).unwrap_or_default()),
            codex_home: String::new(),
            user_home: profile_dir,
            settings: settings.to_string_lossy().into_owned(),
        },
        payload: payload.record(),
        plugins: p.plugins.iter().cloned().chain(set_plugins.plugins.iter().filter_map(|s| s.dir.file_name().map(|n| n.to_string_lossy().into_owned()))).collect(),
        guards: copied.files,
        skills,
        git_keys: git.keys,
        warnings: set_plugins.warnings.into_iter().chain(copy_warnings).chain(login_warnings).chain(git.warning).collect(),
        managed_policy: manifest::managed_policy(),
        codex_rules: None,
        falcon_session: None,
    };
    Ok(Launch {
        program: host,
        args,
        env,
        manifest: m,
        file_stamp,
        manifests_dir: home_dir.join("manifests"),
        _lock: lock,
    })
}

impl Launch {
    /// Records the launch (create-new) with the final env names, tab variables included. An
    /// error refuses the spawn: a bare tab never runs unrecorded.
    pub fn write_manifest<'a>(&mut self, tab: &str, env_names: impl IntoIterator<Item = &'a str>) -> Result<PathBuf, String> {
        self.manifest.tab = tab.to_string();
        self.manifest.env_names = env_names.into_iter().map(str::to_string).collect();
        manifest::write(&self.manifests_dir, &self.file_stamp, &self.manifest)
    }
}

// ---- Claude Rendered (Falcon-hosted, falcon/session_commands.rs; plan § P5) ----

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
    /// The row's set plugin folders (`set_plugin::build`, ref order), for
    /// `SpawnParams.set_plugin_dirs`; empty when the row has no sets or none attach anything.
    pub set_plugin_dirs: Vec<PathBuf>,
    manifest: manifest::Manifest,
    file_stamp: String,
    manifests_dir: PathBuf,
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
        manifest::write(&self.manifests_dir, &self.file_stamp, &self.manifest)
    }
}

/// Prepares the real home (the per-install home under LOCALAPPDATA) for a hosted spawn.
pub fn prepare_hosted_for(profile: &str, opts: &LaunchOpts) -> Result<HostedLaunch, String> {
    let normal = claude_dir::claude_json_for(None);
    prepare_hosted_with(profile, &crate::paths::root(), &home::resolve()?, &home::Guard::from_vidar_env(), &LaunchOpts { claude_json: normal.as_deref(), ..*opts })
}

/// The Raw path's home steps without its spawn line: profile and isolation checks, the rendered
/// plugin set present, dirs and ACL, the lock, the payload (the row's sets built, or the
/// profile's own and its marker), `settings.json` generated.
pub fn prepare_hosted_with(profile_id: &str, root: &Path, home_dir: &Path, guard: &home::Guard, opts: &LaunchOpts) -> Result<HostedLaunch, String> {
    let p = load_profile(root, profile_id)?;
    check_isolation(&p)?;
    check_config_in_home(&p, root, home_dir)?;
    let rendered = p.rendered.as_ref().ok_or_else(|| format!("Launch profile {:?} has no rendered block; spawn refused", p.id))?;
    for name in &rendered.plugins {
        plugin_dir(root, name)?;
    }
    let row = row_sets_for(opts)?;
    let bare_guards = guards::read(&config_of(opts))?;
    let (root_s, home_s) = (root.to_string_lossy().into_owned(), home_dir.to_string_lossy().into_owned());
    home::prepare_dirs(home_dir, &p.home_dirs)?;
    // Held only while the payload, guard copies and `settings.json` are written: the manifest is
    // create-new with a unique name, so the host round-trip that follows needs no lock (a second
    // bare spawn must not wait on it). Copy sources are read and hashed before it.
    let layer_plan = copies::plan(&config_of(opts), home_dir);
    let lock = home::lock(home_dir, home::LOCK_WAIT)?;
    let login_warnings = login_link::sync_profile(home_dir, &p.shared_login, &p.home_dirs, &lock)?;
    let git = identity::write(&lock, home_dir, guard);
    let copied = guards::copy(&lock, home_dir, &bare_guards)?;
    let (skills, copy_warnings) = copies::sync_named(&lock, home_dir, config_dir_of(&p, root, home_dir).as_deref(), layer_plan);
    // As Raw: one plugin per set (Falcon admits each folder and the sidecar loads it after the
    // profile's plugins); its guard scripts count as carried for `enforced-by` claims.
    let set_plugins = set_plugin::build(&lock, root, home_dir, row.as_ref(), set_layer::user_home().as_deref());
    let mut carried = copied.files.clone();
    carried.extend(set_plugins.guard_files.iter().cloned());
    let payload = choose_payload(&lock, &p, root, home_dir, row.as_ref(), guard, &carried)?;
    let settings = under(home_dir, &p.settings_target);
    home::generate_settings(&under(root, &p.settings_template), &settings, root, home_dir, guard, &copied.hooks)?;
    mirror_claude_seen(&p, root, home_dir, opts.claude_json);
    drop(lock);

    let fill = |s: &str| s.replace("{{root}}", &root_s).replace("{{home}}", &home_s);
    let (created_utc, file_stamp) = manifest::stamps();
    let m = manifest::Manifest {
        profile: p.id.clone(),
        agent: p.agent.clone(),
        tab: String::new(),
        created_utc,
        vidar_pid: std::process::id(),
        // Falcon resolves claude.exe and runs the sidecar; Vidar sees neither.
        binary: manifest::Binary { path: String::new(), version: None, verified_version: p.verified_version.clone(), warning: None },
        program: "falcon".into(),
        args: Vec::new(),
        env_names: Vec::new(),
        homes: manifest::Homes {
            home: home_s.clone(),
            claude_config: fill(p.overlay.get("CLAUDE_CONFIG_DIR").map(String::as_str).unwrap_or_default()),
            codex_home: String::new(),
            user_home: fill(p.overlay.get("USERPROFILE").map(String::as_str).unwrap_or_default()),
            settings: settings.to_string_lossy().into_owned(),
        },
        payload: payload.record(),
        plugins: rendered.plugins.iter().cloned().chain(set_plugins.plugins.iter().filter_map(|s| s.dir.file_name().map(|n| n.to_string_lossy().into_owned()))).collect(),
        guards: copied.files,
        skills,
        git_keys: git.keys,
        // No spawn line to print it on: the manifest is the hosted tab's record.
        warnings: set_plugins.warnings.iter().cloned().chain(copy_warnings).chain(login_warnings).chain(git.warning).collect(),
        managed_policy: manifest::managed_policy(),
        codex_rules: None,
        falcon_session: None,
    };
    let payload_file = row.is_some().then(|| payload.path.clone());
    let set_plugin_dirs = set_plugins.dirs();
    Ok(HostedLaunch { payload_file, set_plugin_dirs, manifest: m, file_stamp, manifests_dir: home_dir.join("manifests") })
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
        return Err(format!("Bare Codex refused: cwd {cwd} is Vidar's folder, a parent of it or its runtime folder, which the sandbox could write; pick a project folder, or a worktree under runtime\\worktrees for Vidar work"));
    }
    Ok(())
}

pub fn admit_rendered(profile: &str, agent: Option<&str>, rules_file: Option<&str>) -> Result<(), String> {
    if !PROFILES.contains(&profile) {
        return Err(format!("Unknown launch profile {profile:?}; spawn refused"));
    }
    if agent != Some("codex") {
        return Err(format!("The {profile:?} profile on an in-process Rendered tab is for Codex rows only (agent {agent:?}); spawn refused"));
    }
    if rules_file.is_some_and(|f| !f.trim().is_empty()) {
        return Err(format!("A {profile:?} spawn carries no rules file (its layer comes from the profile); spawn refused"));
    }
    Ok(())
}

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

fn load_codex_profile(root: &Path, id: &str) -> Result<CodexProfile, String> {
    let path = root.join("profiles").join(id).join("codex.json");
    let p: CodexProfile = crate::fsx::read_json(&path).map_err(|e| format!("Launch profile {}: {e}", path.display()))?;
    if p.id != id || p.agent != "codex" {
        return Err(format!("Launch profile {}: id {:?} / agent {:?} do not match a Codex {id:?} row", path.display(), p.id, p.agent));
    }
    if !p.shared_login.is_empty() {
        return Err(format!("Launch profile {}: sharedLogin is not wired for Codex yet; spawn refused", path.display()));
    }
    Ok(p)
}

/// Fills a profile string's `{{root}}` and `{{home}}` (the live spawn and the lookup share it).
fn fill_placeholders(s: &str, root: &Path, home_dir: &Path) -> String {
    s.replace("{{root}}", &root.to_string_lossy()).replace("{{home}}", &home_dir.to_string_lossy())
}

/// The profile's `CODEX_HOME` overlay value, filled; the one place the live spawn and the
/// no-session lookup compute it.
fn codex_home_of(p: &CodexProfile, root: &Path, home_dir: &Path) -> Option<PathBuf> {
    p.overlay.get("CODEX_HOME").map(|v| PathBuf::from(fill_placeholders(v, root, home_dir)))
}

/// A Bare Codex profile's `CODEX_HOME` with no live session, for readers (MCP Rack, Loadout).
/// Read-only: Err when the profile row or the home folder is missing, and it never creates a
/// home (a new `CODEX_HOME` triggers UAC and resets the sandbox passwords).
pub fn codex_home_for_profile(profile_id: &str) -> Result<PathBuf, String> {
    codex_home_for_profile_with(profile_id, &crate::paths::root(), &home::resolve()?)
}

pub fn codex_home_for_profile_with(profile_id: &str, root: &Path, home_dir: &Path) -> Result<PathBuf, String> {
    let p = load_codex_profile(root, profile_id)?;
    let codex_home = codex_home_of(&p, root, home_dir).ok_or_else(|| format!("Bare Codex profile {profile_id:?} sets no CODEX_HOME"))?;
    if !codex_home.is_dir() {
        return Err(format!("Bare Codex home {} does not exist yet; open the profile once to create it", codex_home.display()));
    }
    Ok(codex_home)
}

/// What a Flow Codex node spawns on the Bare home: the profile's env (WindowsApps folders
/// dropped, as a tab's), `node`, the resolved `codex.js` and the home it points at.
/// Flow's runner calls it (run 2026-10-19-codex-primary, U2).
pub struct CodexEnv {
    pub env: Env,
    pub node: PathBuf,
    pub js: PathBuf,
    pub codex_home: PathBuf,
}

/// A Bare Codex profile's env with no tab, for Flow. Read-only like `codex_home_for_profile`:
/// Err when the profile, the home folder or its `auth.json` login is missing; it never prepares
/// dirs, takes the lock or rewrites config.toml (a new `CODEX_HOME` triggers UAC and resets the
/// sandbox passwords). `auth.json` is tested for presence only, never opened.
pub fn codex_env_for_profile(profile_id: &str, inherited: impl IntoIterator<Item = (OsString, OsString)>) -> Result<CodexEnv, String> {
    let probes = CodexProbes { find: &find_on_env_path, codex: &resolve_codex };
    codex_env_for_profile_with(profile_id, &crate::paths::root(), &home::resolve()?, inherited, &probes)
}

pub fn codex_env_for_profile_with(
    profile_id: &str,
    root: &Path,
    home_dir: &Path,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    probes: &CodexProbes,
) -> Result<CodexEnv, String> {
    if !PROFILES.contains(&profile_id) {
        return Err(format!("Unknown launch profile {profile_id:?}"));
    }
    let p = load_codex_profile(root, profile_id)?;
    let codex_home = codex_home_of(&p, root, home_dir).ok_or_else(|| format!("Bare Codex profile {profile_id:?} sets no CODEX_HOME"))?;
    if !codex_home.is_dir() {
        return Err("Open a Bare tab once to create its home".to_string());
    }
    if !codex_home.join("auth.json").is_file() {
        return Err("Sign in from a Bare tab".to_string());
    }
    let overlay: BTreeMap<String, String> = p.overlay.iter().map(|(k, v)| (k.clone(), fill_placeholders(v, root, home_dir))).collect();
    let mut env = env::codex(inherited, &overlay)?;
    env::drop_app_alias_dirs(&mut env);
    let node = (probes.find)(&env, &p.host.name).ok_or_else(|| format!("{} is not on the allowlisted Path", p.host.name))?;
    let (js, _) = (probes.codex)(&env, &p.binary).ok_or_else(|| format!("{} not found beside a {} shim on the allowlisted Path", p.binary.script, p.binary.shims.join(" or ")))?;
    Ok(CodexEnv { env, node, js, codex_home })
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

/// Seams for the tests: `node` lookup and the Codex resolver.
pub struct CodexProbes<'a> {
    pub find: &'a dyn Fn(&Env, &str) -> Option<PathBuf>,
    pub codex: &'a dyn Fn(&Env, &CodexBinary) -> Option<(PathBuf, Option<String>)>,
}

/// Which Codex line a prepare builds: the in-process app-server (Rendered, agent.rs) or the TUI
/// in a PTY (Raw, pty.rs). The only difference is the profile's `args` vs `rawArgs`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    AppServer,
    Tui,
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
    _lock: home::HomeLock,
}

impl CodexLaunch {
    /// Same contract as `Launch::write_manifest`: no record, no spawn.
    pub fn write_manifest<'a>(&mut self, tab: &str, env_names: impl IntoIterator<Item = &'a str>) -> Result<PathBuf, String> {
        self.manifest.tab = tab.to_string();
        self.manifest.env_names = env_names.into_iter().map(str::to_string).collect();
        manifest::write(&self.manifests_dir, &self.file_stamp, &self.manifest)
    }
}

/// Prepares the real home (the per-install home under LOCALAPPDATA) from Vidar's own env.
/// `cwd` is the tab's launch folder: Bare writes it into config.toml as a trusted project.
pub fn prepare_codex(profile: &str, opts: &LaunchOpts, cwd: &str) -> Result<CodexLaunch, String> {
    let probes = CodexProbes { find: &find_on_env_path, codex: &resolve_codex };
    let root = crate::paths::root();
    let launch = prepare_codex_in(profile, &root, &home::resolve()?, std::env::vars_os(), &home::Guard::from_vidar_env(), &probes, opts, Some(cwd))?;
    verify_new_codex(&launch, &root);
    Ok(launch)
}

/// `prepare_codex` for the Raw TUI in a PTY (pty.rs): the same home, env and config.toml, the
/// profile's `rawArgs` instead of `app-server`. The caller has already refused a home-folder `cwd`.
pub fn prepare_codex_tui(profile: &str, opts: &LaunchOpts, cwd: &str) -> Result<CodexLaunch, String> {
    let probes = CodexProbes { find: &find_on_env_path, codex: &resolve_codex };
    let root = crate::paths::root();
    let launch = prepare_codex_for(Surface::Tui, profile, &root, &home::resolve()?, std::env::vars_os(), &home::Guard::from_vidar_env(), &probes, opts, Some(cwd))?;
    verify_new_codex(&launch, &root);
    Ok(launch)
}

/// A Codex spawn's built instructions: the row's sets (`build_payload`, carrying the guard files
/// hooks.json runs) and the copied skills listing, or the listing alone, filled into the profile's
/// `setsPayload` with `{{root}}` filled; `None` when there are neither (the static payload in config.toml stands).
#[allow(clippy::too_many_arguments)]
fn codex_instructions(lock: &home::HomeLock, p: &CodexProfile, root: &Path, home_dir: &Path, row: Option<&layer::RowSets>, skills: &str, guard: &home::Guard, carried: &[String]) -> Result<Option<layer::BuiltPayload>, String> {
    if row.is_none() && skills.is_empty() {
        return Ok(None);
    }
    let rel = p.sets_payload.as_deref().ok_or_else(|| format!("Launch profile {:?} has no setsPayload, so rune sets cannot load; Bare spawn refused", p.id))?;
    let tpl_path = under(root, rel);
    let template = crate::fsx::read_text(&tpl_path).map_err(|e| format!("Bare sets payload {}: {e}; Bare spawn refused", tpl_path.display()))?;
    let template = template.replace("{{root}}", &root.to_string_lossy());
    let built = match row {
        // The listing rides after the sets, before the marker build_payload appends.
        Some(row) => layer::build_payload(lock, root, home_dir, &layer::with_skills(&template, skills), row, guard, carried)?,
        None => layer::build_text_payload(lock, root, home_dir, &template, skills, guard)?,
    };
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
    guard: &home::Guard,
    probes: &CodexProbes,
    opts: &LaunchOpts,
) -> Result<CodexLaunch, String> {
    prepare_codex_in(profile_id, root, home_dir, inherited, guard, probes, opts, None)
}

/// `prepare_codex_with` for a launch folder: `cwd` becomes config.toml's one trusted `[projects]` entry.
#[allow(clippy::too_many_arguments)]
pub fn prepare_codex_in(
    profile_id: &str,
    root: &Path,
    home_dir: &Path,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    guard: &home::Guard,
    probes: &CodexProbes,
    opts: &LaunchOpts,
    cwd: Option<&str>,
) -> Result<CodexLaunch, String> {
    prepare_codex_for(Surface::AppServer, profile_id, root, home_dir, inherited, guard, probes, opts, cwd)
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
    guard: &home::Guard,
    probes: &CodexProbes,
    opts: &LaunchOpts,
    cwd: Option<&str>,
) -> Result<CodexLaunch, String> {
    let p = load_codex_profile(root, profile_id)?;
    let line_args = match surface {
        Surface::AppServer => p.args.clone(),
        Surface::Tui => p.raw_args.clone().ok_or_else(|| format!("Launch profile {profile_id:?} has no rawArgs, so it has no Raw Codex row; spawn refused"))?,
    };
    // The TUI takes the payload as a profile file; the app-server surface hands the text back for
    // the Rendered adapter to send on `thread/start`. Neither has a length cap.
    let route = match surface {
        Surface::AppServer => codex_hosted::PayloadRoute::ThreadStart,
        Surface::Tui => codex_hosted::PayloadRoute::ProfileFile,
    };
    let h = codex_hosted::prepare_home(p, root, home_dir, inherited, guard, probes.find, probes.codex, opts, cwd, route)?;
    let fill = |s: &str| fill_placeholders(s, root, home_dir);
    let (p, env) = (&h.p, &h.env);
    let node = (probes.find)(env, &p.host.name).ok_or_else(|| format!("{} is not on the allowlisted Path; bare spawn refused", p.host.name))?;
    let (js, version) = (probes.codex)(env, &p.binary).ok_or_else(|| {
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
    let mut args = vec![js.to_string_lossy().into_owned()];
    args.extend(line_args.iter().map(|a| fill(a)));
    // The record names the built file, never the encoded text.
    let mut recorded_args = args.clone();
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
