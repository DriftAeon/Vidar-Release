// Speak: the bottom-bar button left of the close lock. Runs
// speak.py under contract id localVoice — session transcript → rewrite slot → tts slot (voice slots, passed
// as --slots-file) → speakers — as a child and returns the one JSON line
// it prints. Any failure is a string the button shows in its tooltip, and
// also lands in the journal (`journal`, below) with the run's
// full stderr, so a slow or failed boot is debuggable after the fact instead
// of from memory. One child at a time; `speak_stop` kills it, which also
// stops playback (winsound plays inside that process). Every speak.py run is a
// `JobChild` (kill-on-close job): Stop, or Vidar exiting or crashing,
// ends the venv stub's real interpreter, the adapters and playback, not
// just the stub. The job allows explicit breakaway, so the Kokoro process the
// tts adapter starts (CREATE_BREAKAWAY_FROM_JOB) outlives the run on purpose, as does
// an LM Studio server an adapter brings up. When Vidar's own job forbids breakaway, every
// Speak first runs `--arm` outside any job of ours (Kokoro and the rewrite server come up in
// Vidar's job), then the run in a plain kill-on-close job, so Stop still ends playback
// (`spawn_run`). `speak_status` and `speak_off` run the tts slot's own `status` and
// `stop` with `{owner}` = `OWNER`. The waits run in spawn_blocking,
// off the webview thread.
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::proc_job::JobChild;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const JOURNAL_MAX_BYTES: u64 = 1024 * 1024;
/// The lifecycle `{owner}` Vidar passes (contracts/voice-slots.json `lifecycle.owner`): to every
/// speak.py run as `--owner`, and into the tts slot's `stop`/`status`. The Kokoro adapter tags
/// the warm process with it, so the launch stop ends only one Vidar started.
const OWNER: &str = "vidar";

/// Local wall-clock time as RFC3339 (kernel32 `GetLocalTime` for the fields,
/// `GetTimeZoneInformation` for the UTC offset — no time crate in this
/// dependency tree).
fn rfc3339_local() -> String {
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct SystemTime {
        w_year: u16,
        w_month: u16,
        w_day_of_week: u16,
        w_day: u16,
        w_hour: u16,
        w_minute: u16,
        w_second: u16,
        w_milliseconds: u16,
    }
    #[repr(C)]
    struct TimeZoneInformation {
        bias: i32,
        standard_name: [u16; 32],
        standard_date: SystemTime,
        standard_bias: i32,
        daylight_name: [u16; 32],
        daylight_date: SystemTime,
        daylight_bias: i32,
    }
    extern "system" {
        fn GetLocalTime(time: *mut SystemTime);
        fn GetTimeZoneInformation(info: *mut TimeZoneInformation) -> u32;
    }
    let mut local = SystemTime::default();
    // SAFETY: `local` is a valid, correctly-sized out-pointer for this call.
    unsafe { GetLocalTime(&mut local) };
    let mut tzi: TimeZoneInformation = unsafe { std::mem::zeroed() };
    // SAFETY: `tzi` is a valid, correctly-sized out-pointer for this call.
    let active = unsafe { GetTimeZoneInformation(&mut tzi) };
    let extra_bias = if active == 2 { tzi.daylight_bias } else { tzi.standard_bias };
    let offset_minutes = -(tzi.bias + extra_bias);
    let sign = if offset_minutes < 0 { '-' } else { '+' };
    let abs = offset_minutes.abs();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{sign}{:02}:{:02}",
        local.w_year, local.w_month, local.w_day, local.w_hour, local.w_minute, local.w_second,
        abs / 60, abs % 60,
    )
}

static JOURNAL: Mutex<()> = Mutex::new(());

/// Append one boot/run outcome to the speak journal: a header line, the
/// run's stderr verbatim, then a blank line. Diagnostic only — every error
/// in here is swallowed, never surfaced to the caller. `kind` is `"speak"`
/// (from `run`) or the `aux` flag name (`"arm"` | `"status"` | `"stop"`).
fn journal(kind: &str, outcome: &str, stderr: &str) {
    let _guard = JOURNAL.lock().unwrap_or_else(|e| e.into_inner());
    let dir = crate::paths::speak_journal_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("speak.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > JOURNAL_MAX_BYTES {
            let _ = std::fs::rename(&path, dir.join("speak.log.1"));
        }
    }
    use std::io::Write;
    let mut file = match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(f) => f,
        Err(_) => return,
    };
    let _ = writeln!(file, "=== {} {kind} {outcome} ===", rfc3339_local());
    if !stderr.is_empty() {
        let _ = writeln!(file, "{stderr}");
    }
    let _ = writeln!(file);
}

