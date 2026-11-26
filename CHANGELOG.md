# Changelog

## Unreleased

### Compatibility policy

Capture Workbench follows an explicit 0.x compatibility policy:

- While the runtime is `0.x`, a minor-version change may be breaking.
- Capture Workbench clients therefore require the same runtime major and minor
  version during the readiness handshake; patch updates remain compatible.
- The in-scope consumers are the published Web Component package, Cert
  Prep's Angular, Python, and desktop hosts, and LAW's web app and Python AI
  service. They must be deployed on the same minor before a runtime release
  is enabled.
- `compatibleRuntimeMinor` is a temporary, explicit break-glass setting for a
  coordinated rollback or split-minor migration. Remove the override after the
  consumer and runtime are aligned; reverting the consumer package is the
  rollback path if an undiscovered incompatibility is found.

The consumer consistency check is a permanent CI gate for the declared
runtime, package lock, Python host, desktop host, and browser host versions.

### The diagnostic log records while the runtime serves

In 0.11.0 the runtime's diagnostic log
(`<app data>/logs/runtime-diagnostics.log`) received only the `runtime-start`
line: the server's logging setup closed the log's handler right after it was
attached. A worker failure or a capture's end left no line, so a failed
capture could not be traced afterwards. The log is now attached after the
server has configured logging, and records worker failures, capture ends and
expired waits for cancelled captures for as long as the runtime runs.

## 0.11.0

Capture now calls OCR text recognition and uses `recording` for audio and
video captures. The runtime selects and reports its own structuring device.
Workbench shows live transcripts and treats captures as belonging to the app
run that started them. Installed engine verification survives restarts, and
full releases publish manifest v2.

The contract set (`7802e8b8…`) and capture document schema (`7d2262f1…`)
change from 0.10.0. The text recognition sources are pinned to the snapshot
for `capture-runtime-model-sources-v0.11.0` (OCR profile
`ocr-c3a409ecfd46b9ab`). The external model pins and private speech fixture
are unchanged. Upgrade the runtime and its consumers together.

### Breaking for clients and hosts: moving from 0.10.0

- The contract-set SHA-256 moves from
  `91ff5ff5cef6d68774cf036878843503f171044bf8c4a9f6a62e7fb418ce2380` to
  `7802e8b85d45e687f2ad0ee9980f03e26b5a5ad43d9df079bfacc2ddbfa6780a`.
  The capture document schema SHA-256 moves from `5452631c…` to
  `7d2262f13489df24eab83f8c3b5a5b5b7f5e8f7af0f521ac1b247ae86df9b493`.
- Capture kind `audio` → `recording`. Requirement ids `windowsml-ocr` →
  `text-recognition`, `ollama-runtime` → `structuring-runtime`, and
  `capture-ollama-model` → `structuring-model`. A requirement's `kind`
  is now its id. Fresh requests must use current values. General
  installation rejects `structuring-model`. Use
  `POST /v2/runtime/structuring-model-installations` for that model.
- Text recognition provenance `engine` changes with the requirement id.
  Its `device` changes from `windowsml-dml` to `directml` and its `model`
  from `pp-ocrv6-medium-windowsml` to `pp-ocrv6-medium`. The display name
  is now “Text recognition.” `OcrComputeMode` changes from `gpu-dml` to
  `gpu`, and `dml_provider_unavailable` becomes `gpu_provider_unavailable`.
- Rename `CAPTURE_WHISPER_PREFER_GPU` to `CAPTURE_SPEECH_PREFER_GPU` and
  `CAPTURE_WHISPER_ALLOW_CPU_FALLBACK` to
  `CAPTURE_SPEECH_RECOGNITION_ALLOW_CPU_FALLBACK`. Remove
  `CAPTURE_WINDOWSML_MODEL_DIR` and `CAPTURE_OLLAMA_PROFILE_ID`.
  Runtime startup rejects all four old variables.
- `GET /v2/streaming/health/ready` is removed. Use `GET /v2/health/ready`.
  The operation id changes from `v2.streaming.health.ready` to
  `v2.health.ready`. Read `RuntimeCapabilities` in `RuntimeReady.capabilities`
  and remove `RuntimeDiscovery.streaming`. Use `supportsProgressiveRecording`
  (Python `supports_progressive_recording`)
  in place of `supportsProgressiveAudio` (`supports_progressive_audio`).
  The `/v2/runtime/model-options` and `/v2/runtime/model-installations`
  routes move to `/v2/runtime/structuring-model-options` and
  `/v2/runtime/structuring-model-installations`, including installation
  status and cancellation under the new path.
- TypeScript SDK methods and Workbench client equivalents where applicable:
  `startStreamingCapture` → `startCapture`, `getStreamingCapture` →
  `getCapture`, `getStreamingPartial` → `getPartial`, `getStreamingRaw` →
  `getRaw`, `getStreamingResult` → `getResult`, `getStreamingEvents` →
  `captureEvents`, `cancelStreamingCapture` → `cancelCapture`, and
  `deleteStreamingCapture` → `deleteCapture`.
  `commitStreamingStructuredResult` → `commitStructure`,
  `reportStreamingStructuringFailure` → `reportStructuringFailure`,
  `getStreamingCapabilities` → `getReady`, `getModelInstallationStatus` →
  `getModelInstallation`, and `pullStructuringBatch` →
  `getStructuringBatch`. Replace `createCapture` with `startCapture`.
  `deleteIngestion` is available for ingestion cleanup.
- Python SDK: `start_streaming_capture` → `start_capture`,
  `get_streaming_capture` → `get_capture`, `get_streaming_result` →
  `get_result`, `cancel_streaming_capture` → `cancel_capture`,
  `commit_streaming_structure` → `commit_structure`,
  `report_streaming_failure` → `report_structuring_failure`,
  `delete_streaming_capture` → `delete_capture`, `delete_streaming_ingestion`
  → `delete_ingestion`, `get_model_installation_status` →
  `get_model_installation`, `pull_structuring_batch` →
  `get_structuring_batch`, and `get_streaming_capabilities` → `handshake`.
  Readiness now returns typed `capabilities` and `ocr_compute`.
  Model installation starts with `start_model_installation`, event
  iteration uses `capture_events`, and `upload_path` accepts
  `structuring_mode`.
- `structureStreamingCapture` and `structureCapture` are removed.
  The runtime still serves `POST /v2/captures/{capture_id}/structure`,
  returning `CaptureDocument`. The capture's `GET /result` returns the
  `CaptureResult` envelope.
- Contract types: `StreamingCaptureStatus` → `CaptureStatus`,
  `StreamingIngestionStatus` → `IngestionStatus`, `StreamingIngestionMode`
  → `IngestionMode`, `StreamingEventType` → `CaptureEventType`,
  `CaptureStreamingResult` → `CaptureResult`, `RuntimeStreamingCapabilities`
  → `RuntimeCapabilities`, and `CaptureFailure` / `CaptureFailureV2` →
  `OperationFailure`. The `RuntimeModelOption` and
  `RuntimeModelInstallation` families use the `StructuringModel` prefix.
  The problem registry names `ErrorDetails` in place of `ErrorDetailsV2`.
- Import `CaptureReview` and `CaptureReviewEdit` from the Workbench UI.
  For a Workbench client, replace `StartStreamingCaptureRequest` and
  `CreateCaptureRequest` with `StartCaptureRequest`,
  `CommitStreamingStructuredResultRequest` with
  `CommitStructuredResultRequest`, and
  `ReportStreamingStructuringFailureRequest` with
  `ReportStructuringFailureRequest`. Handle `capture_client_unavailable`
  in place of `streaming_client_unavailable`.
- Fields: `contractSha256` → `contractSetSha256`, OCR projection
  `pageCount` → `processedPageCount`, pull-session `rawSourceSha256` →
  `sourceSha256`, discovery index `schemaSha256` →
  `captureDocumentSchemaSha256`, model option `expectedBytes` →
  `downloadBytes`, and `suggestedUnits` → `suggestedRequirementIds`
  (Python `suggested_units` → `suggested_requirement_ids`).
  Remove `RuntimeReady.schemaSha256` and the discovery index's
  `catalogVersion`. Schema entries and the launcher manifest still use
  `schemaSha256`, and the engine catalogue still uses `catalogVersion`.
  Pass `expectedCaptureDocumentSchemaSha256` to the TypeScript client.
  Passing the old `expectedSchemaSha256` throws.
