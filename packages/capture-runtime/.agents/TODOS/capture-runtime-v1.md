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

## Release verification

- [x] Runtime release artifacts publish from the synchronized build candidate with a
  checksum-pinned WindowsML descriptor and canonical manifest/schema assets.
  Verify: `pnpm nx run capture-runtime:build-release-artifacts`
- [x] Local runtime consumer smoke verifies downloaded assets, manifest/checksum integrity,
  readiness, and cleanup without becoming a hosted clean-install publication gate.
  Verify: `pnpm nx run capture-runtime:local-release-consumer-smoke`
