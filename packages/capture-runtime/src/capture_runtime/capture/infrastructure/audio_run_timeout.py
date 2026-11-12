"""How long one whole-recording engine run (speech recognition, speaker diarization) may take."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

from capture_runtime.worker_process import DEFAULT_RUN_TIMEOUT_SECONDS


def audio_run_timeout_seconds(content: bytes | Path, max_duration_ms: int) -> float:
    """How long one Whisper or speaker-diarization run on this audio may take.

    Both take time in proportion to the recording, and diarization runs on the
    CPU at about a third of real time: with the standard limit alone a
    40-minute interview failed. The limit grows by the recording's own length,
    or by the longest allowed when the container does not say.
    """
    duration_seconds = audio_duration_seconds(content)
    if duration_seconds is None:
        duration_seconds = max_duration_ms / 1000
    return DEFAULT_RUN_TIMEOUT_SECONDS + duration_seconds


def audio_duration_seconds(content: bytes | Path) -> float | None:
    try:
        import av

        source = str(content) if isinstance(content, Path) else BytesIO(content)
        with av.open(source, mode="r") as container:
            if container.duration is None:
                return None
            return container.duration / 1_000_000
    except Exception:
        return None


__all__ = ["audio_duration_seconds", "audio_run_timeout_seconds"]
