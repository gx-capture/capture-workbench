# Capture Runtime 0.4.2 P1 OCR projection and ownership spec

## Purpose

Make PaddleOCR the single extraction source for every requested PDF page (or all
pages when no scope is supplied) and image while adding a typed, page-addressable
OCR projection that Law Prep can bind to the existing capture lifecycle.  The
projection is exposed through an authenticated
`GET /v2/captures/{capture_id}/ocr` route.  The `/v2` surface and API version
remain `2.0`; only this response has `schemaVersion: "3"`.  Existing raw and
structured document schema 2 contracts remain compatible.

Phase 1 real-app acceptance intentionally requests one JPEG and PDF page 1 per
app. The runtime contract still supports an explicit page scope and its
all-pages default; full-document OCR is only a targeted later check when page
accumulation, ordering, or memory is the risk under test.

## Non-goals

- Do not read embedded PDF text, add `pypdf`, arbitrate between text sources,
  invoke an LLM for OCR routing, or expose Paddle/provider kwargs to hosts.
  The presence or absence of an embedded text layer is not an input gate:
  embedded text is ignored, not rejected.
- Do not add a host-specific OCR policy or a public source-language selector.
- Do not replace the existing capture lifecycle, durable source ownership, or
  host-owned structuring contract.
- Do not claim release, installer, registry, or three-project acceptance from
  unit/integration tests alone.

## Deep module and seams

`OcrPipeline` is the deep module.  Its external interface accepts a capture
source, bounded page manifest, and engine adapter, then returns one ordered
projection for every rasterized page.  It owns result normalization,
box/confidence semantics, page ordering, empty-page handling, provenance, and
typed failure conversion.  `StandaloneRuntimeCaptureExtractor` returns a
typed `CaptureExtractionOutcome` containing the legacy schema-2 `RawCapture`
and optional page projection; `RawCapture` does not carry a private projection
attachment.  For OCR, non-empty `RawCaptureSegment` values are composed only
from recognized pages in that normalized projection.  The legacy worker
`segments` envelope is compatibility-only: its page/text sequence must exactly
match the recognized projection before raw persistence; divergence is a typed
protocol failure and cannot expose worker-only text.  Worker and synchronous
adapters call only the public `OcrPipeline` interface.

The worker protocol is an internal seam.  The production Paddle worker and an
in-memory test adapter are the two justified adapters.  The HTTP route is a
thin authenticated adapter over the streaming repository/service; it must not
reimplement OCR policy.

### Canonical Paddle profile

`model-sources/commit-a/model/pipeline.json` is the packaged canonical profile
spec and is copied byte-for-byte to the worker model root and runtime asset.
Its canonical UTF-8 JSON bytes derive both `profileSpecSha256` and the stable
profile ID (`capture-workbench-ocr-<hash-prefix>`).  The spec includes the
PP-OCRv6 detector/recognizer names and model revisions, the final
Traditional-Chinese/multilingual dictionary path/revision/SHA, the three
PaddleX orientation switches, DirectML provider policy, and preprocessing
ownership (PDFium/Pillow RGB normalization, bounded Lanczos resize, no
deskew/contrast pass).  The worker verifies every listed model/dictionary file
byte hash before constructing PaddleOCR; the resolved model digest is then
computed from the bytes actually loaded, not copied from the manifest.

The only Paddle constructor configuration is built by the runtime profile
module from accepted PaddleX kwargs (`use_doc_orientation_classify`,
`use_doc_unwarping`, and `use_textline_orientation` included).  The adapter
compares that exact payload immediately before the constructor call and never
accepts `targetLanguage`, `ocrLanguage`, or arbitrary Paddle kwargs.  A
profile, dictionary, model artifact, orientation, preprocessing, or DirectML
policy mismatch fails closed.

### DirectML provider policy

The canonical WindowsML OCR adapter makes one provider decision per pipeline
creation. If `DmlExecutionProvider` is available, it creates one DML-first
ONNX Runtime session with `CPUExecutionProvider` in the same session for
unsupported kernels. It never catches a DML error to create a CPU-only
session. PaddleX 3.7 does not expose ONNX Runtime's constructor-fallback
control through `engine_config`, so the runtime does not mutate vendor globals:
immediately after construction, every returned session must report the exact
`[DmlExecutionProvider, CPUExecutionProvider]` identity before run-time
fallback is disabled and inference begins; a CPU-only, reordered, or otherwise
changed identity fails closed.

