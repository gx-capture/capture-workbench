# Public R3 closeout TODO

See [SPEC](../SPECS/capture-runtime-042-r3-closeout.md) and
[decisions](../DECISIONS/capture-runtime-042-r3-closeout.md). This is a bounded
implementation checkpoint, not a replacement for the D0-D8 release checklist.

- [x] Fresh workers analyze the three repos and record current HEAD/dirty scope.
- [x] Run the initial launcher suite uncached: 311 passed, 2 failed; public
  integration tests were not reached after the library failure.
- [x] Fresh standards and specification reviewers assess the dirty R3 scope.
  Both recommend scoped repairs; findings are recorded in the SPEC. Formal
  D1 and release gates remain unchanged.
- [x] Repair confirmed defects with regression coverage, preserving prior work.
- [x] Allow fresh durable-state and fixture analysts at least 30 minutes;
  actual windows were 30m40s and 30m55s with unchanged HEAD/source hashes.
- [x] Root applies grill-me to the proposals and records the user's required
  bounded-concurrency gate in the decision record before scheduling repairs.
- [x] Confirm adopted candidates before later fallible work; preserve pending
  candidates through prewrite errors and reject confirmed predecessor replay.
- [x] Repair test-only admission and observer ordering without weakening
  deadlines, internal concurrency, typed failures or cleanup assertions.
- [x] Run `corepack pnpm nx run capture-sidecar-launcher:cargo-fmt-check --skip-nx-cache`.
- [x] Run `corepack pnpm nx run capture-sidecar-launcher:cargo-check --skip-nx-cache`.
- [x] Run `corepack pnpm nx run capture-sidecar-launcher:cargo-fixture-test --skip-nx-cache`.
- [x] Run `corepack pnpm nx run capture-sidecar-launcher:cargo-test --skip-nx-cache`.
  Require three predeclared complete runs at the selected bounded concurrency;
  no overlapping independent native suites and no retry-until-green.
- [x] Run `corepack pnpm nx run capture-workbench-desktop:cargo-check --skip-nx-cache`.
- [x] Run `corepack pnpm nx run capture-workbench-desktop:cargo-test --skip-nx-cache`.
- [x] Obtain fresh post-repair review and resolve blockers.
- [x] Update the three repo checkpoints with actual results and remaining
  producer/SDK/candidate dependencies; verify diff scope and whitespace.

No commit, candidate, installed OCR, publication, download-back or stable
pointer success is implied by this checklist.

## Local verification record (2026-09-21)

The first declared four-thread series A stopped at run 1: 322 library and
7 API tests passed, but lifecycle observation failed (11/12 public tests).
An additional fixture regression deterministically reproduced an accepted
nonblocking socket returning before request bytes arrived. Setting that
accepted stream to blocking mode preserves its socket timeouts and absolute
deadline. This proves the fixture defect; old logs do not establish it as
the exact cause of every historical readiness failure.

After this source repair, declared series B passed all three complete,
uncached standard Nx runs with `RUST_TEST_THREADS=4` from the target config.
Each passed 322 library, 7 API and 12 public lifecycle tests, with none
filtered out in those complete suites. The 18-file source/config hash set
was unchanged. Fixture tests passed 33/33; launcher format/check and desktop
compile plus 53 tests passed. Root observed no remaining activation-probe
process after the suites. Fresh independent durable-state and concurrency/
fixture reviews found no blocking defects. Their UTC windows were
06:46:52-07:17:09 (30m17s) and 06:46:51-07:17:41 (30m50s), respectively.
Root accepts this bounded local repair; the formal D0-D8 gates remain unchanged.

Evidence is retained under `%TEMP%/capture-042-20260921`: the series A/B
declarations, hashes and run logs, socket RED/GREEN logs,
`finalfix-implementation.md`, `final-desktop-{check,test}.log`, and
`final-review-{state,fixture}.md`. Both reviews bind the same 18-file manifest,
whose SHA-256 is
`D81F948C19D81F0AB170CD2ED0CCED912B300A06CBC69B52BE7D8B1B600C898B`.
Only Root-owned documentation changed during review; source/config did not.
Serial and isolated passing runs remain diagnostic only. These results
establish neither unbounded concurrency nor installed/release acceptance.
