"""Repositories take and return domain objects, never dicts (DDD plan section 5)."""

from __future__ import annotations

import inspect
import typing

from tests.semantic_layers import documented_contexts, modules_of


def _mentions_dict(hint: object) -> bool:
    if hint is dict or typing.get_origin(hint) is dict:
        return True
    return any(_mentions_dict(argument) for argument in typing.get_args(hint))


def test_repositories_take_and_return_domain_objects() -> None:
    repositories = 0
    offenders = []
    for context in documented_contexts():
        for module in modules_of(f"capture_runtime.{context}.infrastructure"):
            for class_name, value in vars(module).items():
                if not (
                    inspect.isclass(value)
                    and class_name.endswith("Repository")
                    and value.__module__ == module.__name__
                ):
                    continue
                repositories += 1
                for method_name, method in inspect.getmembers(value, inspect.isfunction):
                    if method_name.startswith("_"):
                        continue
                    try:
                        hints = typing.get_type_hints(method)
                    except Exception:
                        continue
                    for argument, hint in hints.items():
                        if _mentions_dict(hint):
                            offenders.append(f"{class_name}.{method_name} ({argument})")

    assert repositories > 0
    assert offenders == [], f"Repositories must not take or return dicts: {offenders}"
