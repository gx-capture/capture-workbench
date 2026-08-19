# Real OCR Result Acceptance TODO

- [x] Define a hash-independent expectation manifest and fail-closed oracle.
  Verify: `node --test apps/capture-workbench-desktop/scripts/real-ocr-result-assertions.test.ts`

- [x] Assert raw OCR JSON, semantic anchors, and structured projection from
  the visible WebView2 result panels.
  Verify: `corepack pnpm exec tsc --noEmit -p apps/capture-workbench-desktop/tsconfig.json`

- [x] Run the real image journey to completion and retain its manifest.
  Verify: `E2E_ACCEPTANCE_RUN_ID=local-20260819-fix72 corepack pnpm nx run capture-workbench-desktop:acceptance-real`
  Evidence: `output/playwright/capture-workbench/local-20260819-fix72/acceptance-manifest.json`
  Result: `status=completed`; app, sidecar, CDP, and temporary app-data cleanup
  all passed; errors, console errors, and page errors were empty.

## Current acceptance method

The packaged executable is the lifecycle authority. The journey observes its
readiness and owned-process signals, reattaches to WebView2 CDP after runtime
installation and the native picker, and uses Windows UI Automation plus an
exact `library_list` acknowledgement for import. It does not use renderer
reload as a lifecycle signal. Semantic OCR/structured-result assertions and
the final cleanup manifest are the acceptance evidence; screenshots are
secondary checkpoint artifacts.
