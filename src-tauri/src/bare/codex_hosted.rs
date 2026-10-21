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
    /// The row's sets and/or skills listing, built into `<home>\layer\`; None = static payload.
    pub built: Option<layer::BuiltPayload>,
    /// The name of the profile file written for `built` (`PayloadRoute::ProfileFile`); None when the
    /// caller carries the text itself or the payload is static.
    pub profile: Option<String>,
    overlay: BTreeMap<String, String>,
    payload_path: PathBuf,
    payload_text: String,
    marker: String,
    listed: Vec<copies::Listed>,
    copy_warnings: Vec<String>,
    /// The guard files copied for hooks.json (shim included), for the manifest's `guards`.
    guard_files: Vec<String>,
    /// No `bareCodexGuards`, or entries dropped for a matcher no Codex tool answers to.
    guard_warnings: Vec<String>,
    /// The launch folder is not trusted by the user's own Codex config (not in `guard_warnings`; it is
    /// chained into the manifest's and Rendered's warnings separately, and Raw prints it on its banner).
    pub(super) trust_warning: Option<String>,
    /// The shared Codex login's launch warnings (`login_link::sync_codex`), chained after the trust
    /// warning wherever it goes.
    pub(super) login_warnings: Vec<String>,
    git: identity::GitIdentity,
    config: PathBuf,
    home_dir: PathBuf,
    pub lock: home::HomeLock,
}

/// How a prepare carries the row's built payload to Codex.
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
pub(super) const UNTRUSTED_FOLDER_WARNING: &str = "Codex doesn't trust this folder yet. Trust it in your own Codex config to load its project settings.";

