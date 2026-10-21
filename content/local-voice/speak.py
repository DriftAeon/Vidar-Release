"""Speak the latest agent reply: transcript -> rewrite slot -> tts slot -> speakers.

The "Speak" action for Vidar, callable from any terminal, a skill, or
the bottom-bar button (src-tauri\\src\\speak.rs runs exactly this with --json).

Usage (from the repo root, with the local-voice venv's python):
  local-voice\\.venv\\Scripts\\python.exe local-voice\\speak.py [--cwd <dir>]
      [--text "..." | --stdin] --slots-file <resolved.json> [--no-rewrite] [--dry]
      [--voice <id>] [--owner <tag>] [--json] [--arm | --status | --stop]

  --cwd      which project's transcripts to read (default: the current directory); the
             newest of two stores by mtime is "the session". Claude: a .jsonl under
             ~\\.claude\\projects\\<slug>\\, its last non-sidechain assistant text block is
             "the latest reply". Codex: a rollout-*.jsonl under ~\\.codex\\sessions\\<yyyy>\\<mm>\\<dd>\\
             from the last 3 days whose first line (type "session_meta") has payload.cwd equal
             to --cwd, case-insensitively; its last line of type "response_item" with
             payload {type "message", role "assistant"} and a content block of type
             "output_text" is "the latest reply".
  --text / --stdin   speak this instead of a transcript (A/B the rewrite on any text).
  --slots-file  bridge\\voice-slots\\resolved.json, written by Vidar per Speak press
             (voice_slots::write_resolved). Its `rewrite` slot picks the adapter: a filled
             slot runs that adapter (stock: voice-stock/openai-compat = LM Studio,
             rewrite_openai.py; voice-stock/claude-p = `claude -p`, rewrite_claude.py);
             an empty slot strips markdown mechanically and reads verbatim; a broken or
             missing slot fails the run and names the adapter. Its `tts` slot (required, no
             legacy key) picks the voice adapter (stock: voice-stock/kokoro-kpipeline,
             voice-stock/kokoro-onnx-int8; both tts_kokoro.py). Required in every mode.
  --no-rewrite  run the empty-slot path whatever the rewrite slot says.
  --dry      print the text that would be spoken and stop before the tts slot.
  --voice    the tts slot's {voice}; default: the slot's picked model id. Neither = an error.
  --owner    the lifecycle {owner} (speak.rs passes "vidar"; a terminal is "cli").
  --json     one JSON object on stdout at the end (ok, spoken, source, timings or error);
             progress still goes to stderr.
  --arm      bring the voice up and stop: the tts adapter's `warm` (Kokoro: start the warm
             process if it is not answering), then the rewrite adapter's `warm` if it has one
             (openai-compat: LM Studio's server up and the model loaded; timings merged in).
  --status   the tts adapter's `status` (Kokoro: {"sidecar", "owner", "owned", "engine"}) plus
             `rewrite` (that adapter's `status`) when the rewrite slot is filled and has one.
  --stop     the tts adapter's `stop` with --owner (Kokoro: quits only while tagged --owner).

The rewrite adapter gets the prepared reply on stdin and `{budget}` (the word budget) in its
args; `{lmstudioOrigin}` is already filled by Vidar from vidar.json. Only the openai-compat
adapter touches LM Studio; an empty slot or claude-p never does. Adapters run with no console
window (CREATE_NO_WINDOW), their stderr is copied into this script's. The tts adapter runs once
per chunk: `{text}` a UTF-8 file, `{out}` the WAV it must write (16-bit PCM), `{voice}`,
`{speed}` (SPEAK_SPEED, default 1.15) and `{owner}`. The Kokoro adapter's warm
process, owner tags and ports are documented in tts_kokoro.py.

Jobs: each adapter runs in its own kill-on-close job (adapter_job.py). The tts adapter does so
only while this process may break away from every job it is in (adapter_job.can_break_away);
otherwise the warm process it starts could live only inside that job and would die with the
run, so the tts adapter runs without one and the warm process lands in the caller's job.

Speech is chunked: the first sentence goes to the tts slot alone and plays while the rest
is synthesised in the background, so audio starts about a second after the rewrite returns
instead of after the whole utterance is rendered. Playback is winsound (in-process,
blocking), so killing this script stops the audio.

The rewrite prompt gives the model a word budget computed from the reply's length and one
worked example; a 4B model follows a number and an example far better than "as short
as the reply allows" (which produced anything from a fifth to a copy). The example
used to end on a question and the model invented one of its own on a reply that asked
nothing, so the example ends flat and a rule forbids adding one; the
example itself stays, because it is what holds the format. Untested. Paths, code and
links are replaced before the call and any survivors are stripped after it, because
the model reads them aloud regardless of instruction. The prompt (SYSTEM_PROMPT) lives in
rewrite_prompt.py, which the stock adapters import; each adapter owns its budget factor and retry
(rewrite_openai.py, rewrite_claude.py headers). This script prepares the text, computes
the budget and polishes what comes back.
Refuses: empty replies, no transcript for --cwd in either store.
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import traceback
import uuid
import wave
from datetime import datetime
from pathlib import Path

import adapter_job

ROOT = Path(__file__).resolve().parent
TMP = ROOT / ".tmp"
PROJECTS = Path.home() / ".claude" / "projects"
CODEX_SESSIONS = Path.home() / ".codex" / "sessions"
# Codex keeps every rollout ever (hundreds per day), so only the last 3 days' folders are scanned.
CODEX_DAYS = 3
# A small model in LM Studio defaults to a 4k context; keep the prompt well inside it.
HEAD_CHARS, TAIL_CHARS = 6000, 2000
MIN_WORDS, MAX_WORDS = 15, 90


def log(msg: str) -> None:
    stamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    print(f"[speak] {stamp} {msg}", file=sys.stderr, flush=True)


# ---------- source ----------

def project_slug(cwd: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "-", str(Path(cwd).resolve()))


def _norm_cwd(p: str) -> str:
    """A cwd for comparison: resolved, forward slashes, case-folded (Windows paths ignore case)."""
    try:
        p = str(Path(p).resolve())
    except OSError:
        pass
    return p.replace("\\", "/").rstrip("/").casefold()


def _codex_cwd(f: Path) -> str:
    """The rollout's session_meta cwd (its first line), or "" when unreadable."""
    try:
        with f.open(encoding="utf-8", errors="replace") as fh:
            rec = json.loads(fh.readline())
    except (OSError, ValueError):
        return ""
    if not isinstance(rec, dict) or rec.get("type") != "session_meta":
        return ""
    return str((rec.get("payload") or {}).get("cwd") or "")


