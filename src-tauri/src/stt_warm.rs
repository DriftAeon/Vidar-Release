// The warm `stt` process: the slot's `warm` command (`stt_parakeet.py --serve`) held loaded in a
// kill-on-close job, so a press costs one decode instead of a model load.
//
// Lifecycle: `ensure()` (from `listen_start` only) spawns it; nothing
// unloads it but Vidar's exit (the job closes with the process, crash and swap included).
// `listen_stop` leaves it loaded. `try_run` is caller-agnostic: PTT and wake both use a loaded
// process, and the `WARM` mutex serialises them (one decode at a time).
//
// Protocol (content/local-voice/stt_parakeet.py `--serve`): stdout `{"ready":true,"loadMs":n}`
// once, then per stdin line `{"id":n,"wav":"<path>","out":"<base>"}` one reply
// `{"id":n,"ok":true,"ms":n}` or `{"id":n,"ok":false,"error":"..."}`; exits on stdin EOF. The
// transcript is `<out>.txt`, read by `voice::transcribe` as on the cold path.
//
// Anything off-protocol (EOF, garbage, a wrong id, no reply within the clip-scaled budget, a slot that no longer
// resolves to this process) kills the process and sends the caller down the cold path.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::proc_job::JobChild;
use crate::voice_slots::{self, Resolved, Slot};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const LOAD_DEADLINE: Duration = Duration::from_secs(30);

/// Reply budget for a clip of `audio_secs`: max(10 s, 5 s + audio_secs x 0.5). A long dictation
/// decodes slower than a short one; a flat 10 s killed a healthy process on a long clip.
fn reply_timeout(audio_secs: f64) -> Duration {
    Duration::from_secs_f64((5.0 + audio_secs.max(0.0) * 0.5).max(10.0))
}

/// Reads `r` to EOF one `\n`-terminated line at a time, lossily decoded, so a non-UTF-8 byte never
/// stops the drain (a full stderr pipe would block the child). `f` returns false to stop.
fn for_each_line<R: std::io::Read>(r: R, mut f: impl FnMut(String) -> bool) {
    let mut r = BufReader::new(r);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match r.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string();
                if !f(line) {
                    return;
                }
            }
        }
    }
}
const STDERR_TAIL_LINES: usize = 20;
/// contracts/voice-slots.json `lifecycle.owner`.
const OWNER: &str = "vidar";

static WARM: Mutex<Option<Warm>> = Mutex::new(None);
/// Signalled when a loading process turns ready or dead, so a press during the load waits for it.
static READY: Condvar = Condvar::new();
static GEN: AtomicU64 = AtomicU64::new(0);
/// What `stt_warm_status` reports; copied from `WARM` after each change so the command never
/// waits behind a decode.
static SNAP: Mutex<WarmStatus> = Mutex::new(WarmStatus { state: "off", pid: None, adapter: None, last_path: None, last_ms: None });

/// Which process a resolve asks for: a different one (slot switched, manifest edited) kills the held one.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Key {
    adapter: String,
    command: PathBuf,
    args: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Loading,
    Ready,
    Dead,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Phase::Loading => "loading",
            Phase::Ready => "ready",
            Phase::Dead => "dead",
        }
    }
}

struct Warm {
    gen: u64,
    key: Key,
    phase: Phase,
    pid: u32,
    child: Option<JobChild>,
    stdin: Option<ChildStdin>,
    /// stdout lines; `None` while loading (the loader holds it) and once dead.
    lines: Option<Receiver<String>>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    load: Duration,
    load_deadline: Instant,
    next_id: u64,
}

