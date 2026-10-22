//! Whether the user's own Codex config trusts a launch folder. Vidar's generated Bare config writes a
//! `[projects]` trust entry only for a folder that passes here, so Bare never trusts a folder the
//! user did not (a trusted folder loads its `.codex` config, hooks and exec policies).

use std::path::{Path, PathBuf};

use super::home::norm_cwd;

/// The user's Codex config: `%CODEX_HOME%\config.toml`, else `~\.codex\config.toml`.
#[cfg_attr(test, allow(dead_code))]
fn user_config_path() -> Option<PathBuf> {
    let home = std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).or_else(|| {
        let up = std::env::var_os("USERPROFILE").filter(|v| !v.is_empty())?;
        Some(PathBuf::from(up).join(".codex"))
    })?;
    Some(home.join("config.toml"))
}

/// True when the user's Codex config trusts `cwd`, its git root, or (for a worktree) the main repo.
/// A missing or unreadable config, or one that does not parse, trusts nothing.
#[cfg_attr(test, allow(dead_code))]
pub(super) fn user_trusts(cwd: &str) -> bool {
    user_config_path().is_some_and(|p| config_trusts(&p, cwd))
}

/// `user_trusts` against an explicit config file.
pub(super) fn config_trusts(config: &Path, cwd: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(config) else { return false };
    let Ok(doc) = crate::fsx::strip_bom(&text).parse::<toml::Table>() else { return false };
    let Some(projects) = doc.get("projects").and_then(|p| p.as_table()) else { return false };
    let trusted: Vec<String> = projects
        .iter()
        .filter(|(_, v)| v.get("trust_level").and_then(|t| t.as_str()) == Some("trusted"))
        .map(|(k, _)| norm_cwd(k))
        .collect();
    candidates(cwd).iter().any(|c| trusted.contains(&norm_cwd(c)))
}

/// The folders whose trust covers `cwd`: itself, its git root, and the main repo root when the git
/// root is a worktree (`.git` is a file naming a `gitdir`, whose `commondir` is the main `.git`).
fn candidates(cwd: &str) -> Vec<String> {
    let Some(cwd) = plain_absolute(cwd) else { return Vec::new() };
    let mut out = vec![cwd.clone()];
    let start = PathBuf::from(&cwd);
    let Some(root) = start.ancestors().find(|a| a.join(".git").exists()) else { return out };
    out.push(root.to_string_lossy().into_owned());
    let dot_git = root.join(".git");
    if dot_git.is_file() {
        if let Some(main) = main_repo_root(&dot_git) {
            out.push(main.to_string_lossy().into_owned());
        }
    }
    out
}

/// `cwd` as a plain drive-absolute path, or `None`: a relative path, a UNC or device path
/// (`\\server\share`, `\\?\UNC\...`) and any path with a `.` or `..` component are untrusted, so the
/// ancestor walk and the trust key never come from a path that lexically hides another folder.
fn plain_absolute(cwd: &str) -> Option<String> {
    let p = cwd.trim().replace('/', "\\");
    let p = p.strip_prefix(r"\\?\").unwrap_or(&p);
    let b = p.as_bytes();
    if b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' || b[2] != b'\\' {
        return None;
    }
    let tail = &p[3..];
    if tail.split('\\').any(|c| c == "." || c == "..") {
        return None;
    }
    Some(p.to_string())
}

/// Resolved path as plain text, `\\?\` dropped.
fn resolved(p: &Path) -> Option<String> {
    let c = std::fs::canonicalize(p).ok()?;
    Some(norm_cwd(&c.to_string_lossy()))
}

