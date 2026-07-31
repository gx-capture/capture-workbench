from __future__ import annotations

import argparse
import hashlib
import importlib.util
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "report_bundle_size.py"
SPEC = importlib.util.spec_from_file_location("capture_report_bundle_size", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
report_bundle_size = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(report_bundle_size)


def test_report_binds_the_canonical_release_executable(
    tmp_path: Path,
) -> None:
    executable = tmp_path / "dist" / "release" / "capture-runtime-x86_64-pc-windows-msvc.exe"
    executable.parent.mkdir(parents=True)
    executable_bytes = b"exact canonical runtime bytes"
    executable.write_bytes(executable_bytes)

    report = report_bundle_size.build_report(
        argparse.Namespace(
            executable=executable,
            installer=None,
            installed_size_evidence=None,
            pyinstaller_work=None,
        )
    )

    assert report["runtimeExecutable"] == {
        "path": executable.resolve().as_posix(),
        "fileName": executable.name,
        "bytes": len(executable_bytes),
        "sha256": hashlib.sha256(executable_bytes).hexdigest(),
    }


def test_pyinstaller_fallback_emits_canonical_v2_categories(tmp_path: Path) -> None:
    assert report_bundle_size.pyinstaller_inventory(tmp_path / "missing") == {
        "blocker": "PyInstaller work directory is unavailable.",
        "categories": {
            "core": 0,
            "ocr": 0,
            "other": 0,
            "pdf": 0,
            "whisper": 0,
        },
        "files": [],
        "topFiles": [],
    }


def test_installed_size_evidence_requires_exact_installer_and_native_uninstall(
    tmp_path: Path,
) -> None:
    evidence = tmp_path / "installed-size.json"
    evidence.write_text(
        """
{
  "arch": "x86_64",
  "bundle": "nsis",
  "cleanup": {
    "installDirectoryRemoved": true,
    "isolatedRunDataRemoved": false,
    "nativeUninstallKeyRemoved": true,
    "productRegistryKeyRetainedAfterNativeUninstall": true,
    "registryResidueRemoved": false,
    "uninstallerCompleted": true
  },
  "disclaimer": "size only",
  "evidenceKind": "release-installed-size",
  "installedBytes": 1234,
  "installer": {
    "fileName": "Capture Workbench_0.3.7_x64-setup.exe",
    "bytes": 99,
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "platform": "windows",
  "releaseGateSatisfied": false
}
""".strip(),
        encoding="utf-8",
    )
    installed_bytes, blocker = report_bundle_size.installed_bytes_evidence(
        evidence,
        installer={
            "fileName": "Capture Workbench_0.3.7_x64-setup.exe",
            "bytes": 99,
            "sha256": "a" * 64,
        },
    )
    assert installed_bytes == 1234
    assert blocker is None

    installed_bytes, blocker = report_bundle_size.installed_bytes_evidence(
        evidence,
        installer={
            "fileName": "Capture Workbench_0.3.7_x64-setup.exe",
            "bytes": 100,
            "sha256": "a" * 64,
        },
    )
    assert installed_bytes is None
    assert blocker is not None


def test_installed_size_evidence_rejects_a_different_installer_filename(
    tmp_path: Path,
) -> None:
    evidence = tmp_path / "installed-size.json"
    evidence.write_text(
        """
{
  "arch": "x86_64",
  "bundle": "nsis",
  "cleanup": {
    "installDirectoryRemoved": true,
    "isolatedRunDataRemoved": false,
    "nativeUninstallKeyRemoved": true,
    "productRegistryKeyRetainedAfterNativeUninstall": false,
    "registryResidueRemoved": false,
    "uninstallerCompleted": true
  },
  "disclaimer": "size only",
  "evidenceKind": "release-installed-size",
  "installedBytes": 1234,
  "installer": {
    "fileName": "other.exe",
    "bytes": 99,
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "platform": "windows",
  "releaseGateSatisfied": false
}
""".strip(),
        encoding="utf-8",
    )
    installed_bytes, blocker = report_bundle_size.installed_bytes_evidence(
        evidence,
        installer={
            "fileName": "Capture Workbench_0.3.7_x64-setup.exe",
            "bytes": 99,
            "sha256": "a" * 64,
        },
    )
    assert installed_bytes is None
    assert blocker is not None


def test_installed_size_evidence_rejects_boolean_bytes(tmp_path: Path) -> None:
    evidence = tmp_path / "installed-size.json"
    evidence.write_text(
        """
{
  "arch": "x86_64",
  "bundle": "nsis",
  "cleanup": {
    "installDirectoryRemoved": true,
    "isolatedRunDataRemoved": false,
    "nativeUninstallKeyRemoved": true,
    "productRegistryKeyRetainedAfterNativeUninstall": false,
    "registryResidueRemoved": false,
    "uninstallerCompleted": true
  },
  "disclaimer": "size only",
  "evidenceKind": "release-installed-size",
  "installedBytes": true,
  "installer": {
    "fileName": "Capture Workbench_0.3.7_x64-setup.exe",
    "bytes": 99,
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "platform": "windows",
  "releaseGateSatisfied": false
}
""".strip(),
        encoding="utf-8",
    )

    installed_bytes, blocker = report_bundle_size.installed_bytes_evidence(
        evidence,
        installer={
            "fileName": "Capture Workbench_0.3.7_x64-setup.exe",
            "bytes": 99,
            "sha256": "a" * 64,
        },
    )

    assert installed_bytes is None
    assert blocker is not None
