"""Pydantic wire contracts for the Capture Runtime v2 API."""

from __future__ import annotations

import math
from datetime import datetime
from enum import StrEnum
from typing import Annotated, Any, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    RootModel,
    StringConstraints,
    TypeAdapter,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel

from capture_runtime.constants import API_VERSION, CAPTURE_DOCUMENT_SCHEMA_VERSION, RUNTIME_VERSION

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


class RuntimeInstallationStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    MANUAL_ACTION_REQUIRED = "manual_action_required"


class RuntimeModelOptionStatus(StrEnum):
    NOT_INSTALLED = "not-installed"
    INSTALLED = "installed"
    ACTIVE = "active"


class RuntimeRequirementStatus(StrEnum):
    READY = "ready"
    MISSING = "missing"
    INSTALLABLE = "installable"
    MANUAL_ACTION_REQUIRED = "manual_action_required"
    UNAVAILABLE = "unavailable"


class OcrComputeMode(StrEnum):
    GPU_DML = "gpu-dml"
    CPU_FALLBACK = "cpu-fallback"


class OcrAdapterClass(StrEnum):
    DEDICATED = "dedicated"
    INTEGRATED = "integrated"
    UNKNOWN = "unknown"


class OcrComputeReasonCode(StrEnum):
    NO_COMPATIBLE_GPU = "no_compatible_gpu"
    DML_PROVIDER_UNAVAILABLE = "dml_provider_unavailable"


class OcrComputeNoticeCode(StrEnum):
    CPU_FALLBACK = "ocr_cpu_fallback"


CaptureRequirementId = Literal[
    "windowsml-ocr",
    "whisper-primary",
    "ollama-runtime",
    "capture-ollama-model",
]


class PageLocator(StrictModel):
    kind: Literal["page"] = "page"
    page: int = Field(ge=1)
    bounding_box: tuple[float, float, float, float] | None = None


class TimeLocator(StrictModel):
    kind: Literal["time"] = "time"
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)

    @model_validator(mode="after")
    def validate_interval(self) -> Self:
        if self.end_ms <= self.start_ms:
            raise ValueError("endMs must be greater than startMs")
        return self


CaptureLocator = Annotated[PageLocator | TimeLocator, Field(discriminator="kind")]


class CaptureSource(StrictModel):
    sha256: Sha256Hex
    file_name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)
    ]
    media_type: NonEmptyString
    bytes: int = Field(ge=1)


class CaptureEngine(StrictModel):
    engine: NonEmptyString
    model: NonEmptyString
    digest: EngineDigest
    device: NonEmptyString | None = None


class StructuringSessionStatus(StrEnum):
    """Durable lifecycle states for a pull-based structuring session."""

    OPEN = "open"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class StructuringBatchStatus(StrEnum):
    """Durable lifecycle states for one provider-ready semantic batch."""

    READY = "ready"
    ACCEPTED = "accepted"
    FAILED = "failed"


class StructuringProviderCapabilityV2(StrictModel):
    """Provider identity and schema dialect negotiated for one session."""

    provider: CaptureEngine
    capability: NonEmptyString
    schema_dialect: NonEmptyString


class OpenStructuringSessionV2(StrictModel):
    """Authenticated request to open or replay a pull structuring session."""

    protocol_version: Literal["2"] = "2"
    capture_id: NonEmptyString
    target_language: str | None = None
    provider_capability: StructuringProviderCapabilityV2
    schema_dialect: NonEmptyString
    client_request_id: NonEmptyString

    @field_validator("target_language")
    @classmethod
    def validate_target_language(cls, value: str | None) -> str | None:
        if value is not None and not 1 <= len(value) <= 64:
            raise ValueError("targetLanguage must be 1 to 64 characters")
        return value

    @model_validator(mode="after")
    def validate_schema_dialect(self) -> Self:
        if self.provider_capability.schema_dialect != self.schema_dialect:
            raise ValueError("schemaDialect must match providerCapability.schemaDialect")
        return self


