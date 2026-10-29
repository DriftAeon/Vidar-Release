//! The home half of a Codex Bare prepare, shared by the in-process line (`prepare_codex_for`,
//! agent.rs and pty.rs) and the Falcon-hosted spawn (`prepare_codex_hosted`,
//! falcon/session_commands.rs): env and pwsh probe, dirs, lock, git identity, skills, the built
//! payload (a profile file for the Raw TUI, otherwise carried by the caller) and config.toml. The hosted prepare resolves no
//! binary: Falcon runs Codex (installed first) and reports what it ran, which `record_host` turns
//! into the manifest's binary and the tab's warning.

use super::*;

/// What the home half leaves for the caller's line and manifest. Holds the home lock.
pub(super) struct CodexHome {
    pub p: CodexProfile,
    /// The profile's env, WindowsApps folders dropped (the in-process child's env).
    pub env: Env,
    /// Set when no unpackaged pwsh survives the WindowsApps drop on this env.
    pub shell_warning: Option<String>,
    pub codex_home: PathBuf,
    /// The vault's text and copied skill-rune listing, built into `<home>\layer\`.
    pub built: Option<layer::BuiltPayload>,
    /// The name of the profile file written for `built` (`PayloadRoute::ProfileFile`); None when the
    /// caller carries the text itself or the payload is static.
    pub profile: Option<String>,
    overlay: BTreeMap<String, String>,
    payload_path: PathBuf,
    payload_text: String,
    marker: String,
    listed: Vec<copies::Listed>,
    /// The resolved skill, agent and MCP items the launch loaded, for the manifest's `items`.
    items: manifest::LaunchItems,
    copy_warnings: Vec<String>,
    /// The guard files copied for hooks.json (shim included), for the manifest's `guards`.
    guard_files: Vec<String>,
    /// No `bareCodexGuards`, or entries dropped for a matcher no Codex tool answers to.
    guard_warnings: Vec<String>,
    /// The launch folder is not trusted by the user's own Codex config (not in `guard_warnings`; it is
    /// chained into the manifest's and Rendered's warnings separately, and Raw prints it on its banner).
    pub(super) trust_warning: Option<String>,
    /// The untrusted launch folder, as the card's Trust Folder action shows and writes it.
    pub(super) untrusted_dir: Option<String>,
    /// The shared Codex login's launch warnings (`login_link::sync_codex`), chained after the trust
    /// warning wherever it goes.
    pub(super) login_warnings: Vec<String>,
    /// The set items Codex cannot carry (`Loadout.unsupported`), one warning each, chained after the
    /// login warnings.
    pub(super) unsupported_warnings: Vec<String>,
    /// MCP warnings; both Codex surfaces load server tables from this vault's config.toml.
    pub(super) mcp: codex_mcp::LaunchArgs,
    git: identity::GitIdentity,
    config: PathBuf,
    home_dir: PathBuf,
    /// The vault the launch loaded (`launch_row::vault_for`); `None` only for the test no-vault spawn.
    pub(super) vault: Option<super::vault::Vault>,
    pub(super) loadout_hash: String,
    /// The vault's model rune, written as config.toml's top-level `model`.
    pub(super) model: Option<String>,
    pub lock: home::HomeLock,
}

/// How a prepare carries the vault's built payload to Codex.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PayloadRoute {
    /// The caller sends the built text as `developerInstructions` on `thread/start` (Rendered
    /// in-process, via the spawn reply; Falcon-hosted, via the admitted payload file). No cap.
    ThreadStart,
    /// `<codex-home>\vidar-<hash12>.config.toml` and `--profile vidar-<hash12>` (Raw TUI; no cap).
    ProfileFile,
}

/// A version warning and a shell warning as one banner line.
pub(super) fn join_warnings(version: Option<String>, shell: Option<String>) -> Option<String> {
    match (version, shell) {
        (Some(v), Some(s)) => Some(format!("{v}; {s}")),
        (v, s) => v.or(s),
    }
}

/// Shown on a Raw tab whose launch folder's `.codex\config.toml` sets `developer_instructions`: a
/// project config outranks the `--profile` file, so the runes never reach Codex.
pub(super) const PROJECT_OVERRIDE_WARNING: &str = "This Folder's Codex Config Replaces Your Runes: .codex\\config.toml Sets developer_instructions";

