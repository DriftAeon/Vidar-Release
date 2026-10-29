//! One concern: Codex never starts with the user profile (or a parent of it) as its workspace.
//! Codex's Windows sandbox turns a profile-root workspace into a write grant on every child of
//! `~` (`.claude` and AppData among them) and never revokes it. Every Codex spawn path calls
//! `refuse_home_cwd`: `agent.rs spawn_codex_appserver` and the Codex launches in `pty.rs spawn_pty`
//! (a profiled Raw Codex Bare tab sends no shell or args, so `is_codex_launch` cannot see it:
//! `pty.rs codex_bare_prepare` calls `refuse_home_cwd` itself, before the prepare trusts the folder).

use std::path::Path;

/// The refusal shown in the tab or launcher toast.
pub const HOME_CWD_REFUSED: &str = "Codex Can't Start in Your Home Folder: Pick a Project Folder";

/// Err when `cwd` is the resolved user profile or any parent of it. No profile, no refusal.
pub fn refuse_home_cwd(cwd: &Path) -> Result<(), String> {
    match crate::paths::home() {
        Some(home) if is_home_or_parent(cwd, &home) => Err(HOME_CWD_REFUSED.to_string()),
        _ => Ok(()),
    }
}

/// For the launcher: whether Codex would refuse `cwd` (the Home row dims on it).
#[tauri::command]
pub fn codex_cwd_refused(cwd: String) -> bool {
    refuse_home_cwd(Path::new(&cwd)).is_err()
}

/// `spawn_pty`'s one-line call: a Codex launch is checked against the folder it will really start
/// in (`dir`, else Vidar's own cwd, which the child inherits); any other launch passes.
pub fn refuse_home_pty(shell: Option<&str>, args: Option<&[String]>, dir: Option<&Path>) -> Result<(), String> {
    if !is_codex_launch(shell, args) {
        return Ok(());
    }
    match dir.map(Path::to_path_buf).or_else(|| std::env::current_dir().ok()) {
        Some(d) => refuse_home_cwd(&d),
        None => Ok(()),
    }
}

/// Lexical check (case-insensitive, `/` and `\` alike, `.`/`..` folded, `\\?\` dropped), then the
/// canonical forms when both resolve, so a junction or 8.3 name onto the profile is caught too.
fn is_home_or_parent(cwd: &Path, home: &Path) -> bool {
    if is_prefix(&segments(cwd), &segments(home)) {
        return true;
    }
    match (std::fs::canonicalize(cwd), std::fs::canonicalize(home)) {
        (Ok(c), Ok(h)) => is_prefix(&segments(&c), &segments(&h)),
        _ => false,
    }
}

fn is_prefix(cwd: &[String], home: &[String]) -> bool {
    cwd.len() <= home.len() && cwd.iter().zip(home).all(|(a, b)| a == b)
}

fn segments(p: &Path) -> Vec<String> {
    let s = p.to_string_lossy().replace('/', "\\");
    let s = s.strip_prefix("\\\\?\\UNC\\").map(|r| format!("\\\\{r}")).unwrap_or(s);
    let s = s.strip_prefix("\\\\?\\").map(str::to_string).unwrap_or(s);
    let mut out: Vec<String> = Vec::new();
    for part in s.split('\\') {
        match part {
            "" | "." => {}
            ".." => {
                // Never pop the drive: `C:\..` is still `C:\`.
                if out.len() > 1 {
                    out.pop();
                }
            }
            p => out.push(p.to_lowercase()),
        }
    }
    out
}

/// Whether a PTY launch runs Codex: the shell itself is `codex`, or an argument's first command
/// word is (`-Command "codex -a never ..."`, `& codex`, `codex.cmd resume <id>`).
pub fn is_codex_launch(shell: Option<&str>, args: Option<&[String]>) -> bool {
    shell.is_some_and(names_codex)
        || args.unwrap_or_default().iter().any(|a| {
            let a = a.trim_start().trim_start_matches('&').trim_start();
            a.split_whitespace().next().is_some_and(names_codex)
        })
}

