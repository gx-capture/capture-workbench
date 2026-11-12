# Recordings over 50 MiB by native path (issue #155)

Recommendation: retain v2 chunked ingestion, raise the desktop recording ceiling to **2 GiB**, retain **50 MiB for PDF/image**, and move selection and path ownership entirely into Rust. Keep the current 90-minute duration budget initially, enforcing it consistently. No public schema, problem-registry, or generated-client change is required.

## Evidence boundary

- The findings come from reading `main` at `b2ae360`. They describe source behavior, not installed-product acceptance; line numbers refer to that commit.
- Paths are repository-relative unless prefixed with `../cert-prep/` (the Cert Prep consumer repository).

## Current size limits and failures

| Layer / source kind | Definition and enforcement today |
|---|---|
| Desktop, every supported kind | `MAX_SOURCE_BYTES = 50 * 1024 * 1024`: `apps/capture-workbench-desktop/src-tauri/src/library.rs:16`. Byte-input validation rejects empty/oversized inputs: `library/validation.rs:28`. Native import rejects metadata over that limit before reading, then bounds the read: `library/store.rs:201`, `library/store.rs:223`. These last two paths are under the same `src-tauri/src/` directory. |
| Desktop runtime configuration | The launcher passes 50 MiB as `CAPTURE_MAX_UPLOAD_BYTES`: `apps/capture-workbench-desktop/src-tauri/src/constants/runtime.rs:2`, `apps/capture-workbench-desktop/src-tauri/src/launch_policy.rs:73`. |
| Runtime configuration/readiness | `CAPTURE_MAX_UPLOAD_BYTES` defaults to 50 MiB and is checked only for positivity: `packages/capture-runtime/src/capture_runtime/config.py:250`. Readiness advertises it as `capabilities.maxUploadBytes`: `packages/capture-runtime/src/capture_runtime/provisioning/api/runtime.py:74`. |
| Production v2 ingestion | Opening an ingestion rejects a declared total over the limit for its kind with 422 `validation_error`, before any record or file exists: recordings (`audio`) up to the configured `max_upload_bytes`, PDF and image up to `min(max_upload_bytes, 50 MiB)`. A source declared `audio` and larger than 50 MiB must start with a recording signature; a chunk that shows otherwise is rejected with 409 `chunk_rejected` and not stored. Recovered records over the limit are pruned unless a capture still uses them: `packages/capture-runtime/src/capture_runtime/capture/domain/size_policy.py`, `packages/capture-runtime/src/capture_runtime/capture/application/use_cases.py`, `packages/capture-runtime/src/capture_runtime/capture/infrastructure/streaming_repository.py`. |
| Ingestion chunks | Maximum 4 MiB per chunk: `packages/capture-runtime/src/capture_runtime/capture/infrastructure/streaming.py:23`. Headers and actual body are checked: `packages/capture-runtime/src/capture_runtime/capture/api/streaming.py:129`, `packages/capture-runtime/src/capture_runtime/capture/api/streaming.py:579`. |
| Ingestion total | Positive declared total, contiguous ordered chunks, no bytes beyond that declared total, matching final count/digest (the ceiling is the row above): `packages/capture-runtime/src/capture_runtime/contracts/__init__.py:637`, `packages/capture-runtime/src/capture_runtime/capture/domain/ingestion/models.py:63`, `packages/capture-runtime/src/capture_runtime/capture/domain/ingestion/models.py:86`. |
| Speech worker, whole-recording operation | Independent 50 MiB compressed-source guard: `packages/capture-runtime/src/capture_runtime/workers/speech_recognition_main.py:118`, `packages/capture-runtime/src/capture_runtime/workers/speech_recognition_main.py:244`. |
| Diarization worker | Independent 50 MiB guard: `packages/capture-runtime/src/capture_runtime/workers/diarization_main.py:23`, `packages/capture-runtime/src/capture_runtime/workers/diarization_main.py:149`. |
| OCR worker, PDF/image | Independent 50 MiB guard: `packages/capture-runtime/src/capture_runtime/workers/ocr_main.py:82`, `packages/capture-runtime/src/capture_runtime/workers/ocr_main.py:507`. |
| Decoded media | Defaults: 200 PDF pages, 50,000,000 image pixels, 5,400,000 ms audio duration: `packages/capture-runtime/src/capture_runtime/config.py:260`. Whole-recording speech enforces decoded sample duration: `packages/capture-runtime/src/capture_runtime/speech/infrastructure/speech_recognition.py:346`. Diarization enforces decoded PCM bytes derived from duration: `packages/capture-runtime/src/capture_runtime/diarization/infrastructure/speaker_diarization.py:109`. |
| Progressive speech | 120-second windows, 30-second overlap, 4 MiB maximum window payload: `packages/capture-runtime/src/capture_runtime/speech/domain/window/models.py:9`. Binary session payloads also have a 4 MiB ceiling: `packages/capture-runtime/src/capture_runtime/speech/infrastructure/whisper_session.py:20`. |

