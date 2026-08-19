"""Shared image sizing rules for standalone and worker-backed OCR."""

from __future__ import annotations

import math


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
