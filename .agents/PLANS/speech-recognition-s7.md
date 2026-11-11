# S7 plan: offer the `cpu` speech content in the release catalog (issue #154), plus what S8 must change

Everything here comes from reading the `main` checkouts. Producer tip is `055e0fe` (S6, push CI 42930404485 green), Cert Prep is `1b45d22`, LAW is `62decd44`. I ran no builds, tests or nx commands.

## Headline findings

1. **LAW breaks on a `contents` catalog.** `gx.law-prep/tools/scripts/shared/capture-runtime-resources/capture-runtime-resources.ts:123-125` throws `Invalid Capture engine requirement.` when a requirement has no `artifacts` array. Three tools call it, all on the bundled catalog:
   - `stage-capture-runtime.ts:157`
   - `verify-desktop-runtime-artifacts.ts:101`
   - `generate-desktop-runtime-manifest.ts:77`

   It also runs on `release-desktop.yml:83-89`, which downloads the catalog asset. LAW therefore needs a code change, so the plan file's line 3 ("Cert Prep and LAW get no code change") and line 17 are wrong.
2. **Cert Prep is not broken by this slice, but it has an old exact list.** `cert-prep/tools/capture-candidate-gate.mts:176-184` is the pinned inventory. It holds 14 required paths: 3 runtime assets, the catalog, the OCR zip and `-files.json`, `capture-engine-whisper-<v>` zip and `-files.json`, the Python wheel and sdist, the crate, and 3 contract files. Lines 186-194 add up to 6 optional `.sha256` sidecars.
   - It still names the whisper worker. That worker was renamed at 0.7.0 and diarization is missing, so this "strict local candidate" path (used only by `acceptance-real-options.mts:758`) already fails on any real runtime candidate. S7 does not make it worse.
   - The release-candidate gate itself has no fixed list: it compares the manifest to the files on disk (`:917-935`). Its catalog reads look only at `windowsml-ocr` (`:301-303`, `:1323-1345`), and so does `build_backend_runtime.py:150-163`.
   - `install-capture-runtime.mts:42-55, 248-266` downloads only the exe, the runtime manifest, the schema and an optional sidecar.
3. **Neither consumer installs speech by itself.** Both go through the runtime API, so the runtime picks the content and neither needs to know about contents (details in section 3).
4. **Push CI never runs `generate-release-engine-catalog` or `build-release-artifacts`.** The `ci.yml` runtime job runs `verify-worker-boundaries` and the worker targets (`:254-266`), and the installer job is core-only (`:328-331`). The first real exercise of the catalog switch is `runtime-candidate.yml:133`, so the switch PR must be built locally before merge.

## 1. Producer chain today

- **Runtime candidate:** `runtime-candidate.yml:133` runs `build-release-artifacts`, then `local-release-consumer-smoke.ts` (`:143`), then `assemble-runtime-candidate.ts`.
  - `build-release-artifacts` (`project.json:735-754`) depends on `build-production-executable` (which depends on `generate-release-engine-catalog`, `:360-376`) and `verify-worker-boundaries`. `build_release_artifacts.py` then calls `release.build_release_artifacts`.
  - `generate-release-engine-catalog` (`:572-594`) depends on the OCR, CUDA speech and diarization workers. It does not take the CPU worker.
  - Job timeout is 90 min; 0.9.0 took 16 min.
- **Full release:** `release-candidate.yml` stages the runtime candidate, builds NSIS, runs size budgets (`:195-210`), runs `assemble-release-candidate.ts` and `verify-release-candidate.ts`, and runs the consumer smoke again (`:458`, `:589`). `:583-588` compares requirement **ids** with the lock. `_publish-github-release.yml:68-90` runs `create-release-manifest.ts` and `create-github-release.ts`.

How each piece reacts to a `contents` requirement and to two extra assets:

