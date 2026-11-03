"""Internal download transports for engine artifacts and direct model files."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager, contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Protocol
from urllib.parse import urlsplit
from uuid import uuid4

import httpx

from capture_runtime.engine_catalog import (
    EngineArtifactDescriptor,
    EngineArtifactPart,
    EngineModelFileDescriptor,
)

from ._engine_installation_errors import EngineInstallationError
from ._engine_installation_limits import (
    PARALLEL_DOWNLOAD_MIN_BYTES,
    PARALLEL_DOWNLOAD_SEGMENTS,
)

_SMOKE_WORKER_MIRROR_OPT_IN = "CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN"
_SMOKE_WORKER_MIRROR_URL = "CAPTURE_SMOKE_WORKER_MIRROR_URL"
_PDF_OCR_E2E_LOCAL_WORKER_OPT_IN = "CAPTURE_PDF_OCR_E2E_LOCAL_WORKER_OPT_IN"
_PDF_OCR_E2E_LOCAL_WORKER_URL = "CAPTURE_PDF_OCR_E2E_LOCAL_WORKER_URL"
_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN = "CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN"
_PDF_OCR_E2E_LOCAL_MODEL_ROOT = "CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT"


def _facade_download_chunk_bytes() -> int:
    from .engine_installation import DOWNLOAD_CHUNK_BYTES

    return DOWNLOAD_CHUNK_BYTES


def _facade_max_direct_model_redirects() -> int:
    from .engine_installation import MAX_DIRECT_MODEL_REDIRECTS

    return MAX_DIRECT_MODEL_REDIRECTS


def _facade_max_single_model_file_bytes() -> int:
    from ._engine_installation_limits import MAX_SINGLE_MODEL_FILE_BYTES

    return MAX_SINGLE_MODEL_FILE_BYTES


def smoke_worker_mirror_url(environ: dict[str, str] | None = None) -> str | None:
    """Resolve the intentionally narrow pre-release worker mirror override.

    The production catalog remains immutable and model downloads always use the
    catalog's HTTPS URLs.  This opt-in exists solely so the local packaged smoke
    can serve the exact worker bytes before the GitHub release is published.
    """

    source = os.environ if environ is None else environ
    if source.get(_SMOKE_WORKER_MIRROR_OPT_IN, "").strip() != "1":
        return None
    raw = source.get(_SMOKE_WORKER_MIRROR_URL, "").strip()
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError as error:
        raise EngineInstallationError("smoke worker mirror URL is invalid") from error
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or port is None
        or not 1 <= port <= 65535
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise EngineInstallationError("smoke worker mirror must be a numeric loopback HTTP origin")
    return f"http://127.0.0.1:{port}"


def pdf_ocr_e2e_local_worker_url(environ: dict[str, str] | None = None) -> str | None:
    """Resolve the exact OCR worker URL used by the local-package PDF E2E.

    Unlike the general packaged-smoke mirror origin, this test-only contract
    names one complete worker URL. The installer applies it only to the OCR
    requirement and verifies the URL filename against the locked catalog.
    """

    source = os.environ if environ is None else environ
    if source.get(_PDF_OCR_E2E_LOCAL_WORKER_OPT_IN, "").strip() != "1":
        return None
    raw = source.get(_PDF_OCR_E2E_LOCAL_WORKER_URL, "").strip()
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError as error:
        raise EngineInstallationError("PDF OCR E2E local worker URL is invalid") from error
    path_parts = parsed.path.split("/")
    file_name = path_parts[1] if len(path_parts) == 2 else ""
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or port is None
        or not 1 <= port <= 65535
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or not file_name
        or any(
            character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
            for character in file_name
        )
    ):
        raise EngineInstallationError(
            "PDF OCR E2E local worker must be one numeric-loopback HTTP file URL"
        )
    return f"http://127.0.0.1:{port}/{file_name}"


def pdf_ocr_e2e_local_model_root(environ: dict[str, str] | None = None) -> Path | None:
    """Resolve the locked model root used only by the local-package OCR probe.

    The normal installer always uses catalog HTTPS URLs.  This explicit test
    opt-in lets a commit-bound local candidate exercise the freshly built app
    before its derived profile bytes exist at the immutable release source URL.
    The downloader still verifies every copied file against the catalog.
    """

    source = os.environ if environ is None else environ
    if source.get(_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN, "").strip() != "1":
        return None
    raw = source.get(_PDF_OCR_E2E_LOCAL_MODEL_ROOT, "").strip()
    if not raw:
        raise EngineInstallationError("PDF OCR E2E local model root is missing")
    try:
        root = Path(raw).resolve(strict=True)
    except OSError as error:
        raise EngineInstallationError("PDF OCR E2E local model root is unavailable") from error
    if not root.is_dir() or root.is_symlink():
        raise EngineInstallationError("PDF OCR E2E local model root is not a directory")
    return root


# Sidecar updates are throttled so a large fetch does not rewrite the JSON on
# every chunk. Each update follows an fsync of the bytes it describes.
_CHECKPOINT_BYTES = 8 * 1024 * 1024
_SIDECAR_VERSION = 1


class _CorruptDownload(EngineInstallationError):
    """The partial bytes failed an integrity check and must not be resumed."""


@dataclass(frozen=True, slots=True)
class _Wording:
    """Failure messages of one download kind; the installer classifies errors by this text."""

    length_mismatch: str
    length_invalid: str | None
    exceeded: str
    incomplete: str
    checksum: str


_ARTIFACT = _Wording(
    length_mismatch="engine artifact Content-Length does not match catalog",
    length_invalid="engine artifact Content-Length is invalid",
    exceeded="engine artifact exceeded catalog byte count",
    incomplete="engine artifact byte count does not match catalog",
    checksum="engine artifact checksum does not match catalog",
)
_ARTIFACT_PART = _Wording(
    length_mismatch="engine artifact part Content-Length does not match",
    length_invalid=None,
    exceeded="engine artifact part exceeded its byte count",
    incomplete="engine artifact part is incomplete",
    checksum="engine artifact part checksum does not match catalog",
)
_DIRECT_MODEL = _Wording(
    length_mismatch="direct model Content-Length does not match catalog",
    length_invalid="direct model Content-Length is invalid",
    exceeded="direct model file exceeded catalog byte count",
    incomplete="direct model file byte count does not match catalog",
    checksum="direct model file checksum does not match catalog",
)

# Opens one GET with the given extra headers (a Range when resuming).
type _Opener = Callable[[dict[str, str]], AbstractAsyncContextManager[httpx.Response]]


class _Hash(Protocol):
    def update(self, data: bytes) -> None: ...

    def hexdigest(self) -> str: ...


def _new_digest() -> _Hash:
    return hashlib.sha256()


@dataclass(slots=True)
class _Segment:
    start: int
    end: int
    received: int
    # Bytes flushed and fsynced. Only these go into the sidecar: a sibling
    # segment may save it while this one still holds buffered bytes.
    saved: int = 0

    @property
    def length(self) -> int:
        return self.end - self.start + 1

    @property
    def done(self) -> bool:
        return self.received == self.length

    def to_json(self) -> dict[str, object]:
        return {"end": self.end, "received": self.saved, "start": self.start}


@dataclass(slots=True)
class _PartState:
    offset: int
    size: int
    sha256: str
    complete: bool
    ranged: bool | None
    segments: list[_Segment]

    def shape_ok(self) -> bool:
        if self.ranged is None:
            return not self.segments and not self.complete
        if not self.segments:
            return False
        if self.ranged is False and len(self.segments) != 1:
            return False
        if self.complete and not all(segment.done for segment in self.segments):
            return False
        return True

    def to_json(self) -> dict[str, object]:
        return {
            "bytes": self.size,
            "complete": self.complete,
            "offset": self.offset,
            "ranged": self.ranged,
            "segments": [segment.to_json() for segment in self.segments],
            "sha256": self.sha256,
        }


def _split_segments(size: int, count: int) -> list[_Segment]:
    step = -(-size // max(1, count))
    return [
        _Segment(start=start, end=min(start + step, size) - 1, received=0)
        for start in range(0, size, step)
    ]


def _partial_paths(destination: Path) -> tuple[Path, Path]:
    return (
        destination.with_name(destination.name + ".part"),
        destination.with_name(destination.name + ".part.json"),
    )


class _Plan:
    """Durable resume record for one destination.

    Bytes live in `<final>.part`. The sidecar names only ranges that have been
    flushed, so the next attempt can continue from the first missing byte.
    """

    def __init__(
        self,
        *,
        destination: Path,
        part_path: Path,
        sidecar_path: Path,
        sha256: str,
        total_bytes: int,
        preallocated: bool,
        parts: list[_PartState],
    ) -> None:
        self.destination = destination
        self.part_path = part_path
        self.sidecar_path = sidecar_path
        self.sha256 = sha256
        self.total_bytes = total_bytes
        self.preallocated = preallocated
        self.parts = parts

    @classmethod
    def open(
        cls,
        destination: Path,
        *,
        sha256: str,
        size: int,
        parts: tuple[EngineArtifactPart, ...],
    ) -> _Plan:
        part_path, sidecar_path = _partial_paths(destination)
        loaded = _load_plan(destination, part_path, sidecar_path)
        if loaded is not None and loaded.matches(sha256, size, parts) and loaded.file_ok():
            return loaded
        _discard(part_path)
        _discard(sidecar_path)
        return cls(
            destination=destination,
            part_path=part_path,
            sidecar_path=sidecar_path,
            sha256=sha256,
            total_bytes=size,
            preallocated=False,
            parts=[],
        )

    def matches(self, sha256: str, size: int, parts: tuple[EngineArtifactPart, ...]) -> bool:
        if self.sha256 != sha256 or self.total_bytes != size:
            return False
        if parts:
            if not self.preallocated or len(self.parts) != len(parts):
                return False
            offset = 0
            for state, part in zip(self.parts, parts, strict=True):
                same_part = (
                    state.offset == offset
                    and state.size == part.bytes
                    and state.sha256 == part.sha256
                )
                if not same_part or not state.shape_ok():
                    return False
                offset += part.bytes
            return offset == size
        if len(self.parts) != 1:
            return False
        state = self.parts[0]
        same_region = (
            state.offset == 0 and state.size == size and state.sha256 == sha256 and state.shape_ok()
        )
        if not same_region:
            return False
        if state.ranged is True:
            return self.preallocated
        return state.ranged is False and not self.preallocated

    def file_ok(self) -> bool:
        received = self.received_total()
        if self.preallocated:
            try:
                size = self.part_path.stat().st_size if self.part_path.is_file() else -1
            except OSError:
                return False
            return size == self.total_bytes
        if received == 0 and not self.part_path.exists():
            return True
        try:
            file_size = self.part_path.stat().st_size
        except OSError:
            return False
        return received <= file_size <= self.total_bytes

    def received_total(self) -> int:
        return sum(segment.received for part in self.parts for segment in part.segments)

    def fully_present(self) -> bool:
        # Segments tile their parts and parts tile the file, so this means all done.
        return self.received_total() == self.total_bytes

    def is_stream(self) -> bool:
        return len(self.parts) == 1 and self.parts[0].ranged is False

    def is_ranged(self) -> bool:
        return len(self.parts) == 1 and self.parts[0].ranged is True

    def begin_stream(self) -> None:
        self.preallocated = False
        self.parts = [
            _PartState(
                0,
                self.total_bytes,
                self.sha256,
                False,
                False,
                [_Segment(0, self.total_bytes - 1, 0)],
            )
        ]

    def begin_ranges(self, count: int) -> None:
        self.preallocated = True
        self.parts = [
            _PartState(
                0,
                self.total_bytes,
                self.sha256,
                False,
                True,
                _split_segments(self.total_bytes, count),
            )
        ]
        _allocate(self.part_path, self.total_bytes)
        self.save()

    def begin_parts(self, parts: tuple[EngineArtifactPart, ...]) -> None:
        """Lay the published parts out in one preallocated archive; each decides ranges later."""

        offset = 0
        slots: list[_PartState] = []
        for part in parts:
            slots.append(_PartState(offset, part.bytes, part.sha256, False, None, []))
            offset += part.bytes
        self.parts = slots
        self.preallocated = True
        _allocate(self.part_path, self.total_bytes)
        self.save()

    def rewind(self, part: _PartState) -> None:
        """Forget a region the server will not continue; its next write starts over."""

        for segment in part.segments:
            segment.received = segment.saved = 0
        self.save()

    def save(self) -> None:
        payload = {
            "bytes": self.total_bytes,
            "parts": [part.to_json() for part in self.parts],
            "preallocated": self.preallocated,
            "sha256": self.sha256,
            "version": _SIDECAR_VERSION,
        }
        _atomic_write(
            self.sidecar_path,
            json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("ascii"),
        )

    def commit(self) -> None:
        os.replace(self.part_path, self.destination)
        _discard(self.sidecar_path)

    def discard(self) -> None:
        _discard(self.part_path)
        _discard(self.sidecar_path)


def _report(part: _PartState, progress: Callable[[int], None]) -> None:
    progress(part.offset + sum(segment.received for segment in part.segments))


def _load_plan(destination: Path, part_path: Path, sidecar_path: Path) -> _Plan | None:
    try:
        payload: object = json.loads(sidecar_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    parsed = _object_dict(payload)
    if parsed is None or _read_int(parsed, "version") != _SIDECAR_VERSION:
        return None
    sha256 = _read_str(parsed, "sha256")
    size = _read_int(parsed, "bytes")
    preallocated = parsed.get("preallocated")
    raw_parts = parsed.get("parts")
    if sha256 is None or size is None or not isinstance(preallocated, bool) or size < 1:
        return None
    if not isinstance(raw_parts, list):
        return None
    parts: list[_PartState] = []
    for item in raw_parts:
        part = _load_part(item)
        if part is None:
            return None
        parts.append(part)
    return _Plan(
        destination=destination,
        part_path=part_path,
        sidecar_path=sidecar_path,
        sha256=sha256,
        total_bytes=size,
        preallocated=preallocated,
        parts=parts,
    )


def _load_part(value: object) -> _PartState | None:
    payload = _object_dict(value)
    if payload is None:
        return None
    offset = _read_int(payload, "offset")
    size = _read_int(payload, "bytes")
    sha256 = _read_str(payload, "sha256")
    complete = payload.get("complete")
    ranged = payload.get("ranged")
    if (
        offset is None
        or size is None
        or sha256 is None
        or offset < 0
        or size < 1
        or not isinstance(complete, bool)
    ):
        return None
    if ranged is not None and not isinstance(ranged, bool):
        return None
    segments = _load_segments(payload.get("segments"), size)
    if segments is None:
        return None
    part = _PartState(offset, size, sha256, complete, ranged, segments)
    if not part.shape_ok():
        return None
    return part


def _load_segments(value: object, size: int) -> list[_Segment] | None:
    if not isinstance(value, list):
        return None
    segments: list[_Segment] = []
    cursor = 0
    for item in value:
        payload = _object_dict(item)
        if payload is None:
            return None
        start = _read_int(payload, "start")
        end = _read_int(payload, "end")
        received = _read_int(payload, "received")
        if start is None or end is None or received is None:
            return None
        segment = _Segment(start, end, received, saved=received)
        if start != cursor or end < start or end >= size or not 0 <= received <= segment.length:
            return None
        segments.append(segment)
        cursor = end + 1
    if segments and cursor != size:
        return None
    return segments


def _object_dict(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    typed: dict[str, object] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            return None
        typed[key] = item
    return typed


def _read_int(payload: dict[str, object], key: str) -> int | None:
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _read_str(payload: dict[str, object], key: str) -> str | None:
    value = payload.get(key)
    if not isinstance(value, str):
        return None
    return value


def _atomic_write(path: Path, data: bytes) -> None:
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        _discard(temporary)
        raise


def _allocate(path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        handle.truncate(size)
        handle.flush()
        os.fsync(handle.fileno())


def _checkpoint(writer: BinaryIO, plan: _Plan, segment: _Segment) -> None:
    """Make the segment's new bytes durable, then record them in the sidecar."""

    if segment.saved == segment.received:
        return
    writer.flush()
    os.fsync(writer.fileno())
    segment.saved = segment.received
    plan.save()


