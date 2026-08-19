# Decision: Real OCR acceptance requires a content oracle and executable-boundary lifecycle

## Context

The real WebView2 journey previously proved only that the OCR and structured
result panels were non-empty. That can pass while the OCR text is corrupted,
the JSON is malformed, or structuring is detached from the extracted segments.
The packaged executable also cannot use renderer reload as a reliable lifecycle
signal: runtime installation and the Windows brokered picker cross native
process boundaries and can invalidate the original CDP attachment.

## Decision

- Every real OCR acceptance input must have an adjacent expectation manifest,
  or an explicit `CAPTURE_REAL_DESKTOP_OCR_EXPECTATIONS` path.
- The manifest contains semantic `rawTextIncludes` anchors and never pins an
  input SHA-256. Any regular supported input may be used when its expectation
  manifest is supplied.
- The UI result must expose non-empty raw segments and a valid
  `CaptureDocument` projection through rendered segment/block data. Each
  structured block must preserve raw segment identity, order, locator, and
  source text.
- The raw OCR text must contain every normalized semantic anchor. Missing,
  empty, malformed, or inconsistent content fails closed.
- The packaged executable is the lifecycle authority. Acceptance observes its
  readiness and owned-process signals and uses an acceptance-only process probe
  where an exact sidecar PID is required.
- After runtime installation and after the native picker closes, acceptance
  creates a fresh WebView2 CDP attachment. Renderer reload is not a readiness or
  reinitialization mechanism.
- The native picker is driven through PID-bound Windows UI Automation. Import is
  accepted only after an exact `library_list` acknowledgement for the fixture;
  clipboard mutation is not permitted.
- The journey deletes the exact imported document and fails closed unless app,
  owned sidecar, CDP port, and temporary app-data cleanup are all verified.
- Artifacts record checkpoint hashes, verification counts, provenance, errors,
  and cleanup status, but not the OCR text itself. Screenshots support stable
  visual checkpoints; semantic programmatic assertions are the content proof.

## Consequences

The acceptance gate can prove meaningful content correctness without requiring
one globally fixed document or persisting potentially private OCR text. A new
fixture must ship an expectation manifest before it can be used as acceptance
evidence. The executable-boundary lifecycle makes the real gate resilient to
native process transitions without pretending that a renderer reload resets the
packaged application. Moving-progress checkpoints may be retained as run
artifacts, but they are not committed screenshot-diff contracts unless the test
explicitly compares them.
