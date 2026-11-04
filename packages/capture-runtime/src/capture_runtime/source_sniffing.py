"""The kind and media type of a capture source, read from its first bytes."""

from __future__ import annotations

from dataclasses import dataclass

from capture_runtime.contracts import CaptureSourceKind


class UnsupportedMediaError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class SniffedSource:
    kind: CaptureSourceKind
    media_type: str


SNIFF_BYTES = 200
"""How much of a source's start `sniff_source` needs (MPEG-TS repeats its sync byte at 188)."""

_MP4_BOX_TYPES = frozenset({b"ftyp", b"moov", b"mdat", b"wide", b"free", b"skip", b"pnot"})


def sniff_source(content: bytes) -> SniffedSource:
    """The kind of a source and its media type, from the signature of its first bytes.

    Audio is whatever FFmpeg decodes: recordings arrive as phone memos (M4A,
    3GP, AMR), dictaphone files (WMA, MP3), and meetings or hearings recorded
    as video (MP4, MOV, MKV, WebM, AVI, MPEG-TS), whose audio track is
    transcribed.
    """
    if content.startswith(b"%PDF-"):
        return SniffedSource(CaptureSourceKind.PDF, "application/pdf")
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return SniffedSource(CaptureSourceKind.IMAGE, "image/png")
    if content.startswith(b"\xff\xd8\xff"):
        return SniffedSource(CaptureSourceKind.IMAGE, "image/jpeg")
    if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return SniffedSource(CaptureSourceKind.IMAGE, "image/webp")
    media_type = _audio_media_type(content)
    if media_type is not None:
        return SniffedSource(CaptureSourceKind.AUDIO, media_type)
    raise UnsupportedMediaError(
        "Only PDF, PNG, JPEG, WebP, and audio or video recordings are supported"
    )


def _audio_media_type(content: bytes) -> str | None:
    if len(content) >= 12 and content[:4] == b"RIFF":
        return {b"WAVE": "audio/wav", b"AVI ": "video/x-msvideo"}.get(content[8:12])
    if content.startswith(b"ID3"):
        return "audio/mpeg"
    if len(content) >= 2 and content[0] == 0xFF and content[1] & 0xE0 == 0xE0:
        # Both open with an 11-bit sync word; ADTS marks its layer bits zero.
        return "audio/aac" if content[1] & 0x06 == 0 else "audio/mpeg"
    if content.startswith(b"fLaC"):
        return "audio/flac"
    if content.startswith(b"OggS"):
        return "audio/ogg"
    if len(content) >= 12 and content[4:8] == b"ftyp":
        return "audio/mp4"
    if len(content) >= 8 and content[4:8] in _MP4_BOX_TYPES:
        return "video/quicktime"
    if content.startswith(b"\x1a\x45\xdf\xa3"):
        return "video/x-matroska"
    if content.startswith(b"\x30\x26\xb2\x75\x8e\x66\xcf\x11"):
        return "video/x-ms-asf"
    if content.startswith(b"#!AMR"):
        return "audio/amr"
    if len(content) >= 12 and content[:4] == b"FORM" and content[8:12] in {b"AIFF", b"AIFC"}:
        return "audio/aiff"
    if content.startswith(b"caff"):
        return "audio/x-caf"
    if content.startswith(b"FLV"):
        return "video/x-flv"
    if content.startswith(b"\x00\x00\x01\xba"):
        return "video/mpeg"
    if len(content) > 188 and content[0] == 0x47 and content[188] == 0x47:
        return "video/mp2t"
    return None


__all__ = [
    "SNIFF_BYTES",
    "SniffedSource",
    "UnsupportedMediaError",
    "sniff_source",
]