- To open a pull session, put the capture id in the route and send a
  nonblank `X-Idempotency-Key`. Remove body fields `captureId`,
  `clientRequestId` and `providerCapability.capability`. Supply
  `profileId` and keep the provider's actual model in its identity.
  OCR profile ids now use `ocr-<16 hex>` and structuring profiles use
  `qwen` in place of the `capture-workbench-qwen` prefix. A fresh
  pull-session request with a retired profile id gets 422
  `validation_error`.
- `kind` is required on `OpenIngestion`, `Ingestion`, `CaptureOperation`
  and `CaptureEvent`. Captures start at `extracting` or `waiting_input`.
  Remove capture status `created`, ingestion statuses `finalizing` and
  `expired`, and model option status `installed`. Handle an absent
  `PartialCapture.coveredUntilMs` for documents and for recordings whose
  coverage is unknown. `GET /ocr` on a recording is 409
  `ocr_unavailable`. A chunk whose `Content-Range` end is at or beyond
  the total gets 422 `invalid_chunk_headers` before the size check.
- Failure codes: `progressive_failed` → `extraction_failed`,
  `progressive_interrupted` → `capture_interrupted`,
  `progressive_output_invalid` → `extraction_output_invalid`,
  `progressive_no_text_at_sample` → `extraction_no_text` (non-retryable,
  stage `extraction`), `streaming_source_unavailable` →
  `ingestion_source_unavailable`, and `installation_filesystem` →
  `installation_timeout` or `installation_io_failed`. A stored
  `installation_filesystem` job reads as `installation_failed`. The
  SDKs drop the `authentication_failed` alias, classify HTTP 401 as
  authentication, and classify HTTP 403 as authorization regardless of
  its body. Update structuring device checks as described below.
- Desktop IPC: `runtime_start_streaming_capture` →
  `runtime_start_recording_capture`. The `runtime_get_streaming_`
  commands for `capture`, `events`, `partial` and `result` become
  `runtime_get_capture`, `runtime_get_capture_events`,
  `runtime_get_partial` and `runtime_get_result`. Replace
  `runtime_delete_streaming_capture`, `runtime_cancel_streaming_capture`
  and `runtime_cancel_capture` with `runtime_delete_capture`. Remove
  `runtime_structure_streaming_capture` and `runtime_structure_capture`.
  Documents still use `runtime_create_capture` with page selection.
  The library rejects new `persisting` and `recovery_required` statuses
  and recovery fields. Earlier rows remain readable.
- Launcher crate: `OwnedRuntimeSession` → `OwnedSidecarSession`,
  `RuntimeTerminationProof` → `SidecarTerminationProof`,
  `RuntimeCleanupError` → `SidecarCleanupError`,
  `RuntimeCleanupErrorKind` → `SidecarCleanupErrorKind`,
  `reserve_loopback_port` → `pick_free_loopback_port`, and
  `reserve_distinct_loopback_port` → `pick_distinct_free_loopback_port`.
- Contract bundle schema files remove the version suffix before
  `.schema.json` from these stems:
  - `-v2` on `capture-event`, `capture-operation`, `error-body`,
    `error-envelope`, `finalize-ingestion`, `ingestion`,
    `ocr-compute-preflight`, `ocr-page-scope`, `open-ingestion`,
    `open-structuring-session`, `partial-capture`,
    `report-structuring-failure`, `runtime-artifact-descriptor`,
    `runtime-installation`, `runtime-installations`,
    `runtime-requirement`, `runtime-requirements`, `start-capture`,
    `start-runtime-installation`, `structuring-batch`,
    `structuring-provider-capability`, `structuring-semantic-block`,
    `structuring-session` and `submit-structuring-batch`.
  - `-v3` on `capture-ocr-projection`, `ocr-box`,
    `ocr-page-projection`, `ocr-point`, `ocr-provenance`,
    `ocr-provenance-resolved`, `ocr-provenance-unavailable` and `ocr-raster`.
  - Stems also change: `capture-failure-v2` → `operation-failure`,
    `capture-streaming-result` → `capture-result`, both forms of
    `runtime-streaming-capabilities` → `runtime-capabilities`, and
    `runtime-model-{option,options,installation,installations}-v2` →
    `structuring-model-{option,options,installation,installations}`.
    `start-runtime-model-installation-v2` becomes
    `start-structuring-model-installation`.
  The standalone release asset is still `capture-document-v2.schema.json`.
- Update release automation for manifest v2 and the candidate verification
  summary below. Replace the `smoke-real-engines` target in
  `capture-workbench-e2e` and the `chromium-real-engines` Playwright project
  with the split installation and execution checks below. Remove
  `CAPTURE_REAL_ENGINES_REUSE_INSTALLED`.

### Consumers

- Cert Prep and LAW Prep should pin the runtime, the Web Component
  (`@gx-capture/capture-workbench-ui`), `@gx-capture/capture-runtime-client`,
  Python's `capture-runtime-client` and `capture-sidecar-launcher` to 0.11.0
  wherever used. Update both digests. The Web Component defaults to matching
  the runtime's major and minor. The Python SDK checks the exact runtime
  version.
- Migrate fresh requests and decoders to the new contract. The runtime reads
  supported 0.10.x records through compatibility adapters without migrating
  them on read. The Desktop App displays and exports stored library results
  as recorded.

### Text recognition is named by what it does

- Runtime startup removes the retired `engines/windowsml-ocr` and
  `runtime-assets/windowsml-ocr` directories under the app-data lock
  without following links. Reinstall text recognition. Unchanged model
  downloads can be reused from the cache.
- Stored OCR evidence remains readable. The runtime translates
  `pageCount` and `contractSha256` together in historical OCR projections.
  A projection mixing old and new keys is rejected.

### Speech settings are named by what they control

- `CAPTURE_SPEECH_PREFER_GPU` controls speech recognition and speaker
  identification. Speech recognition CPU fallback is on by default and
  controlled separately from worker mirroring. Set
  `CAPTURE_SPEECH_RECOGNITION_ALLOW_CPU_FALLBACK=false` to disable it.
- The Desktop App forwards worker-mirror and local OCR model overrides only
  with the respective verification opt-in and a loopback mirror URL or an
  absolute model root.

### A recording is the capture kind for audio and video

- Stored capture and ingestion metadata and events with `audio` or a
  missing kind read as `recording`. A stored document partial with
  `coveredUntilMs` of zero reads without that field.
- Old structuring installation and selection records remain readable.
  Host-commit retries and installation replays verify the historical
  fingerprint before translating the record.

### One readiness document, and client methods named by the action

- Readiness advertises capture kinds, structuring modes, cancellation and
  raw diagnostics, upload and chunk limits, timing and progressive recording
  support. SDKs take their chunk limit from readiness and fetch the contract
  index and bundle separately. The heartbeat uses the advertised interval.
  TypeScript rejects empty `structuringModes` or `maxChunkBytes` over 4 MiB.
- The Web Component forwards `pdfPageNumbers` only for PDF captures.
  Desktop IPC's `runtime_get_result` returns the terminal result envelope.

### What a failed capture and `/structure` report

- Discovery separates HTTP `problems` from job `failureCodes`, which both
  SDKs require. Host-reported structuring failure codes are kept as
  submitted, including codes that the runtime has retired.
- Caller-driven `POST /v2/captures/{capture_id}/structure` returns
  503 `requirement_unavailable` for a missing or unavailable provider.
  Invalid output or mismatched provider provenance gets 422
  `structuring_invalid_output` with a fixed message. Failed or abandoned
  requests release the capture back to `awaiting_structuring` for retry.
  An explicit capture cancel ends it as `cancelled` and the structure
  request can return 409 `invalid_capture_state`.
- Worker failures report `speech_recognition_worker_failed` or
  `speaker_identification_worker_failed` at stage `extraction`, with
  `retryable: false`. Engine-resolution timeouts report
  `requirement_unavailable`. An unconfigured extractor reports
  `extraction_runtime_unavailable` with `retryable: false`.
- Model installation retries are for transient failures. An invalid option,
  profile digest, or model digest or size is a permanent failure. Uninstall
  reports 409 `requirement_in_use` for active captures or installations,
  a busy install lock or a Windows file sharing or lock violation. Other
  uninstall execution failures report 500 `uninstall_failed`. Disabled
  structuring model management reports `requirement_disabled`.
