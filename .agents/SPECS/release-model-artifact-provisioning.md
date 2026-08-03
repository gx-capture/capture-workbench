# Tiered Release and Direct Model Delivery Specification

## Superseding local-verification boundary (2026-08-03)

Model-enabled verification is local-only. The operator runs the exact-SHA
source-lock/model probe and Tauri/WebView media smoke on the Windows machine
before creating a tag. There is no self-hosted runner, candidate workflow,
Actions receipt, or remote model-probe rerun. The release workflow only builds
and publishes the locally verified source tree; local evidence is redacted,
reviewed, and removed after the run.

## Purpose

Preserve the published `0.3.8` core-only release as immutable evidence and
publish `0.3.9` as the model-enabled successor only after every direct-model,
source, runtime, UI, and consumer trust gate passes. Keep the installer small
and preserve explicit-consent, checksum-pinned model installation.

## Non-Goals

- No model ZIP build, GitHub Release model asset, Actions model handoff, runtime
  cache lookup, sibling-repository input, secret, or mutable upstream ref.
- No worker archive format change.
- No implicit/background install, new API endpoint, token persistence, package
  API break, or consumer-owned OCR/Whisper/runtime implementation. Cert Prep
  integration starts only after published v0.3.9 bytes exist and remains
  uncommitted.
- No tag, release, package mutation, or publication from a model-probe command.
- No mutation, asset upload, retarget, reuse, deletion, or retrofit of
  `v0.3.8`; it remains a core-only release with exactly nine public assets and
  an empty published engine catalog.
- No Cert Prep OCR/Whisper provider, installer, compatibility shim, or other
  consumer-side fallback.
- No second release workflow, caller-selected release mode, bypass flag, or
  best-effort fallback from malformed model metadata to core-only.

## v0.3.8 Evidence and Next-Version Cohesion

The authoritative public `v0.3.8` tag commit is
`f14958b65b0d786d3d0d8e3ea340a3dd40a79876`. Its source lock is blocked with
`requirements: []`, and its published engine catalog is canonical core-only
with `requirements: []`. Its Release has no OCR/Whisper worker, model, model
ZIP, or real-fixture asset. These are facts to preserve, not missing assets to
upload.

Before a model-enabled candidate is built, select one unused semantic version
after read-only remote checks for its tag, Release, and package identity. That
version must be the only runtime release identity used by production code and
workflow execution. It must agree in the Python package/runtime constants and
wire contract, Angular package metadata, Tauri/Cargo metadata, source lock,
worker archive discovery, catalog, staging manifest validation, NSIS size
report, and tag workflow. The implementation must add regressions that reject
a mismatched source lock, worker archive/catalog, staged manifest, or release
tag. Historical v0.3.8 test fixtures and
documentation can retain their literal historical version only when they are
not candidate inputs.

## Release Mode Contract

The checked-in source lock is required in both modes and is the only release
mode input. It must be canonical sorted-key UTF-8 JSON, have the exact known
top-level shape, and match the release and lock versions.

- Core-only: `sourceLock.requirements` is exactly an empty array. The generated
  catalog must also have `requirements: []`. Model-source approval and real
  fixtures are not required.
- Model-enabled: `sourceLock.requirements` is non-empty. It must validate as the
  exact approved OCR/Whisper set; the generated catalog must contain the exact
  two complete bound requirements; and the exact-SHA local model probe is
  mandatory before tagging.
- Invalid: the source lock or catalog is missing, malformed, non-canonical,
  version-drifted, partial, unknown, or internally inconsistent. Invalid input
  stops the release and is never treated as an empty requirements list.

Exact-head main CI, synchronized versions, the complete workspace verification
floor, and package/runtime/installer integrity are unconditional gates.
The release workflow queries GitHub server metadata for the active trusted CI
workflow and requires exactly one completed successful `push` run on `main`
for the exact tag SHA. It rejects PR or release runs, wrong workflow identity,
event, branch, or SHA, cancelled/skipped conclusions, and ambiguous success.

The core-only runtime release directory contains no optional worker archive,
model file/ZIP, or QA fixture. The empty canonical catalog is published so the
runtime can deterministically report OCR and Whisper as unavailable with no
artifact URL. The UI presents that unavailable state and offers no installation
action. A direct installation request cannot begin a network download for an
absent catalog requirement.

## Source Lock and Catalog Contract

A canonical checked-in source lock is the only release-model input. When its
requirements are non-empty, production validation fails unless it is
explicitly approved and contains:

