from __future__ import annotations

import argparse
import ast
import hashlib
import json
import platform
from collections.abc import Iterable
from pathlib import Path
from typing import Any

REPORT_VERSION = "2"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def artifact(path: Path | None) -> dict[str, Any] | None:
    if path is None or not path.is_file():
        return None
    return {
        "path": path.as_posix(),
        "fileName": path.name,
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def installed_bytes_evidence(
    path: Path | None,
    *,
    installer: dict[str, Any] | None,
) -> tuple[int | None, str | None]:
    if path is None or not path.is_file():
        return None, "Installed directory or installed-size evidence was not supplied."
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return None, f"Installed-size evidence is unreadable: {error}"
    if not isinstance(payload, dict) or set(payload) != {
        "arch",
        "bundle",
        "cleanup",
        "disclaimer",
        "evidenceKind",
        "installedBytes",
        "installer",
        "platform",
        "releaseGateSatisfied",
    }:
        return None, "Installed-size evidence fields are invalid."
    evidence_installer = payload["installer"]
    cleanup = payload["cleanup"]
    if (
        payload["evidenceKind"] != "release-installed-size"
        or payload["releaseGateSatisfied"] is not False
        or payload["platform"] != "windows"
        or payload["arch"] != "x86_64"
        or payload["bundle"] != "nsis"
        or isinstance(payload["installedBytes"], bool)
        or not isinstance(payload["installedBytes"], int)
        or payload["installedBytes"] < 1
        or not isinstance(evidence_installer, dict)
        or installer is None
        or evidence_installer.get("fileName") != installer["fileName"]
        or evidence_installer.get("bytes") != installer["bytes"]
        or evidence_installer.get("sha256") != installer["sha256"]
        or not isinstance(cleanup, dict)
        or cleanup.get("uninstallerCompleted") is not True
        or cleanup.get("installDirectoryRemoved") is not True
        or cleanup.get("nativeUninstallKeyRemoved") is not True
    ):
        return (
            None,
            "Installed-size evidence did not prove the exact installer and native uninstall.",
        )
    return payload["installedBytes"], None


def _walk_strings(value: object) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _walk_strings(item)
    elif isinstance(value, list | tuple):
        for item in value:
            yield from _walk_strings(item)


def pyinstaller_inventory(work_dir: Path | None) -> dict[str, Any]:
    categories = {"core": 0, "pdf": 0, "ocr": 0, "whisper": 0, "other": 0}
    if work_dir is None or not work_dir.is_dir():
        return {
            "files": [],
            "topFiles": [],
            "categories": categories,
            "blocker": "PyInstaller work directory is unavailable.",
        }
    files = [
        {
            "path": item.relative_to(work_dir).as_posix(),
            "bytes": item.stat().st_size,
        }
        for item in work_dir.rglob("*")
        if item.is_file()
    ]
    files.sort(key=lambda item: (-int(item["bytes"]), str(item["path"])))
    toc = next(iter(work_dir.rglob("PKG-00.toc")), None)
    if toc is not None:
        try:
            payload = ast.literal_eval(toc.read_text(encoding="utf-8"))
            seen: set[str] = set()
            for candidate in _walk_strings(payload):
                path = Path(candidate)
                if candidate in seen or not path.is_file():
                    continue
                seen.add(candidate)
                lowered = candidate.lower().replace("\\", "/")
                size = path.stat().st_size
                if any(
                    token in lowered
                    for token in (
                        "paddle",
                        "onnxruntime",
                        "opencv",
                        "cv2",
                        "pypdfium2",
                        "/pil/",
                        "pillow",
                    )
                ):
                    categories["ocr"] += size
                elif any(
                    token in lowered
                    for token in (
                        "faster_whisper",
                        "ctranslate2",
                        "huggingface",
                        "/av/",
                        "av.libs",
                    )
                ):
                    categories["whisper"] += size
                elif "pypdf" in lowered:
                    categories["pdf"] += size
                elif any(
                    token in lowered
                    for token in (
                        "capture_runtime",
                        "fastapi",
                        "pydantic",
                        "starlette",
                        "uvicorn",
                    )
                ):
                    categories["core"] += size
                else:
                    categories["other"] += size
        except (OSError, SyntaxError, ValueError) as error:
            return {
                "files": files,
                "topFiles": files[:25],
                "categories": categories,
                "blocker": f"Could not parse PyInstaller TOC: {error}",
            }
    return {
        "files": files,
        "topFiles": files[:25],
        "categories": categories,
        "blocker": None if toc is not None else "PKG-00.toc is unavailable.",
    }


def build_report(arguments: argparse.Namespace) -> dict[str, Any]:
    executable = arguments.executable.resolve() if arguments.executable else None
    installer = arguments.installer.resolve() if arguments.installer else None
    installed_evidence = (
        arguments.installed_size_evidence.resolve() if arguments.installed_size_evidence else None
    )
    work_dir = arguments.pyinstaller_work.resolve() if arguments.pyinstaller_work else None
    installer_artifact = artifact(installer)
    installed_bytes, installed_blocker = installed_bytes_evidence(
        installed_evidence,
        installer=installer_artifact,
    )
    return {
        "reportVersion": REPORT_VERSION,
        "platform": "windows" if platform.system() == "Windows" else platform.system().lower(),
        "arch": platform.machine().lower(),
        "pythonVersion": platform.python_version(),
        "runtimeExecutable": artifact(executable),
        "nsisInstaller": installer_artifact,
        "installedBytes": installed_bytes,
        "installedBytesBlocker": installed_blocker,
        "pyinstaller": pyinstaller_inventory(work_dir),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", type=Path)
    parser.add_argument("--installer", type=Path)
    parser.add_argument("--installed-size-evidence", type=Path)
    parser.add_argument("--pyinstaller-work", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    report = build_report(arguments)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
