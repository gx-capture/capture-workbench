"""A module does not import another context's private (underscore) names.

The contexts are the ones the import-linter contracts in importlinter.toml define (DDD refactor
step W1, .agents/PLANS/ddd-refactor/ decision D7). Inside one context a private helper may be
shared; across contexts it is an implementation detail that another context must not rely on.
"""

from __future__ import annotations

import ast
import tomllib
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[2]
SOURCE = PACKAGE_ROOT / "src"
CONTEXT_SUFFIX = " does not depend on its downstream contexts"
# Worker entry points belong to the engine they start.
ENTRY_POINTS = {
    "capture_runtime.workers.ocr_main": "Document OCR",
    "capture_runtime.workers.speech_recognition_main": "Speech transcription",
    "capture_runtime.workers.diarization_main": "Speaker diarization",
}
# Known before the refactor (W2-W5 remove them); this list may only shrink. Names are relative
# to capture_runtime: (importing module, defining module, private name).
_KNOWN = {
    ("progressive_capture", "worker_process", "_subprocess_path"),
    ("speaker_diarization", "engine_adapters", "_directory_digest"),
    ("speech_recognition", "engine_adapters", "_directory_digest"),
    ("storage.installation_repository", "storage.common", "_atomic_json"),
    ("storage.installation_repository", "storage.common", "_dump_model"),
    ("storage.installation_repository", "storage.common", "_identifier"),
    ("storage.model_installation_repository", "storage.common", "_atomic_json"),
    ("storage.model_installation_repository", "storage.common", "_dump_model"),
    ("storage.model_installation_repository", "storage.common", "_identifier"),
    ("storage.structuring_session_repository", "storage.common", "_atomic_json"),
}
KNOWN = {
    (f"capture_runtime.{importer}", f"capture_runtime.{source}", name)
    for importer, source, name in _KNOWN
}


def _contexts() -> dict[str, str]:
    config = tomllib.loads((PACKAGE_ROOT / "importlinter.toml").read_text(encoding="utf-8"))
    members: dict[str, str] = dict(ENTRY_POINTS)
    for contract in config["tool"]["importlinter"]["contracts"]:
        if contract["name"].endswith(CONTEXT_SUFFIX):
            context = contract["name"].removesuffix(CONTEXT_SUFFIX)
            members.update({module: context for module in contract["source_modules"]})
    return members


def _context_of(module: str, members: dict[str, str]) -> str:
    best = ""
    for candidate in members:
        inside = module == candidate or module.startswith(candidate + ".")
        if inside and len(candidate) > len(best):
            best = candidate
    return members.get(best, "composition")


def _private_imports() -> set[tuple[str, str, str]]:
    found = set()
    for path in sorted((SOURCE / "capture_runtime").rglob("*.py")):
        if "_vendor" in path.parts:
            continue
        module = ".".join(path.relative_to(SOURCE).with_suffix("").parts).removesuffix(".__init__")
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not isinstance(node, ast.ImportFrom) or node.level or not node.module:
                continue
            if not node.module.startswith("capture_runtime") or node.module == module:
                continue
            for alias in node.names:
                if alias.name.startswith("_") and not alias.name.startswith("__"):
                    found.add((module, node.module, alias.name))
    return found


def test_no_context_imports_another_contexts_private_names() -> None:
    members = _contexts()
    crossing = {
        (importer, source, name)
        for importer, source, name in _private_imports()
        if _context_of(importer, members) != _context_of(f"{source}.{name}", members)
    }

    assert crossing - KNOWN == set(), "new private imports across contexts"
    assert KNOWN - crossing == set(), "a known exception is gone: remove it from KNOWN"
