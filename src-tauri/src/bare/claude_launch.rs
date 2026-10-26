//! src-tauri\src\bare\claude_launch.rs — the Claude Bare prepares: the Raw PTY line (`prepare`,
//! pty.rs) and the Falcon-hosted home (`prepare_hosted_for`, falcon/session_commands.rs). The
//! `*_for`/`prepare` wrappers read the real machine (env, user home, probes); the `*_with` bodies
//! read only what they are handed (root, agent home, env, `Ambient`, probes), so a test runs them
//! against a temp dir. Split out of mod.rs (fold W0-L0d). Since fold W2 L2a both run on the row's
//! set-combination home (`prepare_home`): `CLAUDE_CONFIG_DIR` in Raw's env, `claude_config_dir`
//! for Falcon.

use super::*;

/// Prepares the real home (the per-install home under LOCALAPPDATA) from Vidar's own env.
pub fn prepare(profile: &str, opts: &LaunchOpts) -> Result<Launch, String> {
    let probes = Probes { find: &find_on_env_path, version: &read_version, remote_control: &read_remote_control };
    let normal = claude_dir::claude_json_for(None);
    prepare_with(
        profile,
        &crate::paths::root(),
        &home::resolve()?,
        std::env::vars_os(),
        &Ambient::from_env(),
        &home::Guard::from_vidar_env(),
        &probes,
        &LaunchOpts { claude_json: normal.as_deref(), ..*opts },
    )
}

/// What both Claude prepares share once the home is ready (`prepare_home`): the profile, the held
/// lock, the launch's config dir and everything written into it, and the warnings in Raw's order
/// after the payload's and the MCP file's.
struct ClaudeHome {
    p: Profile,
    lock: home::HomeLock,
    /// The profile's own `CLAUDE_CONFIG_DIR`, and the one this launch runs on (its set
    /// combination's home under `claude-homes`, or the own one).
    legacy: PathBuf,
    config_dir: PathBuf,
    settings: PathBuf,
    payload: PayloadChoice,
    mcp: claude_mcp::Prepared,
    items: manifest::LaunchItems,
    guard_files: Vec<String>,
    skills: Vec<String>,
    /// Unsupported items, guard drops, copies, home pruning and the login link, in that order.
    warnings: Vec<String>,
    git: identity::GitIdentity,
    loadout_hash: String,
    inherited: Vec<(OsString, OsString)>,
    /// The vault rendered text, so the payload is the built one.
    has_row: bool,
    /// The vault the launch loaded; `None` only for the test no-vault spawn.
    vault: Option<super::vault::Vault>,
    /// Plugins, allowed tools and mode, from the vault only.
    floor: Floor,
}

