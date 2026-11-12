from __future__ import annotations

import asyncio
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import httpx
import pytest
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse

from capture_runtime.capture.api.streaming import register_streaming_routes
from capture_runtime.capture.application.streaming_capture_service import StreamingCaptureService
from capture_runtime.capture.domain.size_policy import DOCUMENT_MAX_UPLOAD_BYTES, SourceSizePolicy
from capture_runtime.capture.infrastructure.capture_extraction import CaptureExtractor
from capture_runtime.capture.infrastructure.source_sniffing import sniff_source
from capture_runtime.capture.infrastructure.streaming_repository import (
    StreamingRecordNotFoundError,
    StreamingRepository,
)
from capture_runtime.contracts import (
    CaptureSource,
    StartCaptureV2,
    StreamingCaptureStatus,
    StructuringMode,
)
from capture_runtime.dependencies import RuntimeDependencies
from capture_runtime.routes.common import ApiProblem
from capture_runtime.structuring.infrastructure.structuring_provider import (
    FakeCaptureStructuringProvider,
)
from capture_runtime.testing.deterministic_extractor import DeterministicCaptureExtractor
from tests.integration.test_streaming_progressive import FixedClock, _open
from tests.unit.test_speaker_extraction import AUDIO


class HeldExtractor:
    sniff = staticmethod(sniff_source)

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.finish = asyncio.Event()
        self.stopping = asyncio.Event()
        self.stopped = asyncio.Event()
        self.allow_stop = asyncio.Event()
        self.order: list[str] = []

    async def extract(self, source: Path, *args: Any, **kwargs: Any) -> Any:
        self.started.set()
        try:
            await self.finish.wait()
            raise ValueError("Synthetic extraction failure")
        finally:
            self.stopping.set()
            await asyncio.wait_for(self.allow_stop.wait(), timeout=3)
            assert source.exists()
            self.order.append("worker-stopped")
            self.stopped.set()


class RetiringExtractor(HeldExtractor):
    """An extractor whose warm OCR worker takes a while to retire."""

    def __init__(self) -> None:
        super().__init__()
        self.retiring = asyncio.Event()
        self.allow_retire = asyncio.Event()

    async def release_warm_workers(self) -> None:
        self.retiring.set()
        await asyncio.wait_for(self.allow_retire.wait(), timeout=3)
        self.order.append("warm-worker-retired")


class Harness:
    def __init__(self, tmp_path: Path, extractor: HeldExtractor | None = None) -> None:
        self.clock = FixedClock()
        policy = SourceSizePolicy(DOCUMENT_MAX_UPLOAD_BYTES)
        self.repository = StreamingRepository(
            tmp_path / "streaming", clock=self.clock, retention_hours=4, policy=policy
        )
        self.repository.initialize()
        self.ingestion_id, _ = _open(self.repository, source=AUDIO)
        self.source = self.repository.source_path(self.ingestion_id)
        self.extractor = extractor or HeldExtractor()
        self.service = StreamingCaptureService(
            self.repository,
            clock=self.clock,
            policy=policy,
            extractor=cast(CaptureExtractor, self.extractor),
            structurer=FakeCaptureStructuringProvider(self.clock),
        )
        operation = self.service.start_capture_use_case.execute(
            StartCaptureV2(
                client_request_id="ownership",
                ingestion_id=self.ingestion_id,
                identify_speakers=True,
                structuring_mode=StructuringMode.RUNTIME,
            )
        )
        self.capture_id = operation.capture_id
        self.task = self.service._tasks[self.capture_id]

    def client(self) -> httpx.AsyncClient:
        app = FastAPI()
        router = APIRouter(prefix="/v2")
        register_streaming_routes(
            router,
            cast(
                RuntimeDependencies,
                SimpleNamespace(
                    streaming_capture_service=self.service,
                    structuring_session_service=SimpleNamespace(
                        open_use_case=None, submit_use_case=None, get_use_case=None
                    ),
                ),
            ),
        )
        app.include_router(router)

        @app.exception_handler(ApiProblem)
        async def problem(request: Request, error: ApiProblem) -> JSONResponse:
            return JSONResponse({"code": error.code}, status_code=error.status_code)

        return httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test")


async def checkpoint() -> None:
    # Drain ready tasks without a wall-clock delay.
    for _ in range(5):
        await asyncio.sleep(0)


