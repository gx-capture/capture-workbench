# Capture Streaming SSE Migration TODO

This TODO is active-only. Completed evidence belongs in the migration spec,
decision record, and phase commits.

## Remaining implementation gate

- [x] Migrate the remaining deterministic/real smoke harnesses and probes from
      `/v1/captures` to v2, or delete obsolete v1-only probes.
  Verify: active local-source residual scan has no `/v1/captures` callers.

- [ ] Complete the known external consumer migration gate for Cert Prep and
      Law Prep before deleting deprecated `CaptureJobV1` compatibility types.
  Verify: the sibling-repo scan is clean, or an explicitly approved breaking
      release is recorded outside this repository.

- [x] Run the final verification floor and independent review of all phase
      commits, with explicit cached-path inspection before any final commit.
  Verify: Nx runtime/Angular/desktop targets, `git diff --check`, and residual
      scans pass without staging unrelated dirty changes.

- [x] Complete the post-`d3bf3de` hardening slice: canonical resync event
      identity, crash-window ingestion repair and max-upload enforcement,
      Angular runtime response identity decoders, and active SSE/reconnect
      coverage in the real Ollama smoke.
  Verify: the containing phase commit records the exact focused/full command
      results; the external Cert Prep/Law Prep compatibility gate below stays
      unchecked.

- [x] Complete the post-`1db5624` final closeout: map finalize upload-limit
      failures to HTTP 413, keep bounded consumer request IDs distinct from
      opaque runtime IDs (including dotted IDs), and fail the live reconnect
      gate when the disconnect-to-reconnect window observes a terminal race.
  Verify: runtime finalize focused test, Angular recovery test, native request
      ID test, real-Ollama smoke gate, full Nx runtime/Angular/tools/workbench
      checks, Tauri fmt/check/test/contract/package QA, deterministic smoke,
      Playwright E2E, and `git diff --check` passed; the external Cert Prep/Law
      Prep compatibility gate remains unchecked.

- [x] Complete the post-`695567b` ingestion open-recovery phase: add a runtime
      by-client-request ingestion lookup and Angular/native lost-open-response
      recovery, with the existing bounded expiry/prune documented as the orphan
      backstop.
  Verify: runtime streaming API/repository tests, Angular recovery tests,
      native recovery tests, full Nx runtime/Angular/tools/workbench checks,
      Tauri fmt/check/test/contract/package QA, deterministic smoke, Playwright
      E2E, and `git diff --check` passed; the external Cert Prep/Law Prep
      compatibility gate remains unchecked.

- [x] Complete the post-`9e6e2b3` final hardening phase: native open-ingestion
      semantic-2xx recovery, same-bounded-id ingestion requests, v2
      status/stage mapping in real-media-model-smoke, and authoritative
      source-kind rejection.
  Verify: runtime streaming API/repository tests, Angular client tests, native
      recovery tests, real-media-model-smoke/probe tests, full Nx
      runtime/Angular/tools/workbench checks, Tauri fmt/check/test/contract/
      package QA, deterministic smoke, Playwright E2E, and `git diff --check`
      passed; the external Cert Prep/Law Prep compatibility gate remains
      unchecked.

## Explicitly blocked evidence

- Real engine-bearing OCR/Whisper smoke remains opt-in and depends on the
  existing approved catalog and private fixture gates. Do not synthesize
  missing fixtures or make that unrelated release gate part of ordinary P0-P6
  CI.
