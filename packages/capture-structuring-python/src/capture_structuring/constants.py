"""Token budgets and provider response schemas for the Python SDK."""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy

from .contracts import CaptureBlockBatch, CaptureIdentityBlockBatch

DEFAULT_STRUCTURING_NUM_CTX = 8_192
"""Default Ollama context budget for bounded structuring requests."""

DEFAULT_STRUCTURING_NUM_PREDICT = 4_096
"""Default Ollama generation budget for bounded structuring requests."""

CONTEXT_RESERVE_TOKENS = 512
"""Context tokens reserved for instructions, schema, and provider overhead."""

OUTPUT_RESERVE_TOKENS = 256
"""Output tokens reserved for JSON completion overhead."""

ESTIMATED_BYTES_PER_TOKEN = 3
"""Conservative UTF-8 byte-to-token estimate used by batch planning."""

MIN_REQUEST_TOKENS = 256
"""Smallest adaptive provider request budget."""

IDENTITY_TEXT_PREVIEW_CHARACTERS = 256
"""Maximum source preview sent to the identity classifier."""

CAPTURE_BLOCK_BATCH_SCHEMA: dict[str, object] = CaptureBlockBatch.model_json_schema(by_alias=True)
"""JSON Schema for translated semantic block batches."""

CAPTURE_IDENTITY_BLOCK_BATCH_SCHEMA: dict[str, object] = (
    CaptureIdentityBlockBatch.model_json_schema(by_alias=True)
)
"""JSON Schema for identity-mode semantic block batches."""


def structuring_batch_schema(*, target_language: str | None) -> dict[str, object]:
    """Return the canonical semantic response schema for one host operation.

    Args:
        target_language: Translation language, or ``None`` for identity mode.

    Returns:
        The canonical schema that every host can validate independently.
    """

    return (
        CAPTURE_IDENTITY_BLOCK_BATCH_SCHEMA
        if target_language is None
        else CAPTURE_BLOCK_BATCH_SCHEMA
    )


def _ollama_generation_schema(schema: Mapping[str, object]) -> dict[str, object]:
    """Remove grammar-hostile text maxima while retaining SDK validation.

    Args:
        schema: Source schema to clone and simplify.

    Returns:
        A deep-cloned schema suitable for Ollama grammar generation.
    """

    result = deepcopy(dict(schema))
    pending: list[object] = [result]
    while pending:
        current = pending.pop()
        if isinstance(current, dict):
            current.pop("maxLength", None)
            pending.extend(current.values())
        elif isinstance(current, list):
            pending.extend(current)
    return result


OLLAMA_CAPTURE_BLOCK_BATCH_SCHEMA = _ollama_generation_schema(CAPTURE_BLOCK_BATCH_SCHEMA)
"""Ollama-compatible schema for translated semantic block batches."""

OLLAMA_IDENTITY_BLOCK_BATCH_SCHEMA = _ollama_generation_schema(CAPTURE_IDENTITY_BLOCK_BATCH_SCHEMA)
"""Ollama-compatible schema for identity-mode semantic block batches."""


def ollama_structuring_batch_schema(*, target_language: str | None) -> dict[str, object]:
    """Return the minimal schema suitable for the requested host operation.

    Args:
        target_language: Translation language, or ``None`` for identity mode.

    Returns:
        The grammar-compatible schema for the requested operation.
    """

    return (
        OLLAMA_IDENTITY_BLOCK_BATCH_SCHEMA
        if target_language is None
        else OLLAMA_CAPTURE_BLOCK_BATCH_SCHEMA
    )


__all__ = [
    "CAPTURE_BLOCK_BATCH_SCHEMA",
    "CAPTURE_IDENTITY_BLOCK_BATCH_SCHEMA",
    "DEFAULT_STRUCTURING_NUM_CTX",
    "DEFAULT_STRUCTURING_NUM_PREDICT",
    "OLLAMA_CAPTURE_BLOCK_BATCH_SCHEMA",
    "OLLAMA_IDENTITY_BLOCK_BATCH_SCHEMA",
    "structuring_batch_schema",
    "ollama_structuring_batch_schema",
]