def test_qa_fixture_path_preserves_long_text(tmp_path: Path) -> None:
    content = AUDIO + b"CAPTURE_TEXT:" + b"first " * 80 + b"|second segment"
    source_path = tmp_path / "fixture.bin"
    source_path.write_bytes(content)
    source = CaptureSource(
        sha256="0" * 64, file_name="fixture", media_type="audio/wav", bytes=len(content)
    )
    extractor = DeterministicCaptureExtractor(FixedClock())

    async def scenario() -> None:
        buffered = await extractor.extract(content, source, asyncio.Event())
        by_path = await extractor.extract(source_path, source, asyncio.Event())
        assert len(buffered.raw.segments) == 2
        assert by_path.raw.segments == buffered.raw.segments

    asyncio.run(scenario())


def test_delete_and_cancel_wait_for_worker_once(tmp_path: Path) -> None:
    async def scenario() -> None:
        h = Harness(tmp_path)
        await h.extractor.started.wait()
        errors: list[dict[str, Any]] = []
        asyncio.get_running_loop().set_exception_handler(
            lambda loop, context: errors.append(context)
        )
        async with h.client() as client:
            first = asyncio.create_task(client.delete(f"/v2/captures/{h.capture_id}"))
            await h.extractor.stopping.wait()
            second = asyncio.create_task(client.delete(f"/v2/captures/{h.capture_id.upper()}"))
            h.service.cancel_capture_use_case.execute(h.capture_id.upper())
            await checkpoint()
            assert not first.done() and not second.done()
            assert h.source.exists() and not h.extractor.stopped.is_set()
            h.extractor.allow_stop.set()
            assert (await first).status_code == 204
            response = await second
            assert response.status_code == 404 and response.json()["code"] == "capture_not_found"
            h.extractor.order.append("deleted")
            assert h.extractor.order == ["worker-stopped", "deleted"]
            assert not h.source.exists()
            assert (await client.get(f"/v2/captures/{h.capture_id}")).status_code == 404
        await checkpoint()
        assert not errors
        assert not h.service._tasks
        await h.service.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize("upper", [False, True])
def test_delete_task_done_before_callback(tmp_path: Path, upper: bool) -> None:
    async def scenario() -> None:
        h = Harness(tmp_path)
        await h.extractor.started.wait()
        h.extractor.allow_stop.set()
        h.extractor.finish.set()
        while not h.task.done():
            await asyncio.sleep(0)
        assert h.capture_id in h.service._tasks
        assert h.capture_id in h.repository._running_captures
        async with h.client() as client:
            capture_id = h.capture_id.upper() if upper else h.capture_id
            assert (await client.delete(f"/v2/captures/{capture_id}")).status_code == 204
        assert not h.source.exists()
        await h.service.shutdown()

    asyncio.run(scenario())


def test_cancelled_ingestion_delete_waits_but_running_is_rejected(tmp_path: Path) -> None:
    async def scenario() -> None:
        h = Harness(tmp_path)
        await h.extractor.started.wait()
        async with h.client() as client:
            rejected = await client.delete(f"/v2/ingestions/{h.ingestion_id}")
            assert rejected.status_code == 409
            assert rejected.json()["code"] == "ingestion_delete_rejected"
            assert h.source.exists()
            h.service.cancel_capture_use_case.execute(h.capture_id.upper())
            deleting = asyncio.create_task(client.delete(f"/v2/ingestions/{h.ingestion_id}"))
            await checkpoint()
            assert not deleting.done() and h.source.exists()
            h.extractor.allow_stop.set()
            assert (await deleting).status_code == 204
            assert h.extractor.stopped.is_set() and not h.source.exists()
        await h.service.delete_capture(h.capture_id)
        await h.service.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize("kind", ["capture", "ingestion"])
def test_cancelled_delete_request_never_deletes_later(tmp_path: Path, kind: str) -> None:
    async def scenario() -> None:
        h = Harness(tmp_path)
        await h.extractor.started.wait()
        if kind == "ingestion":
            h.service.cancel_capture_use_case.execute(h.capture_id)
        deleting = asyncio.create_task(
            h.service.delete_capture(h.capture_id)
            if kind == "capture"
            else h.service.delete_ingestion(h.ingestion_id)
        )
        await h.extractor.stopping.wait()
        deleting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await deleting
        assert h.source.exists()
        h.extractor.allow_stop.set()
        await asyncio.wait({h.task})
        await checkpoint()
        assert h.source.exists()
        assert h.repository.get_capture(h.capture_id)
        await h.service.delete_capture(h.capture_id)
        assert not h.source.exists()
        await h.service.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize("concurrent", ["shutdown", "delete"])
