//! src-tauri\src\bare\flow_vault.rs — a Flow agent node loads its own Rune Vault.
//! Replaces `flow_claude.rs` and `flow_home.rs`: a node spawns on the home its vault builds, the way a
//! Rendered tab does, with no payload or MCP carry of Flow's own.
//!
//! - `approve`: the vault a node names (unset = the agent's stock vault) must exist, belong to the
//!   agent, and still hold the hash the approval bound; mode and allow entries come from
//!   `vault_spawn::node_permissions`, never re-derived.
//! - `claude_node`: the hosted Claude prepare (`admit_hosted`, then `prepare_hosted_for`) and the
//!   sidecar's Flow argv: `--flow --profile <p> --root --home [--payload] [--set-plugin].. [--mcp-file]`.
//! - `codex_node`: the in-process Codex app-server prepare; the developer instructions go on
//!   `thread/start`.
//!
//! Both lock the vault at spawn (a Flow node has no first-message hook) and write the launch record
//! with no Falcon session. Prepares serialise on `pty::BARE_PREPARE`, as every Bare prepare does.
//! Agent-free by design: the agent is a value (`agent_spec::Agent`), never a literal here.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::vault::store::Store;
use super::vault_spawn::{self, NodePerms};
use super::{home, Env, HostedLaunch, LaunchOpts};
use crate::agent_spec::{self, Agent};

/// The launch profile Flow nodes run on.
pub(crate) const PROFILE: &str = "bare";

/// `-c` override every Flow Codex node carries: network on in the workspace-write sandbox.
const NETWORK_ON: &str = "sandbox_workspace_write.network_access=true";

/// An approved node: its vault id and what that vault grants it.
#[derive(Debug)]
pub(crate) struct Approved {
    pub vault: String,
    pub perms: NodePerms,
}

/// The vault id a node loads: the one it names, else its agent's stock vault.
pub(crate) fn vault_id(agent: Agent, vault: Option<&str>) -> String {
    match vault.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => v.to_string(),
        None => format!("stock-{}", agent.as_str()),
    }
}

/// The vault a node names, checked under `root` for `agent`: unknown and another agent's stock vault
/// refuse (`node_permissions`), and so does a vault whose hash is not the one approval bound. A `None`
/// hash is accepted until the editor sends one (FV5).
pub(crate) fn approve(root: &Path, agent: Agent, vault: Option<&str>, hash: Option<&str>) -> Result<Approved, String> {
    let vault = vault_id(agent, vault);
    let perms = vault_spawn::node_permissions(root, &vault, agent)?;
    if let Some(h) = hash.map(str::trim).filter(|h| !h.is_empty()) {
        if h != perms.hash {
            return Err(format!("Vault Changed Since Approval: {vault}; Approve It Again"));
        }
    }
    Ok(Approved { vault, perms })
}

/// A warning when `agent` cannot carry some of the allow entries its vault holds (they drop for the
/// node, the node still spawns): the spec's own refusal text.
pub(crate) fn dropped_allow_warning(root: &Path, agent: Agent, vault: &str) -> Option<String> {
    let store = Store::open(&vault_spawn::store_root(root));
    let resolved = store.resolve(vault).ok()?;
    let mut all: Vec<String> = Vec::new();
    for r in resolved.runes.iter().filter(|r| !r.recall) {
        let Ok(rune) = crate::rules::rune::parse(&r.body) else { continue };
        if rune.kind != "permission" || rune.agent.as_deref().is_some_and(|a| agent_spec::parse(a) != Some(agent)) {
            continue;
        }
        for a in &rune.item.allow {
            if !all.contains(a) {
                all.push(a.clone());
            }
        }
    }
    let refused = (agent_spec::spec(agent).carries.permission)(&all, None).refused?;
    Some(format!("Vault {vault}: {refused}; dropped for this node"))
}

/// What a Flow Claude node spawns with.
#[derive(Debug)]
pub(crate) struct ClaudeNode {
    pub env: Env,
    /// The sidecar's profile-mapping argv (everything after the script path).
    pub args: Vec<String>,
    /// The vault home's Claude config dir (its `.credentials.json` is the login).
    pub config_dir: PathBuf,
    pub warnings: Vec<String>,
}

/// Production: the hosted Claude prepare for `vault` on the real Bare home, for the node `tab`.
pub(crate) fn claude_node(vault: &str, tab: &str) -> Result<ClaudeNode, String> {
    super::admit_hosted(PROFILE, None, None)?;
    let opts = LaunchOpts { vault: Some(vault), ..Default::default() };
    let _serial = crate::pty::BARE_PREPARE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let launch = super::prepare_hosted_for(PROFILE, &opts)?;
    finish_claude(launch, &crate::paths::root(), &home::resolve()?, std::env::vars_os(), vault, tab)
}

