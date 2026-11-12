from __future__ import annotations

import asyncio
import wave
from contextlib import contextmanager
from datetime import timedelta
from pathlib import Path
from threading import Event
from typing import Any

import pytest

from capture_runtime.capture.application.streaming_capture_service import StreamingCaptureService
from capture_runtime.capture.domain.size_policy import DOCUMENT_MAX_UPLOAD_BYTES, SourceSizePolicy
from capture_runtime.capture.infrastructure.audio_run_timeout import audio_run_timeout_seconds
from capture_runtime.capture.infrastructure.capture_extraction import (
    StandaloneRuntimeCaptureExtractor,
)
from capture_runtime.capture.infrastructure.source_sniffing import SNIFF_BYTES, sniff_source
from capture_runtime.capture.infrastructure.streaming_repository import (
    StreamingRepository,
    StreamingTransitionError,
)
from capture_runtime.contracts import StartCaptureV2, StructuringMode
from capture_runtime.diarization.infrastructure.speaker_diarization import decode_mono_16k
from capture_runtime.structuring.infrastructure.structuring_provider import (
    FakeCaptureStructuringProvider,
)
from capture_runtime.worker_contracts import WorkerRequest
from capture_runtime.worker_process import DEFAULT_RUN_TIMEOUT_SECONDS
from capture_runtime.workers import diarization_main, ocr_main, speech_recognition_main
from tests.integration.test_streaming_progressive import FixedClock, _open
from tests.unit.test_speaker_extraction import AUDIO, _extract


def test_both_workers_borrow_the_same_recording_without_a_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from tests.unit.test_speaker_extraction import _WorkerClient

    original = StandaloneRuntimeCaptureExtractor.extract
    original_run = _WorkerClient.run
    speech_paths: list[Path] = []
    timeout_paths: list[Path] = []

    def timeout(source: Path, limit: int) -> float:
        timeout_paths.append(source)
        return 1234.0

    async def run(self: Any, *args: Any, **kwargs: Any) -> Any:
        speech_paths.append(kwargs["source_path"])
        assert kwargs["source_path"].exists()
        return await original_run(self, *args, **kwargs)

    paths: list[Path] = []

    async def extract(self: Any, content: bytes, *args: Any, **kwargs: Any) -> Any:
        source = tmp_path / "ingestion.bin"
        source.write_bytes(content)
        paths.append(source)
        return await original(self, source, *args, **kwargs)

    def no_copy(*args: Any, **kwargs: Any) -> Path:
        raise AssertionError("Recording must not be copied")

    monkeypatch.setattr(
        "capture_runtime.capture.infrastructure.capture_extraction.audio_run_timeout_seconds",
        timeout,
    )
    monkeypatch.setattr(_WorkerClient, "run", run)
    monkeypatch.setattr(StandaloneRuntimeCaptureExtractor, "extract", extract)
    monkeypatch.setattr(StandaloneRuntimeCaptureExtractor, "_worker_source", no_copy)
    raw, client = _extract(
        tmp_path, installed={"speech-recognition", "speaker-diarization"}, identify_speakers=True
    )
    assert len(raw.speakers) == 2
    assert client.sources == speech_paths == paths
    assert timeout_paths == paths * 2
    assert paths[0].exists()
    assert not (tmp_path / "temp").exists()


