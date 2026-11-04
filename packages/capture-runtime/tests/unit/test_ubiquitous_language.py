"""Domain names come from the glossary, and API enum values from the concept set (DDD plan
section 5, decisions D11 and D12)."""

from __future__ import annotations

import inspect
import json
from collections import Counter
from enum import Enum
from typing import Any

from capture_runtime import contracts
from tests.semantic_layers import (
    VOCABULARY,
    documented_contexts,
    glossary_code_names,
    modules_of,
)


def _concepts() -> list[dict[str, Any]]:
    return json.loads(VOCABULARY.read_text(encoding="utf-8"))["concepts"]


def test_some_context_is_checked() -> None:
    assert "provisioning" in documented_contexts()


def test_public_domain_classes_are_named_in_the_glossary() -> None:
    names = glossary_code_names()
    missing: dict[str, list[str]] = {}
    for context in documented_contexts():
        for module in modules_of(f"capture_runtime.{context}.domain"):
            for name, value in vars(module).items():
                if (
                    not name.startswith("_")
                    and inspect.isclass(value)
                    and value.__module__ == module.__name__
                    and name not in names
                ):
                    missing.setdefault(context, []).append(name)

    assert missing == {}, f"add these names to the glossary or rename them: {missing}"


def test_concepts_have_unique_ids_and_mappings() -> None:
    concepts = _concepts()
    ids = Counter(concept["id"] for concept in concepts)
    mappings = Counter(
        (concept["enum"]["enumId"], concept["enum"]["value"])
        for concept in concepts
        if "enum" in concept
    )

    assert [concept_id for concept_id, count in ids.items() if count > 1] == []
    assert [mapping for mapping, count in mappings.items() if count > 1] == []
    assert all(concept["label"] and concept["codeName"] for concept in concepts)


def test_every_api_enum_value_of_a_modelled_context_maps_to_one_concept() -> None:
    # Context-to-enums mapping for modelled contexts
    context_enums: dict[str, list[type[Enum]]] = {
        "provisioning": [
            contracts.RuntimeInstallationStatus,
            contracts.RuntimeRequirementStatus,
        ],
        "diarization": [],
        "speech": [],
        "ocr": [
            contracts.OcrComputeMode,
            contracts.OcrAdapterClass,
            contracts.OcrComputeReasonCode,
            contracts.OcrComputeNoticeCode,
            contracts.OcrProjectionStatus,
            contracts.OcrPageStatus,
            contracts.OcrProvenanceStatus,
            contracts.OcrProvenanceUnavailableReason,
        ],
        "structuring": [
            contracts.StructuringMode,
            contracts.StructuringSessionStatus,
            contracts.StructuringBatchStatus,
        ],
    }
    mapped = {
        (concept["enum"]["enumId"], concept["enum"]["value"])
        for concept in _concepts()
        if "enum" in concept and not concept.get("retired")
    }

    for context in documented_contexts():
        if context not in context_enums:
            continue
        for enum_cls in context_enums[context]:
            enum_id = enum_cls.__name__
            for member in enum_cls:
                mapping = (enum_id, str(member.value))
                assert mapping in mapped, (
                    f"Missing concept mapping for {enum_id}.{member.name} ({member.value})"
                )
