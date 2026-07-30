"""Deterministic schema and release-manifest generation."""

from __future__ import annotations

import hashlib
import json
import shutil
import zipfile
from pathlib import Path
from typing import Any

from capture_runtime.constants import (
    API_VERSION,
    CAPTURE_DOCUMENT_SCHEMA_VERSION,
    RUNTIME_VERSION,
)
from capture_runtime.contracts import CaptureDocumentV1

CAPTURE_DOCUMENT_SCHEMA_ID = (
    "https://github.com/gx-capture/capture-workbench/schema/capture-document-v1.schema.json"
)
CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256 = (
    "2721093496a9f09044d5737cce70d2356d5f71757b1cd23a960e1d003ea014f2"
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _validated_engine_release_files(
    engine_dir: Path,
    engine_catalog: Path,
) -> tuple[Path, ...]:
    from capture_runtime.engine_catalog import EngineCatalog, canonical_json_bytes

    if not engine_dir.is_dir():
        raise FileNotFoundError(engine_dir)
    if not engine_catalog.is_file():
        raise FileNotFoundError(engine_catalog)
    catalog = EngineCatalog.from_dict(json.loads(engine_catalog.read_text(encoding="utf-8")))
    if engine_catalog.read_bytes() != canonical_json_bytes(catalog.to_dict()):
        raise ValueError("release engine catalog bytes are not canonical")
    requirement_ids = {item.requirement_id for item in catalog.requirements}
    if not requirement_ids:
        return ()
    if requirement_ids != {"windowsml-ocr", "whisper-primary"}:
        raise ValueError("release engine catalog requirement set is invalid")
    incomplete = [item.requirement_id for item in catalog.requirements if not item.complete]
    if incomplete:
        raise ValueError("release engine catalog is incomplete: " + ", ".join(incomplete))

    manifests = tuple(
        item
        for item in engine_dir.iterdir()
        if item.is_file() and item.name.endswith("-files.json")
    )
    selected: set[Path] = set()
    for requirement in catalog.requirements:
        for descriptor in requirement.artifacts:
            archive = engine_dir / descriptor.file_name
            if not archive.is_file():
                raise ValueError(
                    f"catalog artifact is absent from engine directory: {archive.name}"
                )
            if archive.stat().st_size != descriptor.bytes:
                raise ValueError(f"catalog artifact byte count mismatch: {archive.name}")
            if sha256_file(archive) != descriptor.sha256:
                raise ValueError(f"catalog artifact checksum mismatch: {archive.name}")
            matching_manifests = [
                item for item in manifests if sha256_file(item) == descriptor.files_manifest_sha256
            ]
            if len(matching_manifests) != 1:
                raise ValueError(
                    f"catalog artifact needs exactly one matching files manifest: {archive.name}"
                )
            manifest = matching_manifests[0]
            with zipfile.ZipFile(archive) as source:
                if source.read("files-manifest.json") != manifest.read_bytes():
                    raise ValueError(
                        f"archive inner manifest differs from release sidecar: {archive.name}"
                    )
                if sum(item.file_size for item in source.infolist()) != descriptor.extracted_bytes:
                    raise ValueError(f"catalog extracted byte count mismatch: {archive.name}")
            selected.update((archive, manifest))

    engine_files = {
        item
        for item in engine_dir.iterdir()
        if item.is_file() and (item.suffix == ".zip" or item.name.endswith("-files.json"))
    }
    if engine_files != selected:
        unexpected = ", ".join(sorted(item.name for item in engine_files - selected))
        raise ValueError(f"engine directory contains uncatalogued release artifacts: {unexpected}")
    return tuple(sorted(selected, key=lambda item: item.name))


def capture_document_schema() -> dict[str, Any]:
    """Return the authoritative semantic CaptureDocumentV1 JSON Schema."""

    schema = CaptureDocumentV1.model_json_schema(by_alias=True)
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["$id"] = CAPTURE_DOCUMENT_SCHEMA_ID
    return schema


def capture_document_schema_release_bytes() -> bytes:
    """Serialize the v1 release schema with deterministic Windows CRLF bytes."""

    serialized = json.dumps(capture_document_schema(), ensure_ascii=False, indent=2, sort_keys=True)
    return (serialized.replace("\n", "\r\n") + "\r\n").encode("utf-8")


def capture_document_schema_release_sha256() -> str:
    return hashlib.sha256(capture_document_schema_release_bytes()).hexdigest()


def write_capture_document_schema(output: Path) -> Path:
    schema_bytes = capture_document_schema_release_bytes()
    digest = hashlib.sha256(schema_bytes).hexdigest()
    if digest != CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256:
        raise ValueError(
            "CaptureDocumentV1 schema bytes changed without an intentional schema release"
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(schema_bytes)
    return output


def build_release_artifacts(
    *,
    executable: Path,
    schema: Path,
    output_dir: Path,
    engine_dir: Path | None = None,
    engine_catalog: Path | None = None,
) -> dict[str, Any]:
    if not executable.is_file():
        raise FileNotFoundError(executable)
    if not schema.is_file():
        raise FileNotFoundError(schema)
    json.loads(schema.read_text(encoding="utf-8"))
    engine_files: tuple[Path, ...] = ()
    if (engine_dir is None) != (engine_catalog is None):
        raise ValueError("release engine directory and catalog must be supplied together")
    if engine_dir is not None and engine_catalog is not None:
        engine_files = _validated_engine_release_files(engine_dir, engine_catalog)
    resolved_output_dir = output_dir.resolve()
    if resolved_output_dir == Path(resolved_output_dir.anchor):
        raise ValueError("release output directory cannot be a filesystem root")
    protected_inputs = (executable, schema, *engine_files)
    if engine_dir is not None:
        protected_inputs += (engine_dir,)
    if engine_catalog is not None:
        protected_inputs += (engine_catalog,)
    if any(item.resolve().is_relative_to(resolved_output_dir) for item in protected_inputs):
        raise ValueError("release output directory cannot contain release inputs")
    if output_dir.exists():
        if not output_dir.is_dir():
            raise NotADirectoryError(output_dir)
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    released_executable = output_dir / "capture-runtime-x86_64-pc-windows-msvc.exe"
    released_schema = output_dir / "capture-document-v1.schema.json"
    shutil.copy2(executable, released_executable)
    shutil.copy2(schema, released_schema)
    manifest: dict[str, Any] = {
        "manifestVersion": "1",
        "runtimeVersion": RUNTIME_VERSION,
        "apiVersion": API_VERSION,
        "captureDocumentSchemaVersion": CAPTURE_DOCUMENT_SCHEMA_VERSION,
        "platform": "windows",
        "arch": "x86_64",
        "fileName": released_executable.name,
        "bytes": released_executable.stat().st_size,
        "sha256": sha256_file(released_executable),
        "schemaFileName": released_schema.name,
        "schemaSha256": sha256_file(released_schema),
    }
    (output_dir / "capture-runtime-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (output_dir / f"{released_executable.name}.sha256").write_text(
        f"{manifest['sha256']}  {released_executable.name}\n",
        encoding="utf-8",
    )
    if engine_files:
        for item in engine_files:
            shutil.copy2(item, output_dir / item.name)
            (output_dir / f"{item.name}.sha256").write_text(
                f"{sha256_file(item)}  {item.name}\n",
                encoding="utf-8",
            )
    if engine_catalog is not None:
        released_catalog = output_dir / "capture-engine-catalog.json"
        shutil.copy2(engine_catalog, released_catalog)
        (output_dir / f"{released_catalog.name}.sha256").write_text(
            f"{sha256_file(released_catalog)}  {released_catalog.name}\n",
            encoding="utf-8",
        )
    return manifest