def codex_rollouts(cwd: str, root: Path, now: float | None = None) -> list[Path]:
    """Rollouts under root (<yyyy>/<mm>/<dd>/rollout-*.jsonl) from the last CODEX_DAYS days
    whose session_meta cwd is `cwd`. The store is large, so only those day folders are listed."""
    now = time.time() if now is None else now
    want = _norm_cwd(cwd)
    found: list[Path] = []
    for back in range(CODEX_DAYS + 1):  # +1: the folder's date may be UTC, ahead of local
        day = datetime.fromtimestamp(now - back * 86400)
        ddir = root / f"{day:%Y}" / f"{day:%m}" / f"{day:%d}"
        if not ddir.is_dir():
            continue
        for f in ddir.glob("rollout-*.jsonl"):
            try:
                if f.stat().st_mtime < now - CODEX_DAYS * 86400:
                    continue
            except OSError:
                continue
            if _norm_cwd(_codex_cwd(f)) == want:
                found.append(f)
    return found


def latest_reply(cwd: str, claude_root: Path | None = None, codex_root: Path | None = None,
                 agent: str | None = None) -> tuple[str, str]:
    """(text, source) — the latest reply in the newest transcript for `cwd`. `agent` ("claude" or
    "codex") restricts the search to that store; None searches both (the CLI default)."""
    pdir = (claude_root or PROJECTS) / project_slug(cwd)
    files = list(pdir.glob("*.jsonl")) if pdir.is_dir() and agent != "codex" else []
    if agent != "claude":
        files += codex_rollouts(cwd, codex_root or CODEX_SESSIONS)
    if not files:
        raise RuntimeError(f"no transcripts for {cwd} (expected {pdir} or a Codex rollout)")
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for f in files[:3]:  # the newest file may be a fresh session with no reply yet
        text = _last_codex_text(f) if f.name.startswith("rollout-") else _last_assistant_text(f)
        if text:
            return text, f"{f.name}"
    raise RuntimeError(f"no assistant text in the newest transcripts for {cwd}")


