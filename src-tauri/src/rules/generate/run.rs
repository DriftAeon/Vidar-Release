//! src-tauri\src\rules\generate\run.rs — spawning the tab's agent for one generation and reading what it
//! printed (plan Design "Runner", D1, D5, W0 result). Pure builders (`claude_argv`, `codex_argv`, `child_env`),
//! the capped, stoppable child run (`execute_until`; `execute` is it without a stop) and the classification of its
//! output (`classify`). Nothing here picks a model, home or file: `commands.rs` does, and tests inject the runner.
//! - Claude: `claude -p ... --tools "" --setting-sources "" --system-prompt-file <skill copy>`, the input on stdin;
//!   the reply is one JSON object (`result`, `total_cost_usd`, `usage`).
//! - Codex: `node codex.js exec --json --sandbox read-only ... -`, the skill, a blank line and the input on stdin;
//!   the reply is JSONL (last `item.completed` agent message, `turn.completed.usage`; cost null).
//! - The env is the parent's minus every agent/Vidar variable (`Build-Env` of `tools/bare/probe-generate.ps1`),
//!   plus the overlay that points the profile folders and the agent's config dir into the generator home.
//! - The child is assigned to its call's own `Job` before its stdin is written; stdout and stderr are each capped at
//!   `OUT_CAP` (overflow ends the child and is `output:`), the call's timeout (`CHUNK_TIMEOUT`, `MERGE_TIMEOUT`) ends
//!   it as `timeout`, and a true `stop()` ends it as `cancelled`.
//! - Classification uses the exit status plus the result JSON's error fields and the two auth signatures W0
//!   recorded (Claude `is_error` with a `result` starting `Not logged in`; Codex `error`/`turn.failed` events
//!   naming `401 Unauthorized`), plus a refused login (`AUTH_REFUSED`: an expired or revoked OAuth token, a 401,
//!   `invalid_grant`, a "Please run /login" variant): auth is `login:`, another nonzero exit `spawn:`, no
//!   parseable result `output:`.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::Value;

use super::home;
use crate::job::Job;

/// stdout and stderr are each held to this many bytes.
pub const OUT_CAP: usize = 4 * 1024 * 1024;
/// The longest one chunk call may run.
pub const CHUNK_TIMEOUT: Duration = Duration::from_secs(6 * 60);
/// The longest the merge call may run.
pub const MERGE_TIMEOUT: Duration = Duration::from_secs(8 * 60);
/// Each stream tail kept in a timeout's text.
const TAIL_CHARS: usize = 300;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Names the child never inherits (`Build-Env`): the agents' own config and credential variables and Vidar's.
const DROP_PREFIXES: [&str; 7] = ["ANTHROPIC_", "CLAUDE", "CODEX_", "OPENAI_", "VIDAR_", "FALCON_", "DISABLE_AUTOUPDATER"];