/// The running child, if any. `None` between runs.
#[derive(Default)]
pub struct SpeakState(pub Arc<Mutex<Option<JobChild>>>);

/// `bridge\voice-slots\resolved.json` for `--slots-file`, written fresh per press so a
/// vidar.json edit applies without a restart. Only `rewrite` and `tts` are resolved: they are
/// all speak.py reads, and resolving stt would hash the whisper model on the first press.
fn slots_file(kind: &str) -> Result<String, String> {
    use crate::voice_slots::Slot;
    crate::voice_slots::write_resolved(&[Slot::Rewrite, Slot::Tts]).map(|p| p.to_string_lossy().into_owned()).map_err(|e| {
        journal(kind, &format!("slots-file-failed: {e}"), "");
        format!("Voice Slots: Cannot Write resolved.json: {e}")
    })
}

/// Set once a spawn finds that Vidar's own job forbids breakaway; it does not change while
/// Vidar runs.
static BREAKAWAY_REFUSED: AtomicBool = AtomicBool::new(false);

fn spawn_failed(kind: &str, e: String) -> String {
    journal(kind, &format!("spawn-failed: {e}"), "");
    format!("spawn {}: {e}", crate::paths::local_voice_python().display())
}

/// `--arm`: in its own kill-on-close job that allows explicit breakaway, or in none when
/// Vidar's job forbids breakaway, so the warm processes it starts outlive it either way (they
/// then live in Vidar's job). Not stoppable, so no job costs nothing here.
fn spawn_arm(cmd: &mut Command) -> Result<JobChild, String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let (child, in_job) = JobChild::spawn_breakaway_or_plain(cmd, CREATE_NO_WINDOW).map_err(|e| spawn_failed("arm", e))?;
    if !in_job {
        BREAKAWAY_REFUSED.store(true, Ordering::Relaxed);
        journal("arm", "no-job: Vidar's job forbids breakaway; the warm processes start in Vidar's job", "");
    }
    Ok(child)
}

/// The Speak run, always in a kill-on-close job so Stop ends the whole tree (playback runs in
/// speak.py's real interpreter, not the venv stub). The job allows explicit breakaway when
/// Vidar's job does. When it does not, `run` has already armed outside any job of ours
/// (`BREAKAWAY_REFUSED`), so the run's plain job only holds speak.py and its adapters, and
/// Kokoro, already up, is not in it. The first refusal is found here, unarmed: a Kokoro that
/// run starts then dies with it (one cold start; the button's first press is Arm anyway).
fn spawn_run(cmd: &mut Command) -> Result<JobChild, String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if !BREAKAWAY_REFUSED.load(Ordering::Relaxed) {
        if let Some(c) = JobChild::spawn_breakaway(cmd, CREATE_NO_WINDOW).map_err(|e| spawn_failed("speak", e))? {
            return Ok(c);
        }
        BREAKAWAY_REFUSED.store(true, Ordering::Relaxed);
        journal("speak", "no-breakaway: Vidar's job forbids breakaway; this run was not armed first", "");
    }
    cmd.creation_flags(CREATE_NO_WINDOW);
    JobChild::spawn(cmd).map_err(|e| spawn_failed("speak", e))
}

/// Reads stdout to EOF with stderr drained on its own thread, so neither pipe can fill and
/// stall the script. Lossy UTF-8: one bad byte never drops the whole stream.
fn drain(mut stdout: std::process::ChildStdout, mut stderr: std::process::ChildStderr) -> (String, String) {
    let err_thread = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = stderr.read_to_end(&mut b);
        String::from_utf8_lossy(&b).into_owned()
    });
    let mut b = Vec::new();
    let _ = stdout.read_to_end(&mut b);
    (String::from_utf8_lossy(&b).into_owned(), err_thread.join().unwrap_or_default())
}

