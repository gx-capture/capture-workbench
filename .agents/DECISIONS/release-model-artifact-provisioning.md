# Tiered Release and Direct Model Delivery Decisions

## Scope and Evidence

- Capture Workbench release commits contain only
  `gx-capture/capture-workbench` files. After publication, Cert Prep consumes
  the exact published package/runtime bytes and keeps its integration diff
  uncommitted. Cert Prep must not regain an OCR/Whisper provider, runtime
  implementation, or compatibility shim.
- The initial NSIS remains core-only. Worker ZIPs remain optional GitHub
  Release assets. Model ZIPs are not built, staged, handed between jobs, or
  published.
- Existing runtime installation is explicit-consent only. This decision does
  not add background prefetch, implicit installation, or a new endpoint.
- The user approved the exact pinned OCR/Whisper upstream sources,
  attribution/NOTICE records, project-owned OCR fixture bytes, and private
  runner audio gate. Commit A records the first-party derivation and
  redistribution surface. Model-enabled catalog generation remains fail
  closed until two identical production Whisper preflights freeze the private
  output digest and model/device pair in the source lock.

## Approved Two-Tier Release Classification

The user approved a core-only / model-enabled release scheme on 2026-07-30.
The existing source-lock validator, engine-catalog generator, tag workflow, and
publisher remain the only owners. No parallel publication workflow or bypass
flag is added.

Release mode is derived only from a canonical checked-in source lock and the
canonical catalog it generates:

- `requirements: []` is core-only. The lock must still be present, canonical,
  version-synchronized, and structurally valid, but model-source approval,
  fixtures, a `capture-directml` runner, and a model-candidate receipt do not
  gate this mode.
- A non-empty `requirements` list is model-enabled. It must be the exact
  approved OCR/Whisper set and satisfy every immutable source, license, NOTICE,
  fixture, DirectML runner, fresh exact-commit receipt, and catalog-binding
  gate.
- A missing, malformed, non-canonical, version-drifted, partial, or unknown
  requirements value is invalid. It is never reclassified as core-only.

The core-only catalog has `requirements: []`. Its release directory contains
the core runtime, schema/manifest/checksums, empty engine catalog, size
evidence, NSIS installer, and package tarball handoff. Its GitHub Release
contains only the canonical runtime assets and NSIS installer; the package
tarball is GitHub Packages-only. Optional worker archives, model files/ZIPs,
and QA fixtures are absent. Runtime requirement reporting exposes OCR and
Whisper as unavailable with no downloadable artifact,
and an installation attempt fails before any download begins.

Exact-head main CI, synchronized versions, and package/runtime/installer
integrity remain mandatory in both modes.

The tag workflow resolves exact-head CI through GitHub server metadata for the
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
  extraction, inner manifest verification, and 512 MiB entry ceiling.
- Model delivery uses a requirement-scoped unique staging directory. Each file
  is streamed with bounded retries, cancellation, exact length/SHA-256,
  per-file and aggregate limits, safe path resolution, flush/fsync, and partial
  cleanup.
- Only checksum-pinned `model/*` entries may exceed 512 MiB. Their exact locked
  bytes/SHA-256 and the aggregate extracted limit are independent gates.
  License, NOTICE, provenance, manifest, worker, and other files retain the
  512 MiB ceiling.
- Activation is atomic only after the worker is installed, every model file is
  verified, the code-only worker probe succeeds, and the post-install model
  probe succeeds. Cancellation, network failure, drift, or probe failure
  removes staging and preserves the previous active version.
- A same-process failure removes its own residue in `finally`. A hard-crash
  residue is removed at the next installation, after acquiring the same
  per-requirement exclusive lock. That sweep removes only UUID-named staging
  children and validated dot-prefixed temporary-version children, does not
  follow symlinks/reparse points, and never removes an active/final version.

## Release and Receipt Trust