/// The home steps both Claude prepares run (fold W2 L2a): the row's sets resolved for Claude
/// (`set_loadout::resolve`), its config dir picked (`agent_homes::pick`: a set-combination home, or
/// the profile's own for no sets), recorded and older homes pruned under the lock; the shared login
/// linked into it; the loadout's guards copied into its `hooks\` and wired into its settings.json
/// with the sets' permissions and output style; its skills and agents copied flat with its own
/// ledger; the payload chosen; the strict MCP file of its module servers written; `.claude.json`
/// seen-counters mirrored (and a combination home's seeded from the own one). Returns with the
/// lock still held.
#[allow(clippy::too_many_arguments)]
fn prepare_home(
    p: Profile,
    root: &Path,
    home_dir: &Path,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    ambient: &Ambient,
    guard: &home::Guard,
    opts: &LaunchOpts,
) -> Result<ClaudeHome, String> {
    let vault = vault_for(root, opts, Agent::Claude)?;
    let config = config_of(opts);
    let legacy = config_dir_of(&p, root, home_dir).ok_or("Bare Claude profile sets no CLAUDE_CONFIG_DIR; spawn refused")?;
    let picked = agent_homes::pick_vault(Agent::Claude, home_dir, &legacy, vault.as_ref().map(|v| v.id.as_str()));
    let config_dir = picked.dir.clone();
    let on_legacy = picked.on_legacy(&legacy);
    // Every item the launch carries comes from its vault through the resolver (model R2); what Claude
    // cannot carry (`Loadout.unsupported`) is named in the warnings.
    let resolve_env = set_loadout::ResolveEnv { root, config: &config, home: home_dir, user_home: ambient.user_home.as_deref() };
    let set_loadout::VaultLoadout { mut loadout, warnings: loadout_warnings, text, sets } = vault_spawn::resolve(&resolve_env, Agent::Claude, root, vault.as_ref())?;
    if !loadout.refusals.is_empty() {
        return Err(format!("Rune sets failed to resolve: {}; Bare spawn refused", loadout.refusals.join("; ")));
    }
    if let Some(skill) = recall_skill::write(root, home_dir, guard, &loadout.recall_skill)? {
        loadout.skills.insert(0, skill.to_string_lossy().into_owned());
    }
    let mut warnings: Vec<String> = loadout.unsupported.iter().map(|u| format!("{} {} Not Carried by Claude: {}", u.kind, u.item, u.reason)).collect();
    let mut raw_groups = Vec::new();
    let mut script_items = Vec::new();
    for g in &loadout.guard_items {
        if let Some(raw) = guards::raw_hook(g).map_err(|e| format!("{e}; Bare spawn refused"))? {
            raw_groups.push(guards::raw_group(&raw, false));
        } else {
            script_items.push(g.clone());
        }
    }
    let (set_guards, guard_warnings) = guards::from_items(&script_items);
    warnings.extend(guard_warnings);
    let (catalog, _) = bundles::load(root);
    let servers = claude_mcp::for_launch(&loadout.mcp, &catalog);
    home::prepare_dirs(home_dir, &p.home_dirs)?;
    // Sources read and hashed before the lock (fold 4: LOCK_WAIT is 5 s).
    let plan = copies::plan_for(Agent::Claude, &loadout.skills, &loadout.agents, Some(home_dir));
    let items = manifest::LaunchItems::claude(&plan, &set_guards, servers.iter().map(|s| s.name.clone()).collect(), loadout.shadow.clone());
    let lock = home::lock(home_dir, home::LOCK_WAIT)?;
    agent_homes::record(Agent::Claude, &lock, home_dir, &legacy, &config, &picked)?;
    let pruned = agent_homes::prune(Agent::Claude, &lock, home_dir, crate::fsx::now_ms());
    // The one shared Claude login, linked into whichever dir this launch runs on.
    let login_warnings = match on_legacy {
        true => login_link::sync_profile(home_dir, &p.shared_login, &p.home_dirs, &lock)?,
        false => {
            let mut login_dirs = p.home_dirs.clone();
            login_dirs.push(picked.rel.clone());
            login_link::sync_claude(home_dir, &config_dir, &login_dirs, &lock)?
        }
    };
    let git = identity::write(&lock, home_dir, guard);
    // Before settings: a refused row build or guard copy leaves settings.json as it was.
    let mut copied = guards::copy(&lock, &config_dir.join("hooks"), &set_guards)?;
    copied.hooks.extend(raw_groups);
    // Plan F2: an item dropped from the plan leaves only a home no live (or unknown) owner holds.
    let delete_gone = agent_homes::owners(Agent::Claude, home_dir, &config_dir) == agent_homes::Owners::None;
    let (skills, copy_warnings) = copies::sync_home(Agent::Claude, &lock, home_dir, &config_dir, plan, delete_gone);
    warnings.extend(copy_warnings);
    warnings.extend(pruned);
    warnings.extend(login_warnings);
    // The guard copies count as carried, so a rune's `enforced-by` claim on them stays. The vault
    // build's warnings are the payload's (the rune build's, as before L2a).
    let mut payload = choose_payload(&lock, &p, root, home_dir, text.as_deref(), &sets, guard)?;
    payload.warnings = loadout_warnings;
    let inherited: Vec<_> = inherited.into_iter().collect();
    let floor = Floor::of(&loadout);
    let mcp = claude_mcp::prepare_for(&lock, root, home_dir, &servers, inherited.iter().cloned(), floor.drive)?;
    let settings = match on_legacy {
        true => under(home_dir, &p.settings_target),
        false => config_dir.join("settings.json"),
    };
    let extras = home::SettingsExtras {
        allow: loadout.permissions.allow.clone(),
        ask: loadout.permissions.ask.clone(),
        mode: loadout.permissions.mode.clone(),
        output_style: loadout.output_style.clone(),
    };
    home::generate_settings_with(&under(root, &p.settings_template), &settings, root, home_dir, guard, &copied.hooks, &extras)?;
    mirror_claude_seen(&config_dir, home_dir, opts.claude_json);
    if !on_legacy {
        if let Err(e) = home::seed_claude_json(&legacy.join(".claude.json"), &config_dir.join(".claude.json")) {
            log_mirror_skip(home_dir, &e);
        }
    }
    Ok(ClaudeHome {
        p,
        lock,
        legacy,
        config_dir,
        settings,
        payload,
        mcp,
        items,
        guard_files: copied.files,
        skills,
        warnings,
        git,
        loadout_hash: loadout.hash,
        inherited,
        has_row: text.is_some(),
        vault,
        floor,
    })
}