def _last_codex_text(f: Path) -> str:
    try:
        lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as e:
        raise RuntimeError(f"read {f}: {e}") from e
    for line in reversed(lines):
        if '"assistant"' not in line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        pl = rec.get("payload") if isinstance(rec, dict) else None
        if rec.get("type") != "response_item" or not isinstance(pl, dict):
            continue
        if pl.get("type") != "message" or pl.get("role") != "assistant" or not isinstance(pl.get("content"), list):
            continue
        parts = [b.get("text", "") for b in pl["content"] if isinstance(b, dict) and b.get("type") == "output_text"]
        text = "\n".join(p for p in parts if p).strip()
        if text:
            return text
    return ""


def _last_assistant_text(f: Path) -> str:
    try:
        lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as e:
        raise RuntimeError(f"read {f}: {e}") from e
    for line in reversed(lines):
        if '"type":"assistant"' not in line and '"type": "assistant"' not in line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("type") != "assistant" or rec.get("isSidechain"):
            continue
        content = (rec.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        text = "\n".join(p for p in parts if p).strip()
        if text:
            return text
    return ""


def clip(text: str) -> str:
    if len(text) <= HEAD_CHARS + TAIL_CHARS:
        return text
    return text[:HEAD_CHARS] + "\n[...]\n" + text[-TAIL_CHARS:]


# ---------- text shaping ----------

# A token that is clearly a filesystem path or a slash-separated file: drive or
# tilde or dot prefix, or anything containing a backslash, or word/word.ext.
_PATH = re.compile(
    r"(?<![\w`])(?:[A-Za-z]:\\|~[\\/]|\.{1,2}[\\/]|[\w.-]+\\)[^\s`'\",;:)\]]*"
    r"|(?<![\w`/])[\w.-]+(?:/[\w.-]+)+\.\w{1,5}(?![\w/])"
    r"|(?<![\w`/.])[\w-]+\.(?:ps1|py|rs|ts|mjs|js|md|json|toml|exe|wav)(?![\w/])"  # bare make-tab-art.ps1
)


def path_words(m: re.Match) -> str:
    """docs\\INDEX.md -> 'the INDEX file'; bridge\\review\\<id>\\ -> 'the review folder'.
    Named after the last real component so the sentence keeps its referent; a
    bare placeholder made the model narrate 'a file path' as if it were the point."""
    raw = m.group(0)
    is_dir = raw.endswith(("\\", "/"))
    parts = [p for p in re.split(r"[\\/]+", raw) if p and not p.startswith("<") and not re.fullmatch(r"[A-Za-z]:|~|\.{1,2}", p)]
    if not parts:
        return "a file"
    last = re.sub(r":\d+$", "", parts[-1])  # src/pty.rs:88
    stem, dot, _ext = last.rpartition(".")
    name = stem if dot and stem else last
    name = re.sub(r"[-_.]+", " ", name).strip() or "that"
    return f"the {name} folder" if is_dir or not dot else f"the {name} file"


def prepare(text: str) -> str:
    """Before the rewrite: take out what it would read aloud anyway, keep the sense."""
    text = re.sub(r"```.*?```", " (code omitted) ", text, flags=re.S)
    text = re.sub(r"https?://\S+", "a link", text)
    text = re.sub(r"`([^`\n]*)`", r"\1", text)
    text = re.sub(r"<[^>\n]{1,40}>", "<x>", text)  # keep <id>/<terms> as one placeholder token
    text = _PATH.sub(path_words, text)
    text = re.sub(r"(?<![\w/])/([a-z][\w-]*)\b", r"the \1 command", text)  # /ctx, /sortie
    text = re.sub(r"\s*<x>\s*", " ", text)
    text = text.replace("→", " to ").replace("←", " from ")
    return re.sub(r"[ \t]{2,}", " ", text)


def polish(spoken: str) -> str:
    """After the rewrite: what a 4B model lets through despite the rules."""
    spoken = re.sub(r"```.*?```", " ", spoken, flags=re.S)
    spoken = re.sub(r"[`*_#>|]+", "", spoken)
    spoken = re.sub(r"https?://\S+", "a link", spoken)
    spoken = _PATH.sub(path_words, spoken)
    spoken = re.sub(r"\S*\\\S*", "a file", spoken)  # any backslash survivor
    spoken = re.sub(r"(?<![\w/])/([a-z][\w-]*)\b", r"the \1 command", spoken)
    spoken = re.sub(r"<[^>\n]{1,40}>", "", spoken)
    spoken = spoken.replace("→", " to ").replace("←", " from ")
    spoken = re.sub(r"\s*[—–]\s*", ", ", spoken)
    spoken = re.sub(r"^\s*[-•]\s+", "", spoken, flags=re.M)
    spoken = re.sub(r"\(\s*\)", "", spoken)
    spoken = re.sub(r"[ \t]{2,}", " ", spoken)
    return re.sub(r"\n{2,}", "\n", spoken).strip()


def word_budget(words_in: int) -> int:
    # Half for short replies, a quarter beyond: a 330-word reply becomes ~80
    # words, about 30 s of audio (a third felt long).
    raw = words_in // 2 if words_in < 120 else words_in // 4
    return max(MIN_WORDS, min(MAX_WORDS, raw))


def strip_markdown(text: str) -> str:
    """The empty rewrite slot (and --no-rewrite): drop fences and the loudest markup, keep the words."""
    text = re.sub(r"```.*?```", " (code omitted) ", text, flags=re.S)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"^\s{0,3}#{1,6}\s*", "", text, flags=re.M)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.M)
    text = re.sub(r"\*\*|__|~~", "", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"^\s*\|.*\|\s*$", "", text, flags=re.M)
    return polish(re.sub(r"\n{2,}", "\n", text).strip())


