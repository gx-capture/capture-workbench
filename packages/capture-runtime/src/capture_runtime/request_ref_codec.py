"""Private, strict codec for producer RequestRef start metadata.

The codec owns only the bytes-to-value boundary for the producer's closed
start metadata.  It does not generate references, inspect source bytes, or
participate in transport, storage, or capture lifecycle behavior.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from dataclasses import dataclass
from typing import Final, Literal, NoReturn, cast

from capture_runtime.contracts import CaptureSourceKind, StructuringMode

MAX_METADATA_BYTES: Final = 64 * 1024
MAX_FILE_NAME_LENGTH: Final = 255
MAX_TARGET_LANGUAGE_LENGTH: Final = 64
MAX_PDF_PAGE_NUMBERS: Final = 500
_MAX_SAFE_JSON_INTEGER: Final = 2**53 - 1
_MAX_JSON_INTEGER_DIGITS: Final = len(str(_MAX_SAFE_JSON_INTEGER))

_METADATA_KEYS: Final = frozenset(
    {
        "protocolVersion",
        "sourceKind",
        "fileName",
        "mediaType",
        "totalBytes",
        "sourceSha256",
        "pdfPageNumbers",
        "structuringMode",
        "targetLanguage",
        "startPolicy",
    }
)
_MEDIA_TYPES: Final = frozenset(
    {
        "application/pdf",
        "image/jpeg",
        "image/png",
        "image/webp",
    }
)
_SOURCE_KIND_BY_VALUE: Final = {
    CaptureSourceKind.PDF.value: CaptureSourceKind.PDF,
    CaptureSourceKind.IMAGE.value: CaptureSourceKind.IMAGE,
}
_STRUCTURING_MODE_BY_VALUE: Final = {
    StructuringMode.RUNTIME.value: StructuringMode.RUNTIME,
    StructuringMode.HOST.value: StructuringMode.HOST,
}
_REQUEST_REF_PATTERN: Final = re.compile(r"rr1_[0-9a-f]{64}\Z")
_SHA256_PATTERN: Final = re.compile(r"[0-9a-f]{64}\Z")
_PRODUCER_DIGEST_PATTERN: Final = re.compile(r"sha256:[0-9a-f]{64}\Z")

_ERROR_MESSAGES: Final = {
    "metadata_type": "Request metadata bytes are invalid.",
    "metadata_too_large": "Request metadata exceeds the size limit.",
    "metadata_bom": "Request metadata must not contain a UTF-8 BOM.",
    "metadata_not_utf8": "Request metadata is not valid UTF-8.",
    "metadata_invalid_json": "Request metadata is not valid JSON.",
    "metadata_nonfinite_number": "Request metadata contains a non-finite number.",
    "metadata_root": "Request metadata must be a JSON object.",
    "metadata_duplicate_key": "Request metadata contains duplicate object keys.",
    "metadata_integer_range": "Request metadata contains an out-of-range integer.",
    "metadata_missing_fields": "Request metadata is missing required fields.",
    "metadata_unknown_fields": "Request metadata contains unknown fields.",
    "protocol_version": "Request metadata protocol version is invalid.",
    "source_kind": "Request metadata source kind is invalid.",
    "file_name": "Request metadata file name is invalid.",
    "media_type": "Request metadata media type is invalid.",
    "total_bytes": "Request metadata byte count is invalid.",
    "total_bytes_limit": "Request metadata byte count exceeds the supplied limit.",
    "source_sha256": "Request metadata source digest is invalid.",
    "pdf_page_numbers": "Request metadata PDF page selection is invalid.",
    "structuring_mode": "Request metadata structuring mode is invalid.",
    "target_language": "Request metadata target language is invalid.",
    "start_policy": "Request metadata start policy is invalid.",
    "metadata_unicode": "Request metadata contains invalid Unicode.",
    "metadata_not_canonical": "Request metadata is not canonical JSON.",
    "producer_digest": "Producer request digest is invalid.",
    "producer_digest_mismatch": "Producer request digest does not match metadata.",
    "request_ref": "Request reference is invalid.",
}


class RequestRefCodecError(ValueError):
    """A stable, sanitized rejection from the private metadata codec."""

    __slots__ = ("code",)

    code: str

    def __init__(self, code: str) -> None:
        message = _ERROR_MESSAGES.get(code)
        if message is None:
            raise ValueError("unknown request metadata error code")
        self.code = code
        super().__init__(message)


class _ParserRejection(Exception):
    __slots__ = ("code",)

    code: str

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__()


@dataclass(frozen=True, slots=True)
class _JsonParseResult:
    value: object | None
    error_code: str | None


@dataclass(frozen=True, slots=True, repr=False)
class StartCaptureByRequestRefMetadata:
    """Immutable typed form of the producer's ten-field start metadata."""

    protocol_version: Literal["2"]
    source_kind: CaptureSourceKind
    file_name: str
    media_type: str
    total_bytes: int
    source_sha256: str
    pdf_page_numbers: tuple[int, ...] | None
    structuring_mode: StructuringMode
    target_language: str | None
    start_policy: Literal["eager"]

    def __repr__(self) -> str:
        return "<StartCaptureByRequestRefMetadata redacted>"


