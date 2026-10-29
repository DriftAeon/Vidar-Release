//! src-tauri\src\bare\guards.rs — guard hook copies for a Claude Bare home.
//! `bareGuards` in vidar.json (`[{ event, matcher?, run: ["<abs .mjs>", ...] }]`, filled from
//! `tools/bare/guard-probe.mjs --emit`, each `run` keeping its wrapper first) names the guard hooks
//! a Bare tab keeps. Since fold W2 L2a a Claude launch takes its guards from its sets
//! (`Loadout.guard_items`, `from_items`), not `bareGuards`. On every spawn, Raw or hosted, each `run`
//! file is copied to `<config dir>\hooks\<file name>` and the entry becomes `node "<copy>" ...`
//! appended to `hooks.<event>` of that home's settings.json, so both paths write the same file. The home
//! never reads `~\.claude` on its own: only the files named here are copied. Refusals: an
//! unreadable vidar.json or a malformed `bareGuards`; an event that is not one of Claude Code's
//! (`HOOK_EVENTS`, exact case); a `run` led by `fail-closed.mjs` (PreToolUse-only) on another event
//! or with no guard after it; a `run` file that is missing, not absolute or not `.mjs`; two files
//! of one name from different folders (both would land on one copy). A vidar.json without
//! `bareGuards` launches quietly; the launch manifest names the copied files.
//!
//! Codex (P1 W2): `bareCodexGuards`, its own key (`{ event, matcher?, run, open? }`), checked the
//! same way against Codex's events (`CODEX_HOOK_EVENTS`); `copy_codex` copies the files and the
//! repo's `codex-shim.mjs` beside them and builds the hooks.json groups `codex_hooks` writes.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::home::HomeLock;

/// One `bareGuards` entry: a hook event, an optional matcher and the scripts `node` runs.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BareGuard {
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matcher: Option<String>,
    pub run: Vec<String>,
}

/// A rune imported from a hooks.json command. The command is kept verbatim, with no script copy.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RawHook {
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matcher: Option<String>,
    pub command: String,
}

