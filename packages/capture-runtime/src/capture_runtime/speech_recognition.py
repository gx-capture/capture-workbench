"""Local TEA-ASR recognition and Qwen forced alignment in the speech worker.

The loader and splitting/alignment algorithms follow the tested transcript-workbench
adapter. Heavy dependencies stay lazy and all pretrained paths are installed assets.
"""

from __future__ import annotations

import gc
import importlib.util
import itertools
import threading
import time
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any, cast

from capture_runtime.engine_adapters import (
    EngineProbe,
    EngineRuntimeUnavailableError,
    WhisperTextSegment,
    WhisperTranscriptionResult,
    WhisperWord,
    _directory_digest,
)
from capture_runtime.worker_stage_policy import (
    sanitize_worker_stage,
    speech_model_load_stage,
    speech_output_stage,
    speech_stage,
)

SAMPLE_RATE = 16_000
ASR_CHUNK_SECONDS = 30
RETRY_MIN_SECONDS = 5
# A generation whose last LOOP_REPEATS patterns of up to LOOP_MAX_PERIOD tokens are the
# same is stopped and treated as reaching the length limit. Greedy decoding that starts
# repeating keeps on until the limit: 0.7.1 generated one character 564 times (20 s) for
# a 25 s chunk before halving it. The parsed transcript already collapses a character
# repeated over 20 times, or a pattern repeated 20 times, to one, so stopping later than
# that changes when the chunk is halved, not what it reads.
LOOP_REPEATS = 32
LOOP_MAX_PERIOD = 16
SENTENCE_ENDINGS = ("。", "！", "？", "!", "?", "；", ";", "…", ".")
ASR_KEY_MAPPING = {
    r"^thinker\.audio_tower\.proj1\.": "model.multi_modal_projector.linear_1.",
    r"^thinker\.audio_tower\.proj2\.": "model.multi_modal_projector.linear_2.",
    r"^thinker\.audio_tower\.": "model.audio_tower.",
    r"^thinker\.model\.": "model.language_model.",
}
CHECKPOINT_FILES = (
    "model.safetensors",
    "generation_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "added_tokens.json",
)
ARCHITECTURE_FILES = (
    "config.json",
    "processor_config.json",
    "chat_template.jinja",
    "tokenizer.json",
    "tokenizer_config.json",
)
ALIGNER_FILES = (*ARCHITECTURE_FILES, "model.safetensors")
LOCAL_OPTIONS = {"local_files_only": True, "trust_remote_code": False}


class _CleanupError(RuntimeError):
    """Resource cleanup cannot authorize repeating successful inference."""


class _ProgressError(RuntimeError):
    """A caller's callback is outside the device failure boundary."""


def _cuda_failure_reason(error: BaseException) -> str | None:
    causes: list[BaseException] = []
    current: BaseException | None = error
    while current is not None and current not in causes:
        if isinstance(current, (InterruptedError, _CleanupError, _ProgressError)):
            return None
        if not isinstance(current, (RuntimeError, OSError)):
            return None
        message = str(current).lower()
        if any(
            phrase in message
            for phrase in (
                "unauthorized",
                "forbidden",
                "authentication",
                "access was denied",
                "local cache",
                "model files",
                "invalid input",
            )
        ):
            return None
        causes.append(current)
        current = current.__cause__
    for cause in causes:
        message = str(cause).lower()
        if type(cause).__name__ == "OutOfMemoryError" or (
            any(name in message for name in ("cuda", "cudnn", "cublas"))
            and any(phrase in message for phrase in ("out of memory", "memory allocation"))
        ):
            return "cuda_out_of_memory"
        if any(
            name in message for name in ("cublas", "cudnn", "cudart", "nvrtc", "nvcuda")
        ) and any(
            phrase in message
            for phrase in (
                "could not load",
                "cannot load",
                "failed to load",
                "unable to load",
                "not found",
                "missing",
                "dll load failed",
                "cannot be loaded",
                "undefined symbol",
            )
        ):
            return "cuda_library_error"
        if any(
            phrase in message
            for phrase in (
                "cuda driver version is insufficient",
                "cuda initialization",
                "cuda error: initialization error",
                "cuda_error_not_initialized",
                "cuda_error_insufficient_driver",
                "cuda_error_no_device",
                "cuda driver initialization failed",
                "found no nvidia driver",
                "no cuda gpus are available",
            )
        ):
            return "cuda_initialization_error"
    return None


