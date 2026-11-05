"""Domain aggregates and value objects for pull-based structuring sessions."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace

from capture_runtime.contracts import StructuringBatchStatus, StructuringSessionStatus


class SessionTransitionError(ValueError):
    """A batch cannot advance this structuring session."""


@dataclass(frozen=True, slots=True)
class StructuringSemanticBlock:
    """A semantic block contributed to or accepted from a structuring batch."""

    source_segment_id: str
    type: str
    target_text: str | None = None

    def __post_init__(self) -> None:
        if not self.source_segment_id:
            raise ValueError("source_segment_id cannot be empty")
        valid_types = {"heading", "paragraph", "list-item", "table", "quote", "transcript"}
        if self.type not in valid_types:
            raise ValueError(f"type must be one of {valid_types}, got '{self.type}'")

    def dump(self) -> dict[str, object]:
        data: dict[str, object] = {
            "sourceSegmentId": self.source_segment_id,
            "type": self.type,
        }
        if self.target_text is not None:
            data["targetText"] = self.target_text
        return data


@dataclass(frozen=True, slots=True)
class StructuringBatch:
    """A single batch planned within a structuring session."""

    session_id: str
    capture_id: str
    batch_index: int
    batch_count: int
    source_segment_ids: tuple[str, ...]
    provider_prompt: Mapping[str, object] | str
    provider_schema: Mapping[str, object] | str | None = None
    num_ctx: int | None = None
    num_predict: int | None = None
    batch_digest: str = ""
    status: StructuringBatchStatus = StructuringBatchStatus.READY

    def verify_digest(self, digest: str) -> None:
        if digest != self.batch_digest:
            raise StructuringSessionDigestConflictError(digest)

    def accept(self) -> StructuringBatch:
        return replace(self, status=StructuringBatchStatus.ACCEPTED)

    def __post_init__(self) -> None:
        if self.batch_count < 1:
            raise ValueError("batch_count must be >= 1")
        if self.batch_index < 0 or self.batch_index >= self.batch_count:
            raise ValueError(f"batch_index {self.batch_index} out of range [0, {self.batch_count})")
        if not self.source_segment_ids:
            raise ValueError("source_segment_ids cannot be empty")


@dataclass(frozen=True, slots=True)
class StructuringSession:
    """Root aggregate for durable pull-based structuring progress."""

    session_id: str
    capture_id: str
    raw_source_sha256: str
    contract_set_sha256: str
    schema_dialect: str
    batch_count: int
    next_batch_index: int = 0
    session_digest: str = ""
    status: StructuringSessionStatus = StructuringSessionStatus.OPEN
    target_language: str | None = None

    @staticmethod
    def require_next_batch(
        status: StructuringSessionStatus,
        next_batch_index: int,
        batch_index: int,
    ) -> None:
        if status is not StructuringSessionStatus.OPEN:
            raise SessionTransitionError("structuring session is not open")
        if batch_index != next_batch_index:
            raise SessionTransitionError("structuring batches must be submitted in order")

    def accept_batch(self, batch_index: int) -> StructuringSession:
        self.require_next_batch(self.status, self.next_batch_index, batch_index)
        next_index = batch_index + 1
        return replace(
            self,
            next_batch_index=next_index,
            status=(
                StructuringSessionStatus.COMPLETED
                if next_index == self.batch_count
                else StructuringSessionStatus.OPEN
            ),
        )

    def __post_init__(self) -> None:
        if self.batch_count < 1:
            raise ValueError("batch_count must be >= 1")
        if self.next_batch_index < 0 or self.next_batch_index > self.batch_count:
            raise ValueError(
                f"next_batch_index {self.next_batch_index} out of range [0, {self.batch_count}]"
            )
        if not self.session_id:
            raise ValueError("session_id cannot be empty")
        if not self.capture_id:
            raise ValueError("capture_id cannot be empty")


@dataclass(frozen=True, slots=True)
class BatchPlanningPolicy:
    """Domain policy governing structuring batch size limits and partition rules."""

    max_context_tokens: int = 4096
    target_language: str | None = None

    def limits(
        self, max_predict: int, *, context_reserve: int, output_reserve: int
    ) -> tuple[int, int]:
        if max_predict <= output_reserve:
            raise ValueError("Capture structuring output budget is too small")
        if self.max_context_tokens <= max_predict + context_reserve:
            raise ValueError("Capture structuring context budget is too small")
        return self.max_context_tokens - max_predict - context_reserve, max_predict - output_reserve

    @staticmethod
    def fits(input_tokens: int, output_tokens: int, limits: tuple[int, int]) -> bool:
        return input_tokens <= limits[0] and output_tokens <= limits[1]

    def __post_init__(self) -> None:
        if self.max_context_tokens < 1:
            raise ValueError("max_context_tokens must be >= 1")


__all__ = [
    "BatchPlanningPolicy",
    "StructuringBatch",
    "StructuringSemanticBlock",
    "StructuringSession",
]


class StructuringValidationError(ValueError):
    """Raised when structuring output cannot be safely projected."""

    def __init__(self, message: str, *, issues: list[dict[str, object]] | None = None) -> None:
        super().__init__(message)
        self.issues = issues or []


class StructuringSessionDigestConflictError(ValueError):
    """A submission did not match the advertised provider batch digest."""