@contextmanager
def _open_part(plan: _Plan, position: int) -> Iterator[BinaryIO]:
    """Open the partial at `position`; a sequential partial drops its unrecorded tail."""

    if plan.preallocated or plan.part_path.exists():
        handle: BinaryIO = plan.part_path.open("r+b")
    else:
        handle = plan.part_path.open("wb")
    with handle:
        if not plan.preallocated:
            handle.truncate(position)
        handle.seek(position)
        yield handle


def _exact_content_range(response: httpx.Response, start: int, end: int, total: int) -> bool:
    content_range: str | None = response.headers.get("content-range")
    return content_range == f"bytes {start}-{end}/{total}"


def _monotonic(progress: Callable[[int], None]) -> Callable[[int], None]:
    """Report only growth, so a restarted region never moves progress back."""

    seen = 0

    def report(copied: int) -> None:
        nonlocal seen
        if copied > seen:
            seen = copied
            progress(copied)

    return report


def _plain_get(client: httpx.AsyncClient, url: str) -> _Opener:
    return lambda headers: client.stream("GET", url, headers=headers)


def _require_length(response: httpx.Response, expected: int, wording: _Wording) -> None:
    declared = response.headers.get("content-length")
    if declared is None:
        return
    if wording.length_invalid is None:
        if declared != str(expected):
            raise _CorruptDownload(wording.length_mismatch)
        return
    try:
        declared_bytes = int(declared)
    except ValueError as error:
        raise _CorruptDownload(wording.length_invalid) from error
    if declared_bytes != expected:
        raise _CorruptDownload(wording.length_mismatch)


