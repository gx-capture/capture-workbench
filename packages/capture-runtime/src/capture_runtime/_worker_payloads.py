"""Wire values every engine worker shares: probe results and the run envelope.

OCR pages, speech words, and diarization turns are decoded in their own
contexts. What stays here is the protocol framing those decoders share.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from capture_runtime.constants import VERTICAL_READER_REQUIREMENT_ID
from capture_runtime.contracts import OcrProvenanceV3

SHA256_PROVENANCE = re.compile(r"^sha256:[a-f0-9]{64}$")
SUGGESTABLE_UNITS = frozenset({VERTICAL_READER_REQUIREMENT_ID})


class WorkerResultError(ValueError):
    """Raised when a worker result does not match the internal contract."""


@dataclass(frozen=True, slots=True)
class WorkerProbeResult:
    ready: bool
    code_ready: bool
    assets_ready: bool
    detail: str
    device: str | None


@dataclass(frozen=True, slots=True)
class WorkerWord:
    start_ms: int
    end_ms: int
    text: str


@dataclass(frozen=True, slots=True)
class WorkerSegment:
    order: int
    text: str
    page: int | None = None
    start_ms: int | None = None
    end_ms: int | None = None
    words: tuple[WorkerWord, ...] = ()


@dataclass(frozen=True, slots=True)
class WorkerRunResult:
    """Run envelope every engine shares. OCR pages and proof live on the OCR result."""

    segments: tuple[WorkerSegment, ...]
    engine: str
    model: str
    digest: str
    device: str
    warnings: tuple[str, ...]
    ocr_provenance: OcrProvenanceV3 | None = None
    # Optional units that are not installed and would have read part of the source.
    suggested_units: tuple[str, ...] = ()
    elapsed_ms: int | None = None
    stage_ms: dict[str, int] | None = None


def bounded_string(value: object, label: str, *, maximum: int = 500) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise WorkerResultError(f"{label} must be a non-empty bounded string")
    return value


def milliseconds(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise WorkerResultError("worker time must be a non-negative integer")
    return value


def parse_engine_timings(provenance: dict[str, Any]) -> tuple[int | None, dict[str, int] | None]:
    elapsed = provenance.get("elapsedMs")
    stages = provenance.get("stageMs")
    if stages is not None and (
        not isinstance(stages, dict)
        or any(not isinstance(name, str) or not name.strip() for name in stages)
    ):
        raise WorkerResultError("worker stage times must use non-empty names")
    return (
        None if elapsed is None else milliseconds(elapsed),
        None if stages is None else {name: milliseconds(value) for name, value in stages.items()},
    )


def parse_words(value: object, *, time_locator: bool) -> tuple[WorkerWord, ...]:
    if value is None:
        return ()
    if not time_locator or not isinstance(value, list) or len(value) > 100_000:
        raise WorkerResultError("worker segment words are invalid")
    words: list[WorkerWord] = []
    for raw_word in value:
        if not isinstance(raw_word, dict) or set(raw_word) != {"startMs", "endMs", "text"}:
            raise WorkerResultError("worker segment word has unexpected fields")
        start_ms = milliseconds(raw_word["startMs"])
        end_ms = milliseconds(raw_word["endMs"])
        text = raw_word["text"]
        if end_ms < start_ms or not isinstance(text, str) or not text or len(text) > 500:
            raise WorkerResultError("worker segment word is invalid")
        words.append(WorkerWord(start_ms, end_ms, text))
    return tuple(words)


def parse_suggested_units(value: object) -> tuple[str, ...]:
    """Optional units the worker says would have improved this result."""

    if value is None:
        return ()
    if (
        not isinstance(value, list)
        or not value
        or len(set(value)) != len(value)
        or any(item not in SUGGESTABLE_UNITS for item in value)
    ):
        raise WorkerResultError("worker suggested units are invalid")
    return tuple(value)


def permille_handler(
    progress: Callable[[int], None] | None,
) -> Callable[[dict[str, object]], None] | None:
    """Pass on well-formed 0-1000 progress frames; a malformed one is ignored."""

    if progress is None:
        return None

    def handle(frame: dict[str, object]) -> None:
        value = frame.get("permille")
        if (
            set(frame) == {"permille"}
            and isinstance(value, int)
            and not isinstance(value, bool)
            and 0 <= value <= 1000
        ):
            progress(value)

    return handle


def parse_probe_result(payload: dict[str, Any]) -> WorkerProbeResult:
    if set(payload) != {"ready", "codeReady", "assetsReady", "detail", "device"}:
        raise WorkerResultError("worker probe result has unexpected fields")
    if not all(isinstance(payload[name], bool) for name in ("ready", "codeReady", "assetsReady")):
        raise WorkerResultError("worker probe readiness fields must be boolean")
    device = payload["device"]
    if device is not None and not isinstance(device, str):
        raise WorkerResultError("worker probe device must be a string or null")
    return WorkerProbeResult(
        ready=payload["ready"],
        code_ready=payload["codeReady"],
        assets_ready=payload["assetsReady"],
        detail=bounded_string(payload["detail"], "worker probe detail"),
        device=device,
    )
