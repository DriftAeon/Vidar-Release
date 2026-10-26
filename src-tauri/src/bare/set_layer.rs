//! src-tauri\src\bare\set_layer.rs — the shapes a set's old `<library>\sets\<set>.layer.json` sidecar used.
//! Nothing reads a sidecar at launch any more: a session loads only the runes of its vault. What stays:
//! `sidecar_path` and the name helpers, which `vault::migrate` uses to turn a legacy sidecar into item
//! runes, `Permissions` (a rune item's shape), and `SetLayerWrite`, the input of Add Kit and of
//! `item_import` (paths and guard objects to turn into item runes). No code here writes a sidecar.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::bundles::SetModules;
use super::guards;

/// A set's `permissions`: tool rules to allow, tool rules to ask about, and a permission mode.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Permissions {
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub ask: Vec<String>,
    #[serde(default)]
    pub mode: Option<String>,
}

/// The legacy sidecar of `set` in library folder `dir`; only `migrate` and the fork copy read it.
pub fn sidecar_path(dir: &Path, set: &str) -> PathBuf {
    dir.join("sets").join(format!("{set}.layer.json"))
}

/// The real user home a `~` stands for.
pub fn user_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// The machine paths a Bare prepare reads besides the install root and the agent home: the user's
/// home and the user's own Codex `config.toml` (folder trust). Callers pass
/// them in, so a test builds a prepare that never touches the real machine (`Default` = neither).
#[derive(Clone, Debug, Default)]
pub struct Ambient {
    pub user_home: Option<PathBuf>,
    pub codex_config: Option<PathBuf>,
}

impl Ambient {
    /// This process's machine: what every production caller passes.
    pub fn from_env() -> Self {
        Self { user_home: user_home(), codex_config: super::codex_user_trust::user_config_path() }
    }
}

pub(crate) fn name_of(path: &str) -> String {
    Path::new(path).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_else(|| path.to_lowercase())
}

pub(crate) fn guard_name(g: &Value) -> String {
    if let Some(command) = g.get("command").and_then(Value::as_str) {
        let event = g["event"].as_str().unwrap_or("");
        let matcher = g.get("matcher").and_then(Value::as_str);
        return format!("{event}|{}|cmd-{}", matcher.unwrap_or(""), guards::raw_id(event, matcher, command));
    }
    if let Some(source) = g.get("source").and_then(Value::as_str) {
        return format!("{}|{}|cmd-{}", g["event"].as_str().unwrap_or(""), g.get("matcher").and_then(Value::as_str).unwrap_or(""), source.rsplit(':').next().unwrap_or(""));
    }
    let run: Vec<String> = g.get("run").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(name_of).collect();
    format!("{}|{}|{}", g["event"].as_str().unwrap_or(""), g.get("matcher").and_then(Value::as_str).unwrap_or(""), run.join(","))
}

/// Resolve a discovery-only hook reference against the live Codex home before saving a rune; a `rune:`
/// reference resolves against `stored`.
pub(crate) fn resolve_hook_ref(g: &Value, home: Option<&Path>, stored: &[Value]) -> Result<Value, String> {
    let Some(source) = g.get("source").and_then(Value::as_str) else { return Ok(g.clone()) };
    if g.get("command").is_some() || g.get("open").is_some() || g.get("run").and_then(Value::as_array).is_none_or(|v| !v.is_empty()) {
        return Err("Hook selection contains command or script data; set layer not saved".into());
    }
    let event = g.get("event").and_then(Value::as_str).ok_or("Hook selection has no event")?;
    let matcher = g.get("matcher").and_then(Value::as_str);
    if let Some(id) = source.strip_prefix("rune:") {
        return stored.iter()
            .find(|s| guards::raw_hook(s).ok().flatten().is_some_and(|r| r.event == event && r.matcher.as_deref() == matcher && guards::raw_id(&r.event, r.matcher.as_deref(), &r.command) == id))
            .cloned()
            .ok_or_else(|| "Stored hook rune changed or is gone; refresh the Runes tab; set layer not saved".to_string());
    }
    let codex = crate::rules::import::sources::live_codex_home(home).ok_or("Codex home is unavailable; set layer not saved")?;
    crate::rules::import::codex_home::resolve_hook_at(&codex, event, matcher, source)
}

/// Whether `set` is a plain set name: not empty, no `/ \ :` and no `..`.
pub fn plain_set_name(set: &str) -> bool {
    !(set.is_empty() || set.contains(['/', '\\', ':']) || set.contains(".."))
}

/// What Add Kit and `bare_items_import` turn into item runes: a present key lists the items to import.
#[derive(serde::Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SetLayerWrite {
    #[serde(default)]
    pub skills: Option<Vec<String>>,
    #[serde(default)]
    pub agents: Option<Vec<String>>,
    #[serde(default)]
    pub guards: Option<Vec<Value>>,
    #[serde(default)]
    pub codex_skills: Option<Vec<String>>,
    #[serde(default)]
    pub codex_agents: Option<Vec<String>>,
    #[serde(default)]
    pub codex_guards: Option<Vec<Value>>,
    #[serde(default)]
    pub modules: Option<SetModules>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_set_names_refuse_separators_and_dots() {
        for set in ["", "a/b", "a\\b", "c:x", "..", "a..b"] {
            assert!(!plain_set_name(set), "{set:?}");
        }
        assert!(plain_set_name("kit"));
    }

    #[test]
    fn names_are_case_insensitive_file_names() {
        assert_eq!(name_of("C:\\x\\Tidy"), "tidy");
        let g = serde_json::json!({ "event": "PreToolUse", "matcher": "Bash", "run": ["C:\\x\\G.mjs"] });
        assert_eq!(guard_name(&g), "PreToolUse|Bash|g.mjs");
    }
}