def _digest_prefix(path: Path, count: int, failure: str) -> _Hash:
    digest = _new_digest()
    remaining = count
    with path.open("rb") as reader:
        while remaining:
            chunk = reader.read(min(_facade_download_chunk_bytes(), remaining))
            if not chunk:
                break
            digest.update(chunk)
            remaining -= len(chunk)
    if remaining:
        raise _CorruptDownload(failure)
    return digest


async def _receive(
    response: httpx.Response,
    plan: _Plan,
    part: _PartState,
    segment: _Segment,
    *,
    cancel_event: asyncio.Event,
    progress: Callable[[int], None],
    digest: _Hash | None,
    exceeded: str,
) -> None:
    """Write the body after the segment's received bytes, checkpointing as it goes."""

    with _open_part(plan, part.offset + segment.start + segment.received) as writer:
        try:
            # Unbuffered, so every byte the network delivered reaches the partial.
            async for chunk in response.aiter_bytes():
                if cancel_event.is_set():
                    raise asyncio.CancelledError
                if segment.received + len(chunk) > segment.length:
                    raise _CorruptDownload(exceeded)
                writer.write(chunk)
                if digest is not None:
                    digest.update(chunk)
                segment.received += len(chunk)
                _report(part, progress)
                if segment.received - segment.saved >= _CHECKPOINT_BYTES:
                    _checkpoint(writer, plan, segment)
                if cancel_event.is_set():
                    raise asyncio.CancelledError
        except _CorruptDownload:
            raise
        except BaseException:
            # Cancellation and transport errors keep what arrived for the next attempt.
            with suppress(OSError):
                _checkpoint(writer, plan, segment)
            raise
        _checkpoint(writer, plan, segment)


