from __future__ import annotations

from typing import Protocol

from capture_runtime.contracts import (
    CaptureDocument,
    CaptureEventV2,
    CaptureOperationV2,
    IngestionV2,
    OpenIngestionV2,
    RawCapture,
    StartCaptureV2,
    StreamingEventType,
)


class CaptureRepository(Protocol):
    def append_event(
        self, capture_id: str, *, event_type: StreamingEventType, stage: str
    ) -> CaptureEventV2: ...

    def create_ingestion(self, request: OpenIngestionV2) -> IngestionV2: ...
    def get_ingestion(self, ingestion_id: str) -> IngestionV2: ...
    def append_chunk(
        self,
        ingestion_id: str,
        *,
        chunk_index: int,
        byte_offset: int,
        data: bytes,
        sha256: str,
        max_chunk_bytes: int,
        declared_total_bytes: int,
    ) -> IngestionV2: ...
    def finalize_ingestion(
        self,
        ingestion_id: str,
        *,
        total_bytes: int,
        sha256: str,
    ) -> IngestionV2: ...
    def create_capture(self, request: StartCaptureV2) -> CaptureOperationV2: ...
    def get_capture(self, capture_id: str) -> CaptureOperationV2: ...
    def capture_request(self, capture_id: str) -> StartCaptureV2: ...
    def capture_ids_for_ingestion(self, ingestion_id: str) -> list[str]: ...
    def mark_ingestion_ready(self, ingestion_id: str) -> list[CaptureOperationV2]: ...
    def read_events(self, capture_id: str, *, after_sequence: int) -> list[CaptureEventV2]: ...
    def read_raw(self, capture_id: str) -> RawCapture: ...
    def commit_host_result(
        self,
        capture_id: str,
        *,
        idempotency_key: str,
        fingerprint: str,
        result: CaptureDocument,
    ) -> CaptureOperationV2: ...
    def cancel_capture(self, capture_id: str) -> CaptureOperationV2: ...
