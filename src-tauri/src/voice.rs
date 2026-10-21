// Voice input: global push-to-talk hotkey → WASAPI capture → external whisper-cli →
// transcript handed back to the webview, which types it into the focused pane, unsent.
//
// Split: this file owns the mic and the child process; `src/voice.ts` owns the state
// machine (hold vs toggle, which pane) because the webview already owns `activeId`.
// Hotkey events are only forwarded ("voice-hotkey": "pressed" | "released"). The plugin
// gives exactly one Pressed per hold (RegisterHotKey with MOD_NOREPEAT) and a polled
// Released (global-hotkey 0.8, windows/mod.rs), and it marshals
// registration onto the main thread itself, so commands may call it from anywhere.
//
// Transcription is an external process on purpose: whisper-rs would tie every
// `cargo check` to a cmake build of whisper.cpp. The command comes from the `stt` voice slot
// (voice_slots::resolve), never from the webview, so swapping engines is a pick or a manifest.

use std::fs;
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::FromSample;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::voice_slots::{Resolved, Slot};

/// Hard cap on one recording (toggle mode with a forgotten stop). 48 kHz stereo f32 is
/// ~23 MB/min, so this bounds memory at ~46 MB and is longer than any prompt.
const MAX_SECONDS: usize = 120;
/// Peak below this is a muted/absent mic — don't pay a model load to hear nothing.
const SILENCE_PEAK: f32 = 0.01;
/// whisper.cpp's native rate; its loader resamples anyway, this just keeps the WAV small.
const TARGET_RATE: u32 = 16_000;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TranscriberCfg {
    pub command: String,
    /// Substitutions: `{wav}` (input path), `{out}` (output basename), `{prompt}`, and
    /// `{model}` (resolved from `VoiceCfg::model`). A literal `-m <path>` still works —
    /// it just means the model row in settings has nothing to drive. Read from vidar.json by
    /// the `stt` slot's legacy pick (voice_slots), never taken from the webview.
    pub args: Vec<String>,
}

