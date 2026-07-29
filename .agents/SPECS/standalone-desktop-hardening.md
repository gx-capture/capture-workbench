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
- Terminal `errorCode`/`errorMessage` remain distinct from
  `recoveryCode`/`recoveryMessage`, so cleanup failures cannot overwrite failed
  or canceled runtime evidence.
- `captureId` sets or replaces an ID; `clearCaptureId: true` clears it; omitting
  both preserves it. Supplying both is invalid.
- `retry(documentId)` always reuses a retained runtime job. Nonterminal
  documents query that job; documents with committed terminal data retry only
  cleanup. A new job is created only when no runtime ID is retained.
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
After an app restart, `processing`/`persisting` documents resume the retained
job, while terminal documents with a retained ID perform cleanup only.

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
- Canceled raw retrieval is optional only when the runtime returns the defined
  409/no-raw response; a transport failure does not delete the job.
- Terminal library commit fails: do not delete.
- Runtime DELETE returns 404: clear the local link as idempotent success.
- Runtime DELETE otherwise fails: retain the link and expose retryable recovery
  without replacing the original failed/canceled error evidence.
- If cleanup succeeds but clearing the local runtime link fails, every nested
  fallback remains phase-aware: it preserves terminal evidence and records
  cleanup-only recovery. If all writes fail, the prior committed terminal
  record remains authoritative and is cleanup-only after restart.
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
  restart recovery, canceled raw durability, cleanup 404, and cleanup failure
  with preserved terminal evidence, including double local-write failures.
- Renderer source tests cover six allowed MIME values, empty, exact 50 MiB,
  oversized, WebP, and OGG inputs, including no `arrayBuffer`/invoke assertions.
- Rust library/runtime tests cover clear-ID semantics, status validation, source
  limits, MIME allowlist, and DELETE 404 mapping.
- Run focused and full Nx targets, deterministic smoke, Playwright E2E, and the
  tracked real-PDF standalone OCR smoke from standard host AppData.

## Verification evidence (2026-07-29)

- `capture-workbench:test`: 4 files, 41 tests passed.
- `capture-angular:test`: 8 files, 55 tests passed.
- Native desktop tests: 27 passed; package QA tests: 34 passed.
- Capture Runtime: Ruff, mypy, build, and 70 tests passed.
- Deterministic desktop smoke and Playwright reference flow (3 tests) passed.
- `capture-workbench-desktop:smoke-real-desktop-ocr` passed from a fresh
  production sidecar/Tauri build, using the tracked real PDF and the standard
  Tauri host AppData. Its redacted report records real engines, visible OCR,
  isolated Ollama provenance, and post-verification document deletion.