def _clear_fallback_error(error: BaseException) -> None:
    pending, seen = [error], set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        pending.extend(
            item for item in (current.__cause__, current.__context__) if item is not None
        )
        current.__traceback__ = current.__cause__ = current.__context__ = None


def _out_of_memory(error: BaseException, torch: Any) -> bool:
    kinds = tuple(
        kind
        for kind in (
            getattr(torch, "OutOfMemoryError", None),
            getattr(torch.cuda, "OutOfMemoryError", None),
        )
        if isinstance(kind, type)
    )
    return bool(kinds) and isinstance(error, kinds)


class _LoopStop:
    """Stopping criterion for one generation: true once its tail repeats one pattern."""

    def __init__(self) -> None:
        self.tokens: list[int] = []
        self.stopped = False

    def __call__(self, input_ids: Any, *_args: Any, **_kwargs: Any) -> bool:
        tokens = self.tokens
        tokens.append(int(input_ids[0, -1]))
        for period in range(1, LOOP_MAX_PERIOD + 1):
            span = period * LOOP_REPEATS
            if len(tokens) < span:
                break
            if (
                tokens[-1] == tokens[-1 - period]
                and tokens[-span:] == tokens[-period:] * LOOP_REPEATS
            ):
                self.stopped = True
                return True
        return False


class _Background:
    """A call on a daemon thread, so a cancelled capture's worker can still exit."""

    def __init__(self, call: Callable[[], Any]) -> None:
        self._result: Any = None
        self._error: BaseException | None = None
        self._thread = threading.Thread(target=self._run, args=(call,), daemon=True)
        self._thread.start()

    def _run(self, call: Callable[[], Any]) -> None:
        try:
            self._result = call()
        except BaseException as error:
            self._error = error

    def result(self) -> Any:
        self._thread.join()
        if self._error is not None:
            raise self._error
        return self._result


def _release(torch: Any, device: str) -> None:
    gc.collect()
    if device == "cuda":
        torch.cuda.empty_cache()


@contextmanager
def _cleanup_on_exit(cleanup: Callable[[], None]) -> Any:
    try:
        yield
    except BaseException:
        try:
            cleanup()
        except BaseException:
            pass
        raise
    else:
        try:
            cleanup()
        except Exception as error:
            raise _CleanupError("Speech model resource cleanup failed") from error


def _asr_dtype(requested: str, device: str, torch: Any) -> str:
    if device == "cpu" and requested == "float16":
        requested = "auto"
    if requested != "auto":
        return requested
    if device == "cuda":
        return "bfloat16" if torch.cuda.is_bf16_supported() else "float16"
    return "float32"


def _quiet_point(audio: Any, left: int, right: int) -> int:
    """Quietest sample of the quietest 100 ms within audio[left:right]."""
    import numpy as np

    window = SAMPLE_RATE // 10
    magnitude = np.abs(audio[left:right])
    sums = np.convolve(magnitude, np.ones(window, dtype=np.float32), mode="valid")
    quiet = int(np.argmin(sums))
    return left + quiet + int(np.argmin(magnitude[quiet : quiet + window]))


def _split_audio(audio: Any) -> list[tuple[int, Any]]:
    """Qwen-ASR quiet-point splitter (Apache-2.0), without gaps or overlap."""
    limit = ASR_CHUNK_SECONDS * SAMPLE_RATE
    if len(audio) <= limit:
        return [(0, audio)]
    expand = 5 * SAMPLE_RATE
    chunks, start = [], 0
    while len(audio) - start > limit:
        cut = start + limit
        boundary = _quiet_point(audio, max(start, cut - expand), min(len(audio), cut + expand))
        boundary = min(max(boundary, start + 1), len(audio))
        chunks.append((start, audio[start:boundary]))
        start = boundary
    chunks.append((start, audio[start:]))
    return chunks


