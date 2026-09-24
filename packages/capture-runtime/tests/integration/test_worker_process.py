from __future__ import annotations

import asyncio
import ctypes
import os
import subprocess
import time
from copy import deepcopy
from pathlib import Path

import pytest

from capture_runtime.contracts import OcrAdapterClass, OcrComputeMode
from capture_runtime.worker_client import InstalledEngine, OcrWorkerFailure, WorkerClient
from capture_runtime.worker_contracts import WorkerProtocolError, WorkerResponse
from capture_runtime.worker_process import (
    WorkerCancelledError,
    WorkerExecutionError,
    WorkerProcess,
    _stage_suffix,
    _subprocess_path,
)

WORKER = Path(__file__).parents[1] / "fixtures" / "deterministic_worker.py"
SERVER_WORKER = Path(__file__).parents[1] / "fixtures" / "server_worker.py"
OCR_PROVENANCE = {
    "status": "resolved",
    "engine": "windowsml-ocr",
    "model": "pp-ocrv6-medium-windowsml",
    "modelDigest": "sha256:" + "a" * 64,
    "device": "windowsml-dml",
    "profileId": "capture-workbench-ocr-pipeline-v1",
    "profileSpecSha256": "b" * 64,
}


def _ocr_page_payload(
    page: int,
    text: str,
    *,
    status: str = "recognized",
    confidence: float | None = 0.1234,
    provenance: dict[str, object] | None = None,
    failure: dict[str, object] | None = None,
) -> dict[str, object]:
    del provenance
    if status == "empty":
        return {
            "page": page,
            "status": "empty",
            "text": "",
            "boxes": [],
            "regionConfidences": [],
            "confidence": None,
            "raster": {
                "width": 120,
                "height": 80,
                "scale": 2,
                "coordinateSystem": "pixel",
            },
            "failure": None,
        }
    if status == "failed":
        return {
            "page": page,
            "status": "failed",
            "text": "",
            "boxes": [],
            "regionConfidences": [],
            "confidence": None,
            "raster": {
                "width": 120,
                "height": 80,
                "scale": 2,
                "coordinateSystem": "pixel",
            },
            "failure": failure
            or {
                "code": "ocr_page_failed",
                "message": "OCR page processing failed.",
                "stage": "extraction",
                "retryable": True,
            },
        }
    assert status == "recognized"
    return {
        "page": page,
        "status": "recognized",
        "text": text,
        "boxes": [
            {
                "polygon": [
                    {"x": 1, "y": 2},
                    {"x": 30, "y": 2},
                    {"x": 30, "y": 20},
                    {"x": 1, "y": 20},
                ],
                "text": text,
                "confidence": confidence,
            }
        ],
        "regionConfidences": [confidence] if confidence is not None else [],
        "confidence": confidence,
        "raster": {
            "width": 120,
            "height": 80,
            "scale": 2,
            "coordinateSystem": "pixel",
        },
        "failure": None,
    }


class EquivocatingOcrProcess:
    def __init__(
        self,
        progress_pages: list[dict[str, object]],
        final_pages: list[dict[str, object]],
        *,
        final_provenance: dict[str, object] | None = None,
    ) -> None:
        self.progress_pages = progress_pages
        self.final_pages = final_pages
        self.final_provenance = final_provenance or OCR_PROVENANCE

    async def request(
        self,
        _executable: Path,
        _operation: str,
        _payload: dict[str, object],
        *,
        cancel_event: asyncio.Event | None = None,
        progress_handler=None,
        timeout_seconds: float,
    ) -> WorkerResponse:
        del cancel_event, timeout_seconds
        assert progress_handler is not None
        progress_handler(
            {
                "type": "ocr-header",
                "pageCount": len(self.progress_pages),
                "provenance": OCR_PROVENANCE,
                "pages": [
                    {
                        "page": page,
                        "raster": {
                            "width": 120,
                            "height": 80,
                            "scale": 2,
                            "coordinateSystem": "pixel",
                        },
                    }
                    for page in range(1, len(self.progress_pages) + 1)
                ],
            }
        )
        for page in self.progress_pages:
            progress_handler({"type": "ocr-page", "page": page})
        return WorkerResponse(
            request_id="ocr-equivocation",
            ok=True,
            result={
                "segments": [
                    {
                        "order": index,
                        "text": page["text"],
                        "page": page["page"],
                        "startMs": None,
                        "endMs": None,
                    }
                    for index, page in enumerate(self.final_pages)
                    if page["status"] == "recognized"
                ],
                "provenance": self.final_provenance,
                "warnings": [],
                "pages": self.final_pages,
            },
            error=None,
        )


class MalformedTerminalOcrProcess:
    def __init__(
        self,
        progress_pages: list[dict[str, object]],
        *,
        page_count: int,
        terminal_result: dict[str, object] | None = None,
        terminal_error: WorkerProtocolError | None = None,
    ) -> None:
        self.progress_pages = progress_pages
        self.page_count = page_count
        self.terminal_result = terminal_result
        self.terminal_error = terminal_error

    async def request(
        self,
        _executable: Path,
        _operation: str,
        _payload: dict[str, object],
        *,
        cancel_event: asyncio.Event | None = None,
        progress_handler=None,
        timeout_seconds: float,
    ) -> WorkerResponse:
        del cancel_event, timeout_seconds
        assert progress_handler is not None
        progress_handler(
            {
                "type": "ocr-header",
                "pageCount": self.page_count,
                "provenance": OCR_PROVENANCE,
                "pages": [
                    {
                        "page": page,
                        "raster": {
                            "width": 120,
                            "height": 80,
                            "scale": 2,
                            "coordinateSystem": "pixel",
                        },
                    }
                    for page in range(1, self.page_count + 1)
                ],
            }
        )
        for page in self.progress_pages:
            progress_handler({"type": "ocr-page", "page": page})
        if self.terminal_error is not None:
            raise self.terminal_error
        assert self.terminal_result is not None
        return WorkerResponse(
            request_id="ocr-malformed-terminal",
            ok=True,
            result=self.terminal_result,
            error=None,
        )


