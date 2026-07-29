# Standalone Desktop Merge Hardening

## Purpose

Make the standalone Windows desktop capture flow responsive, cancellation-safe,
and durable before it replaces PR #4.

## Non-goals

- No public `/v1`, package, or `CaptureDocumentV1` changes.
- No bearer token in renderer IPC, logs, reports, or library files.
- No native file picker or binary/streaming IPC migration.
- No broad store/component split, typed runtime DTO migration, or smoke-helper
  extraction.
- No DirectML dependency or provider change in this branch.

## Private interfaces

- Library status adds `persisting` and `recovery_required`.
- `LibraryCaptureUpdate` adds `clearCaptureId?: boolean`.
- `captureId` sets or replaces an ID; `clearCaptureId: true` clears it; omitting
  both preserves it. Supplying both is invalid.
- `retry(documentId)` recovers the retained runtime job for
  `recovery_required`; all other retryable documents start a new runtime job.
- Renderer source inputs accept only PDF, PNG, JPEG, WAV, MP3, and MP4 MIME
  values, with byte length `1..=50 MiB`.

## Capture lifecycle

```text
queued
  -> processing (runtime create)
  -> processing + captureId (immediate durable link)
  -> persisting (terminal runtime response)
  -> completed | failed | canceled (terminal data committed)
  -> runtime DELETE
  -> terminal status + cleared captureId
```

Any terminal retrieval, library commit, or non-404 cleanup failure moves to
`recovery_required` and retains `captureId`. Recovery queries that same job ID,
settles its current terminal state, and retries cleanup. If runtime cleanup
returns 404, recovery treats the job as already deleted and clears the link.

Cancellation requested before create completes is remembered. Once the ID is
durably linked, exactly one unaffiliated cancel request is sent. Its returned job
is authoritative: a completion that won the race is persisted as completed.
Cancel-request failure moves to recovery without deleting the runtime job.

## Tauri execution

Commands that call `LibraryStore` or `runtime_client` clone managed state into a
`spawn_blocking` closure and map task-join failure to a redacted desktop error.
`desktop_runtime_status` remains a short synchronous mutex read.

## Failure modes

- Invalid renderer file: reject before `arrayBuffer()` and before `invoke()`.
- Runtime create succeeds but local ID persistence fails: do not delete; retain
  the best available link and report recovery failure.
- Terminal raw/result retrieval fails: do not delete.
- Terminal library commit fails: do not delete.
- Runtime DELETE returns 404: clear the local link as idempotent success.
- Runtime DELETE otherwise fails: retain the link and expose retryable recovery.
- A fresh packaged one-file sidecar may need longer than one minute for its
  first extraction; product readiness and the real smoke allow 180 seconds,
  while explicit `failed` or `stopped` states still fail immediately.

## Acceptance criteria

- Main-thread Tauri commands perform no blocking runtime or library I/O.
- Cancellation is sent once with a non-aborted request, including
  create-before-cancel and completion/cancellation races.
- Runtime jobs are deleted only after a successful terminal local commit.
- Recovery uses the original capture ID and never creates a replacement job.
- Invalid/oversized files allocate no source buffer and invoke no native command.
- Ready UI messaging and Playwright reference flow are green.
- Duplicate `build-nsis-release` is removed and no tracked caller remains.

## Test plan

- Angular store tests cover cancellation timing, send-once, request failure,
  terminal races, immediate-completion linkage, persistence failures, same-ID
  recovery, cleanup 404, and cleanup failure.
- Renderer source tests cover six allowed MIME values, empty, exact 50 MiB,
  oversized, WebP, and OGG inputs, including no `arrayBuffer`/invoke assertions.
- Rust library/runtime tests cover clear-ID semantics, status validation, source
  limits, MIME allowlist, and DELETE 404 mapping.
- Run focused and full Nx targets, deterministic smoke, Playwright E2E, and the
  tracked real-PDF standalone OCR smoke from standard host AppData.

## Verification evidence (2026-07-29)

- `capture-workbench:test`: 4 files, 28 tests passed.
- `capture-angular:test`: 8 files, 55 tests passed.
- Native desktop tests: 27 passed; package QA tests: 34 passed.
- Capture Runtime: Ruff, mypy, build, and 70 tests passed.
- Deterministic desktop smoke and Playwright reference flow (3 tests) passed.
- `capture-workbench-desktop:smoke-real-desktop-ocr` passed from a fresh
  production sidecar/Tauri build, using the tracked real PDF and the standard
  Tauri host AppData. Its redacted report records real engines, visible OCR,
  isolated Ollama provenance, and post-verification document deletion.
