//! src-tauri\src\bare\vault_spawn.rs — the Rune Vault glue every Bare launch path shares: the spawn's vault resolved into a loadout, the session
//! record each manifest write adds, and the Raw lock at spawn. New file for the mod.rs size cap.

use std::path::{Path, PathBuf};

use super::agent_homes::Agent;
use super::set_loadout::{self, ResolveEnv, VaultLoadout};
use super::vault::session::{self, VaultPin};
use super::vault::store::Store;
use super::vault::{LockedBy, Vault};
use crate::rules::rune::Surface;

/// The folder the vault store, its libraries and the session records resolve under: the spawn's root.
/// Tests that spawn on the checkout's root (for its profiles) point the store at a temp dir through
/// `TEST_VAULT_ROOT`, so no test writes the checkout's vaults folder (`paths::rune_vaults_dir_in`).
pub(super) fn store_root(root: &Path) -> PathBuf {
    #[cfg(test)]
    if let Some(r) = TEST_VAULT_ROOT.with(|t| t.borrow().clone()) {
        return r;
    }
    root.to_path_buf()
}
#[cfg(test)]
thread_local! {
    pub(super) static TEST_VAULT_ROOT: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// The spawn's loadout: vault `v` resolved (`set_loadout::resolve_vault`). `None` is the test-only
/// no-vault spawn (`launch_row::TEST_NO_VAULT`), an empty loadout on the profile's own home.
pub(super) fn resolve(env: &ResolveEnv, agent: Agent, surface: Option<Surface>, root: &Path, v: Option<&Vault>) -> Result<VaultLoadout, String> {
    match v {
        Some(v) => set_loadout::resolve_vault(env, agent, surface, &Store::open(&store_root(root)), v),
        None => {
            let (mut loadout, _) = set_loadout::resolve(env, agent, &[]);
            // No vault, no setting rune to place: the shipped one stands in.
            loadout.setting = shipped_setting(root, agent);
            loadout.hash = set_loadout::hash_of(&loadout);
            Ok(VaultLoadout { loadout, warnings: Vec::new(), text: None, sets: Vec::new() })
        }
    }
}

/// The loadout's setting file for `agent`, expanded and checked for every key the agent needs
/// (`AgentSpec.setting_keys`); a loadout with no setting rune, or a file missing a key, refuses the spawn.
pub(super) fn setting_file(loadout: &set_loadout::Loadout, agent: Agent, root: &Path) -> Result<PathBuf, String> {
    let spec = crate::agent_spec::spec(agent);
    let s = loadout.setting.as_ref().ok_or_else(|| format!("Rune Vault carries no {} setting rune; Bare spawn refused", spec.label))?;
    let path = super::rune_items::expand_path(&s.source, &super::rune_items::MapEnv { root, user_home: None }).map_err(|e| format!("Setting rune `{}`: {e}; spawn refused", s.id))?;
    (spec.check_setting)(&s.id, &path, spec.setting_keys)?;
    Ok(path)
}

/// The Vidar library's setting rune for `agent`, as a vault places it (`claude-settings`, `codex-config`).
fn shipped_setting(root: &Path, agent: Agent) -> Option<set_loadout::SettingRef> {
    let lib = crate::rules::library::Library::open(&crate::paths::rune_vidar_dir_in(root)).ok()?;
    lib.all_runes().0.into_iter().find(|(r, _)| r.kind == "setting" && r.fits(Some(agent), None)).and_then(|(r, _)| Some(set_loadout::SettingRef { id: r.id, source: r.item.source? }))
}

/// Raw bodies lock at spawn (model: Raw has no first-message hook): `Store::lock(id, FirstMessage, hash)`.
/// A vault already locked at this hash stands; another hash refuses the spawn.
pub(super) fn lock_at_spawn(root: &Path, v: &Vault) -> Result<(), String> {
    Store::open(&store_root(root)).lock(&v.id, LockedBy::FirstMessage, &v.hash).map(|_| ()).map_err(|e| format!("{e}; Bare spawn refused"))
}

/// A permission rune's `mode:` header, unless the rune names another agent than `agent`, or `agent`
/// carries no permission mode (the spec's `permission` fn refuses one).
pub(crate) fn rune_mode(body: &str, agent: Agent) -> Option<String> {
    use super::vault::store::header_value;
    if header_value(body, "kind").as_deref() != Some("permission") {
        return None;
    }
    if !crate::rules::rune::parse(body).ok()?.fits(Some(agent), None) {
        return None;
    }
    let mode = header_value(body, "mode").filter(|m| !m.is_empty())?;
    (crate::agent_spec::spec(agent).carries.permission)(&[], Some(&mode)).refused.is_none().then_some(mode)
}

/// D-c: the `mode` of vault `id`'s first `agent` permission rune, if it has one.
pub(crate) fn vault_mode(root: &Path, id: &str, agent: Agent) -> Option<String> {
    let resolved = Store::open(&store_root(root)).resolve(id).ok()?;
    resolved.runes.iter().find_map(|r| rune_mode(&r.body, agent))
}

/// What a vault gives one Flow node's permissions: its raw mode rune (the caller limits it to the
/// modes a node can act in), the exact allow entries the agent carries, and the vault hash the
/// approval binds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NodePerms {
    pub mode: Option<String>,
    pub allow: Vec<String>,
    pub hash: String,
}

