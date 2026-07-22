# Capture Runtime v1 Spec

## Purpose

Provide an independently installable Windows 11 x64 FastAPI sidecar for single-file PDF,
image, and audio capture. The sidecar owns extraction provenance, asynchronous job state,
strict `CaptureDocumentV1` validation, runtime requirement setup, and an isolated Capture
Workbench Ollama lifecycle. It never imports a host application's backend.

## Non-goals

- Domain-specific certificate or legal interpretation.
- A production Web Component.
- A compatibility fallback to a host OCR or capture provider.
- Silently installing Ollama or running a PowerShell download script.
- Repairing invalid structured model output.

## Public interfaces

- Python: `capture_runtime.create_app`, `CaptureStructuringProvider`, `CaptureDocumentV1`,
  and `RawCaptureV1`.
- CLI: `capture-runtime serve` (loopback only).
- Handshake: `GET /v1/health/ready` reports runtime, API, schema, and capabilities.
- Runtime jobs: requirements plus create/list/get/cancel installation operations.
- Capture jobs: create/get/cancel/raw/result/delete.
- Runtime structuring: extraction is followed automatically by the configured isolated
  Ollama or deterministic fake provider.
- Host structuring: extraction stops at `awaiting_structuring`; an authenticated host may
  commit a complete candidate or record an explicit structuring failure.

All `/v1` endpoints require a Bearer token. `Host` and browser `Origin` are independently
allowlisted. All errors use `{ "error": { "code", "message", "details"? } }`.

## Key decisions

- Python 3.12, uv, FastAPI, Pydantic v2, file-backed JSON metadata, and opaque UUIDs.
- Public JSON uses camelCase and rejects unknown fields at trust boundaries.
- Idempotency identity is the client UUID plus a semantic request fingerprint. Reuse with a
  different payload is `409 idempotency_conflict`.
- Upload request bodies are copied in bounded chunks to staging and atomically moved into a job;
  the default maximum is 50 MiB. Declared `sourceKind` must match content sniffing.
- Raw/result/job metadata is retained for 24 hours. Terminal jobs delete upload bytes.
- Startup changes unfinished jobs to `failed/runtime_restarted`, preserving any raw output.
- PDF and image fake extraction emits page locators; audio emits time locators.
- Production extraction owns embedded/scanned PDF routing, safe PNG/JPEG/WebP normalization,
  WindowsML OCR, and local-only faster-whisper without importing a host package. Engine/model
  digests are derived from installed package or model bytes.
- Structured output is accepted only when schema, source, raw segments, engine provenance,
  non-empty content, locator references, and contiguous order all validate. Blocks cover every
  raw segment exactly once, in raw order, with identical locator and source text.
- Host commit, host failure, and cancel contend through an atomic compare-and-set terminal
  transition. Once one wins, no later request may mutate that terminal state.
- The system Ollama executable may be reused, but the Capture process has a dedicated host,
  app-data, model directory, PID file, profile, and owned process tree.
- Ollama application installation uses `winget` only and requires explicit consent. Missing
  `winget` produces `manual_action_required`.
- Requirement readiness is actively probed. The capture Ollama profile requires a live model
  listing with a digest; marker files are not accepted as readiness evidence.
- WindowsML model installation requires a checksum-pinned HTTPS/file release ZIP and safe
  extraction. Whisper downloads run only after consent in a cancellable subprocess; inference
  never triggers downloads.

## Failure modes

- Unsupported or oversized uploads fail before a job is created.
- Extraction failure ends the job at `failed/extraction` without raw data.
- Runtime provider or validation failure ends at `failed/structuring`; raw stays diagnostic.
- Invalid host candidates return 422 and terminate at `failed/structuring`; raw stays diagnostic.
- Cancellation is idempotent and never terminates an unowned Ollama process.

## Acceptance criteria

- The package builds and tests independently through its Nx targets and through uv.
- Authentication, Host, Origin, upload limits, and canonical error envelopes are tested.
- Capture and installation idempotency, polling, cancellation, retention, and restart
  recovery are deterministic under tests.
- PDF/image/audio fake paths produce valid provenance-bearing raw and structured results.
- Invalid JSON/order/locator/provenance cannot become a successful result.
- Runtime and host structuring modes both complete only through strict validation.
- No source file imports `cert_prep_backend` or another host package.

## Test plan

Use FastAPI `TestClient`, temporary app-data directories, deterministic engines, and an
injectable clock. No real downloads, OCR, Whisper, or Ollama are required in CI. Unit tests
cover contracts and Ollama ownership; API tests cover all public state transitions.
