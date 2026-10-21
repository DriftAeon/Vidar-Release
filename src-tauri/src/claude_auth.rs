//! Whether the installed Claude Code is logged in.
//!
//! Source: `claude auth status --json` (Claude Code 2.1.x). Logged in it exits 0 with
//! `{"loggedIn": true, "authMethod": "claude.ai", …}`; with no credentials it exits 1 with
//! `{"loggedIn": false, "authMethod": "none", …}` (both printed 2026-10-09 on 2.1.295, the second
//! against an empty `CLAUDE_CONFIG_DIR`). Only `loggedIn` is read: the rest carries the account's
//! email and org, which never leave this file.
//!
//! Two callers: the Dependencies probe (`deps.rs`, the `claude` row's `warning`) and the
//! `claude_auth_status` command a Claude Rendered tab invokes on each spawn. No cache: a login in a
//! terminal must show on the next check. Bounded like the version probe; unreadable is `None`.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::deps::run_bounded_any;

/// One check took ~210 ms; the bound only stops a hung CLI from holding a detect run.
const AUTH_TIMEOUT: Duration = Duration::from_secs(5);

/// The Dependencies row's warning; the Rendered tab shows the same words (src\panels\rendered\state-chip.ts).
const NOT_LOGGED_IN: &str = "Not Logged In";

/// `Some(loggedIn)`; `None` when stdout is not that JSON (a CLI without `auth status`, a crash).
fn parse_status(stdout: &str) -> Option<bool> {
    serde_json::from_str::<serde_json::Value>(stdout).ok()?.get("loggedIn")?.as_bool()
}

fn logged_in(program: &OsStr) -> Option<bool> {
    let (_exit_ok, stdout) = run_bounded_any(program, &["auth", "status", "--json"], AUTH_TIMEOUT)?;
    parse_status(&stdout)
}

/// The Dependencies warning for a found claude exe: set only on a definite "logged out".
pub(crate) fn login_warning(program: &OsStr) -> Option<String> {
    (logged_in(program) == Some(false)).then(|| NOT_LOGGED_IN.to_string())
}

/// Same resolution as the flow runner (`flow/env.rs` `resolve_executables`): the claude pack's
/// dep probe, `.exe` names on PATH then `.exe` candidates (`deps::claude_exe`).
fn claude_exe() -> Option<PathBuf> {
    crate::deps::claude_exe()
}

/// `Some(false)` = logged out, `Some(true)` = logged in, `None` = unknown (no claude, odd output).
#[tauri::command]
pub async fn claude_auth_status() -> Option<bool> {
    tauri::async_runtime::spawn_blocking(|| logged_in(claude_exe()?.as_os_str()))
        .await
        .ok()
        .flatten()
}

/// `claude auth status --json` against an explicit config dir. A Bare tab's own shell cannot answer
/// this (the subprocess env scrub drops `CLAUDE_CONFIG_DIR`, so a nested claude reads the user's
/// home), and Vidar's own `USERPROFILE` is the real one: the dir is always passed, never inherited.
fn logged_in_in(program: &OsStr, config_dir: &Path) -> Option<bool> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Instant;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let deadline = Instant::now() + AUTH_TIMEOUT;
    let mut child = Command::new(program)
        .args(["auth", "status", "--json"])
        .env("CLAUDE_CONFIG_DIR", config_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let buf = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).ok()?;
    parse_status(&String::from_utf8_lossy(&buf))
}

/// The Bare home's login state: `Some(false)` = logged out, `None` = unknown. The Dependencies page
/// shows it only while a Bare row is enabled; the default `claude` row keeps `claude_auth_status`.
#[tauri::command]
pub async fn claude_auth_status_bare() -> Option<bool> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = crate::bare::claude_dir::claude_dir_for(Some("bare"))?;
        // A home that was never created is "not logged in", not unknown, but creating it is the
        // launch's job (private ACL): report unknown and let the first Bare launch make it.
        dir.is_dir().then_some(())?;
        logged_in_in(claude_exe()?.as_os_str(), &dir)
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::parse_status;

    #[test]
    fn reads_logged_in_and_logged_out() {
        assert_eq!(parse_status("{\n  \"loggedIn\": true,\n  \"authMethod\": \"claude.ai\"\n}\n"), Some(true));
        assert_eq!(parse_status("{\"loggedIn\": false, \"authMethod\": \"none\"}"), Some(false));
    }

    /// The `--text` form and an old CLI's usage error must read as unknown, never as logged out.
    #[test]
    fn anything_else_is_unknown() {
        assert_eq!(parse_status("Not logged in. Run claude auth login to authenticate.\n"), None);
        assert_eq!(parse_status(""), None);
        assert_eq!(parse_status("{\"loggedIn\": \"no\"}"), None);
    }
}
