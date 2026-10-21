// `!` lines in the Rendered composer: run one command through Git Bash and hand back
// the output. One runner: `bash.exe -c <command>`, non-login, stdin null, no window, the
// agent-session env scrubbed, the whole process tree in a Job Object that a timeout ends,
// and an output cap per stream (head and tail kept, marker between).
//
// Trust model. The caller is the trusted local frontend; at the IPC level this adds nothing
// `spawn_pty` does not already allow, and the DevTools port is opt-in and already owns the UI.
// The real boundary is inside the frontend: only a keyboard Enter in the tab's own composer
// runs a `!` line. Bus `prompt` (sendPrompt) never reaches it, and bus `write`, voice, drive
// `send` and Astra all use `write()`, which leaves a `!` line unsent, so a sandboxed agent in
// another tab cannot escape through a Claude tab. Synthetic keydowns are not filtered.
//
// Bash is found, never assumed: CLAUDE_CODE_GIT_BASH_PATH, else the Git for Windows that owns
// `git.exe` on PATH. A bare `bash.exe` on PATH can be System32\bash.exe (WSL): never used.

use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::proc_job::JobChild;
use crate::pty::SCRUBBED_ENV;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const RUN_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_COMMAND: usize = 16 * 1024;
const STREAM_CAP: usize = 30_000;
const KEEP_HEAD: usize = STREAM_CAP / 2;
const KEEP_TAIL: usize = STREAM_CAP / 2;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BangResult {
    stdout: String,
    stderr: String,
    code: Option<i32>,
    timed_out: bool,
    truncated: bool,
}

#[tauri::command]
pub async fn bang_run(cwd: String, command: String) -> Result<BangResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate(&cwd, &command)?;
        let git = crate::which::find_on_path_exact("git.exe");
        let override_path = std::env::var("CLAUDE_CODE_GIT_BASH_PATH").ok();
        let bash = resolve_bash(override_path.as_deref(), git.as_deref()).ok_or_else(|| {
            "Git Bash was not found. Install Git for Windows or set CLAUDE_CODE_GIT_BASH_PATH.".to_string()
        })?;
        run(&bash, Path::new(&cwd), &command, RUN_TIMEOUT)
    })
    .await
    .map_err(|e| format!("bang task failed: {e}"))?
}

fn validate(cwd: &str, command: &str) -> Result<(), String> {
    let p = Path::new(cwd);
    if !p.is_absolute() {
        return Err("cwd must be an absolute path".into());
    }
    if !p.exists() {
        return Err(format!("cwd does not exist: {cwd}"));
    }
    if !p.is_dir() {
        return Err(format!("cwd is not a directory: {cwd}"));
    }
    if command.trim().is_empty() {
        return Err("command is empty".into());
    }
    if command.len() > MAX_COMMAND {
        return Err(format!("command is longer than {MAX_COMMAND} bytes"));
    }
    if command.contains('\0') {
        return Err("command contains a NUL".into());
    }
    Ok(())
}

/// WSL's launcher (`System32\bash.exe`) and the Store alias directory are never Git Bash.
fn is_wsl_or_alias(p: &Path) -> bool {
    let s = p.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
    s.contains("\\system32\\") || s.contains("\\syswow64\\") || s.contains("\\sysnative\\") || s.contains("\\windowsapps\\")
}

fn usable(p: &Path) -> bool {
    p.is_file() && !is_wsl_or_alias(p)
}

