from __future__ import annotations

import argparse
import hashlib
import struct
import zlib
from pathlib import Path
from typing import Final

RELEASE_VERSION: Final = "0.4.0"
DET_REVISION: Final = "61323801669c338b7891481ec7bac61ce31b576a"
REC_REVISION: Final = "50c7eacafc52fa7bcf4194e8cd08e46f8558504b"
PADDLEOCR_DICT_REVISION: Final = "b03f46425e8ff4442b268ce449e3eef758146cd4"
WHISPER_PRIMARY_REVISION: Final = "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf"
WHISPER_FALLBACK_REVISION: Final = "536b0662742c02347bc0e980a01041f333bce120"
DET_REPOSITORY: Final = "PaddlePaddle/PP-OCRv6_medium_det_onnx"
REC_REPOSITORY: Final = "PaddlePaddle/PP-OCRv6_medium_rec_onnx"
OCR_TEXT: Final = "CAPTURE OCR FIXTURE"
IMAGE_WIDTH: Final = 1024
IMAGE_HEIGHT: Final = 256
IMAGE_SCALE: Final = 8
PNG_MEDIA_TYPE: Final = "image/png"
PDF_MEDIA_TYPE: Final = "application/pdf"

_GLYPHS: Final[dict[str, tuple[str, ...]]] = {
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "C": ("01111", "10000", "10000", "10000", "10000", "10000", "01111"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "F": ("11111", "10000", "10000", "11110", "10000", "10000", "10000"),
    "I": ("11111", "00100", "00100", "00100", "00100", "00100", "11111"),
    "O": ("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
    "P": ("11110", "10001", "10001", "11110", "10000", "10000", "10000"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "U": ("10001", "10001", "10001", "10001", "10001", "10001", "01110"),
    "X": ("10001", "10001", "01010", "00100", "01010", "10001", "10001"),
}


def _canonical_json(value: object) -> bytes:
    import json

    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    checksum = struct.pack(">I", zlib.crc32(kind + payload))
    return struct.pack(">I", len(payload)) + kind + payload + checksum


def render_fixture_rgb() -> bytes:
    """Render the fixed OCR phrase with a dependency-free bitmap font."""

    pixels = bytearray(b"\xff" * (IMAGE_WIDTH * IMAGE_HEIGHT * 3))
    glyph_width = 5 * IMAGE_SCALE
    gap_width = IMAGE_SCALE
    space_width = 3 * IMAGE_SCALE
    text_width = sum(
        space_width if character == " " else glyph_width for character in OCR_TEXT
    ) + gap_width * (len(OCR_TEXT) - 1)
    x_origin = (IMAGE_WIDTH - text_width) // 2
    y_origin = (IMAGE_HEIGHT - 7 * IMAGE_SCALE) // 2

    cursor = x_origin
    for character in OCR_TEXT:
        glyph = _GLYPHS.get(character)
        if glyph is None:
            cursor += space_width + gap_width
            continue
        for row, bits in enumerate(glyph):
            for column, bit in enumerate(bits):
                if bit != "1":
                    continue
                for dy in range(IMAGE_SCALE):
                    pixel_y = y_origin + row * IMAGE_SCALE + dy
                    for dx in range(IMAGE_SCALE):
                        pixel_x = cursor + column * IMAGE_SCALE + dx
                        offset = (pixel_y * IMAGE_WIDTH + pixel_x) * 3
                        pixels[offset : offset + 3] = b"\x00\x00\x00"
        cursor += glyph_width + gap_width
    return bytes(pixels)


def render_png(rgb: bytes) -> bytes:
    rows = bytearray()
    row_bytes = IMAGE_WIDTH * 3
    for row in range(IMAGE_HEIGHT):
        rows.append(0)
        start = row * row_bytes
        rows.extend(rgb[start : start + row_bytes])
    header = struct.pack(">IIBBBBB", IMAGE_WIDTH, IMAGE_HEIGHT, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", zlib.compress(bytes(rows), level=9))
        + _png_chunk(b"IEND", b"")
    )


def render_image_only_pdf(rgb: bytes) -> bytes:
    """Create a deterministic one-page PDF containing only the rendered image."""

    image_stream = zlib.compress(rgb, level=9)
    contents = b"q\n256 0 0 64 50 700 cm\n/Im0 Do\nQ\n"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 356 792] "
            b"/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>"
        ),
        b"<< /Length "
        + str(len(contents)).encode("ascii")
        + b" >>\nstream\n"
        + contents
        + b"endstream",
        (
            b"<< /Type /XObject /Subtype /Image /Width "
            + str(IMAGE_WIDTH).encode("ascii")
            + b" /Height "
            + str(IMAGE_HEIGHT).encode("ascii")
            + b" /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length "
            + str(len(image_stream)).encode("ascii")
            + b" >>\nstream\n"
            + image_stream
            + b"\nendstream"
        ),
    ]
    output = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode("ascii"))
        output.extend(obj)
        output.extend(b"\nendobj\n")
    xref_offset = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode("ascii")
    )
    return bytes(output)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _license_text() -> bytes:
    return (
        b"MIT License\n\n"
        b"Copyright (c) 2026 Capture Workbench contributors\n\n"
        b"Permission is hereby granted, free of charge, to any person obtaining a copy\n"
        b'of this software and associated documentation files (the "Software"), to deal\n'
        b"in the Software without restriction, including without limitation the rights\n"
        b"to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\n"
        b"copies of the Software, and to permit persons to whom the Software is\n"
        b"furnished to do so, subject to the following conditions:\n\n"
        b"The above copyright notice and this permission notice shall be included in all\n"
        b"copies or substantial portions of the Software.\n\n"
        b'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n'
        b"IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\n"
        b"FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n"
        b"AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\n"
        b"LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\n"
        b"OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\n"
        b"SOFTWARE.\n"
    )