# ---------- slots ----------

ADAPTER_TIMEOUT_S = {"run": 480, "tts": 300, "warm": 300, "status": 10, "stop": 10}
# An older Vidar exe passes `--rewrite <x>`, or writes no `tts`
# entry and no --owner; it gets this line instead of an argparse or slot error.
RESTART_VIDAR = "Restart Vidar (Voice Slots Updated)"
SLOT_NAMES = {"rewrite": "Rewrite", "tts": "TTS"}
# The tokens the rewrite and tts adapters' commands may carry, and only those
# (contracts/voice-slots.json: roots, fillTokens, slots.rewrite/tts.tokens, lifecycle.tokens), so
# a user path that happens to hold "{word}" is not mistaken for one. Scoped to the two slots this
# script runs. Left in a command or arg = the run fails, named.
_TOKEN = re.compile(r"\{(?:vidar|pack|home|model|budget|lmstudioOrigin|owner|text|out|voice|speed)\}")


def slot_entry(slots_file: str | None, name: str) -> dict | None:
    """The resolved `name` slot from Vidar's resolved.json: the adapter dict when filled, None
    when empty (rewrite's strip_markdown path). Broken, missing or unreadable is an error that
    names the adapter; there is no default adapter."""
    if not slots_file:
        raise RuntimeError("No --slots-file: pass bridge\\voice-slots\\resolved.json (Vidar writes it per Speak press)")
    try:
        data = json.loads(Path(slots_file).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as e:
        raise RuntimeError(f"Cannot Read Slots File {slots_file}: {e}") from e
    if data.get("version") != 1:
        raise RuntimeError(f"Unknown Slots File Version {data.get('version')!r} in {slots_file}")
    slot = (data.get("slots") or {}).get(name)
    if slot:
        return slot
    err = (data.get("errors") or {}).get(name)
    if not err:
        raise RuntimeError(f"Slots File {slots_file} Has No {name} Entry: {RESTART_VIDAR}")
    if err.get("state") == "empty":
        return None
    who = f"{err['adapter']}: " if err.get("adapter") else ""
    raise RuntimeError(f"{SLOT_NAMES[name]} Slot: {who}{err.get('reason') or err.get('state')}")


def rewrite_slot(slots_file: str | None) -> dict | None:
    return slot_entry(slots_file, "rewrite")


def tts_slot(slots_file: str | None) -> dict:
    slot = slot_entry(slots_file, "tts")
    if slot is None:
        raise RuntimeError("TTS Slot: Empty (Required)")
    return slot


def run_adapter(slot: dict, cmd: dict, what: str, tokens: dict, stdin: str = "", *,
                need_stdout: bool = True, job: bool = True) -> str:
    """One run of the adapter's `run` (or a lifecycle command): tokens filled, no console
    window, its stderr copied into ours. Non-zero exit, or empty stdout when `need_stdout`,
    fails and names it. `job`: in its own kill-on-close job (adapter_job.run)."""
    adapter = slot.get("adapter", "?")
    argv = []
    for a in [cmd["command"], *cmd.get("args", [])]:
        for k, v in tokens.items():
            a = a.replace("{" + k + "}", v)
        left = _TOKEN.search(a)
        if left:
            raise RuntimeError(f"{adapter} {what}: Unfilled Token {left.group(0)}")
        argv.append(a)
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        # In its own kill-on-close job: a timeout, or Stop ending this process, ends the
        # adapter's real interpreter too, not just the venv stub (adapter_job.py).
        r = adapter_job.run(argv, input=stdin, timeout=ADAPTER_TIMEOUT_S[what], creationflags=flags, job=job)
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"{adapter} {what} Timed Out After {ADAPTER_TIMEOUT_S[what]} s") from e
    except OSError as e:
        raise RuntimeError(f"{adapter} {what}: Cannot Run {cmd['command']}: {e}") from e
    if r.stderr:
        sys.stderr.write(r.stderr if r.stderr.endswith("\n") else r.stderr + "\n")
        sys.stderr.flush()
    out = (r.stdout or "").strip()
    if r.returncode != 0 or (need_stdout and not out):
        tail = (r.stderr or "").strip().splitlines()[-1:] or [""]
        detail = f": {tail[0]}" if tail[0] else ""
        raise RuntimeError(f"{adapter} {what} Exited {r.returncode}{' With No Output' if not out else ''}{detail}")
    return out