async def _fill_open_ended(
    open_response: _Opener,
    plan: _Plan,
    part: _PartState,
    *,
    cancel_event: asyncio.Event,
    progress: Callable[[int], None],
    digest: _Hash | None,
    wording: _Wording,
) -> _Hash | None:
    """Stream one region, continuing with `Range: bytes=N-` from the recorded bytes."""

    segment = part.segments[0]
    while not segment.done:
        headers = {"Range": f"bytes={segment.received}-"} if segment.received else {}
        async with open_response(headers) as response:
            if segment.received and not (
                response.status_code == 206
                and _exact_content_range(response, segment.received, part.size - 1, part.size)
            ):
                # Other failures are transient: keep the partial for the next attempt.
                if response.status_code not in {200, 206, 416}:
                    response.raise_for_status()
                # The server did not continue at the first missing byte. A 200
                # body is the whole region; otherwise ask again without Range.
                plan.rewind(part)
                if digest is not None:
                    digest = _new_digest()
                if response.status_code != 200:
                    continue
            response.raise_for_status()
            _require_length(response, part.size - segment.received, wording)
            await _receive(
                response,
                plan,
                part,
                segment,
                cancel_event=cancel_event,
                progress=progress,
                digest=digest,
                exceeded=wording.exceeded,
            )
            break
    if not segment.done:
        raise _CorruptDownload(wording.incomplete)
    return digest


