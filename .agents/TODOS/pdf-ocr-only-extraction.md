# PDF OCR-only extraction TODO

- [x] Replace embedded/mixed PDF extraction with all-page OCR worker dispatch.
  Verify: `pnpm nx run capture-runtime:test-unit --skip-nx-cache`

- [x] Make the OCR worker enumerate, bound, render, and recognize every PDF page.
  Verify: `pnpm nx run capture-runtime:test-unit --skip-nx-cache`

- [x] Add an explicit bounded PDF page-prefix seam for Phase 1 while retaining
  all-page behavior for callers that omit it; expose source/requested/processed
  page evidence through raw capture output.
  Verify: `pnpm nx run capture-runtime:test-unit --skip-nx-cache` and the
  packaged desktop OCR acceptance manifest.

- [x] Remove production `pypdf` code/dependency and refresh the lockfile.
  Verify: `pnpm nx run capture-runtime:lint --skip-nx-cache` and
  `pnpm nx run capture-runtime:typecheck --skip-nx-cache`

- [x] Gate Cert Prep PDF admission on `windowsml-ocr` in frontend and backend.
  Verify: `pnpm nx run cert-prep:test --skip-nx-cache` and
  `pnpm nx run cert-prep-backend:test --skip-nx-cache`

- [x] Update current behavior specs and deterministic package assertions.
  Verify: `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`

- [x] Split runtime unit, integration, local-package E2E, and online-package E2E
  into independently collected directories and Nx targets.
  Verify: `pnpm nx run-many -t test-unit test-integration -p capture-runtime --parallel=2 --skip-nx-cache`

- [x] Build the local runtime release and run the real-runtime PDF OCR E2E.
  Verify: `pnpm nx run capture-runtime:e2e-local-package-pdf-ocr --skip-nx-cache`
  Passed 2026-09-30 with the 2024-07 N1 PDF after the blank-region normalization
  fix: 44/44 pages contain text on DirectML, with all eight exact samples from
  pages 2, 8, 15, 22, 29, 36, 41, and 44 matching (72 normalized characters).
  Capture deletion and owned-process cleanup passed. Each run writes its
  evidence to `tmp/capture-runtime/pdf-ocr-e2e/local-package/evidence.json`.
  Local model input was the checksum-verified installed 0.4.3 model root, set
  through `CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT`. The local mirror records one
  byte-range capability probe and one complete worker download.

- [x] Skip blank recognized regions after validating their metadata.
  The page 16 left-margin strip produces empty text with score zero and a
  valid polygon. Rejecting it aborted the entire document after inference.
  Preserve cardinality, text-type, score, and polygon validation, including on
  blank regions; retain the existing empty-page behavior for all-blank output.
  A rejected result now reports `ocr-normalize-failed-<exception>` so worker
  failure evidence names the normalization step instead of ending at
  `ocr-predict-complete`.
  Verify: `pnpm nx run-many -t test-unit,lint,typecheck -p capture-runtime --parallel=1 --skip-nx-cache`
  and the real local-package E2E above. Models and OCR profile are unchanged.

- [x] Forward validated worker page progress into capture status and checkpoint
  events; reset the watchdog only on forward stage/progress movement.
  The earlier 303-second diagnostic proved that the 300-second stall failure
  could occur while OCR was still working. The rebuilt local package now
  returns the same normalized full text in 234 seconds, with 44 visible page
  updates, 46 total checkpoints, and a longest observed progress gap of 15.292
  seconds. All 44 pages and eight anchors pass; capture deletion and owned
  process cleanup pass. The five-minute idle, fifteen-minute worker, and
  thirty-minute E2E limits remain unchanged.
  Controlled-clock HTTP tests cover seven minutes of continued progress,
  metadata-only heartbeats, regressing progress, absolute timeout and worker
  failure. Integration tests cover intermediate HTTP progress, cancellation,
  invalid terminal output, empty pages and untrusted progress frames.
  Verify: `pnpm nx run-many -t test-unit,test-integration,lint,typecheck -p capture-runtime --parallel=1 --skip-nx-cache`
  Passed: 664 Python unit tests, 215 integration tests, 22 Node tests; one
  existing worker-archive test skipped. Fresh package E2E also passed without
  Nx cache. A failed checkpoint write skips that progress update and never
  fails OCR.

- [x] After a package containing this change is published, run the official
  online-package E2E with the same PDF semantics.
  Verify: `pnpm nx run capture-runtime:e2e-online-package-pdf-ocr --skip-nx-cache`
  Passed 2026-09-30 against published 0.4.4 (runtime SHA-256
  `0227313c6ca2f6c67a1c12d8f232b5708df63cc611b036f80b5163a5630e68fd`), with the
  OCR worker installed from the catalog HTTPS URL and the engine cache off:
  44/44 pages contain text, all eight anchors match (72 normalized
  characters), 45 watchdog checkpoints, capture deletion and owned-process
  cleanup verified.

- [ ] Read vertical Japanese text in the correct column order. Page 16 of the
  N1 PDF (a boxed vertical passage) now completes but returns its columns in
  the wrong order with more recognition errors than horizontal pages. The
  profile runs with `useTextlineOrientation: false`; enabling it or adding a
  vertical-aware recognizer changes the OCR profile identity (profile hash,
  commit-a fixtures, model-source lock), so it needs a release decision.
  Verify: page 16 text matches a manual transcription in reading order.
