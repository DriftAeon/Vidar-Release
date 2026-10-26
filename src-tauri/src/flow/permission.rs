//! The permission mode Flow Claude nodes spawn with: Flow's own `FLOW_MODE`, limited to the modes a
//! node can act in. `bypassPermissions` and `plan` are never followed; `auto` needs a classifier a
//! gateway model cannot run, so it falls back to `default` there.

use std::collections::HashMap;

use super::env::CLAUDE_MODELS;

const ACCEPTED: &[&str] = &["default", "acceptEdits", "auto"];

/// Flow's own mode source. It used to read `--permission-mode` from the Bare Claude profile; a Bare
/// session's mode now comes from its Rune Vault (`mode-auto` stock rune, run 2026-10-25-rune-vault
/// L2b), and a Flow node is not a Bare session, so Flow keeps the `auto` the profile held.
const FLOW_MODE: &str = "auto";

/// The mode `requested` becomes for `model`: re-validated against the accepted set, and `auto`
/// drops to `default` for a model outside `CLAUDE_MODELS`.
pub(super) fn effective(requested: &str, model: &str) -> &'static str {
    let mode = ACCEPTED.iter().copied().find(|m| *m == requested).unwrap_or("default");
    if mode == "auto" && !CLAUDE_MODELS.contains(&model) { "default" } else { mode }
}

/// Flow's mode as it applies to each of `models`.
#[tauri::command]
pub fn flow_permission_modes(models: Vec<String>) -> Result<HashMap<String, String>, String> {
    Ok(models.into_iter().map(|m| { let e = effective(FLOW_MODE, &m).to_string(); (m, e) }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flow_mode_is_auto_and_accepted() {
        assert_eq!(FLOW_MODE, "auto");
        assert!(ACCEPTED.contains(&FLOW_MODE));
    }

    #[test]
    fn flow_mode_no_longer_reads_the_bare_profile() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("profiles/bare/claude.json");
        let doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        assert!(!doc["args"].as_array().unwrap().iter().any(|a| a == "--permission-mode"), "the Bare profile carries no mode; the vault does");
        let modes = flow_permission_modes(vec!["claude-sonnet-5".into(), "glm-5".into()]).unwrap();
        assert_eq!(modes["claude-sonnet-5"], "auto");
        assert_eq!(modes["glm-5"], "default");
    }

    #[test]
    fn auto_holds_for_claude_models_only() {
        assert_eq!(effective("auto", "claude-sonnet-5"), "auto");
        assert_eq!(effective("auto", "glm-5"), "default");
        assert_eq!(effective("acceptEdits", "glm-5"), "acceptEdits");
        assert_eq!(effective("bypassPermissions", "claude-sonnet-5"), "default");
        assert_eq!(effective("plan", "claude-sonnet-5"), "default");
    }
}
