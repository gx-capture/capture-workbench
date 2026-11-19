from __future__ import annotations

from typing import Protocol

from capture_runtime.contracts import (
    CaptureDocument,
    CaptureEvent,
    CaptureEventType,
    CaptureOperation,
    Ingestion,
    OpenIngestion,
    RawCapture,
    StartCapture,
)


class CaptureRepository(Protocol):
    def append_event(
        self, capture_id: str, *, event_type: CaptureEventType, stage: str
    ) -> CaptureEvent: ...

    def create_ingestion(self, request: OpenIngestion) -> Ingestion: ...
    def get_ingestion(self, ingestion_id: str) -> Ingestion: ...
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
    ) -> Ingestion: ...
    def finalize_ingestion(
        self,
        ingestion_id: str,
        *,
        total_bytes: int,
        sha256: str,
    ) -> Ingestion: ...
    def create_capture(self, request: StartCapture) -> CaptureOperation: ...
    def get_capture(self, capture_id: str) -> CaptureOperation: ...
    def capture_request(self, capture_id: str) -> StartCapture: ...
    def capture_ids_for_ingestion(self, ingestion_id: str) -> list[str]: ...
    def mark_ingestion_ready(self, ingestion_id: str) -> list[CaptureOperation]: ...
    def read_events(self, capture_id: str, *, after_sequence: int) -> list[CaptureEvent]: ...
    def read_raw(self, capture_id: str) -> RawCapture: ...
    def commit_host_result(
        self,
        capture_id: str,
        *,
        idempotency_key: str,
        fingerprint: str,
        result: CaptureDocument,
    ) -> CaptureOperation: ...
    def cancel_capture(self, capture_id: str) -> CaptureOperation: ...
