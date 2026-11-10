"""A requirement is either today's one delivery or cuda and cpu contents."""

from __future__ import annotations

import hashlib

import pytest

from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.provisioning.infrastructure.engine_catalog import (
    ActiveEngineState,
    EngineCatalog,
    EngineCatalogError,
    EngineRequirementDescriptor,
    canonical_json_bytes,
)

_REVISION = "a" * 40


def _sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _model_file(
    path: str,
    content: bytes,
    *,
    kind: str,
    derivation: dict[str, object] | None = None,
) -> dict[str, object]:
    return {
        "bytes": len(content),
        "derivation": derivation,
        "kind": kind,
        "licensePath": None if kind in {"license", "notice"} else "licenses/LICENSE.txt",
        "noticePath": None if kind in {"license", "notice"} else "notices/NOTICE.txt",
        "owner": "test-owner",
        "path": path,
        "redirectHosts": [],
        "revision": _REVISION,
        "sha256": _sha(content),
        "spdx": "MIT",
        "url": f"https://downloads.example.test/{_REVISION}/{path}",
    }


def _delivery(version: str, files: list[dict[str, object]]) -> dict[str, object]:
    ordered = sorted(files, key=lambda item: str(item["path"]))
    manifest = {
        "artifactVersion": version,
        "entryPoint": "model",
        "files": ordered,
        "manifestVersion": "1",
    }
    return {
        "artifactVersion": version,
        "entryCount": len(ordered),
        "entryPoint": "model",
        "extractedBytes": sum(int(item["bytes"]) for item in ordered),
        "files": ordered,
        "manifestSha256": _sha(canonical_json_bytes(manifest)),
        "sourceLockSha256": "b" * 64,
    }


def _worker(requirement_id: str, *, file_name: str, size: int) -> dict[str, object]:
    return {
        "role": "worker",
        "requirementId": requirement_id,
        "artifactVersion": "engine-1",
        "workerProtocolVersion": "1",
        "platform": "windows",
        "arch": "x86_64",
        "fileName": file_name,
        "bytes": size,
        "sha256": _sha(f"{file_name}:{size}".encode()),
        "extractedBytes": 1,
        "entryPoint": f"{file_name.removesuffix('.zip')}.exe",
        "filesManifestSha256": "e" * 64,
        "url": f"https://downloads.example.test/{file_name}",
    }


def _pack(
    requirement_id: str,
    *,
    file_name: str,
    worker_bytes: int,
    model_path: str,
    model_content: bytes,
) -> dict[str, object]:
    return {
        "artifacts": [_worker(requirement_id, file_name=file_name, size=worker_bytes)],
        "modelFiles": _delivery(
            "engine-1",
            [
                _model_file("licenses/LICENSE.txt", b"license", kind="license"),
                _model_file(model_path, model_content, kind="source"),
                _model_file("notices/NOTICE.txt", b"notice", kind="notice"),
            ],
        ),
        "unavailableReason": None,
    }


def _content(
    content_id: str,
    *,
    file_name: str,
    worker_bytes: int,
    model_path: str,
    model_content: bytes,
) -> dict[str, object]:
    return {
        "id": content_id,
        **_pack(
            "speech-recognition",
            file_name=file_name,
            worker_bytes=worker_bytes,
            model_path=model_path,
            model_content=model_content,
        ),
    }


def _legacy_speech() -> dict[str, object]:
    return {
        "requirementId": "speech-recognition",
        **_pack(
            "speech-recognition",
            file_name="speech.zip",
            worker_bytes=100,
            model_path="model/model.bin",
            model_content=b"weights",
        ),
    }


def _catalog(requirements: list[dict[str, object]]) -> dict[str, object]:
    return {
        "catalogVersion": "2",
        "runtimeVersion": RUNTIME_VERSION,
        "requirements": requirements,
    }


def _unavailable(content_id: str, reason: str | None) -> dict[str, object]:
    return {
        "id": content_id,
        "artifacts": [],
        "modelFiles": None,
        "unavailableReason": reason,
    }