/// `claude` arguments for one generation. The system prompt is the skill copy in the generator home; the input
/// goes on stdin. `--tools ""` and `--setting-sources ""` carry empty values on purpose (W0 proved both).
pub fn claude_argv(model: &str, effort: &str, skill_path: &Path) -> Vec<String> {
    let mut a: Vec<String> = ["-p", "--model"].map(String::from).into();
    a.extend([model.to_string(), "--effort".into(), effort.to_string()]);
    a.extend(
        ["--output-format", "json", "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "", "--system-prompt-file"]
            .map(String::from),
    );
    a.push(skill_path.to_string_lossy().into_owned());
    a
}

/// `codex` arguments (after the script path) for one generation; the prompt is stdin (`-`).
pub fn codex_argv(model: &str, effort: &str, cwd: &Path) -> Vec<String> {
    let mut a: Vec<String> = ["exec", "--json", "--sandbox", "read-only", "-c", "approval_policy=\"never\"", "-c"].map(String::from).into();
    a.push(format!("model=\"{model}\""));
    a.push("-c".into());
    a.push(format!("model_reasoning_effort=\"{effort}\""));
    a.extend(["--skip-git-repo-check", "--ephemeral", "-C"].map(String::from));
    a.push(cwd.to_string_lossy().into_owned());
    a.push("-".into());
    a
}

/// The child's env: `parent` without the dropped prefixes (case-insensitive), then the overlay for the generator
/// home `home`. Claude adds `CLAUDE_CONFIG_DIR` and `DISABLE_AUTOUPDATER=1`, Codex `CODEX_HOME`.
pub fn child_env(parent: impl IntoIterator<Item = (OsString, OsString)>, agent: &str, home: &Path) -> Vec<(OsString, OsString)> {
    let mut map: BTreeMap<String, (OsString, OsString)> = BTreeMap::new();
    for (k, v) in parent {
        let key = k.to_string_lossy().to_ascii_uppercase();
        if !DROP_PREFIXES.iter().any(|p| key.starts_with(p)) {
            map.insert(key, (k, v));
        }
    }
    let user = home.join(home::USER_HOME);
    let config = home.join(home::CONFIG);
    let path = |p: &Path| p.to_string_lossy().into_owned();
    let mut overlay: Vec<(&str, String)> = vec![
        ("USERPROFILE", path(&user)),
        ("HOME", path(&user)),
        ("APPDATA", path(&user.join("AppData").join("Roaming"))),
        ("LOCALAPPDATA", path(&user.join("AppData").join("Local"))),
        ("TEMP", path(&user.join("AppData").join("Local").join("Temp"))),
        ("TMP", path(&user.join("AppData").join("Local").join("Temp"))),
    ];
    if agent == "claude" {
        overlay.push(("CLAUDE_CONFIG_DIR", path(&config)));
        overlay.push(("DISABLE_AUTOUPDATER", "1".into()));
    } else {
        overlay.push(("CODEX_HOME", path(&config)));
    }
    for (k, v) in overlay {
        map.insert(k.to_string(), (OsString::from(k), OsString::from(v)));
    }
    map.into_values().collect()
}

/// A process to run: program, arguments, env, cwd and the text for its stdin.
#[derive(Debug)]
pub struct Spec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(OsString, OsString)>,
    pub cwd: PathBuf,
    /// The agent's config dir; with `cwd` it is checked for instruction files right before the spawn (`None`: only `cwd`).
    pub config: Option<PathBuf>,
    pub stdin: String,
}

/// What a finished (or ended) child left.
#[derive(Debug, Default)]
pub struct Raw {
    pub exit: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// `stdout` or `stderr` when it went over the cap.
    pub overflow: Option<&'static str>,
    pub timed_out: bool,
    /// `stop()` ended the child.
    pub cancelled: bool,
}

#[derive(Deserialize)]
struct CodexProfile {
    binary: crate::bare::CodexBinary,
    host: Host,
}

#[derive(Deserialize)]
struct Host {
    name: String,
}

fn env_path_dirs(env: &[(OsString, OsString)]) -> Vec<PathBuf> {
    env.iter()
        .find(|(k, _)| k.to_string_lossy().eq_ignore_ascii_case("path"))
        .map(|(_, v)| std::env::split_paths(v).filter(|d| !d.as_os_str().is_empty()).collect())
        .unwrap_or_default()
}

