"""Unit tests for speak.py's transcript picker and reply extractors: `python test_speak.py`.

Synthetic Claude and Codex fixtures under a temp dir; the real home is never read.
"""
from __future__ import annotations

import json
import os
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path

import speak


def jl(path: Path, recs: list[dict]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r) for r in recs) + "\n", encoding="utf-8")
    return path


def rollout(root: Path, name: str, cwd: str, texts: list[str], when: float) -> Path:
    day = datetime.fromtimestamp(when)
    f = root / f"{day:%Y}" / f"{day:%m}" / f"{day:%d}" / f"rollout-{name}.jsonl"
    recs: list[dict] = [{"type": "session_meta", "payload": {"cwd": cwd, "id": name}}]
    for t in texts:
        recs.append({"type": "response_item", "payload": {"type": "message", "role": "user",
                     "content": [{"type": "input_text", "text": "question"}]}})
        recs.append({"type": "response_item", "payload": {"type": "message", "role": "assistant",
                     "content": [{"type": "output_text", "text": t}]}})
    recs.append({"type": "event_msg", "payload": {"type": "token_count"}})
    jl(f, recs)
    os.utime(f, (when, when))
    return f


def claude_file(root: Path, cwd: str, name: str, text: str, when: float) -> Path:
    f = root / speak.project_slug(cwd) / f"{name}.jsonl"
    jl(f, [{"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}])
    os.utime(f, (when, when))
    return f


class SpeakPicker(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.claude, self.codex = self.tmp / "claude", self.tmp / "codex"
        self.cwd = str(self.tmp / "proj")
        Path(self.cwd).mkdir()
        self.now = time.time()

    def reply(self) -> tuple[str, str]:
        return speak.latest_reply(self.cwd, self.claude, self.codex)

    def test_codex_last_assistant_message(self) -> None:
        rollout(self.codex, "a", self.cwd, ["first", "second"], self.now)
        self.assertEqual(self.reply(), ("second", "rollout-a.jsonl"))

    def test_codex_cwd_case_insensitive(self) -> None:
        rollout(self.codex, "a", self.cwd.upper(), ["hi"], self.now)
        self.assertEqual(self.reply()[0], "hi")

    def test_codex_other_cwd_ignored(self) -> None:
        rollout(self.codex, "a", str(self.tmp / "other"), ["nope"], self.now)
        with self.assertRaises(RuntimeError):
            self.reply()

    def test_newest_across_both_stores(self) -> None:
        claude_file(self.claude, self.cwd, "c", "from claude", self.now - 100)
        rollout(self.codex, "a", self.cwd, ["from codex"], self.now - 10)
        self.assertEqual(self.reply()[0], "from codex")
        claude_file(self.claude, self.cwd, "c", "from claude", self.now)
        self.assertEqual(self.reply()[0], "from claude")

    def test_agent_restricts_to_its_own_store(self) -> None:
        # F3: a Codex reply must not speak the newer Claude transcript of the same folder.
        rollout(self.codex, "a", self.cwd, ["from codex"], self.now - 50)
        claude_file(self.claude, self.cwd, "c", "from claude", self.now)
        self.assertEqual(speak.latest_reply(self.cwd, self.claude, self.codex)[0], "from claude")
        self.assertEqual(speak.latest_reply(self.cwd, self.claude, self.codex, agent="codex")[0], "from codex")
        self.assertEqual(speak.latest_reply(self.cwd, self.claude, self.codex, agent="claude")[0], "from claude")

    def test_claude_root_is_the_given_store_only(self) -> None:
        # A Bare Claude tab's transcripts live under its own config dir, not the default projects.
        bare = self.tmp / "bare"
        claude_file(bare, self.cwd, "b", "from bare", self.now - 5)
        claude_file(self.claude, self.cwd, "c", "from default", self.now)
        self.assertEqual(speak.latest_reply(self.cwd, bare, self.codex, agent="claude")[0], "from bare")

    def test_agent_with_no_transcripts_raises(self) -> None:
        claude_file(self.claude, self.cwd, "c", "from claude", self.now)
        with self.assertRaises(RuntimeError):
            speak.latest_reply(self.cwd, self.claude, self.codex, agent="codex")

    def test_old_rollouts_not_scanned(self) -> None:
        rollout(self.codex, "a", self.cwd, ["stale"], self.now - 10 * 86400)
        with self.assertRaises(RuntimeError):
            self.reply()

    def test_fresh_rollout_without_reply_falls_back(self) -> None:
        rollout(self.codex, "old", self.cwd, ["answer"], self.now - 50)
        rollout(self.codex, "new", self.cwd, [], self.now)
        self.assertEqual(self.reply(), ("answer", "rollout-old.jsonl"))

    def test_claude_extractor_skips_sidechain_and_tools(self) -> None:
        f = jl(self.tmp / "c.jsonl", [
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "main"}]}},
            {"type": "assistant", "isSidechain": True, "message": {"content": [{"type": "text", "text": "side"}]}},
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "x"}]}},
        ])
        self.assertEqual(speak._last_assistant_text(f), "main")


if __name__ == "__main__":
    unittest.main()
