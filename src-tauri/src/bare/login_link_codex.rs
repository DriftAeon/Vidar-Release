//! src-tauri\src\bare\login_link_codex.rs — Codex's half of the shared-login sync: its prepare call
//! site. Moved from login_link.rs.

use std::path::Path;

use super::home::HomeLock;
use crate::agent_spec::Agent;

/// The Codex prepare call site: `<codex_home>\auth.json` synced like Claude's login, when
/// `codex_home` sits under `home` (any other `CODEX_HOME`, or a home outside `…\Vidar\homes`,
/// shares nothing). `home_dirs` is the Codex profile's.
pub fn sync_codex(home: &Path, codex_home: &Path, home_dirs: &[String], lock: &HomeLock) -> Result<Vec<String>, String> {
    super::login_link::sync_dir(home, codex_home, Agent::Codex, home_dirs, lock)
}
