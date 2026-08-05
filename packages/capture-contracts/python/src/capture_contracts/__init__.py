"""Generated Capture Workbench wire-contract artifacts.

The runtime owns canonical validation. Hosts may use these schemas and
generated Pydantic models, but must submit the final candidate to the runtime's
validation endpoint before persisting it.
"""

from __future__ import annotations

import json
from importlib.resources import files
from typing import Any

try:
    from .generated_models import *  # noqa: F401,F403
    from .generated_models import __all__ as _generated_model_names
except ModuleNotFoundError as error:
    # The runtime generator imports its own package before the first generated
    # model file exists. Installed wheels must always include this artifact.
    if error.name != "capture_contracts.generated_models":
        raise
    _generated_model_names = ()


def _manifest() -> dict[str, Any]:
    return json.loads(
        files("capture_contracts")
        .joinpath("contract-manifest.json")
        .read_text(encoding="utf-8")
    )


_METADATA = _manifest()
CAPTURE_API_VERSION = _METADATA["apiVersion"]
CAPTURE_DOCUMENT_SCHEMA_ID = _METADATA["captureDocumentSchemaId"]
CAPTURE_DOCUMENT_SCHEMA_SHA256 = _METADATA["captureDocumentSchemaSha256"]
CAPTURE_DOCUMENT_SCHEMA_VERSION = _METADATA["captureDocumentSchemaVersion"]
CAPTURE_RUNTIME_VERSION = _METADATA["runtimeVersion"]


def load_contract_schema(name: str) -> dict[str, Any]:
    """Load one generated JSON Schema by its canonical contract name."""

    model = next(
        (item for item in _manifest()["models"] if item["name"] == name), None
    )
    if model is None:
        raise ValueError(f"Unknown generated contract schema: {name}")
    return json.loads(
        files("capture_contracts")
        .joinpath("schemas", model["schemaFile"])
        .read_text(encoding="utf-8")
    )


def load_contract_constraints() -> dict[str, Any]:
    """Load generated semantic invariants not expressible in JSON Schema."""

    return {"invariants": _manifest()["invariants"]}


__all__ = [
    "CAPTURE_API_VERSION",
    "CAPTURE_DOCUMENT_SCHEMA_ID",
    "CAPTURE_DOCUMENT_SCHEMA_SHA256",
    "CAPTURE_DOCUMENT_SCHEMA_VERSION",
    "CAPTURE_RUNTIME_VERSION",
    "load_contract_constraints",
    "load_contract_manifest",
    "load_contract_schema",
    *_generated_model_names,
]


def load_contract_manifest() -> dict[str, Any]:
    """Load the generated manifest, including model hashes and invariants."""

    return _manifest()
