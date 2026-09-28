# Checklist
- [x] Enforce ordered child journal and parent-only terminalization.
  Done: `tools/acceptance-checkpoint-journal.ts` with `tools/acceptance-checkpoint-journal.test.ts` (232d6ea).
- [x] Preserve readable manifest hashes and validate physical OCR proof.
  Done: `tools/acceptance-contract.ts:readOcrExecutionProof`; manifest checks in `acceptance-orchestration.test.ts`.
- [x] Keep cleanup exact, typed, and fail closed; preserve baseline processes.
  Done: `tools/three-project-cleanup-verifier.test.ts` and the cleanup cases in `acceptance-orchestration.test.ts`.
- [x] Test pass, stage/OCR/manifest/cleanup failures, malformed journal, and publication failure.
  Done: covered by `capture-workbench-desktop:package-qa-test` in CI.
- [x] Run focused tests and `typecheck-scripts --skip-nx-cache` before handoff.
  Done: `typecheck-scripts` is a dependency of the desktop QA targets run in CI.
