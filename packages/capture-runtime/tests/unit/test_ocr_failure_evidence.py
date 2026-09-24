from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path

import pytest

from capture_runtime.contracts import OcrProvenanceV3
from capture_runtime.ocr_execution_proof import (
    AcceptanceOcrExecutionEvidenceSink,
    NoopOcrExecutionEvidenceSink,
    acceptance_ocr_execution_evidence_sink_from_environment,
)
from capture_runtime.worker_client import InstalledEngine, OcrWorkerFailure, WorkerClient
from capture_runtime.worker_contracts import WorkerResponse
from capture_runtime.worker_process import (
    MAX_WORKER_DIAGNOSTIC_STAGES,
    WorkerExecutionError,
    WorkerFailureDiagnostics,
    WorkerProcess,
)


def test_worker_exit_carries_sanitized_structured_diagnostics(tmp_path: Path) -> None:
    worker = tmp_path / "failure_worker.py"
    worker.write_text(
        """
import os
import sys

sys.stdin.buffer.readline()
sys.stderr.write("C:\\\\Users\\\\secret-user\\\\private-source.pdf SECRET_STDERR\\n")
sys.stderr.write("capture-worker-stage:secret-token-abc123\\n")
sys.stderr.write("capture-worker-stage:worker-entry-start\\n")
sys.stderr.write("capture-worker-stage:ocr-pipeline-create-start\\n")
sys.stderr.flush()
os._exit(7)
""".lstrip(),
        encoding="utf-8",
    )
    owner = WorkerProcess()

    async def run() -> None:
        with pytest.raises(WorkerExecutionError) as raised:
            await owner.request(worker, "run", {}, timeout_seconds=5)
        error = raised.value
        assert error.diagnostics.stage_sequence == (
            "worker-entry-start",
            "ocr-pipeline-create-start",
        )
        assert error.diagnostics.failure_class == "no-response"
        assert error.diagnostics.exit_code == 7
        assert "SECRET_STDERR" not in str(error)
        assert "private-source.pdf" not in str(error)

        root = tmp_path / "acceptance"
        root.mkdir()
        AcceptanceOcrExecutionEvidenceSink(
            root,
            preauthorized_root=root,
            runtime_sha256="c" * 64,
        ).record_failure(
            source_sha256="a" * 64,
            source_role="pdf",
            diagnostics=error.diagnostics,
            worker_sha256=hashlib.sha256(worker.read_bytes()).hexdigest(),
        )
        artifact_text = (root / "ocr-execution-failure-v1.json").read_text(encoding="utf-8")
        assert "SECRET_STDERR" not in artifact_text
        assert "private-source.pdf" not in artifact_text

    asyncio.run(run())


def test_worker_stage_policy_uses_safe_fallback_when_only_secret_marker_is_emitted(
    tmp_path: Path,
) -> None:
    worker = tmp_path / "secret_stage_worker.py"
    worker.write_text(
        """
import os
import sys

sys.stdin.buffer.readline()
sys.stderr.write("capture-worker-stage:secret-token-abc123\\n")
sys.stderr.flush()
os._exit(7)
""".lstrip(),
        encoding="utf-8",
    )

    async def run() -> None:
        with pytest.raises(WorkerExecutionError) as raised:
            await WorkerProcess().request(worker, "run", {}, timeout_seconds=5)
        assert raised.value.diagnostics.stage_sequence == ("worker-process-no-response",)
        assert "secret-token-abc123" not in str(raised.value.diagnostics.stage_sequence)

    asyncio.run(run())


def test_worker_stage_policy_preserves_ocr_and_whisper_dynamic_families(
    tmp_path: Path,
) -> None:
    worker = tmp_path / "dynamic_stage_worker.py"
    worker.write_text(
        """
import os
import sys

sys.stdin.buffer.readline()
sys.stderr.write("capture-worker-stage:ocr-probe-modules-missing-2\\n")
sys.stderr.write("capture-worker-stage:ocr-probe-assets-missing-4\\n")
sys.stderr.write("capture-worker-stage:ocr-probe-providers-3-cpu-yes-dml-no\\n")
sys.stderr.write("capture-worker-stage:ocr-provider-evidence-dml-5-cpu-2\\n")
sys.stderr.write("capture-worker-stage:whisper-model-load-cpu-failed-permissionerror\\n")
sys.stderr.flush()
os._exit(7)
""".lstrip(),
        encoding="utf-8",
    )

    async def run() -> None:
        with pytest.raises(WorkerExecutionError) as raised:
            await WorkerProcess().request(worker, "run", {}, timeout_seconds=5)
        assert raised.value.diagnostics.stage_sequence == (
            "ocr-probe-modules-missing-2",
            "ocr-probe-assets-missing-4",
            "ocr-probe-providers-3-cpu-yes-dml-no",
            "ocr-provider-evidence-dml-5-cpu-2",
            "whisper-model-load-cpu-failed-permissionerror",
        )

    asyncio.run(run())


