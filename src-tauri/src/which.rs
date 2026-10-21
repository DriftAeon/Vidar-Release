//! src-tauri\src\which.rs — exact-filename PATH search, shared by flow.rs
//! (node/claude for Rendered tabs) and deps.rs (the Dependencies probes).
//! Never through PATHEXT: the caller names the exact file it can use.
//!
//! `find_on_path_exact` searches the process PATH only: every child Vidar
//! spawns inherits that env, so a hit elsewhere would not run. Vidar never
//! mutates its own PATH. `registry_path_dirs` (user and machine `Path` from
//! the registry) exists so deps.rs can tell "installed after Vidar started"
//! apart from "not installed".

use std::path::{Path, PathBuf};

/// A file, counting Windows app-execution aliases. `Path::is_file()` follows
/// the reparse point, and an alias (`%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe`,
/// a Store-installed pwsh) cannot be followed, so it reads as absent.
/// `symlink_metadata` reads the reparse point itself; std only reports
/// symlink and mount-point tags as links, so an alias is a plain file there.
pub(crate) fn is_file_or_alias(path: &Path) -> bool {
    path.is_file()
        || std::fs::symlink_metadata(path)
            .map(|m| m.file_type().is_file())
            .unwrap_or(false)
}

/// First `dir\name` on the process PATH that exists as a file (aliases included).
pub(crate) fn find_on_path_exact(name: &str) -> Option<PathBuf> {
    find_in(&process_path_dirs(), name)
}

/// First `dir\name` among `dirs` that exists as a file (aliases included).
pub(crate) fn find_in(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    dirs.iter()
        .map(|dir| dir.join(name))
        .find(|candidate| is_file_or_alias(candidate))
}

/// The process PATH, empty entries dropped, duplicates (case- and
/// trailing-slash-insensitive) kept once.
pub(crate) fn process_path_dirs() -> Vec<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    dedupe_dirs(std::env::split_paths(&path))
}

/// HKCU then HKLM `Environment\Path` as persisted now, deduped the same way.
/// Read once per call: callers hold the result for a whole detect pass.
pub(crate) fn registry_path_dirs() -> Vec<PathBuf> {
    let lists: Vec<String> = [Hive::User, Hive::Machine]
        .into_iter()
        .filter_map(|hive| registry_env(hive, "Path"))
        .collect();
    dedupe_dirs(lists.iter().flat_map(std::env::split_paths))
}

fn dedupe_dirs(dirs: impl Iterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for dir in dirs {
        let key = dir.to_string_lossy().trim().trim_end_matches(['\\', '/']).to_lowercase();
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        out.push(dir);
    }
    out
}

#[derive(Clone, Copy)]
pub(crate) enum Hive {
    /// `HKCU\Environment`
    User,
    /// `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`
    Machine,
}

/// A variable from the persisted user or machine environment, as a string.
/// REG_EXPAND_SZ is expanded against the process environment (RegGetValueW
/// does this when RRF_NOEXPAND is absent). `None` when absent or not a string.
pub(crate) fn registry_env(hive: Hive, name: &str) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
    };

    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (key, subkey) = match hive {
        Hive::User => (HKEY_CURRENT_USER, wide("Environment")),
        Hive::Machine => (
            HKEY_LOCAL_MACHINE,
            wide(r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        ),
    };
    let value = wide(name);
    // RRF_RT_REG_SZ without RRF_NOEXPAND also accepts REG_EXPAND_SZ and expands it.
    let flags = RRF_RT_REG_SZ;

    let mut size: u32 = 0;
    let rc = unsafe {
        RegGetValueW(key, PCWSTR(subkey.as_ptr()), PCWSTR(value.as_ptr()), flags, None, None, Some(&mut size))
    };
    if rc != ERROR_SUCCESS {
        return None;
    }
    // The expanded size can move between the two calls (an env var changed);
    // retry a few times on ERROR_MORE_DATA rather than fail.
    for _ in 0..3 {
        let mut buf = vec![0u16; (size as usize).div_ceil(2).max(1)];
        let mut size_read = (buf.len() * 2) as u32;
        let rc = unsafe {
            RegGetValueW(
                key,
                PCWSTR(subkey.as_ptr()),
                PCWSTR(value.as_ptr()),
                flags,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut size_read),
            )
        };
        if rc == ERROR_MORE_DATA {
            size = size_read.max(size.saturating_mul(2));
            continue;
        }
        if rc != ERROR_SUCCESS {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        return Some(String::from_utf16_lossy(&buf[..len]));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The alias case on this machine: wt.exe is an app-execution alias. Prints
    /// what each check returns; asserts only when the alias is actually there.
    #[test]
    fn which_counts_an_app_execution_alias() {
        let Some(local) = std::env::var_os("LOCALAPPDATA") else {
            return;
        };
        let wt = Path::new(&local).join("Microsoft").join("WindowsApps").join("wt.exe");
        let link = std::fs::symlink_metadata(&wt);
        println!(
            "wt alias {}: is_file={} symlink_metadata={:?} is_file_or_alias={}",
            wt.display(),
            wt.is_file(),
            link.as_ref().map(|m| (m.file_type().is_file(), m.file_type().is_symlink())),
            is_file_or_alias(&wt)
        );
        if link.is_ok() {
            assert!(is_file_or_alias(&wt), "alias present but not counted");
        }
    }

    /// The machine Path always exists on Windows and holds System32 once its
    /// `%SystemRoot%` is expanded: proves the read and the REG_EXPAND_SZ expansion.
    #[test]
    fn which_reads_and_expands_the_machine_path() {
        let path = registry_env(Hive::Machine, "Path").expect("HKLM Environment Path");
        println!("HKLM Path: {path}");
        assert!(!path.contains("%SystemRoot%"), "not expanded: {path}");
        assert!(path.to_lowercase().contains(r"\system32"), "no System32: {path}");
    }

    #[test]
    fn which_dedupes_case_and_trailing_slash() {
        let dirs = [r"C:\A", r"c:\a\", "", r"C:\B", r"C:\a"].map(PathBuf::from);
        let out = dedupe_dirs(dirs.into_iter());
        assert_eq!(out, vec![PathBuf::from(r"C:\A"), PathBuf::from(r"C:\B")]);
    }
}
