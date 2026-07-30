from __future__ import annotations

import importlib.util
import json
import sys
from copy import deepcopy
from pathlib import Path
from types import ModuleType

import pytest
from direct_model_fixtures import approved_source_lock

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "model_source_lock.py"


def _load_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("model_source_lock", MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


model_source_lock = _load_module()


def test_blocked_production_lock_fails_closed() -> None:
    source = (
        Path(__file__).resolve().parents[1] / "model-sources" / "release-model-source-lock.json"
    )
    with pytest.raises(model_source_lock.ModelSourceLockError, match="source lock is blocked"):
        model_source_lock.load_source_lock(source)


def test_approved_lock_generates_checksum_pinned_manifest_equivalent(
    tmp_path: Path,
) -> None:
    payload, _content = approved_source_lock()
    source = tmp_path / "lock.json"
    source.write_bytes(model_source_lock.canonical_json_bytes(payload))
    lock = model_source_lock.load_source_lock(source)
    delivery = model_source_lock.model_delivery(lock, "whisper-primary")
    assert delivery["entryCount"] == len(delivery["files"])
    assert delivery["extractedBytes"] == sum(item["bytes"] for item in delivery["files"])
    assert len(delivery["manifestSha256"]) == 64
    assert delivery["sourceLockSha256"] == model_source_lock.source_lock_sha256(lock)


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (
            lambda payload: payload["requirements"][0]["files"][1].update(
                {"path": "../escape.bin"}
            ),
            "must not escape",
        ),
        *[
            (
                lambda payload, unsafe_path=unsafe_path: payload["requirements"][0]["files"][
                    1
                ].update({"path": unsafe_path}),
                "Windows-unsafe",
            )
            for unsafe_path in (
                "model/NUL",
                "model/file.",
                "model/file ",
                "model/file:stream",
            )
        ],
        (
            lambda payload: payload["requirements"][0]["files"][1].update(
                {"path": "licenses/license.txt"}
            ),
            "case-insensitively unique",
        ),
        (
            lambda payload: payload["requirements"][1]["files"][2]["derivation"].update(
                {"inputs": ["model/missing.onnx"]}
            ),
            "derived inputs",
        ),
        (
            lambda payload: payload["requirements"][1]["files"][2]["derivation"].update(
                {
                    "inputs": [
                        "model/det/inference.onnx",
                        "model/det/inference.onnx",
                    ]
                }
            ),
            "sorted and unique",
        ),
        (
            lambda payload: payload["requirements"][0].update({"entryPoint": "weights"}),
            "entryPoint",
        ),
        (
            lambda payload: payload["requirements"][0]["files"][0].update(
                {
                    "bytes": 512 * 1024 * 1024 + 1,
                    "path": "model/LICENSE.txt",
                }
            ),
            "large-model exception",
        ),
        (
            lambda payload: payload["requirements"][0]["files"][1].update(
                {"url": "https://models.example.test/latest/model.bin"}
            ),
            "immutable revision",
        ),
        (
            lambda payload: payload["fixtures"][0].update({"expectedDevice": "cpu"}),
            "WindowsML DirectML provenance",
        ),
        (
            lambda payload: payload["fixtures"][1].update({"expectedModel": "primary"}),
            "approved primary/fallback",
        ),
        (
            lambda payload: payload["fixtures"][1].update({"expectedText": "  not normalized"}),
            "normalized and bounded",
        ),
        (
            lambda payload: payload["fixtures"][0].update({"licenseBytes": 1024 * 1024 + 1}),
            "licenseBytes",
        ),
        (
            lambda payload: payload["fixtures"][0].update(
                {"url": "https://fixtures.example.test/latest/ocr.png"}
            ),
            "immutable revision",
        ),
        (
            lambda payload: payload["fixtures"][0].update(
                {
                    "licenseUrl": "https://fixtures.example.test/main/license.txt",
                    "revision": "main",
                    "url": "https://fixtures.example.test/main/ocr.png",
                }
            ),
            "immutable hex ID",
        ),
        (
            lambda payload: payload["fixtures"][1].update({"id": payload["fixtures"][0]["id"]}),
            "sorted and unique",
        ),
    ],
)
def test_source_lock_rejects_unsafe_or_incomplete_entries(
    mutate,
    message: str,
) -> None:
    payload, _content = approved_source_lock()
    candidate = deepcopy(payload)
    mutate(candidate)
    with pytest.raises(model_source_lock.ModelSourceLockError, match=message):
        model_source_lock.validate_source_lock(candidate)


def test_source_lock_requires_canonical_json(tmp_path: Path) -> None:
    payload, _content = approved_source_lock()
    source = tmp_path / "lock.json"
    source.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(model_source_lock.ModelSourceLockError, match="canonical"):
        model_source_lock.load_source_lock(source)
