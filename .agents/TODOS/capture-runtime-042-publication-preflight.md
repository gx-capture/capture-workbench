# Publication preflight TODO

See [SPEC](../SPECS/capture-runtime-042-publication-preflight.md) and
[decisions](../DECISIONS/capture-runtime-042-publication-preflight.md).

- [x] Commit prior work separately: Capture `2f232b9`, Cert `5959572`, LAW
  `ea6199d`; verify explicit path scopes, whitespace and clean worktrees.
- [x] Fresh producer/Cert/LAW analyses: 31m05s, 30m09s and 31m04s.
- [x] Root resolves Nx targets and verifies remaining registry occupancy.
- [x] Record user-selected JPEG and usability floor without claiming CER.
- [x] Obtain first fresh standards/specification reviews (30m20s/30m30s), both
  BLOCKED; preserve reports and incorporate their narrow amendments.
- [x] Obtain fresh review of the amended plan before implementation
  (spec 30m19s and standards 30m44s, both PASS at `439c2f0`).
- [x] Fix PyPI pre-publication manifest/identity validation and ledger reuse.
- [x] Reuse exact package-candidate Python bytes in runtime candidates.
- [ ] Repair LAW OCR failure privacy with sentinel regression coverage
  (implemented in the LAW worktree, 369 tests/0 failures; not yet committed).
- [x] Repair production version inventory and preserve PyPI destination checks.
- [ ] Correct the independently verified stale LAW fixed contract expectation
  (implemented with the LAW privacy slice; not yet committed).
- [x] Run producer promotion-registry/release-version tests through uncached
  Nx: 46/46 and 33/33, plus capture-tools lint/typecheck (2026-09-24).
- [x] Post-repair review of the producer slices. The external post-repair
  workers stopped on a usage limit; Root reviewed the diff and committed
  `4813b1e` (publication/assembly) and `466a80b` (version inventory).
- [x] Resolve the separate 0.4.2 release scope: publish with printed OCR as
  the floor and handwriting disclosed as a known limitation.
- [x] Add Capture's side-by-side practical installed OCR path
  (`build-practical-installer`, `acceptance-practical-installed`) in
  `ee9a52d`. Local rehearsal `r0924rehearsal1` (2026-09-24) passed: fresh
  first-run setup (mirrored worker, HuggingFace models), DirectML OCR of the
  canonical JPEG, runtime/worker image hashes bound, normal close, uninstall
  and variant cleanup with the ordinary installation preserved. Private
  review: all lines in order, gist readable, many handwriting word errors
  (the disclosed limitation). Rehearsal evidence is not release evidence.
- [ ] Schedule candidate build, pre-publication checks, immutable
  publication, fresh download and published-mode practical OCR in Capture,
  then Cert and LAW.

Analysis/commit/registry evidence is in
`%TEMP%/capture-042-release-20260921`. Read `root-user-steering.md` alongside
the original worker reports: the user changed the OCR evaluation floor after
those analysis workers started. Source/identity/cleanup safeguards remain.