/// The plugin a Raw line never carries: the gate mod runs on function hooks, which only the
/// Rendered overlay turns on (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`).
const RENDERED_ONLY_PLUGINS: &[&str] = &["gate"];

/// The plugin whose MCP server (`plugin_vidar_drive`) the strict MCP file carries.
const DRIVE_PLUGIN: &str = "vidar-app";

/// The allow entries a Raw line also passes as `--allowedTools` (stock `drive-allow`); every allow
/// entry already rides settings.json `permissions.allow`.
const DRIVE_TOOLS: &str = "mcp__plugin_vidar_drive";

/// What the session's Rune Vault carries for the Claude floor (run 2026-10-25-rune-vault L2b; model
/// R1): nothing here comes from the profile, so dropping a stock rune drops its effect.
#[derive(Default)]
struct Floor {
    /// Plugin rune folders (`<root>\plugins\<name>`) and their names, vault order.
    plugins: Vec<(String, String)>,
    /// Allow entries for Raw's `--allowedTools` (the drive tools only).
    allowed_tools: Vec<String>,
    mode: Option<String>,
    /// `vidar-app` is in the vault, so its drive server joins the strict MCP file.
    drive: bool,
}

impl Floor {
    fn of(loadout: &set_loadout::Loadout) -> Floor {
        let plugins: Vec<(String, String)> = loadout
            .plugins
            .iter()
            .map(|dir| (dir.clone(), Path::new(dir).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()))
            .collect();
        Floor {
            drive: plugins.iter().any(|(_, n)| n == DRIVE_PLUGIN),
            plugins,
            allowed_tools: loadout.permissions.allow.iter().filter(|a| a.starts_with(DRIVE_TOOLS)).cloned().collect(),
            mode: loadout.permissions.mode.clone(),
        }
    }

    /// Raw's plugins: every vault plugin but the Rendered-only ones (`gate` draws Rendered UI only;
    /// Raw never carried it). Silent, since the stock vault holds it: the manifest's `plugins`
    /// records what Raw carried.
    fn raw_plugins(&self) -> Vec<(String, String)> {
        self.plugins.iter().filter(|(_, n)| !RENDERED_ONLY_PLUGINS.contains(&n.as_str())).cloned().collect()
    }

