# Tiered Release and Direct Model Delivery Specification

## Local verification boundary

Model-enabled verification is local-only (since 2026-08-03). The operator runs the exact-SHA
source-lock/model probe and Tauri/WebView media smoke on the Windows machine
before creating a tag. There is no self-hosted runner, candidate workflow,
Actions receipt, or remote model-probe rerun. The release workflow only builds
and publishes the locally verified source tree; local evidence is redacted,
reviewed, and removed after the run.

## Purpose

Deliver engine models as checksum-pinned direct downloads after explicit
consent, keep the installer small, and publish a model-enabled release only
after every direct-model, source, runtime, UI, and consumer trust gate passes.
The model-source snapshot and lock procedure (Commit A, then the lock) is in
the [release runbook](../GUIDES/release-runbook.md).

## Non-Goals

- No model ZIP build, GitHub Release model asset, Actions model handoff, runtime
  cache lookup, sibling-repository input, secret, or mutable upstream ref.
- No worker archive format change.
- No implicit/background install, token persistence, or consumer-owned
  OCR/speech/runtime implementation.
- No tag, release, package mutation, or publication from a model-probe command.
- No mutation, asset upload, retarget, reuse, deletion, or retrofit of a
  published release.
- No consumer-side OCR/speech provider, installer, compatibility shim, or other
  fallback.
- No second release workflow, caller-selected release mode, bypass flag, or
  best-effort fallback from malformed model metadata to core-only.

## Release Mode Contract

The checked-in source lock is required in both modes and is the only release
mode input. It must be canonical sorted-key UTF-8 JSON, have the exact known
top-level shape, and match the release and lock versions.

- Core-only: `sourceLock.requirements` is exactly an empty array. The generated
  catalog must also have `requirements: []`. Model-source approval and real
  fixtures are not required.
- Model-enabled: `sourceLock.requirements` is non-empty. It must validate as the
  exact approved set (today `windowsml-ocr`, `speech-recognition`,
  `speaker-diarization` and `vertical-japanese-reader`); the generated catalog
  must contain each complete bound requirement; and the exact-SHA local model
  probe is mandatory before tagging.
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
runtime can deterministically report every engine as unavailable with no
artifact URL. The UI presents that unavailable state and offers no installation
action. A direct installation request cannot begin a network download for an
absent catalog requirement.

## Source Lock and Catalog Contract

A canonical checked-in source lock is the only release-model input. When its
requirements are non-empty, production validation fails unless it is
explicitly approved and contains:

- lock/version/toolchain identity and approval record with no blockers;
- exact requirement IDs and artifact version;
- for every source, derived, license, and NOTICE entry: safe POSIX relative
  path, kind, canonical owner, immutable HTTPS URL/revision, exact positive
  bytes, lowercase SHA-256, SPDX/provenance, and license/NOTICE references;
- first-party OCR `model/pipeline.json` derivation with full generator commit,
  algorithm, pinned inputs, tool versions, output bytes/hash, license, and
  NOTICE;
- unique case-insensitive paths, bounded entry count, at most 4 GiB per model
  file, 8 GiB per requirement and 10 GiB across the lock
  (`scripts/model_source_lock.py`); and
- checksum-pinned real fixtures with first-party copying/redistribution
  approval, exact normalized expected output and exact engine/model/device
  provenance (the private speech fixture is represented only by its bytes,
  SHA-256 and expected output digest).

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
7. enforce 512 MiB for license, NOTICE, provenance, manifest, and other
   entries; only checksum-pinned paths under `model/` may be larger, bounded by
   their exact locked bytes and the per-file and aggregate caps;
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
  runs the real fixtures.

Ordinary CI remains lightweight and does not download real weights.

The local model verification runs on Windows after the source lock is approved
and before tagging. It uses the exact checked-out `main` SHA, validates the
lock, performs checksum-pinned online model installation/probes, requires OCR
`windowsml-ocr` / `pp-ocrv6-medium-windowsml` / `windowsml-dml`, requires the
lock-selected speech recognition provenance, compares normalized output exactly
with each fixture expectation, and runs the Tauri/WebView three-media smoke
(`capture-workbench-desktop:smoke-real-media-model`). It writes
only redacted local evidence and does not upload a receipt or model bytes.

The release candidate workflow (`release-candidate.yml`) validates and
classifies the lock, verifies exact-head main CI,
rebuilds the lock-bound catalog/workers, and checks runtime/package/installer
integrity. It does not resolve a candidate receipt or rerun model probes on a
GitHub runner. The release candidate contains catalogued worker archives and
their files manifests, but never model files, model ZIPs, or QA fixtures.

The core-only release candidate contains core runtime assets, an empty canonical
catalog, core-only NSIS, and the package tarball handoff. The size report is
the CI artifact `capture-size-report-<version>-<run>`. A model-enabled
candidate additionally
contains catalogued worker archives and their files manifests.
Neither mode contains model files/ZIPs or QA fixtures.
The package tarball is published through GitHub Packages and is never a GitHub
Release asset. Upload uses compression level 0 and short retention for this
ordinary-sized handoff.

## Publisher

The publisher derives the canonical expected release asset names from the
complete catalog plus core runtime, worker archives, files manifests, and the
installer. A full release has 19 assets. Checksum sidecars and the size report
are not among them. The size report is the CI artifact
`capture-size-report-<version>-<run>`.
Model file/ZIP names are forbidden. Before package publication and on
all draft/public retries it lists remote asset names and requires:

- no duplicate names;
- no unexpected names;
- a subset only during draft repair before upload; and
- exact equality after upload and for public retries.