class RecordingWorkerProcess:
    def __init__(self) -> None:
        self.payloads: list[dict[str, object]] = []

    async def request(
        self,
        _executable: Path,
        _operation: str,
        payload: dict[str, object],
        *,
        timeout_seconds: float,
    ) -> WorkerResponse:
        del timeout_seconds
        self.payloads.append(payload)
        return WorkerResponse(
            request_id="probe",
            ok=True,
            result={
                "ready": True,
                "codeReady": True,
                "assetsReady": True,
                "detail": "ready",
                "device": None,
            },
            error=None,
        )


class FreshWhisperRetryProcess:
    def __init__(
        self,
        failure: str = "worker_failed at stage whisper-model-load-cpu-failed-runtimeerror",
    ) -> None:
        self.failure = failure
        self.options: list[dict[str, object]] = []
        self.timeouts: list[float] = []

    async def request(
        self,
        _executable: Path,
        _operation: str,
        payload: dict[str, object],
        *,
        cancel_event: asyncio.Event | None = None,
        timeout_seconds: float,
    ) -> WorkerResponse:
        del cancel_event
        options = payload["options"]
        assert isinstance(options, dict)
        self.options.append(options)
        self.timeouts.append(timeout_seconds)
        if len(self.options) == 1:
            raise WorkerExecutionError(self.failure)
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


def test_worker_client_restarts_whisper_worker_for_cpu_fallback(
    tmp_path: Path,
) -> None:
    process = FreshWhisperRetryProcess()
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
        assert result.model == "small"

    asyncio.run(run())
    assert process.options == [
        {"maxDurationMs": 60_000, "preferGpu": True},
        {"maxDurationMs": 60_000, "preferGpu": False},
    ]


def test_worker_client_does_not_retry_whisper_when_gpu_is_already_disabled(
    tmp_path: Path,
) -> None:
    process = FreshWhisperRetryProcess()
    client = WorkerClient(process=process)  # type: ignore[arg-type]
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    source = tmp_path / "audio.mp3"
    source.write_bytes(b"audio")

    async def run() -> None:
        with pytest.raises(WorkerExecutionError):
            await client.run(
                InstalledEngine(
                    requirement_id="whisper-primary",
                    artifact_version="engine-1",
                    executable=tmp_path / "whisper.exe",
                    model_dir=model_dir,
                ),
                source_path=source,
                media_type="audio/mpeg",
                options={"maxDurationMs": 60_000, "preferGpu": False},
                cancel_event=asyncio.Event(),
            )

    asyncio.run(run())
    assert process.options == [{"maxDurationMs": 60_000, "preferGpu": False}]


def test_worker_client_does_not_retry_strict_cuda_with_cpu_fallback(
    tmp_path: Path,
) -> None:
    process = FreshWhisperRetryProcess()
    client = WorkerClient(process=process)  # type: ignore[arg-type]
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    source = tmp_path / "audio.mp3"
    source.write_bytes(b"audio")

    async def run() -> None:
        with pytest.raises(WorkerExecutionError):
            await client.run(
                InstalledEngine(
                    requirement_id="whisper-primary",
                    artifact_version="engine-1",
                    executable=tmp_path / "whisper.exe",
                    model_dir=model_dir,
                ),
                source_path=source,
                media_type="audio/mpeg",
                options={
                    "maxDurationMs": 60_000,
                    "preferGpu": True,
                    "allowCpuFallback": False,
                },
                cancel_event=asyncio.Event(),
            )

    asyncio.run(run())
    assert process.options == [
        {
            "maxDurationMs": 60_000,
            "preferGpu": True,
            "allowCpuFallback": False,
        }
    ]