class StructuringSessionV2(StrictModel):
    """Current durable pull-session snapshot."""

    protocol_version: Literal["2"] = "2"
    session_id: NonEmptyString
    capture_id: NonEmptyString
    raw_source_sha256: Sha256Hex
    contract_set_sha256: Sha256Hex
    target_language: str | None = None
    provider_capability: StructuringProviderCapabilityV2
    schema_dialect: NonEmptyString
    batch_count: int = Field(ge=1)
    next_batch_index: int = Field(ge=0)
    session_digest: Sha256Hex
    status: StructuringSessionStatus
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None

    _aware_times = field_validator("created_at", "updated_at", "completed_at")(
        lambda value: None if value is None else _require_aware(value)
    )

    @model_validator(mode="after")
    def validate_state(self) -> Self:
        if self.provider_capability.schema_dialect != self.schema_dialect:
            raise ValueError("schemaDialect must match providerCapability.schemaDialect")
        if self.next_batch_index > self.batch_count:
            raise ValueError("nextBatchIndex must not exceed batchCount")
        terminal = {
            StructuringSessionStatus.COMPLETED,
            StructuringSessionStatus.FAILED,
            StructuringSessionStatus.CANCELLED,
        }
        if (self.status in terminal) != (self.completed_at is not None):
            raise ValueError("terminal structuring sessions must have completedAt")
        if self.status is StructuringSessionStatus.COMPLETED and (
            self.next_batch_index != self.batch_count
        ):
            raise ValueError("completed structuring sessions must accept every batch")
        return self


class StructuringBatchV2(StrictModel):
    """Provider-ready prompt/schema projection for one ordered batch."""

    protocol_version: Literal["2"] = "2"
    session_id: NonEmptyString
    capture_id: NonEmptyString
    batch_index: int = Field(ge=0)
    batch_count: int = Field(ge=1)
    source_segment_ids: list[NonEmptyString] = Field(min_length=1)
    provider_prompt: dict[str, object]
    provider_schema: dict[str, object]
    num_ctx: int = Field(gt=0)
    num_predict: int = Field(gt=0)
    batch_digest: Sha256Hex
    status: StructuringBatchStatus

    @model_validator(mode="after")
    def validate_index(self) -> Self:
        if self.batch_index >= self.batch_count:
            raise ValueError("batchIndex must be less than batchCount")
        return self


class StructuringSemanticBlockV2(StrictModel):
    """Minimal semantic block accepted from a pull-session provider."""

    source_segment_id: NonEmptyString
    type: Literal["heading", "paragraph", "list-item", "table", "quote", "transcript"]
    target_text: CaptureText | None = None


class SubmitStructuringBatchV2(StrictModel):
    """Strict minimal semantic batch submission body."""

    protocol_version: Literal["2"] = "2"
    batch_digest: Sha256Hex
    blocks: list[StructuringSemanticBlockV2] = Field(min_length=1)


class RawCaptureSegment(StrictModel):
    segment_id: NonEmptyString
    order: int = Field(ge=0)
    locator: CaptureLocator
    text: CaptureText


class OcrPageScopeV2(StrictModel):
    """Public evidence describing which PDF pages entered OCR."""

    source_page_count: int = Field(ge=1, le=500)
    requested_page_numbers: list[int] = Field(min_length=1, max_length=500)
    processed_page_numbers: list[int] = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_page_scope(self) -> Self:
        expected = list(range(1, len(self.requested_page_numbers) + 1))
        if self.requested_page_numbers != expected:
            raise ValueError("requested PDF pages must be an ordered prefix from page one")
        if self.requested_page_numbers[-1] > self.source_page_count:
            raise ValueError("requested PDF pages must exist in the source")
        if self.processed_page_numbers != self.requested_page_numbers:
            raise ValueError("processed PDF pages must equal requested PDF pages")
        return self


def project_source_text(segments: list[RawCaptureSegment]) -> str:
    return "\n".join(segment.text for segment in segments)


