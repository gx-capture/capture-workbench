"""Pydantic wire contracts for Capture Runtime API v1."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Any, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel

from capture_runtime.constants import (
    API_VERSION,
    CAPTURE_DOCUMENT_SCHEMA_VERSION,
    RUNTIME_VERSION,
)

NonEmptyString = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
CaptureText = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2_000_000)
]
ProjectedText = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=8_000_000)
]
WarningText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]
Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
EngineDigest = Annotated[str, StringConstraints(pattern=r"^sha256:[0-9a-f]{64}$")]


class StrictModel(BaseModel):
    """Reject unexpected wire fields and expose camelCase JSON aliases."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        extra="forbid",
        populate_by_name=True,
        str_strip_whitespace=True,
    )


def _require_aware(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamp must include a timezone")
    return value


class CaptureSourceKind(StrEnum):
    PDF = "pdf"
    IMAGE = "image"
    AUDIO = "audio"


class StructuringMode(StrEnum):
    RUNTIME = "runtime"
    HOST = "host"


class CaptureJobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class CaptureJobStage(StrEnum):
    QUEUED = "queued"
    EXTRACTING = "extracting"
    AWAITING_STRUCTURING = "awaiting_structuring"
    STRUCTURING = "structuring"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class RuntimeInstallationStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    MANUAL_ACTION_REQUIRED = "manual_action_required"


class RuntimeRequirementStatus(StrEnum):
    READY = "ready"
    MISSING = "missing"
    INSTALLABLE = "installable"
    MANUAL_ACTION_REQUIRED = "manual_action_required"
    UNAVAILABLE = "unavailable"


class PageLocatorV1(StrictModel):
    kind: Literal["page"] = "page"
    page: int = Field(ge=1)
    bounding_box: tuple[float, float, float, float] | None = None


class TimeLocatorV1(StrictModel):
    kind: Literal["time"] = "time"
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)

    @model_validator(mode="after")
    def validate_interval(self) -> Self:
        if self.end_ms <= self.start_ms:
            raise ValueError("endMs must be greater than startMs")
        return self


CaptureLocatorV1 = Annotated[PageLocatorV1 | TimeLocatorV1, Field(discriminator="kind")]


class CaptureSourceV1(StrictModel):
    sha256: Sha256Hex
    file_name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)
    ]
    media_type: NonEmptyString
    bytes: int = Field(ge=1)


class CaptureEngineV1(StrictModel):
    engine: NonEmptyString
    model: NonEmptyString
    digest: EngineDigest
    device: NonEmptyString | None = None


class RawCaptureSegmentV1(StrictModel):
    segment_id: NonEmptyString
    order: int = Field(ge=0)
    locator: CaptureLocatorV1
    text: CaptureText


def project_source_text(segments: list[RawCaptureSegmentV1]) -> str:
    return "\n".join(segment.text for segment in segments)


class RawCaptureV1(StrictModel):
    schema_version: Literal["1"] = CAPTURE_DOCUMENT_SCHEMA_VERSION
    diagnostic_only: Literal[True] = True
    source: CaptureSourceV1
    segments: list[RawCaptureSegmentV1] = Field(min_length=1, max_length=10_000)
    source_text: ProjectedText
    extraction_engine: CaptureEngineV1
    warnings: list[WarningText] = Field(default_factory=list, max_length=1_000)
    created_at: datetime

    _aware_created_at = field_validator("created_at")(_require_aware)

    @model_validator(mode="after")
    def validate_projection(self) -> Self:
        expected_orders = list(range(len(self.segments)))
        if [segment.order for segment in self.segments] != expected_orders:
            raise ValueError("raw segment order must be contiguous and match list order")
        if self.source_text != project_source_text(self.segments):
            raise ValueError("sourceText must be the exact raw segment projection")
        identifiers = [segment.segment_id for segment in self.segments]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("raw segmentId values must be unique")
        return self


class CaptureBlockV1(StrictModel):
    block_id: NonEmptyString
    order: int = Field(ge=0)
    type: Literal["heading", "paragraph", "list-item", "table", "quote", "transcript"]
    source_segment_id: NonEmptyString
    locator: CaptureLocatorV1
    source_text: CaptureText
    target_text: CaptureText