impl Default for TranscriberCfg {
    fn default() -> Self {
        Self {
            command: crate::paths::whisper_dir().join("whisper-cli.exe").to_string_lossy().into_owned(),
            args: ["-m", "{model}", "-l", "en", "-nt", "-np", "-otxt", "--prompt", "{prompt}", "-f", "{wav}", "-of", "{out}"]
                .into_iter()
                .map(String::from)
                .collect(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VoiceCfg {
    /// global-hotkey chord syntax; "" disables voice input entirely
    pub hotkey: String,
    /// "hold" (press starts, release stops) or "toggle" (press starts, next press stops)
    pub mode: String,
    /// case-insensitive substring of a WASAPI input endpoint name; "" = Windows default
    pub device: String,
    /// whisper's initial prompt (`{prompt}` in the args): a spelling/casing bias for
    /// homophones and jargon, not a grammar. Short; long lists leak into output.
    pub prompt: String,
    /// Bare whisper model name (`small.en`), resolved to `ggml-<name>.bin` in `paths::whisper_dir()`;
    /// anything containing a separator or ending `.bin` is used verbatim. This is what
    /// `{model}` substitutes to, so it is the one knob the settings UI turns.
    pub model: String,
    pub transcriber: TranscriberCfg,
}

impl Default for VoiceCfg {
    fn default() -> Self {
        Self {
            // Ctrl+Alt+Space was rejected: it's Rider's
            // type-matching completion and RegisterHotKey would steal it globally.
            hotkey: "Ctrl+Shift+G".into(),
            mode: "hold".into(),
            device: String::new(),
            // Tauri sits in a sentence, not the list: whisper biases better on context than
            // on a bare enumeration, and "Tauri" came back as "toy" without it.
            prompt: "Coding in Vidar with Claude and Codex: git commits, PowerShell scripts, tabs, panes and the mic.".into(),
            // No code default: the model is a pick, `voice.model` in
            // vidar.json or `voiceSlots.stt`; nothing picked is the `stt` slot's `missing`.
            model: String::new(),
            transcriber: TranscriberCfg::default(),
        }
    }
}

struct Recording {
    stop: mpsc::Sender<()>,
    join: thread::JoinHandle<()>,
    samples: Arc<Mutex<Vec<f32>>>,
    rate: u32,
    channels: u16,
}

#[derive(Default)]
pub struct VoiceState {
    rec: Mutex<Option<Recording>>,
}

/* ---- capture ---- */

fn pick_device(host: &cpal::Host, filter: &str) -> Result<cpal::Device, String> {
    if filter.trim().is_empty() {
        return host.default_input_device().ok_or_else(|| "no default input device".to_string());
    }
    let want = filter.to_lowercase();
    let mut names = Vec::new();
    for d in host.input_devices().map_err(|e| e.to_string())? {
        let name = device_name(&d);
        if name.to_lowercase().contains(&want) {
            return Ok(d);
        }
        names.push(name);
    }
    Err(format!("no input device matching \"{filter}\"; available: {}", names.join(" | ")))
}

pub fn device_names() -> Result<Vec<String>, String> {
    let host = cpal::default_host();
    Ok(host
        .input_devices()
        .map_err(|e| e.to_string())?
        .map(|d| device_name(&d))
        .collect())
}

fn device_name(d: &cpal::Device) -> String {
    d.description().map(|desc| desc.name().to_string()).unwrap_or_default()
}

/// Generalisation of `build_stream`+`open_stream`: hands every converted-to-f32 callback slice
/// to a caller-built closure instead of sinking into a shared buffer, so listen.rs can resample
/// and forward to a sidecar without an intermediate `Arc<Mutex<Vec<f32>>>`. `open_stream` keeps
/// its own signature/behaviour on top of this so the 10 existing voice tests need no changes.
/// `make_on_data` takes the stream's native rate/channels (known only once cpal picks a config)
/// and builds the actual per-callback closure, so the caller never has to guess them up front.
pub(crate) fn open_stream_with<F, B>(filter: &str, make_on_data: F) -> Result<(cpal::Stream, u32, u16), String>
where
    B: FnMut(&[f32]) + Send + 'static,
    F: FnOnce(u32, u16) -> B,
{
    let host = cpal::default_host();
    let device = pick_device(&host, filter)?;
    let supported = device.default_input_config().map_err(|e| format!("input config: {e}"))?;
    let rate = supported.sample_rate();
    let channels = supported.channels();
    let cfg = supported.config();
    let on_data = make_on_data(rate, channels);
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => build_stream_with::<f32, B>(&device, cfg, on_data)?,
        cpal::SampleFormat::I16 => build_stream_with::<i16, B>(&device, cfg, on_data)?,
        cpal::SampleFormat::U16 => build_stream_with::<u16, B>(&device, cfg, on_data)?,
        cpal::SampleFormat::I32 => build_stream_with::<i32, B>(&device, cfg, on_data)?,
        other => return Err(format!("unsupported sample format {other:?}")),
    };
    stream.play().map_err(|e| format!("start stream: {e}"))?;
    Ok((stream, rate, channels))
}

fn build_stream_with<T, F>(device: &cpal::Device, cfg: cpal::StreamConfig, mut on_data: F) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample,
    f32: FromSample<T>,
    F: FnMut(&[f32]) + Send + 'static,
{
    // Converts to f32 on the callback (same cost `build_stream` already pays) and hands the
    // whole slice straight to the caller; no intermediate buffer, no lock.
    let mut scratch: Vec<f32> = Vec::new();
    device
        .build_input_stream(
            cfg,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                scratch.clear();
                scratch.extend(data.iter().map(|s| f32::from_sample_(*s)));
                on_data(&scratch);
            },
            |e| eprintln!("voice: stream error: {e}"),
            None,
        )
        .map_err(|e| e.to_string())
}

fn build_stream<T>(
    device: &cpal::Device,
    cfg: cpal::StreamConfig,
    sink: Arc<Mutex<Vec<f32>>>,
    max: usize,
) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample,
    f32: FromSample<T>,
{
    device
        .build_input_stream(
            cfg,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let mut buf = sink.lock().unwrap();
                let room = max.saturating_sub(buf.len());
                buf.extend(data.iter().take(room).map(|s| f32::from_sample_(*s)));
            },
            |e| eprintln!("voice: stream error: {e}"),
            None,
        )
        .map_err(|e| e.to_string())
}

fn open_stream(filter: &str, sink: Arc<Mutex<Vec<f32>>>) -> Result<(cpal::Stream, u32, u16), String> {
    let host = cpal::default_host();
    let device = pick_device(&host, filter)?;
    let supported = device.default_input_config().map_err(|e| format!("input config: {e}"))?;
    let rate = supported.sample_rate();
    let channels = supported.channels();
    let max = rate as usize * channels as usize * MAX_SECONDS;
    let cfg = supported.config();
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => build_stream::<f32>(&device, cfg, sink, max)?,
        cpal::SampleFormat::I16 => build_stream::<i16>(&device, cfg, sink, max)?,
        cpal::SampleFormat::U16 => build_stream::<u16>(&device, cfg, sink, max)?,
        cpal::SampleFormat::I32 => build_stream::<i32>(&device, cfg, sink, max)?,
        other => return Err(format!("unsupported sample format {other:?}")),
    };
    stream.play().map_err(|e| format!("start stream: {e}"))?;
    Ok((stream, rate, channels))
}

