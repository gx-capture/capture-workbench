from __future__ import annotations

import io
import wave

from capture_runtime.extractors import _audio_run_timeout_seconds
from capture_runtime.worker_process import DEFAULT_RUN_TIMEOUT_SECONDS


def _wav(seconds: int) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8_000)
        audio.writeframes(b"\x00\x00" * (seconds * 8_000))
    return buffer.getvalue()


def test_an_audio_run_may_take_the_standard_limit_plus_the_recording() -> None:
    timeout = _audio_run_timeout_seconds(_wav(60), max_duration_ms=5_400_000)

    assert abs(timeout - (DEFAULT_RUN_TIMEOUT_SECONDS + 60)) < 1


def test_audio_of_unknown_length_may_take_as_long_as_the_longest_allowed() -> None:
    timeout = _audio_run_timeout_seconds(b"not audio", max_duration_ms=5_400_000)

    assert timeout == DEFAULT_RUN_TIMEOUT_SECONDS + 5_400