impl Warm {
    /// Ends the tree (dropping the `JobChild` closes its job) and marks the record dead.
    fn kill(&mut self, why: &str) {
        if let Some(mut child) = self.child.take() {
            child.kill();
            let _ = child.wait();
        }
        self.stdin = None;
        self.lines = None;
        self.phase = Phase::Dead;
        let tail = self.stderr_tail.lock().unwrap_or_else(|p| p.into_inner());
        let tail = if tail.is_empty() { String::new() } else { format!(". Stderr: {}", Vec::from(tail.clone()).join(" | ")) };
        eprintln!("stt warm: {}: {why}{tail}", self.key.adapter);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarmStatus {
    state: &'static str,
    pid: Option<u32>,
    adapter: Option<String>,
    last_path: Option<&'static str>,
    last_ms: Option<u64>,
}

#[derive(Debug, PartialEq)]
enum Reply {
    Ready { load_ms: u64 },
    Done { id: u64 },
    Failed { id: Option<u64>, error: String },
}

fn parse_line(line: &str) -> Result<Reply, String> {
    let v: Value = serde_json::from_str(line.trim()).map_err(|e| format!("bad line: {e}"))?;
    if v.get("ready").and_then(Value::as_bool) == Some(true) {
        return Ok(Reply::Ready { load_ms: v.get("loadMs").and_then(Value::as_u64).unwrap_or(0) });
    }
    let id = v.get("id").and_then(Value::as_u64);
    match (v.get("ok").and_then(Value::as_bool), id) {
        (Some(true), Some(id)) => Ok(Reply::Done { id }),
        (Some(false), _) => Ok(Reply::Failed { id, error: v.get("error").and_then(Value::as_str).unwrap_or("").to_string() }),
        _ => Err("line has neither \"ready\" nor \"ok\" with an id".into()),
    }
}

fn request_line(id: u64, wav: &Path, base: &Path) -> String {
    // serde_json is built with preserve_order: keys go out as written.
    serde_json::json!({ "id": id, "wav": wav.to_string_lossy(), "out": base.to_string_lossy() }).to_string()
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// The slot's `warm` command with the lifecycle tokens filled: `{owner}`, and `{model}`, which the
/// resolve fills in `run.args` only. `None` when the adapter has no `warm` or a token is left.
fn key_of(stt: &Resolved) -> Option<Key> {
    let warm = stt.warm.as_ref()?;
    let model = stt.model.as_ref().map(|m| m.file.as_str());
    let args: Vec<String> = warm
        .args
        .iter()
        .map(|a| {
            let a = a.replace("{owner}", OWNER);
            match model {
                Some(f) => a.replace("{model}", f),
                None => a,
            }
        })
        .collect();
    let left = ["{model}", "{owner}", "{wav}", "{out}", "{prompt}"];
    if args.iter().any(|a| left.iter().any(|t| a.contains(t))) {
        eprintln!("stt warm: {}: unfilled token in warm args", stt.adapter);
        return None;
    }
    Some(Key { adapter: stt.adapter.clone(), command: warm.command.clone(), args })
}

/// Spawns `cmd` for `key` unless a process for the same key is already loading or ready.
/// Returns the new record's generation and its stdout lines for `finish_in`.
fn begin_in(slot: &Mutex<Option<Warm>>, key: Key, mut cmd: Command, load: Duration) -> Option<(u64, Receiver<String>)> {
    let mut held = lock(slot);
    if let Some(w) = held.as_mut() {
        if w.key == key && matches!(w.phase, Phase::Loading | Phase::Ready) {
            return None;
        }
        if w.phase != Phase::Dead {
            w.kill("replaced by a different warm command");
        }
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).creation_flags(CREATE_NO_WINDOW);
    let mut child = match JobChild::spawn(&mut cmd) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("stt warm: {}: Cannot Run {}: {e}", key.adapter, key.command.display());
            return None;
        }
    };
    let pid = child.id();
    let stdin = child.stdin.take();
    let tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)));
    // stderr is drained for the whole life of the process: a full pipe would block the child.
    if let Some(stderr) = child.stderr.take() {
        let tail = tail.clone();
        thread::spawn(move || {
            for_each_line(stderr, |line| {
                let mut t = lock(&tail);
                if t.len() >= STDERR_TAIL_LINES {
                    t.pop_front();
                }
                t.push_back(line);
                true
            });
        });
    }
    let (tx, rx) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        thread::spawn(move || for_each_line(stdout, |line| tx.send(line).is_ok()));
    }
    let gen = GEN.fetch_add(1, Ordering::Relaxed) + 1;
    *held = Some(Warm {
        gen,
        key,
        phase: Phase::Loading,
        pid,
        child: Some(child),
        stdin,
        lines: None,
        stderr_tail: tail,
        load,
        load_deadline: Instant::now() + load,
        next_id: 0,
    });
    Some((gen, rx))
}