/// Vault `vault` as `agent` reads it for one node: refuses an unknown id. The mode and allow come from
/// the vault's permission runes only (none → no mode).
pub(crate) fn node_permissions(root: &Path, vault: &str, agent: Agent) -> Result<NodePerms, String> {
    let store = Store::open(&store_root(root));
    let v = store.get(vault).map_err(|_| format!("Unknown Vault: {vault}"))?;
    let resolved = store.resolve(vault).map_err(|e| format!("Vault {vault}: {e}"))?;
    let mut allow: Vec<String> = Vec::new();
    for r in resolved.runes.iter().filter(|r| !r.recall) {
        let Ok(rune) = crate::rules::rune::parse(&r.body) else { continue };
        if rune.kind != "permission" || !rune.fits(Some(agent), None) {
            continue;
        }
        for a in &rune.item.allow {
            if !allow.contains(a) {
                allow.push(a.clone());
            }
        }
    }
    let allow = (crate::agent_spec::spec(agent).carries.permission)(&allow, None).kept;
    Ok(NodePerms { mode: vault_mode(root, vault, agent), allow, hash: v.hash })
}

/// What a launch knows before its tab exists; `write` adds the tab, the Falcon session and the home
/// once the manifest is written. One record per manifest write (model R4).
pub(crate) struct SessionSeed {
    root: PathBuf,
    agent: &'static str,
    body: &'static str,
    pin: VaultPin,
    loadout_hash: String,
}

impl SessionSeed {
    pub(super) fn new(root: &Path, agent: Agent, body: &'static str, v: Option<&Vault>, loadout_hash: &str) -> Option<SessionSeed> {
        let v = v?;
        Some(SessionSeed { root: store_root(root), agent: agent.as_str(), body, pin: VaultPin { id: v.id.clone(), hash: v.hash.clone() }, loadout_hash: loadout_hash.to_string() })
    }

    /// Writes the session record; an error refuses the spawn as a manifest error does.
    pub(super) fn write(&self, tab: &str, falcon_session: Option<&str>, home: &Path) -> Result<PathBuf, String> {
        let mut r = session::record(self.agent, self.body, tab, self.pin.clone(), &home.to_string_lossy(), &self.loadout_hash);
        r.falcon_session = falcon_session.map(str::to_string);
        session::write(&self.root, &r).map_err(|e| format!("Session record: {e}; Bare spawn refused"))
    }
}

/// Writes `seed`'s record when the launch has a vault.
pub(super) fn write_record(seed: Option<&SessionSeed>, tab: &str, falcon_session: Option<&str>, home: &Path) -> Result<(), String> {
    match seed {
        Some(s) => s.write(tab, falcon_session, home).map(|_| ()),
        None => Ok(()),
    }
}
