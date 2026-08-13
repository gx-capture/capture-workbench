"""FastAPI application factory for the local Capture Runtime sidecar."""

from __future__ import annotations

import secrets
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, FastAPI, Request, Security
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import Response as StarletteResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from capture_runtime.clock import Clock
from capture_runtime.config import RuntimeSettings
from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.dependencies import RuntimeDependencies, build_runtime_dependencies
from capture_runtime.extractors import CaptureExtractor
from capture_runtime.ollama import ProcessController, RuntimeInstaller
from capture_runtime.routes.capture import register_capture_routes
from capture_runtime.routes.common import ApiProblem, error_response
from capture_runtime.routes.runtime import register_runtime_routes
from capture_runtime.routes.streaming import register_streaming_routes
from capture_runtime.services import InvalidJobStateError, RecordNotFoundError
from capture_runtime.storage import (
    CaptureRepository,
    InstallationRepository,
    ModelInstallationRepository,
    StreamingRecordNotFoundError,
    StreamingTransitionError,
)
from capture_runtime.structuring_provider import CaptureStructuringProvider


class CandidateBodyLimitMiddleware:
    """Enforce the structure-candidate limit even for chunked request bodies."""

    def __init__(self, app: ASGIApp, *, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not _is_candidate_structure_path(
            str(scope.get("path", ""))
        ):
            await self.app(scope, receive, send)
            return
        received = 0
        messages: list[Message] = []
        while True:
            message = await receive()
            messages.append(message)
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    response = error_response(
                        413, "candidate_too_large", "Structured candidate exceeds the size limit."
                    )
                    await response(scope, receive, send)
                    return
                if not message.get("more_body", False):
                    break
            elif message["type"] == "http.disconnect":
                break

        message_index = 0

        async def replay_receive() -> Message:
            nonlocal message_index
            if message_index >= len(messages):
                return {"type": "http.request", "body": b"", "more_body": False}
            message = messages[message_index]
            message_index += 1
            return message

        await self.app(scope, replay_receive, send)


def _is_candidate_structure_path(path: str) -> bool:
    return path.endswith("/structure") or path.endswith("/structure/commit")


def _normalized_authority(value: str) -> str | None:
    try:
        parsed = urlsplit(f"//{value}")
    except ValueError:
        return None
    if parsed.username is not None or parsed.password is not None or parsed.hostname is None:
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    if port is None or parsed.path not in {"", "/"}:
        return None
    return f"{parsed.hostname.lower()}:{port}"


def create_app(
    settings: RuntimeSettings | None = None,
    *,
    clock: Clock | None = None,
    extractor: CaptureExtractor | None = None,
    structurer: CaptureStructuringProvider | None = None,
    installer: RuntimeInstaller | None = None,
    process_controller: ProcessController | None = None,
    dependencies: RuntimeDependencies | None = None,
    capture_repository: CaptureRepository | None = None,
    installation_repository: InstallationRepository | None = None,
    model_installation_repository: ModelInstallationRepository | None = None,
) -> FastAPI:
    """Create one isolated runtime app and its dependency graph.

    ``dependencies`` is an escape hatch for tests and host applications that
    need to provide a complete fake graph. The individual factory arguments
    remain supported for the existing API and are used when no graph is given.
    """

    runtime_settings = settings or RuntimeSettings.from_env()
    runtime_dependencies = dependencies or build_runtime_dependencies(
        runtime_settings,
        clock=clock,
        extractor=extractor,
        structurer=structurer,
        installer=installer,
        process_controller=process_controller,
        capture_repository=capture_repository,
        installation_repository=installation_repository,
        model_installation_repository=model_installation_repository,
    )
    runtime_settings = runtime_dependencies.settings

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        runtime_dependencies.staging_root.mkdir(parents=True, exist_ok=True)
        for abandoned_upload in (
            *runtime_dependencies.staging_root.glob("*.upload"),
            *runtime_dependencies.staging_root.glob("*.spool"),
        ):
            abandoned_upload.unlink(missing_ok=True)
        runtime_dependencies.capture_repository.initialize()
        runtime_dependencies.streaming_repository.initialize()
        runtime_dependencies.installation_repository.initialize()
        runtime_dependencies.model_installation_repository.initialize()
        try:
            yield
        finally:
            await runtime_dependencies.installation_service.shutdown()
            await runtime_dependencies.model_installation_service.shutdown()
            await runtime_dependencies.streaming_capture_service.shutdown()
            await runtime_dependencies.capture_service.shutdown()
            await runtime_dependencies.engine_manager.shutdown()
            runtime_dependencies.lifecycle.stop()

    docs_url = "/docs" if runtime_settings.enable_api_docs else None
    openapi_url = "/openapi.json" if runtime_settings.enable_api_docs else None
    app = FastAPI(
        title="Capture Runtime",
        version=RUNTIME_VERSION,
        debug=False,
        docs_url=docs_url,
        redoc_url=None,
        openapi_url=openapi_url,
        lifespan=lifespan,
    )
    app.state.dependencies = runtime_dependencies
    # Keep these named state attributes for existing host integrations.
    app.state.settings = runtime_settings
    app.state.capture_repository = runtime_dependencies.capture_repository
    app.state.installation_repository = runtime_dependencies.installation_repository
    app.state.capture_service = runtime_dependencies.capture_service
    app.state.streaming_repository = runtime_dependencies.streaming_repository
    app.state.streaming_capture_service = runtime_dependencies.streaming_capture_service
    app.state.installation_service = runtime_dependencies.installation_service
    app.state.model_installation_repository = runtime_dependencies.model_installation_repository
    app.state.model_installation_service = runtime_dependencies.model_installation_service
    app.state.ollama_lifecycle = runtime_dependencies.lifecycle
    app.state.staging_root = runtime_dependencies.staging_root

    if runtime_settings.allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(runtime_settings.allowed_origins),
            allow_credentials=False,
            allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            allow_headers=[
                "Accept",
                "Authorization",
                "Content-Type",
                "Content-Range",
                "Digest",
                "Last-Event-ID",
                "X-Idempotency-Key",
            ],
        )
    app.add_middleware(
        CandidateBodyLimitMiddleware,
        max_bytes=runtime_settings.max_candidate_bytes,
    )

    allowed_hosts = {
        normalized
        for configured in runtime_settings.allowed_hosts
        if (normalized := _normalized_authority(configured)) is not None
    }

    @app.middleware("http")
    async def local_request_policy(
        request: Request,
        call_next: Callable[[Request], Awaitable[StarletteResponse]],
    ) -> StarletteResponse:
        host = _normalized_authority(request.headers.get("host", ""))
        if host is None or host not in allowed_hosts:
            return error_response(400, "invalid_host", "Request Host is not allowed.")
        origin = request.headers.get("origin")
        if origin is not None and origin not in runtime_settings.allowed_origins:
            return error_response(403, "origin_not_allowed", "Request Origin is not allowed.")
        content_length = request.headers.get("content-length")
        if _is_candidate_structure_path(request.url.path) and content_length is not None:
            try:
                candidate_bytes = int(content_length)
            except ValueError:
                return error_response(400, "invalid_content_length", "Content-Length is invalid.")
            if candidate_bytes > runtime_settings.max_candidate_bytes:
                return error_response(
                    413, "candidate_too_large", "Structured candidate exceeds the size limit."
                )
        runtime_dependencies.capture_repository.prune_expired()
        runtime_dependencies.streaming_repository.prune_expired()
        runtime_dependencies.installation_repository.prune_expired()
        runtime_dependencies.model_installation_repository.prune_expired()
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.exception_handler(ApiProblem)
    async def handle_api_problem(_request: Request, error: ApiProblem) -> JSONResponse:
        headers = {"WWW-Authenticate": "Bearer"} if error.status_code == 401 else None
        return error_response(
            error.status_code,
            error.code,
            error.message,
            details=error.details,
            headers=headers,
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation(_request: Request, error: RequestValidationError) -> JSONResponse:
        issues = [
            {
                "location": [str(part) for part in issue["loc"]],
                "message": issue["msg"],
                "type": issue["type"],
            }
            for issue in error.errors()
        ]
        capture_id = _request.path_params.get("capture_id")
        invalid_structure = (
            isinstance(capture_id, str)
            and _is_candidate_structure_path(_request.url.path)
            and any(issue["loc"] and issue["loc"][0] == "body" for issue in error.errors())
        )
        if invalid_structure:
            assert isinstance(capture_id, str)
            if _request.url.path.endswith("/structure/commit"):
                try:
                    runtime_dependencies.streaming_capture_service.fail_invalid_host_structure(
                        capture_id,
                        idempotency_key=(
                            _request.headers.get("x-idempotency-key")
                            or f"invalid-structure-{capture_id}"
                        ),
                    )
                except (StreamingRecordNotFoundError, StreamingTransitionError):
                    pass
            else:
                try:
                    runtime_dependencies.capture_service.fail_invalid_host_structure(capture_id)
                except (RecordNotFoundError, InvalidJobStateError):
                    pass
            return error_response(
                422,
                "invalid_structure",
                "Candidate failed strict schema or provenance validation.",
                details={"issues": issues},
            )
        return error_response(
            422,
            "validation_error",
            "Request validation failed.",
            details={"issues": issues},
        )

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_error(_request: Request, error: StarletteHTTPException) -> JSONResponse:
        code = "not_found" if error.status_code == 404 else f"http_{error.status_code}"
        message = "Resource was not found." if error.status_code == 404 else "Request failed."
        return error_response(error.status_code, code, message)

    bearer = HTTPBearer(auto_error=False)
    bearer_dependency = Security(bearer)

    async def authenticate(
        credentials: HTTPAuthorizationCredentials | None = bearer_dependency,
    ) -> None:
        if (
            credentials is None
            or credentials.scheme.lower() != "bearer"
            or not secrets.compare_digest(credentials.credentials, runtime_settings.api_token)
        ):
            raise ApiProblem(401, "unauthorized", "A valid Bearer token is required.")

    router = APIRouter(prefix="/v1", dependencies=[Depends(authenticate)])
    register_runtime_routes(router, runtime_dependencies)
    register_capture_routes(router, runtime_dependencies)
    app.include_router(router)
    streaming_router = APIRouter(prefix="/v2", dependencies=[Depends(authenticate)])
    register_streaming_routes(streaming_router, runtime_dependencies)
    app.include_router(streaming_router)
    return app


__all__ = ["ApiProblem", "CandidateBodyLimitMiddleware", "create_app"]