/// Takes the child's pipes (the child stays in the caller's hands for Stop).
fn pipes(child: &mut JobChild) -> Result<(std::process::ChildStdout, std::process::ChildStderr), String> {
    Ok((child.stdout.take().ok_or("no stdout pipe")?, child.stderr.take().ok_or("no stderr pipe")?))
}

/// Which transcripts the run reads: the tab's folder, its agent and (Codex) its own CODEX_HOME.
/// All absent = the script's default, the newest transcript of either agent for the folder.
#[derive(Default, Debug)]
struct Source {
    cwd: Option<String>,
    agent: Option<String>,
    codex_home: Option<String>,
    /// A Bare Claude tab's CLAUDE_CONFIG_DIR; None = the default `~\.claude`.
    claude_home: Option<String>,
}

impl Source {
    fn args(&self) -> Vec<String> {
        let mut a = Vec::new();
        let mut put = |flag: &str, v: &Option<String>| {
            if let Some(v) = v.as_deref().filter(|v| !v.is_empty()) {
                a.push(flag.to_string());
                a.push(v.to_string());
            }
        };
        put("--cwd", &self.cwd);
        // Only the two names speak.py accepts; anything else keeps the merged search.
        let agent = self.agent.as_deref().and_then(crate::agent_spec::parse);
        put("--agent", &agent.map(|g| g.as_str().to_string()));
        // CODEX_HOME only means something to a Codex read, CLAUDE home to a Claude one.
        let (codex_home, claude_home) = match agent {
            None => (None, None),
            Some(agent) => match agent {
                crate::agent_spec::Agent::Codex => (self.codex_home.clone(), None),
                crate::agent_spec::Agent::Claude => (None, self.claude_home.clone()),
            },
        };
        put("--codex-home", &codex_home);
        put("--claude-home", &claude_home);
        a
    }
}

fn run(slot: Arc<Mutex<Option<JobChild>>>, src: Source) -> Result<serde_json::Value, String> {
    // No-breakaway fallback (spawn_run): warm outside our jobs first, off the state lock so a
    // Stop press never waits on a cold start. Costs one --arm process per Speak there, only.
    if BREAKAWAY_REFUSED.load(Ordering::Relaxed) {
        if slot.lock().map_err(|_| "speak state poisoned")?.is_some() {
            return Err("already speaking".into());
        }
        let armed = arm()?;
        if armed.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return Ok(armed);
        }
    }
    let (stdout, stderr) = {
        let mut guard = slot.lock().map_err(|_| "speak state poisoned")?;
        if guard.is_some() {
            return Err("already speaking".into());
        }
        // After the busy check: a second press never rewrites resolved.json under a live run.
        let slots = slots_file("speak")?;
        let mut cmd = Command::new(crate::paths::local_voice_python());
        cmd.arg(crate::paths::speak_script()).arg("--json");
        cmd.args(src.args());
        // `--owner`: the tts slot's {owner}, which tags a Kokoro process this run starts.
        cmd.args(["--slots-file", &slots, "--owner", OWNER]);
        let mut child = spawn_run(&mut cmd)?;
        let p = pipes(&mut child)?;
        *guard = Some(child);
        p
    };

    // Drain both pipes to EOF, then reap the child. Dropping it closes its job, which ends
    // anything the run left behind except what broke away (the Kokoro process).
    let (out, err) = drain(stdout, stderr);

    let status = {
        let mut guard = slot.lock().map_err(|_| "speak state poisoned")?;
        match guard.take() {
            Some(mut child) => child.wait().map_err(|e| format!("wait: {e}"))?,
            None => return Err("speak child vanished".into()),
        }
    };

    journal("speak", &format!("exit={status}"), &err);

    // The script's contract: its last stdout line is one JSON object, ok or
    // not. Anything else (killed, crashed before printing) is reported raw.
    if let Some(line) = out.lines().rev().find(|l| l.trim_start().starts_with('{')) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            return Ok(v);
        }
    }
    let tail: String = err.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
    Err(format!("speak.py exited {status} without a result{}{}", if tail.is_empty() { "" } else { ":\n" }, tail))
}

