"""The one rule for which pages of a PDF a capture reads.

A selection lists one-based source page numbers in ascending order, without
duplicates, and holds at most ``MAX_PDF_PAGE_SELECTION`` pages: ``[3, 7, 8, 20]``
or the prefix ``[1, 2, 3]``. Results keep the source page numbers, so page 7
of the PDF is page 7 in the OCR projection and in every page locator.

The public wire models in ``capture_runtime.contracts`` repeat this rule
inline, because the client SDKs generate their models from that module alone.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final

MAX_PDF_PAGE_SELECTION: Final = 500


def is_ascending_page_numbers(values: Sequence[object]) -> bool:
    """Whether every value is a one-based page number greater than the one before."""

    previous = 0
    for page in values:
        if type(page) is not int or page <= previous:
            return False
        previous = page
    return True


def is_pdf_page_selection(value: object) -> bool:
    """Whether ``value`` is a non-empty, bounded, ascending list of source pages."""

    return (
        isinstance(value, list | tuple)
        and 1 <= len(value) <= MAX_PDF_PAGE_SELECTION
        and is_ascending_page_numbers(value)
    )


__all__ = ["MAX_PDF_PAGE_SELECTION", "is_ascending_page_numbers", "is_pdf_page_selection"]
