//! Assembles `UnrealStatus`: file reads, the process check, merge and caps.

use std::fs::{self, File};
use std::io::{ErrorKind, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use super::parse::{self, RawDiag};
use super::{discover, Build, Diag, Editor, LiveCoding, Project, UnrealStatus};

const TAIL_BYTES: u64 = 256 * 1024;
const UBT_MAX_BYTES: u64 = 16 * 1024 * 1024;
const DIAG_CAP: usize = 50;
const UBT_HEAD_BYTES: u64 = 64 * 1024;

/// `UnrealEditor.exe` and its configuration builds (`UnrealEditor-Win64-DebugGame.exe`), not `-Cmd`.
fn is_editor_exe(exe: &str) -> bool {
    let e = exe.to_lowercase();
    e.starts_with("unrealeditor") && e.ends_with(".exe") && !e.ends_with("-cmd.exe")
}

/// True when another process holds the file open for writing without sharing write access (the
/// editor does that to its own `<Project>.log`). Opening for write needs no truncate or edit; only a
/// sharing violation counts, so any other failure reads as "not held". The process list cannot tell
/// which project an `UnrealEditor.exe` belongs to, so this ties "running" to this project (F5).
#[cfg(windows)]
fn log_held_for_write(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    match fs::OpenOptions::new().write(true).share_mode(7).open(path) {
        Err(e) => e.raw_os_error() == Some(ERROR_SHARING_VIOLATION),
        Ok(_) => false,
    }
}

#[cfg(not(windows))]
fn log_held_for_write(_path: &Path) -> bool { true }

/// Last `TAIL_BYTES` of the file as lossy UTF-8, first partial line dropped when the read
/// started mid-file. `Ok(None)` when the file does not exist.
fn read_tail(path: &Path) -> Result<Option<String>, String> {
    let mut f = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let err = |e: std::io::Error| format!("{}: {e}", path.display());
    let len = f.metadata().map_err(err)?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).map_err(err)?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.take(TAIL_BYTES).read_to_end(&mut buf).map_err(err)?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    if start == 0 { return Ok(Some(text)); }
    Ok(Some(match text.find('\n') {
        Some(i) => text[i + 1..].to_string(),
        None => String::new(),
    }))
}

/// UBT `Log.txt` text plus its file time (epoch ms). None when absent, implausibly large, or when
/// its head (`UBT_HEAD_BYTES`) does not name `uproject`: the rest is only decoded for a match.
fn read_ubt(dir: &Path, uproject: &str) -> Result<Option<(String, Option<u64>)>, String> {
    let path = dir.join("Log.txt");
    let meta = match fs::metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    if meta.len() > UBT_MAX_BYTES { return Ok(None); }
    let err = |e: std::io::Error| format!("{}: {e}", path.display());
    let mut head = Vec::new();
    File::open(&path).map_err(err)?.take(UBT_HEAD_BYTES).read_to_end(&mut head).map_err(err)?;
    if !parse::ubt_matches(&String::from_utf8_lossy(&head), uproject) { return Ok(None); }
    let bytes = fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let at = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64);
    Ok(Some((String::from_utf8_lossy(&bytes).into_owned(), at)))
}

/// Newest first (by line time, then file order), capped.
fn merge(mut all: Vec<(Option<u64>, usize, Diag)>) -> Vec<Diag> {
    all.sort_by(|a, b| (b.0, b.1).cmp(&(a.0, a.1)));
    all.into_iter().take(DIAG_CAP).map(|(_, _, d)| d).collect()
}

