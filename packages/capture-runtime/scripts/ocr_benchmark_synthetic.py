"""Reproducible research scan/skew fixtures; never changes runtime preprocessing.

The source is a pinned browser render. Glyph polygons use continuous pixel-boundary
coordinates; OpenCV rotations use pixel-centre coordinates. Keep that half-pixel
conversion explicit, and transform all vertices instead of just character centres.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import re
from pathlib import Path
from typing import Any

from ocr_benchmark import read_verified_bytes, save_json

POLICY_ID = "synthetic-scan-v1"
VARIANTS = {"clean": None, "scan": 0.0, "skew-plus-0p8": 0.8, "skew-minus-1p5": -1.5}


def glyph_transform(
    output_size: tuple[int, int], high_size: tuple[int, int], scale: float, angle: float
) -> list[list[float]]:
    if not math.isfinite(angle) or not math.isfinite(scale) or scale <= 0:
        raise ValueError("angle and positive scale must be finite")
    if any(type(n) is not int or n <= 0 for n in (*output_size, *high_size)):
        raise ValueError("raster dimensions must be positive integers")
    cosine, sine = math.cos(math.radians(angle)), math.sin(math.radians(angle))
    # The rotation centre expressed in pixel-boundary coordinates.
    cx, cy = high_size[0] / 2 + 0.5, high_size[1] / 2 + 0.5
    sx, sy = output_size[0] / high_size[0], output_size[1] / high_size[1]
    return [
        [sx * cosine * scale, sx * sine * scale, sx * (cx - cosine * cx - sine * cy)],
        [-sy * sine * scale, sy * cosine * scale, sy * (cy + sine * cx - cosine * cy)],
        [0.0, 0.0, 1.0],
    ]


def transform_polygon(polygon: list[list[float]], matrix: list[list[float]]) -> list[list[float]]:
    return [
        [sum(row[i] * point[i] for i in range(3)) for row in matrix[:2]]
        for x, y in polygon
        for point in ([x, y, 1],)
    ]


def invert_transform(matrix: list[list[float]]) -> list[list[float]]:
    a, b, tx = matrix[0]
    c, d, ty = matrix[1]
    determinant = a * d - b * c
    if not math.isfinite(determinant) or determinant == 0:
        raise ValueError("noninvertible affine transform")
    return [
        [d / determinant, -b / determinant, (b * ty - d * tx) / determinant],
        [-c / determinant, a / determinant, (c * tx - a * ty) / determinant],
        [0.0, 0.0, 1.0],
    ]


def validate_glyphs(glyphs: list[dict[str, Any]], size: tuple[int, int]) -> None:
    for glyph in glyphs:
        polygon = glyph["polygon"]
        if len(polygon) != 4 or any(
            not math.isfinite(x)
            or not math.isfinite(y)
            or not 0 <= x <= size[0]
            or not 0 <= y <= size[1]
            for x, y in polygon
        ):
            raise ValueError("synthetic glyph is clipped or has invalid geometry")


def scan_image(image: Any, size: tuple[int, int], *, seed: int) -> Any:
    import cv2
    import numpy as np

    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY).astype(np.float32)
    gray = cv2.GaussianBlur(gray, (0, 0), 1.1)
    gray = np.clip(gray * 0.92 + 12 + np.random.default_rng(seed).normal(0, 7, gray.shape), 0, 255)
    ok, encoded = cv2.imencode(".jpg", gray.astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 55])
    if not ok:
        raise ValueError("synthetic JPEG encoding failed")
    decoded = cv2.imdecode(encoded, cv2.IMREAD_GRAYSCALE)
    return cv2.cvtColor(cv2.resize(decoded, size, interpolation=cv2.INTER_AREA), cv2.COLOR_GRAY2RGB)


def read_render_glyphs(record: dict[str, Any]) -> list[dict[str, Any]]:
    """Use the same hash-verified bytes pinned alongside the original render."""
    for key in ("html", "glyphs"):
        if not isinstance(record.get(key), dict) or not {"path", "sha256"} <= record[key].keys():
            raise ValueError("render manifest must pin HTML and glyph digests")
    html = read_verified_bytes(Path(record["html"]["path"]), record["html"]["sha256"])
    glyph_bytes = read_verified_bytes(Path(record["glyphs"]["path"]), record["glyphs"]["sha256"])
    data = json.loads(glyph_bytes)
    if data.get("sourceHtmlSha256") != hashlib.sha256(html).hexdigest():
        raise ValueError("synthetic glyph HTML lineage mismatch")
    if not isinstance(data.get("glyphs"), list) or len(data["glyphs"]) != record["glyphCount"]:
        raise ValueError("synthetic glyph count changed after rendering")
    return data["glyphs"]


def build_variants(manifest_path: Path, output: Path) -> None:
    import cv2
    import numpy as np
    from PIL import Image
    from PIL import __version__ as pillow_version

    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    output.mkdir(parents=True, exist_ok=False)
    records = []
    images = []
    ids: set[str] = set()
    for record in manifest["records"]:
        page_id = record["id"]
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", page_id) or page_id in ids:
            raise ValueError("invalid or duplicate synthetic page ID")
        ids.add(page_id)
        clean_record, high_record = (record["images"][key] for key in ("clean", "hi"))
        clean_bytes = read_verified_bytes(Path(clean_record["path"]), clean_record["sha256"])
        high_bytes = read_verified_bytes(Path(high_record["path"]), high_record["sha256"])
        with Image.open(io.BytesIO(clean_bytes)) as clean:
            size = clean.size
        with Image.open(io.BytesIO(high_bytes)) as high:
            high_image = np.array(high.convert("RGB"))
            high_size = high.size
        source_glyphs = read_render_glyphs(record)
        validate_glyphs(source_glyphs, size)
        for variant, angle in VARIANTS.items():
            case_id = f"{page_id}-{variant}"
            target = output / f"{case_id}.png"
            matrix = (
                np.eye(3).tolist()
                if angle is None
                else glyph_transform(
                    size, high_size, high_record["scale"] / clean_record["scale"], angle
                )
            )
            glyphs = [
                {**glyph, "polygon": transform_polygon(glyph["polygon"], matrix)}
                for glyph in source_glyphs
            ]
            validate_glyphs(glyphs, size)  # Never silently clamp or discard edge glyphs.
            if angle is None:
                target.write_bytes(clean_bytes)
            else:
                rotation = cv2.getRotationMatrix2D((high_size[0] / 2, high_size[1] / 2), angle, 1)
                rotated = cv2.warpAffine(
                    high_image,
                    rotation,
                    high_size,
                    flags=cv2.INTER_CUBIC,
                    borderMode=cv2.BORDER_CONSTANT,
                    borderValue=(255, 255, 255),
                )
                with Image.fromarray(scan_image(rotated, size, seed=7)) as degraded:
                    degraded.save(target)
            image_sha = hashlib.sha256(target.read_bytes()).hexdigest()
            annotation_path = output / f"{case_id}.glyphs.json"
            save_json(
                annotation_path,
                {
                    "schemaVersion": 1,
                    "status": "generated-awaiting-visual-review",
                    "caseId": case_id,
                    "imageSha256": image_sha,
                    "glyphs": glyphs,
                    "sourceGlyphSha256": record["glyphs"]["sha256"],
                    "sourceToRaster": matrix,
                    "rasterToSource": invert_transform(matrix),
                },
            )
            records.append(
                {
                    "id": case_id,
                    "variant": variant,
                    "angleCounterclockwiseDegrees": angle,
                    "imageSha256": image_sha,
                    "glyphSha256": hashlib.sha256(annotation_path.read_bytes()).hexdigest(),
                    "width": size[0],
                    "height": size[1],
                    "sourcePage": page_id,
                }
            )
            images.append(
                {
                    "id": case_id,
                    "path": str(target.resolve()),
                    "sha256": image_sha,
                    "kind": "synthetic",
                }
            )
    save_json(output / "material-request.json", {"documents": [], "images": images})
    save_json(
        output / "variant-manifest.json",
        {
            "schemaVersion": 1,
            "policyId": POLICY_ID,
            "phasePass": False,
            "renderManifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "sourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "packages": {
                "opencv": cv2.__version__,
                "numpy": np.__version__,
                "pillow": pillow_version,
            },
            "scanParameters": {
                "seed": 7,
                "gaussianSigma": 1.1,
                "contrast": 0.92,
                "offset": 12,
                "noiseSigma": 7,
                "jpegQuality": 55,
            },
            "coordinateConvention": (
                "continuous pixel boundaries, positive angle counterclockwise; "
                "same canvas, no clamping"
            ),
            "records": records,
        },
    )
    print(json.dumps({"pages": len(ids), "variants": len(records), "phasePass": False}), flush=True)
