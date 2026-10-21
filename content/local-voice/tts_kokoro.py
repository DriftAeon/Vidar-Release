"""TTS adapter for the `tts` voice slot: Kokoro through the warm sidecar.

Two stock manifests run this script (packs/voice-stock/voice/):
  kokoro-kpipeline   --engine kpipeline --port 24242: hexgrad/Kokoro-82M through KPipeline
                     (PyTorch), the default Speak voice.
  kokoro-onnx-int8   --engine onnx --port 24243 --model-file ... --voices-file ...: the int8
                     model through kokoro-onnx (ONNX Runtime).
Each engine has its own port, so a changed pick never synthesises on the other engine's process;
only --stop and --status reach it (below).

Modes (every one takes --engine, --port and --owner; onnx also --model-file and --voices-file):
  run       --text <file> --out <wav> --voice <id> --speed <x>
            the text file's contents -> 16-bit PCM WAV at --out, starting the sidecar if it is
            down. Prints {"ok", "audio_seconds", "synth_seconds", "sidecar_wait_seconds", "voice"}.
  --warm    --voice <id>: start the sidecar if it is down. Prints {"sidecar_wait_seconds"}.
  --stop    ask the sidecar to quit while its owner tag is --owner, and the other stock port's
            too (STOCK_PORTS). Prints {"sidecar", "stopped", "owner",
            "others": [{"port", "sidecar", "stopped", "owner"}]} (others: only ports that answered).
  --status  prints {"sidecar", "owner", "owned", "engine", "others": [{"port", "engine", "owner"}]}.
A failure prints {"ok": false, "error"} on stdout and the error on stderr, exit 1.

Owner: the tag the sidecar carries, from the slot's {owner} (Vidar passes `vidar`; speak.py run
from a terminal passes `cli`). A `cli` run or warm re-tags a running Vidar sidecar `cli` (one
way only), so Vidar's launch stop leaves it up. `--stop` ends only a sidecar still tagged with
the caller's owner; the sidecar re-checks the tag on /quit, so a claim in between wins. A sidecar
from before the owner tag (owner null) is never stopped from here.

Process: the sidecar runs under the venv's pythonw.exe (the venv's python.exe is a stub whose
detached grandchild would open a console), DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP, and
CREATE_BREAKAWAY_FROM_JOB so it outlives the Speak run's jobs. If breakaway is refused inside a
job adapter_job.py made (VIDAR_ADAPTER_JOB=1), that is an error: a sidecar started inside it
would die with the run and cold-start on every Speak. Outside one it starts in the caller's own
job (a terminal's, or Vidar's when Vidar's job forbids breakaway: speak.rs then runs `--arm`
without a job of its own before each Speak, so the sidecar is up before the run's job exists). Stdlib only (urllib), so the per-chunk process start stays short.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PYTHONW = ROOT / ".venv" / "Scripts" / "pythonw.exe"
SIDECAR = ROOT / "kokoro_sidecar.py"
TMP = ROOT / ".tmp"
DEFAULT_IDLE_MIN = 240
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
ERROR_ACCESS_DENIED = 5
# The stock manifests' ports (packs/voice-stock/voice/kokoro-*.json); --stop and --status also
# look at the ones that are not --port, so a changed pick can still reach the old engine.
STOCK_PORTS = {"kpipeline": 24242, "onnx": 24243}
LISTEN_PROBE_S = 0.25
# Loopback only, never through a proxy from the environment.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def log(msg: str) -> None:
    print(f"[tts-kokoro] {msg}", file=sys.stderr, flush=True)


def call(port: int, path: str, body: dict | None = None, timeout: float = 2.0) -> tuple[int, dict | None]:
    """(status, JSON body) of one loopback request; a connection failure raises OSError."""
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        with _OPENER.open(req, timeout=timeout) as r:
            code, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        code, raw = e.code, e.read()
    try:
        out = json.loads(raw or b"null")
    except ValueError:
        out = None
    return code, out if isinstance(out, dict) else None


def listening(port: int) -> bool:
    """A short TCP connect first: on Windows a refused loopback connect is retried until the
    timeout (/health on a closed port takes the full 1.5 s, a listening
    one answers in ~3 ms), so a down port would cost every status and stop 1.5 s."""
    try:
        socket.create_connection(("127.0.0.1", port), timeout=LISTEN_PROBE_S).close()
        return True
    except OSError:
        return False


def health(port: int) -> dict | None:
    """The sidecar's /health body when Kokoro answers on `port`, else None."""
    if not listening(port):
        return None
    try:
        code, body = call(port, "/health", timeout=1.5)
    except OSError:
        return None
    return body if code == 200 and body and body.get("kokoro") else None


