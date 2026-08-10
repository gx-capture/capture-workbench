from __future__ import annotations

import wave
from pathlib import Path

import pytest

from capture_runtime.engine_adapters import WhisperTextSegment, WhisperTranscriptionResult
from capture_runtime.progressive_audio import DecodedAudioWindow, ProgressiveBackpressureError
from capture_runtime.progressive_decoder import PyAVIncrementalDecoder
from capture_runtime.progressive_whisper import FasterWhisperWindowTranscriber


def _wav(path: Path, *, seconds: int = 2) -> bytes:
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(1_000)
        audio.writeframes(b"\x00\x00" * (seconds * 1_000))
    return path.read_bytes()


def test_pyav_incremental_decoder_keeps_windows_bounded_and_overlapped(tmp_path: Path) -> None:
    source = _wav(tmp_path / "fixture.wav")
    decoder = PyAVIncrementalDecoder(
        tmp_path / "spool.wav",
        sample_rate=1_000,
        window_ms=1_000,
        overlap_ms=200,
        max_spool_bytes=len(source),
        max_window_bytes=2_400,
    )

    windows: list[DecodedAudioWindow] = []
    for offset in range(0, len(source), 257):
        windows.extend(decoder.push(source[offset : offset + 257]))
    windows.extend(decoder.finish())

    assert windows
    assert [(window.start_ms, window.end_ms) for window in windows] == [
        (0, 1_000),
        (800, 1_800),
        (1_600, 2_000),
    ]
    assert all(len(window.payload) <= 2_400 for window in windows)


def test_pyav_incremental_decoder_rejects_spool_overflow(tmp_path: Path) -> None:
    decoder = PyAVIncrementalDecoder(
        tmp_path / "spool.wav",
        max_spool_bytes=3,
    )

    with pytest.raises(ProgressiveBackpressureError):
        decoder.push(b"1234")


class FakeWhisper:
    def __init__(self) -> None:
        self.paths: list[Path] = []

    def transcribe(self, source_path: Path, *, should_cancel):
        self.paths.append(source_path)
        assert source_path.is_file()
        return WhisperTranscriptionResult(
            segments=(WhisperTextSegment(0, 100, "window text"),),
            duration_ms=100,
            device="cpu",
            model="small",
            digest=f"sha256:{'c' * 64}",
        )


def test_progressive_whisper_adapter_cleans_window_and_preserves_provenance(
    tmp_path: Path,
) -> None:
    adapter = FakeWhisper()
    transcriber = FasterWhisperWindowTranscriber(adapter, temp_dir=tmp_path)

    result = transcriber.transcribe(DecodedAudioWindow(0, 100, b"\x00\x00" * 100))

    assert result.extraction_engine.engine == "whisper-primary"
    assert result.extraction_engine.model == "small"
    assert result.extraction_engine.device == "cpu"
    assert not list(tmp_path.glob("capture-progressive-window-*.wav"))
