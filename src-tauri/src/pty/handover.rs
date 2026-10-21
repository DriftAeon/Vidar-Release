/* ---- adopt ----
   Moves an external Claude session into a Vidar tab: the hosting shell tree is
   killed so the tab can resume the session. The other direction is Jettison
   (a Falcon-hosted session detaches and waits in the launcher's Falcon row). */

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::{kill, PtyManager};

fn is_uuid(s: &str) -> bool {
    s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptResult {
    /// where to spawn the resuming tab: the session's START cwd (transcript key)
    cwd: String,
    session_id: String,
}

/// Kill an external Claude's hosting shell tree, so the
/// frontend can open a tab that resumes the session. Everything is re-derived
/// here from the registry and the live process table — the frontend's pid and
/// session id are only a claim to be checked. Nothing is killed unless every
/// guard passes; never two processes on one session id, which is why the kill
/// blocks before this returns Ok.
/// Async on the blocking pool: the snapshot and taskkill must not run on the UI thread.
#[tauri::command]
pub async fn adopt_session(app: AppHandle, pid: u32, session_id: String) -> Result<AdoptResult, String> {
    tauri::async_runtime::spawn_blocking(move || adopt_blocking(&app.state::<PtyManager>(), pid, session_id))
        .await
        .map_err(|e| format!("adopt task failed: {e}"))?
}

fn adopt_blocking(state: &PtyManager, pid: u32, session_id: String) -> Result<AdoptResult, String> {
    if !is_uuid(&session_id) {
        return Err("session id is not a UUID".into());
    }
    let map = crate::procs::snapshot();
    let r = crate::status::resolve(pid, &map)?;
    if r.entry.session_id != session_id {
        return Err("registry session id changed — reopen the list".into());
    }
    if r.inside_vidar {
        return Err("that session is already inside Vidar".into());
    }
    if !crate::status::is_shell(&r.shell_exe) {
        return Err(format!("hosted by {} — not adoptable", r.host.trim_end_matches(".exe")));
    }
    if r.entry.status == "busy" {
        return Err("session is busy — wait for it to go idle".into());
    }
    // the shell must not be one of our own ptys (belt and braces over inside_vidar)
    let ours = state
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .filter_map(kill::Slot::live)
        .any(|s| s.child.process_id() == Some(r.shell_pid));
    if ours || r.shell_pid == std::process::id() {
        return Err("refusing to kill a Vidar process".into());
    }
    // The parent must predate the child, or the parent pid was reused and the
    // real shell is gone — killing whatever now holds that pid would be wrong.
    match (crate::procs::creation_time(r.shell_pid), crate::procs::creation_time(pid)) {
        (Some(shell_t), Some(claude_t)) if shell_t <= claude_t => {}
        _ => return Err("hosting shell is gone or was replaced".into()),
    }

    // Kill the shell too: -NoExit profiles would otherwise leave a bare prompt.
    // Record and verify the shell and all identified, non-spared descendants;
    // Claude's exit alone cannot prove its siblings are gone. Snapshot races
    // remain in the Falcon-sparing path (kill.rs), and all waits are bounded.
    kill::kill_tree_sparing_falcon(r.shell_pid, kill::KILL_TIMEOUT)?;
    Ok(AdoptResult { cwd: r.entry.cwd, session_id })
}
