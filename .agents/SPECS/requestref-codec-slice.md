# RequestRef input codec slice

## Purpose

Add one private, pure Capture Runtime boundary that accepts the producer's
canonical start metadata bytes, validates the closed RequestRef metadata
shape, and returns immutable typed metadata, the exact canonical bytes, and
the producer request digest. The boundary is useful to a future
`start_or_get` adapter but does not claim that adapter, a route, source
consumption, or lifecycle ownership.

## Non-goals

- Do not change public contracts, generated assets, contract hashes, routes,
  services, storage, SDKs, versions, or dependencies.
- Do not generate RequestRefs. A future adapter owns CSPRNG generation.
- Do not read, hash, stage, or otherwise consume source bytes.
- Do not validate LAW `pageScope`; it is outside producer start metadata.
- Do not add persistence, idempotency, native process, transport, or endpoint
  behavior.

## Interface

`decode_request_metadata(metadata_bytes, *, max_total_bytes,
expected_producer_request_digest)` accepts only bytes for metadata, a
caller-supplied positive integer byte ceiling, and the separate expected
producer digest. It returns
`DecodedRequestMetadata`, containing:

- frozen `StartCaptureByRequestRefMetadata` fields;
- canonical compact UTF-8 JSON bytes with recursively sorted object keys,
  ordered arrays, and explicit nullable fields;
- `producer_request_digest`, exactly `sha256:` followed by 64 lowercase hex
  characters.

The expected digest must have the exact producer digest syntax and match the
recomputed digest. `validate_request_ref` validates
the opaque `rr1_` plus 64 lowercase-hex syntax only; it makes no claim about
randomness or derivation.

## Key decisions

- The module lives at `packages/capture-runtime/src/capture_runtime/request_ref_codec.py`
  and is intentionally absent from the package's public `__init__.py`.
- The closed metadata has exactly these camelCase keys, all present:
  `protocolVersion`, `sourceKind`, `fileName`, `mediaType`, `totalBytes`,
  `sourceSha256`, `pdfPageNumbers`, `structuringMode`, `targetLanguage`, and
  `startPolicy`.
- `CaptureSourceKind`, `StructuringMode`, and the existing positive integer,
  SHA-256, target-language, page-prefix, and file-name semantics are reused at
  this private boundary. OCR start metadata accepts `pdf` or `image` and the
  producer's four media types (`application/pdf`, `image/jpeg`, `image/png`,
  `image/webp`); `structuringMode` accepts exactly the existing `runtime` and
  `host` enum values, and `startPolicy` is `eager`.
- The existing 255-character file-name bound and 1..64 target-language bound
  are retained. File names are basenames without separators. Bounded text
  rejects C0 controls (U+0000 through U+001F), DEL (U+007F), and Unicode
  surrogates; C1 controls in non-boundary positions are accepted and preserved
  byte-for-byte, and no Unicode normalization is applied. Media type strings
  are exact allowlisted values.
- Metadata is rejected when its raw byte length exceeds 64 KiB before UTF-8 or
  JSON parsing. UTF-8 is strict, a UTF-8 BOM is rejected, duplicate object keys
  are rejected recursively, non-finite JSON constants are rejected, and raw
  input must already be byte-for-byte canonical.
- Runtime validation never coerces booleans, floats, strings, or aliases into
  typed values. `totalBytes` must be positive and no larger than the injected
  `max_total_bytes`. Every JSON integer token must be within the exact
  JavaScript safe-integer range `-(2**53 - 1)` through `2**53 - 1`, with
  oversized digit tokens rejected before integer conversion; the codec has no
  ambient settings or default source-size I/O.
- Dataclasses are frozen and use tuples for page numbers. Result and metadata
  representations are sanitized so raw metadata, paths, refs, and digests do
  not appear in exception text or `repr`.

## Edge cases and failure modes

Every rejection raises `RequestRefCodecError` with a stable lowercase error
code and a fixed sanitized message. Codes cover input type/size/UTF-8/BOM/JSON
syntax/duplicate keys, exact key closure, each typed field, canonical bytes,
digest syntax/mismatch, total-size bounds, and RequestRef syntax. No raw value,
path, reference, or digest is interpolated into an error.

The codec accepts only producer metadata. `requestRef`, `requestDigest`, LAW
`pageScope`, snake_case aliases, nested metadata, and every other unknown key
are rejected by exact root-key validation. `pdfPageNumbers` is an explicit
ordered prefix `[1, ..., N]` for PDF and explicit `null` for image input.

## Acceptance criteria

- The LAW golden producer vector returns exactly
  `sha256:09e72d163518cc548cd48fe579e2dc0f689623c8d6f6ffdd79e95671a3df5679`.
- The LAW golden envelope's digest over `{startMetadata, pageScope}` is
  `sha256:8a35ab69804633e3fd5a2ef966ea991171d76151204a293a4e582cd70f32173e`.
  Changing only LAW `pageScope.sourcePageCount` changes that LAW digest while
  the unchanged `startMetadata` still produces the exact producer digest above.
  This test uses fixture literals at the digest-domain boundary; it does not
  add or exercise a LAW codec. Supplying `pageScope` or an extra digest field
  to this codec is rejected.
- Canonical order, compact spacing, UTF-8 CJK text, explicit nulls, and the
  producer digest are stable; noncanonical spacing/order/escaping, a trailing
  newline, or a BOM is rejected.
- PDF page selections accept the ordered prefix through 500 pages and reject
  501 pages.
- JSON integer tokens at exactly `-(2**53 - 1)` and
  `2**53 - 1` are accepted when field validation allows them;
  out-of-range tokens are rejected before typed-field or closed-key
  validation, independently of Python's process-wide integer digit limit.
- Missing/unknown/duplicate root or nested keys, malformed UTF-8, oversized
  pre-parse bytes, NaN/Infinity, floats/booleans/string numeric coercions,
  wrong non-hex SHA/ref syntax, invalid source/page/media/file/target values,
  unsupported structuring modes, unexpected metadata input types, and digest
  mismatch fail with sanitized stable codes.
- The returned values cannot be mutated through list/map aliases, and their
  representations do not expose metadata values.
- Malformed UTF-8 or JSON, invalid enum values, deep nesting, and oversized
  integer literals produce a `RequestRefCodecError` whose type, stable code
  (`metadata_integer_range` for an out-of-range JSON integer), `str`,
  `repr`, and default traceback contain no raw input or parser detail;
  the error retains neither a raw `__context__` nor a `__cause__` chain.
- Tests run through the discovered Nx `capture-runtime:test-unit` target;
  lint, strict typecheck, and `check-contracts` are run when available. No
  source-consumption or lifecycle acceptance claim is made by this slice.

## Test plan

Use one focused Python unit file. Start with the golden vector and immutable
result checks, then cover valid image/null and CJK metadata. Add parameterized
negative cases for closure, duplicate keys, syntax/encoding/canonicality,
strict scalar types, field bounds, page invariants, RequestRef syntax, and
expected digest mismatch. Include both existing structuring modes, C1
preservation, the 500/501 page boundary, and parser/enum rejection
sanitization checks. Keep all tests pure and fixture-free; load no source
files and use no network or process APIs.
