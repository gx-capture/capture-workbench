"""Internal download transports for engine artifacts and direct model files."""

from __future__ import annotations

import asyncio
import hashlib
import os
from collections.abc import Callable
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit

import httpx

from capture_runtime.engine_catalog import EngineArtifactDescriptor, EngineModelFileDescriptor

from ._engine_installation_errors import EngineInstallationError

_SMOKE_WORKER_MIRROR_OPT_IN = "CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN"
_SMOKE_WORKER_MIRROR_URL = "CAPTURE_SMOKE_WORKER_MIRROR_URL"


def _facade_download_chunk_bytes() -> int:
    from .engine_installation import DOWNLOAD_CHUNK_BYTES

    return DOWNLOAD_CHUNK_BYTES


def _facade_max_direct_model_redirects() -> int:
    from .engine_installation import MAX_DIRECT_MODEL_REDIRECTS

    return MAX_DIRECT_MODEL_REDIRECTS


def _facade_max_single_extracted_file_bytes() -> int:
    from .engine_installation import MAX_SINGLE_EXTRACTED_FILE_BYTES

    return MAX_SINGLE_EXTRACTED_FILE_BYTES


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
    ) -> None:
        self._client_factory = client_factory or (
            lambda: httpx.AsyncClient(timeout=120, follow_redirects=True)
        )

    async def download(
        self,
        descriptor: EngineArtifactDescriptor,
        destination: Path,
        *,
        cancel_event: asyncio.Event,
        progress: Callable[[int], None],
    ) -> None:
        copied = 0
        digest = hashlib.sha256()
        try:
            async with self._client_factory() as client:
                async with client.stream("GET", descriptor.url) as response:
                    response.raise_for_status()
                    declared = response.headers.get("content-length")
                    if declared is not None:
                        try:
                            declared_bytes = int(declared)
                        except ValueError as error:
                            raise EngineInstallationError(
                                "engine artifact Content-Length is invalid"
                            ) from error
                        if declared_bytes != descriptor.bytes:
                            raise EngineInstallationError(
                                "engine artifact Content-Length does not match catalog"
                            )
                    with destination.open("xb") as writer:
                        async for chunk in response.aiter_bytes(_facade_download_chunk_bytes()):
                            if cancel_event.is_set():
                                raise asyncio.CancelledError
                            copied += len(chunk)
                            if copied > descriptor.bytes:
                                raise EngineInstallationError(
                                    "engine artifact exceeded catalog byte count"
                                )
                            writer.write(chunk)
                            digest.update(chunk)
                            progress(copied)
                        writer.flush()
                        os.fsync(writer.fileno())
            if copied != descriptor.bytes:
                raise EngineInstallationError("engine artifact byte count does not match catalog")
            if digest.hexdigest() != descriptor.sha256:
                raise EngineInstallationError("engine artifact checksum does not match catalog")
        except BaseException:
            destination.unlink(missing_ok=True)
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
        if descriptor.bytes > _facade_max_single_extracted_file_bytes():
            raise EngineInstallationError("direct model file exceeds the 2 GiB single-file limit")
        last_error: BaseException | None = None
        for attempt, delay in enumerate(self._retry_delays):
            last_error = None
            destination.unlink(missing_ok=True)
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
                    progress=progress,
                )
                return
            except asyncio.CancelledError:
                raise
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
            except BaseException:
                destination.unlink(missing_ok=True)
                raise
            finally:
                if attempt + 1 == len(self._retry_delays) and last_error is not None:
                    destination.unlink(missing_ok=True)
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
        copied = 0
        digest = hashlib.sha256()
        try:
            async with self._client_factory() as client:
                if "authorization" in client.headers:
                    raise EngineInstallationError(
                        "direct model client must not send authorization material"
                    )
                current = httpx.URL(descriptor.url)
                validate_direct_model_url(descriptor, current, initial=True)
                for redirect_count in range(_facade_max_direct_model_redirects() + 1):
                    async with client.stream(
                        "GET",
                        current,
                        follow_redirects=False,
                        headers={"Accept-Encoding": "identity"},
                    ) as response:
                        if 300 <= response.status_code < 400:
                            if redirect_count == _facade_max_direct_model_redirects():
                                raise EngineInstallationError(
                                    "direct model redirect limit exceeded"
                                )
                            location = response.headers.get("location")
                            if (
                                response.status_code not in {301, 302, 303, 307, 308}
                                or location is None
                            ):
                                raise EngineInstallationError(
                                    "direct model redirect is missing or unsupported"
                                )
                            try:
                                redirected = response.url.join(location)
                            except (httpx.InvalidURL, ValueError) as error:
                                raise EngineInstallationError(
                                    "direct model redirect Location is invalid"
                                ) from error
                            validate_direct_model_url(
                                descriptor,
                                redirected,
                                initial=False,
                            )
                            current = redirected
                            continue
                        response.raise_for_status()
                        declared = response.headers.get("content-length")
                        if declared is not None:
                            try:
                                declared_bytes = int(declared)
                            except ValueError as error:
                                raise EngineInstallationError(
                                    "direct model Content-Length is invalid"
                                ) from error
                            if declared_bytes != descriptor.bytes:
                                raise EngineInstallationError(
                                    "direct model Content-Length does not match catalog"
                                )
                        with destination.open("xb") as writer:
                            async for chunk in response.aiter_bytes(_facade_download_chunk_bytes()):
                                if cancel_event.is_set():
                                    raise asyncio.CancelledError
                                copied += len(chunk)
                                if copied > descriptor.bytes:
                                    raise EngineInstallationError(
                                        "direct model file exceeded catalog byte count"
                                    )
                                writer.write(chunk)
                                digest.update(chunk)
                                progress(copied)
                                if cancel_event.is_set():
                                    raise asyncio.CancelledError
                            writer.flush()
                            os.fsync(writer.fileno())
                        break
                else:
                    raise EngineInstallationError("direct model redirect chain did not terminate")
            if copied != descriptor.bytes:
                raise EngineInstallationError("direct model file byte count does not match catalog")
            if digest.hexdigest() != descriptor.sha256:
                raise EngineInstallationError("direct model file checksum does not match catalog")
        except BaseException:
            destination.unlink(missing_ok=True)
            raise


__all__ = [
    "ArtifactDownloader",
    "HttpArtifactDownloader",
    "HttpModelFileDownloader",
    "ModelFileDownloader",
    "smoke_worker_mirror_url",
]

ArtifactDownloader.__module__ = "capture_runtime.engine_installation"
ModelFileDownloader.__module__ = "capture_runtime.engine_installation"
HttpArtifactDownloader.__module__ = "capture_runtime.engine_installation"
HttpModelFileDownloader.__module__ = "capture_runtime.engine_installation"