/// The program and its leading arguments for `agent`: `claude.exe` as the Flow runner finds it, or `node` plus the
/// `codex.js` the Bare Codex resolver finds beside a `codex` shim (profile `profiles/bare/codex.json`).
pub fn resolve_exe(agent: &str, root: &Path, env: &[(OsString, OsString)]) -> Result<(PathBuf, Vec<String>), String> {
    if agent == "claude" {
        let exe = crate::deps::claude_exe().ok_or("spawn: Claude Code was not found; install it first")?;
        return Ok((exe, Vec::new()));
    }
    let path = root.join("profiles").join("bare").join("codex.json");
    let p: CodexProfile = crate::fsx::read_json(&path).map_err(|e| format!("spawn: launch profile {}: {e}", path.display()))?;
    let dirs = env_path_dirs(env);
    let mut bare_env = crate::bare::Env::default();
    if let Some((_, v)) = env.iter().find(|(k, _)| k.to_string_lossy().eq_ignore_ascii_case("path")) {
        bare_env.set("Path", v.clone());
    }
    let (js, _) = crate::bare::resolve_codex(&bare_env, &p.binary)
        .ok_or_else(|| format!("spawn: {} was not found beside a {} shim on the Path", p.binary.script, p.binary.shims.join(" or ")))?;
    let node = crate::which::find_in(&dirs, &p.host.name).ok_or_else(|| format!("spawn: {} was not found on the Path", p.host.name))?;
    Ok((node, vec![js.to_string_lossy().into_owned()]))
}

fn read_capped(mut r: impl Read, cap: usize, flag: Arc<AtomicBool>) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match r.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > cap {
                    buf.truncate(cap);
                    flag.store(true, Ordering::SeqCst);
                    break;
                }
            }
        }
    }
    buf
}

/// `execute_until` with no stop signal.
pub fn execute(spec: &Spec, job: &Job, timeout: Duration, cap: usize) -> Result<Raw, String> {
    execute_until(spec, job, timeout, cap, || false)
}

/// Runs `spec` under `job`: assigned before stdin is written, output capped at `cap` bytes per stream, ended at
/// `timeout`, and ended (`Raw::cancelled`) as soon as `stop()` is true. `job.terminate()` from another thread
/// (Cancel) ends the child like any exit; the caller knows why.
pub fn execute_until(spec: &Spec, job: &Job, timeout: Duration, cap: usize, stop: impl Fn() -> bool) -> Result<Raw, String> {
    // The W0 clean-home check, immediately before the spawn.
    super::home::assert_dirs_clean(spec.config.iter().chain(std::iter::once(&spec.cwd)).map(PathBuf::as_path))?;
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .env_clear()
        .envs(spec.env.iter().map(|(k, v)| (k, v)))
        .current_dir(&spec.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn().map_err(|e| format!("spawn: {} did not start ({e})", spec.program.display()))?;
    if let Err(e) = job.assign(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("spawn: the child could not join its job object ({e})"));
    }
    let (out_flag, err_flag) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
    let stdin = child.stdin.take();
    let text = spec.stdin.clone();
    let writer = std::thread::spawn(move || {
        if let Some(mut s) = stdin {
            let _ = s.write_all(text.as_bytes());
        }
    });
    let out = child.stdout.take().map(|s| {
        let f = out_flag.clone();
        std::thread::spawn(move || read_capped(s, cap, f))
    });
    let err = child.stderr.take().map(|s| {
        let f = err_flag.clone();
        std::thread::spawn(move || read_capped(s, cap, f))
    });

    let start = Instant::now();
    let mut timed_out = false;
    let mut cancelled = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {}
            Err(e) => {
                job.terminate();
                return Err(format!("spawn: waiting on the child failed ({e})"));
            }
        }
        if out_flag.load(Ordering::SeqCst) || err_flag.load(Ordering::SeqCst) {
            job.terminate();
        }
        // Checked after the assign above, so a stop raised before the child joined its job still ends it.
        if !cancelled && stop() {
            cancelled = true;
            job.terminate();
        }
        if !timed_out && start.elapsed() >= timeout {
            timed_out = true;
            job.terminate();
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    // Stragglers holding the pipes open would block the readers.
    job.terminate();
    let _ = writer.join();
    let stdout = out.map(|h| h.join().unwrap_or_default()).unwrap_or_default();
    let stderr = err.map(|h| h.join().unwrap_or_default()).unwrap_or_default();
    let overflow = if out_flag.load(Ordering::SeqCst) {
        Some("stdout")
    } else if err_flag.load(Ordering::SeqCst) {
        Some("stderr")
    } else {
        None
    };
    Ok(Raw { exit: status.code(), stdout, stderr, overflow, timed_out, cancelled })
}

