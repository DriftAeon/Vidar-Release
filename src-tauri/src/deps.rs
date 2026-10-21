//! src-tauri\src\deps.rs — `detect_dependencies`: one DepStatus per entry of
//! contracts\dependencies.json, in catalog order. The catalog is read
//! through include_str!; the frontend reads the same file through a JSON import
//! (src\deps\state.ts), shapes in src\deps\types.ts. The listed pack modules' `deps[]`
//! (modules::pack_deps) are probed the same way and reported after the catalog in `deps`.
//!
//! Probes look at PATH, files, vidar.json, the environment and the Falcon bundle
//! store only: no network. Two process spawns, each only once the exe is found:
//! `<exe> --version` for an `exe` probe carrying `minVersion` (Node today), bounded by
//! `VERSION_TIMEOUT` (`run_bounded`, also used by claude_version.rs), and
//! `claude auth status --json` for an entry carrying `authCheck: "claude"` (the claude pack's
//! `claude` dep; `claude_auth.rs`), which sets `warning`. That entry's probe is also where the
//! Flow runner, `claude_auth.rs` and `status.rs` find Claude Code (`claude_exe`, `claude_images`).
//! The env probe reports presence and never puts the value into `location` or `detail`.

use std::ffi::OsStr;
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod updates;

use crate::which::{find_in, find_on_path_exact, is_file_or_alias, registry_env, registry_path_dirs, Hive};

/// Shown when an exe is only on the persisted (registry) PATH: Vidar and its
/// children still run with the PATH they started with, so it would not spawn.
const STALE_PATH_DETAIL: &str = "Installed After Launch: Restart Vidar";

/// Shown when an env variable is only in HKCU\Environment: the process env (and
/// every child's) predates it. Never carries the value.
const STALE_ENV_DETAIL: &str = "Set After Launch: Restart Vidar";

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The `authCheck` value whose found exe also gets the Claude Code login check (`claude_auth.rs`).
const AUTH_CHECK_CLAUDE: &str = "claude";

const CATALOG_JSON: &str = include_str!("../../contracts/dependencies.json");

#[derive(Debug, Deserialize)]
struct Catalog {
    deps: Vec<CatalogEntry>,
}

/// Only what Rust needs; the other copy fields (install, usedBy, …) belong to the frontend.
#[derive(Debug, Deserialize)]
struct CatalogEntry {
    id: String,
    probe: Probe,
    /// The startup update offer's name for the row (`updates.rs`).
    #[serde(default)]
    label: Option<String>,
    /// `"claude"`: a found exe also gets the Claude Code login check (`claude_auth.rs`).
    #[serde(default, rename = "authCheck")]
    auth_check: Option<String>,
    /// Present: the startup update check covers this entry (`updates.rs`).
    #[serde(default)]
    update: Option<UpdateRule>,
}

/// A dep entry's `update`: `package` is the npm package installed next to the exe; `native`
/// lets a non-npm `.exe` install update itself (`<exe> --version`, `<exe> update`).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct UpdateRule {
    #[serde(default)]
    package: Option<String>,
    #[serde(default)]
    native: bool,
}

