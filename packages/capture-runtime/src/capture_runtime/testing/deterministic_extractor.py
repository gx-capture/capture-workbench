"""A content-sniffed capture extractor with fixed output, for CI and the desktop e2e."""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Callable

from capture_runtime._pdf_source import PdfPageSelectionError
from capture_runtime.capture.infrastructure.capture_extraction import CaptureExtractionOutcome
from capture_runtime.capture.infrastructure.pdf_page_selection import is_pdf_page_selection
from capture_runtime.capture.infrastructure.source_sniffing import SniffedSource, sniff_source
from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureEngine,
    CaptureSource,
    CaptureSourceKind,
    OcrPageScopeV2,
    PageLocator,
    RawCapture,
    RawCaptureSegment,
    TimeLocator,
    project_source_text,
)


def _engine_digest(engine: str, model: str) -> str:
    value = hashlib.sha256(f"{engine}:{model}".encode()).hexdigest()
    return f"sha256:{value}"


class DeterministicCaptureExtractor:
    """Content-sniffed fake for CI and the independently testable harness."""

    def __init__(self, clock: Clock, *, delay_seconds: float = 0) -> None:
        self._clock = clock
        self._delay_seconds = delay_seconds

    def sniff(self, content: bytes) -> SniffedSource:
        return sniff_source(content)

    async def extract(
        self,
        content: bytes,
        source: CaptureSource,
        cancel_event: asyncio.Event,
        *,
        pdf_page_numbers: tuple[int, ...] | None = None,
        ocr_progress: Callable[[int, int], None] | None = None,
        identify_speakers: bool = False,
        speaker_progress: Callable[[str, int], None] | None = None,
        spoken_language: str | None = None,
    ) -> CaptureExtractionOutcome:
        sniffed = self.sniff(content)
        if self._delay_seconds:
            try:
                await asyncio.wait_for(cancel_event.wait(), timeout=self._delay_seconds)
            except TimeoutError:
                pass
        if cancel_event.is_set():
            raise asyncio.CancelledError

        text = self._fixture_text(content, sniffed.kind, source.sha256)
        scope: OcrPageScopeV2 | None = None
        if sniffed.kind is CaptureSourceKind.AUDIO:
            parts = [part.strip() for part in text.split("|") if part.strip()]
            segments = [
                RawCaptureSegment(
                    segment_id=f"segment-{index + 1}",
                    order=index,
                    locator=TimeLocator(
                        start_ms=index * 1000,
                        end_ms=(index + 1) * 1000,
                    ),
                    text=part,
                )
                for index, part in enumerate(parts)
            ]
            engine = CaptureEngine(
                engine="speech-recognition",
                model="deterministic-whisper-v1",
                digest=_engine_digest("speech-recognition", "deterministic-whisper-v1"),
                device="fake",
            )
        else:
            source_pages = [part.strip() for part in text.split("\f")]
            page_numbers = tuple(range(1, len(source_pages) + 1))
            if pdf_page_numbers is not None:
                if not is_pdf_page_selection(pdf_page_numbers):
                    raise PdfPageSelectionError(
                        "PDF page selection must list source pages in ascending order "
                        "without duplicates."
                    )
                if pdf_page_numbers[-1] > len(source_pages):
                    raise PdfPageSelectionError(
                        f"PDF page selection includes page {pdf_page_numbers[-1]}, "
                        f"but the PDF has {len(source_pages)} pages."
                    )
                page_numbers = tuple(pdf_page_numbers)
            # Each page keeps its source page number, selected or not.
            page_texts = [
                (page_number, source_pages[page_number - 1])
                for page_number in page_numbers
                if source_pages[page_number - 1]
            ]
            segments = [
                RawCaptureSegment(
                    segment_id=f"segment-{index + 1}",
                    order=index,
                    locator=PageLocator(page=page_number),
                    text=part,
                )
                for index, (page_number, part) in enumerate(page_texts)
            ]
            engine = CaptureEngine(
                engine="windowsml-ocr",
                model="deterministic-windowsml-v1",
                digest=_engine_digest("windowsml-ocr", "deterministic-windowsml-v1"),
                device="fake",
            )
            scope = (
                OcrPageScopeV2(
                    source_page_count=len(text.split("\f")),
                    requested_page_numbers=list(pdf_page_numbers),
                    processed_page_numbers=list(pdf_page_numbers),
                )
                if sniffed.kind is CaptureSourceKind.PDF and pdf_page_numbers is not None
                else None
            )
        if not segments:
            raise ValueError("extraction produced no non-empty content")
        return CaptureExtractionOutcome(
            raw=RawCapture(
                source=source,
                segments=segments,
                source_text=project_source_text(segments),
                extraction_engine=engine,
                warnings=[],
                ocr_page_scope=scope,
                created_at=self._clock.now(),
            )
        )

    @staticmethod
    def _fixture_text(content: bytes, kind: CaptureSourceKind, sha256: str) -> str:
        marker = b"CAPTURE_TEXT:"
        marker_index = content.find(marker)
        if marker_index >= 0:
            candidate = content[marker_index + len(marker) :].decode("utf-8", errors="ignore")
            candidate = candidate.strip("\x00\r\n ")
            if candidate:
                return candidate
        return f"Deterministic {kind.value} capture {sha256[:12]}"


__all__ = ["DeterministicCaptureExtractor"]