/// Inputs injected so tests need no real Git: `override_path` is the value of
/// CLAUDE_CODE_GIT_BASH_PATH, `git_exe` the `git.exe` found on PATH. From `git.exe`'s
/// directory, look for `bin\bash.exe` there and at most two levels up
/// (`Git\cmd\git.exe` -> `Git\bin`, `Git\mingw64\bin\git.exe` -> `Git\bin`).
pub(crate) fn resolve_bash(override_path: Option<&str>, git_exe: Option<&Path>) -> Option<PathBuf> {
    if let Some(o) = override_path.map(str::trim).filter(|o| !o.is_empty()) {
        let p = PathBuf::from(o);
        if usable(&p) {
            return Some(p);
        }
    }
    let mut dir = git_exe?.parent()?.to_path_buf();
    for _ in 0..3 {
        let cand = dir.join("bin").join("bash.exe");
        if usable(&cand) {
            return Some(cand);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

/// Reads a pipe to the end, keeping the first KEEP_HEAD and last KEEP_TAIL bytes.
fn drain<R: Read>(mut r: R) -> (Vec<u8>, Vec<u8>, usize) {
    let mut head: Vec<u8> = Vec::new();
    let mut tail: Vec<u8> = Vec::new();
    let mut total = 0usize;
    let mut chunk = [0u8; 16 * 1024];
    loop {
        match r.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                total += n;
                let mut data = &chunk[..n];
                if head.len() < KEEP_HEAD {
                    let take = (KEEP_HEAD - head.len()).min(data.len());
                    head.extend_from_slice(&data[..take]);
                    data = &data[take..];
                }
                if !data.is_empty() {
                    tail.extend_from_slice(data);
                    if tail.len() > KEEP_TAIL * 2 {
                        let cut = tail.len() - KEEP_TAIL;
                        tail.drain(..cut);
                    }
                }
            }
        }
    }
    (head, tail, total)
}

/// Bytes bound chars, so a stream within STREAM_CAP bytes is within STREAM_CAP chars.
fn assemble((head, tail, total): (Vec<u8>, Vec<u8>, usize)) -> (String, bool) {
    if total <= STREAM_CAP {
        let mut all = head;
        all.extend_from_slice(&tail);
        return (String::from_utf8_lossy(&all).into_owned(), false);
    }
    let tail_keep = tail.len().min(KEEP_TAIL);
    let tail = &tail[tail.len() - tail_keep..];
    let dropped = total - head.len() - tail.len();
    let text = format!(
        "{}\n[... {dropped} bytes omitted ...]\n{}",
        String::from_utf8_lossy(&head),
        String::from_utf8_lossy(tail)
    );
    (text, true)
}

fn run(bash: &Path, cwd: &Path, command: &str, timeout: Duration) -> Result<BangResult, String> {
    let mut cmd = Command::new(bash);
    cmd.arg("-c")
        .arg(command)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    for key in SCRUBBED_ENV {
        cmd.env_remove(key);
    }
    cmd.env_remove("VIDAR_TAB");
    cmd.env_remove("VIDAR_TAB_NAME");
    let mut child = JobChild::spawn(&mut cmd).map_err(|e| format!("Git Bash not runnable: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let out_t = thread::spawn(move || drain(stdout));
    let err_t = thread::spawn(move || drain(stderr));
    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                if started.elapsed() >= timeout {
                    timed_out = true;
                    child.kill();
                    break child.wait().ok();
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(e) => {
                child.kill();
                return Err(format!("wait failed: {e}"));
            }
        }
    };
    // bash is gone, but a backgrounded grandchild (`sleep 600 &`) still holds the pipes and
    // would keep the readers (and this call) open past the timeout: end the whole job now.
    child.kill();
    // With the job ended every pipe holder is gone, so the readers reach EOF.
    let out = out_t.join().map_err(|_| "stdout reader panicked")?;
    let err = err_t.join().map_err(|_| "stderr reader panicked")?;
    let (stdout, t1) = assemble(out);
    let (stderr, t2) = assemble(err);
    Ok(BangResult {
        stdout,
        stderr,
        code: if timed_out { None } else { status.and_then(|s| s.code()) },
        timed_out,
        truncated: t1 || t2,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vidar-bang-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn touch(p: &Path) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, b"").unwrap();
    }

    #[test]
    fn rejects_bad_cwd_and_command() {
        let here = std::env::current_dir().unwrap();
        let here = here.to_str().unwrap();
        assert!(validate("relative\\dir", "ls").is_err());
        assert!(validate("C:\\definitely\\not\\here\\vidar", "ls").is_err());
        assert!(validate(here, "").is_err());
        assert!(validate(here, "   ").is_err());
        assert!(validate(here, "a\0b").is_err());
        assert!(validate(here, &"x".repeat(MAX_COMMAND + 1)).is_err());
        assert!(validate(here, "ls").is_ok());
    }

    #[test]
    fn resolver_finds_git_bin_from_cmd_and_mingw64() {
        let root = tmp("resolve");
        let bash = root.join("Git").join("bin").join("bash.exe");
        touch(&bash);
        let cmd_git = root.join("Git").join("cmd").join("git.exe");
        let mingw_git = root.join("Git").join("mingw64").join("bin").join("git.exe");
        touch(&cmd_git);
        touch(&mingw_git);
        assert_eq!(resolve_bash(None, Some(&cmd_git)), Some(bash.clone()));
        assert_eq!(resolve_bash(None, Some(&mingw_git)), Some(bash.clone()));
        assert_eq!(resolve_bash(None, None), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolver_never_returns_system32() {
        let root = tmp("wsl");
        let wsl = root.join("Windows").join("System32").join("bash.exe");
        touch(&wsl);
        assert_eq!(resolve_bash(Some(wsl.to_str().unwrap()), None), None);
        // a git.exe whose walk-up lands on System32\bin\bash.exe is refused too
        let sys_bin = root.join("Windows").join("System32").join("bin").join("bash.exe");
        let git = root.join("Windows").join("System32").join("cmd").join("git.exe");
        touch(&sys_bin);
        touch(&git);
        assert_eq!(resolve_bash(None, Some(&git)), None);
        // a good override wins over a git walk
        let good = root.join("Git").join("bin").join("bash.exe");
        touch(&good);
        assert_eq!(resolve_bash(Some(good.to_str().unwrap()), Some(&git)), Some(good));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn caps_keep_head_and_tail() {
        let data: Vec<u8> = (0..100_000u32).map(|i| b'a' + (i % 26) as u8).collect();
        let (text, truncated) = assemble(drain(&data[..]));
        assert!(truncated);
        assert!(text.chars().count() <= STREAM_CAP + 64);
        assert!(text.contains("bytes omitted"));
        assert!(text.starts_with("abcdef"));
        let small = assemble(drain(&b"hello"[..]));
        assert_eq!(small, ("hello".to_string(), false));
    }

    fn real_bash() -> Option<PathBuf> {
        resolve_bash(
            std::env::var("CLAUDE_CODE_GIT_BASH_PATH").ok().as_deref(),
            crate::which::find_on_path_exact("git.exe").as_deref(),
        )
    }

    #[test]
    fn runs_and_times_out() {
        let Some(bash) = real_bash() else {
            eprintln!("skip: no Git Bash");
            return;
        };
        let cwd = std::env::current_dir().unwrap();
        let ok = run(&bash, &cwd, "echo hi; echo err >&2; exit 3", Duration::from_secs(20)).unwrap();
        assert_eq!(ok.stdout.trim(), "hi");
        assert_eq!(ok.stderr.trim(), "err");
        assert_eq!(ok.code, Some(3));
        assert!(!ok.timed_out);

        let started = Instant::now();
        let r = run(&bash, &cwd, "sleep 30", Duration::from_secs(1)).unwrap();
        assert!(r.timed_out);
        assert_eq!(r.code, None);
        // readers only finish once the job's processes are gone
        assert!(started.elapsed() < Duration::from_secs(10), "job was not killed");
    }

    /// A Windows pid is alive when `tasklist` lists it.
    fn pid_alive(pid: u32) -> bool {
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .expect("tasklist");
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    }

    #[test]
    fn background_child_does_not_hold_the_run() {
        let Some(bash) = real_bash() else {
            eprintln!("skip: no Git Bash");
            return;
        };
        let cwd = std::env::current_dir().unwrap();
        let started = Instant::now();
        // the sleep's Windows pid, printed before bash exits and leaves it holding the pipes
        let r = run(&bash, &cwd, "sleep 30 & cat /proc/$!/winpid", Duration::from_secs(60)).unwrap();
        assert!(started.elapsed() < Duration::from_secs(5), "run waited on the backgrounded sleep");
        assert!(!r.timed_out);
        assert_eq!(r.code, Some(0));
        let pid: u32 = r.stdout.trim().parse().unwrap_or_else(|_| panic!("winpid: {:?}", r.stdout));
        assert!(!pid_alive(pid), "the backgrounded sleep {pid} still runs");
    }
}