/// Internally tagged: an unknown `kind` is a parse error, not a silent skip.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Probe {
    Exe {
        names: Vec<String>,
        #[serde(default)]
        candidates: Vec<String>,
        /// Floor as `X.Y` or `X.Y.Z`; below it, or unreadable, the exe counts as missing.
        #[serde(default, rename = "minVersion")]
        min_version: Option<String>,
    },
    Vidar {
        files: Vec<String>,
    },
    Config {
        /// Dotted path into vidar.json (`editor.exe`).
        key: String,
        /// Probed when `key` is absent or blank (legacy key, e.g. `riderPath`).
        #[serde(default)]
        fallback: Option<String>,
    },
    Env {
        name: String,
    },
    Falcon,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepStatus {
    id: String,
    found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    /// Found but not usable as is (Claude Code not logged in); Title Case, never a secret.
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepReport {
    /// The Vidar root (`paths::root()`): the setup agent's cwd.
    root: String,
    /// The catalog's entries, then the listed pack modules' `deps[]` (`modules::pack_deps`).
    deps: Vec<DepStatus>,
}

fn parse_catalog(text: &str) -> Result<Catalog, String> {
    serde_json::from_str(text).map_err(|e| format!("contracts\\dependencies.json: {e}"))
}

/// A pack dep's probe parses as one deps.rs can run (modules::manifest validation).
pub(crate) fn check_probe(probe: &Value) -> Result<(), String> {
    serde_json::from_value::<Probe>(probe.clone()).map(|_| ()).map_err(|e| e.to_string())
}

/// Catalog claims used while scanning packs: ids for pack deps and env keys for gateway keyVars.
/// The catalog still has first priority when dependencies are probed.
#[derive(Default)]
pub(crate) struct CatalogClaims {
    pub ids: std::collections::BTreeSet<String>,
    pub env_names: std::collections::BTreeSet<String>,
}

pub(crate) fn catalog_claims() -> CatalogClaims {
    let Ok(catalog) = parse_catalog(CATALOG_JSON) else { return CatalogClaims::default() };
    let mut claims = CatalogClaims::default();
    for entry in catalog.deps {
        if let Probe::Env { name } = entry.probe {
            claims.env_names.insert(name);
        }
        claims.ids.insert(entry.id);
    }
    claims
}

/// Pack dep entries to probe after the catalog. An id the catalog or an earlier entry already
/// has is skipped (first wins), as is an entry that does not parse.
fn extra_entries(catalog: &Catalog, extra: Vec<Value>) -> Vec<CatalogEntry> {
    let mut seen: std::collections::HashSet<String> = catalog.deps.iter().map(|e| e.id.clone()).collect();
    extra
        .into_iter()
        .filter_map(|v| serde_json::from_value::<CatalogEntry>(v).ok())
        .filter(|e| seen.insert(e.id.clone()))
        .collect()
}

/// The catalog entries, then the listed packs' `deps[]` (first id wins): what `detect` probes.
fn entries() -> Vec<CatalogEntry> {
    let Ok(catalog) = parse_catalog(CATALOG_JSON) else { return Vec::new() };
    let extra = extra_entries(&catalog, crate::modules::pack_deps());
    catalog.deps.into_iter().chain(extra).collect()
}

/// The Claude Code dep (the entry carrying `authCheck: "claude"`; it lives in the claude pack),
/// or None when no listed catalog or pack entry declares it.
fn claude_entry() -> Option<CatalogEntry> {
    entries().into_iter().find(|e| e.auth_check.as_deref() == Some(AUTH_CHECK_CLAUDE))
}

/// The Claude Code exe a spawn can run: the dep probe's `.exe` names on the process PATH, then its
/// `.exe` candidates. A `.cmd`/`.ps1` shim is never returned (the SDK cannot spawn one directly).
/// Shared by the Flow runner (`flow/env.rs`) and `claude_auth.rs`.
pub(crate) fn claude_exe() -> Option<PathBuf> {
    let Probe::Exe { names, candidates, .. } = claude_entry()?.probe else { return None };
    let is_exe = |s: &String| s.to_ascii_lowercase().ends_with(".exe");
    let names: Vec<String> = names.into_iter().filter(is_exe).collect();
    let candidates: Vec<String> = candidates.into_iter().filter(is_exe).collect();
    match probe_exe(&names, &candidates, &[]) {
        ExeHit::Usable(path) => Some(path),
        _ => None,
    }
}

/// Process image names a running Claude Code can have (`status.rs`): the Claude dep probe's `.exe`
/// names, plus `node.exe` when it also lists a `.cmd`/`.ps1` shim (an npm install runs under node).
/// Empty when no Claude dep is declared.
pub(crate) fn claude_images() -> Vec<String> {
    let Some(Probe::Exe { names, .. }) = claude_entry().map(|e| e.probe) else { return Vec::new() };
    claude_images_from(&names)
}

fn claude_images_from(names: &[String]) -> Vec<String> {
    let lower: Vec<String> = names.iter().map(|n| n.to_ascii_lowercase()).collect();
    let mut out: Vec<String> = lower.iter().filter(|n| n.ends_with(".exe")).cloned().collect();
    if lower.iter().any(|n| n.ends_with(".cmd") || n.ends_with(".ps1")) && !out.iter().any(|n| n == "node.exe") {
        out.push("node.exe".to_string());
    }
    out
}

/// One update-checked entry for `updates.rs`: id, label, exe probe names and candidates, rule.
pub(crate) struct UpdateEntry {
    pub id: String,
    pub label: String,
    pub names: Vec<String>,
    pub candidates: Vec<String>,
    pub rule: UpdateRule,
}

impl UpdateRule {
    pub(crate) fn package(&self) -> Option<&str> {
        self.package.as_deref()
    }
    pub(crate) fn native(&self) -> bool {
        self.native
    }
}

/// Every catalog and pack entry with an `update` rule and an exe probe, in report order.
pub(crate) fn update_entries() -> Vec<UpdateEntry> {
    entries()
        .into_iter()
        .filter_map(|e| {
            let rule = e.update?;
            let Probe::Exe { names, candidates, .. } = e.probe else { return None };
            Some(UpdateEntry { label: e.label.unwrap_or_else(|| e.id.clone()), id: e.id, names, candidates, rule })
        })
        .collect()
}

/// `Err` reaches the frontend as a rejected invoke (`depsError`), never a panic.
#[tauri::command]
pub async fn detect_dependencies() -> Result<DepReport, String> {
    tauri::async_runtime::spawn_blocking(detect)
        .await
        .map_err(|e| e.to_string())?
}

fn detect() -> Result<DepReport, String> {
    let catalog = parse_catalog(CATALOG_JSON)?;
    let registry_dirs = registry_path_dirs(); // once per detect, not per lookup
    Ok(DepReport {
        root: crate::paths::root().display().to_string(),
        deps: probe_all(&catalog, crate::modules::pack_deps(), &registry_dirs),
    })
}

/// Catalog entries first, then the pack deps (first id wins), each probed once.
fn probe_all(catalog: &Catalog, pack: Vec<Value>, registry_dirs: &[PathBuf]) -> Vec<DepStatus> {
    let extra = extra_entries(catalog, pack);
    catalog
        .deps
        .iter()
        .chain(extra.iter())
        .map(|e| run_probe(&e.id, &e.probe, e.auth_check.as_deref() == Some(AUTH_CHECK_CLAUDE), registry_dirs))
        .collect()
}

/// `registry_dirs`: the persisted user+machine PATH, read once by `detect`. `auth_check`: the
/// entry carries `authCheck: "claude"`, so a found exe also gets the login check.
fn run_probe(id: &str, probe: &Probe, auth_check: bool, registry_dirs: &[PathBuf]) -> DepStatus {
    let status = |found: bool, location: Option<String>, detail: Option<String>| DepStatus {
        id: id.to_string(),
        found,
        location,
        detail,
        warning: None,
    };
    match probe {
        Probe::Exe { names, candidates, min_version } => match probe_exe(names, candidates, registry_dirs) {
            ExeHit::Usable(path) => match min_version.as_deref().and_then(|min| version_gap(read_version(&path).as_deref(), min)) {
                // Claude Code found but logged out: still found (its tabs stay offered), with a warning
                None if auth_check => DepStatus {
                    warning: crate::claude_auth::login_warning(path.as_os_str()),
                    ..status(true, Some(path.display().to_string()), None)
                },
                None => status(true, Some(path.display().to_string()), None),
                Some(gap) => status(false, None, Some(gap)),
            },
            ExeHit::RegistryOnly => status(false, None, Some(STALE_PATH_DETAIL.to_string())),
            ExeHit::Absent => status(false, None, None),
        },
        Probe::Vidar { files } => {
            let root = crate::paths::root();
            match files.iter().map(|f| root.join(f)).find(|p| p.is_file()) {
                Some(path) => status(true, Some(path.display().to_string()), None),
                None => status(false, None, None),
            }
        }
        Probe::Config { key, fallback } => match probe_config(&crate::paths::config_path(), &crate::paths::root(), key, fallback.as_deref()) {
            Ok(path) => status(true, Some(path), None),
            Err(detail) => status(false, None, Some(detail)),
        },
        Probe::Env { name } => {
            let (found, detail) = env_status(probe_env(name));
            status(found, None, detail)
        }
        Probe::Falcon => status(
            crate::falcon::bundle_present(&crate::paths::root()),
            None,
            None,
        ),
    }
}

#[derive(Debug, PartialEq)]
enum ExeHit {
    /// On the process PATH or at a candidate path: a spawn would find it.
    Usable(PathBuf),
    /// Only in a registry PATH dir: installed after Vidar started.
    RegistryOnly,
    Absent,
}

/// Process PATH, then candidates, then the registry PATH (never usable, only
/// reported). Vidar does not mutate its own PATH to pick up a registry hit.
fn probe_exe(names: &[String], candidates: &[String], registry_dirs: &[PathBuf]) -> ExeHit {
    let usable = names.iter().find_map(|n| find_on_path_exact(n)).or_else(|| {
        candidates
            .iter()
            .filter_map(|c| expand_env(c))
            .map(PathBuf::from)
            .find(|p| is_file_or_alias(p))
    });
    if let Some(path) = usable {
        return ExeHit::Usable(path);
    }
    // A dir on both PATHs was already searched above, so any hit here is registry-only.
    if names.iter().any(|n| find_in(registry_dirs, n).is_some()) {
        return ExeHit::RegistryOnly;
    }
    ExeHit::Absent
}

/// Bound on a `--version` spawn: past it the child is killed and the version is unreadable.
pub(crate) const VERSION_TIMEOUT: Duration = Duration::from_secs(3);

/// `<exe> --version` stdout; `None` when the spawn fails, exits non-zero or outlives the bound.
fn read_version(exe: &Path) -> Option<String> {
    run_bounded(exe.as_os_str(), &["--version"], VERSION_TIMEOUT)
}

/// Runs `program args` with no console window and returns its stdout when it exits 0 within
/// `timeout`. On timeout the child is killed and the result is `None`. Stdout is read on a
/// thread so a full pipe cannot stall the child; a grandchild still holding the pipe after the
/// kill only leaves that detached reader waiting, never the caller.
/// Shared with `claude_version.rs`.
pub(crate) fn run_bounded(program: &OsStr, args: &[&str], timeout: Duration) -> Option<String> {
    let (ok, stdout) = run_bounded_any(program, args, timeout)?;
    ok.then_some(stdout)
}

/// `run_bounded` that keeps stdout on a non-zero exit too, paired with whether the exit was 0.
/// For CLIs that answer on stdout and signal the answer through the exit code
/// (`claude auth status` exits 1 when logged out; `claude_auth.rs`).
pub(crate) fn run_bounded_any(program: &OsStr, args: &[&str], timeout: Duration) -> Option<(bool, String)> {
    let deadline = Instant::now() + timeout;
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let buf = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).ok()?;
    Some((status.success(), String::from_utf8_lossy(&buf).into_owned()))
}