/// `PROJECT_OVERRIDE_WARNING` when `<cwd>\.codex\config.toml` has a top-level `developer_instructions`
/// key. A missing folder, file or key, or a file the lite parser cannot read, is silent (cannot tell).
pub(super) fn project_override_warning(cwd: Option<&str>) -> Option<String> {
    let cwd = cwd.filter(|c| !c.trim().is_empty())?;
    let text = std::fs::read_to_string(Path::new(cwd).join(".codex").join("config.toml")).ok()?;
    let doc = home::parse_toml_lite(&text).ok()?;
    doc.iter().any(|(k, _)| k == "developer_instructions").then(|| PROJECT_OVERRIDE_WARNING.to_string())
}

/// Shown when the launch folder is not trusted in the user's own Codex config.
pub(super) const UNTRUSTED_FOLDER_WARNING: &str = "Trust this Folder in your Codex Config to Load its Project Settings.";

/// Whether trust would unlock anything: a `.codex` directory (project config, hooks, exec policies)
/// in `dir` or an ancestor up to and including the nearest git root (a folder holding `.git`); with
/// no git root above, `dir` alone.
pub(super) fn has_codex_settings(dir: &Path) -> bool {
    let settings_dir = ".codex";
    let root = dir.ancestors().find(|a| a.join(".git").exists()).unwrap_or(dir);
    for a in dir.ancestors() {
        if a.join(settings_dir).is_dir() {
            return true;
        }
        if a == root {
            break;
        }
    }
    false
}

