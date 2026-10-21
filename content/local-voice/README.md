# Local Voice Setup

Status: installed and smoke-tested. Speak action wired (below).

## Set Up

```
pwsh -File tools/voice/setup-voice.ps1
```

Sets up the Recommended picks: Python 3.11 venv, the lean ONNX package set
(`requirements.txt`), the Whisper CLI and `tiny.en-q8_0` model, the Kokoro ONNX model files and
the wake-word models. Each step checks first and skips what is already in place. Before any
download it lists what it will fetch and asks `Download these? [y/N]`; `-Yes` answers yes,
`-DryRun` prints the list and changes nothing. `-Speak` also installs the KPipeline Speak voice
extra (`requirements-speak.txt`: kokoro, PyTorch CPU, spaCy); its Kokoro-82M weights are still
fetched by hand (the `kokoro-kpipeline` fill line). Python 3.11 itself is not downloaded.

### What It Downloads

| What | Publisher | Source | Licence | Size | Check |
|---|---|---|---|---|---|
| Python packages (lean ONNX set) | Each project's maintainers, via PyPI | pypi.org/simple, files.pythonhosted.org | MIT, BSD-3-Clause, Apache-2.0 per package; phonemizer GPL-3.0 | up to ~150 MB | HTTPS; direct packages at exact `==` versions (versions, not hashes); pip resolves the rest |
| Speak voice extra, `-Speak` only (kokoro, PyTorch CPU, spaCy) | hexgrad, PyTorch, Explosion, via PyPI | pypi.org, files.pythonhosted.org, github.com/explosion/spacy-models/releases | Apache-2.0 (kokoro, misaki); BSD-style (torch); MIT (spaCy) | ~1 GB | HTTPS; exact `==` versions; en-core-web-sm wheel SHA-256 pinned |
| whisper.cpp CLI and tiny.en model | ggml-org (whisper.cpp) | github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip; huggingface.co/ggerganov/whisper.cpp/resolve/(pinned commit)/ggml-tiny.en-q8_0.bin | MIT | ~15 MB zip + 44 MB model | SHA-256 pinned in `fetch-whisper.ps1` for both files |
| Kokoro model file kokoro-v1.0.int8.onnx | thewh1teagle (kokoro-onnx), release model-files-v1.0, 2025-01-28 | github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx | Apache-2.0 (Kokoro-82M weights) | 88.1 MB | exact byte size (92361271); SHA-256 printed; upstream publishes no hash |
| Kokoro model file voices-v1.0.bin | thewh1teagle (kokoro-onnx), release model-files-v1.0, 2025-01-28 | github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin | Apache-2.0 (Kokoro-82M weights) | 26.9 MB | exact byte size (28214398); SHA-256 printed; upstream publishes no hash |
| Wake-word models (openWakeWord) | dscripka (openWakeWord); openwakeword.com model library | github.com/dscripka/openWakeWord/releases/download/v0.5.1; openwakeword.com/api/models | CC BY-NC-SA 4.0 (models) | ~7 MB | SHA-256 and byte size against the `openwakeword.json` pack manifest |

