"""Fail-closed validation for the v0.3.9 direct-model source lock."""

from __future__ import annotations

import argparse
import hashlib
import json
import unicodedata
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlsplit

LOCK_VERSION = "2"
RELEASE_VERSION = "0.3.9"
COMMIT_A_SHA = "31821b241846878d917a60e638a4fce39aba418a"
FIRST_PARTY_ROOT = (
    "https://raw.githubusercontent.com/gx-capture/capture-workbench/"
    f"{COMMIT_A_SHA}/packages/capture-runtime/model-sources/commit-a"
)
MAX_ENTRIES = 4096
# Keep the direct-model lane bounded while admitting the pinned Whisper
# primary model (~1.62 GiB) and the complete fallback/OCR set.  These limits
# are shared by the source lock and the runtime installer/catalog validators.
MAX_SINGLE_FILE_BYTES = 2 * 1024 * 1024 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
MAX_SOURCE_LOCK_TOTAL_BYTES = 3 * 1024 * 1024 * 1024
REQUIREMENT_IDS = ("windowsml-ocr", "whisper-primary")
CORE_ONLY_RELEASE_MODE = "core-only"
MODEL_ENABLED_RELEASE_MODE = "model-enabled"
PENDING_WHISPER_FREEZE_BLOCKER = (
    "Freeze private Whisper model/device pair and normalized output digest "
    "from two identical production runs."
)
HEX = frozenset("0123456789abcdef")
WINDOWS_FORBIDDEN_PATH_CHARACTERS = frozenset('<>:"|?*')
WINDOWS_RESERVED_DEVICE_BASENAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{index}" for index in range(1, 10)}
    | {f"LPT{index}" for index in range(1, 10)}
)
OCR_FIXTURE_SHA256 = "7d61f4835837c4c387a0d46c4f21f7442fe22aab3f14f330b86f6857f5f3bc82"
OCR_FIXTURE_BYTES = 2157
OCR_PDF_SHA256 = "5eec85d2b2e98e06577cb5310d1b3037ca26f03d06d85a292ae78b68d4c57f30"
OCR_PDF_BYTES = 2421
PRIVATE_WHISPER_FIXTURE_BYTES = 11_005_641
PRIVATE_WHISPER_FIXTURE_SHA256 = "7f844ad97129470ee0981effcf31f5d69d5556e18c452e9ff27d418bc32d1a5d"


class ModelSourceLockError(ValueError):
    """Raised when direct model delivery metadata is incomplete or unsafe."""


def canonical_json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _exact(value: object, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        found = sorted(value) if isinstance(value, dict) else type(value).__name__
        raise ModelSourceLockError(f"{label} fields must be {sorted(keys)}; found {found}")
    return value


def _text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ModelSourceLockError(f"{label} must be a non-empty string")
    return value


def _sha256(value: object, label: str, *, allow_pending: bool = False) -> str | None:
    if allow_pending and value is None:
        return None
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in HEX for character in value)
    ):
        raise ModelSourceLockError(f"{label} must be 64 lowercase hexadecimal characters")
    return value