/// Whether the user's Codex config (`config`, the caller's path) trusts `cwd`; tests add folders
/// through `TEST_TRUST` without a file.
#[cfg(not(test))]
fn trust_of(config: Option<&Path>, cwd: &str) -> bool {
    config.is_some_and(|c| super::codex_user_trust::config_trusts(c, cwd))
}
#[cfg(test)]
fn trust_of(config: Option<&Path>, cwd: &str) -> bool {
    TEST_TRUST.with(|t| t.borrow().iter().any(|p| home::norm_cwd(p) == home::norm_cwd(cwd))) || config.is_some_and(|c| super::codex_user_trust::config_trusts(c, cwd))
}
#[cfg(test)]
thread_local! {
    pub(super) static TEST_TRUST: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// The installed-Codex resolver (`resolve_codex` or a test's): codex.js and its version.
pub(super) type ResolveCodex<'r> = dyn Fn(&Env, &CodexBinary) -> Option<(PathBuf, Option<String>)> + 'r;

/// Everything a Codex Bare spawn writes before its line: the caller has loaded the profile and
/// refused the surface. `cwd` becomes config.toml's one trusted `[projects]` entry only when the user's own Codex config trusts it.
/// `bareCodexGuards` (P1 W2): the guards and the shim are copied and written into hooks.json
/// (`codex_hooks::write`, the one writer every Codex prepare runs), then trusted through
/// `hooks/list` once config.toml is written (`codex_hooks::trust`, node from `find` and codex.js
/// from `codex`, the binary the in-process line and Falcon's installed-first pick both run); a hook
/// Codex does not trust refuses the spawn. The guard files ride into the built payload as carried
/// hooks, and that payload reaches Codex only when the trust check passed (a refusal ends the spawn).
#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_home(
    p: CodexProfile,
    root: &Path,
    home_dir: &Path,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    ambient: &Ambient,
    guard: &home::Guard,
    find: &dyn Fn(&Env, &str) -> Option<PathBuf>,
    codex: &ResolveCodex<'_>,
    opts: &LaunchOpts,
    cwd: Option<&str>,
    payload_route: PayloadRoute,
    hosted: bool,
) -> Result<CodexHome, String> {
    let _ = hosted; // Both surfaces now use vault-owned MCP tables.
    let mut overlay: BTreeMap<String, String> = p.overlay.iter().map(|(k, v)| (k.clone(), fill_placeholders(v, root, home_dir))).collect();
    let vault = vault_for(root, opts, super::agent_homes::Agent::Codex)?;
    // Every item the launch carries comes from its vault through the resolver (model R2), which maps
    // each item rune through rune_items::map_items(Agent::Codex, ...): skills, agents, guards, env and
    // MCP. What Codex cannot carry (`Loadout.unsupported`: mode, plugins) is named in the warnings.
    let config = config_of(opts);
    let resolve_env = set_loadout::ResolveEnv { root, config: &config, home: home_dir, user_home: ambient.user_home.as_deref() };
    let set_loadout::VaultLoadout { mut loadout, warnings: loadout_warnings, text, sets } = vault_spawn::resolve(&resolve_env, Agent::Codex, root, vault.as_ref())?;
    if !loadout.refusals.is_empty() {
        return Err(format!("Rune Vault failed to resolve: {}; Bare spawn refused", loadout.refusals.join("; ")));
    }
    // Codex's bundled skills are runes too: their markers leave the copy list, the config switch is appended last.
    let off_held = vault.as_ref().is_some_and(super::codex_builtin::holds_off);
    let builtins = super::codex_builtin::take(Agent::Codex, root, &mut loadout.skills, off_held);
    // The launch's vault picks its Codex home (`agent_homes::pick_vault`, keyed `vault:<id>`; read-only
    // here, recorded under the lock). The test no-vault spawn stays on the profile's home; a hosted
    // spawn hands its pick to Falcon (`SpawnParams.codex_home`, W9).
    let legacy = codex_home_of(&p, root, home_dir);
    let picked = legacy.as_ref().map(|l| agent_homes::pick_vault(Agent::Codex, home_dir, l, vault.as_ref().map(|v| v.id.as_str())));
    if let Some(pk) = picked.as_ref().filter(|pk| Some(&pk.dir) != legacy.as_ref()) {
        for k in ["CODEX_HOME", "VIDAR_AGENT_HOME"] {
            if let Some(v) = overlay.get_mut(k) {
                *v = pk.dir.to_string_lossy().into_owned();
            }
        }
    }
    let inherited: Vec<(OsString, OsString)> = inherited.into_iter().collect();
    // Before the home is touched: an overlay without an absolute CODEX_HOME refuses here.
    let mut env = env::codex(inherited.iter().cloned(), &overlay)?;
    for (name, value) in &loadout.env {
        if overlay.keys().any(|key| key.eq_ignore_ascii_case(name)) {
            return Err(format!("Rune Vault env {name} conflicts with the Codex home overlay; Bare spawn refused"));
        }
        env.set(name, value.expose());
    }
    // pwsh on the full allowlisted Path first (the Store alias included: notify runs outside the
    // sandbox), then the WindowsApps folders leave the Path so Codex's own shell lookup cannot pick the
    // Store pwsh its sandbox token cannot start (env::drop_app_alias_dirs). A pwsh found again after the
    // drop is an unpackaged install: Codex's shell lookup finds it too, so it serves shell and notify.
    // Not found, Codex's shell is Windows PowerShell 5.1, notify keeps the full-Path pwsh, and the tab warns.
    let full_pwsh = find(&env, PWSH).ok_or_else(|| format!("{PWSH} is not on the allowlisted Path; bare spawn refused"))?;
    env::drop_app_alias_dirs(&mut env);
    let (pwsh, shell_warning) = match find(&env, PWSH) {
        Some(unpackaged) => (unpackaged, None),
        None => (full_pwsh, Some(SHELL_51_WARNING.to_string())),
    };
    let process_env = |name: &str| env.get(name).and_then(|v| v.to_str()).map(str::to_string)
        .or_else(|| inherited.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).and_then(|(_, v)| v.to_str()).map(str::to_string));
    let (legacy, picked) = legacy.zip(picked).ok_or("Bare Codex profile sets no CODEX_HOME; spawn refused")?;
    let codex_home = picked.dir.clone();
    if let Some(skill) = recall_skill::write(root, home_dir, guard, &loadout.recall_skill)? {
        loadout.skills.insert(0, skill.to_string_lossy().into_owned());
    }
    let mut hook_guards: Vec<guards::BareCodexGuard> = Vec::new();
    let mut raw_groups = Vec::new();
    for g in &loadout.guard_items {
        if let Some(raw) = guards::raw_hook(g).map_err(|e| format!("{e}; Bare spawn refused"))? {
            raw_groups.push(guards::raw_group(&raw, true));
            continue;
        }
        hook_guards.push(serde_json::from_value(g.clone()).map_err(|e| format!("A set's codexGuards entry is not {{ event, matcher?, run, open? }} ({e}); Bare spawn refused"))?);
    }
    let unsupported_warnings: Vec<String> = loadout.unsupported.iter().map(|u| set_loadout::not_carried(Agent::Codex, u)).collect();
    // The trust check needs node even when every hook is a raw command.
    let node = match hook_guards.is_empty() && raw_groups.is_empty() {
        true => PathBuf::new(),
        false => find(&env, &p.host.name).ok_or_else(|| format!("{} is not on the allowlisted Path for the guard hooks; Bare spawn refused", p.host.name))?,
    };

    home::prepare_dirs(home_dir, &p.home_dirs)?;
    // Skill sources read and hashed before the lock, as the Claude prepares do.
    let skill_plan = copies::plan_for(Agent::Codex, &copies::codex_skills_in(root, &loadout.skills), &loadout.agents, Some(home_dir));
    let selected_skills: Vec<String> = skill_plan.skills.iter().map(|s| s.name.clone()).collect();
    let selected_agents: Vec<String> = skill_plan.agents.iter().map(|a| a.name.clone()).collect();
    // MCP tables live in this vault's Codex home for both surfaces. Server URLs and env values
    // never enter argv. vidar_drive has no bundle entry: its stock rune toggles the pinned table.
    let (catalog, _) = bundles::load(root);
    let servers = codex_mcp::for_launch(&loadout.mcp, &catalog);
    let drive = match vault.as_ref() {
        Some(v) => vault::store::Store::open(&vault_spawn::store_root(root)).resolve(&v.id)?.runes.iter().any(|r| {
            r.library == "stock" && r.id == "vidar-drive" && loadout.mcp.iter().any(|m| m == "vidar_drive")
        }),
        None => false,
    };
    let (mut table_mcp, mut mcp_warnings) = codex_mcp::Tables::servers(&servers, &process_env)?;
    if drive {
        table_mcp = table_mcp.with_vidar_drive(root)?;
    }
    for name in &loadout.mcp {
        if !table_mcp.names.iter().any(|n| n.eq_ignore_ascii_case(name)) {
            mcp_warnings.push(format!("MCP server {name}: no Codex server definition for this Rune Vault; not carried"));
        }
    }
    let mcp = codex_mcp::LaunchArgs { warnings: mcp_warnings, ..Default::default() };
    let items = manifest::LaunchItems::without_guards(&skill_plan, table_mcp.names.clone(), loadout.shadow.clone());
    let lock = home::lock(home_dir, home::LOCK_WAIT)?;
    agent_homes::record(Agent::Codex, &lock, home_dir, &legacy, &config, &picked)?;
    let mut copy_warnings = agent_homes::prune(Agent::Codex, &lock, home_dir, crate::fsx::now_ms());
    copy_warnings.extend(loadout_warnings);
    // First under the lock, as Claude's: `auth.json` linked to the shared Codex login, so a fresh
    // install folder starts signed in and Flow's `auth.json` presence check sees the linked file.
    // A combination home's folder joins homeDirs for the check.
    let mut login_dirs = p.home_dirs.clone();
    let on_legacy = codex_home == legacy;
    login_dirs.extend((!on_legacy).then(|| picked.rel.clone()));
    let login_warnings = login_link_codex::sync_codex(home_dir, &codex_home, &login_dirs, &lock)?;
    let git = identity::write(&lock, home_dir, guard);
    // Before the payload: a refused guard copy leaves config.toml as it was.
    let copied = guards::copy_codex(&lock, home_dir, &node, &under(root, "tools/bare/codex-shim.mjs"), &hook_guards)?;
    let mut groups = copied.groups.clone();
    groups.extend(raw_groups);
    let handlers = codex_hooks::write(&lock, &codex_home, &groups)?;
    // Plan F2: an item dropped from the plan leaves only a home no live (or unknown) owner holds.
    let delete_gone = agent_homes::owners(Agent::Codex, home_dir, &codex_home) == agent_homes::Owners::None;
    let (listed, synced) = copies::sync_codex(&lock, home_dir, &codex_home, skill_plan, delete_gone);
    copy_warnings.extend(synced);
    // A live owner can keep a dropped copy in this home. Refuse a new spawn before Codex can
    // discover a skill or role that the current vault did not select.
    for (kind, names) in [("skills", &selected_skills), ("agents", &selected_agents)] {
        let dir = codex_home.join(kind);
        if dir.is_dir() {
            for entry in std::fs::read_dir(&dir).map_err(|e| format!("Codex {kind} {}: {e}; Bare spawn refused", dir.display()))? {
                let entry = entry.map_err(|e| format!("Codex {kind} {}: {e}; Bare spawn refused", dir.display()))?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if !name.starts_with('.') && !names.iter().any(|wanted| wanted.eq_ignore_ascii_case(&name)) {
                    return Err(format!("Codex {kind} {name:?} is outside the loaded Rune Vault; Bare spawn refused"));
                }
            }
        }
    }
    copy_warnings.extend(mcp.warnings.iter().cloned());
    let payload_path = under(root, &p.payload);
    let payload_text = crate::fsx::read_text(&payload_path).map_err(|e| format!("Bare payload {}: {e}", payload_path.display()))?;
    let (marker, _) = payload_marker(&payload_text)?;
    // Built, then written as a profile file when that is the route, before config.toml: a refusal
    // leaves it, the manifest and the spawn untouched. config.toml has an inert baseline;
    // `thread/start` or the `--profile` file delivers this vault's instructions.
    let listing = copies::listing(&listed);
    let built = match vault.is_none() && text.is_none() && listing.trim().is_empty() {
        // The test-only no-vault spawn (`launch_row::TEST_NO_VAULT`) with nothing to carry.
        true => None,
        false => codex_instructions(&lock, &p, root, home_dir, text.as_deref(), &sets, &listing, guard)?,
    };
    let profile = match (&built, payload_route) {
        (Some(b), PayloadRoute::ProfileFile) => Some(home::write_codex_profile(&lock, &codex_home, &String::from_utf8_lossy(&b.bytes), root, home_dir, guard)?),
        _ => None,
    };
    // The active instructions are built from this vault. Keep the profile's baseline inert; only the
    // test no-vault spawn keeps the static payload.
    let payload = match built {
        Some(_) => String::new(),
        None => payload_text.replace('\r', ""),
    };
    let config = match on_legacy {
        true => under(home_dir, &p.config_target),
        false => codex_home.join("config.toml"),
    };
    let template = under(root, &p.config_template);
    // Only a folder the user's own Codex config trusts gets the trust table; any other still runs,
    // with its project config, hooks and exec policies not loaded, and the tab says so, but only when
    // the folder has a `.codex` to load (otherwise trusting it would change nothing).
    let launch_dir = cwd.filter(|c| !c.trim().is_empty());
    let trusted_cwd = launch_dir.filter(|c| trust_of(ambient.codex_config.as_deref(), c));
    let settings_found = launch_dir.is_some_and(|c| has_codex_settings(Path::new(c)));
    let trust_warning = (settings_found && trusted_cwd.is_none()).then(|| UNTRUSTED_FOLDER_WARNING.to_string());
    let untrusted_dir = launch_dir.filter(|_| trust_warning.is_some()).map(str::to_string);
    // Both surfaces: exactly the vault's server tables (none when it carries no MCP rune).
    let model = loadout.model.clone();
    home::generate_codex_config_with(&template, &config, root, home_dir, &pwsh, &payload, guard, trusted_cwd, &table_mcp, &home::HookTrust::default(), model.as_deref())?;
    if handlers > 0 {
        let hooks_json = codex_home.join(codex_hooks::HOOKS_FILE);
        let launch_dir = match cwd.filter(|c| !c.trim().is_empty()).map(PathBuf::from) {
            Some(dir) => dir,
            None => codex_home.clone(),
        };
        let ctx = codex_hooks::ListCtx { env: &env, node: &node, js: codex(&env, &p.binary).map(|(js, _)| js), codex_home: &codex_home, cwd: &launch_dir };
        let mut write_trusted = |entries: &[(String, String)]| {
            let trust = home::HookTrust { hooks_json: Some(&hooks_json), entries };
            home::generate_codex_config_with(&template, &config, root, home_dir, &pwsh, &payload, guard, trusted_cwd, &table_mcp, &trust, model.as_deref())
        };
        codex_hooks::trust(&ctx, &hooks_json, handlers, &mut write_trusted)?;
    }
    builtins.apply(&config)?;
    Ok(CodexHome {
        p,
        env,
        shell_warning,
        codex_home,
        built,
        profile,
        overlay,
        payload_path,
        payload_text,
        marker,
        listed,
        items,
        copy_warnings,
        guard_files: if handlers > 0 { copied.files } else { Vec::new() },
        guard_warnings: copied.warnings,
        trust_warning,
        untrusted_dir,
        login_warnings,
        unsupported_warnings,
        mcp,
        git,
        config,
        home_dir: home_dir.to_path_buf(),
        vault,
        loadout_hash: loadout.hash,
        model,
        lock,
    })
}

