//! src-tauri\src\bare\set_layer.rs — the shapes a set's old `<library>\sets\<set>.layer.json` sidecar used.
//! Nothing reads a sidecar at launch any more: a session loads only the runes of its vault. What stays:
//! `sidecar_path` (tests only) and the name helpers, and `Permissions` (a rune item's shape). No code here writes a sidecar.

use std::path::{Path, PathBuf};

use serde_json::Value;

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

/// The legacy sidecar of `set` in library folder `dir`; only tests build one.
#[cfg(test)]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_case_insensitive_file_names() {
        assert_eq!(name_of("C:\\x\\Tidy"), "tidy");
        let g = serde_json::json!({ "event": "PreToolUse", "matcher": "Bash", "run": ["C:\\x\\G.mjs"] });
        assert_eq!(guard_name(&g), "PreToolUse|Bash|g.mjs");
    }
}
