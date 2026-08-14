# Tauri Reference Harness Spec

## Purpose

Provide a Tauri 2 Windows 11 x64 NSIS harness that packages the Angular reference app and launches a verified `capture-runtime` sidecar with an isolated Workbench Ollama configuration.

## Non-Goals

- A supported public desktop product.
- Installing Ollama without explicit runtime/UI consent.
- Sharing cert-prep or law-prep provider processes, model stores, PID files, or profiles.
- Persisting the runtime bearer token.
- Proving real OCR, Whisper, or Ollama installation in deterministic CI.

## Interfaces

- Tauri command `backend_config() -> { baseUrl, token, runtimeVersion, apiVersion, captureDocumentSchemaVersion }`.
- Bundled runtime manifest fields: manifestVersion, runtimeVersion, apiVersion, captureDocumentSchemaVersion, platform, arch, fileName, bytes, and sha256.
- Sidecar launch environment is centralized in Rust and includes the loopback bind, bearer token, allowed hosts/origins, runtime app-data, and isolated Ollama directories/port/profile/model.
- The verification host caps uploads at 50 MiB so the runtime can safely buffer the canonical multipart request on the supported Windows baseline.
- Nx targets expose dev, NSIS build, Cargo format/check/test, deterministic package QA, and deterministic smoke entry points.

## Failure Modes

- Missing or malformed manifest: fail closed before spawn.
- Wrong platform, architecture, runtime version, schema version, bytes, or SHA-256: fail closed before spawn.
- Sidecar exits or readiness times out: terminate only its recorded process tree and keep `backend_config` unavailable.
- Poisoned runtime state: return a redacted error and do not expose partial connection details.
- App/window exit: idempotently terminate the owned sidecar tree.

## Acceptance Criteria

- Bundle target is NSIS and target triple is `x86_64-pc-windows-msvc`.
- Production CSP has no wildcard source, `unsafe-eval`, remote script, or remote frame permission.
- Tokens contain at least 256 bits of OS randomness and are absent from URLs and launcher diagnostics.
- Runtime and Ollama ports bind to `127.0.0.1` and are independently selected.
- Host authorization compares the complete `127.0.0.1:<runtime-port>` authority; a correct hostname with a different port is rejected.
- Model profile is `capture-workbench-qwen3.5-4b-structure-v1`; base model is `qwen3.5:4b`.
- Unit tests cover token shape, loopback URLs, manifest validation, launch environment isolation, readiness authentication, and PID-scoped cleanup command construction.
- Deterministic QA emits redacted JSON evidence and leaves no owned runtime process behind.

## Test Plan

- Rust unit tests for pure launch policy and manifest checks.
- Cargo check/test for the native host.
- Node smoke for the canonical multipart `file`/`structuringMode`/`targetLanguage` wire, `captureId`, schema version `2`, exact status/raw/result/error envelopes, idempotency, host structuring, authentication, exact Host authority, Origin/CORS rejection, readiness, and redaction.
- Windows package QA skeleton for NSIS artifact/resource inspection.
- Real release gate remains an external clean Windows run with real WindowsML, Whisper, Ollama, PDF, image, and licensed audio fixtures.
