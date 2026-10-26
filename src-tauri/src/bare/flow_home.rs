//! Flow's own Codex home (runesets fold W2-L2d, user pick Q4): `<home>\flow-codex\`, beside the
//! legacy `codex-home` and outside `codex-homes\`, so no rune set's loadout (skills, hooks, agents,
//! MCP tables) ever reaches a Flow node. Prepared on every Flow Codex spawn under the home lock,
//! with the baseline only:
//! - login: `auth.json` linked to the shared Codex login (`login_link::sync_codex`), as every Bare
//!   Codex home's;
//! - `config.toml` generated from the Bare Codex template (`home::generate_codex_config_for`, the
//!   one writer and validator the legacy home uses): the `vidar_drive` server, the same sandbox,
//!   Windows and feature pins, and the cwd's trust table when the user's own Codex config trusts it;
//!   no MCP tables, no hook trust;
//! - no skills, hooks.json, agents, roles or built payload (only the template's static payload).
//!
//! A home whose content is unchanged is not rewritten (`generate_codex_config_with` skips an
//! identical config.toml; the login link keeps its file). The legacy home is only checked to exist.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::{codex_home_of, codex_mcp, codex_user_trust, env, fill_placeholders, home, load_codex_profile, login_link, under, Ambient, CodexEnv, CodexProbes, PROFILES, PWSH};

/// Flow's Codex home folder under the Bare home.
pub(super) const DIR: &str = "flow-codex";

/// `<home>\flow-codex`.
pub(super) fn dir(home_dir: &Path) -> PathBuf {
    home_dir.join(DIR)
}

/// Prepares Flow's Codex home for one node and returns its spawn env. Err with u1's strings when
/// the Bare home was never opened (no legacy `codex-home`) or no login reached `flow-codex\auth.json`;
/// both are checked before anything is written or after the login link, respectively. `cwd` is the
/// node's launch folder: it gets the trust table only when the user's own Codex config trusts it.
#[allow(clippy::too_many_arguments)]
pub(super) fn prepare(
    profile_id: &str,
    root: &Path,
    home_dir: &Path,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    ambient: &Ambient,
    guard: &home::Guard,
    probes: &CodexProbes,
    cwd: Option<&str>,
) -> Result<CodexEnv, String> {
    if !PROFILES.contains(&profile_id) {
        return Err(format!("Unknown launch profile {profile_id:?}"));
    }
    let p = load_codex_profile(root, profile_id)?;
    let legacy = codex_home_of(&p, root, home_dir).ok_or_else(|| format!("Bare Codex profile {profile_id:?} sets no CODEX_HOME"))?;
    if !legacy.is_dir() {
        return Err("Open a Bare tab once to create its home".to_string());
    }
    let codex_home = dir(home_dir);
    // The profile's overlay with its Codex home keys pointed at Flow's (as a combination home's).
    let mut overlay: BTreeMap<String, String> = p.overlay.iter().map(|(k, v)| (k.clone(), fill_placeholders(v, root, home_dir))).collect();
    for k in ["CODEX_HOME", "VIDAR_AGENT_HOME"] {
        if let Some(v) = overlay.get_mut(k) {
            *v = codex_home.to_string_lossy().into_owned();
        }
    }
    let mut env = env::codex(inherited, &overlay)?;
    // The notify pwsh as a tab's: an unpackaged one left after the WindowsApps drop, else the full-Path one.
    let full_pwsh = (probes.find)(&env, PWSH).ok_or_else(|| format!("{PWSH} is not on the allowlisted Path; bare spawn refused"))?;
    env::drop_app_alias_dirs(&mut env);
    let pwsh = (probes.find)(&env, PWSH).unwrap_or(full_pwsh);
    let node = (probes.find)(&env, &p.host.name).ok_or_else(|| format!("{} is not on the allowlisted Path", p.host.name))?;
    let (js, _) = (probes.codex)(&env, &p.binary).ok_or_else(|| format!("{} not found beside a {} shim on the allowlisted Path", p.binary.script, p.binary.shims.join(" or ")))?;
    let payload_path = under(root, &p.payload);
    let payload = crate::fsx::read_text(&payload_path).map_err(|e| format!("Bare payload {}: {e}", payload_path.display()))?.replace('\r', "");
    let template = under(root, &p.config_template);
    let trusted = cwd.filter(|c| !c.trim().is_empty()).filter(|c| ambient.codex_config.as_deref().is_some_and(|cfg| codex_user_trust::config_trusts(cfg, c)));

    let mut dirs = p.home_dirs.clone();
    dirs.push(DIR.to_string());
    home::prepare_dirs(home_dir, &dirs)?;
    let lock = home::lock(home_dir, home::LOCK_WAIT)?;
    let warnings = login_link::sync_codex(home_dir, &codex_home, &dirs, &lock)?;
    home::generate_codex_config_for(&template, &codex_home.join("config.toml"), root, home_dir, &pwsh, &payload, guard, trusted, &codex_mcp::Tables::default().with_vidar_drive(root)?)?;
    drop(lock);
    if !codex_home.join("auth.json").is_file() {
        return Err("Sign in from a Bare tab".to_string());
    }
    Ok(CodexEnv { env, node, js, codex_home, warnings })
}

#[cfg(test)]
#[path = "flow_home_tests.rs"]
mod tests;