def test_shutdown_joins_worker_despite_other_requests(tmp_path: Path, concurrent: str) -> None:
    async def scenario() -> None:
        h = Harness(tmp_path)
        await h.extractor.started.wait()
        closing = asyncio.create_task(h.service.close())
        await h.extractor.stopping.wait()
        other = asyncio.create_task(
            h.service.close()
            if concurrent == "shutdown"
            else h.service.delete_capture(h.capture_id.upper())
        )
        await checkpoint()
        assert not closing.done() and not other.done() and h.source.exists()
        h.extractor.allow_stop.set()
        await asyncio.gather(closing, other)
        assert h.extractor.stopped.is_set() and not h.service._tasks
        if concurrent == "shutdown":
            await h.service.delete_capture(h.capture_id)
        assert not h.source.exists()

    asyncio.run(scenario())


def test_prune_and_reinitialize_clear_live_task_protection(tmp_path: Path) -> None:
    async def scenario() -> None:
        h = Harness(tmp_path)
        await h.extractor.started.wait()
        h.clock.current += timedelta(hours=5)
        h.service.cancel_capture_use_case.execute(h.capture_id)
        await h.extractor.stopping.wait()
        h.repository.prune_expired()
        assert h.source.exists()
        assert h.repository.get_capture(h.capture_id)
        h.extractor.allow_stop.set()
        await asyncio.wait({h.task})
        await checkpoint()
        # Start a retention interval after the final cancellation event.
        h.clock.current += timedelta(hours=5)
        h.repository.prune_expired()
        assert not h.source.exists()
        with pytest.raises(StreamingRecordNotFoundError):
            h.repository.get_capture(h.capture_id)
        h.repository._running_captures.add(h.capture_id)
        h.repository.initialize()
        assert not h.repository._running_captures
        await h.service.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize("stage", ["speech", "diarization"])
def test_extraction_joins_worker_after_repeated_cancellation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stage: str
) -> None:
    from capture_runtime.capture.infrastructure.capture_extraction import (
        StandaloneRuntimeCaptureExtractor,
    )
    from capture_runtime.config import ExtractionRuntimeConfig
    from capture_runtime.provisioning.infrastructure.engine_installation import (
        EngineInstallationManager,
    )
    from capture_runtime.worker_client import InstalledEngine
    from capture_runtime.worker_process import WorkerCancelledError
    from tests.unit.test_speaker_extraction import _WorkerClient

    async def scenario() -> None:
        source = tmp_path / "source.bin"
        source.write_bytes(AUDIO)
        started, stopping, release, stopped = (asyncio.Event() for _ in range(4))
        cancellation = asyncio.Event()

        async def held(self: Any, engine: Any, **kwargs: Any) -> Any:
            assert kwargs["source_path"] == source
            started.set()
            try:
                await kwargs["cancel_event"].wait()
                raise WorkerCancelledError
            finally:
                stopping.set()
                await asyncio.wait_for(release.wait(), timeout=3)
                assert source.exists()
                stopped.set()

        monkeypatch.setattr(_WorkerClient, "run" if stage == "speech" else "diarize", held)

        async def resolve(requirement_id: str) -> InstalledEngine:
            return InstalledEngine(
                requirement_id=requirement_id,
                artifact_version="fixture",
                executable=tmp_path / "worker",
                model_dir=tmp_path / "model",
            )

        extractor = StandaloneRuntimeCaptureExtractor(
            FixedClock(),
            ExtractionRuntimeConfig(
                windowsml_model_dir=tmp_path / "ocr",
                whisper_models_dir=tmp_path / "asr",
                temp_dir=tmp_path / "temp",
                max_pdf_pages=10,
                max_image_pixels=100000,
                ocr_render_scale=2,
                max_audio_duration_ms=60000,
                whisper_prefer_gpu=False,
            ),
            engine_manager=cast(
                EngineInstallationManager,
                SimpleNamespace(
                    resolve_active_engine=resolve,
                    worker_client=_WorkerClient(),
                ),
            ),
        )
        task = asyncio.create_task(
            extractor.extract(
                source,
                CaptureSource(
                    sha256="0" * 64, file_name="fixture", media_type="audio/wav", bytes=len(AUDIO)
                ),
                cancellation,
                identify_speakers=True,
            )
        )
        await started.wait()
        task.cancel()
        await stopping.wait()
        task.cancel()
        await checkpoint()
        task.cancel()
        await checkpoint()
        assert cancellation.is_set() and not stopped.is_set()
        assert not task.done() and source.exists()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert stopped.is_set() and source.exists()
        assert not (tmp_path / "temp").exists()

    asyncio.run(scenario())