def test_unknown_ocr_module_suffix_is_redacted_to_a_safe_family_sentinel() -> None:
    error = WorkerExecutionError(
        "worker failed at stage "
        "python-import-paddleocr-failed-modulenotfounderror-"
        "missing-secret-token-in-paddleocr"
    )

    assert error.diagnostics.stage_sequence == ("python-import-paddleocr-failed-unknown",)
    assert "secret-token" not in str(error.diagnostics.stage_sequence)


def test_unknown_whisper_failure_suffix_is_redacted_without_losing_cpu_fallback(
    tmp_path: Path,
) -> None:
    class UnknownWhisperFailureProcess:
        def __init__(self) -> None:
            self.options: list[dict[str, object]] = []

        async def request(
            self,
            _executable: Path,
            _operation: str,
            payload: dict[str, object],
            *,
            cancel_event: asyncio.Event | None = None,
            timeout_seconds: float,
        ) -> WorkerResponse:
            del cancel_event, timeout_seconds
            options = payload["options"]
            assert isinstance(options, dict)
            self.options.append(options)
            if len(self.options) == 1:
                error = WorkerExecutionError(
                    "worker failed at stage whisper-model-load-cpu-failed-secret-token"
                )
                assert error.diagnostics.stage_sequence == (
                    "whisper-model-load-cpu-failed-unknown",
                )
                assert "secret-token" not in str(error.diagnostics.stage_sequence)
                raise error
            return WorkerResponse(
                request_id="run",
                ok=True,
                result={
                    "segments": [
                        {
                            "order": 0,
                            "text": "words",
                            "page": None,
                            "startMs": 0,
                            "endMs": 1000,
                        }
                    ],
                    "provenance": {
                        "engine": "whisper-primary",
                        "model": "small",
                        "digest": f"sha256:{'1' * 64}",
                        "device": "cpu",
                    },
                    "warnings": [],
                },
                error=None,
            )

    process = UnknownWhisperFailureProcess()
    client = WorkerClient(process=process)  # type: ignore[arg-type]
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    source = tmp_path / "audio.mp3"
    source.write_bytes(b"audio")

    async def run() -> None:
        result = await client.run(
            InstalledEngine(
                requirement_id="whisper-primary",
                artifact_version="engine-1",
                executable=tmp_path / "whisper.exe",
                model_dir=model_dir,
            ),
            source_path=source,
            media_type="audio/mpeg",
            options={"maxDurationMs": 60_000, "preferGpu": True},
            cancel_event=asyncio.Event(),
        )
        assert result.device == "cpu"

    asyncio.run(run())
    assert process.options == [
        {"maxDurationMs": 60_000, "preferGpu": True},
        {"maxDurationMs": 60_000, "preferGpu": False},
    ]


def test_worker_failure_diagnostics_rejects_unknown_stage_constructor_input() -> None:
    with pytest.raises(ValueError, match="allowlisted"):
        WorkerFailureDiagnostics(
            stage_sequence=("secret-token-abc123",),
            failure_class="worker",
        )


def test_ocr_worker_failure_retains_only_private_diagnostics() -> None:
    diagnostics = WorkerFailureDiagnostics(
        stage_sequence=("ocr-predict-start", "ocr-predict-failed-runtimeerror"),
        failure_class="exit-nonzero",
        exit_code=7,
    )
    failure = OcrWorkerFailure(kind="worker", progress=None, diagnostics=diagnostics)

    assert failure._diagnostics == diagnostics
    assert not hasattr(failure, "diagnostics")
    assert str(failure) == "OCR worker failed before completing all pages."


def test_worker_client_propagates_diagnostics_only_to_private_ocr_failure(
    tmp_path: Path,
) -> None:
    diagnostics = WorkerFailureDiagnostics(
        stage_sequence=("ocr-predict-start", "ocr-predict-failed-runtimeerror"),
        failure_class="exit-nonzero",
        exit_code=7,
    )

    class FailingWorkerProcess:
        async def request(self, *_args: object, **_kwargs: object) -> object:
            raise WorkerExecutionError("private path C:\\source.pdf", diagnostics=diagnostics)

    source = tmp_path / "source.pdf"
    source.write_bytes(b"source")
    client = WorkerClient(process=FailingWorkerProcess())  # type: ignore[arg-type]

    async def run() -> None:
        with pytest.raises(OcrWorkerFailure) as raised:
            await client.run(
                InstalledEngine(
                    requirement_id="windowsml-ocr",
                    artifact_version="engine-1",
                    executable=tmp_path / "ocr.exe",
                    model_dir=tmp_path,
                    worker_sha256="b" * 64,
                ),
                source_path=source,
                media_type="application/pdf",
                options={},
                cancel_event=asyncio.Event(),
            )
        assert raised.value._diagnostics == diagnostics
        assert not hasattr(raised.value, "diagnostics")

    asyncio.run(run())


