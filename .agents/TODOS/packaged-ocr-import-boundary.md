# Packaged OCR import seam - Phase 1 j16 TODO

- [x] j15 installed Workbench page 1 completed with FAIL: `...native-load-paddleocr`.
- [x] Record fallback evidence, not packaging proof; Sol direct fix is blocked.
- [x] Extend only native-load by appending `-<nativeReason>-<nativeComponent>`.
  Done: native-load diagnostics in `capture_runtime/worker_stage_policy.py`.
- [x] Implement cycle-safe depth-0..3 traversal and all-node exact-code pass.
  Done: `worker_stage_policy.py`.
- [x] Apply fixed reason precedence, deeper-node ties, then strict phrase fallback.
  Done: `worker_stage_policy.py`.
- [x] Map name (deeper), while-importing token, DLL basename, then unknown.
  Done: `worker_stage_policy.py`.
- [x] Add TDD for precedence, cutoff/cycles, mappings, unknowns, and malicious inputs.
  Done: `tools/worker-stage-policy.test.ts` and runtime unit tests.
- [x] Regenerate the canonical worker-stage policy and corpus from source.
  Done: generated worker stage policy is checked by `worker-stage-policy.test.ts` in CI.
- [x] Keep non-native/legacy stages, public API, schema, and contract v1 unchanged.
  Done: contract hash unchanged across the slice (checked by `capture-runtime:check-contracts`).
- [x] Keep handwritten production+test additions at or below 100 lines.
  Done: slice landed within budget.
- [x] Run exactly one j16 installed Workbench page 1 after green.
  Done: installed Workbench practical OCR passed (published mode, 2026-09-27).
