"""Each context's documented use cases are exactly its application's use cases
(DDD plan section 5).
"""

from __future__ import annotations

import importlib

from tests.semantic_layers import documented_contexts, documented_use_cases


def test_documented_use_cases_match_the_application() -> None:
    mismatched = {}
    for context in documented_contexts():
        use_cases = importlib.import_module(f"capture_runtime.{context}.application.use_cases")
        documented = documented_use_cases(context)
        actual = set(use_cases.__all__)
        if actual != documented:
            mismatched[context] = {
                "undocumented": sorted(actual - documented),
                "not in the application": sorted(documented - actual),
            }

    assert mismatched == {}, f"Use cases mismatch: {mismatched}"