| Piece | Today | On `contents` / +2 assets |
|---|---|---|
| `release.py:56-62` | `complete` per requirement, then incomplete fails | **Fails**: a contents requirement has `complete` false (`engine_catalog.py:720-722`, `714`) |
| `release.py:70-123` | walks `requirement.artifacts`; any zip, part or `-files.json` not walked is "uncatalogued" | **Fails**: the CPU zip and its manifest are uncatalogued |
| `verify_release_model_candidate.py:291-298` | `requirement.complete` and `model_delivery()` | **Fails** (raises at `engine_catalog.py:743-746`) |
| same file `:356-361` | manager built without `speech_variant`, so `auto` | On a machine without a driver it would install `cpu` and fail the frozen `tea-asr-1.1`/`cuda` fixture |
| `generate_engine_catalog.py:263-268` | CPU flags with a core-only lock cause SystemExit | Breaks `core-only` once the target always passes the flags |
| `local-release-consumer-smoke.ts:181-326` | exact keys `requirementId, artifacts, modelFiles, unavailableReason`; exactly one artifact; `unavailableReason` must be null | **Fails** the key check; the exact asset-name set (`:373-387`, `:427-449`) also needs the CPU zip and manifest |
| `practical-installed.ts:198-233` | throws if `requirement.artifacts` is missing | **Fails** |
| `real-media-smoke.ts:212-217` | needs `artifacts` and `modelFiles` | Reports speech "not complete" in preflight |
| `real-media-model-smoke.ts:439-480` | exactly OCR and speech, one artifact each, compared with the lock | **Fails**; must compare the lock with the `cuda` content |
| `installed-process-cleanup.ts:31-40` | list of owned exe names | Misses `capture-engine-speech-recognition-cpu.exe` silently (diarization is already missing) |
| `local-candidate-worker-mirror.ts:302, 377-381` | OCR only | Not affected; also cannot serve speech |
| `progressive-audio-oracle.ts:172-174` | serves a single speech `.zip` | Not affected; it has been stale since 0.7.0, when speech became parts |
| `verify-release-candidate.ts:140-162` | `some` requirement has artifacts → model-enabled | Not affected (OCR keeps `artifacts`) |
| `verify-runtime-candidate.ts:181-238`, `assemble-runtime-candidate.ts:156,205`, `assemble-release-candidate.ts:77,101`, `create-release-manifest.ts:61-63`, `create-github-release.ts:20-45`, `create-runtime-github-release.ts:101-108`, `github-release-support.ts:29-39`, `verify-runtime-candidate-binding.ts:83-90` | read the directory; no fixed count | Not affected; `runtimeAssets` grows by 2 |
| `engine-catalog-parts.ts` | one artifact at a time | Not affected |
| `package-qa.ts` | npm package artifacts | Not a catalog reader |

- **The 17-asset count** exists only in prose: runbook `:367-372`. No test pins it.
- **Size limits:**
  - Budgets cover only the runtime exe and the NSIS installer (decision `:65-67`).
  - The CPU zip is one file of 316,666,018 bytes. That is below the 1.9 GB split point, below the 2e9 part cap (`engine-catalog-parts.ts:21`) and below the 512 MiB public-artifact cap. S3 already keeps speech `artifact` null.

## 2. Consumer chain

**LAW**
- `capture-runtime-resources.ts:113-155` requires `requirement.artifacts` and checks every part URL against the release. **Breaks.** Minimal fix: walk `requirement.contents[].artifacts` when `contents` is present, otherwise `requirement.artifacts`. This keeps 0.9.0 working.
- `CAPTURE_ENGINE_ARCHIVE_PATTERN` (`:24-25`) already matches `capture-engine-speech-recognition-cpu-*.zip` and its `-files.json`, so "never bundle" holds.
- `release-desktop.yml:83-89` downloads only 5 named assets: not affected.
- `capture-contract-gate.mts`, `capture-bump.mts` and `update-capture-version.mts` have no catalog or engine-asset reads.
- `apps/tauri` has no catalog reader. The e2e scripts (`capture_e2e.py:116-129`, `e2e-workspace.mts`) use the API.

**Cert Prep:** no break (see headline 2). Separately, `capture-runtime-consumer-smoke.mts:298-316` checks only requirement ids and statuses, so it is also unaffected.