impl CodexHome {
    /// The launch record (tab and env names filled at spawn) and its file stamp.
    pub(super) fn manifest(&self, binary: manifest::Binary, program: String, args: Vec<String>) -> (manifest::Manifest, String) {
        let rules = std::fs::read_dir(self.codex_home.join("rules"))
            .map(|d| {
                let mut v: Vec<String> = d.filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
                v.sort();
                v
            })
            .unwrap_or_default();
        let (created_utc, file_stamp) = manifest::stamps();
        let m = manifest::Manifest {
            profile: self.p.id.clone(),
            agent: self.p.agent.clone(),
            tab: String::new(),
            created_utc,
            vidar_pid: std::process::id(),
            binary,
            program,
            args,
            env_names: Vec::new(),
            homes: manifest::Homes {
                home: self.home_dir.to_string_lossy().into_owned(),
                claude_config: String::new(),
                codex_home: self.codex_home.to_string_lossy().into_owned(),
                user_home: self.overlay.get("USERPROFILE").cloned().unwrap_or_default(),
                settings: self.config.to_string_lossy().into_owned(),
            },
            payload: match &self.built {
                Some(b) => manifest::Payload {
                    path: b.path.to_string_lossy().into_owned(),
                    sha256: hex(&Sha256::digest(&b.bytes)),
                    marker: b.marker.clone(),
                    sets: b.sets.clone(),
                    warnings: b.warnings.iter().cloned().chain(self.trust_warning.clone()).chain(self.login_warnings.iter().cloned()).chain(self.unsupported_warnings.iter().cloned()).collect(),
                },
                None => manifest::Payload {
                    path: self.payload_path.to_string_lossy().into_owned(),
                    sha256: hex(&Sha256::digest(self.payload_text.as_bytes())),
                    marker: self.marker.clone(),
                    sets: Vec::new(),
                    warnings: self.trust_warning.iter().chain(&self.login_warnings).chain(&self.unsupported_warnings).cloned().collect(),
                },
            },
            plugins: Vec::new(),
            guards: self.guard_files.clone(),
            skills: self.listed.iter().map(|s| s.name.clone()).collect(),
            items: Some(self.items.clone()),
            git_keys: self.git.keys.clone(),
            // Copy warnings are log-only for Codex: the spawn line has no banner for them.
            warnings: self.guard_warnings.iter().chain(&self.copy_warnings).cloned().chain(self.git.warning.clone()).collect(),
            managed_policy: manifest::managed_policy(),
            codex_rules: Some(rules),
            falcon_session: None,
            loadout_hash: Some(self.loadout_hash.clone()),
            thread_id: None,
        };
        (m, file_stamp)
    }
}