/// Waits for a short, untracked child (`--arm`, the tts `status`/`stop`) and returns its last
/// JSON line. Not stoppable; none should take long except `--arm` on a cold Kokoro (~5 s) or an
/// unloaded rewrite model. `what` names it in errors.
fn finish(mut child: JobChild, kind: &str, what: &str) -> Result<serde_json::Value, String> {
    let (stdout, stderr) = pipes(&mut child)?;
    let (stdout, err) = drain(stdout, stderr);
    let status: ExitStatus = child.wait().map_err(|e| format!("wait: {e}"))?;
    drop(child);
    let parsed = stdout
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .and_then(|l| serde_json::from_str::<serde_json::Value>(l).ok());
    let ok_true = parsed.as_ref().and_then(|v| v.get("ok")).and_then(|v| v.as_bool()).unwrap_or(false);
    // The voice map polls status; judge the skip on the field, not on
    // whether the process itself returned Ok.
    if !(kind == "status" && ok_true) {
        let outcome = if ok_true { "ok".to_string() } else { format!("exit={status}") };
        journal(kind, &outcome, &err);
    }
    if let Some(v) = parsed {
        return Ok(v);
    }
    let tail: Vec<&str> = err.lines().rev().take(4).collect();
    Err(format!("{what} exited {status} without a result: {}", tail.into_iter().rev().collect::<Vec<_>>().join("\n")))
}

/// `speak.py --arm`: the tts adapter's `warm`, then the rewrite adapter's.
fn arm() -> Result<serde_json::Value, String> {
    let slots = slots_file("arm")?;
    let mut cmd = Command::new(crate::paths::local_voice_python());
    cmd.arg(crate::paths::speak_script()).args(["--arm", "--slots-file", &slots, "--owner", OWNER, "--json"]);
    // Same job rule as `run`: the warm Kokoro process this starts must outlive the arm.
    let child = spawn_arm(&mut cmd)?;
    finish(child, "arm", "speak.py --arm")
}

/// The first `{name}` token left in `arg` (name: ASCII letters and digits), if any.
fn token_in(arg: &str) -> Option<&str> {
    let mut rest = arg;
    while let Some(open) = rest.find('{') {
        let after = &rest[open + 1..];
        let close = after.find('}')?;
        let name = &after[..close];
        if !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Some(name);
        }
        rest = after;
    }
    None
}

/// The tts slot's `stop` or `status` with `{owner}` = OWNER, run directly (no speak.py). A
/// slot without it: `status` reports no warm process, `stop` stops nothing. Any other token
/// left in the command is an error naming it: stop and status get `{owner}` only.
fn tts_lifecycle(what: &str) -> Result<serde_json::Value, String> {
    use crate::voice_slots::{resolve, Slot};
    let r = resolve(Slot::Tts).map_err(|e| format!("TTS Slot: {e}"))?;
    let cmd = match what {
        "stop" => r.stop,
        _ => r.status,
    };
    let Some(cmd) = cmd else {
        return Ok(match what {
            "stop" => serde_json::json!({ "ok": true, "stopped": false }),
            _ => serde_json::json!({ "ok": true, "sidecar": false }),
        });
    };
    let args: Vec<String> = cmd.args.iter().map(|a| a.replace("{owner}", OWNER)).collect();
    if let Some(left) = args.iter().find_map(|a| token_in(a)) {
        return Err(format!("TTS Slot: {} {what}: Unfilled Token {{{left}}}", r.adapter));
    }
    let mut c = Command::new(&cmd.command);
    c.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).creation_flags(CREATE_NO_WINDOW);
    let child = JobChild::spawn(&mut c).map_err(|e| {
        journal(what, &format!("spawn-failed: {e}"), "");
        format!("TTS Slot: {} {what}: Cannot Run {}: {e}", r.adapter, cmd.command.display())
    })?;
    finish(child, what, &format!("{} {what}", r.adapter))
}

/// First press of the button: the tts slot's `warm` (Kokoro up), then the rewrite adapter's
/// `warm` (openai-compat: LM Studio up and its model loaded; nothing for an empty slot or claude-p).
#[tauri::command]
pub async fn speak_arm() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(arm)
        .await
        .map_err(|e| format!("speak arm failed: {e}"))?
}

/// Is the voice already up (from an earlier Vidar, or the CLI)? The tts slot's `status`;
/// Kokoro's reports `sidecar`, `owner` and `owned` (tagged OWNER, so the launch stop may end it).
#[tauri::command]
pub async fn speak_status() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| tts_lifecycle("status"))
        .await
        .map_err(|e| format!("speak status failed: {e}"))?
}

