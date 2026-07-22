"""FastAPI application factory for the local Capture Runtime sidecar."""

from __future__ import annotations

import hashlib
import json
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from fastapi import (
    APIRouter,
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    Request,
    Response,
    Security,
    UploadFile,
    status,
)
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import Response as StarletteResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from capture_runtime.clock import Clock, SystemClock
from capture_runtime.config import RuntimeSettings
from capture_runtime.constants import (
    OLLAMA_MODEL_REQUIREMENT_ID,
    OLLAMA_RUNTIME_REQUIREMENT_ID,
)
from capture_runtime.contracts import (
    CaptureDocumentV1,
    CaptureJobV1,
    CaptureSourceKind,
    CaptureSourceV1,
    ErrorBodyV1,
    ErrorEnvelopeV1,
    RawCaptureV1,
    ReportStructuringFailureV1,
    RuntimeCapabilitiesV1,
    RuntimeInstallationsV1,
    RuntimeInstallationV1,
    RuntimeReadyV1,
    RuntimeRequirementsV1,
    StartRuntimeInstallationV1,
    StructuringMode,
)
from capture_runtime.extractors import (
    CaptureExtractor,
    DeterministicCaptureExtractor,
    StandaloneRuntimeCaptureExtractor,
    UnsupportedMediaError,
)
from capture_runtime.ollama import (
    IsolatedOllamaLifecycle,
    OllamaCaptureStructuringProvider,
    ProcessController,
    RuntimeInstaller,
    SystemRuntimeInstaller,
)
from capture_runtime.services import (
    CaptureService,
    IdempotencyConflictError,
    InstallationService,
    InvalidJobStateError,
    RawUnavailableError,
    RecordNotFoundError,
    ResultUnavailableError,
    StructuringValidationError,
)
from capture_runtime.storage import CaptureRepository, InstallationRepository
from capture_runtime.structuring import (
    CaptureStructuringProvider,
    FakeCaptureStructuringProvider,
    HostOnlyCaptureStructuringProvider,
)


