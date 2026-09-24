# Capture Runtime 0.4.2 P1 decisions

## Approved decisions

1. **OCR-only source of truth.** PDFium rasterizes every PDF page and image
   normalization feeds the canonical PaddleOCR WindowsML worker. Embedded PDF
   text is never inspected. There is no hybrid arbitration and no LLM route
   selection.
2. **Version identity.** The existing authenticated `/v2` API remains API
   `2.0`. `CaptureOcrProjectionV3` uses `schemaVersion: "3"` as an additive
   response model; `RawCapture`, `CaptureDocument`, and existing host
   structuring remain schema 2.
3. **Small public seam.** The only new public route is
   `GET /v2/captures/{capture_id}/ocr`. Paddle configuration, language/profile
   selection, and worker implementation details remain behind the runtime
   deep-module seam. `targetLanguage` remains structuring output metadata.
4. **Page completeness.** The typed OCR projection records every source page,
   including an `empty` page. Raw schema 2 continues to contain only non-empty
   `RawCaptureSegment` values; the projection is the page-complete typed seam.
5. **Failure readability.** A failed terminal capture returns a projection with
   `status: "failed"` and a sanitized `CaptureFailureV2`; consumers need not
   infer failure from a missing body. No partial successful raw document is
   emitted as a substitute for an OCR failure.
6. **Ownership.** Windows Job Object ownership is implemented in one Rust
   `OwnedRuntimeSession` per launch attempt. Host adapters own graceful intent;
   they do not share or duplicate native Job handles. Runtime-root exit is
   observed and invokes the same terminate-and-prove path. OS crash/power-loss
   reconciliation is a next-start concern, not an app callback guarantee.
7. **Sequential acceptance evidence.** The three-project runner uses
   acceptance-manifest schema 2. Each child must prove all seven cleanup
   booleans (`app`, `sidecar`, `cdpPort`, `temporaryAppData`, `ownedPids`,
   `ownedListeners`, and `ownedWorkers`) and empty error arrays before the next
   PaddleOCR model is loaded. The runner stops after the first invalid child.
8. **Worker failure completeness.** The runtime preflights PDF/image page count
   and raster metadata before launching the OCR worker. The internal
   JSON-lines worker seam then carries a validated header and per-page frames;
   malformed/crashed/timed-out runs synthesize only the uncompleted manifest
   pages as failed with fixed typed messages. A failure before a safe page count
   exists returns a typed failed projection without guessing pages. Runtime or
   model unavailability after the manifest exists is stricter: the canonical
   owner discards any unresolved progress prefix and synthesizes every manifest
   page as failed with `ocr_runtime_unavailable`, preserved raster metadata,
   and unavailable provenance. A source-preflight failure before the manifest
   exists remains an empty/unknown page projection with a typed source failure.
9. **DirectML execution proof.** DML availability selects one DML-first
   ONNX Runtime session with CPU support for unsupported kernels; it does not
   authorize a second CPU-only retry. Because PaddleX 3.7 does not forward
   ONNX Runtime's constructor-fallback kwarg, runtime creation leaves vendor
   globals untouched and requires every returned session to report the exact
   DML-first/CPU provider identity before disabling session-run fallback; a
   CPU-only, reordered, or dropped identity fails closed before inference.
   ORT execution evidence is the source of truth for provider provenance:
   graph-assignment evidence is finalized after the first prediction when
   exposed and recording is enabled by the installed ORT, with that
   prediction's execution profile as the fallback when the graph option is
   unavailable; at least one `DmlExecutionProvider` node is required before
   emitting `windowsml-dml`; missing/unreadable evidence or zero DML nodes
   fails closed. The worker does not emit its header or recognized page frame
   until this provenance is resolved.
   When DML is not available, one explicit CPU-only session is allowed and its
   provenance is `cpu`. The internal evidence adapter is injectable for unit
   seams, while real acceptance must preserve and inspect ORT evidence.