def check_engine(body: dict, args: argparse.Namespace) -> None:
    # An older sidecar reports no engine; it can only be KPipeline.
    running = body.get("engine") or "kpipeline"
    if running != args.engine:
        raise RuntimeError(f"Port {args.port} Runs Kokoro {running}, Not {args.engine}: Stop It First")


def claim(port: int) -> None:
    """Re-tag a running sidecar `cli`. Best effort: a pre-tag sidecar has no /owner."""
    try:
        code, _ = call(port, "/owner", {"owner": "cli"})
        if code == 200:
            log("claimed kokoro sidecar for cli")
    except OSError:
        pass


def spawn(argv: list[str], logfile: Path) -> None:
    """The sidecar, detached and out of this run's jobs (module doc)."""
    nt = os.name == "nt"
    flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP if nt else 0
    with open(logfile, "ab") as lf:
        kw = dict(stdin=subprocess.DEVNULL, stdout=lf, stderr=subprocess.STDOUT, cwd=str(ROOT), close_fds=True)
        try:
            subprocess.Popen(argv, creationflags=flags | (CREATE_BREAKAWAY_FROM_JOB if nt else 0), **kw)
            return
        except OSError as e:
            if getattr(e, "winerror", None) != ERROR_ACCESS_DENIED:
                raise
            if os.environ.get("VIDAR_ADAPTER_JOB") == "1":
                raise RuntimeError("Kokoro Cannot Break Away From the Adapter Job: Started Inside It, "
                                   "It Would Die With This Run") from e
        log("breakaway refused outside an adapter job: the sidecar starts in the caller's job")
        subprocess.Popen(argv, creationflags=flags, **kw)


def ensure(args: argparse.Namespace) -> float:
    """Start the sidecar if it is not answering; returns seconds waited."""
    body = health(args.port)
    if body is not None:
        check_engine(body, args)
        if args.owner == "cli" and body.get("owner") != "cli":
            claim(args.port)
        return 0.0
    if not PYTHONW.exists():
        raise RuntimeError(f"local-voice venv missing: {PYTHONW}")
    TMP.mkdir(exist_ok=True)
    logfile = TMP / ("kokoro-sidecar.log" if args.engine == "kpipeline" else f"kokoro-sidecar-{args.engine}.log")
    idle = os.environ.get("SIDECAR_IDLE_MIN", str(DEFAULT_IDLE_MIN))
    log(f"starting kokoro sidecar ({args.engine}) on {args.port} (log: {logfile})")
    argv = [str(PYTHONW), str(SIDECAR), "--serve", str(args.port), "--idle-min", idle,
            "--owner", args.owner, "--engine", args.engine, "--voice", args.voice]
    if args.engine == "onnx":
        argv += ["--model-file", args.model_file, "--voices-file", args.voices_file]
    spawn(argv, logfile)
    started = time.perf_counter()
    while time.perf_counter() - started < 120:
        time.sleep(0.25)
        if health(args.port) is not None:
            return round(time.perf_counter() - started, 1)
    raise RuntimeError(f"kokoro sidecar did not come up on {args.port} within 120 s; see {logfile}")