def last_json(out: str) -> dict:
    """The adapter's last stdout line as JSON, "ok" dropped (the caller owns it); else {}."""
    try:
        v = json.loads(out.strip().splitlines()[-1]) if out.strip() else {}
    except ValueError:
        return {"output": out}
    return {k: x for k, x in v.items() if k != "ok"} if isinstance(v, dict) else {"output": out}


def run_lifecycle(slot: dict, what: str, tokens: dict, job: bool = True) -> dict:
    """`warm`, `status` or `stop`, if the adapter has it: its JSON stdout line, else {}."""
    cmd = slot.get(what)
    if not cmd:
        return {}
    return last_json(run_adapter(slot, cmd, what, tokens, job=job))


def rewrite(text: str, slot: dict) -> tuple[str, float, int]:
    """(spoken, seconds, budget) through the filled rewrite slot: the prepared text on the
    adapter's stdin, `{budget}` in its args, the polished stdout back. The adapter owns its
    budget factor and retry; the seconds include its process start."""
    prepared = clip(prepare(text))
    budget = word_budget(len(prepared.split()))
    started = time.perf_counter()
    out = run_adapter(slot, slot, "run", {"budget": str(budget)}, stdin=prepared)
    return polish(out), round(time.perf_counter() - started, 3), budget


