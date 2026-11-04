"""Semantic layers helper for Capture Workbench (DDD plan section 5, decision D11).

A context takes part once it has docs/domain/<context>.md with a '## 用例' section.
"""

from __future__ import annotations

import importlib
import pkgutil
import re
from pathlib import Path
from types import ModuleType

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = PACKAGE_ROOT.parents[1]
SOURCE_ROOT = PACKAGE_ROOT / "src" / "capture_runtime"
DOMAIN_DOCS = REPOSITORY_ROOT / "docs" / "domain"
GLOSSARY = REPOSITORY_ROOT / ".agents" / "PLANS" / "ddd-refactor" / "glossary.md"
VOCABULARY = PACKAGE_ROOT / "vocabulary" / "capture-vocabulary-v1.json"
_CODE_NAME = re.compile(r"`([A-Za-z_][A-Za-z0-9_]*)`")


def documented_contexts() -> list[str]:
    contexts: list[str] = []
    for page in DOMAIN_DOCS.glob("*.md"):
        if page.name == "README.md":
            continue
        stem = page.stem
        if not (SOURCE_ROOT / stem).is_dir():
            continue
        text = page.read_text(encoding="utf-8")
        if "\n## 用例" in text:
            contexts.append(stem)
    return sorted(contexts)


def modules_of(package_name: str) -> list[ModuleType]:
    try:
        package = importlib.import_module(package_name)
    except ModuleNotFoundError:
        return []
    modules = [package]
    if hasattr(package, "__path__"):
        for info in pkgutil.walk_packages(package.__path__, prefix=f"{package_name}."):
            modules.append(importlib.import_module(info.name))
    return modules


def glossary_code_names() -> set[str]:
    """Every name in the code-name column of the glossary's tables."""
    names: set[str] = set()
    for line in GLOSSARY.read_text(encoding="utf-8").splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if line.lstrip().startswith("|") and len(cells) >= 2:
            names.update(_CODE_NAME.findall(cells[1]))
    return names


def documented_use_cases(context: str) -> set[str]:
    """The code names in the use-case table of docs/domain/<context>.md."""
    text = (DOMAIN_DOCS / f"{context}.md").read_text(encoding="utf-8")
    section = text.split("\n## 用例", 1)[1].split("\n## ", 1)[0]
    names: set[str] = set()
    for line in section.splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if line.lstrip().startswith("|") and len(cells) >= 2:
            names.update(_CODE_NAME.findall(cells[1]))
    return names
