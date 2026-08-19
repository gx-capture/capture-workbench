# Real OCR Result Acceptance Spec

## Purpose

Prove that the packaged Capture Workbench executable completes a real WebView2
journey, produces an OCR result that is parseable and semantically matches its
supplied fixture oracle, correctly projects that result into the structured
result shown by the UI, and leaves no owned process or temporary app-data
residue.

## Interfaces

- Input: `CAPTURE_REAL_DESKTOP_OCR_INPUT` or the legacy PDF variable.
- Oracle: `CAPTURE_REAL_DESKTOP_OCR_EXPECTATIONS`, or
  `<input-path>.expected.json`.
- Oracle schema: `{ schemaVersion: 1, sourceFileName?: string,
  rawTextIncludes: string[] }`.
- UI outputs: visible raw OCR text plus rendered raw segments, and visible
  structured target text plus rendered structured blocks.
- Lifecycle authority: the packaged executable and its acceptance-only
  readiness/process signals, not a renderer reload.
- Native input boundary: Windows UI Automation drives the brokered file picker;
  the test then reattaches to the packaged WebView2 CDP session and waits for an
  exact `library_list` acknowledgement for the fixture filename.
- Evidence: an acceptance manifest containing checkpoint artifacts, semantic
  verification counts/provenance, errors, and cleanup status.

## Acceptance Criteria

- The input and oracle are existing regular files; no input SHA is required.
- The visible raw OCR result contains at least one non-empty, ordered segment.
- Raw `sourceText` equals the exact segment text projection.
- Every oracle anchor occurs in normalized raw OCR text.
- The visible structured result contains the same ordered raw segments.
- Every block maps one-to-one to its raw segment, preserving ID, order, locator,
  and source text; `targetText` is the exact block projection.
- Missing OCR, malformed JSON, missing anchor, or projection mismatch fails the
  Playwright test.
- Runtime installation and native-picker transitions must publish readiness or
  import signals; the test must not treat renderer reload as lifecycle proof.
- Native picker automation is PID-bound and fail-closed; it must not use the
  user's clipboard as a transport or leave the picker boundary ambiguous.
- The journey must delete the exact imported document and verify app, owned
  sidecar, CDP port, and temporary app-data cleanup before writing a completed
  manifest.
- The evidence report records verification counts and provenance, not OCR text
  itself. Screenshots are secondary artifacts; moving-progress checkpoints are
  retained for diagnostics but are not screenshot-diff contracts.

## Test Plan

- Unit tests cover valid parsing, missing anchors, malformed JSON, and broken
  raw/structured projections.
- The real Playwright journey observes executable readiness, drives the native
  picker, reattaches CDP after native/runtime transitions, and reads both
  visible result panels after the actual OCR and AI structuring stages.
- The completion wrapper fails closed unless Playwright succeeds, the manifest
  is `completed`, and every cleanup field is true.