async def _stream_verified(
    open_response: _Opener,
    plan: _Plan,
    *,
    cancel_event: asyncio.Event,
    progress: Callable[[int], None],
    wording: _Wording,
) -> None:
    """Stream the whole file, hashing the bytes already present first."""

    part = plan.parts[0]
    received = part.segments[0].received
    digest = (
        await asyncio.to_thread(_digest_prefix, plan.part_path, received, wording.incomplete)
        if received
        else _new_digest()
    )
    finished = await _fill_open_ended(
        open_response,
        plan,
        part,
        cancel_event=cancel_event,
        progress=progress,
        digest=digest,
        wording=wording,
    )
    if finished is None or finished.hexdigest() != plan.sha256:
        raise _CorruptDownload(wording.checksum)


async def _fill_segment(
    client: httpx.AsyncClient,
    url: str,
    plan: _Plan,
    part: _PartState,
    segment: _Segment,
    *,
    cancel_event: asyncio.Event,
    progress: Callable[[int], None],
) -> None:
    start = segment.start + segment.received
    headers = {"Range": f"bytes={start}-{segment.end}"}
    async with client.stream("GET", url, headers=headers) as response:
        # Status failures are transient: keep the bytes already flushed. A 200,
        # a 416, or a 206 whose Content-Range is not this segment is unusable.
        if response.status_code != 206:
            if response.status_code != 416:
                response.raise_for_status()
            raise _CorruptDownload("engine artifact range response is invalid")
        if not _exact_content_range(response, start, segment.end, part.size):
            raise _CorruptDownload("engine artifact range response is invalid")
        await _receive(
            response,
            plan,
            part,
            segment,
            cancel_event=cancel_event,
            progress=progress,
            digest=None,
            exceeded="engine artifact range exceeded its length",
        )
    if segment.received != segment.length:
        raise _CorruptDownload("engine artifact range is incomplete")


async def _fill_closed_ranges(
    client: httpx.AsyncClient,
    url: str,
    plan: _Plan,
    part: _PartState,
    *,
    cancel_event: asyncio.Event,
    progress: Callable[[int], None],
) -> None:
    tasks = [
        asyncio.create_task(
            _fill_segment(
                client,
                url,
                plan,
                part,
                segment,
                cancel_event=cancel_event,
                progress=progress,
            )
        )
        for segment in part.segments
        if not segment.done
    ]
    if not tasks:
        return
    try:
        await asyncio.gather(*tasks)
    except BaseException:
        # Every segment checkpoints and closes its handle before the caller
        # keeps or discards the partial (an open handle blocks unlink on Windows).
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


async def _verify_part(plan: _Plan, part: _PartState) -> None:
    digest = await asyncio.to_thread(_region_sha256, plan.part_path, part.offset, part.size)
    if digest != part.sha256:
        raise _CorruptDownload(_ARTIFACT_PART.checksum)


