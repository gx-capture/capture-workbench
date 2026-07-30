from __future__ import annotations

import argparse
import hashlib
import json
import unicodedata
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlsplit

LOCK_VERSION = "1"
RELEASE_VERSION = "0.3.3"
MAX_ENTRIES = 4096
MAX_SINGLE_FILE_BYTES = 512 * 1024 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
REQUIREMENT_IDS = ("whisper-primary", "windowsml-ocr")
CORE_ONLY_RELEASE_MODE = "core-only"
MODEL_ENABLED_RELEASE_MODE = "model-enabled"
HEX = frozenset("0123456789abcdef")
WINDOWS_FORBIDDEN_PATH_CHARACTERS = frozenset('<>:"|?*')
WINDOWS_RESERVED_DEVICE_BASENAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{index}" for index in range(1, 10)}
    | {f"LPT{index}" for index in range(1, 10)}
)


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


def _sha256(value: object, label: str) -> str:
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


def _derivation(value: object, label: str) -> None:
    payload = _exact(
        value,
        {"algorithm", "generator", "inputs", "sourceCommit", "toolVersions"},
        label,
    )
    _text(payload["algorithm"], f"{label}.algorithm")
    _text(payload["generator"], f"{label}.generator")
    commit = _text(payload["sourceCommit"], f"{label}.sourceCommit")
    if len(commit) != 40 or any(character not in HEX for character in commit):
        raise ModelSourceLockError(f"{label}.sourceCommit must be a full Git SHA")
    inputs = payload["inputs"]
    if not isinstance(inputs, list) or not inputs:
        raise ModelSourceLockError(f"{label}.inputs must be non-empty")
    for index, item in enumerate(inputs):
        _safe_path(item, f"{label}.inputs[{index}]")
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


