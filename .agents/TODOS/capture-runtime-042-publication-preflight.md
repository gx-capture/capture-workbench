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
- [x] Repair LAW OCR failure privacy with sentinel regression coverage
  (LAW `2a860ae`, merged to LAW main via PR #79).
- [x] Repair production version inventory and preserve PyPI destination checks.
- [x] Correct the independently verified stale LAW fixed contract expectation
  (LAW `5dd18cd`, merged via PR #79).
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
- [x] Schedule candidate build, pre-publication checks, immutable
  publication, fresh download and published-mode practical OCR in Capture,
  then Cert and LAW. Route A (2026-09-24..27): package candidate
  `35964636948` and runtime candidate `35964853750` at `6726b6a`; package
  promotion `36288205702` (npm, Maven, PyPI inline, crates.io) and runtime
  promotion `36289842249` (GitHub release `v0.4.2`, runtime exe
  `d42b343d…`). Published-mode practical OCR passed in Capture, Cert
  (merged to Cert main, PR #21) and LAW (engine → AI service → runtime,
  `ocr_paddle`, anchors matched; merged to LAW main, PR #79).
- [x] LAW first-run install: the AI service no longer cancels a
  `windowsml-ocr` installation on its 240 s setup timeout and resumes an
  active one (LAW `2394cf7`). The runtime reports `installable` throughout
  a download, and the first GitHub download took ~9 min locally.
- [x] Full route for the desktop installer and stable pointer
  (2026-09-27): release candidate `36324039007` (`a1b8234f…`) at `6726b6a`
  reusing the Route A candidates, consumer gates `36329045296` (Cert Prep
  and LAW), release promotion `36329671186`. Registries re-verified as
  already published, the GitHub release gained the desktop installer and
  release manifest, and `release-index/stable.json` points at `v0.4.2`.
  Unblocking it needed: size budgets read from the tooling ref (the 0.4.2
  runtime grew to 69.9 MB), and consumer-gate fixes for pnpm 12 in Cert
  Prep (#22–#24) and LAW (#80, #81).

Known limitations carried by 0.4.2: handwriting OCR quality (disclosed);
slow first-run engine download from GitHub releases; the installed OCR
worker crashes when `CAPTURE_APP_DATA_DIR` makes worker paths exceed
Windows MAX_PATH (default `%LOCALAPPDATA%` roots are fine).

Analysis/commit/registry evidence is in
`%TEMP%/capture-042-release-20260921`. Read `root-user-steering.md` alongside
the original worker reports: the user changed the OCR evaluation floor after
those analysis workers started. Source/identity/cleanup safeguards remain.
