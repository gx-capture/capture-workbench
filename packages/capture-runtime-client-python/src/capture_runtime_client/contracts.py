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

from pydantic import Field

from .private import generated_models as _generated

for _generated_name in (
    "RuntimeModelInstallationV2",
    "RuntimeModelInstallationsV2",
    "RuntimeInstallationV2",
    "RuntimeInstallationsV2",
    "CaptureOperationV2",
    "PartialCaptureV2",
    "CaptureEventV2",
):
    getattr(_generated, _generated_name).model_rebuild(
        force=True,
        _types_namespace=vars(_generated),
    )

CAPTURE_API_VERSION = "2.0"
CAPTURE_DOCUMENT_SCHEMA_VERSION = _generated.CAPTURE_DOCUMENT_SCHEMA_VERSION
CAPTURE_RUNTIME_VERSION = "0.4.0"
CAPTURE_DOCUMENT_SCHEMA_ID = (
    "https://github.com/gx-capture/capture-workbench/schema/capture-document-v2.schema.json"
)
CAPTURE_DOCUMENT_SCHEMA_SHA256 = "850afd212d049c25da41d3867ba5477451a6a2c6c7e41f116fe60f26b6a35335"
_CONTRACT_SET_ASSETS = files("capture_runtime_client.private.assets")
CAPTURE_CONTRACT_SET_SHA256 = _CONTRACT_SET_ASSETS.joinpath(
    "contract-set.sha256"
).read_text(encoding="ascii").strip()
if hashlib.sha256(
    _CONTRACT_SET_ASSETS.joinpath("contract-set.json").read_bytes()
).hexdigest() != CAPTURE_CONTRACT_SET_SHA256:
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


class CaptureFailure(_generated.CaptureFailureV2):
    pass


class CaptureDocument(_generated.CaptureDocument):
    pass


class RawCapture(_generated.RawCapture):
    pass


class RuntimeArtifactDescriptor(_generated.RuntimeArtifactDescriptorV2):
    pass


class RuntimeRequirement(_generated.RuntimeRequirementV2):
    pass


class RuntimeRequirements(_generated.RuntimeRequirementsV2):
    pass


class RuntimeModelOption(_generated.RuntimeModelOptionV2):
    pass


class RuntimeModelOptions(_generated.RuntimeModelOptionsV2):
    pass


class RuntimeModelInstallation(_generated.RuntimeModelInstallationV2):
    pass


class RuntimeModelInstallations(_generated.RuntimeModelInstallationsV2):
    pass


class RuntimeInstallation(_generated.RuntimeInstallationV2):
    pass


class RuntimeInstallations(_generated.RuntimeInstallationsV2):
    pass


class OpenIngestion(_generated.OpenIngestionV2):
    pass


class Ingestion(_generated.IngestionV2):
    pass


class StartCapture(_generated.StartCaptureV2):
    pass


class FinalizeIngestion(_generated.FinalizeIngestionV2):
    pass


class CaptureOperation(_generated.CaptureOperationV2):
    pass


class PartialCapture(_generated.PartialCaptureV2):
    pass


class CaptureEvent(_generated.CaptureEventV2):
    pass


class RuntimeStreamingCapabilities(_generated.RuntimeStreamingCapabilitiesV2):
    pass


class RuntimeReady(_generated.StrictModel):
    """General v2 readiness payload shared by discovery clients."""

    ready: bool
    service: str
    api_version: str
    runtime_version: str
    capture_document_schema_version: str
    capture_document_schema_sha256: str | None = None
    schema_sha256: str | None = None
    contract_set_version: str = "2"
    capabilities: dict[str, Any] = Field(default_factory=dict)
    message: str | None = None


class ReportStructuringFailure(_generated.ReportStructuringFailureV2):
    pass


class ErrorBody(_generated.ErrorBodyV2):
    pass


class ErrorEnvelope(_generated.ErrorEnvelopeV2):
    pass


CaptureLocator = _generated.CaptureLocator
PageLocator = _generated.PageLocator
TimeLocator = _generated.TimeLocator

CaptureSourceKind = _generated.CaptureSourceKind
StructuringMode = _generated.StructuringMode
RuntimeInstallationStatus = _generated.RuntimeInstallationStatus
RuntimeModelOptionStatus = _generated.RuntimeModelOptionStatus
RuntimeRequirementStatus = _generated.RuntimeRequirementStatus
StreamingIngestionMode = _generated.StreamingIngestionMode
StreamingIngestionStatus = _generated.StreamingIngestionStatus
StreamingCaptureStatus = _generated.StreamingCaptureStatus
StreamingEventType = _generated.StreamingEventType
CaptureRequirementId = _generated.CaptureRequirementId
project_source_text = _generated.project_source_text


def _load_contract_schema(name: str) -> dict[str, Any]:
    filename = {
        "RawCapture": "raw-capture.schema.json",
        "CaptureDocument": "capture-document.schema.json",
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
    "CaptureFailure",
    "CaptureDocument",
    "RawCapture",
    "RuntimeArtifactDescriptor",
    "RuntimeRequirement",
    "RuntimeRequirements",
    "RuntimeModelOption",
    "RuntimeModelOptions",
    "RuntimeModelInstallation",
    "RuntimeModelInstallations",
    "RuntimeInstallation",
    "RuntimeInstallations",
    "OpenIngestion",
    "Ingestion",
    "StartCapture",
    "FinalizeIngestion",
    "CaptureOperation",
    "PartialCapture",
    "CaptureEvent",
    "RuntimeStreamingCapabilities",
    "RuntimeReady",
    "ReportStructuringFailure",
    "ErrorBody",
    "ErrorEnvelope",
    "CaptureSourceKind",
    "StructuringMode",
    "RuntimeInstallationStatus",
    "RuntimeModelOptionStatus",
    "RuntimeRequirementStatus",
    "StreamingIngestionMode",
    "StreamingIngestionStatus",
    "StreamingCaptureStatus",
    "StreamingEventType",
    "CaptureRequirementId",
    "project_source_text",
]
