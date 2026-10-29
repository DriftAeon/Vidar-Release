//! src-tauri\src\bare\claude_profile.rs — the Claude Bare profile's own reads: its file, its isolation
//! switches, its `CLAUDE_CONFIG_DIR`, the seen-counter mirror and the readers' home list. Moved from
//! mod.rs so the shared prepare names no agent.

use super::*;

/// The agent this profile file configures.
pub(super) const AGENT: Agent = Agent::Claude;

/// Points the profile env's config-dir variables, those it already carries, at the vault home `dir`.
pub(super) fn point_env_at(env: &mut Env, dir: &Path) {
    for k in ["CLAUDE_CONFIG_DIR", "VIDAR_AGENT_HOME"] {
        if env.get(k).is_some() {
            env.set(k, dir.as_os_str().to_owned());
        }
    }
}

pub(super) fn load_profile(root: &Path, id: &str) -> Result<Profile, String> {
    let spec = crate::agent_spec::spec(AGENT);
    let path = root.join("profiles").join(id).join(spec.profile_file);
    let p: Profile = crate::fsx::read_json(&path).map_err(|e| format!("Launch profile {}: {e}", path.display()))?;
    if p.id != id || p.agent != AGENT.as_str() {
        return Err(format!("Launch profile {}: id {:?} / agent {:?} do not match a Raw Claude {id:?} row", path.display(), p.id, p.agent));
    }
    Ok(p)
}

/// The two isolation switches a bare launch must carry, checked on the profile before any home is
/// touched: an edited profile that drops either is refused, never launched half-isolated.
pub(super) fn check_isolation(p: &Profile) -> Result<(), String> {
    if !p.args.windows(2).any(|w| w[0] == "--setting-sources" && w[1] == "user") {
        return Err(format!("Launch profile {:?} lacks `--setting-sources user`; spawn refused", p.id));
    }
    if p.overlay.get("CLAUDE_CODE_DISABLE_CLAUDE_MDS").map(String::as_str) != Some("1") {
        return Err(format!("Launch profile {:?} lacks CLAUDE_CODE_DISABLE_CLAUDE_MDS=1; spawn refused", p.id));
    }
    // Plugins, allowed tools and the mode arrive only through the session's Rune Vault:
    // a profile that carries them itself is refused.
    if !p.plugins.is_empty() || p.rendered.as_ref().is_some_and(|r| !r.plugins.is_empty()) {
        return Err(format!("Launch profile {:?} lists plugins; plugins come from the vault's plugin runes; spawn refused", p.id));
    }
    if let Some(a) = p.args.iter().find(|a| ["--plugin-dir", "--allowedTools", "--allowed-tools", "--permission-mode"].contains(&a.as_str())) {
        return Err(format!("Launch profile {:?} carries {a}; that comes from the vault's runes; spawn refused", p.id));
    }
    Ok(())
}

/// A profile's `CLAUDE_CONFIG_DIR` (after `{{root}}`/`{{home}}`) must sit under the bare home: an
/// edited profile pointing it at the user's real `.claude` is refused before any home is touched.
pub(super) fn check_config_in_home(p: &Profile, root: &Path, home_dir: &Path) -> Result<(), String> {
    let Some(raw) = p.overlay.get("CLAUDE_CONFIG_DIR") else { return Ok(()) };
    let filled = raw.replace("{{root}}", &root.to_string_lossy()).replace("{{home}}", &home_dir.to_string_lossy());
    let comps = |s: &str| -> Vec<String> {
        s.split(['/', '\\']).filter(|c| !c.is_empty()).map(str::to_lowercase).collect()
    };
    let (config, home) = (comps(&filled), comps(&home_dir.to_string_lossy()));
    if config.len() <= home.len() || config[..home.len()] != home[..] || config.iter().any(|c| c == "..") {
        return Err(format!("Launch profile {:?} sets CLAUDE_CONFIG_DIR outside the bare home; spawn refused", p.id));
    }
    Ok(())
}

/// The profile's `CLAUDE_CONFIG_DIR` with `{{root}}`/`{{home}}` filled: where skills and agents copy.
pub(super) fn config_dir_of(p: &Profile, root: &Path, home_dir: &Path) -> Option<PathBuf> {
    let raw = p.overlay.get("CLAUDE_CONFIG_DIR")?;
    Some(PathBuf::from(raw.replace("{{root}}", &root.to_string_lossy()).replace("{{home}}", &home_dir.to_string_lossy())))
}

/// Before a Bare Claude spawn: the normal `~/.claude.json`'s seen-counters raised into the Bare one
/// (`home::mirror_claude_seen`). Never blocks the spawn; a skip is a line in
/// `<home>\logs\claude-seen-mirror.log` (stderr is invisible in release). `normal` is the source
/// `.claude.json` the caller resolved (`LaunchOpts::claude_json`); tests pass a temp file and the
/// real home is never read here. `dir` is the launch's config dir (its combination's or the own).
pub(super) fn mirror_claude_seen(dir: &Path, home_dir: &Path, normal: Option<&Path>) {
    let skipped = match normal {
        None => Some("no normal .claude.json path resolved".to_string()),
        Some(normal) => home::mirror_claude_seen(normal, &dir.join(".claude.json")).err(),
    };
    if let Some(e) = skipped {
        log_mirror_skip(home_dir, &e);
    }
}

/// One line per skipped mirror, appended like `login-link.log` (`<ms> <text>`). Best effort.
pub(super) fn log_mirror_skip(home_dir: &Path, why: &str) {
    use std::io::Write;
    let logs = home_dir.join("logs");
    let _ = std::fs::create_dir_all(&logs);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(logs.join("claude-seen-mirror.log")) {
        let _ = writeln!(f, "{} bare claude seen-state mirror skipped: {why}", crate::fsx::now_ms());
    }
}

/// Reads the user's real Claude `settings.json` (`CLAUDE_CONFIG_DIR` from Vidar's env, else `~\.claude`).
pub(super) fn read_remote_control() -> bool {
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()).map(PathBuf::from).or_else(crate::paths::claude_dir);
    dir.and_then(|d| std::fs::read_to_string(d.join("settings.json")).ok()).map(|t| parse_remote_control(&t)).unwrap_or(false)
}

/// Every Claude config dir of a Bare profile for readers: the legacy one (the profile's
/// `CLAUDE_CONFIG_DIR`) first, then each indexed combination home under `claude-homes`. Read-only:
/// Err when the profile, its `CLAUDE_CONFIG_DIR` or that folder is missing, and nothing is created.
/// The readers go through `claude_dir::listed_for` (fold W2 L2e).
pub fn claude_homes_for_profile_with(profile_id: &str, root: &Path, home_dir: &Path) -> Result<Vec<AgentHomeInfo>, String> {
    let legacy = claude_legacy_dir(profile_id, root, home_dir)?;
    if !legacy.is_dir() {
        return Err(format!("Bare Claude config {} does not exist yet; open the profile once to create it", legacy.display()));
    }
    Ok(agent_homes::listed(AGENT, home_dir, &legacy).into_iter().map(|(dir, sets)| AgentHomeInfo { dir, sets }).collect())
}

/// A Claude profile's own `CLAUDE_CONFIG_DIR`, checked to sit under the Bare home; read-only.
pub(super) fn claude_legacy_dir(profile_id: &str, root: &Path, home_dir: &Path) -> Result<PathBuf, String> {
    let p = load_profile(root, profile_id)?;
    check_config_in_home(&p, root, home_dir)?;
    config_dir_of(&p, root, home_dir).ok_or_else(|| format!("Launch profile {profile_id:?} sets no CLAUDE_CONFIG_DIR"))
}