def _halve(audio: Any) -> list[tuple[int, Any]]:
    cut = _quiet_point(audio, len(audio) // 3, 2 * len(audio) // 3)
    return [(0, audio[:cut]), (cut, audio[cut:])]


def _aligned_pieces(text: str, tokens: list[str]) -> list[str]:
    """Reattach punctuation and spaces so aligned pieces reconstruct the transcript."""
    starts, position = [], 0
    for token in tokens:
        for index, char in enumerate(token):
            found = text.find(char, position)
            if found < 0:
                return tokens
            if index == 0:
                starts.append(found)
            position = found + 1
    if not starts:
        return []
    starts[0] = 0
    return [text[start:end] for start, end in zip(starts, [*starts[1:], len(text)], strict=True)]


def _load_asr(
    checkpoint: Path, architecture: Path, transformers: Any, dtype: Any
) -> tuple[Any, Any]:
    processor = transformers.AutoProcessor.from_pretrained(str(architecture), **LOCAL_OPTIONS)
    # AutoTokenizer rebuilds Qwen2 and loses TEA's private-marker deletion decoder.
    processor.tokenizer = transformers.PreTrainedTokenizerFast.from_pretrained(
        str(checkpoint), **LOCAL_OPTIONS
    )
    model = transformers.Qwen3ASRForConditionalGeneration.from_pretrained(
        str(checkpoint),
        config=transformers.AutoConfig.from_pretrained(str(architecture), **LOCAL_OPTIONS),
        key_mapping=ASR_KEY_MAPPING,
        dtype=dtype,
        **LOCAL_OPTIONS,
    )
    return processor, model


def decode_audio(source: Path, *, max_duration_ms: int, should_cancel: Callable[[], bool]) -> Any:
    import av
    import av.audio.resampler
    import numpy as np

    pieces, samples = [], 0
    resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    with av.open(str(source)) as container:
        stream = next((item for item in container.streams if item.type == "audio"), None)
        if stream is None:
            raise ValueError("Source has no audio stream.")
        for frame in itertools.chain(container.decode(stream), [None]):
            if should_cancel():
                raise InterruptedError("Speech recognition was cancelled.")
            for decoded in resampler.resample(cast(Any, frame)) or ():
                piece = decoded.to_ndarray().reshape(-1)
                samples += len(piece)
                if samples * 1000 > max_duration_ms * SAMPLE_RATE:
                    raise ValueError("Audio duration exceeds the configured limit.")
                pieces.append(piece)
    if not pieces:
        raise ValueError("Source has no audio samples.")
    return np.concatenate(pieces).astype(np.float32) / 32768.0


class TeaAsrAdapter:
    """GPU primary / mini CPU fallback, with one retry for classified CUDA errors."""

    def __init__(
        self,
        models_dir: Path,
        *,
        primary_model: str = "primary",
        fallback_model: str = "fallback",
        primary_provenance_model: str = "tea-asr-1.1",
        fallback_provenance_model: str = "tea-asr-1.1-mini",
        prefer_gpu: bool,
        max_duration_ms: int,
        allow_cpu_fallback: bool = True,
        word_timestamps: bool = False,
        torch_module: Any = None,
        transformers_module: Any = None,
        decoder: Callable[..., Any] = decode_audio,
        stage_reporter: Callable[[str], None] | None = None,
        progress_reporter: Callable[[int, int], None] | None = None,
    ) -> None:
        self.models_dir = models_dir.resolve()
        self.primary_model, self.fallback_model = primary_model, fallback_model
        self.primary_provenance_model = primary_provenance_model
        self.fallback_provenance_model = fallback_provenance_model
        self.prefer_gpu, self.allow_cpu_fallback = prefer_gpu, allow_cpu_fallback
        self.max_duration_ms, self.word_timestamps = max_duration_ms, word_timestamps
        # TEA-ASR is a Taiwan Mandarin model; its card recommends forcing Chinese, which also
        # keeps dense Chinese-English code-switching from being translated into English.
        self.language = "zh"
        self._torch, self._transformers = torch_module, transformers_module
        self._decoder, self._stage_reporter = decoder, stage_reporter
        self._progress_reporter = progress_reporter
        # Model digests by model folder. Hashing about 6 GB took 5-7 s after the
        # first capture's alignment, so it runs beside the model load instead.
        self._digests: dict[str, _Background] = {}
        # Loaded models by role, kept for the worker's next window: a streaming
        # capture transcribes 120 s windows, and 0.7.1 reloaded both models for
        # each (about 10 s a window).
        self._models: dict[str, tuple[tuple[str, str, str], Any, Any]] = {}

    def _resident(
        self,
        role: str,
        key: tuple[str, str, str],
        load: Callable[[], tuple[Any, Any]],
        device: str,
        torch: Any,
    ) -> tuple[Any, Any]:
        """Load a model once per worker; drop the other one if both do not fit on the GPU."""

        cached = self._models.get(role)
        if cached is not None and cached[0] == key:
            return cached[1], cached[2]
        self._models.pop(role, None)
        try:
            processor, model = load()
        except Exception as error:
            if device != "cuda" or not self._models or not _out_of_memory(error, torch):
                raise
            self._models.clear()
            _release(torch, device)
            processor, model = load()
        self._models[role] = (key, processor, model)
        return processor, model

    def _model_digest(self, selected: str) -> str:
        paths = sorted(
            str(path.relative_to(self.models_dir).as_posix())
            for folder in (selected, f"{selected}-architecture", "aligner")
            for path in (self.models_dir / folder).rglob("*")
            if path.is_file()
        )
        return _directory_digest(self.models_dir, paths)

    def _report_stage(self, stage: str) -> None:
        safe = sanitize_worker_stage(stage)
        if safe is not None and self._stage_reporter is not None:
            self._stage_reporter(safe)

    def _progress(self, position: int, total: int) -> None:
        if self._progress_reporter is not None:
            try:
                self._progress_reporter(position, total)
            except InterruptedError:
                raise
            except Exception as error:
                raise _ProgressError("Speech progress callback failed") from error

    def probe(self) -> EngineProbe:
        code_ready = (self._torch is not None and self._transformers is not None) or all(
            importlib.util.find_spec(name) is not None
            for name in ("torch", "transformers", "numpy", "librosa", "av")
        )
        required = {
            self.primary_model: CHECKPOINT_FILES,
            self.fallback_model: CHECKPOINT_FILES,
            f"{self.primary_model}-architecture": ARCHITECTURE_FILES,
            f"{self.fallback_model}-architecture": ARCHITECTURE_FILES,
            "aligner": ALIGNER_FILES,
        }
        missing = [
            f"{folder}/{name}"
            for folder, names in required.items()
            for name in names
            if not (self.models_dir / folder / name).is_file()
        ]
        code_detail = None if code_ready else "Missing speech recognition runtime dependencies."
        assets_detail = (
            "Missing local speech model assets: " + ", ".join(missing) if missing else None
        )
        detail = (
            code_detail or assets_detail or "TEA recognizers and Qwen aligner are locally ready."
        )
        return EngineProbe(
            code_ready and not missing,
            code_ready,
            not missing,
            detail,
            code_detail=code_detail,
            assets_detail=assets_detail,
        )

    def _dependencies(self) -> tuple[Any, Any]:
        if self._torch is None:
            import torch

            self._torch = torch
        if self._transformers is None:
            import transformers

            self._transformers = transformers
        return self._torch, self._transformers

    def _cuda_devices(self) -> int:
        torch, _ = self._dependencies()
        return int(torch.cuda.is_available())

    def transcribe(
        self,
        source_path: Path,
        *,
        should_cancel: Callable[[], bool],
        allow_empty_output: bool = False,
    ) -> WhisperTranscriptionResult:
        started = time.perf_counter()
        callback_error: BaseException | None = None
        try:
            result = self._transcribe(
                source_path, should_cancel=should_cancel, allow_empty_output=allow_empty_output
            )
            return replace(result, elapsed_ms=round((time.perf_counter() - started) * 1000))
        except _ProgressError as error:
            callback_error = error.__cause__
        # Preserve the callback's original exception without exposing our retry marker.
        assert callback_error is not None
        raise callback_error

    def _transcribe(
        self,
        source_path: Path,
        *,
        should_cancel: Callable[[], bool],
        allow_empty_output: bool,
    ) -> WhisperTranscriptionResult:
        self._report_stage(speech_stage("assets-probe-start"))
        probe = self.probe()
        if not probe.ready:
            raise EngineRuntimeUnavailableError(probe.detail)
        self._report_stage(speech_stage("assets-probe-complete"))
        if should_cancel():
            raise InterruptedError("Speech recognition was cancelled.")
        torch, transformers = self._dependencies()
        audio = self._decoder(
            source_path, max_duration_ms=self.max_duration_ms, should_cancel=should_cancel
        )
        if len(audio) * 1000 > self.max_duration_ms * SAMPLE_RATE:
            raise ValueError("Audio duration exceeds the configured limit.")
        self._report_stage(speech_stage("device-probe-start"))
        device, warning = "cpu", None
        if self.prefer_gpu:
            try:
                available = bool(self._cuda_devices())
            except Exception as error:
                if not self.allow_cpu_fallback or _cuda_failure_reason(error) is None:
                    raise
                _clear_fallback_error(error)
                available = False
            if available:
                device = "cuda"
            elif not self.allow_cpu_fallback:
                raise EngineRuntimeUnavailableError(
                    "Speech recognition CUDA device is unavailable."
                )
        self._report_stage(speech_stage("device-probe-complete"))
        if device == "cuda":
            try:
                return self._attempt(
                    audio, device, torch, transformers, should_cancel, allow_empty_output, warning
                )
            except Exception as error:
                reason = _cuda_failure_reason(error)
                if not self.allow_cpu_fallback or reason is None:
                    raise
                warning = f"Speech recognition GPU fallback: {type(error).__name__}"
                _clear_fallback_error(error)
                self._models.clear()
                try:
                    _release(torch, device)
                except BaseException:
                    raise error from None
            self._report_stage(speech_stage("gpu-fallback"))
        return self._attempt(
            audio, "cpu", torch, transformers, should_cancel, allow_empty_output, warning
        )

    def _attempt(
        self,
        audio: Any,
        device: str,
        torch: Any,
        transformers: Any,
        should_cancel: Callable[[], bool],
        allow_empty_output: bool,
        warning: str | None,
    ) -> WhisperTranscriptionResult:
        model = inputs = output = generated = None

        def cleanup() -> None:
            nonlocal model, inputs, output, generated
            model = inputs = output = generated = None
            _release(torch, device)

        def check_cancel(*_args: Any, **_kwargs: Any) -> bool:
            if should_cancel():
                raise InterruptedError("Speech recognition was cancelled.")
            return False

        with _cleanup_on_exit(cleanup):
            stage_ms: dict[str, int] = {}
            selected = self.primary_model if device == "cuda" else self.fallback_model
            identity = (
                self.primary_provenance_model
                if device == "cuda"
                else self.fallback_provenance_model
            )
            dtype = getattr(torch, _asr_dtype("auto", device, torch))
            duration_ms = round(len(audio) / SAMPLE_RATE * 1000)
            check_cancel()
            digest_job = self._digests.get(selected)
            if digest_job is None:
                digest_job = self._digests[selected] = _Background(
                    lambda: self._model_digest(selected)
                )
            self._report_stage(speech_model_load_stage(device, "start"))
            started = time.perf_counter()

            def load_recognizer() -> tuple[Any, Any]:
                loaded_processor, loaded = _load_asr(
                    self.models_dir / selected,
                    self.models_dir / f"{selected}-architecture",
                    transformers,
                    dtype,
                )
                loaded.to(torch.device(device))
                return loaded_processor, loaded

            try:
                processor, model = self._resident(
                    "recognizer", (selected, device, str(dtype)), load_recognizer, device, torch
                )
            except Exception as error:
                self._report_stage(speech_model_load_stage(device, "failed", error))
                raise
            stage_ms["modelLoad"] = round((time.perf_counter() - started) * 1000)
            self._report_stage(speech_model_load_stage(device, "complete"))
            started = time.perf_counter()
            pending, pieces, unfinished = _split_audio(audio)[::-1], [], []
            self._report_stage(speech_stage("transcription-call-start"))
            while pending:
                check_cancel()
                start, chunk = pending.pop()
                request = chunk
                if len(chunk) < SAMPLE_RATE // 2:
                    import numpy as np

                    request = np.pad(chunk, (0, SAMPLE_RATE // 2 - len(chunk)))
                inputs = processor.apply_transcription_request(
                    audio=request, language=self.language
                ).to(torch.device(device), dtype)
                limit = int(len(request) / SAMPLE_RATE * 20) + 64
                loop = _LoopStop()
                with torch.inference_mode():
                    output = model.generate(
                        **inputs,
                        do_sample=False,
                        max_new_tokens=limit,
                        stopping_criteria=transformers.StoppingCriteriaList([check_cancel, loop]),
                    )
                check_cancel()
                generated = output[:, inputs["input_ids"].shape[1] :]
                if generated.shape[1] >= limit or loop.stopped:
                    if len(chunk) >= 2 * RETRY_MIN_SECONDS * SAMPLE_RATE:
                        pending.extend(
                            [(start + offset, half) for offset, half in _halve(chunk)][::-1]
                        )
                        continue
                    unfinished.append(start / SAMPLE_RATE)
                pieces.append(
                    (start, chunk, processor.decode(generated, return_format="parsed")[0])
                )
                self._progress(round((start + len(chunk)) / SAMPLE_RATE * 500), duration_ms)
            stage_ms["transcription"] = round((time.perf_counter() - started) * 1000)
            self._report_stage(speech_stage("transcription-call-complete"))
            # Release this window's inputs and token tensor before alignment. The
            # recognizer stays loaded unless the aligner needs its GPU memory.
            try:
                cleanup()
            except Exception as error:
                raise _CleanupError("Speech model resource cleanup failed") from error
            check_cancel()
            started = time.perf_counter()
            aligner_dir = str(self.models_dir / "aligner")

            def load_aligner() -> tuple[Any, Any]:
                loaded_processor = transformers.AutoProcessor.from_pretrained(
                    aligner_dir, **LOCAL_OPTIONS
                )
                loaded = transformers.Qwen3ASRForTokenClassification.from_pretrained(
                    aligner_dir, dtype=dtype, **LOCAL_OPTIONS
                )
                loaded.to(torch.device(device))
                return loaded_processor, loaded

            aligner, model = self._resident(
                "aligner", ("aligner", device, str(dtype)), load_aligner, device, torch
            )
            stage_ms["alignerLoad"] = round((time.perf_counter() - started) * 1000)
            started = time.perf_counter()
            segments: list[WhisperTextSegment] = []
            self._report_stage(speech_stage("transcription-iteration-start"))
            for start, chunk, result in pieces:
                check_cancel()
                text = result["transcription"].strip()
                if not text:
                    continue
                language = self.language or result["language"]
                offset, chunk_end = start / SAMPLE_RATE, (start + len(chunk)) / SAMPLE_RATE
                inputs, word_lists = aligner.prepare_forced_aligner_inputs(
                    audio=chunk, transcript=text, language=language
                )
                inputs = inputs.to(torch.device(device), dtype)
                with torch.inference_mode():
                    output = model(**inputs)
                check_cancel()
                items = aligner.decode_forced_alignment(
                    logits=output.logits,
                    input_ids=inputs["input_ids"],
                    word_lists=word_lists,
                    timestamp_token_id=model.config.timestamp_token_id,
                )[0]
                if not items:
                    raise ValueError("Speech recognition returned speech without word timestamps.")
                aligned = _aligned_pieces(text, [item["text"] for item in items])
                sentence: list[WhisperWord] = []
                for index, (item, piece) in enumerate(zip(items, aligned, strict=True)):
                    begin = min(offset + item["start_time"], chunk_end)
                    end = min(offset + item["end_time"], chunk_end)
                    sentence.append(
                        WhisperWord(round(begin * 1000), round(max(begin, end) * 1000), piece)
                    )
                    if piece.rstrip().endswith(SENTENCE_ENDINGS) or index == len(items) - 1:
                        segments.append(
                            WhisperTextSegment(
                                sentence[0].start_ms,
                                max(word.end_ms for word in sentence),
                                "".join(word.text for word in sentence).strip(),
                                tuple(sentence) if self.word_timestamps else (),
                            )
                        )
                        sentence = []
                self._progress(round(duration_ms / 2 + chunk_end * 500), duration_ms)
            stage_ms["alignment"] = round((time.perf_counter() - started) * 1000)
            check_cancel()
            if not segments and not allow_empty_output:
                self._report_stage(speech_stage("output-empty"))
                raise ValueError("Speech recognition produced no non-empty segments.")
            self._report_stage(speech_output_stage(bool(segments)))
            if unfinished:
                detail = (
                    f"Speech recognition generation limit reached in {len(unfinished)} chunk(s)."
                )
                warning = f"{warning}; {detail}" if warning else detail
            try:
                digest = digest_job.result()
            except BaseException:
                self._digests.pop(selected, None)
                raise
            return WhisperTranscriptionResult(
                tuple(segments), duration_ms, device, identity, digest, warning, stage_ms=stage_ms
            )