# ---------- tts slot ----------

class Tts:
    """The resolved tts slot for one run: its tokens and whether it runs in a job of ours."""

    def __init__(self, slots_file: str | None, voice: str | None, owner: str) -> None:
        self.slot = tts_slot(slots_file)
        self.adapter = self.slot.get("adapter", "?")
        voice = voice or (self.slot.get("model") or {}).get("id")
        # 1.0 is Kokoro's own speed.
        self.tokens = {"owner": owner, "speed": os.environ.get("SPEAK_SPEED", "1.15")}
        if voice:
            self.tokens["voice"] = voice
        self.job = adapter_job.can_break_away()

    def _need_voice(self, cmd: dict) -> None:
        if "voice" not in self.tokens and any("{voice}" in a for a in cmd.get("args", [])):
            raise RuntimeError(f"TTS Slot: {self.adapter}: No Voice: Pick a Model or Pass --voice")

    def lifecycle(self, what: str) -> dict:
        cmd = self.slot.get(what)
        if not cmd:
            return {}
        self._need_voice(cmd)
        return run_lifecycle(self.slot, what, self.tokens, job=self.job)

    def synth(self, index: int, total: int, text: str) -> dict:
        """One chunk to a WAV: `{text}` a UTF-8 file, `{out}` the WAV the adapter writes."""
        self._need_voice(self.slot)
        TMP.mkdir(exist_ok=True)
        stem = TMP / f"tts-{uuid.uuid4().hex[:8]}-{index}"
        txt, wav = stem.with_suffix(".txt"), stem.with_suffix(".wav")
        txt.write_text(text, encoding="utf-8")
        started = time.perf_counter()
        where = f"TTS Chunk {index} of {total}"
        try:
            out = run_adapter(self.slot, self.slot, "tts", {**self.tokens, "text": str(txt), "out": str(wav)},
                              need_stdout=False, job=self.job)
        except RuntimeError as e:
            raise RuntimeError(f"{where}: {e}") from e
        finally:
            txt.unlink(missing_ok=True)
        if not wav.is_file() or wav.stat().st_size == 0:
            raise RuntimeError(f"{where}: {self.adapter} Wrote No WAV")
        try:
            with wave.open(str(wav), "rb") as w:
                if w.getsampwidth() != 2:
                    raise RuntimeError(f"{where}: {self.adapter} Wrote {8 * w.getsampwidth()}-Bit Audio, Not 16-Bit PCM")
                audio = w.getnframes() / float(w.getframerate())
        except (wave.Error, EOFError) as e:
            raise RuntimeError(f"{where}: {self.adapter} Wrote No PCM WAV: {e}") from e
        # synth_seconds is the adapter's whole run, process start included.
        return {"wav": str(wav), "audio_seconds": audio, "synth_seconds": time.perf_counter() - started,
                "adapter": last_json(out)}


def play(wav: str) -> None:
    import winsound

    winsound.PlaySound(wav, winsound.SND_FILENAME | winsound.SND_NODEFAULT)


def chunk(text: str, target: int = 260) -> list[str]:
    """First chunk is one sentence (fast start); the rest ~target chars of whole sentences."""
    sents = [s for s in re.split(r"(?<=[.!?])\s+|\n+", text) if s.strip()]
    if not sents:
        return [text]
    chunks = [sents[0]]
    cur = ""
    for s in sents[1:]:
        if cur and len(cur) + len(s) > target:
            chunks.append(cur)
            cur = s
        else:
            cur = f"{cur} {s}".strip()
    if cur:
        chunks.append(cur)
    return chunks


