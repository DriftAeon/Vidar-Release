"""Rewrite adapter `claude/claude-p`: the Claude Code CLI, `claude -p`.

The `rewrite` slot contract (contracts/voice-slots.json, docs/reference/voice-pipelines.md):
the prepared reply as UTF-8 on stdin, the spoken text as UTF-8 on stdout, exit 0. A failure
is a non-zero exit with the reason on stderr; speak.py names this adapter in the error.

Usage (the manifest packs/claude/voice/claude-p.json fills the token):
  rewrite_claude.py --budget <words> --model <id> --effort <level>   stdin -> stdout

Same system prompt as speak.py, the
budget stated exactly (Sonnet follows a number closely; the 0.7 factor is for the small local models), one retry as
a fresh single user message because `claude -p` has no messages array. No API key on this
machine, so this is the CLI, and it spends the Claude Code plan meter. Flags: MCP server startup
is most of the round trip (4.4 s plain vs 3.0 s with `--strict-mcp-config
--disable-slash-commands --exclude-dynamic-system-prompt-sections`); `--bare` also cuts it but
drops the login and returns "Not logged in". No warm process, so no warm/stop/status.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

# The prompt is shared with the stock OpenAI rewrite adapter.
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "local-voice"))
from rewrite_prompt import SYSTEM_PROMPT


def log(msg: str) -> None:
    print(f"[rewrite-claude] {msg}", file=sys.stderr, flush=True)


def _chat(system: str, user: str, model: str, effort: str) -> str:
    claude = shutil.which("claude")
    if not claude:
        raise RuntimeError(
            "claude not found on PATH: install the Claude Code CLI, or pick another rewrite adapter"
        )
    # A nested-session guard in the CLI can fire off inherited CLAUDE_*/CLAUDECODE env
    # vars from this being spawned underneath a running Claude session; strip them so
    # the child starts clean.
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE_") and not k.startswith("CLAUDECODE")}
    cmd = [
        claude, "-p", "--model", model, "--effort", effort,
        "--no-session-persistence", "--output-format", "text",
        "--system-prompt", system,
        "--strict-mcp-config", "--disable-slash-commands",
        "--exclude-dynamic-system-prompt-sections",
    ]
    try:
        r = subprocess.run(
            cmd, input=user, capture_output=True, timeout=90,
            text=True, encoding="utf-8", env=env,
        )
    except subprocess.TimeoutExpired as e:
        raise RuntimeError("claude -p Timed Out After 90 s") from e
    out = (r.stdout or "").strip()
    if r.returncode != 0 or not out:
        tail = (r.stderr or "").strip()[-300:]
        detail = f": {tail}" if tail else ""
        raise RuntimeError(f"claude -p exited {r.returncode} without output{detail}")
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
    args = ap.parse_args()
    try:
        print(rewrite(sys.stdin.read(), args.budget, args.model, args.effort))
    except Exception as e:  # noqa: BLE001 — one failure line on stderr, whatever it was
        log(str(e))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