class RawCapture(StrictModel):
    schema_version: Literal["2"] = CAPTURE_DOCUMENT_SCHEMA_VERSION
    diagnostic_only: Literal[True] = True
    source: CaptureSource
    segments: list[RawCaptureSegment] = Field(min_length=1, max_length=10_000)
    source_text: ProjectedText
    extraction_engine: CaptureEngine
    warnings: list[WarningText] = Field(default_factory=list, max_length=1_000)
    ocr_page_scope: OcrPageScopeV2 | None = None
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


class CaptureBlock(StrictModel):
    block_id: NonEmptyString
    order: int = Field(ge=0)
    type: Literal["heading", "paragraph", "list-item", "table", "quote", "transcript"]
    source_segment_id: NonEmptyString
    locator: CaptureLocator
    source_text: CaptureText
    target_text: CaptureText


class CaptureDocument(StrictModel):
    schema_version: Literal["2"] = CAPTURE_DOCUMENT_SCHEMA_VERSION
    source: CaptureSource
    raw_segments: list[RawCaptureSegment] = Field(min_length=1, max_length=10_000)
    blocks: list[CaptureBlock] = Field(min_length=1, max_length=10_000)
    source_text: ProjectedText
    target_text: ProjectedText
    extraction_engine: CaptureEngine
    structuring_engine: CaptureEngine
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


class RuntimeArtifactDescriptorV2(StrictModel):
    artifact_url: NonEmptyString
    artifact_file_name: NonEmptyString
    bytes: int = Field(ge=1, le=536_870_912)
    sha256: Sha256Hex


class RuntimeRequirementV2(StrictModel):
    requirement_id: CaptureRequirementId
    kind: NonEmptyString
    display_name: NonEmptyString
    status: RuntimeRequirementStatus
    required_for: list[str]
    install_strategy: NonEmptyString
    detail: str | None = None
    artifact: RuntimeArtifactDescriptorV2 | None = None


class RuntimeRequirementsV2(StrictModel):
    items: list[RuntimeRequirementV2]


class StartRuntimeInstallationV2(StrictModel):
    requirement_id: CaptureRequirementId
    consent: Literal[True]


class RuntimeModelOptionV2(StrictModel):
    option_id: NonEmptyString
    display_name: NonEmptyString
    model_reference: NonEmptyString
    expected_digest: Sha256Hex | None = None
    expected_bytes: int | None = Field(default=None, ge=1)
    profile_id: NonEmptyString
    profile_spec_sha256: Sha256Hex
    status: RuntimeModelOptionStatus


class RuntimeModelOptionsV2(StrictModel):
    catalog_sha256: Sha256Hex
    items: list[RuntimeModelOptionV2]


class StartRuntimeModelInstallationV2(StrictModel):
    option_id: NonEmptyString
    consent: Literal[True]


class RuntimeModelInstallationV2(StrictModel):
    installation_id: str
    option_id: NonEmptyString
    status: RuntimeInstallationStatus
    progress: float = Field(ge=0, le=1)
    error: CaptureFailureV2 | None = None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None

    _aware_times = field_validator("created_at", "updated_at", "completed_at")(
        lambda value: None if value is None else _require_aware(value)
    )


class RuntimeModelInstallationsV2(StrictModel):
    items: list[RuntimeModelInstallationV2]


class RuntimeInstallationV2(StrictModel):
    installation_id: str
    requirement_id: CaptureRequirementId
    status: RuntimeInstallationStatus
    progress: float = Field(ge=0, le=1)
    error: CaptureFailureV2 | None = None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None

    _aware_times = field_validator("created_at", "updated_at", "completed_at")(
        lambda value: None if value is None else _require_aware(value)
    )


class RuntimeInstallationsV2(StrictModel):
    items: list[RuntimeInstallationV2]


class StreamingIngestionMode(StrEnum):
    FILE = "file"


class StreamingIngestionStatus(StrEnum):
    OPEN = "open"
    FINALIZING = "finalizing"
    READY = "ready"
    CANCELLED = "cancelled"
    FAILED = "failed"
    EXPIRED = "expired"


