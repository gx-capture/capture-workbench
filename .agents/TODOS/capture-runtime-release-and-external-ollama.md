# Capture Runtime Release and External Ollama TODO

- [x] Add the v0.3.0 external Ollama configuration and provider contract.
  Verify: focused external-provider pytest tests.
  Done: external Ollama settings in `capture_runtime/config.py`; `tests/unit/test_external_ollama.py`.

- [x] Add API tests for external mode requirement scoping and runtime
  capabilities.
  Verify: `corepack pnpm nx run capture-runtime:test --skip-nx-cache`.
  Done: `tests/unit/test_external_ollama.py`.

- [x] Repair release-version argument/path handling and synchronize runtime
  protocol metadata at v0.3.0.
  Verify: `corepack pnpm verify:release-version -- v0.3.0`.
  Done: release version tooling in `tools/release/version-sources.ts`, used for every release since v0.3.0.

- [x] Document standalone executable and HTTP API quick start.
  Verify: README contains launch, readiness, upload, polling, and external
  Ollama examples without placing secrets in URLs.
  Done: `packages/capture-runtime/README.md` documents readiness and the v2 ingestion/capture lifecycle.

