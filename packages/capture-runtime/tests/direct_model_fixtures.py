from __future__ import annotations

import hashlib
from typing import Any


def _file(
    requirement_id: str,
    path: str,
    kind: str,
    content: bytes,
    *,
    derivation: dict[str, object] | None = None,
) -> dict[str, object]:
    revision = "a" * 40 if requirement_id == "windowsml-ocr" else "b" * 40
    return {
        "bytes": len(content),
        "derivation": derivation,
        "kind": kind,
        "licensePath": (None if kind in {"license", "notice"} else "licenses/LICENSE.txt"),
        "noticePath": (None if kind in {"license", "notice"} else "notices/NOTICE.txt"),
        "owner": "fixture-owner",
        "path": path,
        "redirectHosts": ["cdn.example.test"],
        "revision": revision,
        "sha256": hashlib.sha256(content).hexdigest(),
        "spdx": "MIT",
        "url": f"https://models.example.test/{revision}/{path}",
    }


def approved_source_lock() -> tuple[dict[str, Any], dict[tuple[str, str], bytes]]:
    content: dict[tuple[str, str], bytes] = {}
    requirements = []
    for requirement_id in ("whisper-primary", "windowsml-ocr"):
        files_with_content = [
            (
                _file(
                    requirement_id,
                    "licenses/LICENSE.txt",
                    "license",
                    b"license",
                ),
                b"license",
            ),
            (
                _file(
                    requirement_id,
                    (
                        "model/primary/model.bin"
                        if requirement_id == "whisper-primary"
                        else "model/det/inference.onnx"
                    ),
                    "source",
                    b"model",
                ),
                b"model",
            ),
        ]
        if requirement_id == "windowsml-ocr":
            files_with_content.append(
                (
                    _file(
                        requirement_id,
                        "model/pipeline.json",
                        "derived",
                        b'{"pipeline":"derived"}\n',
                        derivation={
                            "algorithm": "canonical-json-v1",
                            "generator": "scripts/generate_pipeline.py",
                            "inputs": ["model/det/inference.onnx"],
                            "sourceCommit": "c" * 40,
                            "toolVersions": {"python": "3.12.12"},
                        },
                    ),
                    b'{"pipeline":"derived"}\n',
                )
            )
        files_with_content.append(
            (
                _file(
                    requirement_id,
                    "notices/NOTICE.txt",
                    "notice",
                    b"notice",
                ),
                b"notice",
            )
        )
        files_with_content.sort(key=lambda item: item[0]["path"])
        requirements.append(
            {
                "artifactVersion": "0.3.4",
                "entryPoint": "model",
                "files": [item for item, _value in files_with_content],
                "requirementId": requirement_id,
            }
        )
        content.update(
            {(requirement_id, item["path"]): value for item, value in files_with_content}
        )
    return (
        {
            "approval": {
                "approvedAt": "2026-07-30T00:00:00Z",
                "approvedBy": "release-owner",
                "blockers": [],
                "status": "approved",
            },
            "fixtures": [
                {
                    "bytes": 1,
                    "expectedDevice": "windowsml-dml",
                    "expectedEngine": "windowsml-ocr",
                    "expectedModel": "pp-ocrv6-medium-windowsml",
                    "expectedText": "CAPTURE OCR FIXTURE",
                    "id": "ocr-real",
                    "kind": "ocr",
                    "licenseBytes": 1,
                    "licenseSha256": "d" * 64,
                    "licenseUrl": (f"https://fixtures.example.test/{'c' * 40}/licenses/ocr.txt"),
                    "mediaType": "image/png",
                    "owner": "fixture-owner",
                    "preferGpu": None,
                    "redistributable": True,
                    "revision": "c" * 40,
                    "sha256": "e" * 64,
                    "spdx": "CC0-1.0",
                    "url": f"https://fixtures.example.test/{'c' * 40}/ocr.png",
                },
                {
                    "bytes": 1,
                    "expectedDevice": "cpu",
                    "expectedEngine": "whisper-primary",
                    "expectedModel": "fallback",
                    "expectedText": "capture whisper fixture",
                    "id": "whisper-real",
                    "kind": "whisper",
                    "licenseBytes": 1,
                    "licenseSha256": "f" * 64,
                    "licenseUrl": (
                        f"https://fixtures.example.test/{'d' * 40}/licenses/whisper.txt"
                    ),
                    "mediaType": "audio/wav",
                    "owner": "fixture-owner",
                    "preferGpu": False,
                    "redistributable": True,
                    "revision": "d" * 40,
                    "sha256": "1" * 64,
                    "spdx": "CC0-1.0",
                    "url": f"https://fixtures.example.test/{'d' * 40}/whisper.wav",
                },
            ],
            "lockVersion": "1",
            "releaseVersion": "0.3.4",
            "requirements": requirements,
        },
        content,
    )