class StreamingCaptureStatus(StrEnum):
    CREATED = "created"
    WAITING_INPUT = "waiting_input"
    EXTRACTING = "extracting"
    AWAITING_STRUCTURING = "awaiting_structuring"
    STRUCTURING = "structuring"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class StreamingEventType(StrEnum):
    ACCEPTED = "accepted"
    INPUT_CHECKPOINT = "input_checkpoint"
    HEARTBEAT = "heartbeat"
    SEGMENT = "segment"
    CHECKPOINT = "checkpoint"
    RESYNC_REQUIRED = "resync_required"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class OpenIngestionV2(StrictModel):
    protocol_version: Literal["2"] = "2"
    kind: CaptureSourceKind = CaptureSourceKind.AUDIO
    mode: StreamingIngestionMode = StreamingIngestionMode.FILE
    client_request_id: NonEmptyString
    file_name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)
    ]
    media_type: NonEmptyString
    total_bytes: int = Field(gt=0)
    source_sha256: Sha256Hex | None = None


class IngestionV2(StrictModel):
    protocol_version: Literal["2"] = "2"
    kind: CaptureSourceKind = CaptureSourceKind.AUDIO
    ingestion_id: NonEmptyString
    status: StreamingIngestionStatus
    file_name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)
    ]
    media_type: NonEmptyString
    total_bytes: int = Field(gt=0)
    received_bytes: int = Field(ge=0)
    contiguous_bytes: int = Field(ge=0)
    next_chunk_index: int = Field(ge=0)
    next_offset: int = Field(ge=0)
    source_sha256: Sha256Hex | None = None
    finalized_sha256: Sha256Hex | None = None
    expires_at: datetime

    _aware_expires_at = field_validator("expires_at")(_require_aware)

    @model_validator(mode="after")
    def validate_progress(self) -> Self:
        if self.received_bytes > self.total_bytes:
            raise ValueError("receivedBytes must not exceed totalBytes")
        if self.contiguous_bytes > self.received_bytes:
            raise ValueError("contiguousBytes must not exceed receivedBytes")
        if self.next_offset != self.contiguous_bytes:
            raise ValueError("nextOffset must equal contiguousBytes")
        if self.status is StreamingIngestionStatus.READY:
            if self.received_bytes != self.total_bytes or self.finalized_sha256 is None:
                raise ValueError("ready ingestion must be complete and checksummed")
        return self


class StartCaptureV2(StrictModel):
    protocol_version: Literal["2"] = "2"
    client_request_id: NonEmptyString
    ingestion_id: NonEmptyString
    structuring_mode: StructuringMode
    target_language: str | None = None
    start_policy: Literal["eager"] = "eager"
    pdf_page_numbers: list[int] | None = Field(default=None, min_length=1, max_length=500)

    @field_validator("target_language")
    @classmethod
    def validate_target_language(cls, value: str | None) -> str | None:
        if value is not None and not 1 <= len(value) <= 64:
            raise ValueError("targetLanguage must be 1 to 64 characters")
        return value

    @field_validator("pdf_page_numbers")
    @classmethod
    def validate_pdf_page_numbers(cls, value: list[int] | None) -> list[int] | None:
        if value is None:
            return None
        if value != list(range(1, len(value) + 1)):
            raise ValueError("pdfPageNumbers must be an ordered prefix from page one")
        return value


class FinalizeIngestionV2(StrictModel):
    protocol_version: Literal["2"] = "2"
    total_bytes: int = Field(gt=0)
    sha256: Sha256Hex


class CaptureFailureV2(StrictModel):
    code: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{1,63}$")]
    message: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    stage: NonEmptyString | None = None
    retryable: bool = False


class OcrProjectionStatus(StrEnum):
    COMPLETED = "completed"
    FAILED = "failed"


class OcrPageStatus(StrEnum):
    RECOGNIZED = "recognized"
    EMPTY = "empty"
    FAILED = "failed"