10. **Canonical Paddle profile identity.** The packaged
    `model-sources/commit-a/model/pipeline.json` is the sole OCR profile
    source. Canonical JSON bytes are copied to the runtime asset and model
    directory; their SHA-256 derives `profileSpecSha256`, and a hash-prefixed
    profile ID is derived from the same bytes. The profile fixes PP-OCRv6
    detector/recognizer revisions, the Traditional-Chinese/multilingual
    dictionary identity, PaddleX's three orientation switches, the actual
    PDFium/Pillow preprocessing ownership, and DirectML provider policy.
    Runtime verifies listed artifact bytes and then computes model digest from
    loaded files. It builds and compares the exact accepted PaddleX
    constructor kwargs immediately before invocation; `targetLanguage`,
    `ocrLanguage`, and host-supplied Paddle kwargs do not exist at this seam.
    Any profile, artifact, orientation, preprocessing, or provider-policy
    drift fails closed.
11. **Atomic raw-result normalization.** Paddle `rec_texts`, `rec_scores`,
    and the selected polygon array are normalized once through a strict deep
    module. Non-empty pages require parallel cardinality, non-empty strings,
    finite numeric scores in `[0, 1]`, and bounded predictor-input polygons;
    malformed values never get dropped or hidden by `str()`/`float()` and a
    malformed tenth region fails the entire page rather than preserving a
    misleading nine-region recognized prefix. Only an actually empty
    `rec_texts: []` payload may produce an empty page without regions.
12. **Canonical confidence semantics.** The `OcrPipeline`, not an adapter,
    computes page confidence. A `recognized` page with numeric region scores
    receives their arithmetic mean rounded to four decimal places; recognized
    text with no numeric score permitted by the engine contract receives
    `0.0`; `empty` and `failed` pages receive `null`. This status rule is
    preserved by the wire validators and all generated SDK models.
13. **Projection-owned raw OCR.** The normalized `OcrPipeline` projection is
   the only source for OCR `RawCaptureSegment` values. The worker's legacy
   `segments` envelope remains parseable for compatibility but must exactly
   equal the recognized page/text sequence; any extra, missing, empty-page, or
   divergent text is rejected as `ocr_worker_protocol` before raw persistence.
14. **Unavailable projection completeness.** A PDF/image manifest is a source
    contract, not an optimistic hint. Once established, any runtime resolution,
    worker launch, or OCR initialization failure must carry that exact ordered
    manifest into a failed projection. The unavailable document variant cannot
    claim resolved model/device identity or expose a recognized prefix; only a
    pre-manifest source failure may have no pages.
15. **Host OCR proof checkpoint.** In `StructuringMode.HOST`, the runtime
    publishes a validated private `OcrExecutionDeviceProofV1` exactly once
    after raw capture persistence, OCR projection persistence, and the
    `awaiting_structuring` transition all succeed. This OCR-proof terminal is
    deliberately earlier than host LLM/structuring and release success; the
    public operation remains `awaiting_structuring` until a host-owned document
    commit or host-structuring failure. Failed or malformed OCR, either
    persistence failure, transition failure, and cancel/delete before the
    checkpoint publish no proof. Cancel/delete after it cannot publish again.
    Host commit persistence failure remains a separate host-owned behavior and
    does not retract a proof already emitted at the OCR checkpoint.

## Rejected alternatives

- Public `ocrLanguage`, `ocrProfile`, Paddle kwargs, or host-specific OCR
  policies: rejected because they expose implementation and create cache/model
  identity drift without a proven caller intent.
- Reusing `RawCaptureSegment` as the page-complete projection: rejected because
  schema 2 requires non-empty text and cannot represent empty pages or typed
  page failures.
- A shared cross-language Job Object handle abstraction: rejected because it is
  not a supported nested-job contract; the outer desktop Job is the safety net,
  while Rust owns native lifecycle and hosts call semantic methods.

## TDD seams

- `OcrPipeline` with production and in-memory engine adapters: test ordered
  pages, predictor polygon order/round-trip, raster bounds, confidence rules,
  empty pages, and typed failures.
- Authenticated route plus repository fixture: test 401, 404, pending/unavailable,
  completed projection, and readable failed projection.
- `OwnedRuntimeSession` with a native-process test seam: test assignment before
  resume, breakaway rejection, root exit, idempotent terminate-and-prove, and
  no descendant residue.
