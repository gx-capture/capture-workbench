# Capture Runtime Phase 2 hardening (canonical design)

Status: canonical design for the producer-owned OCR pipeline, compute
selection, runtime lifecycle and acceptance evidence, first shipped in 0.4.2
(2026-09-27). The [release runbook](../GUIDES/release-runbook.md) owns the
release procedure. Open work: [#247](https://github.com/gx-capture/capture-workbench/issues/247) (iGPU selection test and installed proof).

## Purpose and non-goals

Phase 2 hardens the existing producer-owned OCR and runtime lifecycle behind
deep modules, then proves the same bytes through candidate, publication,
download-back, and repeated consumer acceptance. It preserves the public
contract floor while making ownership, identity, cleanup, and evidence
mechanically checkable.

Non-goals:

- PDFium rasterizes every requested PDF page; PaddleOCR is the only extraction
  source. Embedded PDF text is never read, and no hybrid or LLM-routed path is
  introduced.
- Hosts do not create Paddle engines, choose devices, persist model paths,
  hold process handles, or name-kill processes. Cert Prep and GX Law Prep own
  durable domain data; runtime jobs and run-scoped staging are ephemeral.
- Package QA, fake OCR, snapshots, screenshots, local source-tree imports, and
  successful exit codes are not substitutes for real installed or published
  acceptance.
- A selected DirectML construction or inference failure never retries another
  device or silently falls back to CPU. Indeterminate hardware remains
  indeterminate/unavailable.

## Responsibility map

The producer owns runtime policy and execution truth. A host receives semantic
results and owns domain persistence only.

| Responsibility | Producer (`capture-runtime`, launcher, desktop harness) | Cert Prep / GX Law Prep |
| --- | --- | --- |
| OCR | `OcrPipeline`, PDFium rasterization, Paddle profile, normalization, page order, confidence, provenance, and typed failures | Invoke the public capture/ocr seam through an adapter; never create or route an OCR engine |
| Compute | `OcrComputePlan`, hardware truth, model/profile/catalog identity | Render readiness/notice; never probe, rank, select, or persist a GPU ordinal |
| Process lifecycle | `capture-sidecar-launcher`: one launch path, a kill-on-close Job per root, descendant cleanup, and termination proof | Launch and stop through the crate's ownership token; never hold OS handles or name-kill |
| Acceptance | Desktop acceptance in this repository (`acceptance-real`, practical installed OCR, `acceptance-three-projects`) and the manifests it writes through `tools/acceptance-contract.ts` | Each product runs its own acceptance gate and writes its own manifest. Cert Prep: `acceptance-real`. LAW: `law-prep-web-e2e:acceptance-real`. Releases are gated by those consumer gates |
| Version/release | One inventory, candidate bytes, manifests, publication ledgers, download-back, and stable-pointer policy | Pin exact bytes and verify before model start |

Runtime/model caches are durable only where explicitly declared. Staging,
listeners, and owned processes are ephemeral: the Job object stops the
processes and releases their listeners, and the runtime cleans its own
leftovers when it starts (see [Runtime process lifecycle](#runtime-process-lifecycle)).
Tauri may request a semantic operation but never owns or mutates a native Job.

## Public contract floor and identity

Phase 2 preserves API `2.0`, raw and structured document schema `2`,
`CaptureOcrProjectionV3` schema `3`, and one contract-set SHA-256
(`packages/capture-runtime/src/capture_runtime/assets/contract-set.sha256`). The
authenticated `GET /v2/captures/{capture_id}/ocr` route remains the typed
projection seam. No private process, device, path, bearer token, model, or
performance field is added to an HTTP route, SDK, public document, or UI
property.

Every requested page is represented in source order. Empty and failed pages
remain present, recognized regions have bounded polygons and scores, and raw
schema-2 segments are composed only from the normalized projection. A public
contract change requires a separate design, regeneration, and review.

The exact identity rule is tiered, not relaxed:

| Tier | Required identity |
| --- | --- |
| Local E2E | The selected local package, runtime, worker, model/profile, catalog, and contract identities are bound at their declared local tier. A local path or package build is not a release identity. |
| Candidate/release | The manifest binds exact source HEAD, version, artifact bytes, runtime/worker/model/profile/catalog hashes, schema versions, and the runtime contract-set hash. Every consumer uses those bytes, not a source tree or mutable URL. |
| Published acceptance | Each consumer runs its own acceptance gate on the downloaded candidate bytes. The release hard identity is exact SHA-256 equality, not a semantic version or average of checks. |

## Deep-module design discipline

An external interface is the smallest stable seam that carries inputs, results,
ordering, invariants, typed errors, cancellation, configuration, and resource
proof. Platform, transport, and failure-injection seams are internal adapters;
they are not promoted merely to make tests convenient. Deepening means
convergence/replacement of the existing owner, followed by deletion tests. It
does not mean adding a coordinator around the current shallow paths.

### `OcrPipeline`

The chosen design (O1) keeps PDFium/Paddle ownership in the producer and
preserves schema 2/3 output.

#### O1: one terminal operation

Interface shape:

```text
OcrPipeline.extract(request: OcrRequest, engine: OcrEnginePort)
  -> OcrTerminalOutcome
OcrTerminalOutcome = Projection(CaptureOcrProjectionV3)
                   | Failure(SanitizedOcrFailure)
```

`OcrRequest` carries capture id, source kind, page scope, validated manifest,
creation time, warnings, and cancellation. `OcrEnginePort` accepts the
producer-owned normalized/raster page request and returns a bounded observation
or typed engine error. The host-facing usage is one call:

```text
outcome = pipeline.extract(request, producer_engine)
return outcome.to_public_projection_or_failure()
```

Hidden internals own source/page planning, PDFium rasterization, normalization,
ordered projection, provenance, serialization, cancellation, and sanitized
terminalization. At the current head, the producer extractor's `_extract_pdf`
and `_render_pdf_page` are the PDFium adapter to migrate behind this seam; the
current split is not a reason to add another coordinator. Dependencies are the
private PDFium adapter, worker transport adapter, `OcrEnginePort`, and schema
validators; deterministic in-memory engine and raster fixtures are test
adapters. The advantage is a deep common-caller
seam and one terminal proof. The trade-off is less convenient streaming and a
bounded in-memory/page-result policy must be explicit. Its deletion surface is
the current public normalization/serialization/failure helpers in
`ocr_projection.py`; tests migrate to terminal outcomes and deletion tests
prove callers no longer duplicate page policy. Tests cover every-page order,
empty/failed pages, cancellation, malformed manifests, worker failure, and
schema/contract identity.

#### Chosen O1, constrained by repository facts

Choose O1. The repository already has `OcrPipeline.extract`, an
`OcrEnginePort`, producer-owned worker and extractor adapters, and three caller
families. A terminal operation hides page policy and lets those callers cross
one deep seam. The implementation is convergence/replacement: retain a
compatibility adapter only while callers migrate, then make page normalization,
serialization, and failure helpers private or delete them. The chosen method
does not expose Paddle kwargs, source paths, model paths, process handles, or
private diagnostics. It is a design decision, not evidence that the code has
already been changed.

## Runtime process lifecycle

`capture-sidecar-launcher` owns the native process lifecycle for every host.
There is one launch path and it writes nothing to disk:

- **Launch.** The host verifies the manifest and executable
  (`load_manifest`, `validate_manifest_contract`, `verify_sidecar`), reserves a
  fresh loopback port (`reserve_loopback_port` or
  `reserve_distinct_loopback_port`) and generates a fresh bearer token
  (`generate_bearer_token`) for every launch attempt. `launch_sidecar` or
  `launch_sidecar_with_observer` then makes up to 3 attempts within 60 seconds
  (`LaunchOptions::default()`), probes `GET /v2/health/ready` with that token,
  and returns a `LaunchedSidecar` only when the handshake matches the manifest.
  An old listener cannot pass for the new runtime because it does not know the
  new token. A host that runs its own process uses `OwnedRuntimeSession::spawn`
  or `OwnedSidecarProcess::spawn`.
- **Containment.** Every root is created suspended and without a window,
  assigned to a new unnamed Job configured with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and no breakaway, checked with
  `IsProcessInJob`, and only then resumed. A child that asks for breakaway is
  refused. If assignment or resume fails, the root is stopped before the call
  returns.
- **Live cleanup.** `OwnedRuntimeSession::monitor_root_exit` lets a host poll
  for an unexpected root exit; it terminates the Job and returns the exit only
  after the root is reaped and the Job reports no process.
  `terminate_and_prove` stops an attempt and returns `RuntimeTerminationProof`.
  A failed proof keeps the process and Job handle for a retry. Dropping the
  last `OwnedRuntimeSession` clone stops the attempt.
- **Host crash or kill.** The system closes the host's Job handle and stops
  the runtime root and every descendant (the onefile child, Ollama, and the
  workers), which releases their listeners. Nothing blocks the next start.
- **App-data directory lock.** `capture-runtime serve` acquires a
  non-blocking exclusive OS lock on `<app_data_dir>/runtime.lock`
  (`storage/app_data_lock.py`) before running any startup sweep or creating the
  FastAPI app, and keeps the file handle open until the process exits. If
  another Capture Runtime still holds that lock after a 10-second wait
  (Windows releases a stopped process's lock asynchronously), startup leaves existing files
  untouched, writes one path-free line to stderr, and exits with code `10`
  (`EXIT_APP_DATA_IN_USE`).
- **Runtime startup sweeps.** The runtime cleans its own leftovers when it
  starts: `_MEI*` extraction folders
  (`_frozen_extraction_residue.py`), `*.upload` and `*.spool` files in
  `app_data/jobs/staging` (`app.py`), interrupted installs, which are marked
  `runtime_restarted` (`installation_repository.py`), and engine install
  leftovers (`_engine_installation_residue.py`). Partial downloads resume from
  their `.part` file and are checked by SHA-256
  (`_engine_installation_download.py`).

The hosts use this path as follows:

| Host | Launch | Supervision |
| --- | --- | --- |
| Capture Workbench desktop | `launch_sidecar_with_observer` at setup and when the compute setting changes | Keeps the `OwnedRuntimeSession` clone and polls `monitor_root_exit` every 100 ms; a runtime exit becomes a failed status and is not relaunched automatically |
| Cert Prep | `launch_sidecar` for Capture Runtime; `OwnedSidecarProcess::spawn` for its own backend | Keeps the ownership value and stops it with `terminate` on shutdown or replacement |
| GX Law Prep | `OwnedRuntimeSession::spawn` for each of its runtime processes | Each process has its own Job and is stopped with `terminate` |

Limits that follow from this design:

- The launcher keeps no record of what it started, so after a power loss or
  an operating-system kill it relies on every process being gone. The startup
  sweeps above remove what such a stop leaves on disk.
- Ollama's `ollama.pid` survives a power loss. The file records the PID and
  the process creation time. A live PID with the same creation time is the
  same process, and the runtime refuses to start a second one. A live PID
  with a different creation time has been reused: the runtime removes the
  stale file and continues. A file without a creation time, or a creation
  time that cannot be read, keeps the conservative refusal.
## Canonical compute decision truth table

`OcrComputePlan.select(input)` consumes one immutable producer hardware snapshot
and returns one immutable selection. The readiness result and engine session
use that same selection; hosts never select or persist an ordinal.

The exact implementation owner is
`packages/capture-runtime/src/capture_runtime/ocr/infrastructure/ocr_preflight.py:OcrComputePlan.select`
with `OcrGpuCapabilitySnapshot`; its tests are in
`packages/capture-runtime/tests/unit/test_ocr_compute_plan.py`. A focused
regression for a positively unavailable dGPU beside a usable iGPU is still
missing ([#247](https://github.com/gx-capture/capture-workbench/issues/247)); the existing
indeterminate-dGPU test is a separate fail-closed case.

| Snapshot | Selection | Failure/fallback rule |
| --- | --- | --- |
| A usable discrete GPU with complete LUID/ORT mapping | DirectML on the selected dGPU, with exact LUID join and ordinary ORT ordinal | No CPU fallback after selected construction or inference failure |
| No usable dGPU and a usable integrated GPU with complete mapping | DirectML on the selected iGPU | Same terminal failure rule |
| No usable GPU and policy permits CPU notice | CPU with an explicit noticed readiness result | CPU is not a recovery path after a selected GPU failure |
| Probe timeout, exception, unknown adapter, incomplete mapping, or indeterminate state | Indeterminate/unavailable | Do not guess, rank, or persist an ordinal |

This table replaces the earlier adapter-`0` default and the
`CAPTURE_WINDOWSML_DEVICE_ID` host override. The DirectML provider policy,
provenance meaning, and production environment gate are in
[gpu-ocr-directml.md](gpu-ocr-directml.md).

## Acceptance

Each consumer runs its own acceptance gate and writes its own manifest.
Cert Prep's gate is `acceptance-real`. LAW's gate is
`law-prep-web-e2e:acceptance-real`. A release is gated by those consumer
gates. The [release runbook](../GUIDES/release-runbook.md) owns the procedure.

Desktop acceptance in this repository (`acceptance-real`, practical installed
OCR, and `acceptance-three-projects`) writes its own manifests through
`tools/acceptance-contract.ts`. `acceptance-real` is a diagnostic, not release
evidence.

## Version, schema, projection, and release-channel inventory

`tools/release/version-sources.ts` (`collectReleaseVersionEntries()`, tested
by `capture-tools:release-version-test` and run by
`capture-tools:release-version-check`) inventories every version, schema,
projection and contract identity. `release/version.json` is the release
intent; the runbook describes the version workflow.

The release channels are distinct and each is represented in the candidate and
release manifests: npm on GitHub Packages (`npm-github-packages`: the Workbench
UI and the TypeScript runtime client), PyPI (`pypi`: the Python runtime
client), crates.io (`crates-io`: `capture-sidecar-launcher`), and GitHub
Releases (`github-releases`: runtime, engine and desktop assets and the
immutable release manifests). Their only publication owners are
`_publish-npm.yml`, `_publish-pypi.yml`, `_publish-crates.yml`,
`_publish-github-release.yml`, `_publish-runtime-github-release.yml` and
`_verify-registries.yml`, orchestrated by `release-promote.yml`; the stable
pointer is moved only by `_publish-stable-pointer.yml`. No local script or
consumer may mutate it.