The adapter enables ONNX Runtime execution profiling for that DML-first
session and attempts graph-assignment evidence when the installed ORT exposes
it. The internal execution-evidence adapter counts actual `provider`/EP node
assignments only after the first prediction: graph-assignment evidence is used
when exposed and recording is enabled by the installed ORT, while the
profile's `Node` events are the fallback when that API is absent or reports
that its recording option is unavailable. Missing or unreadable evidence, or zero
assigned DML nodes, is a typed runtime failure; the result is never labelled
`windowsml-dml` from the configured provider list alone. A proven assignment
with at least one DML node remains valid even when other nodes are assigned to
CPU. The profile is deleted after evidence is read and never becomes public OCR
diagnostics.

If DML is absent, the adapter explicitly creates a CPU-only session and emits
`cpu` provenance. This is the only permitted CPU route. Unit tests use the
same internal evidence-adapter seam with literal node counts; real installed
acceptance must retain ORT evidence and prove at least one DML node on the
candidate artifact.

Before a model-enabled worker is launched, the runtime builds a bounded page
manifest from PDFium/image normalization. Each manifest entry has a stable
one-based page number and canonical raster dimensions/scale; this remains the
source of truth if worker import or preparation fails before stdout exists.
During a run the worker emits validated internal JSON-lines progress frames
only after the first page has completed with resolved provider provenance: one
`ocr-header` manifest followed by zero or one `ocr-page` frame per completed
page. The parent commits only validated frames. A crash, malformed frame/result,
or timeout produces a failed projection for every manifest page
not represented by a recognized/empty frame, while retaining represented
pages. Error text is never copied from worker stderr, exceptions, or private
paths into the public projection.

If worker/runtime resolution or OCR initialization becomes unavailable after
the PDF/image manifest is established, the canonical extraction owner passes
that manifest into a fail-closed projection: every manifest page is present as
`failed` with empty text/boxes, `null` confidence, preserved raster metadata,
and unavailable document/page provenance. No resolved progress prefix is
exposed under unavailable provenance. If manifest construction itself fails,
the projection has an empty/unknown page set and a typed source-preflight
failure; the runtime never fabricates a page count.

## API and wire interface

`GET /v2/captures/{capture_id}/ocr` is Bearer-authenticated and returns
`CaptureOcrProjectionV3`:

- `apiVersion: "2.0"` and `schemaVersion: "3"`;
- capture identity, source identity when known, `status` (`completed` or
  `failed`), ordered `pages`, document-level `provenance`, and optional typed
  `failure`;
- each page has `page`, `status` (`recognized`, `empty`, `failed`), raster
  metadata (`width`, `height`, `scale`, `coordinateSystem: "pixel"`), exact
  OCR `text`, normalized polygon `boxes`, aggregate confidence, per-page provenance,
  and an optional `CaptureFailureV2`.

Boxes use a typed object `{polygon, text, confidence}`. `polygon` preserves the
Paddle predictor-input polygon as an ordered list of at least four `{x, y}`
points in top-left-origin pixel coordinates; every finite, non-negative point
must stay inside the declared raster. A Paddle `xyxy` rectangle is faithfully
represented as four polygon points, never as a replacement rectangle. Region
confidence and page aggregate confidence are Paddle scores in `[0, 1]`.
The canonical page rule is status-dependent: a `recognized` page with numeric
region scores uses their arithmetic mean rounded to four decimal places; a
`recognized` page with text but no numeric scores allowed by the engine
contract uses `0.0`; and `empty` or `failed` pages use JSON `null`. The
adapter aggregate is never trusted as a substitute for this calculation.
Confidence is evidence only and never chooses an OCR route.

The Paddle adapter uses one strict, atomic normalizer for `rec_texts`,
`rec_scores`, and the selected `rec_polys`/`dt_polys`/`rec_boxes` array.  A
non-empty result must contain parallel arrays: text is a non-empty string,
scores are finite numeric values in `[0, 1]`, and every polygon has 4--256
finite numeric points inside the predictor raster.  Missing arrays, nested or
non-string values, booleans, non-finite/out-of-range scores, malformed
polygons, and cardinality mismatches are typed normalization failures; no bad
region is dropped or coerced, and the valid prefix is never projected as a
recognized page.  A genuinely empty `rec_texts: []` result remains a valid
empty page, with only empty or absent companion arrays.

