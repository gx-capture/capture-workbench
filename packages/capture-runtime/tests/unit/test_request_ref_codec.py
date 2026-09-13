from __future__ import annotations

import hashlib
import json
import sys
import traceback
from dataclasses import FrozenInstanceError
from typing import cast

import pytest

from capture_runtime.contracts import CaptureSourceKind, StructuringMode
from capture_runtime.request_ref_codec import (
    DecodedRequestMetadata,
    RequestRefCodecError,
    decode_request_metadata,
    validate_request_ref,
)

GOLDEN_DIGEST = "sha256:09e72d163518cc548cd48fe579e2dc0f689623c8d6f6ffdd79e95671a3df5679"
GOLDEN_METADATA: dict[str, object] = {
    "protocolVersion": "2",
    "sourceKind": "pdf",
    "fileName": "scanned-evidence.pdf",
    "mediaType": "application/pdf",
    "totalBytes": 4096,
    "sourceSha256": "e" * 64,
    "pdfPageNumbers": [1],
    "structuringMode": "runtime",
    "targetLanguage": None,
    "startPolicy": "eager",
}

LAW_GOLDEN_ENVELOPE: dict[str, object] = {
    "schema": "OcrProjectionRequestV1",
    "lawRequestDigest": "sha256:8a35ab69804633e3fd5a2ef966ea991171d76151204a293a4e582cd70f32173e",
    "idempotencyKey": "sha256:" + "c" * 64,
    "evidenceIdentityDigest": "sha256:" + "d" * 64,
    "startMetadata": GOLDEN_METADATA,
    "pageScope": {
        "sourcePageCount": 1,
        "requestedPageNumbers": [1],
    },
    "sourceStream": {
        "mode": "readonly_one_shot",
        "totalBytes": 4096,
        "sourceSha256": "e" * 64,
    },
}


