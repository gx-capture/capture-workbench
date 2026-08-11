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

- [ ] Run the final verification floor and independent review of all phase
      commits, with explicit cached-path inspection before any final commit.
  Verify: Nx runtime/Angular/desktop targets, `git diff --check`, and residual
      scans pass without staging unrelated dirty changes.

## Explicitly blocked evidence

- Real engine-bearing OCR/Whisper smoke remains opt-in and depends on the
  existing approved catalog and private fixture gates. Do not synthesize
  missing fixtures or make that unrelated release gate part of ordinary P0-P5
  CI.