/// The reader with its environment injected: `ubt_dir` is the folder holding UBT's `Log.txt`
/// (production: `%LOCALAPPDATA%\UnrealBuildTool`), `editor_proc` whether the editor process is up.
pub fn status_with(cwd: &Path, ubt_dir: Option<&Path>, editor_proc: bool) -> Result<UnrealStatus, String> {
    let Some(uproject) = discover::find_uproject(cwd) else {
        return Ok(UnrealStatus { project: None, editor: Editor::Closed, build: None, live_coding: None, diags: Vec::new() });
    };
    let root_path = uproject.parent().map(Path::to_path_buf).unwrap_or_default();
    let root = root_path.to_string_lossy().replace('/', "\\");
    let uproject_name = uproject.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let project = Project {
        name: root_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        root: root.clone(),
        uproject: uproject_name,
    };

    let stem = uproject.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let log_path: PathBuf = root_path.join("Saved").join("Logs").join(format!("{stem}.log"));
    let log = read_tail(&log_path)?;
    let scan = log.as_deref().map(|t| parse::scan_log(t, &root));
    let closed = scan.as_ref().is_some_and(|s| s.closed);
    // an editor process alone may belong to another project: this project's log must be held too
    let editor_proc = editor_proc && scan.is_some() && !closed && log_held_for_write(&log_path);
    let editor = if editor_proc && scan.is_some() && !closed {
        Editor::Running
    } else if !editor_proc && scan.is_some() && !closed {
        Editor::Unclean
    } else {
        Editor::Closed
    };

    let mut all: Vec<(Option<u64>, usize, Diag)> = Vec::new();
    let mut live_coding = None;
    if let Some(s) = scan {
        live_coding = s.live.map(|(result, at)| LiveCoding { result, at });
        all.extend(s.diags.into_iter().enumerate().map(|(i, RawDiag { diag, at })| (at, i, diag)));
    }

    let mut build = None;
    // A UBT read error (shared log mid-build, say) means no build line, not a failed status.
    let uproject_str = uproject.to_string_lossy().into_owned();
    if let Some(Ok(Some((text, at)))) = ubt_dir.map(|d| read_ubt(d, &uproject_str)) {
        if let Some(u) = parse::scan_ubt(&text, &uproject_str, &root) {
            build = Some(Build { result: u.result, at });
            let base = all.len();
            all.extend(u.diags.into_iter().enumerate().map(|(i, RawDiag { diag, .. })| (at, base + i, diag)));
        }
    }

    Ok(UnrealStatus { project: Some(project), editor, build, live_coding, diags: merge(all) })
}

