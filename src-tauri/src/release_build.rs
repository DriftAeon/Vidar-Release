//! Settings > Build: runs `tools\release\release-build.ps1` (catalog, then a streamed zip build with
//! Cancel). The wrapper speaks one JSON object per stdout line (`phase`, `log`, `result`); this file
//! relays them as `release-build-event`, keeps the tail for a reopened page and ends the whole process
//! tree on cancel. Ids reach a spawned pwsh, so `valid_id` is the trust boundary.

use std::collections::VecDeque;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read};
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::proc_job::JobChild;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Same wording as swap_button: tools\release is export-ignored, so a shipped install has no wrapper.
const UNAVAILABLE: &str = "Build Unavailable: No Release Tools In This Install";
const CATALOG_TIMEOUT: Duration = Duration::from_secs(60);
const KEEP_LINES: usize = 200;
/// Mirrors `idPattern` in contracts/modules.json (a test pins them equal).
const ID_PATTERN: &str = r"^[a-z][a-z0-9-]{0,31}$";

fn script_path() -> std::path::PathBuf {
    crate::paths::root().join(r"tools\release\release-build.ps1")
}

fn id_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(ID_PATTERN).expect("id pattern"))
}

fn valid_id(id: &str) -> bool {
    id_regex().is_match(id)
}

/// Longest line relayed, in chars; the rest is cut and marked with an ellipsis.
const MAX_LINE_CHARS: usize = 4000;

fn cap_line(line: &str) -> String {
    match line.char_indices().nth(MAX_LINE_CHARS) {
        Some((cut, _)) => format!("{}…", &line[..cut]),
        None => line.to_string(),
    }
}

/// One line as an event: JSON objects pass as-is from stdout only; stderr and anything else become log lines.
fn wrap_line(line: &str, from_stdout: bool) -> Value {
    if from_stdout {
        if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
            if v.is_object() {
                return v;
            }
        }
    }
    json!({ "t": "log", "line": line })
}

/// Deletes the lock file when it names `pid`, so a killed build leaves nothing for pid reuse to match.
fn clear_lock_at(path: &std::path::Path, pid: u32) {
    let named = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(s.trim_start_matches('\u{feff}')).ok())
        .and_then(|v| v.get("pid").and_then(Value::as_u64));
    if named == Some(u64::from(pid)) {
        let _ = std::fs::remove_file(path);
    }
}

fn clear_lock(pid: u32) {
    clear_lock_at(&crate::paths::bridge_dir().join("release-build.json"), pid);
}

/// True while the in-process release build runs (swap_start refuses meanwhile).
pub(crate) fn running() -> bool {
    RUN.lock().map(|r| r.running).unwrap_or(false)
}

fn is_result(v: &Value) -> bool {
    v.get("t").and_then(Value::as_str) == Some("result")
}

#[derive(Default)]
struct Run {
    running: bool,
    cancelled: bool,
    saw_result: bool,
    events: VecDeque<Value>,
    result: Option<Value>,
    phase: Option<String>,
    child: Option<Arc<Mutex<JobChild>>>,
}

static RUN: Mutex<Run> = Mutex::new(Run {
    running: false,
    cancelled: false,
    saw_result: false,
    events: VecDeque::new(),
    result: None,
    phase: None,
    child: None,
});

/// The phase a `{"t":"phase"}` event announces.
fn phase_of(ev: &Value) -> Option<&str> {
    if ev.get("t").and_then(Value::as_str) == Some("phase") {
        ev.get("phase").and_then(Value::as_str)
    } else {
        None
    }
}

fn lock_run() -> Result<std::sync::MutexGuard<'static, Run>, String> {
    RUN.lock().map_err(|e| e.to_string())
}

/// Records and emits one event.
fn publish(app: &AppHandle, ev: Value) {
    if let Ok(mut run) = RUN.lock() {
        if is_result(&ev) {
            run.saw_result = true;
            run.result = Some(ev.clone());
        }
        if let Some(p) = phase_of(&ev) {
            run.phase = Some(p.to_string());
        }
        run.events.push_back(ev.clone());
        while run.events.len() > KEEP_LINES {
            run.events.pop_front();
        }
    }
    let _ = app.emit("release-build-event", ev);
}

#[tauri::command]
pub async fn release_build_catalog() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let script = script_path();
        if !script.is_file() {
            return Err(UNAVAILABLE.to_string());
        }
        let script = script.to_str().ok_or("Build Catalog Failed: Path Is Not Unicode")?;
        let out = crate::deps::run_bounded(
            OsStr::new("pwsh.exe"),
            &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-List"],
            CATALOG_TIMEOUT,
        )
        .ok_or("Build Catalog Failed")?;
        serde_json::from_str::<Value>(out.trim()).map_err(|_| "Build Catalog Failed: Not JSON".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn pump(app: AppHandle, stream: impl Read + Send + 'static, from_stdout: bool) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        for line in BufReader::new(stream).split(b'\n').map_while(Result::ok) {
            let text = String::from_utf8_lossy(&line);
            let text = text.trim_end_matches('\r');
            if text.is_empty() {
                continue;
            }
            publish(&app, wrap_line(&cap_line(text), from_stdout));
        }
    })
}