- The runtime writes `<app_data_dir>/logs/runtime-diagnostics.log` in UTF-8,
  rotating at 1 MiB with three backups. It records runtime start, worker
  failures (requirement, code, failure class, exit code, cause type, worker
  stages and elapsed milliseconds) and each capture's terminal outcome.
  It never includes tokens, ids, file names, paths or content. Hosts that
  discard runtime stderr can read this file.

### Structuring runs on the device the runtime selects

- On Windows, the runtime-owned Ollama selects a dedicated GPU by dedicated
  memory, with NVIDIA then AMD preferred for ties. It uses CUDA for NVIDIA
  and pins the GPU by UUID when identified, ROCm for AMD, Vulkan for other
  dedicated or integrated-only GPUs, and CPU when no physical GPU is
  present. Incomplete inventories, unknown adapters without a confirmed
  dedicated GPU and non-Windows hosts leave selection to Ollama.
- A verified first-batch mismatch can trigger one restart and batch replay.
  Check `CaptureEngine.device` for the observed `cuda`, `rocm`, `vulkan` or
  `cpu` backend, and `deviceName` for the observed GPU description when
  available. Unknown observations and external Ollama leave device
  provenance unset. Older documents with `local` or `remote` remain readable.
- Batches use the session's configured context length (8192 by default),
  including batches for host providers. Output budgets remain adaptive.
  A historical model selection is accepted only if its option, base model
  and profile digest match. Previously accepted batches replay with their
  original digest.

### Installed engines keep their verification, and installation stays answerable

- The runtime reuses `verified-files.json` across restarts if its binding
  to the active engine or model and the installed file snapshot match.
  Missing, unreadable or stale records trigger full verification.
- Installation's blocking file operations no longer hold up status reads.
  The desktop transport reports a socket read timeout as “Capture Runtime
  sent no data for 60 seconds.” A stalled body read can trigger it as well.
- Live installation progress stays current while periodic progress writes
  occur at most once a second per job. A runtime shutdown leaves unfinished
  installations to be recovered as `runtime_restarted`.
- Workbench keeps the last installation progress visible and retries failed
  polls after 1, 2, 4 and then 8 seconds. On 404, it checks the requirements
  installation list for a current job or refreshes model options, depending
  on the job type. Confirmed cancellation stops that job's poll.
- On startup the runtime removes inactive versions of models-only units
  when it can do so safely.

### A capture belongs to the app run that started it

- Workbench starts one document or recording at a time, taking the oldest
  waiting item whose feature is ready. A previous run's unfinished row is
  shown as interrupted. Once the runtime is ready, Workbench requests
  cleanup of old capture links without waiting for a reply.
- In Workbench, Cancel aborts an in-flight upload or deletes its capture when
  an id is available. The row is saved as cancelled even if the runtime
  delete times out. Once the terminal write has been sent, Cancel is ignored.
- Success saves the result and clears the capture link in one library update.
  OCR success comes from its checkpoint and saves completed recognition
  evidence once. Failed or cancelled attempts save no partial result or OCR
  evidence from that attempt.
- Failed, cancelled or interrupted rows without raw text offer Start again.
  Workbench leaves failed attempts for the user to restart. To recapture a
  row with raw text, delete and reimport it. History can delete idle rows
  even if they still have a runtime link, without waiting for runtime cleanup.
  If a reload loses the capture id during upload, runtime retention handles
  the orphan (24 hours by default).
- While a recording runs, Workbench polls for live transcript updates.
  The desktop event read returns when the stream ends, after 250 ms of
  silence following a complete event, or at the 10-second request deadline.
- Runtime `POST /v2/captures/{capture_id}/cancel` requests a stop and can
  return while the worker is still running. Use
  `DELETE /v2/captures/{capture_id}` and wait for its response when the
  worker needs to release the device. Worker close clears speech window
  files, and runtime startup sweeps abandoned session directories without
  following links.

### Release manifest v2 and the checks an operator runs

- Full releases publish the desktop installer and
  `capture-release-manifest-v2.json` with `schemaVersion` `"2"` and
  `releaseAssets` in place of `runtimeAssets`. Readers accept manifest v1
  and v2 under their respective filenames and schema versions. An operator
  can supersede a v1 release with a v2 release.
- `candidate-verification-summary.json` replaces `release-ledger.json`.
  Candidate verification and consumer gates check its identity and digests
  against the candidate. The reader accepts legacy summaries for older
  versions.
- Run `capture-runtime:verify-release-model-candidate` for 0.11.0. This
  check is required when the model source lock, an engine worker, or model
  delivery differs from the last published release. Re-pinning text
  recognition sources triggers it for 0.11.0.
- Worker archives are reproducible from the same build inputs. Worker
  builds track their own inputs so unrelated runtime changes can reuse
  the same archive.
- `capture-workbench-e2e:smoke-real-engines-installation` starts with empty
  app data and verifies downloads, installation, cancellation, re-attach
  and restart. `capture-workbench-e2e:smoke-real-engines-execution` reuses
  app data from the same build and asks for a reinstall if the installed
  engines differ. It checks real captures and devices, editing, export,
  restart and deletion. Both check the installed speech pack. Execution
  also checks live and final transcripts when both a long recording and
  its oracle are configured.
- On Windows, `capture-workbench-desktop:check-real-engine-devices`
  checks the expected, reported and observed device. The manual
  `diagnostic-installed-deterministic-capture-lifecycle` target in that
  project checks reload, close during capture and native file drops on
  the installed QA app. It is optional for release.

### The sidecar launcher names the process it starts

Keep using `launch_sidecar` or `launch_sidecar_with_observer` with the renamed
types. The session still provides `spawn`, `terminate_and_prove` and
`terminate`. The port helpers report a currently free port. The process
that uses it must bind it.

## 0.10.0

A minor release. Speech recognition ships as two packs, so a computer without
an NVIDIA GPU installs a CPU pack of about 3.72 GB instead of the 10.5 GB CUDA
pack; a host can choose the speech recognition model apart from the device; the
runtime owns the built-in Ollama's port; a full release publishes 19 assets
instead of 28; and the sidecar launcher crate keeps only the launch path hosts
use, which removes part of its public API. The contract set (`91ff5ff5…`), the
capture document schema (`5452631c…`) and the models are unchanged from 0.9.0.
The Web Component and the Python client refuse a runtime of another minor, so
every consumer moves together with the runtime.

### Breaking for clients and hosts: moving from 0.9.0

- Runtime minor 10. The contract-set SHA-256 is unchanged
  (`91ff5ff5cef6d68774cf036878843503f171044bf8c4a9f6a62e7fb418ce2380`, as in
  0.9.0). The Web Component requires the same runtime major and minor at the
  readiness handshake (see "Compatibility policy"), and the Python client
  requires a runtime of exactly its own version. A 0.9.x Web Component or
  Python client therefore refuses a 0.10.0 runtime, and the 0.10.0 ones refuse
  a 0.9.x runtime. Bump the runtime and every Capture client together; the
  pinned contract-set hash stays. Tests that quote runtime minor 9 move to 10.
- `capture-sidecar-launcher` 0.10.0 removes the group lifecycle (R3) API; the
  removed and the unchanged items are listed under "Sidecar launcher keeps one
  launch path" below. A host that uses only `launch_sidecar`,
  `launch_sidecar_with_observer` and `OwnedRuntimeSession` (`spawn`,
  `terminate_and_prove`, `terminate`) builds unchanged. The runtime no longer
  reads `CAPTURE_RUN_STAGING_DIR`.
- Speech recognition pack: when it installs speech recognition, the runtime
  picks `cuda` if the NVIDIA driver is present and `cpu` otherwise;
  `CAPTURE_SPEECH_RECOGNITION_VARIANT` (`auto`, `cuda`, `cpu`) forces one. A
  host that sets `CAPTURE_SPEECH_RECOGNITION_MODEL=tea-asr-1.1` on machines
  without the driver also sets `CAPTURE_SPEECH_RECOGNITION_VARIANT=cuda`
  before installing, or its captures fail with `requirement_unavailable`. A
  host that reads the engine catalog itself must read the `contents` of
  `speech-recognition` (`requirement.contents[].artifacts`).
- Built-in Ollama: `CAPTURE_OLLAMA_HOST` is no longer read for the built-in
  provider, and the runtime sets the child's `OLLAMA_HOST` itself. A host can
  stop passing both; values it still passes are ignored. The external provider
  (`CAPTURE_OLLAMA_ENDPOINT`) is unchanged.