@dataclass(frozen=True, slots=True, repr=False)
class DecodedRequestMetadata:
    """Validated metadata and the exact bytes used for its producer digest."""

    metadata: StartCaptureByRequestRefMetadata
    canonical_bytes: bytes
    producer_request_digest: str

    def __repr__(self) -> str:
        return "<DecodedRequestMetadata redacted>"


def validate_request_ref(value: object) -> str:
    """Validate the opaque producer reference syntax without assessing entropy."""

    if type(value) is not str or _REQUEST_REF_PATTERN.fullmatch(value) is None:
        _fail("request_ref")
    return value


def decode_request_metadata(
    metadata_bytes: object,
    *,
    max_total_bytes: int,
    expected_producer_request_digest: str,
) -> DecodedRequestMetadata:
    """Decode and validate canonical producer start metadata bytes.

    ``max_total_bytes`` is deliberately required from the caller.  The codec
    has no ambient configuration or default source-size policy.
    """

    if type(max_total_bytes) is not int or max_total_bytes <= 0:
        _fail("total_bytes_limit")
    raw = _require_metadata_bytes(metadata_bytes)
    if len(raw) > MAX_METADATA_BYTES:
        _fail("metadata_too_large")
    if raw.startswith(b"\xef\xbb\xbf"):
        _fail("metadata_bom")
    text = _decode_utf8(raw)
    if text is None:
        _fail("metadata_not_utf8")
    if text.startswith("\ufeff"):
        _fail("metadata_bom")

    parsed_result = _parse_json(text)
    if parsed_result.error_code is not None:
        _fail(parsed_result.error_code)
    parsed = parsed_result.value
    if type(parsed) is not dict:
        _fail("metadata_root")
    metadata = cast(dict[str, object], parsed)
    _validate_metadata_keys(metadata)
    typed = _validate_metadata(metadata, max_total_bytes=max_total_bytes)
    canonical_mapping = _canonical_mapping(typed)
    canonical_bytes = _canonical_bytes(canonical_mapping)
    if canonical_bytes is None:
        _fail("metadata_unicode")
    if raw != canonical_bytes:
        _fail("metadata_not_canonical")

    producer_request_digest = "sha256:" + hashlib.sha256(canonical_bytes).hexdigest()
    _validate_producer_digest(expected_producer_request_digest)
    if not hmac.compare_digest(producer_request_digest, expected_producer_request_digest):
        _fail("producer_digest_mismatch")
    return DecodedRequestMetadata(typed, canonical_bytes, producer_request_digest)


def _require_metadata_bytes(value: object) -> bytes:
    if type(value) is not bytes:
        _fail("metadata_type")
    return value


def _decode_utf8(raw: bytes) -> str | None:
    try:
        return raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return None


def _parse_json(text: str) -> _JsonParseResult:
    try:
        value = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_int=_parse_integer,
            parse_constant=_reject_nonfinite_number,
        )
    except _ParserRejection as rejection:
        return _JsonParseResult(None, rejection.code)
    except (json.JSONDecodeError, RecursionError, ValueError):
        return _JsonParseResult(None, "metadata_invalid_json")
    return _JsonParseResult(value, None)


def _parse_integer(value: str) -> int:
    digits = value[1:] if value.startswith("-") else value
    if len(digits) > _MAX_JSON_INTEGER_DIGITS:
        raise _ParserRejection("metadata_integer_range")
    parsed = int(value)
    if not -_MAX_SAFE_JSON_INTEGER <= parsed <= _MAX_SAFE_JSON_INTEGER:
        raise _ParserRejection("metadata_integer_range")
    return parsed


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _ParserRejection("metadata_duplicate_key")
        result[key] = value
    return result


def _reject_nonfinite_number(value: str) -> NoReturn:
    del value
    raise _ParserRejection("metadata_nonfinite_number")


def _validate_metadata_keys(metadata: dict[str, object]) -> None:
    keys = frozenset(metadata)
    if not _METADATA_KEYS.issubset(keys):
        _fail("metadata_missing_fields")
    if not keys.issubset(_METADATA_KEYS):
        _fail("metadata_unknown_fields")


