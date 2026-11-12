from __future__ import annotations

import wave
from pathlib import Path

import pytest

from capture_runtime.speech.infrastructure.progressive_audio import (
    DecodedAudioWindow,
)
from capture_runtime.speech.infrastructure.progressive_decoder import (
    AudioDurationExceededError,
    ProgressiveDecoderError,
    PyAVFileDecoder,
)
from capture_runtime.speech.infrastructure.progressive_whisper import (
    SpeechRecognitionWindowTranscriber,
)
from capture_runtime.speech.infrastructure.speech_transcript import (
    WhisperTextSegment,
    WhisperTranscriptionResult,
)


def _wav(path: Path, *, seconds: int = 2) -> bytes:
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(1_000)
        audio.writeframes(b"\x00\x00" * (seconds * 1_000))
    return path.read_bytes()


def test_finalized_windows_match_sample_intervals_and_samples(tmp_path: Path) -> None:
    path = tmp_path / "fixture.wav"
    _wav(path)
    windows = list(
        PyAVFileDecoder(
            path,
            sample_rate=1_000,
            window_ms=1_000,
            overlap_ms=200,
            max_duration_ms=10_000,
            should_cancel=lambda: False,
        ).windows()
    )
    assert [(w.start_ms, w.end_ms, len(w.payload) // 2) for w in windows] == [
        (0, 1_000, 1_000),
        (800, 1_800, 1_000),
        (1_600, 2_000, 400),
    ]


def _opus_tone(path: Path, *, seconds: int = 3) -> bytes:
    import math

    import av

    # Opus decodes at 48 kHz in 20 ms frames; resampled to 16 kHz each frame is
    # 320 samples, whose plane buffer is longer than its 640 bytes of audio.
    with av.open(str(path), "w", format="ogg") as output:
        stream = output.add_stream("libopus", rate=48_000)
        stream.layout = "mono"
        samples = 48_000 * seconds
        pcm = b"".join(
            int(8_000 * math.sin(2 * math.pi * 440 * index / 48_000)).to_bytes(
                2, "little", signed=True
            )
            for index in range(samples)
        )
        frame = av.AudioFrame(format="s16", layout="mono", samples=samples)
        frame.planes[0].update(pcm)
        frame.sample_rate = 48_000
        frame.pts = 0
        for packet in stream.encode(frame):
            output.mux(packet)
        for packet in stream.encode(None):
            output.mux(packet)
    return path.read_bytes()


def _reference_pcm(path: Path) -> bytes:
    import av

    pcm = bytearray()
    with av.open(str(path)) as container:
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16_000)
        for frame in container.decode(container.streams.audio[0]):
            for decoded in resampler.resample(frame):
                pcm.extend(bytes(decoded.planes[0])[: decoded.samples * 2])
        for decoded in resampler.resample(None):
            pcm.extend(bytes(decoded.planes[0])[: decoded.samples * 2])
    return bytes(pcm)