- Release assets: the nine per-asset `.sha256` files of the runtime assets,
  `runtime-size-report.json` and its `.sha256` are no longer published. Verify
  the executable and the schema against `capture-runtime-manifest.json`, and
  each worker archive, part and `*-files.json` against
  `capture-engine-catalog.json`. New assets:
  `capture-engine-speech-recognition-cpu-0.10.0-windows-x64.zip` and its
  `-files.json`.
- `CAPTURE_WHISPER_PRIMARY_MODEL` and `CAPTURE_WHISPER_FALLBACK_MODEL` are
  removed; they never reached the worker.

### Consumers

Cert Prep moves first, then LAW, each together with the runtime:

- Cert Prep: bump every Capture pin (`@gx-capture/capture-workbench-ui`,
  `@gx-capture/capture-runtime-client`, the Python client and
  `capture-sidecar-launcher`) to exactly 0.10.0; the pinned contract-set
  SHA-256 stays. Tests that quote runtime minor 9 move to 10. Cert Prep no
  longer reads the runtime assets' `.sha256` files
  (`WodenWang820118/cert-prep#133`).
- LAW: its catalog reader must walk `requirement.contents[].artifacts` before
  it moves to this release, or staging and `release-desktop` fail with
  "Invalid Capture engine requirement."; that change must be on LAW `main`
  before the release candidate's consumer gate. Then bump the Python client
  with `apps/law-prep-ai-service/src/app/capture_version.py`, the npm packages
  its web app uses, `capture-sidecar-launcher` where used, and their test
  samples (runtime minor).

### Speech recognition pack per machine

