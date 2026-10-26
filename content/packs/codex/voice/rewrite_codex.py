"""Rewrite adapter `codex/codex-exec`: the Codex CLI, `codex exec`.

The `rewrite` slot contract (contracts/voice-slots.json, docs/reference/voice-pipelines.md):
the prepared reply as UTF-8 on stdin, the spoken text as UTF-8 on stdout, exit 0. A failure
is a non-zero exit with the reason on stderr; speak.py names this adapter in the error.

Usage (the manifest packs/codex/voice/codex-exec.json fills the tokens):
  rewrite_codex.py --budget <words> --model <id> --effort <level> [--dry-run]   stdin -> stdout

Same system prompt and retry rule as rewrite_claude.py. `codex exec` has no system-prompt flag, so
the prompt and the reply go in one stdin message. Flags: `--ephemeral` (no session file, so a Speak
press leaves nothing in Codex history), `--sandbox read-only`, `approval_policy="never"`,
`--skip-git-repo-check`, `--output-last-message <file>` (only the final message, no event log),
`-c model_reasoning_effort=<level>`. It spends the Codex plan meter. `--dry-run` prints the argv as
JSON and exits without calling codex.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# The prompt is shared with the stock OpenAI rewrite adapter.
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "local-voice"))
from rewrite_prompt import SYSTEM_PROMPT


def log(msg: str) -> None:
    print(f"[rewrite-codex] {msg}", file=sys.stderr, flush=True)


# CODEX_*: inherited from a running Codex session, they would leak into the child (CODEX_HOME
# stays: it picks the login). VIDAR_*/FALCON_*: a hosted tab's control identity
# (VIDAR_CTL_SECRET, FALCON_SESSION) reaches speak.ps1's env; rewriting needs none of it, and
# the child reads text it did not write.
CHILD_ENV_DROP = ("CODEX_", "VIDAR_", "FALCON_")
CHILD_ENV_KEEP = ("CODEX_HOME",)


def child_env() -> dict[str, str]:
    return {
        k: v for k, v in os.environ.items()
        if k.upper() in CHILD_ENV_KEEP or not k.upper().startswith(CHILD_ENV_DROP)
    }


def build_cmd(codex: str, model: str, effort: str, out_file: str) -> list[str]:
    """The `codex exec` argv; the prompt is read from stdin (`-`)."""
    return [
        codex, "exec", "--model", model,
        "-c", f"model_reasoning_effort={effort}",
        "-c", 'approval_policy="never"',
        "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check",
        "--color", "never", "--output-last-message", out_file, "-",
    ]


def _chat(system: str, user: str, model: str, effort: str) -> str:
    codex = shutil.which("codex")
    if not codex:
        raise RuntimeError(
            "codex not found on PATH: install the Codex CLI, or pick another rewrite adapter"
        )
    env = child_env()
    prompt = f"{system}\n\n---\n\n{user}"
    with tempfile.TemporaryDirectory(prefix="vidar-rewrite-codex-") as tmp:
        out_file = str(Path(tmp) / "last.txt")
        cmd = build_cmd(codex, model, effort, out_file)
        try:
            r = subprocess.run(
                cmd, input=prompt, capture_output=True, timeout=120,
                text=True, encoding="utf-8", env=env, cwd=tmp,
            )
        except subprocess.TimeoutExpired as e:
            raise RuntimeError("codex exec Timed Out After 120 s") from e
        try:
            out = Path(out_file).read_text(encoding="utf-8").strip()
        except OSError:
            out = ""
    if r.returncode != 0 or not out:
        tail = (r.stderr or "").strip()[-300:]
        detail = f": {tail}" if tail else ""
        raise RuntimeError(f"codex exec exited {r.returncode} without output{detail}")
    return out


def rewrite(prepared: str, budget: int, model: str, effort: str) -> str:
    """The spoken text, unpolished (speak.py polishes). One retry if it blows the budget."""
    system = SYSTEM_PROMPT.replace("{budget}", str(budget))
    out = _chat(system, prepared, model, effort)
    words = len(out.split())
    if words > budget * 1.25 + 5:
        log(f"{model} used {words} words against a budget of {budget}; retrying tighter")
        retry_user = f"{prepared}\n\nYour previous attempt was {words} words; the hard limit is {budget}. Say it again within the limit, still covering the whole reply."
        again = _chat(system, retry_user, model, effort)
        if again:
            out = again
    return out


def main() -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--budget", type=int, required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--effort", required=True)
    ap.add_argument("--dry-run", action="store_true", help="print the codex exec argv as JSON and exit")
    args = ap.parse_args()
    if args.dry_run:
        print(json.dumps(build_cmd("codex", args.model, args.effort, "<last-message-file>")))
        return 0
    try:
        print(rewrite(sys.stdin.read(), args.budget, args.model, args.effort))
    except Exception as e:  # noqa: BLE001 — one failure line on stderr, whatever it was
        log(str(e))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
