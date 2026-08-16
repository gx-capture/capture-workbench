"""Canonical remote problem metadata for the Capture Runtime wire contract.

The HTTP adapters may choose the safe message/details for a particular
request, but they must not invent a second error taxonomy.  This small module
contains the immutable registry primitive; the runtime contract-set builder
owns the concrete release catalog and serializes it into the discovery bundle.
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
    details_schema: str | None = "ErrorDetailsV2"

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

    @property
    def codes(self) -> tuple[str, ...]:
        return tuple(self._definitions)

    def get(self, code: str) -> ProblemDefinition | None:
        return self._definitions.get(code)

    def require(self, code: str) -> ProblemDefinition:
        definition = self.get(code)
        if definition is None:
            raise ProblemRegistryError(f"unknown problem code: {code}")
        return definition

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
            "requirement_unavailable",
            503,
            "The requested runtime requirement is unavailable.",
            retryable=True,
        ),
        _definition(
            "model_option_unknown", 422, "The model option is not allowlisted.", "validation"
        ),
        _definition("installation_not_found", 404, "Installation job was not found.", "not_found"),
        _definition("installation_cancelled", 409, "Installation was cancelled.", "conflict"),
        _definition(
            "runtime_restarted",
            503,
            "Runtime restarted while installation was active.",
            retryable=True,
        ),
        _definition(
            "manual_action_required",
            422,
            "Runtime installation requires manual action.",
            "validation",
        ),
        _definition(
            "installation_filesystem", 500, "Runtime installation filesystem operation failed."
        ),
        _definition("installation_unexpected", 500, "Runtime installation failed unexpectedly."),
        _definition(
            "direct_model_retries_exhausted",
            502,
            "Runtime model download retries were exhausted.",
            retryable=True,
        ),
        _definition("direct_model_checksum", 502, "Runtime model checksum verification failed."),
        _definition("engine_probe_failed", 502, "Runtime engine probe failed.", retryable=True),
        _definition(
            "streaming_source_unavailable", 409, "Streaming source is unavailable.", "conflict"
        ),
        _definition(
            "extraction_runtime_unavailable",
            503,
            "Extraction runtime is unavailable.",
            retryable=True,
        ),
        _definition(
            "unsupported_media_type", 415, "Uploaded media type is unsupported.", "validation"
        ),
        _definition(
            "source_kind_mismatch",
            422,
            "Declared source kind does not match content.",
            "validation",
        ),
        _definition(
            "progressive_no_text_at_sample",
            422,
            "Progressive audio produced no text at the sample.",
            "validation",
        ),
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


__all__ = [
    "DEFAULT_PROBLEM_REGISTRY",
    "ProblemDefinition",
    "ProblemRegistry",
    "ProblemRegistryError",
]