def _notice_text() -> bytes:
    return (
        b"Capture Workbench v0.4.0 Commit A notice\n\n"
        b"These files contain no model weights. The fixed OCR\n"
        b"phrase is intentionally limited to `CAPTURE OCR FIXTURE`. PaddleOCR\n"
        b"and model-revision metadata identify user-directed upstream inputs; their\n"
        b"licenses and attribution remain a later Commit B/source-lock gate.\n"
    )


def _provenance(
    png: bytes,
    pdf: bytes,
    pipeline: bytes,
    license_bytes: bytes,
    notice_bytes: bytes,
) -> bytes:
    files = [
        {
            "bytes": len(license_bytes),
            "kind": "license",
            "mediaType": "text/plain",
            "path": "licenses/LICENSE.txt",
            "sha256": _sha256(license_bytes),
        },
        {
            "bytes": len(notice_bytes),
            "kind": "notice",
            "mediaType": "text/plain",
            "path": "licenses/NOTICE.txt",
            "sha256": _sha256(notice_bytes),
        },
        {
            "bytes": len(pipeline),
            "kind": "derived",
            "mediaType": "application/json",
            "path": "model/pipeline.json",
            "sha256": _sha256(pipeline),
        },
        {
            "bytes": len(png),
            "expectedDevice": "windowsml-dml",
            "expectedEngine": "windowsml-ocr",
            "expectedModel": "pp-ocrv6-medium-windowsml",
            "expectedText": OCR_TEXT,
            "kind": "ocr-fixture",
            "licensePath": "licenses/LICENSE.txt",
            "mediaType": PNG_MEDIA_TYPE,
            "noticePath": "licenses/NOTICE.txt",
            "path": "fixtures/ocr-reference.png",
            "sha256": _sha256(png),
        },
        {
            "bytes": len(pdf),
            "imageOnly": True,
            "kind": "scanned-pdf-fixture",
            "licensePath": "licenses/LICENSE.txt",
            "mediaType": PDF_MEDIA_TYPE,
            "noticePath": "licenses/NOTICE.txt",
            "pageCount": 1,
            "path": "fixtures/ocr-scanned.pdf",
            "sha256": _sha256(pdf),
        },
    ]
    return _canonical_json(
        {
            "algorithm": "capture-workbench-commit-a-fixtures-v1",
            "files": files,
            "fixedUpstreamRevisions": {
                "paddleocrDictionary": PADDLEOCR_DICT_REVISION,
                "paddleocrDetection": DET_REVISION,
                "paddleocrRecognition": REC_REVISION,
                "whisperFallback": WHISPER_FALLBACK_REVISION,
                "whisperPrimary": WHISPER_PRIMARY_REVISION,
            },
            "generator": "packages/capture-runtime/scripts/generate_commit_a_fixtures.py",
            "licensePath": "licenses/LICENSE.txt",
            "noticePath": "licenses/NOTICE.txt",
            "sourceRepositories": {
                "paddleocrDetection": DET_REPOSITORY,
                "paddleocrRecognition": REC_REPOSITORY,
            },
            "releaseVersion": RELEASE_VERSION,
            "stage": "commit-a",
        }
    )


def build_files() -> dict[str, bytes]:
    rgb = render_fixture_rgb()
    png = render_png(rgb)
    pdf = render_image_only_pdf(rgb)
    pipeline = _canonical_json(
        {
            "algorithm": "capture-workbench-ocr-pipeline-v1",
            "cpuFallback": "provider-missing-only",
            "device": "windowsml-dml",
            "dictionaryRevision": PADDLEOCR_DICT_REVISION,
            "failClosedOnDmlError": True,
            "model": "pp-ocrv6-medium-windowsml",
            "models": {
                "det": {
                    "revision": DET_REVISION,
                    "source": DET_REPOSITORY,
                },
                "rec": {
                    "revision": REC_REVISION,
                    "source": REC_REPOSITORY,
                },
            },
            "releaseVersion": RELEASE_VERSION,
            "schemaVersion": "1",
        }
    )
    license_bytes = _license_text()
    notice_bytes = _notice_text()
    return {
        "fixtures/ocr-reference.png": png,
        "fixtures/ocr-scanned.pdf": pdf,
        "licenses/LICENSE.txt": license_bytes,
        "licenses/NOTICE.txt": notice_bytes,
        "model/pipeline.json": pipeline,
        "provenance/commit-a.json": _provenance(png, pdf, pipeline, license_bytes, notice_bytes),
    }


def _write_or_check(root: Path, *, check: bool) -> None:
    expected = build_files()
    if check:
        actual_paths = {
            path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()
        }
        if actual_paths != set(expected):
            raise SystemExit(
                "Commit A fixture file set drifted: "
                f"expected {sorted(expected)}, found {sorted(actual_paths)}"
            )
        for relative, content in expected.items():
            target = root / relative
            if target.read_bytes() != content:
                raise SystemExit(f"Commit A fixture bytes drifted: {relative}")
        return
    for relative, content in expected.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "model-sources" / "commit-a",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify tracked Commit A bytes without writing files",
    )
    arguments = parser.parse_args()
    _write_or_check(arguments.output.resolve(), check=arguments.check)


if __name__ == "__main__":
    main()
