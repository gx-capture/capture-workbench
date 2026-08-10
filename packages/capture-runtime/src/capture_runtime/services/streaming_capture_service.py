"""Application service for the authenticated v2 streaming routes."""

from __future__ import annotations

import threading

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureEventV2,
    CaptureOperationV2,
    FinalizeIngestionV2,
    IngestionV2,
    OpenIngestionV2,
    PartialCaptureV2,
    StartCaptureV2,
    StreamingEventType,
)
from capture_runtime.storage import (
    StreamingRepository,
    StreamingTransitionError,
)
from capture_runtime.streaming import MAX_STREAM_CHUNK_BYTES


class StreamingCaptureService:
    def __init__(
        self,
        repository: StreamingRepository,
        *,
        clock: Clock,
        max_chunk_bytes: int = MAX_STREAM_CHUNK_BYTES,
    ) -> None:
        self.repository = repository
        self._clock = clock
        self.max_chunk_bytes = max_chunk_bytes
        self._lock = threading.RLock()

    def open_ingestion(self, request: OpenIngestionV2) -> IngestionV2:
        return self.repository.create_ingestion(request)

    def get_ingestion(self, ingestion_id: str) -> IngestionV2:
        return self.repository.get_ingestion(ingestion_id)

    def append_chunk(
        self,
        ingestion_id: str,
        *,
        chunk_index: int,
        byte_offset: int,
        data: bytes,
        sha256: str,
        declared_total_bytes: int,
    ) -> IngestionV2:
        with self._lock:
            before = self.repository.get_ingestion(ingestion_id)
            snapshot = self.repository.append_chunk(
                ingestion_id,
                chunk_index=chunk_index,
                byte_offset=byte_offset,
                data=data,
                sha256=sha256,
                max_chunk_bytes=self.max_chunk_bytes,
                declared_total_bytes=declared_total_bytes,
            )
            if snapshot.next_chunk_index > before.next_chunk_index:
                for operation in self._captures_for(ingestion_id):
                    if operation.status.value not in {"waiting_input", "extracting"}:
                        continue
                    self.repository.append_event(
                        operation.capture_id,
                        event_type=StreamingEventType.INPUT_CHECKPOINT,
                        stage="extracting",
                    )
            return snapshot

    def finalize_ingestion(
        self,
        ingestion_id: str,
        request: FinalizeIngestionV2,
    ) -> IngestionV2:
        snapshot = self.repository.finalize_ingestion(
            ingestion_id,
            total_bytes=request.total_bytes,
            sha256=request.sha256,
        )
        self.repository.mark_ingestion_ready(ingestion_id)
        return snapshot

    def start_capture(self, request: StartCaptureV2) -> CaptureOperationV2:
        return self.repository.create_capture(request)

    def get_capture(self, capture_id: str) -> CaptureOperationV2:
        return self.repository.get_capture(capture_id)

    def events(self, capture_id: str, *, after_sequence: int) -> list[CaptureEventV2]:
        return self.repository.read_events(capture_id, after_sequence=after_sequence)

    def partial(self, capture_id: str) -> PartialCaptureV2:
        return self.repository.read_partial(capture_id)

    def cancel_capture(self, capture_id: str) -> CaptureOperationV2:
        return self.repository.cancel_capture(capture_id)

    def delete_capture(self, capture_id: str) -> None:
        self.repository.delete_capture(capture_id)

    def delete_ingestion(self, ingestion_id: str) -> None:
        self.repository.delete_ingestion(ingestion_id)

    def _captures_for(self, ingestion_id: str) -> list[CaptureOperationV2]:
        operations: list[CaptureOperationV2] = []
        for capture_id in self.repository.capture_ids_for_ingestion(ingestion_id):
            operations.append(self.repository.get_capture(capture_id))
        return operations


__all__ = ["StreamingCaptureService", "StreamingTransitionError"]
