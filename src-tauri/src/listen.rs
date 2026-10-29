// Wake word -> VAD -> whisper -> webview. Sibling to voice.rs (push-to-talk): this file owns
// its own child process (the `wake` slot's adapter, stock listen.py under contract id localVoice), its own
// capture stream and its own state machine; it reuses `voice::open_stream_with` for the mic and
// `voice::transcribe` with the `stt` slot so the two paths never diverge on DSP or the
// transcriber. The spawn, the ready handshake and the event parser live in listen_sidecar.rs.
//
// Threads per session: capture (owns the cpal::Stream, converts+resamples, NEVER touches the
// child directly), writer (drains a bounded drop-oldest queue into the child's stdin), reader
// (parses the child's stdout JSON lines, drives the state machine), ticker (polls the state
// machine's own timeouts — heard's 4 s false-wake window, recording's 15 s cap, delivering's
// 5 s auto-return — none of which arrive as a sidecar line).
//
// The queue/state-machine primitives below (`Machine`, `Resampler`, `to_i16_le`,
// `BoundedQueue`) are pure or nearly-pure and unit-tested at the bottom.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::process::ChildStdout;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::listen_sidecar::{self as sidecar, parse_event, SidecarEvent};
use crate::proc_job::JobChild;
use crate::voice;
use crate::voice_slots::{self, Slot as VoiceSlot};

/// The sidecar's own contract (see listen.py's argparse): 1280 samples = 80 ms at 16 kHz.
const BLOCK_SAMPLES: usize = 1280;
const TARGET_RATE: u32 = 16_000;
/// ~2 s of 80 ms blocks. Full = the writer thread is behind; the capture callback drops the
/// OLDEST queued block rather than block itself or the new one.
const CHANNEL_DEPTH: usize = 25;
const DELIVER_TIMEOUT_MS: u64 = 5_000;

/* ---- config ---- */

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WakewordCfg {
    pub enabled: bool,
    /// case-insensitive substring of a WASAPI input endpoint name; "" = Windows default
    pub device: String,
    /// The `wake` slot's legacy pick: an id from the stock openWakeWord manifest's `models[]`
    /// (`hey_jarvis_v0.1`, `pico`…). Read from vidar.json by `voice_slots::resolve`, never from
    /// the webview's copy; empty is no pick.
    pub model: String,
    pub threshold: f32,
    pub end_silence_ms: u32,
    pub max_utterance_ms: u32,
    /// "heard" (wake fired, waiting on VAD) reverts to "listening" if speech never starts.
    pub heard_timeout_ms: u32,
    /// VAD hysteresis band; read by listen.py, round-tripped here so settings can edit it.
    pub vad_start: f32,
    pub vad_stop: f32,
    /// how much pre-wake audio survives into the recorded utterance.
    pub preroll_ms: u32,
    pub auto_submit: bool,
}

impl Default for WakewordCfg {
    fn default() -> Self {
        Self {
            enabled: false,
            device: String::new(),
            model: String::new(),
            threshold: 0.5,
            end_silence_ms: 800,
            max_utterance_ms: 15_000,
            heard_timeout_ms: 4_000,
            vad_start: 0.5,
            vad_stop: 0.35,
            preroll_ms: 500,
            auto_submit: true,
        }
    }
}

