from pathlib import Path
from time import perf_counter

import soundfile as sf


TEXT = (
    "The patch passes the TypeScript build, but WebView2 clipboard behavior "
    "hasn't been tested yet. Right now, clipboard reads grab the target session "
    "before waiting for permission. This should stop paste from reaching a newly "
    "focused tab. Restart the packaged app to see the change. We can't say the "
    "runtime bug is fixed until we actually test a live paste."
)


def main() -> None:
    try:
        from kokoro import KPipeline  # KPipeline voice only: torch, spaCy
    except ImportError as e:
        raise SystemExit(
            "The KPipeline voice needs the Speak extra: pwsh -File tools/voice/setup-voice.ps1 -Speak"
        ) from e
    started = perf_counter()
    pipeline =KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
    chunks = [audio for _, _, audio in pipeline(TEXT, voice="af_heart")]
    elapsed = perf_counter() - started

    if len(chunks) != 1:
        raise RuntimeError(f"Expected one audio chunk, got {len(chunks)}")

    output = Path(__file__).with_name("smoke-test.wav")
    sf.write(output, chunks[0], 24_000)
    duration = len(chunks[0]) / 24_000
    print(f"output={output}")
    print(f"generation_seconds={elapsed:.3f}")
    print(f"audio_seconds={duration:.3f}")


if __name__ == "__main__":
    main()