def run(args: argparse.Namespace) -> dict:
    text = Path(args.text).read_text(encoding="utf-8").strip()
    if not text:
        raise RuntimeError(f"Empty Text File {args.text}")
    wait = ensure(args)
    try:
        code, body = call(args.port, "/", {"text": text, "voice": args.voice, "speed": float(args.speed)}, timeout=300)
    except OSError as e:
        raise RuntimeError(f"kokoro sidecar on {args.port}: {e}") from e
    if not body or not body.get("ok"):
        raise RuntimeError(f"kokoro {code}: {(body or {}).get('error', 'no reply')}")
    shutil.move(body["wav"], args.out)
    return {"ok": True, "audio_seconds": body.get("audio_seconds"), "synth_seconds": body.get("synth_seconds"),
            "sidecar_wait_seconds": wait, "voice": body.get("voice")}


def stop_port(port: int, owner_tag: str) -> dict:
    """{"sidecar", "stopped", "owner"} for `port`: /quit only while tagged `owner_tag`."""
    body = health(port)
    owner = body.get("owner") if body else None
    if body is None or owner != owner_tag:
        return {"sidecar": body is not None, "stopped": False, "owner": owner}
    try:
        code, reply = call(port, "/quit", {"if_owner": owner_tag})
    except OSError:
        return {"sidecar": True, "stopped": False, "owner": owner}
    if code == 409:
        return {"sidecar": True, "stopped": False, "owner": (reply or {}).get("owner", owner)}
    return {"sidecar": True, "stopped": code == 200, "owner": owner}


def other_ports(args: argparse.Namespace) -> list[int]:
    return [p for p in STOCK_PORTS.values() if p != args.port]


def stop(args: argparse.Namespace) -> dict:
    """The picked engine's sidecar, then any other stock engine's still tagged --owner: after a
    changed pick the old engine's process would otherwise idle out unseen (240 min)."""
    result = {"ok": True, **stop_port(args.port, args.owner)}
    others = [{"port": p, **stop_port(p, args.owner)} for p in other_ports(args)]
    result["others"] = [o for o in others if o["sidecar"]]
    return result


def status(args: argparse.Namespace) -> dict:
    body = health(args.port)
    owner = body.get("owner") if body else None
    others = []
    for p in other_ports(args):
        b = health(p)
        if b is not None:
            others.append({"port": p, "engine": b.get("engine") or "kpipeline", "owner": b.get("owner")})
    return {"ok": True, "sidecar": body is not None, "owner": owner, "owned": owner == args.owner,
            "engine": (body.get("engine") or "kpipeline") if body else None, "others": others}


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--engine", required=True, choices=["kpipeline", "onnx"])
    ap.add_argument("--port", required=True, type=int)
    ap.add_argument("--owner", required=True)
    ap.add_argument("--model-file")
    ap.add_argument("--voices-file")
    ap.add_argument("--text")
    ap.add_argument("--out")
    ap.add_argument("--voice")
    ap.add_argument("--speed")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--warm", action="store_true")
    mode.add_argument("--stop", action="store_true")
    mode.add_argument("--status", action="store_true")
    args = ap.parse_args()
    if args.engine == "onnx" and (args.warm or not (args.stop or args.status)) and not (args.model_file and args.voices_file):
        ap.error("--engine onnx needs --model-file and --voices-file")
    if (args.warm or not (args.stop or args.status)) and not args.voice:
        ap.error("--voice is required: the slot's {voice} (the picked model), never a default")
    if not (args.warm or args.stop or args.status) and not (args.text and args.out and args.speed):
        ap.error("run needs --text, --out and --speed")
    try:
        if args.warm:
            result = {"ok": True, "sidecar_wait_seconds": ensure(args)}
        elif args.stop:
            result = stop(args)
        elif args.status:
            result = status(args)
        else:
            result = run(args)
    except Exception as e:  # noqa: BLE001 - one failure line, whatever it was
        result = {"ok": False, "error": str(e)}
        print(f"tts-kokoro: {e}", file=sys.stderr, flush=True)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