**Gates:** both consumers gate locally with `pnpm ci:local`.
- Cert Prep: `tools/run-local-ci.mts`.
- LAW: lanes in `tools/run-local-ci.mts:18-56`. `@org/scripts:test` runs `stage-capture-runtime.spec.ts`, `verify-desktop-runtime-artifacts.spec.ts` and `update-capture-version.test.mts` (`tools/scripts/project.json:73`).

**Order constraint:** LAW only reads published or candidate catalogs. The fix must be on LAW `main` before the next release candidate's consumer-gate pre-run, and in any case before LAW bumps.

## 3. How consumers install speech

- **Cert Prep:** through the runtime API. `capture_integration/infrastructure/client.py:143-149` calls `start_installation` in the SDK, and `coordinator.py:55` maps AUDIO to `speech-recognition`.
- **LAW:** through the runtime API. `law-prep-ai-service/src/app/capture_setup.py:58-68` starts installs only when the status is `installable`. `release-desktop.yml:63-66` says engine archives are never bundled.
- **Settings:** neither sets `CAPTURE_SPEECH_RECOGNITION_MODEL` or `_VARIANT` (grep finds no hits in src), so both run `auto`.
- **Driver detection:** both pass `SystemRoot` to the runtime (Cert `capture_runtime.rs:48`, LAW `capture.rs:46`). The launcher clears the environment except for its allowlist (`spec.rs:53-73`), and detection needs `SystemRoot` (`engine_content_selection.py:37-41`).
- **Visible changes:** on a machine without a driver, `downloadBytes` and provenance `model` change. That provenance becomes `tea-asr-1.1-mini`, which Cert Prep stores as `effective_transcription_model`.

## 4. The API-visibility gap

**Where captures enter.** Every capture goes through `streaming_capture_service.py:_process` (`347-410`).
- With speakers → `_extract_buffered_source` → `capture_extraction._run_worker` (`835-878`; the content option is set at `856-857`).
- Plain audio → `ProgressiveSpeechProcessor.process` → `_resolve_engine` (`progressive_capture.py:443-449`) → `_acquire` (`:337-343`).

**Existing codes and fields.**
- `CaptureFailureV2.code` is a pattern string, not an enum (`contracts/__init__.py:720-724`).
- `requirement_unavailable` already exists in the problem registry (`problem_registry.py:198-203`) and is already used as a capture failure (`streaming_capture_service.py:409`, `490-495`).
- `RuntimeRequirementV2.detail` (string or null) already exists. It is `None` for installed contents (`system_installer.py:325-331`).
- The worker's own errors become generic `worker_failed`, retryable (`workers/server.py:166, 214, 313, 337`).
- `_safe_failure_message` forwards text only from `ProgressiveCaptureError` (`:838-841`).

**Decision (no new code, no contract change).**
- **Rule:** add a pure rule in `engine_content_selection.py`: content `cpu` allows only `auto` and `tea-asr-1.1-mini`; `cuda` and legacy allow all.
- **Error type:** add `SpeechModelNotInstalledError(ExtractionRuntimeUnavailableError)` in `_engine_installation_errors.py`, re-exported by `engine_installation.py`. Both the streaming service and `capture_extraction` already import from there.
- **Where it is raised:** after engine resolution and before any worker starts, in `progressive_capture._resolve_engine` and in `capture_extraction._run_worker` for speech.
- **How it is reported:** catch it before line 490 and call `_fail(capture_id, "requirement_unavailable", str(error), stage="extraction", retryable=False)`.
- **Listing:** `_contents_requirement` sets `detail` to the same sentence when the installed content is `cpu` and `extraction_config.speech_recognition_model` is `tea-asr-1.1`. `extraction_config` is already injected (`system_installer.py:103`). Status stays `ready`, because `auto` and mini still work on that install. LAW treats anything other than `ready` or `installable` as unavailable (`capture_setup.py:58-60`), so changing the status would block hosts.
- **What the host sees:** the capture fails with `{code:"requirement_unavailable", stage:"extraction", retryable:false}` and this message (≤500 chars): "Speech recognition model tea-asr-1.1 is not in the installed cpu content. Set CAPTURE_SPEECH_RECOGNITION_MODEL to auto or tea-asr-1.1-mini, or uninstall speech-recognition and install it with CAPTURE_SPEECH_RECOGNITION_VARIANT=cuda."
- **Defence in depth:** the worker's own `model not installed` check stays.
- **Drift risk:** the runtime rule duplicates the worker's selection in `speech_recognition.py`. Pin the two with a test that compares them.