For model-enabled releases, the pre-tag candidate workflow remains explicit
`workflow_dispatch`, read-only, and non-publishing. Once the legal/source lock
is approved, it
performs the normal consent-equivalent direct downloads on an explicitly
labeled self-hosted Windows x64 DirectML runner, verifies real OCR and Whisper
fixtures, and uploads only a small canonical receipt. GitHub-hosted
`windows-latest` does not prove the product DirectML GPU lane and is forbidden
for this job.

The tag workflow first derives the release mode from the canonical checked-in
lock. Core-only releases do not query or copy candidate-receipt evidence.
Model-enabled releases grant `actions: read` to `build-candidate` and trust
GitHub server-side metadata, not receipt claims:

- checked-in candidate workflow path and stable workflow ID;
- `workflow_dispatch`, successful conclusion, exact full head SHA and version;
- exact source-lock SHA;
- exactly one fresh, non-expired run and receipt artifact;
- server run/artifact IDs and GitHub-reported artifact digest; and
- no caller-provided URL, run ID, artifact ID, timestamp, or hash override.

Replay, expiry, ambiguity, wrong workflow/event/SHA/version/lock, unsuccessful
run, artifact tamper, or server-digest mismatch fails before candidate work.
The tag workflow rebuilds workers/runtime, then requires the rebuilt catalog's
exact runtime version, source-lock SHA, and ordered direct-model manifest
summaries to equal the receipt. Candidate catalog SHA remains audit evidence;
it is not a gate because independent PyInstaller/worker ZIP builds are not
byte-deterministic. The workflow then builds the core-only NSIS/package and
hands those ordinary release assets to `publish`; model files and model ZIPs
are absent from the handoff.

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
- Chunk/reassembly and a smaller Whisper model remain unnecessary for this
  delivery scheme.
- First-party hosting remains a separate future decision if immutable upstream
  availability is inadequate.

## Remaining Model-Enabled Blockers

- Run the production Whisper worker twice against the exact runner-local
  private fixture. Both privacy-safe evidence records must be identical before
  freezing the normalized output SHA-256 and either
  `large-v3-turbo`/`cuda` or `small`/`cpu` provenance.
- Complete the local release gates and Commit B review, merge to `main`, then
  register an ephemeral self-hosted Windows x64 runner with the exact
  `capture-directml` label for the exact-main candidate workflow.

These gates prevent tagging or publishing v0.3.9. The release path has no
best-effort or core-only downgrade after a non-empty model source lock is
selected.

## Immutable v0.3.8 Evidence and the Successor Boundary

`v0.3.8` is closed, immutable core-only feasibility evidence, not a partially
repairable model-enabled release. The public tag resolves to
`f14958b65b0d786d3d0d8e3ea340a3dd40a79876`; its public Release has exactly
nine core/runtime and installer assets, and its published
`capture-engine-catalog.json` has `requirements: []`. There are no WindowsML
worker, Whisper worker, model, model ZIP, or real-fixture Release assets. The
tag's checked-in source lock is correspondingly blocked with an empty
requirements list.

Do not delete, retarget, reuse, upload to, edit, republish, or otherwise try
to retrofit that tag or its assets. A code or source-lock correction requires a
new, unused semantic version only after the remote tag, Release, and package
identities have been checked. This planning slice does not select, tag, push,
publish, or dispatch that successor.

The successor must carry one coherent version through the package, Runtime
constants/contracts, Tauri metadata, source lock, worker names, catalog,
installer/report assertions, workflow receipt name/version, and tests. The
current literal `0.3.8` values in the source-lock validator, Nx commands, and
model-candidate/release workflows are release-specific evidence, not a basis
for a successor candidate. Replace execution-path duplication with a verified
canonical version input; historical v0.3.8 fixtures and release evidence may
remain explicit historical data.

## Model-Enabled Candidate Decision

