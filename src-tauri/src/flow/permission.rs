//! The permission mode Flow Claude nodes spawn with: the Bare Claude profile's `--permission-mode`
//! (`profiles/bare/claude.json`), limited to the modes a node can act in. `bypassPermissions` and
//! `plan` are never followed; `auto` needs a classifier a gateway model cannot run, so it falls
//! back to `default` there.

use std::collections::HashMap;
use std::path::Path;

use super::env::CLAUDE_MODELS;

const ACCEPTED: &[&str] = &["default", "acceptEdits", "auto"];

/// Pure: the accepted mode that follows `--permission-mode` in a profile's args, else `default`
/// (flag absent, flag last with no value, or a mode outside the accepted set).
pub(super) fn mode_from_args(args: &[String]) -> &'static str {
    let value = args.iter().position(|a| a == "--permission-mode").and_then(|i| args.get(i + 1));
    ACCEPTED.iter().copied().find(|m| Some(*m) == value.map(String::as_str)).unwrap_or("default")
}

/// The Bare Claude profile's mode, read from `<root>\profiles\bare\claude.json`; a missing or
/// unreadable profile is an error, never a silent `default`.
fn bare_profile_mode(path: &Path) -> Result<&'static str, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("Bare Claude Profile Unreadable: {e}"))?;
    let body = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let v: serde_json::Value = serde_json::from_str(body).map_err(|e| format!("Bare Claude Profile Invalid: {e}"))?;
    let args: Vec<String> = v
        .get("args")
        .and_then(|a| a.as_array())
        .ok_or_else(|| "Bare Claude Profile Has No Args".to_string())?
        .iter()
        .filter_map(|a| a.as_str().map(str::to_string))
        .collect();
    Ok(mode_from_args(&args))
}

/// The mode `requested` becomes for `model`: re-validated against the accepted set, and `auto`
/// drops to `default` for a model outside `CLAUDE_MODELS`.
pub(super) fn effective(requested: &str, model: &str) -> &'static str {
    let mode = ACCEPTED.iter().copied().find(|m| *m == requested).unwrap_or("default");
    if mode == "auto" && !CLAUDE_MODELS.contains(&model) { "default" } else { mode }
}

/// The Bare profile's mode as it applies to each of `models`.
#[tauri::command]
pub fn flow_permission_modes(models: Vec<String>) -> Result<HashMap<String, String>, String> {
    let path = crate::paths::root().join("profiles").join("bare").join("claude.json");
    let mode = bare_profile_mode(&path)?;
    Ok(models.into_iter().map(|m| { let e = effective(mode, &m).to_string(); (m, e) }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reads_the_mode_after_the_flag() {
        assert_eq!(mode_from_args(&args(&["--x", "--permission-mode", "auto", "{{remoteControl}}"])), "auto");
    }

    #[test]
    fn unaccepted_modes_read_as_default() {
        assert_eq!(mode_from_args(&args(&["--permission-mode", "plan"])), "default");
        assert_eq!(mode_from_args(&args(&["--permission-mode", "bypassPermissions"])), "default");
    }

    #[test]
    fn absent_flag_or_missing_value_reads_as_default() {
        assert_eq!(mode_from_args(&args(&["--setting-sources", "user"])), "default");
        assert_eq!(mode_from_args(&args(&["--a", "--permission-mode"])), "default");
    }

    #[test]
    fn missing_profile_is_an_error() {
        assert!(bare_profile_mode(Path::new(r"C:\no\such\dir\claude.json")).is_err());
    }

    #[test]
    fn shipped_profile_reads_auto() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("profiles/bare/claude.json");
        assert_eq!(bare_profile_mode(&p).unwrap(), "auto");
    }

    #[test]
    fn auto_holds_for_claude_models_only() {
        assert_eq!(effective("auto", "claude-sonnet-5"), "auto");
        assert_eq!(effective("auto", "glm-5"), "default");
        assert_eq!(effective("acceptEdits", "glm-5"), "acceptEdits");
        assert_eq!(effective("bypassPermissions", "claude-sonnet-5"), "default");
    }
}
