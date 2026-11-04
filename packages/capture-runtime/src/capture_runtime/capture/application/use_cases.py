"""Application use cases for capture and ingestion workflows."""

from __future__ import annotations

from typing import TYPE_CHECKING

from capture_runtime.contracts import (
    CaptureDocument,
    CaptureEventV2,
    CaptureOperationV2,
    FinalizeIngestionV2,
    IngestionV2,
    OpenIngestionV2,
    StartCaptureV2,
)

if TYPE_CHECKING:
    from capture_runtime.capture.application.streaming_capture_service import (
        StreamingCaptureService,
    )


class OpenIngestion:
    """Open a chunked or direct file ingestion session."""

    def __init__(self, service: StreamingCaptureService) -> None:
        self._service = service

    def execute(self, request: OpenIngestionV2) -> IngestionV2:
        return self._service.open_ingestion(request)


class AppendChunk:
    """Append a verified binary chunk to an open ingestion session."""

    def __init__(self, service: StreamingCaptureService) -> None:
        self._service = service

    def execute(
        self,
        ingestion_id: str,
        *,
        chunk_index: int,
        byte_offset: int,
        data: bytes,
        sha256: str,
        declared_total_bytes: int,
    ) -> IngestionV2:
        return self._service.append_chunk(
            ingestion_id,
            chunk_index=chunk_index,
            byte_offset=byte_offset,
            data=data,
            sha256=sha256,
            declared_total_bytes=declared_total_bytes,
        )


class FinalizeIngestion:
    """Finalize an ingestion session after all chunks have been appended."""

    def __init__(self, service: StreamingCaptureService) -> None:
        self._service = service

    def execute(
        self,
        ingestion_id: str,
        request: FinalizeIngestionV2,
    ) -> IngestionV2:
        return self._service.finalize_ingestion(ingestion_id, request)


class StartCapture:
    """Create and start a media extraction pipeline from an ingestion."""

    def __init__(self, service: StreamingCaptureService) -> None:
        self._service = service

    def execute(self, request: StartCaptureV2) -> CaptureOperationV2:
        return self._service.start_capture(request)


class CancelCapture:
    """Cancel an active or running capture operation."""

    def __init__(self, service: StreamingCaptureService) -> None:
        self._service = service

    def execute(self, capture_id: str) -> CaptureOperationV2:
        return self._service.cancel_capture(capture_id)


class PollCaptureEvents:
    """Poll sequence events for a capture operation."""

    def __init__(self, service: StreamingCaptureService) -> None:
        self._service = service

    def execute(self, capture_id: str, *, after_sequence: int = -1) -> list[CaptureEventV2]:
        return self._service.events(capture_id, after_sequence=after_sequence)


class CommitHostStructuring:
    """Commit host-structured document to complete the capture operation."""

    def __init__(self, service: StreamingCaptureService) -> None:
        self._service = service

    def execute(
        self,
        capture_id: str,
        document: CaptureDocument,
        *,
        idempotency_key: str,
    ) -> CaptureOperationV2:
        return self._service.commit_host_result(
            capture_id,
            document,
            idempotency_key=idempotency_key,
        )


__all__ = [
    "AppendChunk",
    "CancelCapture",
    "CommitHostStructuring",
    "FinalizeIngestion",
    "OpenIngestion",
    "PollCaptureEvents",
    "StartCapture",
]
