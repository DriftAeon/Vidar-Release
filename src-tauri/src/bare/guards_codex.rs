//! src-tauri\src\bare\guards_codex.rs — the Codex half of `guards.rs` (`bareCodexGuards`): its events, its shim, the support check and `copy_codex`.
//! Split from guards.rs by agent; guards.rs re-exports every name here.

use super::*;

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

/// Why Codex cannot carry a guard on `event` with `matcher`, by the rules `copy_codex` applies (its
/// events, and a tool-event matcher that must hit a Codex tool); `None` when Codex carries it.
pub(crate) fn codex_unsupported(event: &str, matcher: Option<&str>) -> Option<String> {
    let known = CODEX_HOOK_EVENTS.contains(&event);
    match known {
        true => {}
        false => return Some(format!("Codex has no {event} hook event")),
    }
    let tool_event = matches!(event, "PreToolUse" | "PostToolUse" | "PermissionRequest");
    match (tool_event, matcher) {
        (true, Some(m)) => match matcher_hits_codex(m) {
            Ok(true) => None,
            Ok(false) => Some(format!("Matcher {m:?} names no Codex tool ({})", CODEX_TOOLS.join(", "))),
            Err(e) => Some(e),
        },
        _ => None,
    }
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
            let hits = matcher_hits_codex(m).map_err(refuse)?;
            match hits {
                true => {}
                false => {
                    warnings.push(format!("bareCodexGuards entry for {} with matcher {m:?} names no Codex tool ({}); entry dropped", g.event, CODEX_TOOLS.join(", ")));
                    continue;
                }
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