#[tauri::command]
pub fn release_build_start(app: AppHandle, base: String, include: Vec<String>) -> Result<(), String> {
    if !valid_id(&base) || !include.iter().all(|i| valid_id(i)) {
        return Err("Build Refused: Bad Module Id".into());
    }
    if include.is_empty() {
        return Err("Build Refused: Nothing Selected".into());
    }
    let script = script_path();
    if !script.is_file() {
        return Err(UNAVAILABLE.into());
    }
    let mut run = lock_run()?;
    if run.running {
        return Err("Build Already Running".into());
    }
    if crate::swap_button::swap_state().running {
        return Err("Swap Already Running".into());
    }
    let mut cmd = Command::new("pwsh.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .arg("-Base")
        .arg(&base)
        .arg("-Include")
        .arg(include.join(","))
        .current_dir(crate::paths::root())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    for (key, _) in std::env::vars_os() {
        if crate::swap_button::is_scrubbed(&key.to_string_lossy()) {
            cmd.env_remove(&key);
        }
    }
    let mut child = JobChild::spawn(&mut cmd).map_err(|e| format!("Build Failed: {e}"))?;
    let stdout = child.stdout.take().ok_or("Build Failed: No Stdout")?;
    let stderr = child.stderr.take().ok_or("Build Failed: No Stderr")?;
    let pid = child.id();
    let child = Arc::new(Mutex::new(child));
    *run = Run { running: true, child: Some(child.clone()), ..Run::default() };
    drop(run);

    let readers = [pump(app.clone(), stdout, true), pump(app.clone(), stderr, false)];
    thread::spawn(move || {
        loop {
            let done = match child.lock() {
                Ok(mut c) => !matches!(c.try_wait(), Ok(None)),
                Err(_) => true,
            };
            if done {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        // The job holds every pipe end, so the readers reach EOF once the tree is gone.
        if let Ok(mut c) = child.lock() {
            c.kill();
        }
        clear_lock(pid);
        for r in readers {
            let _ = r.join();
        }
        let (saw, cancelled) = RUN.lock().map(|r| (r.saw_result, r.cancelled)).unwrap_or((true, false));
        if !saw {
            let ev = if cancelled {
                json!({ "t": "result", "ok": false, "cancelled": true })
            } else {
                json!({ "t": "result", "ok": false, "error": "Build Failed" })
            };
            publish(&app, ev);
        }
        if let Ok(mut run) = RUN.lock() {
            run.running = false;
            run.child = None;
        }
    });
    Ok(())
}

#[tauri::command]
pub fn release_build_cancel() -> Result<(), String> {
    let child = {
        let mut run = lock_run()?;
        if !run.running {
            return Ok(());
        }
        run.cancelled = true;
        run.child.clone()
    };
    if let Some(child) = child {
        if let Ok(mut c) = child.lock() {
            c.kill();
            clear_lock(c.id());
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildState {
    running: bool,
    events: Vec<Value>,
    result: Option<Value>,
    phase: Option<String>,
}

#[tauri::command]
pub fn release_build_state() -> Result<BuildState, String> {
    let run = lock_run()?;
    Ok(BuildState {
        running: run.running,
        events: run.events.iter().cloned().collect(),
        result: run.result.clone(),
        phase: run.phase.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_friend_ids() {
        for id in ["friend", "relay", "codex", "agent-profiles", "voice-stock", "gate", "tray", "a"] {
            assert!(valid_id(id), "{id}");
        }
        assert!(valid_id(&"a".repeat(32)));
    }

    #[test]
    fn refuses_unsafe_ids() {
        for id in ["", "..\\x", "a b", "a;b", "A", "1a", "-a", "a,b", "a\nb", "a\\b", "a/b", "a$b", "a&b", "a|b"] {
            assert!(!valid_id(id), "{id:?}");
        }
        assert!(!valid_id(&"a".repeat(33)));
    }

    #[test]
    fn pattern_matches_the_contract() {
        let contract: Value = serde_json::from_str(include_str!("../../contracts/modules.json")).unwrap();
        assert_eq!(contract["idPattern"].as_str(), Some(ID_PATTERN));
    }

    #[test]
    fn json_objects_pass_and_text_is_wrapped() {
        let ev = wrap_line(r#"{"t":"phase","phase":"zip"}"#, true);
        assert_eq!(ev, json!({ "t": "phase", "phase": "zip" }));
        assert_eq!(wrap_line("Compiling vidar", true), json!({ "t": "log", "line": "Compiling vidar" }));
        assert_eq!(wrap_line("42", true), json!({ "t": "log", "line": "42" }));
        assert_eq!(wrap_line("{broken", true), json!({ "t": "log", "line": "{broken" }));
    }

    #[test]
    fn stderr_json_is_wrapped_as_a_log_line() {
        let raw = r#"{"t":"result","ok":true}"#;
        assert_eq!(wrap_line(raw, false), json!({ "t": "log", "line": raw }));
    }

    #[test]
    fn long_lines_are_capped_with_an_ellipsis() {
        let short = "a".repeat(MAX_LINE_CHARS);
        assert_eq!(cap_line(&short), short);
        let long = "é".repeat(MAX_LINE_CHARS + 50);
        let cut = cap_line(&long);
        assert_eq!(cut.chars().count(), MAX_LINE_CHARS + 1);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn phase_is_read_from_phase_events_only() {
        assert_eq!(phase_of(&json!({ "t": "phase", "phase": "zip" })), Some("zip"));
        assert_eq!(phase_of(&json!({ "t": "log", "line": "x", "phase": "zip" })), None);
        assert_eq!(phase_of(&json!({ "t": "phase" })), None);
    }

    #[test]
    fn lock_is_cleared_only_for_its_own_pid() {
        let dir = std::env::temp_dir().join(format!("vidar-rb-lock-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("release-build.json");
        std::fs::write(&path, r#"{"phase":"zip","pid":4242,"atMs":1}"#).unwrap();
        clear_lock_at(&path, 7);
        assert!(path.is_file());
        clear_lock_at(&path, 4242);
        assert!(!path.exists());
        clear_lock_at(&path, 4242);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
