from __future__ import annotations

import asyncio
import hashlib
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

from capture_runtime.clock import Clock
from capture_runtime.config import ExtractionRuntimeConfig
from capture_runtime.contracts import (
    CaptureFailureV2,
    CaptureSourceKind,
    OpenIngestionV2,
    StartCaptureV2,
    StreamingCaptureStatus,
    StructuringMode,
)
from capture_runtime.extractors import (
    CaptureExtractionOutcome,
    OcrExtractionFailure,
    SniffedSource,
    StandaloneRuntimeCaptureExtractor,
)
from capture_runtime.ocr_execution_proof import AcceptanceOcrExecutionEvidenceSink
from capture_runtime.ocr_projection import OcrPipeline
from capture_runtime.services import StreamingCaptureService
from capture_runtime.storage import StreamingRepository
from capture_runtime.worker_client import InstalledEngine, OcrWorkerFailure, WorkerClient
from capture_runtime.worker_process import WorkerFailureDiagnostics, WorkerProcess


def _loaded_runtime_sha256() -> str:
    return hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest()


class FixedClock(Clock):
    def now(self) -> datetime:
        return datetime(2026, 8, 29, 12, 0, tzinfo=UTC)


def test_streaming_ocr_failure_records_private_artifact_before_public_projection(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        clock = FixedClock()
        repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
        repository.initialize()
        content = b"%PDF-1.7 failure evidence fixture"
        digest = hashlib.sha256(content).hexdigest()
        ingestion = repository.create_ingestion(
            OpenIngestionV2(
                kind=CaptureSourceKind.PDF,
                client_request_id="failure-evidence-ingestion",
                file_name="source.pdf",
                media_type="application/pdf",
                total_bytes=len(content),
                source_sha256=digest,
            )
        )
        repository.append_chunk(
            ingestion.ingestion_id,
            chunk_index=0,
            byte_offset=0,
            data=content,
            sha256=digest,
            max_chunk_bytes=4 * 1024 * 1024,
            declared_total_bytes=len(content),
        )
        repository.finalize_ingestion(
            ingestion.ingestion_id,
            total_bytes=len(content),
            sha256=digest,
        )
        root = tmp_path / "acceptance"
        root.mkdir()

        class FailingExtractor:
            def sniff(self, _content: bytes) -> SniffedSource:
                return SniffedSource(CaptureSourceKind.PDF, "application/pdf")

            async def extract(
                self,
                _content: bytes,
                source,
                _cancel_event: asyncio.Event,
                *,
                pdf_page_numbers: tuple[int, ...] | None = None,
            ) -> CaptureExtractionOutcome:
                del pdf_page_numbers
                public_failure = CaptureFailureV2(
                    code="ocr_worker_failed",
                    message="OCR worker failed before completing all pages.",
                    stage="extraction",
                    retryable=True,
                )
                projection = OcrPipeline().failed(
                    capture_id=source.sha256,
                    source=source,
                    failure=public_failure,
                    created_at=clock.now(),
                )
                worker_failure = OcrWorkerFailure(
                    kind="worker",
                    progress=None,
                    diagnostics=WorkerFailureDiagnostics(
                        stage_sequence=(
                            "ocr-pipeline-create-start",
                            "ocr-pipeline-create-failed-runtimeerror",
                        ),
                        failure_class="exit-nonzero",
                        exit_code=7,
                    ),
                    worker_sha256="b" * 64,
                )
                try:
                    raise worker_failure
                except OcrWorkerFailure as cause:
                    raise OcrExtractionFailure(
                        failure=public_failure,
                        projection=projection,
                    ) from cause

        service = StreamingCaptureService(
            repository,
            clock=clock,
            extractor=FailingExtractor(),  # type: ignore[arg-type]
            execution_evidence_sink=AcceptanceOcrExecutionEvidenceSink(
                root,
                preauthorized_root=root,
                runtime_sha256="c" * 64,
            ),
        )
        operation = service.start_capture(
            StartCaptureV2(
                client_request_id="failure-evidence-capture",
                ingestion_id=ingestion.ingestion_id,
                structuring_mode=StructuringMode.HOST,
            )
        )
        for _ in range(100):
            if service.get_capture(operation.capture_id).status is StreamingCaptureStatus.FAILED:
                break
            await asyncio.sleep(0.01)

        failed = service.get_capture(operation.capture_id)
        assert failed.status is StreamingCaptureStatus.FAILED
        public_projection = repository.read_ocr_projection(operation.capture_id)
        assert public_projection.failure is not None
        assert public_projection.failure.code == "ocr_worker_failed"
        assert "diagnostics" not in public_projection.model_dump(mode="json", by_alias=True)

        artifact = json.loads((root / "ocr-execution-failure-v1.json").read_text(encoding="utf-8"))
        assert artifact["sourceSha256"] == digest
        assert artifact["runtimeSha256"] == "c" * 64
        assert artifact["workerSha256"] == "b" * 64
        assert artifact["failureClass"] == "exit-nonzero"
        assert artifact["stageSequence"] == [
            "ocr-pipeline-create-start",
            "ocr-pipeline-create-failed-runtimeerror",
        ]
        await service.shutdown()

    asyncio.run(scenario())


def test_real_worker_process_client_extractor_service_failure_chain_records_evidence(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        clock = FixedClock()
        fixture_path = Path(__file__).resolve().parents[4] / "test-fixtures" / "ocr_test_image.jpeg"
        content = fixture_path.read_bytes()
        assert len(content) == 45494
        assert hashlib.sha256(content).hexdigest() == (
            "9b1a9a87bae10ecd07b4b7874d5f8e46fbd8b798cc0becb20825636637da99b1"
        )
        digest = hashlib.sha256(content).hexdigest()
        worker = tmp_path / "failing-ocr-worker.py"
        worker.write_text(
            """
import os
import sys

sys.stdin.buffer.readline()
sys.stderr.write("C:\\\\Users\\\\private-user\\\\source.jpg SECRET_STDERR\\n")
sys.stderr.write("capture-worker-stage:ocr-pipeline-create-start\\n")
sys.stderr.write("capture-worker-stage:ocr-predict-failed-runtimeerror\\n")
sys.stderr.flush()
os._exit(7)
""".lstrip(),
            encoding="utf-8",
        )

        class InstalledFailureCatalog:
            def __init__(self) -> None:
                self.worker_client = WorkerClient(process=WorkerProcess())

            async def resolve_active_engine(self, requirement_id: str) -> InstalledEngine:
                assert requirement_id == "windowsml-ocr"
                return InstalledEngine(
                    requirement_id=requirement_id,
                    artifact_version="test-worker",
                    executable=worker,
                    model_dir=tmp_path,
                    worker_sha256=hashlib.sha256(worker.read_bytes()).hexdigest(),
                )

            async def ocr_compute_selection(self, *, contract_sha256: str) -> object:
                del contract_sha256
                return SimpleNamespace(
                    execution_plan=SimpleNamespace(
                        to_dict=lambda: {"mode": "cpu-fallback"},
                    ),
                )

        repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
        repository.initialize()
        ingestion = repository.create_ingestion(
            OpenIngestionV2(
                kind=CaptureSourceKind.IMAGE,
                client_request_id="real-worker-failure-ingestion",
                file_name="source.jpg",
                media_type="image/jpeg",
                total_bytes=len(content),
                source_sha256=digest,
            )
        )
        repository.append_chunk(
            ingestion.ingestion_id,
            chunk_index=0,
            byte_offset=0,
            data=content,
            sha256=digest,
            max_chunk_bytes=4 * 1024 * 1024,
            declared_total_bytes=len(content),
        )
        repository.finalize_ingestion(
            ingestion.ingestion_id,
            total_bytes=len(content),
            sha256=digest,
        )
        root = tmp_path / "acceptance"
        root.mkdir()
        extractor = StandaloneRuntimeCaptureExtractor(
            clock,
            ExtractionRuntimeConfig(
                windowsml_model_dir=tmp_path / "models",
                whisper_models_dir=tmp_path / "whisper",
                temp_dir=tmp_path / "temp",
                max_pdf_pages=4,
                max_image_pixels=1_000_000,
                ocr_render_scale=2.0,
                max_audio_duration_ms=60_000,
                whisper_primary_model="small",
                whisper_fallback_model="tiny",
                whisper_prefer_gpu=False,
            ),
            engine_manager=InstalledFailureCatalog(),  # type: ignore[arg-type]
        )
        service = StreamingCaptureService(
            repository,
            clock=clock,
            extractor=extractor,
            execution_evidence_sink=AcceptanceOcrExecutionEvidenceSink(
                root,
                preauthorized_root=root,
                runtime_sha256=_loaded_runtime_sha256(),
            ),
        )
        operation = service.start_capture(
            StartCaptureV2(
                client_request_id="real-worker-failure-capture",
                ingestion_id=ingestion.ingestion_id,
                structuring_mode=StructuringMode.HOST,
            )
        )
        for _ in range(100):
            if service.get_capture(operation.capture_id).status is StreamingCaptureStatus.FAILED:
                break
            await asyncio.sleep(0.01)

        failed = service.get_capture(operation.capture_id)
        assert failed.status is StreamingCaptureStatus.FAILED
        public_projection = repository.read_ocr_projection(operation.capture_id)
        assert public_projection.failure is not None
        assert public_projection.failure.code == "ocr_worker_failed"
        assert "diagnostics" not in public_projection.model_dump(mode="json", by_alias=True)
        artifact_path = root / "ocr-execution-failure-v1.json"
        artifact_text = artifact_path.read_text(encoding="utf-8")
        artifact = json.loads(artifact_text)
        assert artifact["sourceSha256"] == digest
        assert artifact["sourceRole"] == "image"
        assert artifact["runtimeSha256"] == _loaded_runtime_sha256()
        assert artifact["workerSha256"] == hashlib.sha256(worker.read_bytes()).hexdigest()
        assert artifact["failureClass"] == "no-response"
        assert artifact["exitCode"] == 7
        assert artifact["stageSequence"] == [
            "ocr-pipeline-create-start",
            "ocr-predict-failed-runtimeerror",
        ]
        assert "SECRET_STDERR" not in artifact_text
        assert "private-user" not in artifact_text
        await service.shutdown()

    asyncio.run(scenario())
