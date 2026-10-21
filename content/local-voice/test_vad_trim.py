"""Plain-python test for vad_trim.py: `python test_vad_trim.py`.

Pads the wake fixture with 1 s leading and 1.5 s trailing digital silence and checks
the trimmed clip is under 70% of the padded length and still holds the original
speech span (located by sample amplitude in the unpadded fixture). 3 s of silence must
come back unchanged. Skips with a message when the fixture or model is absent.
"""
from __future__ import annotations

import sys
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
FIXTURE = ROOT / "fixtures" / "hey-jarvis-16k.wav"
VAD = ROOT / "models" / "silero_vad.onnx"
SR = 16_000


def log(msg: str) -> None:
    print(f"[test_vad_trim] {msg}")


def main() -> int:
    if not FIXTURE.exists() or not VAD.exists():
        log(f"SKIP: need {FIXTURE.name} and {VAD.name} (missing: "
            f"{[p.name for p in (FIXTURE, VAD) if not p.exists()]})")
        return 0
    sys.path.insert(0, str(ROOT))
    import vad_trim

    with wave.open(str(FIXTURE), "rb") as w:
        assert w.getframerate() == SR and w.getnchannels() == 1 and w.getsampwidth() == 2
        speech = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    loud = np.flatnonzero(np.abs(speech) > 500)
    s0, s1 = int(loud[0]), int(loud[-1]) + 1  # speech span inside the unpadded clip
    lead, tail = SR, int(1.5 * SR)
    padded = np.concatenate([np.zeros(lead, np.int16), speech, np.zeros(tail, np.int16)])

    out = vad_trim.trim(padded, SR, VAD)
    ratio = len(out) / len(padded)
    log(f"padded {len(padded) / SR:.2f}s -> trimmed {len(out) / SR:.2f}s ({ratio:.0%})")
    assert out.dtype == padded.dtype, "dtype changed"
    assert ratio < 0.70, f"trim too loose: {ratio:.0%}"
    # the trimmed clip must contain the speech span verbatim: find it by exact match
    needle = speech[s0:s1]
    hay = out.astype(np.int64)
    n = needle.astype(np.int64)
    first = int(np.flatnonzero(hay == n[0])[0]) if (hay == n[0]).any() else -1
    found = any(np.array_equal(hay[i:i + len(n)], n) for i in np.flatnonzero(hay == n[0]) if i + len(n) <= len(hay))
    assert found, f"speech span lost (loud span {s0}..{s1}, first candidate {first})"
    log("speech span preserved")

    sil = np.zeros(3 * SR, np.int16)
    out = vad_trim.trim(sil, SR, VAD)
    assert len(out) == len(sil) and np.array_equal(out, sil), "silence was altered"
    log("3 s silence unchanged")

    flt = vad_trim.trim(padded.astype(np.float32) / 32768.0, SR, VAD)
    assert flt.dtype == np.float32 and len(flt) < len(padded) * 0.7
    log("float input ok")
    log("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