@pytest.mark.parametrize("persistent", [False, True])
def test_worker_process_termination_survives_repeated_cancellation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, persistent: bool
) -> None:
    from capture_runtime.worker_process import WorkerProcess

    async def scenario() -> None:
        owner = WorkerProcess()
        executable = tmp_path / "synthetic-worker"
        executable.write_bytes(b"fixture")
        started, stopping, release, stopped = (asyncio.Event() for _ in range(4))
        output = asyncio.StreamReader()
        stderr = asyncio.StreamReader()
        stderr.feed_eof()
        forever = asyncio.Event()
        stops: list[int] = []

        class Input:
            def write(self, payload: bytes) -> None:
                started.set()

            async def drain(self) -> None:
                pass

            def close(self) -> None:
                pass

        async def wait() -> int:
            await forever.wait()
            return 0

        async def spawn(path: Path) -> Any:
            owner._active.add(process)
            return process

        async def stop(child: Any, *, initial_grace: float) -> None:
            stops.append(child.pid)
            stopping.set()
            await asyncio.wait_for(release.wait(), timeout=3)
            child.returncode = 0
            stopped.set()

        class Process:
            stdin = Input()
            stdout = output
            returncode: int | None = None
            pid = 1

            async def wait(self) -> int:
                return await wait()

        process = Process()
        process.stderr = stderr
        monkeypatch.setattr(owner, "_spawn", spawn)
        monkeypatch.setattr(owner, "_stop", stop)
        if persistent:
            task = asyncio.create_task(
                owner.request_warm(executable, "run", {}, idle_seconds=0, timeout_seconds=60)
            )
        else:
            task = asyncio.create_task(owner.request(executable, "run", {}, timeout_seconds=60))
        await started.wait()
        task.cancel()
        await stopping.wait()
        task.cancel()
        await checkpoint()
        task.cancel()
        await checkpoint()
        assert not task.done() and not stopped.is_set()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert stopped.is_set() and stops == [1]
        assert not owner._active

    asyncio.run(scenario())


def test_an_abandoned_delete_leaves_a_cancelled_capture_that_can_be_deleted(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        h = Harness(tmp_path)
        await h.extractor.started.wait()
        deleting = asyncio.create_task(h.service.delete_capture(h.capture_id))
        await h.extractor.stopping.wait()

        # The client goes away while the DELETE waits for the worker.
        deleting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await deleting

        # Nothing was deleted, and the capture is terminal, not stuck in progress.
        assert h.repository.get_capture(h.capture_id).status is StreamingCaptureStatus.CANCELLED
        assert h.source.exists()

        h.extractor.allow_stop.set()
        await asyncio.wait({h.task})
        await checkpoint()
        assert not h.repository.has_active_capture()

        await h.service.delete_capture(h.capture_id)
        with pytest.raises(StreamingRecordNotFoundError):
            h.repository.get_capture(h.capture_id)
        assert not h.source.exists()

    asyncio.run(scenario())


def test_a_capture_cancelled_while_a_warm_worker_retires_stays_joined_to_it(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        extractor = RetiringExtractor()
        h = Harness(tmp_path, extractor)
        await extractor.retiring.wait()

        h.service.cancel_capture_use_case.execute(h.capture_id)
        await checkpoint()
        # The retirement is still running, so the capture task has not ended.
        assert not h.task.done()
        assert extractor.order == []

        extractor.allow_retire.set()
        await asyncio.wait({h.task})
        assert extractor.order == ["warm-worker-retired"]
        assert not extractor.started.is_set()

    asyncio.run(scenario())