def _validate_metadata(
    metadata: dict[str, object], *, max_total_bytes: int
) -> StartCaptureByRequestRefMetadata:
    protocol_version = metadata["protocolVersion"]
    if protocol_version != "2" or type(protocol_version) is not str:
        _fail("protocol_version")

    source_kind_value = metadata["sourceKind"]
    if type(source_kind_value) is not str:
        _fail("source_kind")
    source_kind = _SOURCE_KIND_BY_VALUE.get(source_kind_value)
    if source_kind is None:
        _fail("source_kind")

    file_name = _bounded_text(metadata["fileName"], maximum=MAX_FILE_NAME_LENGTH, code="file_name")
    if "/" in file_name or "\\" in file_name or file_name in {".", ".."}:
        _fail("file_name")

    media_type = metadata["mediaType"]
    if type(media_type) is not str or media_type not in _MEDIA_TYPES:
        _fail("media_type")
    if source_kind is CaptureSourceKind.PDF and media_type != "application/pdf":
        _fail("media_type")
    if source_kind is CaptureSourceKind.IMAGE and not media_type.startswith("image/"):
        _fail("media_type")

    total_bytes = metadata["totalBytes"]
    if type(total_bytes) is not int or total_bytes <= 0:
        _fail("total_bytes")
    if total_bytes > max_total_bytes:
        _fail("total_bytes_limit")
    source_sha256 = metadata["sourceSha256"]
    if type(source_sha256) is not str or _SHA256_PATTERN.fullmatch(source_sha256) is None:
        _fail("source_sha256")
    pages_value = metadata["pdfPageNumbers"]
    pdf_page_numbers = _pdf_page_numbers(pages_value)
    if source_kind is CaptureSourceKind.PDF:
        if pdf_page_numbers is None:
            _fail("pdf_page_numbers")
    elif pdf_page_numbers is not None:
        _fail("pdf_page_numbers")

    structuring_mode_value = metadata["structuringMode"]
    if type(structuring_mode_value) is not str:
        _fail("structuring_mode")
    structuring_mode = _STRUCTURING_MODE_BY_VALUE.get(structuring_mode_value)
    if structuring_mode is None:
        _fail("structuring_mode")

    target_language_value = metadata["targetLanguage"]
    if target_language_value is None:
        target_language = None
    else:
        target_language = _bounded_text(
            target_language_value,
            maximum=MAX_TARGET_LANGUAGE_LENGTH,
            code="target_language",
        )

    start_policy = metadata["startPolicy"]
    if start_policy != "eager" or type(start_policy) is not str:
        _fail("start_policy")

    return StartCaptureByRequestRefMetadata(
        protocol_version=protocol_version,
        source_kind=source_kind,
        file_name=file_name,
        media_type=media_type,
        total_bytes=total_bytes,
        source_sha256=source_sha256,
        pdf_page_numbers=pdf_page_numbers,
        structuring_mode=structuring_mode,
        target_language=target_language,
        start_policy=start_policy,
    )


def _bounded_text(value: object, *, maximum: int, code: str) -> str:
    if type(value) is not str:
        _fail(code)
    text = value
    if not 1 <= len(text) <= maximum or text != text.strip():
        _fail(code)
    if any(
        ord(character) < 0x20 or ord(character) == 0x7F or 0xD800 <= ord(character) <= 0xDFFF
        for character in text
    ):
        _fail(code)
    return text


def _pdf_page_numbers(value: object) -> tuple[int, ...] | None:
    if value is None:
        return None
    if type(value) is not list or not 1 <= len(value) <= MAX_PDF_PAGE_NUMBERS:
        _fail("pdf_page_numbers")
    values = cast(list[object], value)
    if any(type(page) is not int or page < 1 for page in values):
        _fail("pdf_page_numbers")
    pages = tuple(cast(int, page) for page in values)
    if pages != tuple(range(1, len(pages) + 1)):
        _fail("pdf_page_numbers")
    return pages


def _canonical_mapping(metadata: StartCaptureByRequestRefMetadata) -> dict[str, object]:
    return {
        "protocolVersion": metadata.protocol_version,
        "sourceKind": metadata.source_kind.value,
        "fileName": metadata.file_name,
        "mediaType": metadata.media_type,
        "totalBytes": metadata.total_bytes,
        "sourceSha256": metadata.source_sha256,
        "pdfPageNumbers": (
            None if metadata.pdf_page_numbers is None else list(metadata.pdf_page_numbers)
        ),
        "structuringMode": metadata.structuring_mode.value,
        "targetLanguage": metadata.target_language,
        "startPolicy": metadata.start_policy,
    }


def _canonical_bytes(value: object) -> bytes | None:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (UnicodeEncodeError, ValueError):
        return None


def _validate_producer_digest(value: object) -> str:
    if type(value) is not str or _PRODUCER_DIGEST_PATTERN.fullmatch(value) is None:
        _fail("producer_digest")
    return value


def _fail(code: str) -> NoReturn:
    raise RequestRefCodecError(code)


__all__ = [
    "MAX_FILE_NAME_LENGTH",
    "MAX_METADATA_BYTES",
    "MAX_PDF_PAGE_NUMBERS",
    "MAX_TARGET_LANGUAGE_LENGTH",
    "DecodedRequestMetadata",
    "RequestRefCodecError",
    "StartCaptureByRequestRefMetadata",
    "decode_request_metadata",
    "validate_request_ref",
]
