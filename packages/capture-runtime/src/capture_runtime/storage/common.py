"""Shared storage exception taxonomy and persistence helpers for v2 repositories."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from capture_runtime.constants.requirements import RETIRED_STRUCTURING_REQUIREMENT_IDS


class RecordNotFoundError(KeyError):
    """A durable runtime record does not exist."""


class IdempotencyConflictError(ValueError):
    """An idempotency key was reused for a different request."""


class TransitionRejectedError(ValueError):
    """A durable state transition is not valid for the current record."""


def record_identifier(value: str) -> str:
    try:
        parsed = UUID(value)
    except ValueError as error:
        raise RecordNotFoundError(value) from error
    if str(parsed) != value.lower():
        raise RecordNotFoundError(value)
    return str(parsed)


def dump_model(model: Any) -> Any:
    return model.model_dump(mode="json", by_alias=True)


def project_stored_requirement_id(value: Any) -> Any:
    if isinstance(value, str):
        return {
            "windowsml-ocr": "text-recognition",
            **RETIRED_STRUCTURING_REQUIREMENT_IDS,
        }.get(value, value)
    return value


def project_stored_capture_kind(payload: Any) -> Any:
    if isinstance(payload, dict) and payload.get("kind") == "audio":
        return {**payload, "kind": "recording"}
    return payload


def project_stored_capture(payload: Any) -> Any:
    """Project renamed fields in a decoded runtime capture, leaving digests and text intact."""
    if not isinstance(payload, dict):
        return payload
    projected = payload.copy()
    for key in ("extractionEngine", "provenance"):
        identity = payload.get(key)
        if isinstance(identity, dict) and identity.get("engine") == "windowsml-ocr":
            identity = {**identity, "engine": "text-recognition"}
            if identity.get("model") == "pp-ocrv6-medium-windowsml":
                identity["model"] = "pp-ocrv6-medium"
            elif identity.get("model") == "deterministic-windowsml-v1":
                identity["model"] = "deterministic-ocr-v1"
            if identity.get("device") == "windowsml-dml":
                identity["device"] = "directml"
            projected[key] = identity
    if "suggestedUnits" in projected:
        historical = projected.pop("suggestedUnits")
        projected.setdefault("suggestedRequirementIds", historical)
    suggested = projected.get("suggestedRequirementIds")
    if isinstance(suggested, list):
        projected["suggestedRequirementIds"] = [
            project_stored_requirement_id(value) for value in suggested
        ]
    pages = payload.get("pages")
    if isinstance(pages, list):
        projected["pages"] = [project_stored_capture(page) for page in pages]
    return projected


def atomic_json(path: Path, payload: object) -> None:
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
    "atomic_json",
    "dump_model",
    "project_stored_capture",
    "project_stored_capture_kind",
    "project_stored_requirement_id",
    "record_identifier",
]