def speak_chunks(tts: Tts, text: str, result: dict) -> None:
    """Synthesise ahead on a thread, play in order here. Kill = silence."""
    chunks = chunk(text)
    q: queue.Queue = queue.Queue()
    failure: list[Exception] = []

    def producer() -> None:
        try:
            for i, c in enumerate(chunks, 1):
                q.put(tts.synth(i, len(chunks), c))
        except Exception as e:  # noqa: BLE001 — surfaced after the queue drains
            failure.append(e)
        finally:
            q.put(None)

    threading.Thread(target=producer, daemon=True).start()
    started = time.perf_counter()
    audio = synth_secs = 0.0
    played = 0
    while True:
        item = q.get()
        if item is None:
            break
        if played == 0:
            result["first_audio_seconds"] = round(time.perf_counter() - started, 3)
            wait = item["adapter"].get("sidecar_wait_seconds")
            if wait is not None:
                result["sidecar_wait_seconds"] = wait
        audio += item["audio_seconds"]
        synth_secs += item["synth_seconds"]
        try:
            play(item["wav"])
        finally:
            Path(item["wav"]).unlink(missing_ok=True)
        played += 1
    result.update(chunks=len(chunks), audio_seconds=round(audio, 3), synth_seconds=round(synth_secs, 3))
    if failure:
        raise RuntimeError(f"{failure[0]} (after {played} chunk(s) played)")
    log(f"{tts.adapter} {audio:.1f}s of audio in {synth_secs:.2f}s over {len(chunks)} chunk(s)")


# ---------- main ----------

def run(args: argparse.Namespace) -> dict:
    result: dict = {"ok": False}
    if args.text is not None:
        text, source = args.text, "arg"
    elif args.stdin:
        text, source = sys.stdin.read(), "stdin"
    else:
        codex_root = Path(args.codex_home) / "sessions" if args.codex_home else None
        claude_root = Path(args.claude_home) / "projects" if args.claude_home else None
        text, source = latest_reply(args.cwd, claude_root, codex_root, agent=args.agent)
    text = text.strip()
    if not text:
        raise RuntimeError("nothing to speak")
    result.update(source=source, chars_in=len(text), words_in=len(text.split()))
    log(f"source {source}: {len(text)} chars")

    # Before the rewrite: a broken tts slot fails the run before a rewrite adapter spends anything.
    tts = None if args.dry else Tts(args.slots_file, args.voice, args.owner)
    slot = None if args.no_rewrite else rewrite_slot(args.slots_file)
    if slot is None:
        # The empty rewrite slot (a named state, not a fallback): mechanical strip, no model.
        spoken = strip_markdown(text)
        result.update(rewrite="empty")
    else:
        adapter = slot.get("adapter", "?")
        spoken, secs, budget = rewrite(text, slot)
        # rewrite_seconds (src\panels\speak.ts reads it for the tooltip) is the adapter's
        # whole run: process start, its imports and (openai-compat) any LM Studio cold start.
        result.update(rewrite=adapter, rewrite_seconds=secs, budget=budget)
        log(f"{adapter} rewrite {len(spoken.split())} words (budget {budget}) in {secs}s")
    if not spoken:
        raise RuntimeError("nothing left to speak after shaping")
    result.update(spoken=spoken, words_out=len(spoken.split()))
    if tts is None:
        result["ok"] = True
        return result

    sweep_tmp()
    speak_chunks(tts, spoken, result)
    result["ok"] = True
    return result


def sweep_tmp() -> None:
    """Chunk files a killed run left behind, once they are an hour old."""
    cutoff = time.time() - 3600
    for old in [*TMP.glob("tts-*.wav"), *TMP.glob("tts-*.txt")]:
        try:
            if old.stat().st_mtime < cutoff:
                old.unlink()
        except OSError:
            pass


