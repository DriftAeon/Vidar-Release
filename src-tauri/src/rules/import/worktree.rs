//! src-tauri\src\rules\import\worktree.rs — Local Files in a linked git worktree list the main checkout's
//! CLAUDE.md / AGENTS.md: the worktree copy is a snapshot at the worktree's commit, and an import's recorded
//! source goes missing when the worktree is cleaned up.

use std::path::{Path, PathBuf};

/// `(worktree root, main checkout root)` when `dir` sits in a linked worktree (its `.git` is a file reading
/// `gitdir: <main>\.git\worktrees\<name>`); `None` in an ordinary checkout or outside git.
pub fn roots(dir: &Path) -> Option<(PathBuf, PathBuf)> {
    let root = dir.ancestors().find(|a| a.join(".git").exists())?;
    let text = std::fs::read_to_string(root.join(".git")).ok()?; // a directory fails the read: not a worktree
    let gitdir = PathBuf::from(text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim().replace('/', "\\"));
    let gitdir = if gitdir.is_absolute() { gitdir } else { root.join(gitdir) };
    // `commondir` is relative to the worktree's gitdir (normally `../..`) and names the main `.git`
    let common = std::fs::read_to_string(gitdir.join("commondir")).ok()?;
    let common = gitdir.join(common.trim().replace('/', "\\"));
    let main = std::fs::canonicalize(&common).ok()?.parent()?.to_path_buf();
    let main = PathBuf::from(main.to_string_lossy().trim_start_matches(r"\\?\"));
    Some((root.to_path_buf(), main))
}

/// The same relative path in the main checkout when `path` is a CLAUDE.md or AGENTS.md under the worktree and
/// the main copy exists; otherwise `path` unchanged.
pub fn main_copy(path: &Path, worktree: &Path, main: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if name != "claude.md" && name != "agents.md" {
        return path.to_path_buf();
    }
    let norm = |p: &Path| p.to_string_lossy().replace('/', "\\");
    let (full, base) = (norm(path), norm(worktree));
    let base = base.trim_end_matches('\\');
    if full.len() <= base.len() || !full.to_lowercase().starts_with(&base.to_lowercase()) || !full[base.len()..].starts_with('\\') {
        return path.to_path_buf();
    }
    let candidate = main.join(full[base.len() + 1..].to_string());
    if candidate.is_file() { candidate } else { path.to_path_buf() }
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let mut c = Command::new("git");
        c.current_dir(dir).args(args);
        for (k, _) in std::env::vars() {
            if k.starts_with("GIT_") {
                c.env_remove(k);
            }
        }
        let out = c.output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    #[test]
    fn a_linked_worktree_lists_the_main_checkouts_rules_file() {
        let root = std::env::temp_dir().join(format!("vidar-wt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (main, wt) = (root.join("main"), root.join("main").join("linked").join("wt1"));
        std::fs::create_dir_all(&main).unwrap();
        git(&main, &["init", "-q"]);
        std::fs::write(main.join("AGENTS.md"), "main\n").unwrap();
        std::fs::write(main.join(".gitignore"), "linked/\n").unwrap();
        git(&main, &["add", "."]);
        git(&main, &["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "x"]);
        git(&main, &["worktree", "add", "-q", wt.to_str().unwrap()]);
        std::fs::write(wt.join("CLAUDE.md"), "only in the worktree\n").unwrap();

        let canon = |p: &Path| std::fs::canonicalize(p).unwrap().to_string_lossy().trim_start_matches(r"\\?\").to_lowercase();
        let (wroot, mroot) = roots(&wt).expect("worktree detected");
        assert_eq!(canon(&mroot), canon(&main));
        assert!(roots(&main).is_none(), "an ordinary checkout is not a worktree");
        let listed = main_copy(&wroot.join("AGENTS.md"), &wroot, &mroot);
        assert_eq!(canon(&listed), canon(&main.join("AGENTS.md")));
        // the main checkout has no CLAUDE.md: the worktree copy stays
        assert_eq!(main_copy(&wroot.join("CLAUDE.md"), &wroot, &mroot), wroot.join("CLAUDE.md"));
        // other files are not remapped
        assert_eq!(main_copy(&wroot.join("x.md"), &wroot, &mroot), wroot.join("x.md"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
