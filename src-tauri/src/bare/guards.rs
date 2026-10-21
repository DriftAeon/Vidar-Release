//! src-tauri\src\bare\guards.rs — guard hook copies for a Claude Bare home (Bare slice 1, W3).
//! `bareGuards` in vidar.json (`[{ event, matcher?, run: ["<abs .mjs>", ...] }]`, filled from
//! `tools/bare/guard-probe.mjs --emit`, each `run` keeping its wrapper first) names the guard hooks
//! a Bare tab keeps. On every spawn, Raw or hosted, each `run` file is copied to
//! `<home>\layer\hooks\<file name>` and the entry becomes `node "<copy>" ...` appended to
//! `hooks.<event>` of the generated settings.json, so both paths write the same file. The home
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

/// A generated hook group for `hooks.<event>`: `(event, { matcher?, hooks: [command] })`.
pub type HookEntry = (String, Value);

/// Claude Code's hook events a guard may name, compared exactly (case included).
pub const HOOK_EVENTS: &[&str] = &["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SubagentStop", "SessionStart", "SessionEnd", "Notification", "PreCompact"];

/// The global PreToolUse-only wrapper: a `run` starting with it wraps the guard after it.
const FAIL_CLOSED: &str = "fail-closed.mjs";

/// `bareGuards` from vidar.json at `config`, parsed read-only (never `config::load`). A missing
/// file or key gives none, quietly (Settings > Agents shows the count); an unreadable file or a
/// malformed value refuses.
pub fn read(config: &Path) -> Result<Vec<BareGuard>, String> {
    let text = match crate::fsx::read_text(config) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("vidar.json {} is unreadable ({e}); Bare spawn refused", config.display())),
    };
    let root: Value = serde_json::from_str(crate::fsx::strip_bom(&text))
        .map_err(|e| format!("vidar.json {} is unreadable ({e}); Bare spawn refused", config.display()))?;
    match root.get("bareGuards") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(v) => serde_json::from_value(v.clone())
            .map_err(|e| format!("vidar.json `bareGuards` is not a list of {{ event, matcher?, run }} ({e}); Bare spawn refused")),
    }
}

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
/// no suffix: `copy` adds "Bare spawn refused", `bare_layer_set` its own.
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

/// Checks every entry (`validate`), then copies each `run` file to `<home>\layer\hooks\<file name>`
/// (fresh on every spawn) and returns the hook groups for `generate_settings`. Takes the caller's
/// `HomeLock` (it is not reentrant, so this never locks). Nothing is copied unless every check
/// passes; no guards: nothing is written and `layer\` is never made.
pub fn copy(_lock: &HomeLock, home_dir: &Path, guards: &[BareGuard]) -> Result<Copied, String> {
    let files = validate(guards).map_err(|e| format!("{e}; Bare spawn refused"))?;
    if guards.is_empty() {
        return Ok(Copied::default());
    }

    let dir = home_dir.join("layer").join("hooks");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Bare guard copies {}: {e}; Bare spawn refused", dir.display()))?;
    for (src, _) in files.values() {
        let bytes = std::fs::read(src).map_err(|e| format!("Bare guard script {}: {e}; Bare spawn refused", src.display()))?;
        let dest = dir.join(src.file_name().unwrap_or_default());
        crate::fsx::atomic_write(&dest, &bytes).map_err(|e| format!("Bare guard copy {}: {e}; Bare spawn refused", dest.display()))?;
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

// ---- Codex (`bareCodexGuards`, plan p1-codex-hooks.md § 4 and Revisions) ----

/// One `bareCodexGuards` entry: `bareGuards`' shape plus `open`, the fail-open guards
/// (guard-driver) the shim runs after the blocking ones. Its own key: `BareGuard` refuses
/// unknown fields, so an `agent` field on `bareGuards` would break older builds.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BareCodexGuard {
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matcher: Option<String>,
    pub run: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub open: Vec<String>,
}

/// Codex's hook events a guard may name, compared exactly (case included).
pub const CODEX_HOOK_EVENTS: &[&str] = &[
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "UserPromptSubmit",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "Interrupt",
    "SessionStart",
    "SessionEnd",
];

/// The repo-owned PreToolUse shim every Codex PreToolUse entry runs its guards through.
pub const CODEX_SHIM: &str = "codex-shim.mjs";

/// Codex tool names a PreToolUse matcher can hit (`apply_patch` also answers to `Edit` and `Write`).
const CODEX_TOOLS: &[&str] = &["Bash", "apply_patch", "Edit", "Write"];

/// `bareCodexGuards` from vidar.json at `config`, read-only, with `read`'s rules. An absent key is
/// the plain empty list: a fresh install launches quietly and Settings shows the state.
pub fn read_codex(config: &Path) -> Result<Vec<BareCodexGuard>, String> {
    let text = match crate::fsx::read_text(config) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("vidar.json {} is unreadable ({e}); Bare spawn refused", config.display())),
    };
    let root: Value = serde_json::from_str(crate::fsx::strip_bom(&text))
        .map_err(|e| format!("vidar.json {} is unreadable ({e}); Bare spawn refused", config.display()))?;
    match root.get("bareCodexGuards") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(v) => serde_json::from_value(v.clone())
            .map_err(|e| format!("vidar.json `bareCodexGuards` is not a list of {{ event, matcher?, run, open? }} ({e}); Bare spawn refused")),
    }
}