/// A prepared hosted Codex Bare spawn: home, payload and config.toml written, no binary resolved.
/// Holds the home lock until dropped (after the host's reply), as the in-process launch holds it
/// until its child starts: a second spawn would rewrite config.toml's trusted folder under it.
pub struct CodexHostedLaunch {
    /// The row's built payload (`<home>\layer\payload-<hash12>.md`), already admitted by the rule
    /// Falcon applies (`codex_payload::admit_payload_file`), for `SpawnParams.payload_file`;
    /// `None` when there is nothing to build and config.toml's static payload stands.
    pub payload_file: Option<PathBuf>,
    /// The launch's combination home (`<home>\codex-homes\<hash12>`), already admitted by the rule
    /// Falcon applies (`codex_payload::admit_codex_home`), for `SpawnParams.codex_home`; `None` when
    /// the launch runs on the profile's own home (no sets, or the seeded combination).
    pub codex_home: Option<PathBuf>,
    /// The vault's model rune; beats the row's model at spawn (`falcon/session_commands.rs`).
    pub model: Option<String>,
    manifest: manifest::Manifest,
    file_stamp: String,
    manifests_dir: PathBuf,
    /// The launch folder when the user's Codex config does not trust it; `write_manifest` registers
    /// it for the notice card's Trust Folder action (`codex_trust`).
    untrusted_dir: Option<String>,
    seed: Option<SessionSeed>,
    /// The profile's host (node) name, its env and the install root: what `record_host` runs
    /// `verify.mjs` with on a new Codex version, as the in-process prepare does (`verify_new_codex`).
    /// Node is looked up only then, so the prepare itself still probes no binary.
    verify_host: String,
    verify_env: Env,
    root: PathBuf,
    _lock: home::HomeLock,
}