/* ---- state machine (pure; `now_ms` is injected so tests never touch a real clock) ---- */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Listening,
    Heard,
    Recording,
    Transcribing,
    Delivering,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Effect {
    None,
    State(&'static str),
    /// A wake fired while transcribing/delivering: the UI flashes and chimes "busy", the
    /// wake is otherwise dropped (no buffering).
    Busy,
}

pub(crate) struct Machine {
    phase: Phase,
    heard_deadline_ms: Option<u64>,
    recording_deadline_ms: Option<u64>,
    delivering_deadline_ms: Option<u64>,
    heard_timeout_ms: u64,
    max_utterance_ms: u64,
}

impl Machine {
    pub fn new(heard_timeout_ms: u64, max_utterance_ms: u64) -> Self {
        Self {
            phase: Phase::Listening,
            heard_deadline_ms: None,
            recording_deadline_ms: None,
            delivering_deadline_ms: None,
            heard_timeout_ms,
            max_utterance_ms,
        }
    }

    fn phase_label(&self) -> &'static str {
        match self.phase {
            Phase::Listening => "listening",
            Phase::Heard => "heard",
            Phase::Recording => "recording",
            Phase::Transcribing => "transcribing",
            Phase::Delivering => "delivering",
        }
    }

    pub fn on_wake(&mut self, now_ms: u64) -> Effect {
        match self.phase {
            Phase::Listening => {
                self.phase = Phase::Heard;
                self.heard_deadline_ms = Some(now_ms + self.heard_timeout_ms);
                Effect::State("heard")
            }
            Phase::Transcribing | Phase::Delivering => Effect::Busy,
            Phase::Heard | Phase::Recording => Effect::None,
        }
    }

    pub fn on_speech_start(&mut self, now_ms: u64) -> Effect {
        if self.phase == Phase::Heard {
            self.phase = Phase::Recording;
            self.recording_deadline_ms = Some(now_ms + self.max_utterance_ms);
            Effect::State("recording")
        } else {
            Effect::None
        }
    }

    pub fn on_speech_end(&mut self) -> Effect {
        if self.phase == Phase::Recording {
            self.phase = Phase::Transcribing;
            self.recording_deadline_ms = None;
            Effect::State("transcribing")
        } else {
            Effect::None
        }
    }

    pub fn on_transcribed(&mut self, ok: bool, now_ms: u64) -> Effect {
        if self.phase != Phase::Transcribing {
            return Effect::None;
        }
        if ok {
            self.phase = Phase::Delivering;
            self.delivering_deadline_ms = Some(now_ms + DELIVER_TIMEOUT_MS);
            Effect::State("delivering")
        } else {
            self.phase = Phase::Listening;
            Effect::State("listening")
        }
    }

    pub fn on_delivered(&mut self) -> Effect {
        if self.phase == Phase::Delivering {
            self.phase = Phase::Listening;
            self.delivering_deadline_ms = None;
            Effect::State("listening")
        } else {
            Effect::None
        }
    }

    /// Push-to-talk taken mid-recording: the clip so far is a truncated
    /// fragment, not an utterance, so it is dropped rather than left to run out the clock on
    /// the 15 s cap and get transcribed anyway. No-op outside `Recording` (in particular,
    /// `Heard` is left alone — a PTT press before speech started doesn't need this).
    pub fn on_abort_recording(&mut self) -> Effect {
        if self.phase == Phase::Recording {
            self.phase = Phase::Listening;
            self.recording_deadline_ms = None;
            Effect::State("listening")
        } else {
            Effect::None
        }
    }

    /// Polled (not event-driven): the three timeouts that have no sidecar line of their own.
    pub fn tick(&mut self, now_ms: u64) -> Effect {
        match self.phase {
            Phase::Heard if self.heard_deadline_ms.is_some_and(|d| now_ms >= d) => {
                self.phase = Phase::Listening;
                self.heard_deadline_ms = None;
                Effect::State("listening")
            }
            Phase::Recording if self.recording_deadline_ms.is_some_and(|d| now_ms >= d) => {
                self.phase = Phase::Transcribing;
                self.recording_deadline_ms = None;
                Effect::State("transcribing")
            }
            Phase::Delivering if self.delivering_deadline_ms.is_some_and(|d| now_ms >= d) => {
                self.phase = Phase::Listening;
                self.delivering_deadline_ms = None;
                Effect::State("listening")
            }
            _ => Effect::None,
        }
    }
}

/* ---- streaming resample + i16 encode (pure) ---- */

/// Linear-interpolation resample that carries its fractional read position and one sample of
/// history across calls, so chunking at the capture callback's boundaries (cpal hands over
/// whatever it has, not fixed-size blocks) produces the same output as one long call would —
/// no per-chunk `voice::resample` call, no boundary click.
pub(crate) struct Resampler {
    from: u32,
    to: u32,
    pos: f64,
    prev: f32,
}

impl Resampler {
    pub fn new(from: u32, to: u32) -> Self {
        Self { from, to, pos: 0.0, prev: 0.0 }
    }

    pub fn push(&mut self, chunk: &[f32]) -> Vec<f32> {
        if chunk.is_empty() {
            return Vec::new();
        }
        if self.from == self.to {
            return chunk.to_vec();
        }
        let ratio = self.from as f64 / self.to as f64;
        let mut out = Vec::new();
        loop {
            let idx = self.pos.floor() as usize;
            if idx >= chunk.len() {
                break;
            }
            let frac = (self.pos - idx as f64) as f32;
            let a = if idx == 0 { self.prev } else { chunk[idx - 1] };
            let b = chunk[idx];
            out.push(a + (b - a) * frac);
            self.pos += ratio;
        }
        self.pos -= chunk.len() as f64;
        self.prev = *chunk.last().unwrap();
        out
    }
}

/// Same clamp/scale convention as `voice::wav_bytes`.
pub(crate) fn to_i16_le(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/* ---- bounded, drop-oldest queue (capture callback -> writer thread) ---- */

struct BoundedQueue {
    inner: Mutex<VecDeque<Vec<u8>>>,
    cv: Condvar,
    cap: usize,
    closed: AtomicBool,
}

impl BoundedQueue {
    fn new(cap: usize) -> Self {
        Self { inner: Mutex::new(VecDeque::with_capacity(cap)), cv: Condvar::new(), cap, closed: AtomicBool::new(false) }
    }

    /// Never blocks: at capacity it drops the OLDEST queued block, not the new one, so the
    /// cpal callback (which must never block) always returns immediately. Poison-tolerant
    /// (`unwrap_or_else(into_inner)`, not a bare `unwrap`) since this runs on the realtime
    /// audio thread — a panic elsewhere must not turn into a second panic here.
    fn push(&self, item: Vec<u8>) {
        let mut q = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if q.len() >= self.cap {
            q.pop_front();
        }
        q.push_back(item);
        self.cv.notify_one();
    }

    fn pop_blocking(&self) -> Option<Vec<u8>> {
        let mut q = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            if let Some(item) = q.pop_front() {
                return Some(item);
            }
            if self.closed.load(Ordering::SeqCst) {
                return None;
            }
            q = match self.cv.wait(q) {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
        }
    }

    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.cv.notify_all();
    }
}