/// One generated Codex hook group: its event and the `{ matcher?, hooks: [handler] }` object.
pub type CodexGroup = (String, Value);

/// What `copy_codex` made: the groups for hooks.json (entry order), the copied file names
/// (sorted, the shim included) and the entries dropped with a warning.
#[derive(Debug, Default)]
pub struct CodexCopied {
    pub groups: Vec<CodexGroup>,
    pub files: Vec<String>,
    pub warnings: Vec<String>,
}

/// Whether a tool-event matcher can hit a Codex tool: absent, empty or `*` match all; an `mcp__`
/// name is Codex's own MCP form; else the regex must match one of `CODEX_TOOLS`. A bad regex refuses.
fn matcher_hits_codex(m: &str) -> Result<bool, String> {
    if m.is_empty() || m == "*" || m.contains("mcp__") {
        return Ok(true);
    }
    let re = regex::Regex::new(&format!("^(?:{m})$")).map_err(|e| format!("Bare Codex guard matcher {m:?} is not a valid regex ({e})"))?;
    Ok(CODEX_TOOLS.iter().any(|t| re.is_match(t)))
}

/// `s` as a PowerShell single-quoted string (a `'` doubled), so no `$` or backtick in a path expands.
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// The handler line Codex runs through PowerShell (`commandWindows`): the call operator first (a
/// quoted first token is a parse error), then `exit $LASTEXITCODE` (else -Command turns exit 2 into 1).
pub fn codex_command(node: &Path, argv: &[String]) -> String {
    let mut parts = vec!["&".to_string(), ps_quote(&node.to_string_lossy())];
    parts.extend(argv.iter().map(|a| if a.starts_with("--") { a.clone() } else { ps_quote(a) }));
    format!("{}; exit $LASTEXITCODE", parts.join(" "))
}

