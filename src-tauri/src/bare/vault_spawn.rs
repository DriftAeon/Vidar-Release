//! src-tauri\src\bare\vault_spawn.rs — the Rune Vault glue every Bare launch path shares (run
//! 2026-10-25-rune-vault, L2a; model R2, R4): the spawn's vault resolved into a loadout, the session
//! record each manifest write adds, and the Raw lock at spawn. New file for the mod.rs size cap.

use std::path::{Path, PathBuf};

use super::agent_homes::Agent;
use super::set_loadout::{self, ResolveEnv, VaultLoadout};
use super::vault::session::{self, VaultPin};
use super::vault::store::Store;
use super::vault::{LockedBy, Vault};

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
pub(super) fn resolve(env: &ResolveEnv, agent: Agent, root: &Path, v: Option<&Vault>) -> Result<VaultLoadout, String> {
    match v {
        Some(v) => set_loadout::resolve_vault(env, agent, &Store::open(&store_root(root)), v),
        None => {
            let (loadout, _) = set_loadout::resolve(env, agent, &[]);
            Ok(VaultLoadout { loadout, warnings: Vec::new(), text: None, sets: Vec::new() })
        }
    }
}

/// Raw bodies lock at spawn (model: Raw has no first-message hook): `Store::lock(id, FirstMessage, hash)`.
/// A vault already locked at this hash stands; another hash refuses the spawn.
pub(super) fn lock_at_spawn(root: &Path, v: &Vault) -> Result<(), String> {
    Store::open(&store_root(root)).lock(&v.id, LockedBy::FirstMessage, &v.hash).map(|_| ()).map_err(|e| format!("{e}; Bare spawn refused"))
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