## 5. Verification on a real machine

**Where the bytes come from.**
- Model files are downloaded at install time from the lock's Hugging Face URLs. No catalog build needs them; generation needs only `model-sources/release-model-source-lock.json`.
- The shared cache is keyed by sha256: `%LOCALAPPDATA%\gx-capture\engine-cache\<sha[:2]>\<sha>` (`_engine_download_cache.py:57-71, 90-93`).
  - Entries still hard-linked by an install are kept; other entries are evicted after 7 idle days (`:29-33`).
  - If a 0.9.0 speech pack is installed on the box, mini and the aligner restore from the cache, so only the 302 MiB worker is new.
  - `CAPTURE_ENGINE_CACHE_DIR=off` forces a cold download.
- The local candidate worker mirror is OCR only (`:302`), so it cannot be used here.

**Smallest path.** `release/version.json` is still 0.9.0, so the published archives have the expected names.
1. Build the CPU worker: `pnpm nx run capture-runtime:build-speech-recognition-cpu-worker` (about 4 min, 302 MiB).
2. Put the other three workers in `packages/capture-runtime/dist/engines`, without the `.sha256` files: `gh release download v0.9.0 -R gx-capture/capture-workbench -D packages/capture-runtime/dist/engines -p 'capture-engine-ocr-0.9.0-windows-x64*' -p 'capture-engine-diarization-0.9.0-windows-x64*' -p 'capture-engine-speech-recognition-0.9.0-windows-x64*'`. That is about 3.4 GB; the CUDA parts are only hashed and are never fetched with `cpu`. Alternatively build them with the three `build-*-worker` targets.
3. Generate the catalog: `pnpm nx run capture-runtime:generate-release-engine-catalog` (P3 passes the CPU archive and manifest).
4. Build the exe: `pnpm nx run capture-runtime:prepare-production-environment`, then in `packages/capture-runtime` run `uv run --no-sync --python 3.13 python scripts/build_executable.py --layout onefile --catalog dist/catalog/capture-engine-catalog.json`.
5. Serve the workers: `python -m http.server 8765 --bind 127.0.0.1 --directory packages/capture-runtime/dist/engines`.
6. Start `dist/executable/capture-runtime.exe serve --port P` with these settings:
   - `CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN=1`, `CAPTURE_SMOKE_WORKER_MIRROR_URL=http://127.0.0.1:8765`
   - `CAPTURE_SPEECH_RECOGNITION_VARIANT=cpu`
   - a short `CAPTURE_APP_DATA_DIR`
   - `CAPTURE_PORT=P` (with `--port`, runbook `:491-493`) and `CAPTURE_API_TOKEN`