    /// The hosted spawn's `plugin_names`, each checked the way Falcon admits it (`admit_plugin_name`:
    /// `[a-z0-9][a-z0-9-]{0,63}`, an existing `<root>\plugins\<name>` folder) before it goes on the
    /// wire; one that fails refuses the spawn, as Falcon would.
    fn plugin_names(&self, root: &Path) -> Result<Vec<String>, String> {
        let ok = |n: &str| {
            let b = n.as_bytes();
            (1..=64).contains(&b.len()) && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        };
        self.plugins
            .iter()
            .map(|(_, n)| {
                if !ok(n) {
                    return Err(format!("Plugin rune name {n:?} is not [a-z0-9][a-z0-9-]{{0,63}}; spawn refused"));
                }
                plugin_dir(root, n).map(|_| n.clone())
            })
            .collect()
    }
}

#[allow(clippy::too_many_arguments)]
pub fn prepare_with(
    profile_id: &str,
    root: &Path,
    home_dir: &Path,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    ambient: &Ambient,
    guard: &home::Guard,
    probes: &Probes,
    opts: &LaunchOpts,
) -> Result<Launch, String> {
    let p = load_profile(root, profile_id)?;
    check_isolation(&p)?;
    check_config_in_home(&p, root, home_dir)?;
    let (root_s, home_s) = (root.to_string_lossy().into_owned(), home_dir.to_string_lossy().into_owned());
    let ClaudeHome { p, lock, legacy: _, config_dir, settings, payload, mcp, items, guard_files, skills, warnings: home_warnings, git, loadout_hash, inherited, has_row: _, vault, floor } =
        prepare_home(p, root, home_dir, inherited, ambient, guard, opts)?;
    let raw_plugins = floor.raw_plugins();
    // Raw has no first-message hook, so it locks its vault at spawn.
    if let Some(v) = vault.as_ref() {
        vault_spawn::lock_at_spawn(root, v)?;
    }
    let seed = SessionSeed::new(root, Agent::Claude, "raw", vault.as_ref(), &loadout_hash);

    let fill = |s: &str| s.replace("{{root}}", &root_s).replace("{{home}}", &home_s);
    let mut env = profile_env(&p, root, home_dir, inherited);
    // The launch's config dir, as the hosted path hands Falcon (`SpawnParams.claude_config_dir`).
    for k in ["CLAUDE_CONFIG_DIR", "VIDAR_AGENT_HOME"] {
        if env.get(k).is_some() {
            env.set(k, config_dir.as_os_str().to_owned());
        }
    }
    let profile_dir = fill(&p.overlay.get("USERPROFILE").cloned().unwrap_or_default());

    let host = (probes.find)(&env, &p.host.name).ok_or_else(|| format!("{} is not on the allowlisted Path; bare spawn refused", p.host.name))?;
    let claude = (probes.find)(&env, &p.binary.name).ok_or_else(|| format!("{} is not on the allowlisted Path; bare spawn refused", p.binary.name))?;
    let version = (probes.version)(&claude, &env);
    let warning = match &version {
        Some(v) if *v == p.verified_version => None,
        Some(v) => Some(format!("Claude {v} differs from the verified {}; launching anyway. Verify: node tools/bare/verify-pin.mjs", p.verified_version)),
        None => Some(format!("Claude version unreadable (verified {}); launching anyway", p.verified_version)),
    };

    let plugin_dirs: Vec<String> = raw_plugins.iter().map(|(dir, _)| dir.clone()).collect();
    let vault_args = claude_line::VaultArgs { plugins: &plugin_dirs, allow: &floor.allowed_tools, mode: floor.mode.as_deref() };
    let claude_args = claude_line::claude_args(&p, &payload.path.to_string_lossy(), &fill, probes.remote_control, mcp.file.as_deref(), &vault_args)?;
    let line = claude_line::spawn_line(
        warning.iter().chain(&payload.warnings).chain(&mcp.warnings).chain(&home_warnings).chain(&git.warning),
        &claude,
        claude_args,
    );
    let mut args = p.host.args.clone();
    args.push(line);

    let (created_utc, file_stamp) = manifest::stamps();
    let m = manifest::Manifest {
        profile: p.id.clone(),
        agent: p.agent.clone(),
        tab: String::new(),
        created_utc,
        vidar_pid: std::process::id(),
        binary: manifest::Binary {
            path: claude.to_string_lossy().into_owned(),
            version,
            verified_version: p.verified_version.clone(),
            warning,
        },
        program: host.to_string_lossy().into_owned(),
        args: args.clone(),
        env_names: Vec::new(),
        homes: manifest::Homes {
            home: home_s.clone(),
            claude_config: config_dir.to_string_lossy().into_owned(),
            codex_home: String::new(),
            user_home: profile_dir,
            settings: settings.to_string_lossy().into_owned(),
        },
        payload: payload.record(),
        plugins: raw_plugins.into_iter().map(|(_, name)| name).collect(),
        guards: guard_files,
        skills,
        items: Some(items),
        git_keys: git.keys,
        warnings: mcp.warnings.into_iter().chain(home_warnings).chain(git.warning).collect(),
        managed_policy: manifest::managed_policy(),
        codex_rules: None,
        falcon_session: None,
        loadout_hash: Some(loadout_hash),
        thread_id: None,
    };
    Ok(Launch {
        program: host,
        args,
        env,
        manifest: m,
        file_stamp,
        manifests_dir: home_dir.join("manifests"),
        seed,
        _lock: lock,
    })
}