@pytest.mark.parametrize("ending", ["success", "failure", "cancel", "delete"])
def test_service_keeps_ingestion_until_extraction_stops(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, ending: str
) -> None:
    async def scenario() -> None:
        clock = FixedClock()
        policy = SourceSizePolicy(DOCUMENT_MAX_UPLOAD_BYTES)
        repository = StreamingRepository(
            tmp_path / "streaming", clock=clock, retention_hours=4, policy=policy
        )
        repository.initialize()
        ingestion_id, _ = _open(repository, source=AUDIO)
        source_path = repository.source_path(ingestion_id)
        entered = asyncio.Event()
        finish = asyncio.Event()

        class Extractor:
            sniff = staticmethod(sniff_source)

            async def extract(self, content: Any, *args: Any, **kwargs: Any) -> Any:
                assert content == source_path
                assert content.exists()
                entered.set()
                try:
                    await finish.wait()
                    if ending == "failure":
                        raise ValueError("Synthetic worker failure")
                    # The existing synthetic processor supplies a valid raw outcome.
                    from capture_runtime.capture.infrastructure.capture_extraction import (
                        CaptureExtractionOutcome,
                    )
                    from tests.integration.test_streaming_progressive import (
                        FakeProgressiveProcessor,
                    )

                    processor = FakeProgressiveProcessor(clock)

                    async def sink(*values: Any) -> None:
                        pass

                    raw = await processor.process(
                        capture_id="fixture",
                        source_path=source_path,
                        source=args[0],
                        cancellation=asyncio.Event(),
                        sink=sink,
                    )
                    return CaptureExtractionOutcome(raw=raw)
                finally:
                    assert source_path.exists()

        original_read_bytes = Path.read_bytes
        original_open = Path.open
        reads: list[int] = []

        @contextmanager
        def bounded_open(self: Path, *args: Any, **kwargs: Any) -> Any:
            with original_open(self, *args, **kwargs) as opened:
                if self != source_path:
                    yield opened
                    return

                class PrefixReader:
                    def read(self, size: int = -1) -> bytes:
                        assert size == SNIFF_BYTES
                        reads.append(size)
                        return opened.read(size)

                yield PrefixReader()

        def no_read_bytes(self: Path) -> bytes:
            if self == source_path:
                raise AssertionError("Runtime must not read the complete source")
            return original_read_bytes(self)

        monkeypatch.setattr(Path, "read_bytes", no_read_bytes)
        monkeypatch.setattr(Path, "open", bounded_open)
        service = StreamingCaptureService(
            repository,
            clock=clock,
            policy=policy,
            extractor=Extractor(),
            structurer=FakeCaptureStructuringProvider(clock),
        )
        operation = service.start_capture_use_case.execute(
            StartCaptureV2(
                client_request_id="speaker-capture",
                ingestion_id=ingestion_id,
                identify_speakers=True,
                structuring_mode=StructuringMode.RUNTIME,
            )
        )
        await asyncio.wait_for(entered.wait(), 2)
        task = service._tasks[operation.capture_id]
        assert reads == [SNIFF_BYTES]
        # Expire both ingestion and capture while extraction still owns the file.
        clock.current += timedelta(hours=5)
        repository.prune_expired()
        assert repository.source_path(ingestion_id) == source_path
        if ending == "cancel":
            service.cancel_capture_use_case.execute(operation.capture_id)
            repository.prune_expired()
            with pytest.raises(StreamingTransitionError):
                repository.delete_ingestion(ingestion_id)
        elif ending == "delete":
            deleting = asyncio.create_task(service.delete_capture(operation.capture_id))
            await asyncio.sleep(0)
        assert source_path.exists()
        finish.set()
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.sleep(0)
        if ending == "success":
            assert service.get_capture(operation.capture_id).status.value == "completed"
        if ending == "failure":
            assert service.get_capture(operation.capture_id).status.value == "failed"
        if ending != "delete":
            await service.delete_capture(operation.capture_id)
        else:
            await deleting
        assert not source_path.exists()
        await service.shutdown()

    asyncio.run(scenario())


