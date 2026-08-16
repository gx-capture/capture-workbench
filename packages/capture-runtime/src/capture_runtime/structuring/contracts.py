"""Internal semantic models for runtime-owned capture structuring."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel

from capture_runtime.contracts import CaptureText

NonEmptyString = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
"""String value that must contain at least one non-whitespace character."""

type WireObject = dict[str, object]
"""JSON-compatible object used at the internal structuring boundary."""

type WireInput = Mapping[str, object] | object
"""Mapping or Pydantic-like object accepted at the wire boundary."""

type StructuringSchema = Mapping[str, object]
"""JSON Schema object supplied to an LLM generation provider."""

type StructuringCandidate = bytes | bytearray | str
"""JSON candidate representation accepted from a provider callback."""

type LlmGenerate = Callable[
    [Mapping[str, object], StructuringSchema],
    StructuringCandidate | Awaitable[StructuringCandidate],
]
"""Provider callback that turns one prompt/schema pair into JSON output."""


class StructuringValidationError(ValueError):
    """Raised when structuring output cannot be safely projected."""

    def __init__(self, message: str, *, issues: list[dict[str, object]] | None = None) -> None:
        super().__init__(message)
        self.issues = issues or []


class _SemanticModel(BaseModel):
    """Base model enforcing camelCase fields and forbidden extras."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        extra="forbid",
        populate_by_name=True,
        str_strip_whitespace=True,
    )


class CaptureSemanticBlock(_SemanticModel):
    """Translated semantic fields accepted from one provider response."""

    source_segment_id: NonEmptyString
    type: Literal["heading", "paragraph", "list-item", "table", "quote", "transcript"]
    target_text: CaptureText | None = None


class CaptureIdentitySemanticBlock(_SemanticModel):
    """Identity-mode semantic fields, without target-text echoes."""

    source_segment_id: NonEmptyString
    type: Literal["heading", "paragraph", "list-item", "table", "quote", "transcript"]


class CaptureBlockBatch(_SemanticModel):
    """Translated semantic blocks returned for one bounded request."""

    blocks: list[CaptureSemanticBlock] = Field(min_length=1)


class CaptureIdentityBlockBatch(_SemanticModel):
    """Identity semantic blocks returned for one bounded request."""

    blocks: list[CaptureIdentitySemanticBlock] = Field(min_length=1)


class _ValidatedSemanticBlock:
    """Structural view shared by translated and identity semantic models."""

    source_segment_id: str
    type: Literal["heading", "paragraph", "list-item", "table", "quote", "transcript"]


@dataclass(frozen=True, slots=True)
class StructuringBatchPlan:
    """Token-budget accounting for one provider request."""

    segments: tuple[object, ...]
    input_tokens: int
    output_tokens: int


__all__ = [
    "CaptureBlockBatch",
    "CaptureIdentityBlockBatch",
    "CaptureIdentitySemanticBlock",
    "CaptureSemanticBlock",
    "CaptureText",
    "LlmGenerate",
    "NonEmptyString",
    "StructuringBatchPlan",
    "StructuringCandidate",
    "StructuringSchema",
    "StructuringValidationError",
    "WireInput",
    "WireObject",
]
