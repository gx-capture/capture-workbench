"""Shared image sizing rules and image preparation for standalone and worker-backed OCR."""

from __future__ import annotations

import math
from io import BytesIO
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from PIL import Image

# OCR enlarges an image only while its enlarged long side stays within this. Enlarging helps
# a small image; a larger one it only slows. On an RTX 4060 laptop a 1654 x 2339 page took
# 23 s at 2x and 6 s as is, reading no less (CER 0.26% / 0.20%), and dense 11 px text in a
# 1080p screenshot read best as is (character recall 0.986; 0.984 at 2x, 0.980 at 1.07x).
# PDF pages still render at the full scale.
OCR_MAX_ENLARGED_LONG_SIDE = 2048


def ocr_image_scale(width: int, height: int, scale: float) -> float:
    """The enlargement OCR applies to a width x height image: all of `scale`, or none."""

    if max(width, height) * scale <= OCR_MAX_ENLARGED_LONG_SIDE:
        return scale
    return min(scale, 1.0)


def bounded_scaled_dimensions(
    width: int,
    height: int,
    scale: float,
    max_pixels: int,
) -> tuple[int, int]:
    """Return scaled dimensions without exceeding the configured pixel cap.

    The source image is validated before this helper is called, so an input
    that already exceeds ``max_pixels`` remains rejected by the caller. For a
    valid input, reduce only the requested enlargement when that enlargement
    would exceed the same cap.
    """
    if width <= 0 or height <= 0 or width * height > max_pixels:
        raise ValueError("image dimensions exceed limit")
    if scale == 1:
        return width, height

    effective_scale = min(scale, math.sqrt(max_pixels / (width * height)))
    while True:
        scaled_width = max(1, round(width * effective_scale))
        scaled_height = max(1, round(height * effective_scale))
        if scaled_width * scaled_height <= max_pixels:
            return scaled_width, scaled_height
        effective_scale = math.nextafter(effective_scale, 0)


def normalize_image_png(
    image: Image.Image,
    *,
    scale: float = 1,
    max_pixels: int | None = None,
) -> bytes:
    from PIL import Image, ImageOps

    oriented = ImageOps.exif_transpose(image)
    if "A" in oriented.getbands() or "transparency" in oriented.info:
        rgba = oriented.convert("RGBA")
        normalized = Image.new("RGB", rgba.size, "white")
        normalized.paste(rgba, mask=rgba.getchannel("A"))
    else:
        normalized = oriented.convert("RGB")
    if scale != 1:
        width, height = normalized.size
        dimensions = (
            bounded_scaled_dimensions(width, height, scale, max_pixels)
            if max_pixels is not None
            else (round(width * scale), round(height * scale))
        )
        normalized = normalized.resize(dimensions, Image.Resampling.LANCZOS)
    output = BytesIO()
    normalized.save(output, format="PNG")
    return output.getvalue()


def normalize_image_content(content: bytes, *, scale: float, max_pixels: int) -> bytes:
    import warnings as image_warnings

    from PIL import Image, UnidentifiedImageError

    try:
        with image_warnings.catch_warnings():
            image_warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(content)) as image:
                if (image.format or "").upper() not in {"PNG", "JPEG", "WEBP"}:
                    raise ValueError("Only PNG, JPEG, and WebP images are supported.")
                width, height = image.size
                if width <= 0 or height <= 0:
                    raise ValueError("Image dimensions must be positive.")
                if width * height > max_pixels:
                    raise ValueError("Image exceeds the configured pixel limit.")
                if getattr(image, "n_frames", 1) != 1 or bool(getattr(image, "is_animated", False)):
                    raise ValueError("Animated or multi-frame images are unsupported.")
                image.seek(0)
                image.load()
                return normalize_image_png(
                    image, scale=ocr_image_scale(width, height, scale), max_pixels=max_pixels
                )
    except (
        OSError,
        UnidentifiedImageError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ) as error:
        raise ValueError("Uploaded image is not readable.") from error


def png_raster_dimensions(image_png: bytes) -> tuple[int | None, int | None]:
    try:
        from PIL import Image

        with Image.open(BytesIO(image_png)) as image:
            width, height = image.size
            return (width, height) if width > 0 and height > 0 else (None, None)
    except Exception:
        return None, None


def image_ocr_scale(content: bytes, scale: float) -> float:
    """The enlargement of an already validated image, as normalize_image_content applies it."""

    from PIL import Image

    with Image.open(BytesIO(content)) as image:
        width, height = image.size
    return ocr_image_scale(width, height, scale)


def oriented_image_dimensions(content: bytes) -> tuple[int, int]:
    from PIL import Image, ImageOps

    with Image.open(BytesIO(content)) as image:
        oriented = ImageOps.exif_transpose(image)
        width, height = oriented.size
    if width <= 0 or height <= 0:
        raise ValueError("Image dimensions must be positive.")
    return width, height


__all__ = [
    "OCR_MAX_ENLARGED_LONG_SIDE",
    "bounded_scaled_dimensions",
    "image_ocr_scale",
    "normalize_image_content",
    "normalize_image_png",
    "ocr_image_scale",
    "oriented_image_dimensions",
    "png_raster_dimensions",
]