class ApiProblem(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


class CandidateBodyLimitMiddleware:
    """Enforce the structure-candidate limit even for chunked request bodies."""

    def __init__(self, app: ASGIApp, *, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not str(scope.get("path", "")).endswith("/structure"):
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
                    response = _error_response(
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


def _error_response(
    status_code: int,
    code: str,
    message: str,
    *,
    details: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    envelope = ErrorEnvelopeV1(error=ErrorBodyV1(code=code, message=message, details=details))
    return JSONResponse(
        status_code=status_code,
        content=envelope.model_dump(mode="json", by_alias=True, exclude_none=True),
        headers=headers,
    )


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


def _safe_filename(value: str | None) -> str:
    candidate = Path(value or "upload.bin").name
    candidate = "".join(
        character for character in candidate if character >= " " and character != "\x7f"
    )
    candidate = candidate.strip()[:255]
    return candidate or "upload.bin"


def _request_fingerprint(payload: object) -> str:
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def create_app(
    settings: RuntimeSettings | None = None,
    *,
    clock: Clock | None = None,
    extractor: CaptureExtractor | None = None,
    structurer: CaptureStructuringProvider | None = None,
    installer: RuntimeInstaller | None = None,
    process_controller: ProcessController | None = None,
) -> FastAPI:
    runtime_settings = settings or RuntimeSettings.from_env()
    runtime_clock = clock or SystemClock()
    lifecycle = IsolatedOllamaLifecycle(
        runtime_settings.ollama,
        process_controller=process_controller,
        clock=runtime_clock,
    )
    standalone_extractor = StandaloneRuntimeCaptureExtractor(
        runtime_clock, runtime_settings.extraction
    )
    active_extractor = extractor
    if active_extractor is None:
        active_extractor = (
            DeterministicCaptureExtractor(runtime_clock)
            if runtime_settings.extraction_provider == "fake"
            else standalone_extractor
        )
    active_structurer = structurer
    if active_structurer is None:
        if runtime_settings.structuring_provider == "fake":
            active_structurer = FakeCaptureStructuringProvider(runtime_clock)
        elif runtime_settings.structuring_provider == "ollama":
            active_structurer = OllamaCaptureStructuringProvider(lifecycle)
        else:
            active_structurer = HostOnlyCaptureStructuringProvider()
    supported_structuring_modes = (
        [StructuringMode.HOST]
        if runtime_settings.structuring_provider == "host"
        else [StructuringMode.RUNTIME, StructuringMode.HOST]
    )
    disabled_requirement_ids = (
        {OLLAMA_RUNTIME_REQUIREMENT_ID, OLLAMA_MODEL_REQUIREMENT_ID}
        if runtime_settings.structuring_provider == "host"
        else set()
    )
    active_installer = installer or SystemRuntimeInstaller(
        lifecycle,
        extraction_config=runtime_settings.extraction,
        ocr_adapter=standalone_extractor.ocr_adapter,
        whisper_adapter=standalone_extractor.whisper_adapter,
        clock=runtime_clock,
    )

    capture_repository = CaptureRepository(
        runtime_settings.app_data_dir / "jobs" / "captures",
        clock=runtime_clock,
        retention_hours=runtime_settings.retention_hours,
    )
    installation_repository = InstallationRepository(
        runtime_settings.app_data_dir / "jobs" / "installations",
        clock=runtime_clock,
        retention_hours=runtime_settings.retention_hours,
    )
    staging_root = runtime_settings.app_data_dir / "jobs" / "staging"
    capture_service = CaptureService(
        capture_repository,
        extractor=active_extractor,
        structurer=active_structurer,
        clock=runtime_clock,
    )
    installation_service = InstallationService(
        installation_repository,
        installer=active_installer,
        clock=runtime_clock,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        staging_root.mkdir(parents=True, exist_ok=True)
        for abandoned_upload in staging_root.glob("*.upload"):
            abandoned_upload.unlink(missing_ok=True)
        capture_repository.initialize()
        installation_repository.initialize()
        try:
            yield
        finally:
            await installation_service.shutdown()
            await capture_service.shutdown()
            lifecycle.stop()

    docs_url = "/docs" if runtime_settings.enable_api_docs else None
    openapi_url = "/openapi.json" if runtime_settings.enable_api_docs else None
    app = FastAPI(
        title="Capture Runtime",
        version="0.1.0",
        debug=False,
        docs_url=docs_url,
        redoc_url=None,
        openapi_url=openapi_url,
        lifespan=lifespan,
    )
    app.state.settings = runtime_settings
    app.state.capture_repository = capture_repository
    app.state.installation_repository = installation_repository
    app.state.capture_service = capture_service
    app.state.installation_service = installation_service
    app.state.ollama_lifecycle = lifecycle
    app.state.staging_root = staging_root

    if runtime_settings.allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(runtime_settings.allowed_origins),
            allow_credentials=False,
            allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
            allow_headers=["Accept", "Authorization", "Content-Type", "X-Idempotency-Key"],
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
            return _error_response(400, "invalid_host", "Request Host is not allowed.")
        origin = request.headers.get("origin")
        if origin is not None and origin not in runtime_settings.allowed_origins:
            return _error_response(403, "origin_not_allowed", "Request Origin is not allowed.")
        content_length = request.headers.get("content-length")
        if request.url.path.endswith("/structure") and content_length is not None:
            try:
                candidate_bytes = int(content_length)
            except ValueError:
                return _error_response(400, "invalid_content_length", "Content-Length is invalid.")
            if candidate_bytes > runtime_settings.max_candidate_bytes:
                return _error_response(
                    413, "candidate_too_large", "Structured candidate exceeds the size limit."
                )
        capture_repository.prune_expired()
        installation_repository.prune_expired()
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.exception_handler(ApiProblem)
    async def handle_api_problem(_request: Request, error: ApiProblem) -> JSONResponse:
        headers = {"WWW-Authenticate": "Bearer"} if error.status_code == 401 else None
        return _error_response(
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
            and _request.url.path.endswith("/structure")
            and any(issue["loc"] and issue["loc"][0] == "body" for issue in error.errors())
        )
        if invalid_structure:
            assert isinstance(capture_id, str)
            try:
                capture_service.fail_invalid_host_structure(capture_id)
            except (RecordNotFoundError, InvalidJobStateError):
                pass
            return _error_response(
                422,
                "invalid_structure",
                "Candidate failed strict schema or provenance validation.",
                details={"issues": issues},
            )
        return _error_response(
            422,
            "validation_error",
            "Request validation failed.",
            details={"issues": issues},
        )

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_error(_request: Request, error: StarletteHTTPException) -> JSONResponse:
        code = "not_found" if error.status_code == 404 else f"http_{error.status_code}"
        message = "Resource was not found." if error.status_code == 404 else "Request failed."
        return _error_response(error.status_code, code, message)

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

    @router.get("/health/ready", response_model=RuntimeReadyV1)
    async def ready() -> RuntimeReadyV1:
        return RuntimeReadyV1(
            ready=True,
            capabilities=RuntimeCapabilitiesV1(
                capture_kinds=["pdf", "image", "audio"],
                structuring_modes=supported_structuring_modes,
                max_upload_bytes=runtime_settings.max_upload_bytes,
            ),
        )

    @router.get("/runtime/requirements", response_model=RuntimeRequirementsV1)
    async def requirements() -> RuntimeRequirementsV1:
        return RuntimeRequirementsV1(
            items=[
                item
                for item in active_installer.requirements()
                if item.requirement_id not in disabled_requirement_ids
            ]
        )

    @router.post(
        "/runtime/installations",
        response_model=RuntimeInstallationV1,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_installation(
        payload: StartRuntimeInstallationV1,
        idempotency_key: Annotated[UUID, Header(alias="X-Idempotency-Key")],
    ) -> RuntimeInstallationV1:
        if payload.requirement_id in disabled_requirement_ids:
            raise ApiProblem(
                422,
                "requirement_disabled",
                "This runtime process delegates structuring to its host provider.",
            )
        fingerprint = _request_fingerprint(payload.model_dump(mode="json", by_alias=True))
        try:
            return installation_service.create(
                idempotency_key=str(idempotency_key),
                request_fingerprint=fingerprint,
                requirement_id=payload.requirement_id,
            )
        except IdempotencyConflictError as error:
            raise ApiProblem(
                409,
                "idempotency_conflict",
                "Idempotency key was already used with a different request.",
            ) from error

    @router.get("/runtime/installations", response_model=RuntimeInstallationsV1)
    async def list_installations() -> RuntimeInstallationsV1:
        return RuntimeInstallationsV1(items=installation_service.list())

    @router.get("/runtime/installations/{installation_id}", response_model=RuntimeInstallationV1)
    async def get_installation(installation_id: str) -> RuntimeInstallationV1:
        try:
            return installation_service.get(installation_id)
        except RecordNotFoundError as error:
            raise ApiProblem(
                404, "installation_not_found", "Installation job was not found."
            ) from error

    @router.post(
        "/runtime/installations/{installation_id}/cancel",
        response_model=RuntimeInstallationV1,
    )
    async def cancel_installation(installation_id: str) -> RuntimeInstallationV1:
        try:
            return await installation_service.cancel(installation_id)
        except RecordNotFoundError as error:
            raise ApiProblem(
                404, "installation_not_found", "Installation job was not found."
            ) from error

    @router.post("/captures", response_model=CaptureJobV1, status_code=status.HTTP_202_ACCEPTED)
    async def create_capture(
        file: Annotated[UploadFile, File()],
        idempotency_key: Annotated[UUID, Header(alias="X-Idempotency-Key")],
        source_kind: Annotated[CaptureSourceKind, Form(alias="sourceKind")],
        structuring_mode: Annotated[
            StructuringMode, Form(alias="structuringMode")
        ] = StructuringMode.RUNTIME,
        target_language: Annotated[str | None, Form(alias="targetLanguage")] = None,
    ) -> CaptureJobV1:
        if structuring_mode not in supported_structuring_modes:
            raise ApiProblem(
                422,
                "structuring_mode_unavailable",
                "Requested structuringMode is disabled for this runtime process.",
            )
        if target_language is not None:
            target_language = target_language.strip()
            if not target_language or len(target_language) > 64:
                raise ApiProblem(
                    422, "validation_error", "targetLanguage must be 1 to 64 characters."
                )
        file_name = _safe_filename(file.filename)
        staged_upload = staging_root / f"{uuid4().hex}.upload"
        digest_builder = hashlib.sha256()
        sniff_prefix = bytearray()
        upload_bytes = 0
        try:
            try:
                with staged_upload.open("xb") as destination:
                    while chunk := await file.read(1024 * 1024):
                        upload_bytes += len(chunk)
                        if upload_bytes > runtime_settings.max_upload_bytes:
                            raise ApiProblem(
                                413,
                                "upload_too_large",
                                "Upload exceeds the configured size limit.",
                            )
                        destination.write(chunk)
                        digest_builder.update(chunk)
                        if len(sniff_prefix) < 64:
                            sniff_prefix.extend(chunk[: 64 - len(sniff_prefix)])
            finally:
                await file.close()
            if upload_bytes == 0:
                raise ApiProblem(422, "empty_upload", "Uploaded file is empty.")
            try:
                sniffed = active_extractor.sniff(bytes(sniff_prefix))
            except UnsupportedMediaError as error:
                raise ApiProblem(415, "unsupported_media_type", str(error)) from error
            if sniffed.kind is not source_kind:
                raise ApiProblem(
                    422,
                    "source_kind_mismatch",
                    "Declared sourceKind does not match the uploaded content.",
                    details={"declared": source_kind.value, "detected": sniffed.kind.value},
                )
            digest = digest_builder.hexdigest()
            source = CaptureSourceV1(
                sha256=digest,
                file_name=file_name,
                media_type=sniffed.media_type,
                bytes=upload_bytes,
            )
            fingerprint = _request_fingerprint(
                {
                    "sha256": digest,
                    "sourceKind": source_kind.value,
                    "structuringMode": structuring_mode.value,
                    "targetLanguage": target_language,
                }
            )
            try:
                return capture_service.create(
                    idempotency_key=str(idempotency_key),
                    request_fingerprint=fingerprint,
                    source=source,
                    structuring_mode=structuring_mode,
                    target_language=target_language,
                    staged_upload=staged_upload,
                )
            except IdempotencyConflictError as error:
                raise ApiProblem(
                    409,
                    "idempotency_conflict",
                    "Idempotency key was already used with a different request.",
                ) from error
        finally:
            staged_upload.unlink(missing_ok=True)

    @router.get("/captures/{capture_id}", response_model=CaptureJobV1)
    async def get_capture(capture_id: str) -> CaptureJobV1:
        try:
            return capture_service.get(capture_id)
        except RecordNotFoundError as error:
            raise ApiProblem(404, "capture_not_found", "Capture job was not found.") from error

    @router.post("/captures/{capture_id}/cancel", response_model=CaptureJobV1)
    async def cancel_capture(capture_id: str) -> CaptureJobV1:
        try:
            return await capture_service.cancel(capture_id)
        except RecordNotFoundError as error:
            raise ApiProblem(404, "capture_not_found", "Capture job was not found.") from error

    @router.get("/captures/{capture_id}/raw", response_model=RawCaptureV1)
    async def get_raw(capture_id: str) -> RawCaptureV1:
        try:
            return capture_service.raw(capture_id)
        except RawUnavailableError as error:
            raise ApiProblem(409, "raw_unavailable", "Raw extraction is not available.") from error
        except RecordNotFoundError as error:
            raise ApiProblem(404, "capture_not_found", "Capture job was not found.") from error

    @router.get("/captures/{capture_id}/result", response_model=CaptureDocumentV1)
    async def get_result(capture_id: str) -> CaptureDocumentV1:
        try:
            return capture_service.result(capture_id)
        except ResultUnavailableError as error:
            raise ApiProblem(
                409, "result_unavailable", "Structured result is not available."
            ) from error
        except RecordNotFoundError as error:
            raise ApiProblem(404, "capture_not_found", "Capture job was not found.") from error

    @router.post("/captures/{capture_id}/structure", response_model=CaptureJobV1)
    async def commit_structure(
        capture_id: str,
        candidate: CaptureDocumentV1,
        idempotency_key: Annotated[UUID, Header(alias="X-Idempotency-Key")],
    ) -> CaptureJobV1:
        try:
            return capture_service.commit_host_result(
                capture_id, candidate, idempotency_key=str(idempotency_key)
            )
        except StructuringValidationError as error:
            try:
                capture_service.fail_invalid_host_structure(capture_id)
            except (RecordNotFoundError, InvalidJobStateError):
                pass
            raise ApiProblem(
                422,
                "invalid_structure",
                "Candidate failed strict schema or provenance validation.",
                details={"issues": error.issues},
            ) from error
        except IdempotencyConflictError as error:
            raise ApiProblem(
                409, "idempotency_conflict", "Commit idempotency key conflicts."
            ) from error
        except InvalidJobStateError as error:
            raise ApiProblem(409, "invalid_capture_state", str(error)) from error
        except RecordNotFoundError as error:
            raise ApiProblem(404, "capture_not_found", "Capture job was not found.") from error

    @router.post("/captures/{capture_id}/structuring-failure", response_model=CaptureJobV1)
    async def report_structuring_failure(
        capture_id: str, payload: ReportStructuringFailureV1
    ) -> CaptureJobV1:
        try:
            return capture_service.report_host_failure(
                capture_id, code=payload.code, message=payload.message
            )
        except InvalidJobStateError as error:
            raise ApiProblem(409, "invalid_capture_state", str(error)) from error
        except RecordNotFoundError as error:
            raise ApiProblem(404, "capture_not_found", "Capture job was not found.") from error

    @router.delete("/captures/{capture_id}", status_code=status.HTTP_204_NO_CONTENT)
    async def delete_capture(capture_id: str) -> Response:
        try:
            await capture_service.delete(capture_id)
        except RecordNotFoundError as error:
            raise ApiProblem(404, "capture_not_found", "Capture job was not found.") from error
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    app.include_router(router)
    return app
