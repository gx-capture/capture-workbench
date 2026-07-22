# Capture Runtime v1 TODO

- [x] Add uv and Nx package scaffolding.
  Verify: `pnpm nx show project capture-runtime --json`
- [x] Implement contracts, persistence, engines, and isolated Ollama ownership.
  Verify: `pnpm nx run capture-runtime:typecheck`
- [x] Implement authenticated runtime and capture APIs with both structuring modes.
  Verify: `pnpm nx run capture-runtime:test`
- [x] Cover validation, recovery, retention, cancellation, and idempotency failures.
  Verify: `pnpm nx run capture-runtime:test`
- [x] Run all package gates.
  Verify: `pnpm nx run-many -t lint,typecheck,test,build -p capture-runtime`

## Release blockers

- [x] Implement standalone WindowsML OCR and Whisper adapters behind `CaptureExtractor`, with
  local-only model paths and no host-package imports.
  Verify: `pnpm nx run capture-runtime:test`
- [ ] Publish the checksum-pinned WindowsML model ZIP and record both consent-downloaded Whisper
  model digests for the release tag.
  Verify: `pnpm nx run capture-runtime:production-preflight`
- [ ] Produce clean Windows 11 x64 evidence for real PDF, image, licensed audio, schema/locator
  provenance, and concurrent Capture/Cert Ollama isolation.
  Verify: set `CAPTURE_RELEASE_EVIDENCE_PATH`, then run production preflight.
