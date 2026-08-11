"""Release-owned allowlist and persistence for selectable Ollama models."""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def _atomic_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


PROFILE_SYSTEM_PROMPT = (
    "Return only JSON matching the supplied schema. Preserve source provenance exactly."
)


@dataclass(frozen=True, slots=True)
class RuntimeModelOption:
    option_id: str
    display_name: str
    model_reference: str
    profile_id: str
    expected_digest: str | None = None
    expected_bytes: int | None = None

    @property
    def profile_spec_bytes(self) -> bytes:
        return (
            f"FROM {self.model_reference}\n"
            "PARAMETER temperature 0\n"
            f"SYSTEM {PROFILE_SYSTEM_PROMPT}\n"
        ).encode()

    @property
    def profile_spec_sha256(self) -> str:
        return hashlib.sha256(self.profile_spec_bytes).hexdigest()


MODEL_OPTIONS: tuple[RuntimeModelOption, ...] = (
    RuntimeModelOption(
        option_id="qwen3.5-0.8b-v1",
        display_name="Qwen 3.5 0.8B",
        model_reference="qwen3.5:0.8b",
        profile_id="capture-workbench-qwen3.5-0.8b-structure-v1",
    ),
    RuntimeModelOption(
        option_id="qwen3.5-2b-v1",
        display_name="Qwen 3.5 2B",
        model_reference="qwen3.5:2b",
        profile_id="capture-workbench-qwen3.5-2b-structure-v1",
    ),
    RuntimeModelOption(
        option_id="qwen3.5-4b-v1",
        display_name="Qwen 3.5 4B",
        model_reference="qwen3.5:4b",
        profile_id="capture-workbench-qwen3.5-4b-structure-v1",
    ),
)


def model_option(option_id: str) -> RuntimeModelOption:
    for option in MODEL_OPTIONS:
        if option.option_id == option_id:
            return option
    raise KeyError(option_id)


def catalog_sha256() -> str:
    payload = [
        {
            "optionId": option.option_id,
            "displayName": option.display_name,
            "modelReference": option.model_reference,
            "expectedDigest": option.expected_digest,
            "expectedBytes": option.expected_bytes,
            "profileId": option.profile_id,
            "profileSpecSha256": option.profile_spec_sha256,
        }
        for option in MODEL_OPTIONS
    ]
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode(
        "utf-8"
    )
    return hashlib.sha256(encoded).hexdigest()


class ActiveModelSelectionStore:
    """Persist the verified active selection in runtime-owned app data."""

    def __init__(self, app_data_dir: Path) -> None:
        self.path = app_data_dir / "requirements" / "capture-ollama-model.active.json"

    def load(self) -> dict[str, Any] | None:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict):
            return None
        option_id = payload.get("optionId")
        if not isinstance(option_id, str):
            return None
        try:
            option = model_option(option_id)
        except KeyError:
            return None
        if payload.get("catalogSha256") != catalog_sha256():
            return None
        if payload.get("modelReference") != option.model_reference:
            return None
        observed_digest = str(payload.get("observedModelDigest") or "").removeprefix("sha256:")
        observed_bytes = payload.get("observedModelBytes")
        if not re.fullmatch(r"[0-9a-f]{64}", observed_digest):
            return None
        if (
            not isinstance(observed_bytes, int)
            or isinstance(observed_bytes, bool)
            or observed_bytes <= 0
        ):
            return None
        if payload.get("profileId") != option.profile_id:
            return None
        if payload.get("profileSpecSha256") != option.profile_spec_sha256:
            return None
        return payload

    def save(
        self,
        option: RuntimeModelOption,
        *,
        observed_digest: str,
        observed_bytes: int,
    ) -> None:
        _atomic_json(
            self.path,
            {
                "catalogSha256": catalog_sha256(),
                "optionId": option.option_id,
                "modelReference": option.model_reference,
                "observedModelDigest": observed_digest,
                "observedModelBytes": observed_bytes,
                "profileId": option.profile_id,
                "profileSpecSha256": option.profile_spec_sha256,
            },
        )


def active_selection_path(app_data_dir: Path) -> Path:
    return ActiveModelSelectionStore(app_data_dir).path


__all__ = [
    "ActiveModelSelectionStore",
    "MODEL_OPTIONS",
    "PROFILE_SYSTEM_PROMPT",
    "RuntimeModelOption",
    "active_selection_path",
    "catalog_sha256",
    "model_option",
]