def _verify_hashed_file(path: Path, size: int, sha256: str, wording: _Wording) -> None:
    copied, digest = _file_size_and_sha256(path)
    if copied != size:
        raise _CorruptDownload(wording.incomplete)
    if digest != sha256:
        raise _CorruptDownload(wording.checksum)


class ArtifactDownloader(Protocol):
    async def download(
        self,
        descriptor: EngineArtifactDescriptor,
        destination: Path,
        *,
        cancel_event: asyncio.Event,
        progress: Callable[[int], None],
    ) -> None: ...


class ModelFileDownloader(Protocol):
    async def download(
        self,
        descriptor: EngineModelFileDescriptor,
        destination: Path,
        *,
        cancel_event: asyncio.Event,
        progress: Callable[[int], None],
    ) -> None: ...


class HttpArtifactDownloader:
    def __init__(
        self,
        client_factory: Callable[[], httpx.AsyncClient] | None = None,
        *,
        parallel_min_bytes: int = PARALLEL_DOWNLOAD_MIN_BYTES,
        parallel_segments: int = PARALLEL_DOWNLOAD_SEGMENTS,
    ) -> None:
        self._client_factory = client_factory or (
            lambda: httpx.AsyncClient(timeout=120, follow_redirects=True)
        )
        self._parallel_min_bytes = parallel_min_bytes
        self._parallel_segments = parallel_segments

    async def download(
        self,
        descriptor: EngineArtifactDescriptor,
        destination: Path,
        *,
        cancel_event: asyncio.Event,
        progress: Callable[[int], None],
    ) -> None:
        """Keep `<destination>.part` until the catalog byte count and SHA-256 match."""

        plan = _Plan.open(
            destination,
            sha256=descriptor.sha256,
            size=descriptor.bytes,
            parts=descriptor.parts,
        )
        report = _monotonic(progress)
        report(plan.received_total())
        try:
            streamed = False
            if not plan.fully_present():
                async with self._client_factory() as client:
                    streamed = await self._fetch(
                        client,
                        descriptor,
                        plan,
                        cancel_event=cancel_event,
                        progress=report,
                    )
            if not streamed:
                await asyncio.to_thread(
                    _verify_hashed_file,
                    plan.part_path,
                    descriptor.bytes,
                    descriptor.sha256,
                    _ARTIFACT,
                )
            await asyncio.to_thread(plan.commit)
        except _CorruptDownload:
            plan.discard()
            raise

    async def _fetch(
        self,
        client: httpx.AsyncClient,
        descriptor: EngineArtifactDescriptor,
        plan: _Plan,
        *,
        cancel_event: asyncio.Event,
        progress: Callable[[int], None],
    ) -> bool:
        """Fetch bytes the sidecar still lacks. True when the stream digest was checked."""

        if descriptor.parts:
            await self._download_parts(
                client,
                descriptor,
                plan,
                cancel_event=cancel_event,
                progress=progress,
            )
            return False
        url = descriptor.url
        assert url is not None
        # Release hosts throttle each connection, so large artifacts are
        # fetched as concurrent byte ranges when the server supports them.
        if not plan.is_ranged() and not plan.is_stream():
            if await self._uses_ranges(client, url, descriptor.bytes):
                plan.begin_ranges(self._parallel_segments)
            else:
                plan.begin_stream()
        if plan.is_ranged():
            await _fill_closed_ranges(
                client,
                url,
                plan,
                plan.parts[0],
                cancel_event=cancel_event,
                progress=progress,
            )
            return False
        await _stream_verified(
            _plain_get(client, url),
            plan,
            cancel_event=cancel_event,
            progress=progress,
            wording=_ARTIFACT,
        )
        return True

    async def _uses_ranges(self, client: httpx.AsyncClient, url: str, size: int) -> bool:
        return (
            self._parallel_segments > 1
            and size >= self._parallel_min_bytes
            and await _supports_byte_ranges(client, url, size)
        )

    async def _download_parts(
        self,
        client: httpx.AsyncClient,
        descriptor: EngineArtifactDescriptor,
        plan: _Plan,
        *,
        cancel_event: asyncio.Event,
        progress: Callable[[int], None],
    ) -> None:
        """Write each published part into its place in the whole archive and verify it."""

        if not plan.parts:
            plan.begin_parts(descriptor.parts)
        for part, published in zip(plan.parts, descriptor.parts, strict=True):
            if part.complete:
                continue
            if not part.segments:
                if await self._uses_ranges(client, published.url, published.bytes):
                    part.ranged = True
                    part.segments = _split_segments(published.bytes, self._parallel_segments)
                else:
                    part.ranged = False
                    part.segments = [_Segment(0, published.bytes - 1, 0)]
                plan.save()
            # Both fills skip bytes already recorded, so a part received before
            # an interruption goes straight to verification.
            if part.ranged:
                await _fill_closed_ranges(
                    client,
                    published.url,
                    plan,
                    part,
                    cancel_event=cancel_event,
                    progress=progress,
                )
            else:
                await _fill_open_ended(
                    _plain_get(client, published.url),
                    plan,
                    part,
                    cancel_event=cancel_event,
                    progress=progress,
                    digest=None,
                    wording=_ARTIFACT_PART,
                )
            await _verify_part(plan, part)
            part.complete = True
            plan.save()


