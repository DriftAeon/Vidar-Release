//! src-tauri\src\bare\login_link_claude.rs — Claude's half of the shared-login sync: its prepare call
//! site and the shape of its credentials key. Moved from login_link.rs so the shared sync names no agent.

use std::path::Path;

use super::home::HomeLock;
use crate::agent_spec::Agent;

/// Claude's agent name, for the sweep's record-file reader (`login_link_sweep.rs`).
pub(super) const AGENT: &str = Agent::Claude.as_str();

/// The Claude prepare call site (fold W2 L2a): `<dir>\.credentials.json` synced to the one shared
/// Claude login, for the profile's own config dir and every set-combination home alike (the
/// store is per file name, so each home links the same `_shared\claude\.credentials.json`).
/// `dir` outside `home` shares nothing; `home_dirs` must hold `dir`'s folder.
pub fn sync_claude(home: &Path, dir: &Path, home_dirs: &[String], lock: &HomeLock) -> Result<Vec<String>, String> {
    super::login_link::sync_dir(home, dir, Agent::Claude, home_dirs, lock)
}

/// Drops Claude's login record (its share is gone).
pub(super) fn clear_login(home: &Path) -> Result<(), String> {
    super::login_link::clear_record(home, AGENT)
}

/// Whether a record key is a Claude credentials file, the one login whose expiry decides a split.
pub(super) fn is_credentials_key(key: &str) -> bool {
    key.starts_with("claude/") && key.ends_with("/.credentials.json")
}