/// Checks `bareCodexGuards` (Codex events, `open` on PreToolUse only, `validate`'s file rules, no
/// user file named like the shim, the shim present), then copies every file and the shim to
/// `<home>\layer\hooks\` and returns the hooks.json groups. A PreToolUse entry runs
/// `[fail-closed.mjs] codex-shim.mjs --guard <each run> --open-guard <each open>`; any other event
/// runs its `run` as Claude's copies do. A tool-event matcher that hits no Codex tool drops its
/// entry with a warning. Nothing is copied unless every check passes; no guards: nothing written.
pub fn copy_codex(_lock: &HomeLock, home_dir: &Path, node: &Path, shim: &Path, guards: &[BareCodexGuard]) -> Result<CodexCopied, String> {
    let refuse = |e: String| format!("{e}; Bare spawn refused");
    let mut kept: Vec<&BareCodexGuard> = Vec::new();
    let mut warnings = Vec::new();
    for g in guards {
        if g.run.is_empty() {
            return Err(refuse(format!("Bare guard for {} has an empty `run`", g.event)));
        }
        if !g.open.is_empty() && g.event != "PreToolUse" {
            return Err(refuse(format!("Bare Codex guard for {} has `open` guards, which the PreToolUse shim runs only", g.event)));
        }
        let tool_event = matches!(g.event.as_str(), "PreToolUse" | "PostToolUse" | "PermissionRequest");
        if let (true, Some(m)) = (tool_event, g.matcher.as_deref()) {
            if !matcher_hits_codex(m).map_err(refuse)? {
                warnings.push(format!("bareCodexGuards entry for {} with matcher {m:?} names no Codex tool ({}); entry dropped", g.event, CODEX_TOOLS.join(", ")));
                continue;
            }
        }
        kept.push(g);
    }
    let merged = |list: &[&BareCodexGuard]| -> Vec<BareGuard> {
        list.iter().map(|g| BareGuard { event: g.event.clone(), matcher: g.matcher.clone(), run: g.run.iter().chain(&g.open).cloned().collect() }).collect()
    };
    // Every entry is checked, a dropped one included; only the kept ones are copied.
    let all = validate_for(&merged(&guards.iter().collect::<Vec<_>>()), CODEX_HOOK_EVENTS, "a Codex").map_err(refuse)?;
    if all.contains_key(CODEX_SHIM) {
        return Err(refuse(format!("Bare Codex guard list names a {CODEX_SHIM}; Vidar adds its own shim")));
    }
    let mut files = validate_for(&merged(&kept), CODEX_HOOK_EVENTS, "a Codex").map_err(refuse)?;
    if kept.is_empty() {
        return Ok(CodexCopied { warnings, ..Default::default() });
    }
    if kept.iter().any(|g| g.event == "PreToolUse") {
        if !shim.is_file() {
            return Err(refuse(format!("Bare Codex guard shim {} is missing", shim.display())));
        }
        let folder = shim.parent().and_then(|p| std::fs::canonicalize(p).ok()).unwrap_or_default();
        files.insert(CODEX_SHIM.into(), (shim.to_path_buf(), folder));
    }

    let dir = home_dir.join("layer").join("hooks");
    std::fs::create_dir_all(&dir).map_err(|e| refuse(format!("Bare guard copies {}: {e}", dir.display())))?;
    for (src, _) in files.values() {
        let bytes = std::fs::read(src).map_err(|e| refuse(format!("Bare guard script {}: {e}", src.display())))?;
        let dest = dir.join(src.file_name().unwrap_or_default());
        crate::fsx::atomic_write(&dest, &bytes).map_err(|e| refuse(format!("Bare guard copy {}: {e}", dest.display())))?;
    }
    let mut names: Vec<String> = files.values().map(|(src, _)| src.file_name().unwrap_or_default().to_string_lossy().into_owned()).collect();
    names.sort();
    let copy_of = |f: &str| dir.join(Path::new(f).file_name().unwrap_or_default()).to_string_lossy().into_owned();
    let groups = kept
        .iter()
        .map(|g| {
            let wrapped = Path::new(&g.run[0]).file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(FAIL_CLOSED));
            let argv: Vec<String> = if g.event == "PreToolUse" {
                let mut a: Vec<String> = Vec::new();
                if wrapped {
                    a.push(copy_of(&g.run[0]));
                }
                a.push(copy_of(CODEX_SHIM));
                for f in &g.run[usize::from(wrapped)..] {
                    a.extend(["--guard".to_string(), copy_of(f)]);
                }
                for f in &g.open {
                    a.extend(["--open-guard".to_string(), copy_of(f)]);
                }
                a
            } else {
                g.run.iter().map(|f| copy_of(f)).collect()
            };
            let line = codex_command(node, &argv);
            let mut group = json!({ "hooks": [{ "type": "command", "command": line, "commandWindows": line }] });
            if let Some(m) = &g.matcher {
                group["matcher"] = json!(m);
            }
            (g.event.clone(), group)
        })
        .collect();
    Ok(CodexCopied { groups, files: names, warnings })
}

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
