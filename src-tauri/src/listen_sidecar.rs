// The wake sidecar's process edge, split out of listen.rs: spawning the
// `wake` slot's adapter with its tokens filled, the bounded ready handshake, and the JSONL event
// parser. listen.rs owns the threads and the state machine that consume these.
//
// Contract (contracts/voice-slots.json `wake`): stdin takes 1280-sample i16 LE blocks at
// 16 kHz; stdout is JSONL `{ready,pid}`, `{ev:wake,score}`, `{ev:speech_start}`,
// `{ev:speech_end}`, `{ev:error,msg}`; stderr is free-form diagnostics (listen.rs keeps a tail).

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::os::windows::process::CommandExt;
use std::process::{ChildStderr, ChildStdout, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::listen::WakewordCfg;
use crate::proc_job::JobChild;
use crate::voice_slots::Resolved;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum SidecarEvent {
    Ready { pid: u32 },
    Wake { score: f32 },
    SpeechStart,
    SpeechEnd,
    Error { msg: String },
}

pub(crate) fn parse_event(line: &str) -> Result<SidecarEvent, String> {
    let v: Value = serde_json::from_str(line.trim()).map_err(|e| format!("bad sidecar line: {e}"))?;
    if v.get("ready").and_then(Value::as_bool) == Some(true) {
        let pid = v.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32;
        return Ok(SidecarEvent::Ready { pid });
    }
    match v.get("ev").and_then(Value::as_str) {
        Some("wake") => Ok(SidecarEvent::Wake { score: v.get("score").and_then(Value::as_f64).unwrap_or(0.0) as f32 }),
        Some("speech_start") => Ok(SidecarEvent::SpeechStart),
        Some("speech_end") => Ok(SidecarEvent::SpeechEnd),
        Some("error") => Ok(SidecarEvent::Error { msg: v.get("msg").and_then(Value::as_str).unwrap_or("").to_string() }),
        Some(other) => Err(format!("unknown sidecar event \"{other}\"")),
        None => Err("sidecar line has neither \"ready\" nor \"ev\"".into()),
    }
}

/// The `wake` tokens the slot resolve leaves for the stage: tuning from `cfg`, `{parentPid}` from
/// this process. `{model}` was filled by the resolve; one left over is an `Err`, not a guess.
pub(crate) fn fill_args(wake: &Resolved, cfg: &WakewordCfg, parent_pid: u32) -> Result<Vec<String>, String> {
    let tokens = [
        ("{threshold}", cfg.threshold.to_string()),
        ("{vadStart}", cfg.vad_start.to_string()),
        ("{vadStop}", cfg.vad_stop.to_string()),
        ("{endSilenceMs}", cfg.end_silence_ms.to_string()),
        ("{heardTimeoutMs}", cfg.heard_timeout_ms.to_string()),
        ("{parentPid}", parent_pid.to_string()),
    ];
    wake.args
        .iter()
        .map(|a| {
            let filled = tokens.iter().fold(a.clone(), |s, (t, v)| s.replace(t, v));
            if filled.contains("{model}") {
                Err(format!("{}: Unresolved {{model}}", wake.adapter))
            } else {
                Ok(filled)
            }
        })
        .collect()
}

/// Spawns the resolved `wake` adapter with all three pipes, inside its own kill-on-close job:
/// a venv `python.exe` is a launcher stub, and killing only the stub left the real
/// interpreter holding the mic and the pipes (proc_job.rs).
pub(crate) fn spawn(wake: &Resolved, cfg: &WakewordCfg) -> Result<JobChild, String> {
    let args = fill_args(wake, cfg, std::process::id())?;
    let mut cmd = Command::new(&wake.command);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    JobChild::spawn(&mut cmd)
        .map_err(|e| format!("{}: Cannot Run {}: {e}", wake.adapter, wake.command.display()))
}

/// Bounds the sidecar's model-load-then-`ready` handshake to 5 s: the
/// blocking `read_line` runs on its own short-lived thread so a hung/crashed-silently sidecar
/// can't wedge the blocking-pool thread `listen_start` runs on forever.
pub(crate) fn read_ready_line(mut reader: BufReader<ChildStdout>) -> Result<(BufReader<ChildStdout>, String), String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut line = String::new();
        let res = reader.read_line(&mut line).map(|_| (reader, line));
        let _ = tx.send(res);
    });
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(pair)) => Ok(pair),
        Ok(Err(e)) => Err(format!("listen: sidecar: {e}")),
        Err(_) => Err("listen: sidecar did not report ready within 5s".into()),
    }
}