A normal **60 MiB desktop recording fails during library import**, before any runtime ingestion or capture exists. The message is **“Selected source exceeds the desktop library limit.”** There is no problem code or runtime stage; the renderer displays the command error through its import error handler. Evidence: `apps/capture-workbench-desktop/src-tauri/src/library/store.rs:201`, `apps/capture-workbench/src/app/services/desktop-workspace-capture.service.ts:212`.

A host that sends a recording over its configured `maxUploadBytes` is refused when it opens the ingestion (422 `validation_error`). A recording within that limit but over 50 MiB is still refused later by the whole-recording workers' own 50 MiB guards (speaker identification), which slice 4 raises: `packages/capture-runtime/src/capture_runtime/workers/speech_recognition_main.py`, `packages/capture-runtime/src/capture_runtime/workers/diarization_main.py`.

## Public contract and client checks

- `maxUploadBytes` is public discovery data, but its enclosing `capabilities` field is an unrestricted dictionary; there is no schema-fixed 50 MiB value. Source byte counts likewise have no maximum: `packages/capture-runtime/src/capture_runtime/contracts/__init__.py:1227`, `packages/capture-runtime/src/capture_runtime/contracts/__init__.py:176`.
- TypeScript does not check total size against readiness. It materializes the body, hashes it, and selects chunks using `maxChunkBytes`: `packages/capture-runtime-client/src/private/streaming.ts:45`.
- Python similarly accepts an existing complete `content` value and chunks it using streaming capabilities: `packages/capture-runtime-client-python/src/capture_runtime_client/client.py:439`, `packages/capture-runtime-client-python/src/capture_runtime_client/client.py:461`.
- The Rust **launcher crate is not an upload SDK**; it supervises the sidecar. The desktop’s private Rust uploader handles ingestion and has no readiness-based total-size check: `packages/capture-sidecar-launcher/src/lib.rs:1`, `apps/capture-workbench-desktop/src-tauri/src/runtime_client.rs:147`.
- The Web Component workflow checks source classification/enabled kinds, rather than file size, then passes the `File` to the SDK: `packages/capture-workbench-ui/src/lib/capture-workflow/capture-workflow.service.ts:115`, `packages/capture-workbench-ui/src/lib/http-capture-client.ts:144`.
- Raising a configured value needs no generated artifacts. Adding typed per-kind capabilities, a new source kind, or a new problem code would change the contract set; avoid those changes here. Existing `validation_error` is available for rejected ingestion metadata: `packages/capture-runtime/src/capture_runtime/problem_registry.py:116`.

## Upload and transcription path today

