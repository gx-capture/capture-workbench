# Tiered Release and Direct Model Delivery Decisions

## Local Verification (2026-08-03)

The initial NSIS remains core-only and worker ZIPs are optional GitHub Release
assets; model ZIPs are not built, staged, handed between jobs, or published.
Runtime installation is explicit-consent only, with no background prefetch.

The self-hosted `capture-directml` runner and GitHub candidate-receipt gate are
removed. Model-enabled release verification is performed on the local Windows
machine before tagging, using the exact checked-out `main` SHA, the canonical
source lock, checksum-pinned online model downloads, the real engine probes,
and the Tauri/WebView media smoke. The GitHub release workflow does not
re-run or attest to those model probes; it only builds and publishes the
already locally verified source tree. The local evidence remains outside the
release assets and must be deleted after verification.

## Approved Two-Tier Release Classification

The user approved a core-only / model-enabled release scheme on 2026-07-30.
The existing source-lock validator, engine-catalog generator, release
workflows, and publisher remain the only owners. No parallel publication workflow or bypass
flag is added.

Release mode is derived only from a canonical checked-in source lock and the
canonical catalog it generates:

- `requirements: []` is core-only. The lock must still be present, canonical,
  version-synchronized, and structurally valid, but model-source approval and
  fixtures do not gate this mode.
- A non-empty `requirements` list is model-enabled. It must be the exact
  approved requirement set and satisfy every immutable source, license, NOTICE,
  fixture, local exact-SHA probe, and catalog-binding gate.
- A missing, malformed, non-canonical, version-drifted, partial, or unknown
  requirements value is invalid. It is never reclassified as core-only.

The core-only catalog has `requirements: []`. Its release directory contains
the core runtime, schema/manifest/checksums, empty engine catalog, size
evidence, NSIS installer, and package tarball handoff. Its GitHub Release
contains only the canonical runtime assets and NSIS installer; the package
tarball is GitHub Packages-only. Optional worker archives, model files/ZIPs,
and QA fixtures are absent. Runtime requirement reporting exposes every engine
as unavailable with no downloadable artifact,
and an installation attempt fails before any download begins.

Exact-head main CI, synchronized versions, and package/runtime/installer
integrity remain mandatory in both modes.

The release candidate workflow resolves exact-head CI through GitHub server metadata for the
active checked-in `.github/workflows/ci.yml` workflow. It requires exactly one
completed successful `push` run whose `head_branch` is `main` and whose
`head_sha` equals the tag commit. A PR run, release-workflow run, wrong event,
branch, SHA, workflow path/ID, cancelled/skipped result, malformed metadata, or
ambiguous successful run fails closed.

## Approved Delivery Scheme

The user approved delivery scheme 2 on 2026-07-30: after explicit installation
consent, the runtime downloads checksum-pinned model files directly from their
immutable upstream URLs.

The embedded release catalog contains, or checksum-pins, the manifest
equivalent:

- requirement and artifact version;
- immutable HTTPS URL and revision for every file;
- safe relative destination path;
- exact byte count and SHA-256;
- kind and canonical owner;
- SPDX/provenance metadata; and
- references to separately pinned license and NOTICE entries.

No runtime request may resolve `latest`, a branch, a mutable model alias, or a
caller-provided URL/hash/path. Redirects remain HTTPS, credential-free, and on
the approved canonical host set; redirected bytes must still match the
original locked length and SHA-256.

First-party `pipeline.json`, license, NOTICE, and fixture bytes use a mandatory
two-commit bootstrap in `gx-capture/capture-workbench`. Commit A adds the
reviewed bytes. A later commit B adds/approves the source lock, whose first-party
URLs name the exact repository and full Commit A SHA (for example an immutable
`raw.githubusercontent.com/gx-capture/capture-workbench/<commit-a>/...` URL).
Commit B must be reachable after Commit A and the source lock may not reference
Commit B itself: a checked-in lock cannot truthfully self-reference bytes at its
own not-yet-existing commit.

## Installation and Activation

- Worker archives retain the existing descriptor, bounded downloader, safe ZIP
  extraction, and inner manifest verification (limits in
  `_engine_installation_limits.py`).
- Model delivery uses a requirement-scoped unique staging directory. Each file
  is streamed with bounded retries, cancellation, exact length/SHA-256,
  per-file and aggregate limits, safe path resolution, flush/fsync, and partial
  cleanup.
- Only checksum-pinned `model/*` entries may exceed 512 MiB. Their exact locked
  bytes/SHA-256 and the aggregate limit are independent gates. License, NOTICE,
  provenance, manifest, and other files retain the 512 MiB ceiling.
- Activation is atomic only after the worker is installed, every model file is
  verified, the code-only worker probe succeeds, and the post-install model
  probe succeeds. Cancellation, network failure, drift, or probe failure
  removes staging and preserves the previous active version.
- A same-process failure removes its own residue in `finally`. A hard-crash
  residue is removed at the next installation, after acquiring the same
  per-requirement exclusive lock. That sweep removes only UUID-named staging
  children and validated dot-prefixed temporary-version children, does not
  follow symlinks/reparse points, and never removes an active/final version.

## Release and Local Verification Trust

Before a model-enabled tag, the local Windows machine must be on the exact
`main` commit and run the existing source-lock/version gates, checksum-pinned
online model probe, and Tauri/WebView three-media smoke. The probe evidence is
reviewed locally, contains only redacted digests/provenance, and is deleted
after verification. It is not uploaded as an Actions artifact and does not
enter the GitHub Release.

The release candidate workflow derives the release mode from the canonical checked-in
lock, verifies exact-head `main` CI, rebuilds the source-lock-bound catalog and
workers, and checks package/runtime/installer integrity. It does not query a
self-hosted runner, resolve a GitHub candidate receipt, or retry the model
probe on a different machine. A failed local model probe stops the operator
before the tag is created.

## Publisher Contract

Before any package publication and on every retry, the publisher requires the
remote GitHub Release asset-name set to equal the local canonical set exactly.
Draft releases may initially be a subset only while missing assets are
uploaded. Extras and duplicate names always fail closed. Model ZIP/manifest
names are never in the expected release set.

## Rejected or Superseded Designs

- Deterministic combined model ZIP publication and the approximately 2.5 GB
  Actions candidate handoff are superseded. Their ZIP64, compression-level,
  artifact quota, retention, and multi-gigabyte timeout requirements are
  removed.
- Runtime resolution of mutable upstream names is rejected.
- First-party hosting remains a separate future decision if immutable upstream
  availability is inadequate.