/// A failed handshake's reason with the sidecar's last `n` stderr lines appended, so a Python
/// traceback before `ready` is not lost. Call after the kill (the pipe then closes); lines are
/// collected for at most 500 ms, in case a grandchild still holds the pipe open.
pub(crate) fn with_stderr_tail(reason: String, stderr: Option<ChildStderr>, n: usize) -> String {
    let Some(stderr) = stderr else { return reason };
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                return;
            }
        }
    });
    let deadline = Instant::now() + Duration::from_millis(500);
    let mut tail = VecDeque::with_capacity(n);
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(line) if line.trim().is_empty() => {}
            Ok(line) => {
                if tail.len() >= n {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
            Err(_) => break,
        }
    }
    if tail.is_empty() {
        return reason;
    }
    format!("{reason}. Stderr: {}", Vec::from(tail).join(" | "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice_slots::Source;

    #[test]
    fn parse_event_reads_every_line_shape() {
        assert_eq!(parse_event(r#"{"ready":true,"pid":123}"#), Ok(SidecarEvent::Ready { pid: 123 }));
        assert_eq!(parse_event(r#"{"ev":"wake","score":0.93}"#), Ok(SidecarEvent::Wake { score: 0.93 }));
        assert_eq!(parse_event(r#"{"ev":"speech_start"}"#), Ok(SidecarEvent::SpeechStart));
        assert_eq!(parse_event(r#"{"ev":"speech_end"}"#), Ok(SidecarEvent::SpeechEnd));
        assert_eq!(parse_event(r#"{"ev":"error","msg":"boom"}"#), Ok(SidecarEvent::Error { msg: "boom".into() }));
    }

    #[test]
    fn parse_event_refuses_unknown_or_shapeless_lines() {
        assert!(parse_event(r#"{"ev":"mystery"}"#).is_err());
        assert!(parse_event(r#"{"nonsense":1}"#).is_err());
        assert!(parse_event("not json").is_err());
    }

    /// The manifest's `wake` tokens (content/packs/voice-stock/voice/openwakeword.json) against what
    /// Rust fills: a token the stage does not fill would reach the sidecar verbatim.
    #[test]
    fn listen_fill_args_fills_every_wake_token_and_refuses_an_unresolved_model() {
        let wake = |args: &[&str]| Resolved {
            adapter: "voice-stock/openwakeword".into(),
            source: Source::Stock,
            command: "python.exe".into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            model: None,
            warm: None,
            stop: None,
            status: None,
        };
        let cfg = WakewordCfg { threshold: 0.6, vad_start: 0.5, vad_stop: 0.35, end_silence_ms: 800, heard_timeout_ms: 4000, ..WakewordCfg::default() };
        let manifest: Value = serde_json::from_str(include_str!("../../content/packs/voice-stock/voice/openwakeword.json")).unwrap();
        let args: Vec<&str> = manifest["run"]["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
        // what the resolve already expanded: `{model}` and the rooted paths
        let args: Vec<&str> = args
            .into_iter()
            .map(|a| if a == "{model}" { "C:/m/pico.onnx" } else if a.starts_with("{vidar}") { "C:/v/file" } else { a })
            .collect();
        let filled = fill_args(&wake(&args), &cfg, 42).unwrap();
        assert!(filled.iter().all(|a| !a.contains('{')), "{filled:?}");
        assert!(filled.windows(2).any(|w| w[0] == "--threshold" && w[1] == "0.6"));
        assert!(filled.windows(2).any(|w| w[0] == "--parent-pid" && w[1] == "42"));
        assert!(fill_args(&wake(&["--model", "{model}"]), &cfg, 42).is_err());
    }
}
