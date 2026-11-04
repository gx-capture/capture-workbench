"""The runtime's worker client: one process, and each engine's own run."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path

from capture_runtime._worker_payloads import WorkerRunResult
from capture_runtime.ocr_worker_run import OcrWorkerMethods
from capture_runtime.speaker_worker_result import SpeakerWorkerMethods
from capture_runtime.speech_worker_result import SpeechWorkerMethods
from capture_runtime.worker_client import InstalledEngine
from capture_runtime.worker_client import WorkerClient as KernelWorkerClient
from capture_runtime.worker_process import DEFAULT_RUN_TIMEOUT_SECONDS


class WorkerClient(OcrWorkerMethods, SpeechWorkerMethods, SpeakerWorkerMethods, KernelWorkerClient):
    async def run(
        self,
        engine: InstalledEngine,
        *,
        source_path: Path,
        media_type: str,
        options: dict[str, object],
        cancel_event: asyncio.Event,
        timeout_seconds: float = DEFAULT_RUN_TIMEOUT_SECONDS,
        ocr_progress: Callable[[int, int], None] | None = None,
        on_permille: Callable[[int], None] | None = None,
        vertical_reader_dir: Path | None = None,
    ) -> WorkerRunResult:
        if engine.requirement_id == "windowsml-ocr":
            return await self.run_ocr(
                engine,
                source_path=source_path,
                media_type=media_type,
                options=options,
                cancel_event=cancel_event,
                timeout_seconds=timeout_seconds,
                ocr_progress=ocr_progress,
                on_permille=on_permille,
                vertical_reader_dir=vertical_reader_dir,
            )
        return await SpeechWorkerMethods.run(
            self,
            engine,
            source_path=source_path,
            media_type=media_type,
            options=options,
            cancel_event=cancel_event,
            timeout_seconds=timeout_seconds,
            ocr_progress=ocr_progress,
            on_permille=on_permille,
            vertical_reader_dir=vertical_reader_dir,
        )
