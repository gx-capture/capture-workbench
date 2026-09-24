# Capture Runtime 0.4.2 P1 TODO

- [x] Add `CaptureOcrProjectionV3` and page/box/raster/status/failure models.
  Verify: focused contract model tests.
- [x] Add the OCR projection deep module and worker result normalization.
  Verify: focused unit tests through the projection interface.
- [x] Add authenticated `GET /v2/captures/{capture_id}/ocr` and durable
  projection persistence, including readable failed captures.
  Verify: focused route/integration tests and contract route inventory pass
  after canonical artifact regeneration.
- [x] Generate runtime/TypeScript/Python contract artifacts and synchronize the
  Java SDK's canonical hash surface.
  Verify: canonical generator default, `generate_contracts.py --check`,
  `pnpm nx run capture-runtime:check-contracts --skip-nx-cache`, and SDK
  tests/typechecks/build/pack/hash checks all pass.
- [x] Implement the Rust `OwnedRuntimeSession` lifecycle slice.
  Verify: `pnpm nx run capture-sidecar-launcher:cargo-fmt-check --skip-nx-cache`,
  `cargo-check`, and `cargo-test`.
- [x] Run the P1 runtime and sidecar gates without cache.
  Verify: lint, typecheck, unit, integration, contract, and Rust checks.
  Runtime lint/typecheck/unit/integration/check-contracts, model/profile lock,
  sidecar and desktop Rust, desktop script lint/typecheck/package QA, and tools
  lint/typecheck/test all passed with `--skip-nx-cache`.
- [ ] Real Phase 1 evidence remains unchecked/currently incomplete: use one
  real private JPEG and PDF page 1 per installed app, in Capture Workbench ->
  Cert Prep -> GX Law Prep order, with one OCR owner at a time and cleanup
  proven before the next app. Embedded PDF text is ignored, not rejected; the
  result must come from rasterized PaddleOCR. Record CER/anchors, GPU/DML or
  explicit noticed CPU fallback, provenance, and cleanup without raw text.
  Full-document OCR is reserved for a risk-specific page-order or memory test.
  Release manifest promotion and publish actions remain separate later gates.
- Phase 2 defer: production ambient-environment hardening and persisted
  runtime catalog identity remain outside this Phase 1 wiring slice.
- [x] Update the three-project real-OCR orchestrator to run deterministic
  Capture Workbench -> Cert Prep -> Law Prep sequentially. Gate each child on
  acceptance-manifest schema 2, a completed manifest, empty error lists, and
  true `app`, `sidecar`, `cdpPort`, `temporaryAppData`, `ownedPids`,
  `ownedListeners`, and `ownedWorkers` cleanup; stop on first failure and
  require cleanup before exit. Real three-project execution remains a later
  evidence gate.
- [x] Add OCR worker progress/header validation and page-complete failure
  projection. Verify: runtime unit/integration tests cover timeout, crash,
  malformed progress/result, valid-page retention, sanitized typed failures,
  and authenticated persistence through `GET /v2/captures/{id}/ocr`.
- [x] Derive OCR raw segments only from the canonical page projection and reject
  divergent legacy worker segments before persistence. Verify: worker segment
  divergence, empty-page secret, missing/extra segment, and perspective-box
  tests pass through the extractor seam.
- [x] Preserve the raster page manifest when OCR runtime resolution or
  initialization is unavailable, returning failed pages with unavailable
  provenance; type source-preflight failures before a manifest without
  inventing a page count. Verify: sync/worker PDF and image projections plus
  authenticated streaming GET route coverage pass.
- [x] Publish the private host-mode OCR execution proof exactly once after raw
  and OCR projection persistence plus the `awaiting_structuring` transition;
  keep this OCR-proof terminal distinct from host structuring/release success.
  Verify: successful host OCR, malformed/failed OCR, persistence/transition
  failures, checkpoint-before cancel/delete, checkpoint-after cancel/delete,
  and host commit persistence failure coverage.
