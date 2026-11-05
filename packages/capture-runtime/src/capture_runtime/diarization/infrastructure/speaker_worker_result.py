"""Speaker-diarization worker results: turns and the run that returns them.

The worker kernel carries the process. This module checks the diarization
frame before the runtime uses the turns.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

from capture_runtime._worker_payloads import (
    SHA256_PROVENANCE,
    WorkerResultError,
)
from capture_runtime._worker_payloads import (
    bounded_string as _string,
)
from capture_runtime._worker_payloads import (
    milliseconds as _milliseconds,
)
from capture_runtime._worker_payloads import (
    parse_engine_timings as _parse_engine_timings,
)
from capture_runtime._worker_payloads import (
    permille_handler as _permille_handler,
)
from capture_runtime.diarization.domain.turn.models import DiarizationResult
from capture_runtime.diarization.infrastructure.speaker_turns import SPEAKER_LABEL, SpeakerTurn
from capture_runtime.worker_client import InstalledEngine
from capture_runtime.worker_process import DEFAULT_RUN_TIMEOUT_SECONDS, WorkerProcess


class _ProcessClient(Protocol):
    process: WorkerProcess


WorkerDiarizationResult = DiarizationResult


def _parse_turns(value: object, duration_ms: int) -> tuple[SpeakerTurn, ...]:
    if not isinstance(value, list) or len(value) > 100_000:
        raise WorkerResultError("diarization turns must be a bounded list")
    turns: list[SpeakerTurn] = []
    for raw_turn in value:
        if not isinstance(raw_turn, dict) or set(raw_turn) != {"startMs", "endMs", "speaker"}:
            raise WorkerResultError("diarization turn has unexpected fields")
        start_ms = _milliseconds(raw_turn["startMs"])
        end_ms = _milliseconds(raw_turn["endMs"])
        speaker = raw_turn["speaker"]
        if (
            not start_ms < end_ms <= duration_ms
            or not isinstance(speaker, str)
            or SPEAKER_LABEL.fullmatch(speaker) is None
        ):
            raise WorkerResultError("diarization turn is invalid")
        turns.append(SpeakerTurn(start_ms, end_ms, speaker))
    return tuple(turns)


def parse_diarization_result(payload: dict[str, Any]) -> WorkerDiarizationResult:
    """Validate a speaker diarization worker result before the runtime uses it."""

    if set(payload) != {"turns", "exclusiveTurns", "durationMs", "provenance", "warnings"}:
        raise WorkerResultError("diarization result has unexpected fields")
    duration_ms = _milliseconds(payload["durationMs"])
    exclusive_turns = _parse_turns(payload["exclusiveTurns"], duration_ms)
    if any(
        right.start_ms < left.end_ms
        for left, right in zip(exclusive_turns, exclusive_turns[1:], strict=False)
    ):
        raise WorkerResultError("exclusive diarization turns must not overlap")
    provenance = payload["provenance"]
    if not isinstance(provenance, dict) or set(provenance) - {"elapsedMs", "stageMs"} != {
        "engine",
        "model",
        "digest",
        "device",
    }:
        raise WorkerResultError("worker provenance has unexpected fields")
    elapsed_ms, stage_ms = _parse_engine_timings(provenance)
    digest = provenance["digest"]
    if not isinstance(digest, str) or SHA256_PROVENANCE.fullmatch(digest) is None:
        raise WorkerResultError("worker provenance digest is invalid")
    if provenance["engine"] != "speaker-diarization" or provenance["device"] not in {
        "cpu",
        "cuda",
    }:
        raise WorkerResultError("diarization provenance is invalid")
    warnings = payload["warnings"]
    if not isinstance(warnings, list) or len(warnings) > 100:
        raise WorkerResultError("worker warnings must be a bounded list")
    return WorkerDiarizationResult(
        turns=_parse_turns(payload["turns"], duration_ms),
        exclusive_turns=exclusive_turns,
        duration_ms=duration_ms,
        engine=provenance["engine"],
        model=_string(provenance["model"], "worker provenance model"),
        digest=digest,
        device=provenance["device"],
        warnings=tuple(_string(item, "worker warning") for item in warnings),
        elapsed_ms=elapsed_ms,
        stage_ms=stage_ms,
    )


class SpeakerWorkerMethods:
    async def diarize(
        self: _ProcessClient,
        engine: InstalledEngine,
        *,
        source_path: Path,
        media_type: str,
        options: dict[str, object],
        cancel_event: asyncio.Event,
        timeout_seconds: float = DEFAULT_RUN_TIMEOUT_SECONDS,
        on_permille: Callable[[int], None] | None = None,
    ) -> WorkerDiarizationResult:
        if not source_path.is_file() or not source_path.is_absolute():
            raise ValueError("worker source path must be an existing absolute file")
        response = await self.process.request(
            engine.executable,
            "run",
            {
                "requirementId": engine.requirement_id,
                "artifactVersion": engine.artifact_version,
                "modelPath": str(engine.model_dir),
                "sourcePath": str(source_path),
                "mediaType": media_type,
                "options": options,
            },
            cancel_event=cancel_event,
            progress_handler=_permille_handler(on_permille),
            timeout_seconds=timeout_seconds,
        )
        assert response.result is not None
        return parse_diarization_result(response.result)