class CaptureDocumentV1(StrictModel):
    schema_version: Literal["1"] = CAPTURE_DOCUMENT_SCHEMA_VERSION
    source: CaptureSourceV1
    raw_segments: list[RawCaptureSegmentV1] = Field(min_length=1, max_length=10_000)
    blocks: list[CaptureBlockV1] = Field(min_length=1, max_length=10_000)
    source_text: ProjectedText
    target_text: ProjectedText
    extraction_engine: CaptureEngineV1
    structuring_engine: CaptureEngineV1
    warnings: list[WarningText] = Field(default_factory=list, max_length=1_000)
    created_at: datetime
    completed_at: datetime

    _aware_created_at = field_validator("created_at")(_require_aware)
    _aware_completed_at = field_validator("completed_at")(_require_aware)

    @model_validator(mode="after")
    def validate_document(self) -> Self:
        if self.completed_at < self.created_at:
            raise ValueError("completedAt must not precede createdAt")
        if [segment.order for segment in self.raw_segments] != list(range(len(self.raw_segments))):
            raise ValueError("raw segment order must be contiguous and match list order")
        if [block.order for block in self.blocks] != list(range(len(self.blocks))):
            raise ValueError("block order must be contiguous and match list order")
        segment_ids = [segment.segment_id for segment in self.raw_segments]
        if len(segment_ids) != len(set(segment_ids)):
            raise ValueError("raw segmentId values must be unique")
        block_ids = [block.block_id for block in self.blocks]
        if len(block_ids) != len(set(block_ids)):
            raise ValueError("blockId values must be unique")
        segments_by_id = {segment.segment_id: segment for segment in self.raw_segments}
        if len(self.blocks) != len(self.raw_segments):
            raise ValueError("blocks must cover every raw segment exactly once")
        for index, block in enumerate(self.blocks):
            expected_segment = self.raw_segments[index]
            segment = segments_by_id.get(block.source_segment_id)
            if segment is None:
                raise ValueError("every block must reference a raw source segment")
            if block.source_segment_id != expected_segment.segment_id:
                raise ValueError("block sequence must follow raw segment order")
            if block.locator != segment.locator:
                raise ValueError("block locator must equal its raw source segment locator")
            if block.source_text != segment.text:
                raise ValueError("block sourceText must equal its raw source segment text")
        if self.source_text != project_source_text(self.raw_segments):
            raise ValueError("sourceText must be the exact raw segment projection")
        expected_target = "\n".join(block.target_text for block in self.blocks)
        if self.target_text != expected_target:
            raise ValueError("targetText must be the exact block target projection")
        return self


class CaptureFailureV1(StrictModel):
    code: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{1,63}$")]
    message: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    stage: NonEmptyString | None = None
    retryable: bool = False


class CaptureJobV1(StrictModel):
    capture_id: str
    status: CaptureJobStatus
    stage: CaptureJobStage
    structuring_mode: StructuringMode
    progress: float = Field(ge=0, le=1)
    source: CaptureSourceV1 | None = None
    error: CaptureFailureV1 | None = None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None

    _aware_times = field_validator("created_at", "updated_at", "completed_at")(
        lambda value: None if value is None else _require_aware(value)
    )

    @model_validator(mode="after")
    def validate_state(self) -> Self:
        terminal = {
            CaptureJobStatus.COMPLETED,
            CaptureJobStatus.FAILED,
            CaptureJobStatus.CANCELLED,
        }
        if (self.status in terminal) != (self.completed_at is not None):
            raise ValueError("terminal capture jobs must have completedAt")
        return self


class RuntimeArtifactDescriptorV1(StrictModel):
    artifact_url: NonEmptyString
    artifact_file_name: NonEmptyString
    bytes: int = Field(ge=1, le=536_870_912)
    sha256: Sha256Hex


class RuntimeRequirementV1(StrictModel):
    requirement_id: Literal[
        "windowsml-ocr",
        "whisper-primary",
        "ollama-runtime",
        "capture-ollama-model",
    ]
    kind: NonEmptyString
    display_name: NonEmptyString
    status: RuntimeRequirementStatus
    required_for: list[str]
    install_strategy: NonEmptyString
    detail: str | None = None
    artifact: RuntimeArtifactDescriptorV1 | None = None


class RuntimeRequirementsV1(StrictModel):
    items: list[RuntimeRequirementV1]


class StartRuntimeInstallationV1(StrictModel):
    requirement_id: Literal[
        "windowsml-ocr",
        "whisper-primary",
        "ollama-runtime",
        "capture-ollama-model",
    ]
    consent: Literal[True]


class RuntimeInstallationV1(StrictModel):
    installation_id: str
    requirement_id: Literal[
        "windowsml-ocr",
        "whisper-primary",
        "ollama-runtime",
        "capture-ollama-model",
    ]
    status: RuntimeInstallationStatus
    progress: float = Field(ge=0, le=1)
    error: CaptureFailureV1 | None = None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None

    _aware_times = field_validator("created_at", "updated_at", "completed_at")(
        lambda value: None if value is None else _require_aware(value)
    )


class RuntimeInstallationsV1(StrictModel):
    items: list[RuntimeInstallationV1]


class RuntimeCapabilitiesV1(StrictModel):
    capture_kinds: list[Literal["pdf", "image", "audio"]]
    structuring_modes: list[Literal["runtime", "host"]]
    supports_cancellation: Literal[True] = True
    supports_raw_diagnostics: Literal[True] = True
    max_upload_bytes: int = Field(gt=0)


class RuntimeReadyV1(StrictModel):
    ready: bool
    service: Literal["capture-runtime"] = "capture-runtime"
    api_version: Literal["1.0"] = API_VERSION
    runtime_version: Literal["0.1.0"] = RUNTIME_VERSION
    capture_document_schema_version: Literal["1"] = CAPTURE_DOCUMENT_SCHEMA_VERSION
    capabilities: RuntimeCapabilitiesV1
    message: str | None = None


class ReportStructuringFailureV1(StrictModel):
    code: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{1,63}$")]
    message: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]


class ErrorBodyV1(StrictModel):
    code: NonEmptyString
    message: NonEmptyString
    details: dict[str, Any] | None = None


class ErrorEnvelopeV1(StrictModel):
    error: ErrorBodyV1
