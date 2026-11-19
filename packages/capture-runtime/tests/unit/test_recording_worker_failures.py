"""Recording worker failures and slow engine checks name their cause (#428)."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

import pytest

from capture_runtime.capture.application.streaming_capture_service import StreamingCaptureService
from capture_runtime.capture.domain.size_policy import DOCUMENT_MAX_UPLOAD_BYTES, SourceSizePolicy
from capture_runtime.capture.infrastructure.capture_extraction import RecordingWorkerFailure
from capture_runtime.capture.infrastructure.source_sniffing import sniff_source
from capture_runtime.capture.infrastructure.streaming_repository import StreamingRepository
from capture_runtime.config import ExtractionRuntimeConfig
from capture_runtime.contracts import OperationFailure, StartCapture, StructuringMode
from capture_runtime.provisioning.infrastructure.engine_installation import (
    EngineResolutionTimeoutError,
    ExtractionRuntimeUnavailableError,
)
from capture_runtime.speech.infrastructure.progressive_capture import ProgressiveCaptureProcessor
from capture_runtime.worker_process import WorkerExecutionError, WorkerFailureDiagnostics
from tests.integration.test_streaming_progressive import FixedClock, _open
from tests.unit.test_speaker_extraction import AUDIO, _extract, _WorkerClient

# A path the worker's own message may carry; it must never reach the log.
_PRIVATE_PATH = r"C:\Users\private-user\models\speech"


def _worker_error(*stages: str) -> WorkerExecutionError:
    return WorkerExecutionError(
        f"worker failed while loading {_PRIVATE_PATH}",
        diagnostics=WorkerFailureDiagnostics(stage_sequence=stages, failure_class="worker"),
    )


def test_a_speech_recognition_worker_failure_names_its_worker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def run(self: Any, *args: Any, **kwargs: Any) -> Any:
        raise _worker_error("speech-model-load-cpu-failed-unknown")

    monkeypatch.setattr(_WorkerClient, "run", run)
    with pytest.raises(RecordingWorkerFailure) as caught:
        _extract(tmp_path, installed={"speech-recognition"}, identify_speakers=False)
    assert caught.value.code == "speech_recognition_worker_failed"
    assert caught.value.diagnostics.stage_sequence == ("speech-model-load-cpu-failed-unknown",)


def test_a_speaker_identification_worker_failure_names_its_worker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def diarize(self: Any, *args: Any, **kwargs: Any) -> Any:
        raise _worker_error("diarization-model-load-start")

    monkeypatch.setattr(_WorkerClient, "diarize", diarize)
    with pytest.raises(RecordingWorkerFailure) as caught:
        _extract(
            tmp_path,
            installed={"speech-recognition", "speaker-diarization"},
            identify_speakers=True,
        )
    assert caught.value.code == "speaker_identification_worker_failed"


def _run_capture(tmp_path: Path, error: BaseException) -> OperationFailure:
    async def scenario() -> OperationFailure:
        clock = FixedClock()
        policy = SourceSizePolicy(DOCUMENT_MAX_UPLOAD_BYTES)
        repository = StreamingRepository(
            tmp_path / "streaming", clock=clock, retention_hours=4, policy=policy
        )
        repository.initialize()
        ingestion_id, _ = _open(repository, source=AUDIO)

        class Extractor:
            sniff = staticmethod(sniff_source)

            async def extract(self, *args: Any, **kwargs: Any) -> Any:
                raise error

        service = StreamingCaptureService(
            repository, clock=clock, policy=policy, extractor=Extractor()
        )
        operation = service.start_capture_use_case.execute(
            StartCapture(
                client_request_id="worker-failure-capture",
                ingestion_id=ingestion_id,
                identify_speakers=True,
                structuring_mode=StructuringMode.HOST,
            )
        )
        await asyncio.gather(service._tasks[operation.capture_id], return_exceptions=True)
        failed = service.get_capture(operation.capture_id)
        await service.shutdown()
        assert failed.status.value == "failed"
        assert failed.error is not None
        return failed.error

    return asyncio.run(scenario())


@pytest.mark.parametrize(
    ("code", "stage"),
    [
        ("speech_recognition_worker_failed", "speech-model-load-cpu-failed-unknown"),
        ("speaker_identification_worker_failed", "diarization-model-load-start"),
    ],
)
def test_a_worker_failure_fails_the_capture_without_retry_and_logs_only_safe_names(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, code: str, stage: str
) -> None:
    worker_error = _worker_error(stage)
    failure = RecordingWorkerFailure(code, worker_error.diagnostics)  # type: ignore[arg-type]
    failure.__cause__ = worker_error
    with caplog.at_level(logging.WARNING):
        error = _run_capture(tmp_path, failure)

    assert (error.code, error.retryable, error.stage) == (code, False, "extraction")
    # The failure object carries no stage record or worker class.
    assert set(error.model_dump()) == {"code", "message", "stage", "retryable"}
    assert stage not in error.message
    assert code in caplog.text
    assert "WorkerExecutionError" in caplog.text
    assert "class=worker" in caplog.text
    assert stage in caplog.text
    assert _PRIVATE_PATH not in caplog.text
    assert "private-user" not in caplog.text


def test_an_unexpected_extraction_error_is_extraction_failed_and_logs_its_class(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    class SyntheticFailure(Exception):
        pass

    with caplog.at_level(logging.WARNING):
        error = _run_capture(tmp_path, SyntheticFailure(_PRIVATE_PATH))

    assert (error.code, error.stage) == ("extraction_failed", "extraction")
    assert "SyntheticFailure" in caplog.text
    assert _PRIVATE_PATH not in caplog.text


def test_silent_buffered_extraction_is_extraction_no_text_without_retry(tmp_path: Path) -> None:
    from capture_runtime.processing_error import CaptureProcessingError

    with pytest.raises(CaptureProcessingError) as caught:
        asyncio.run(_silent_extraction(tmp_path))
    assert (caught.value.code, caught.value.retryable, caught.value.stage) == (
        "extraction_no_text",
        False,
        "extraction",
    )


async def _silent_extraction(tmp_path: Path) -> None:
    from capture_runtime._worker_payloads import WorkerRunResult

    async def run(self: Any, *args: Any, **kwargs: Any) -> WorkerRunResult:
        return WorkerRunResult(
            segments=(),
            engine="speech-recognition",
            model="tea-asr-1.1-mini",
            digest=f"sha256:{'1' * 64}",
            device="cuda",
            warnings=(),
        )

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(_WorkerClient, "run", run)
        await asyncio.to_thread(
            _extract, tmp_path, installed={"speech-recognition"}, identify_speakers=False
        )


def test_progressive_engine_resolution_timeout_reads_like_the_buffered_path(
    tmp_path: Path,
) -> None:
    class SlowEngines:
        async def resolve_active_engine(self, requirement_id: str) -> None:
            raise EngineResolutionTimeoutError(
                f"active engine resolution timed out for requirement {requirement_id}"
            )

    processor = ProgressiveCaptureProcessor(
        clock=FixedClock(),
        config=ExtractionRuntimeConfig(
            temp_dir=tmp_path / "temp",
            max_pdf_pages=10,
            max_image_pixels=100_000,
            ocr_render_scale=2,
            max_audio_duration_ms=60_000,
            speech_prefer_gpu=True,
        ),
        engine_manager=SlowEngines(),  # type: ignore[arg-type]
    )

    async def sink(*_values: Any) -> None:
        return None

    with pytest.raises(ExtractionRuntimeUnavailableError) as caught:
        asyncio.run(
            processor.process(
                capture_id="slow-engine",
                source=None,  # type: ignore[arg-type]
                source_path=tmp_path / "unused.mp3",
                cancellation=asyncio.Event(),
                sink=sink,
            )
        )
    # The buffered path's sentence for the same timeout.
    assert str(caught.value) == (
        "Runtime requirement speech-recognition could not be resolved within the bounded timeout."
    )

    class Processor:
        async def process(self, **_kwargs: Any) -> Any:
            raise caught.value

    async def scenario() -> OperationFailure:
        clock = FixedClock()
        policy = SourceSizePolicy(DOCUMENT_MAX_UPLOAD_BYTES)
        repository = StreamingRepository(
            tmp_path / "streaming", clock=clock, retention_hours=4, policy=policy
        )
        repository.initialize()
        ingestion_id, _ = _open(repository, source=AUDIO)
        service = StreamingCaptureService(
            repository,
            clock=clock,
            policy=policy,
            processor=Processor(),  # type: ignore[arg-type]
        )
        operation = service.start_capture_use_case.execute(
            StartCapture(
                client_request_id="slow-engine-capture",
                ingestion_id=ingestion_id,
                structuring_mode=StructuringMode.HOST,
            )
        )
        await asyncio.gather(service._tasks[operation.capture_id], return_exceptions=True)
        failed = service.get_capture(operation.capture_id)
        await service.shutdown()
        assert failed.error is not None
        return failed.error

    error = asyncio.run(scenario())
    assert (error.code, error.stage, error.retryable) == (
        "requirement_unavailable",
        "extraction",
        True,
    )
