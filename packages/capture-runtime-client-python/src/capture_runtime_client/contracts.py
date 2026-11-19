"""Public v2 contract DTOs backed by private generated wire models.

The generated module is an SDK build input only. Consumers receive deliberate
canonical names from this module; generated identifiers never form part of the
package's public surface.
"""

from __future__ import annotations

import hashlib
import json
from importlib.resources import files
from typing import Any, cast

from .private import generated_models as _generated

for _generated_name in (
    "StructuringModelInstallation",
    "StructuringModelInstallations",
    "RuntimeInstallation",
    "RuntimeInstallations",
    "CaptureOperation",
    "PartialCapture",
    "CaptureEvent",
    "OcrPageProjection",
    "CaptureOcrProjection",
    "StructuringProviderCapability",
    "OpenStructuringSession",
    "StructuringSession",
    "StructuringBatch",
    "StructuringSemanticBlock",
    "SubmitStructuringBatch",
):
    getattr(_generated, _generated_name).model_rebuild(
        force=True,
        _types_namespace=vars(_generated),
    )

CAPTURE_API_VERSION = "2.0"
CAPTURE_DOCUMENT_SCHEMA_VERSION = _generated.CAPTURE_DOCUMENT_SCHEMA_VERSION
CAPTURE_RUNTIME_VERSION = _generated.RUNTIME_VERSION
CAPTURE_DOCUMENT_SCHEMA_ID = (
    "https://github.com/gx-capture/capture-workbench/schema/capture-document-v2.schema.json"
)
CAPTURE_DOCUMENT_SCHEMA_SHA256 = "e3a68a577acc740fb79abcd8a0ca59cfc93c7bffd8eec3fc154aec50b9fc4b01"
_CONTRACT_SET_ASSETS = files("capture_runtime_client.private.assets")
CAPTURE_CONTRACT_SET_SHA256 = (
    _CONTRACT_SET_ASSETS.joinpath("contract-set.sha256").read_text(encoding="ascii").strip()
)
if (
    hashlib.sha256(_CONTRACT_SET_ASSETS.joinpath("contract-set.json").read_bytes()).hexdigest()
    != CAPTURE_CONTRACT_SET_SHA256
):
    raise RuntimeError("Packaged contract-set asset does not match its SHA-256 allowlist.")


# Public v2 DTOs.  These subclasses intentionally create a stable public seam
# without exporting the generated module or its model names.  Pydantic keeps
# inherited strict/alias validation, while each class has a canonical v2 name
# for consumers and package introspection.
class CaptureSource(_generated.CaptureSource):
    pass


class CaptureEngine(_generated.CaptureEngine):
    pass


class RawCaptureSegment(_generated.RawCaptureSegment):
    pass


class CaptureBlock(_generated.CaptureBlock):
    pass


class OperationFailure(_generated.OperationFailure):
    pass


class OcrRaster(_generated.OcrRaster):
    pass


class OcrPoint(_generated.OcrPoint):
    pass


class OcrBox(_generated.OcrBox):
    pass


class OcrProvenance(_generated.OcrProvenance):
    pass


class OcrProvenanceResolved(_generated.OcrProvenanceResolved):
    pass


class OcrProvenanceUnavailable(_generated.OcrProvenanceUnavailable):
    pass


class OcrPageProjection(_generated.OcrPageProjection):
    pass


class CaptureOcrProjection(_generated.CaptureOcrProjection):
    pass


class CaptureDocument(_generated.CaptureDocument):
    pass


class RawCapture(_generated.RawCapture):
    pass


class RuntimeArtifactDescriptor(_generated.RuntimeArtifactDescriptor):
    pass


class RuntimeRequirement(_generated.RuntimeRequirement):
    pass


class RuntimeRequirements(_generated.RuntimeRequirements):
    pass


class StructuringModelOption(_generated.StructuringModelOption):
    pass


class StructuringModelOptions(_generated.StructuringModelOptions):
    pass


class StructuringModelInstallation(_generated.StructuringModelInstallation):
    pass


class StructuringModelInstallations(_generated.StructuringModelInstallations):
    pass


class RuntimeInstallation(_generated.RuntimeInstallation):
    pass


class RuntimeInstallations(_generated.RuntimeInstallations):
    pass


class OpenIngestion(_generated.OpenIngestion):
    pass


class Ingestion(_generated.Ingestion):
    pass


class StartCapture(_generated.StartCapture):
    pass


class FinalizeIngestion(_generated.FinalizeIngestion):
    pass


class CaptureOperation(_generated.CaptureOperation):
    pass


class PartialCapture(_generated.PartialCapture):
    pass


class CaptureEvent(_generated.CaptureEvent):
    pass


class StructuringProviderCapability(_generated.StructuringProviderCapability):
    pass


class OpenStructuringSession(_generated.OpenStructuringSession):
    pass


class StructuringSession(_generated.StructuringSession):
    pass


class StructuringBatch(_generated.StructuringBatch):
    pass


class StructuringSemanticBlock(_generated.StructuringSemanticBlock):
    pass


class SubmitStructuringBatch(_generated.SubmitStructuringBatch):
    pass


class RuntimeCapabilities(_generated.RuntimeCapabilities):
    pass


class OcrComputePreflight(_generated.OcrComputePreflight):
    pass