def _safe_path(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ModelSourceLockError(f"{label} must be a POSIX relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ModelSourceLockError(f"{label} must not escape its requirement root")
    for part in path.parts:
        if (
            part.endswith((".", " "))
            or any(
                character in WINDOWS_FORBIDDEN_PATH_CHARACTERS
                or unicodedata.category(character) == "Cc"
                for character in part
            )
            or part.split(".", 1)[0].rstrip(" .").upper() in WINDOWS_RESERVED_DEVICE_BASENAMES
        ):
            raise ModelSourceLockError(f"{label} contains a Windows-unsafe path component")
    return path.as_posix()


def _https_url(value: object, label: str) -> tuple[str, str]:
    url = _text(value, label)
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ModelSourceLockError(
            f"{label} must be absolute HTTPS without credentials, query, or fragment"
        )
    return url, parsed.hostname.lower()


def _first_party_url(value: object, relative: str, label: str) -> str:
    url, host = _https_url(value, label)
    expected = f"{FIRST_PARTY_ROOT}/{relative}"
    if host != "raw.githubusercontent.com" or url != expected:
        raise ModelSourceLockError(f"{label} must bind the exact Commit A raw URL")
    return url


def _redirect_hosts(value: object, initial_host: str, label: str) -> list[str]:
    if (
        not isinstance(value, list)
        or value != sorted(set(value))
        or any(
            not isinstance(host, str)
            or not host
            or host != host.lower()
            or "@" in host
            or "/" in host
            for host in value
        )
        or initial_host in value
    ):
        raise ModelSourceLockError(f"{label} must be sorted unique extra hosts")
    return value


def _derivation(value: object, label: str, *, known_paths: set[str]) -> None:
    payload = _exact(
        value,
        {"algorithm", "generator", "inputs", "sourceCommit", "toolVersions"},
        label,
    )
    _text(payload["algorithm"], f"{label}.algorithm")
    _text(payload["generator"], f"{label}.generator")
    if payload["sourceCommit"] != COMMIT_A_SHA:
        raise ModelSourceLockError(f"{label}.sourceCommit must equal Commit A")
    inputs = payload["inputs"]
    if not isinstance(inputs, list) or not inputs:
        raise ModelSourceLockError(f"{label}.inputs must be non-empty")
    for index, item in enumerate(inputs):
        path = _safe_path(item, f"{label}.inputs[{index}]")
        if path not in known_paths:
            raise ModelSourceLockError(f"{label} input is not locked: {path}")
    if inputs != sorted(set(inputs)):
        raise ModelSourceLockError(f"{label}.inputs must be sorted and unique")
    versions = payload["toolVersions"]
    if (
        not isinstance(versions, dict)
        or not versions
        or any(
            not isinstance(key, str) or not key or not isinstance(item, str) or not item
            for key, item in versions.items()
        )
    ):
        raise ModelSourceLockError(f"{label}.toolVersions must pin exact versions")


def _validate_file(
    raw_file: object,
    *,
    requirement_id: str,
    index: int,
    known_paths: set[str],
) -> dict[str, Any]:
    item = _exact(
        raw_file,
        {
            "bytes",
            "derivation",
            "kind",
            "licensePath",
            "noticePath",
            "owner",
            "path",
            "redirectHosts",
            "revision",
            "sha256",
            "spdx",
            "url",
        },
        f"{requirement_id}.files[{index}]",
    )
    path = _safe_path(item["path"], f"{requirement_id}.files[{index}].path")
    kind = item["kind"]
    if kind not in {"derived", "license", "notice", "provenance", "source"}:
        raise ModelSourceLockError(f"{requirement_id}.{path}.kind is invalid")
    size = item["bytes"]
    if not isinstance(size, int) or isinstance(size, bool) or size < 1:
        raise ModelSourceLockError(f"{requirement_id}.{path}.bytes must be positive")
    if size > MAX_SINGLE_FILE_BYTES:
        raise ModelSourceLockError(f"{requirement_id}.{path} exceeds 2 GiB single-file limit")
    _sha256(item["sha256"], f"{requirement_id}.{path}.sha256")
    _text(item["owner"], f"{requirement_id}.{path}.owner")
    _text(item["spdx"], f"{requirement_id}.{path}.spdx")
    revision = _text(item["revision"], f"{requirement_id}.{path}.revision")
    if len(revision) != 40 or any(character not in HEX for character in revision):
        raise ModelSourceLockError(f"{requirement_id}.{path}.revision must be a full lowercase SHA")
    url, initial_host = _https_url(item["url"], f"{requirement_id}.{path}.url")
    if revision not in url:
        raise ModelSourceLockError(f"{requirement_id}.{path}.url must contain its revision")
    _redirect_hosts(item["redirectHosts"], initial_host, f"{requirement_id}.{path}.redirectHosts")
    if kind == "derived":
        _derivation(
            item["derivation"], f"{requirement_id}.{path}.derivation", known_paths=known_paths
        )
    elif item["derivation"] is not None:
        raise ModelSourceLockError("only derived entries may define derivation metadata")
    if kind in {"license", "notice"}:
        if item["licensePath"] is not None or item["noticePath"] is not None:
            raise ModelSourceLockError("license/NOTICE entries cannot reference themselves")
    else:
        _safe_path(item["licensePath"], f"{requirement_id}.{path}.licensePath")
        _safe_path(item["noticePath"], f"{requirement_id}.{path}.noticePath")
    return item


def _validate_requirement(raw_requirement: object, index: int) -> dict[str, Any]:
    requirement = _exact(
        raw_requirement,
        {"artifactVersion", "entryPoint", "files", "requirementId"},
        f"requirement[{index}]",
    )
    requirement_id = _text(requirement["requirementId"], f"requirement[{index}].requirementId")
    if requirement["artifactVersion"] != RELEASE_VERSION:
        raise ModelSourceLockError(f"{requirement_id} artifactVersion is unsynchronized")
    if requirement["entryPoint"] != "model":
        raise ModelSourceLockError(f"{requirement_id} entryPoint must remain model")
    files = requirement["files"]
    if not isinstance(files, list) or not files or len(files) > MAX_ENTRIES:
        raise ModelSourceLockError(f"{requirement_id} files are missing or excessive")
    previous = ""
    folded: set[str] = set()
    total = 0
    licenses: set[str] = set()
    notices: set[str] = set()
    known_paths = {
        _safe_path(item["path"], f"{requirement_id}.files.path")
        for item in files
        if isinstance(item, dict) and "path" in item
    }
    validated: list[dict[str, Any]] = []
    for file_index, raw_file in enumerate(files):
        item = _validate_file(
            raw_file,
            requirement_id=requirement_id,
            index=file_index,
            known_paths=known_paths,
        )
        path = _safe_path(item["path"], f"{requirement_id}.files[{file_index}].path")
        if path <= previous or path.casefold() in folded:
            raise ModelSourceLockError(f"{requirement_id} file paths must be sorted and unique")
        previous = path
        folded.add(path.casefold())
        if item["kind"] == "license":
            licenses.add(path)
        elif item["kind"] == "notice":
            notices.add(path)
        total += item["bytes"]
        if total > MAX_TOTAL_BYTES:
            raise ModelSourceLockError(f"{requirement_id} exceeds aggregate 2 GiB model limit")
        validated.append(item)
    if not licenses or not notices:
        raise ModelSourceLockError(f"{requirement_id} must pin license and NOTICE files")
    for item in validated:
        if item["kind"] not in {"license", "notice"} and (
            item["licensePath"] not in licenses or item["noticePath"] not in notices
        ):
            raise ModelSourceLockError(
                f"{requirement_id} entries must reference license and NOTICE"
            )
    if requirement_id == "windowsml-ocr":
        pipeline = next((item for item in validated if item["path"] == "model/pipeline.json"), None)
        if pipeline is None or pipeline["kind"] != "derived":
            raise ModelSourceLockError("OCR requirement needs derived model/pipeline.json")
        for item in validated:
            path = item["path"]
            if path in {"model/pipeline.json", "provenance/commit-a.json"}:
                _first_party_url(item["url"], path, f"windowsml-ocr.{path}.url")
    return requirement


def _validate_ocr_fixture(value: object) -> dict[str, Any]:
    fixture = _exact(
        value,
        {
            "bytes",
            "expectedDevice",
            "expectedEngine",
            "expectedModel",
            "expectedText",
            "id",
            "kind",
            "licenseBytes",
            "licensePath",
            "licenseSha256",
            "licenseUrl",
            "mediaType",
            "noticeBytes",
            "noticePath",
            "noticeSha256",
            "noticeUrl",
            "owner",
            "pdfBytes",
            "pdfSha256",
            "pdfUrl",
            "redistributable",
            "revision",
            "sha256",
            "spdx",
            "url",
        },
        "ocr fixture",
    )
    if fixture["kind"] != "ocr" or fixture["id"] != "ocr-reference":
        raise ModelSourceLockError("OCR fixture identity is invalid")
    if (
        fixture["bytes"] != OCR_FIXTURE_BYTES
        or fixture["sha256"] != OCR_FIXTURE_SHA256
        or fixture["mediaType"] != "image/png"
        or fixture["expectedEngine"] != "windowsml-ocr"
        or fixture["expectedModel"] != "pp-ocrv6-medium-windowsml"
        or fixture["expectedDevice"] != "windowsml-dml"
        or fixture["expectedText"] != "CAPTURE OCR FIXTURE"
        or fixture["pdfBytes"] != OCR_PDF_BYTES
        or fixture["pdfSha256"] != OCR_PDF_SHA256
        or fixture["redistributable"] is not True
    ):
        raise ModelSourceLockError("OCR fixture bytes/text/provenance are not the Commit A fixture")
    revision = fixture["revision"]
    if revision != COMMIT_A_SHA:
        raise ModelSourceLockError("OCR fixture must bind Commit A")
    for key in ("sha256", "licenseSha256", "noticeSha256", "pdfSha256"):
        _sha256(fixture[key], f"ocr fixture {key}")
    if fixture["licenseBytes"] != 1087 or fixture["noticeBytes"] != 303:
        raise ModelSourceLockError("OCR fixture license/NOTICE bytes drifted")
    _first_party_url(fixture["url"], "fixtures/ocr-reference.png", "OCR fixture url")
    _first_party_url(fixture["pdfUrl"], "fixtures/ocr-scanned.pdf", "OCR fixture pdfUrl")
    _first_party_url(fixture["licenseUrl"], "licenses/LICENSE.txt", "OCR fixture licenseUrl")
    _first_party_url(fixture["noticeUrl"], "licenses/NOTICE.txt", "OCR fixture noticeUrl")
    if (
        fixture["licensePath"] != "licenses/LICENSE.txt"
        or fixture["noticePath"] != "licenses/NOTICE.txt"
    ):
        raise ModelSourceLockError("OCR fixture license/NOTICE paths are invalid")
    return fixture


def _validate_private_whisper_fixture(value: object, *, require_approved: bool) -> dict[str, Any]:
    fixture = _exact(
        value,
        {
            "bytes",
            "expectedDevice",
            "expectedEngine",
            "expectedModel",
            "expectedNormalizedOutputSha256",
            "expectedSegmentCount",
            "id",
            "kind",
            "mediaType",
            "monotonicSegments",
            "sha256",
        },
        "private Whisper fixture",
    )
    if fixture["kind"] != "whisper" or fixture["id"] != "whisper-private-reference":
        raise ModelSourceLockError("private Whisper fixture identity is invalid")
    if (
        fixture["bytes"] != PRIVATE_WHISPER_FIXTURE_BYTES
        or fixture["sha256"] != PRIVATE_WHISPER_FIXTURE_SHA256
        or fixture["mediaType"] != "audio/mpeg"
        or fixture["expectedEngine"] != "whisper-primary"
        or fixture["monotonicSegments"] is not True
    ):
        raise ModelSourceLockError("private Whisper fixture bytes/provenance are invalid")
    expected_model = fixture["expectedModel"]
    expected_device = fixture["expectedDevice"]
    if expected_model is None or expected_device is None:
        if require_approved:
            raise ModelSourceLockError(
                "private Whisper model/device pair is pending two-run freeze"
            )
        if expected_model is not None or expected_device is not None:
            raise ModelSourceLockError("private Whisper model/device pair must be frozen together")
    elif (expected_model, expected_device) not in {
        ("large-v3-turbo", "cuda"),
        ("small", "cpu"),
    }:
        raise ModelSourceLockError("private Whisper model/device pair is unsupported")
    count = _exact(fixture["expectedSegmentCount"], {"maximum", "minimum"}, "Whisper segment count")
    if count["minimum"] != 1 or count["maximum"] != 10_000:
        raise ModelSourceLockError("private Whisper segment count bounds are invalid")
    digest = _sha256(
        fixture["expectedNormalizedOutputSha256"],
        "private Whisper expectedNormalizedOutputSha256",
        allow_pending=True,
    )
    if require_approved and digest is None:
        raise ModelSourceLockError("private Whisper output digest is pending two-run freeze")
    return fixture


def validate_source_lock(
    payload: object,
    *,
    require_approved: bool = True,
) -> dict[str, Any]:
    lock = _exact(
        payload,
        {"approval", "fixtures", "lockVersion", "releaseVersion", "requirements"},
        "model source lock",
    )
    if lock["lockVersion"] != LOCK_VERSION or lock["releaseVersion"] != RELEASE_VERSION:
        raise ModelSourceLockError("model source lock version is unsupported or unsynchronized")
    approval = _exact(
        lock["approval"],
        {"approvedAt", "approvedBy", "blockers", "status"},
        "model source lock approval",
    )
    blockers = approval["blockers"]
    if not isinstance(blockers, list) or any(
        not isinstance(item, str) or not item.strip() for item in blockers
    ):
        raise ModelSourceLockError("model source lock blockers must be non-empty strings")
    if approval["status"] == "approved":
        _text(approval["approvedAt"], "approval.approvedAt")
        _text(approval["approvedBy"], "approval.approvedBy")
        if blockers:
            raise ModelSourceLockError("approved source lock cannot retain blockers")
    elif approval["status"] == "blocked":
        if approval["approvedAt"] is not None or approval["approvedBy"] is not None or not blockers:
            raise ModelSourceLockError("blocked source lock must identify unresolved blockers")
    else:
        raise ModelSourceLockError("model source lock approval status is invalid")

    requirements = lock["requirements"]
    if not isinstance(requirements, list):
        raise ModelSourceLockError("model source lock requirements must be a list")
    core_only = not requirements
    if core_only:
        if lock["fixtures"]:
            raise ModelSourceLockError("core-only source lock cannot contain fixtures")
        return lock
    if approval["status"] == "blocked" and approval["blockers"] != [PENDING_WHISPER_FREEZE_BLOCKER]:
        raise ModelSourceLockError(
            "blocked model source lock must contain only the private Whisper two-run freeze blocker"
        )
    if [item.get("requirementId") for item in requirements if isinstance(item, dict)] != list(
        REQUIREMENT_IDS
    ):
        raise ModelSourceLockError(
            "requirements must be ordered windowsml-ocr then whisper-primary"
        )
    validated_requirements: list[dict[str, Any]] = []
    total_locked_bytes = 0
    for index, requirement in enumerate(requirements):
        validated = _validate_requirement(requirement, index)
        validated_requirements.append(validated)
        total_locked_bytes += sum(item["bytes"] for item in validated["files"])
    if total_locked_bytes > MAX_SOURCE_LOCK_TOTAL_BYTES:
        raise ModelSourceLockError("model source lock exceeds aggregate 3 GiB model limit")
    fixtures = lock["fixtures"]
    if not isinstance(fixtures, list) or len(fixtures) != 2:
        raise ModelSourceLockError(
            "model-enabled source lock needs OCR and private Whisper fixtures"
        )
    if [item.get("kind") for item in fixtures if isinstance(item, dict)] != ["ocr", "whisper"]:
        raise ModelSourceLockError("fixtures must be ordered OCR then private Whisper")
    _validate_ocr_fixture(fixtures[0])
    _validate_private_whisper_fixture(fixtures[1], require_approved=require_approved)
    if require_approved and approval["status"] != "approved":
        raise ModelSourceLockError("model source lock is blocked: " + "; ".join(blockers))
    return lock


def load_source_lock(path: Path, *, require_approved: bool = True) -> dict[str, Any]:
    try:
        raw = path.read_bytes()
        payload = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ModelSourceLockError(f"model source lock is unreadable: {path}") from error
    lock = validate_source_lock(payload, require_approved=require_approved)
    if raw != canonical_json_bytes(lock):
        raise ModelSourceLockError("model source lock must be canonical sorted-key UTF-8 JSON")
    return lock


def source_lock_sha256(lock: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json_bytes(lock)).hexdigest()


def release_mode(lock: dict[str, Any]) -> str:
    return CORE_ONLY_RELEASE_MODE if not lock["requirements"] else MODEL_ENABLED_RELEASE_MODE


def model_delivery(lock: dict[str, Any], requirement_id: str) -> dict[str, Any]:
    requirement = next(
        item for item in lock["requirements"] if item["requirementId"] == requirement_id
    )
    manifest = {
        "artifactVersion": requirement["artifactVersion"],
        "entryPoint": requirement["entryPoint"],
        "files": requirement["files"],
        "manifestVersion": "1",
    }
    return {
        "artifactVersion": requirement["artifactVersion"],
        "entryCount": len(requirement["files"]),
        "entryPoint": requirement["entryPoint"],
        "extractedBytes": sum(item["bytes"] for item in requirement["files"]),
        "files": requirement["files"],
        "manifestSha256": hashlib.sha256(canonical_json_bytes(manifest)).hexdigest(),
        "sourceLockSha256": source_lock_sha256(lock),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("classify", "validate"))
    parser.add_argument(
        "--lock",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "model-sources"
        / "release-model-source-lock.json",
    )
    parser.add_argument("--output", type=Path)
    arguments = parser.parse_args()
    lock = load_source_lock(arguments.lock, require_approved=arguments.operation == "validate")
    if arguments.operation == "classify":
        content = canonical_json_bytes({"releaseMode": release_mode(lock)})
        if arguments.output is None:
            print(content.decode("utf-8"), end="")
        else:
            arguments.output.parent.mkdir(parents=True, exist_ok=True)
            arguments.output.write_bytes(content)
    elif arguments.output is not None:
        raise SystemExit("--output is supported only by classify")


if __name__ == "__main__":
    main()
