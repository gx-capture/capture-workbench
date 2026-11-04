# Capture Runtime Installer Size Reduction

## Purpose

The Windows 11 x64 Capture Workbench NSIS installer holds the desktop host plus
a lightweight `capture-runtime-core`. The OCR, speech recognition and speaker
diarization workers, their models, the vertical Japanese reader's models, and
the app-managed Ollama runtime/model are installed only after explicit
requirement installation.

The existing authenticated loopback `/v2` API, `CaptureClient`,
`CaptureDocument`, requirement IDs, local desktop library/history, isolated
app-managed Ollama behavior, job cancellation/rollback, renderer token
isolation, and DirectML-first fail-closed OCR policy are unchanged.

## Reconciled Existing Decisions

- This spec extends `standalone-desktop-product.md`: the Tauri host remains the
  public Windows 11 x64 product and the runtime remains a native sidecar.
- It preserves `gpu-ocr-directml.md`: if `DmlExecutionProvider` is registered,
  the OCR worker creates one DML-first session and fails closed on
  initialization/inference failure. CPU-only OCR is allowed only when DML is
  unavailable. Provenance remains `windowsml-dml` or `cpu`.
- It replaces the old meaning of an OCR `bundled` install strategy. The
  checksum-pinned descriptor remains runtime-owned, but code and model bytes
  are optional release artifacts and are not NSIS resources.
- Model files are delivered as described in `release-model-artifact-provisioning.md`
  (direct checksum-pinned downloads, never in a release asset).
- Deterministic development/smoke remains a QA lane. Product staging uses the
  core release runtime and real optional-engine installation path.

## Non-goals

- No public `/v2` route, schema, requirement ID, `CaptureDocument`, or
  `CaptureClient` change.
- No renderer-provided artifact URL, byte count, checksum, catalog, local path,
  bearer token, or worker command.
- No runtime `pip install`, `uv sync`, unpinned code execution, or dynamic
  Python-package installation.
- No engine worker or model in the initial NSIS installer.
- No automatic Ollama inclusion in the initial installer.
- No platform other than Windows 11 x64.

## Ownership

Pure functions and frozen dataclasses own descriptor parsing, hashes, archive
validation, protocol validation, and activation-state transitions. Stateful
classes/protocols own downloads, worker processes, install locks, activation,
and shutdown. No general plugin framework is introduced.

## Runtime Core Boundary

The core contains FastAPI/Uvicorn, Pydantic contracts, authenticated job
lifecycle, structuring providers, the runtime-owned engine catalog, worker
orchestration, and installation logic.

The core must not contain/import at runtime:

- PaddleOCR, PaddleX, OpenCV, ONNX Runtime, `pypdfium2`, or Pillow;
- PyTorch, Transformers, PyAV, or Hugging Face Hub;
- worker/model archives;
- binaries for non-Windows or non-x64 platforms.

Every PDF is sent to the OCR worker, which owns PDFium rendering and PaddleOCR
for every page. Embedded PDF text is never read. Images are sent to OCR;
recordings are sent to the speech recognition worker (and the speaker
diarization worker when speakers are requested).

## Catalog and Artifact Formats