/// The sidecar env and argv for a prepared hosted launch. Writes the launch record and locks the vault.
pub(super) fn finish_claude(
    mut launch: HostedLaunch,
    root: &Path,
    home_dir: &Path,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    vault: &str,
    tab: &str,
) -> Result<ClaudeNode, String> {
    let p = super::load_profile(root, PROFILE)?;
    let config_dir = launch.claude_config_dir.clone().ok_or("The vault's Claude home was not prepared; Flow refused")?;
    let mut env = super::profile_env(&p, root, home_dir, inherited);
    super::point_env_at(&mut env, &config_dir);
    let mut args: Vec<String> = ["--flow", "--profile", PROFILE, "--root"].map(String::from).into();
    args.push(root.to_string_lossy().into_owned());
    args.push("--home".into());
    args.push(home_dir.to_string_lossy().into_owned());
    if let Some(f) = &launch.payload_file {
        args.extend(["--payload".into(), f.to_string_lossy().into_owned()]);
    }
    for name in &launch.plugin_names {
        args.extend(["--set-plugin".into(), super::plugin_dir(root, name)?.to_string_lossy().into_owned()]);
    }
    if let Some(f) = &launch.mcp_file {
        args.extend(["--mcp-file".into(), f.to_string_lossy().into_owned()]);
    }
    launch.manifest.tab = tab.to_string();
    launch.manifest.env_names = env.iter().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
    super::manifest::write_hosted(&launch.manifests_dir, &launch.file_stamp, &launch.manifest, launch.mcp_file.as_deref())?;
    vault_spawn::write_record(launch.seed.as_ref(), tab, None, Path::new(&launch.manifest.homes.claude_config))?;
    lock(root, vault)?;
    let mut warnings = launch.bare_warnings();
    warnings.dedup();
    Ok(ClaudeNode { env, args, config_dir, warnings })
}

/// What a Flow Codex node spawns with.
pub(crate) struct CodexNode {
    pub node: PathBuf,
    pub js: PathBuf,
    pub env: Env,
    /// Everything between the script and the `app-server` subcommand the Flow adapter adds back:
    /// the per-spawn `-c` overrides.
    pub args: Vec<String>,
    pub home: PathBuf,
    /// The vault's rendered runes, sent as `developerInstructions` on `thread/start`.
    pub instructions: Option<String>,
    pub warnings: Vec<String>,
}

/// Production: the in-process Codex app-server prepare for `vault` in `cwd`, for the node `tab`.
pub(crate) fn codex_node(vault: &str, tab: &str, cwd: &str, ctl_token: &str) -> Result<CodexNode, String> {
    let opts = LaunchOpts { vault: Some(vault), ..Default::default() };
    let launch = {
        let _serial = crate::pty::BARE_PREPARE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        super::prepare_codex(PROFILE, &opts, cwd)?
    };
    finish_codex(launch, &crate::paths::root(), vault, tab, ctl_token)
}

/// The spawn inputs of a prepared Codex launch. Writes the launch record, locks the vault and lets go
/// of the home lock (the launch drops here) before the caller spawns.
pub(super) fn finish_codex(mut launch: super::CodexLaunch, root: &Path, vault: &str, tab: &str, ctl_token: &str) -> Result<CodexNode, String> {
    // The vault's `vidar_drive` server forwards it (`env_vars`).
    launch.env.set("VIDAR_CTL_TOKEN", ctl_token);
    let env_names = launch.env.iter().map(|(k, _)| k.to_string_lossy().into_owned()).collect::<Vec<String>>();
    launch.write_manifest(tab, env_names.iter().map(String::as_str))?;
    lock(root, vault)?;
    let mut rest = launch.args.iter().cloned();
    let js = PathBuf::from(rest.next().ok_or("The Codex launch has no script; Flow refused")?);
    // Flow's adapter adds `app-server` itself.
    let mut dropped = false;
    let mut args = vec!["-c".to_string(), NETWORK_ON.to_string()];
    for a in rest {
        if !dropped && a == "app-server" {
            dropped = true;
            continue;
        }
        args.push(a);
    }
    let warnings = launch.warning.iter().cloned().collect();
    Ok(CodexNode {
        node: launch.program.clone(),
        js,
        env: launch.env.clone(),
        args,
        home: launch.codex_home.clone(),
        instructions: launch.developer_instructions.clone(),
        warnings,
    })
}

/// Locks `vault` at the hash it holds now: a Flow node has no first-message hook.
fn lock(root: &Path, vault: &str) -> Result<(), String> {
    let v = Store::open(&vault_spawn::store_root(root)).get(vault).map_err(|e| format!("Vault {vault}: {e}"))?;
    vault_spawn::lock_at_spawn(root, &v)
}

#[cfg(test)]
#[path = "flow_vault_tests.rs"]
mod tests;