pub fn status_blocking(cwd: &str) -> Result<UnrealStatus, String> {
    let editor_proc = crate::procs::snapshot().values().any(|p| is_editor_exe(&p.exe));
    let ubt_dir = std::env::var_os("LOCALAPPDATA").map(|b| PathBuf::from(b).join("UnrealBuildTool"));
    status_with(Path::new(cwd), ubt_dir.as_deref(), editor_proc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::unreal::{BuildResult, LiveResult, Severity, Source};

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/unreal")
    }

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vidar-unreal-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("Saved").join("Logs")).unwrap();
        fs::write(d.join("Zed.uproject"), "{}").unwrap();
        d
    }

    #[test]
    fn log_close_marker_sets_editor_state() {
        let d = scratch("close");
        let log = d.join("Saved").join("Logs").join("Zed.log");
        fs::write(&log, "\u{FEFF}[2026.10.04-06.00.00:000][  0]Log file open, 10/04/26\n[2026.10.04-06.00.01:000][  1]LogTemp: Display: hi\n").unwrap();
        // F5: a process alone is not enough; this project's log must be held open for writing
        assert_eq!(status_with(&d, None, true).unwrap().editor, Editor::Unclean);
        assert_eq!(status_with(&d, None, false).unwrap().editor, Editor::Unclean);
        {
            use std::os::windows::fs::OpenOptionsExt;
            let _held = fs::OpenOptions::new().write(true).share_mode(1).open(&log).unwrap();
            assert_eq!(status_with(&d, None, true).unwrap().editor, Editor::Running);
            assert_eq!(status_with(&d, None, false).unwrap().editor, Editor::Unclean);
        }
        let mut closed = fs::read_to_string(&log).unwrap();
        closed.push_str("[2026.10.04-06.53.13:778][ 91]Log file closed, 10/04/26 06:53:13\n");
        fs::write(&log, closed).unwrap();
        assert_eq!(status_with(&d, None, false).unwrap().editor, Editor::Closed);
        assert_eq!(status_with(&d, None, true).unwrap().editor, Editor::Closed);
        fs::remove_file(&log).unwrap();
        assert_eq!(status_with(&d, None, false).unwrap().editor, Editor::Closed);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn tail_drops_the_partial_first_line_and_caps_diags() {
        let d = scratch("tail");
        let log = d.join("Saved").join("Logs").join("Zed.log");
        let mut s = String::from("LogTemp: Error: PARTIAL-HEAD-should-vanish\n");
        s.push_str(&"x".repeat(TAIL_BYTES as usize));
        s.push('\n');
        for i in 0..60 {
            s.push_str(&format!("[2026.10.04-06.00.{:02}:000][  1]LogTemp: Error: e{i}\n", i % 60));
        }
        fs::write(&log, s).unwrap();
        let st = status_with(&d, None, true).unwrap();
        assert_eq!(st.diags.len(), DIAG_CAP);
        assert_eq!(st.diags[0].text, "e59");
        assert!(st.diags.iter().all(|d| !d.text.contains("PARTIAL")));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn unreadable_log_is_an_error_not_a_panic() {
        let d = scratch("dir");
        let log = d.join("Saved").join("Logs").join("Zed.log");
        fs::create_dir_all(&log).unwrap(); // a directory where the file should be
        assert!(status_with(&d, None, false).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn running_needs_a_log() {
        let d = scratch("nolog");
        assert_eq!(status_with(&d, None, true).unwrap().editor, Editor::Closed);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn editor_exe_names_include_config_builds_not_cmd() {
        assert!(is_editor_exe("unrealeditor.exe"));
        assert!(is_editor_exe("UnrealEditor-Win64-DebugGame.exe"));
        assert!(!is_editor_exe("UnrealEditor-Cmd.exe"));
        assert!(!is_editor_exe("unrealeditor-win64-debuggame-cmd.exe"));
        assert!(!is_editor_exe("notepad.exe"));
    }

    #[test]
    fn ubt_read_error_drops_the_build_line_not_the_status() {
        let d = scratch("proj");
        let ubt = scratch("ubterr");
        fs::create_dir_all(ubt.join("Log.txt")).unwrap(); // a directory where the log should be
        let st = status_with(&d, Some(&ubt), false).unwrap();
        assert!(st.project.is_some() && st.build.is_none());
        let _ = fs::remove_dir_all(&d);
        let _ = fs::remove_dir_all(&ubt);
    }

    #[test]
    fn no_project_is_an_empty_status() {
        let st = status_with(Path::new(env!("CARGO_MANIFEST_DIR")).join("src").as_path(), None, true).unwrap();
        assert!(st.project.is_none() && st.build.is_none() && st.diags.is_empty());
    }

    #[test]
    fn status_serialises_to_fixture_shape() {
        let acme = fixtures().join("acme");
        // The fixture UBT log names C:/Projects/Acme; the project matches by its real path here,
        // so a scratch copy gets that path swapped in.
        let real = discover::find_uproject(&acme).unwrap().to_string_lossy().replace('\\', "/");
        let ubt = scratch("ubt");
        let text = fs::read_to_string(acme.join("UnrealBuildTool").join("Log.txt")).unwrap();
        fs::write(ubt.join("Log.txt"), text.replace("C:/Projects/Acme/Acme.uproject", &real)).unwrap();
        let mut st = status_with(&acme.join("Saved"), Some(&ubt), false).unwrap();
        let _ = fs::remove_dir_all(&ubt);
        assert_eq!(st.build.as_ref().map(|b| b.result), Some(BuildResult::Succeeded));
        assert_eq!(st.live_coding.as_ref().map(|l| l.result), Some(LiveResult::Failed));
        // machine-dependent fields: the fixture's real location and the UBT file time
        assert_eq!(st.project.as_ref().unwrap().name.to_lowercase(), "acme");
        st.project.as_mut().unwrap().name = "Acme".into(); // fixture folder is lowercase
        st.project.as_mut().unwrap().root = r"C:\Projects\Acme".into();
        st.build.as_mut().unwrap().at = Some(1_790_000_000_000);
        let want: serde_json::Value = serde_json::from_str(include_str!("../../../tests/fixtures/unreal/status.json")).unwrap();
        assert_eq!(serde_json::to_value(&st).unwrap(), want);
        assert_eq!(st.diags[0].severity, Severity::Error);
        assert!(st.diags.iter().any(|d| d.source == Source::Log && d.file.is_none()));
    }
}