/// The tts slot's `stop` with `{owner}` = OWNER: Kokoro's quits only while tagged OWNER, so a
/// warm process a terminal started or claimed stays up. The rewrite model stays LM Studio's business. Every
/// caller is owner-scoped (launch stop and Speak off both pass `vidar`);
/// an `ifOwned` the webview still sends is ignored.
#[tauri::command]
pub async fn speak_off() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| tts_lifecycle("stop"))
        .await
        .map_err(|e| format!("speak off failed: {e}"))?
}

/// Async: the whole run (rewrite, Kokoro, playback) can take tens of seconds.
#[tauri::command]
pub async fn speak_last(
    app: tauri::AppHandle,
    state: tauri::State<'_, SpeakState>,
    cwd: Option<String>,
    agent: Option<String>,
    tab: Option<String>,
    profile: Option<String>,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let slot = state.0.clone();
    // A Bare Codex tab runs on its own CODEX_HOME; the live session knows it (None = ~\.codex).
    let codex_home = tab
        .as_deref()
        .and_then(|id| app.state::<crate::agent::AgentManager>().codex_home(id))
        .map(|p| p.to_string_lossy().into_owned());
    // A launch-profile (Bare) Claude tab keeps its transcripts under the config dir its session
    // runs on (a combination home); a profile that resolves to nothing never falls back to the
    // user's home.
    let claude_home = match profile.as_deref().filter(|p| !p.is_empty()) {
        None => None,
        Some(p) => Some(
            crate::bare::claude_dir::home_of_session(Some(p), tab.as_deref(), crate::bare::claude_dir::hosted_session_of(&app, tab.as_deref()).as_deref(), None)
                .ok_or_else(|| format!("No Claude home for launch profile {p:?}"))?
                .to_string_lossy()
                .into_owned(),
        ),
    };
    let src = Source { cwd, agent, codex_home, claude_home };
    tauri::async_runtime::spawn_blocking(move || run(slot, src))
        .await
        .map_err(|e| format!("speak task failed: {e}"))?
}

/// Kill the running child's whole tree (job); true if there was one. `speak_last` reaps it.
#[tauri::command]
pub fn speak_stop(state: tauri::State<'_, SpeakState>) -> Result<bool, String> {
    let mut guard = state.0.lock().map_err(|_| "speak state poisoned")?;
    match guard.as_mut() {
        Some(child) => {
            child.kill();
            Ok(true)
        }
        None => Ok(false),
    }
}

#[cfg(test)]
mod source_tests {
    use super::Source;

    fn s(cwd: &str, agent: Option<&str>, home: Option<&str>) -> Source {
        Source { cwd: Some(cwd.into()), agent: agent.map(Into::into), codex_home: home.map(Into::into), claude_home: home.map(Into::into) }
    }

    #[test]
    fn an_agent_the_spec_does_not_parse_keeps_the_merged_search() {
        for bad in ["grok", "Claude", ""] {
            assert_eq!(s("C:\\p", Some(bad), Some("H")).args(), ["--cwd", "C:\\p"], "{bad:?}");
        }
    }

    #[test]
    fn no_agent_keeps_the_merged_search() {
        assert_eq!(s("C:\\p", None, Some("H")).args(), ["--cwd", "C:\\p"]);
    }

    #[test]
    fn codex_passes_agent_and_its_home() {
        assert_eq!(s("C:\\p", Some("codex"), Some("H")).args(), ["--cwd", "C:\\p", "--agent", "codex", "--codex-home", "H"]);
    }

    #[test]
    fn claude_drops_the_codex_home_and_unknown_agents_are_ignored() {
        assert_eq!(s("C:\\p", Some("claude"), None).args(), ["--cwd", "C:\\p", "--agent", "claude"]);
        assert_eq!(s("C:\\p", Some("gemini"), None).args(), ["--cwd", "C:\\p"]);
    }

    #[test]
    fn claude_passes_its_own_home_and_codex_does_not() {
        assert_eq!(s("C:\\p", Some("claude"), Some("H")).args(), ["--cwd", "C:\\p", "--agent", "claude", "--claude-home", "H"]);
        assert!(!s("C:\\p", Some("codex"), Some("H")).args().contains(&"--claude-home".to_string()));
    }
}