/// The agent's reply and what it reported about the run.
#[derive(Debug, PartialEq)]
pub struct Reply {
    pub text: String,
    pub cost_usd: Option<f64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

/// One line of at most `n` characters, whitespace collapsed.
fn head(s: &str, n: usize) -> String {
    let one = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > n {
        format!("{}…", one.chars().take(n).collect::<String>())
    } else {
        one
    }
}

fn code(raw: &Raw) -> String {
    raw.exit.map_or_else(|| "no exit code".to_string(), |c| format!("exit code {c}"))
}

/// Signatures of a login the service refused beyond "Not logged in": an expired or revoked OAuth token, a 401, a
/// rotated refresh token, a "/login" prompt (both agents; matched lowercased).
const AUTH_REFUSED: [&str; 12] = [
    "oauth token has expired",
    "oauth token revoked",
    "token has expired",
    "token expired",
    "token revoked",
    "invalid_grant",
    "refresh_token_reused",
    "authentication_error",
    "api error: 401",
    "401 unauthorized",
    "please run /login",
    "invalid api key",
];

/// True when `text` names a refused login (`AUTH_REFUSED`).
pub fn auth_refused(text: &str) -> bool {
    let low = text.to_lowercase();
    AUTH_REFUSED.iter().any(|s| low.contains(s))
}

const CLAUDE_EXPIRED: &str = "login: Claude's login has expired or was revoked; log in on a Bare Claude tab first";
const CODEX_EXPIRED: &str = "login: Codex's login has expired or was revoked; log in on a Bare Codex tab first";

fn claude_reply(raw: &Raw) -> Result<Reply, String> {
    let out = String::from_utf8_lossy(&raw.stdout);
    let json: Option<Value> = serde_json::from_str::<Value>(out.trim()).ok().filter(Value::is_object);
    let result = json.as_ref().and_then(|j| j.get("result")).and_then(Value::as_str);
    let is_error = json.as_ref().and_then(|j| j.get("is_error")).and_then(Value::as_bool).unwrap_or(false);
    let stderr = String::from_utf8_lossy(&raw.stderr);
    if raw.exit != Some(0) {
        if is_error && result.is_some_and(|r| r.starts_with("Not logged in")) {
            return Err("login: Claude is not logged in; log in on a Bare Claude tab first".into());
        }
        if result.is_some_and(auth_refused) || (result.is_none() && auth_refused(&stderr)) {
            return Err(CLAUDE_EXPIRED.into());
        }
        let why = result.map(str::to_string).unwrap_or_else(|| stderr.into_owned());
        return Err(format!("spawn: claude ended with {}: {}", code(raw), head(&why, 300)));
    }
    let Some(json) = json.as_ref() else { return Err("output: claude printed no JSON result".into()) };
    if is_error && result.is_some_and(auth_refused) {
        return Err(CLAUDE_EXPIRED.into());
    }
    if is_error {
        return Err(format!("output: claude reported an error: {}", head(result.unwrap_or(""), 300)));
    }
    let Some(text) = result else { return Err("output: claude's JSON result holds no `result` text".into()) };
    let usage = json.get("usage");
    Ok(Reply {
        text: text.to_string(),
        cost_usd: json.get("total_cost_usd").and_then(Value::as_f64),
        input_tokens: usage.and_then(|u| u.get("input_tokens")).and_then(Value::as_u64),
        output_tokens: usage.and_then(|u| u.get("output_tokens")).and_then(Value::as_u64),
    })
}

fn event_message(e: &Value) -> Option<&str> {
    e.get("message").or_else(|| e.get("error").and_then(|x| x.get("message"))).and_then(Value::as_str)
}

fn codex_reply(raw: &Raw) -> Result<Reply, String> {
    let out = String::from_utf8_lossy(&raw.stdout);
    let events: Vec<Value> = out
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with('{'))
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect();
    let kind = |e: &Value| e.get("type").and_then(Value::as_str).unwrap_or("").to_string();
    if raw.exit != Some(0) {
        let failures: Vec<&str> = events.iter().filter(|e| matches!(kind(e).as_str(), "error" | "turn.failed")).filter_map(event_message).collect();
        if failures.iter().any(|m| m.contains("401 Unauthorized")) {
            return Err("login: Codex is not logged in; log in on a Bare Codex tab first".into());
        }
        let stderr = String::from_utf8_lossy(&raw.stderr);
        if failures.iter().any(|m| auth_refused(m)) || (failures.is_empty() && auth_refused(&stderr)) {
            return Err(CODEX_EXPIRED.into());
        }
        let why = failures.last().map(|m| m.to_string()).unwrap_or_else(|| stderr.into_owned());
        return Err(format!("spawn: codex ended with {}: {}", code(raw), head(&why, 300)));
    }
    let text = events
        .iter()
        .rev()
        .filter(|e| kind(e) == "item.completed")
        .filter_map(|e| e.get("item"))
        .find(|i| i.get("type").and_then(Value::as_str) == Some("agent_message"))
        .and_then(|i| i.get("text"))
        .and_then(Value::as_str);
    let Some(text) = text else { return Err("output: codex printed no agent message".into()) };
    let usage = events.iter().rev().find(|e| kind(e) == "turn.completed").and_then(|e| e.get("usage"));
    Ok(Reply {
        text: text.to_string(),
        cost_usd: None,
        input_tokens: usage.and_then(|u| u.get("input_tokens")).and_then(Value::as_u64),
        output_tokens: usage.and_then(|u| u.get("output_tokens")).and_then(Value::as_u64),
    })
}