def test_finalized_decoder_resamples_and_flushes_without_plane_padding(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "tone.ogg"
    _opus_tone(path)
    import av

    original = av.audio.resampler.AudioResampler
    flushed = []

    class Resampler:
        def __init__(self, **kwargs):
            self.resampler = original(**kwargs)

        def resample(self, frame):
            if frame is None:
                flushed.append(True)
            return self.resampler.resample(frame)

    monkeypatch.setattr(av.audio.resampler, "AudioResampler", Resampler)
    [window] = list(
        PyAVFileDecoder(
            path,
            window_ms=10_000,
            overlap_ms=1_000,
            max_duration_ms=10_000,
            should_cancel=lambda: False,
        ).windows()
    )
    reference = _reference_pcm(path)
    assert window.payload == reference
    assert abs(window.end_ms - len(reference) / 32) < 1
    assert flushed == [True]


class _ObservedContainer:
    def __init__(self, container, counts, *, duration="actual", malformed=False):
        self.container = container
        self.counts = counts
        self.duration = container.duration if duration == "actual" else duration
        self.streams = container.streams
        self.malformed = malformed

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.container.close()
        self.counts["closed"] += 1

    def decode(self, stream):
        for frame in self.container.decode(stream):
            self.counts["frames"] += 1
            yield frame
        if self.malformed:
            raise ValueError("malformed tail")


def _observe(monkeypatch, *, duration="actual", malformed=False):
    import av

    original = av.open
    counts = {"opens": 0, "frames": 0, "closed": 0}

    def open_source(*args, **kwargs):
        counts["opens"] += 1
        return _ObservedContainer(
            original(*args, **kwargs), counts, duration=duration, malformed=malformed
        )

    monkeypatch.setattr(av, "open", open_source)
    return counts


def test_finalized_decoder_is_lazy_and_decodes_each_frame_once(tmp_path, monkeypatch):
    import av

    path = tmp_path / "fixture.wav"
    _wav(path, seconds=12)
    with av.open(str(path)) as container:
        total_frames = sum(1 for _ in container.decode(container.streams.audio[0]))
    counts = _observe(monkeypatch)
    windows = PyAVFileDecoder(
        path,
        sample_rate=1_000,
        window_ms=1_000,
        overlap_ms=200,
        max_duration_ms=20_000,
        should_cancel=lambda: False,
    ).windows()
    next(windows)
    assert 0 < counts["frames"] < total_frames
    list(windows)
    assert counts == {"opens": 1, "frames": total_frames, "closed": 1}


@pytest.mark.parametrize("duration", ["actual", None, 1, 999_000_000])
def test_duration_budget_counts_samples_independently_of_metadata(tmp_path, monkeypatch, duration):
    path = tmp_path / "fixture.wav"
    _wav(path, seconds=12)
    counts = _observe(monkeypatch, duration=duration)
    windows = PyAVFileDecoder(
        path,
        sample_rate=1_000,
        window_ms=1_000,
        overlap_ms=200,
        max_duration_ms=1_500,
        should_cancel=lambda: False,
    ).windows()
    next(windows)
    with pytest.raises(AudioDurationExceededError, match="configured limit"):
        list(windows)
    assert counts["closed"] == 1
    path.unlink()


def test_cancellation_closes_source_mid_file(tmp_path, monkeypatch):
    path = tmp_path / "fixture.wav"
    _wav(path, seconds=12)
    counts = _observe(monkeypatch)
    cancelled = False
    windows = PyAVFileDecoder(
        path,
        sample_rate=1_000,
        window_ms=1_000,
        overlap_ms=200,
        max_duration_ms=20_000,
        should_cancel=lambda: cancelled,
    ).windows()
    next(windows)
    frames = counts["frames"]
    cancelled = True
    with pytest.raises(InterruptedError):
        next(windows)
    assert counts["frames"] <= frames + 1
    assert counts["closed"] == 1
    path.unlink()


def test_malformed_tail_fails_after_partial_windows_and_closes(tmp_path, monkeypatch):
    path = tmp_path / "fixture.wav"
    _wav(path, seconds=3)
    counts = _observe(monkeypatch, malformed=True)
    windows = PyAVFileDecoder(
        path,
        sample_rate=1_000,
        window_ms=1_000,
        overlap_ms=200,
        max_duration_ms=20_000,
        should_cancel=lambda: False,
    ).windows()
    next(windows)
    with pytest.raises(ProgressiveDecoderError, match="could not be decoded"):
        list(windows)
    assert counts["closed"] == 1
    path.unlink()


def test_video_without_audio_fails_and_closes(tmp_path):
    import av

    path = tmp_path / "video.mp4"
    with av.open(str(path), "w") as output:
        stream = output.add_stream("mpeg4", rate=25)
        stream.width = stream.height = 16
        stream.pix_fmt = "yuv420p"
        frame = av.VideoFrame(16, 16, "yuv420p")
        for plane in frame.planes:
            plane.update(bytes(plane.buffer_size))
        for packet in stream.encode(frame):
            output.mux(packet)
        for packet in stream.encode(None):
            output.mux(packet)
    with pytest.raises(ProgressiveDecoderError, match="no audio stream"):
        list(PyAVFileDecoder(path, max_duration_ms=10_000, should_cancel=lambda: False).windows())
    path.unlink()


class FakeWhisper:
    def __init__(self) -> None:
        self.paths: list[Path] = []

    def transcribe(self, source_path: Path, *, should_cancel, **_kwargs):
        self.paths.append(source_path)
        assert source_path.is_file()
        return WhisperTranscriptionResult(
            segments=(WhisperTextSegment(0, 100, "window text"),),
            duration_ms=100,
            device="cpu",
            model="tea-asr-1.1-mini",
            digest=f"sha256:{'c' * 64}",
        )


def test_progressive_whisper_adapter_cleans_window_and_preserves_provenance(
    tmp_path: Path,
) -> None:
    adapter = FakeWhisper()
    transcriber = SpeechRecognitionWindowTranscriber(adapter, temp_dir=tmp_path)

    result = transcriber.transcribe(DecodedAudioWindow(0, 100, b"\x00\x00" * 100))

    assert result.extraction_engine.engine == "speech-recognition"
    assert result.extraction_engine.model == "tea-asr-1.1-mini"
    assert result.extraction_engine.device == "cpu"
    assert not list(tmp_path.glob("capture-progressive-window-*.wav"))


class TimedWhisper:
    """Loads its model in the first window only, like the TEA-ASR adapter."""

    def __init__(self) -> None:
        self.calls = 0

    def transcribe(self, source_path: Path, *, should_cancel, **_kwargs):
        self.calls += 1
        first = self.calls == 1
        return WhisperTranscriptionResult(
            segments=(WhisperTextSegment(0, 100, "window text"),),
            duration_ms=100,
            device="cuda",
            model="tea-asr-1.1",
            digest=f"sha256:{'c' * 64}",
            elapsed_ms=900 if first else 300,
            stage_ms={"modelLoad": 600, "transcription": 300} if first else {"transcription": 300},
        )


def test_progressive_whisper_adapter_times_the_whole_recording(tmp_path: Path) -> None:
    transcriber = SpeechRecognitionWindowTranscriber(TimedWhisper(), temp_dir=tmp_path)
    window = DecodedAudioWindow(0, 100, b"\x00\x00" * 100)

    transcriber.transcribe(window)
    engine = transcriber.transcribe(window).extraction_engine

    assert engine.elapsed_ms == 1200
    assert engine.stage_ms == {"modelLoad": 600, "transcription": 600}


def test_closing_suspended_decoder_releases_source(tmp_path, monkeypatch):
    path = tmp_path / "fixture.wav"
    _wav(path, seconds=12)
    counts = _observe(monkeypatch)
    windows = PyAVFileDecoder(
        path,
        sample_rate=1_000,
        window_ms=1_000,
        overlap_ms=200,
        max_duration_ms=20_000,
        should_cancel=lambda: False,
    ).windows()
    next(windows)
    frames = counts["frames"]
    windows.close()
    assert counts["frames"] == frames
    assert counts["closed"] == 1
    path.unlink()


def test_video_container_audio_track_is_decoded(tmp_path):
    import av

    path = tmp_path / "recording.mkv"
    with av.open(str(path), "w", format="matroska") as output:
        video = output.add_stream("mpeg4", rate=25)
        video.width = video.height = 16
        video.pix_fmt = "yuv420p"
        audio = output.add_stream("pcm_s16le", rate=16_000)
        audio.layout = "mono"
        picture = av.VideoFrame(16, 16, "yuv420p")
        for plane in picture.planes:
            plane.update(bytes(plane.buffer_size))
        sound = av.AudioFrame(format="s16", layout="mono", samples=16_000)
        sound.sample_rate = 16_000
        sound.planes[0].update(bytes(32_000))
        for stream, frame in ((video, picture), (audio, sound)):
            for packet in stream.encode(frame):
                output.mux(packet)
            for packet in stream.encode(None):
                output.mux(packet)
    [window] = list(
        PyAVFileDecoder(path, max_duration_ms=2_000, should_cancel=lambda: False).windows()
    )
    assert (window.start_ms, window.end_ms, len(window.payload)) == (0, 1_000, 32_000)
    path.unlink()


def test_exact_duration_budget_accepts_the_final_sample(tmp_path):
    path = tmp_path / "fixture.wav"
    _wav(path, seconds=2)
    windows = list(
        PyAVFileDecoder(
            path,
            sample_rate=1_000,
            window_ms=1_000,
            overlap_ms=200,
            max_duration_ms=2_000,
            should_cancel=lambda: False,
        ).windows()
    )
    assert windows[-1].end_ms == 2_000


@pytest.mark.parametrize("frame_count", [1501, 253125])
def test_fractional_millisecond_frames_keep_sample_time_and_every_sample(
    tmp_path, monkeypatch, frame_count
):
    from types import SimpleNamespace

    import av

    # Resampler-output seam: AAC commonly alternates 341/342 samples at 16 kHz.
    frames = [
        SimpleNamespace(samples=count, planes=[bytes([index + 1, 0]) * count])
        for index, count in enumerate((341, 342))
    ]
    total_samples = (frame_count // 2) * 683 + (341 if frame_count % 2 else 0)

    class Container:
        duration = None
        streams = [SimpleNamespace(type="audio")]

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def decode(self, _stream):
            return (frames[index % 2] for index in range(frame_count))

    monkeypatch.setattr(av, "open", lambda *_args: Container())
    monkeypatch.setattr(
        "capture_runtime.speech.infrastructure.progressive_decoder._resample",
        lambda _resampler, frame: [] if frame is None else [frame],
    )
    decoder = PyAVFileDecoder(
        tmp_path / "synthetic.aac",
        window_ms=1_000 if frame_count == 1501 else 120_000,
        overlap_ms=200 if frame_count == 1501 else 30_000,
        max_duration_ms=6_000_000,
        should_cancel=lambda: False,
    )
    unique_samples = 0
    previous_end = 0
    reconstructed = bytearray()
    reference = (
        b"".join(frames[i % 2].planes[0] for i in range(frame_count))
        if frame_count == 1501
        else b""
    )
    for window in decoder.windows():
        start_sample = window.start_ms * 16
        overlap_samples = previous_end - start_sample
        assert overlap_samples >= 0
        unique = window.payload[overlap_samples * 2 :]
        unique_samples += len(unique) // 2
        previous_end = start_sample + len(window.payload) // 2
        assert abs(window.end_ms - previous_end / 16) < 1
        if frame_count == 1501:
            assert window.payload == reference[start_sample * 2 : previous_end * 2]
            reconstructed.extend(unique)
    assert abs(window.end_ms - total_samples / 16) < 1
    assert unique_samples == total_samples
    if frame_count == 1501:
        assert reconstructed == reference


def test_second_decoded_window_segments_use_its_true_sample_start(tmp_path):
    from capture_runtime.contracts import CaptureEngine
    from capture_runtime.speech.infrastructure.progressive_audio import (
        ProgressiveAudioSession,
        WhisperWindowResult,
        WhisperWindowSegment,
    )

    path = tmp_path / "source.wav"
    _wav(path, seconds=2)
    windows = PyAVFileDecoder(
        path,
        sample_rate=16_000,
        window_ms=1_000,
        overlap_ms=200,
        max_duration_ms=3_000,
        should_cancel=lambda: False,
    ).windows()

    class Transcriber:
        def transcribe(self, window):
            return WhisperWindowResult(
                (WhisperWindowSegment(200, 300, str(window.start_ms)),),
                CaptureEngine(
                    engine="speech-recognition",
                    model="tea-asr-1.1-mini",
                    device="cpu",
                    digest=f"sha256:{'c' * 64}",
                ),
            )

    session = ProgressiveAudioSession(transcriber=Transcriber(), overlap_ms=200)
    first = next(windows)
    session.consume_window(first)
    second = next(windows)
    assert second.start_ms == 800
    assert len(second.payload) == (second.end_ms - second.start_ms) * 32
    events = session.consume_window(second)
    [segment] = [segment for event in events for segment in event.segments]
    assert segment.locator.start_ms == second.start_ms + 200 == 1_000
    windows.close()