Everything lands inside the checkout (`content\local-voice\` and `content\vendor\whisper\`;
`fetch-whisper.ps1` unpacks its zip in `%TEMP%` first). Nothing is installed globally, no admin
rights are needed and PATH is not changed. To remove it all, delete `content\local-voice\.venv`,
`content\local-voice\.cache`, `content\local-voice\models` and `content\vendor\whisper`.

## Speak action

Transcript → `rewrite` slot → `tts` slot → speakers. Early testing: callable, not automatic.
Every model is a voice slot (`stt`, `wake`, `rewrite`, `tts`); Settings › Audio › Voice Slots
shows each slot's state and, for a missing one, its `fill` line to run by hand (Vidar never
downloads). Contract and adapters: `docs\reference\voice-pipelines.md`.

- `speak.py` — the action. Header is the documentation (`--cwd`, `--text`/`--stdin`,
  `--slots-file` (required), `--no-rewrite`, `--dry`, `--voice`, `--owner`, `--json`, `--arm`,
  `--status`, `--stop`).
- `tts_kokoro.py` — the `tts` adapter behind both stock manifests: `kokoro-kpipeline` (PyTorch,
  port 24242, the default Speak voice) and `kokoro-onnx-int8` (ONNX Runtime, port 24243,
  recommended; its runtime and model files come from `tools\voice\setup-voice.ps1`, which its
  fill line names). `tts` has no legacy key: set `voiceSlots.tts` in
  `vidar.json` or Speak fails naming the slot.
- `kokoro_sidecar.py` — the warm process `tts_kokoro.py` starts (`--serve <port>`, `--engine`),
  under the venv's `pythonw.exe`, tagged with an owner (`vidar` or `cli`); stays up until `--stop`
  or `SIDECAR_IDLE_MIN` minutes idle (default 240, 0 = never). Also speaks JSON lines on stdin
  (`--stdio`); not wired.
- `tools\voice\speak.ps1` — wrapper for any terminal or a skill (`-Arm`, `-Status`, `-Stop`).
- The bottom-bar button (left of the close lock, `src-tauri\src\speak.rs` + `src\panels\speak.ts`)
  is a power switch first: off (faded, muted glyph) → click loads the voice (`--arm`: the `tts`
  adapter's `warm` (the Kokoro sidecar), then the `rewrite` adapter's `warm` if it has one —
  openai-compat starts LM Studio's server if it is down (`lms server start`) and sends a
  one-token request so LM Studio loads the slot's model) → armed → click reads, click again stops, right-click switches off (`--stop`). On
  start it asks `--status`, so a sidecar left warm shows as armed. Nothing loads just because
  Vidar opened.
- "Latest reply" = last non-sidechain assistant text block of the newest transcript under
  `~\.claude\projects\<cwd slug>\`. Known gap: newest by mtime, so with two live sessions in the
  same cwd it may read the other one's reply.
- openai-compat needs LM Studio's server up; `--arm` and a read through the openai-compat adapter both
  start it on demand (`lms server start`) if it is down — claude-p and an empty slot never
  touch it. LM Studio unloads the model on its own TTL (1 h) and the next request reloads it. Still down after the start attempt
  = a clear error, not a verbatim read.
- Speech is chunked: first sentence synthesised alone and played while the rest renders on a
  thread. Measured warm: rewrite 0.4–1.3 s, first audio 0.25 s after that, Kokoro
  ~0.65 s per 7 s of audio, sidecar cold start 5.5 s.
- Prompt lessons: a minimum word count made a 4B model invent content for one-liners; "as short as the
  reply allows" gave anything from a fifth to a copy, and "verdict first" made it announce a
  verdict on replies that had none. Now: a word budget computed from the input (half under 120
  words, else a quarter, clamped 15–90; the prompt states 70% of it because the model lands
  ~40% over any number), one worked example, temperature 0, one retry when the budget is blown
  by more than a quarter. Paths become "the X file/folder", slash commands "the X command",
  code and links are dropped, before the call; survivors are stripped after. Residual 4B
  behaviour: occasional garble of a clause, and a floor of one sentence per bullet on dense
  lists (a 13-bullet overview still comes out ~115 words).
- Kokoro speed: 1.15 by default (`SPEAK_SPEED`, the slot's `{speed}`, clamped 0.5–2.0 in the
  sidecar); the only real Kokoro lever. The voice is the `tts` slot's model (`{voice}`):
  kokoro-kpipeline lists `af_heart` only (other voices need a per-voice download, ask-first);
  kokoro-onnx-int8 lists four from its one `voices-v1.0.bin`, British English included.
- Console-window lesson: the venv's `python.exe` is a launcher stub that spawns the real
  interpreter; spawning the stub with `DETACHED_PROCESS` gave that grandchild a fresh visible
  console on cold start. `pythonw.exe` (same stub, GUI subsystem) fixes it.
- Boot journal: every `speak_last` run and every `--arm`/`--stop` call — plus a
  `--status` call only when it did not simply report armed — appends a timestamped block to
  `.tmp\speak.log` (created if missing): a header line naming the call and its outcome, then that
  run's full stderr (the Python side's `ensure_lmstudio`/`ensure_sidecar` timing and error lines,
  and a full traceback on an unhandled exception), then a blank line. The tooltip still shows only
  the one-line failure; the journal is what is left to check afterward. Rotates once past 1 MiB:
  the current file becomes `speak.log.1` (overwritten each time), a fresh `speak.log` starts.

### Rewrite backend

The `rewrite` voice slot picks what rewrites the transcript before Kokoro speaks it.
`vidar.json` `voiceSlots.rewrite` is `{ "adapter": "<pack>/<id>", "model": "<id>" }`; the
legacy `speakRewrite` key is retired (`"none"` still means empty, any other value breaks the
slot).
Per Speak press `src-tauri\src\speak.rs` resolves the slot, writes
`bridge\voice-slots\resolved.json` and passes it as `--slots-file` to `speak.py` (no restart
needed). An empty slot is `strip_markdown`: the reply read verbatim.

- **openai-compat** (LM Studio) — local, ~1 s with a 4B model, which runs ~40% over any stated
  word budget, so the prompt asks for less than it means. The model is the slot's `model`, the
  id LM Studio serves, passed verbatim as `--model` (`"modelIds": true`); no default. Origin
  from vidar.json `lmstudioOrigin`.
- **claude-p** — `claude -p` (no API key on this machine), ~3 s measured, obeys the word budget
  closely, spends the Claude Code plan's usage meter instead of a local model. Needs `claude` on
  PATH.
- **empty** — `strip_markdown`, read verbatim (same as `--no-rewrite`).

## Listen sidecar (wake word + VAD; the `wake` slot)

`src-tauri\src\listen.rs` runs the `wake` slot's adapter (stock `voice-stock/openwakeword` =
`listen.py`) and hands each utterance to the `stt` slot (stock `voice-stock/whisper-cli`, the same
path push-to-talk uses). A missing `stt` shows on the Voice Slots page with its fill line
(`tools\voice\fetch-whisper.ps1 -Model <model>`); a missing `wake` model with
`tools\voice\wakeword-models.ps1`.

- `listen.py` — `--stdio` sidecar: reads raw 16 kHz mono int16 PCM from stdin in 2560-byte
  (1280-sample, 80 ms) blocks, writes one JSON line per event to stdout
  (`{"ready":...}`, `{"ev":"wake"|"speech_start"|"speech_end"|"error",...}`), diagnostics on
  stderr (`[listen] ...`). Every model path is a required arg (`--model`, `--melspec`,
  `--embedding`, `--vad-model`), no defaults; Vidar fills them from the `wake` slot's manifest
  and checks their sha256 pins before it spawns this, and it never imports
  `openwakeword.utils.download_models` — no network path. Wake scoring is openWakeWord's
  `Model.predict` on `--model` (the slot's picked model, `hey_jarvis_v0.1` recommended);
  speech start/end is Silero VAD loaded directly from `--vad-model`
  (`openwakeword.vad.VAD(model_path=...)`, `predict(x, frame_size=640)` — `Model`'s own
  `vad_threshold` stays 0, since this venv has no bundled copy for it to fall back to). Exits
  clean on stdin EOF, ten seconds with no audio, or its `--parent-pid` going away (polled via
  `OpenProcess`/`GetExitCodeProcess`); exits 2 only when a model path is missing at startup.
- `test_listen.py` — plain `python test_listen.py`, no pytest. Generates
  `fixtures\hey-jarvis-16k.wav` once from a Kokoro utterance via `kokoro_sidecar.py --stdio`
  (24 kHz → 16 kHz `scipy.signal.resample_poly`, padded with silence, gain-normalised towards
  full scale), then reuses that fixture on reruns — delete it to force regeneration. Pipes the
  fixture into `listen.py` and asserts the event order `ready → wake → speech_end`, then feeds
  3 s of digital silence through a fresh sidecar and asserts no `wake`. Verified: max
  wake score 0.9984 on the Kokoro voice at the default `--threshold 0.5` — no tuning needed, so
  the test uses the default rather than a lowered one. Known gap: regenerating the
  fixture calls `kokoro_sidecar.py --stdio` without the now-required `--engine` and `--voice`,
  so it fails until the test passes them; the existing fixture still runs.
- `tools\voice\wakeword-models.ps1` — the `openwakeword` adapter's fill line: fetches the
  `models\*.onnx` files the manifest lists (gitignored) for a fresh checkout from the openWakeWord v0.5.1 GitHub
  release and verifies each against the sha256 and size in `openwakeword.json` (the manifest is
  the one pin). It downloads third-party
  binaries, which is an ask-first action at run time.

## Parakeet speech-to-text (the `stt` slot, opt-in)

Stock adapter `voice-stock/parakeet-v2`: Parakeet TDT 0.6B v2 (English, int8) through onnx-asr.

- `stt_parakeet.py` — one-shot (`--wav`, `--out`) and warm (`--serve`: prints `{"ready":true}`,
  then one JSON request per stdin line; exits on stdin EOF). Vidar holds the warm process in a
  kill-on-close job: it loads when Listen turns on and dies with Vidar (`src-tauri/src/stt_warm.rs`).
- `vad_trim.py` — Silero VAD trim of the clip before decoding (model `models/silero_vad.onnx`).
  The `whisper-cli-vad` adapter does the same natively with `--vad`.
- Fetch (ask-first, user runs): `pwsh -File tools/voice/fetch-parakeet.ps1 -Variant v2`;
  `pwsh -File tools/voice/fetch-whisper.ps1 -Model silero-v5.1.2` for the whisper VAD file.
- Paths: `content/local-voice/models/parakeet-tdt-0.6b-v2/` (encoder, decoder_joint, nemo128,
  config, vocab) and `content/vendor/whisper/ggml-silero-v5.1.2.bin`.
- Python is the venv's, by full path (`content/local-voice/.venv/Scripts/python.exe`); never bare
  `python`.
- Select: `vidar.json` `voiceSlots.stt` = `{ "adapter": "voice-stock/parakeet-v2", "model":
  "parakeet-tdt-0.6b-v2-int8" }`. Remove the key to revert to the legacy whisper path.
- Cost and decision: `docs/reference/voice-input.md` (2026-10-05 entry).

## Installed components

- Simplification: whichever model LM Studio serves, named by `voiceSlots.rewrite.model`.
- Speech: hexgrad/Kokoro-82M in the isolated `.venv` environment, using CPU.
- Kokoro model, `af_heart` voice, and English spaCy data are cached locally.
- No global installs, PATH edits, startup services, or LM Studio settings edits.
- Subsequent smoke checks use local inference only.

## Local layout

- `.venv/`: isolated Python 3.11 environment.
- `.cache/pip/`: Python package cache.
- `.cache/huggingface/`: Kokoro config, weights, and voice cache.
- `.tmp/`: setup temporary files.
- `smoke_test.py`: repeatable Kokoro CPU check.
- `smoke-test.wav`: generated validation audio.

LM Studio stores models under `%USERPROFILE%\.lmstudio\models\`. The served id is whatever
`lms ls` reports, and it **changes with what else is on disk**: one quant present and it is the
plain id; add a second and the entry splits into `<id>@q4_k_m` and `<id>@q8_0`, breaking the plain
id. Put the id LM Studio serves in `voiceSlots.rewrite.model`.

A **reasoning model** without `reasoning_effort: "none"` spends the whole budget in
`message.reasoning_content` and returns `content: ""` — a silently empty rewrite. `_chat()` sets it
unconditionally; do not remove it.

## Offline Kokoro check

```powershell
$voiceRoot = 'C:\Apps\Vidar\content\local-voice'   # your checkout's local-voice folder
$env:HF_HOME = Join-Path $voiceRoot '.cache\huggingface'
$env:HF_HUB_CACHE = Join-Path $env:HF_HOME 'hub'
$env:XDG_CACHE_HOME = Join-Path $voiceRoot '.cache'
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
$env:TEMP = Join-Path $voiceRoot '.tmp'
$env:TMP = $env:TEMP
& (Join-Path $voiceRoot '.venv\Scripts\python.exe') (Join-Path $voiceRoot 'smoke_test.py')
```

## Validation results

- The rewrite figures were measured against a 4B instruct model (2.50 GB) that is now off disk;
  they were not re-run since. It rewrote the test passage while preserving all required caveats;
  its successor was looser: handed a factual summary it dropped the subject and invented a
  closing question.
- Rewrite inference: 158.83 tokens/second; 0.033 seconds to first token.
- `pip check`: no broken requirements.
- PyTorch reports a CPU-only build and no CUDA device.
- Kokoro downloaded its official config, model weights, `af_heart` voice, and
  `en_core_web_sm` phonemizer data into the local environment/cache.
- Forced-offline rerun: 3.012 seconds to generate 21.800 seconds of 24 kHz audio.
- Output: `smoke-test.wav`.

The PyTorch deprecation warnings are upstream warnings and did not affect the smoke
test. Windows cache symlink support is unavailable, so Hugging Face may use more
disk space than it would with Developer Mode enabled.

## Sources

- Speech model: https://huggingface.co/hexgrad/Kokoro-82M
- Kokoro package: https://pypi.org/project/kokoro/0.9.4/
