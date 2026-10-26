//! Flow's own Claude config dir (runesets fold W2-L2a, the twin of `flow_home.rs`):
//! `<home>\flow-claude\`, beside the legacy `claude-config` and outside `claude-homes\`, so no rune
//! set's loadout (skills, agents, guard hooks, MCP modules, rune text) ever reaches a Flow node.
//! Prepared on every Flow Claude spawn under the home lock, with the baseline only:
//! - login: `.credentials.json` linked to the shared Claude login (`login_link::sync_claude`), as
//!   every Bare Claude home's;
//! - `settings.json` generated from the Bare Claude template (`home::generate_settings`, the one
//!   writer and validator the legacy dir uses) with no set hooks, permissions or output style;
//! - `.claude.json` seeded from the legacy dir's onboarding flags and folder trust
//!   (`home::seed_claude_json`), so the sidecar's project-trust gate reads what it read before;
//! - an MCP file holding only `plugin_vidar_drive` (`claude_mcp::prepare` with no modules), which
//!   the sidecar loads strict (`--mcp-file`, `flowOptions`).
//!
//! An unchanged file is not rewritten. The legacy dir is only checked to exist and read for the seed.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::{check_config_in_home, claude_mcp, config_dir_of, home, load_profile, log_mirror_skip, login_link, profile_env, under, ClaudeFlowEnv, PROFILES};

/// Flow's Claude config folder under the Bare home.
pub(super) const DIR: &str = "flow-claude";

/// `<home>\flow-claude`.
pub(super) fn dir(home_dir: &Path) -> PathBuf {
    home_dir.join(DIR)
}

/// Prepares Flow's Claude config dir for one node and returns its spawn env (`CLAUDE_CONFIG_DIR`
/// and `VIDAR_AGENT_HOME` at `flow-claude`) and its drive-only MCP file. Err with u1's string when
/// the Bare home was never opened (no legacy `claude-config`), before anything is written. The
/// login check stays the caller's (`flow/bare.rs verify_claude`: a gateway node needs none).
pub(super) fn prepare(
    profile_id: &str,
    root: &Path,
    home_dir: &Path,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    guard: &home::Guard,
) -> Result<ClaudeFlowEnv, String> {
    if !PROFILES.contains(&profile_id) {
        return Err(format!("No Claude home for the {profile_id:?} profile; Flow refused"));
    }
    let p = load_profile(root, profile_id)?;
    check_config_in_home(&p, root, home_dir)?;
    let legacy = config_dir_of(&p, root, home_dir).ok_or_else(|| format!("Bare Claude profile {profile_id:?} sets no CLAUDE_CONFIG_DIR"))?;
    if !legacy.is_dir() {
        return Err("Open a Bare tab once to create its home".to_string());
    }
    let config_dir = dir(home_dir);
    let mut env = profile_env(&p, root, home_dir, inherited);
    for k in ["CLAUDE_CONFIG_DIR", "VIDAR_AGENT_HOME"] {
        if env.get(k).is_some() {
            env.set(k, config_dir.as_os_str().to_owned());
        }
    }

    let mut dirs = p.home_dirs.clone();
    dirs.push(DIR.to_string());
    home::prepare_dirs(home_dir, &dirs)?;
    let lock = home::lock(home_dir, home::LOCK_WAIT)?;
    let warnings = login_link::sync_claude(home_dir, &config_dir, &dirs, &lock)?;
    home::generate_settings(&under(root, &p.settings_template), &config_dir.join("settings.json"), root, home_dir, guard, &[])?;
    let mcp = claude_mcp::prepare(&lock, root, home_dir, &[], std::iter::empty())?;
    if let Err(e) = home::seed_claude_json(&legacy.join(".claude.json"), &config_dir.join(".claude.json")) {
        log_mirror_skip(home_dir, &e);
    }
    drop(lock);
    let mcp_file = mcp.file.ok_or("Flow's Claude MCP file was not written")?;
    Ok(ClaudeFlowEnv { env, config_dir, mcp_file, warnings: warnings.into_iter().chain(mcp.warnings).collect() })
}
