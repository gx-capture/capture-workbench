# Packaged OCR import seam - Phase 1 j16 TODO

- [x] j15 installed Workbench page 1 completed with FAIL: `...native-load-paddleocr`.
- [x] Record fallback evidence, not packaging proof; Sol direct fix is blocked.
- [ ] Extend only native-load by appending `-<nativeReason>-<nativeComponent>`.
- [ ] Implement cycle-safe depth-0..3 traversal and all-node exact-code pass.
- [ ] Apply fixed reason precedence, deeper-node ties, then strict phrase fallback.
- [ ] Map name (deeper), while-importing token, DLL basename, then unknown.
- [ ] Add TDD for precedence, cutoff/cycles, mappings, unknowns, and malicious inputs.
- [ ] Regenerate the canonical worker-stage policy and corpus from source.
- [ ] Keep non-native/legacy stages, public API, schema, and contract v1 unchanged.
- [ ] Keep handwritten production+test additions at or below 100 lines.
- [ ] Run exactly one j16 installed Workbench page 1 after green.
- [ ] On failure, select exactly one component-specific fix; on pass, continue semantic/GPU gates.
- [ ] Preserve unrelated dirty files and perform no broad rollback.
