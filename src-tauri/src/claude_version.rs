//! The installed Claude Code version, read once per app run.
//!
//! `falcon-build.ps1` copies a pinned claude.exe into each Falcon bundle and the
//! native installer self-updates, so a hosted tab can run an older Claude than
//! the one on PATH. The Rendered panel compares the tab's reported
//! `claude_code_version` against this and names `falcon-refresh.ps1` when the
//! bundle is behind. It never refreshes anything itself.
//!
//! Source: `claude --version` from PATH (prints `2.1.282 (Claude Code)`), the
//! spawned through `deps::run_bounded` (no console, killed after 3 s). Cached in a `OnceLock`; a
//! failed read caches `None` too, so a missing claude costs one spawn per run.

use std::ffi::OsStr;
use std::sync::OnceLock;

use crate::deps::{run_bounded, VERSION_TIMEOUT};

static INSTALLED: OnceLock<Option<String>> = OnceLock::new();

/// First whitespace-separated token when it looks like a dotted version.
fn parse_version(stdout: &str) -> Option<String> {
    let token = stdout.split_whitespace().next()?;
    let ok = token.split('.').count() >= 2
        && token.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    ok.then(|| token.to_string())
}

/// Bounded like the deps probe: a hung `claude --version` caches `None` instead of pinning the
/// `OnceLock` initialiser (and every later caller) forever.
fn read_installed() -> Option<String> {
    let stdout = run_bounded(OsStr::new("claude"), &["--version"], VERSION_TIMEOUT)?;
    parse_version(&stdout)
}

/// `None` when claude is not on PATH or prints something unexpected; the
/// panel then shows no chip.
#[tauri::command]
pub async fn claude_installed_version() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| INSTALLED.get_or_init(read_installed).clone())
        .await
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::parse_version;

    #[test]
    fn parses_the_cli_line() {
        assert_eq!(parse_version("2.1.282 (Claude Code)\n").as_deref(), Some("2.1.282"));
    }

    #[test]
    fn rejects_non_versions() {
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("error: unknown"), None);
        assert_eq!(parse_version("2..1"), None);
    }
}
