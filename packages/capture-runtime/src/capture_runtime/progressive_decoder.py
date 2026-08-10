"""Disk-backed, bounded PyAV decoder for progressive audio windows."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from capture_runtime.progressive_audio import (
    MAX_PROGRESSIVE_WINDOW_BYTES,
    DecodedAudioWindow,
    ProgressiveBackpressureError,
)


class ProgressiveDecoderError(RuntimeError):
    pass


class PyAVIncrementalDecoder:
    """Decode a growing source file while retaining only one overlap window in memory."""

    def __init__(
        self,
        spool_path: Path,
        *,
        sample_rate: int = 16_000,
        window_ms: int = 120_000,
        overlap_ms: int = 30_000,
        max_spool_bytes: int,
        max_window_bytes: int = MAX_PROGRESSIVE_WINDOW_BYTES,
    ) -> None:
        if sample_rate <= 0 or not 0 < overlap_ms < window_ms:
            raise ValueError("decoder audio timing is invalid")
        if max_spool_bytes <= 0 or max_window_bytes <= 0:
            raise ValueError("decoder byte limits must be positive")
        self.spool_path = spool_path
        self.sample_rate = sample_rate
        self.window_ms = window_ms
        self.overlap_ms = overlap_ms
        self.max_spool_bytes = max_spool_bytes
        self.max_window_bytes = max_window_bytes
        self._spooled_bytes = 0
        self._decoded_until_ms = 0
        self._window_start_ms = 0
        self._pcm = bytearray()
        self._finished = False

    def push(self, data: bytes) -> list[DecodedAudioWindow]:
        if self._finished:
            raise ProgressiveDecoderError("decoder is already finished")
        if not data:
            return []
        if self._spooled_bytes + len(data) > self.max_spool_bytes:
            raise ProgressiveBackpressureError("progressive audio spool exceeds its limit")
        self.spool_path.parent.mkdir(parents=True, exist_ok=True)
        with self.spool_path.open("ab") as spool:
            spool.write(data)
            spool.flush()
        self._spooled_bytes += len(data)
        return self._decode_available()

    def finish(self) -> list[DecodedAudioWindow]:
        if self._finished:
            return []
        self._finished = True
        windows = self._decode_available()
        if self._pcm:
            windows.append(self._take_window(self._decoded_until_ms, final=True))
        return windows

    def _decode_available(self) -> list[DecodedAudioWindow]:
        try:
            import av

            container = av.open(str(self.spool_path))
        except Exception as error:
            if self._finished:
                raise ProgressiveDecoderError("audio source could not be decoded") from error
            return []
        windows: list[DecodedAudioWindow] = []
        try:
            stream = next((item for item in container.streams if item.type == "audio"), None)
            if stream is None:
                raise ProgressiveDecoderError("audio source has no audio stream")
            resampler = av.audio.resampler.AudioResampler(
                format="s16", layout="mono", rate=self.sample_rate
            )
            timeline_ms = 0
            for frame in container.decode(stream):
                for decoded in _resample(resampler, frame):
                    sample_count = int(decoded.samples)
                    duration_ms = max(1, round(sample_count * 1000 / self.sample_rate))
                    frame_end_ms = timeline_ms + duration_ms
                    timeline_ms = frame_end_ms
                    if frame_end_ms <= self._decoded_until_ms:
                        continue
                    self._pcm.extend(bytes(decoded.planes[0]))
                    self._decoded_until_ms = frame_end_ms
                    while self._decoded_until_ms - self._window_start_ms >= self.window_ms:
                        windows.append(self._take_window(self._window_start_ms + self.window_ms))
            return windows
        except ProgressiveDecoderError:
            raise
        except Exception as error:
            if self._finished:
                raise ProgressiveDecoderError("audio source could not be decoded") from error
            return windows
        finally:
            container.close()

    def _take_window(self, end_ms: int, *, final: bool = False) -> DecodedAudioWindow:
        duration_ms = max(1, end_ms - self._window_start_ms)
        expected_bytes = round(duration_ms * self.sample_rate * 2 / 1000)
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
        overlap_bytes = round(self.overlap_ms * self.sample_rate * 2 / 1000)
        self._pcm = self._pcm[max(0, expected_bytes - overlap_bytes) :]
        start_ms = self._window_start_ms
        self._window_start_ms = end_ms - self.overlap_ms
        return DecodedAudioWindow(start_ms, end_ms, payload)


def _resample(resampler: Any, frame: Any) -> list[Any]:
    result = resampler.resample(frame)
    if result is None:
        return []
    return list(result) if isinstance(result, list | tuple) else [result]


__all__ = ["ProgressiveDecoderError", "PyAVIncrementalDecoder"]
