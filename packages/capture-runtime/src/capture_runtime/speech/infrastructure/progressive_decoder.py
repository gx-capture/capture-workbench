"""Disk-backed, bounded PyAV decoder for progressive audio windows."""

from __future__ import annotations

import itertools
from collections.abc import Callable, Generator
from pathlib import Path
from typing import Any

from capture_runtime.speech.application.use_cases import SliceAudioStream
from capture_runtime.speech.domain.window import WindowSlicingPolicy
from capture_runtime.speech.infrastructure.progressive_audio import (
    MAX_PROGRESSIVE_WINDOW_BYTES,
    DecodedAudioWindow,
)


class ProgressiveDecoderError(RuntimeError):
    pass


def progressive_decoder_ready() -> bool:
    """Return whether the packaged PyAV decoder can be imported safely."""

    try:
        import av
        import av.audio.resampler
        import av.container

        return av is not None
    except Exception:
        return False


class AudioDurationExceededError(ValueError):
    """The decoded sample count exceeded the whole-recording duration budget."""


class PyAVFileDecoder:
    """Lazily decode a finalized source once, with bounded overlapping PCM windows."""

    def __init__(
        self,
        source_path: Path,
        *,
        max_duration_ms: int,
        should_cancel: Callable[[], bool],
        sample_rate: int = 16_000,
        window_ms: int = 120_000,
        overlap_ms: int = 30_000,
        max_window_bytes: int = MAX_PROGRESSIVE_WINDOW_BYTES,
    ) -> None:
        if sample_rate <= 0 or not 0 < overlap_ms < window_ms:
            raise ValueError("decoder audio timing is invalid")
        if max_duration_ms <= 0 or max_window_bytes <= 0:
            raise ValueError("decoder limits must be positive")
        if round(window_ms * sample_rate * 2 / 1000) > max_window_bytes:
            raise ValueError("decoded audio window exceeds its memory limit")
        self.source_path = source_path
        self.sample_rate = sample_rate
        self._slicer = SliceAudioStream(WindowSlicingPolicy(window_ms, overlap_ms))
        self.overlap_ms = overlap_ms
        self.max_window_bytes = max_window_bytes
        self.max_duration_ms = max_duration_ms
        self.should_cancel = should_cancel
        self.duration_ms: int | None = None
        self._decoded_samples = 0
        self._window_start_ms = 0
        self._pcm = bytearray()

    def windows(self) -> Generator[DecodedAudioWindow]:
        """The caller must close this iterator when stopping before exhaustion."""
        try:
            import av

            if self.should_cancel():
                raise InterruptedError("Speech recognition was cancelled.")
            with av.open(str(self.source_path)) as container:
                if container.duration:
                    self.duration_ms = max(1, int(container.duration) // 1000)
                stream = next((item for item in container.streams if item.type == "audio"), None)
                if stream is None:
                    raise ProgressiveDecoderError("audio source has no audio stream")
                resampler = av.audio.resampler.AudioResampler(
                    format="s16", layout="mono", rate=self.sample_rate
                )
                for frame in itertools.chain(container.decode(stream), [None]):
                    if self.should_cancel():
                        raise InterruptedError("Speech recognition was cancelled.")
                    for decoded in _resample(resampler, frame):
                        if self.should_cancel():
                            raise InterruptedError("Speech recognition was cancelled.")
                        sample_count = int(decoded.samples)
                        self._decoded_samples += sample_count
                        if self._decoded_samples * 1000 > self.max_duration_ms * self.sample_rate:
                            raise AudioDurationExceededError(
                                "Audio duration exceeds the configured limit."
                            )
                        decoded_until_ms = self._decoded_samples * 1000 // self.sample_rate
                        # Plane buffers may contain alignment padding after the samples.
                        self._pcm.extend(bytes(decoded.planes[0])[: sample_count * 2])
                        for _, end_ms in self._slicer.execute(
                            decoded_until_ms,
                            start_ms=self._window_start_ms,
                            include_partial=False,
                        ):
                            if self.should_cancel():
                                raise InterruptedError("Speech recognition was cancelled.")
                            yield self._take_window(end_ms)
                if self._pcm:
                    yield self._take_window(
                        max(1, self._decoded_samples * 1000 // self.sample_rate), final=True
                    )
        except (ProgressiveDecoderError, AudioDurationExceededError, InterruptedError):
            raise
        except Exception as error:
            raise ProgressiveDecoderError("audio source could not be decoded") from error
        finally:
            self._pcm.clear()

    def _take_window(self, end_ms: int, *, final: bool = False) -> DecodedAudioWindow:
        start_sample = self._window_start_ms * self.sample_rate // 1000
        end_sample = end_ms * self.sample_rate // 1000
        # Integer milliseconds cannot express a sub-ms tail. Carry every sample
        # at EOF; only the reported end is truncated, by less than one ms.
        expected_bytes = len(self._pcm) if final else (end_sample - start_sample) * 2
        if expected_bytes <= 0:
            raise ProgressiveDecoderError("decoded audio window is empty")
        if expected_bytes > self.max_window_bytes:
            raise ProgressiveDecoderError("decoded audio window exceeds its memory limit")
        payload = bytes(self._pcm[:expected_bytes])
        if not payload:
            raise ProgressiveDecoderError("decoded audio window is empty")
        if final:
            self._pcm.clear()
            start_ms = self._window_start_ms
            self._window_start_ms = end_ms
            return DecodedAudioWindow(start_ms, end_ms, payload)
        next_start_sample = (end_ms - self.overlap_ms) * self.sample_rate // 1000
        self._pcm = self._pcm[(next_start_sample - start_sample) * 2 :]
        start_ms = self._window_start_ms
        self._window_start_ms = end_ms - self.overlap_ms
        return DecodedAudioWindow(start_ms, end_ms, payload)


def _resample(resampler: Any, frame: Any) -> list[Any]:
    result = resampler.resample(frame)
    if result is None:
        return []
    return list(result) if isinstance(result, list | tuple) else [result]