def arm(args: argparse.Namespace) -> dict:
    """The tts adapter's `warm` (Kokoro up), then the picked rewrite adapter's `warm`
    (openai-compat: LM Studio up and the model loaded, its timings merged in). An empty slot or
    an adapter without `warm` (claude-p) warms nothing and never touches LM Studio."""
    result: dict = {"ok": False}
    # tts first: a broken rewrite slot fails the arm but still
    # leaves the voice warm for the next press.
    result.update(Tts(args.slots_file, args.voice, args.owner).lifecycle("warm"))
    slot = None if args.no_rewrite else rewrite_slot(args.slots_file)
    if slot is not None:
        result.update(run_lifecycle(slot, "warm", {"owner": args.owner}))
    result["ok"] = True
    return result


def status(args: argparse.Namespace) -> dict:
    result = {"ok": True, **Tts(args.slots_file, args.voice, args.owner).lifecycle("status")}
    # The rewrite adapter's own `status` only when the slot is filled; a status poll never
    # fails on the rewrite slot.
    if not args.no_rewrite:
        try:
            slot = rewrite_slot(args.slots_file)
            if slot is not None and slot.get("status"):
                result["rewrite"] = run_lifecycle(slot, "status", {"owner": args.owner})
        except RuntimeError as e:
            result["rewrite"] = {"error": str(e)}
    return result


def main() -> int:
    # The Rust caller and PowerShell 7 both read UTF-8; the console default on
    # Windows is not, and a curly quote would turn the JSON line into mojibake.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--agent", choices=["claude", "codex"], default=None,
                    help="read only this agent's transcripts (default: newest of both)")
    ap.add_argument("--claude-home", dest="claude_home", default=None,
                    help="CLAUDE_CONFIG_DIR of the tab (default ~/.claude); its projects folder is searched")
    ap.add_argument("--codex-home", dest="codex_home", default=None,
                    help="CODEX_HOME of the tab (default ~/.codex); its sessions folder is searched")
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--text")
    src.add_argument("--stdin", action="store_true")
    ap.add_argument("--slots-file", default=None)
    ap.add_argument("--no-rewrite", dest="no_rewrite", action="store_true")
    # Replaced by the rewrite slot; kept hidden so an old exe gets RESTART_VIDAR.
    ap.add_argument("--rewrite", default=None, help=argparse.SUPPRESS)
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--voice", default=None)
    # The lifecycle {owner}; "cli" is what a terminal is, speak.rs passes "vidar".
    ap.add_argument("--owner", default="cli")
    ap.add_argument("--json", action="store_true")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--arm", action="store_true")
    mode.add_argument("--status", action="store_true")
    mode.add_argument("--stop", action="store_true")
    # Every stop is owner-scoped; an old exe still passes this flag.
    ap.add_argument("--if-owned", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args()

    try:
        if args.rewrite is not None:
            raise RuntimeError(RESTART_VIDAR)
        if args.stop:
            result = {"ok": True, **Tts(args.slots_file, args.voice, args.owner).lifecycle("stop")}
        elif args.status:
            result = status(args)
        elif args.arm:
            result = arm(args)
        else:
            result = run(args)
    except Exception as e:  # noqa: BLE001 — one failure line, whatever it was
        log(traceback.format_exc())
        result = {"ok": False, "error": str(e)}
    if args.json:
        print(json.dumps(result, ensure_ascii=False), flush=True)
    elif not result["ok"]:
        print(f"speak: {result['error']}", file=sys.stderr)
    elif args.status or args.arm or args.stop:
        print(json.dumps(result))
    else:
        print(result.get("spoken", ""))
        timing = {k: v for k, v in result.items() if k.endswith("_seconds")}
        if timing:
            print(f"-- {json.dumps(timing)}", file=sys.stderr)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