def _discard(path: Path) -> None:
    """Remove a partial download; a failure here must not hide why the download failed."""

    with suppress(OSError):
        path.unlink(missing_ok=True)


async def _supports_byte_ranges(client: httpx.AsyncClient, url: str, size: int) -> bool:
    """Probe one byte; any failure falls back to a single sequential stream."""

    try:
        async with client.stream("GET", url, headers={"Range": "bytes=0-0"}) as response:
            if response.status_code != 206:
                return False
            content_range: str | None = response.headers.get("content-range")
            return content_range == f"bytes 0-0/{size}"
    except httpx.HTTPError:
        return False


def _region_sha256(path: Path, offset: int, size: int) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as reader:
        reader.seek(offset)
        remaining = size
        while remaining and (chunk := reader.read(min(_facade_download_chunk_bytes(), remaining))):
            digest.update(chunk)
            remaining -= len(chunk)
    return digest.hexdigest()


def _file_size_and_sha256(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as reader:
        while chunk := reader.read(_facade_download_chunk_bytes()):
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


class LocalModelFileDownloader:
    """Copy exact locked model files from a test-only local source root."""

    def __init__(self, root: Path) -> None:
        try:
            resolved = root.resolve(strict=True)
        except OSError as error:
            raise EngineInstallationError("local OCR model root is unavailable") from error
        if not resolved.is_dir() or resolved.is_symlink():
            raise EngineInstallationError("local OCR model root is not a directory")
        self._root = resolved

    def _source(self, descriptor: EngineModelFileDescriptor) -> Path:
        relative = PurePosixPath(descriptor.path)
        if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
            raise EngineInstallationError("local OCR model path is unsafe")
        source = self._root.joinpath(*relative.parts)
        try:
            resolved = source.resolve(strict=True)
        except OSError as error:
            raise EngineInstallationError("local OCR model file is unavailable") from error
        if source.is_symlink() or resolved != source or not resolved.is_file():
            raise EngineInstallationError("local OCR model file is unsafe")
        return resolved

    async def download(
        self,
        descriptor: EngineModelFileDescriptor,
        destination: Path,
        *,
        cancel_event: asyncio.Event,
        progress: Callable[[int], None],
    ) -> None:
        source = self._source(descriptor)
        copied = 0
        digest = hashlib.sha256()
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            with source.open("rb") as reader, destination.open("xb") as writer:
                while chunk := reader.read(_facade_download_chunk_bytes()):
                    if cancel_event.is_set():
                        raise asyncio.CancelledError
                    copied += len(chunk)
                    if copied > descriptor.bytes:
                        raise EngineInstallationError(
                            "local OCR model file exceeded catalog byte count"
                        )
                    writer.write(chunk)
                    digest.update(chunk)
                    progress(copied)
                writer.flush()
                os.fsync(writer.fileno())
            if copied != descriptor.bytes:
                raise EngineInstallationError(
                    "local OCR model file byte count does not match catalog"
                )
            if digest.hexdigest() != descriptor.sha256:
                raise EngineInstallationError(
                    "local OCR model file checksum does not match catalog"
                )
        except BaseException:
            _discard(destination)
            raise


def validate_direct_model_url(
    descriptor: EngineModelFileDescriptor,
    url: httpx.URL,
    *,
    initial: bool,
) -> None:
    initial_url = httpx.URL(descriptor.url)
    initial_host = (initial_url.host or "").lower()
    allowed_redirect_hosts = set(descriptor.redirect_hosts)
    host = (url.host or "").lower()
    if (
        url.scheme != "https"
        or url.username
        or url.password
        or url.fragment
        or host not in {initial_host, *allowed_redirect_hosts}
        or (url.query and host not in allowed_redirect_hosts)
    ):
        raise EngineInstallationError(
            "direct model redirect is downgraded, credentialed, or outside the lock"
        )
    if initial and str(url) != descriptor.url:
        raise EngineInstallationError("direct model request URL drifted from catalog")


@asynccontextmanager
async def _open_direct_model(
    client: httpx.AsyncClient,
    descriptor: EngineModelFileDescriptor,
    headers: dict[str, str],
) -> AsyncIterator[httpx.Response]:
    """GET the locked URL, validating every redirect hop of every request, resumed or not."""

    current = httpx.URL(descriptor.url)
    validate_direct_model_url(descriptor, current, initial=True)
    limit = _facade_max_direct_model_redirects()
    for redirect_count in range(limit + 1):
        async with client.stream(
            "GET",
            current,
            follow_redirects=False,
            headers={"Accept-Encoding": "identity", **headers},
        ) as response:
            if not 300 <= response.status_code < 400:
                yield response
                return
            if redirect_count == limit:
                raise EngineInstallationError("direct model redirect limit exceeded")
            location = response.headers.get("location")
            if response.status_code not in {301, 302, 303, 307, 308} or location is None:
                raise EngineInstallationError("direct model redirect is missing or unsupported")
            try:
                redirected = response.url.join(location)
            except (httpx.InvalidURL, ValueError) as error:
                raise EngineInstallationError(
                    "direct model redirect Location is invalid"
                ) from error
            validate_direct_model_url(descriptor, redirected, initial=False)
            current = redirected
    raise EngineInstallationError("direct model redirect chain did not terminate")


class HttpModelFileDownloader:
    def __init__(
        self,
        client_factory: Callable[[], httpx.AsyncClient] | None = None,
        *,
        retry_delays: tuple[float, ...] = (0, 1, 2),
    ) -> None:
        if not 1 <= len(retry_delays) <= 5 or any(
            isinstance(delay, bool)
            or not isinstance(delay, (int, float))
            or delay < 0
            or delay > 30
            for delay in retry_delays
        ):
            raise ValueError("direct model retry schedule must be bounded")
        self._client_factory = client_factory or (
            lambda: httpx.AsyncClient(timeout=120, follow_redirects=False)
        )
        self._retry_delays = retry_delays

    async def download(
        self,
        descriptor: EngineModelFileDescriptor,
        destination: Path,
        *,
        cancel_event: asyncio.Event,
        progress: Callable[[int], None],
    ) -> None:
        """Retry from `<destination>.part` instead of deleting it between attempts."""

        if descriptor.bytes > _facade_max_single_model_file_bytes():
            raise EngineInstallationError("direct model file exceeds the 4 GiB single-file limit")
        report = _monotonic(progress)
        last_error: BaseException | None = None
        for delay in self._retry_delays:
            last_error = None
            if cancel_event.is_set():
                raise asyncio.CancelledError
            if delay:
                await asyncio.sleep(delay)
            if cancel_event.is_set():
                raise asyncio.CancelledError
            try:
                await self._download_once(
                    descriptor,
                    destination,
                    cancel_event=cancel_event,
                    progress=report,
                )
                return
            except httpx.HTTPStatusError as error:
                last_error = error
                if error.response.status_code < 500 and error.response.status_code not in {
                    408,
                    429,
                }:
                    raise EngineInstallationError(
                        "direct model source returned a non-retryable response"
                    ) from error
            except httpx.InvalidURL as error:
                raise EngineInstallationError(
                    "direct model redirect Location is invalid"
                ) from error
            except httpx.TransportError as error:
                last_error = error
            except OSError as error:
                # Windows HTTP/file IO can surface a connection abort as a bare
                # OSError. Treat it like the other bounded transport failures;
                # integrity checks still run after a complete retry succeeds.
                last_error = error
        raise EngineInstallationError("direct model download exhausted bounded retries") from (
            last_error
        )

    async def _download_once(
        self,
        descriptor: EngineModelFileDescriptor,
        destination: Path,
        *,
        cancel_event: asyncio.Event,
        progress: Callable[[int], None],
    ) -> None:
        plan = _Plan.open(
            destination,
            sha256=descriptor.sha256,
            size=descriptor.bytes,
            parts=(),
        )
        if not plan.is_stream():
            plan.begin_stream()
        progress(plan.received_total())
        try:
            if plan.fully_present():
                await asyncio.to_thread(
                    _verify_hashed_file,
                    plan.part_path,
                    descriptor.bytes,
                    descriptor.sha256,
                    _DIRECT_MODEL,
                )
            else:
                async with self._client_factory() as client:
                    if "authorization" in client.headers:
                        raise EngineInstallationError(
                            "direct model client must not send authorization material"
                        )
                    await _stream_verified(
                        lambda headers: _open_direct_model(client, descriptor, headers),
                        plan,
                        cancel_event=cancel_event,
                        progress=progress,
                        wording=_DIRECT_MODEL,
                    )
            await asyncio.to_thread(plan.commit)
        except _CorruptDownload:
            plan.discard()
            raise


__all__ = [
    "ArtifactDownloader",
    "HttpArtifactDownloader",
    "HttpModelFileDownloader",
    "LocalModelFileDownloader",
    "ModelFileDownloader",
    "pdf_ocr_e2e_local_model_root",
    "pdf_ocr_e2e_local_worker_url",
    "smoke_worker_mirror_url",
]

ArtifactDownloader.__module__ = "capture_runtime.engine_installation"
ModelFileDownloader.__module__ = "capture_runtime.engine_installation"
HttpArtifactDownloader.__module__ = "capture_runtime.engine_installation"
HttpModelFileDownloader.__module__ = "capture_runtime.engine_installation"
