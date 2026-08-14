"""Shared storage exception taxonomy and persistence helpers for v2 repositories."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4


class RecordNotFoundError(KeyError):
    """A durable runtime record does not exist."""


class IdempotencyConflictError(ValueError):
    """An idempotency key was reused for a different request."""


class TransitionRejectedError(ValueError):
    """A durable state transition is not valid for the current record."""


def _identifier(value: str) -> str:
    try:
        parsed = UUID(value)
    except ValueError as error:
        raise RecordNotFoundError(value) from error
    if str(parsed) != value.lower():
        raise RecordNotFoundError(value)
    return str(parsed)


def _dump_model(model: Any) -> Any:
    return model.model_dump(mode="json", by_alias=True)


def _atomic_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(temporary, path)


__all__ = [
    "IdempotencyConflictError",
    "RecordNotFoundError",
    "TransitionRejectedError",
    "_atomic_json",
    "_dump_model",
    "_identifier",
]
