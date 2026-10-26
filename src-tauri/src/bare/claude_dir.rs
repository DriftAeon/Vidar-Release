//! src-tauri\src\bare\claude_dir.rs — the one resolver for "which Claude config dir does this tab
//! use" (plan P4). Observers (Loadout, MCP rack, Recent, status bar, handoffs) take the tab's optional launch profile and ask here, never `USERPROFILE\.claude`
//! directly. No profile keeps today's `crate::paths::claude_dir()`; `bare` is
//! `<agentHomes>\claude-config`; an unknown profile resolves to nothing (the caller skips the
//! lookup, it never falls back to the user's home). A Bare profile also runs on one dir per set
//! combination (`<home>\claude-homes\<hash12>`): lists read `listed_for`/`homes_for`, one session's
//! state `home_of_session`.

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

/// The Claude config dir for a tab with this profile: for a Bare profile the profile's own
/// (legacy) dir, which holds the shared login link. A reader of one session's state asks
/// `home_of_session`, a reader of lists `homes_for` (fold W2 L2e: a Bare profile runs on one dir
/// per set combination).
pub fn claude_dir_for(profile: Option<&str>) -> Option<PathBuf> {
    resolve_with(profile, crate::paths::claude_dir, || home::resolve().ok())
}

/// One Claude config dir a profile's sessions may live in, with the set refs (`library/set`) of
/// its combination; `sets` is `None` for the user's own `.claude` (no profile).
#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeHome {
    pub dir: PathBuf,
    pub sets: Option<Vec<String>>,
}