class OcrProvenanceStatus(StrEnum):
    RESOLVED = "resolved"
    UNAVAILABLE = "unavailable"


class OcrProvenanceUnavailableReason(StrEnum):
    MODEL_UNAVAILABLE = "model_unavailable"
    WORKER_CRASHED = "worker_crashed"
    WORKER_TIMEOUT = "worker_timeout"
    PROTOCOL_FAILURE = "protocol_failure"


class OcrProvenanceResolvedV3(StrictModel):
    """Concrete OCR identity available after model/provider resolution."""

    status: Literal["resolved"]
    engine: Literal["windowsml-ocr"]
    model: NonEmptyString
    model_digest: EngineDigest = Field(json_schema_extra={"not": {"const": "sha256:" + "0" * 64}})
    device: NonEmptyString
    profile_id: NonEmptyString
    profile_spec_sha256: Sha256Hex

    @field_validator("model_digest")
    @classmethod
    def reject_unknown_model_digest(cls, value: str) -> str:
        if value == "sha256:" + "0" * 64:
            raise ValueError("modelDigest must identify a resolved model")
        return value


class OcrProvenanceUnavailableV3(StrictModel):
    """Profile identity retained when model identity is not yet available."""

    status: Literal["unavailable"]
    profile_id: NonEmptyString
    profile_spec_sha256: Sha256Hex
    reason: OcrProvenanceUnavailableReason


OcrProvenancePayloadV3 = Annotated[
    OcrProvenanceResolvedV3 | OcrProvenanceUnavailableV3,
    Field(discriminator="status"),
]


class OcrProvenanceV3(RootModel[OcrProvenancePayloadV3]):
    """Discriminated OCR provenance without fake model/device placeholders."""

    root: OcrProvenancePayloadV3

    def __init__(self, root: OcrProvenancePayloadV3 | None = None, **data: Any) -> None:
        if root is None:
            root = TypeAdapter(OcrProvenancePayloadV3).validate_python(data)
        elif data:
            raise TypeError("OcrProvenanceV3 accepts either root or wire fields, not both")
        elif isinstance(root, OcrProvenanceV3):
            root = root.root
        super().__init__(root=root)

    @property
    def status(self) -> Literal["resolved", "unavailable"]:
        return self.root.status

    @property
    def is_resolved(self) -> bool:
        return isinstance(self.root, OcrProvenanceResolvedV3)

    @property
    def profile_id(self) -> str:
        return self.root.profile_id

    @property
    def profile_spec_sha256(self) -> str:
        return self.root.profile_spec_sha256

    @property
    def reason(self) -> OcrProvenanceUnavailableReason:
        if not isinstance(self.root, OcrProvenanceUnavailableV3):
            raise AttributeError("resolved OCR provenance has no unavailable reason")
        return self.root.reason

    @property
    def engine(self) -> str:
        if not isinstance(self.root, OcrProvenanceResolvedV3):
            raise AttributeError("unavailable OCR provenance has no engine")
        return self.root.engine

    @property
    def model(self) -> str:
        if not isinstance(self.root, OcrProvenanceResolvedV3):
            raise AttributeError("unavailable OCR provenance has no model")
        return self.root.model

    @property
    def model_digest(self) -> str:
        if not isinstance(self.root, OcrProvenanceResolvedV3):
            raise AttributeError("unavailable OCR provenance has no model digest")
        return self.root.model_digest

    @property
    def device(self) -> str:
        if not isinstance(self.root, OcrProvenanceResolvedV3):
            raise AttributeError("unavailable OCR provenance has no device")
        return self.root.device


class OcrRasterV3(StrictModel):
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    scale: float = Field(gt=0, le=8)
    coordinate_system: Literal["pixel"]


class OcrPointV3(StrictModel):
    """One predictor-input pixel coordinate in polygon order."""

    x: float = Field(ge=0)
    y: float = Field(ge=0)

    @field_validator("x", "y")
    @classmethod
    def validate_coordinate(cls, value: float) -> float:
        if not math.isfinite(value) or value < 0:
            raise ValueError("OCR polygon coordinates must be finite and non-negative")
        return value


