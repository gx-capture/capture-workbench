"""Environment-backed runtime settings with loopback-only invariants."""

from __future__ import annotations

import os
import secrets
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from capture_runtime.constants import CAPTURE_OLLAMA_BASE_MODEL, CAPTURE_OLLAMA_PROFILE_ID

_CHILD_PROCESS_ENVIRONMENT_ALLOWLIST = frozenset(
    {
        "APPDATA",
        "COMSPEC",
        "LOCALAPPDATA",
        "NUMBER_OF_PROCESSORS",
        "OS",
        "PATH",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
        "PROCESSOR_IDENTIFIER",
        "PROCESSOR_LEVEL",
        "PROCESSOR_REVISION",
        "PROGRAMDATA",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "WINDIR",
    }
)


def sanitized_child_environment(base: Mapping[str, str] | None = None) -> dict[str, str]:
    """Return only OS bootstrap variables safe for Capture-owned child processes."""

    source = os.environ if base is None else base
    return {
        key: value
        for key, value in source.items()
        if key.upper() in _CHILD_PROCESS_ENVIRONMENT_ALLOWLIST and value
    }


def _csv(value: str | None, default: tuple[str, ...]) -> tuple[str, ...]:
    if value is None:
        return default
    return tuple(item.strip() for item in value.split(",") if item.strip())


def _bool(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"invalid boolean value: {value!r}")


def _default_app_data(env: Mapping[str, str]) -> Path:
    local_app_data = env.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "CaptureWorkbench" / "runtime"
    return Path.cwd() / ".capture-workbench-runtime"


@dataclass(frozen=True, slots=True)
class OllamaRuntimeConfig:
    host_url: str
    app_data_dir: Path
    pid_file: Path
    models_dir: Path
    base_model: str = CAPTURE_OLLAMA_BASE_MODEL
    profile_id: str = CAPTURE_OLLAMA_PROFILE_ID

    @property
    def host_address(self) -> str:
        parsed = urlsplit(self.host_url)
        if parsed.hostname != "127.0.0.1" or parsed.port is None:
            raise ValueError("CAPTURE_OLLAMA_HOST must be an HTTP loopback URL with a port")
        return f"127.0.0.1:{parsed.port}"

    def process_environment(self, base: Mapping[str, str] | None = None) -> dict[str, str]:
        result = sanitized_child_environment(base)
        result.update(
            {
                "OLLAMA_HOST": self.host_address,
                "OLLAMA_MODELS": str(self.models_dir),
            }
        )
        return result


@dataclass(frozen=True, slots=True)
class ExternalOllamaConfig:
    """Configuration for an Ollama endpoint owned by the host environment."""

    endpoint_url: str
    model: str
    api_key: str | None = None


@dataclass(frozen=True, slots=True)
class ExtractionRuntimeConfig:
    windowsml_model_dir: Path
    whisper_models_dir: Path
    temp_dir: Path
    windowsml_device_id: int
    max_pdf_pages: int
    max_image_pixels: int
    ocr_render_scale: float
    max_audio_duration_ms: int
    whisper_primary_model: str
    whisper_fallback_model: str
    whisper_prefer_gpu: bool
    windowsml_bundle_url: str | None
    windowsml_bundle_sha256: str | None
    windowsml_bundle_bytes: int | None


def _external_ollama_endpoint(value: str) -> str:
    try:
        parsed = urlsplit(value)
    except ValueError as error:
        raise ValueError("CAPTURE_OLLAMA_ENDPOINT must be an absolute HTTP(S) URL") from error
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(
            "CAPTURE_OLLAMA_ENDPOINT must be an HTTP(S) URL without credentials, path, "
            "query, or fragment"
        )
    try:
        _ = parsed.port
    except ValueError as error:
        raise ValueError("CAPTURE_OLLAMA_ENDPOINT must use a valid port") from error
    return value.rstrip("/")


