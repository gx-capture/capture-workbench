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

- [x] Complete the post-`3b61cef` security/protocol hardening phase: Angular
      recovered-ingestion correlation, native capture-start semantic
      validation/recovery, unterminated-final-SSE rejection, and canonical
      persistence containment.
  Verify: runtime streaming API/repository tests, Angular client/SSE tests,
      native recovery/SSE tests, probe parser tests, full Nx
      runtime/Angular/tools/workbench checks, Tauri fmt/check/test/contract/
      package QA, deterministic smoke, Playwright E2E, and `git diff --check`
      passed; the external Cert Prep/Law Prep compatibility gate remains
      unchecked.

- [x] Complete the post-`e166174` final security hardening phase: native/
      deterministic SSE EOF termination, Angular recovery abort-signal
      propagation, root/category persistence containment, and required native
      capture-start source metadata.
  Verify: runtime streaming API/repository tests, Angular client tests,
      native recovery/SSE tests, deterministic/probe parser tests, full Nx
      runtime/Angular/tools/workbench checks, Tauri fmt/check/test/contract/
      package QA, deterministic smoke, Playwright E2E, and `git diff --check`
      passed; the external Cert Prep/Law Prep compatibility gate remains
      unchecked.

- [x] Complete the post-`7909eeb` final lifecycle/security phase: Angular
      initial open-ingestion correlation/status, persistence leaf-file and
      metadata-ID containment, deterministic incomplete-final-line rejection,
      and documented bounded desktop cancellation for native upload/start.
  Verify: runtime streaming API/repository tests, Angular client tests,
      deterministic parser tests, full Nx runtime/Angular/tools/workbench
      checks, Tauri fmt/check/test/contract/package QA, deterministic smoke,
      Playwright E2E, and `git diff --check` passed; the external Cert Prep/Law
      Prep compatibility gate remains unchecked.

- [x] Complete the post-`c762e02` final lifecycle hardening phase: Angular/
      native open-status decoding, cancellation-before-id recovery, durable
      recovery correlation, initialize ordering, replay validation, and
      progressive-audio oracle EOF rejection.
  Verify: runtime streaming API/repository tests, Angular/workbench tests,
      native tests, oracle/deterministic parser tests, full Nx
      runtime/Angular/tools/workbench checks, Tauri fmt/check/test/contract/
      package QA, deterministic smoke, Playwright E2E, and `git diff --check`
      passed; the external Cert Prep/Law Prep compatibility gate remains
      unchecked.

- [x] Complete the post-`f9827bf` final bounded security/protocol phase:
      exact-once SSE size accounting, Tauri library containment, and required
      SSE frame ids.
  Verify: native/library tests, Angular SSE tests, full Nx
      runtime/Angular/tools/workbench checks, Tauri fmt/check/test/contract/
      package QA, deterministic smoke, Playwright E2E, and `git diff --check`
      passed; the external Cert Prep/Law Prep compatibility gate remains
      unchecked.

- [x] Complete the post-`8c98a32` final hardening phase: Tauri pre-mutation
      root validation and unique atomic temp writes, native source TOCTOU
      guards, replay gap/subscriber-order hardening, Angular parser caps and
      empty-later-id rejection, mandatory probe/oracle ids, and real-media
      payload identity validation.
  Verify: native/library tests, Angular/workbench tests, runtime repository
      tests, node parser/probe/oracle tests, full Nx
      runtime/Angular/tools/workbench checks, Tauri fmt/check/test/contract/
      package QA, deterministic smoke, Playwright E2E, and `git diff --check`
      passed; the external Cert Prep/Law Prep compatibility gate remains
      unchecked.

- [x] Complete the post-`5b5aa3c` final lifecycle hardening phase: native
      cancellation pending-map preservation, probe per-read deadline-timer
      cleanup, Angular UTF-8 byte line caps, record-directory symlink/alias
      rejection, startup sequence-gap quarantine, terminal-race-safe SSE
      subscription/status setup, and full v2 operation contract correlation.
  Verify: runtime streaming API/repository tests, Angular/workbench tests,
      native state/runtime-client tests, probe tests, full Nx
      runtime/Angular/tools/workbench checks, Tauri fmt/check/test/contract/
      package QA, deterministic smoke, Playwright E2E, and `git diff --check`
      passed; the external Cert Prep/Law Prep compatibility gate remains
      unchecked.

- [x] Complete the post-`59bcbf5` final lifecycle hardening phase: bounded
      native cancellation identifiers, Tauri transaction containment,
      runtime result/event completion atomicity, malformed UTF-8/payload caps,
      and terminal-after-replay SSE draining.
  Verify: runtime `346 passed, 11 skipped, 1 warning`; Angular `126 passed`;
      workbench `58 passed`; Tauri `79 passed`; package QA `215 passed, 2
      skipped`; tools `25 passed`; deterministic smoke, 4 Playwright E2E tests,
      contract checks, typechecks, lint, and `git diff --check` passed. The
      external Cert Prep/Law Prep compatibility gate remains unchecked.

## Explicitly blocked evidence

- Real engine-bearing OCR/Whisper smoke remains opt-in and depends on the
  existing approved catalog and private fixture gates. Do not synthesize
  missing fixtures or make that unrelated release gate part of ordinary P0-P6
  CI.