impl CodexHostedLaunch {
    /// What the tab's notice area shows: the rune build's warnings, then the binary/shell warning
    /// `record_host` set (copy and git warnings stay in the manifest, as for in-process Codex).
    /// The untrusted-folder warning is left to the card's trust offer (the manifest keeps it).
    pub fn bare_warnings(&self) -> Vec<String> {
        self.manifest.payload.warnings.iter().filter(|w| *w != UNTRUSTED_FOLDER_WARNING).chain(&self.manifest.binary.warning).cloned().collect()
    }

    /// Records what Falcon ran (the spawn reply's `codex_bare`): the executable, its version
    /// checked against the profile's pin and the accepted verdicts, and the pwsh its Path found
    /// after the WindowsApps drop (None: Codex's shell is Windows PowerShell 5.1). Returns the warning.
    /// A version without a verdict against the pin starts the `verify.mjs` run on the executable
    /// Falcon ran, so its verdict lands in Vidar's `codexAccepted` file for the next launch.
    pub fn record_host(&mut self, executable: &str, version: Option<&str>, pwsh: Option<&str>) -> Option<String> {
        let accepted_path = crate::paths::codex_accepted_path();
        let warning = self.record_host_with(executable, version, pwsh, &read_accepted(&accepted_path));
        if let Some(job) = self.verify_job(&accepted_path, &find_on_env_path) {
            codex_verify::start_verify(job);
        }
        warning
    }