- lock/version/toolchain identity and approval record with no blockers;
- exact OCR and Whisper requirement IDs and artifact version;
- for every source, derived, license, and NOTICE entry: safe POSIX relative
  path, kind, canonical owner, immutable HTTPS URL/revision, exact positive
  bytes, lowercase SHA-256, SPDX/provenance, and license/NOTICE references;
- first-party OCR `model/pipeline.json` derivation with full generator commit,
  algorithm, pinned inputs, tool versions, output bytes/hash, license, and
  NOTICE;
- unique case-insensitive paths, bounded entry count, and aggregate extracted
  bytes no greater than 2 GiB per requirement; and
- one checksum-pinned real OCR fixture and one real Whisper fixture, with
  first-party copying/redistribution approval, including full immutable hex
  revisions embedded in the exact
  fixture/license URLs, byte counts and hashes, exact normalized expected text,
  exact engine/model/device provenance, and an explicitly approved Whisper
  primary/fallback preference.

First-party `pipeline.json`, license, NOTICE, and fixture bytes have a
two-commit repository/commit binding contract:

1. Commit A in `gx-capture/capture-workbench` adds the reviewed bytes only.
2. A later Commit B adds/approves the source lock and references immutable raw
   URLs containing the exact full Commit A SHA and repository identity.

Commit B must follow Commit A. The source lock must not self-reference Commit B
because the commit identity does not exist until after the lock bytes are
created. Upstream model weights remain user-directed upstream downloads; their
legal gate is download/use plus attribution/NOTICE, not model-byte
redistribution. Redistribution approval applies to bytes copied into the
first-party repository.

Every source/derived entry references embedded or separately downloaded locked
license and NOTICE entries for the same requirement. Unknown licensing,
missing owner/provenance, a mutable URL/revision, or an unresolved fixture
invalidates the lock and stops catalog/release generation.

The generated embedded engine catalog keeps worker archive descriptors and
replaces model archive descriptors with a `modelFiles` manifest equivalent.
Each model delivery descriptor contains the artifact version, aggregate bytes,
entry count, model directory entry point, and the exact ordered file records
above. Catalog parsing rejects unknown fields, unsafe paths, duplicates,
invalid URLs/hashes, entry-count drift, missing license/NOTICE references, and
aggregate mismatch.

## Direct Download and Security

For one consented requirement installation:

1. acquire the existing per-requirement exclusive install lock;
2. create a UUID-named staging directory below that requirement only;
3. download the worker archive with the existing descriptor validation;
4. for each catalog model file in ordinal path order, stream to an exclusive
   staging path with bounded retries/backoff and cancellation;
5. enforce an initial HTTPS URL without credentials/query/fragment; validate
   every redirect target before contact; allow a query only on an explicitly
   allowlisted redirected CDN host; reject credentials, fragments, downgrade,
   unknown host, malformed/missing location, and excessive hops; then enforce
   exact `Content-Length` when present, locked bytes while streaming, and
   SHA-256 at EOF;
6. flush/fsync every completed file, resolve every parent below staging, reject
   symlinks/reparse points/path collisions, and delete partial files on any
   failure;
7. enforce 512 MiB for worker, license, NOTICE, provenance, manifest, and other
   entries; only checksum-pinned paths under `model/` may be larger, bounded by
   their exact locked bytes and the 2 GiB aggregate cap;
8. run the code-only worker probe, atomically move verified worker/model trees
   into the new version, run the model probe, and only then replace
   `active.json`; and
9. on cancellation, download drift, redirect downgrade/host drift, or probe
   failure, remove this process's staging/new inactive version and retain the
   prior active state; after a hard crash, the next install acquires the
   requirement lock and removes only validated UUID staging children and
   dot-prefixed temporary-version children without following
   symlinks/reparse points or deleting active/final versions.

No download request accepts caller-supplied model metadata. Direct downloads
never log authorization material and send no bearer token to public sources.

## Nx and Release Workflow

Nx owns:

- canonical release-mode/source-lock validation;
- complete release catalog generation;
- focused direct-download/install tests; and
- an opt-in real model candidate target that downloads the locked files and
  runs real OCR/Whisper fixtures.

Ordinary CI remains lightweight and does not download real weights.

The local model verification runs on Windows after the source lock is approved
and before tagging. It uses the exact checked-out `main` SHA, validates the
lock, performs checksum-pinned online model installation/probes, requires OCR
`windowsml-ocr` / `pp-ocrv6-medium-windowsml` / `windowsml-dml`, requires the
lock-selected Whisper provenance, compares normalized output exactly with each
fixture expectation, and runs the Tauri/WebView three-media smoke. It writes
only redacted local evidence and does not upload a receipt or model bytes.

