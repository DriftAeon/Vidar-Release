//! src-tauri\src\bare\claude_dir.rs — the one resolver for "which Claude config dir does this tab
//! use" (plan P4). Observers (Loadout, MCP rack, Recent, status bar, handoffs) take the tab's optional launch profile and ask here, never `USERPROFILE\.claude`
//! directly. No profile keeps today's `crate::paths::claude_dir()`; `bare` is
//! `<agentHomes>\claude-config`; an unknown profile resolves to nothing (the caller skips the
//! lookup, it never falls back to the user's home).

use std::path::{Path, PathBuf};

use super::home;

/// Folder name of a bare tab's `CLAUDE_CONFIG_DIR` under the agent homes.
pub const CONFIG_DIR_NAME: &str = "claude-config";

fn bare_in(homes: &Path) -> PathBuf {
    homes.join(CONFIG_DIR_NAME)
}

fn resolve_with(profile: Option<&str>, default: impl FnOnce() -> Option<PathBuf>, homes: impl FnOnce() -> Option<PathBuf>) -> Option<PathBuf> {
    match profile {
        None => default(),
        Some("bare") => Some(bare_in(&homes()?)),
        Some(_) => None,
    }
}

/// The Claude config dir for a tab with this profile.
pub fn claude_dir_for(profile: Option<&str>) -> Option<PathBuf> {
    resolve_with(profile, crate::paths::claude_dir, || home::resolve().ok())
}

/// Claude's `.claude.json`: beside the `.claude` dir by default, inside the config dir when
/// `CLAUDE_CONFIG_DIR` is set (G2 saw it there).
pub fn claude_json_for(profile: Option<&str>) -> Option<PathBuf> {
    match profile {
        None => Some(crate::paths::home()?.join(".claude.json")),
        Some(_) => Some(claude_dir_for(profile)?.join(".claude.json")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn none_is_the_default_dir() {
        let d = resolve_with(None, || Some(PathBuf::from("C:\\U\\.claude")), || panic!("homes not read"));
        assert_eq!(d, Some(PathBuf::from("C:\\U\\.claude")));
    }

    #[test]
    fn bare_is_claude_config_under_the_homes() {
        let d = resolve_with(Some("bare"), || panic!("default not read"), || Some(PathBuf::from("C:\\L\\Vidar\\homes\\k")));
        assert_eq!(d, Some(PathBuf::from("C:\\L\\Vidar\\homes\\k").join("claude-config")));
    }

    #[test]
    fn bare_with_no_home_is_nothing() {
        assert_eq!(resolve_with(Some("bare"), || panic!("default not read"), || None), None);
    }

    #[test]
    fn unknown_is_nothing() {
        let d = resolve_with(Some("zzz"), || panic!("default not read"), || panic!("homes not read"));
        assert_eq!(d, None);
        assert_eq!(claude_dir_for(Some("zzz")), None);
        assert_eq!(claude_json_for(Some("zzz")), None);
    }

    /// The real template, generated into a temp home: the context gate rides UserPromptSubmit and
    /// Stop as arrays of matchers, by path from the install root, with the home passed explicitly.
    #[test]
    fn generated_settings_hold_the_gate_hooks_as_arrays() {
        let tmp = std::env::temp_dir().join(format!("vidar-gate-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let template = crate::paths::root().join("profiles").join("bare").join("claude.settings.template.json");
        let target = tmp.join("settings.json");
        let guard = home::Guard { user_profile: Some(r"C:\Users\testuser".into()), username: Some("testuser".into()) };
        let root = crate::paths::root();
        home::generate_settings(&template, &target, &root, &tmp, &guard, &[]).expect("generate");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        for (event, arg) in [("UserPromptSubmit", "prompt"), ("Stop", "stop")] {
            let arr = v["hooks"][event].as_array().unwrap_or_else(|| panic!("{event} is not an array"));
            let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
            assert!(cmd.contains("tools\\agent-layer\\context-gate.mjs"), "{cmd}");
            assert!(cmd.contains(&format!("context-gate.mjs\" {arg} --root ")), "{cmd}");
            assert!(cmd.contains(&format!("--home \"{}\"", tmp.display())), "{cmd}");
        }
        assert!(v["hooks"]["InstructionsLoaded"].is_array(), "the existing hook stays");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn bare_json_sits_in_the_config_dir() {
        let p = claude_json_for(Some("bare")).unwrap();
        assert!(p.ends_with("claude-config\\.claude.json"), "{p:?}");
    }
}
