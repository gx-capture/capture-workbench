from __future__ import annotations

import importlib.util
import json
import struct
import sys
import zlib
from pathlib import Path
from types import ModuleType

from pypdf import PdfReader

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "generate_commit_a_fixtures.py"
FIXTURE_ROOT = Path(__file__).resolve().parents[1] / "model-sources" / "commit-a"


def _load_generator() -> ModuleType:
    spec = importlib.util.spec_from_file_location("generate_commit_a_fixtures", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


generator = _load_generator()


def _sha256(value: bytes) -> str:
    import hashlib

    return hashlib.sha256(value).hexdigest()


def test_commit_a_generator_reproduces_exact_tracked_bytes() -> None:
    expected = generator.build_files()
    actual_paths = {
        path.relative_to(FIXTURE_ROOT).as_posix()
        for path in FIXTURE_ROOT.rglob("*")
        if path.is_file()
    }
    assert actual_paths == set(expected)
    for relative, content in expected.items():
        assert (FIXTURE_ROOT / relative).read_bytes() == content


def test_commit_a_provenance_binds_bytes_and_fixed_revisions() -> None:
    provenance = json.loads((FIXTURE_ROOT / "provenance/commit-a.json").read_text("utf-8"))
    assert provenance == json.loads((FIXTURE_ROOT / "provenance/commit-a.json").read_text("utf-8"))
    assert provenance["releaseVersion"] == "0.3.9"
    assert provenance["stage"] == "commit-a"
    assert provenance["licensePath"] == "licenses/LICENSE.txt"
    assert provenance["noticePath"] == "licenses/NOTICE.txt"
    assert provenance["fixedUpstreamRevisions"] == {
        "paddleocrDetection": "61323801669c338b7891481ec7bac61ce31b576a",
        "paddleocrDictionary": "b03f46425e8ff4442b268ce449e3eef758146cd4",
        "paddleocrRecognition": "50c7eacafc52fa7bcf4194e8cd08e46f8558504b",
        "whisperFallback": "536b0662742c02347bc0e980a01041f333bce120",
        "whisperPrimary": "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf",
    }
    assert provenance["sourceRepositories"] == {
        "paddleocrDetection": "PaddlePaddle/PP-OCRv6_medium_det_onnx",
        "paddleocrRecognition": "PaddlePaddle/PP-OCRv6_medium_rec_onnx",
    }
    for item in provenance["files"]:
        content = (FIXTURE_ROOT / item["path"]).read_bytes()
        assert item["bytes"] == len(content)
        assert item["sha256"] == _sha256(content)

    pipeline = json.loads((FIXTURE_ROOT / "model/pipeline.json").read_text("utf-8"))
    assert pipeline["model"] == "pp-ocrv6-medium-windowsml"
    assert pipeline["device"] == "windowsml-dml"
    assert pipeline["cpuFallback"] == "provider-missing-only"
    assert pipeline["failClosedOnDmlError"] is True
    assert pipeline["models"]["det"] == {
        "revision": "61323801669c338b7891481ec7bac61ce31b576a",
        "source": "PaddlePaddle/PP-OCRv6_medium_det_onnx",
    }
    assert pipeline["models"]["rec"] == {
        "revision": "50c7eacafc52fa7bcf4194e8cd08e46f8558504b",
        "source": "PaddlePaddle/PP-OCRv6_medium_rec_onnx",
    }

    ocr = next(item for item in provenance["files"] if item["kind"] == "ocr-fixture")
    assert ocr["expectedText"] == "CAPTURE OCR FIXTURE"
    assert ocr["expectedEngine"] == "windowsml-ocr"
    assert ocr["expectedModel"] == "pp-ocrv6-medium-windowsml"
    assert ocr["expectedDevice"] == "windowsml-dml"
    assert "audio" not in json.dumps(provenance).lower()


def test_reference_png_is_valid_deterministic_rgb_image() -> None:
    data = (FIXTURE_ROOT / "fixtures/ocr-reference.png").read_bytes()
    assert data.startswith(b"\x89PNG\r\n\x1a\n")
    offset = 8
    chunks: dict[bytes, bytes] = {}
    while offset < len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        kind = data[offset + 4 : offset + 8]
        payload = data[offset + 8 : offset + 8 + length]
        chunks[kind] = chunks.get(kind, b"") + payload
        offset += 12 + length
    assert struct.unpack(">IIBBBBB", chunks[b"IHDR"]) == (1024, 256, 8, 2, 0, 0, 0)
    rows = zlib.decompress(chunks[b"IDAT"])
    assert len(rows) == 256 * (1 + 1024 * 3)
    assert b"\x00\x00\x00" in rows


def test_scanned_pdf_is_one_page_image_only_and_has_no_embedded_text() -> None:
    data = (FIXTURE_ROOT / "fixtures/ocr-scanned.pdf").read_bytes()
    reader = PdfReader(FIXTURE_ROOT / "fixtures/ocr-scanned.pdf")
    assert len(reader.pages) == 1
    assert reader.pages[0].extract_text() in (None, "")
    assert len(reader.pages[0].images) == 1
    assert b"CAPTURE OCR FIXTURE" not in data
    assert b"BT" not in data


def test_commit_a_contains_only_project_owned_non_model_media() -> None:
    files = sorted(
        path.relative_to(FIXTURE_ROOT).as_posix()
        for path in FIXTURE_ROOT.rglob("*")
        if path.is_file()
    )
    assert files == [
        "fixtures/ocr-reference.png",
        "fixtures/ocr-scanned.pdf",
        "licenses/LICENSE.txt",
        "licenses/NOTICE.txt",
        "model/pipeline.json",
        "provenance/commit-a.json",
    ]
    license_text = (FIXTURE_ROOT / "licenses/LICENSE.txt").read_text("utf-8")
    assert license_text.startswith("MIT License\n")
    assert "Permission is hereby granted" in license_text
    assert 'THE SOFTWARE IS PROVIDED "AS IS"' in license_text
    for path in FIXTURE_ROOT.rglob("*"):
        if not path.is_file():
            continue
        payload = path.read_bytes().lower()
        assert b"model.bin" not in payload
        assert b".onnx" not in payload
        assert b".wav" not in payload
        assert b".mp3" not in payload
        assert b"private" not in payload
        assert "audio" not in path.relative_to(FIXTURE_ROOT).as_posix().lower()