/// Whether the user's Codex config trusts `cwd`; tests stand in for the real `~\.codex\config.toml`.
#[cfg(not(test))]
fn trust_of(cwd: &str) -> bool {
    super::codex_user_trust::user_trusts(cwd)
}
#[cfg(test)]
fn trust_of(cwd: &str) -> bool {
    TEST_TRUST.with(|t| t.borrow().iter().any(|p| home::norm_cwd(p) == home::norm_cwd(cwd)))
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
    guard: &home::Guard,
    find: &dyn Fn(&Env, &str) -> Option<PathBuf>,
    codex: &ResolveCodex<'_>,
    opts: &LaunchOpts,
    cwd: Option<&str>,
    payload_route: PayloadRoute,
) -> Result<CodexHome, String> {
    let overlay: BTreeMap<String, String> = p.overlay.iter().map(|(k, v)| (k.clone(), fill_placeholders(v, root, home_dir))).collect();
    // Before the home is touched: an overlay without an absolute CODEX_HOME refuses here.
    let mut env = env::codex(inherited, &overlay)?;
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
    let codex_home = codex_home_of(&p, root, home_dir).ok_or("Bare Codex profile sets no CODEX_HOME; spawn refused")?;

    let row = row_sets_for(opts)?;
    let codex_guards = guards::read_codex(&config_of(opts))?;
    // The node every hook line and the trust check run: the one on the Bare Path, as Codex's own.
    let node = match codex_guards.is_empty() {
        true => PathBuf::new(),
        false => find(&env, &p.host.name).ok_or_else(|| format!("{} is not on the allowlisted Path for the guard hooks; Bare spawn refused", p.host.name))?,
    };

    home::prepare_dirs(home_dir, &p.home_dirs)?;
    // Skill sources read and hashed before the lock, as the Claude prepares do.
    let skill_plan = copies::plan_codex(&config_of(opts), home_dir, opts.row_key);
    let mcp = codex_mcp::read_enabled(&config_of(opts))?;
    let lock = home::lock(home_dir, home::LOCK_WAIT)?;
    // First under the lock, as Claude's: `auth.json` linked to the shared Codex login, so a fresh
    // install folder starts signed in and Flow's `auth.json` presence check sees the linked file.
    let login_warnings = login_link::sync_codex(home_dir, &codex_home, &p.home_dirs, &lock)?;
    let git = identity::write(&lock, home_dir, guard);
    // Before the payload: a refused guard copy leaves config.toml as it was.
    let copied = guards::copy_codex(&lock, home_dir, &node, &under(root, "tools/bare/codex-shim.mjs"), &codex_guards)?;
    let handlers = codex_hooks::write(&lock, &codex_home, &copied.groups)?;
    let (listed, copy_warnings) = copies::sync_codex(&lock, home_dir, &codex_home, skill_plan);
    let payload_path = under(root, &p.payload);
    let payload_text = crate::fsx::read_text(&payload_path).map_err(|e| format!("Bare payload {}: {e}", payload_path.display()))?;
    let (marker, _) = payload_marker(&payload_text)?;
    // Built, then written as a profile file when that is the route, before config.toml: a refusal
    // leaves it, the manifest and the spawn untouched. config.toml keeps the static payload; the
    // `thread/start` param (P4) and the `--profile` file (r1) both override it (0.163.0).
    let carried: &[String] = if handlers > 0 { &copied.files } else { &[] };
    let built = codex_instructions(&lock, &p, root, home_dir, row.as_ref(), &copies::listing(&listed), guard, carried)?;
    let profile = match (&built, payload_route) {
        (Some(b), PayloadRoute::ProfileFile) => Some(home::write_codex_profile(&lock, &codex_home, &String::from_utf8_lossy(&b.bytes), root, home_dir, guard)?),
        _ => None,
    };
    let payload = payload_text.replace('\r', "");
    let config = under(home_dir, &p.config_target);
    let template = under(root, &p.config_template);
    // Only a folder the user's own Codex config trusts gets the trust table; any other still runs,
    // with its project config, hooks and exec policies not loaded, and the tab says so.
    let launch_dir = cwd.filter(|c| !c.trim().is_empty());
    let trusted_cwd = launch_dir.filter(|c| trust_of(c));
    let trust_warning = (launch_dir.is_some() && trusted_cwd.is_none()).then(|| UNTRUSTED_FOLDER_WARNING.to_string());
    home::generate_codex_config_for(&template, &config, root, home_dir, &pwsh, &payload, guard, trusted_cwd, &mcp)?;
    if handlers > 0 {
        let hooks_json = codex_home.join(codex_hooks::HOOKS_FILE);
        let launch_dir = cwd.filter(|c| !c.trim().is_empty()).map(PathBuf::from).unwrap_or_else(|| codex_home.clone());
        let ctx = codex_hooks::ListCtx { env: &env, node: &node, js: codex(&env, &p.binary).map(|(js, _)| js), codex_home: &codex_home, cwd: &launch_dir };
        let mut write_trusted = |entries: &[(String, String)]| {
            let trust = home::HookTrust { hooks_json: Some(&hooks_json), entries };
            home::generate_codex_config_with(&template, &config, root, home_dir, &pwsh, &payload, guard, trusted_cwd, &mcp, &trust)
        };
        codex_hooks::trust(&ctx, &hooks_json, handlers, &mut write_trusted)?;
    }
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
        copy_warnings,
        guard_files: if handlers > 0 { copied.files } else { Vec::new() },
        guard_warnings: copied.warnings,
        trust_warning,
        login_warnings,
        git,
        config,
        home_dir: home_dir.to_path_buf(),
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
                    warnings: b.warnings.iter().cloned().chain(self.trust_warning.clone()).chain(self.login_warnings.iter().cloned()).collect(),
                },
                None => manifest::Payload {
                    path: self.payload_path.to_string_lossy().into_owned(),
                    sha256: hex(&Sha256::digest(self.payload_text.as_bytes())),
                    marker: self.marker.clone(),
                    sets: Vec::new(),
                    warnings: self.trust_warning.iter().chain(&self.login_warnings).cloned().collect(),
                },
            },
            plugins: Vec::new(),
            guards: self.guard_files.clone(),
            skills: self.listed.iter().map(|s| s.name.clone()).collect(),
            git_keys: self.git.keys.clone(),
            // Copy warnings are log-only for Codex: the spawn line has no banner for them.
            warnings: self.guard_warnings.iter().chain(&self.copy_warnings).cloned().chain(self.git.warning.clone()).collect(),
            managed_policy: manifest::managed_policy(),
            codex_rules: Some(rules),
            falcon_session: None,
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
    manifest: manifest::Manifest,
    file_stamp: String,
    manifests_dir: PathBuf,
    _lock: home::HomeLock,
}

impl CodexHostedLaunch {
    /// What the tab's notice area shows: the rune build's warnings, then the binary/shell warning
    /// `record_host` set (copy and git warnings stay in the manifest, as for in-process Codex).
    pub fn bare_warnings(&self) -> Vec<String> {
        self.manifest.payload.warnings.iter().chain(&self.manifest.binary.warning).cloned().collect()
    }

    /// Records what Falcon ran (the spawn reply's `codex_bare`): the executable, its version
    /// checked against the profile's pin and the accepted verdicts, and the pwsh its Path found
    /// after the WindowsApps drop (None: Codex's shell is Windows PowerShell 5.1). Returns the warning.
    pub fn record_host(&mut self, executable: &str, version: Option<&str>, pwsh: Option<&str>) -> Option<String> {
        self.record_host_with(executable, version, pwsh, &read_accepted(&crate::paths::codex_accepted_path()))
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
        manifest::write(&self.manifests_dir, &self.file_stamp, &self.manifest)
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
    let (_, launch) = crate::pty::codex_bare_prepare(Some(dir), |cwd| {
        prepare_codex_hosted_with(profile, &root, &home_dir, std::env::vars_os(), &guard, &find_on_env_path, opts, cwd)
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
    let h = prepare_home(p, root, home_dir, inherited, guard, find, &resolve_codex, opts, Some(cwd), PayloadRoute::ThreadStart)?;
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
    Ok(CodexHostedLaunch { payload_file, manifest, file_stamp, manifests_dir: home_dir.join("manifests"), _lock: h.lock })
}
