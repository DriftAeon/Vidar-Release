"""Warm Kokoro process for Vidar's Speak action.

Keeps a Kokoro-82M engine loaded and turns text into a 24 kHz PCM-16 wav on
request, so each utterance costs synthesis only, not model load. Started by the tts
adapter tts_kokoro.py, which passes everything this needs:
  --engine kpipeline   KPipeline (PyTorch), hexgrad/Kokoro-82M from local-voice\\.cache
  --engine onnx        kokoro-onnx (ONNX Runtime) with --model-file and --voices-file
  --voice <id>         the voice for a request that names none; there is no built-in voice
Two transports carry the same JSON messages:

  --serve <port>   loopback HTTP (the transport tts_kokoro.py uses)
                   GET  /health            -> {"ok":true,"kokoro":true,"engine","voice","pid":N,"owner":S|null}
                   POST /       {"text","voice"?,"speed"?} -> {"wav","audio_seconds","synth_seconds","voice"}
                   POST /quit   {"if_owner"?} -> exits (409 when the owner tag differs)
                   POST /owner  {"owner":"cli"} -> re-tags to "cli" (the only direction)
  --stdio          one JSON object per line on stdin, one reply per line on stdout
                   ({"op":"health"} | {"text",...} | {"op":"quit"}); the contract a
                   Rust-spawned sidecar would use. Not wired to Vidar yet.

Exits on its own after --idle-min minutes without a request (default 30). Offline
only: weights come from local-voice\\.cache and nothing is downloaded. Wav files
land in local-voice\\.tmp and ones older than an hour are swept on each request.
Refuses: empty text, non-loopback binds (the bind address is not configurable).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache"
TMP = ROOT / ".tmp"
SAMPLE_RATE = 24_000
WAV_TTL_SECONDS = 3600
# Who spawned this process (--owner; tts_kokoro.py passes the slot's {owner}). Echoed in /health
# so Vidar's launch stop ends only a sidecar it started itself.
OWNER: str | None = None
# --engine and --voice, echoed in /health.
ENGINE: str | None = None
VOICE: str | None = None


def _offline_env() -> None:
    """Pin every cache to local-voice and forbid downloads, before kokoro imports."""
    os.environ.setdefault("HF_HOME", str(CACHE / "huggingface"))
    os.environ.setdefault("HF_HUB_CACHE", str(CACHE / "huggingface" / "hub"))
    os.environ.setdefault("XDG_CACHE_HOME", str(CACHE))
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    TMP.mkdir(exist_ok=True)
    os.environ["TEMP"] = str(TMP)
    os.environ["TMP"] = str(TMP)


_offline_env()

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402


def log(msg: str) -> None:
    print(f"[kokoro-sidecar] {msg}", file=sys.stderr, flush=True)


class Synth:
    def __init__(self, engine: str, model_file: str | None = None, voices_file: str | None = None) -> None:
        started = time.perf_counter()
        self.engine = engine
        if engine == "kpipeline":
            try:
                from kokoro import KPipeline  # heavy import: torch, spaCy
            except ImportError as e:
                raise RuntimeError(
                    "The KPipeline voice needs the Speak extra: pwsh -File tools/voice/setup-voice.ps1 -Speak"
                ) from e

            self.pipeline = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
        else:
            try:
                from kokoro_onnx import Kokoro
            except ImportError as e:
                raise RuntimeError("kokoro-onnx is not installed in the local-voice venv: pwsh -File tools/voice/setup-voice.ps1") from e
            self.onnx = Kokoro(model_file, voices_file)
        self.lock = threading.Lock()
        self.last_request = time.monotonic()
        log(f"{engine} ready in {time.perf_counter() - started:.2f}s")

    def touch(self) -> None:
        self.last_request = time.monotonic()

    def _parts(self, text: str, voice: str, speed: float) -> list[np.ndarray]:
        if self.engine == "onnx":
            # kokoro-onnx picks the phonemizer language itself; the b* voices are British.
            samples, rate = self.onnx.create(text, voice=voice, speed=speed, lang="en-gb" if voice.startswith("b") else "en-us")
            if rate != SAMPLE_RATE:
                raise RuntimeError(f"kokoro-onnx returned {rate} Hz, expected {SAMPLE_RATE}")
            return [np.asarray(samples, dtype=np.float32).reshape(-1)]
        parts = []
        for _, _, audio in self.pipeline(text, voice=voice, speed=speed):
            arr = audio.numpy() if hasattr(audio, "numpy") else audio
            parts.append(np.asarray(arr, dtype=np.float32).reshape(-1))
        return parts

    def speak(self, text: str, voice: str, speed: float = 1.0) -> dict:
        text = (text or "").strip()
        if not text:
            raise ValueError("empty text")
        if not voice:
            raise ValueError("no voice")
        speed = min(2.0, max(0.5, float(speed or 1.0)))
        started = time.perf_counter()
        with self.lock:
            self.touch()
            parts = self._parts(text, voice, speed)
        if not parts:
            raise RuntimeError("kokoro produced no audio")
        # Kokoro splits long text on sentence boundaries; a short gap between
        # chunks reads as a breath rather than a cut.
        gap = np.zeros(int(SAMPLE_RATE * 0.15), dtype=np.float32)
        joined: list[np.ndarray] = []
        for i, part in enumerate(parts):
            if i:
                joined.append(gap)
            joined.append(part)
        audio = np.concatenate(joined) if len(joined) > 1 else joined[0]
        self._sweep()
        out = TMP / f"speak-{uuid.uuid4().hex[:8]}.wav"
        sf.write(out, audio, SAMPLE_RATE, subtype="PCM_16")
        return {
            "wav": str(out),
            "audio_seconds": round(len(audio) / SAMPLE_RATE, 3),
            "synth_seconds": round(time.perf_counter() - started, 3),
            "voice": voice,
        }

    @staticmethod
    def _sweep() -> None:
        cutoff = time.time() - WAV_TTL_SECONDS
        for old in TMP.glob("speak-*.wav"):
            try:
                if old.stat().st_mtime < cutoff:
                    old.unlink()
            except OSError:
                pass


def handle(synth: Synth, msg: dict) -> dict:
    op = msg.get("op")
    if op == "health":
        synth.touch()
        return {"ok": True, "kokoro": True, "engine": ENGINE, "voice": VOICE, "pid": os.getpid(), "owner": OWNER}
    if op == "quit":
        return {"ok": True, "quit": True}
    try:
        return {"ok": True, **synth.speak(str(msg.get("text", "")), str(msg.get("voice") or VOICE), msg.get("speed") or 1.0)}
    except Exception as e:  # noqa: BLE001 — one reply per request, whatever went wrong
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def idle_watchdog(synth: Synth, idle_min: float) -> None:
    if idle_min <= 0:
        return  # 0 = stay until /quit (the Speak button's explicit off)
    limit = idle_min * 60
    while True:
        time.sleep(15)
        if time.monotonic() - synth.last_request > limit:
            log(f"idle for {idle_min} min, exiting")
            os._exit(0)


def serve(synth: Synth, port: int) -> None:
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        def _reply(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/health":
                self._reply(200, handle(synth, {"op": "health"}))
            else:
                self._reply(404, {"ok": False, "error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            global OWNER
            if self.path not in ("/", "/quit", "/owner"):
                self._reply(404, {"ok": False, "error": "not found"})
                return
            try:
                n = int(self.headers.get("Content-Length") or 0)
                msg = json.loads(self.rfile.read(n) or b"{}")
            except (ValueError, json.JSONDecodeError) as e:
                self._reply(400, {"ok": False, "error": f"bad json: {e}"})
                return
            if not isinstance(msg, dict):
                msg = {}
            if self.path == "/quit":
                # {"if_owner": S}: quit only while the tag is still S, checked here so a CLI
                # claim between speak.py's status read and this call wins. No body: any owner.
                want = msg.get("if_owner")
                if want is not None and want != OWNER:
                    self._reply(409, {"ok": False, "quit": False, "owner": OWNER})
                    return
                self._reply(200, {"ok": True, "quit": True})
                threading.Thread(target=lambda: (time.sleep(0.2), os._exit(0)), daemon=True).start()
                return
            if self.path == "/owner":
                # One-way claim: a CLI use takes over a sidecar Vidar started, so Vidar's
                # launch stop leaves it up. Nothing ever re-tags a sidecar away from "cli".
                if msg.get("owner") != "cli":
                    self._reply(400, {"ok": False, "error": "owner can only become \"cli\"", "owner": OWNER})
                    return
                OWNER = "cli"
                log("owner claimed by cli")
                self._reply(200, {"ok": True, "owner": OWNER})
                return
            out = handle(synth, msg)
            self._reply(200 if out.get("ok") else 500, out)

        def log_message(self, fmt: str, *args: object) -> None:
            log(fmt % args)

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"READY 127.0.0.1:{port}", flush=True)
    log(f"listening on 127.0.0.1:{port}")
    server.serve_forever()


def stdio(synth: Synth) -> None:
    print(json.dumps({"ready": True, "pid": os.getpid()}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"ok": False, "error": f"bad json: {e}"}), flush=True)
            continue
        out = handle(synth, msg)
        print(json.dumps(out), flush=True)
        if out.get("quit"):
            return


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--serve", type=int, metavar="PORT", help="loopback HTTP on this port")
    mode.add_argument("--stdio", action="store_true", help="JSON lines on stdin/stdout")
    ap.add_argument("--idle-min", type=float, default=30, help="exit after this many idle minutes; 0 = never")
    ap.add_argument("--owner", default=None, help="spawner tag echoed in /health (vidar, cli)")
    ap.add_argument("--engine", required=True, choices=["kpipeline", "onnx"])
    ap.add_argument("--voice", required=True, help="voice for a request that names none (the slot's {voice})")
    ap.add_argument("--model-file", help="--engine onnx: the .onnx model")
    ap.add_argument("--voices-file", help="--engine onnx: the voices .bin")
    args = ap.parse_args()
    if args.engine == "onnx" and not (args.model_file and args.voices_file):
        ap.error("--engine onnx needs --model-file and --voices-file")
    global OWNER, ENGINE, VOICE
    OWNER, ENGINE, VOICE = args.owner, args.engine, args.voice

    synth = Synth(args.engine, args.model_file, args.voices_file)
    threading.Thread(target=idle_watchdog, args=(synth, args.idle_min), daemon=True).start()
    if args.stdio:
        stdio(synth)
    else:
        serve(synth, args.serve)


if __name__ == "__main__":
    main()