class OcrBoxV3(StrictModel):
    """A text region retaining the predictor polygon without rectangle loss."""

    polygon: list[OcrPointV3] = Field(min_length=4, max_length=256)
    text: ProjectedText
    confidence: float | None = Field(..., ge=0, le=1)

    @field_validator("confidence")
    @classmethod
    def validate_confidence(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("OCR box confidence must be finite")
        return value

    @property
    def x(self) -> int:
        return math.floor(min(point.x for point in self.polygon))

    @property
    def y(self) -> int:
        return math.floor(min(point.y for point in self.polygon))

    @property
    def width(self) -> int:
        return max(1, math.ceil(max(point.x for point in self.polygon)) - self.x)

    @property
    def height(self) -> int:
        return max(1, math.ceil(max(point.y for point in self.polygon)) - self.y)


class OcrPageProjectionV3(StrictModel):
    # Recognized pages carry the pipeline's arithmetic-mean score rounded to
    # four decimal places, or 0.0 when text is legal without numeric region
    # scores. None is reserved for empty and failed pages on the wire.
    page: int = Field(ge=1)
    status: OcrPageStatus
    raster: OcrRasterV3
    text: Annotated[str, StringConstraints(max_length=8_000_000)] = ""
    boxes: list[OcrBoxV3] = Field(default_factory=list, max_length=100_000)
    # ``null`` is a terminal empty/failed-page value; recognized pages are
    # validated below and receive either the rounded mean or the no-score 0.0.
    confidence: float | None = Field(default=None, ge=0, le=1)
    provenance: OcrProvenanceV3
    failure: CaptureFailureV2 | None = None

    @model_validator(mode="after")
    def validate_page_payload(self) -> Self:
        if self.status is not OcrPageStatus.FAILED and not self.provenance.is_resolved:
            raise ValueError("recognized and empty OCR pages require resolved provenance")
        raster = self.raster
        for box in self.boxes:
            if any(point.x > raster.width or point.y > raster.height for point in box.polygon):
                raise ValueError("OCR polygon must stay inside the raw raster bounds")
        if self.status is OcrPageStatus.RECOGNIZED:
            if not self.text.strip() or self.failure is not None or self.confidence is None:
                raise ValueError("recognized OCR pages require text, confidence, and no failure")
        elif self.status is OcrPageStatus.EMPTY:
            if (
                self.text.strip()
                or self.boxes
                or self.confidence is not None
                or self.failure is not None
            ):
                raise ValueError(
                    "empty OCR pages must not contain text, boxes, confidence, or failure"
                )
        else:
            if (
                self.text.strip()
                or self.boxes
                or self.confidence is not None
                or self.failure is None
            ):
                raise ValueError("failed OCR pages require only a typed failure")
        return self


class CaptureOcrProjectionV3(StrictModel):
    api_version: Literal["2.0"]
    schema_version: Literal["3"]
    capture_id: NonEmptyString
    status: OcrProjectionStatus
    source: CaptureSource | None = None
    # The wire projection always carries a page collection, including the
    # empty collection used by a failed run before a safe page count exists.
    # Requiring the member here keeps JSON Schema and runtime construction
    # semantics aligned while still allowing ``pages=[]``.
    pages: list[OcrPageProjectionV3] = Field(..., max_length=500)
    page_count: int = Field(ge=0, le=500)
    runtime_version: Literal[RUNTIME_VERSION]  # type: ignore[valid-type]
    contract_sha256: Sha256Hex
    provenance: OcrProvenanceV3
    warnings: list[WarningText] = Field(default_factory=list, max_length=1_000)
    failure: CaptureFailureV2 | None = None
    created_at: datetime

    _aware_created_at = field_validator("created_at")(_require_aware)

    @model_validator(mode="after")
    def validate_projection(self) -> Self:
        if self.page_count != len(self.pages):
            raise ValueError("pageCount must equal the number of OCR pages")
        if [page.page for page in self.pages] != list(range(1, len(self.pages) + 1)):
            raise ValueError("OCR pages must be complete and ordered from page one")
        if self.status is OcrProjectionStatus.COMPLETED:
            if not self.pages or self.failure is not None or self.source is None:
                raise ValueError(
                    "completed OCR projections require pages, source, provenance, and no failure"
                )
            if not self.provenance.is_resolved:
                raise ValueError("completed OCR projections require resolved provenance")
            if any(page.status is OcrPageStatus.FAILED for page in self.pages):
                raise ValueError("completed OCR projections must not contain failed pages")
            if not any(page.status is OcrPageStatus.RECOGNIZED for page in self.pages):
                raise ValueError("completed OCR projections require recognized text")
            if any(
                page.provenance is None or page.provenance != self.provenance for page in self.pages
            ):
                raise ValueError(
                    "completed OCR pages require provenance matching the document provenance"
                )
        elif self.failure is None:
            raise ValueError("failed OCR projections require a typed failure")
        for page in self.pages:
            if page.provenance != self.provenance:
                raise ValueError("page OCR provenance must match document provenance")
        return self


class ReportStructuringFailureV2(StrictModel):
    protocol_version: Literal["2"] = "2"
    code: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{1,63}$")]
    message: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]


