//! src-tauri\src\settings\schema.rs — the typed vidar.json shape.
//! `#[serde(default)]` on every struct means an old file missing a newer key
//! still parses instead of refusing the whole config.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

// TRUST MODEL: vidar.json is writable by the same principal that could replace
// vidar.exe itself — validating its *authorship* is theater. What we do enforce
// is operational: typed parse with defaults, no env expansion, no shell
// interpretation of any config string, and error surfacing instead of crashes.
// The ＋ menu is types × locations: an agent is WHAT a tab runs (command per
// type), a location is WHERE. The older flat `launchers` list is gone;
// a stale `launchers` key in a file is ignored like any unknown key.
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentCfg {
    /// "claude" | "codex" | "gemini" | "pi" | "shell" — drives the tab colour and agent-scoped controls
    pub id: String,
    pub label: Option<String>,
    pub shell: Option<String>,
    pub args: Option<Vec<String>>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// "astra": the tab arms itself as the review target (sessions.ts bridge)
    pub role: Option<String>,
    /// overrides the picked location's cwd (Astra: bridge\display, so workspace-write
    /// can't reach the repo)
    pub cwd: Option<String>,
    /// variant: rendered inside the flyout of the top-level type with this `id`
    /// (Astra under Codex). Resolved by the frontend; only declared here so the
    /// typed round-trip doesn't drop it.
    pub under: Option<String>,
    /// "rendered": the tab runs the agent headless and Vidar draws it
    /// (panels/rendered.ts); absent = terminal. Claude only.
    pub body: Option<String>,
    /// Rendered tabs: "default" | "acceptEdits" | "plan" | "auto". Anything else is
    /// refused at spawn (src-falcon\src\protocol.rs, its mode allowlist) — a config
    /// entry cannot widen it.
    pub permission_mode: Option<String>,
    /// Stable overlay identity: an entry with `key` matches the built-in row with the
    /// same key (so it can relabel or move it); without one it matches by
    /// id/under/label (the frontend's overlay, src\config-agents.ts). Declared so the
    /// typed round-trip keeps it.
    pub key: Option<String>,
    /// `true` removes the matching built-in row (and, for a root, its variants).
    /// Declared so the typed round-trip keeps it.
    pub disabled: Option<bool>,
    /// Every field this build doesn't name (`requires`, a future key, a hand-written
    /// oddity) rides here so file → `read_config` → webview → `patch_settings` → file
    /// keeps it. Opaque in Rust; the webview owns its meaning.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LocationCfg {
    pub label: String,
    pub cwd: String,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MacroCfg {
    pub label: String,
    pub command: String,
    pub submit: Option<bool>,
    /// Unnamed fields round-trip, same as `AgentCfg::extra`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// `editor` in vidar.json: `exe` is spawned directly (must be an existing `.exe`, so a
/// `.cmd`/`.bat` can never route the launch through cmd.exe) and each `args` element is one
/// argv entry. `{file}` and `{line}` are replaced inside each element on its own; elements
/// are never joined. Absent `args` = `["{file}"]`.
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EditorCfg {
    pub exe: String,
    pub args: Option<Vec<String>>,
}

/// `editor` never fails the whole config: a bare string is `{ exe: s }`; any other shape
/// that doesn't parse as `EditorCfg` (a number, `args` not an array…) logs and yields None,
/// so the rest of vidar.json still loads.
fn lenient_editor<'de, D>(d: D) -> Result<Option<EditorCfg>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = Value::deserialize(d)?;
    Ok(match v {
        Value::Null => None,
        Value::String(s) => Some(EditorCfg { exe: s, args: None }),
        other => match serde_json::from_value::<EditorCfg>(other) {
            Ok(e) => Some(e),
            Err(e) => {
                eprintln!("config: ignoring `editor` (expected {{exe, args[]}} or a path string): {e}");
                None
            }
        },
    })
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VidarConfig {
    /// Absent on disk = version 0, the shape before this field existed.
    /// `settings::migrate` stamps the current version on read; a value this
    /// build doesn't recognise as "at or below current" is left as read
    /// (migrations only ever move forward).
    pub config_version: Option<u32>,
    pub font_size: Option<u16>,
    /// Flow grid-line strength, whole percent 0..=100 (`patch_settings` validates).
    /// Declared so the typed `read_config` round-trip keeps a saved value.
    pub flow_grid_opacity: Option<u8>,
    pub default_cwd: Option<String>,
    /// Legacy file-link editor (Rider only). Read only when `editor` is absent or has a
    /// blank `exe`; then it stands in as `{ exe: riderPath, args: ["--line","{line}","{file}"] }`
    /// (`editor.rs::resolve`). Never rewritten into `editor`.
    pub rider_path: Option<String>,
    /// File-link editor: an executable plus an argv array, never a shell string.
    /// Wins over `rider_path` whenever its `exe` is non-blank. Lenient (`lenient_editor`).
    #[serde(deserialize_with = "lenient_editor")]
    pub editor: Option<EditorCfg>,
    /// App for Open Externally on a document: an existing `.exe`, spawned with the file as
    /// its one argument. Absent or blank = the Windows default app (`chrome.rs::open_document`).
    pub document_app: Option<String>,
    /// Retired pick for the `rewrite` voice slot: "none" = empty, any other value makes the
    /// slot broken ("speakRewrite Is Retired: Use voiceSlots.rewrite"). Absent = empty (core
    /// `strip_markdown`). Read raw by `voice_slots` per Speak press, never through this field.
    pub speak_rewrite: Option<String>,
    /// LM Studio origin override, e.g. "http://127.0.0.1:1235". Absent or invalid (not an
    /// http(s) origin) = `DEFAULT_ORIGIN` in `lmstudio.rs`; an invalid value is logged once,
    /// never a panic. Read fresh per status probe via `lmstudio::probe()`.
    pub lmstudio_origin: Option<String>,
    /// Days an archived Tray entry (`runtime\bridge\workbench\archive\`) is kept before the
    /// start-up purge deletes it. Absent = 7; 0 or negative = never purge. Read once at start
    /// (`bridge::purge_workbench_archive`).
    pub workbench_archive_days: Option<i64>,
    /// The rules library folder (kind folders `rules/ facts/ procedures/ sets/` and `tombstones.md`; `rules/library.rs`); relative = under the
    /// Vidar root, like `pluginDirs`. Read by `rules::rules_prepare` per launch. Declared for that
    /// typed read; `patch_settings` does not accept it yet (the GUI wave adds a `KeySpec`).
    /// Absent = rules are skipped with a warning.
    pub rules_library: Option<String>,
    /// Which body row leads the launcher's body column: "bare" or "raw" (`src/launcher/body-order.ts`
    /// reads it once at start; any other value reads as absent). Hand-edit only, no `KeySpec`.
    pub launcher_lead: Option<String>,
    /// Guard hooks every Claude Bare tab keeps: `[{ event, matcher?, run: ["<abs .mjs>", ...] }]`,
    /// filled from `tools/bare/guard-probe.mjs --emit`. Read raw per spawn by `bare/guards.rs`,
    /// which copies each script into the home; opaque here so a malformed value cannot fail the
    /// whole parse. Declared so `read_config` round-trips it. Hand-edit only.
    pub bare_guards: Option<Value>,
    /// Hosted MCP servers every Codex Bare tab carries: `["notion", "atlassian"]`. Read raw per spawn by
    /// `bare/codex_mcp.rs`, which appends the pinned tables to the generated config; opaque here so a
    /// malformed value cannot fail the whole parse. Absent = none. Hand-edit only.
    pub bare_codex_mcp: Option<Value>,
    /// The primary agent: "codex" or "claude" (`patch_settings` validates; `""` removes the key).
    /// Absent = not yet asked; the webview resolves it at use time against the active agent
    /// modules (`src/agents/primary.ts` `effectivePrimary`), so an uninstalled pick falls back.
    pub primary_agent: Option<String>,
    pub agents: Option<Vec<AgentCfg>>,
    pub locations: Option<Vec<LocationCfg>>,
    pub macros: Option<Vec<MacroCfg>>,
    // `models` (the Config band's model dropdown) was removed: the
    // Rendered status line and the terminal already show the model. `logRoots`
    // (the Output Log tool) was removed too. A stale key of either in vidar.json is ignored.
    /// shortcut id -> chord ("Ctrl+T"); only overrides of the built-in defaults
    pub shortcuts: Option<HashMap<String, String>>,
    /// Tray behaviour and summon chord. Hand-edit only; applies at startup.
    pub window: crate::tray_config::WindowTrayCfg,
    /// Always present in the result (defaults filled in) so the webview never guesses.
    pub voice: crate::voice::VoiceCfg,
    /// Always present, same reasoning as `voice`.
    pub wakeword: crate::listen::WakewordCfg,
    /// Voice slot picks: slot -> `{ adapter: "<pack>/<id>", model?: "<id>" }`. Opaque here, so a
    /// malformed pick cannot fail the whole parse; `voice_slots` reads the raw file and reports
    /// it as a broken slot. Declared so `read_config` round-trips it.
    pub voice_slots: Option<Value>,
    /// Per-character saved default camera view: id -> `{ position, target, zoom }`.
    /// Opaque JSON — the frontend validates shape/finiteness before ever applying one.
    pub character_views: Option<HashMap<String, Value>>,
    /// Character window stage pick: a stage id from `content\stages\` (`patch_settings`
    /// validates it); absent = the built-in default stage. Opaque here so a hand-edited wrong
    /// type cannot fail the whole parse; the webview falls back to the default.
    pub character_stage: Option<Value>,
    /// Capability overlay: id -> `false` switches a capability off in the webview's
    /// registry (src/capabilities/registry.ts). Opaque here; passed through so the key
    /// reaches `read_config`, which would otherwise drop it. Any JSON shape is accepted: a
    /// malformed overlay must not fail the whole parse (TS ignores non-objects).
    pub capabilities: Option<Value>,
    /// Falcon options: `{ "hostedCodex": true }` lets Codex Rendered tabs run in the Falcon host
    /// when it can (opt-in until the live journeys pass). Opaque here, like `capabilities`, so a
    /// malformed value cannot fail the parse; the webview reads it once at start
    /// (`src/launcher/readopt.ts` `readHostedCodexGate`). Declared so `read_config` passes it on.
    pub falcon: Option<Value>,
    /// Jira tab: `{ "site", "jql" }`, validated on write by `jira::config::validate_settings`
    /// and again at request time. Opaque here, like `falcon`, so a hand edit cannot fail the parse.
    pub jira: Option<Value>,
    /// User-set module names: `{ "<module id>": "<name>" }`, validated on write by
    /// `commands::validate_module_names`. Opaque here, so a hand edit cannot fail the parse;
    /// the webview cleans it (`src/modules/names.ts`).
    pub module_names: Option<Value>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigResult {
    pub config: VidarConfig,
    /// A real problem: unparsable file, or a read error. Shown as the alert-styled banner.
    pub error: Option<String>,
    /// Informational: a real migration step ran (shape changed). Shown neutrally, never
    /// on a no-op version bump. Distinct from `error` so main.ts can style it differently.
    pub notice: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_capabilities_overlay_keeps_the_rest_of_the_config() {
        for bad in [Value::Bool(false), serde_json::json!([]), Value::from("off")] {
            let raw = serde_json::json!({ "fontSize": 17, "capabilities": bad });
            let cfg: VidarConfig = serde_json::from_value(raw).expect("config parses");
            assert_eq!(cfg.font_size, Some(17));
        }
    }

    /// `falcon.hostedCodex` reaches `read_config`; any shape parses (the webview validates it).
    #[test]
    fn falcon_options_pass_through_and_never_fail_the_parse() {
        let raw = serde_json::json!({ "falcon": { "hostedCodex": true } });
        let cfg: VidarConfig = serde_json::from_value(raw).expect("config parses");
        let back = serde_json::to_value(&cfg).unwrap();
        assert_eq!(back["falcon"]["hostedCodex"], Value::Bool(true));
        for bad in [Value::Bool(true), serde_json::json!([]), Value::from("on")] {
            let raw = serde_json::json!({ "fontSize": 17, "falcon": bad });
            let cfg: VidarConfig = serde_json::from_value(raw).expect("config parses");
            assert_eq!(cfg.font_size, Some(17));
        }
    }

    #[test]
    fn module_names_pass_through_and_a_bad_shape_never_fails_the_parse() {
        let raw = serde_json::json!({ "moduleNames": { "doc": "Docs" } });
        let cfg: VidarConfig = serde_json::from_value(raw).expect("config parses");
        let back = serde_json::to_value(&cfg).unwrap();
        assert_eq!(back["moduleNames"]["doc"], Value::from("Docs"));
        for bad in [Value::Bool(true), serde_json::json!([]), Value::from("Docs"), serde_json::json!({ "doc": 3 })] {
            let raw = serde_json::json!({ "fontSize": 17, "moduleNames": bad });
            let cfg: VidarConfig = serde_json::from_value(raw).expect("config parses");
            assert_eq!(cfg.font_size, Some(17));
        }
    }

    #[test]
    fn flow_grid_opacity_reads_back_camel_case() {
        let raw = serde_json::json!({ "flowGridOpacity": 30 });
        let cfg: VidarConfig = serde_json::from_value(raw).expect("config parses");
        assert_eq!(cfg.flow_grid_opacity, Some(30));
        let back = serde_json::to_value(&cfg).unwrap();
        assert_eq!(back.get("flowGridOpacity"), Some(&serde_json::json!(30)));
    }

    #[test]
    fn launcher_lead_reads_back_camel_case_and_is_absent_by_default() {
        let cfg: VidarConfig = serde_json::from_value(serde_json::json!({ "launcherLead": "bare" })).expect("config parses");
        assert_eq!(cfg.launcher_lead.as_deref(), Some("bare"));
        let back = serde_json::to_value(&cfg).unwrap();
        assert_eq!(back.get("launcherLead"), Some(&serde_json::json!("bare")));
        let none: VidarConfig = serde_json::from_value(serde_json::json!({})).expect("config parses");
        assert!(none.launcher_lead.is_none());
    }

    #[test]
    fn agent_unknown_fields_round_trip_through_the_typed_parse() {
        let raw = serde_json::json!({
            "id": "claude",
            "key": "claude-opus",
            "requires": ["claude"],
            "x": { "nested": [1, "two", null], "flag": true }
        });
        let agent: AgentCfg = serde_json::from_value(raw.clone()).expect("agent parses");
        assert_eq!(agent.key.as_deref(), Some("claude-opus"));
        let back = serde_json::to_value(&agent).unwrap();
        assert_eq!(back.get("requires"), raw.get("requires"));
        assert_eq!(back.get("x"), raw.get("x"));
        assert_eq!(back.get("id"), raw.get("id"));
        assert_eq!(back.get("key"), raw.get("key"));
    }
}
