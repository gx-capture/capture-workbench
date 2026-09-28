# v0.3.9 Model-Enabled Release TODO

`v0.3.8` is immutable core-only evidence. The authorized successor is
`v0.3.9`. Capture Workbench release changes may be committed, pushed, merged,
tagged, and published only through the gates below. Cert Prep consumes only
published `v0.3.9` bytes and its final integration diff remains uncommitted.

## Completed foundations

- [x] Freeze the product contract: DirectML-first OCR, CPU only when
      `DmlExecutionProvider` is absent, and terminal failure on DirectML
      initialization or inference errors. Audio uses
      `large-v3-turbo`/CUDA and falls back to `small`/CPU only for resource
      failures. API `1.0` and CaptureDocument schema `1` remain unchanged.
- [x] Commit and push the seven-file project-owned OCR fixture checkpoint as
      Commit A `31821b241846878d917a60e638a4fce39aba418a`. It contains no
      model weights, private audio, private audio paths, or private audio text.
- [x] Bind the pending v0.3.9 source lock to immutable Commit A URLs and the
      approved pinned PaddleOCR/Whisper revisions. Keep the private audio
      fixture represented only by its bytes, SHA-256, output/provenance
      conditions, and pending freeze fields.
- [x] Add source-lock validation, checksum-pinned direct model delivery,
      atomic activation rollback, version cohesion, model-enabled publisher
      inventory, and provider regressions.
- [x] Add the Tauri/WebView scanned-PDF, image, and private-audio smoke plus
      early raw OCR visibility, UUID-scoped deletion, bounded redacted
      evidence, and owned process/listener cleanup checks.
- [x] Update `@gx-capture/capture-workbench-ui` and the desktop/runtime release
      surfaces to candidate version `0.3.9`; retain literal `0.3.8` only in
      explicitly historical compatibility fixtures and evidence.

## Active release gates

- [x] Create and push `v0.3.9` only after the local worker probe and desktop
      three-media evidence pass. Verify the release publishes the core runtime,
      catalog/checksums, worker archives, NSIS installer, and
      `@gx-capture/capture-workbench-ui@0.3.9`, with no model, model ZIP, fixture,
      or package tarball in GitHub Release assets.
  Done: `v0.3.9` released 2026-08-03; later releases supersede it.
- [x] Update Cert Prep to the published package/runtime bytes, run fresh
      packaged scanned-PDF, image, and audio E2E plus v0.3.8 compatibility and
      unavailable-negative gates, and leave all Cert Prep changes uncommitted.
  Done: Cert Prep now consumes published 0.4.2.