def _canonical(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _metadata(**changes: object) -> dict[str, object]:
    return {**GOLDEN_METADATA, **changes}


def _law_request_digest(envelope: dict[str, object]) -> str:
    digest_input = {
        "startMetadata": envelope["startMetadata"],
        "pageScope": envelope["pageScope"],
    }
    return "sha256:" + hashlib.sha256(_canonical(digest_input)).hexdigest()


def _decode(value: dict[str, object] | bytes, **kwargs: object) -> DecodedRequestMetadata:
    payload = value if isinstance(value, bytes) else _canonical(value)
    expected = kwargs.pop(
        "expected_producer_request_digest",
        "sha256:" + hashlib.sha256(payload).hexdigest(),
    )
    return decode_request_metadata(
        payload,
        max_total_bytes=kwargs.pop("max_total_bytes", 1_000_000),
        expected_producer_request_digest=expected,  # type: ignore[arg-type]
        **kwargs,
    )  # type: ignore[arg-type]


def _raises(code: str, value: object, **kwargs: object) -> RequestRefCodecError:
    with pytest.raises(RequestRefCodecError) as raised:
        _decode(value if isinstance(value, bytes) else value, **kwargs)
    assert raised.value.code == code
    return raised.value


def test_law_golden_metadata_has_exact_producer_digest() -> None:
    decoded = _decode(
        GOLDEN_METADATA,
        expected_producer_request_digest=GOLDEN_DIGEST,
    )

    assert decoded.producer_request_digest == GOLDEN_DIGEST
    assert decoded.canonical_bytes == _canonical(GOLDEN_METADATA)
    assert decoded.metadata.source_kind is CaptureSourceKind.PDF
    assert decoded.metadata.structuring_mode is StructuringMode.RUNTIME
    assert decoded.metadata.pdf_page_numbers == (1,)
    assert hashlib.sha256(decoded.canonical_bytes).hexdigest() == GOLDEN_DIGEST.removeprefix(
        "sha256:"
    )


def test_digest_is_metadata_only_and_changes_when_metadata_changes() -> None:
    original = _decode(GOLDEN_METADATA)
    changed = _decode(_metadata(totalBytes=4097))

    assert changed.producer_request_digest != original.producer_request_digest
    assert changed.canonical_bytes != original.canonical_bytes

    law_changed = {
        **LAW_GOLDEN_ENVELOPE,
        "pageScope": {
            "sourcePageCount": 2,
            "requestedPageNumbers": [1],
        },
    }
    law_changed["lawRequestDigest"] = _law_request_digest(law_changed)
    assert _law_request_digest(LAW_GOLDEN_ENVELOPE) == LAW_GOLDEN_ENVELOPE["lawRequestDigest"]
    assert _law_request_digest(law_changed) != _law_request_digest(LAW_GOLDEN_ENVELOPE)
    assert law_changed["lawRequestDigest"] != LAW_GOLDEN_ENVELOPE["lawRequestDigest"]

    original_producer = _decode(
        cast(dict[str, object], LAW_GOLDEN_ENVELOPE["startMetadata"]),
        expected_producer_request_digest=GOLDEN_DIGEST,
    )
    changed_producer = _decode(
        cast(dict[str, object], law_changed["startMetadata"]),
        expected_producer_request_digest=GOLDEN_DIGEST,
    )
    assert original_producer.producer_request_digest == changed_producer.producer_request_digest
    assert original_producer.canonical_bytes == changed_producer.canonical_bytes

    with pytest.raises(RequestRefCodecError) as extra:
        _decode(_metadata(pageScope={"sourcePageCount": 1}))
    assert extra.value.code == "metadata_unknown_fields"


def test_cjk_and_image_metadata_preserve_unicode_and_explicit_null() -> None:
    cjk = _metadata(
        sourceKind="image",
        fileName="証拠画像.png",
        mediaType="image/png",
        pdfPageNumbers=None,
        targetLanguage="zh-TW",
    )

    decoded = _decode(cjk)

    assert "証拠画像.png".encode() in decoded.canonical_bytes
    assert b"\\u8a3c" not in decoded.canonical_bytes
    assert decoded.metadata.pdf_page_numbers is None
    assert decoded.metadata.target_language == "zh-TW"


def test_c1_controls_are_preserved_without_normalization() -> None:
    file_name = "evidence-" + chr(0x80) + chr(0x9F) + ".png"

    decoded = _decode(_metadata(fileName=file_name))

    assert file_name.encode("utf-8") in decoded.canonical_bytes
    assert decoded.metadata.file_name == file_name


def test_result_is_frozen_and_repr_is_redacted() -> None:
    decoded = _decode(GOLDEN_METADATA)

    assert isinstance(decoded, DecodedRequestMetadata)
    assert isinstance(decoded.canonical_bytes, bytes)
    assert isinstance(decoded.metadata.pdf_page_numbers, tuple)
    with pytest.raises(FrozenInstanceError):
        decoded.metadata.file_name = "changed.pdf"  # type: ignore[misc]
    with pytest.raises(FrozenInstanceError):
        decoded.canonical_bytes = b"changed"  # type: ignore[misc]
    rendered = repr(decoded) + repr(decoded.metadata)
    assert "scanned-evidence.pdf" not in rendered
    assert "eeee" not in rendered
    assert GOLDEN_DIGEST not in rendered


@pytest.mark.parametrize(
    "value",
    [
        "rr1_" + "a" * 64,
        "rr1_" + "0" * 64,
    ],
)
def test_request_ref_syntax_accepts_only_opaque_lowercase_hex(value: str) -> None:
    assert validate_request_ref(value) == value


@pytest.mark.parametrize(
    "value",
    [
        "rr1_" + "A" * 64,
        "rr1_" + "a" * 63,
        "rr1_" + "a" * 65,
        "rr2_" + "a" * 64,
        "rr1_" + "g" * 64,
        "rr1_" + "a" * 64 + "\n",
        "sha256:" + "a" * 64,
        None,
    ],
)
def test_request_ref_syntax_rejects_invalid_values(value: object) -> None:
    with pytest.raises(RequestRefCodecError) as raised:
        validate_request_ref(value)
    assert raised.value.code == "request_ref"


@pytest.mark.parametrize(
    "change, code",
    [
        ({"missing": True}, "metadata_unknown_fields"),
        ({"requestRef": "rr1_" + "a" * 64}, "metadata_unknown_fields"),
        ({"requestDigest": "sha256:" + "f" * 64}, "metadata_unknown_fields"),
        ({"pageScope": {"sourcePageCount": 1}}, "metadata_unknown_fields"),
    ],
)
def test_closed_metadata_rejects_unknown_fields(change: dict[str, object], code: str) -> None:
    value = _metadata(**change)
    error = _raises(code, value)
    assert "missing" not in str(error)
    assert "rr1_" not in str(error)


def test_closed_metadata_rejects_missing_and_snake_case_fields() -> None:
    missing = dict(GOLDEN_METADATA)
    del missing["targetLanguage"]
    _raises("metadata_missing_fields", missing)

    snake_case = _metadata(target_language=None)
    _raises("metadata_unknown_fields", snake_case)


@pytest.mark.parametrize(
    "payload, code",
    [
        (b'{"protocolVersion":"2", "sourceKind":"pdf"}', "metadata_missing_fields"),
        (b"\xef\xbb\xbf" + _canonical(GOLDEN_METADATA), "metadata_bom"),
        (_canonical(GOLDEN_METADATA) + b"\n", "metadata_not_canonical"),
        (b" {" + _canonical(GOLDEN_METADATA)[1:], "metadata_not_canonical"),
        (
            _canonical(GOLDEN_METADATA).replace(
                b"scanned-evidence.pdf", b"scanned-\\u0065vidence.pdf"
            ),
            "metadata_not_canonical",
        ),
        (
            b'{"sourceKind":"pdf","fileName":"scanned-evidence.pdf","mediaType":"application/pdf","totalBytes":4096,"sourceSha256":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","pdfPageNumbers":[1],"protocolVersion":"2","startPolicy":"eager","structuringMode":"runtime","targetLanguage":null}',
            "metadata_not_canonical",
        ),
        (b'{"fileName":"scanned-evidence.pdf"', "metadata_invalid_json"),
        (b"\xff", "metadata_not_utf8"),
        (b"null", "metadata_root"),
    ],
)
def test_bytes_boundary_rejects_malformed_or_noncanonical_input(payload: bytes, code: str) -> None:
    _raises(code, payload)


@pytest.mark.parametrize(
    "payload, code, secret",
    [
        (b'{"fileName":"SECRET-MALFORMED-JSON"', "metadata_invalid_json", "SECRET-MALFORMED-JSON"),
        (b'{"fileName":"SECRET-UTF8-DETAIL"\xff}', "metadata_not_utf8", "SECRET-UTF8-DETAIL"),
        (
            _canonical(_metadata(sourceKind="SECRET-SOURCE-KIND-DETAIL")),
            "source_kind",
            "SECRET-SOURCE-KIND-DETAIL",
        ),
        (
            _canonical(_metadata(structuringMode="SECRET-STRUCTURING-MODE-DETAIL")),
            "structuring_mode",
            "SECRET-STRUCTURING-MODE-DETAIL",
        ),
        (
            b"[" * 5000 + b'"SECRET-DEEPNEST-DETAIL"' + b"]" * 5000,
            "metadata_invalid_json",
            "SECRET-DEEPNEST-DETAIL",
        ),
        (
            b'{"SECRET-LARGE-INTEGER":' + b"9" * 5000 + b"}",
            "metadata_integer_range",
            "SECRET-LARGE-INTEGER",
        ),
    ],
)
def test_parser_rejections_are_fully_sanitized(payload: bytes, code: str, secret: str) -> None:
    error = _raises(code, payload)
    rendered = str(error) + repr(error) + "".join(traceback.format_exception(error))

    assert type(error) is RequestRefCodecError
    assert error.code == code
    assert secret not in rendered
    assert error.__context__ is None
    assert error.__cause__ is None


@pytest.mark.parametrize("value", [bytearray(b"metadata"), memoryview(b"metadata"), "metadata"])
def test_metadata_input_requires_bytes(value: object) -> None:
    with pytest.raises(RequestRefCodecError) as raised:
        decode_request_metadata(
            value,
            max_total_bytes=1_000_000,
            expected_producer_request_digest=GOLDEN_DIGEST,
        )

    assert raised.value.code == "metadata_type"


@pytest.mark.parametrize(
    "payload",
    [
        _canonical({**GOLDEN_METADATA, "targetLanguage": "bad"})[:-1] + b',"x":NaN}',
        _canonical({**GOLDEN_METADATA, "targetLanguage": "bad"})[:-1] + b',"x":Infinity}',
        b'{"targetLanguage":"bad","targetLanguage":"again"}',
    ],
)
def test_nonfinite_and_nested_duplicate_values_fail_before_typed_parse(payload: bytes) -> None:
    error = _raises(
        "metadata_nonfinite_number"
        if b"NaN" in payload or b"Infinity" in payload
        else "metadata_duplicate_key",
        payload,
    )
    assert "NaN" not in str(error)
    assert "Infinity" not in str(error)


def test_duplicate_key_inside_a_nested_value_is_rejected() -> None:
    payload = _canonical(GOLDEN_METADATA).replace(b"[1]", b'[{"page":1,"page":1}]')
    _raises("metadata_duplicate_key", payload)


def test_duplicate_key_at_root_is_rejected_before_last_value_wins() -> None:
    payload = _canonical(GOLDEN_METADATA)[:-1] + b',"sourceKind":"pdf"}'
    _raises("metadata_duplicate_key", payload)


def test_oversized_metadata_is_rejected_before_json_parse() -> None:
    payload = b"{" + b"x" * (64 * 1024)
    _raises("metadata_too_large", payload)


def test_json_integer_limit_is_independent_of_python_digit_limit() -> None:
    payload = b'{"totalBytes":' + b"9" * 5000 + b"}"
    previous_limit = sys.get_int_max_str_digits()
    try:
        sys.set_int_max_str_digits(0)
        error = _raises("metadata_integer_range", payload)
    finally:
        sys.set_int_max_str_digits(previous_limit)

    assert sys.get_int_max_str_digits() == previous_limit
    rendered = str(error) + repr(error) + "".join(traceback.format_exception(error))
    assert "9" * 5000 not in rendered
    assert error.__context__ is None
    assert error.__cause__ is None


def test_oversized_integers_are_rejected_before_closed_field_validation() -> None:
    payloads = (
        b'{"unknown":' + b"9" * 5000 + b"}",
        b'{"pdfPageNumbers":[{"nested":' + b"9" * 5000 + b"}]}",
    )

    for payload in payloads:
        _raises("metadata_integer_range", payload)


@pytest.mark.parametrize(
    "field, value, code",
    [
        ("totalBytes", True, "total_bytes"),
        ("totalBytes", 1.0, "total_bytes"),
        ("totalBytes", "4096", "total_bytes"),
        ("sourceSha256", True, "source_sha256"),
        ("sourceSha256", "E" * 64, "source_sha256"),
        ("sourceSha256", "g" * 64, "source_sha256"),
        ("sourceSha256", "a" * 63, "source_sha256"),
        ("protocolVersion", 2, "protocol_version"),
        ("startPolicy", True, "start_policy"),
        ("targetLanguage", 7, "target_language"),
        ("pdfPageNumbers", [True], "pdf_page_numbers"),
    ],
)
def test_scalar_types_are_strict_without_coercion(field: str, value: object, code: str) -> None:
    _raises(code, _metadata(**{field: value}))


@pytest.mark.parametrize(
    "change, code",
    [
        ({"sourceKind": "audio", "mediaType": "audio/mpeg", "pdfPageNumbers": None}, "source_kind"),
        ({"sourceKind": "pdf", "mediaType": "image/png"}, "media_type"),
        (
            {"sourceKind": "image", "mediaType": "application/pdf", "pdfPageNumbers": None},
            "media_type",
        ),
        ({"mediaType": "text/plain"}, "media_type"),
        ({"structuringMode": "runtime-v2"}, "structuring_mode"),
        ({"startPolicy": "lazy"}, "start_policy"),
        ({"fileName": "folder/secret.pdf"}, "file_name"),
        ({"fileName": "x" * 256}, "file_name"),
        ({"fileName": ""}, "file_name"),
        ({"targetLanguage": "x" * 65}, "target_language"),
        ({"targetLanguage": " zh-TW"}, "target_language"),
    ],
)
def test_field_bounds_and_closed_values_fail_closed(change: dict[str, object], code: str) -> None:
    _raises(code, _metadata(**change))


@pytest.mark.parametrize(
    "change, code",
    [
        ({"pdfPageNumbers": None}, "pdf_page_numbers"),
        ({"pdfPageNumbers": []}, "pdf_page_numbers"),
        ({"pdfPageNumbers": [2]}, "pdf_page_numbers"),
        ({"pdfPageNumbers": [1, 3]}, "pdf_page_numbers"),
        ({"pdfPageNumbers": list(range(1, 502))}, "pdf_page_numbers"),
        (
            {"sourceKind": "image", "mediaType": "image/png", "pdfPageNumbers": [1]},
            "pdf_page_numbers",
        ),
    ],
)
def test_pdf_page_selection_is_an_ordered_prefix_and_null_for_images(
    change: dict[str, object], code: str
) -> None:
    _raises(code, _metadata(**change))


def test_pdf_page_selection_accepts_the_500_page_limit() -> None:
    decoded = _decode(_metadata(pdfPageNumbers=list(range(1, 501))))

    assert decoded.metadata.pdf_page_numbers == tuple(range(1, 501))


@pytest.mark.parametrize("mode", [StructuringMode.RUNTIME.value, StructuringMode.HOST.value])
def test_structuring_mode_accepts_each_existing_enum_value(mode: str) -> None:
    decoded = _decode(_metadata(structuringMode=mode))

    assert decoded.metadata.structuring_mode is StructuringMode(mode)


def test_total_bytes_uses_the_injected_caller_limit() -> None:
    _raises("total_bytes_limit", GOLDEN_METADATA, max_total_bytes=4095)
    assert _decode(GOLDEN_METADATA, max_total_bytes=4096).metadata.total_bytes == 4096

    for invalid_limit in (True, 0, -1, 1.0):
        _raises("total_bytes_limit", GOLDEN_METADATA, max_total_bytes=invalid_limit)


def test_total_bytes_accepts_the_exact_json_safe_integer_limit() -> None:
    safe_integer = 2**53 - 1

    decoded = _decode(
        _metadata(totalBytes=safe_integer),
        max_total_bytes=safe_integer,
    )

    assert decoded.metadata.total_bytes == safe_integer


def test_total_bytes_rejects_out_of_range_or_nonpositive_integers() -> None:
    safe_integer = 2**53 - 1

    _raises(
        "metadata_integer_range",
        _metadata(totalBytes=safe_integer + 1),
        max_total_bytes=safe_integer + 1,
    )
    _raises(
        "metadata_integer_range",
        _metadata(totalBytes=-(safe_integer + 1)),
        max_total_bytes=safe_integer,
    )
    _raises(
        "total_bytes",
        _metadata(totalBytes=-safe_integer),
        max_total_bytes=safe_integer,
    )


@pytest.mark.parametrize(
    "expected",
    [
        "09e72d163518cc548cd48fe579e2dc0f689623c8d6f6ffdd79e95671a3df5679",
        "SHA256:09e72d163518cc548cd48fe579e2dc0f689623c8d6f6ffdd79e95671a3df5679",
        "sha256:09e72d163518cc548cd48fe579e2dc0f689623c8d6f6ffdd79e95671a3df567",
        "sha256:09e72d163518cc548cd48fe579e2dc0f689623c8d6f6ffdd79e95671a3df5679\n",
    ],
)
def test_expected_producer_digest_requires_exact_prefixed_lowercase_form(expected: str) -> None:
    _raises("producer_digest", GOLDEN_METADATA, expected_producer_request_digest=expected)


def test_expected_producer_digest_mismatch_is_sanitized() -> None:
    error = _raises(
        "producer_digest_mismatch",
        GOLDEN_METADATA,
        expected_producer_request_digest="sha256:" + "f" * 64,
    )
    assert GOLDEN_DIGEST not in str(error)
    assert "f" * 64 not in str(error)