1. The renderer calls the dialog plugin and receives native path strings. Tauri drops also deliver `event.payload.paths`; neither flow uses opaque tokens: `apps/capture-workbench/src/app/services/desktop-library.service.ts:33`, `apps/capture-workbench/src/app/services/desktop-library.service.ts:59`.
2. Those strings cross IPC as `LibraryImportSourceRequest.source_path`: `apps/capture-workbench/src/app/services/desktop-library.service.ts:81`, `apps/capture-workbench-desktop/src-tauri/src/contracts/library.rs:512`.
3. Rust rejects a final-component symlink/non-file, canonicalizes, opens the file once, takes the length from the handle, reads a 512-byte prefix and verifies signature/extension: `apps/capture-workbench-desktop/src-tauri/src/library/store.rs` (`import_source`).
4. Import streams the file in 1 MiB blocks to `<app-data>/library/staging/<random id>`, counting bytes (more or fewer than the length seen is "changed during import"), then creates the item and renames the staged file to `<app-data>/library/items/<document-id>/source.bin` and saves the index; a failure removes the staged file and the item directory. It does not hash or deduplicate. Startup removes staging entries untouched for an hour and never touches `items/`, because another running instance shares the directory.
5. Audio uses `runtime_start_streaming_capture`; PDF/image use `runtime_create_capture`. Both native implementations already upload the stored file through v2 ingestion: `apps/capture-workbench/src/app/services/desktop-workspace-capture.service.ts:286`, `apps/capture-workbench-desktop/src-tauri/src/runtime_client.rs:147`, `apps/capture-workbench-desktop/src-tauri/src/runtime_client.rs:226`.
6. Native upload reads sequential **1 MiB chunks**, copies each into the HTTP request, sends range/digest/idempotency headers, then rereads the file to compute final SHA-256. It does not buffer the complete upload: `apps/capture-workbench-desktop/src-tauri/src/runtime_client.rs:373`, `apps/capture-workbench-desktop/src-tauri/src/runtime_client.rs:442`.
7. The native transport has 60-second socket timeouts and no retry loop. Failed upload/finalize/start triggers best-effort ingestion deletion: `apps/capture-workbench-desktop/src-tauri/src/runtime_client/transport.rs:17`, `apps/capture-workbench-desktop/src-tauri/src/runtime_client/transport.rs:44`, `apps/capture-workbench-desktop/src-tauri/src/runtime_client.rs:298`.
8. Both native paths send the required `X-Idempotency-Key` (equal to the body's `clientRequestId`) when they open the ingestion and start the capture, and share one helper for open, upload and finalize (`upload_ingestion_source` in `apps/capture-workbench-desktop/src-tauri/src/runtime_client.rs`). The runtime answers 422 without the header and 409 when it differs from the body.
9. Production ingestion is disk-backed under `<runtime-app-data>/jobs/streaming/ingestions/<id>/source.bin`; chunk append flushes/fsyncs, metadata records accepted chunks, and final hashing reads in 1 MiB blocks: `packages/capture-runtime/src/capture_runtime/dependencies.py:205`, `packages/capture-runtime/src/capture_runtime/capture/infrastructure/_streaming_persistence.py:33`, `packages/capture-runtime/src/capture_runtime/capture/infrastructure/_streaming_persistence.py:62`, `packages/capture-runtime/src/capture_runtime/capture/infrastructure/streaming_repository.py:187`.
10. Identical accepted chunks replay safely; conflicting/out-of-order chunks fail. Finalization replay uses stored metadata: `packages/capture-runtime/src/capture_runtime/capture/domain/ingestion/models.py:69`, `packages/capture-runtime/src/capture_runtime/capture/infrastructure/streaming_repository.py:206`.
11. Without speakers, the runtime opens the finalized ingestion file once (PyAV), decodes and resamples forward only, and yields bounded PCM windows lazily under the worker's backpressure; there is no second compressed copy. The worker writes a temporary WAV per window for ASR: `packages/capture-runtime/src/capture_runtime/speech/infrastructure/progressive_capture.py`, `packages/capture-runtime/src/capture_runtime/speech/infrastructure/progressive_decoder.py` (`PyAVFileDecoder`), `packages/capture-runtime/src/capture_runtime/speech/infrastructure/progressive_whisper.py`. See `docs/domain/speech.md`, "Finalized recording decoding".
12. Window boundaries and durations come from the cumulative decoded sample count, so timestamps do not drift over a long recording; the final window carries every remaining sample.
13. The configured maximum duration is enforced from the decoded sample count on this path too, whatever the container's duration metadata says; the failure is `worker_failed`, stage `extraction`, as on the whole-recording path. The worker adapter's eight-hour limit applies to individual window transcriptions: `packages/capture-runtime/src/capture_runtime/workers/speech_recognition_main.py`.
14. With speakers, the service instead reads the complete compressed recording into Python memory, writes worker-source copies, and sends native paths in worker requests. Speech and diarization decode through PyAV, not an external ffmpeg command in these inspected paths: `packages/capture-runtime/src/capture_runtime/capture/application/streaming_capture_service.py:376`, `packages/capture-runtime/src/capture_runtime/capture/application/streaming_capture_service.py:570`, `packages/capture-runtime/src/capture_runtime/capture/infrastructure/capture_extraction.py:876`, `packages/capture-runtime/src/capture_runtime/capture/infrastructure/capture_extraction.py:890`.

## Whole-file memory inventory

- Library byte retrieval (playback): complete compressed `Vec` and IPC response. Evidence: `apps/capture-workbench-desktop/src-tauri/src/library/store.rs` (`load_source`), `apps/capture-workbench-desktop/src-tauri/src/commands.rs` (`library_source_bytes`). The import itself holds 1 MiB.
- Renderer playback: complete `ArrayBuffer` and Blob-backed object URL. Evidence: `apps/capture-workbench/src/app/services/desktop-workspace.store.ts:409`.
- Buffered runtime extraction: complete compressed Python `bytes`, including speaker mode and PDF/image. Evidence: `packages/capture-runtime/src/capture_runtime/capture/application/streaming_capture_service.py:570`.
- Whole-recording speech: all decoded pieces, concatenated waveform, float32 conversion; inference subsequently chunks audio, but decoding already holds the whole waveform. Evidence: `packages/capture-runtime/src/capture_runtime/speech/infrastructure/speech_recognition.py:334`, `packages/capture-runtime/src/capture_runtime/speech/infrastructure/speech_recognition.py:351`, `packages/capture-runtime/src/capture_runtime/speech/infrastructure/speech_recognition.py:45`.
- Diarization: all decoded frames, complete PCM, then float waveform. Evidence: `packages/capture-runtime/src/capture_runtime/diarization/infrastructure/speaker_diarization.py:116`, `packages/capture-runtime/src/capture_runtime/diarization/infrastructure/speaker_diarization.py:212`.
- TypeScript SDK: complete upload bytes plus a full copy for hashing; Python SDK: complete caller-provided bytes. Evidence: `packages/capture-runtime-client/src/private/codec-plumbing.ts:23`, `packages/capture-runtime-client/src/private/codec-plumbing.ts:33`, `packages/capture-runtime-client-python/src/capture_runtime_client/client.py:439`.
- OCR worker also reads its complete source for hashing. The in-memory ingestion adapter retains all bytes, but is documented as a test adapter. Evidence: `packages/capture-runtime/src/capture_runtime/workers/ocr_main.py:590`, `packages/capture-runtime/src/capture_runtime/capture/infrastructure/streaming.py:64`.

## Renderer path boundary

- Current permissions are `core:default` and `dialog:allow-open`; no filesystem plugin permission is granted: `apps/capture-workbench-desktop/src-tauri/capabilities/default.json:6`.
- `library_import_source` takes a native path. Library get/list/export/source-bytes and both capture-start commands use document IDs; summaries return basename/media type/size, not the original path: `apps/capture-workbench-desktop/src-tauri/src/contracts/library.rs:512`, `apps/capture-workbench-desktop/src-tauri/src/contracts/library.rs:551`, `apps/capture-workbench-desktop/src-tauri/src/contracts/library.rs:573`, `apps/capture-workbench-desktop/src-tauri/src/runtime_client.rs:152`.
- The smoke-only `model_smoke_import_fixture` already resolves a fixture key inside Rust: `apps/capture-workbench-desktop/src-tauri/src/commands.rs:146`.
- Paths additionally live in the renderer’s OCR queue and workspace routing, so fixing only the ASR picker is insufficient: `apps/capture-workbench/src/app/services/capture-queue.store.ts:183`, `apps/capture-workbench/src/app/services/ocr-queue.ts:40`, `apps/capture-workbench/src/app/services/desktop-workspace.store.ts:540`.
- Library summary errors are arbitrary strings, and renderer sanitization removes tokens rather than filesystem paths. Native filesystem errors can be interpolated into IPC errors. No comprehensive log-path exclusion was established: `apps/capture-workbench-desktop/src-tauri/src/library/store.rs:391`, `apps/capture-workbench/src/app/services/desktop-library.service.ts:155`.
- Required design: Rust owns dialogs and native drop handling. Return only random, window-bound, expiring selection tokens plus basename/size/type; import consumes a token. Keep raw paths and opened handles exclusively in Rust.
- Replace renderer dialog permission with the narrow native commands. Remove broad event-listening access or explicitly deny raw Tauri drag-enter/drop subscriptions; deliver sanitized native notifications through a narrow IPC channel. Merely removing `onDragDropEvent` is insufficient security proof.
- Required commands: native selection, native-source notification registration, token import/discard, and cancellation for a pending import/upload. Remove the renderer-callable arbitrary-path import shape.
- Do not grant `fs:default`, read-file scopes, recursive directory scopes, arbitrary path-to-URL conversion, or a runtime HTTP endpoint accepting native paths.
- The exact packaged Tauri ACL/drop behavior remains unverified. Prove that attempted raw JavaScript subscriptions cannot receive paths before accepting this slice.

## Other hosts

- Cert Prep launches with `CAPTURE_MAX_UPLOAD_BYTES = 104857600`—100 MiB—while its backend’s generic upload default is 20 MiB. Different entry routes therefore have different ceilings: `../cert-prep/apps/cert-prep-desktop/src-tauri/src/capture_runtime.rs:30`, `../cert-prep/apps/cert-prep-desktop/src-tauri/src/capture_runtime.rs:268`, `../cert-prep/apps/cert-prep-backend/src/cert_prep_backend/platform/config.py:27`.
- Cert Prep’s capture adapter also buffers content and uploads chunks. Its higher setting does not remove the producer’s worker guards: `../cert-prep/apps/cert-prep-backend/src/cert_prep_backend/capture_integration/application/use_cases.py:311`, `../cert-prep/apps/cert-prep-backend/src/cert_prep_backend/capture_integration/infrastructure/client.py:266`.
- The other consumer does not submit an original long recording as one ingestion, so this issue does not change it.
- Cert Prep consumes launcher 0.9.0; producer source changes do not update installed consumers: `../cert-prep/apps/cert-prep-desktop/src-tauri/Cargo.toml:21`.
- Recommendation: no consumer changes in #155. Verify their packaged contracts during release; retain their existing host limits.

## Limit-model options

| Option | Contract impact | 1 GiB memory/disk budget after implementation | Failure modes / effort |
|---|---|---|---|
| A. One 2 GiB ceiling for every kind | Existing scalar suffices; OCR worker policy must also change. | Streaming transfer is bounded, but current PDF/image extraction can allocate ≥1 GiB plus raster expansion; approximately 2 GiB additional disk with existing spool. | Broadens OCR resource exposure unnecessarily. Medium effort, high resource risk. |
| B. Recording ceiling 2 GiB; PDF/image 50 MiB | Existing `maxUploadBytes` remains the overall ceiling; exact per-kind limits are not discoverable. No new schema/code. | Proposed recording path: bounded compressed buffers plus PCM/model memory; approximately 1 GiB additional library disk and 1 GiB runtime disk. | Disk exhaustion, misleading extensions, duration expansion; requires real enforcement and path-based extraction. Medium/high effort. |
| C. No recording-byte ceiling; duration/free-space checks | No schema addition, but no truthful finite `maxUploadBytes` without redefining its meaning. | Same streaming buffers; disk grows with input and concurrency. | Unknown duration, malicious containers, quota races and indefinitely large uploads. Highest effort. |

Choose **B**. Keep the standalone runtime default at 50 MiB initially; desktop explicitly requests 2 GiB. Effective recording limits must agree across readiness, ingestion, and workers. PDF/image use the smaller of the configured global ceiling and 50 MiB.

The public wire contract stays unchanged, but observable admission policy changes and needs compatibility review. Use existing `validation_error`/422 for total-size admission failures. What is lost: clients cannot discover exact per-kind limits or distinguish oversize through a dedicated problem code.

## Implementation slices, in merge order

Merged: the idempotency keys of the recording start (PR #328), slice 2 (the runtime enforces its size limits at admission), slice 3 (a finalized recording is decoded once) and slice 5 (the library import streams to disk). The remaining slices keep their numbers.

Change mode: edit existing owners, with small private helpers only where needed. Delete renderer path plumbing and obsolete source-text assertions. Size pressure is large across boundaries; avoid a general upload framework or unrelated library rewrite. Each slice below is intended to stay around ten files, including tests.

1. **Replay in the native upload. Public contract: no. Capabilities: no.**
   - Edit `apps/capture-workbench-desktop/src-tauri/src/runtime_client.rs` and `runtime_client/transport.rs`: retry a transient failure (no complete response, or 502/503/504) with the identical request, three attempts in total, for chunks, finalize and the two idempotent POSTs; any other status is a definite answer.
   - Compute the source digest while uploading instead of reading the file a second time.
   - When the start request stays unconfirmed after the retries, do not delete the ingestion: the capture may own it. A definite rejection still deletes it.
   - Tests at the native HTTP boundary: lost responses, 503, conflicts that are not retried, the unconfirmed start, one pass over the file.
   - Gates: `pnpm nx run capture-workbench-desktop:cargo-test`, `pnpm run verify:affected`.
   - Visible result: recording uploads recover from transient failures.

4. **Remove compressed-source buffering from speaker mode. Public contract: no. Capabilities: no.**
   - Edit `packages/capture-runtime/src/capture_runtime/capture/application/streaming_capture_service.py:376`, `capture/infrastructure/capture_extraction.py:604`, `capture/infrastructure/audio_run_timeout.py:10`, `workers/speech_recognition_main.py:244`, and `workers/diarization_main.py:149`.
   - Pass the validated ingestion path through a private extraction seam to both workers; do not create another complete worker-source copy. Probe timeout duration from that path.
   - Edit `packages/capture-runtime/src/capture_runtime/diarization/infrastructure/speaker_diarization.py:116` to iterate decoded frames rather than collecting them all. Retain the explicit duration budget for full-waveform speaker processing.
   - Raise recording worker guards consistently; leave `workers/ocr_main.py:82` unchanged. Do not forward bearer tokens into workers.
   - Add mocked-worker path/size tests and speaker-mode cancellation/cleanup tests; verify optional speakers do not restore compressed-file buffering.
   - Gates: `pnpm nx run capture-runtime:test`, `pnpm nx run capture-runtime:lint-architecture`, `pnpm nx run capture-runtime:check-contracts`.
   - Visible result: large recording transcription can also support speaker identification within the duration budget.

6. **Move selection authority into Rust. Public contract: desktop IPC changes only. Capabilities: YES, line-by-line review.** Design: [large-recording-selection-tokens.md](large-recording-selection-tokens.md).
   - Rust opens the dialog and receives drops; the renderer gets selection tokens with a base name, size and media type; importing consumes a token. The workspace picker, the OCR picker and the drop all move in this slice, and the path command `library_import_source` is removed with them.
   - The capability denies event listening and the renderer-side dialog; the queues hold selections instead of paths.
   - Do not raise the limit yet.
   - Gates: desktop `cargo-test`, `package-qa-test`, `package-qa` for the packaged boundary check, renderer `test` and `typecheck`, `pnpm run verify:affected`.
   - Visible result: picking and dropping files work as before; no path crosses to the renderer.

7. **Activate large recordings. Public contract: no runtime change. Capabilities: final restriction review.**
   - Raise the desktop limits for recordings to 2 GiB (`apps/capture-workbench-desktop/src-tauri/src/constants/runtime.rs`, the library limit per kind); PDF and image stay at 50 MiB.
   - Cancel a pending import or upload from the UI (a command with its renderer caller), with cooperative cancellation in the native upload.
   - Keep playback safe: reject large `library_source_bytes` reads natively before allocation and say in the UI that playback is unavailable (issue #327 covers playing large recordings).
   - Check free disk space before an import and name the shortage in the error.
   - Drop `core:default` from the capability once a packaged run shows the renderer calls nothing in `core:*`.
   - Gates: `pnpm nx run capture-workbench:test`, `pnpm nx run capture-workbench:typecheck`, desktop `cargo-test`/`package-qa-test`, and browser proof.
   - Visible result: a recording over 50 MiB can be imported and transcribed in the desktop app.

8. **Crash cleanup, package QA and installed acceptance. Public contract: no. Capabilities: packaged verification.**
   - Edit recovery owners at `packages/capture-runtime/src/capture_runtime/capture/infrastructure/_streaming_persistence.py:99`, `streaming_repository.py:123`, `packages/capture-runtime/src/capture_runtime/app.py:150`, and native library recovery at `apps/capture-workbench-desktop/src-tauri/src/library/store.rs:96`.
   - Reconcile source length with durable accepted-chunk metadata after crashes; remove abandoned import directories, malformed orphan ingestions and worker/window temporary files without touching active work.
   - Update audio-specific smoke admission at `apps/capture-workbench-desktop/scripts/real-media-model-smoke.ts:752` and `progressive-audio-oracle.ts:269`; retain PDF/image caps. Extend installed acceptance through the native selection route.
   - Replace obsolete regex assertions about path-based renderer import and fixed launcher size with behavior tests: `apps/capture-workbench-desktop/scripts/desktop-contract.test.ts:510`, `apps/capture-workbench-desktop/scripts/desktop-contract.test.ts:542`.
   - Gates: desktop package QA and affected builds; rebuild runtime plus both speech packs and diarization worker, then run installed acceptance. Packaging definitions are in `packages/capture-runtime/project.json:395`, `packages/capture-runtime/project.json:416`, `packages/capture-runtime/project.json:454`.
   - Visible result: the feature has crash/cancel evidence and works in the installed desktop product, not only source tests.

## Existing tests and acceptance floor

- Repository tests cover upload recovery, expiry and source deletion: `packages/capture-runtime/tests/unit/test_streaming_repository.py:44`, `packages/capture-runtime/tests/unit/test_streaming_repository.py:97`, `packages/capture-runtime/tests/unit/test_streaming_repository.py:170`.
- API integration covers ordered chunks, checksum/order failures and ingestion cleanup: `packages/capture-runtime/tests/integration/test_streaming_api.py:1871`, `packages/capture-runtime/tests/integration/test_streaming_api.py:2031`, `packages/capture-runtime/tests/integration/test_streaming_api.py:2101`.
- Native tests cover 1 MiB upload chunking and library boundaries: `apps/capture-workbench-desktop/src-tauri/src/runtime_client.rs:789`, `apps/capture-workbench-desktop/src-tauri/src/library.rs:1188`.
- The cited 50 MiB+1 smoke fixture is **a PDF**. Under the recommendation its rejection must remain valid; a blanket global increase would break its expectation: `apps/capture-workbench-desktop/src-tauri/src/model_smoke_fixtures.rs:251`.
- Tests that assert renderer dialog/path plumbing or exactly 50 MiB launcher constants will break intentionally; replace their implementation-text assertions with behavior coverage, not revised regexes.
- Create synthetic boundary files incrementally in temporary roots; do not allocate a 2 GiB test buffer. Use small injected limits for routine tests and a dedicated sparse-file boundary case. TypeScript temp-file tests import `tools/test-temp-root.ts` first; Python uses `tmp_path`; Rust uses `tempfile`.
- Common completion gates: `pnpm run verify:affected`, `pnpm nx run capture-runtime:check-contracts`, `pnpm run architecture:check`, `pnpm run architecture-exceptions:check`, and `pnpm run dead-code:check`. Regenerate graph/baselines only when applicable; never add exceptions to accommodate this feature.
- Installed acceptance must import and transcribe an actual >50 MiB audio recording and a video container, with cancel/retry/restart checks, memory/disk observations and no renderer path exposure.
- Development real-audio runs use mini/CUDA with fallback disabled; release/private-reference smokes retain TEA-ASR 1.1/CUDA. Follow `AGENTS.md:39` and `.agents/RESEARCH/tea-asr-1.1-mini-gpu-2026-11-04.md:15`.
- The existing real-media script itself reads entire fixtures; do not use its memory profile as proof of bounded native import: `apps/capture-workbench-desktop/scripts/real-media-smoke.ts:387`.

## Disk, memory and cleanup budget

- Today, a recording exists as original + library copy + runtime ingestion; the speaker path adds a worker-source temporary copy, which slice 4 removes.
- For a 1 GiB source, target **approximately 2 GiB additional disk** beyond the original: 1 GiB library copy and 1 GiB runtime ingestion, plus small metadata/window files. Reserve/check space on each destination volume with headroom; checks do not replace handling write failures.
- Target compressed-data buffers of a few MiB, independent of source size. Models/VRAM and transcript growth are separate budgets.
- At 16 kHz mono, a 90-minute waveform is about 165 MiB as int16 or 330 MiB as float32. Speaker mode retains duration-proportional memory; measure its conversion/model peaks rather than promising a fixed RSS ceiling.
- Cancel before library publication removes staging; cancel upload deletes unowned ingestion; cancel transcription stops workers before deleting ephemeral source data. A published library copy remains available for retry until explicit user deletion.
- Today, ingestions have a two-hour expiry; capture retention defaults to 24 hours, with pruning on initialization and requests. Active captures protect their ingestion: `packages/capture-runtime/src/capture_runtime/capture/infrastructure/streaming_repository.py:147`, `packages/capture-runtime/src/capture_runtime/capture/infrastructure/streaming_repository.py:657`, `packages/capture-runtime/src/capture_runtime/config.py:247`, `packages/capture-runtime/src/capture_runtime/app.py:247`.
- Today, normal cleanup deletes the last-reference ingestion; startup removes staging `.upload` files and `.spool` files left by an older runtime. Malformed ingestion metadata is skipped rather than cleaned, so crash-orphan cleanup needs explicit work: `packages/capture-runtime/src/capture_runtime/capture/infrastructure/streaming_repository.py:638`, `packages/capture-runtime/src/capture_runtime/speech/infrastructure/progressive_capture.py:440`, `packages/capture-runtime/src/capture_runtime/app.py:153`, `packages/capture-runtime/src/capture_runtime/capture/infrastructure/_streaming_persistence.py:114`.

## Playback scope

Playback currently loads the complete source into the renderer; it uses Blob URLs, not range requests or a recording asset protocol: `apps/capture-workbench/src/app/services/desktop-workspace.store.ts:409`. Loading is user-triggered: `apps/capture-workbench/src/app/history/history-page.html:263`. CSP currently permits Blob media: `apps/capture-workbench-desktop/src-tauri/tauri.conf.json:26`.

Full large-recording playback can be a separate issue because #155’s acceptance is import/transcription. The backend size guard and clear UI message belong here so the newly admitted file cannot trigger a giant IPC allocation. Follow-up playback should use a document-ID-bound range service/protocol; never expose the native path.

## Security requirements

- Authorize arbitrary local selections only through native user actions. Canonicalize, reject unsupported reparse/symlink traversal and non-regular files, validate signatures, and retain an opened handle or equivalent identity check to close replacement races.
- Permit selected local files without granting renderer directory access. Reject network/UNC sources by default to maintain a strict local-recording boundary.
- Tokens are random, short-lived, window-bound and revocable. Validate document IDs and confinement under owned library/runtime directories on every later access.
- Keep bearer tokens in native transport; current transport attaches them only to loopback requests and redacts responses: `apps/capture-workbench-desktop/src-tauri/src/runtime_client/transport.rs:19`, `apps/capture-workbench-desktop/src-tauri/src/runtime_client/transport.rs:60`.
- Never log/report source paths, filenames, transcripts, audio or credentials. Acceptance reports contain sizes, timings, result/provenance status and sanitized failures only. Private recordings remain on the machine.

## Product decisions

Decided by the product owner on issue #155 (2026-11-12).

| Decision | Outcome |
|---|---|
| Maximum source size | 2 GiB per recording; 50 MiB for PDF and image. |
| Maximum duration | 90 minutes, enforced on the progressive and the speaker paths alike. |
| Video containers | Supported: the audio track is transcribed, with no new public `video` kind. Subtitles may follow later, so segment timestamps must stay usable for a video's timeline. |
| Durable library copy | The library keeps one owned copy, so a retry works after the original moves. |
| Large-file playback | Not in this issue; discussed in issue #327. Here a large recording shows that playback is unavailable instead of loading the file into the renderer. |
| Speaker identification | Supported for large recordings within the same size and duration limits. |

## Risks

The largest risks are packaged Tauri raw-event exposure, compressed containers that reveal audio late, disk exhaustion during concurrent work, crash reconciliation between source append and metadata publication, and duration-proportional speaker memory. SDK/web hosts still buffer complete upload bodies. A passing build or synthetic upload does not establish installed transcription acceptance; #155 closes only after the >50 MiB installed-app journey and renderer-boundary checks pass.