The next locally built model-enabled candidate remains the existing direct-file
delivery design: checksum-pinned worker ZIPs are Release assets, while model
files are downloaded only after explicit consent from immutable approved source
lock URLs. The candidate must prove the exact lock-derived catalog, real OCR
and Whisper fixture output, and the DirectML/Whisper provenance before any tag
workflow can accept its small receipt. Model bytes, model ZIPs, and real
fixtures never enter a Release, package tarball, or Actions handoff.

The published desktop is additionally required to exercise the candidate
through its Tauri/WebView flow with separate real scanned-PDF, image, and audio
inputs. PDF/image must prove non-empty OCR and `windowsml-dml` provenance;
audio must prove non-empty time-located Whisper output and the exact
lock-selected primary or fallback provenance. Each case must verify UI-visible
raw/result data, delete only its own UUID-named document, redact paths/tokens
from evidence, and leave no owned worker or desktop process. The existing
PDF-only smoke is useful evidence but is insufficient for this three-media
release gate.

## Blocked-State Developer and Consumer Alternative

Until the legal/source and runner blockers are resolved, the production and
consumer answer is deliberately unavailable: the core-only catalog offers no
install action and cannot begin an OCR/Whisper model download. Do not add a
consumer URL, local-model environment override, sidecar shim, or automatic
fallback to change that result.

If local engineering evidence is needed before approval, the smallest safe
alternative is a developer-only, non-release probe that accepts explicit local
paths and records local SHA-256 observations. It must be opt-in, write its
redacted output outside tracked release directories, be unable to generate a
release catalog/receipt or stage the desktop runtime, and state
`developer-only; not an approved source lock or consumer installation` in its
output. It may not use the production source-lock path, mutate `active.json`,
or cause the UI to advertise a ready requirement. The existing
`tools/user-pdf-ocr-probe.mts` ambient-model path is diagnostic-only and must
not be promoted as this alternative because it bypasses catalog-bound
checksum-pinned installation.

## v0.3.9 Successor: Commit A Complete and Release Gates Authorized

The v0.3.8 tag and its published assets are immutable core-only evidence. They
are not repaired, retagged, republished, or used as a model-enabled candidate.
The selected successor is v0.3.9 on
`release/model-enabled-v0.3.9`. The user authorized the two-commit release,
push, PR merge, exact-main candidate, tag, Release, package publication, and
subsequent uncommitted Cert Prep consumer verification, subject to every
fail-closed gate in this decision.

Commit A is intentionally limited to project-owned, redistributable evidence:
the fixed-text OCR PNG, the one-page image-only scanned PDF, the derived
`model/pipeline.json`, the reproducible generator, and the accompanying
license/NOTICE/provenance files. It contains no model weights, worker archives,
  private audio, private audio paths, or private audio text. It was committed
  and pushed as `31821b241846878d917a60e638a4fce39aba418a`. Commit B adds the
  approved v0.3.9 source lock whose immutable first-party URLs point to that
  exact Commit A SHA; the lock must never self-reference Commit B.

The fixed upstream revisions recorded by Commit A are detection
`61323801669c338b7891481ec7bac61ce31b576a`, recognition
`50c7eacafc52fa7bcf4194e8cd08e46f8558504b`, PaddleOCR dictionary
`b03f46425e8ff4442b268ce449e3eef758146cd4`, Whisper primary
`0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf`, and Whisper fallback
`536b0662742c02347bc0e980a01041f333bce120`. These are provenance inputs,
not checked-in model bytes.

OCR remains DirectML-first on the Cert Prep iGPU route. CPU-only execution is
selected only when `DmlExecutionProvider` is absent. DirectML initialization or
inference failure is fail-closed and must not trigger a CPU-only retry. The
model-enabled audio proof is restricted to an authorized private Windows x64
  runner and its private fixture; no private audio bytes, text, path, or license
  URL is copied into this repository or its logs/reports. Cert Prep changes
  remain uncommitted and are made only after published v0.3.9 bytes exist.