/// The stream lives and dies on one thread: created, played, then dropped when the stop
/// signal arrives (or the Recording is dropped and the sender goes with it). That keeps
/// every WASAPI object on the thread that made it and sidesteps any Send question.
fn start_capture(filter: &str) -> Result<Recording, String> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(u32, u16), String>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let samples = Arc::new(Mutex::new(Vec::new()));
    let sink = samples.clone();
    let filter = filter.to_string();
    let join = thread::spawn(move || {
        let stream = match open_stream(&filter, sink) {
            Ok((stream, rate, channels)) => {
                let _ = ready_tx.send(Ok((rate, channels)));
                stream
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
                return;
            }
        };
        let _ = stop_rx.recv();
        drop(stream);
    });
    match ready_rx.recv() {
        Ok(Ok((rate, channels))) => Ok(Recording { stop: stop_tx, join, samples, rate, channels }),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("capture thread died before reporting".into()),
    }
}

/* ---- DSP (pure; unit-tested) ---- */

pub fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0, |m, s| m.max(s.abs()))
}

pub fn downmix(samples: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }
    samples
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Linear interpolation. Good enough for speech into whisper, which itself resamples.
pub fn resample(mono: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || mono.is_empty() {
        return mono.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let out_len = ((mono.len() as f64) / ratio).floor() as usize;
    (0..out_len)
        .map(|i| {
            let pos = i as f64 * ratio;
            let idx = pos.floor() as usize;
            let frac = (pos - idx as f64) as f32;
            let a = mono[idx];
            let b = mono[(idx + 1).min(mono.len() - 1)];
            a + (b - a) * frac
        })
        .collect()
}

/// 16-bit PCM mono WAV at TARGET_RATE: 44-byte RIFF header, no dependency.
pub fn wav_bytes(mono: &[f32]) -> Vec<u8> {
    let data_len = (mono.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&TARGET_RATE.to_le_bytes());
    out.extend_from_slice(&(TARGET_RATE * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in mono {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// `voice.model` for the inline custom transcriber (`voice.transcriber`): a bare name
/// (`small.en`) is a file in the vendor dir; anything with a separator or a `.bin` suffix is a
/// path the user chose and is passed through untouched. Empty or absent is an `Err`, never a
/// default model.
pub fn model_path(model: Option<&str>) -> Result<String, String> {
    let m = model.map(str::trim).unwrap_or_default();
    if m.is_empty() {
        return Err("voice.model Is Not Set".into());
    }
    if m.contains('\\') || m.contains('/') || m.ends_with(".bin") {
        return Ok(m.to_string());
    }
    Ok(crate::paths::whisper_dir().join(format!("ggml-{m}.bin")).to_string_lossy().into_owned())
}

/// The per-call tokens of an `stt` adapter's args; `{model}` was filled by the slot resolve.
pub fn substitute(args: &[String], wav: &str, out: &str, prompt: &str) -> Vec<String> {
    args.iter().map(|a| a.replace("{wav}", wav).replace("{out}", out).replace("{prompt}", prompt)).collect()
}

/// One line, single-spaced, no CR/LF (a stray `\r` would be the Enter we promised not to
/// press). Bracketed/parenthesised tokens are whisper's non-speech annotations —
/// `[BLANK_AUDIO]`, `(upbeat music)`, `[inaudible]` — never dictation.
///
/// Tokens with no alphanumeric character are dropped too. Whisper renders a pause or
/// a trailing-off as a bare `...`, which survived the bracket pass and got typed into the tab; a
/// lone `...` into a Claude tab is a prompt, and answering it costs a turn. Dropping per TOKEN,
/// not per string, is deliberate: the common shape is a leading ellipsis on real speech
/// (`... yeah so the thing`), which a whole-string test misses.
///
/// `is_alphanumeric` is the Unicode Alphabetic/Numeric property, so CJK, kana, Hangul and Cyrillic
/// all survive while `。` and `、` are correctly dropped. This is right as written — do not
/// "fix" it to an ASCII test.
pub fn normalise(raw: &str) -> String {
    let mut s = String::with_capacity(raw.len());
    let mut depth = 0u32;
    for ch in raw.chars() {
        match ch {
            '[' | '(' => depth += 1,
            ']' | ')' => depth = depth.saturating_sub(1),
            _ if depth > 0 => {}
            _ => s.push(ch),
        }
    }
    s.split_whitespace()
        .filter(|t| t.chars().any(char::is_alphanumeric))
        .collect::<Vec<_>>()
        .join(" ")
}

/* ---- transcribe ---- */

/// `stem` names the output triple (`<stem>.wav`/`.txt`) under `paths::voice_dir()` so concurrent
/// callers (push-to-talk vs. wake-word) never race on `last.wav`/`last.txt`. PTT passes
/// `"last"` (unchanged on-disk name); listen.rs passes a per-utterance stem. `stt` is the
/// resolved `stt` slot; every failure names its adapter.
pub(crate) fn transcribe(stt: &Resolved, prompt: &str, samples: Vec<f32>, rate: u32, channels: u16, stem: &str) -> Result<String, String> {
    if samples.is_empty() || peak(&samples) < SILENCE_PEAK {
        return Ok(String::new());
    }
    let pcm = resample(&downmix(&samples, channels as usize), rate, TARGET_RATE);
    if pcm.len() < TARGET_RATE as usize / 4 {
        return Ok(String::new()); // under 250 ms: a tap, not speech
    }
    let dir = crate::paths::voice_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let wav = dir.join(format!("{stem}.wav"));
    let base = dir.join(stem);
    let txt = dir.join(format!("{stem}.txt"));
    fs::write(&wav, wav_bytes(&pcm)).map_err(|e| format!("write {}: {e}", wav.display()))?;
    let _ = fs::remove_file(&txt);

    let who = &stt.adapter;
    if stt.args.iter().any(|a| a.contains("{model}")) {
        return Err(format!("{who}: Unresolved {{model}}"));
    }
    let args = substitute(&stt.args, &wav.to_string_lossy(), &base.to_string_lossy(), prompt);
    // A loaded warm process (stt_warm.rs) writes the same `<base>.txt`; `None` = cold spawn.
    let started = std::time::Instant::now();
    let warm = match crate::stt_warm::try_run(stt, &wav, &base, pcm.len() as f64 / TARGET_RATE as f64) {
        Some(r) => {
            if let Err(e) = r {
                crate::stt_warm::record_last(true, started.elapsed()); // the warm path ran; it answered ok:false
                return Err(e);
            }
            true
        }
        None => {
            let output = Command::new(&stt.command)
                .args(&args)
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map_err(|e| format!("{who}: Cannot Run {}: {e}", stt.command.display()))?;
            if !output.status.success() {
                let err = String::from_utf8_lossy(&output.stderr);
                let tail: String = err.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" ");
                return Err(format!("{who}: Exit {}: {tail}", output.status));
            }
            false
        }
    };
    crate::stt_warm::record_last(warm, started.elapsed());
    let text = fs::read_to_string(&txt).map_err(|e| format!("{who}: Wrote No {}: {e}", txt.display()))?;
    Ok(normalise(&text))
}

/* ---- commands ---- */

#[tauri::command]
pub fn voice_devices() -> Result<Vec<String>, String> {
    device_names()
}

/// (Re)binds the one voice chord. Empty chord = unbind. Errors are the plugin's own
/// (parse failure, or RegisterHotKey refused because another app owns the chord).
#[tauri::command]
pub fn voice_register(app: AppHandle, chord: String) -> Result<(), String> {
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    if chord.trim().is_empty() {
        return Ok(());
    }
    gs.on_shortcut(chord.as_str(), |app, _shortcut, event| {
        let state = match event.state {
            ShortcutState::Pressed => "pressed",
            ShortcutState::Released => "released",
        };
        let _ = app.emit("voice-hotkey", state);
    })
    .map_err(|e| format!("hotkey \"{chord}\": {e}"))
}

/// Push-to-talk pauses wake-word listening for the hold (stop its capture stream, keep its
/// sidecar warm) so the two never fight the mic; `voice_stop` resumes it. A push-to-talk that
/// races a wake-word transcription still lands its own audio — listen.rs owns its own buffer.
#[tauri::command]
pub fn voice_start(state: State<VoiceState>, listen: State<crate::listen::ListenState>, device: String) -> Result<(), String> {
    let mut slot = state.rec.lock().unwrap();
    if slot.is_some() {
        return Ok(());
    }
    crate::listen::pause(&listen);
    match start_capture(&device) {
        Ok(rec) => {
            *slot = Some(rec);
            Ok(())
        }
        Err(e) => {
            crate::listen::resume(&listen);
            Err(e)
        }
    }
}

/// Stops the capture and, unless `discard`, runs the `stt` slot's adapter (resolved here, never
/// sent by the webview). Async so the model load doesn't sit on an invoke thread; the blocking
/// work is on the blocking pool.
#[tauri::command]
pub async fn voice_stop(state: State<'_, VoiceState>, listen: State<'_, crate::listen::ListenState>, prompt: String, discard: bool) -> Result<String, String> {
    let rec = state.rec.lock().unwrap().take().ok_or("not recording")?;
    let listen = listen.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = rec.stop.send(());
        let _ = rec.join.join();
        crate::listen::resume(&listen);
        if discard {
            return Ok(String::new());
        }
        let samples = std::mem::take(&mut *rec.samples.lock().unwrap());
        let stt = crate::voice_slots::resolve_for(Slot::Stt)?;
        transcribe(&stt, &prompt, samples, rec.rate, rec.channels, "last")
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmix_averages_frames() {
        assert_eq!(downmix(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        assert_eq!(downmix(&[0.2, 0.4], 1), vec![0.2, 0.4]);
    }

    #[test]
    fn resample_halves_and_keeps_endpoints() {
        let out = resample(&[0.0, 1.0, 2.0, 3.0], 4, 2);
        assert_eq!(out, vec![0.0, 2.0]);
        assert_eq!(resample(&[1.0, 2.0], 16_000, 16_000), vec![1.0, 2.0]);
        let up = resample(&[0.0, 1.0], 1, 2);
        assert_eq!(up.len(), 4);
        assert!((up[1] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn wav_header_is_44_bytes_16bit_mono_16k() {
        let b = wav_bytes(&[0.0, 1.0, -1.0]);
        assert_eq!(b.len(), 44 + 6);
        assert_eq!(&b[0..4], b"RIFF");
        assert_eq!(&b[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes([b[24], b[25], b[26], b[27]]), 16_000);
        assert_eq!(u16::from_le_bytes([b[34], b[35]]), 16);
        assert_eq!(i16::from_le_bytes([b[46], b[47]]), i16::MAX);
    }

    #[test]
    fn substitute_only_touches_placeholders() {
        let args: Vec<String> = ["-f", "{wav}", "-of", "{out}", "--prompt", "{prompt}", "-l"].iter().map(|s| s.to_string()).collect();
        assert_eq!(substitute(&args, "a.wav", "a", "mic, Claude"), vec!["-f", "a.wav", "-of", "a", "--prompt", "mic, Claude", "-l"]);
        assert_eq!(substitute(&args, "a.wav", "a", "")[5], "");
    }

    #[test]
    fn model_path_resolves_bare_names_only() {
        assert!(model_path(Some("small.en")).unwrap().ends_with("\\ggml-small.en.bin"));
        assert_eq!(model_path(Some("D:\\models\\custom.bin")).unwrap(), "D:\\models\\custom.bin");
        assert_eq!(model_path(Some("relative/ggml-x.bin")).unwrap(), "relative/ggml-x.bin");
        assert_eq!(model_path(Some("ggml-tiny.bin")).unwrap(), "ggml-tiny.bin");
        // no default model: empty or absent is an Err
        assert!(model_path(Some("  ")).is_err());
        assert!(model_path(None).is_err());
    }

    #[test]
    fn normalise_strips_annotations_and_newlines() {
        assert_eq!(normalise(" Hello,\n world.\r\n"), "Hello, world.");
        assert_eq!(normalise("[BLANK_AUDIO]"), "");
        assert_eq!(normalise("(upbeat music) fix the   test\n[inaudible] please"), "fix the test please");
    }

    /// Whisper's pause filler. Empty here means voice.ts shows "Nothing Detected" and types
    /// nothing; the partial case is the common one and must not survive either.
    #[test]
    fn normalise_drops_punctuation_only_tokens() {
        assert_eq!(normalise("..."), "");
        assert_eq!(normalise(" . "), "");
        assert_eq!(normalise("... yeah so the thing"), "yeah so the thing");
        assert_eq!(normalise("okay ... next"), "okay next");
        // punctuation attached to a word is part of the word, not a token of its own
        assert_eq!(normalise("Hello, world."), "Hello, world.");
        assert_eq!(normalise("wait -- no"), "wait no");
    }

    /// Unicode Alphabetic, not ASCII: non-Latin dictation must survive intact.
    #[test]
    fn normalise_keeps_non_latin() {
        assert_eq!(normalise("これはテストです"), "これはテストです");
        assert_eq!(normalise("привет мир"), "привет мир");
        assert_eq!(normalise("... 你好"), "你好");
        assert_eq!(normalise("。"), ""); // CJK full stop is punctuation, correctly dropped
    }

    #[test]
    fn peak_is_max_abs() {
        assert_eq!(peak(&[0.1, -0.7, 0.3]), 0.7);
        assert_eq!(peak(&[]), 0.0);
    }
}
