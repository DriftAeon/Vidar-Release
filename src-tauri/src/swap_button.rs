//! Bottom-bar Swap button (src/panels/swap.ts): the pending check and the detached start of
//! `tools\release\swap-button.ps1`, which builds and runs swap-release.ps1 after this window is gone.
//! The worker reports through `runtime\bridge\swap-button.json` (read back by `swap_state`) and logs
//! to `swap-button.log` beside it. Falcon is never part of this; `/swap falcon` stays the agent path.

use std::ffi::{OsStr, OsString};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// pending.ps1 also runs falcon-refresh.ps1 -DryRun; measured 3 s warm, 10.5 s cold (2026-10-06).
const PENDING_TIMEOUT: Duration = Duration::from_secs(60);

/// Removed from the worker's env on top of `pty::SCRUBBED_ENV` (agent-session markers, the control
/// token, VIDAR_ROOT, the DevTools port). The worker's children are npm, cargo and swap-release.ps1;
/// swap-release relaunches through clean-env.ps1, and this is the layer before that: a Vidar started
/// from a tab carries VIDAR_TAB (swap-release refuses under it) or FALCON_SESSION, and an agent shell
/// that launched Vidar leaves its Claude/Codex markers (the 2026-09-20 leak was an inherited env).
const EXTRA_SCRUBBED: &[&str] = &["VIDAR_TAB", "VIDAR_TAB_NAME", "FALCON_SESSION"];
/// Whole families: every Claude Code and Codex session variable, known now or added later.
const SCRUBBED_PREFIXES: &[&str] = &["CLAUDE_CODE_", "CODEX_"];

/// True when `key` stays out of the worker's env. Windows env names are case-insensitive.
pub(crate) fn is_scrubbed(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    crate::pty::SCRUBBED_ENV
        .iter()
        .chain(EXTRA_SCRUBBED)
        .any(|k| k.eq_ignore_ascii_case(key))
        || SCRUBBED_PREFIXES.iter().any(|p| upper.starts_with(p))
}

/// The env the worker gets: the caller's minus the scrubbed names, sorted case-insensitively
/// (CreateProcessW wants the block sorted by name).
fn kept_vars(vars: impl IntoIterator<Item = (OsString, OsString)>) -> Vec<(OsString, OsString)> {
    let mut kept: Vec<_> = vars
        .into_iter()
        .filter(|(k, _)| !is_scrubbed(&k.to_string_lossy()))
        .collect();
    kept.sort_by_key(|(k, _)| k.to_string_lossy().to_uppercase());
    kept
}