/// First token as `[v]X.Y[.Z][-pre|+build]`, digits only; anything else is `None`.
fn parse_semver(text: &str) -> Option<(u32, u32, u32)> {
    let token = text.split_whitespace().next()?;
    let token = token.strip_prefix('v').unwrap_or(token);
    let core = token.split(['-', '+']).next()?;
    let parts = core
        .split('.')
        .map(|p| (!p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())).then(|| p.parse::<u32>().ok()).flatten())
        .collect::<Option<Vec<u32>>>()?;
    match parts[..] {
        [a, b] => Some((a, b, 0)),
        [a, b, c] => Some((a, b, c)),
        _ => None,
    }
}

/// `None` = at or above `min`. Otherwise the Title Case detail for the page: too old, or
/// unknown when the output (or the floor) does not parse; unknown never passes.
fn version_gap(output: Option<&str>, min: &str) -> Option<String> {
    match (output.and_then(parse_semver), parse_semver(min)) {
        (Some(have), Some(floor)) if have >= floor => None,
        (Some((a, b, c)), Some(_)) => Some(format!("Too Old: v{a}.{b}.{c}, Needs v{min}")),
        _ => Some(format!("Version Unknown, Needs v{min}")),
    }
}

/// `%VAR%` expanded from the process env. `None` when a named variable is unset,
/// so a candidate never degrades into a relative path.
fn expand_env(text: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = after.find('%')?;
        let value = std::env::var(&after[..end]).ok()?;
        out.push_str(&value);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Some(out)
}