/// Stable public identity for a raw hook. This is only a row key; the discovery reference also
/// carries a SHA-256 digest, which is what protects a pick against a changed source entry.
pub(crate) fn raw_id(event: &str, matcher: Option<&str>, command: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in event.bytes().chain([0]).chain(matcher.unwrap_or("").bytes()).chain([0]).chain(command.bytes()) {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// A command hook has exactly one command and no run/open script list.
pub fn raw_hook(value: &Value) -> Result<Option<RawHook>, String> {
    if value.get("command").is_none() { return Ok(None); }
    let raw: RawHook = serde_json::from_value(value.clone()).map_err(|_| "Raw hook must contain only event, matcher? and a command string".to_string())?;
    if raw.event.is_empty() || raw.command.is_empty() {
        return Err("Raw hook event and command must not be empty".into());
    }
    Ok(Some(raw))
}

/// The native hook group an agent writes for a raw command.
pub fn raw_group(raw: &RawHook, windows_line: bool) -> HookEntry {
    let mut hook = json!({ "type": "command", "command": raw.command });
    if windows_line { hook["commandWindows"] = json!(raw.command); }
    let mut group = json!({ "hooks": [hook] });
    if let Some(m) = &raw.matcher { group["matcher"] = json!(m); }
    (raw.event.clone(), group)
}

/// A generated hook group for `hooks.<event>`: `(event, { matcher?, hooks: [command] })`.
pub type HookEntry = (String, Value);

/// Claude Code's hook events a guard may name, compared exactly (case included).
pub const HOOK_EVENTS: &[&str] = &["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SubagentStop", "SessionStart", "SessionEnd", "Notification", "PreCompact"];

/// Whether Claude Bare can carry a hook event and tool matcher unchanged.
pub(crate) fn claude_unsupported(event: &str, matcher: Option<&str>) -> Option<String> {
    if !HOOK_EVENTS.contains(&event) {
        return Some(format!("Claude has no {event} hook event"));
    }
    if !matches!(event, "PreToolUse" | "PostToolUse") { return None; }
    let Some(m) = matcher.filter(|m| !m.is_empty() && *m != "*") else { return None };
    if m.contains("mcp__") { return None; }
    let re = match regex::Regex::new(&format!("^(?:{m})$")) {
        Ok(re) => re,
        Err(_) => return Some("Matcher is not a valid regex for Claude".into()),
    };
    let tools = ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Task", "WebFetch", "WebSearch", "NotebookEdit"];
    (!tools.iter().any(|t| re.is_match(t))).then(|| format!("Matcher {m:?} names no Claude tool"))
}

/// The global PreToolUse-only wrapper: a `run` starting with it wraps the guard after it.
const FAIL_CLOSED: &str = "fail-closed.mjs";

/// What `copy` made: the hook groups for `generate_settings` and the copied file names (sorted,
/// for the launch manifest).
#[derive(Debug, Default)]
pub struct Copied {
    pub hooks: Vec<HookEntry>,
    pub files: Vec<String>,
}

/// The script files a valid guard list copies: file name (lowercase) -> (source, its canonical folder).
pub type GuardFiles = BTreeMap<String, (PathBuf, PathBuf)>;

/// The checks a spawn runs on `bareGuards` before copying anything (event, `run`, the
/// `fail-closed.mjs` lead, absolute existing `.mjs` files, one folder per file name). Errors carry
/// no suffix: `copy` adds "Bare spawn refused".
pub fn validate(guards: &[BareGuard]) -> Result<GuardFiles, String> {
    validate_for(guards, HOOK_EVENTS, "a Claude Code")
}

/// `validate` against one agent's event list (`HOOK_EVENTS` or `CODEX_HOOK_EVENTS`).
fn validate_for(guards: &[BareGuard], events: &[&str], agent: &str) -> Result<GuardFiles, String> {
    let mut files: GuardFiles = BTreeMap::new();
    for g in guards {
        if !events.contains(&g.event.as_str()) {
            return Err(format!("Bare guard event {:?} is not {agent} hook event ({})", g.event, events.join(", ")));
        }
        if g.run.is_empty() {
            return Err(format!("Bare guard for {} has an empty `run`", g.event));
        }
        let wrapped = Path::new(&g.run[0]).file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(FAIL_CLOSED));
        if wrapped && g.event != "PreToolUse" {
            return Err(format!("Bare guard for {} starts with {FAIL_CLOSED}, which wraps PreToolUse only", g.event));
        }
        if wrapped && g.run.len() < 2 {
            return Err(format!("Bare guard for {} runs {FAIL_CLOSED} with no guard after it", g.event));
        }
        for f in &g.run {
            let src = PathBuf::from(f);
            let mjs = src.extension().is_some_and(|e| e.eq_ignore_ascii_case("mjs"));
            if !src.is_absolute() || !mjs {
                return Err(format!("Bare guard script {f:?} must be an absolute path to a .mjs file"));
            }
            if !src.is_file() {
                return Err(format!("Bare guard script {f} is missing"));
            }
            let folder = src.parent().and_then(|p| std::fs::canonicalize(p).ok()).ok_or_else(|| format!("Bare guard script {f}: its folder is unreadable"))?;
            let name = src.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
            if let Some((other, seen)) = files.get(&name) {
                if *seen != folder {
                    return Err(format!("Bare guard scripts {} and {f} share a file name but sit in different folders", other.display()));
                }
                continue;
            }
            files.insert(name, (src, folder));
        }
    }
    Ok(files)
}

/// A loadout's Claude guard items (`Loadout.guard_items`: `{ event, matcher?, run, open? }`, run
/// paths absolute) as `BareGuard`s, each checked with the ones accepted before it. `open` files are
/// dropped (Claude Code has no shim for them); a malformed or failing guard is skipped. Each drop is
/// one warning (the wording the per-set plugin used, fold W2 L2a).
pub fn from_items(items: &[Value]) -> (Vec<BareGuard>, Vec<String>) {
    let mut accepted: Vec<BareGuard> = Vec::new();
    let mut warnings = Vec::new();
    for g in items {
        if g.get("open").and_then(Value::as_array).is_some_and(|o| !o.is_empty()) {
            warnings.push(format!("guard for {} has `open` files, which Claude Code has no shim for; they were dropped", g["event"].as_str().unwrap_or("?")));
        }
        let mut plain = g.clone();
        if let Some(o) = plain.as_object_mut() {
            o.remove("open");
        }
        let guard: BareGuard = match serde_json::from_value(plain) {
            Ok(b) => b,
            Err(e) => {
                warnings.push(format!("guard {g} is not an event, matcher? and run list ({e}); skipped"));
                continue;
            }
        };
        let mut trial = accepted.clone();
        trial.push(guard.clone());
        if let Err(e) = validate(&trial) {
            warnings.push(format!("guard for {}: {e}; skipped", guard.event));
            continue;
        }
        accepted.push(guard);
    }
    (accepted, warnings)
}

/// Checks every entry (`validate`), then copies each `run` file to `<dir>\<file name>` (the launch's
/// Claude config dir's `hooks\`; written only when its bytes differ, and a file no guard names any
/// more is removed) and returns the hook groups for `generate_settings`. Takes the caller's
/// `HomeLock` (it is not reentrant, so this never locks). Nothing is copied unless every check
/// passes; no guards: nothing is written and `dir` is never made.
pub fn copy(_lock: &HomeLock, dir: &Path, guards: &[BareGuard]) -> Result<Copied, String> {
    let files = validate(guards).map_err(|e| format!("{e}; Bare spawn refused"))?;
    let keep: Vec<std::ffi::OsString> = files.values().map(|(src, _)| src.file_name().unwrap_or_default().to_ascii_lowercase()).collect();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let stale = !keep.contains(&e.file_name().to_ascii_lowercase());
            if stale && e.file_type().is_ok_and(|t| t.is_file()) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    if guards.is_empty() {
        return Ok(Copied::default());
    }

    std::fs::create_dir_all(dir).map_err(|e| format!("Bare guard copies {}: {e}; Bare spawn refused", dir.display()))?;
    for (src, _) in files.values() {
        let bytes = std::fs::read(src).map_err(|e| format!("Bare guard script {}: {e}; Bare spawn refused", src.display()))?;
        let dest = dir.join(src.file_name().unwrap_or_default());
        if std::fs::read(&dest).ok().as_deref() != Some(bytes.as_slice()) {
            crate::fsx::atomic_write(&dest, &bytes).map_err(|e| format!("Bare guard copy {}: {e}; Bare spawn refused", dest.display()))?;
        }
    }
    let mut names: Vec<String> = files.values().map(|(src, _)| src.file_name().unwrap_or_default().to_string_lossy().into_owned()).collect();
    names.sort();
    let hooks = guards
        .iter()
        .map(|g| {
            let args: Vec<String> = g.run.iter().map(|f| format!("\"{}\"", dir.join(Path::new(f).file_name().unwrap_or_default()).display())).collect();
            let mut group = json!({ "hooks": [{ "type": "command", "command": format!("node {}", args.join(" ")) }] });
            if let Some(m) = &g.matcher {
                group["matcher"] = json!(m);
            }
            (g.event.clone(), group)
        })
        .collect();
    Ok(Copied { hooks, files: names })
}

#[path = "guards_codex.rs"]
mod guards_codex;
pub use guards_codex::{copy_codex, BareCodexGuard, CodexGroup, CODEX_HOOK_EVENTS};
#[cfg(test)] // only tests.rs calls it from outside the module
pub use guards_codex::codex_command;
pub(crate) use guards_codex::codex_unsupported;

/// Appends each group to `hooks.<event>` of a substituted settings template, after the
/// template's own groups (a new event becomes a new key).
pub fn append(settings: &mut Value, hooks: &[HookEntry]) -> Result<(), String> {
    if hooks.is_empty() {
        return Ok(());
    }
    let all = settings.get_mut("hooks").and_then(Value::as_object_mut).ok_or("Bare settings template has no `hooks` object for the guard copies")?;
    for (event, group) in hooks {
        let groups = all.entry(event.clone()).or_insert_with(|| json!([]));
        groups.as_array_mut().ok_or_else(|| format!("Bare settings template: hooks.{event} is not an array"))?.push(group.clone());
    }
    Ok(())
}

#[cfg(test)]
mod raw_tests {
    use super::*;

    #[test]
    fn command_hook_has_one_payload_and_agent_specific_events() {
        let raw = json!({ "event": "Interrupt", "command": "pwsh -NoProfile -Command 'exit 7'" });
        assert!(raw_hook(&raw).unwrap().is_some());
        assert!(raw_hook(&json!({ "event": "Stop", "run": ["a.mjs"], "command": "pwsh" })).is_err());
        assert!(codex_unsupported("Interrupt", None).is_none());
        assert_eq!(claude_unsupported("Interrupt", None).as_deref(), Some("Claude has no Interrupt hook event"));
        assert!(codex_unsupported("Notification", None).is_some());
        assert!(claude_unsupported("Notification", None).is_none());
        assert!(codex_unsupported("PreToolUse", Some("not_a_tool")).is_some());
        assert!(claude_unsupported("PreToolUse", Some("apply_patch")).is_some());
    }
}