class CaptureOperationV2(StrictModel):
    protocol_version: Literal["2"] = "2"
    capture_id: NonEmptyString
    ingestion_id: NonEmptyString
    kind: CaptureSourceKind = CaptureSourceKind.AUDIO
    status: StreamingCaptureStatus
    progress: float | None = Field(default=None, ge=0, le=1)
    partial_revision: int = Field(ge=0)
    last_event_sequence: int = Field(ge=0)
    source: CaptureSource | None = None
    error: CaptureFailureV2 | None = None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None

    _aware_times = field_validator("created_at", "updated_at", "completed_at")(
        lambda value: None if value is None else _require_aware(value)
    )

    @model_validator(mode="after")
    def validate_state(self) -> Self:
        terminal = {
            StreamingCaptureStatus.COMPLETED,
            StreamingCaptureStatus.FAILED,
            StreamingCaptureStatus.CANCELLED,
        }
        if (self.status in terminal) != (self.completed_at is not None):
            raise ValueError("terminal streaming captures must have completedAt")
        return self


class CaptureStreamingResult(StrictModel):
    operation: CaptureOperationV2
    raw: RawCapture
    result: CaptureDocument

    @model_validator(mode="after")
    def validate_source_identity(self) -> Self:
        if self.raw.source != self.result.source:
            raise ValueError("raw and structured result source identity must match")
        if self.operation.source is not None and self.operation.source != self.raw.source:
            raise ValueError("operation and result source identity must match")
        return self


class PartialCaptureV2(StrictModel):
    protocol_version: Literal["2"] = "2"
    capture_id: NonEmptyString
    source: CaptureSource
    revision: int = Field(ge=0)
    covered_until_ms: int = Field(ge=0)
    segments: list[RawCaptureSegment] = Field(default_factory=list, max_length=10_000)
    source_text: Annotated[str, StringConstraints(max_length=8_000_000)] = ""
    extraction_engine: CaptureEngine | None = None
    updated_at: datetime

    _aware_updated_at = field_validator("updated_at")(_require_aware)

    @model_validator(mode="after")
    def validate_projection(self) -> Self:
        if [segment.order for segment in self.segments] != list(range(len(self.segments))):
            raise ValueError("partial segment order must be contiguous")
        expected_text = project_source_text(self.segments) if self.segments else ""
        if self.source_text != expected_text:
            raise ValueError("sourceText must be the exact partial segment projection")
        return self


