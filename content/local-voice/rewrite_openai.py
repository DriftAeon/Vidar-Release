"""Rewrite adapter `voice-stock/openai-compat`: an OpenAI-compatible chat server (LM Studio).

The `rewrite` slot contract (contracts/voice-slots.json, docs/reference/voice-pipelines.md):
the prepared reply as UTF-8 on stdin, the spoken text as UTF-8 on stdout, exit 0. A failure
is a non-zero exit with the reason on stderr; speak.py names this adapter in the error.

Usage (the manifest packs/voice-stock/voice/openai-compat.json fills the tokens):
  rewrite_openai.py --origin <lmstudioOrigin> --model <id> --budget <words>   stdin -> stdout
  rewrite_openai.py --origin <lmstudioOrigin> --model <id> --warm   start the server, load the model
  rewrite_openai.py --origin <lmstudioOrigin> --model <id> --status {"model": loaded|not-loaded|down}
  rewrite_openai.py --stop                                          no-op: LM Studio owns its server

The origin comes from vidar.json `lmstudioOrigin` through Vidar (lmstudio.rs), its one source.
The model id is the server's id, from vidar.json `voiceSlots.rewrite.model` (`{model}`); there is
no default. A small model lands about 40% over any number it is given, so it is told 0.7 of
the budget, and a reply far over budget gets one retry as a second turn. The server is started
on demand (`lms server start`) if it is down; still down after that is an error, never a
verbatim read. `--stop` exists because the contract ties `warm` to a `stop`; Vidar started no
process here that it could end, and unloading the model stays LM Studio's business.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time

from adapter_job import breakaway_flags
from rewrite_prompt import SYSTEM_PROMPT


def log(msg: str) -> None:
    print(f"[rewrite-openai] {msg}", file=sys.stderr, flush=True)


def _chat(origin: str, model: str, messages: list[dict], max_tokens: int) -> str:
    import requests

    # A reasoning model left alone spends the whole budget in `reasoning_content`
    # and returns content "" with finish_reason "length" — a rewrite that is silently empty.
    # Raising max_tokens does not fix it (2.7k chars of thinking at 800 and still going) and
    # chat_template_kwargs.enable_thinking is ignored here; `reasoning_effort: none` is what works.
    # Harmless on non-reasoning models, so it is unconditional rather than model-sniffed.
    body = {"model": model, "messages": messages, "temperature": 0, "max_tokens": max_tokens,
            "stream": False, "reasoning_effort": "none"}
    try:
        r = requests.post(f"{origin}/v1/chat/completions", json=body, timeout=(5, 180))
    except requests.ConnectionError as e:
        raise RuntimeError(f"LM Studio not reachable at {origin}; start its server and load {model}") from e
    except requests.Timeout as e:
        raise RuntimeError(f"LM Studio timed out at {origin}") from e
    if r.status_code != 200:
        raise RuntimeError(f"LM Studio {r.status_code}: {r.text[:300]}")
    try:
        out = r.json()["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"LM Studio reply had no content: {r.text[:300]}") from e
    return re.sub(r"<think>.*?</think>", "", out, flags=re.S).strip()


def model_state(origin: str, model: str) -> str:
    """'loaded' | 'not-loaded' | 'down' (LM Studio's REST model list; v0 API)."""
    import requests

    try:
        r = requests.get(f"{origin}/api/v0/models", timeout=2)
        for m in r.json().get("data", []):
            if m.get("id") == model:
                return "loaded" if m.get("state") == "loaded" else "not-loaded"
        return "not-loaded"
    except (requests.RequestException, ValueError, AttributeError):
        return "down"


def ensure_lmstudio(origin: str, model: str) -> float:
    """Start LM Studio's server via `lms server start` if it is down; returns seconds
    waited (0.0 if it was already up). Raises RuntimeError on any failure to reach
    "not down" within the poll window — never falls through to a verbatim read."""
    if model_state(origin, model) != "down":
        return 0.0
    log("lm studio down, starting")
    started = time.perf_counter()
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    # speak.py runs this adapter in a kill-on-close job (adapter_job.py); the server `lms`
    # brings up must outlive the run, so it breaks away. A caller already inside a job that
    # forbids breakaway gets access denied; then it starts in-job and may stop with the run.
    try:
        try:
            r = subprocess.run(
                ["lms", "server", "start"], capture_output=True, text=True,
                timeout=30, creationflags=flags | breakaway_flags(),
            )
        except PermissionError:
            log("breakaway from the adapter job refused; starting lms inside it")
            r = subprocess.run(
                ["lms", "server", "start"], capture_output=True, text=True,
                timeout=30, creationflags=flags,
            )
    except FileNotFoundError as e:
        log("lms not found on PATH")
        raise RuntimeError("lms not found on PATH: install LM Studio's CLI or start its server manually") from e
    except subprocess.TimeoutExpired as e:
        log("lms server start timed out after 30s")
        raise RuntimeError("lms server start Timed Out After 30 s") from e
    if r.returncode != 0:
        tail = (r.stderr or r.stdout or "").strip()[-200:]
        detail = f": {tail}" if tail else ""
        log(f"lms server start exited {r.returncode}{detail}")
        raise RuntimeError(f"lms server start exited {r.returncode}{detail}")
    while time.perf_counter() - started < 20:
        if model_state(origin, model) != "down":
            waited = round(time.perf_counter() - started, 3)
            log(f"lm studio up after {waited}s")
            return waited
        time.sleep(0.5)
    tail = (r.stderr or r.stdout or "").strip()[-200:]
    detail = f": {tail}" if tail else ""
    log(f"lm studio still down 20s after lms server start{detail}")
    raise RuntimeError(f"LM Studio still down 20s after lms server start{detail}")


def rewrite(origin: str, model: str, prepared: str, budget: int) -> str:
    """The spoken text, unpolished (speak.py polishes). One retry if the model blows the
    budget by a wide margin."""
    stated_budget = int(budget * 0.7)
    system = SYSTEM_PROMPT.replace("{budget}", str(stated_budget))
    messages = [{"role": "system", "content": system}, {"role": "user", "content": prepared}]
    ensure_lmstudio(origin, model)
    out = _chat(origin, model, messages, max_tokens=400)
    if not out:
        raise RuntimeError(f"{model} returned an empty rewrite")
    words = len(out.split())
    if words > budget * 1.25 + 5:
        log(f"{model} used {words} words against a budget of {budget}; retrying tighter")
        messages += [
            {"role": "assistant", "content": out},
            {"role": "user", "content": f"That was {words} words. The hard limit is {budget}. Say it again within the limit, still covering the whole reply."},
        ]
        again = _chat(origin, model, messages, max_tokens=400)
        if again:
            out = again
    return out


# The JSON keys `--warm` and `--status` print (speak.py merges warm's into its --arm result;
# src/panels/speak.ts ArmResult reads them; tests/voice-slots-contract.test.mjs pins both sides).
WARM_KEYS = ("lmstudio_start_seconds", "model_load_seconds", "model")
STATUS_KEYS = ("model",)


def warm(origin: str, model: str) -> dict:
    result = {"lmstudio_start_seconds": ensure_lmstudio(origin, model)}
    started = time.perf_counter()
    _chat(origin, model, [{"role": "user", "content": "hi"}], max_tokens=1)
    result["model_load_seconds"] = round(time.perf_counter() - started, 3)
    result["model"] = model_state(origin, model)
    return result


def main() -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--origin")
    ap.add_argument("--model", help="the server's model id (required except with --stop)")
    ap.add_argument("--budget", type=int)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--warm", action="store_true")
    mode.add_argument("--status", action="store_true")
    mode.add_argument("--stop", action="store_true")
    args = ap.parse_args()
    if args.stop:
        print(json.dumps({"stopped": False}))
        return 0
    if not args.origin:
        ap.error("--origin is required")
    if not args.model:
        ap.error("--model is required: set voiceSlots.rewrite.model in vidar.json")
    origin, model = args.origin.rstrip("/"), args.model
    try:
        if args.status:
            print(json.dumps({"model": model_state(origin, model)}))
        elif args.warm:
            print(json.dumps(warm(origin, model)))
        else:
            if args.budget is None:
                ap.error("--budget is required")
            print(rewrite(origin, model, sys.stdin.read(), args.budget))
    except Exception as e:  # noqa: BLE001 — one failure line on stderr, whatever it was
        log(str(e))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
