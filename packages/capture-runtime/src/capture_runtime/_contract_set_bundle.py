"""Private bundle, inventory, and serialization primitives for the facade."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from types import MappingProxyType
from typing import Any


def duplicate(values: Iterable[object]) -> list[object]:
    seen: set[object] = set()
    duplicates: set[object] = set()
    for value in values:
        if value in seen:
            duplicates.add(value)
        seen.add(value)
    return sorted(duplicates, key=repr)


def validate_bundle_entries(
    bundle: Mapping[str, Any],
    *,
    error_type: type[ValueError],
    duplicate_fn: Callable[[Iterable[object]], list[object]],
) -> None:
    """Reject duplicate catalog entries and dangling references before serving bytes."""

    surfaces = bundle["surfaces"]
    schemas = bundle["schemas"]
    operations = bundle["operations"]
    problems = bundle["problems"]
    surface_ids = [surface.get("id") for surface in surfaces if isinstance(surface, Mapping)]
    schema_names = [schema.get("name") for schema in schemas if isinstance(schema, Mapping)]
    operation_ids = [
        operation.get("id") for operation in operations if isinstance(operation, Mapping)
    ]
    operation_routes = [
        (operation.get("method"), operation.get("path"))
        for operation in operations
        if isinstance(operation, Mapping)
    ]
    problem_codes = [problem.get("code") for problem in problems if isinstance(problem, Mapping)]
    checks = (
        ("surface", surface_ids),
        ("schema", schema_names),
        ("operation", operation_ids),
        ("operation route", operation_routes),
        ("problem", problem_codes),
    )
    for label, values in checks:
        if any(value is None for value in values):
            raise error_type(f"contract bundle {label} entries must be objects with identity")
        duplicates = duplicate_fn(values)
        if duplicates:
            raise error_type(f"contract bundle has duplicate {label}: {duplicates[0]}")

    known_surfaces = set(surface_ids)
    known_schemas = set(schema_names)
    known_problems = set(problem_codes)
    for operation in operations:
        if not isinstance(operation, Mapping):
            raise error_type("contract bundle operation entries must be objects")
        if operation.get("surface") not in known_surfaces:
            raise error_type(f"operation has unknown surface: {operation.get('surface')!r}")
        for field in ("requestSchema", "responseSchema"):
            reference = operation.get(field)
            if reference is not None and reference not in known_schemas:
                raise error_type(f"operation has unknown {field}: {reference!r}")
        referenced_problems = operation.get("problems")
        if not isinstance(referenced_problems, list) or any(
            code not in known_problems for code in referenced_problems
        ):
            raise error_type(f"operation {operation.get('id')!r} has unknown problem code")


def assert_secret_free(
    value: object, *, error_type: type[ValueError], path: str = "bundle"
) -> None:
    """Reject credential-shaped fields from executable contract bytes."""

    forbidden_keys = {
        "token",
        "api_token",
        "apiToken",
        "authorization",
        "password",
        "secret",
        "client_secret",
        "clientSecret",
    }
    if isinstance(value, Mapping):
        for key, item in value.items():
            if str(key) in forbidden_keys:
                raise error_type(f"contract bundle contains secret field at {path}.{key}")
            assert_secret_free(item, error_type=error_type, path=f"{path}.{key}")
    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            assert_secret_free(item, error_type=error_type, path=f"{path}[{index}]")


def route_inventory(routes: Iterable[object]) -> tuple[tuple[str, str], ...]:
    """Return normalized public runtime HTTP route keys from FastAPI routes."""

    result: list[tuple[str, str]] = []
    pending = list(routes)
    while pending:
        route = pending.pop()
        original_router = getattr(route, "original_router", None)
        if original_router is not None:
            pending.extend(getattr(original_router, "routes", ()))
            continue
        children = getattr(route, "routes", None)
        if children is not None and not isinstance(children, (str, bytes)):
            pending.extend(children)
            continue
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", None)
        if path is None or methods is None:
            if not isinstance(route, (tuple, list)) or len(route) != 2:
                continue
            method, candidate_path = route
            if not isinstance(method, str) or not isinstance(candidate_path, str):
                continue
            path, methods = candidate_path, {method}
        public_prefixes = ("/v" + "1/", "/v2/")
        if not isinstance(path, str) or not path.startswith(public_prefixes):
            continue
        if not isinstance(methods, Iterable):
            continue
        for method in methods:
            if isinstance(method, str):
                result.append((method.upper(), path))
    return tuple(sorted(set(result)))


def contract_operation_inventory(bundle: Mapping[str, Any]) -> tuple[tuple[str, str], ...]:
    """Return normalized v2 operation keys from a loaded contract bundle."""

    return tuple(
        sorted(
            (str(operation["method"]).upper(), str(operation["path"]))
            for operation in bundle["operations"]
            if operation.get("surface") == "v2"
        )
    )


def canonical_json_bytes(value: object, *, error_type: type[ValueError]) -> bytes:
    """Serialize JSON deterministically for hashing and transport."""

    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise error_type("contract data is not canonical JSON") from error


def sha256_hex(value: bytes) -> str:
    """Return the lowercase SHA-256 digest for exact bytes."""

    return hashlib.sha256(value).hexdigest()


def deep_freeze(value: Any) -> Any:
    """Freeze nested contract data so served bytes cannot drift in-process."""

    if isinstance(value, Mapping):
        return MappingProxyType({key: deep_freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(deep_freeze(item) for item in value)
    return value


def json_source(source: object, *, error_type: type[ValueError]) -> dict[str, Any]:
    if isinstance(source, Mapping):
        value = dict(source)
    elif isinstance(source, bytes):
        try:
            value = json.loads(source.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise error_type("contract JSON is invalid UTF-8 or JSON") from error
    elif isinstance(source, Path):
        try:
            return json_source(source.read_bytes(), error_type=error_type)
        except OSError as error:
            raise error_type(f"unable to read contract JSON: {source}") from error
    elif isinstance(source, str):
        candidate = source.strip()
        if candidate.startswith("{"):
            try:
                value = json.loads(candidate)
            except json.JSONDecodeError as error:
                raise error_type("contract JSON is invalid") from error
        else:
            return json_source(Path(source), error_type=error_type)
    else:
        raise error_type("contract JSON must be a mapping, bytes, string, or path")
    if not isinstance(value, dict):
        raise error_type("contract JSON root must be an object")
    return value
