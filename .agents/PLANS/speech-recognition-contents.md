# Speech recognition: `cuda` and `cpu` contents (issue #154, option A)

Requirement id stays `speech-recognition`. No new public field, problem code, or requirement id. Contract-set hash and `CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256` stay put. Launcher, TypeScript client, Python client, Cert Prep, and LAW get no code change.

Until a release catalog is generated with a CPU worker archive, a real catalog still has one speech delivery (today's CUDA pack). Machines with and without a driver install that pack. Detection does nothing for a requirement that has no `contents`.

## 1. Today's shape

Two catalog types exist. Install uses the infrastructure one. `provisioning/domain/catalog.py:10-26` is a separate in-memory descriptor (string tuples) and does not parse the JSON.

**File.** `catalogVersion` `"2"`, `runtimeVersion` must equal `RUNTIME_VERSION`, `requirements` is a list (`engine_catalog.py:18-19`, `652-685`). Each requirement's keys are exactly `requirementId`, `artifacts`, `modelFiles`, `unavailableReason` (`542-546`). A complete unit is one `role: "worker"` archive plus direct `modelFiles`, or models only for `vertical-japanese-reader` (`525-527`, `559-560`, `583-592`). Unknown keys fail (`46-50`). The checked-in copy is the incomplete placeholder `assets/engine-catalog.json:1-17`.

**Generated, then embedded.** `scripts/generate_engine_catalog.py:96-129` builds one requirement from one worker archive and `model_delivery()`. Speech is hard-wired to `capture-engine-speech-recognition.exe` (`206-217`). Payload is canonical JSON (`256-263`). `build_executable.py:26-30` copies that file and sets `CAPTURE_ENGINE_CATALOG_BUILD_PATH`. The frozen exe reads `_MEIPASS/capture-engine-catalog.json`; source runs read the placeholder (`engine_catalog.py:775-792`). The wheel also force-includes the placeholder (`pyproject.toml:62-63`). `release.py:37-62` and `218-220` republish `capture-engine-catalog.json` beside the exe. The runtime does not download a newer catalog at startup.

**Not a hashed contract.** `CaptureRequirementId` is the closed literal list that includes `speech-recognition` (`contracts/__init__.py:139-146`). `RuntimeRequirementV2` (`490-505`) and `RuntimeInstallationV2` (`557-569`) are what the contract set hashes (`contract_set.py` bundle of schemas, operations, problems). `CaptureDocument` schema hash is the constant at `release.py:24-26`. The engine catalog is absent from `generate_contracts.py`. `catalogVersion` in the clients (`discovery.ts:154-168` and the Python discovery twin) is the **contract index**, a different document (`contractSetVersion`, `surfaces`, `sha256`).

**Who else reads the engine catalog.** Same-repo release tools, with loose or exact walks of `requirements[].artifacts`: `tools/release/engine-catalog-parts.ts:39-95`, `tools/local-release-consumer-smoke.ts`, `apps/capture-workbench-desktop/scripts/practical-installed.ts:207-247`, `real-media-smoke.ts`, `real-media-model-smoke.ts`, `local-candidate-worker-mirror.ts`, `verify-release-candidate.ts`. `release-candidate.yml:578-582` compares requirement **ids** to the model-source lock, not artifact shape. No `*.rs` under the launcher parses it. Published clients never see the file; they see `GET /v2/runtime/requirements`.

**Requirement to bytes.** `download_bytes` is worker archive `bytes` plus model `extractedBytes` (`engine_catalog.py:610-615`). `SystemRuntimeInstaller.requirements` (`system_installer.py:141-210`) maps that to `RuntimeRequirementV2.downloadBytes`, status `ready` / `installable` / `unavailable`. `artifact` is set only for a single-URL worker of at most 512 MiB (`system_installer.py:60-74`, `contracts/__init__.py:483-486`). The parted CUDA speech archive therefore has `artifact: null` and is installed from the catalog.

**Disk.** Root is `{app data requirements}/{requirement_id}` (`engine_installation.py:866-871`). `active.json` keys are exactly `stateVersion` `"1"`, `requirementId`, `artifactVersion`, `workerProtocolVersion`, `entryPoint`, `activatedArtifacts` of worker sha256 plus model manifest sha256 (`engine_catalog.py:707-772`). Files live in `versions/{artifactVersion}/worker` and `.../model`. `is_installed` / `active_engine` (`engine_installation.py:336-409`) return ready only when version and both digests match **the one** catalog descriptor. Install no-ops when that already matches (`587-589`), then downloads that worker and those model files (`608-611`, `755-768`). Uninstall deletes `active.json` first, then the tree, then cache digests of that requirement's artifacts and model files (`824-853`, `_engine_uninstall.py:20-29`).

**Worker launch.** `capture_extraction.py:600-621` resolves the installed exe and passes `preferGpu`, `allowCpuFallback`, and `model` only when `CAPTURE_SPEECH_RECOGNITION_MODEL` is not `auto`. Streaming does the same via env (`progressive_capture.py:488-510`). `WorkerClient.probe` (`worker_client.py:35-55`) starts `engine.executable`.

**Model and CPU fallback, inside the worker.** `TeaAsrAdapter` (`speech_recognition.py:355-358`, `431-437`) maps `auto` and `tea-asr-1.1` to folder `primary`, and `tea-asr-1.1-mini` to `fallback`. `probe` requires both checkpoints, both architecture dirs, and `aligner` (`463-479`). Device: CUDA when `prefer_gpu` and `torch.cuda` sees a device; a classified CUDA failure retries **the same** checkpoint on CPU (`557-607`). Config defaults: `CAPTURE_WHISPER_PREFER_GPU` true, `CAPTURE_WHISPER_ALLOW_CPU_FALLBACK` true, model `auto` (`config.py:139-143`, `305-314`). The desktop sets those two from `nvcuda.dll` in `SystemRoot/System32` plus `compute-settings.json` (`compute.rs:66-74`, `launch_policy.rs:59-66`). The core exe cannot import torch (`verify_boundaries.py:11-22`).

**Models on disk** (lock `release-model-source-lock.json`, one `speech-recognition` unit, `artifactVersion` `0.9.0`): `model/primary/model.safetensors` 4,076,191,640 bytes (`664-670`), `model/fallback/model.safetensors` 1,564,926,456 (`506-511`), `model/aligner/model.safetensors` 1,835,545,960 (`346-351`), plus the small tokenizer sidecars under `primary`, `primary-architecture`, `fallback`, `fallback-architecture`, `aligner`. Runbook: CUDA worker archive about 2.95 GB, parted (`.agents/GUIDES/release-runbook.md:173-176`). That is the ~10.5 GB pack.

## 2. Catalog change

`catalogVersion` stays `"2"`. A requirement is **either** today's four fields **or** `requirementId` plus `contents` (one or more). Not both, so `download_bytes` cannot sum packs. Each content has `id`, `artifacts`, `modelFiles`, `unavailableReason` with the same completeness rule as today. `id` is `cuda` or `cpu`. Artifact and model-file objects are unchanged, so `engine-catalog-parts.ts` still parses a worker once the walker reaches it.

Single content (OCR, diarization, vertical reader, and speech until the CPU archive is passed in) — same bytes as today:

```json
{
  "requirementId": "windowsml-ocr",
  "artifacts": [{ "role": "worker", "fileName": "capture-engine-ocr-0.9.0-windows-x64.zip" }],
  "modelFiles": { "entryPoint": "model", "files": [] },
  "unavailableReason": null
}
```

Speech once both archives exist (digests omitted):

```json
{
  "requirementId": "speech-recognition",
  "contents": [
    {
      "id": "cuda",
      "artifacts": [{ "role": "worker", "requirementId": "speech-recognition", "fileName": "capture-engine-speech-recognition-0.9.0-windows-x64.zip", "entryPoint": "capture-engine-speech-recognition.exe" }],
      "modelFiles": { "entryPoint": "model", "files": ["...primary, primary-architecture, fallback, fallback-architecture, aligner, shared license..."] },
      "unavailableReason": null
    },
    {
      "id": "cpu",
      "artifacts": [{ "role": "worker", "requirementId": "speech-recognition", "fileName": "capture-engine-speech-recognition-cpu-0.9.0-windows-x64.zip", "entryPoint": "capture-engine-speech-recognition-cpu.exe" }],
      "modelFiles": { "entryPoint": "model", "files": ["...fallback, fallback-architecture, aligner, LICENSE-Qwen3-ASR.txt, NOTICE-fallback.md, NOTICE-aligner.md..."] },
      "unavailableReason": null
    }
  ]
}
```

`cuda.modelFiles` is today's `model_delivery(lock, "speech-recognition")` (`model_source_lock.py:621-639`). `cpu.modelFiles` is that list filtered to `model/fallback`, `model/fallback-architecture`, `model/aligner`, and the license/notice paths those entries reference. No new locked bytes. Both contents share `artifactVersion` = runtime version.

**Older runtimes.** They embed their own catalog. `from_dict` rejects a mismatched `runtimeVersion` (`667-668`) and extra keys. They do not fetch this asset. A hand-swapped newer file fails closed. No published engine-catalog JSON Schema exists, so none moves. Public hashes move only if `RuntimeRequirementV2`, `CaptureDocument`, the problem list, or `CaptureRequirementId` change. This shape does not touch them.

**Same-commit parsers must learn `contents` in the slice that first emits them.** `practical-installed.ts:211-215` throws if `artifacts` is missing. `release.py:70-72` iterates `requirement.artifacts` only. `local-release-consumer-smoke.ts` rejects a zip the catalog walk did not name. Those updates are internal. Requirement ids stay the lock's ids, so `release-candidate.yml:580-582` still passes.

## 3. Selection and persistence

Detection runs in the runtime process, never in the worker (the worker is not installed yet, and the core exe must not import torch). Match the desktop: `SystemRoot/System32/nvcuda.dll` is a file (`compute.rs:66-74`). The shipping exe is x64, so this is System32, not SysWOW64. Non-Windows counts as no driver. The desktop's `CAPTURE_WHISPER_PREFER_GPU` line stays; it is device preference inside a content, not content choice. The launcher does not grow a new env line. Unset variant means `auto`.

`CAPTURE_SPEECH_RECOGNITION_VARIANT` is `auto`, `cuda`, or `cpu`, validated like the model setting (`config.py:312-314`). Anything else fails process start. It applies to every requirement that has `contents`. Only `speech-recognition` has them. A requirement without `contents` ignores it.

Chosen content is fixed when the install lock is taken, written into `active.json`, and never re-detected:

- `stateVersion` `"1"` (today's keys) remains valid for a requirement **without** `contents`. OCR and diarization keep writing it.
- A contents install writes `stateVersion` `"2"` with the same keys plus `contentId`. `"1"` and `"2"` are different exact key sets.
- `active_engine` and launch load `contentId` and that content's worker sha256 and model manifest. They do not stat `nvcuda.dll`. Uninstall does not read the record: it deletes the requirement's whole tree and frees the cached downloads of every content.
- A second install while `active_engine` matches is still a no-op (`587-589`). The other content is not swapped in. Switching is uninstall, then install.
- Cache digests for uninstall are the union of every content of that requirement, minus digests other requirement ids use (`_engine_uninstall.py:32-40`).

`auto` prefers the detected content (`cuda` when `nvcuda.dll` is a file, otherwise `cpu`). When that content is missing from the catalog, `auto` uses the content that is published: the detected one when it is present, otherwise the only one. A forced `cuda` or `cpu` stays strict, so a missing forced content is `unavailable` with `downloadBytes` null. Listing and install both call `choose_content`.

`GET /v2/runtime/requirements` `downloadBytes` for a requirement that is not installed is the prospective content (what a fresh install on this machine would fetch). Once a content is installed, the listed size is that installed content's size until uninstall, including when the driver or the override later changes. The installation job's `downloadBytes` / `downloadedBytes` freeze the content chosen at install start. `status: ready` follows the installed content. Speech keeps `artifact: null` for every content, including a single-file archive under 512 MiB, so a host does not start that download itself on only some machines.

| State | status | requirement `downloadBytes` | what runs |
| --- | --- | --- | --- |
| Not installed, driver, `auto`, both contents published | `installable` | `cuda` | — |
| Not installed, no driver, `auto`, both published | `installable` | `cpu` | — |
| Not installed, no driver, `auto`, only `cuda` published | `installable` | `cuda` | — |
| Not installed, driver, `auto`, only `cpu` published | `installable` | `cpu` | — |
| Not installed, only the legacy speech object (interval below) | `installable` | today's single pack, driver ignored | today's worker |
| Not installed, `cpu` forced, no `cpu` content | `unavailable`, `downloadBytes` null | — | — |
| Not installed, `cuda` forced, no `cuda` content | `unavailable`, `downloadBytes` null | — | — |
| Not installed, `cuda` forced, no driver, `cuda` content published | `installable` | `cuda` | — |
| `cpu` installed, driver appears later | `ready` | installed `cpu` size | installed CPU exe; mini; device `cpu` |
| `cuda` installed, driver disappears | `ready` | installed `cuda` size | installed CUDA exe; today's same-model CPU retry |
| Override flipped after install | `ready` | installed content's size | installed content; override does not retarget launch |

Interval, after the parser and selector exist and before the generator is given a CPU archive: speech has no `contents`. List, install, readiness, uninstall, and launch are today's code path on every machine. `CAPTURE_SPEECH_RECOGNITION_VARIANT` is accepted and stored, and does not change speech. A GPU failure still retries `tea-asr-1.1` on CPU.

CPU-content inference (only once that content is what `active.json` names): default / `auto` loads folder `fallback` and reports `tea-asr-1.1-mini` / `cpu`. An option `model=tea-asr-1.1` raises before load with message `model not installed`. It does not select mini. `tea-asr-1.1-mini` loads mini. The CUDA content's `_selection` and `_transcribe` retry stay as they are (`431-437`, `557-607`). Pass the content id into the worker (run option and `CAPTURE_SESSION_SPEECH_MODEL`'s sibling). Do not infer the content from a missing `primary/` directory: a truncated CUDA install would then look like the CPU pack. Do not add a problem-registry code; those codes are in the contract bundle (`contract_set.py:154-165`). The existing worker-failure path carries the message.

`probe` for a CPU content is ready when mini, its architecture dir, and `aligner` are present. CUDA `probe` still requires primary and mini (`463-472`).

## 4. Slices

Each slice is a few files plus behavior tests, mergeable with CI green. Slices 1–4 do not need a CPU archive and do not change the release catalog.

**S1 — accept `contents` in the parser.** Files: `engine_catalog.py` (`EngineRequirementDescriptor.from_dict` / `to_dict` / `download_bytes` / `worker_artifact` / `model_delivery`), unit tests next to `test_generate_engine_catalog.py` and `test_engine_installation.py`. A legacy requirement round-trips. A two-content fixture round-trips and rejects a duplicate `id`, a content missing its worker, and a requirement that has both top-level `artifacts` and `contents`. Generator and the checked-in catalog stay legacy. `download_bytes` on a legacy requirement is unchanged. Done in this change. A model-only requirement cannot declare `contents`: that install path would ignore them and write state version 1.

**S2 — detector and env.** `CAPTURE_SPEECH_RECOGNITION_VARIANT` is validated in `config.py` the same way as the model setting (`auto` when unset; anything else fails process start). The driver check cannot live there: platform must not import provisioning. `engine_content_selection.py` answers `nvcuda.dll` and the content id; `EngineInstallationManager` calls it only when a requirement has `contents`, and only for `auto` (a forced `cuda` or `cpu` does not stat the driver). Tests inject the driver callable. Tests: a file under a fake SystemRoot selects `cuda`; a missing file, a directory, a missing or empty SystemRoot, or a non-Windows platform selects `cpu`; `auto` / `cuda` / `cpu` pass; any other value fails like the model setting. No test calls the detector against this machine. Done in this change.

**S3 — bind install, readiness, uninstall, launch to the recorded content.** Files: `engine_catalog.py` `ActiveEngineState`, `engine_installation.py` `active_engine` / `_install_locked` / `uninstall`, `system_installer.py` `requirements`, `_engine_uninstall.py` `download_digests`. Tests (fixture catalog, no real weights): legacy OCR still writes state `"1"` and ignores the variant; a two-content speech install writes `contentId` and the chosen worker sha; a later detector flip still returns the installed exe; install while that engine is active does not fetch the other content; uninstall drops both contents' digests from the cache and leaves another requirement's shared digest; list `downloadBytes` follows the detector only while the requirement is not installed and both contents are published; `auto` with only the other content published lists that content's size; once installed, the size is the recorded content's. Speech `artifact` is null for every content. Checked-in catalog has no `contents`, so production list/install stay on the S1 legacy path (the interval in section 3). Done in this change.

**S4 — CPU-content model rules in the shared adapter.** Files: `speech_recognition.py`, `speech_recognition_main.py` (probe + run options), `progressive_capture.py` and `capture_extraction.py` only to forward the installed content id. Tests in `test_speech_recognition.py`: CUDA content, `auto`, no GPU, fallback allowed, still reports `tea-asr-1.1` / `cpu` and still retries that checkpoint after a classified CUDA error; CPU content, `auto`, reports `tea-asr-1.1-mini` / `cpu`; CPU content with `model=tea-asr-1.1` raises `model not installed` and does not call the mini loader; CPU content with `tea-asr-1.1-mini` loads mini. CUDA `probe` still fails when primary is missing. CI will rebuild the CUDA worker because the module is shared; its **behavior** for a directory that contains primary stays. The release catalog sha changes only when the catalog is regenerated, which this slice does not do.

**S5 — generator can emit `contents`, and does not do so in release targets.** Files: `generate_engine_catalog.py`, `project.json` left without the new archive arg on `generate-release-engine-catalog` (`517-537`). Tests: omitting the CPU archive emits today's speech object; passing a tiny zip plus the real lock emits two contents whose `cpu` file bytes and sha256 equal the lock entries and whose paths omit `model/primary` and `model/primary-architecture`. `EngineCatalog.from_dict` accepts the output. Release nx command unchanged, so a release catalog is still cuda-only.

**S6 — CPU worker archive, not yet offered.** Section 5. After this, CI produces the zip. `generate-release-engine-catalog` still does not take it. Runtime behavior of a release catalog is the interval in section 3.

**S7 — offer `cpu` in the release catalog.** Point `generate-release-engine-catalog` at the new archive. Teach `release.py:70-100`, `practical-installed.ts:211-247`, `local-release-consumer-smoke.ts`, and the other catalog walkers in section 2 to collect artifacts from `contents` when present and from `artifacts` otherwise. A requirement with `contents` reports `complete` false, `artifact_version` none, and `download_bytes` none at the requirement level, so those walkers are not enough: `release.py` (the incomplete-catalog check around line 60) and `scripts/verify_release_model_candidate.py` (around line 293) must judge completeness per content. `release-candidate.yml:580-582` needs no id change. Behavior test: a generated catalog's speech requirement id is still `speech-recognition`, and the consumer smoke lists both zips and no extra zip. This is the first release that downloads ~3.8 GB on a machine with no driver.

**S8 — words that describe the pack.** Decision addendum, `docs/domain/speech.md` (engine supply sentence), `packages/capture-workbench-ui/src/lib/i18n/unit-guides.ts` (today's guide says the same TEA-ASR 1.1 checkpoint runs on CPU). The decision already says those facts move with the lock (`speech-recognition-tea-asr.md:79-84`). No client package change. `Agents.md` speech paragraph is the workspace rule that still says the default checkpoint is TEA-ASR 1.1 on CPU; update it in this slice so later work does not "fix" the CPU content back.

## 5. CPU speech worker build

CUDA speech and diarization already share the package list and differ by torch index and entry module.

| | CUDA speech | Diarization | CPU speech |
| --- | --- | --- | --- |
| Extra | `speech-recognition` (`pyproject.toml:31-36`) | `diarization` (`37-42`), same four packages | new extra, same four packages |
| Torch index | `pytorch-cu128` on win32 (`73-80`) | PyPI (no source override) | PyPI, same as diarization |
| Env | `.venv-speech-recognition` (`project.json:407-410`) | `.venv-diarization` (`430-434`) | `.venv-speech-recognition-cpu` |
| Conflict | cuda extra conflicts with diarization (`69-71`) | | conflict with the cuda extra |
| Spec | `capture-engine-speech-recognition.spec:14-18` (`qwen3_asr`, librosa), Japanese kanji `LICENSE` (`43-48`), exe name `84-88` | `capture-engine-diarization.spec:14-18` (nemotron), no kanji file | clone the **speech** spec; exe `capture-engine-speech-recognition-cpu` |
| Script | `build_speech_recognition_worker.py:13-43`, stem `capture-engine-speech-recognition-{version}-windows-x64` | `build_diarization_worker.py:13-43` | same script shape, new stem |
| Nx | `build-speech-recognition-worker` (`project.json:395-414`), `verify-speech-recognition-worker` (`736-747`) | `build-diarization-worker` (`416-435`), `verify-diarization-worker` | parallel targets |
| Boundary | `verify_boundaries.py:35`, `142-145` forbids paddle/cv2, does not assert CUDA dlls | not in that script | add a third zip argument; forbid the CUDA runtime names the speech worker carries today (`cublas`, `cudnn`, `cudart`, `nvrtc`) so a cu128 wheel cannot slip in |
| CI | `ci.yml:249-255` builds speech via `verify-worker-boundaries` and diarization via `verify-diarization-worker` | | add the verify target beside diarization. Do not add it to `build-release-artifacts` (`project.json:680-687`) until S7 |
| Size | parted, ~2.95 GB (`release-runbook.md:173-176`). Budgets cover the runtime exe and NSIS only | ~315 MB, one zip | reuse `archive_parts` (`generate_engine_catalog.py:46-77`). Expect one zip under 2 GB; if the build exceeds 2 GB the existing parts path applies. No size-budget file change |

Entry stays `workers/speech_recognition_main.py`. The CPU archive is the same code on CPU torch, not the diarization worker.

## 6. Model source lock and release tooling

Do not add files, revisions, or an approval. `validate_source_lock` (`model_source_lock.py:513-598`) keeps one `speech-recognition` requirement. The private fixture may still expect `tea-asr-1.1` / `cuda` (`493-498`); that fixture runs the CUDA content. `MAX_SOURCE_LOCK_TOTAL_BYTES` (`31`) stays, because the lock does not grow.

Add a filter used only by catalog generation: CPU paths are the subset above, each byte count and sha256 copied from the lock entry. A test fails if a CPU path is missing from the lock or if a `model/primary` path is included. CUDA generation keeps calling `model_delivery` unchanged.

`runtime-candidate.yml:133` reaches the catalog through `build-release-artifacts` and `generate-release-engine-catalog`. Wiring the CPU zip is S7, not S6. `classify-release-model-mode` stays `core-only` / `model-enabled`.

Placeholder `assets/engine-catalog.json` stays the legacy two-requirement incomplete catalog so core-only and local runs still load.

## 7. Risks and open questions

Risks the code forces, with the resolution used above:

- Sharing `speech_recognition.py` means the next CI worker build changes the CUDA archive digest. CUDA **behavior** (models, same-checkpoint CPU retry) stays. The catalog hash moves only in S7.
- `active.json` exact keys (`719-729`) cannot gain `contentId` without a new `stateVersion`. `"1"` must keep parsing or OCR installs break.
- Introducing `contents` under the same `artifactVersion` as an already installed speech unit makes that unit not ready (`engine_installation.py:351-363`) because the rebuilt worker sha no longer matches. Upgrade is uninstall/reinstall, which the product already requires for a content switch.
- `probe` that treats "primary missing" as the CPU pack would hide a corrupt CUDA install. The content id is passed in instead.
- A new problem code changes the contract-set hash. The failure is a worker message on the existing failure path.
- If the CPU zip is a single file of at most 512 MiB, `system_installer.py` would set public `artifact` on CPU machines and leave it null on GPU machines. S3 already keeps speech's `artifact` null for every content, so hosts do not start fetching the worker themselves. S6 still confirms the built size.
- `release.py:56-58` allows only the four known requirement ids. Contents do not add an id. Forgetting to walk `contents` in S7 makes the CPU zip an unknown release file and fails the consumer smoke.
- Unit guides and `Agents.md` still say TEA-ASR 1.1 is the CPU default. S8 is what stops that sentence from being re-implemented.

Resolved on 2026-11-10 (defaults inside the decided design; recorded on issue #154):

1. `downloadBytes` of a requirement that is not installed is the content this machine would download. Once a content is installed, the requirement reports the installed content's size until it is removed, so a removal dialog shows what is on disk.
2. A forced variant is honored: `cuda` forced on a machine with no driver is installable and then follows today's CPU rule; a forced variant whose content the catalog does not have is `unavailable`.
3. A `cpu` content always runs on the CPU, whatever `preferGpu` and `allowCpuFallback` say, because it has no GPU path. Provenance reports device `cpu`.
