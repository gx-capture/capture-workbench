"""Capture upload, polling, cancellation and host structuring routes."""

from __future__ import annotations

import hashlib
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, File, Form, Header, Response, UploadFile, status

from capture_runtime.contracts import (
    CaptureDocumentV1,
    CaptureJobV1,
    CaptureSourceKind,
    CaptureSourceV1,
    RawCaptureV1,
    ReportStructuringFailureV1,
    StructuringMode,
)
from capture_runtime.dependencies import RuntimeDependencies
from capture_runtime.extractors import UnsupportedMediaError
from capture_runtime.routes.common import ApiProblem, request_fingerprint, safe_filename
from capture_runtime.services import (
    IdempotencyConflictError,
    InvalidJobStateError,
    RawUnavailableError,
    RecordNotFoundError,
    ResultUnavailableError,
    StructuringValidationError,
)


def register_capture_routes(router: APIRouter, dependencies: RuntimeDependencies) -> None:
    """Register capture lifecycle and host-owned structuring endpoints."""

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
        if structuring_mode not in dependencies.supported_structuring_modes:
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

        file_name = safe_filename(file.filename)
        staged_upload = dependencies.staging_root / f"{uuid4().hex}.upload"
        digest_builder = hashlib.sha256()
        sniff_prefix = bytearray()
        upload_bytes = 0
        try:
            try:
                with staged_upload.open("xb") as destination:
                    while chunk := await file.read(1024 * 1024):
                        upload_bytes += len(chunk)
                        if upload_bytes > dependencies.settings.max_upload_bytes:
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
                sniffed = dependencies.extractor.sniff(bytes(sniff_prefix))
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
            fingerprint = request_fingerprint(
                {
                    "sha256": digest,
                    "sourceKind": source_kind.value,
                    "structuringMode": structuring_mode.value,
                    "targetLanguage": target_language,
                }
            )
            try:
                return dependencies.capture_service.create(
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
            return dependencies.capture_service.get(capture_id)
        except RecordNotFoundError as error:
            raise ApiProblem(404, "capture_not_found", "Capture job was not found.") from error

    @router.post("/captures/{capture_id}/cancel", response_model=CaptureJobV1)
    async def cancel_capture(capture_id: str) -> CaptureJobV1:
        try:
            return await dependencies.capture_service.cancel(capture_id)
        except RecordNotFoundError as error:
            raise ApiProblem(404, "capture_not_found", "Capture job was not found.") from error

    @router.get("/captures/{capture_id}/raw", response_model=RawCaptureV1)
    async def get_raw(capture_id: str) -> RawCaptureV1:
        try:
            return dependencies.capture_service.raw(capture_id)
        except RawUnavailableError as error:
            raise ApiProblem(409, "raw_unavailable", "Raw extraction is not available.") from error
        except RecordNotFoundError as error:
            raise ApiProblem(404, "capture_not_found", "Capture job was not found.") from error

    @router.get("/captures/{capture_id}/result", response_model=CaptureDocumentV1)
    async def get_result(capture_id: str) -> CaptureDocumentV1:
        try:
            return dependencies.capture_service.result(capture_id)
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
            return dependencies.capture_service.commit_host_result(
                capture_id, candidate, idempotency_key=str(idempotency_key)
            )
        except StructuringValidationError as error:
            try:
                dependencies.capture_service.fail_invalid_host_structure(capture_id)
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
            return dependencies.capture_service.report_host_failure(
                capture_id, code=payload.code, message=payload.message
            )
        except InvalidJobStateError as error:
            raise ApiProblem(409, "invalid_capture_state", str(error)) from error
        except RecordNotFoundError as error:
            raise ApiProblem(404, "capture_not_found", "Capture job was not found.") from error

    @router.delete("/captures/{capture_id}", status_code=status.HTTP_204_NO_CONTENT)
    async def delete_capture(capture_id: str) -> Response:
        try:
            await dependencies.capture_service.delete(capture_id)
        except RecordNotFoundError as error:
            raise ApiProblem(404, "capture_not_found", "Capture job was not found.") from error
        return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["register_capture_routes"]