def _external_ollama_model(value: str) -> str:
    model = value.strip()
    if not model or len(model) > 255 or any(character in model for character in "\r\n"):
        raise ValueError("CAPTURE_OLLAMA_MODEL must contain 1 to 255 characters")
    return model


def _external_ollama_api_key(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    api_key = value.strip()
    if len(api_key) > 4096 or any(character in api_key for character in "\r\n"):
        raise ValueError("CAPTURE_OLLAMA_API_KEY must contain at most 4096 characters")
    return api_key


@dataclass(frozen=True, slots=True)
class RuntimeSettings:
    host: str
    port: int
    api_token: str
    allowed_hosts: tuple[str, ...]
    allowed_origins: tuple[str, ...]
    enable_api_docs: bool
    app_data_dir: Path
    retention_hours: int
    max_upload_bytes: int
    max_candidate_bytes: int
    extraction_provider: str
    structuring_provider: str
    extraction: ExtractionRuntimeConfig
    ollama: OllamaRuntimeConfig
    external_ollama: ExternalOllamaConfig | None

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> RuntimeSettings:
        env = dict(os.environ if environ is None else environ)
        app_data_dir = Path(env.get("CAPTURE_APP_DATA_DIR") or _default_app_data(env))
        ollama_app_data = Path(env.get("CAPTURE_OLLAMA_APP_DATA") or app_data_dir / "ollama")
        host = env.get("CAPTURE_HOST", "127.0.0.1")
        if host != "127.0.0.1":
            raise ValueError("Capture Runtime may only bind 127.0.0.1")
        port = int(env.get("CAPTURE_PORT", "8766"))
        if not 1 <= port <= 65535:
            raise ValueError("CAPTURE_PORT must be between 1 and 65535")
        token = env.get("CAPTURE_API_TOKEN") or secrets.token_urlsafe(48)
        if len(token) < 32:
            raise ValueError("CAPTURE_API_TOKEN must contain at least 32 characters")
        allowed_hosts = _csv(env.get("CAPTURE_ALLOWED_HOSTS"), (f"127.0.0.1:{port}",))
        if not allowed_hosts:
            raise ValueError("CAPTURE_ALLOWED_HOSTS must not be empty")
        for authority in allowed_hosts:
            parsed_authority = urlsplit(f"//{authority}")
            if (
                parsed_authority.username is not None
                or parsed_authority.password is not None
                or parsed_authority.hostname != "127.0.0.1"
                or parsed_authority.port != port
                or parsed_authority.path not in {"", "/"}
            ):
                raise ValueError(
                    "CAPTURE_ALLOWED_HOSTS must contain only the exact "
                    "127.0.0.1:<CAPTURE_PORT> authority"
                )
        allowed_origins = _csv(env.get("CAPTURE_ALLOWED_ORIGINS"), ())
        provider = env.get("CAPTURE_STRUCTURING_PROVIDER", "ollama").strip().lower()
        if provider not in {"ollama", "external-ollama", "fake", "host"}:
            raise ValueError(
                "CAPTURE_STRUCTURING_PROVIDER must be ollama, external-ollama, fake, or host"
            )
        extraction_provider = env.get("CAPTURE_EXTRACTION_PROVIDER", "runtime").strip().lower()
        if extraction_provider not in {"runtime", "fake"}:
            raise ValueError("CAPTURE_EXTRACTION_PROVIDER must be runtime or fake")
        profile_id = env.get("CAPTURE_OLLAMA_PROFILE_ID", CAPTURE_OLLAMA_PROFILE_ID)
        if profile_id != CAPTURE_OLLAMA_PROFILE_ID:
            raise ValueError(f"CAPTURE_OLLAMA_PROFILE_ID must be {CAPTURE_OLLAMA_PROFILE_ID}")
        retention_hours = int(env.get("CAPTURE_RETENTION_HOURS", "24"))
        if retention_hours <= 0:
            raise ValueError("CAPTURE_RETENTION_HOURS must be positive")
        max_upload_bytes = int(env.get("CAPTURE_MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))
        if max_upload_bytes <= 0:
            raise ValueError("CAPTURE_MAX_UPLOAD_BYTES must be positive")
        max_candidate_bytes = int(env.get("CAPTURE_MAX_CANDIDATE_BYTES", str(8 * 1024 * 1024)))
        if max_candidate_bytes <= 0:
            raise ValueError("CAPTURE_MAX_CANDIDATE_BYTES must be positive")
        windowsml_device_id = int(env.get("CAPTURE_WINDOWSML_DEVICE_ID", "0"))
        if windowsml_device_id < 0:
            raise ValueError("CAPTURE_WINDOWSML_DEVICE_ID must be non-negative")
        max_pdf_pages = int(env.get("CAPTURE_MAX_PDF_PAGES", "200"))
        max_image_pixels = int(env.get("CAPTURE_MAX_IMAGE_PIXELS", "50000000"))
        ocr_render_scale = float(env.get("CAPTURE_OCR_RENDER_SCALE", "2"))
        max_audio_duration_ms = int(env.get("CAPTURE_MAX_AUDIO_DURATION_MS", "5400000"))
        if max_pdf_pages <= 0 or max_image_pixels <= 0 or max_audio_duration_ms <= 0:
            raise ValueError("Capture extraction limits must be positive")
        if not 1 <= ocr_render_scale <= 4:
            raise ValueError("CAPTURE_OCR_RENDER_SCALE must be between 1 and 4")

        extraction = ExtractionRuntimeConfig(
            windowsml_model_dir=Path(
                env.get("CAPTURE_WINDOWSML_MODEL_DIR")
                or app_data_dir / "runtime-assets" / "windowsml-ocr" / "models"
            ),
            whisper_models_dir=Path(
                env.get("CAPTURE_WHISPER_MODELS_DIR") or app_data_dir / "runtime-assets" / "whisper"
            ),
            temp_dir=Path(env.get("CAPTURE_EXTRACTION_TEMP_DIR") or app_data_dir / "temp"),
            windowsml_device_id=windowsml_device_id,
            max_pdf_pages=max_pdf_pages,
            max_image_pixels=max_image_pixels,
            ocr_render_scale=ocr_render_scale,
            max_audio_duration_ms=max_audio_duration_ms,
            whisper_primary_model=env.get("CAPTURE_WHISPER_PRIMARY_MODEL", "large-v3-turbo"),
            whisper_fallback_model=env.get("CAPTURE_WHISPER_FALLBACK_MODEL", "small"),
            whisper_prefer_gpu=_bool(env.get("CAPTURE_WHISPER_PREFER_GPU"), True),
            windowsml_bundle_url=(env.get("CAPTURE_WINDOWSML_BUNDLE_URL", "").strip() or None),
            windowsml_bundle_sha256=(
                env.get("CAPTURE_WINDOWSML_BUNDLE_SHA256", "").strip().lower() or None
            ),
            windowsml_bundle_bytes=(
                int(env["CAPTURE_WINDOWSML_BUNDLE_BYTES"])
                if env.get("CAPTURE_WINDOWSML_BUNDLE_BYTES", "").strip()
                else None
            ),
        )
        configured_windowsml_descriptor_fields = (
            extraction.windowsml_bundle_url,
            extraction.windowsml_bundle_sha256,
            extraction.windowsml_bundle_bytes,
        )
        if any(value is None for value in configured_windowsml_descriptor_fields) and any(
            value is not None for value in configured_windowsml_descriptor_fields
        ):
            raise ValueError(
                "CAPTURE_WINDOWSML_BUNDLE_URL, CAPTURE_WINDOWSML_BUNDLE_SHA256, and "
                "CAPTURE_WINDOWSML_BUNDLE_BYTES must be configured together"
            )
        if extraction.windowsml_bundle_sha256 is not None and (
            len(extraction.windowsml_bundle_sha256) != 64
            or any(
                character not in "0123456789abcdef"
                for character in extraction.windowsml_bundle_sha256
            )
        ):
            raise ValueError("CAPTURE_WINDOWSML_BUNDLE_SHA256 must be 64 lowercase hex characters")
        if extraction.windowsml_bundle_bytes is not None and not (
            1 <= extraction.windowsml_bundle_bytes <= 512 * 1024 * 1024
        ):
            raise ValueError("CAPTURE_WINDOWSML_BUNDLE_BYTES must be between 1 and 536870912")
        if extraction.windowsml_bundle_url is not None:
            bundle_scheme = urlsplit(extraction.windowsml_bundle_url).scheme
            if bundle_scheme == "https":
                from capture_runtime.release import _canonical_public_https_artifact

                _canonical_public_https_artifact(extraction.windowsml_bundle_url)
            elif bundle_scheme != "file":
                raise ValueError(
                    "CAPTURE_WINDOWSML_BUNDLE_URL must be canonical public HTTPS "
                    "or the development-only file:// seam"
                )
        supported_whisper_models = {"large-v3-turbo", "small"}
        if {
            extraction.whisper_primary_model,
            extraction.whisper_fallback_model,
        } - supported_whisper_models:
            raise ValueError("Capture Whisper models must be large-v3-turbo or small in runtime v1")

        external_ollama = None
        if provider == "external-ollama":
            endpoint = env.get("CAPTURE_OLLAMA_ENDPOINT", "").strip()
            if not endpoint:
                raise ValueError("CAPTURE_OLLAMA_ENDPOINT is required when using external-ollama")
            external_ollama = ExternalOllamaConfig(
                endpoint_url=_external_ollama_endpoint(endpoint),
                model=_external_ollama_model(
                    env.get("CAPTURE_OLLAMA_MODEL", CAPTURE_OLLAMA_BASE_MODEL)
                ),
                api_key=_external_ollama_api_key(env.get("CAPTURE_OLLAMA_API_KEY")),
            )

        ollama_host = (
            "http://127.0.0.1:11439"
            if provider == "external-ollama"
            else env.get("CAPTURE_OLLAMA_HOST") or "http://127.0.0.1:11439"
        )
        parsed_ollama_host = urlsplit(ollama_host)
        if (
            parsed_ollama_host.scheme != "http"
            or parsed_ollama_host.hostname != "127.0.0.1"
            or parsed_ollama_host.port is None
            or parsed_ollama_host.path not in {"", "/"}
        ):
            raise ValueError("CAPTURE_OLLAMA_HOST must be http://127.0.0.1:<port>")

        ollama = OllamaRuntimeConfig(
            host_url=ollama_host.rstrip("/"),
            app_data_dir=ollama_app_data,
            pid_file=Path(
                env.get("CAPTURE_OLLAMA_PID_FILE") or ollama_app_data / "ollama.pid.json"
            ),
            models_dir=Path(env.get("CAPTURE_OLLAMA_MODELS_DIR") or ollama_app_data / "models"),
            base_model=env.get("CAPTURE_OLLAMA_MODEL", CAPTURE_OLLAMA_BASE_MODEL),
            profile_id=profile_id,
        )
        # Validate the derived child-process address now, before starting the server.
        _ = ollama.host_address
        return cls(
            host=host,
            port=port,
            api_token=token,
            allowed_hosts=allowed_hosts,
            allowed_origins=allowed_origins,
            enable_api_docs=_bool(env.get("CAPTURE_ENABLE_API_DOCS"), False),
            app_data_dir=app_data_dir,
            retention_hours=retention_hours,
            max_upload_bytes=max_upload_bytes,
            max_candidate_bytes=max_candidate_bytes,
            extraction_provider=extraction_provider,
            structuring_provider=provider,
            extraction=extraction,
            ollama=ollama,
            external_ollama=external_ollama,
        )