def _parse_contents(contents: list[dict[str, object]]) -> EngineRequirementDescriptor:
    return EngineRequirementDescriptor.from_dict(
        {"requirementId": "speech-recognition", "contents": contents}
    )


def _state(state_version: str = "1", content_id: str | None = None) -> dict[str, object]:
    payload: dict[str, object] = {
        "activatedArtifacts": [
            {"role": "worker", "sha256": "a" * 64},
            {"role": "model", "sha256": "b" * 64},
        ],
        "artifactVersion": "engine-1",
        "entryPoint": "versions/engine-1/worker/speech.exe",
        "requirementId": "speech-recognition",
        "stateVersion": state_version,
        "workerProtocolVersion": "1",
    }
    if content_id is not None:
        payload["contentId"] = content_id
    return payload


def _pipeline(inputs: list[str]) -> dict[str, object]:
    return _model_file(
        "model/pipeline.json",
        b'{"pipeline":"derived"}\n',
        kind="derived",
        derivation={
            "algorithm": "canonical-json-v1",
            "generator": "scripts/generate_pipeline.py",
            "inputs": inputs,
            "sourceCommit": "c" * 40,
            "toolVersions": {"python": "3.12.12"},
        },
    )


def test_legacy_speech_round_trips_and_keeps_its_download_size() -> None:
    raw = _legacy_speech()
    parsed = EngineRequirementDescriptor.from_dict(raw)

    assert parsed.contents == ()
    assert parsed.download_bytes == (
        parsed.worker_artifact().bytes + parsed.model_delivery().extracted_bytes
    )
    assert canonical_json_bytes(parsed.to_dict()) == canonical_json_bytes(raw)
    whole = _catalog([raw])
    assert canonical_json_bytes(EngineCatalog.from_dict(whole).to_dict()) == canonical_json_bytes(
        whole
    )


def test_a_two_content_requirement_round_trips_without_summing_packs() -> None:
    cuda = _content(
        "cuda",
        file_name="cuda.zip",
        worker_bytes=100,
        model_path="model/primary.bin",
        model_content=b"cuda",
    )
    cpu = _content(
        "cpu",
        file_name="cpu.zip",
        worker_bytes=250,
        model_path="model/fallback.bin",
        model_content=b"cpu-model",
    )
    raw = {"requirementId": "speech-recognition", "contents": [cuda, cpu]}
    parsed = EngineRequirementDescriptor.from_dict(raw)
    cuda_content = parsed.find_content("cuda")
    cpu_content = parsed.find_content("cpu")
    assert cuda_content is not None and cpu_content is not None

    assert parsed.download_bytes is None
    assert parsed.complete is False
    assert cuda_content.download_bytes == (
        cuda_content.worker_artifact().bytes + cuda_content.model_delivery().extracted_bytes
    )
    assert cpu_content.download_bytes == (
        cpu_content.worker_artifact().bytes + cpu_content.model_delivery().extracted_bytes
    )
    assert cuda_content.download_bytes != cpu_content.download_bytes
    assert canonical_json_bytes(parsed.to_dict()) == canonical_json_bytes(raw)
    whole = _catalog([raw])
    assert canonical_json_bytes(EngineCatalog.from_dict(whole).to_dict()) == canonical_json_bytes(
        whole
    )


def test_contents_reject_a_duplicate_id() -> None:
    item = _unavailable("cpu", "missing")

    with pytest.raises(EngineCatalogError, match="engine content id must be unique"):
        _parse_contents([item, dict(item)])


def test_contents_reject_an_unknown_id() -> None:
    with pytest.raises(EngineCatalogError, match="engine content id must be cuda or cpu"):
        _parse_contents([_unavailable("gpu", "missing")])


def test_contents_reject_top_level_artifacts_and_contents_together() -> None:
    with pytest.raises(EngineCatalogError, match="fields must be"):
        EngineRequirementDescriptor.from_dict(
            {
                "requirementId": "speech-recognition",
                "artifacts": [],
                "modelFiles": None,
                "unavailableReason": "missing",
                "contents": [_unavailable("cpu", "missing")],
            }
        )


