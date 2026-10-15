from __future__ import annotations

from pathlib import Path

import av
import pytest

from capture_runtime.contracts import CaptureSourceKind
from capture_runtime.extractors import SNIFF_BYTES, UnsupportedMediaError, sniff_source


def _record(path: Path, container_format: str, codec: str, *, rate: int = 16_000) -> bytes:
    """One second of silence in a real container, as FFmpeg writes it."""
    with av.open(str(path), "w", format=container_format) as output:
        stream = output.add_stream(codec, rate=rate)
        stream.layout = "mono"
        if codec == "wmav2":
            stream.bit_rate = 32_000
        samples = rate
        frame = av.AudioFrame(format="s16", layout="mono", samples=samples)
        frame.planes[0].update(bytes(samples * 2))
        frame.sample_rate = rate
        frame.pts = 0
        for packet in stream.encode(frame):
            output.mux(packet)
        for packet in stream.encode(None):
            output.mux(packet)
    return path.read_bytes()


@pytest.mark.parametrize(
    ("file_name", "container_format", "codec", "rate", "media_type"),
    [
        ("memo.wav", "wav", "pcm_s16le", 16_000, "audio/wav"),
        ("memo.mp3", "mp3", "libmp3lame", 16_000, "audio/mpeg"),
        ("memo.aac", "adts", "aac", 16_000, "audio/aac"),
        ("memo.flac", "flac", "flac", 16_000, "audio/flac"),
        ("memo.opus", "ogg", "libopus", 16_000, "audio/ogg"),
        ("memo.m4a", "ipod", "aac", 16_000, "audio/mp4"),
        ("meeting.mov", "mov", "aac", 16_000, "audio/mp4"),
        ("hearing.mkv", "matroska", "pcm_s16le", 16_000, "video/x-matroska"),
        ("call.webm", "webm", "libopus", 48_000, "video/x-matroska"),
        ("dictation.wma", "asf", "wmav2", 22_050, "video/x-ms-asf"),
        ("camera.avi", "avi", "pcm_s16le", 16_000, "video/x-msvideo"),
        ("broadcast.ts", "mpegts", "mp2", 16_000, "video/mp2t"),
        ("studio.aiff", "aiff", "pcm_s16be", 16_000, "audio/aiff"),
    ],
)
def test_recordings_ffmpeg_writes_are_sniffed_as_audio(
    tmp_path: Path,
    file_name: str,
    container_format: str,
    codec: str,
    rate: int,
    media_type: str,
) -> None:
    content = _record(tmp_path / file_name, container_format, codec, rate=rate)

    sniffed = sniff_source(content[:SNIFF_BYTES])

    assert sniffed.kind is CaptureSourceKind.AUDIO
    assert sniffed.media_type == media_type


@pytest.mark.parametrize(
    ("header", "media_type"),
    [
        (b"#!AMR\n" + bytes(16), "audio/amr"),
        (b"caff" + bytes(16), "audio/x-caf"),
        (b"FLV\x01" + bytes(16), "video/x-flv"),
        (b"\x00\x00\x01\xba" + bytes(16), "video/mpeg"),
        (b"\xff\xfb\x90\x00", "audio/mpeg"),
        (b"\xff\xf1\x50\x80", "audio/aac"),
    ],
)
def test_other_recording_signatures_are_audio(header: bytes, media_type: str) -> None:
    assert sniff_source(header).media_type == media_type


def test_documents_keep_their_kinds_and_text_is_rejected() -> None:
    assert sniff_source(b"%PDF-1.7").kind is CaptureSourceKind.PDF
    assert sniff_source(b"\xff\xd8\xff\xe0").kind is CaptureSourceKind.IMAGE
    with pytest.raises(UnsupportedMediaError):
        sniff_source(b"plain text, not a recording")