def validate_source_lock(
    payload: object,
    *,
    require_approved: bool = True,
) -> dict[str, Any]:
    lock = _exact(
        payload,
        {
            "approval",
            "fixtures",
            "lockVersion",
            "releaseVersion",
            "requirements",
        },
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
    core_only = len(requirements) == 0
    if require_approved and not core_only and approval["status"] != "approved":
        raise ModelSourceLockError("model source lock is blocked: " + "; ".join(blockers))
    if (
        not core_only
        and approval["status"] == "approved"
        and len(requirements) != len(REQUIREMENT_IDS)
    ):
        raise ModelSourceLockError("approved source lock needs exact OCR and Whisper requirements")
    requirement_ids: list[str] = []
    for requirement_index, raw_requirement in enumerate(requirements):
        requirement = _exact(
            raw_requirement,
            {"artifactVersion", "entryPoint", "files", "requirementId"},
            f"requirement[{requirement_index}]",
        )
        requirement_id = _text(
            requirement["requirementId"], f"requirement[{requirement_index}].requirementId"
        )
        requirement_ids.append(requirement_id)
        if requirement_id not in REQUIREMENT_IDS:
            raise ModelSourceLockError(f"unknown model requirement: {requirement_id}")
        if requirement["artifactVersion"] != RELEASE_VERSION:
            raise ModelSourceLockError(f"{requirement_id} artifactVersion is unsynchronized")
        entry_point = _safe_path(requirement["entryPoint"], f"{requirement_id}.entryPoint")
        if entry_point != "model":
            raise ModelSourceLockError(f"{requirement_id} entryPoint must remain model")
        files = requirement["files"]
        if not isinstance(files, list) or not files or len(files) > MAX_ENTRIES:
            raise ModelSourceLockError(f"{requirement_id} files are missing or excessive")
        previous = ""
        folded: set[str] = set()
        total = 0
        license_paths: set[str] = set()
        notice_paths: set[str] = set()
        for file_index, raw_file in enumerate(files):
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
                f"{requirement_id}.files[{file_index}]",
            )
            path = _safe_path(item["path"], f"{requirement_id}.files[{file_index}].path")
            if path <= previous or path.casefold() in folded:
                raise ModelSourceLockError(
                    f"{requirement_id} file paths must be sorted and case-insensitively unique"
                )
            previous = path
            folded.add(path.casefold())
            kind = item["kind"]
            if kind not in {"derived", "license", "notice", "provenance", "source"}:
                raise ModelSourceLockError(f"{requirement_id} file kind is invalid")
            size = item["bytes"]
            if not isinstance(size, int) or isinstance(size, bool) or size < 1:
                raise ModelSourceLockError(f"{requirement_id} file bytes must be positive")
            if size > MAX_SINGLE_FILE_BYTES and not (
                kind in {"source", "derived"} and path.startswith("model/")
            ):
                raise ModelSourceLockError(
                    f"{requirement_id} file is not eligible for the large-model exception"
                )
            _sha256(item["sha256"], f"{requirement_id}.{path}.sha256")
            _text(item["owner"], f"{requirement_id}.{path}.owner")
            _text(item["spdx"], f"{requirement_id}.{path}.spdx")
            revision = _text(item["revision"], f"{requirement_id}.{path}.revision")
            if not 40 <= len(revision) <= 64 or any(character not in HEX for character in revision):
                raise ModelSourceLockError(
                    f"{requirement_id}.{path}.revision must be an immutable hex ID"
                )
            url, initial_host = _https_url(item["url"], f"{requirement_id}.{path}.url")
            if revision not in url:
                raise ModelSourceLockError(
                    f"{requirement_id}.{path}.url must contain its immutable revision"
                )
            redirect_hosts = item["redirectHosts"]
            if (
                not isinstance(redirect_hosts, list)
                or redirect_hosts != sorted(set(redirect_hosts))
                or any(
                    not isinstance(host, str)
                    or not host
                    or host != host.lower()
                    or "@" in host
                    or "/" in host
                    for host in redirect_hosts
                )
                or initial_host in redirect_hosts
            ):
                raise ModelSourceLockError(
                    f"{requirement_id}.{path}.redirectHosts must be sorted unique extra hosts"
                )
            if kind == "derived":
                _derivation(item["derivation"], f"{requirement_id}.{path}.derivation")
            elif item["derivation"] is not None:
                raise ModelSourceLockError("only derived entries may define derivation metadata")
            if kind in {"license", "notice"}:
                if item["licensePath"] is not None or item["noticePath"] is not None:
                    raise ModelSourceLockError("license/NOTICE entries cannot reference themselves")
                if kind == "license":
                    license_paths.add(path)
                else:
                    notice_paths.add(path)
            else:
                _safe_path(item["licensePath"], f"{requirement_id}.{path}.licensePath")
                _safe_path(item["noticePath"], f"{requirement_id}.{path}.noticePath")
            total += size
            if total > MAX_TOTAL_BYTES:
                raise ModelSourceLockError(
                    f"{requirement_id} exceeds the aggregate 2 GiB model limit"
                )
        if not license_paths or not notice_paths:
            raise ModelSourceLockError(f"{requirement_id} must pin license and NOTICE files")
        known_paths = {item["path"] for item in files}
        for item in files:
            if item["kind"] not in {"license", "notice"} and (
                item["licensePath"] not in license_paths or item["noticePath"] not in notice_paths
            ):
                raise ModelSourceLockError(
                    f"{requirement_id} entries must reference pinned license and NOTICE files"
                )
            if item["kind"] == "derived" and any(
                source not in known_paths for source in item["derivation"]["inputs"]
            ):
                raise ModelSourceLockError(
                    f"{requirement_id} derived inputs must reference locked files"
                )
        if requirement_id == "windowsml-ocr":
            pipeline = [item for item in files if item["path"] == "model/pipeline.json"]
            if len(pipeline) != 1 or pipeline[0]["kind"] != "derived":
                raise ModelSourceLockError("OCR pipeline.json must be first-party derived")
    if requirement_ids != sorted(requirement_ids) or len(set(requirement_ids)) != len(
        requirement_ids
    ):
        raise ModelSourceLockError("requirements must be sorted and unique")

    fixtures = lock["fixtures"]
    if not isinstance(fixtures, list):
        raise ModelSourceLockError("fixtures must be a list")
    if not core_only and approval["status"] == "approved" and len(fixtures) != 2:
        raise ModelSourceLockError("approved source lock needs real OCR and Whisper fixtures")
    fixture_ids: list[str] = []
    fixture_kinds: list[str] = []
    for index, raw_fixture in enumerate(fixtures):
        fixture = _exact(
            raw_fixture,
            {
                "bytes",
                "expectedDevice",
                "expectedEngine",
                "expectedModel",
                "expectedText",
                "id",
                "kind",
                "licenseBytes",
                "licenseSha256",
                "licenseUrl",
                "mediaType",
                "owner",
                "preferGpu",
                "redistributable",
                "revision",
                "sha256",
                "spdx",
                "url",
            },
            f"fixture[{index}]",
        )
        fixture_ids.append(_text(fixture["id"], f"fixture[{index}].id"))
        if fixture["kind"] not in {"ocr", "whisper"}:
            raise ModelSourceLockError(f"fixture[{index}].kind is invalid")
        fixture_kinds.append(fixture["kind"])
        expected_engine = _text(fixture["expectedEngine"], f"fixture[{index}].expectedEngine")
        expected_model = _text(fixture["expectedModel"], f"fixture[{index}].expectedModel")
        expected_device = _text(fixture["expectedDevice"], f"fixture[{index}].expectedDevice")
        expected_text = _text(fixture["expectedText"], f"fixture[{index}].expectedText")
        if expected_text != " ".join(expected_text.split()) or len(expected_text) > 4_000:
            raise ModelSourceLockError(
                f"fixture[{index}].expectedText must be normalized and bounded"
            )
        prefer_gpu = fixture["preferGpu"]
        if fixture["kind"] == "ocr":
            if (
                expected_engine != "windowsml-ocr"
                or expected_model != "pp-ocrv6-medium-windowsml"
                or expected_device != "windowsml-dml"
                or prefer_gpu is not None
            ):
                raise ModelSourceLockError(
                    "OCR fixture must require the exact WindowsML DirectML provenance"
                )
        elif (
            expected_engine != "whisper-primary"
            or not isinstance(prefer_gpu, bool)
            or (prefer_gpu is False and (expected_model != "fallback" or expected_device != "cpu"))
            or (prefer_gpu is True and (expected_model != "primary" or expected_device != "cuda"))
        ):
            raise ModelSourceLockError(
                "Whisper fixture must pin an approved primary/fallback execution path"
            )
        if fixture["redistributable"] is not True:
            raise ModelSourceLockError(f"fixture[{index}] is not redistributable")
        if (
            not isinstance(fixture["bytes"], int)
            or isinstance(fixture["bytes"], bool)
            or fixture["bytes"] < 1
        ):
            raise ModelSourceLockError(f"fixture[{index}].bytes must be positive")
        _sha256(fixture["sha256"], f"fixture[{index}].sha256")
        if (
            not isinstance(fixture["licenseBytes"], int)
            or isinstance(fixture["licenseBytes"], bool)
            or not 1 <= fixture["licenseBytes"] <= 1024 * 1024
        ):
            raise ModelSourceLockError(
                f"fixture[{index}].licenseBytes must be from 1 byte through 1 MiB"
            )
        _sha256(fixture["licenseSha256"], f"fixture[{index}].licenseSha256")
        fixture_url, _fixture_host = _https_url(fixture["url"], f"fixture[{index}].url")
        license_url, _license_host = _https_url(
            fixture["licenseUrl"], f"fixture[{index}].licenseUrl"
        )
        _text(fixture["owner"], f"fixture[{index}].owner")
        media_type = _text(fixture["mediaType"], f"fixture[{index}].mediaType")
        if (
            fixture["kind"] == "ocr" and media_type not in {"image/jpeg", "image/png", "image/webp"}
        ) or (fixture["kind"] == "whisper" and not media_type.startswith("audio/")):
            raise ModelSourceLockError(f"fixture[{index}].mediaType is incompatible")
        fixture_revision = _text(fixture["revision"], f"fixture[{index}].revision")
        if not 40 <= len(fixture_revision) <= 64 or any(
            character not in HEX for character in fixture_revision
        ):
            raise ModelSourceLockError(f"fixture[{index}].revision must be an immutable hex ID")
        if fixture_revision not in fixture_url or fixture_revision not in license_url:
            raise ModelSourceLockError(f"fixture[{index}] URLs must contain the immutable revision")
        _text(fixture["spdx"], f"fixture[{index}].spdx")
    if (
        not core_only
        and approval["status"] == "approved"
        and sorted(fixture_kinds) != ["ocr", "whisper"]
    ):
        raise ModelSourceLockError("fixture kinds must be exactly OCR and Whisper")
    if fixture_ids != sorted(fixture_ids) or len(set(fixture_ids)) != len(fixture_ids):
        raise ModelSourceLockError("fixture IDs must be sorted and unique")
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
    lock = load_source_lock(arguments.lock)
    if arguments.operation == "classify":
        payload = {"releaseMode": release_mode(lock)}
        content = canonical_json_bytes(payload)
        if arguments.output is None:
            print(content.decode("utf-8"), end="")
        else:
            arguments.output.parent.mkdir(parents=True, exist_ok=True)
            arguments.output.write_bytes(content)
    elif arguments.output is not None:
        raise SystemExit("--output is supported only by classify")


if __name__ == "__main__":
    main()