/* ---- capture-thread control ---- */

enum CaptureMsg {
    Stop,
    Pause,
    Resume,
}

struct UtteranceBuf {
    ring: VecDeque<f32>,
    preroll_cap: usize,
}

impl UtteranceBuf {
    fn new() -> Self {
        Self { ring: VecDeque::new(), preroll_cap: 0 }
    }

    fn push(&mut self, samples: &[f32], recording: bool) {
        self.ring.extend(samples.iter().copied());
        if !recording {
            while self.ring.len() > self.preroll_cap {
                self.ring.pop_front();
            }
        }
    }

    fn take(&mut self) -> Vec<f32> {
        self.ring.drain(..).collect()
    }
}

/* ---- session context, shared by capture/writer/reader/ticker ---- */

struct Ctx {
    app: AppHandle,
    /// Back-reference so the reader/capture threads can clear their own slot on an
    /// unexpected exit instead of leaving a dead `Session` behind. This is
    /// a genuine `Arc` cycle (`ListenState -> Session -> Ctx -> ListenState`) for as long as a
    /// session is `Running`; it is broken the moment the slot is cleared or taken, which every
    /// exit path (`listen_stop`, this same teardown, `reap_if_dead`) does.
    listen_state: ListenState,
    machine: Mutex<Machine>,
    utterance: Mutex<UtteranceBuf>,
    recording: AtomicBool,
    rate: AtomicU32,
    stopping: AtomicBool,
    capture_tx: Mutex<mpsc::Sender<CaptureMsg>>,
    queue: Arc<BoundedQueue>,
    /// Last few `[listen] ...` stderr lines, folded into the EOF/error
    /// message the reader thread emits so "sidecar exited unexpectedly" isn't the whole story.
    stderr_tail: Mutex<VecDeque<String>>,
    prompt: String,
    start: Instant,
}

const STDERR_TAIL_LINES: usize = 20;

impl Ctx {
    fn clock(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }

    fn last_stderr(&self) -> Option<String> {
        self.stderr_tail.lock().unwrap().back().cloned()
    }

    /// Appends the last stderr line (if any) to a reason string, for the messages that go out
    /// in `listen-state {state:"off", error}`.
    fn with_stderr(&self, reason: impl Into<String>) -> String {
        let mut msg = reason.into();
        if let Some(line) = self.last_stderr() {
            msg.push_str(" — ");
            msg.push_str(&line);
        }
        msg
    }
}

fn apply_effect(ctx: &Ctx, eff: Effect, error: Option<String>) {
    match eff {
        Effect::State(s) => {
            ctx.recording.store(s == "recording", Ordering::SeqCst);
            let _ = ctx.app.emit("listen-state", serde_json::json!({"state": s, "error": error}));
        }
        Effect::Busy => {
            let _ = ctx.app.emit("listen-state", serde_json::json!({"state": "busy", "error": Value::Null}));
        }
        Effect::None => {}
    }
}

fn handle_effect(ctx: &Arc<Ctx>, eff: Effect) {
    let finish = matches!(eff, Effect::State("transcribing"));
    apply_effect(ctx, eff, None);
    if finish {
        finish_recording(ctx.clone());
    }
}

/// Runs off the reader/ticker thread on its own thread so neither is blocked on the model
/// load + whisper-cli round trip. `stem` is per-call so this never races a
/// concurrent push-to-talk transcription over `bridge\voice\last.wav`. The `stt` slot is
/// resolved per utterance, so a model changed since `listen_start` is caught by its pin.
fn finish_recording(ctx: Arc<Ctx>) {
    let samples = ctx.utterance.lock().unwrap().take();
    let rate = ctx.rate.load(Ordering::SeqCst).max(1);
    thread::spawn(move || {
        let stem = format!("listen-{}", ctx.clock());
        let result = voice_slots::resolve_for(VoiceSlot::Stt).and_then(|stt| voice::transcribe(&stt, &ctx.prompt, samples, rate, 1, &stem));
        match result {
            Ok(text) if !text.trim().is_empty() => {
                let eff = ctx.machine.lock().unwrap().on_transcribed(true, ctx.clock());
                let _ = ctx.app.emit("listen-transcript", serde_json::json!({"text": text}));
                apply_effect(&ctx, eff, None);
                // A successful utterance has nothing left to debug, so its
                // `<stem>.wav`/`.txt` are cleaned up; a failed or empty one keeps them (best
                // effort — a missing file here is not itself an error worth surfacing).
                let dir = crate::paths::voice_dir();
                let _ = std::fs::remove_file(dir.join(format!("{stem}.wav")));
                let _ = std::fs::remove_file(dir.join(format!("{stem}.txt")));
            }
            Ok(_) => {
                let eff = ctx.machine.lock().unwrap().on_transcribed(false, ctx.clock());
                apply_effect(&ctx, eff, None);
            }
            Err(e) => {
                let eff = ctx.machine.lock().unwrap().on_transcribed(false, ctx.clock());
                apply_effect(&ctx, eff, Some(e));
            }
        }
    });
}

