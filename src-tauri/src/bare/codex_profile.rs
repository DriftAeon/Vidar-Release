//! src-tauri\src\bare\codex_profile.rs — the Codex Bare profile's own reads: its file, its `CODEX_HOME`
//! overlay, the Rendered admission, the probe seams and the readers' home list. Moved from mod.rs
//! so the shared prepare names no agent.

use super::*;

/// The agent this profile file configures.
pub(super) const AGENT: Agent = Agent::Codex;

const UNOPENED_LEAD: &str = "Bare Codex home ";

/// The refusal for a profile row whose home folder was never created.
pub(super) fn unopened_message(dir: &Path) -> String {
    format!("{UNOPENED_LEAD}{} does not exist yet; open the profile once to create it", dir.display())
}

/// Whether `err` is `unopened_message`'s: the row exists, its home was never opened.
pub fn home_unopened(err: &str) -> bool {
    err.starts_with(UNOPENED_LEAD) && err.contains("does not exist yet")
}

pub fn admit_rendered(profile: &str, agent: Option<&str>, rules_file: Option<&str>) -> Result<(), String> {
    if !PROFILES.contains(&profile) {
        return Err(format!("Unknown launch profile {profile:?}; spawn refused"));
    }
    if agent != Some(AGENT.as_str()) {
        return Err(format!("The {profile:?} profile on an in-process Rendered tab is for Codex rows only (agent {agent:?}); spawn refused"));
    }
    if rules_file.is_some_and(|f| !f.trim().is_empty()) {
        return Err(format!("A {profile:?} spawn carries no rules file (its layer comes from the profile); spawn refused"));
    }
    Ok(())
}

pub(super) fn load_codex_profile(root: &Path, id: &str) -> Result<CodexProfile, String> {
    let path = root.join("profiles").join(id).join(crate::agent_spec::spec(AGENT).profile_file);
    let p: CodexProfile = crate::fsx::read_json(&path).map_err(|e| format!("Launch profile {}: {e}", path.display()))?;
    if p.id != id || p.agent != AGENT.as_str() {
        return Err(format!("Launch profile {}: id {:?} / agent {:?} do not match a Codex {id:?} row", path.display(), p.id, p.agent));
    }
    if !p.shared_login.is_empty() {
        return Err(format!("Launch profile {}: a Codex profile takes no sharedLogin entry (login_link::sync_codex shares auth.json itself); spawn refused", path.display()));
    }
    Ok(p)
}

/// The profile's `CODEX_HOME` overlay value, filled; the one place the live spawn and the
/// no-session lookup compute it.
pub(super) fn codex_home_of(p: &CodexProfile, root: &Path, home_dir: &Path) -> Option<PathBuf> {
    p.overlay.get("CODEX_HOME").map(|v| PathBuf::from(fill_placeholders(v, root, home_dir)))
}

pub fn codex_homes_for_profile_with(profile_id: &str, root: &Path, home_dir: &Path) -> Result<Vec<CodexHomeInfo>, String> {
    let legacy = codex_home_for_profile_with(profile_id, root, home_dir)?;
    // The sets shown are the runesets of the vault each home is keyed to, as Claude's (`claude_dir::listed_sets`).
    Ok(agent_homes::listed(AGENT, home_dir, &legacy).into_iter().map(|(dir, sets)| AgentHomeInfo { dir, sets: listed_sets(root, &sets) }).collect())
}

/// Seams for the tests: `node` lookup and the Codex resolver.
pub struct CodexProbes<'a> {
    pub find: &'a dyn Fn(&Env, &str) -> Option<PathBuf>,
    pub codex: &'a dyn Fn(&Env, &CodexBinary) -> Option<(PathBuf, Option<String>)>,
}

impl<'a> CodexProbes<'a> {
    /// The live lookups.
    pub(super) fn live() -> CodexProbes<'static> {
        CodexProbes { find: &find_on_env_path, codex: &resolve_codex }
    }

    /// The Codex resolver seam.
    pub(super) fn resolver(&self) -> &'a dyn Fn(&Env, &CodexBinary) -> Option<(PathBuf, Option<String>)> {
        self.codex
    }
}
