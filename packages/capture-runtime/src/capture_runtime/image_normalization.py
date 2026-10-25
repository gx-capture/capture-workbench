"""Shared image sizing rules for standalone and worker-backed OCR."""

from __future__ import annotations

import math

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


__all__ = ["bounded_scaled_dimensions"]
