"""STT A/B harness for Vidar's voice `stt` slot. Plain Python, no deps beyond stt_ab_metrics.

    python stt_ab.py collect [--dir fixtures/ab] [--start N]
    python stt_ab.py run --clips fixtures/ab --out results.tsv [--runs 3] [--only id,id]

collect: shows sentence N, waits for `runtime/bridge/voice/last.wav` to change (the real
hold-to-talk path: hold the voice chord in a scratch RAW shell tab so nothing lands in a
session), copies it to `<dir>/NN.wav` with `NN.ref.txt` and `NN.kind.txt`.
Wake utterances never reach last.wav (listen.rs transcribes `listen-<clock>.wav` and deletes
it on success), so wake lines are listed and skipped; no capture path exists.

run: every candidate in CANDIDATES x every clip, `--runs` times each, invoked the way
voice.rs does (manifest args with {model}/{wav}/{out}/{prompt}/{vidar} substituted, spawn and
model load included). Run 1 is reported separately (cold file cache); median/p90 cover all runs.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

import stt_ab_metrics as M

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
VOICE_DIR = REPO / "runtime" / "bridge" / "voice"
LAST_WAV = VOICE_DIR / "last.wav"
STOCK = REPO / "content" / "packs" / "voice-stock" / "voice"
VIDAR_JSON = REPO / "vidar.json"

# (kind, sentence). "ptt" = hold-to-talk dictation; "wake" = say it after the wake word.
SENTENCES: list[tuple[str, str]] = [
    # prose
    ("ptt", "I think we should move the settings page into its own panel before the release."),
    ("ptt", "The build finished without errors, but the second run took twice as long."),
    ("ptt", "Can you check why the window loses focus when I switch back from the browser?"),
    ("ptt", "Remind me to rename that folder once the old runs are archived."),
    ("ptt", "It works on my machine, so the problem is probably in the environment."),
    ("ptt", "Please keep the answer short and put the verdict on the first line."),
    # prompt vocabulary
    ("ptt", "Ask Claude to review the diff and then hand the fix to Codex."),
    ("ptt", "Open a new tab and split the pane so the logs sit beside the terminal."),
    ("ptt", "The Tauri shell calls into Rust and the front end is plain TypeScript."),
    ("ptt", "Run it in PowerShell, not in the other shell."),
    ("ptt", "Rider shows the error but the mic stays muted on the Yeti."),
    ("ptt", "Claude Code in a Vidar terminal should keep the tab title after a restart."),
    ("ptt", "Is the mic picking up the keyboard, or is that the Yeti gain?"),
    # held-out terms (not in the voice.prompt)
    ("ptt", "Show me the git diff for the last commit."),
    ("ptt", "Run npm run build and then cargo check."),
    ("ptt", "Rebase onto master and resolve the merge conflict in the manifest."),
    ("ptt", "The worktree is dirty, so stash it before you pull."),
    ("ptt", "Parse the JSON with serde and log the error with tracing."),
    ("ptt", "Open the Kubernetes dashboard and check the Docker container logs."),
    # short commands
    ("ptt", "Scroll up."),
    ("ptt", "Close this tab."),
    ("ptt", "Yes, go ahead."),
    ("ptt", "Run the tests again."),
    ("ptt", "Commit that and push it."),
    ("ptt", "Switch to the next pane."),
    # wake utterances (say after the wake word)
    ("wake", "Open the notes."),
    ("wake", "What is the status of the build?"),
    ("wake", "Start a new Claude tab in the Vidar folder."),
    ("wake", "Show me the git diff."),
    ("wake", "Read the last reply out loud."),
]

# Terms scored separately. PROMPT_TERMS are kept only if the live voice.prompt contains them.
PROMPT_TERMS = ["Claude", "Codex", "git", "PowerShell", "Rider", "Yeti", "Tauri", "Rust", "Vidar", "tab", "pane", "mic"]
HELDOUT_TERMS = ["git diff", "npm run build", "cargo check", "worktree", "serde", "tracing", "Kubernetes", "Docker", "rebase"]

# Candidate table: add rows here (W2: parakeet manifests, whisper --vad variants).
# `manifest` is a file under the stock voice pack; `model` an id in its models[]; `prompt` whether
# voice.prompt is passed (False passes an empty string, as an unset prompt would).
CANDIDATES: list[dict] = [
    {"id": "whisper-base.en+prompt", "manifest": "whisper-cli.json", "model": "base.en", "prompt": True},
    {"id": "whisper-base.en", "manifest": "whisper-cli.json", "model": "base.en", "prompt": False},
]


def vidar_prompt() -> str:
    try:
        return json.loads(VIDAR_JSON.read_text(encoding="utf-8")).get("voice", {}).get("prompt", "") or ""
    except (OSError, ValueError):
        return ""


def expand(s: str, **tokens: str) -> str:
    """Token expansion as voice.rs `substitute` plus the manifest's {vidar} root.

    Only the tokens passed are replaced, so the argv template can keep {wav}/{out}/{prompt} open.
    """
    tokens.setdefault("vidar", str(REPO))
    for k, v in tokens.items():
        s = s.replace("{" + k + "}", v)
    return s


def resolve(cand: dict) -> tuple[list[str], str]:
    """-> (argv template with {wav}/{out}/{prompt} still open, model path)."""
    man = json.loads((STOCK / cand["manifest"]).read_text(encoding="utf-8"))
    model = next(m for m in man["models"] if m["id"] == cand["model"])
    mpath = expand(model["file"])
    cmd = expand(man["run"]["command"])
    args = [expand(a, model=mpath) for a in man["run"]["args"]]
    return [cmd] + args, mpath


def wav_seconds(p: Path) -> float:
    with wave.open(str(p), "rb") as w:
        return w.getnframes() / w.getframerate()


# ---------------- collect ----------------

def cmd_collect(a: argparse.Namespace) -> int:
    dest = Path(a.dir)
    dest.mkdir(parents=True, exist_ok=True)
    print("Focus a scratch RAW shell tab first, then hold the voice chord for each line.")
    print("Wake lines are skipped: wake clips never reach last.wav (no capture path).\n")
    last = LAST_WAV.stat().st_mtime_ns if LAST_WAV.exists() else 0
    for n, (kind, text) in enumerate(SENTENCES, 1):
        if n < a.start:
            continue
        stem = dest / f"{n:02d}"
        if stem.with_suffix(".wav").exists():
            print(f"{n:02d} exists, skipping")
            continue
        if kind == "wake":
            print(f"{n:02d} [wake] not collectable: {text}")
            continue
        print(f"{n:02d}/{len(SENTENCES)} [{kind}] say: {text}")
        while True:
            time.sleep(0.2)
            try:
                m = LAST_WAV.stat().st_mtime_ns
            except OSError:
                continue
            if m != last:
                break
        time.sleep(0.3)  # let the writer finish
        shutil.copyfile(LAST_WAV, stem.with_suffix(".wav"))
        last = LAST_WAV.stat().st_mtime_ns
        stem.with_suffix(".ref.txt").write_text(text, encoding="utf-8")
        stem.with_suffix(".kind.txt").write_text(kind, encoding="utf-8")
        print(f"    saved {stem.name}.wav ({wav_seconds(stem.with_suffix('.wav')):.1f}s)")
    return 0


# ---------------- run ----------------

def load_clips(d: Path) -> list[dict]:
    clips = []
    for wav in sorted(d.glob("*.wav")):
        ref = wav.with_suffix(".ref.txt")
        if not ref.exists():
            print(f"skip {wav.name}: no .ref.txt", file=sys.stderr)
            continue
        kind_f = wav.with_suffix(".kind.txt")
        clips.append({
            "id": wav.stem, "wav": wav, "secs": wav_seconds(wav),
            "ref": ref.read_text(encoding="utf-8").strip(),
            "kind": kind_f.read_text(encoding="utf-8").strip() if kind_f.exists() else "ptt",
        })
    return clips


def run_once(argv: list[str], wav: Path, prompt: str, tmp: Path, tag: str) -> tuple[float, str, str]:
    base = tmp / tag
    txt = base.with_suffix(".txt")
    args = [expand(x, wav=str(wav), out=str(base), prompt=prompt) for x in argv]
    t0 = time.perf_counter()
    proc = subprocess.run(args, capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    ms = (time.perf_counter() - t0) * 1000
    if proc.returncode != 0:
        return ms, "", f"exit {proc.returncode}: {proc.stderr.decode('utf-8', 'replace')[-120:]}"
    if not txt.exists():
        return ms, "", "no .txt written"
    text = " ".join(txt.read_text(encoding="utf-8").split())
    txt.unlink()
    return ms, text, ""


COLS = ["clip", "kind", "cand", "secs", "run1_ms", "median_ms", "p90_ms", "rtf_run1", "rtf_median",
        "wer", "prompt_hit", "prompt_n", "heldout_hit", "heldout_n", "misses", "hyp", "error"]


def cmd_run(a: argparse.Namespace) -> int:
    clips = load_clips(Path(a.clips))
    if not clips:
        print("no clips (need NN.wav + NN.ref.txt)", file=sys.stderr)
        return 2
    prompt = vidar_prompt()
    pterms = [t for t in PROMPT_TERMS if t.lower() in prompt.lower()]
    only = set(a.only.split(",")) if a.only else None
    rows = []
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        for cand in CANDIDATES:
            if only and cand["id"] not in only:
                continue
            argv, mpath = resolve(cand)
            if not Path(argv[0]).exists() or not Path(mpath).exists():
                print(f"skip {cand['id']}: missing {argv[0] if not Path(argv[0]).exists() else mpath}", file=sys.stderr)
                continue
            p = prompt if cand["prompt"] else ""
            for clip in clips:
                times, hyp, err = [], "", ""
                for r in range(a.runs):
                    ms, text, e = run_once(argv, clip["wav"], p, tmp, f"{clip['id']}-{r}")
                    times.append(ms)
                    if r == 0:
                        hyp = text
                    err = err or e
                w = M.wer(clip["ref"], hyp)
                th = M.term_hits(clip["ref"], hyp, pterms, HELDOUT_TERMS)
                med = M.median(times)
                rows.append({
                    "clip": clip["id"], "kind": clip["kind"], "cand": cand["id"], "secs": f"{clip['secs']:.2f}",
                    "run1_ms": f"{times[0]:.0f}", "median_ms": f"{med:.0f}", "p90_ms": f"{M.p90(times):.0f}",
                    "rtf_run1": f"{times[0] / 1000 / clip['secs']:.2f}",
                    "rtf_median": f"{med / 1000 / clip['secs']:.2f}",
                    "wer": "" if w is None else f"{w:.3f}",
                    "prompt_hit": th["prompt_hit"], "prompt_n": th["prompt_n"],
                    "heldout_hit": th["held_hit"], "heldout_n": th["held_n"],
                    "misses": ";".join(th["misses"]), "hyp": hyp, "error": err,
                })
    line = lambda r: "\t".join(str(r[c]).replace("\t", " ").replace("\n", " ") for c in COLS)
    out = "\t".join(COLS) + "\n" + "\n".join(line(r) for r in rows) + "\n"
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(out, encoding="utf-8", newline="\n")
    print(out, end="")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("collect")
    c.add_argument("--dir", default=str(HERE / "fixtures" / "ab"))
    c.add_argument("--start", type=int, default=1)
    r = sub.add_parser("run")
    r.add_argument("--clips", default=str(HERE / "fixtures" / "ab"))
    r.add_argument("--out", required=True)
    r.add_argument("--runs", type=int, default=3)
    r.add_argument("--only", default="", help="comma-separated candidate ids")
    a = ap.parse_args()
    return cmd_collect(a) if a.cmd == "collect" else cmd_run(a)


if __name__ == "__main__":
    sys.exit(main())