7. Check the listing: `GET /v2/runtime/requirements` should show speech `installable` with `downloadBytes` ≈ 3.72e9. Restarting with `auto` on the RTX box should show about 10.5e9 without installing.
8. Install: `POST /v2/runtime/installations {requirementId:"speech-recognition",consent:true}` and poll. Record `downloadBytes` and `downloadedBytes`. `active.json` should show `stateVersion "2"`, `contentId "cpu"`.
9. Transcribe a 30 s clip through the Python client (as LAW's `capture_e2e.py` does). Expect provenance `tea-asr-1.1-mini` / `cpu`.
10. After P1: restart with `CAPTURE_SPEECH_RECOGNITION_MODEL=tea-asr-1.1`. The capture should fail as in section 4, the requirement should show `detail`, and no `capture-engine-speech-recognition-cpu.exe` process should start.
11. Measure:
    - Disk: sum the speech requirement tree (the folder holding `active.json`). Expect about 825 MB worker plus 3.40 GB models.
    - Cache growth.
    - A cold run with `CAPTURE_ENGINE_CACHE_DIR=off`.

Forcing `cpu` on the RTX box exercises everything except driver detection, which S2 covers with unit tests. Checking `auto` end to end needs a machine without a driver (open question 1).

## A. Files to change

| Repo / PR | File (lines) | Why |
|---|---|---|
| CW P1 | `provisioning/infrastructure/engine_content_selection.py`; `_engine_installation_errors.py` (+ re-export in `engine_installation.py`) | content→models rule; `SpeechModelNotInstalledError` |
| CW P1 | `speech/infrastructure/progressive_capture.py:443-449`; `capture/infrastructure/capture_extraction.py:854-857` | raise before the worker starts, streaming and with-speakers paths |
| CW P1 | `capture/application/streaming_capture_service.py:490-495` | `requirement_unavailable`, message kept, retryable false |
| CW P1 | `structuring/infrastructure/ollama/system_installer.py:325-331` | `detail` on a ready `cpu` install |
| CW P1 | `docs/domain/speech.md:69` | the "only `worker_failed`" sentence becomes false |
| CW P2 | `src/capture_runtime/release.py:56-123` | completeness and artifact walk per content |
| CW P2 | `scripts/verify_release_model_candidate.py:291-298, 356-361` | per-content check (`cuda` = the lock's delivery, `cpu` = `cpu_speech_model_delivery`); `speech_variant="cuda"` for the frozen fixture |
| CW P2 | `scripts/generate_engine_catalog.py:263-268` | `core-only` ignores the CPU archive instead of exiting |
| CW P2 | `tools/release/engine-catalog-parts.ts` (new `catalogDeliveries()`) | one TS walker for both shapes, instead of four copies |
| CW P2 | `tools/local-release-consumer-smoke.ts:181-326`; `apps/capture-workbench-desktop/scripts/practical-installed.ts:198-233`, `real-media-smoke.ts:212-217`, `real-media-model-smoke.ts:439-480` (lock vs `cuda` and `cpu`), `installed-process-cleanup.ts:31-40` | learn `contents` |
| CW P3 | `packages/capture-runtime/project.json:572-594` (dependsOn and flags), `:735-743` (add `verify-speech-recognition-cpu-boundary`), `:465` description | the switch |
| CW P3 | `CHANGELOG.md` Unreleased; runbook `:35-44`, `:365-372` | user-visible change; 19 assets |
| CW P4 | S8 docs (section C) | words |
| LAW L1 | `tools/scripts/shared/capture-runtime-resources/capture-runtime-resources.ts:113-155` (+ tests in `update-capture-version.test.mts:~229`, `stage-capture-runtime.spec.ts`, `verify-desktop-runtime-artifacts.spec.ts`) | walk `contents`; keep the legacy branch |
| Cert C1 (optional) | `tools/capture-candidate-gate.mts:176-194` (+ test fixture `:1846-1858`) | stale whisper inventory: derive it from the catalog or delete the path |

## B. PR order (nothing red in between)

1. **L1 (LAW, not user-visible).** Tests: a `contents` catalog passes and its `cpu` part URLs are checked; a legacy 0.9.0-shaped catalog still passes; a `contents` entry whose URL points at another release fails. Gate: `pnpm ci:local` (at least `pnpm nx run @org/scripts:test`).
2. **P1 (CW, not visible with release catalogs; visible only on a `cpu` install). Done in this change.** Tests (fixture catalog, injected driver):
   - `cpu` + `tea-asr-1.1` fails with `requirement_unavailable`, retryable false, the message above, on both the streaming and with-speakers paths, and the fake worker client is never called;
   - `cpu` + `auto`/mini and `cuda` + `tea-asr-1.1` pass;
   - a legacy engine is unaffected;
   - listing shows `ready` plus `detail`;
   - the rule matches the adapter's selection.

   Gate: `pnpm run verify:affected`, `pnpm nx run capture-runtime:test`, `capture-runtime:check-contracts` (must show no hash change).
3. **P2 (CW, not visible; release catalogs are still legacy). Done.** Tests:
   - `test_release_engine_consistency.py`: a contents catalog with both zips passes; a missing CPU zip, an extra zip, or an incomplete content fails;
   - `test_generate_engine_catalog.py`: core-only plus CPU flags produces an empty catalog;
   - `local-release-consumer-smoke.test.ts`: lists both zips and their manifests and no extra; legacy still passes;
   - the `practical-installed`, `real-media-smoke` and `real-media-model-smoke` tests.

   Gate: `verify:affected`, `capture-runtime:test`, the `capture-workbench-desktop` node test target (`project.json:220`). P1 and P2 are independent and can go in either order.
4. **(Optional) C1 (Cert Prep).** Gate: `pnpm ci:local`.
5. **P3 (CW, user-visible: the next release ships `cpu`). Done in this change, with P4.** Requires L1, P1 and P2.
   - Done: `generate-release-engine-catalog` depends on `build-speech-recognition-cpu-worker` and passes its archive and manifest; `build-release-artifacts` also depends on `verify-speech-recognition-cpu-boundary`. `core-only` still yields an empty catalog (the generator ignores the CPU flags there).
   - Done: `release.py` (`assert_release_speech_contents`), `verify_release_model_candidate.py` (not in `--preflight-speech-recognition`), `local-release-consumer-smoke.ts` and `real-media-model-smoke.ts` fail a model-enabled release whose speech requirement is legacy or has one content (decision 3 below). `practical-installed.ts` and `real-media-smoke.ts` still read both shapes, so a published 0.9.0 release can still be checked; the tag audit, `resolve-capture-release.ts` and `verify-release-candidate.ts` never read the speech shape.
   - Done: the candidate verifier runs a second pass that installs the candidate's own `cpu` archive and model subset (variant pinned `cpu`, own install root), probes it and transcribes the same private fixture the `cuda` pass uses, asserting `tea-asr-1.1-mini` / `cpu`, a non-empty transcript and ordered segments. Nothing is frozen for it (decision 2).
   - Done: `real-media-smoke.ts` and `progressive-audio-oracle.ts` force `CAPTURE_SPEECH_RECOGNITION_VARIANT=cuda`; the oracle's mirror now serves the `cuda` content's parts from the catalog. `real-media-model-smoke.ts` launches the desktop app, whose `launch_policy.rs` does not pass the variant, so it requires `%SystemRoot%\System32\nvcuda.dll` before it starts and its mirror stays `cuda`-only.
   - Done: `CAPTURE_SPEECH_RECOGNITION_*` joins the ambient guard in `release-candidate.yml` and in `real-media-model-smoke.ts`. `runtime-candidate.yml` has no such guard.
   - Workflows: only `runtime-candidate.yml` runs `build-release-artifacts` (`release-candidate.yml` reuses the runtime candidate). Its 90-minute timeout covers the extra CPU build; push CI's `runtime` job already builds all four workers on one runner. Assembly, the release manifest and both publishers list the runtime directory, so the two new assets needed no code change.
   - Behavior test: the generated catalog keeps the id `speech-recognition`, with contents `["cuda","cpu"]`, and the consumer smoke lists both zips.
   - Left open by P2, required before the switch:
     - A release gate runs the candidate's own `cpu` archive: it installs the `cpu` content from the candidate and transcribes. Today nothing does: the candidate verifier (`verify_release_model_candidate.py`) pins `cuda`, and push CI probes a separately built CPU zip.
     - The smoke mirrors that serve worker archives (`workerArchives` in `real-media-model-smoke.ts`, `progressive-audio-oracle.ts`) serve only the `cuda` zip. With a `contents` catalog they need the machine with the NVIDIA driver or a forced variant, or they serve both zips.
     - `CAPTURE_SPEECH_RECOGNITION_VARIANT` joins the ambient-environment guard of the consumer smoke step in `release-candidate.yml` (the `$ambient` check after `local-release-consumer-smoke.ts`, about line 590), so a stray value cannot change which content a release gate installs.
     - Decide whether a `contents` catalog with only one content may be released. Today a `cuda`-only `contents` catalog passes every tool.
   - Gate, mandatory before merge because CI never runs these targets (runbook `:532-536`): `pnpm nx run capture-runtime:build-release-artifacts --skip-nx-cache`, then `node tools/local-release-consumer-smoke.ts --runtime-dir packages/capture-runtime/dist/release --version 0.9.0`, then section 5 steps 6-11.
6. **P4 = S8 docs (user-visible: the unit guide in the UI). Done, folded into P3.** The sentences of section C are rewritten; the unit guide describes both packs.
7. **Release.** Pre-run both consumer gates (runbook `:457-475`). Cert Prep bumps first, then LAW, which already has L1.

## C. S8: sentences that become false once `cpu` is offered

- `AGENTS.md:21-24`: "By default, speech recognition runs TEA-ASR 1.1 on CUDA or, with no GPU, that same checkpoint on CPU. An explicitly chosen model also stays the same across devices and CPU retries."
- Decision record `.agents/DECISIONS/speech-recognition-tea-asr.md`. Add an addendum and mark these superseded:
  - `:7-10` "By default that checkpoint runs on CUDA when a GPU is present, and on CPU when it is not … `TEA-ASR-1.1-mini` stays installed for explicit selection and development tests; it is not the automatic CPU substitute."
  - `:90-93` "`auto` (the default) runs `tea-asr-1.1` on CUDA or CPU … `tea-asr-1.1-mini` or `tea-asr-1.1` runs that model on either device."
  - `:104-105` "The installed unit still holds both models. Installing only mini, and a worker without the CUDA libraries, is evaluated in issue #274."
  - `:111-114` "If no GPU is present, it uses the CPU. The default checkpoint is TEA-ASR 1.1 on both devices … The earlier automatic pairing … is retired."
- `packages/capture-workbench-ui/src/lib/i18n/unit-guides.ts`:
  - `:30` "沒有 GPU 時在 CPU 上執行同一個模型，速度明顯較慢。"
  - `:31` "兩種大小的辨識模型、對齊時間點的 Qwen3 模型與 GPU 執行環境。"
  - `:55` "without one it runs the same model on the CPU, which is much slower."
  - `:56-57` "Recognition models in two sizes, a Qwen3 model that aligns the times, and the GPU runtime."
  - `:18-21`: the comment cites "the 0.8.0 worker archives".
  - The guide is static and shown before the download, so the new text must describe both packs.
- `docs/domain/speech.md:63` "發行目錄尚未提供 `cpu` 內容時…" (now historical). `:69` "API 的呼叫端目前只會收到一般的 worker 失敗…需求也仍顯示為就緒" (P1 changes this).
- `docs/domain/provisioning.md:94` "沒有 `contents` 的需求（包含目前目錄裡的語音）…"
- `packages/capture-runtime/README.md:60-63` "By default TEA-ASR 1.1 runs on CUDA when a GPU is present and on CPU when it is not". `:68-70` "`auto`, the default, runs TEA-ASR-1.1 on CUDA or CPU … runs that model on either device".
- Runbook:
  - `:38-41` "Releases do not ship it yet … The published speech worker remains the CUDA archive"
  - `:367` "publishes 17 assets"
  - `:370` "the three `*-files.json` manifests"
- `CHANGELOG.md` Unreleased:
  - `:49-51` "TEA-ASR 1.1 runs on CUDA when a GPU is present and on CPU when it is not … no longer switches to TEA-ASR 1.1 mini because the device is CPU."
  - `:77-79` "`auto` (the default, TEA-ASR-1.1 on either device) … A chosen model runs on either device"
  - Add a "Speech recognition pack per machine" section.
- `.agents/PLANS/speech-recognition-contents.md:3` and `:17`: the "no consumer change" claims are wrong because of LAW.
- `README.md:45` ("TEA-ASR 1.1 (CUDA) or TEA-ASR 1.1 mini (CPU)") becomes true again; reword it as "CUDA pack / CPU pack".

## D. Release notes

- **Asset count:** a full release goes from 17 to 19 assets. The two new ones are `capture-engine-speech-recognition-cpu-<v>-windows-x64.zip` (one file, about 302 MiB) and `capture-engine-speech-recognition-cpu-<v>-windows-x64-files.json`, which makes four `*-files.json`. The Route A runtime release also gains these two.
- **Contracts:** the contract set and the document schema are unchanged.
- **What hosts must do when they bump:**
  - LAW: have L1 merged first. Without it, staging and `release-desktop` throw "Invalid Capture engine requirement."
  - Cert Prep: only the usual pin bump.
  - Hosts that set `CAPTURE_SPEECH_RECOGNITION_MODEL=tea-asr-1.1` on machines without a driver: also set `CAPTURE_SPEECH_RECOGNITION_VARIANT=cuda` before installing, or captures fail with `requirement_unavailable`.
- **What users see:**
  - On machines without a driver, the speech reinstall after a version bump downloads about 3.72 GB instead of about 10.5 GB.
  - Provenance becomes `tea-asr-1.1-mini` / `cpu` on those machines.
  - Mini and aligner files already in the shared cache are restored without downloading again.
  - Hosts that show `downloadBytes` need no change.

## E. Questions for the product owner

Answered by the product owner on 2026-11-11 (issue #154):

1. `auto` end-to-end evidence is the development machine with `CAPTURE_SPEECH_RECOGNITION_VARIANT=cpu`, plus the driver-detection unit tests. No extra machine.
2. The `cpu` pack's release evidence is one manual TEA-ASR-1.1-mini transcription on CPU, recorded in the runbook. The lock and the frozen private fixture stay `tea-asr-1.1` / `cuda`.
3. After the switch a release carries both contents; a `speech-recognition` requirement with one content fails the release candidate.
4. The unit guide describes both packs; its title stays.

Question 3 below (Cert Prep's whisper inventory) stays open. The questions as asked:

1. Is there a Windows machine or VM with no NVIDIA driver for the `auto` end-to-end check? If not, is forcing `cpu` on the RTX 4060 box plus the S2 unit tests enough release evidence?
2. Release evidence for the `cpu` pack: the lock and the private fixture stay on `tea-asr-1.1`/`cuda`. Is one manual CPU transcription with mini, recorded in the runbook, enough? A frozen CPU fixture would change the lock and needs your approval.
3. Cert Prep's strict-local candidate path still pins `capture-engine-whisper-*` (`capture-candidate-gate.mts:176-194`) and has failed on every real candidate since 0.7.0. Repair it or delete it?
4. Unit-guide wording: the guide cannot know which pack this machine will get. Should it name both packs ("with an NVIDIA driver: TEA-ASR 1.1; without one: TEA-ASR 1.1 mini on the CPU, about a third of the download"), and should the title stay "台灣語音轉文字（TEA-ASR 1.1）"?

## Risks

- **No CI coverage of the switch.** Only the local build of `build-release-artifacts` and the runtime candidate exercise P3.
- **Duplicated rule.** The runtime's content→models rule copies the worker's selection; the test in P1 pins them together.
- **Smokes that install through the desktop cannot force the variant.** `real-media-model-smoke.ts` now refuses to start without the NVIDIA driver, so it stays on `cuda`.
- **Plan file vs CI:** the plan says the CI runtime job has a 90-minute timeout; `ci.yml:214` says 60 (the job took 20 min).

### Critical Files for Implementation
- `C:\software-dev\capture-workbench\packages\capture-runtime\src\capture_runtime\release.py`
- `C:\software-dev\capture-workbench\tools\local-release-consumer-smoke.ts`
- `C:\software-dev\capture-workbench\packages\capture-runtime\src\capture_runtime\capture\application\streaming_capture_service.py`
- `C:\software-dev\capture-workbench\packages\capture-runtime\project.json`
- `C:\software-dev\gx.law-prep\tools\scripts\shared\capture-runtime-resources\capture-runtime-resources.ts`