fn plain_profile(p: &str) -> bool {
    !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Every Claude config dir of this profile, for readers of lists and of a session found by id
/// (transcripts, registries, resume): no profile is the user's own dir; a Bare profile is its own
/// dir first, then each indexed combination home (`claude_homes_for_profile_with`). A profile
/// whose own dir does not exist yet, or that resolves to nothing, has none.
pub fn listed_for(profile: Option<&str>) -> Vec<ClaudeHome> {
    listed_with(profile, crate::paths::claude_dir, &crate::paths::root(), || home::resolve().ok())
}

fn listed_with(profile: Option<&str>, default: impl FnOnce() -> Option<PathBuf>, root: &Path, homes: impl FnOnce() -> Option<PathBuf>) -> Vec<ClaudeHome> {
    match profile {
        None => default().map(|dir| ClaudeHome { dir, sets: None }).into_iter().collect(),
        Some(p) if !plain_profile(p) => Vec::new(),
        Some(p) => {
            let Some(home_dir) = homes() else { return Vec::new() };
            super::claude_homes_for_profile_with(p, root, &home_dir)
                .map(|v| v.into_iter().map(|h| ClaudeHome { dir: h.dir, sets: Some(listed_sets(root, &h.sets)) }).collect())
                .unwrap_or_default()
        }
    }
}

/// The runesets (`library/set`) of the vault an index entry is keyed to (`vault:<id>`); none for an
/// entry keyed to no vault or a vault that is gone.
pub(super) fn listed_sets(root: &Path, indexed: &[String]) -> Vec<String> {
    let Some(id) = indexed.iter().find_map(|s| s.strip_prefix("vault:")) else { return Vec::new() };
    super::vault::store::Store::open(root).get(id).ok()
        .map(|v| v.runesets.iter().map(|c| format!("{}/{}", c.source.library, c.source.set)).collect())
        .unwrap_or_default()
}

/// `listed_for`'s dirs alone.
pub fn homes_for(profile: Option<&str>) -> Vec<PathBuf> {
    listed_for(profile).into_iter().map(|h| h.dir).collect()
}

/// The first `<dir>\projects\<slug>\<session_id>.jsonl` that exists across `homes`.
pub fn transcript_in(homes: &[PathBuf], slug: &str, session_id: &str) -> Option<PathBuf> {
    homes.iter().map(|d| d.join("projects").join(slug).join(format!("{session_id}.jsonl"))).find(|p| p.is_file())
}

/// The Claude config dir one tab's session runs on, for readers of per-session state (Loadout,
/// MCP rack, Speak). No profile is the user's own dir. A Bare profile takes, in order: the dir the
/// session's Rune Vault record, then an older launch manifest when either names a listed home;
/// otherwise the profile's own. An unknown profile resolves to nothing.
pub fn home_of_session(profile: Option<&str>, tab: Option<&str>, session: Option<&str>, _row: Option<&str>) -> Option<PathBuf> {
    let Some(p) = profile else { return claude_dir_for(None) };
    if !plain_profile(p) {
        return None;
    }
    let home_dir = home::resolve().ok()?;
    let root = crate::paths::root();
    let listed = homes_for(Some(p));
    session_home_with(p, &root, &home_dir, &listed, tab, session)
}

fn session_home_with(p: &str, root: &Path, home_dir: &Path, listed: &[PathBuf], tab: Option<&str>, session: Option<&str>) -> Option<PathBuf> {
    let norm = |d: &Path| d.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase();
    if let Some(tab) = tab.filter(|t| !t.is_empty()) {
        let recorded = super::vault::session::find(root, tab, session, None).ok().flatten().filter(|r| r.agent == "claude");
        if let Some(r) = recorded {
            return listed.iter().find(|l| norm(l) == norm(Path::new(&r.home))).cloned();
        }
        let recorded = super::manifest::claude_config_in(&home_dir.join("manifests"), tab, session);
        if let Some(d) = recorded.and_then(|r| listed.iter().find(|l| norm(l) == norm(&r)).cloned()) {
            return Some(d);
        }
    }
    super::claude_legacy_dir(p, root, home_dir).ok()
}

/// The Falcon session the Vidar tab `tab` hosts, so a re-adopted tab (a new id) still finds the
/// manifest its launch wrote under the old one.
pub fn hosted_session_of(app: &tauri::AppHandle, tab: Option<&str>) -> Option<String> {
    use tauri::Manager;
    let falcon = app.try_state::<std::sync::Arc<crate::falcon::Falcon>>()?;
    falcon.hosted_session_of(tab?)
}

/// `.claude.json` inside `dir` (a Bare config dir), or beside the user's `.claude` for no profile.
pub fn claude_json_in(profile: Option<&str>, dir: Option<PathBuf>) -> Option<PathBuf> {
    match profile {
        None => claude_json_for(None),
        Some(_) => Some(dir?.join(".claude.json")),
    }
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

    /// The real template, generated into a temp home: no context-gate hook rides UserPromptSubmit
    /// or Stop any more, and the other hooks stay as arrays.
    #[test]
    fn generated_settings_hold_no_gate_hooks() {
        let tmp = std::env::temp_dir().join(format!("vidar-gate-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let template = crate::paths::root().join("profiles").join("bare").join("claude.settings.template.json");
        let target = tmp.join("settings.json");
        let guard = home::Guard { user_profile: Some(r"C:\Users\testuser".into()), username: Some("testuser".into()) };
        let root = crate::paths::root();
        home::generate_settings(&template, &target, &root, &tmp, &guard, &[]).expect("generate");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        for event in ["UserPromptSubmit", "Stop"] {
            assert!(v["hooks"][event].is_null(), "{event} carries no hook (handoffs retired)");
        }
        assert!(!std::fs::read_to_string(&target).unwrap().contains("context-gate"), "no gate hook in settings");
        assert!(v["hooks"]["InstructionsLoaded"].is_array(), "the existing hook stays");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn bare_json_sits_in_the_config_dir() {
        let p = claude_json_for(Some("bare")).unwrap();
        assert!(p.ends_with("claude-config\\.claude.json"), "{p:?}");
    }

    /// A temp Bare home with the profile's own dir and one recorded combination home (vault
    /// `claude-a`'s); removed on drop.
    struct Homes { base: PathBuf, home: PathBuf, legacy: PathBuf, combo: PathBuf }
    impl Homes {
        fn new(tag: &str) -> Homes {
            let base = std::env::temp_dir().join(format!("vidar-claude-dir-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            let home = base.join("home");
            let root = crate::paths::root();
            let legacy = super::super::claude_legacy_dir("bare", &root, &home).expect("the bare profile's dir");
            std::fs::create_dir_all(&legacy).unwrap();
            let config = base.join("config.json");
            std::fs::write(&config, "{}").unwrap();
            let picked = super::super::agent_homes::pick_vault(super::super::Agent::Claude, &home, &legacy, Some("claude-a"));
            let lock = home::lock(&home, home::LOCK_WAIT).unwrap();
            super::super::agent_homes::record(super::super::Agent::Claude, &lock, &home, &legacy, &config, &picked).unwrap();
            drop(lock);
            std::fs::create_dir_all(&picked.dir).unwrap();
            Homes { base, home, legacy, combo: picked.dir }
        }
        fn listed(&self) -> Vec<ClaudeHome> {
            listed_with(Some("bare"), || panic!("default not read"), &crate::paths::root(), || Some(self.home.clone()))
        }
        fn session(&self, tab: Option<&str>, session: Option<&str>, row: Option<&str>) -> Option<PathBuf> {
            let listed: Vec<PathBuf> = self.listed().into_iter().map(|h| h.dir).collect();
            let _ = row;
            session_home_with("bare", &crate::paths::root(), &self.home, &listed, tab, session)
        }
        fn manifest(&self, name: &str, tab: &str, falcon: &str, dir: &Path) {
            let m = self.home.join("manifests");
            std::fs::create_dir_all(&m).unwrap();
            let v = serde_json::json!({ "tab": tab, "agent": "claude", "falconSession": falcon, "homes": { "claudeConfig": dir } });
            std::fs::write(m.join(name), v.to_string()).unwrap();
        }
    }
    impl Drop for Homes {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn a_bare_profile_lists_its_own_dir_then_each_combination_home() {
        let h = Homes::new("listed");
        let l = h.listed();
        assert_eq!(l.len(), 2, "{l:?}");
        assert_eq!(l[0].dir, h.legacy);
        assert_eq!(l[1], ClaudeHome { dir: h.combo.clone(), sets: Some(Vec::new()) });
        let none = listed_with(None, || Some(PathBuf::from("C:\\U\\.claude")), Path::new("C:\\r"), || panic!("homes not read"));
        assert_eq!(none, vec![ClaudeHome { dir: PathBuf::from("C:\\U\\.claude"), sets: None }]);
        assert!(listed_with(Some("../x"), || None, Path::new("C:\\r"), || panic!("homes not read")).is_empty());
    }

    #[test]
    fn a_transcript_is_found_in_whichever_home_holds_it() {
        let h = Homes::new("transcript");
        let slug = "C--r-x";
        for (dir, id) in [(&h.legacy, "aaaa-1"), (&h.combo, "bbbb-2")] {
            let p = dir.join("projects").join(slug);
            std::fs::create_dir_all(&p).unwrap();
            std::fs::write(p.join(format!("{id}.jsonl")), "{}\n").unwrap();
        }
        let homes: Vec<PathBuf> = h.listed().into_iter().map(|x| x.dir).collect();
        assert_eq!(transcript_in(&homes, slug, "aaaa-1"), Some(h.legacy.join("projects").join(slug).join("aaaa-1.jsonl")));
        assert_eq!(transcript_in(&homes, slug, "bbbb-2"), Some(h.combo.join("projects").join(slug).join("bbbb-2.jsonl")));
        assert_eq!(transcript_in(&homes[..1], slug, "bbbb-2"), None, "the profile's own dir alone misses it");
    }

    #[test]
    fn a_session_reads_the_home_its_launch_recorded_else_the_profiles_own() {
        let h = Homes::new("session");
        // the tab's own manifest names the combination home
        h.manifest("20261024T100000-tab-1-11.json", "tab-1", "fs-1", &h.combo);
        assert_eq!(h.session(Some("tab-1"), None, None), Some(h.combo.clone()));
        // a re-adopted tab (new id) finds it by its Falcon session
        assert_eq!(h.session(Some("tab-9"), Some("fs-1"), None), Some(h.combo.clone()));
        // a recorded dir that is not one of the profile's homes is not trusted
        let elsewhere = h.base.join("elsewhere");
        h.manifest("20261024T100001-tab-2-12.json", "tab-2", "fs-2", &elsewhere);
        assert_eq!(h.session(Some("tab-2"), None, None), Some(h.legacy.clone()));
        // no record or manifest: the profile's own dir, even when the row still names a set
        assert_eq!(h.session(Some("tab-3"), None, Some("claude-a")), Some(h.legacy.clone()));
        assert_eq!(h.session(Some("tab-3"), None, None), Some(h.legacy.clone()));
        assert_eq!(h.session(None, None, Some("no-such-row")), Some(h.legacy.clone()));
    }

    #[test]
    fn session_vault_record_selects_its_home_even_when_row_names_another_set() {
        let h = Homes::new("vault-record");
        let vault = super::super::vault::store::Store::open(&h.base).create("Chosen", None, &[], &[]).unwrap();
        let record = super::super::vault::session::record(
            "claude", "hosted", "tab-vault",
            super::super::vault::session::VaultPin { id: vault.id.clone(), hash: vault.hash.clone() },
            &h.combo.to_string_lossy(), "loadout",
        );
        super::super::vault::session::write(&h.base, &record).unwrap();
        let listed = [h.legacy.clone(), h.combo.clone()];
        assert_eq!(session_home_with("bare", &h.base, &h.home, &listed, Some("tab-vault"), None), Some(h.combo.clone()));
        assert!(listed_sets(&h.base, &[format!("vault:{}", vault.id), "lib/alpha".into()]).is_empty(), "row's alpha is absent from this vault");
    }
}