/// A silence block (all-zero i16 LE), the exact shape `to_i16_le` would produce for
/// `BLOCK_SAMPLES` zero samples — pushed at the real 80 ms cadence while paused
/// so the sidecar's own no-audio watchdog and VAD never see a starved pipe, without
/// scoring as a wake (silence never crosses any wake threshold).
fn silence_block() -> Vec<u8> {
    vec![0u8; BLOCK_SAMPLES * 2]
}

fn spawn_capture(filter: String, preroll_ms: u32, ctx: Arc<Ctx>, capture_rx: Receiver<CaptureMsg>) -> Result<thread::JoinHandle<()>, String> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let join = thread::spawn(move || {
        let mut first_open = true;
        'outer: loop {
            let open_ctx = ctx.clone();
            let result = voice::open_stream_with(&filter, move |rate, channels| {
                open_ctx.rate.store(rate, Ordering::SeqCst);
                {
                    let mut u = open_ctx.utterance.lock().unwrap();
                    u.preroll_cap = (preroll_ms as u64 * rate as u64 / 1000) as usize;
                }
                let mut resampler = Resampler::new(rate, TARGET_RATE);
                let mut backlog: Vec<f32> = Vec::new();
                let channels = channels as usize;
                let cb_ctx = open_ctx.clone();
                move |data: &[f32]| {
                    let mono = voice::downmix(data, channels);
                    {
                        let mut u = cb_ctx.utterance.lock().unwrap_or_else(|p| p.into_inner());
                        u.push(&mono, cb_ctx.recording.load(Ordering::Relaxed));
                    }
                    backlog.extend(resampler.push(&mono));
                    let mut i = 0;
                    while backlog.len() - i >= BLOCK_SAMPLES {
                        cb_ctx.queue.push(to_i16_le(&backlog[i..i + BLOCK_SAMPLES]));
                        i += BLOCK_SAMPLES;
                    }
                    backlog.drain(0..i);
                }
            });
            let stream = match result {
                Ok((stream, ..)) => {
                    if first_open {
                        let _ = ready_tx.send(Ok(()));
                    }
                    stream
                }
                Err(e) => {
                    let device = if filter.trim().is_empty() { "default".to_string() } else { filter.clone() };
                    let msg = format!("listen: capture device \"{device}\": {e}");
                    if first_open {
                        // The very first open: `listen_start` is still waiting on `ready_rx`
                        // and surfaces this as its own `Err`, so no separate emit here.
                        let _ = ready_tx.send(Err(msg));
                    } else if !ctx.stopping.swap(true, Ordering::SeqCst) {
                        // Every later iteration (post-pause/resume) used to
                        // hit this same arm and just `return` silently — `ready_tx`'s receiver
                        // was long gone, so the failure vanished. Now it tears the session
                        // down by name instead.
                        let _ = ctx.app.emit("listen-state", serde_json::json!({"state": "off", "error": ctx.with_stderr(msg)}));
                    }
                    ctx.queue.close();
                    return;
                }
            };
            first_open = false;
            loop {
                match capture_rx.recv() {
                    Ok(CaptureMsg::Stop) | Err(_) => {
                        drop(stream);
                        break 'outer;
                    }
                    Ok(CaptureMsg::Pause) => {
                        drop(stream);
                        loop {
                            // Keep feeding the sidecar silence at its own
                            // 80 ms block cadence while paused, instead of going quiet — a
                            // starved stdin is what drove its no-audio watchdog to exit a PTT
                            // hold longer than the old 10 s timeout.
                            match capture_rx.recv_timeout(Duration::from_millis(80)) {
                                Ok(CaptureMsg::Resume) => continue 'outer,
                                Ok(CaptureMsg::Stop) => break 'outer,
                                Err(mpsc::RecvTimeoutError::Disconnected) => break 'outer,
                                Ok(CaptureMsg::Pause) => {}
                                Err(mpsc::RecvTimeoutError::Timeout) => ctx.queue.push(silence_block()),
                            }
                        }
                    }
                    Ok(CaptureMsg::Resume) => {}
                }
            }
        }
    });
    match ready_rx.recv() {
        Ok(Ok(())) => Ok(join),
        Ok(Err(e)) => {
            let _ = join.join();
            Err(e)
        }
        Err(_) => Err("listen: capture thread died before reporting".into()),
    }
}

fn spawn_writer(queue: Arc<BoundedQueue>, mut stdin: std::process::ChildStdin) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        while let Some(block) = queue.pop_blocking() {
            if stdin.write_all(&block).is_err() {
                break;
            }
        }
        // `stdin` drops here, closing the pipe — the "close stdin" half of listen_stop's
        // "closes stdin, waits 2 s, kills": stop() closes the queue, which ends this loop.
    })
}