def test_timeout_probes_recording_path(tmp_path: Path) -> None:
    source = tmp_path / "audio.wav"
    with wave.open(str(source), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(bytes(32000))
    assert audio_run_timeout_seconds(source, 60000) == DEFAULT_RUN_TIMEOUT_SECONDS + 1


@pytest.mark.parametrize("extra_samples", [0, 1])
def test_diarization_exact_sample_budget(tmp_path: Path, extra_samples: int) -> None:
    source = tmp_path / "audio.wav"
    with wave.open(str(source), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(bytes((16000 + extra_samples) * 2))
    if extra_samples:
        with pytest.raises(ValueError, match="duration exceeds"):
            decode_mono_16k(source, max_duration_ms=1000, should_cancel=lambda: False)
    else:
        assert (
            len(decode_mono_16k(source, max_duration_ms=1000, should_cancel=lambda: False)) == 32000
        )


@pytest.mark.parametrize("worker", [speech_recognition_main, diarization_main])
@pytest.mark.parametrize("size", [0, 7, 8, 9])
def test_recording_worker_size_guard(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, worker: Any, size: int
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(bytes(size))
    model = tmp_path / "model"
    model.mkdir()
    monkeypatch.setattr(worker, "RECORDING_MAX_SOURCE_BYTES", 8)

    def accepted(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("Accepted by source and option guards")

    adapter = "TeaAsrAdapter" if worker is speech_recognition_main else "NemotronDiarizationAdapter"
    monkeypatch.setattr(worker, adapter, accepted)
    request = WorkerRequest(
        request_id="size",
        operation="run",
        payload={
            "requirementId": "speech-recognition"
            if worker is speech_recognition_main
            else "speaker-diarization",
            "artifactVersion": "fixture",
            "modelPath": str(model),
            "sourcePath": str(source),
            "mediaType": "audio/wav",
            "options": {"maxDurationMs": 60000, "preferGpu": False},
        },
    )
    if size == 0 or size > 8:
        with pytest.raises(ValueError, match="paths/options"):
            worker._run(request, Event())
    else:
        with pytest.raises(RuntimeError, match="Accepted by source and option guards"):
            worker._run(request, Event())


def test_ocr_retains_document_ceiling(tmp_path: Path) -> None:
    source = tmp_path / "source.bin"
    with source.open("wb") as output:
        output.seek(50 * 1024 * 1024)
        output.write(b"x")
    model = tmp_path / "model"
    model.mkdir()
    request = WorkerRequest(
        request_id="size",
        operation="run",
        payload={
            "requirementId": "windowsml-ocr",
            "artifactVersion": "fixture",
            "modelPath": str(model),
            "sourcePath": str(source),
            "mediaType": "image/png",
            "options": {},
        },
    )
    with pytest.raises(ValueError, match="sourcePath is invalid"):
        ocr_main._run(request, Event())


@pytest.mark.parametrize("budget_ms", [2, 4])
def test_diarization_consumes_frames_lazily(
    monkeypatch: pytest.MonkeyPatch, budget_ms: int
) -> None:
    from contextlib import contextmanager
    from types import SimpleNamespace

    import av
    import av.audio.resampler

    consumed: list[int] = []

    def frames() -> Any:
        for index in range(4):
            assert len(consumed) == index
            yield SimpleNamespace(samples=16, planes=[bytes(32)], index=index)

    class Resampler:
        def __init__(self, **kwargs: Any) -> None:
            pass

        def resample(self, frame: Any) -> list[Any]:
            if frame is None:
                return []
            consumed.append(frame.index)
            return [frame]

    @contextmanager
    def container(*args: Any, **kwargs: Any) -> Any:
        yield SimpleNamespace(streams=[SimpleNamespace(type="audio")], decode=lambda _: frames())

    monkeypatch.setattr(av, "open", container)
    monkeypatch.setattr(av.audio.resampler, "AudioResampler", Resampler)
    if budget_ms == 2:
        with pytest.raises(ValueError, match="duration exceeds"):
            decode_mono_16k(
                Path("synthetic"), max_duration_ms=budget_ms, should_cancel=lambda: False
            )
        assert consumed == [0, 1, 2]
    else:
        pcm = decode_mono_16k(
            Path("synthetic"), max_duration_ms=budget_ms, should_cancel=lambda: False
        )
        assert len(pcm) == 128
        assert consumed == [0, 1, 2, 3]