class CaptureEventV2(StrictModel):
    protocol_version: Literal["2"] = "2"
    event_id: NonEmptyString
    sequence: int = Field(ge=0)
    capture_id: NonEmptyString
    kind: CaptureSourceKind = CaptureSourceKind.AUDIO
    event_type: StreamingEventType
    stage: NonEmptyString
    progress: float | None = Field(default=None, ge=0, le=1)
    partial_revision: int | None = Field(default=None, ge=0)
    covered_until_ms: int | None = Field(default=None, ge=0)
    segments: list[RawCaptureSegment] = Field(default_factory=list, max_length=1_000)
    error: CaptureFailureV2 | None = None
    created_at: datetime

    _aware_created_at = field_validator("created_at")(_require_aware)

    @model_validator(mode="after")
    def validate_event_payload(self) -> Self:
        if self.event_type is StreamingEventType.SEGMENT and not self.segments:
            raise ValueError("segment events must contain at least one segment")
        if self.event_type is StreamingEventType.FAILED and self.error is None:
            raise ValueError("failed events must contain an error")
        if self.event_type is not StreamingEventType.FAILED and self.error is not None:
            raise ValueError("only failed events may contain an error")
        return self


class RuntimeStreamingCapabilitiesV2(StrictModel):
    protocol_version: Literal["2"] = "2"
    capture_kinds: list[CaptureSourceKind] = Field(
        default_factory=lambda: [
            CaptureSourceKind.PDF,
            CaptureSourceKind.IMAGE,
            CaptureSourceKind.AUDIO,
        ],
        min_length=1,
    )
    supports_progressive_audio: bool = True
    max_chunk_bytes: int = Field(gt=0, le=4 * 1024 * 1024)
    checkpoint_interval_ms: int = Field(gt=0)
    heartbeat_interval_ms: int = Field(gt=0)
    stall_timeout_ms: int = Field(gt=0)


class OcrComputePreflightV2(StrictModel):
    """Runtime-owned pre-OCR compute selection and user-notice contract."""

    api_version: Literal["2.0"] = API_VERSION
    schema_version: Literal["1"] = "1"
    service: Literal["capture-runtime"] = "capture-runtime"
    runtime_version: Literal["0.4.2"] = RUNTIME_VERSION
    contract_set_version: Literal["2"] = "2"
    contract_sha256: Sha256Hex
    # The worker computes this digest from its own executable. It is absent
    # for the setup-time decision seam before a worker is installed, while
    # production engine-manager probes require it to match the catalog.
    worker_sha256: Sha256Hex | None = None
    mode: OcrComputeMode
    adapter_class: OcrAdapterClass
    reason_code: OcrComputeReasonCode | None = None
    user_notice_required: bool
    notice_code: OcrComputeNoticeCode | None = None

    @model_validator(mode="after")
    def validate_decision(self) -> Self:
        if self.mode is OcrComputeMode.GPU_DML:
            if (
                self.reason_code is not None
                or self.user_notice_required
                or self.notice_code is not None
            ):
                raise ValueError("gpu-dml cannot carry a fallback reason or notice")
        elif (
            self.reason_code is None
            or not self.user_notice_required
            or self.notice_code is not OcrComputeNoticeCode.CPU_FALLBACK
        ):
            raise ValueError("cpu-fallback requires a reason and user notice")
        return self


class RuntimeReady(StrictModel):
    """General v2 readiness payload shared by runtime clients."""

    ready: bool
    service: Literal["capture-runtime"] = "capture-runtime"
    api_version: Literal["2.0"] = API_VERSION
    runtime_version: Literal["0.4.2"] = RUNTIME_VERSION
    capture_document_schema_version: Literal["2"] = CAPTURE_DOCUMENT_SCHEMA_VERSION
    capture_document_schema_sha256: Sha256Hex | None = None
    schema_sha256: Sha256Hex | None = None
    contract_set_version: Literal["2"] = "2"
    capabilities: dict[str, Any] = Field(default_factory=dict)
    ocr_compute: OcrComputePreflightV2 | None = None
    message: str | None = None


class ErrorBodyV2(StrictModel):
    code: NonEmptyString
    message: NonEmptyString
    details: dict[str, Any] | None = None


class ErrorEnvelopeV2(StrictModel):
    error: ErrorBodyV2