    /// The verify `record_host` starts for what it recorded; None on the pin, an accepted version or
    /// no node on the profile's Path (the launch goes ahead unchecked).
    pub(super) fn verify_job(&self, accepted_path: &Path, find: &dyn Fn(&Env, &str) -> Option<PathBuf>) -> Option<codex_verify::VerifyJob> {
        let b = &self.manifest.binary;
        if b.version.is_none() || b.version.as_deref() == Some(b.verified_version.as_str()) {
            return None;
        }
        let node = find(&self.verify_env, &self.verify_host)?;
        codex_verify::verify_job(b.version.as_deref(), &b.verified_version, &node, &b.path, &self.verify_env, &self.root, accepted_path)
    }

    pub(super) fn record_host_with(&mut self, executable: &str, version: Option<&str>, pwsh: Option<&str>, accepted: &codex_verify::AcceptedMap) -> Option<String> {
        let b = &mut self.manifest.binary;
        let shell = pwsh.is_none().then(|| SHELL_51_WARNING.to_string());
        b.path = executable.to_string();
        b.version = version.map(str::to_string);
        b.warning = join_warnings(codex_warning(version, &b.verified_version, accepted), shell);
        b.warning.clone()
    }

    /// Same contract as `HostedLaunch::write_manifest`: create-new, once the reply names the session.
    pub fn write_manifest<'a>(&mut self, tab: &str, falcon_session: &str, env_names: impl IntoIterator<Item = &'a str>) -> Result<PathBuf, String> {
        self.manifest.tab = tab.to_string();
        self.manifest.falcon_session = Some(falcon_session.to_string());
        self.manifest.env_names = env_names.into_iter().map(str::to_string).collect();
        let written = manifest::write(&self.manifests_dir, &self.file_stamp, &self.manifest)?;
        vault_spawn::write_record(self.seed.as_ref(), tab, Some(falcon_session), Path::new(&self.manifest.homes.codex_home))?;
        super::codex_trust::register(tab, self.untrusted_dir.clone());
        Ok(written)
    }
}

