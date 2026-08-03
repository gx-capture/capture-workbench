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
- [x] Update `@gx-capture/capture-workbench` and the desktop/runtime release
      surfaces to candidate version `0.3.9`; retain literal `0.3.8` only in
      explicitly historical compatibility fixtures and evidence.

## Active release gates

- [ ] On the local Windows machine, build the production workers and run the
      privacy-safe private Whisper preflight twice from the exact source lock.
      Both evidence files must be identical and contain no text, path, token,
      or license URL. Freeze only the observed `large-v3-turbo`/`cuda` or
      `small`/`cpu` pair and normalized output SHA-256.
- [ ] Approve the source lock with no blockers, then run the local source-lock,
      production-environment, worker-boundary, release-version, package,
      Cargo, desktop, and real OCR/audio gates. A failed gate stops before tag
      or publication.
- [ ] Root-review the complete Commit B diff, explicitly stage only reviewed
      Capture Workbench paths, inspect the cached diff/tree, commit, and push
      `release/model-enabled-v0.3.9`.
- [ ] Merge the reviewed PR to `main` and require the unique successful
      `.github/workflows/ci.yml` push run for the exact merge SHA.
- [ ] Confirm the local probe is running from the exact `main` SHA and retain
      only redacted local evidence for review; no runner registration or
      Actions receipt is required.
      Verify: `git fetch origin main`, confirm `git rev-parse HEAD` equals
      `git rev-parse origin/main`, then run
      `pnpm nx run capture-runtime:verify-release-model-candidate` and
      `pnpm nx run capture-workbench-desktop:smoke-real-media-model`.
- [ ] Create and push `v0.3.9` only after the local worker probe and desktop
      three-media evidence pass. Verify the release publishes the core runtime,
      catalog/checksums, worker archives, NSIS installer, and
      `@gx-capture/capture-workbench@0.3.9`, with no model, model ZIP, fixture,
      or package tarball in GitHub Release assets.
- [ ] Update Cert Prep to the published package/runtime bytes, run fresh
      packaged scanned-PDF, image, and audio E2E plus v0.3.8 compatibility and
      unavailable-negative gates, and leave all Cert Prep changes uncommitted.
- [ ] Remove downloaded models, staging/app-data, `.nx`, `dist/out/tmp`,
      Tauri `target`, Python caches, and generated apps. Preserve existing
      `.venv` directories and the original private audio; verify no owned
      Capture Workbench or Cert Prep process/listener remains.