def test_failure_artifact_is_bounded_private_and_atomic(tmp_path: Path) -> None:
    root = tmp_path / "acceptance"
    root.mkdir()
    sink = AcceptanceOcrExecutionEvidenceSink(
        root,
        preauthorized_root=root,
        runtime_sha256="c" * 64,
    )
    diagnostics = WorkerFailureDiagnostics(
        stage_sequence=("ocr-predict-start",) * (MAX_WORKER_DIAGNOSTIC_STAGES + 8),
        failure_class="no-response",
        exit_code=7,
    )

    artifact = sink.record_failure(
        source_sha256="a" * 64,
        source_role="pdf",
        diagnostics=diagnostics,
        worker_sha256="b" * 64,
        provenance=OcrProvenanceV3(
            status="resolved",
            engine="windowsml-ocr",
            model="pp-ocrv6-medium-windowsml",
            model_digest="sha256:" + "c" * 64,
            device="windowsml-dml",
            profile_id="capture-workbench-ocr-pipeline-v1",
            profile_spec_sha256="d" * 64,
        ),
    )
    path = root / artifact.relative_name
    payload = json.loads(path.read_text(encoding="utf-8"))

    assert artifact.relative_name == "ocr-execution-failure-v1.json"
    assert payload["schemaVersion"] == "1"
    assert payload["sourceSha256"] == "a" * 64
    assert payload["sourceRole"] == "pdf"
    assert payload["workerSha256"] == "b" * 64
    assert payload["failureClass"] == "no-response"
    assert payload["exitCode"] == 7
    assert len(payload["stageSequence"]) == MAX_WORKER_DIAGNOSTIC_STAGES
    assert "SECRET_STDERR" not in path.read_text(encoding="utf-8")
    assert not tuple(root.glob(".ocr-failure-*.tmp"))

    with pytest.raises(ValueError, match="already recorded"):
        sink.record_failure(
            source_sha256="a" * 64,
            source_role="pdf",
            diagnostics=diagnostics,
            worker_sha256="b" * 64,
        )


def test_failure_artifact_requires_runtime_and_worker_identities(tmp_path: Path) -> None:
    root = tmp_path / "acceptance"
    root.mkdir()
    diagnostics = WorkerFailureDiagnostics(stage_sequence=(), failure_class="protocol")
    with pytest.raises(ValueError, match="runtime identity"):
        AcceptanceOcrExecutionEvidenceSink(root, preauthorized_root=root).record_failure(
            source_sha256="a" * 64,
            source_role="image",
            diagnostics=diagnostics,
            worker_sha256="b" * 64,
        )

    sink = AcceptanceOcrExecutionEvidenceSink(
        root,
        preauthorized_root=root,
        runtime_sha256="c" * 64,
    )
    with pytest.raises(ValueError, match="worker identity"):
        sink.record_failure(
            source_sha256="a" * 64,
            source_role="image",
            diagnostics=diagnostics,
        )


def test_failure_artifact_rejects_root_collision(tmp_path: Path) -> None:
    root = tmp_path / "acceptance"
    root.mkdir()
    (root / "ocr-execution-failure-v1.json").write_text("collision", encoding="utf-8")
    sink = AcceptanceOcrExecutionEvidenceSink(
        root,
        preauthorized_root=root,
        runtime_sha256="c" * 64,
    )

    with pytest.raises(ValueError, match="collision"):
        sink.record_failure(
            source_sha256="a" * 64,
            source_role="image",
            diagnostics=WorkerFailureDiagnostics(stage_sequence=(), failure_class="protocol"),
            worker_sha256="b" * 64,
        )


def test_failure_artifact_write_failure_cleans_temporary_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "acceptance"
    root.mkdir()
    sink = AcceptanceOcrExecutionEvidenceSink(
        root,
        preauthorized_root=root,
        runtime_sha256="c" * 64,
    )

    def fail_link(*_args: object) -> None:
        raise OSError("synthetic link failure")

    monkeypatch.setattr(
        "capture_runtime.ocr_execution_proof.os.link",
        fail_link,
    )

    with pytest.raises(OSError, match="synthetic link failure"):
        sink.record_failure(
            source_sha256="a" * 64,
            source_role="image",
            diagnostics=WorkerFailureDiagnostics(stage_sequence=(), failure_class="protocol"),
            worker_sha256="b" * 64,
        )
    assert not (root / "ocr-execution-failure-v1.json").exists()
    assert not tuple(root.glob(".ocr-failure-*.tmp"))


def test_failure_artifact_is_disabled_without_acceptance_opt_in(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("CAPTURE_OCR_EXECUTION_EVIDENCE_OPT_IN", raising=False)
    sink = acceptance_ocr_execution_evidence_sink_from_environment()
    assert isinstance(sink, NoopOcrExecutionEvidenceSink)
    assert (
        sink.record_failure(
            source_sha256="a" * 64,
            source_role="pdf",
            diagnostics=WorkerFailureDiagnostics(stage_sequence=(), failure_class="protocol"),
        )
        is None
    )
    assert not tuple(tmp_path.iterdir())