/// Prepares the real home for a hosted Codex Bare spawn in `cwd`, in u1's order: the folder is
/// resolved (no blank, a directory), refused when it is the user profile or a parent of it
/// (`refuse_home_cwd`, then `refuse_profile_cwd`, through `pty::codex_bare_prepare`), then prepared.
pub fn prepare_codex_hosted(profile: &str, opts: &LaunchOpts, cwd: &str) -> Result<CodexHostedLaunch, String> {
    let dir = Some(cwd.trim()).filter(|c| !c.is_empty()).map(PathBuf::from).ok_or("Bare Codex refused: no launch folder; pick a project folder")?;
    if !dir.is_dir() {
        return Err(format!("cwd is not a directory: {cwd}"));
    }
    let root = crate::paths::root();
    let home_dir = home::resolve()?;
    let guard = home::Guard::from_vidar_env();
    let ambient = Ambient::from_env();
    let (_, launch) = crate::pty::codex_bare_prepare(Some(dir), |cwd| {
        prepare_codex_hosted_with(profile, &root, &home_dir, std::env::vars_os(), &ambient, &guard, &find_on_env_path, opts, cwd)
    })?;
    Ok(launch)
}

/// `prepare_codex_hosted` on a given root and home, for an admitted folder: the in-process home
/// half (`prepare_home`), then the built payload checked against the host's admission rule. No
/// `node`, no `codex.js`, no version read: the manifest's binary is filled by `record_host`.
#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_codex_hosted_with(
    profile_id: &str,
    root: &Path,
    home_dir: &Path,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    ambient: &Ambient,
    guard: &home::Guard,
    find: &dyn Fn(&Env, &str) -> Option<PathBuf>,
    opts: &LaunchOpts,
    cwd: &str,
) -> Result<CodexHostedLaunch, String> {
    if !PROFILES.contains(&profile_id) {
        return Err(format!("Unknown launch profile {profile_id:?}; spawn refused"));
    }
    let p = load_codex_profile(root, profile_id)?;
    // The host sends the payload on `thread/start`, so no length is refused here; the marker and
    // path admission below stay.
    let legacy = codex_home_of(&p, root, home_dir);
    let h = prepare_home(p, root, home_dir, inherited, ambient, guard, find, &resolve_codex, opts, Some(cwd), PayloadRoute::ThreadStart, true)?;
    // A combination home goes to Falcon by path, checked here by the host's own rule first.
    let codex_home = match legacy.as_ref() == Some(&h.codex_home) {
        true => None,
        false => {
            codex_payload::admit_codex_home(&h.codex_home.to_string_lossy(), home_dir).map_err(|e| format!("{e}; Bare spawn refused"))?;
            Some(h.codex_home.clone())
        }
    };
    let payload_file = match &h.built {
        Some(b) => {
            codex_payload::admit_payload_file(&b.path.to_string_lossy(), home_dir).map_err(|e| format!("{e}; Bare spawn refused"))?;
            Some(b.path.clone())
        }
        None => None,
    };
    // Falcon resolves and runs Codex; `record_host` fills path, version and warning from its reply.
    let binary = manifest::Binary { path: String::new(), version: None, verified_version: h.p.verified_version.clone(), warning: None };
    let (manifest, file_stamp) = h.manifest(binary, "falcon".into(), Vec::new());
    let seed = SessionSeed::new(root, Agent::Codex, "hosted", h.vault.as_ref(), &h.loadout_hash);
    Ok(CodexHostedLaunch {
        payload_file, codex_home, model: h.model.clone(), manifest, file_stamp, manifests_dir: home_dir.join("manifests"), untrusted_dir: h.untrusted_dir.clone(), seed,
        verify_host: h.p.host.name.clone(), verify_env: h.env.clone(), root: root.to_path_buf(), _lock: h.lock,
    })
}
