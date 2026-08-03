from __future__ import annotations

import importlib.util
from pathlib import Path

_SCRIPT = Path(__file__).parents[1] / "scripts" / "local_media_probe.py"
_SPEC = importlib.util.spec_from_file_location("local_media_probe", _SCRIPT)
assert _SPEC is not None and _SPEC.loader is not None
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)
_redact = _MODULE._redact
_write_ocr_contract = _MODULE._write_ocr_contract


def test_local_probe_derives_ephemeral_ocr_contract(tmp_path: Path) -> None:
    detection = tmp_path / "detection"
    recognition = tmp_path / "recognition"
    detection.mkdir()
    recognition.mkdir()
    (detection / "inference.onnx").write_bytes(b"det")
    (detection / "inference.yml").write_text("Global: {}\n", encoding="utf-8")
    (recognition / "inference.onnx").write_bytes(b"rec")
    (recognition / "inference.yml").write_text(
        "PostProcess:\n  character_dict:\n  - A\n  - 日\n", encoding="utf-8"
    )

    destination = tmp_path / "ephemeral"
    _write_ocr_contract(detection, recognition, destination)

    assert (destination / "det" / "inference.onnx").read_bytes() == b"det"
    assert (destination / "rec" / "inference.onnx").read_bytes() == b"rec"
    assert (destination / "rec" / "ppocrv6_dict.txt").read_text(encoding="utf-8") == "A\n日\n"
    assert '"developerLocalProbe":true' in (destination / "pipeline.json").read_text(
        encoding="utf-8"
    )


def test_local_probe_redacts_explicit_paths() -> None:
    path = Path(r"C:\models\whisper\primary")
    rendered = _redact(f"failed at {path}", (path,))

    assert rendered == "failed at <local>"
    assert "C:\\models" not in rendered