/// The vidar.json `key` (a dotted path, e.g. `editor.exe`) must be a non-empty string
/// naming an existing file. When `key` is absent or blank and a `fallback` key is named,
/// the fallback is probed instead (the `editor.exe` → `riderPath` rule of `editor.rs`).
/// A relative value resolves against the Vidar `root`; `Ok` is the resolved path.
/// `Err` says which of those failed, naming the key and path only.
fn probe_config(config: &Path, root: &Path, key: &str, fallback: Option<&str>) -> Result<String, String> {
    // Details are Title Case; the file name, key and path stay verbatim.
    // A missing vidar.json is the normal fresh-install state: every key is unset.
    let json: Value = match crate::fsx::read_text(config) {
        Ok(text) => serde_json::from_str(&text).map_err(|_| "vidar.json Does Not Parse".to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(_) => return Err(format!("vidar.json Not Readable At {}", config.display())),
    };
    let lookup = |k: &str| -> Result<Option<String>, String> {
        match k.split('.').try_fold(&json, |v, seg| v.get(seg)) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.trim().to_string())),
            Some(_) => Err(format!("{k} In vidar.json Is Not A String")),
        }
    };
    let (key, value) = match (lookup(key)?, fallback) {
        (Some(v), _) => (key, v),
        (None, Some(fb)) => match lookup(fb)? {
            Some(v) => (fb, v),
            None => return Err(format!("{key} (Or {fb}) Not Set In vidar.json")),
        },
        (None, None) => return Err(format!("{key} Not Set In vidar.json")),
    };
    let path = root.join(&value); // an absolute value replaces `root`
    if !path.is_file() {
        return Err(format!("{key} Names A Missing File: {}", path.display()));
    }
    Ok(path.display().to_string())
}