/// Prepares the real home (the per-install home under LOCALAPPDATA) for a hosted spawn.
pub fn prepare_hosted_for(profile: &str, opts: &LaunchOpts) -> Result<HostedLaunch, String> {
    let probes = Probes { find: &find_on_env_path, version: &read_version, remote_control: &read_remote_control };
    let normal = claude_dir::claude_json_for(None);
    prepare_hosted_with(
        profile,
        &crate::paths::root(),
        &home::resolve()?,
        std::env::vars_os(),
        &Ambient::from_env(),
        &home::Guard::from_vidar_env(),
        &probes,
        &LaunchOpts { claude_json: normal.as_deref(), ..*opts },
    )
}

/// The Raw path's home steps without its spawn line: profile and isolation checks, the rendered
/// block present, then `prepare_home`; the config dir it picked is checked as Falcon will admit it
/// and handed over as `claude_config_dir`, the vault's plugin runes as `plugin_names`. Takes the Raw path's `Probes` for
/// the same call shape; the hosted prepare resolves no binary (Falcon does), so none is called.
#[allow(clippy::too_many_arguments)]
pub fn prepare_hosted_with(
    profile_id: &str,
    root: &Path,
    home_dir: &Path,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    ambient: &Ambient,
    guard: &home::Guard,
    _probes: &Probes,
    opts: &LaunchOpts,
) -> Result<HostedLaunch, String> {
    let p = load_profile(root, profile_id)?;
    check_isolation(&p)?;
    check_config_in_home(&p, root, home_dir)?;
    // The sidecar throws without the block; its plugin list stays empty (plugins are vault runes).
    p.rendered.as_ref().ok_or_else(|| format!("Launch profile {:?} has no rendered block; spawn refused", p.id))?;
    let (root_s, home_s) = (root.to_string_lossy().into_owned(), home_dir.to_string_lossy().into_owned());
    // The lock is held only while the home is written: the manifest is create-new with a unique
    // name, so the host round-trip that follows needs no lock (a second bare spawn must not wait
    // on it).
    let ClaudeHome { p, lock, legacy, config_dir, settings, payload, mcp, items, guard_files, skills, warnings: home_warnings, git, loadout_hash, inherited: _, has_row, vault, floor } =
        prepare_home(p, root, home_dir, inherited, ambient, guard, opts)?;
    let plugin_names = floor.plugin_names(root)?;
    let seed = SessionSeed::new(root, Agent::Claude, "rendered", vault.as_ref(), &loadout_hash);
    // What Falcon will admit (`admit_claude_config`), checked before it goes on the wire.
    check_claude_config_dir(&config_dir, &legacy, home_dir)?;
    drop(lock);

    let fill = |s: &str| s.replace("{{root}}", &root_s).replace("{{home}}", &home_s);
    let (created_utc, file_stamp) = manifest::stamps();
    let m = manifest::Manifest {
        profile: p.id.clone(),
        agent: p.agent.clone(),
        tab: String::new(),
        created_utc,
        vidar_pid: std::process::id(),
        // Falcon resolves claude.exe and runs the sidecar; Vidar sees neither.
        binary: manifest::Binary { path: String::new(), version: None, verified_version: p.verified_version.clone(), warning: None },
        program: "falcon".into(),
        args: Vec::new(),
        env_names: Vec::new(),
        homes: manifest::Homes {
            home: home_s.clone(),
            claude_config: config_dir.to_string_lossy().into_owned(),
            codex_home: String::new(),
            user_home: fill(p.overlay.get("USERPROFILE").map(String::as_str).unwrap_or_default()),
            settings: settings.to_string_lossy().into_owned(),
        },
        payload: payload.record(),
        plugins: plugin_names.clone(),
        guards: guard_files,
        skills,
        items: Some(items),
        git_keys: git.keys,
        // No spawn line to print it on: the manifest is the hosted tab's record.
        warnings: mcp.warnings.iter().cloned().chain(home_warnings).chain(git.warning).collect(),
        managed_policy: manifest::managed_policy(),
        codex_rules: None,
        falcon_session: None,
        loadout_hash: Some(loadout_hash),
        thread_id: None,
    };
    let payload_file = has_row.then(|| payload.path.clone());
    Ok(HostedLaunch {
        payload_file,
        mcp_file: mcp.file,
        claude_config_dir: Some(config_dir),
        plugin_names,
        manifest: m,
        file_stamp,
        manifests_dir: home_dir.join("manifests"),
        seed,
    })
}

