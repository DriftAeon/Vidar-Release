"""stt adapter: NVIDIA Parakeet TDT 0.6B v2 (int8 ONNX) through onnx-asr.

One-shot (the `stt` slot contract, contracts/voice-slots.json): read the 16 kHz mono WAV at
--wav, write UTF-8 text to <out>.txt, exit 0.

    stt_parakeet.py --model <encoder-model.int8.onnx> --vad-model <silero_vad.onnx>
                    --wav <in.wav> --out <base> [--no-trim]

--serve keeps the model loaded: prints {"ready":true,"loadMs":n} once, then reads JSONL
requests {"id","wav","out"} from stdin and answers {"id","ok":true,"ms":n} or
{"id","ok":false,"error":"..."}; exits on stdin EOF. stdout carries only protocol lines.

The model directory is the parent of --model (encoder, decoder_joint, nemo128, config.json,
vocab.txt). Offline always: a missing file would make onnx-asr download it, so every file is
checked first.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

MODEL_NAME = "nemo-parakeet-tdt-0.6b-v2"
REQUIRED = ["encoder-model.int8.onnx", "decoder_joint-model.int8.onnx", "nemo128.onnx",
            "config.json", "vocab.txt"]
RATE = 16_000

sys.path.insert(0, str(Path(__file__).resolve().parent))


def load(model_file: str):
    model_dir = Path(model_file).resolve().parent
    missing = [n for n in REQUIRED if not (model_dir / n).is_file()]
    if missing:
        raise FileNotFoundError(f"parakeet model files missing in {model_dir}: {', '.join(missing)}")
    import onnx_asr

    return onnx_asr.load_model(MODEL_NAME, str(model_dir), quantization="int8")


def transcribe(model, wav: str, out: str, vad_path: str | None):
    import numpy as np
    import soundfile as sf

    pcm, rate = sf.read(wav, dtype="float32", always_2d=False)
    if pcm.ndim > 1:
        pcm = pcm.mean(axis=1).astype(np.float32)
    if rate != RATE:
        raise ValueError(f"need {RATE} Hz audio, got {rate}")
    if vad_path:
        import vad_trim

        pcm = vad_trim.trim(pcm, RATE, vad_path)
    text = model.recognize(pcm, sample_rate=RATE)
    if not isinstance(text, str):
        text = getattr(text, "text", str(text))
    # utf-8, no BOM: a BOM would survive voice.rs normalise.
    Path(out + ".txt").write_text(text.strip() + "\n", encoding="utf-8")


def serve(model_file: str, vad_path: str | None) -> int:
    # Keep the real stdout for the protocol; anything else printing lands on stderr.
    proto = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    # Requests are utf-8 JSON from Vidar; the console code page would mangle non-ASCII paths.
    sys.stdin.reconfigure(encoding="utf-8")

    def send(obj):
        proto.write(json.dumps(obj, separators=(",", ":")) + "\n")
        proto.flush()

    t0 = time.perf_counter()
    model = load(model_file)
    send({"ready": True, "loadMs": int((time.perf_counter() - t0) * 1000)})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        t = time.perf_counter()
        try:
            req = json.loads(line)
            rid = req.get("id")
            transcribe(model, req["wav"], req["out"], vad_path)
            send({"id": rid, "ok": True, "ms": int((time.perf_counter() - t) * 1000)})
        except Exception as e:  # noqa: BLE001 - reported to the caller, loop continues
            send({"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"})
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--vad-model")
    ap.add_argument("--wav")
    ap.add_argument("--out")
    ap.add_argument("--no-trim", action="store_true")
    ap.add_argument("--serve", action="store_true")
    a = ap.parse_args()
    vad = None if a.no_trim else a.vad_model
    if a.serve:
        return serve(a.model, vad)
    if not a.wav or not a.out:
        ap.error("--wav and --out are required without --serve")
    transcribe(load(a.model), a.wav, a.out, vad)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        print(f"stt_parakeet: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
