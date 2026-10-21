"""Scoring for the STT A/B (stt_ab.py): word error rate, term hits, timing percentiles.

No dependencies. Text is lowercased and stripped of punctuation before any comparison;
apostrophes are kept inside words ("don't"), hyphens split words.
"""
from __future__ import annotations

import re

_STRIP = re.compile(r"[^a-z0-9' ]+")


def normalise(text: str) -> list[str]:
    """Lowercase, punctuation to spaces, split to words."""
    t = _STRIP.sub(" ", text.lower().replace("’", "'"))
    return [w.strip("'") for w in t.split() if w.strip("'")]


def wer(ref: str, hyp: str) -> float | None:
    """Word-level Levenshtein distance / reference length; None for an empty reference."""
    r, h = normalise(ref), normalise(hyp)
    if not r:
        return None
    prev = list(range(len(h) + 1))
    for i, rw in enumerate(r, 1):
        cur = [i] + [0] * len(h)
        for j, hw in enumerate(h, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rw != hw))
        prev = cur
    return prev[-1] / len(r)


def _phrase_in(words: list[str], phrase: list[str]) -> bool:
    n = len(phrase)
    return n > 0 and any(words[i:i + n] == phrase for i in range(len(words) - n + 1))


def term_hits(ref: str, hyp: str, prompt_terms: list[str], heldout_terms: list[str]) -> dict:
    """Hit counts for terms that occur in the reference, prompt terms and held-out terms apart.

    Held-out phrases are removed from the reference before prompt terms are looked up, so
    "git diff" counts only as held-out even though "git" is a prompt term. A term hits when
    its words appear contiguously in the hypothesis.
    """
    r, h = normalise(ref), normalise(hyp)
    out = {"held_n": 0, "held_hit": 0, "prompt_n": 0, "prompt_hit": 0, "misses": []}
    rest = list(r)
    for term in heldout_terms:
        p = normalise(term)
        if _phrase_in(r, p):
            out["held_n"] += 1
            if _phrase_in(h, p):
                out["held_hit"] += 1
            else:
                out["misses"].append(term)
            n = len(p)
            for i in range(len(rest) - n + 1):  # blank the phrase for the prompt-term pass
                if rest[i:i + n] == p:
                    rest[i:i + n] = [""] * n
    for term in prompt_terms:
        p = normalise(term)
        if _phrase_in(rest, p):
            out["prompt_n"] += 1
            if _phrase_in(h, p):
                out["prompt_hit"] += 1
            else:
                out["misses"].append(term)
    return out


def median(xs: list[float]) -> float:
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def p90(xs: list[float]) -> float:
    """Nearest-rank 90th percentile (with 3 runs this is the slowest)."""
    s = sorted(xs)
    return s[min(len(s) - 1, max(0, -(-9 * len(s) // 10) - 1))]
