# Real OCR Result Acceptance Spec

## Purpose

Prove that the packaged Capture Workbench executable completes a real WebView2
journey through the routed application shell (`/ocr`, `/settings/engines`,
`/settings/compute`, `/history/:id/content`, `/history/:id/details`,
`/settings/diagnostics`, `/history`), produces an OCR result that is parseable
and semantically matches its supplied fixture oracle, matches durable raw
segments across every shown result page, exposes matching extraction provenance
in Settings Diagnostics, and leaves no owned process or temporary app-data
residue.

## Interfaces

- Input: `CAPTURE_REAL_DESKTOP_OCR_INPUT` (image) or `CAPTURE_REAL_DESKTOP_OCR_PDF`.
- Target: `capture-workbench-desktop:diagnostic-desktop-ocr`; the steps are in the
  header of `apps/capture-workbench-desktop/scripts/real-desktop-ocr-smoke.ts`.
- Oracle: `CAPTURE_REAL_DESKTOP_OCR_EXPECTATIONS`, or
  `<input-path>.expected.json`.
- Oracle schema: `{ schemaVersion: 1, sourceFileName?: string,
  rawTextIncludes: string[] }`.
- UI outputs: visible per-page OCR text (`result-page-text` across
  `result-page-next` navigation on `/history/:id/content`), durable extraction
  provenance (`diagnostics-extraction-provenance` on
  `/settings/diagnostics?document=<id>`), and OCR compute readiness on
  `/settings/compute`.
- Lifecycle authority: the packaged executable and its acceptance-only
  readiness/process signals, not a renderer reload.
- Native input boundary: window messages drive the classic file dialog without
  keyboard input; Windows UI Automation, with a keyboard fallback, drives a
  brokered (Explorer-hosted) file picker. Every key send and mouse click
  requires the picker to own the foreground window: after one failed activation
  attempt the input is refused, and a refused keyboard fallback exits with
  code 10. The test then reattaches to the packaged WebView2 CDP session, waits
  for an exact `library_list` acknowledgement containing the fixture's
  `documentId`, and follows the matching `ocr-queue-row`.
- Evidence: an acceptance manifest containing checkpoint artifacts, semantic
  verification counts/provenance, execution proof (when `E2E_ACCEPTANCE_RUN_ID`
  is set), errors, and cleanup status.

## Acceptance Criteria

- The input and oracle are existing regular files; no input SHA is required.
- First-run installation checks `windowsml-ocr` and leaves speech recognition
  and speaker diarization unchecked before installation begins.
- Before import, Settings Compute exposes the active OCR compute mode (`gpu-dml`
  required in acceptance mode).
- Each visible result page (`result-page-text`) matches the durable raw segments
  composed for that page, ordered segments match durable `sourceText`, and
  every oracle anchor occurs in normalized OCR text.
- Every segment preserves non-empty ID, dense 0-based order, non-empty text, and
  valid locator (`page` or monotonic `startMs`..`endMs`).
- Missing OCR, malformed JSON, missing anchor, per-page mismatch, or diagnostics
  provenance mismatch fails the Playwright test.
- Runtime installation and native-picker transitions must publish readiness or
  import signals; the test must not treat renderer reload as lifecycle proof.
- Native picker automation is PID-bound and fail-closed; it must not use the
  user's clipboard as a transport or leave the picker boundary ambiguous.
- The journey must delete the exact imported document via `/history` and verify
  app, owned sidecar, CDP port, and temporary app-data cleanup before writing a
  completed manifest.
- The evidence report records verification counts and provenance (`ocrDevice`,
  `acceptanceMode: 'ocr-only'`, `releaseGateSatisfied: false`), never OCR text.
  Screenshots and video mask/hide source media, OCR text, and identifying
  metadata; moving-progress and checkpoint screenshots remain secondary artifacts.

## Test Plan

- Unit tests cover OCR-only result validation, per-page UI vs durable segment
  composition, first-run setup + retry, compute settings observation,
  diagnostics provenance reading, polling recovery, and redaction gates.
- The real Playwright journey observes executable readiness, completes
  OCR-only first-run setup, drives the native picker, reattaches CDP across
  native/runtime transitions, verifies every shown result page and diagnostics
  provenance at the durable OCR checkpoint (`awaiting_confirmation` /
  `awaiting_structuring` with `captureId` cleared), and deletes the document.
  With `E2E_ACCEPTANCE_RUN_ID` set it also validates execution proof, semantic
  evidence, privacy-masked screenshots/video, and the acceptance manifest.
- The completion wrapper fails closed unless Playwright succeeds, the manifest
  is `completed`, and every cleanup field is true.