/// A per-spawn Claude config dir (`SpawnParams.claude_config_dir`) as Falcon will admit it
/// (`src-falcon/src/claude.rs` `admit_claude_config`), checked before it goes on the wire, the way
/// `check_config_in_home` checks the profile's own: under the bare home by path prefix with no
/// `..`, an existing folder, and either the profile's own dir (`overlay_dir`) or exactly
/// `<home>\claude-homes\<12 lowercase hex>`.
pub(super) fn check_claude_config_dir(dir: &Path, overlay_dir: &Path, home_dir: &Path) -> Result<(), String> {
    let comps = |p: &Path| -> Vec<String> {
        p.to_string_lossy().split(['/', '\\']).filter(|c| !c.is_empty()).map(str::to_lowercase).collect()
    };
    let (config, home, own) = (comps(dir), comps(home_dir), comps(overlay_dir));
    if config.len() <= home.len() || config[..home.len()] != home[..] || config.iter().any(|c| c == "..") {
        return Err(format!("Claude config dir {} is outside the bare home; spawn refused", dir.display()));
    }
    if !dir.is_dir() {
        return Err(format!("Claude config dir {} does not exist; spawn refused", dir.display()));
    }
    if config == own {
        return Ok(());
    }
    let hash12 = |s: &str| s.len() == 12 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    match &config[home.len()..] {
        [d, _] if d == "claude-homes" && hash12(name) => Ok(()),
        _ => Err(format!("Claude config dir {} is not the profile's own or a combination folder under claude-homes; spawn refused", dir.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The floor is the vault's and nothing else: plugin runes, the drive allow and the mode rune
    /// each reach it only when present, and the Raw line carries what it holds (L2b).
    #[test]
    fn the_claude_floor_is_what_the_vault_holds() {
        let root = crate::paths::root();
        let dir = |n: &str| root.join("plugins").join(n).to_string_lossy().into_owned();
        let mut l = set_loadout::Loadout { plugins: vec![dir("vidar-app"), dir("gate")], ..Default::default() };
        l.permissions.allow = vec!["mcp__plugin_vidar_drive".into(), "Bash(git status:*)".into()];
        l.permissions.mode = Some("auto".into());
        let f = Floor::of(&l);
        assert!(f.drive);
        assert_eq!(f.allowed_tools, ["mcp__plugin_vidar_drive".to_string()]);
        assert_eq!(f.mode.as_deref(), Some("auto"));
        assert_eq!(f.plugin_names(&root).unwrap(), ["vidar-app".to_string(), "gate".to_string()]);
        let raw: Vec<String> = f.raw_plugins().into_iter().map(|(d, _)| d).collect();
        assert_eq!(raw, [dir("vidar-app")], "gate is Rendered only");
        let p = load_profile(&root, "bare").unwrap();
        let args = claude_line::claude_args(&p, "P", &|s| s.to_string(), &|| false, None,
            &claude_line::VaultArgs { plugins: &raw, allow: &f.allowed_tools, mode: f.mode.as_deref() }).unwrap();
        let tail = &args[args.len() - 6..];
        assert_eq!(tail, ["--plugin-dir", &dir("vidar-app"), "--allowedTools", "mcp__plugin_vidar_drive", "--permission-mode", "auto"]);

        // Each rune dropped drops its effect.
        let none = Floor::of(&set_loadout::Loadout::default());
        assert!(!none.drive && none.plugins.is_empty() && none.allowed_tools.is_empty() && none.mode.is_none());
        let p_args = claude_line::claude_args(&p, "P", &|s| s.to_string(), &|| false, None, &claude_line::VaultArgs::default()).unwrap();
        assert!(!p_args.iter().any(|a| a.starts_with("--plugin-dir") || a == "--allowedTools" || a == "--permission-mode"), "{p_args:?}");
        let mut bad = set_loadout::Loadout::default();
        bad.permissions.mode = Some("bypassPermissions".into());
        let e = claude_line::claude_args(&p, "P", &|s| s.to_string(), &|| false, None,
            &claude_line::VaultArgs { mode: Floor::of(&bad).mode.as_deref(), ..Default::default() }).unwrap_err();
        assert!(e.contains("refused"), "{e}");
        let odd = Floor::of(&set_loadout::Loadout { plugins: vec![dir("Vidar_App")], ..Default::default() });
        assert!(odd.plugin_names(&root).unwrap_err().contains("not [a-z0-9]"));
    }

    #[test]
    fn a_claude_config_dir_is_the_profiles_own_or_a_claude_homes_combination() {
        let nanos = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let home = std::env::temp_dir().join(format!("vidar-claude-config-check-{}-{nanos}", std::process::id()));
        let own = home.join("claude-config");
        let combo = home.join("claude-homes").join("0123456789ab");
        for d in [&own, &combo, &home.join("claude-homes-2").join("0123456789ab"), &home.join("claude-homes").join("NotAHash")] {
            std::fs::create_dir_all(d).unwrap();
        }
        assert_eq!(check_claude_config_dir(&own, &own, &home), Ok(()));
        assert_eq!(check_claude_config_dir(&combo, &own, &home), Ok(()));
        let refused = |d: &Path, why: &str| {
            let e = check_claude_config_dir(d, &own, &home).unwrap_err();
            assert!(e.contains(why), "{}: {e}", d.display());
        };
        refused(&home.join("claude-homes").join("abcdefabcdef"), "does not exist");
        refused(&std::env::temp_dir(), "outside the bare home");
        refused(&home, "outside the bare home");
        refused(&home.join("claude-homes").join("..").join("claude-config"), "outside the bare home");
        refused(&home.join("claude-homes-2").join("0123456789ab"), "under claude-homes");
        refused(&home.join("claude-homes").join("NotAHash"), "under claude-homes");
        refused(&home.join("claude-homes"), "under claude-homes");
        let _ = std::fs::remove_dir_all(&home);
    }
}
