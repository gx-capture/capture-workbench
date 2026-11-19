"""Canonical remote error metadata for the Capture Runtime wire contract.

Two catalogues: HTTP problems (`problems`), the codes of error responses, and
job failure codes (`failureCodes`), the codes of the `error` a failed capture
or installation reports. A code is in both only when both paths emit it.

The HTTP adapters may choose the safe message/details for a particular
request, but they must not invent a second error taxonomy.  This small module
contains the immutable registry primitives; the runtime contract-set builder
owns the concrete release catalogs and serializes them into the discovery bundle.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any


class ProblemRegistryError(ValueError):
    """Raised when a problem catalog contains invalid or duplicate entries."""


@dataclass(frozen=True, slots=True)
class ProblemDefinition:
    """Machine-readable metadata for one remote error code."""

    code: str
    status: int
    message: str
    category: str
    retryable: bool = False
    details_schema: str | None = "ErrorDetails"

    def __post_init__(self) -> None:
        if not self.code or self.code != self.code.strip():
            raise ProblemRegistryError("problem code must be a non-empty trimmed string")
        if not (100 <= self.status <= 599):
            raise ProblemRegistryError(f"problem {self.code!r} has an invalid HTTP status")
        if not self.message or self.message != self.message.strip():
            raise ProblemRegistryError(f"problem {self.code!r} has an invalid message")
        if not self.category or self.category != self.category.strip():
            raise ProblemRegistryError(f"problem {self.code!r} has an invalid category")

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "status": self.status,
            "message": self.message,
            "category": self.category,
            "retryable": self.retryable,
            "detailsSchema": self.details_schema,
        }


class ProblemRegistry:
    """Immutable lookup and deterministic serialization for problem entries."""

    def __init__(
        self,
        definitions: Mapping[str, ProblemDefinition] | Iterable[ProblemDefinition],
    ) -> None:
        if isinstance(definitions, Mapping):
            values = list(definitions.values())
            keys = list(definitions.keys())
            if any(key != definition.code for key, definition in zip(keys, values, strict=True)):
                raise ProblemRegistryError("problem mapping keys must match definition codes")
        else:
            values = list(definitions)
        ordered: dict[str, ProblemDefinition] = {}
        for definition in values:
            if not isinstance(definition, ProblemDefinition):
                raise ProblemRegistryError(
                    "problem registry entries must be ProblemDefinition values"
                )
            if definition.code in ordered:
                raise ProblemRegistryError(f"duplicate problem code: {definition.code}")
            ordered[definition.code] = definition
        self._definitions = MappingProxyType({code: ordered[code] for code in sorted(ordered)})

    @property
    def definitions(self) -> Mapping[str, ProblemDefinition]:
        return self._definitions

    def get(self, code: str) -> ProblemDefinition | None:
        return self._definitions.get(code)

    def as_dicts(self) -> list[dict[str, Any]]:
        return [definition.as_dict() for definition in self._definitions.values()]


def _definition(
    code: str,
    status: int,
    message: str,
    category: str = "remote",
    *,
    retryable: bool = False,
) -> ProblemDefinition:
    return ProblemDefinition(
        code=code,
        status=status,
        message=message,
        category=category,
        retryable=retryable,
    )


# One deterministic catalog is shared by every v2 route and by discovery.
DEFAULT_PROBLEM_REGISTRY = ProblemRegistry(
    [
        _definition("unauthorized", 401, "A valid Bearer token is required.", "authentication"),
        _definition("invalid_host", 400, "Request Host is not allowed.", "request"),
        _definition("origin_not_allowed", 403, "Request Origin is not allowed.", "authorization"),
        _definition("invalid_content_length", 400, "Content-Length is invalid.", "request"),
        _definition(
            "candidate_too_large", 413, "Structured candidate exceeds the size limit.", "request"
        ),
        _definition("validation_error", 422, "Request validation failed.", "validation"),
        _definition(
            "idempotency_conflict",
            409,
            "Idempotency key conflicts with an existing request.",
            "conflict",
        ),
        _definition("capture_not_found", 404, "Capture operation was not found.", "not_found"),
        _definition("raw_unavailable", 409, "Raw extraction is not available.", "conflict"),
        _definition(
            "ocr_unavailable", 409, "Canonical OCR projection is not available.", "conflict"
        ),
        _definition("result_unavailable", 409, "Structured result is not available.", "conflict"),
        _definition(
            "invalid_structure",
            422,
            "Candidate failed strict schema or provenance validation.",
            "validation",
        ),
        _definition(
            "invalid_capture_state",
            409,
            "Capture is not in a state that accepts this operation.",
            "conflict",
        ),
        _definition("ingestion_not_found", 404, "Ingestion was not found.", "not_found"),
        _definition("invalid_chunk_headers", 422, "Chunk headers are invalid.", "validation"),
        _definition("chunk_too_large", 413, "Chunk exceeds the configured size limit.", "request"),
        _definition(
            "chunk_total_conflict", 409, "Chunk total does not match ingestion size.", "conflict"
        ),
        _definition(
            "chunk_length_mismatch", 422, "Chunk length does not match Content-Range.", "validation"
        ),
        _definition(
            "chunk_checksum_mismatch", 409, "Chunk checksum does not match the body.", "conflict"
        ),
        _definition(
            "chunk_conflict", 409, "Chunk conflicts with existing ingestion state.", "conflict"
        ),
        _definition("chunk_out_of_order", 409, "Chunk is out of order.", "conflict"),
        _definition("chunk_rejected", 409, "Chunk was rejected.", "conflict"),
        _definition(
            "ingestion_finalize_rejected", 409, "Ingestion finalization was rejected.", "conflict"
        ),
        _definition(
            "ingestion_delete_rejected", 409, "Ingestion deletion was rejected.", "conflict"
        ),
        _definition(
            "partial_unavailable",
            409,
            "Progressive partial capture is not available yet.",
            "conflict",
        ),
        _definition(
            "invalid_event_cursor", 422, "Last-Event-ID must be an integer cursor.", "validation"
        ),
        _definition(
            "requirement_disabled",
            422,
            "The requested runtime requirement is disabled.",
            "validation",
        ),
        _definition(
            "requirement_not_found",
            404,
            "The requested runtime requirement is unknown.",
            "not_found",
        ),
        _definition(
            "requirement_not_uninstallable",
            422,
            "The requested runtime requirement is not an engine that can be uninstalled.",
            "validation",
        ),
        _definition(
            "requirement_in_use",
            409,
            "The requirement cannot be uninstalled while an installation or capture is active.",
            "conflict",
            retryable=True,
        ),
        _definition("uninstall_failed", 500, "The requirement could not be uninstalled."),
        _definition(
            "requirement_unavailable",
            503,
            "The requested runtime requirement is unavailable.",
            retryable=True,
        ),
        _definition(
            "model_option_unknown", 422, "The model option is not allowlisted.", "validation"
        ),
        _definition("installation_not_found", 404, "Installation job was not found.", "not_found"),
        _definition(
            "structuring_invalid_output",
            422,
            "Structuring provider returned invalid output.",
            "validation",
        ),
        _definition(
            "structuring_session_not_found",
            404,
            "Structuring session was not found.",
            "not_found",
        ),
        _definition(
            "structuring_batch_not_found",
            404,
            "Structuring batch was not found.",
            "not_found",
        ),
        _definition(
            "structuring_batch_digest_conflict",
            409,
            "Structuring batch digest does not match the advertised batch.",
            "conflict",
        ),
        _definition(
            "structuring_session_corrupt",
            500,
            "Structuring session state is corrupt.",
            "integrity",
        ),
        _definition(
            "contract_bundle_not_found", 404, "Contract bundle was not found.", "not_found"
        ),
        _definition(
            "contract_bundle_integrity", 500, "Contract bundle integrity failed.", "integrity"
        ),
        _definition("not_found", 404, "Resource was not found.", "not_found"),
        _definition("http_400", 400, "Request failed.", "request"),
        _definition("http_404", 404, "Resource was not found.", "not_found"),
        _definition("http_409", 409, "Request failed.", "conflict"),
        _definition("http_415", 415, "Request failed.", "validation"),
        _definition("http_422", 422, "Request failed.", "validation"),
    ]
)


@dataclass(frozen=True, slots=True)
class FailureCodeDefinition:
    """One code a failed job reports; its retryability belongs to each failure."""

    code: str
    message: str

    def __post_init__(self) -> None:
        if not self.code or self.code != self.code.strip():
            raise ProblemRegistryError("failure code must be a non-empty trimmed string")
        if not self.message or self.message != self.message.strip():
            raise ProblemRegistryError(f"failure code {self.code!r} has an invalid message")

    def as_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message}


class FailureCodeRegistry:
    """Immutable, deterministically ordered job failure codes."""

    def __init__(self, definitions: Iterable[FailureCodeDefinition]) -> None:
        ordered: dict[str, FailureCodeDefinition] = {}
        for definition in definitions:
            if definition.code in ordered:
                raise ProblemRegistryError(f"duplicate failure code: {definition.code}")
            ordered[definition.code] = definition
        self._definitions = MappingProxyType({code: ordered[code] for code in sorted(ordered)})

    @property
    def definitions(self) -> Mapping[str, FailureCodeDefinition]:
        return self._definitions

    def as_dicts(self) -> list[dict[str, Any]]:
        return [definition.as_dict() for definition in self._definitions.values()]


def _failure(code: str, message: str) -> FailureCodeDefinition:
    return FailureCodeDefinition(code=code, message=message)


# Every code the runtime puts in a failed capture's, installation's or model
# installation's `error`, and in an OCR projection's failures. A host's own
# structuring failure report keeps the code the host chose.
DEFAULT_FAILURE_CODE_REGISTRY = FailureCodeRegistry(
    [
        # Capture: input and request
        _failure("ingestion_source_unavailable", "The ingested source is unavailable."),
        _failure("unsupported_media_type", "The source content is not a supported kind."),
        _failure("source_kind_mismatch", "The source content does not match its declared kind."),
        _failure("invalid_pdf_page_selection", "The PDF page selection is invalid."),
        _failure("invalid_speaker_identification", "Speakers are identified only in recordings."),
        _failure("invalid_spoken_language", "A spoken language is valid only for recordings."),
        # Capture: extraction
        _failure("capture_interrupted", "The capture was interrupted."),
        _failure("extraction_failed", "Capture extraction failed."),
        _failure("extraction_output_invalid", "Extraction output failed strict validation."),
        _failure("extraction_no_text", "Extraction produced no text."),
        _failure(
            "extraction_runtime_unavailable",
            "This runtime has no extractor for the capture kind.",
        ),
        _failure(
            "requirement_unavailable", "A runtime requirement the capture needs is unavailable."
        ),
        _failure("speech_recognition_worker_failed", "The speech recognition worker failed."),
        _failure(
            "speaker_identification_worker_failed", "The speaker identification worker failed."
        ),
        _failure("worker_failed", "A worker operation failed."),
        _failure("ocr_source_preflight_failed", "OCR source preflight failed."),
        _failure("ocr_no_text", "OCR produced no text."),
        _failure("ocr_page_failed", "OCR page processing failed."),
        _failure("ocr_worker_failed", "The OCR worker failed before completing all pages."),
        _failure("ocr_worker_protocol", "The OCR worker returned an invalid response."),
        _failure("ocr_worker_timeout", "The OCR worker timed out before completing all pages."),
        _failure(
            "ocr_runtime_unavailable",
            "The OCR runtime was unavailable before completing all pages.",
        ),
        # Capture: progressive transcription of a recording
        _failure("progressive_decode_failed", "The recording could not be decoded."),
        _failure("progressive_decoder_init_failed", "The audio decoder could not be prepared."),
        _failure(
            "progressive_engine_resolution_failed",
            "The speech recognition engine could not be prepared.",
        ),
        _failure("progressive_event_persist_failed", "A transcription event could not be saved."),
        _failure("progressive_partial_invalid", "A partial transcript failed validation."),
        _failure("progressive_session_failed", "The transcription session failed."),
        _failure("progressive_stall", "The transcription worker stopped making progress."),
        _failure("progressive_worker_event_invalid", "The worker returned an invalid event."),
        _failure("progressive_worker_exit", "The transcription worker exited."),
        _failure(
            "progressive_worker_finish_failed", "The worker failed while finishing the session."
        ),
        _failure(
            "progressive_worker_frame_read_failed", "A frame from the worker could not be read."
        ),
        _failure("progressive_worker_input_failed", "The worker failed while processing audio."),
        _failure("progressive_worker_start_failed", "The transcription worker did not start."),
        _failure("session_backpressure", "The transcription session was over capacity."),
        _failure("session_cancelled", "The transcription session was cancelled."),
        _failure("session_closed", "The transcription session was already closed."),
        _failure("session_conflict", "The transcription session had already started."),
        _failure("session_credit_invalid", "The transcription session credit was invalid."),
        _failure("session_credit_required", "The transcription session had no credit."),
        _failure("session_failed", "The transcription session failed."),
        _failure("session_frame_invalid", "A transcription session frame was invalid."),
        _failure("session_frame_too_large", "A transcription session frame was too large."),
        _failure("session_input_invalid", "Transcription session audio input was invalid."),
        _failure("session_json_invalid", "A transcription session control payload was invalid."),
        _failure("session_not_started", "The transcription session had not started."),
        _failure("session_start_invalid", "The transcription session start was invalid."),
        # Capture: structuring by the runtime
        _failure("structuring_failed", "Capture structuring failed."),
        _failure(
            "structuring_invalid_output",
            "Structuring output failed strict schema or provenance validation.",
        ),
        # Installation and structuring model installation
        _failure("installation_cancelled", "The installation was cancelled."),
        _failure("runtime_restarted", "The runtime restarted while the installation was active."),
        _failure("manual_action_required", "The installation requires a manual action."),
        _failure("installation_failed", "The installation failed."),
        _failure("installation_timeout", "An installation step timed out."),
        _failure("installation_io_failed", "An installation file operation failed."),
        _failure("installation_unexpected", "The installation failed unexpectedly."),
        _failure("direct_model_retries_exhausted", "Model download retries were exhausted."),
        _failure("direct_model_checksum", "Model checksum verification failed."),
        _failure("worker_archive_integrity", "Engine archive integrity verification failed."),
        _failure("engine_probe_failed", "The installed engine probe failed."),
    ]
)


__all__ = [
    "DEFAULT_FAILURE_CODE_REGISTRY",
    "DEFAULT_PROBLEM_REGISTRY",
    "FailureCodeDefinition",
    "FailureCodeRegistry",
    "ProblemDefinition",
    "ProblemRegistry",
    "ProblemRegistryError",
]