/// One line of the last `n` characters of `bytes`, whitespace collapsed.
fn tail(bytes: &[u8], n: usize) -> String {
    let one = String::from_utf8_lossy(bytes).split_whitespace().collect::<Vec<_>>().join(" ");
    let count = one.chars().count();
    if count > n {
        format!("…{}", one.chars().skip(count - n).collect::<String>())
    } else {
        one
    }
}

/// The text after `timeout: `: what the child had printed, so a silent hang and a slow reply tell apart. Self-contained,
/// so the pipeline can splice `<part> after <s> s` in front of it.
fn timeout_text(raw: &Raw) -> String {
    let mut parts: Vec<String> = Vec::new();
    for (name, bytes) in [("stdout", &raw.stdout), ("stderr", &raw.stderr)] {
        let t = tail(bytes, TAIL_CHARS);
        if !t.is_empty() {
            parts.push(format!("{name} tail: {t}"));
        }
    }
    let out = String::from_utf8_lossy(&raw.stdout);
    if let Some(json) = serde_json::from_str::<Value>(out.trim()).ok().filter(Value::is_object) {
        if let Some(n) = json.get("usage").and_then(|u| u.get("output_tokens")).and_then(Value::as_u64) {
            parts.push(format!("output tokens: {n}"));
        }
        if let Some(r) = json.get("stop_reason").and_then(Value::as_str) {
            parts.push(format!("stop reason: {r}"));
        }
    }
    if parts.is_empty() {
        "no output".into()
    } else {
        parts.join("; ")
    }
}

/// The run's outcome as an IPC result: `cancelled`, `timeout: …`, or an error with its prefix, or the reply.
pub fn classify(agent: &str, raw: &Raw) -> Result<Reply, String> {
    if raw.cancelled {
        return Err("cancelled".into());
    }
    if raw.timed_out {
        return Err(format!("timeout: {}", timeout_text(raw)));
    }
    if let Some(stream) = raw.overflow {
        return Err(format!("output: {stream} went over {} MB", OUT_CAP / (1024 * 1024)));
    }
    if agent == "claude" {
        claude_reply(raw)
    } else {
        codex_reply(raw)
    }
}

#[cfg(test)]
#[path = "run_tests.rs"]
mod tests;
