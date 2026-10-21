"""Trim leading and trailing silence from 16 kHz mono PCM with Silero VAD.

One concern: find the first and last speech frame and cut around them. Silero runs
directly over onnxruntime (ported from openwakeword/vad.py: `input`/`sr`/`h`/`c`
in, `output`/`hn`/`cn` out, 640-sample frames as in listen.py); importing the
`openwakeword` package is avoided because its `__init__` pulls sklearn/scipy/tqdm.

    trim(pcm, 16000, vad_path) -> pcm   (same dtype; unchanged when no speech is found)

The 500 ms lead default covers the wake pre-roll listen.rs buffers ahead of a wake
utterance (`listen.rs:79`), so the first word is never cut.
"""
from __future__ import annotations

import functools
from pathlib import Path

import numpy as np

FRAME = 640  # samples at 16 kHz (40 ms); same as listen.py VAD_FRAME
RATE = 16_000
DEFAULT_VAD = Path(__file__).resolve().parent / "models" / "silero_vad.onnx"


@functools.lru_cache(maxsize=2)
def _session(vad_path: str):
    """One InferenceSession per model path; h/c state is call-local, so sharing is safe."""
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.inter_op_num_threads = 1
    opts.intra_op_num_threads = 1
    return ort.InferenceSession(vad_path, sess_options=opts, providers=["CPUExecutionProvider"])


def speech_probs(pcm: np.ndarray, vad_path: str | Path) -> np.ndarray:
    """Per-frame Silero speech probability for 16 kHz mono PCM (int16 or float in [-1, 1])."""
    sess = _session(str(vad_path))
    x = np.asarray(pcm)
    x = (x / 32767.0).astype(np.float32) if x.dtype.kind in "iu" else x.astype(np.float32)
    sr = np.array(RATE, dtype=np.int64)
    h = np.zeros((2, 1, 64), dtype=np.float32)
    c = np.zeros((2, 1, 64), dtype=np.float32)
    probs = []
    for i in range(0, len(x), FRAME):
        chunk = x[i:i + FRAME]
        if len(chunk) < FRAME:
            chunk = np.pad(chunk, (0, FRAME - len(chunk)))
        out, h, c = sess.run(None, {"input": chunk[None, :], "sr": sr, "h": h, "c": c})
        probs.append(float(out[0][0]))
    return np.array(probs, dtype=np.float32)


def trim(pcm, sample_rate: int, vad_path: str | Path = DEFAULT_VAD, threshold: float = 0.5,
         lead_ms: int = 500, tail_ms: int = 300):
    """Cut `pcm` to first speech frame minus `lead_ms` .. last speech frame plus `tail_ms`.

    No frame above `threshold` returns the input unchanged.
    """
    if sample_rate != RATE:
        raise ValueError(f"vad_trim needs {RATE} Hz audio, got {sample_rate}")
    pcm = np.asarray(pcm)
    if pcm.ndim != 1:
        raise ValueError("vad_trim needs mono (1-D) audio")
    probs = speech_probs(pcm, vad_path)
    hits = np.flatnonzero(probs > threshold)
    if hits.size == 0:
        return pcm
    start = max(0, int(hits[0]) * FRAME - lead_ms * RATE // 1000)
    end = min(len(pcm), (int(hits[-1]) + 1) * FRAME + tail_ms * RATE // 1000)
    return pcm[start:end]