/// Drains `[listen] ...` diagnostics into `ctx.stderr_tail` (capped, oldest dropped first) so
/// an EOF/error message can quote the sidecar's own last word. Self-terminating: the loop ends
/// when the pipe closes (the child exited), same as the reader thread's own stdout loop.
fn spawn_stderr(ctx: Arc<Ctx>, stderr: std::process::ChildStderr) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let mut tail = ctx.stderr_tail.lock().unwrap_or_else(|p| p.into_inner());
            if tail.len() >= STDERR_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    })
}

fn spawn_reader(ctx: Arc<Ctx>, reader: BufReader<ChildStdout>) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if line.trim().is_empty() {
                continue;
            }
            match parse_event(&line) {
                Ok(SidecarEvent::Ready { .. }) => {}
                Ok(SidecarEvent::Wake { .. }) => {
                    let now = ctx.clock();
                    let eff = ctx.machine.lock().unwrap().on_wake(now);
                    handle_effect(&ctx, eff);
                }
                Ok(SidecarEvent::SpeechStart) => {
                    let now = ctx.clock();
                    let eff = ctx.machine.lock().unwrap().on_speech_start(now);
                    handle_effect(&ctx, eff);
                }
                Ok(SidecarEvent::SpeechEnd) => {
                    let eff = ctx.machine.lock().unwrap().on_speech_end();
                    handle_effect(&ctx, eff);
                }
                Ok(SidecarEvent::Error { msg }) => {
                    if !ctx.stopping.swap(true, Ordering::SeqCst) {
                        let _ = ctx.app.emit("listen-state", serde_json::json!({"state": "off", "error": ctx.with_stderr(msg)}));
                    }
                    clear_own_slot(&ctx);
                    return;
                }
                // Diagnostics go to stderr (`[listen] ...`); a malformed stdout line is
                // logged and skipped, not treated as a session-ending error.
                Err(e) => eprintln!("listen: {e}: {line}"),
            }
        }
        // stdout EOF: expected if `listen_stop` already set `stopping`; otherwise the
        // sidecar died on its own (crash, parent-pid watchdog raced, 30 s silence exit).
        // Clear the slot ourselves either way, so a session that died on
        // its own never lingers as `Running` — `listen_start` would otherwise see it as
        // already-listening and no-op, and the UI would keep painting "listening".
        if !ctx.stopping.swap(true, Ordering::SeqCst) {
            let _ = ctx.app.emit("listen-state", serde_json::json!({"state": "off", "error": ctx.with_stderr("sidecar exited unexpectedly")}));
        }
        clear_own_slot(&ctx);
    })
}

/// Clears `ctx.listen_state`'s slot, but only if it still holds THIS session (`Arc::ptr_eq` on
/// the `Ctx` each `Session` carries) — guards against a reader thread that outlives its own
/// session (e.g. `listen_stop` already replaced the slot with a new one by the time this
/// thread's blocking read finally returns) clobbering whatever replaced it.
fn clear_own_slot(ctx: &Arc<Ctx>) {
    let mut slot = ctx.listen_state.0.lock().unwrap_or_else(|p| p.into_inner());
    if let Slot::Running(session) = &*slot {
        if Arc::ptr_eq(&session.ctx, ctx) {
            *slot = Slot::Off;
        }
    }
}

fn spawn_ticker(ctx: Arc<Ctx>) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        while !ctx.stopping.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(150));
            if ctx.stopping.load(Ordering::SeqCst) {
                break;
            }
            let now = ctx.clock();
            let eff = ctx.machine.lock().unwrap().tick(now);
            handle_effect(&ctx, eff);
        }
    })
}

/* ---- session + public state ---- */

struct Session {
    // Its own job: kill and drop end the venv stub AND the interpreter it started.
    child: JobChild,
    ctx: Arc<Ctx>,
    capture_join: thread::JoinHandle<()>,
    writer_join: thread::JoinHandle<()>,
    reader_join: thread::JoinHandle<()>,
    ticker_join: thread::JoinHandle<()>,
}

/// `Starting` covers the window between `listen_start` claiming the slot and
/// `start_session` finishing the sidecar handshake — a second `listen_start` in that window is
/// refused by name instead of racing `start_session` twice or silently no-op'ing.
#[derive(Default)]
enum Slot {
    #[default]
    Off,
    Starting,
    Running(Session),
}

#[derive(Default, Clone)]
pub struct ListenState(Arc<Mutex<Slot>>);

/// Pure "claim the slot" step of `listen_start`: `Off` claims (returns
/// `Ok(true)`, caller should spawn); `Starting` refuses by name (`Err`, a second call losing
/// the race instead of racing `start_session` or silently no-op'ing); `Running` is already on
/// (`Ok(false)`, no-op). Split out so the `Off`/`Starting` arms are unit-testable without a
/// live `Session`, which `Slot::Running` cannot be built without a real `AppHandle`.
fn claim_start(slot: &mut Slot) -> Result<bool, String> {
    match slot {
        Slot::Off => {
            *slot = Slot::Starting;
            Ok(true)
        }
        Slot::Starting => Err("listen: already starting".into()),
        Slot::Running(_) => Ok(false),
    }
}