The embedded engine catalog (`assets/engine-catalog.json`, parsed by
`engine_catalog.py`) is canonical UTF-8 JSON with sorted keys and a final LF.
Its root has exactly `catalogVersion` (`"2"`), `runtimeVersion` (must equal the
core's version) and `requirements`. Each requirement has `requirementId`,
`artifacts`, `modelFiles` and `unavailableReason`; a source build without an
injected release catalog lists every requirement as unavailable with a reason.

`artifacts` holds worker archives only (`role: "worker"`). Each has
`requirementId`, `artifactVersion`, `workerProtocolVersion`, `platform`
(`windows`), `arch` (`x86_64`), `fileName`, `bytes`, `sha256`,
`extractedBytes`, `entryPoint`, `filesManifestSha256`, and either `url` or
ordered `parts` (each `fileName`, `bytes`, `sha256`, `url`). `bytes` and
`sha256` always describe the whole archive; an archive above 1.9 GB is
published in parts because GitHub release assets must stay under 2 GB. A URL is
absolute HTTPS with no credentials, query, or fragment and is owned only by the
catalog. A models-only unit (`vertical-japanese-reader`) has no worker archive.

`modelFiles` is the direct model delivery generated from the model source lock
(see `release-model-artifact-provisioning.md`).

Every ZIP contains `files-manifest.json`. Its canonical JSON shape is:

```json
{
  "manifestVersion": "1",
  "files": [
    {"path": "capture-engine-ocr.exe", "bytes": 1, "sha256": "<64 lowercase hex>"}
  ]
}
```

Paths use `/`, are relative, unique case-insensitively, and are sorted. The
descriptor hashes the exact manifest bytes. The manifest lists every extracted
regular file except `files-manifest.json`; no unlisted file is accepted.

## Installed State

Each requirement is owned below:

```text
<app-data>/engines/<requirement-id>/
├── active.json
├── versions/<artifact-version>/
└── .staging/<unique-install-id>/
```

`active.json` is canonical JSON with exactly `stateVersion`,
`requirementId`, `artifactVersion`, `workerProtocolVersion`, `entryPoint` and
`activatedArtifacts` (each `{role, sha256}`).

Activation uses same-volume temporary write, flush, and atomic replace.
Versions install side-by-side. The old `active.json` is retained until all new
artifacts verify and the new worker probes with its model. Failure or
cancellation removes only the new staging/version and leaves the prior active
version unchanged. One in-process and one filesystem lock serialize concurrent
installation for a requirement; a concurrent caller observes the winning
active state or fails with an explicit busy error.

Once installed, readiness/probe/extraction uses only local verified files and
works offline. Network is used only by an explicit installation job.

## Worker Protocol

Worker stdin/stdout use UTF-8 JSON Lines. stderr is diagnostic-only, capped,
and may not contain secrets. Each request/result is one JSON object with:

- `protocolVersion: "1"`;
- caller-generated `requestId` (1-64 ASCII alphanumeric/`._-`);
- `operation: "probe" | "preflight" | "run" | "cancel"`;
- operation-specific `payload`.

`probe` validates worker code and optional model directory. `run` accepts a
runtime-owned absolute source path, media type, bounded extraction options, and
model directory. `cancel` names the running request ID. Responses contain
`ok`, validated `result` or a bounded structured error, and provenance.

Input framing is capped at 64 KiB. Output framing is capped at 8 MiB. More than
one line, invalid UTF-8/JSON, an unknown field/operation, wrong request ID,
protocol mismatch, oversized output, invalid provenance, or a nonzero exit is
fail-closed. A worker process serves one run plus its cancel message
(`workers/server.py`); progressive speech recognition uses a binary-framed
session for one recording (`workers/session_server.py`). Core never sends its
API bearer token in worker argv, environment, stdin, source file, or model
path.

Default probe timeout is 30 seconds and run timeout is 15 minutes. On user
cancellation core writes a cancel frame, waits up to two seconds, then
terminates; after a further three seconds it kills. Runtime shutdown applies
the same bounded terminate/kill cleanup to all owned workers. No executable
name-wide process termination is permitted.

## Safe Download and ZIP Rules

Downloads stream to a unique `.staging` file with a byte ceiling. HTTP status,
`Content-Length` when present, exact descriptor bytes, and SHA-256 must match
before extraction. Large artifacts download as parallel byte ranges, an
interrupted download resumes, and verified downloads are shared between hosts
through the machine-wide engine cache (`CAPTURE_ENGINE_CACHE_DIR`, `off`
disables it). The limits are in `_engine_installation_limits.py`.

ZIP validation precedes extraction and rejects:

- absolute, drive-qualified, rooted, UNC, empty, `.` or `..` paths;
- path traversal after normalization;
- symlink, reparse-point, junction, device, FIFO, or other non-regular entries;
- duplicate normalized paths and case-insensitive collisions;
- encrypted entries;
- more than 8,192 entries;
- any single file over 2 GiB;
- aggregate bytes above the descriptor `extractedBytes` or 8 GiB;
- an installed file path of 260 characters or more (Windows `MAX_PATH`);
- compression ratio above 200:1 for non-empty files;
- missing, malformed, mismatched, or duplicate inner manifest entries;
- files absent from the inner manifest or manifest byte/hash mismatch.

Extraction opens destination files with exclusive creation beneath the
resolved staging root, streams with byte ceilings, hashes while writing, and
never follows an existing path.

## Engine Installation Flows

`windowsml-ocr`:

1. Download/verify/extract the OCR worker artifact.
2. Probe worker code.
3. Download/verify/extract the pinned WindowsML model artifact.
4. Probe worker + model + providers.
5. Atomically activate.

`speech-recognition` and `speaker-diarization` follow the same sequence with
their own Transformers workers and direct model files. No Hugging Face API is
called by the runtime; the installed model is entirely described by the
catalog. `vertical-japanese-reader` installs model files only. An installed
unit can be removed again (`DELETE /v2/runtime/requirements/{id}/installation`).

Ollama stays app-managed/on-demand with its existing isolated profile and
runtime-owned lifecycle. It is not added to core/NSIS and its bearer/token
boundary is unchanged.

## Release and NSIS

Release build order is worker executables, files manifests/ZIPs, checksums,
engine catalog, core executable, schema/runtime manifest, core-only NSIS, then
size report. Release assets include:

- core runtime executable, checksum, runtime manifest, and schema;
- OCR, speech recognition and speaker diarization worker ZIPs (or their parts)
  and files manifests;
- engine catalog;
- NSIS installer;
- runtime size report plus PyInstaller inventory/xref/warnings.

The NSIS resource allowlist is exactly core executable, runtime manifest, and
schema. A scan fails if engine workers, model assets, Paddle/ONNX/PDFium/Pillow,
PyTorch/Transformers/PyAV/Hugging Face, or Ollama payloads are present.

Publication keeps the candidate draft-only, uploads the exact GitHub Release
assets, downloads every Release asset and re-verifies byte
count/hash/manifest/catalog, verifies package integrity through GitHub Packages,
then publishes. The package tarball is workflow handoff/registry-only and never
a GitHub Release asset. Existing same-version assets with different bytes fail
closed. No external release is created by local implementation or verification.

## Size Baseline and Budgets

`scripts/report_bundle_size.py` emits canonical JSON containing tool/runtime
versions, exact executable and installer file names/bytes/SHA-256, installed
bytes, top PyInstaller files, and categorized core/PDF/OCR/speech bytes.
Installed bytes come only from exact silent install plus positive byte
measurement and native-uninstall proof. Product-registry and run-directory
cleanup after that proof is best-effort diagnostic hygiene. Unknown
measurements are `null` with an explicit blocker; they are never invented.
Canonical report v2 has no direct installed-directory input and rejects
missing, unknown, partial, or legacy startup fields.
Startup timing is not part of this report or its release budget. Full
installed-app startup evidence remains opt-in.

`size-baselines/windows-x64.json` records the actual pre-change artifacts.
`size-budgets/windows-x64.json` is created only from measured post-change
artifacts with explicit headroom. A missing measurement cannot pass a gate.

Measured Windows x64 evidence for this implementation:

| Artifact | Before | After | Change |
| --- | ---: | ---: | ---: |
| Runtime executable | 206,652,755 | 21,567,461 | -89.563% |
| NSIS installer | 208,071,907 | 23,431,713 | -88.739% |
| Installed core-only app | unavailable | 32,001,423 | no comparable baseline |

The selected onefile core remains smaller than the previously measured
42,197,350-byte onedir candidate.
The executable and NSIS budgets add exactly 10% headroom to the measured after
values. The old installed-size baseline remains an explicit `null` value; no
historical value was inferred.

## CI, Release, and Nx Gates

Required Nx and release targets:

- `build-core-executable`
- `build-ocr-worker`
- `build-speech-recognition-worker`
- `build-diarization-worker`
- `generate-engine-catalog`
- `verify-core-boundary`
- `verify-worker-boundaries`
- `bundle-size-report`
- `size-regression-check`

Push CI on `main` runs the non-mutating boundary, package, desktop-product,
and reference-flow gates (pull requests run only the quick `checks` job). CI uploads inventory, xref, and
warnings with always/warn semantics, but it does not install or uninstall the
NSIS candidate, emit canonical installed-size evidence, or run the strict size
budget.

The `build-candidate` job of `release-candidate.yml` is the sole owner of exact
installed-size and strict budget proof (`size-regression-check`, or
`size-regression-check-model-enabled` against
`size-budgets/windows-x64-model-enabled.json` for a model-enabled release). After rebuilding and staging the production runtime and building
the NSIS installer, it performs the size-only install/native-uninstall proof,
runs `size-regression-check`, copies the canonical report and SHA-256 into the
release directory, and only then assembles and uploads the candidate for
publication. A measured budget regression, missing evidence, forbidden
package/platform content, or mismatch among ZIP bytes, inner manifests,
catalog, runtime manifest, release directory, and staged NSIS resources fails
closed before candidate upload or publication.

The canonical report measures
`dist/release/capture-runtime-x86_64-pc-windows-msvc.exe`, which is the exact
runtime asset copied into the candidate and later published. The
`runtimeExecutable.path` field is that actual measured path, `fileName` is
exactly its basename, and `bytes`/`sha256` bind those same candidate bytes.
The raw `dist/executable/capture-runtime.exe` PyInstaller intermediate is not a
release-report identity. Report v2 schema and publisher comparisons remain
strict.

## Test Plan

Unit tests cover descriptor/catalog/state validation, checksums, traversal,
UNC/absolute/symlink/collision/bomb/unlisted-file rejection, atomic activation,
rollback, concurrency, and offline readiness.

Worker tests use a deterministic executable/script to cover probe/run,
protocol mismatch, malformed/multiple/oversized output, timeout, cancellation,
shutdown cleanup, and absence of bearer-token material from environment/argv/
stdin.

Release tests cover core and worker dependency boundaries, exact ZIP/manifests,
catalog/release consistency, core-only staging, and size-report/budget logic.
Existing runtime API/schema/provenance, Tauri Rust, package QA, deterministic
desktop smoke, and full workspace gates remain the behavior-preservation floor.

Real OCR, speech and Ollama journeys are local and manual; deterministic
evidence is not described as real-engine proof.

The checked-in development catalog lists every requirement as unavailable;
release catalog generation requires the approved model source lock and fails
closed otherwise. Model ZIP inputs and
`CAPTURE_*_MODEL_ARCHIVE`/`CAPTURE_*_MODEL_MANIFEST` environment variables are
retired.

## Install lock and archive paths

- The per-requirement `.install.lock` is a persistent inert file guarded by a
  non-blocking OS-owned exclusive lock. Process exit releases ownership; the
  file is never unlinked after unlock, avoiding stale-file deadlock and
  unlink-after-unlock races.
- Archive components reject Windows-illegal characters, control characters,
  trailing dots/spaces, and case-insensitive reserved device basenames,
  including names with extensions. `files-manifest.json` is capped at 4 MiB
  from its `ZipInfo.file_size` before it can be read.

## Acceptance Criteria

- Initial NSIS contains only core runtime metadata/schema bytes and no optional
  engine/model/Ollama payload.
- Core has no engine dependency and owns the job lifecycle.
- Engines install from runtime-owned pinned/checksummed catalog artifacts,
  activate atomically, roll back, and run offline after installation.
- API, schemas, `CaptureClient`, `CaptureDocument`, requirement IDs,
  cancellation, renderer token isolation, local history, and structuring modes
  remain compatible.
- DirectML policy and provenance are unchanged and fail closed.
- A pre-existing unlocked install lock file permits installation, while a lock
  held by a separate process rejects concurrent installation.
- Windows-unsafe archive paths and an oversized inner files manifest are
  rejected before extraction or manifest allocation.
- Catalog/manifests/assets agree exactly and size/boundary gates pass.
- `corepack pnpm verify` passes.