def test_worker_client_does_not_retry_after_cpu_model_load_started(
    tmp_path: Path,
) -> None:
    process = FreshWhisperRetryProcess(
        "worker request timed out at stages whisper-model-load-cpu-start>"
        "whisper-model-load-cpu-complete>whisper-transcription-call-start"
    )
    client = WorkerClient(process=process)  # type: ignore[arg-type]
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    source = tmp_path / "audio.mp3"
    source.write_bytes(b"audio")

    async def run() -> None:
        with pytest.raises(WorkerExecutionError):
            await client.run(
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

    asyncio.run(run())
    assert process.options == [{"maxDurationMs": 60_000, "preferGpu": True}]


def test_worker_client_cpu_retry_shares_original_timeout_budget(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = FreshWhisperRetryProcess()
    client = WorkerClient(process=process)  # type: ignore[arg-type]
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    source = tmp_path / "audio.mp3"
    source.write_bytes(b"audio")
    clock = iter((100.0, 106.0))
    monkeypatch.setattr("capture_runtime.worker_client.monotonic", lambda: next(clock))

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
            timeout_seconds=10,
        )
        assert result.device == "cpu"

    asyncio.run(run())
    assert process.timeouts == [10, 4]


def test_worker_client_keeps_ocr_probe_options_empty_without_changing_whisper(
    tmp_path: Path,
) -> None:
    process = RecordingWorkerProcess()
    client = WorkerClient(process=process)  # type: ignore[arg-type]
    model_dir = tmp_path / "model"
    model_dir.mkdir()

    async def probe() -> None:
        await client.probe(
            InstalledEngine(
                requirement_id="windowsml-ocr",
                artifact_version="engine-1",
                executable=tmp_path / "ocr.exe",
                model_dir=model_dir,
            ),
            include_model=True,
            options={},
        )
        await client.probe(
            InstalledEngine(
                requirement_id="whisper-primary",
                artifact_version="engine-1",
                executable=tmp_path / "whisper.exe",
                model_dir=model_dir,
            ),
            include_model=True,
        )

    asyncio.run(probe())
    assert process.payloads[0]["options"] == {}
    assert "options" not in process.payloads[1]


@pytest.mark.parametrize(
    "mutation",
    ["text", "polygon", "confidence", "status", "failure", "raster"],
)
def test_ocr_worker_rejects_final_content_equivocation_and_keeps_verified_prefix(
    tmp_path: Path,
    mutation: str,
) -> None:
    progress_pages = [_ocr_page_payload(1, "page one"), _ocr_page_payload(2, "page two")]
    final_pages = deepcopy(progress_pages)
    if mutation == "text":
        final_pages[1]["text"] = "different page two"
        final_pages[1]["boxes"][0]["text"] = "different page two"  # type: ignore[index]
    elif mutation == "polygon":
        final_pages[1]["boxes"][0]["polygon"] = list(  # type: ignore[index]
            reversed(final_pages[1]["boxes"][0]["polygon"])  # type: ignore[index]
        )
    elif mutation == "confidence":
        final_pages[1]["confidence"] = 0.1235
        final_pages[1]["regionConfidences"] = [0.1235]
        final_pages[1]["boxes"][0]["confidence"] = 0.1235  # type: ignore[index]
    elif mutation == "status":
        final_pages[1] = _ocr_page_payload(2, "", status="empty")
    elif mutation == "failure":
        final_pages[1] = _ocr_page_payload(2, "", status="failed")
    elif mutation == "raster":
        final_pages[1]["raster"]["width"] = 121  # type: ignore[index]
    else:
        raise AssertionError(f"unhandled mutation: {mutation}")

    client = WorkerClient(
        process=EquivocatingOcrProcess(progress_pages, final_pages),  # type: ignore[arg-type]
    )
    source = tmp_path / "source.pdf"
    source.write_bytes(b"pdf")

    async def run() -> None:
        with pytest.raises(OcrWorkerFailure) as raised:
            await client.run(
                InstalledEngine(
                    requirement_id="windowsml-ocr",
                    artifact_version="engine-1",
                    executable=tmp_path / "ocr.exe",
                    model_dir=tmp_path,
                ),
                source_path=source,
                media_type="application/pdf",
                options={"pageManifest": []},
                cancel_event=asyncio.Event(),
            )
        assert raised.value.kind == "protocol"
        assert raised.value.progress is not None
        assert [page.page for page in raised.value.progress.pages] == [1]

    asyncio.run(run())


def test_ocr_worker_rejects_header_final_provenance_equivocation_without_pages(
    tmp_path: Path,
) -> None:
    progress_pages = [_ocr_page_payload(1, "page one"), _ocr_page_payload(2, "page two")]
    final_provenance = deepcopy(OCR_PROVENANCE)
    final_provenance["modelDigest"] = "sha256:" + "c" * 64
    client = WorkerClient(
        process=EquivocatingOcrProcess(  # type: ignore[arg-type]
            progress_pages,
            deepcopy(progress_pages),
            final_provenance=final_provenance,
        ),
    )
    source = tmp_path / "source.pdf"
    source.write_bytes(b"pdf")

    async def run() -> None:
        with pytest.raises(OcrWorkerFailure) as raised:
            await client.run(
                InstalledEngine(
                    requirement_id="windowsml-ocr",
                    artifact_version="engine-1",
                    executable=tmp_path / "ocr.exe",
                    model_dir=tmp_path,
                ),
                source_path=source,
                media_type="application/pdf",
                options={"pageManifest": []},
                cancel_event=asyncio.Event(),
            )
        assert raised.value.kind == "protocol"
        assert raised.value.progress is not None
        assert raised.value.progress.pages == ()

    asyncio.run(run())


def test_ocr_worker_accepts_signed_zero_as_the_same_numeric_content(
    tmp_path: Path,
) -> None:
    progress_pages = [
        _ocr_page_payload(1, "page one"),
        _ocr_page_payload(2, "page two", confidence=-0.0),
    ]
    final_pages = deepcopy(progress_pages)
    final_pages[1]["confidence"] = 0.0
    final_pages[1]["regionConfidences"] = [0.0]
    final_pages[1]["boxes"][0]["confidence"] = 0.0  # type: ignore[index]
    client = WorkerClient(
        process=EquivocatingOcrProcess(progress_pages, final_pages),  # type: ignore[arg-type]
    )
    source = tmp_path / "source.png"
    source.write_bytes(b"png")

    async def run() -> None:
        result = await client.run(
            InstalledEngine(
                requirement_id="windowsml-ocr",
                artifact_version="engine-1",
                executable=tmp_path / "ocr.exe",
                model_dir=tmp_path,
            ),
            source_path=source,
            media_type="image/png",
            options={"pageManifest": []},
            cancel_event=asyncio.Event(),
        )
        assert result.ocr_progress is not None
        assert [page.page for page in result.ocr_progress.pages] == [1, 2]

    asyncio.run(run())


@pytest.mark.parametrize(
    ("final_pages", "trusted_pages"),
    [
        ([_ocr_page_payload(1, "page one")], [1]),
        # Duplicate terminal page numbers are a malformed terminal shape, so
        # preserve the already validated consecutive progress prefix.
        ([_ocr_page_payload(1, "page one"), _ocr_page_payload(1, "page one")], [1, 2]),
    ],
)
def test_ocr_worker_rejects_final_page_omission_or_duplicate_with_only_trusted_prefix(
    tmp_path: Path,
    final_pages: list[dict[str, object]],
    trusted_pages: list[int],
) -> None:
    progress_pages = [_ocr_page_payload(1, "page one"), _ocr_page_payload(2, "page two")]
    client = WorkerClient(
        process=EquivocatingOcrProcess(progress_pages, deepcopy(final_pages)),  # type: ignore[arg-type]
    )
    source = tmp_path / "source.pdf"
    source.write_bytes(b"pdf")

    async def run() -> None:
        with pytest.raises(OcrWorkerFailure) as raised:
            await client.run(
                InstalledEngine(
                    requirement_id="windowsml-ocr",
                    artifact_version="engine-1",
                    executable=tmp_path / "ocr.exe",
                    model_dir=tmp_path,
                ),
                source_path=source,
                media_type="application/pdf",
                options={"pageManifest": []},
                cancel_event=asyncio.Event(),
            )
        assert raised.value.kind == "protocol"
        assert raised.value.progress is not None
        assert [page.page for page in raised.value.progress.pages] == trusted_pages

    asyncio.run(run())


def test_worker_subprocess_path_removes_windows_extended_prefix_on_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("capture_runtime.worker_process.os.name", "nt")

    assert _subprocess_path(Path(r"\\?\C:\capture\worker.exe")) == r"C:\capture\worker.exe"
    assert (
        _subprocess_path(Path(r"\\?\UNC\server\share\worker.exe")) == r"\\server\share\worker.exe"
    )


def test_worker_process_delivers_validated_progress_frames_before_response() -> None:
    owner = WorkerProcess()
    frames: list[dict[str, object]] = []

    async def run() -> None:
        response = await owner.request(
            SERVER_WORKER,
            "run",
            {"mode": "progress"},
            progress_handler=frames.append,
            timeout_seconds=5,
        )
        assert response.ok is True

    asyncio.run(run())
    assert frames == [{"type": "progress-fixture", "completed": 1}]


def test_worker_client_runs_model_free_preflight_in_one_owned_worker_process(
    tmp_path: Path,
) -> None:
    owner = WorkerProcess()
    client = WorkerClient(process=owner)
    contract_sha256 = "a" * 64

    async def run() -> None:
        decision = await client.ocr_compute_preflight(
            InstalledEngine(
                requirement_id="windowsml-ocr",
                artifact_version="engine-1",
                executable=SERVER_WORKER,
                model_dir=tmp_path,
            ),
            contract_sha256=contract_sha256,
        )
        assert decision.contract_sha256 == contract_sha256
        assert decision.mode is OcrComputeMode.GPU_DML
        assert decision.adapter_class is OcrAdapterClass.DEDICATED

    asyncio.run(run())
    assert owner.active_process_count == 0


def test_ocr_worker_failure_preserves_validated_progress_pages(tmp_path: Path) -> None:
    class FailingOcrProcess:
        async def request(
            self,
            _executable: Path,
            _operation: str,
            _payload: dict[str, object],
            *,
            cancel_event: asyncio.Event | None = None,
            progress_handler=None,
            timeout_seconds: float,
        ) -> WorkerResponse:
            del cancel_event, timeout_seconds
            assert progress_handler is not None
            progress_handler(
                {
                    "type": "ocr-header",
                    "pageCount": 2,
                    "provenance": OCR_PROVENANCE,
                    "pages": [
                        {
                            "page": 1,
                            "raster": {
                                "width": 120,
                                "height": 80,
                                "scale": 2,
                                "coordinateSystem": "pixel",
                            },
                        },
                        {
                            "page": 2,
                            "raster": {
                                "width": 120,
                                "height": 80,
                                "scale": 2,
                                "coordinateSystem": "pixel",
                            },
                        },
                    ],
                }
            )
            progress_handler(
                {
                    "type": "ocr-page",
                    "page": {
                        "page": 1,
                        "status": "recognized",
                        "text": "completed",
                        "boxes": [],
                        "regionConfidences": [],
                        "confidence": None,
                        "raster": {
                            "width": 120,
                            "height": 80,
                            "scale": 2,
                            "coordinateSystem": "pixel",
                        },
                        "failure": None,
                    },
                }
            )
            raise WorkerExecutionError("private worker detail")

    client = WorkerClient(process=FailingOcrProcess())  # type: ignore[arg-type]
    source = tmp_path / "source.pdf"
    source.write_bytes(b"pdf")

    async def run() -> None:
        with pytest.raises(OcrWorkerFailure) as raised:
            await client.run(
                InstalledEngine(
                    requirement_id="windowsml-ocr",
                    artifact_version="engine-1",
                    executable=tmp_path / "ocr.exe",
                    model_dir=tmp_path,
                ),
                source_path=source,
                media_type="application/pdf",
                options={"pageManifest": []},
                cancel_event=asyncio.Event(),
            )
        assert raised.value.kind == "worker"
        assert raised.value.progress is not None
        assert [page.page for page in raised.value.progress.pages] == [1]

    asyncio.run(run())


def test_ocr_worker_malformed_progress_preserves_only_validated_prefix(tmp_path: Path) -> None:
    class MalformedOcrProcess:
        async def request(
            self,
            _executable: Path,
            _operation: str,
            _payload: dict[str, object],
            *,
            cancel_event: asyncio.Event | None = None,
            progress_handler=None,
            timeout_seconds: float,
        ) -> WorkerResponse:
            del cancel_event, timeout_seconds
            assert progress_handler is not None
            header = {
                "type": "ocr-header",
                "pageCount": 2,
                "provenance": OCR_PROVENANCE,
                "pages": [
                    {
                        "page": 1,
                        "raster": {
                            "width": 120,
                            "height": 80,
                            "scale": 2,
                            "coordinateSystem": "pixel",
                        },
                    },
                    {
                        "page": 2,
                        "raster": {
                            "width": 120,
                            "height": 80,
                            "scale": 2,
                            "coordinateSystem": "pixel",
                        },
                    },
                ],
            }
            page = {
                "type": "ocr-page",
                "page": {
                    "page": 1,
                    "status": "recognized",
                    "text": "completed",
                    "boxes": [],
                    "regionConfidences": [],
                    "confidence": None,
                    "raster": {
                        "width": 120,
                        "height": 80,
                        "scale": 2,
                        "coordinateSystem": "pixel",
                    },
                    "failure": None,
                },
            }
            progress_handler(header)
            progress_handler(page)
            progress_handler(page)
            raise AssertionError("unreachable")

    client = WorkerClient(process=MalformedOcrProcess())  # type: ignore[arg-type]
    source = tmp_path / "source.pdf"
    source.write_bytes(b"pdf")

    async def run() -> None:
        with pytest.raises(OcrWorkerFailure) as raised:
            await client.run(
                InstalledEngine(
                    requirement_id="windowsml-ocr",
                    artifact_version="engine-1",
                    executable=tmp_path / "ocr.exe",
                    model_dir=tmp_path,
                ),
                source_path=source,
                media_type="application/pdf",
                options={"pageManifest": []},
                cancel_event=asyncio.Event(),
            )
        assert raised.value.kind == "protocol"
        assert raised.value.progress is not None
        assert [page.page for page in raised.value.progress.pages] == [1]

    asyncio.run(run())


@pytest.mark.parametrize(
    ("progress_shape", "expected_pages"),
    [
        ("recognized_and_empty", [1, 2]),
        ("recognized_only", [1]),
        ("header_only", []),
        ("nonconsecutive", [1]),
    ],
)
def test_ocr_worker_malformed_terminal_preserves_consecutive_progress_prefix(
    tmp_path: Path,
    progress_shape: str,
    expected_pages: list[int],
) -> None:
    page_one = _ocr_page_payload(1, "page one")
    page_two = _ocr_page_payload(2, "", status="empty")
    page_three = _ocr_page_payload(3, "page three")
    progress_pages = {
        "recognized_and_empty": [page_one, page_two],
        "recognized_only": [page_one],
        "header_only": [],
        "nonconsecutive": [page_one, page_three],
    }[progress_shape]
    malformed_terminal = {
        "segments": [],
        "provenance": OCR_PROVENANCE,
        "warnings": [],
        "pages": {"not": "a page list"},
    }
    client = WorkerClient(
        process=MalformedTerminalOcrProcess(
            progress_pages,
            page_count=3,
            terminal_result=malformed_terminal,
        ),  # type: ignore[arg-type]
    )
    source = tmp_path / "source.pdf"
    source.write_bytes(b"pdf")

    async def run() -> None:
        with pytest.raises(OcrWorkerFailure) as raised:
            await client.run(
                InstalledEngine(
                    requirement_id="windowsml-ocr",
                    artifact_version="engine-1",
                    executable=tmp_path / "ocr.exe",
                    model_dir=tmp_path,
                ),
                source_path=source,
                media_type="application/pdf",
                options={"pageManifest": []},
                cancel_event=asyncio.Event(),
            )
        assert raised.value.kind == "protocol"
        assert raised.value.progress is not None
        progress = raised.value.progress
        assert [page.page for page in progress.pages] == expected_pages
        assert progress.provenance is not None and progress.provenance.is_resolved
        assert progress.provenance.model_dump(mode="json", by_alias=True) == OCR_PROVENANCE
        if progress_shape == "recognized_and_empty":
            assert [page.text for page in progress.pages] == ["page one", ""]
            assert [page.status for page in progress.pages] == ["recognized", "empty"]
            assert progress.pages[0].boxes[0].text == "page one"
            assert progress.pages[0].boxes[0].confidence == 0.1234
            assert (progress.pages[0].raster_width, progress.pages[0].raster_height) == (120, 80)

    asyncio.run(run())


def test_ocr_worker_invalid_terminal_json_preserves_all_validated_progress_pages(
    tmp_path: Path,
) -> None:
    progress_pages = [_ocr_page_payload(1, "page one"), _ocr_page_payload(2, "page two")]
    client = WorkerClient(
        process=MalformedTerminalOcrProcess(
            progress_pages,
            page_count=2,
            terminal_error=WorkerProtocolError("worker response JSON is invalid"),
        ),  # type: ignore[arg-type]
    )
    source = tmp_path / "source.pdf"
    source.write_bytes(b"pdf")

    async def run() -> None:
        with pytest.raises(OcrWorkerFailure) as raised:
            await client.run(
                InstalledEngine(
                    requirement_id="windowsml-ocr",
                    artifact_version="engine-1",
                    executable=tmp_path / "ocr.exe",
                    model_dir=tmp_path,
                ),
                source_path=source,
                media_type="application/pdf",
                options={"pageManifest": []},
                cancel_event=asyncio.Event(),
            )
        assert raised.value.kind == "protocol"
        assert raised.value.progress is not None
        assert [page.page for page in raised.value.progress.pages] == [1, 2]
        assert [page.text for page in raised.value.progress.pages] == ["page one", "page two"]

    asyncio.run(run())


def test_ocr_worker_unavailable_header_is_protocol_failure_without_trusted_progress(
    tmp_path: Path,
) -> None:
    class UnavailableHeaderOcrProcess:
        async def request(
            self,
            _executable: Path,
            _operation: str,
            _payload: dict[str, object],
            *,
            cancel_event: asyncio.Event | None = None,
            progress_handler=None,
            timeout_seconds: float,
        ) -> WorkerResponse:
            del cancel_event, timeout_seconds
            assert progress_handler is not None
            progress_handler(
                {
                    "type": "ocr-header",
                    "pageCount": 1,
                    "provenance": {
                        "status": "unavailable",
                        "profileId": "capture-workbench-ocr-pipeline-v1",
                        "profileSpecSha256": "b" * 64,
                        "reason": "protocol_failure",
                    },
                    "pages": [
                        {
                            "page": 1,
                            "raster": {
                                "width": 120,
                                "height": 80,
                                "scale": 2,
                                "coordinateSystem": "pixel",
                            },
                        }
                    ],
                }
            )
            raise AssertionError("unavailable header must fail before any page is trusted")

    client = WorkerClient(process=UnavailableHeaderOcrProcess())  # type: ignore[arg-type]
    source = tmp_path / "source.pdf"
    source.write_bytes(b"pdf")

    async def run() -> None:
        with pytest.raises(OcrWorkerFailure) as raised:
            await client.run(
                InstalledEngine(
                    requirement_id="windowsml-ocr",
                    artifact_version="engine-1",
                    executable=tmp_path / "ocr.exe",
                    model_dir=tmp_path,
                ),
                source_path=source,
                media_type="application/pdf",
                options={"pageManifest": []},
                cancel_event=asyncio.Event(),
            )
        assert raised.value.kind == "protocol"
        assert raised.value.progress is None
        assert raised.value.provenance is None

    asyncio.run(run())


def test_ocr_worker_accepts_complete_empty_terminal_pages_for_deep_outcome(
    tmp_path: Path,
) -> None:
    class EmptyOcrProcess:
        async def request(
            self,
            _executable: Path,
            _operation: str,
            _payload: dict[str, object],
            *,
            cancel_event: asyncio.Event | None = None,
            progress_handler=None,
            timeout_seconds: float,
        ) -> WorkerResponse:
            del cancel_event, timeout_seconds
            assert progress_handler is not None
            progress_handler(
                {
                    "type": "ocr-header",
                    "pageCount": 1,
                    "provenance": OCR_PROVENANCE,
                    "pages": [
                        {
                            "page": 1,
                            "raster": {
                                "width": 120,
                                "height": 80,
                                "scale": 2,
                                "coordinateSystem": "pixel",
                            },
                        }
                    ],
                }
            )
            progress_handler(
                {
                    "type": "ocr-page",
                    "page": {
                        "page": 1,
                        "status": "empty",
                        "text": "",
                        "boxes": [],
                        "regionConfidences": [],
                        "confidence": None,
                        "raster": {
                            "width": 120,
                            "height": 80,
                            "scale": 2,
                            "coordinateSystem": "pixel",
                        },
                        "failure": None,
                    },
                }
            )
            return WorkerResponse(
                request_id="empty-ocr",
                ok=True,
                result={
                    "segments": [],
                    "provenance": OCR_PROVENANCE,
                    "warnings": [],
                    "pages": [
                        {
                            "page": 1,
                            "status": "empty",
                            "text": "",
                            "boxes": [],
                            "regionConfidences": [],
                            "confidence": None,
                            "raster": {
                                "width": 120,
                                "height": 80,
                                "scale": 2,
                                "coordinateSystem": "pixel",
                            },
                            "failure": None,
                        }
                    ],
                },
                error=None,
            )

    client = WorkerClient(process=EmptyOcrProcess())  # type: ignore[arg-type]
    source = tmp_path / "source.png"
    source.write_bytes(b"png")

    async def run() -> None:
        result = await client.run(
            InstalledEngine(
                requirement_id="windowsml-ocr",
                artifact_version="engine-1",
                executable=tmp_path / "ocr.exe",
                model_dir=tmp_path,
            ),
            source_path=source,
            media_type="image/png",
            options={"pageManifest": []},
            cancel_event=asyncio.Event(),
        )
        assert result.segments == ()
        assert result.ocr_progress is not None
        assert [page.status for page in result.ocr_progress.pages] == ["empty"]

    asyncio.run(run())


def test_deterministic_worker_success_and_secret_isolation() -> None:
    owner = WorkerProcess(
        base_environment={
            "PATH": "C:\\Windows\\System32",
            "CAPTURE_API_TOKEN": "secret-value",
            "CAPTURE_TEST_SECRET": "secret-value",
        }
    )

    async def run() -> None:
        response = await owner.request(
            WORKER,
            "probe",
            {"mode": "security"},
            timeout_seconds=5,
        )
        assert response.result == {
            "apiTokenInEnvironment": False,
            "secretInEnvironment": False,
            "secretInArgv": False,
            "secretInStdin": False,
        }
        assert owner.active_process_count == 0

    asyncio.run(run())


def test_worker_drains_large_stderr_without_pipe_deadlock() -> None:
    owner = WorkerProcess()

    async def run() -> None:
        response = await owner.request(
            WORKER,
            "probe",
            {"mode": "stderr-flood"},
            timeout_seconds=5,
        )
        assert response.result == {"value": "ok"}
        assert owner.active_process_count == 0

    asyncio.run(run())


def test_worker_timeout_reports_only_allowlisted_last_stage() -> None:
    owner = WorkerProcess()

    async def run() -> None:
        with pytest.raises(
            WorkerExecutionError,
            match=r"^worker request timed out at stage whisper-model-load-cuda-start$",
        ):
            await owner.request(
                WORKER,
                "run",
                {"mode": "staged-timeout"},
                timeout_seconds=0.5,
            )
        assert owner.active_process_count == 0

    asyncio.run(run())


def test_worker_no_response_reports_safe_exit_code_and_stage_only(tmp_path: Path) -> None:
    worker = tmp_path / "no_response_worker.py"
    worker.write_text(
        """
import os
import sys

sys.stdin.buffer.readline()
sys.stderr.write("C:\\\\Users\\\\secret-user\\\\private-source.pdf SECRET_STDERR\\n")
sys.stderr.write("capture-worker-stage:worker-entry-start\\n")
sys.stderr.flush()
os._exit(7)
""".lstrip(),
        encoding="utf-8",
    )
    owner = WorkerProcess()

    async def run() -> None:
        with pytest.raises(WorkerExecutionError) as raised:
            await owner.request(worker, "probe", {}, timeout_seconds=5)
        assert (
            str(raised.value)
            == "worker returned no response with code 7 at stage worker-entry-start"
        )
        assert "SECRET_STDERR" not in str(raised.value)
        assert "private-source.pdf" not in str(raised.value)
        assert owner.active_process_count == 0

    asyncio.run(run())


def test_worker_stage_diagnostics_accept_windows_crlf(tmp_path: Path) -> None:
    worker = tmp_path / "crlf_worker.py"
    worker.write_text(
        """
import os
import sys

sys.stdin.buffer.readline()
sys.stderr.buffer.write(b"capture-worker-stage:worker-entry-start\\r\\n")
sys.stderr.buffer.flush()
os._exit(7)
""".lstrip(),
        encoding="utf-8",
    )
    owner = WorkerProcess()

    async def run() -> None:
        with pytest.raises(WorkerExecutionError, match=r"at stage worker-entry-start$"):
            await owner.request(worker, "probe", {}, timeout_seconds=5)

    asyncio.run(run())


def test_worker_stage_diagnostics_preserve_bounded_sequence_without_stderr() -> None:
    stderr = "\n".join(
        [
            "C:\\Users\\secret-user\\private-source.mp3 SECRET_STDERR",
            "capture-worker-stage:whisper-assets-probe-start",
            "capture-worker-stage:whisper-device-probe-complete",
            "capture-worker-stage:whisper-model-load-cuda-failed-runtimeerror",
            "capture-worker-stage:whisper-gpu-fallback",
            "capture-worker-stage:whisper-model-load-cpu-failed-runtimeerror",
        ]
    )

    detail = _stage_suffix(stderr)

    assert detail == (
        " at stages whisper-assets-probe-start>whisper-device-probe-complete>"
        "whisper-model-load-cuda-failed-runtimeerror>whisper-gpu-fallback>"
        "whisper-model-load-cpu-failed-runtimeerror"
    )
    assert "private-source.mp3" not in detail
    assert "SECRET_STDERR" not in detail


def test_worker_failure_response_wins_exit_and_hides_stderr(tmp_path: Path) -> None:
    worker = tmp_path / "failure_worker.py"
    worker.write_text(
        """
import json
import os
import sys

request = json.loads(sys.stdin.buffer.readline())
response = {
    "protocolVersion": "1",
    "requestId": request["requestId"],
    "ok": False,
    "result": None,
    "error": {
        "code": "worker_failed",
        "message": "Worker operation failed.",
        "retryable": True,
    },
}
sys.stderr.buffer.write(b"C:\\\\Users\\\\secret-user\\\\private-source.pdf SECRET_STDERR\\n")
sys.stderr.buffer.flush()
sys.stdout.buffer.write((json.dumps(response, separators=(",", ":")) + "\\n").encode())
sys.stdout.buffer.flush()
os._exit(1)
""".lstrip(),
        encoding="utf-8",
    )
    owner = WorkerProcess()

    async def run() -> None:
        with pytest.raises(WorkerExecutionError) as raised:
            await owner.request(worker, "run", {}, timeout_seconds=5)
        assert str(raised.value) == (
            "worker_failed: Worker operation failed. at stage worker-process-response-error"
        )
        assert "SECRET_STDERR" not in str(raised.value)
        assert "private-source.pdf" not in str(raised.value)
        assert owner.active_process_count == 0

    asyncio.run(run())


@pytest.mark.skipif(os.name != "nt", reason="Windows worker-tree release boundary")
def test_worker_response_releases_descendant_after_parent_exits(tmp_path: Path) -> None:
    worker = tmp_path / "failure_worker_with_child.py"
    pid_file = tmp_path / "child.pid"
    worker.write_text(
        """
import json
import os
import subprocess
import sys
import time

request = json.loads(sys.stdin.buffer.readline())
child = subprocess.Popen(
    [sys.executable, "-c", "import time; time.sleep(60)"],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
with open(request["payload"]["pidFile"], "w", encoding="ascii") as handle:
    handle.write(str(child.pid))
response = {
    "protocolVersion": "1",
    "requestId": request["requestId"],
    "ok": True,
    "result": {"value": "ok"},
    "error": None,
}
sys.stdout.buffer.write((json.dumps(response, separators=(",", ":")) + "\\n").encode())
sys.stdout.buffer.flush()
os._exit(0)
""".lstrip(),
        encoding="utf-8",
    )
    owner = WorkerProcess()

    async def run() -> None:
        response = await owner.request(
            worker,
            "run",
            {"pidFile": str(pid_file)},
            timeout_seconds=5,
        )
        assert response.result == {"value": "ok"}

    asyncio.run(run())
    deadline = time.monotonic() + 5
    child_pid: int | None = None
    while time.monotonic() < deadline:
        if pid_file.is_file():
            raw_pid = pid_file.read_text(encoding="ascii").strip()
            if raw_pid:
                child_pid = int(raw_pid)
                break
        time.sleep(0.01)
    assert child_pid is not None
    try:
        assert not _windows_pid_is_live(child_pid)
    finally:
        if _windows_pid_is_live(child_pid):
            subprocess.run(
                ["taskkill", "/PID", str(child_pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                shell=False,
                check=False,
                timeout=15,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )


@pytest.mark.skipif(os.name != "nt", reason="Windows worker-tree pipe boundary")
def test_worker_response_does_not_wait_for_inherited_descendant_pipes(
    tmp_path: Path,
) -> None:
    worker = tmp_path / "response_worker_with_inherited_pipes.py"
    pid_file = tmp_path / "inherited-child.pid"
    worker.write_text(
        """
import json
import os
import subprocess
import sys
import time

request = json.loads(sys.stdin.buffer.readline())
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
with open(request["payload"]["pidFile"], "w", encoding="ascii") as handle:
    handle.write(str(child.pid))
response = {
    "protocolVersion": "1",
    "requestId": request["requestId"],
    "ok": True,
    "result": {"value": "ok"},
    "error": None,
}
sys.stdout.buffer.write((json.dumps(response, separators=(",", ":")) + "\\n").encode())
sys.stdout.buffer.flush()
os._exit(0)
""".lstrip(),
        encoding="utf-8",
    )
    owner = WorkerProcess()

    async def run() -> None:
        response = await asyncio.wait_for(
            owner.request(
                worker,
                "run",
                {"pidFile": str(pid_file)},
                timeout_seconds=5,
            ),
            timeout=5,
        )
        assert response.result == {"value": "ok"}

    try:
        asyncio.run(run())
    finally:
        if pid_file.is_file():
            child_pid = int(pid_file.read_text(encoding="ascii").strip())
            if _windows_pid_is_live(child_pid):
                subprocess.run(
                    ["taskkill", "/PID", str(child_pid), "/T", "/F"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    shell=False,
                    check=False,
                    timeout=15,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )


def _windows_pid_is_live(pid: int) -> bool:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel32.WaitForSingleObject.restype = ctypes.c_ulong
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int
    handle = kernel32.OpenProcess(0x00100000, False, pid)
    if not handle:
        return False
    try:
        return kernel32.WaitForSingleObject(handle, 0) == 0x00000102
    finally:
        kernel32.CloseHandle(handle)


def test_worker_failure_retains_last_stage_after_large_stderr(tmp_path: Path) -> None:
    worker = tmp_path / "large_stderr_failure_worker.py"
    worker.write_text(
        """
import json
import os
import sys

request = json.loads(sys.stdin.buffer.readline())
response = {
    "protocolVersion": "1",
    "requestId": request["requestId"],
    "ok": False,
    "result": None,
    "error": {
        "code": "worker_failed",
        "message": "Worker operation failed.",
        "retryable": True,
    },
}
sys.stderr.buffer.write(b"bounded diagnostic\\n" * 8192)
sys.stderr.buffer.write(b"capture-worker-stage:ocr-output-empty\\n")
sys.stderr.buffer.flush()
sys.stdout.buffer.write((json.dumps(response, separators=(",", ":")) + "\\n").encode())
sys.stdout.buffer.flush()
os._exit(1)
""".lstrip(),
        encoding="utf-8",
    )
    owner = WorkerProcess()

    async def run() -> None:
        with pytest.raises(WorkerExecutionError) as raised:
            await owner.request(worker, "run", {}, timeout_seconds=5)
        assert (
            str(raised.value) == "worker_failed: Worker operation failed. at stage ocr-output-empty"
        )
        assert owner.active_process_count == 0

    asyncio.run(run())


def test_worker_response_failure_has_safe_fallback_stage(tmp_path: Path) -> None:
    worker = tmp_path / "response_failure_worker.py"
    worker.write_text(
        """
import json
import os
import sys

request = json.loads(sys.stdin.buffer.readline())
response = {
    "protocolVersion": "1",
    "requestId": request["requestId"],
    "ok": False,
    "result": None,
    "error": {"code": "worker_failed", "message": "Worker operation failed.", "retryable": True},
}
sys.stdout.buffer.write((json.dumps(response, separators=(",", ":")) + "\\n").encode())
sys.stdout.buffer.flush()
os._exit(1)
""".lstrip(),
        encoding="utf-8",
    )
    owner = WorkerProcess()

    async def run() -> None:
        with pytest.raises(WorkerExecutionError) as raised:
            await owner.request(worker, "run", {}, timeout_seconds=5)
        assert str(raised.value) == (
            "worker_failed: Worker operation failed. at stage worker-process-response-error"
        )
        assert owner.active_process_count == 0

    asyncio.run(run())


def test_worker_bootloader_failure_preserves_fallback_stage(tmp_path: Path) -> None:
    worker = tmp_path / "bootloader_failure_worker.py"
    worker.write_text(
        """
import sys

sys.stdin.buffer.readline()
sys.stderr.write("[PYI-123:ERROR] worker terminated before a response\\n")
sys.stderr.flush()
sys.exit(1)
""".lstrip(),
        encoding="utf-8",
    )
    owner = WorkerProcess()

    async def run() -> None:
        with pytest.raises(WorkerExecutionError) as raised:
            await owner.request(worker, "run", {}, timeout_seconds=5)
        assert str(raised.value) == (
            "worker returned no response with code 1 at stage worker-process-no-response-bootloader"
        )
        assert owner.active_process_count == 0

    asyncio.run(run())


def test_worker_server_runs_native_handler_on_main_thread() -> None:
    owner = WorkerProcess()

    async def run() -> None:
        response = await owner.request(
            SERVER_WORKER,
            "run",
            {},
            timeout_seconds=5,
        )
        assert response.result == {
            "mainThread": True,
            "operation": "run",
            "preparedOnMainThread": True,
        }
        assert owner.active_process_count == 0

    asyncio.run(run())


@pytest.mark.parametrize(
    ("mode", "error_type"),
    [
        ("malformed", WorkerProtocolError),
        ("oversized", WorkerProtocolError),
        ("multiple", WorkerProtocolError),
        ("protocol-mismatch", WorkerProtocolError),
        ("timeout", WorkerExecutionError),
    ],
)
def test_worker_malformed_protocol_and_timeout_leave_no_residue(
    mode: str, error_type: type[BaseException]
) -> None:
    owner = WorkerProcess()

    async def run() -> None:
        with pytest.raises(error_type):
            await owner.request(
                WORKER,
                "probe",
                {"mode": mode},
                timeout_seconds=0.1 if mode == "timeout" else 5,
            )
        assert owner.active_process_count == 0

    asyncio.run(run())


def test_worker_cancellation_is_bounded_and_leaves_no_residue() -> None:
    owner = WorkerProcess()

    async def run() -> None:
        cancellation = asyncio.Event()
        task = asyncio.create_task(
            owner.request(
                WORKER,
                "run",
                {"mode": "cancel"},
                cancel_event=cancellation,
                timeout_seconds=5,
            )
        )
        await asyncio.sleep(0.05)
        cancellation.set()
        with pytest.raises(WorkerCancelledError):
            await task
        assert owner.active_process_count == 0

    asyncio.run(run())


def test_worker_shutdown_stops_all_owned_processes() -> None:
    owner = WorkerProcess()

    async def run() -> None:
        task = asyncio.create_task(
            owner.request(
                WORKER,
                "probe",
                {"mode": "timeout"},
                timeout_seconds=60,
            )
        )
        for _ in range(100):
            if owner.active_process_count == 1:
                break
            await asyncio.sleep(0.01)
        assert owner.active_process_count == 1
        await owner.shutdown()
        with pytest.raises(WorkerExecutionError):
            await task
        assert owner.active_process_count == 0

    asyncio.run(run())
