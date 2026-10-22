//! One concern: the refused-Vidar-folder card's Open in Worktree. `vidar_worktree_open` makes a git
//! worktree of Vidar's own checkout at HEAD under `<runtime>\worktrees\codex-<stamp>` (a folder
//! `bare::refuse_vidar_cwd` lets Codex use) and returns its absolute path. Uncommitted changes stay
//! in the checkout.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::gitrun::{git, GitOpts};

/// `codex-<YYYYMMDD-HHMMSS>` from local time parts.
fn worktree_name(y: u16, mo: u16, d: u16, h: u16, mi: u16, s: u16) -> String {
    format!("codex-{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}")
}

/// The branch and the folder (under `runtime_dir` inside `root`) for worktree `name`.
fn worktree_plan(root: &Path, runtime_dir: &Path, name: &str) -> (String, PathBuf) {
    (format!("codex/{name}"), root.join(runtime_dir).join("worktrees").join(name))
}

/// The git arguments for the add, the branch and the folder in the order git takes them.
fn worktree_args(branch: &str, dir: &str) -> Vec<String> {
    ["worktree", "add", "-b", branch, dir, "HEAD"].iter().map(|s| s.to_string()).collect()
}

fn local_name() -> String {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    // SAFETY: GetLocalTime only fills the returned SYSTEMTIME.
    let t = unsafe { GetLocalTime() };
    worktree_name(t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
}

fn open_at(root: &Path, name: &str) -> Result<String, String> {
    let runtime_dir = crate::paths::rel("bridge").parent().map(Path::to_path_buf).unwrap_or_default();
    let (branch, dir) = worktree_plan(root, &runtime_dir, name);
    let dir_s = dir.to_string_lossy().into_owned();
    let args = worktree_args(&branch, &dir_s);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    git(root, &refs, &GitOpts::read(Duration::from_secs(60), 64 * 1024))?;
    Ok(dir_s)
}

/// Makes the worktree and returns its folder; on failure the trimmed git stderr.
#[tauri::command]
pub async fn vidar_worktree_open() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| open_at(&crate::paths::root(), &local_name()))
        .await
        .map_err(|e| format!("worktree task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_is_codex_with_a_local_stamp() {
        assert_eq!(worktree_name(2026, 10, 2, 3, 4, 5), "codex-20261002-030405");
    }

    #[test]
    fn plan_and_args_put_the_worktree_under_runtime() {
        let root = Path::new(r"C:\work\Checkout");
        let rt = crate::paths::rel("bridge").parent().unwrap().to_path_buf();
        let (branch, dir) = worktree_plan(root, &rt, "codex-20261002-030405");
        assert_eq!(branch, "codex/codex-20261002-030405");
        assert_eq!(dir, root.join(&rt).join("worktrees").join("codex-20261002-030405"));
        assert_eq!(
            worktree_args(&branch, r"C:\x"),
            ["worktree", "add", "-b", "codex/codex-20261002-030405", r"C:\x", "HEAD"]
        );
    }
}