Speech recognition ships as two packs, so a computer without an NVIDIA GPU no
longer downloads the GPU runtime and the large model it cannot use (issue #154).

- The engine catalog offers `speech-recognition` as two contents. `cuda` is
  the 0.9.0 pack: the CUDA worker with TEA-ASR 1.1, TEA-ASR 1.1 mini and the
  aligner, about 10.5 GB. `cpu` is a CPU worker
  (`capture-engine-speech-recognition-cpu-<version>-windows-x64.zip`, one file
  of about 302 MiB) with mini and the aligner, about 3.72 GB.
- The runtime picks the pack when it installs: `cuda` when the NVIDIA driver is
  present (`%SystemRoot%\System32\nvcuda.dll`), `cpu` otherwise. The runtime
  setting `CAPTURE_SPEECH_RECOGNITION_VARIANT` (`auto`, `cuda`, `cpu`) forces
  one. The installed pack is kept until it is uninstalled.
- On the CPU pack, transcripts report model `tea-asr-1.1-mini` and device
  `cpu`. `CAPTURE_SPEECH_RECOGNITION_MODEL=tea-asr-1.1` on a CPU pack fails the
  capture with `requirement_unavailable` (stage `extraction`, not retryable)
  before a worker starts; the requirement stays `ready` and its `detail` says
  how to fix it.
- `GET /v2/runtime/requirements` reports the size of the pack this machine
  would download, and once installed, of the installed pack. Mini and aligner
  files already in the machine-wide engine cache are not downloaded again.
- The CPU worker archive and its `-files.json` are new release assets (see
  "Release assets"). The requirement id, the contract set and the capture
  document schema are unchanged.
- Hosts: LAW's catalog reader must read `contents` before it moves to this
  release, or staging fails with "Invalid Capture engine requirement." Cert Prep
  needs only the usual pin bump. A host that sets
  `CAPTURE_SPEECH_RECOGNITION_MODEL=tea-asr-1.1` on machines without the NVIDIA
  driver also sets `CAPTURE_SPEECH_RECOGNITION_VARIANT=cuda` before installing.
- After a version bump, speech recognition is reinstalled as usual; on a machine
  without the driver that reinstall downloads the CPU pack.

### Speech recognition model is chosen apart from the device

Speech recognition always ran TEA-ASR-1.1 on the GPU and TEA-ASR-1.1-mini on the
CPU, so mini could not use the GPU (issue #273).

- The runtime setting `CAPTURE_SPEECH_RECOGNITION_MODEL` is `auto` (the
  default: the installed pack's model, TEA-ASR-1.1 on the CUDA pack and
  TEA-ASR-1.1-mini on the CPU pack), `tea-asr-1.1` or `tea-asr-1.1-mini`. On the
  CUDA pack a chosen model runs on either device, also on the CPU retry after a
  CUDA failure. The CPU pack holds only mini.
- When CUDA is tried and when it falls back to the CPU are unchanged.
  Provenance reports the model and device that produced the result.
- `CAPTURE_WHISPER_PRIMARY_MODEL` and `CAPTURE_WHISPER_FALLBACK_MODEL` are
  removed: they were validated but never reached the worker.
- A runtime setting, not a capture option: the contract set is unchanged. The
  desktop app does not expose it yet.

### Speech device

- On the CUDA pack, TEA-ASR 1.1 runs on CUDA when a GPU is present and on CPU
  when it is not. A failed GPU attempt retries that same checkpoint on CPU; a run
  no longer switches to TEA-ASR 1.1 mini because the device is CPU. Mini on the
  CPU is the CPU pack, which a machine without the NVIDIA driver installs.

### The runtime owns the built-in Ollama's port

The desktop host reserved a loopback port, released it and passed it to the
runtime, so another local process could take the port before Ollama started and
receive extracted document text (issue #255).

- For the built-in provider the runtime picks an ephemeral `127.0.0.1` port at
  every start and, before any HTTP or CLI call, checks that the listener is the
  `ollama serve` child it started. A bind failure or a foreign listener stops
  the child and retries on a new port (five attempts), then the capture fails
  with `requirement_unavailable`.
- `CAPTURE_OLLAMA_HOST` is no longer read for the built-in provider, and the
  runtime sets the child's `OLLAMA_HOST` itself. A host that still passes
  either variable is not affected: the values are ignored. The external
  provider (`CAPTURE_OLLAMA_ENDPOINT`) is unchanged.
- The desktop launcher no longer reserves an Ollama port or passes
  `CAPTURE_OLLAMA_HOST` and `OLLAMA_HOST`.
- The contract set is unchanged.

### Release assets

- The per-asset `.sha256` files of the runtime assets and
  `runtime-size-report.json` (with its `.sha256`) are no longer release assets,
  so a full release publishes 19 assets instead of 0.9.0's 28. Hosts verify
  the executable against `capture-runtime-manifest.json` and the workers
  against the engine catalog. `capture-release-manifest-v1.json.sha256` and
  the `*-files.json` assets stay; there are four of them now (OCR, both speech
  recognition packs, diarization). The size report is the CI artifact
  `capture-size-report-<version>-<run>`.

### Sidecar launcher keeps one launch path (breaking for the launcher crate)

`capture-sidecar-launcher` drops its group lifecycle (R3), the launch journal,
run staging and restart reconciliation. No host used them. Desktop, Cert Prep
and LAW keep the launch path they use: a fresh loopback port and token per
attempt, every root in a kill-on-close Job object, and the runtime's startup
sweeps. The crate writes nothing to disk. This changes the crate's public API,
which is why the crate moves to a new minor version with this release.

- Removed functions and methods: `build_immutable_group_plan`,
  `OwnedRuntimeSession::prepare_group`, `OwnedRuntimeSession::activate_group`,
  `OwnedRuntimeSession::observe` and `OwnedRuntimeSession::close`.
- Removed types: `ActivationCancelHandle`, `ActivationCleanupObservation`,
  `BindingAttemptId`, `CleanupError`, `CleanupErrorKind`, `CleanupPhase`,
  `CloseReason`, `CompleteGroupBinding`, `CompleteGroupBindingReceiptV1`,
  `GroupLease`, `GroupLifecycleState`, `GroupObservation`, `GroupProof`,
  `GroupRootPlanInput`, `ImmutableGroupPlan`, `LaunchError`,
  `LaunchErrorKind`, `LaunchPhase`, `LifecycleError`, `LifecycleErrorKind`,
  `LifecyclePhase`, `PersistError`, `PrepareError`, `PreparedGroup`,
  `ReconcileRef`, `ReconcileRefSink`, `RootRefBinding`,
  `SemanticActivationCleanupState` and `VerifiedGroupBinding`.
- Unchanged: `launch_sidecar`, `launch_sidecar_with_observer`,
  `LaunchOptions`, `LaunchedSidecar`, `SidecarLaunchSpec`,
  `SidecarConnection`, `OwnedRuntimeSession` (`spawn`, `id`, `try_wait`,
  `monitor_root_exit`, `terminate_and_prove`, `terminate`),
  `OwnedSidecarProcess`, `RuntimeTerminationProof`, `RuntimeCleanupError`,
  `RuntimeCleanupErrorKind`, the manifest functions and types,
  `probe_ready_once`, `ProbeResult`, `ReadyHandshake`,
  `generate_bearer_token`, `reserve_loopback_port` and
  `reserve_distinct_loopback_port`.
- The runtime no longer reads `CAPTURE_RUN_STAGING_DIR`; only the removed
  group activation set it. Staging is always `app_data/jobs/staging`.

## 0.9.0

A minor release that is breaking for clients. Hosts can show how big an engine
download is and how much has arrived, uninstall an engine, and show page and
recording progress; interrupted engine downloads resume; the TypeScript client
reads raw captures again; and Japanese transcripts use Japanese kanji forms.
The contract set changes (`91ff5ff5…`), so a 0.9.0 runtime needs 0.9.0 clients
and every consumer moves with it. The capture document schema (`5452631c…`) and
the models are unchanged from 0.8.0. No Java SDK is published from this release
on.

### Breaking for clients

- Contract-set SHA-256
  `91ff5ff5cef6d68774cf036878843503f171044bf8c4a9f6a62e7fb418ce2380` (0.8.0:
  `664b2b32…`). Clients allowlist the contract set and require the same runtime
  minor, so 0.8.x clients refuse a 0.9.0 runtime at the readiness handshake.
- Both 0.8.x clients reject unknown response fields (the TypeScript client
  through its contract-set field lists, the Python client through
  `extra="forbid"`). Even with an override they would fail on fields this
  runtime sends: `RuntimeRequirementV2.downloadBytes`,
  `RuntimeInstallationV2.downloadBytes` and `downloadedBytes`, and
  `CaptureOperationV2.pagesTotal`, `pagesDone`, `durationMs` and
  `coveredUntilMs`. The 0.8.0 TypeScript client also rejects every raw capture
  (see below).
- The new fields are optional, so a host's own fakes and recorded samples stay
  valid. Nothing is removed or renamed.

### Consumers

Cert Prep moves first, then LAW, each together with the runtime:

- Cert Prep: bump every Capture pin (`@gx-capture/capture-workbench-ui`,
  `@gx-capture/capture-runtime-client`, the Python client and, where used,
  `capture-sidecar-launcher`) to exactly 0.9.0, and refresh the pinned
  contract-set SHA-256. Tests that quote runtime minor 8 move to 9. The Web
  Component now accepts any Angular 22 compiler and elements (`^22.0.0`)
  instead of exact 22.0.7, so pnpm reuses the host's. Optional: show download
  sizes and progress from `downloadBytes`/`downloadedBytes`, page and recording
  progress from `pagesDone`/`pagesTotal` and `durationMs`/`coveredUntilMs`, and
  offer `uninstallRequirement()`.
- LAW: bump the Python client with
  `apps/law-prep-ai-service/src/app/capture_version.py`, the npm packages its
  web app uses, and their test samples (contract-set hash, runtime minor).
  LAW's TypeScript path could not read raw captures on 0.8.0; on 0.9.0 it can.
  The new fields need no LAW change.

### Download size and downloaded bytes (contract change)

The runtime now says how big a download is and how much of it has arrived, so
hosts no longer hard-code sizes.

- `RuntimeRequirementV2.downloadBytes`: bytes a fresh install downloads (worker
  archive plus model files). Units whose install has no size the runtime knows
  (winget, manual, unavailable) omit it.
- `RuntimeInstallationV2.downloadBytes` and `downloadedBytes`: total and bytes
  so far, set together once the install starts downloading. `downloadedBytes`
  never exceeds `downloadBytes`; `progress` is unchanged.
- The contract set hash changes. The TypeScript client accepts and checks the
  two installation fields; clients older than this release reject them, so
  LAW and Cert move to it together with the runtime.

### Uninstall an engine (contract change)

Hosts can remove an installed engine to free disk space.

- `DELETE /v2/runtime/requirements/{requirementId}/installation` removes the
  engine's files and the cached downloads no other engine uses, then returns
  the `RuntimeRequirementV2`, now not installed. Uninstalling a requirement
  that is not installed returns it unchanged; no idempotency key is needed.
- Errors: `requirement_not_found` (404), `requirement_disabled` (422, a
  requirement this process delegates), `requirement_not_uninstallable` (422,
  anything the engine installer does not own, such as the Ollama model) and
  `requirement_in_use` (409, while its installation or any capture has not
  finished, or while its files are still open).
- The TypeScript client adds `uninstallRequirement(requirementId)` and the
  Python client `uninstall_requirement(requirement_id)`. The operation is
  additive, but the contract set hash changes and clients pin it, so LAW and
  Cert move to this release together with the runtime.

### Page and recording progress (contract change)

Hosts can show "page 9 of 12" for a document and "12:04 of 41:30" for a
recording without guessing from `progress`.

- `CaptureOperationV2.pagesTotal` and `pagesDone` (pdf and image captures):
  the pages to process (the selected PDF pages, 1 for an image) and the pages
  done, set together once the count is known, before the first page finishes.
  `pagesDone` never exceeds `pagesTotal` and equals it once extraction ends.
- `CaptureOperationV2.durationMs` and `coveredUntilMs` (audio captures): the
  recording's length from its container, and how far transcription has got
  (the value the partial and events already carry). A container that does not
  state its length leaves `durationMs` absent; a capture that identifies
  speakers transcribes in one pass and reports neither.
- `CaptureEventV2` gains `pagesDone`, `pagesTotal` and `durationMs`, set on the
  events that change them, so SSE consumers see them without polling.
- The values are stored with the operation and survive a runtime restart.
- The contract set hash changes. The TypeScript client accepts and checks the
  new fields on operations and events; clients older than this release reject
  them on operations, so LAW and Cert move to it together with the runtime.

### TypeScript client reads raw captures again

The TypeScript runtime client (`@gx-capture/capture-runtime-client`) rejected
fields the runtime sends in every raw capture: `diarizationEngine`, `speakers`,
`suggestedUnits` and `ocrPageScope` (null or empty when unused). `getRaw()`
failed with `unknown RawCapture field`, so the Web Component, Cert Prep and
LAW's TypeScript paths could not read a raw capture, with or without speaker
identification. The client now accepts them, and also `diarizationEngine`,
`speakers` and `suggestedUnits` in a capture document. A unit test now checks
that every response model the client decodes accepts all of its contract-set
fields, and the client's test target runs all its spec files (the
speaker wire-sample tests were never run). No contract change.

### Interrupted engine downloads resume

An engine download that is cancelled, loses its connection or stops with the
runtime keeps its partial file (`<file>.part`) and a record of the bytes it
holds (`<file>.part.json`). The next install continues each unfinished byte
range from its first missing byte, and skips published parts already verified,
instead of starting over; this matters for the ~3 GB speech worker. A server
that ignores the resume request makes that region restart cleanly. A checksum
or byte-count failure deletes the partial. Direct model files resume the same
way, with every redirect still checked. No contract change.

### Taiwan speech pack is optional and explains its models

Speech-to-text (TEA-ASR 1.1) and speaker identification (Nemotron 3 Diarization) form an
optional Taiwan speech pack. Capture Workbench lists both with a download button each, so users
add them when they want them; PDFs and images never wait for them. Before downloading, each
unit says what it does, which languages it suits (Taiwan Mandarin, including mixed
Mandarin–English), the hardware it uses, its download size and its license. The Web Component
shows the same guide when its host asks for a speech unit. The runtime now reports
`speech-recognition` as `optional`.

### Japanese transcripts use Japanese kanji forms

TEA-ASR learned Taiwan Mandarin, so when a capture names Japanese it still
writes many kanji in their old (Traditional) forms. Speech recognition now
converts them to their Japanese forms: 會議 becomes 会議, 天氣 becomes 天気.

- On the 45-minute JLPT N1 listening test, this changed 161 of 8,755
  characters (1.8%), and the share of the official script transcribed in order
  rose from 87.2% to 89.2%. No character of the official script was changed.
- The table (`capture_runtime/japanese_kanji`) maps 348 old forms. It comes
  from OpenCC's `JPShinjitaiCharacters.txt` (Apache License 2.0; its licence
  ships with the speech recognition engine), narrowed to pairs whose Japanese
  form is a jōyō kanji and whose old form is not, so a kanji standard Japanese
  writes never changes. `scripts/generate_japanese_kanji.py` rebuilds it from
  the pinned upstream files.
- Names written in old forms are converted too: 龍 becomes 竜, 澤 becomes 沢.
- Other languages, and captures that name none, are unchanged. The contract
  does not change.

### Java SDK no longer published

The Java SDK (`com.gx.capture:capture-runtime-client`) had no consumer, so it
is removed and no longer published. LAW's Java engine never calls Capture: its
OCR and ASR go through LAW's Python AI service and the Python client. Cert Prep
has no Java code.

- Releases publish npm (GitHub Packages), PyPI, and crates.io packages only.
  Versions through 0.8.0 stay on GitHub Packages Maven.
- The package candidate no longer carries Maven artifacts. The release
  candidate checks the contract set recorded in the package candidate manifest
  instead of the Java SDK manifest.
- Consumer gates no longer send `package_candidate_run_id`; LAW's gate dropped
  its Java SDK check.
- The contract set is unchanged: the Java SDK only projected it.

### Release resolver action for consumer bump workflows

The composite action `.github/actions/resolve-capture-release` finds the
release a consumer should pin next (`route-a`: newest unsuperseded runtime
release; `stable`: the release `stable.json` names), verifies its manifest
digest and signer-workflow attestation, and outputs the tag, manifest and
contract-set digests, contract classification and whether it differs from the
current pin. See the release runbook.

### Launcher restart guarantees (clarification)

The 0.4.2 launcher durability and verified staging release apply to explicit
live R3 use; restart reconciliation is not wired, and desktop, Cert Prep and
LAW still use legacy launch paths with native Windows Job containment
(`KILL_ON_JOB_CLOSE`).

## 0.8.0

A minor release: a host can name the language spoken in an audio capture, and
deleting a capture deletes its uploaded source. The contract set changes
(`664b2b32…`), so a 0.8.0 runtime needs 0.8.0 clients and every consumer moves
with it. The capture document schema and the models are unchanged from 0.7.2.

### Uploaded sources are deleted with their capture

Uploaded sources are host documents, often confidential, and the runtime now
keeps one only while a capture uses it:

- `DELETE /v2/captures/{id}` also deletes the capture's uploaded source
  (`jobs/streaming/ingestions/<id>/`) once no other capture refers to it. Before,
  the source stayed until its two-hour expiry, and expiry runs only at startup
  or on a request, so an idle runtime kept it longer. The first-party clients
  open one upload per capture, so cancelling and deleting a capture now removes
  the uploaded bytes at once.
- An unfinished capture with no activity for the retention period
  (`CAPTURE_RETENTION_HOURS`, default 24) is treated as abandoned and deleted
  with its source, like a finished one. Before, an OCR-only host-mode capture
  left in `awaiting_structuring`, or a capture interrupted by a runtime stop,
  kept its source forever. Running work records page checkpoints and other
  events, which keeps it fresh.
- The Python client adds `delete_streaming_ingestion()`, like the Java client's
  `deleteStreamingIngestion()`, for an upload that never got a capture.

### Spoken language of an audio capture

Speech recognition always told TEA-ASR the audio was Chinese, so other languages
were transcribed as if spoken in Chinese. A host can now name the language:

- `StartCaptureV2.spokenLanguage` is one of `zh`, `yue` (Cantonese), `en`, `ja`,
  `ko`, `fr`, `de`, `it`, `pt`, `ru` or `es`: the languages the forced aligner
  can time. Omit it to keep Chinese, the model's default. A capture of another
  kind that names one fails with `invalid_spoken_language`.
- On a 45-minute JLPT N1 listening test (RTX 4060), naming Japanese raised the
  share of the official script transcribed in order from 77.9% to 87.2%. The
  transcription took 311 s instead of 385 s.
- Japanese and Korean transcripts are aligned with the aligner's default word
  split, since the worker ships neither tokenizer package it would load for
  them (nagisa, soynlp).
- TEA-ASR still writes some kanji in Traditional forms in Japanese (學, 會, 畫),
  about 1.5% of the characters in that test.
- Hosts set it as `spokenLanguage` in the TypeScript client and the Workbench
  configuration (sent only with audio files), `CaptureUpload.spoken_language` in
  the Python client, and `CaptureUpload.spokenIn("ja")` in the Java client, which
  lists the values in `CaptureRuntimeTypes.SPOKEN_LANGUAGES`.
- The contract set changes (SHA-256
  `664b2b3244d338dd4de39cbc2f1ee83104d21ee454a11f1d65fd8309d3599670`). Clients
  allowlist the contract set, so this runtime needs matching clients: under the
  0.x policy this is a minor release.

## 0.7.2

A patch release that makes speech recognition and OCR faster and shows their
progress. Clients still require the exact runtime version, so a 0.7.2 runtime
needs 0.7.2 clients; the contract set hash (`60c62267…`) and the capture
document schema are unchanged, so moving a consumer from 0.7.1 is a version
bump. The OCR profile id becomes `capture-workbench-ocr-cdfec152f8131864`,
since the profile carries the release version. Engine workers carry the
release version too, so hosts download them again; unchanged model files are
restored from the download cache.

### Speed

Measured on a Windows laptop with an RTX 4060 Laptop GPU (8 GB). Contracts,
the capture document schema and transcripts are unchanged; OCR text changes
only for images over 1024 px, which are no longer enlarged.

Speech recognition:

- A speech recognition worker keeps TEA-ASR and its aligner loaded across a
  capture's 120 s windows (0.7.1 loaded both again for each window) and, for
  five idle minutes, for the next capture (`CAPTURE_SPEECH_WORKER_IDLE_SECONDS`,
  0 to close it after each capture). It frees its GPU memory when OCR or
  speaker identification needs it.
- A TEA-ASR generation whose last 32 patterns of up to 16 tokens repeat is
  stopped, and its chunk is halved as at the length limit. On the 40-minute
  private fixture 5 of 82 chunks repeated one character 564-727 times and took
  45% of the generation time. The parsed transcript already collapsed such
  runs, so transcripts are unchanged (the fixture's normalized output hash is
  the same).
- The first capture of a worker hashes the models for the provenance digest
  beside its model load instead of after it, 5-7 s sooner.
- A 30 s clip took 21-29 s each time in 0.7.1; it now takes 24 s for the
  first capture and 6 s after. A 40-minute recording took 819 s
  through a streaming capture; it now takes 339 s.

OCR:

- An image is enlarged for OCR only when its enlarged long side stays within
  2048 px; a larger one is read as is. A 1654 x 2339 page took 23-25 s and now
  takes 8 s, with fewer errors (character error rate 0.26% -> 0.20%); dense
  11 px text in a 1080p screenshot reads as well as before. PDF pages still
  render at the full scale.
- An OCR worker keeps its DirectML sessions between captures whose pages are
  at most 2048 x 2048 px, for two idle minutes
  (`CAPTURE_OCR_WORKER_IDLE_SECONDS`, 0 to start a worker for each capture)
  and at most 20 captures. A screenshot took 7-8 s and now takes 3 s, a short
  PDF 5-6 s and now 1 s, a 5-page PDF 12 s and now 8 s; the text is the same.
  The sessions are the ones whose DirectML execution the first capture
  evidenced; the selected GPU adapter is checked again before each capture,
  and acceptance runs with an execution proof always start a new worker.
- A larger image runs on fresh sessions: DirectML keeps the GPU buffers of
  every capture, and after a 12 MP photo a warm worker held 7.8 GB of the 8 GB
  and read its next page as empty.

### Downloads and progress

- Installing an engine hard-links its files from the download cache instead
  of copying them, saving about 10.5 GB for speech recognition, and the cache
  drops entries no install uses after seven idle days.
- A streaming capture reports `loading-model` while the speech model loads and
  its progress from the recording's covered time, instead of staying at its
  start until the end.
- A download that failed while its partial files were being removed reported
  the cleanup error instead of the download's; a rebuild of a worker that
  ships in parts left an earlier build's parts behind.

### Capture lifecycle

- A streaming capture published the speech session's `completed` while the
  capture was still extracting, so a host that stopped at `completed` read a
  snapshot without the result. Only the capture's own end is published now.

### Desktop

- The desktop app offers "Use the GPU for speech recognition" when an NVIDIA
  CUDA driver is present; turning it off restarts the runtime with speech on
  the CPU (TEA-ASR mini). It cannot change while a capture or installation
  runs.
- A component installation shows a rounded percentage and a progress bar; it
  showed the raw fraction times 100 (for example 33.33333333333333%).

### Release verification

- The private speech fixture that verifies a model-enabled release is now a
  40-minute Taiwanese Mandarin interview (M4A), with its expected TEA-ASR-1.1
  output frozen from two identical CUDA runs. It replaces an MP3 whose expected
  output still came from Whisper.

## 0.7.1

A patch release that makes 0.7.0's speech recognition usable from a host.
Clients still require the exact runtime version, so a 0.7.1 runtime needs 0.7.1
clients; the contract set hash (`60c62267…`) and the capture document schema
are unchanged, so moving a consumer from 0.7.0 is a version bump. The OCR
profile id becomes `capture-workbench-ocr-e012547f1f9da4da`, since the profile
carries the release version.

### Speech recognition

Found by driving the published 0.7.0 runtime the way LAW's AI service does:
list the requirements, install speech recognition and speaker identification
through the API, then transcribe.

- `GET /v2/runtime/requirements` answered 500 for every host, so nothing could
  be installed. The speech recognition worker ships as two parts of 2.95 GB,
  which the public artifact descriptor (one URL, at most 512 MiB) cannot
  describe. Such a requirement now carries no `artifact`, like a models-only
  unit, and installs from the runtime's catalog as before.
- Every capture failed while loading the speech model ("session failed at
  OSError"). Engine workers did not receive `USERNAME`, and PyTorch names its
  compile cache after it when Transformers loads a model.
- A capture with speakers timed out after 15 minutes while loading the speech
  model. The worker's cancellation listener held a blocked read of stdin, which
  on Windows holds a lock that the model load waited on. The listener now waits
  without a pending read; cancelling still stops a worker cooperatively.
- An install whose worker files would land beyond Windows MAX_PATH (a long
  `CAPTURE_APP_DATA_DIR`) failed only after about 10 GB had downloaded, as a
  bare "installation failed". It now stops before the model download and names
  the path length; a failed post-install probe keeps the worker's reason.
- Progressive transcriptions report `elapsedMs` and `stageMs` for the whole
  recording; they reported none.

The fixes are in the runtime and in rebuilt speech recognition and speaker
diarization workers. The release consumer smoke now reads the packaged
runtime's requirements, which would have caught the first defect.

## 0.7.0

A minor release with breaking changes, which the 0.x policy allows. Clients
require the same runtime minor, so a 0.7.0 runtime needs 0.7.0 clients, and
consumers move together. The contract set changes (SHA-256
`60c622670b00e144b174c210e96773e07e7d94ec7c721b33ac65ff6c722c1d93`): the speech
requirement is renamed, engine provenance gains timing, and the schemas describe
PDF page selection. The OCR profile id becomes
`capture-workbench-ocr-7680a930bb89b381`, since the profile carries the release
version.

### Breaking changes

- Rename the public runtime requirement from `whisper-primary` to `speech-recognition`; replace Whisper with TEA-ASR-1.1 (CUDA), TEA-ASR-1.1-mini (CPU) and Qwen3 forced alignment. Clients and installed engine catalogs must migrate together.
- Speech is always transcribed as Chinese (Traditional, Taiwan vocabulary), as the model card
  recommends; recordings in other languages need another model.

### Speaker diarization

- Replace the optional speaker model with NVIDIA Nemotron-3-Diarization under
  OpenMDW-1.1, using native Transformers offline inference. Preserve GPU preference,
  bounded CPU fallback, overlapping/exclusive speaker turns and worker isolation.
  Remove the internal speaker-count option.

### Engine packaging

- Publish a worker archive above 1.9 GB as ordered parts (`<archive>.001`, `.002`, ...) so every
  release asset stays under GitHub's 2 GB limit; the catalog lists each part with its digest, and
  the installer joins and verifies them. The CUDA speech-recognition worker ships this way, and
  worker extraction is bounded at 8 GiB.
- Speaker diarization runs CPU PyTorch again, which keeps its worker small; only speech
  recognition uses CUDA PyTorch.

### Engine provenance

- Add optional `elapsedMs` and `stageMs` engine provenance fields for speech recognition and speaker diarization, alongside the device that produced the result; total time includes failed CUDA attempts and CPU fallback.

### PDF page selection

- A capture's `pdfPageNumbers` may name any pages of a PDF, such as
  `[3, 7, 8, 20]`, not only a prefix from page 1. The pages are one-based
  source page numbers in ascending order without duplicates, at most 500. A
  prefix such as `[1]`, and leaving the field out to read every page, work as
  before.
- Results keep the source page numbers: the OCR projection's pages, the raw
  segments' page locators and `ocrPageScope` say 3, 7, 8 and 20, so a host maps
  them back without bookkeeping.
- The page limit (`CAPTURE_MAX_PDF_PAGES`, 200 by default) counts the pages
  that are read. Without a selection that is every page of the PDF, as before;
  with one, the PDF may be longer than the limit, and
  `ocrPageScope.sourcePageCount` is no longer capped at 500.
- A selection that names a page past the end of the PDF, or more pages than
  the limit, fails the capture with `invalid_pdf_page_selection` (not
  retryable) before any page is read; it used to fail as
  `ocr_source_preflight_failed`. `POST /v2/captures` still rejects an unsorted,
  repeated, zero or over-long selection with `validation_error`.
- The Python, Java and TypeScript clients check a selection the same way before
  uploading, and the TypeScript `CaptureUpload` gains `pdfPageNumbers`.

The OCR engine renders the selected pages, so the change reaches users with a
rebuilt `capture-engine-ocr` artifact. The contract schemas describe the
selection and require positive page numbers.

## 0.6.3

A patch release for recording transcription. Clients still require the exact
runtime version, so a 0.6.3 runtime needs 0.6.3 clients; the contract set hash
is unchanged, so moving a consumer is a version bump. The OCR profile id
becomes `capture-workbench-ocr-1f5dcb0f58337c71`, since the profile carries
the release version.

### Recording transcription

- Whisper's voice activity filter now ignores sounds shorter than 250 ms,
  Silero's own default; faster-whisper kept every sound it heard. A click at
  the start of a phone recording had become a speech chunk:
  - Whisper heard "You" in an otherwise silent window.
  - With speakers, a word spoken at 4:43, whose aligned span reached back into
    the click, was timed at 0:00 without a speaker.

  On the 40-minute interview from 0.6.2, both are gone.

The filter runs in the Whisper engine, so the fix reaches users with a rebuilt
`capture-engine-whisper` artifact.

## 0.6.2

A patch release for recording transcription. Clients still require the exact
runtime version, so a 0.6.2 runtime needs 0.6.2 clients; the contract set hash
is unchanged, so moving a consumer is a version bump. The OCR profile id
becomes `capture-workbench-ocr-5b63d123f524e4b1`, since the profile carries
the release version.

### Recording transcription

Found by transcribing a 40-minute phone interview (M4A, AAC) through LAW and
directly through the runtime:

- The progressive audio decoder kept the alignment padding of every resampled
  frame, so for Opus, MP3 and AAC sources about a fifth of the PCM sent to
  Whisper was junk and segment times drifted. It now keeps the samples only:
  a four-minute stretch sent as Opus went from one segment to 93.
- A capture no longer fails when its first five minutes produce no text.
  Recordings often open with minutes of waiting; the speech after is now
  heard. `progressive_no_text_at_sample` means the whole recording had no
  text and, as the contract already declared, is not retryable.
- Consecutive progressive windows both transcribe their 30-second overlap,
  often in different words or scripts. Each moment is now kept from one
  window, which removed the doubled sentences (877 segments became 683 on
  the interview).
- A Whisper or speaker-diarization run may take 15 minutes plus the
  recording's length; with the fixed 15 minutes, a 40-minute interview with
  speakers failed.
- The runtime, the Web Component and Capture Workbench accept any audio or
  video recording FFmpeg decodes (AAC, AMR, WMA, AIFF, CAF, MOV, MKV, WebM,
  AVI, FLV, MPEG-PS and MPEG-TS besides WAV, MP3, FLAC, Ogg and MP4); the
  audio track of a video is transcribed.
- Capture Workbench shows a recording's transcript as timed lines with the
  speakers' names beside a player, and plays the recording from a line.

The window merging and the checkpoint rule run in the Whisper engine, so
they reach users with a rebuilt `capture-engine-whisper` artifact.

## 0.6.1

A patch release. Clients still require the exact runtime version, so a 0.6.1
runtime needs 0.6.1 clients, but the contract set hash is unchanged: moving a
consumer is a version bump. The OCR profile id becomes
`capture-workbench-ocr-be5a35092b5cc3be`, since the profile carries the
release version.

### Fixes

- GPU OCR no longer fails about half the time with `ocr_worker_failed`
  (`worker_crashed`). The text detection and recognition models shared one
  ONNX Runtime profile prefix; when both loaded within the same second they
  wrote one profile file, which the DirectML execution proof then rejected as
  invalid. Each model now profiles under its own prefix.

## 0.6.0

This release is incompatible with 0.5.x: a 0.6.0 runtime needs 0.6.0 clients.
Cert Prep and LAW migrate once.

### Contract

- The contract set no longer carries the release version, so a later patch
  release keeps the same contract hash and does not force a client update.
- Capture results can carry speakers: each segment may name a speaker label,
  and the result lists the speakers with the time of a listening sample. Names
  are not part of the contract; the host stores what a person calls a speaker.
- `StartCaptureV2.identifySpeakers` asks for speaker labels. Such a capture
  reports progress but sends no partial transcript.
- Requirements may be optional (`RuntimeRequirementV2.optional`), and a result
  may suggest an optional unit that would have helped (`suggestedUnits`).

### Runtime

- New optional install unit `speaker-diarization`: who spoke when, on the CPU,
  with the Community-1 model (CC-BY-4.0) from the Capture model source.
- The second reader for vertical Japanese pages is now the optional unit
  `vertical-japanese-reader` (157 MB of models, no worker of its own). Without
  it every page is read by the regular OCR pipeline, and a page the reader
  would have taken reports the unit so the host can offer it. The OCR profile
  id does not depend on whether the unit is installed.
- A result with more than 1,000 segments is sent in several events.

### Clients and UI

- The Web Component offers optional units, shows progress while speakers are
  identified, plays each speaker's sample and emits `capture-speakers-named`.
- The Java client decodes captured text that contains line breaks.

## 0.5.1 (2026-10-07)

### Runtime

- The second reader for vertical pages is a Japanese model and now reads only
  Japanese pages: a vertical page is sent to it when its text has kana. Vertical
  Chinese pages stay with the regular pipeline, which reads them better. The OCR
  profile id changes with the routing rule.

## 0.5.0 (2026-10-06)

### Runtime

- Vertical Japanese OCR now assembles detected article columns from right to
  left and places separately detected ruby after its article, while preserving
  unchanged regions' recognized strings, polygons and scores. Horizontal-only pages
  without furigana retain their previous output.
- A second reader for vertical pages. The OCR engine now also installs the
  NDLOCR-Lite models (National Diet Library, Japan; CC BY 4.0; about 150 MiB more).
  A page that is vertical throughout is read as a whole by that reader, with its
  recognizers on the DirectML device of the regular pipeline when there is one, and
  its lines, reading order and scores are returned in the existing page and box
  fields. Other pages keep the regular pipeline. A routed page takes several
  seconds longer; the first one on a machine also prepares the recognizers once in
  the shared engine cache.
- The OCR profile declares the vertical reader, so the profile id changes
  (`capture-workbench-ocr-1c6be4a3cebc2b21`, algorithm
  `capture-workbench-ocr-profile-v3`).
- On horizontal Japanese pages, furigana lines are no longer interleaved with the
  text they annotate: the readings of each block of lines follow that block,
  separated by blank lines. Regions, polygons and scores are unchanged; only
  their order and the page text change, and only on pages with furigana.
- A detector box spanning two body bands can be split when neighboring columns,
  raster whitespace and the same recognition pass agree on the text boundary.
  Child regions retain exact source substrings and inherited scores, with checked
  polygon partitions and private parent/span lineage.
- Vertical reading order also covers scans of two facing pages that lean
  differently (each page is read in its own frame instead of keeping detector
  order), narrow columns of small type beside regular ones, long source lines aligned to the bottom
  of an article, ruby boxes padded into their owner column, and a corner page
  header or page number beside a single article.
- A page whose tall boxes mostly hold digits or Latin text (a sideways scan of a
  horizontal page), or only low-score marks such as chart axes, is no longer
  treated as vertical and keeps its previous output.
- On a page of horizontal questions around a boxed vertical passage, the option
  numbers above the passage stay with their question instead of being read as the
  passage label, and a page number in digits under a column is no longer read as
  body text.
- Stacked bands of a page are read top to bottom even when their outlines overlap
  by a few pixels and a page number stands beside them.
- Known limitation: on dense periodical scans the columns inside a band are ordered,
  but the order of pages, bands, headings and page numbers is not reliable (narrow
  gutters, borders, centre titles and detector boxes spanning two bands).
- This work is unreleased and unversioned: the OCR model, profile and public
  page/box fields are unchanged.

## 0.4.4 (2026-09-30)

- Published to npm, Maven, PyPI, and crates.io, with the runtime, engine zips,
  and desktop installer on the GitHub release; the stable pointer moved to
  `v0.4.4`. Cert Prep and LAW consume it. The official online-package PDF OCR
  E2E passes on the 44-page 2024-07 N1 PDF.

### Runtime

- A PDF page where PaddleOCR returns a region with empty text (score zero) no
  longer fails the whole capture; the blank region is skipped after its
  polygon and score are validated. The 44-page 2024-07 N1 PDF, which failed on
  its vertical-text page 16 with 0.4.2 and 0.4.3, now completes.
- PDF captures report page progress while extracting (up to 90%, one checkpoint
  per validated page, no OCR text); a failed checkpoint write skips that update.
- OCR worker failure evidence names a rejected normalization step
  (`ocr-normalize-failed-*`).
- Known limitation: vertical Japanese text is recognized but returned in the
  wrong column order, with more recognition errors than horizontal text.

### Release tooling

- The post-publish PyPI readback waits up to about five minutes for PyPI's
  metadata instead of failing on the first 404.

## 0.4.3 (2026-09-29)

- Published to npm, Maven, PyPI, and crates.io, with the runtime, engine zips,
  and desktop installer on the GitHub release; the stable pointer moved to
  `v0.4.3`. Cert Prep and LAW consume it.
- A first OCR install on fresh app data takes about 40 s (was 9–17 minutes
  with 0.4.2), and about 8 s once any Capture host on the machine has
  downloaded the engine.

### Runtime

- Engine artifacts of 16 MiB or more download as four concurrent byte ranges
  when the host supports them, falling back to one stream otherwise; size and
  SHA-256 are still verified. The 152 MB OCR engine took 4.7 minutes instead of
  roughly 15 when GitHub Releases served ~170 KB/s per connection.
- Engine workers and model files are kept in a machine-wide cache
  (`%LOCALAPPDATA%\gx-capture\engine-cache`), keyed by SHA-256 and re-verified
  on every read. A second host, a fresh app-data directory, or a reinstall
  copies the verified bytes instead of downloading them again; entries unused
  for 60 days are evicted. Set `CAPTURE_ENGINE_CACHE_DIR` to move the cache or
  to `off` to disable it.

### CI and release tooling

- Release candidates read size budgets from the tooling ref.
- `sync-versions` also updates workspace crates in `Cargo.lock`.
- The launcher's activation probe fixture keeps serving after a test client
  drops a connection, which removes the intermittent launcher test failure.

## 0.4.2 (2026-09-27)

- Runtime OCR is delivered as an installable `windowsml-ocr` engine from the
  release catalog and gated by an OCR compute preflight; PDFs are OCR-only.
- The public launcher lifecycle (prepare, activation, Running, Closing,
  Terminal) persists durable ownership and releases verified staging.
- Published to npm, Maven, PyPI (`capture-runtime-client`, first PyPI
  release), and crates.io, with the runtime, engine zips, and desktop
  installer on the GitHub release; the stable pointer moved to `v0.4.2`.
- Known limitations: handwritten text is recognised poorly (printed text is
  the supported floor); the first engine download from GitHub releases can take
  over ten minutes.

## 0.4.1

- Canonical v2 contract set shared by the runtime and its TypeScript, Python,
  and Java clients; releases require matching contract-set digests.

## 0.3.9

- Published the shared contracts, structuring SDK, and sidecar launcher
  artifacts used by the desktop and host integrations.
