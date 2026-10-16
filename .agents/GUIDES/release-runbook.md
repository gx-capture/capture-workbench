# Capture Workbench release runbook

Current as of 2026-10-07. This is the operational procedure for publishing a
Capture Workbench release and moving its consumers. It reflects how 0.5.0 was
actually shipped (0.5.1 followed the same steps); workflow files remain the source of truth for inputs.

## Current state

- Capture Runtime and Workbench **0.5.1** are published: npm
  (`@gx-capture/capture-workbench-ui`, `@gx-capture/capture-runtime-client` on
  GitHub Packages), Maven (`com.gx.capture:capture-runtime-client`, GitHub
  Packages), PyPI (`capture-runtime-client`), crates.io
  (`capture-sidecar-launcher`), and GitHub release `v0.5.1` (runtime exe
  `8a5c3b2e…`, OCR/Whisper engine zips, desktop installer, release manifest).
  `release-index/stable.json` on the `release-index` branch points at `v0.5.1`.
- Source commit of the 0.5.1 candidates: `1fa4924` (merge of PR #71).
  Contract-set SHA-256:
  `f72e22229bbc726f1feff4c8ea99ab7e68c64dfa893b038bb731a99255b6495c`.
  Model-source Commit A `cad865f` (annotated tag
  `capture-runtime-model-sources-v0.5.1`). OCR profile
  `capture-workbench-ocr-1dc18ff680549aa9`.
  Runs: package candidate 37559860991, runtime candidate 37560144704, package
  promote 37561007340, runtime promote 37561498532, release candidate
  37562803807, consumer gates 37565455444, release promote 37566342753.
- 0.5.1 sends a vertical page to the NDLOCR-Lite reader only when the page has
  kana; 0.5.0 sent vertical Chinese there too and read it worse. A 0.5.1 runtime
  needs 0.5.1 clients: the contract set carries the release version, so its hash
  changes with every release, and the OCR profile id changed with the rule.
- Consumers on their `main` branches pin 0.5.1: Cert Prep
  (`WodenWang820118/cert-prep`, PR #39) and LAW
  (`WodenWang820118/gx.law-prep`, PR #98). Both consumer gates passed on the
  release candidate. The published-mode practical OCR journeys passed on
  2026-10-07 before the consumer merges: Cert Prep's packaged app with the
  canonical JPEG, and LAW's engine, AI service and runtime with the canonical
  JPEG and page 1 of the private PDF.
- The online-package PDF OCR E2E was last run against published 0.5.0 (ten-page
  development PDF, ten anchors, four on pages read by the vertical reader); it
  was not repeated for 0.5.1.
- The OCR engine now also installs the NDLOCR-Lite models (about 157 MB from
  `raw.githubusercontent.com/ndl-lab/ndlocr-lite` at a pinned commit, no mirror).
  **Open**: the licence lineage of its line detector's weights; see
  `.agents/RESEARCH/ndlocr-lite-detector-licence-lineage-2026-10-06.md`.
- Known limitations: handwriting OCR quality (printed text is the floor);
  installed OCR worker paths beyond Windows MAX_PATH crash the worker; page
  structure of dense vertical periodical scans and pages that mix directions;
  about a fifth of furigana on textbook pages is not set aside.

## Published: 0.6.3 (patch, Route A then full route)

- Published on 2026-10-16 through Route A only, like 0.6.2: npm, Maven,
  PyPI, crates.io and GitHub release `v0.6.3` (runtime exe `3b96746c…`, OCR,
  rebuilt Whisper and diarization engine zips). `release-index/stable.json`
  still points at `v0.5.1`, and no desktop installer is published for 0.6.x.
- Fixes the two transcription defects the 0.6.2 consumer checks found
  (PR #96): Whisper's voice activity filter kept a click as speech, so a
  silent window yielded "You" and, with speakers, a word was timed at 0:00.
  The filter now ignores sounds shorter than 250 ms. Verified before release
  in a packaged Whisper engine installed through the runtime's install path.
- Compatible with 0.6.x clients. Contract-set SHA-256 unchanged
  (`fc8a994e…`). Model-source Commit A `d16effb` (annotated tag
  `capture-runtime-model-sources-v0.6.3`). OCR profile
  `capture-workbench-ocr-1f5dcb0f58337c71`. Source commit `2a117cc` (merge
  of PR #97).
- Runs: package candidate 38711240238, runtime candidate 38711539283
  (`model-enabled`), package promote 38830211377, runtime promote
  38830349779 (`registries`: crate, PyPI, tag and GitHub release). Consumer
  gates and the full publish were not run, for the reason given under 0.6.1.
- The runtime candidate artifact is about 620 MB; `gh run download` failed
  on dropped connections. A resumable download of the artifact's signed URL
  (fresh URL per resume) worked.
- Consumers moved: Cert Prep PR #43 and LAW PR #117. Each was checked against
  the published runtime (CUDA), and all runs passed:
  - Capture directly: the 40-minute phone interview 3 times (675 to 682
    segments, about 2 minutes each) and once with speakers (1033 seconds); no
    text before the first speech at 3:07, and the first word with speakers at
    4:42.93 with a speaker.
  - Cert Prep, through its backend Capture adapter: a PDF page, a JPEG and a
    short Chinese recording, 10 times each; then the interview 3 times.
  - LAW, through its engine and AI service: the PDF and JPEG 10 times each;
    the interview 3 times (83-84 lines from 3:07) and once with speakers
    (992 seconds).
  - No hallucination-like text ("You", "Thank you", subscribe or subtitle
    outros) in any saved output.
- Release candidate 38842806012 passed (candidate `792c521c…`, manifest
  `9feca0b1…`, contract impact `breaking` against 0.5.1), including the
  model-enabled runtime and Windows install verification. Both consumer
  gates passed a local full pre-run (2026-10-16): Cert Prep on `main`
  (`8ff4ef0`, 8 checks) and LAW on `feat/legal-ontology-hybrid` (`f4db1a7`,
  9 checks). LAW then merged `feat/legal-ontology-hybrid` into `main`
  (PR #118, `c3a7bdf`, tree identical to `f4db1a7`), so LAW `main` carries
  0.6.3. Consumer gates run 38846795348 passed (ledger verdict `passed`):
  Cert Prep run 38846826555 on `8ff4ef0` and LAW run 38847285881 on
  `c3a7bdf`.
- Full publish: release-promote run 38849532005 (`publication_scope=all`)
  passed every job: registries re-verified, tag, GitHub release with the
  desktop installer `Capture.Workbench_0.6.3_x64-setup.exe` (26 assets),
  stable pointer and promotion ledger. The pointer lives on the protected
  `release-index` branch, not `main`: `836ced2` points stable at `v0.6.3`
  with manifest `7154f54d…`, which matches the published
  `capture-release-manifest-v1.json`.

## Published through Route A: 0.6.2 (patch)

- Published on 2026-10-15 through Route A only, like 0.6.1: npm, Maven,
  PyPI, crates.io and GitHub release `v0.6.2` (runtime exe `82ea45a2…`, OCR,
  rebuilt Whisper and diarization engine zips). `release-index/stable.json`
  still points at `v0.5.1`, and no desktop installer is published for 0.6.x.
- Fixes recording transcription (PR #93):
  - The progressive decoder kept frame padding.
  - A silent first five minutes failed a capture.
  - Overlapping windows doubled sentences.
  - Speaker runs had a fixed 15-minute limit.
  - It also accepts any recording FFmpeg decodes, and Capture Workbench
    shows a transcript beside its recording.
  - The window merging and the checkpoint rule run in the Whisper worker,
    so the runtime candidate rebuilt `capture-engine-whisper`.
- Compatible with 0.6.x clients. Contract-set SHA-256 unchanged
  (`fc8a994e…`). Model-source Commit A `abe8b55` (annotated tag
  `capture-runtime-model-sources-v0.6.2`). OCR profile
  `capture-workbench-ocr-5b63d123f524e4b1`. Source commit `251cdb9` (merge
  of PR #94).
- Runs: package candidate 38684265560, runtime candidate 38684516941
  (`model-enabled`), package promote 38686114774, runtime promote
  38686311532 (`registries`: crate, PyPI, tag and GitHub release). Consumer
  gates and the full publish were not run, for the reason given under 0.6.1.
- Consumers moved: Cert Prep PR #43 and LAW PR #117 (LAW's recording
  transcription, on `feat/legal-ontology-hybrid`). Each was checked against
  the published runtime (CUDA), and all runs passed:
  - Cert Prep, through its backend Capture adapter: a PDF page, a JPEG and a
    short Chinese recording, 10 times each; then a 40-minute phone interview
    (M4A) 3 times, with 677 to 687 segments in 104 to 110 seconds.
  - LAW, through its engine and AI service: the PDF and JPEG 10 times each;
    the interview 3 times (82 lines, 115 to 124 seconds) and once with
    speakers (996 seconds; on 0.6.0 the whole interview with speakers failed
    at the 15-minute limit).
- Still open from those checks:
  - A silent opening yields a hallucinated "You" at 0:00.
  - With speakers, one word comes back at 0:00 without a speaker, though it
    was spoken near 4:43.

## Published through Route A: 0.6.1 (patch)

- Published on 2026-10-14 through Route A only, like 0.6.0: npm, Maven,
  PyPI, crates.io and GitHub release `v0.6.1` (runtime exe `6b9f33f4…`, OCR,
  Whisper and diarization engine zips). `release-index/stable.json` still
  points at `v0.5.1`, and no desktop installer is published for 0.6.x.
- One fix: each OCR model profiles under its own ONNX Runtime prefix, so GPU
  OCR no longer fails about half the time with `ocr_worker_failed` (PR #90).
- Clients still require the exact runtime version, so consumers move to 0.6.1
  clients; the contract-set SHA-256 is unchanged (`fc8a994e…`). Model-source
  Commit A `10524f9` (annotated tag `capture-runtime-model-sources-v0.6.1`).
  OCR profile `capture-workbench-ocr-be5a35092b5cc3be`. Source commit
  `90b386f` (merge of PR #91).
- Runs: package candidate 38558758781, runtime candidate 38559118888 (both
  `model-enabled`), package promote 38561146766, runtime promote 38561502678
  (`github-release`) then 38562351390 (`registries`, which publishes PyPI and
  the crate; use `registries` the first time). Release candidate 38567018276
  passed; consumer gates and the full publish were not run.
- Consumers moved: Cert Prep `main` (PR #42) and LAW
  `feat/legal-ontology-hybrid` (PR #116). Before merging, each ran OCR (a PDF
  page and a JPEG) and ASR (a short Chinese recording) 10 times in a row
  against the published runtime, and all runs passed. Cert Prep went through
  its backend Capture adapter and LAW through its AI service OCR endpoint;
  LAW has no ASR path yet, so its ASR runs went straight to the runtime.
- Why the full route stopped: a release candidate's contract impact is
  measured against the stable pointer (0.5.1), so 0.6.x is `breaking` and the
  LAW gate is required. The gate runs on LAW `main`, which still pins 0.5.1;
  LAW's 0.6.x adoption lives on `feat/legal-ontology-hybrid`. Move the stable
  pointer once LAW `main` carries 0.6.x.
- Observed: an audio capture's event stream reports `completed` about half a
  second before `GET /v2/captures/{id}` does, and `get_raw` answers
  `raw_unavailable` in between. Poll the operation before reading results.

## Published through Route A: 0.6.0

- Published on 2026-10-14 through Route A only (no consumer gates, desktop
  installer or stable pointer). The notes below describe how it was prepared.
- Incompatible with 0.5.x. Contract-set SHA-256
  `fc8a994e5a2a822376821da277e949eb203df9223977da4db4cdc7ab29724523`; the set no
  longer carries the release version, so the version bump did not change it.
- Model-source Commit A `99bfd21` (annotated tag
  `capture-runtime-model-sources-v0.6.0`). OCR profile
  `capture-workbench-ocr-09c2568f8a130abe`: the profile still carries the
  release version, so its id changes with every release.
- The lock has four units: `windowsml-ocr`, `whisper-primary`, and the optional
  `speaker-diarization` (worker archive about 272 MB, models from
  `gx-capture/capture-model-sources`) and `vertical-japanese-reader` (models
  only, no worker archive).
- Checked locally: the release engine catalog generates from the real worker
  archives. Not yet exercised anywhere: the candidate and promote workflows with
  four units, installing the optional units from a published release, and the
  consumer gates. Cert Prep and LAW still pin 0.5.1.

## Workflow map

| Stage             | Workflow                                          | Produces                                                            |
| ----------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| Package candidate | `package-candidate.yml`                           | npm/Maven/PyPI/crate candidate bytes                                |
| Runtime candidate | `runtime-candidate.yml`                           | runtime exe, engine zips, catalog                                   |
| Route A publish   | `package-promote.yml`, then `runtime-promote.yml` | registries, runtime seed GitHub release                             |
| Release candidate | `release-candidate.yml`                           | desktop installer + full candidate                                  |
| Consumer gates    | `consumer-gates.yml`                              | dispatches Cert/LAW gates, gate ledger                              |
| Full publish      | `release-promote.yml`                             | re-verified registries, tag, desktop assets, stable pointer, ledger |

Route A alone publishes the libraries and runtime. The full route reuses the
Route A candidate runs at the same source commit and is required for the
desktop installer and the stable pointer. Every publish step is idempotent:
npm/crates/Maven compare remote bytes, PyPI uses `skip-existing`, and
`tools/create-github-release.ts` keeps runtime seed assets and uploads only
missing ones.

## Procedure

1. Merge the release source to `main` and wait for **push** CI on that commit
   (`ci.yml`). Release candidates verify it with `tools/verify-main-ci.ts`.
2. Dispatch `package-candidate.yml` and `runtime-candidate.yml` for the exact
   commit. Record each run ID, `candidateId`, and the SHA-256 of its
   `candidate-manifest.json` (download the small package artifact; the runtime
   manifest hash is also printed in promotion logs).
3. Route A: dispatch `package-promote.yml`, then `runtime-promote.yml`. The
   runtime promotion requires a successful `workflow_dispatch` package promotion
   on `main` whose commit contains the candidate source.
4. Migrate consumers (pins, locks, generated clients), run their CI and a
   published-mode practical OCR check, and merge them to `main` (Cert Prep
   first, then LAW).
5. Dispatch `release-candidate.yml` with the Route A inputs and the
   `release_mode` recorded in the runtime candidate manifest
   (`model-enabled` for 0.5.0). Record the run ID, `candidateId`, and the
   `candidate-manifest.json` hash from artifact
   `capture-candidate-<version>-<run>`.
6. Pre-run both consumer gates locally against the downloaded release
   candidate before dispatching (see below), then dispatch
   `consumer-gates.yml`.
7. Dispatch `release-promote.yml` with `publication_scope=all`, the release
   candidate, Route A candidates, the consumer gate run ID, and the contract-set
   hash. Verify `gh release view v<version>` and `release-index/stable.json`.

## Consumer gate pre-run

The gates run rarely and drift with toolchain upgrades; each CI round-trip
costs about 20 minutes. From each consumer checkout on `main`:

```sh
# Cert Prep (use a scratch worktree: the full check installs the candidate)
node tools/capture-candidate-gate.mts --candidate <rc-dir> --candidate-id <id> \
  --candidate-manifest-sha256 <sha> --source-commit <sha> --release-version <v> \
  --workflow-run-id 1 --output <out.json> --skip-checks
# LAW (Nx targets are the same ones LAW CI runs)
node tools/capture-contract-gate.mts --candidate <rc-dir> ... \
  --contract-classification <from rc contract-impact.json> --skip-checks
```

Drop `--skip-checks` for the full run. For Cert Prep, first install the
candidate with `node tools/install-capture-workbench-dependencies.mts
--candidate-package-dir <rc-dir>/package` and set
`CAPTURE_CANDIDATE_INSTALL=1`.

## Pitfalls already fixed (keep them fixed)

- Size budgets come from the tooling ref. Re-baseline
  `packages/capture-runtime/size-budgets/*` and the measurement evidence file
  (budget = measured bytes plus `headroomBasisPoints`) when the runtime grows.
- PyPI Trusted Publishing binds the top-level workflow: uploads stay inline in
  `package-promote.yml` and `release-promote.yml`. `_publish-pypi.yml` only
  verifies and has no Trusted Publisher entry on pypi.org; do not re-add one.
- Consumer gate workflows pin `pnpm/action-setup@f40ffcd9…`; `b0f76dfb`
  installs a broken pnpm v11 shim. Gate check steps need GitHub Packages auth
  because pnpm 12 re-verifies `@gx-capture` lockfile entries.
- pnpm 12 rejects `pnpm install --lockfile=false`.
- GitHub Packages npm and Maven need a token even for public packages.
- Launcher `cargo test` runs through `tools/cargo-test-retry-failed.ts`.
- Local practical OCR runs: keep `CAPTURE_APP_DATA_DIR` short (installed OCR
  worker paths beyond Windows MAX_PATH crash the worker) and set `CAPTURE_PORT`
  together with `--port`, or the allowed-host check rejects requests.
- PyPI's JSON API can lag an upload by minutes; the post-publish readback
  retries a 404 for about five minutes before failing. The simple index lags
  too: the clean-install check after the upload retries for about ten minutes
  (in 0.5.1 it failed three times within four minutes of the upload).
- Consumer migrations: bump only exact version tokens (never `10.4.2` or other
  packages' `0.4.2` in lock files), move tests that use the new version as a
  "wrong" value to `99.0.0` first, and let each package manager update its
  own lock. If `pnpm install` re-resolves unrelated peers (LAW), change only the
  `@gx-capture` lock entries and verify with `pnpm install --frozen-lockfile`.
  Regenerate consumer contract artifacts (LAW `law-contracts-generate`) and
  recompute pinned receipt digests from their canonical bytes.
- Cert Prep pins its `minimumReleaseAgeExclude` entries to exact
  `@gx-capture` versions. When the previous release is less than about a day
  old, `pnpm install` rejects the old lock entries before it can re-resolve;
  move only the two `@gx-capture` lock entries (integrity and tarball from
  GitHub Packages) and verify with `pnpm install --frozen-lockfile`.
- A version bump needs a new model-source snapshot before the lock can follow:
  set the version in `scripts/generate_commit_a_fixtures.py`, regenerate, commit
  only `model-sources/commit-a/` (Commit A), push it with the annotated tag
  `capture-runtime-model-sources-v<version>`, then put its SHA in
  `COMMIT_A_SHA` and the lock, recompute the digests of the first-party files
  from the committed bytes, and copy `commit-a/model/pipeline.json` to
  `src/capture_runtime/assets/ocr-profile.json`. The lock's approval record
  changes only with the owner's consent.
- Version management has two stages: ordinary source/tests reference a scoped
  owner, then code updates the explicit owner/native metadata list. Preview with
  `pnpm nx run capture-tools:release-version-plan --args="--version <version>"` and apply
  with `pnpm nx run capture-tools:release-version-sync --args="--version <version>"`.
  `release/version.json` is the release intent; package metadata and packaged
  Python constants are explicit mirrors. The updater never scans/replaces the
  tree, rewrites locks, or approves model provenance and contract hashes.
  Its `followUp` lists package-manager lock refresh, model-source approval and
  existing contract/engine/profile generators. After those steps, run
  `pnpm nx run capture-tools:release-version-check`; this validates source,
  generated identities, local Cargo/uv lock versions and the existing inventory.
  Passing this check is not candidate publication or installed acceptance.
  Keep negative versions and historical byte/digest evidence independent;
  ordinary current-version fixtures reference the scoped shared constant.
- Every pull request runs full CI, docs-only ones included; a docs-only skip
  once let `main` go red for three merges. Tests never assert documentation
  prose, so docs edits alone cannot fail CI.
- Engine downloads are served from the machine-wide cache
  (`%LOCALAPPDATA%\gx-capture\engine-cache`) once any host has installed
  them. Set `CAPTURE_ENGINE_CACHE_DIR=off` to time or debug a cold download.
- A minor version bump also needs `CAPTURE_RUNTIME_MINOR` in
  `packages/capture-workbench-ui/src/lib/constants/runtime.ts`; the version sync
  and its check do not own it, and `capture-angular:test` is what fails.
- Local `build-release-artifacts` after a version bump: delete the previous
  version's files from `packages/capture-runtime/dist/engines` and run with
  `--skip-nx-cache`, or the cache restores them and the catalog step rejects them.
  The ignored `src-tauri/resources/capture-runtime-manifest.json` is re-staged by
  `capture-workbench-desktop:stage-core-runtime`.
- Pin upstream model and configuration digests from git blobs or a real download,
  never from a checkout with `autocrlf`: text files there are CRLF copies.
- `capture-tools:promotion-registry-test` fails under Git Bash on Windows (its
  `tar` reads `C:` as a remote host); run it from PowerShell.
- Consumer migrations in a fresh worktree: Nx can hang or pick the wrong
  workspace unless `NX_WORKSPACE_ROOT_PATH` is unset and `NX_DAEMON=false`.
  LAW's pre-commit builds the Java engine (fetch the new SDK into `~/.m2` with a
  temporary Maven settings file that reads `MAVEN_USERNAME`/`MAVEN_PASSWORD`) and
  runs `cargo check` (create the sidecar placeholder with
  `tauri:prepare-sidecar-placeholder` and `resources/.ci-placeholder` as CI
  does). GitHub Packages npm auth for a local `pnpm install`: a temporary
  `NPM_CONFIG_USERCONFIG` file, deleted afterwards.
- Consumer tests that quote the client's runtime minor (`runtime minor 4`) fail
  on a minor bump; LAW's `test_startup_timeout_waits_for_owner_cleanup` is
  timing-sensitive and failed once in CI on an unrelated change.