/// Drops a `Running` slot back to `Off` if its reader thread has already finished
/// — belt-and-braces for `clear_own_slot`, in case a session ever ends up
/// `Running` with a dead reader thread through some path that isn't the reader's own exit.
fn reap_if_dead(slot: &mut Slot) {
    if let Slot::Running(session) = slot {
        if session.reader_join.is_finished() {
            *slot = Slot::Off;
        }
    }
}

/// Called by `voice::voice_start`: stop the listen capture stream for the push-to-talk hold,
/// keep the sidecar warm; if a wake-word utterance is already `recording`, abort it rather than
/// let it run out the 15 s cap and transcribe a clip PTT audibly stepped on.
/// No-op if listening is off.
/// The managed `ListenState`, captured by `listen_start` so code with no `State` (stt_warm's
/// `try_run`) can ask whether Listen is on.
static LISTEN: std::sync::OnceLock<ListenState> = std::sync::OnceLock::new();

/// True while a listen session is `Running` with a live reader. Takes the slot lock briefly; callers
/// must not hold `stt_warm::WARM` (lock order: listen slot, then WARM, never the reverse).
pub(crate) fn is_on() -> bool {
    let Some(state) = LISTEN.get() else { return false };
    let mut slot = state.0.lock().unwrap_or_else(|p| p.into_inner());
    reap_if_dead(&mut slot);
    matches!(*slot, Slot::Running(_))
}

pub(crate) fn pause(state: &ListenState) {
    let mut slot = state.0.lock().unwrap_or_else(|p| p.into_inner());
    if let Slot::Running(session) = &*slot {
        let _ = session.ctx.capture_tx.lock().unwrap().send(CaptureMsg::Pause);
        let eff = session.ctx.machine.lock().unwrap().on_abort_recording();
        if !matches!(eff, Effect::None) {
            let _ = session.ctx.utterance.lock().unwrap().take(); // discard, never transcribe
            apply_effect(&session.ctx, eff, None);
        }
    }
    reap_if_dead(&mut slot);
}

/// Called by `voice::voice_stop`: resume the listen capture stream. No-op if listening is off
/// (including if it died mid-hold).
pub(crate) fn resume(state: &ListenState) {
    if let Slot::Running(session) = &*state.0.lock().unwrap_or_else(|p| p.into_inner()) {
        let _ = session.ctx.capture_tx.lock().unwrap().send(CaptureMsg::Resume);
    }
}

/// `cfg` carries the tuning (threshold, VAD band, device, timeouts); its `model` is ignored:
/// the `wake` and `stt` slots resolve from vidar.json here. `stt` is resolved up front so a
/// missing transcriber fails the start, not the first utterance.
fn start_session(app: AppHandle, listen_state: ListenState, cfg: WakewordCfg, prompt: String) -> Result<(), String> {
    let wake = voice_slots::resolve_for(VoiceSlot::Wake)?;
    voice_slots::resolve_for(VoiceSlot::Stt)?;
    let mut child = sidecar::spawn(&wake, &cfg)?;

    let stdin = child.stdin.take().ok_or("listen: no stdin pipe")?;
    let stdout = child.stdout.take().ok_or("listen: no stdout pipe")?;
    let mut stderr = Some(child.stderr.take().ok_or("listen: no stderr pipe")?);
    let reader = BufReader::new(stdout);
    // A failed handshake kills the child and quotes its stderr (a traceback before `ready`).
    let mut fail = |reason: String| {
        let _ = child.kill();
        sidecar::with_stderr_tail(reason, stderr.take(), STDERR_TAIL_LINES)
    };

    // `reader` (not a fresh BufReader downstream) goes to the reader thread: a BufReader over
    // a pipe can have buffered bytes past the one line the ready-read consumed, and rebuilding
    // one from a raw handle afterward would drop them.
    let (reader, first) = match sidecar::read_ready_line(reader) {
        Ok(pair) => pair,
        Err(e) => return Err(fail(e)),
    };
    match parse_event(&first) {
        Ok(SidecarEvent::Ready { .. }) => {}
        Ok(SidecarEvent::Error { msg }) => return Err(fail(format!("listen: sidecar: {msg}"))),
        other => return Err(fail(format!("listen: sidecar's first line was not ready: {other:?} ({first:?})"))),
    }
    let stderr = stderr.take().ok_or("listen: no stderr pipe")?;

    let queue = Arc::new(BoundedQueue::new(CHANNEL_DEPTH));
    let (capture_tx, capture_rx) = mpsc::channel::<CaptureMsg>();

    let ctx = Arc::new(Ctx {
        app: app.clone(),
        listen_state: listen_state.clone(),
        machine: Mutex::new(Machine::new(cfg.heard_timeout_ms as u64, cfg.max_utterance_ms as u64)),
        utterance: Mutex::new(UtteranceBuf::new()),
        recording: AtomicBool::new(false),
        rate: AtomicU32::new(0),
        stopping: AtomicBool::new(false),
        capture_tx: Mutex::new(capture_tx),
        queue: queue.clone(),
        stderr_tail: Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)),
        prompt,
        start: Instant::now(),
    });

    let capture_join = match spawn_capture(cfg.device.clone(), cfg.preroll_ms, ctx.clone(), capture_rx) {
        Ok(j) => j,
        Err(e) => {
            let _ = child.kill();
            return Err(e);
        }
    };
    let _stderr_join = spawn_stderr(ctx.clone(), stderr);
    let writer_join = spawn_writer(queue.clone(), stdin);
    let reader_join = spawn_reader(ctx.clone(), reader);
    let ticker_join = spawn_ticker(ctx.clone());

    {
        let mut slot = listen_state.0.lock().unwrap_or_else(|p| p.into_inner());
        if matches!(*slot, Slot::Starting) {
            *slot = Slot::Running(Session { child, ctx, capture_join, writer_join, reader_join, ticker_join });
        } else {
            // A concurrent `listen_stop` moved the slot off `Starting` while this handshake
            // was in flight: don't resurrect a session nothing is waiting on. Best-effort
            // teardown (no joins here — the blocking pool thread returns promptly; each
            // thread notices `stopping`/a closed pipe and winds itself down).
            drop(slot);
            ctx.stopping.store(true, Ordering::SeqCst);
            queue.close();
            let _ = ctx.capture_tx.lock().unwrap().send(CaptureMsg::Stop);
            let _ = child.kill();
            return Ok(());
        }
    }
    let _ = app.emit("listen-state", serde_json::json!({"state": "listening", "error": Value::Null}));
    Ok(())
}

