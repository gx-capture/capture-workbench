"""Runtime-owned provider protocol and deterministic providers.

Batching, semantic validation, and provenance reconstruction live in the
internal ``capture_runtime.structuring`` package. This module owns the
sidecar's provider lifecycle boundary and test doubles.
"""

from __future__ import annotations

import asyncio
import hashlib
from typing import Protocol

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureBlock,
    CaptureDocument,
    CaptureEngine,
    RawCapture,
)
from capture_runtime.structuring import StructuringValidationError


class CaptureStructuringProvider(Protocol):
    @property
    def engine_identity(self) -> CaptureEngine | None: ...

    async def structure(
        self,
        raw: RawCapture,
        *,
        target_language: str | None,
        cancel_event: asyncio.Event,
    ) -> object: ...


class HostOnlyCaptureStructuringProvider:
    """Fail closed if an internal caller bypasses host-mode capability checks."""

    @property
    def engine_identity(self) -> CaptureEngine | None:
        return None

    async def structure(
        self,
        raw: RawCapture,
        *,
        target_language: str | None,
        cancel_event: asyncio.Event,
    ) -> object:
        del raw, target_language, cancel_event
        raise StructuringValidationError(
            "runtime structuring is disabled; submit a host candidate instead"
        )


class FakeCaptureStructuringProvider:
    """Deterministic strict-provider fake used by CI and verification harnesses."""

    def __init__(
        self,
        clock: Clock,
        *,
        delay_seconds: float = 0,
        mode: str = "valid",
    ) -> None:
        self._clock = clock
        self._delay_seconds = delay_seconds
        self._mode = mode
        digest_source = "fake-structurer:deterministic-structure-v1"
        self._engine_identity = CaptureEngine(
            engine="fake-structurer",
            model="deterministic-structure-v1",
            digest=f"sha256:{hashlib.sha256(digest_source.encode()).hexdigest()}",
            device="fake",
        )

    @property
    def engine_identity(self) -> CaptureEngine:
        return self._engine_identity

    async def structure(
        self,
        raw: RawCapture,
        *,
        target_language: str | None,
        cancel_event: asyncio.Event,
    ) -> object:
        if self._delay_seconds:
            try:
                await asyncio.wait_for(cancel_event.wait(), timeout=self._delay_seconds)
            except TimeoutError:
                pass
        if cancel_event.is_set():
            raise asyncio.CancelledError
        if self._mode == "invalid_json":
            return "{not-json"

        target_prefix = f"[{target_language}] " if target_language else ""
        blocks = [
            CaptureBlock(
                block_id=f"block-{index + 1}",
                order=index,
                type="transcript" if segment.locator.kind == "time" else "paragraph",
                source_segment_id=segment.segment_id,
                locator=segment.locator,
                source_text=segment.text,
                target_text=f"{target_prefix}{segment.text}",
            )
            for index, segment in enumerate(raw.segments)
        ]
        document = CaptureDocument(
            source=raw.source,
            raw_segments=raw.segments,
            blocks=blocks,
            source_text=raw.source_text,
            target_text="\n".join(block.target_text for block in blocks),
            extraction_engine=raw.extraction_engine,
            structuring_engine=self._engine_identity,
            warnings=raw.warnings,
            created_at=raw.created_at,
            completed_at=self._clock.now(),
        )
        payload = document.model_dump(mode="json", by_alias=True)
        if self._mode == "invalid_order":
            payload["blocks"][0]["order"] = 4
        elif self._mode == "invalid_locator":
            payload["blocks"][0]["locator"] = {"kind": "page", "page": 999}
        elif self._mode == "invalid_provenance":
            payload["source"]["sha256"] = "0" * 64
        elif self._mode == "invalid_structuring_digest":
            payload["structuringEngine"]["digest"] = f"sha256:{'0' * 64}"
        return payload


__all__ = [
    "CaptureStructuringProvider",
    "FakeCaptureStructuringProvider",
    "HostOnlyCaptureStructuringProvider",
]