/// Waits for the ready line of generation `gen` (until its load deadline), then publishes the
/// outcome and wakes any press waiting on the load.
fn finish_in(slot: &Mutex<Option<Warm>>, cv: &Condvar, gen: u64, rx: Receiver<String>) {
    let (deadline, load) = match lock(slot).as_ref() {
        Some(w) if w.gen == gen => (w.load_deadline, w.load),
        _ => return,
    };
    let outcome = match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(line) => match parse_line(&line) {
            Ok(Reply::Ready { load_ms }) => Ok(load_ms),
            _ => Err(format!("first line was not ready: {line:?}")),
        },
        Err(RecvTimeoutError::Timeout) => Err(format!("no ready line within {} s", load.as_secs())),
        Err(RecvTimeoutError::Disconnected) => Err("exited before ready".into()),
    };
    {
        let mut held = lock(slot);
        // Publish only onto the same-gen record still Loading: one replaced meanwhile was killed
        // by its replacer, one killed during the load stays Dead.
        if let Some(w) = held.as_mut().filter(|w| w.gen == gen && w.phase == Phase::Loading) {
            match outcome {
                Ok(load_ms) => {
                    w.phase = Phase::Ready;
                    w.lines = Some(rx);
                    eprintln!("stt warm: {}: ready (load {load_ms} ms)", w.key.adapter);
                }
                Err(why) => w.kill(&why),
            }
        }
    }
    cv.notify_all();
}

/// One request on the held process. `None` = go cold; `Some(Err)` = the adapter answered `ok:false`.
fn run_in(slot: &Mutex<Option<Warm>>, cv: &Condvar, key: Option<Key>, wav: &Path, base: &Path, reply_timeout: Duration) -> Option<Result<(), String>> {
    let mut held = lock(slot);
    loop {
        let w = held.as_mut()?;
        if Some(&w.key) != key.as_ref() {
            if w.phase != Phase::Dead {
                w.kill("slot no longer resolves to this warm command");
            }
            return None;
        }
        match w.phase {
            Phase::Dead => return None,
            Phase::Ready => break,
            Phase::Loading => {
                // Wait for the load rather than start a second 1.5 GB copy; past the deadline, cold.
                let left = w.load_deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return None;
                }
                held = cv.wait_timeout(held, left).unwrap_or_else(|p| p.into_inner()).0;
            }
        }
    }
    let w = held.as_mut()?;
    w.next_id += 1;
    let id = w.next_id;
    let line = request_line(id, wav, base) + "\n";
    let wrote = w.stdin.as_mut().map(|s| s.write_all(line.as_bytes()).and_then(|_| s.flush()));
    if !matches!(wrote, Some(Ok(()))) {
        w.kill("stdin closed");
        return None;
    }
    let got = w.lines.as_ref().map(|rx| rx.recv_timeout(reply_timeout));
    match got {
        Some(Ok(reply)) => match parse_line(&reply) {
            Ok(Reply::Done { id: r }) if r == id => Some(Ok(())),
            Ok(Reply::Failed { id: Some(r), error }) if r == id => Some(Err(format!("{}: {error}", w.key.adapter))),
            _ => {
                w.kill(&format!("bad reply to request {id}: {reply:?}"));
                None
            }
        },
        Some(Err(RecvTimeoutError::Timeout)) => {
            w.kill(&format!("no reply within {} s", reply_timeout.as_secs()));
            None
        }
        Some(Err(RecvTimeoutError::Disconnected)) | None => {
            w.kill("exited mid-request");
            None
        }
    }
}

fn publish() {
    let (state, pid, adapter) = match lock(&WARM).as_ref() {
        Some(w) => (w.phase.as_str(), w.child.as_ref().map(|_| w.pid), Some(w.key.adapter.clone())),
        None => ("off", None, None),
    };
    let mut s = lock(&SNAP);
    s.state = state;
    s.pid = pid;
    s.adapter = adapter;
}

/// Loads the `stt` slot's warm process in the background if it has one and it is not already
/// loading or loaded. Returns at once; the resolve (first-use hashing included) runs off the caller.
pub(crate) fn ensure() {
    thread::spawn(|| {
        let Ok(stt) = voice_slots::resolve_for(Slot::Stt) else { return };
        let Some(key) = key_of(&stt) else { return };
        start(key, false);
    });
}

/// Spawns the process for `key` (no-op when it is already loading or ready; a different live key
/// is killed first) and finishes the load, inline or on a thread. Takes `WARM` only inside `begin_in`.
fn start(key: Key, detach: bool) {
    let mut cmd = Command::new(&key.command);
    cmd.args(&key.args);
    let begun = begin_in(&WARM, key, cmd, LOAD_DEADLINE);
    publish();
    if let Some((gen, rx)) = begun {
        let fin = move || {
            finish_in(&WARM, &READY, gen, rx);
            publish();
        };
        if detach {
            thread::spawn(fin);
        } else {
            fin();
        }
    }
}