class RuntimeReady(_generated.StrictModel):
    """General v2 readiness payload shared by discovery clients."""

    ready: bool
    service: str
    api_version: str
    runtime_version: str
    capture_document_schema_version: str
    capture_document_schema_sha256: str | None = None
    contract_set_version: str = "2"
    capabilities: RuntimeCapabilities
    ocr_compute: OcrComputePreflight | None = None
    message: str | None = None


class ReportStructuringFailure(_generated.ReportStructuringFailure):
    pass


class ErrorBody(_generated.ErrorBody):
    pass


class ErrorEnvelope(_generated.ErrorEnvelope):
    pass


CaptureLocator = _generated.CaptureLocator
PageLocator = _generated.PageLocator
TimeLocator = _generated.TimeLocator

CaptureSourceKind = _generated.CaptureSourceKind
StructuringMode = _generated.StructuringMode
StructuringSessionStatus = _generated.StructuringSessionStatus
StructuringBatchStatus = _generated.StructuringBatchStatus
RuntimeInstallationStatus = _generated.RuntimeInstallationStatus
StructuringModelOptionStatus = _generated.StructuringModelOptionStatus
RuntimeRequirementStatus = _generated.RuntimeRequirementStatus
IngestionMode = _generated.IngestionMode
IngestionStatus = _generated.IngestionStatus
CaptureStatus = _generated.CaptureStatus
CaptureEventType = _generated.CaptureEventType
OcrProjectionStatus = _generated.OcrProjectionStatus
OcrPageStatus = _generated.OcrPageStatus
OcrProvenanceStatus = _generated.OcrProvenanceStatus
OcrProvenanceUnavailableReason = _generated.OcrProvenanceUnavailableReason
CaptureRequirementId = _generated.CaptureRequirementId
# The requirements a general installation installs; the structuring model is
# installed through `start_model_installation` with a chosen option.
InstallableRequirementId = _generated.InstallableRequirementId
project_source_text = _generated.project_source_text


def _load_contract_schema(name: str) -> dict[str, Any]:
    filename = {
        "RawCapture": "raw-capture.schema.json",
        "CaptureDocument": "capture-document.schema.json",
        "CaptureOcrProjection": "capture-ocr-projection.schema.json",
    }.get(name)
    if filename is None:
        raise ValueError(f"Unknown generated contract schema: {name}")
    return cast(
        dict[str, Any],
        json.loads(files("capture_runtime_client.private.schemas").joinpath(filename).read_text()),
    )


def _load_contract_manifest() -> dict[str, Any]:
    return {
        "manifestVersion": "1",
        "packageVersion": CAPTURE_RUNTIME_VERSION,
        "runtimeVersion": CAPTURE_RUNTIME_VERSION,
        "apiVersion": CAPTURE_API_VERSION,
        "captureDocumentSchemaVersion": CAPTURE_DOCUMENT_SCHEMA_VERSION,
        "captureDocumentSchemaId": CAPTURE_DOCUMENT_SCHEMA_ID,
        "captureDocumentSchemaSha256": CAPTURE_DOCUMENT_SCHEMA_SHA256,
    }


def _load_contract_constraints() -> dict[str, Any]:
    return {"invariants": []}


__all__ = [
    "CAPTURE_API_VERSION",
    "CAPTURE_DOCUMENT_SCHEMA_ID",
    "CAPTURE_DOCUMENT_SCHEMA_SHA256",
    "CAPTURE_CONTRACT_SET_SHA256",
    "CAPTURE_DOCUMENT_SCHEMA_VERSION",
    "CAPTURE_RUNTIME_VERSION",
    "CaptureLocator",
    "PageLocator",
    "TimeLocator",
    "CaptureSource",
    "CaptureEngine",
    "RawCaptureSegment",
    "CaptureBlock",
    "OperationFailure",
    "OcrRaster",
    "OcrPoint",
    "OcrBox",
    "OcrProvenance",
    "OcrProvenanceResolved",
    "OcrProvenanceUnavailable",
    "OcrPageProjection",
    "CaptureOcrProjection",
    "CaptureDocument",
    "RawCapture",
    "RuntimeArtifactDescriptor",
    "RuntimeRequirement",
    "RuntimeRequirements",
    "StructuringModelOption",
    "StructuringModelOptions",
    "StructuringModelInstallation",
    "StructuringModelInstallations",
    "RuntimeInstallation",
    "RuntimeInstallations",
    "OpenIngestion",
    "Ingestion",
    "StartCapture",
    "FinalizeIngestion",
    "CaptureOperation",
    "PartialCapture",
    "CaptureEvent",
    "StructuringProviderCapability",
    "OpenStructuringSession",
    "StructuringSession",
    "StructuringBatch",
    "StructuringSemanticBlock",
    "SubmitStructuringBatch",
    "RuntimeCapabilities",
    "OcrComputePreflight",
    "RuntimeReady",
    "ReportStructuringFailure",
    "ErrorBody",
    "ErrorEnvelope",
    "CaptureSourceKind",
    "StructuringMode",
    "StructuringSessionStatus",
    "StructuringBatchStatus",
    "RuntimeInstallationStatus",
    "StructuringModelOptionStatus",
    "RuntimeRequirementStatus",
    "IngestionMode",
    "IngestionStatus",
    "CaptureStatus",
    "CaptureEventType",
    "OcrProjectionStatus",
    "OcrPageStatus",
    "OcrProvenanceStatus",
    "OcrProvenanceUnavailableReason",
    "CaptureRequirementId",
    "InstallableRequirementId",
    "project_source_text",
]
