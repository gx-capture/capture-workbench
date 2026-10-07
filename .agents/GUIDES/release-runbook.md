# Capture Workbench release runbook

Current as of 2026-10-06. This is the operational procedure for publishing a
Capture Workbench release and moving its consumers. It reflects how 0.5.0 was
actually shipped; workflow files remain the source of truth for inputs.

## Current state

- Capture Runtime and Workbench **0.5.0** are published: npm
  (`@gx-capture/capture-workbench-ui`, `@gx-capture/capture-runtime-client` on
  GitHub Packages), Maven (`com.gx.capture:capture-runtime-client`, GitHub
  Packages), PyPI (`capture-runtime-client`), crates.io
  (`capture-sidecar-launcher`), and GitHub release `v0.5.0` (runtime exe
  `d3d02225…`, OCR/Whisper engine zips, desktop installer, release manifest).
  `release-index/stable.json` on the `release-index` branch points at `v0.5.0`.
- Source commit of the 0.5.0 candidates: `af281e3` (merge of PR #69).
  Contract-set SHA-256:
  `4c63044191551bf3f7c36d24d08cc6ced25fcc701bf1e06a0fa69626b1e18f1b`.
  Model-source Commit A `8f37898` (annotated tag
  `capture-runtime-model-sources-v0.5.0`). OCR profile
  `capture-workbench-ocr-1c6be4a3cebc2b21`.
  Runs: package candidate 37424340590, runtime candidate 37424600408, package
  promote 37425756166, runtime promote 37425994410, release candidate
  37431071882, consumer gates 37433360334, release promote 37434317020.
- 0.5.0 is not compatible with 0.4.x: 0.x clients require the same minor
  version, and the contract-set hash and OCR profile id changed.
- Consumers on their `main` branches pin 0.5.0: Cert Prep
  (`WodenWang820118/cert-prep`, PR #37) and LAW
  (`WodenWang820118/gx.law-prep`, PR #95). Both consumer gates passed on the
  release candidate. LAW's durable OCR receipt readback was repeated locally with
  the CI-built runtime (619 boxes unchanged). The published-mode practical OCR
  journeys passed on 2026-10-07: Cert Prep's packaged app with the canonical
  JPEG, and LAW's engine, AI service and runtime with the canonical JPEG and
  page 1 of the private PDF.
- The online-package PDF OCR E2E passes against published 0.5.0 with a ten-page
  development PDF (all pages with text, ten anchors, four of them on pages read
  by the vertical reader installed from upstream).
- The OCR engine now also installs the NDLOCR-Lite models (about 157 MB from
  `raw.githubusercontent.com/ndl-lab/ndlocr-lite` at a pinned commit, no mirror).
  **Open**: the licence lineage of its line detector's weights; see
  `.agents/RESEARCH/ndlocr-lite-detector-licence-lineage-2026-10-06.md`.
- Known limitations: handwriting OCR quality (printed text is the floor);
  installed OCR worker paths beyond Windows MAX_PATH crash the worker; page
  structure of dense vertical periodical scans and pages that mix directions;
  about a fifth of furigana on textbook pages is not set aside.

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
  retries a 404 for about five minutes before failing.
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