/// UTF-16 environment block: `K=V\0` per entry, then a closing `\0`.
fn env_block(vars: &[(OsString, OsString)]) -> Vec<u16> {
    let mut block = Vec::new();
    for (k, v) in vars {
        block.extend(k.encode_wide());
        block.push(u16::from(b'='));
        block.extend(v.encode_wide());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VidarPending {
    build: bool,
    swap: bool,
    running: bool,
    lock: bool,
    in_tab: bool,
    /// Wall time of the pending.ps1 run.
    ms: u64,
}

/// The `vidar   build=… swap=… running=… lock=… in-tab=…` line of pending.ps1 (line 87); the
/// falcon block is ignored. `None` when the line or any of its five fields is missing.
fn parse_vidar_line(out: &str, ms: u64) -> Option<VidarPending> {
    let line = out.lines().find(|l| l.split_whitespace().next() == Some("vidar"))?;
    let field = |name: &str| {
        line.split_whitespace()
            .find_map(|t| t.strip_prefix(name).and_then(|r| r.strip_prefix('=')))
    };
    let yes = |name: &str| match field(name)? {
        "yes" | "on" => Some(true),
        "no" | "off" => Some(false),
        _ => None,
    };
    Some(VidarPending {
        build: yes("build")?,
        swap: yes("swap")?,
        running: yes("running")?,
        lock: yes("lock")?,
        in_tab: yes("in-tab")?,
        ms,
    })
}

/// tools\release is export-ignored, so a shipped install has no scripts to run; src/panels/swap.ts
/// matches this prefix to hide the button.
const UNAVAILABLE: &str = "Swap Unavailable: No Release Tools In This Install";

#[tauri::command]
pub async fn swap_pending() -> Result<VidarPending, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let script = crate::paths::root().join(r"tools\release\pending.ps1");
        if !script.is_file() {
            return Err(UNAVAILABLE.to_string());
        }
        let script = script.to_str().ok_or("Pending Check Failed: Path Is Not Unicode")?;
        let start = Instant::now();
        let out = crate::deps::run_bounded(
            OsStr::new("pwsh.exe"),
            &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
            PENDING_TIMEOUT,
        )
        .ok_or("Pending Check Failed")?;
        let ms = start.elapsed().as_millis() as u64;
        parse_vidar_line(&out, ms).ok_or_else(|| "Pending Check Failed: No Vidar Line".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

const ACTIVE_PHASES: &[&str] = &["checking", "building", "swapping"];

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StateFile {
    phase: Option<String>,
    error: Option<String>,
    pid: Option<u32>,
    at_ms: Option<u64>,
    #[serde(default)]
    dry_run: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SwapState {
    phase: Option<String>,
    error: Option<String>,
    /// The worker that wrote the file; the frontend matches it to the pid `swap_start` returned,
    /// so a previous run's final state is never read as this run's.
    pid: Option<u32>,
    /// The worker named in the file is still alive and mid-run.
    pub(crate) running: bool,
    dry_run: bool,
    /// Unix ms of the worker's last write; the panel shows a failure found at mount only while recent.
    at_ms: Option<u64>,
}

fn state_path() -> std::path::PathBuf {
    crate::paths::bridge_dir().join("swap-button.json")
}

/// A pid is ours only while it is a live pwsh: pids are reused once the worker exits.
fn worker_alive(pid: u32) -> bool {
    crate::procs::is_alive(pid) && crate::procs::image_name(pid).as_deref() == Some("pwsh.exe")
}

/// A started worker: its pid and creation time, so a pid reused by a tab's pwsh.exe is not mistaken
/// for it (a bare pid is only a hint, `procs::is_alive`).
#[derive(Clone, Copy, Debug, PartialEq)]
struct Worker {
    pid: u32,
    created: Option<u64>,
}

fn same_process(w: Worker, now_created: Option<u64>) -> bool {
    w.created.is_some() && w.created == now_created
}

fn started_worker_alive(w: Worker) -> bool {
    worker_alive(w.pid) && same_process(w, crate::procs::creation_time(w.pid))
}

fn read_state(path: &Path) -> SwapState {
    let file: StateFile = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let active = file.phase.as_deref().is_some_and(|p| ACTIVE_PHASES.contains(&p));
    SwapState {
        running: active && file.pid.is_some_and(worker_alive),
        pid: file.pid,
        phase: file.phase,
        error: file.error,
        dry_run: file.dry_run,
        at_ms: file.at_ms,
    }
}

#[tauri::command]
pub fn swap_state() -> SwapState {
    read_state(&state_path())
}

/// Last worker this Vidar started: covers a second press before the worker has written its pid.
static LAST_WORKER: Mutex<Option<Worker>> = Mutex::new(None);

#[tauri::command]
pub fn swap_start() -> Result<u32, String> {
    let mut last = LAST_WORKER.lock().map_err(|e| e.to_string())?;
    if last.is_some_and(started_worker_alive) || read_state(&state_path()).running {
        return Err("Swap Already Running".into());
    }
    if crate::release_build::running() {
        return Err("Build Already Running".into());
    }
    if crate::settings::switches::read_switch("close-lock".into()) {
        return Err("Close Lock Is On".into());
    }
    let root = crate::paths::root();
    let script = root.join(r"tools\release\swap-button.ps1");
    if !script.is_file() {
        return Err(UNAVAILABLE.to_string());
    }
    let pid = spawn_detached(&script, &root)?;
    *last = Some(Worker { pid, created: crate::procs::creation_time(pid) });
    Ok(pid)
}

/// Starts the worker with CreateProcessW directly: `bInheritHandles = FALSE` (std's Command always
/// passes TRUE), a scrubbed env block, its own hidden console (CREATE_NO_WINDOW; DETACHED_PROCESS
/// would make Windows ignore that flag and give npm/cargo a visible console each) and its own process
/// group, out of Vidar's job when the job allows breakaway (else it retries inside it, as
/// falcon/host_launch.rs does). It owes Vidar nothing after this returns.
fn spawn_detached(script: &Path, cwd: &Path) -> Result<u32, String> {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, E_ACCESSDENIED};
    use windows::Win32::System::Threading::{
        CreateProcessW, CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW,
        CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTUPINFOW,
    };

    let command = format!(
        "pwsh.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{}\"",
        script.display()
    );
    let cwd_w: Vec<u16> = cwd.as_os_str().encode_wide().chain(Some(0)).collect();
    let env = env_block(&kept_vars(std::env::vars_os()));
    let base = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT;
    for breakaway in [true, false] {
        let flags = if breakaway { base | CREATE_BREAKAWAY_FROM_JOB } else { base };
        // CreateProcessW may write into the command line buffer: a fresh copy per attempt.
        let mut command_w: Vec<u16> = command.encode_utf16().chain(Some(0)).collect();
        let startup = STARTUPINFOW { cb: std::mem::size_of::<STARTUPINFOW>() as u32, ..Default::default() };
        let mut info = PROCESS_INFORMATION::default();
        // SAFETY: every pointer is to a live, NUL-terminated local buffer for the call's duration;
        // `info` is a stack out-param whose two handles are closed below.
        let result = unsafe {
            CreateProcessW(
                PCWSTR::null(),
                Some(PWSTR(command_w.as_mut_ptr())),
                None,
                None,
                false,
                flags,
                Some(env.as_ptr() as *const core::ffi::c_void),
                PCWSTR(cwd_w.as_ptr()),
                &startup,
                &mut info,
            )
        };
        match result {
            Ok(()) => {
                // SAFETY: both handles came from the successful call above, closed once.
                unsafe {
                    let _ = CloseHandle(info.hThread);
                    let _ = CloseHandle(info.hProcess);
                }
                return Ok(info.dwProcessId);
            }
            Err(e) if breakaway && e.code() == E_ACCESSDENIED => continue,
            Err(e) => return Err(format!("Swap Did Not Start: {}", e.message())),
        }
    }
    Err("Swap Did Not Start".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
    }

    #[test]
    fn scrubs_tab_falcon_and_agent_session_vars() {
        for key in [
            "VIDAR_TAB",
            "vidar_tab",
            "VIDAR_TAB_NAME",
            "vidar_tab_name",
            "FALCON_SESSION",
            "VIDAR_CTL_TOKEN",
            "VIDAR_CTL_SECRET",
            "VIDAR_ROOT",
            "CLAUDECODE",
            "CLAUDE_PID",
            "CLAUDE_CODE_SESSION_ID",
            "CLAUDE_CODE_SSE_PORT",
            "CLAUDE_CODE_SOMETHING_NEW",
            "CODEX_SANDBOX",
            "CODEX_SESSION_ID",
            "NO_COLOR",
            "TERM",
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        ] {
            assert!(is_scrubbed(key), "{key} should be scrubbed");
        }
        for key in crate::pty::SCRUBBED_ENV {
            assert!(is_scrubbed(key), "{key} from pty::SCRUBBED_ENV should be scrubbed");
        }
    }

    #[test]
    fn keeps_what_the_build_and_swap_need() {
        for key in [
            "PATH",
            "Path",
            "SystemRoot",
            "USERPROFILE",
            "LOCALAPPDATA",
            "TEMP",
            "VIDAR_PROCDUMP",
            "CARGO_HOME",
            "RUSTUP_HOME",
            "CLAUDE_CONFIG_DIR",
        ] {
            assert!(!is_scrubbed(key), "{key} should be kept");
        }
    }

    #[test]
    fn env_block_is_scrubbed_sorted_and_double_terminated() {
        let kept = kept_vars(os(&[
            ("windir", "C:\\Windows"),
            ("VIDAR_TAB", "t1"),
            ("VIDAR_TAB_NAME", "Amber Raptor"),
            ("Path", "C:\\bin"),
            ("FALCON_SESSION", "s1"),
            ("ComSpec", "cmd"),
        ]));
        let names: Vec<_> = kept.iter().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["ComSpec", "Path", "windir"]);
        let block = env_block(&kept);
        let text = String::from_utf16(&block).unwrap();
        assert_eq!(text, "ComSpec=cmd\0Path=C:\\bin\0windir=C:\\Windows\0\0");
        assert_eq!(env_block(&[]), vec![0, 0]);
    }

    #[test]
    fn parses_only_the_vidar_line() {
        let out = "vidar   build=yes  swap=no  running=yes  lock=on  in-tab=no\n        staged 15:32:11  newest source 15:40:37\nfalcon  changed=0  children=3  host=3544\nfalcon  frontend=behind\n";
        assert_eq!(
            parse_vidar_line(out, 7),
            Some(VidarPending { build: true, swap: false, running: true, lock: true, in_tab: false, ms: 7 })
        );
        assert_eq!(parse_vidar_line("falcon  changed=0  children=0  host=none\n", 1), None);
        assert_eq!(parse_vidar_line("vidar   build=yes  swap=no\n", 1), None);
        assert_eq!(parse_vidar_line("vidar   build=maybe  swap=no  running=no  lock=off  in-tab=no\n", 1), None);
    }

    /// The real spawn: a throwaway script reports its cwd, PATH and every env name that should
    /// have been scrubbed. Under an agent shell the test process itself carries CLAUDECODE and kin,
    /// so an empty list here is the scrub working, not an empty parent.
    #[test]
    fn spawn_detached_runs_with_a_scrubbed_env_and_the_given_cwd() {
        let dir = std::env::temp_dir().join(format!("vidar-swap-spawn-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // The child reports the long path; a short (8.3) %TEMP% would not match the text.
        let dir = std::path::PathBuf::from(std::fs::canonicalize(&dir).unwrap().to_string_lossy().trim_start_matches(r"\\?\"));
        let out = dir.join("out.txt");
        let script = dir.join("probe.ps1");
        std::fs::write(
            &script,
            format!(
                "$bad = Get-ChildItem env: | Where-Object {{ $_.Name -match '^(VIDAR_TAB|FALCON_SESSION|CLAUDECODE|CLAUDE_CODE_|CODEX_|VIDAR_CTL_)' }} | ForEach-Object Name\n\
                 Set-Content -LiteralPath '{}' -Value @((Get-Location).Path, [bool]$env:PATH, ($bad -join ','))\n",
                out.display()
            ),
        )
        .unwrap();
        let pid = spawn_detached(&script, &dir).expect("spawn");
        assert!(pid > 0);
        let deadline = Instant::now() + Duration::from_secs(30);
        let text = loop {
            if let Ok(t) = std::fs::read_to_string(&out) {
                if t.lines().count() >= 2 {
                    break t;
                }
            }
            assert!(Instant::now() < deadline, "probe script wrote nothing in 30 s");
            std::thread::sleep(Duration::from_millis(100));
        };
        let lines: Vec<&str> = text.lines().collect();
        assert!(lines[0].eq_ignore_ascii_case(&dir.display().to_string()), "cwd was {}", lines[0]);
        assert_eq!(lines[1], "True", "PATH must survive the scrub");
        assert_eq!(lines.get(2).copied().unwrap_or(""), "", "unscrubbed: {:?}", lines.get(2));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_reused_pid_is_not_the_started_worker() {
        let w = Worker { pid: 1, created: Some(100) };
        assert!(same_process(w, Some(100)));
        assert!(!same_process(w, Some(101)), "pid reused: creation time differs");
        assert!(!same_process(w, None));
        assert!(!same_process(Worker { pid: 1, created: None }, None), "unknown creation time never matches");
        // This test process is alive, but is not a pwsh worker: never ours.
        let me = std::process::id();
        let mine = Worker { pid: me, created: crate::procs::creation_time(me) };
        assert!(mine.created.is_some());
        assert!(!started_worker_alive(mine));
    }

    #[test]
    fn state_running_needs_an_active_phase_and_a_live_worker() {
        let dir = std::env::temp_dir().join(format!("vidar-swap-state-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("swap-button.json");
        // pid 0 is never a live pwsh worker.
        std::fs::write(&path, r#"{"phase":"building","error":null,"pid":0,"dryRun":false}"#).unwrap();
        let s = read_state(&path);
        assert_eq!(s.phase.as_deref(), Some("building"));
        assert!(!s.running);
        std::fs::write(&path, r#"{"phase":"failed","error":"Build Failed: x","pid":0}"#).unwrap();
        let s = read_state(&path);
        assert_eq!(s.error.as_deref(), Some("Build Failed: x"));
        assert!(!s.running);
        let missing = read_state(&dir.join("absent.json"));
        assert!(missing.phase.is_none() && !missing.running);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