/* ---- commands ---- */

#[tauri::command]
pub async fn listen_start(app: AppHandle, state: State<'_, ListenState>, cfg: WakewordCfg, prompt: String) -> Result<(), String> {
    let _ = LISTEN.set(state.inner().clone());
    {
        let mut slot = state.0.lock().unwrap_or_else(|p| p.into_inner());
        reap_if_dead(&mut slot); // backstop: a session whose reader already died is not "on"
        match claim_start(&mut slot) {
            Ok(true) => {}
            Ok(false) => return Ok(()),
            Err(e) => return Err(e),
        }
    }
    let listen_state = state.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || start_session(app, listen_state.clone(), cfg, prompt))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    if result.is_ok() {
        // Listen on is the warm stt trigger; after start_session, whose
        // stt resolve has already paid the first-use hash.
        crate::stt_warm::ensure();
    }
    if result.is_err() {
        // `start_session` never reached `Slot::Running`; hand the slot back UNLESS a
        // concurrent `listen_stop` already reset it to `Off` itself (leave that alone).
        let mut slot = state.0.lock().unwrap_or_else(|p| p.into_inner());
        if matches!(*slot, Slot::Starting) {
            *slot = Slot::Off;
        }
    }
    result
}

/// Closes stdin (by closing the queue, which ends the writer thread that owns the handle),
/// waits up to 2 s for the child to exit on its own, then kills it.
#[tauri::command]
pub async fn listen_stop(state: State<'_, ListenState>) -> Result<(), String> {
    let taken = std::mem::take(&mut *state.0.lock().unwrap_or_else(|p| p.into_inner()));
    let Slot::Running(mut session) = taken else {
        return Ok(());
    };
    session.ctx.stopping.store(true, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        session.ctx.queue.close();
        let _ = session.writer_join.join(); // stdin closes when this returns

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match session.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() >= deadline => {
                    let _ = session.child.kill();
                    let _ = session.child.wait();
                    break;
                }
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }

        let _ = session.ctx.capture_tx.lock().unwrap().send(CaptureMsg::Stop);
        let _ = session.capture_join.join();
        let _ = session.reader_join.join();
        let _ = session.ticker_join.join();
        let _ = session.ctx.app.emit("listen-state", serde_json::json!({"state": "off", "error": Value::Null}));
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn listen_status(state: State<ListenState>) -> String {
    match &*state.0.lock().unwrap_or_else(|p| p.into_inner()) {
        Slot::Running(session) => session.ctx.machine.lock().unwrap().phase_label().to_string(),
        // `Starting` has no TS-visible state of its own (the UI already paints "listening"
        // optimistically on click, before `listen_start` even resolves); reporting it as
        // "listening" here keeps `listen_status` in the same small vocabulary the frontend
        // already handles instead of leaking an internal-only label.
        Slot::Starting => "listening".to_string(),
        Slot::Off => "off".to_string(),
    }
}

/// UI ack after it has delivered the transcript to the target pane: ends the 5 s "delivering"
/// window early so the mic goes back to armed listening right away.
#[tauri::command]
pub fn listen_delivered(state: State<ListenState>) -> Result<(), String> {
    if let Slot::Running(session) = &*state.0.lock().unwrap_or_else(|p| p.into_inner()) {
        let eff = session.ctx.machine.lock().unwrap().on_delivered();
        apply_effect(&session.ctx, eff, None);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wake_then_speech_start_then_15s_cap_reaches_transcribing() {
        let mut m = Machine::new(4_000, 15_000);
        assert_eq!(m.on_wake(0), Effect::State("heard"));
        assert_eq!(m.on_speech_start(100), Effect::State("recording"));
        // still well inside the cap
        assert_eq!(m.tick(10_099), Effect::None);
        // 100 (speech_start) + 15_000 = 15_100
        assert_eq!(m.tick(15_099), Effect::None);
        assert_eq!(m.tick(15_100), Effect::State("transcribing"));
    }

    #[test]
    fn heard_reverts_to_listening_after_its_own_timeout_not_the_recording_cap() {
        let mut m = Machine::new(4_000, 15_000);
        assert_eq!(m.on_wake(0), Effect::State("heard"));
        assert_eq!(m.tick(3_999), Effect::None);
        assert_eq!(m.tick(4_000), Effect::State("listening"));
    }

    #[test]
    fn wake_while_transcribing_or_delivering_is_busy_not_buffered() {
        let mut m = Machine::new(4_000, 15_000);
        m.on_wake(0);
        m.on_speech_start(0);
        m.on_speech_end();
        assert_eq!(m.on_wake(1_000), Effect::Busy);
        assert_eq!(m.on_transcribed(true, 1_000), Effect::State("delivering"));
        assert_eq!(m.on_wake(1_500), Effect::Busy);
        assert_eq!(m.on_delivered(), Effect::State("listening"));
    }

    #[test]
    fn delivering_times_out_on_its_own_5s_window() {
        let mut m = Machine::new(4_000, 15_000);
        m.on_wake(0);
        m.on_speech_start(0);
        m.on_speech_end();
        m.on_transcribed(true, 0);
        assert_eq!(m.tick(4_999), Effect::None);
        assert_eq!(m.tick(5_000), Effect::State("listening"));
    }

    #[test]
    fn to_i16_le_clamps_out_of_range_samples() {
        let bytes = to_i16_le(&[2.0, -2.0, 0.0, 0.5]);
        assert_eq!(i16::from_le_bytes([bytes[0], bytes[1]]), i16::MAX);
        assert_eq!(i16::from_le_bytes([bytes[2], bytes[3]]), -i16::MAX); // -1.0 * MAX, not MIN
        assert_eq!(i16::from_le_bytes([bytes[4], bytes[5]]), 0);
    }

    #[test]
    fn resampler_is_continuous_across_a_chunk_boundary() {
        let signal: Vec<f32> = (0..40).map(|i| (i as f32 * 0.1).sin()).collect();

        let mut whole = Resampler::new(48_000, 16_000);
        let all_at_once = whole.push(&signal);

        let mut streamed = Resampler::new(48_000, 16_000);
        let mut split = streamed.push(&signal[..13]);
        split.extend(streamed.push(&signal[13..27]));
        split.extend(streamed.push(&signal[27..]));

        assert_eq!(all_at_once.len(), split.len());
        for (a, b) in all_at_once.iter().zip(split.iter()) {
            assert!((a - b).abs() < 1e-6, "{a} vs {b}");
        }
        assert!(!all_at_once.is_empty());
    }

    #[test]
    fn resampler_passes_through_unchanged_when_rates_match() {
        let mut r = Resampler::new(16_000, 16_000);
        assert_eq!(r.push(&[1.0, 2.0, 3.0]), vec![1.0, 2.0, 3.0]);
    }

    /// Push-to-talk taken mid-recording aborts the utterance instead of letting the 15 s
    /// cap transcribe a clip PTT audibly stepped on.
    #[test]
    fn abort_recording_drops_a_mid_utterance_back_to_listening() {
        let mut m = Machine::new(4_000, 15_000);
        m.on_wake(0);
        m.on_speech_start(0);
        assert_eq!(m.on_abort_recording(), Effect::State("listening"));
        // the 15 s cap no longer fires: recording_deadline was cleared, not just phase
        assert_eq!(m.tick(20_000), Effect::None);
    }

    #[test]
    fn abort_recording_is_a_noop_outside_recording() {
        let mut m = Machine::new(4_000, 15_000);
        assert_eq!(m.on_abort_recording(), Effect::None); // listening
        m.on_wake(0);
        assert_eq!(m.on_abort_recording(), Effect::None); // heard
    }

    /// Claiming the slot from `Off` moves it to `Starting`; a second claim while
    /// `Starting` is refused by name rather than racing `start_session` or silently no-op'ing.
    #[test]
    fn claim_start_refuses_a_second_call_while_starting() {
        let mut slot = Slot::Off;
        assert_eq!(claim_start(&mut slot), Ok(true));
        assert!(matches!(slot, Slot::Starting));
        assert!(claim_start(&mut slot).is_err());
        assert!(matches!(slot, Slot::Starting)); // the failed claim didn't disturb it
    }

    /// Backstop: `reap_if_dead` leaves `Off`/`Starting` alone — the interesting `Running`
    /// arm (a session whose reader thread already finished) needs a live `Session`, which
    /// can't be built without a real `AppHandle`; it is exercised by the reader thread's own
    /// unconditional `clear_own_slot` call on every exit path instead (see spawn_reader).
    #[test]
    fn reap_if_dead_leaves_off_and_starting_alone() {
        let mut off = Slot::Off;
        reap_if_dead(&mut off);
        assert!(matches!(off, Slot::Off));

        let mut starting = Slot::Starting;
        reap_if_dead(&mut starting);
        assert!(matches!(starting, Slot::Starting));
    }
}
