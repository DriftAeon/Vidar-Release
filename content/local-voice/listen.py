"""Wake-word + VAD sidecar for Vidar's Listen action.

Reads raw 16 kHz mono int16 PCM from stdin in 2560-byte blocks (1280 samples =
80 ms, openWakeWord's own ideal frame length) and writes one JSON object per
line to stdout, flushed immediately:

    {"ready":true,"pid":N}
    {"ev":"wake","score":0.93}
    {"ev":"speech_start"}
    {"ev":"speech_end"}
    {"ev":"error","msg":"..."}

stderr carries `[listen] ...` diagnostics only. Not JSON in: audio is binary,
so unlike `kokoro_sidecar.py --stdio` there is no line-based request side.

Model gating: openWakeWord's own `Model.predict` runs on every block to score
the wake word; on a hit (score >= --threshold, and at least one second since
the last wake) the sidecar emits "wake" and starts also running Silero VAD
(`openwakeword.vad.VAD`, loaded from --vad-model directly — the
package's own `vad_threshold` stays 0 on `Model` so it never tries to load its
bundled copy, which this venv does not have) per block: "speech_start" once
the VAD probability crosses --vad-threshold, "speech_end" once it has stayed
below --vad-stop for --end-silence-ms. If speech never starts within
--heard-timeout-ms of a wake, the sidecar quietly drops back to listening for
a fresh wake — Rust has its own copy of that timeout for the UI (they should
be passed the same value), this is just so the sidecar itself is never
wedged. The sidecar never caps a recording; Rust owns the 15 s ceiling.

Exit conditions, all clean (exit 0) except a missing model file at startup:
  - stdin hits EOF (`read()` returns b""): the writer closed the pipe.
  - no audio at all for thirty seconds: something upstream stalled. Raised from ten
    push-to-talk pauses Rust's own capture stream, and
    the writer thread now feeds silence blocks at the real 80 ms cadence while paused
    instead of going quiet, but thirty seconds is kept as the backstop for a PTT hold
    (or any other stall) that runs long.
  - the parent process (--parent-pid) is gone: polled every two seconds via
    OpenProcess/GetExitCodeProcess so a killed Vidar cannot orphan this.
Every model file comes in as a path argument (--model, --melspec, --embedding,
--vad-model); there are no defaults and no lookup. Vidar resolves them from the
`wake` slot's manifest and checks their pins (sha256) before it spawns this
a missing file here emits "error" and exits 2.
`openwakeword.utils.download_models` is never imported — no network path.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import queue
import sys
import threading
import time
from pathlib import Path
from typing import NoReturn

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache"
TMP = ROOT / ".tmp"

FRAME_SAMPLES = 1280  # 80 ms @ 16 kHz, openWakeWord's ideal Model.predict block
FRAME_BYTES = FRAME_SAMPLES * 2  # int16
VAD_FRAME = 640  # must divide FRAME_SAMPLES; 480 does not (§7 override)
NO_AUDIO_TIMEOUT_S = 30.0
PARENT_POLL_S = 2.0
WAKE_REFRACTORY_S = 1.0
HEARD_TIMEOUT_S = 4.0  # mirrors WakewordCfg.heardTimeoutMs's default (Rust owns the UI copy)
VAD_STOP_DEFAULT = 0.35


def log(msg: str) -> None:
    print(f"[listen] {msg}", file=sys.stderr, flush=True)


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def _offline_env() -> None:
    """Pin every cache to local-voice and forbid downloads, before openwakeword imports."""
    os.environ.setdefault("HF_HOME", str(CACHE / "huggingface"))
    os.environ.setdefault("HF_HUB_CACHE", str(CACHE / "huggingface" / "hub"))
    os.environ.setdefault("XDG_CACHE_HOME", str(CACHE))
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    TMP.mkdir(exist_ok=True)
    os.environ["TEMP"] = str(TMP)
    os.environ["TMP"] = str(TMP)


def _model_files(args: argparse.Namespace) -> tuple[dict[str, Path] | None, str]:
    """The four model paths as given; a missing one is an error, never a fallback."""
    files = {"model": args.model, "melspec": args.melspec, "embedding": args.embedding, "vad-model": args.vad_model}
    out: dict[str, Path] = {}
    for flag, value in files.items():
        p = Path(value)
        if not p.is_file():
            return None, f"--{flag} not found: {value}"
        out[flag] = p.resolve()
    return out, ""


def _watch_parent(pid: int, stop_event: threading.Event) -> None:
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259
    kernel32 = ctypes.windll.kernel32
    while not stop_event.is_set():
        time.sleep(PARENT_POLL_S)
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            log(f"parent pid {pid} gone, exiting")
            os._exit(0)
        exit_code = ctypes.c_ulong(0)
        ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))
        kernel32.CloseHandle(handle)
        if not ok or exit_code.value != STILL_ACTIVE:
            log(f"parent pid {pid} exited, exiting")
            os._exit(0)


def _stdin_reader(q: "queue.Queue[bytes | None]") -> None:
    stream = sys.stdin.buffer
    while True:
        chunk = stream.read(4096)
        q.put(chunk if chunk else None)
        if not chunk:
            return


class _Parser(argparse.ArgumentParser):
    """argparse, but a bad command line is also an {"ev":"error"} on stdout, where Rust reads."""

    def error(self, message: str) -> NoReturn:
        emit({"ev": "error", "msg": f"bad arguments: {message}"})
        super().error(message)


def main() -> None:
    ap = _Parser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stdio", action="store_true", help="accepted for parity with kokoro_sidecar.py; the only transport here is stdio")
    ap.add_argument("--model", required=True, help="path to the wake-word classifier .onnx")
    ap.add_argument("--melspec", required=True, help="path to melspectrogram.onnx")
    ap.add_argument("--embedding", required=True, help="path to embedding_model.onnx")
    ap.add_argument("--vad-model", required=True, dest="vad_model", help="path to silero_vad.onnx")
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--vad-threshold", type=float, default=0.5, dest="vad_start")
    ap.add_argument("--vad-stop", type=float, default=VAD_STOP_DEFAULT)
    ap.add_argument("--end-silence-ms", type=int, default=800)
    ap.add_argument("--heard-timeout-ms", type=int, default=int(HEARD_TIMEOUT_S * 1000), help="revert to idle if speech never starts this long after a wake")
    ap.add_argument("--parent-pid", type=int, default=None)
    ap.add_argument("--debug-scores", action="store_true", help="tuning aid: emit {\"ev\":\"score\"} every block")
    args = ap.parse_args()

    _offline_env()

    files, err = _model_files(args)
    if files is None:
        emit({"ev": "error", "msg": err})
        sys.exit(2)

    import numpy as np
    from openwakeword.model import Model
    from openwakeword.vad import VAD

    wake_path = files["model"]
    model_name = wake_path.stem
    oww = Model(
        wakeword_models=[str(wake_path)],
        inference_framework="onnx",
        melspec_model_path=str(files["melspec"]),
        embedding_model_path=str(files["embedding"]),
        vad_threshold=0,  # openwakeword's own VAD stays off; ours is driven below
    )
    vad = VAD(model_path=str(files["vad-model"]))

    stop_event = threading.Event()
    if args.parent_pid:
        threading.Thread(target=_watch_parent, args=(args.parent_pid, stop_event), daemon=True).start()

    emit({"ready": True, "pid": os.getpid()})
    log(f"ready: model={model_name} threshold={args.threshold} vad={args.vad_start}/{args.vad_stop} end_silence_ms={args.end_silence_ms} heard_timeout_ms={args.heard_timeout_ms}")

    q: "queue.Queue[bytes | None]" = queue.Queue()
    threading.Thread(target=_stdin_reader, args=(q,), daemon=True).start()

    frame_ms = FRAME_SAMPLES / 16000 * 1000
    phase = "idle"  # idle -> pre (awaiting speech) -> speech -> idle
    last_wake_time = -1e9
    pre_started_at = 0.0
    silence_ms = 0.0
    buf = bytearray()
    reason = "eof"

    try:
        while True:
            try:
                chunk = q.get(timeout=NO_AUDIO_TIMEOUT_S)
            except queue.Empty:
                reason = "no audio for 30s"
                break
            if chunk is None:
                reason = "eof"
                break
            buf.extend(chunk)
            while len(buf) >= FRAME_BYTES:
                frame = bytes(buf[:FRAME_BYTES])
                del buf[:FRAME_BYTES]
                x = np.frombuffer(frame, dtype=np.int16).copy()

                scores = oww.predict(x)
                score = float(scores.get(model_name, 0.0))
                if args.debug_scores:
                    emit({"ev": "score", "score": round(score, 4)})

                now = time.monotonic()
                if phase == "idle":
                    if score >= args.threshold and (now - last_wake_time) >= WAKE_REFRACTORY_S:
                        last_wake_time = now
                        phase = "pre"
                        pre_started_at = now
                        vad.reset_states()
                        emit({"ev": "wake", "score": round(score, 4)})
                elif phase == "pre":
                    prob = float(vad.predict(x, frame_size=VAD_FRAME))
                    if prob > args.vad_start:
                        phase = "speech"
                        silence_ms = 0.0
                        emit({"ev": "speech_start"})
                    elif now - pre_started_at > args.heard_timeout_ms / 1000.0:
                        phase = "idle"
                elif phase == "speech":
                    prob = float(vad.predict(x, frame_size=VAD_FRAME))
                    if prob < args.vad_stop:
                        silence_ms += frame_ms
                        if silence_ms >= args.end_silence_ms:
                            phase = "idle"
                            vad.reset_states()
                            emit({"ev": "speech_end"})
                    else:
                        silence_ms = 0.0
    finally:
        stop_event.set()

    log(f"exiting: {reason}")
    if reason != "eof":
        emit({"ev": "error", "msg": reason})


if __name__ == "__main__":
    main()