fn names_codex(word: &str) -> bool {
    let word = word.trim_matches(|c| c == '"' || c == '\'');
    let leaf = word.rsplit(['\\', '/']).next().unwrap_or(word).to_ascii_lowercase();
    matches!(leaf.as_str(), "codex" | "codex.exe" | "codex.cmd" | "codex.ps1")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // Synthetic paths only: none of these exist, so the canonical branch never runs.
    fn home() -> PathBuf {
        PathBuf::from(r"Q:\Profiles\someone")
    }

    fn refused(cwd: &str) -> bool {
        is_home_or_parent(Path::new(cwd), &home())
    }

    #[test]
    fn the_profile_itself_is_refused_in_any_case_or_separator() {
        for cwd in [
            r"Q:\Profiles\someone",
            r"Q:\Profiles\someone\",
            r"q:\profiles\SOMEONE",
            "Q:/Profiles/someone",
            "Q:/Profiles/someone/",
            r"Q:\\Profiles\\someone",
            r"\\?\Q:\Profiles\someone",
            r"Q:\Profiles\someone\.",
            r"Q:\Profiles\someone\proj\..",
        ] {
            assert!(refused(cwd), "{cwd} should be refused");
        }
    }

    #[test]
    fn a_parent_of_the_profile_is_refused() {
        for cwd in [r"Q:\Profiles", "q:/profiles/", r"Q:\", "Q:", r"Q:\..\Profiles"] {
            assert!(refused(cwd), "{cwd} should be refused");
        }
    }

    #[test]
    fn a_child_or_sibling_of_the_profile_is_allowed() {
        for cwd in [
            r"Q:\Profiles\someone\proj",
            "q:/profiles/someone/proj/sub",
            r"Q:\Profiles\someone-else",
            r"Q:\Profiles\some",
            r"R:\Profiles\someone",
            r"Q:\Work\repo",
        ] {
            assert!(!refused(cwd), "{cwd} should be allowed");
        }
    }

    #[test]
    fn the_command_refuses_the_resolved_home_and_its_parent_but_not_a_child() {
        let Some(home) = crate::paths::home() else { return };
        assert!(codex_cwd_refused(home.to_string_lossy().into_owned()));
        if let Some(parent) = home.parent() {
            assert!(codex_cwd_refused(parent.to_string_lossy().into_owned()));
        }
        assert!(!codex_cwd_refused(home.join("some-project-folder").to_string_lossy().into_owned()));
    }

    #[test]
    fn codex_launches_are_recognised_by_shell_or_first_command_word() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let yes = [
            (None, args(&["-NoExit", "-Command", "codex"])),
            (None, args(&["-NoExit", "-Command", "codex -a never -s workspace-write"])),
            (None, args(&["-NoExit", "-Command", "codex resume 0199aaaa"])),
            (None, args(&["-Command", "& 'Q:\\npm\\codex.cmd' -a never"])),
            (Some("codex"), args(&[])),
            (Some("Q:\\npm\\codex.exe"), args(&[])),
        ];
        for (shell, a) in &yes {
            assert!(is_codex_launch(*shell, Some(a)), "{shell:?} {a:?} should be Codex");
        }
        let no = [
            (None, args(&["-NoExit", "-Command", "claude"])),
            (None, args(&["-NoExit", "-Command", "claude --resume 0199aaaa"])),
            (None, args(&["-NoExit", "-Command", "echo codex"])),
            (Some("pwsh.exe"), args(&[])),
            (Some("codexify"), args(&[])),
        ];
        for (shell, a) in &no {
            assert!(!is_codex_launch(*shell, Some(a)), "{shell:?} {a:?} should not be Codex");
        }
        assert!(!is_codex_launch(None, None));
    }
}
