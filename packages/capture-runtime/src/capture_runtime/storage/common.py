"""Shared persistence helpers for the runtime-owned installation stores."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4


class RecordNotFoundError(KeyError):
    pass


class IdempotencyConflictError(ValueError):
    pass


class TransitionRejectedError(ValueError):
    pass


def identifier(value: str) -> str:
    try:
        parsed = UUID(value)
    except ValueError as error:
        raise RecordNotFoundError(value) from error
    if str(parsed) != value.lower():
        raise RecordNotFoundError(value)
    return str(parsed)


def dump_model(model: Any) -> Any:
    return model.model_dump(mode="json", by_alias=True)


def atomic_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)