The tag workflow validates and classifies the lock, verifies exact-head main CI,
rebuilds the lock-bound catalog/workers, and checks runtime/package/installer
integrity. It does not resolve a candidate receipt or rerun model probes on a
GitHub runner. The release candidate contains catalogued worker ZIPs/sidecars,
but never model files, model ZIPs, or QA fixtures.

The core-only release candidate contains core runtime assets, an empty canonical
catalog, core-only NSIS, size report, and the package tarball handoff. A
  model-enabled candidate additionally contains catalogued worker ZIPs/sidecars.
  Neither mode contains model files/ZIPs or QA fixtures.
The package tarball is published through GitHub Packages and is never a GitHub
Release asset. Upload uses compression level 0 and short retention for this
ordinary-sized handoff.

## Local Candidate and Real Desktop Evidence

Once, and only once, the non-empty source lock has passed its legal/source
gates, a local Windows x64 candidate may run:

1. the canonical source-lock validation and version-consistency tests;
2. production-environment preparation, worker builds, and generation of the
   complete lock-bound catalog;
3. checksum-pinned direct model installation plus the existing real OCR and
   Whisper worker fixture verifier; and
4. a new opt-in Tauri/WebView smoke that starts from an explicitly prepared
   host-owned app-data directory, installs engines by the product's consented
   catalog path, and imports separately supplied scanned-PDF, image, and audio
   fixtures through the UI.

The desktop smoke must use no ambient model-directory or extraction-provider
override. It must check the post-install requirement state, non-empty raw and
structured UI data, exact source-kind/provenance assertions, UUID-scoped
document deletion, and owned-process cleanup. The PDF and image cases require
`windowsml-ocr` and `windowsml-dml`; CPU is a failure for this model-enabled
release gate. The audio case requires `whisper-primary`, non-empty segments
with time locators, and the exact source-lock-selected primary/fallback
model/device expectation. Its fixture paths and tokens must not appear in the
  local evidence. This is distinct from the worker probe and from the current
  PDF-only desktop smoke.

No model-enabled candidate, desktop stage, or consumer installation may be
claimed while the source lock remains blocked or the local probe is incomplete.

## Blocked-State Developer Alternative

The only permitted pre-approval alternative is an opt-in developer-only local
probe. It may inspect explicitly supplied local model and fixture paths and
emit redacted SHA-256 observations, but it must be unable to alter the
production catalog, installed engine state, desktop stage, Release candidate,
or consumer requirement status. Its evidence is explicitly non-release and
non-consumer evidence. It cannot make a blocked source lock approved and does
not authorize source-byte redistribution. The existing
ambient `CAPTURE_USER_MODEL_DIR` PDF diagnostic is not a production
provisioning mechanism and must remain outside product/release targets.

## Publisher

The publisher derives the canonical expected release asset names from the
complete catalog plus core runtime, worker, checksum, size-report, and installer
assets. Model file/ZIP names are forbidden. Before package publication and on
all draft/public retries it lists remote asset names and requires:

- no duplicate names;
- no unexpected names;
- a subset only during draft repair before upload; and
- exact equality after upload and for public retries.

## Acceptance Criteria

- `v0.3.8` remains unchanged: the remote tag resolves to its existing commit,
  the Release inventory remains the nine core/runtime assets, and the
  published catalog remains empty. No implementation command writes remote
  state.
- A successor candidate cannot use `v0.3.8`, and one selected unused version
  is verified consistently across every release-execution input listed above.
- The checked-in canonical empty-requirements lock produces a core-only empty
  catalog and release without model approval or local probe evidence.
- A non-empty blocked/unapproved lock fails before publication; an approved
  non-empty lock still requires a fresh exact-SHA local probe.
- Missing, malformed, non-canonical, partial, or unknown lock/catalog
  requirements fail closed rather than selecting core-only.
- Core-only runtime requirements clearly report OCR/Whisper unavailable, the UI
  offers no install action, and no absent-requirement download begins.
- Core-only release assets contain no worker ZIP, model file/ZIP, or fixture.
- Publisher exact-asset checks accept the canonical core-only set and continue
  rejecting model ZIPs, extras, duplicates, and drift.
- Worker archive security ceilings remain unchanged.
- A checksum-pinned `model/*` direct file may exceed 512 MiB without being read
  wholly into memory; license/NOTICE/other files may not.
- Tamper, byte drift, partial download, cancellation, unsafe path, redirect
  downgrade/host drift, aggregate overflow, and probe failure leave no partial
  activation and preserve the previous active version.
- The next requirement-scoped install removes only validated hard-crash
  staging/temporary-version residue under the exclusive lock and preserves
  active/final versions and unrecognized paths.
