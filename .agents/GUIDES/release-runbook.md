# Capture Workbench release runbook

Current as of 2026-09-29. This is the operational procedure for publishing a
Capture Workbench release and moving its consumers. It reflects how 0.4.3 was
actually shipped; workflow files remain the source of truth for inputs.

## Current state

- Capture Runtime and Workbench **0.4.3** are published: npm
  (`@gx-capture/capture-workbench-ui`, `@gx-capture/capture-runtime-client` on
  GitHub Packages), Maven (`com.gx.capture:capture-runtime-client`, GitHub
  Packages), PyPI (`capture-runtime-client`), crates.io
  (`capture-sidecar-launcher`), and GitHub release `v0.4.3` (runtime exe
  `538c8afe…`, OCR/Whisper engine zips, desktop installer, release manifest).
  `release-index/stable.json` on the `release-index` branch points at `v0.4.3`.
- Source commit of the 0.4.3 candidates: `d3c73d2`. Contract-set SHA-256:
  `232ef06bf547e79120df28f39303e73b0e5842beace5910a422f15dfb5e2acbc`.
  Runs: package candidate 36543979781, runtime candidate 36544271386, package
  promote 36545669625, runtime promote 36561430902, release candidate
  36571021075, consumer gates 36574474509, release promote 36576362697.
- Consumers on their `main` branches pin 0.4.3 and passed published-mode
  practical OCR: Cert Prep (`WodenWang820118/cert-prep`, PR #34) and LAW
  (`WodenWang820118/gx.law-prep`, PR #92: Java engine → Python AI service →
  runtime).
- First-run OCR install on fresh app data: about 40 s with a cold download,
  about 8 s when the machine-wide engine cache already holds the engine.
- Known limitations: handwriting OCR quality (printed text is the floor);
  installed OCR worker paths beyond Windows MAX_PATH crash the worker.

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
   (`model-enabled` for 0.4.3). Record the run ID, `candidateId`, and the
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
- `sync-versions.ts` rewrites every occurrence of the previous release
  version (and workspace crates in `Cargo.lock`). A test's "conflicting
  version" must therefore be a value no release will reach (`99.0.0`), and
  recorded fixture data (OCR evidence goldens) must use a fixed version other
  than the current one, or the bump collapses the conflict or breaks digests.
- Every pull request runs full CI, docs-only ones included; a docs-only skip
  once let `main` go red for three merges. Tests never assert documentation
  prose, so docs edits alone cannot fail CI.
- Engine downloads are served from the machine-wide cache
  (`%LOCALAPPDATA%\gx-capture\engine-cache`) once any host has installed
  them. Set `CAPTURE_ENGINE_CACHE_DIR=off` to time or debug a cold download.