/// The main repo root when `dot_git` (a file) is a genuine worktree link: its gitdir is
/// `<X>\.git\worktrees\<name>`, that folder's `gitdir` file points back at this `dot_git`, and its
/// `commondir` is `<X>\.git`. A forged `.git` cannot write into the trusted repo's `.git`, so the
/// back-pointer is what it cannot fake.
fn main_repo_root(dot_git: &Path) -> Option<PathBuf> {
    let root = dot_git.parent()?;
    let text = std::fs::read_to_string(dot_git).ok()?;
    let gitdir = text.lines().find_map(|l| l.trim().strip_prefix("gitdir:"))?.trim();
    let gitdir = std::fs::canonicalize(root.join(gitdir)).ok()?;
    let worktrees = gitdir.parent()?;
    let common_git = worktrees.parent()?;
    if !worktrees.file_name()?.eq_ignore_ascii_case("worktrees") || !common_git.file_name()?.eq_ignore_ascii_case(".git") {
        return None;
    }
    let back = std::fs::read_to_string(gitdir.join("gitdir")).ok()?;
    let back = root.join(back.trim());
    if resolved(&back)? != resolved(dot_git)? {
        return None;
    }
    let common = std::fs::read_to_string(gitdir.join("commondir")).ok()?;
    if resolved(&gitdir.join(common.trim()))? != resolved(common_git)? {
        return None;
    }
    let main = common_git.parent()?;
    Some(PathBuf::from(main.to_string_lossy().trim_start_matches(r"\\?\")))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> TempDir {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let p = std::env::temp_dir().join(format!("vidar-bare-{tag}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&p).unwrap();
            // Long form: production canonicalizes, and a short (8.3) %TEMP% would differ in text.
            let p = PathBuf::from(std::fs::canonicalize(&p).unwrap().to_string_lossy().trim_start_matches(r"\\?\"));
            TempDir(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    /// A config trusting each key in `keys` (TOML literal strings).
    fn cfg(t: &TempDir, keys: &[&str]) -> PathBuf {
        let c = t.0.join("user").join("config.toml");
        write(&c, &keys.iter().map(|k| format!("[projects.'{k}']\ntrust_level = \"trusted\"\n")).collect::<String>());
        c
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn exact_folder_is_trusted() {
        let t = TempDir::new("ut-exact");
        let dir = t.0.join("proj");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(config_trusts(&cfg(&t, &[&s(&dir)]), &s(&dir)));
    }

    #[test]
    fn git_root_trust_covers_a_subfolder() {
        let t = TempDir::new("ut-root");
        let repo = t.0.join("repo");
        let sub = repo.join("a").join("b");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(&sub).unwrap();
        assert!(config_trusts(&cfg(&t, &[&s(&repo)]), &s(&sub)));
        assert!(!config_trusts(&cfg(&t, &[&s(&sub.join("zzz"))]), &s(&sub)));
    }

    #[test]
    fn worktree_inherits_the_main_repo_trust() {
        let t = TempDir::new("ut-wt");
        let main = t.0.join("main");
        let wt = t.0.join("wt");
        let admin = main.join(".git").join("worktrees").join("wt");
        std::fs::create_dir_all(&admin).unwrap();
        std::fs::create_dir_all(wt.join("src")).unwrap();
        write(&admin.join("commondir"), "../..\n");
        write(&admin.join("gitdir"), &format!("{}\n", s(&wt.join(".git")).replace('\\', "/")));
        write(&wt.join(".git"), &format!("gitdir: {}\n", s(&admin).replace('\\', "/")));
        assert!(config_trusts(&cfg(&t, &[&s(&main)]), &s(&wt.join("src"))));
        assert!(!config_trusts(&cfg(&t, &[&s(&t.0.join("other"))]), &s(&wt)));
    }

    /// A worktree layout under `t`: main repo `main`, linked folder `wt`; `back` is the admin folder's
    /// back-pointer file content, when given.
    fn worktree(t: &TempDir, back: Option<&Path>) -> (PathBuf, PathBuf) {
        let main = t.0.join("main");
        let wt = t.0.join("wt");
        let admin = main.join(".git").join("worktrees").join("wt");
        std::fs::create_dir_all(&admin).unwrap();
        std::fs::create_dir_all(&wt).unwrap();
        write(&admin.join("commondir"), "../..\n");
        if let Some(b) = back {
            write(&admin.join("gitdir"), &format!("{}\n", s(b)));
        }
        write(&wt.join(".git"), &format!("gitdir: {}\n", s(&admin)));
        (main, wt)
    }

    #[test]
    fn worktree_back_pointer_must_name_this_folder() {
        let t = TempDir::new("ut-back");
        let (main, wt) = worktree(&t, None);
        assert!(!config_trusts(&cfg(&t, &[&s(&main)]), &s(&wt)));
        let other = t.0.join("other").join(".git");
        write(&other, "x");
        let (main, wt) = worktree(&t, Some(&other));
        assert!(!config_trusts(&cfg(&t, &[&s(&main)]), &s(&wt)));
        let (main, wt) = worktree(&t, Some(&wt.join(".git")));
        assert!(config_trusts(&cfg(&t, &[&s(&main)]), &s(&wt)));
    }

    #[test]
    fn forged_worktree_with_local_commondir_is_untrusted() {
        let t = TempDir::new("ut-forge");
        let main = t.0.join("main");
        std::fs::create_dir_all(main.join(".git")).unwrap();
        let evil = t.0.join("evil");
        write(&evil.join(".git"), "gitdir: g\n");
        write(&evil.join("g").join("commondir"), &format!("{}\n", s(&main.join(".git"))));
        assert!(!config_trusts(&cfg(&t, &[&s(&main)]), &s(&evil)));
        write(&evil.join("g").join("gitdir"), &format!("{}\n", s(&evil.join(".git"))));
        assert!(!config_trusts(&cfg(&t, &[&s(&main)]), &s(&evil)));
    }

    #[test]
    fn dot_dot_unc_and_relative_paths_are_untrusted() {
        let t = TempDir::new("ut-path");
        let trusted = t.0.join("trusted");
        let evil = t.0.join("evil");
        std::fs::create_dir_all(&trusted).unwrap();
        std::fs::create_dir_all(&evil).unwrap();
        let c = cfg(&t, &[&s(&trusted)]);
        assert!(!config_trusts(&c, &format!("{}\\..\\evil", s(&trusted))));
        assert!(!config_trusts(&c, &format!("{}/./sub", s(&trusted))));
        assert!(!config_trusts(&c, "trusted"));
        assert!(!config_trusts(&c, "..\\trusted"));
        let unc = cfg(&t, &[r"\\server\share\x", r"UNC\server\share\x"]);
        assert!(!config_trusts(&unc, r"\\?\UNC\server\share\x"));
        assert!(!config_trusts(&unc, r"\\server\share\x"));
        assert!(!config_trusts(&unc, r"UNC\server\share\x"));
        assert!(plain_absolute(r"\\?\C:\a\b").is_some());
    }

    #[test]
    fn spellings_compare_by_text_not_case_or_slash() {
        let t = TempDir::new("ut-spell");
        let dir = t.0.join("Proj X");
        std::fs::create_dir_all(&dir).unwrap();
        let d = s(&dir);
        for key in [d.to_uppercase(), d.replace('\\', "/"), format!(r"\\?\{d}"), format!("{d}\\"), format!("{}/", d.replace('\\', "/")).to_lowercase()] {
            assert!(config_trusts(&cfg(&t, &[&key]), &d), "{key}");
        }
        assert!(config_trusts(&cfg(&t, &[&d]), &d.replace('\\', "/").to_uppercase()));
    }

    #[test]
    fn untrusted_levels_and_other_folders_do_not_count() {
        let t = TempDir::new("ut-no");
        let dir = t.0.join("proj");
        std::fs::create_dir_all(&dir).unwrap();
        let d = s(&dir);
        assert!(!config_trusts(&cfg(&t, &[&s(&t.0.join("elsewhere"))]), &d));
        let c = t.0.join("user").join("config.toml");
        write(&c, &format!("[projects.'{d}']\ntrust_level = \"untrusted\"\n"));
        assert!(!config_trusts(&c, &d));
        write(&c, "model = \"x\"\n");
        assert!(!config_trusts(&c, &d));
    }

    #[test]
    fn missing_or_malformed_config_trusts_nothing() {
        let t = TempDir::new("ut-bad");
        let dir = s(&t.0);
        assert!(!config_trusts(&t.0.join("none").join("config.toml"), &dir));
        let c = t.0.join("user").join("config.toml");
        write(&c, &format!("[projects.'{dir}'\ntrust_level = trusted ==\n"));
        assert!(!config_trusts(&c, &dir));
    }
}