- Publisher tests cover unexpected and duplicate draft assets plus unexpected
  public-retry assets; model ZIP names are rejected.
- A complete approved next-version lock produces a locally built,
  checksum-pinned model-enabled catalog and candidate. Its real worker proof
  and the three-media Tauri/WebView proof both pass without an ambient model
  override, each recording only redacted evidence.
- When approval, source bytes, or the local probe are unavailable, the release
  remains blocked and cannot make the core-only product/consumer path
  installable or ready.

## v0.3.9 Commit A and Model-Enabled Release Acceptance Surface

The v0.3.8 release remains immutable core-only evidence. The selected successor
is v0.3.9. Commit A is complete and pushed; Commit B, exact-main main CI,
local model verification, tag, publication, and the following uncommitted Cert
Prep consumer E2E are authorized only through the fail-closed sequence in this
specification.

Commit A's complete allowlist is:

- `model-sources/commit-a/fixtures/ocr-reference.png`, a project-owned PNG with
  the fixed expected OCR text `CAPTURE OCR FIXTURE`;
- `model-sources/commit-a/fixtures/ocr-scanned.pdf`, a deterministic one-page
  PDF whose page has an image XObject and no embedded text;
- `model-sources/commit-a/model/pipeline.json`, derived by the checked-in
  generator from canonical metadata;
- `scripts/generate_commit_a_fixtures.py`; and
- the matching `licenses/LICENSE.txt`, `licenses/NOTICE.txt`, and
  `provenance/commit-a.json` files.

No model weight, worker archive, private audio, private audio path, or private
audio text is permitted in the Commit A tree, reports, or logs. Commit A is
`31821b241846878d917a60e638a4fce39aba418a`. Commit B adds the approved v0.3.9
source lock with immutable raw URLs bound to that exact SHA; the source lock
cannot reference Commit B itself.

The provenance records these immutable upstream revisions: PaddleOCR detection
`61323801669c338b7891481ec7bac61ce31b576a` from
`PaddlePaddle/PP-OCRv6_medium_det_onnx`, recognition
`50c7eacafc52fa7bcf4194e8cd08e46f8558504b` from
`PaddlePaddle/PP-OCRv6_medium_rec_onnx`, dictionary
`b03f46425e8ff4442b268ce449e3eef758146cd4`, Whisper primary
`0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf`, and Whisper fallback
`536b0662742c02347bc0e980a01041f333bce120`. Model weights remain upstream
inputs and are not copied into Commit A.

OCR acceptance remains `pp-ocrv6-medium-windowsml` with
`windowsml-dml` provenance. The runtime selects CPU-only OCR only when
`DmlExecutionProvider` is unavailable; DirectML initialization or inference
failure fails closed and must not retry with a CPU-only pipeline. The iGPU
  route uses DirectML adapter 0 by default. Audio acceptance is a private
  local gate represented in the source lock only by bytes, SHA-256, segment
  conditions, normalized output digest, and actual model/device provenance.
  Two identical production-worker preflights must freeze that expectation
  before final OCR/audio candidate and desktop gates run.

The deterministic Phase A validator is
`pnpm nx run capture-runtime:validate-commit-a-fixtures --skip-nx-cache`, and
the focused regression suite is
`pnpm nx run capture-runtime:test --skip-nx-cache --testsFile=tests/test_commit_a_fixtures.py`
(or the equivalent `uv run ... pytest tests/test_commit_a_fixtures.py`).
The generated bytes currently are:

| path | bytes | SHA-256 |
| --- | ---: | --- |
| `fixtures/ocr-reference.png` | 2,157 | `7d61f4835837c4c387a0d46c4f21f7442fe22aab3f14f330b86f6857f5f3bc82` |
| `fixtures/ocr-scanned.pdf` | 2,421 | `5eec85d2b2e98e06577cb5310d1b3037ca26f03d06d85a292ae78b68d4c57f30` |
| `licenses/LICENSE.txt` | 1,087 | `20d8153042f147e730a2265e35e3862f8d1ad67b5f6804d44fb81e7dfbc5818b` |
| `licenses/NOTICE.txt` | 303 | `59b45e1fdb14fce45ba29a4a5200b0d26f97f7db11d42a8b8e2581bfa005d4ed` |
| `model/pipeline.json` | 613 | `21ba11c05440b36894262eab74c124d9ce55d64311ddb53497f99acdcc225606` |
| `provenance/commit-a.json` | 2,334 | `e4a152993dc505156f37504b89519492c2ceaadd9a9480f061676fc0df750a9f` |