/// Transcribes `wav` (`audio_secs` long) into `<base>.txt` on the warm process. `None` sends the
/// caller down the cold path (no warm process, a different slot, or the process failed and is now dead).
///
/// Restart on next press (2026-10-05): with Listen on, a dead or absent record (or a key
/// mismatch) respawns first and the press waits for the load like any press during one, instead of
/// going cold beside a second model copy. With Listen off nothing respawns.
/// Lock order: `listen::is_on()` takes the listen slot lock and releases it before `WARM` is ever
/// taken here; listen code reaches `WARM` only through `ensure()`, which runs on its own thread
/// after listen's lock is dropped. No path holds `WARM` while taking the listen lock.
pub(crate) fn try_run(stt: &Resolved, wav: &Path, base: &Path, audio_secs: f64) -> Option<Result<(), String>> {
    let key = key_of(stt);
    if crate::listen::is_on() {
        if let Some(k) = key.clone() {
            start(k, true);
        }
    } else if lock(&WARM).is_none() {
        return None;
    }
    let r = run_in(&WARM, &READY, key, wav, base, reply_timeout(audio_secs));
    publish();
    r
}

/// Which path the last transcription took and how long the stt step ran.
pub(crate) fn record_last(warm: bool, took: Duration) {
    let mut s = lock(&SNAP);
    s.last_path = Some(if warm { "warm" } else { "cold" });
    s.last_ms = Some(took.as_millis() as u64);
}

#[tauri::command]
pub fn stt_warm_status() -> WarmStatus {
    lock(&SNAP).clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};

    /// Cross-language contract: the literal lines stt_parakeet.py `--serve` prints
    /// (`json.dumps(obj, separators=(",", ":"))`) and the request line it reads.
    #[test]
    fn stt_warm_reads_the_adapter_lines_and_writes_its_request() {
        assert_eq!(parse_line(r#"{"ready":true,"loadMs":1834}"#), Ok(Reply::Ready { load_ms: 1834 }));
        assert_eq!(parse_line(r#"{"id":1,"ok":true,"ms":170}"#), Ok(Reply::Done { id: 1 }));
        assert_eq!(
            parse_line(r#"{"id":2,"ok":false,"error":"FileNotFoundError: [Errno 2] No such file or directory: 'C:\\v\\a.wav'"}"#),
            Ok(Reply::Failed { id: Some(2), error: r"FileNotFoundError: [Errno 2] No such file or directory: 'C:\v\a.wav'".into() })
        );
        // an unparseable request: rid stays None in the adapter
        assert_eq!(
            parse_line(r#"{"id":null,"ok":false,"error":"JSONDecodeError: Expecting value: line 1 column 1 (char 0)"}"#),
            Ok(Reply::Failed { id: None, error: "JSONDecodeError: Expecting value: line 1 column 1 (char 0)".into() })
        );
        assert!(parse_line("Loading model...").is_err());
        assert!(parse_line(r#"{"id":3}"#).is_err());
        assert_eq!(request_line(1, Path::new(r"C:\v\a.wav"), Path::new(r"C:\v\a")), r#"{"id":1,"wav":"C:\\v\\a.wav","out":"C:\\v\\a"}"#);
    }

    /// A process that turns ready, reads one request and exits without a reply: the press goes
    /// cold, the record is dead and its job (the process) is gone.
    #[test]
    fn stt_warm_child_dying_mid_request_goes_cold_and_ends_the_job() {
        let slot = Mutex::new(None);
        let cv = Condvar::new();
        let key = Key { adapter: "test/cmd".into(), command: "cmd.exe".into(), args: Vec::new() };
        let mut cmd = Command::new("cmd.exe");
        cmd.raw_arg(r#"/d /q /c "echo {"ready":true,"loadMs":1}&set /p L=&exit /b 3""#);
        let (gen, rx) = begin_in(&slot, key.clone(), cmd, Duration::from_secs(10)).expect("spawned");
        finish_in(&slot, &cv, gen, rx);
        let pid = {
            let held = lock(&slot);
            let w = held.as_ref().unwrap();
            assert_eq!(w.phase, Phase::Ready);
            w.pid
        };
        let proc = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }.expect("child alive before the request");

        let r = run_in(&slot, &cv, Some(key), Path::new(r"C:\v\a.wav"), Path::new(r"C:\v\a"), Duration::from_secs(5));
        assert!(r.is_none(), "{r:?}");
        {
            let held = lock(&slot);
            let w = held.as_ref().unwrap();
            assert_eq!(w.phase, Phase::Dead);
            assert!(w.child.is_none(), "the JobChild (and its job) must be dropped");
        }
        let gone = unsafe { WaitForSingleObject(proc, 5000) } == WAIT_OBJECT_0;
        let _ = unsafe { CloseHandle(proc) };
        assert!(gone, "child {pid} outlived the request");
    }
}