def test_a_content_missing_its_worker_needs_an_unavailable_reason() -> None:
    with pytest.raises(EngineCatalogError, match="must be complete or have an unavailableReason"):
        _parse_contents([_unavailable("cpu", None)])


def test_a_model_unit_cannot_declare_contents() -> None:
    with pytest.raises(EngineCatalogError, match="a model unit cannot declare contents"):
        EngineRequirementDescriptor.from_dict(
            {
                "requirementId": "vertical-japanese-reader",
                "contents": [_unavailable("cpu", "missing")],
            }
        )


def test_active_engine_state_version_1_omits_content_id() -> None:
    raw = _state()
    state = ActiveEngineState.from_dict(raw)

    assert state.content_id is None
    assert "contentId" not in state.to_dict()
    assert canonical_json_bytes(state.to_dict()) == canonical_json_bytes(raw)


def test_active_engine_state_version_2_round_trips_content_id() -> None:
    raw = _state("2", "cpu")
    state = ActiveEngineState.from_dict(raw)

    assert state.content_id == "cpu"
    assert canonical_json_bytes(state.to_dict()) == canonical_json_bytes(raw)


@pytest.mark.parametrize(
    ("state_version", "content_id"),
    [("2", None), ("1", "cpu")],
)
def test_active_engine_state_rejects_a_version_that_does_not_match_its_keys(
    state_version: str, content_id: str | None
) -> None:
    with pytest.raises(EngineCatalogError, match="unsupported"):
        ActiveEngineState.from_dict(_state(state_version, content_id))


def test_active_engine_state_rejects_an_unknown_content_id() -> None:
    with pytest.raises(EngineCatalogError, match="contentId must be cuda or cpu"):
        ActiveEngineState.from_dict(_state("2", "gpu"))


def test_a_derived_input_may_come_from_another_requirements_content() -> None:
    speech = {
        "requirementId": "speech-recognition",
        "contents": [
            _content(
                "cpu",
                file_name="speech-cpu.zip",
                worker_bytes=40,
                model_path="model/reader.bin",
                model_content=b"reader",
            )
        ],
    }
    ocr = {
        "requirementId": "windowsml-ocr",
        "artifacts": [_worker("windowsml-ocr", file_name="ocr.zip", size=80)],
        "modelFiles": _delivery(
            "engine-1",
            [
                _model_file("licenses/LICENSE.txt", b"license", kind="license"),
                _pipeline(["model/reader.bin"]),
                _model_file("notices/NOTICE.txt", b"notice", kind="notice"),
            ],
        ),
        "unavailableReason": None,
    }

    EngineCatalog.from_dict(_catalog([speech, ocr]))

    with pytest.raises(EngineCatalogError, match="not locked"):
        EngineCatalog.from_dict(_catalog([ocr]))


def test_a_derived_input_in_the_same_requirements_other_content_is_not_locked() -> None:
    def content(content_id: str, *, own_reader: bool) -> dict[str, object]:
        files = [
            _model_file("licenses/LICENSE.txt", b"license", kind="license"),
            _pipeline(["model/reader.bin"]),
            _model_file("notices/NOTICE.txt", b"notice", kind="notice"),
        ]
        if own_reader:
            files.append(_model_file("model/reader.bin", b"reader", kind="source"))
        return {
            "id": content_id,
            "artifacts": [_worker("windowsml-ocr", file_name=f"ocr-{content_id}.zip", size=80)],
            "modelFiles": _delivery("engine-1", files),
            "unavailableReason": None,
        }

    with pytest.raises(EngineCatalogError, match="not locked"):
        EngineCatalog.from_dict(
            _catalog(
                [
                    {
                        "requirementId": "windowsml-ocr",
                        "contents": [
                            content("cuda", own_reader=False),
                            content("cpu", own_reader=True),
                        ],
                    }
                ]
            )
        )