`recognized` requires non-empty text and has no failure.  `empty` preserves the
page and raster/provenance metadata with empty text and boxes; it is not itself
a capture failure.  `failed` preserves the page when possible, has empty text
and boxes, and carries a sanitized typed failure.  A document with no
recognized page or an unrecoverable page/render/worker error fails closed.  A
failed capture still returns a readable projection with `status: "failed"`;
the route does not hide the typed failure behind a 409.

## Lifecycle interface

`OwnedRuntimeSession` is the Rust deep module for one launch attempt.  Its
interface guarantees suspended creation, Job assignment before resume,
`CREATE_BREAKAWAY_FROM_JOB` rejection, root-exit observation, idempotent
`terminate_and_prove`, and a terminal cleanup result.  Desktop/Tauri and other
hosts retain local graceful adapters that call this interface; they do not own
native process handles directly.

### Host OCR execution-proof checkpoint

For a host-structured capture, the validated OCR extraction outcome reaches a
private runtime checkpoint only after the legacy schema-2 raw capture and the
typed OCR projection have both been persisted successfully and the operation
has transitioned to `awaiting_structuring`. At that checkpoint the runtime
publishes the extraction's private execution proof exactly once through the
injected `OcrExecutionEvidenceSink`; it does not wait for an LLM, host
structuring candidate, or host commit. The checkpoint is an OCR-proof terminal
for execution evidence, not a successful structuring or release terminal: the
public operation remains `awaiting_structuring` until the host commits a
validated document (or reports a host-structuring failure).

Malformed or failed OCR, raw/projection persistence failure, transition
failure, and cancellation or deletion before the checkpoint never publish a
success proof. Cancellation or deletion after the checkpoint may discard the
ephemeral runtime state but must not publish a duplicate. Host commit
persistence remains host-owned and is tested independently; a commit failure
does not retroactively turn the already-published OCR checkpoint into a
structuring success.

## Acceptance criteria

- Requested PDF pages (all pages when no page scope is supplied) and images are
  rasterized and sent to the canonical PaddleOCR adapter; no production
  embedded-text path exists. Phase 1 real acceptance uses a real private JPEG
  and PDF page 1, and does not require the PDF to lack an embedded text layer.
- Projection pages are complete, ordered by source page, and retain empty pages.
- OCR polygon points and raster metadata are bounds-checked; recognized Paddle
  regions carry bounded numeric scores, while empty/failed page confidence is
  `null` and no score is fabricated.
- Worker/model/render/cancellation errors map to typed failure data and leave a
  readable failed projection.
- A worker failure before a terminal response still yields exactly one ordered
  page entry for every preflight manifest page; a header-before-inference
  failure uses the parent manifest, and a failure before a safe page count
  exists is fail-closed without inventing a page count.
- Runtime resolution or OCR initialization failure after manifest creation
  yields one failed page for every manifest entry with preserved raster fields,
  `ocr_runtime_unavailable`, and unavailable provenance; source-preflight
  failure before manifest creation is typed and does not invent pages.
- The authenticated OCR route is present in the canonical contract inventory;
  runtime startup rejects route/contract drift.
- Rust launch tests prove per-attempt Job ownership, assign-before-resume,
  no-breakaway, root-exit monitoring, and terminate-and-prove behavior.
- Human truth acceptance separately proves scanned-PDF CER <=1%, photo CER
  <=3%, and zero missing critical anchors per document.

## Verification

Focused P1 gates are the runtime unit/integration/contract targets and the
sidecar Rust format/check/test targets, all with `--skip-nx-cache`.  Real
package/model E2E and release publication remain later gates.

## Cross-project real-OCR execution

Real PaddleOCR acceptance is a memory-bounded, sequential protocol. The
three-project orchestrator MUST run Capture Workbench, then Cert Prep, then
Law Prep in deterministic order, and MUST NOT use `Promise.all`, parallel Nx
OCR journeys, or any other concurrent model-enabled runtime. The version-2
child manifest cleanup object must set `app`, `sidecar`, `cdpPort`,
`temporaryAppData`, `ownedPids`, `ownedListeners`, and `ownedWorkers` to true;
the child must also be completed with empty `errors`, `consoleErrors`, and
`pageErrors` before the next child starts. Any failure stops the sequence and
the failed child must have completed cleanup before the orchestrator returns;
unit tests, package QA, and contract checks are not subject to this global
model-memory limit.