#[derive(Debug, PartialEq)]
enum EnvHit {
    /// Non-empty in the process env: Vidar and its children see it.
    Usable,
    /// Non-empty only in HKCU\Environment: set after Vidar started, so a child
    /// would not inherit it until Vidar restarts.
    RegistryOnly,
    Absent,
}

/// Process env first, then HKCU\Environment. Non-empty counts; the value is
/// read, tested and dropped here.
fn probe_env(name: &str) -> EnvHit {
    env_hit(
        std::env::var_os(name).is_some_and(|v| !v.is_empty()),
        || registry_env(Hive::User, name).is_some_and(|v| !v.is_empty()),
    )
}

/// The decision alone, so a test can drive the registry side without writing HKCU.
fn env_hit(in_process: bool, in_registry: impl FnOnce() -> bool) -> EnvHit {
    if in_process {
        EnvHit::Usable
    } else if in_registry() {
        EnvHit::RegistryOnly
    } else {
        EnvHit::Absent
    }
}

fn env_status(hit: EnvHit) -> (bool, Option<String>) {
    match hit {
        EnvHit::Usable => (true, None),
        EnvHit::RegistryOnly => (false, Some(STALE_ENV_DETAIL.to_string())),
        EnvHit::Absent => (false, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn deps_catalog_parses_with_unique_ids() {
        let catalog = parse_catalog(CATALOG_JSON).expect("real catalog parses");
        assert!(!catalog.deps.is_empty());
        let mut seen = HashSet::new();
        for entry in &catalog.deps {
            assert!(seen.insert(entry.id.as_str()), "duplicate id {}", entry.id);
            if let Probe::Exe { min_version: Some(min), .. } = &entry.probe {
                assert!(parse_semver(min).is_some(), "{}: minVersion {min} does not parse", entry.id);
            }
        }
    }

    #[test]
    fn deps_min_version_compare() {
        assert_eq!(version_gap(Some("v18.19.0\r\n"), "20.10"), Some("Too Old: v18.19.0, Needs v20.10".into()));
        assert_eq!(version_gap(Some("v20.10.0\n"), "20.10"), None);
        assert_eq!(version_gap(Some("v24.19.0\n"), "20.10"), None);
        for garbled in [Some(""), Some("node: bad option"), Some("v24"), Some("v+24.1.0"), Some("v24..0"), None] {
            assert_eq!(version_gap(garbled, "20.10"), Some("Version Unknown, Needs v20.10".into()), "{garbled:?}");
        }
    }

    /// A child that never exits is killed at the bound and reads as unknown.
    #[test]
    fn deps_hung_version_spawn_times_out() {
        let start = Instant::now();
        let out = run_bounded(
            OsStr::new("powershell"),
            &["-NoProfile", "-Command", "Start-Sleep 30"],
            Duration::from_millis(500),
        );
        let elapsed = start.elapsed();
        assert_eq!(out, None);
        assert!(elapsed < Duration::from_secs(5), "took {elapsed:?}");
        assert_eq!(version_gap(out.as_deref(), "20.10"), Some("Version Unknown, Needs v20.10".into()));
    }

    /// Pack deps follow the catalog; a catalog id or a repeat is skipped, never overrides.
    #[test]
    fn deps_pack_extra_skips_catalog_ids_and_repeats() {
        let catalog = parse_catalog(CATALOG_JSON).unwrap();
        let entry = |id: &str, name: &str| serde_json::json!({ "id": id, "label": "L", "probe": { "kind": "env", "name": name } });
        let got = extra_entries(&catalog, vec![entry("git", "X_API_KEY"), entry("acme-key", "ACME_API_KEY"), entry("acme-key", "OTHER_API_KEY"), entry("beta-key", "BETA_API_KEY")]);
        let ids: Vec<&str> = got.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["acme-key", "beta-key"]);
        assert!(matches!(&got[0].probe, Probe::Env { name } if name == "ACME_API_KEY"));
    }

    /// A pack dep lands in the one `deps` list after the catalog; a repeated id keeps the catalog entry.
    #[test]
    fn deps_pack_entries_join_the_report() {
        let catalog = parse_catalog(r#"{ "version": 1, "deps": [
            { "id": "a", "label": "A", "probe": { "kind": "env", "name": "VIDAR_U3_TEST_UNSET_A" } },
            { "id": "b", "label": "B", "probe": { "kind": "env", "name": "VIDAR_U3_TEST_UNSET_B" } } ] }"#).unwrap();
        let entry = |id: &str, name: &str| serde_json::json!({ "id": id, "label": "L", "probe": { "kind": "env", "name": name } });
        let got = probe_all(&catalog, vec![entry("a", "VIDAR_U3_TEST_UNSET_C"), entry("acme-key", "VIDAR_U3_TEST_UNSET_Z")], &[]);
        let ids: Vec<&str> = got.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "acme-key"]);
        let json = serde_json::to_value(DepReport { root: String::new(), deps: got }).unwrap();
        assert!(json.get("extra").is_none());
    }

    /// The claude pack's `claude` dep carries the login check and the update rule `updates.rs` reads.
    #[test]
    fn deps_claude_pack_dep_declares_auth_check_and_update() {
        let pack: Value = serde_json::from_str(include_str!("../../content/packs/claude/pack.json")).unwrap();
        let deps = pack["module"]["deps"].clone();
        let catalog = parse_catalog(r#"{ "version": 1, "deps": [] }"#).unwrap();
        let got = extra_entries(&catalog, deps.as_array().unwrap().clone());
        let claude = got.iter().find(|e| e.id == "claude").expect("claude dep");
        assert_eq!(claude.auth_check.as_deref(), Some(AUTH_CHECK_CLAUDE));
        let rule = claude.update.as_ref().expect("claude update rule");
        assert_eq!(rule.package(), Some("@anthropic-ai/claude-code"));
        assert!(rule.native());
        let real = parse_catalog(CATALOG_JSON).unwrap();
        assert!(real.deps.iter().all(|e| e.auth_check.is_none()), "authCheck moved to the claude pack");
    }

    #[test]
    fn deps_claude_images_follow_the_probe_names() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(claude_images_from(&s(&["claude.exe", "claude.cmd", "claude.ps1"])), s(&["claude.exe", "node.exe"]));
        assert_eq!(claude_images_from(&s(&["Claude.EXE"])), s(&["claude.exe"]));
        assert!(claude_images_from(&[]).is_empty());
    }

    #[test]
    fn deps_unknown_probe_kind_fails() {
        let text = r#"{ "version": 1, "deps": [ { "id": "x", "probe": { "kind": "registry" } } ] }"#;
        assert!(parse_catalog(text).is_err());
    }

    #[test]
    fn deps_config_relative_path_resolves_against_root() {
        let root = std::env::temp_dir().join(format!("vidar-deps-test-{}", std::process::id()));
        std::fs::create_dir_all(root.join("tools")).unwrap();
        std::fs::write(root.join("tools").join("rider.exe"), b"").unwrap();
        let config = root.join("vidar.json");
        std::fs::write(&config, r#"{ "riderPath": "tools\\rider.exe" }"#).unwrap();
        let got = probe_config(&config, &root, "editor.exe", Some("riderPath"));
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(got, Ok(root.join("tools").join("rider.exe").display().to_string()));
    }

    #[test]
    fn deps_config_missing_file_is_unset() {
        let root = std::env::temp_dir().join(format!("vidar-deps-nofile-{}", std::process::id()));
        let got = probe_config(&root.join("absent.json"), &root, "editor.exe", Some("riderPath"));
        assert_eq!(got, Err("editor.exe (Or riderPath) Not Set In vidar.json".to_string()));
    }

    /// An exe only in a registry PATH dir is not usable: found=false with the restart detail.
    #[test]
    fn deps_registry_only_exe_reports_restart() {
        let dir = std::env::temp_dir().join(format!("vidar-deps-reg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let name = "vidar-deps-registry-only-7f3a.exe".to_string();
        std::fs::write(dir.join(&name), b"").unwrap();
        let hit = probe_exe(std::slice::from_ref(&name), &[], std::slice::from_ref(&dir));
        let absent = probe_exe(std::slice::from_ref(&name), &[], &[]);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(hit, ExeHit::RegistryOnly);
        assert_eq!(absent, ExeHit::Absent);
    }

    #[test]
    fn deps_env_probe_never_leaks_the_value() {
        let name = "VIDAR_DEPS_TEST_SECRET_7F3A";
        let secret = "s3cr3t-value-that-must-not-appear";
        std::env::set_var(name, secret);
        let status = run_probe("typesafe", &Probe::Env { name: name.into() }, false, &[]);
        std::env::remove_var(name);
        assert!(status.found);
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains(secret), "value leaked: {json}");
        assert_eq!(json, r#"{"id":"typesafe","found":true}"#);
    }

    /// A variable only in HKCU is not usable: found=false with the restart detail.
    #[test]
    fn deps_registry_only_env_reports_restart() {
        assert_eq!(env_hit(false, || true), EnvHit::RegistryOnly);
        assert_eq!(env_hit(false, || false), EnvHit::Absent);
        assert_eq!(env_hit(true, || panic!("registry read when process env has it")), EnvHit::Usable);
        assert_eq!(env_status(EnvHit::RegistryOnly), (false, Some(STALE_ENV_DETAIL.to_string())));
    }
}
