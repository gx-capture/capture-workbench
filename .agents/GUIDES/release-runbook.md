# Capture Workbench release runbook

Current as of 2026-11-25. This is the operational procedure for publishing a
Capture Workbench release and moving its consumers. Workflow files remain the
source of truth for inputs.

## Current state

- **0.11.0** (minor, changes the contract) is published through Route A
  (2026-11-25): npm, PyPI, crates.io and the `v0.11.0` runtime release carry
  it. The full route is under way: its release candidate passed (run
  45521214727), and the consumer gates and the release promotion follow once
  both consumers have adopted 0.11.0 (LAW's gate runs in its private repository
  after its Actions quota renews on 2026-12-01). Until then the stable pointer
  still names 0.9.0. Remaining steps are tracked in
  [#491](https://github.com/gx-capture/capture-workbench/issues/491).
- **0.9.0** (2026-11-03) is the last release that took the full route and the
  one the stable pointer names: Route A first, then the full route (release
  candidate 41649253900, consumer gates 41659676388, release promotion
  41666190542), so `v0.9.0` carries `capture-release-manifest-v1.json` and the
  desktop installer. Route A publishes npm (`@gx-capture/capture-workbench-ui`,
  `@gx-capture/capture-runtime-client` on GitHub Packages), PyPI
  (`capture-runtime-client`), crates.io (`capture-sidecar-launcher`), and the
  GitHub release (runtime exe, OCR, speech recognition and diarization
  engines, catalog). Consumers' release workflows that attest the release
  manifest need the full route.
- **0.10.0** is published through Route A only (2026-11-15): the registries
  and the `v0.10.0` runtime release carry it, and consumers pin it. It has no
  desktop installer, no `capture-release-manifest-v1.json` and the stable
  pointer still names 0.9.0, because its release candidate cannot pass
  `verify-windows-install` (see "Published through Route A: 0.10.0" below).
  0.11.0 takes the full route.
- Releases after 0.8.0 publish no Java SDK. Maven publication was removed on
  2026-10-31 (no consumer used it); versions through 0.8.0 stay on GitHub
  Packages.
- Cert Prep's `main` pins 0.11.0 (`WodenWang820118/cert-prep#159` and
  `WodenWang820118/cert-prep#160`, merged 2026-11-25). LAW still pins 0.10.0 on its `main` branch; its adoption
  follows after 2026-12-01.
- The workspace runs Nx 24 with task-based affected. The pull request `checks`
  job and `pnpm run verify:affected` lint, type-check, and unit-test only the
  projects a change affects. Push CI on `main` still verifies every project.
- The contract set no longer carries the release version: a patch release keeps
  its hash, and only a contract change moves it.
- **Open**: the licence lineage of the NDLOCR-Lite line detector's weights,
  delivered only in the optional `vertical-japanese-reader` unit; see
  `.agents/RESEARCH/ndlocr-lite-detector-licence-lineage-2026-10-06.md` ([#490](https://github.com/gx-capture/capture-workbench/issues/490)).
- Known limitations: handwriting OCR quality (printed text is the floor); page
  structure of dense vertical periodical scans and pages that mix directions;
  about a fifth of furigana on textbook pages is not set aside.
- Speech recognition ships as two packs from 0.10.0 (issue #154, see
  "Published through Route A: 0.10.0" below). The CUDA worker
  archive (about 2.95 GB, parted into files under 2 GB) is the `cuda` content
  of `speech-recognition`. The CPU worker archive,
  `capture-engine-speech-recognition-cpu-<version>-windows-x64.zip`, built from
  the `speech-recognition-cpu` extra (CPU PyTorch, environment
  `.venv-speech-recognition-cpu`), is the `cpu` content: one zip of 302 MiB
  (316,666,018 bytes at 0.9.0, about 825 MB extracted) with no CUDA runtime
  libraries. `generate-release-engine-catalog` builds and passes it, and
  `build-release-artifacts` also runs `verify-speech-recognition-cpu-boundary`.
  Push CI on `main` builds and probes it too. Size budgets still cover only
  the runtime executable and the NSIS installer.

## Published through Route A: 0.11.0 (minor, changes the contract)

- Published on 2026-11-25 through Route A. Runs: package candidate 45410358031
  (candidate `c47dba7e…`, manifest `e2f712a8…`), runtime candidate 45410943505
  (`model-enabled`; candidate `a3412ba6…`, manifest `71c094bb…`), package promote
  45518586680, runtime promote 45518938013 (`registries`). Source commit
  `29b948d` (merge of PR #495, a merge commit so that the model-source commit
  `76e8df09` stays in `main`'s history).
- Full route: release candidate 45521214727 (candidate `163a11d0…`, manifest
  `8d70d92d…`) passed every job, `verify-windows-install` included. It was
  dispatched right after Route A, while `main` still pointed at the source
  commit, so `main` could take other changes again; its artifacts expire on
  2026-12-09, which bounds when the consumer gates and `release-promote.yml`
  must run.
- Compatibility: the contract set changes (`7802e8b8…`, was `91ff5ff5…`), so
  `resolve-capture-release` in `route-a` mode reports `manual-review` and
  consumers migrate by hand; see the 0.11.0 entry of `CHANGELOG.md` for the
  changes.
- Model-source snapshot: annotated tag `capture-runtime-model-sources-v0.11.0`
  on `76e8df09`, pushed before the candidates.
- `cpu` speech pack evidence: manual transcription on 2026-11-24 (Windows 11)
  against runtime candidate 45410943505; with
  `CAPTURE_SPEECH_RECOGNITION_VARIANT=cpu` and the model left on `auto`, speech
  showed `installable` with `downloadBytes` 3,744,998,183; the installation
  completed in 287.5 s and `active.json` names `contentId` `cpu`. A 75 s `zh`
  excerpt transcribed in 26.4 s end to end: provenance `tea-asr-1.1-mini` /
  `cpu`, 4 ordered, time-located segments, no warnings.
- Packaged acceptance (#163) against the runtime candidate: OCR and speech
  journeys passed with provenance `pp-ocrv6-medium` / `directml` and
  `tea-asr-1.1` / `cuda`, and cleanup passed. Five pixel comparisons differed
  only in download-size digits, because the worker archives built locally and
  by CI differ in size; the product owner accepted the run, and masking those
  values is #497.
- Consumers: Cert Prep adopted 0.11.0 on 2026-11-25
  (`WodenWang820118/cert-prep#159`). Its first real-engine run on the dev
  server found that Cert's capture event decoder rejected the progress and
  speaker fields the runtime always sends (`pagesDone`, `pagesTotal`,
  `durationMs`, `speaker`, `speakerOverlap`, null included), which its
  `ci:local` fixtures did not carry; `WodenWang820118/cert-prep#160` fixed it
  and added that journey (`cert-prep-e2e:smoke-real-engines-dev-server`). Both
  layers then passed: the dev-server journey (OCR on DirectML, speech
  `tea-asr-1.1-mini` / `cuda`, questions on the Cert-owned Ollama on CUDA) and
  the packaged Capture Workbench smoke on an installed Cert Prep (OCR on
  DirectML, uninstall clean); #476 is closed. LAW after
  2026-12-01.

## Published through Route A: 0.10.0 (minor)

- Published on 2026-11-15 through Route A only. Runs: package candidate
  43694978756 (candidate `9340e428…`, manifest `ba85612a…`), runtime candidate
  43695168834 (`model-enabled`; candidate `b11b7bd4…`, manifest `a3a78e61…`),
  package promote 43702784865, runtime promote 43702964332 (`registries`).
  Source commit `b0924a8` (merge of PR #373). The first candidates
  (43682269376 and 43682540780, for `b890158`) were refused by the promotion
  and rebuilt; see the pitfalls.
- No full route: release candidate 43704963630 built the installer and passed
  the cross-framework, runtime-product and model-enabled verifications, but
  `verify-windows-install` fails for this source commit on every run (the
  installed smoke's real app-data guard; see the pitfalls). No consumer gate
  and no release promotion ran. The decision (product owner, 2026-11-15) is to
  leave 0.10.0 as it is and take the full route with the next release.
- Contents: two speech recognition packs (issue #154), the speech recognition
  model chosen apart from the device (issue #273), the runtime-owned built-in
  Ollama port (issue #255, PRs #368 and #369), the release-asset reduction
  (issue #278) and the launcher crate's removal of the group lifecycle (R3).
- Compatibility: contract-set SHA-256 unchanged (`91ff5ff5…`, as in 0.9.0);
  capture document schema unchanged (`5452631c…`). Clients require the same
  runtime minor, so 0.9.x clients refuse a 0.10.0 runtime at the handshake.
  `capture-sidecar-launcher` 0.10.0 removes public API (see the changelog).
- Model-source snapshot `3834db2` (annotated tag
  `capture-runtime-model-sources-v0.10.0`, pushed before the candidates). The
  lock pins the same models as 0.9.0, with the same approval record. OCR
  profile `capture-workbench-ocr-8530e3130b89f10b`.
- Consumers: Cert Prep first (`cert-prep#142`), then LAW
  (`gx.law-prep#382`); both bumped every Capture pin; the contract-set hash
  stays and `resolve-capture-release` reports `no-impact`.
- `cpu` speech pack evidence: manual transcription on 2026-11-15 (Windows 11,
  no GPU override) against runtime candidate 43695168834; the runtime reported
  0.10.0. With `CAPTURE_SPEECH_RECOGNITION_VARIANT=cpu` and the model left on
  `auto`, speech showed `installable` with `downloadBytes` 3,746,379,569; the
  installation completed and `active.json` names `contentId` `cpu` (993 s with
  every download in the first run against the superseded candidate
  43682540780, 97 s here with the model files restored from the engine cache).
  A 75 s `zh` excerpt transcribed in 55.2 s end to end (model load 10.6 s,
  transcription 21.1 s, aligner load 4.5 s, alignment 11.0 s): provenance
  `tea-asr-1.1-mini` / `cpu`, 4 ordered, time-located segments, no warnings.

### Two speech recognition packs

- What changes: a full release publishes 19 assets instead of 0.9.0's 28: the
  per-asset `.sha256` files and the size report are gone, and the new
  `capture-engine-speech-recognition-cpu-<version>-windows-x64.zip` and its
  `-files.json` make four `*-files.json`; the Route A runtime release gains the
  same two. The contract set and the capture document schema do not change.
- Hosts, when they bump:
  - LAW: its catalog reader must read `contents` first (the LAW change that
    walks `requirement.contents[].artifacts`). Without it, staging and
    `release-desktop` throw "Invalid Capture engine requirement." It must be
    on LAW `main` before the release candidate's consumer gate pre-run.
  - Cert Prep: only the usual pin bump.
  - A host that sets `CAPTURE_SPEECH_RECOGNITION_MODEL=tea-asr-1.1` on machines
    without the NVIDIA driver also sets `CAPTURE_SPEECH_RECOGNITION_VARIANT=cuda`
    before installing, or its captures fail with `requirement_unavailable`.
- Users: on a machine without the driver the speech reinstall after the bump
  downloads about 3.72 GB instead of about 10.5 GB, and transcripts report
  `tea-asr-1.1-mini` / `cpu`. Mini and aligner files already in the engine
  cache are restored without downloading. Hosts that show `downloadBytes` need
  no change.
- Release evidence for the `cpu` pack (product owner, 2026-11-11): one manual
  transcription with TEA-ASR-1.1-mini on the CPU, recorded in the release's
  section above. The model-source lock and the frozen private
  fixture stay `tea-asr-1.1` / `cuda`. Steps, with the runtime candidate's
  `runtime` directory or a local `build-release-artifacts` output:
  1. Serve the engine archives over a loopback mirror (for example
     `python -m http.server 8765 --bind 127.0.0.1` in that directory).
  2. Start `capture-runtime-x86_64-pc-windows-msvc.exe serve --port <P>` with
     `CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN=1`,
     `CAPTURE_SMOKE_WORKER_MIRROR_URL=http://127.0.0.1:8765`,
     `CAPTURE_SPEECH_RECOGNITION_VARIANT=cpu`, a short `CAPTURE_APP_DATA_DIR`,
     `CAPTURE_PORT=<P>`, `CAPTURE_API_TOKEN` and
     `CAPTURE_STRUCTURING_PROVIDER=host` (the default provider is Ollama). A
     hand-built environment must keep `USERNAME`: PyTorch reads the user name
     while the model loads, and without it the capture fails with
     `session_failed` at `speech-model-load-cpu-failed-oserror`.
  3. `GET /v2/runtime/requirements` shows speech `installable` with
     `downloadBytes` about 3.72e9. Install it with
     `POST /v2/runtime/installations` and wait for `completed`; the
     requirement's `active.json` names `contentId` `cpu`.
  4. Transcribe a short recording through the Python client and check
     provenance `tea-asr-1.1-mini` / `cpu`.
  5. Record the date, runtime version, candidate run, `downloadBytes`, the
     elapsed time and the provenance. Never record the recording, its name or
     its transcript.
  The `auto` choice is covered by the same run with the variant forced to
  `cpu` plus the unit tests of the driver check; no machine without a driver is
  needed (product owner, 2026-11-11).

## Published: 0.9.0 (minor)

- Published on 2026-11-03 through Route A (issue #181), then the full route
  (issue #237): release candidate 41649253900 (candidate `bc3a03ef…`, manifest
  `f7ff7286…`), consumer gates 41659676388 (the first run, 41652701739, failed
  on LAW's e2e web-server timeout, fixed in `gx.law-prep#339`), release promotion
  41666190542 (`all`); release manifest `a5e9a77f…`. Route A runs: package
  candidate 41603006054 (candidate `dbf64d07…`, manifest `5160231a…`), runtime
  candidate 41603269848 (`model-enabled`; candidate `c064d8d4…`, manifest
  `2e924341…`), package promote 41605327337, runtime promote 41605563992
  (`registries`). Source commit `c030eb4` (merge of PR #231).
- Contents: download size and downloaded bytes (PR #141), resumable engine
  downloads (PR #151), uninstalling an engine (PR #145), page and recording
  progress (PR #148), the TypeScript client reading raw captures again
  (PR #229), the optional Taiwan speech pack (PR #123), Japanese kanji forms in
  Japanese transcripts, and Angular `^22.0.0` ranges for the Web Component's
  compiler and elements (PR #195). The desktop installer includes UI phase 2
  (PR #149). No Java SDK.
- Breaking for clients: contract-set SHA-256 `91ff5ff5…` (0.8.0: `664b2b32…`).
  0.8.x clients reject the new response fields
  (`RuntimeRequirementV2.downloadBytes`, `RuntimeInstallationV2.downloadBytes`
  and `downloadedBytes`, `CaptureOperationV2.pagesTotal`, `pagesDone`,
  `durationMs` and `coveredUntilMs`), besides the handshake's minor and
  contract-set checks. Capture document schema unchanged (`5452631c…`).
- Model-source snapshot `e2c41ae` (annotated tag
  `capture-runtime-model-sources-v0.9.0`, pushed before the candidates). The
  lock pins the same models as 0.8.0, with the same approval record. OCR
  profile `capture-workbench-ocr-8a80b428fa4968ac`.
- Consumers: Cert Prep first, then LAW; both bump every Capture pin, the
  contract-set hash and tests that quote runtime minor 8 (see the changelog).

## Published: 0.8.0 (minor)

- Published on 2026-10-31 through Route A. Runs: package candidate
  41181447228, runtime candidate 41181635905 (`model-enabled`), package promote
  41183372874, runtime promote 41183508942 (`registries`). Source commit
  `97bb151` (merge of PR #116). The full route followed on 2026-11-02 at
  `cdbee11`: release candidate 41185624191, release promotion 41411635581.
  0.8.0 is the last release with a Java SDK on Maven.
- A host can name the language spoken in an audio capture
  (`StartCaptureV2.spokenLanguage`, PR #115), and deleting a capture deletes its
  uploaded source (PR #114). The owner approved the release on 2026-10-31.
- Measured with this source: on a 45-minute JLPT N1 listening test (RTX 4060),
  the speech worker with `ja` covered 87.2% of the official script in order,
  against 77.9% with the default Chinese, in 350 s instead of 385 s.
- Breaking for clients: contract-set SHA-256 `664b2b32…` (0.7.x: `60c62267…`).
  Capture document schema unchanged (`5452631c…`). Model-source snapshot
  `b4b62e3` (annotated tag `capture-runtime-model-sources-v0.8.0`). The lock
  pins the same models as 0.7.2, with the same approval record. OCR profile
  `capture-workbench-ocr-cea24c3eb2bcce57`.
- Consumers: Cert Prep migrates first and sends `ja` for Japanese audio; LAW
  then bumps `apps/law-prep-ai-service/src/app/capture_version.py` and its test
  samples. LAW does not need `spokenLanguage`.

## Published through Route A: 0.7.2 (patch)

- Published on 2026-10-26 through Route A only. Runs: package candidate
  40245444531, runtime candidate 40245677878, package promote 40246889088,
  runtime promote 40247082290. Source commit `d600d42` (merge of PR #111).

- Speed, progress and a desktop GPU switch (see the changelog). Measured on an
  RTX 4060 Laptop (8 GB) with locally built 0.7.2 workers installed through the
  runtime API from a local catalog:
  - speech: a 30 s clip 24 s first, then 6 s (0.7.1: 21-29 s each); a 40-minute
    streaming capture 339 s (0.7.1: 819 s); the private fixture's normalized
    output hash is unchanged (`73cd4c6c…`), 538 s -> 325 s one-shot;
  - OCR: 7 inputs x 3 in 211.8 s one-shot vs 140.8 s with the warm worker, same
    text; a 1654 x 2339 PNG 23-25 s -> 8 s (no 2x enlargement above 1024 px).
- New host settings: `CAPTURE_SPEECH_WORKER_IDLE_SECONDS` (300) and
  `CAPTURE_OCR_WORKER_IDLE_SECONDS` (120); 0 restores a worker per capture.
  The desktop app writes `speech-gpu-settings.json` and passes
  the speech GPU preference to the runtime.
- Compatible with 0.7.x clients. Contract-set SHA-256 unchanged (`60c62267…`);
  capture document schema unchanged (`5452631c…`). Model-source snapshot
  `954f19f` (annotated tag `capture-runtime-model-sources-v0.7.2`). The lock
  pins the same models as 0.7.1; its approval record is the owner's of
  2026-10-25 for the M4A private fixture (PR #108). OCR profile
  `capture-workbench-ocr-cdfec152f8131864`.
- Known limitations: a 12 MP photo peaks at about 7.9 GB of DirectML memory on
  a fresh OCR worker, so it can fail on a busy 8 GB GPU (capping the detector's
  input would change the OCR profile); the 0.7.1 OCR worker failed 2 of about
  60 one-shot runs (`ocr_worker_failed`), cause unproven.

## Published through Route A: 0.7.1 (patch)

- Published on 2026-10-25 through Route A only: npm, Maven, PyPI, crates.io and
  GitHub release `v0.7.1` (runtime exe `40e7eb74…`). Source commit `ce47d89`
  (merge of PR #107). Runs: package candidate 40168256301, runtime candidate
  40168394199 (`model-enabled`), package promote 40173058964, runtime promote
  40173207862 (`registries`).
- Consumers on 0.7.1: Cert Prep (PR #47) and LAW (PR #209); LAW's ASR E2E passed
  three plain and one speakers recording.
- Full route not finished: release candidate 40183828977 passed (after PR #109
  fixed the size checker); consumer gates 40185196544 ran Cert Prep's gate, but
  LAW's gate could not start because gx.law-prep had used its GitHub Actions
  budget (it resets on 2026-11-01). The full route moves to 0.7.2.
- 0.7.0 could not be used from a host. LAW found `GET /v2/runtime/requirements`
  answering 500. Driving the published runtime through the API with the
  published Python client then found three more defects; all four are fixed
  here (see the changelog):
  - the parted speech worker cannot be described by the artifact descriptor;
  - workers lacked `USERNAME`;
  - a blocked stdin read in the worker server stalled model loading;
  - an install beyond MAX_PATH failed only after the downloads.
- Verified before release:
  - The fixed runtime, with the published 0.7.0 catalog and workers, lists its
    requirements, installs speech recognition (140 s) and speaker
    identification (109 s) from the release assets and Hugging Face, and
    transcribes a 30 s recording on CUDA with `tea-asr-1.1`.
  - Locally built 0.7.1 workers, run through the runtime's `WorkerClient` as a
    capture with speakers does, load and transcribe instead of hanging.
- Compatible with 0.7.x clients. Contract-set SHA-256 unchanged (`60c62267…`);
  capture document schema unchanged (`5452631c…`). Model-source snapshot
  `61c7ecd` (annotated tag `capture-runtime-model-sources-v0.7.1`). The lock
  pins the same models as 0.7.0, and its approval record is unchanged. OCR
  profile `capture-workbench-ocr-e012547f1f9da4da`.
- Hosts: keep `CAPTURE_APP_DATA_DIR` to about 130 characters. The speech
  worker's longest DLL path is 78 characters below its install folder.
- The private speech reference fixture's expected output hash was still Whisper's in
  0.7.1. After the release it was frozen on the owner's 40-minute M4A interview,
  which replaced the missing MP3 (see the speech recognition decision); that
  change shipped in 0.7.2 (PR #108).

## Published through Route A: 0.7.0 (minor, breaking)

- Published on 2026-10-25 through Route A only: npm, Maven, PyPI, crates.io and
  GitHub release `v0.7.0` (runtime exe `0fefcce9…`; speech recognition worker
  as parts `.001`/`.002`, diarization, OCR). Not usable from a host; see 0.7.1.
- Runs: package candidate 40153882801, runtime candidate 40154057525
  (`model-enabled`), package promote 40155316510, runtime promote 40155490467
  (`registries`). Source commit `cd3c805` (merge of PR #106).
- 0.6.3 is published (GitHub release `v0.6.3`, 2026-10-16).
- Speech recognition: TEA-ASR-1.1 (CUDA) / TEA-ASR-1.1-mini (CPU) with
  Qwen3-ForcedAligner-0.6B under the renamed requirement `speech-recognition`
  (was `whisper-primary`; see `.agents/DECISIONS/speech-recognition-tea-asr.md`).
- Speaker diarization: NVIDIA Nemotron-3-Diarization (OpenMDW-1.1), revision
  `f667ed73aee57d40cc39428eb768b4fd87a0a29e`, Transformers 5.20.2, CPU PyTorch.
- Worker archives: speech recognition about 2.95 GB (CUDA PyTorch), published
  as parts `.001`, `.002` under 2 GB each; diarization about 315 MB. The size
  budgets cover only the runtime executable and the NSIS installer, which hold
  no worker, so they are unchanged.
- Breaking: contract-set SHA-256 `60c62267…` (0.6.3: `fc8a994e…`). Consumers
  (Cert Prep; LAW's Java engine and AI service) change `whisper-primary` to
  `speech-recognition` with the version bump.
- Model-source snapshot `d4b95bf` (annotated tag
  `capture-runtime-model-sources-v0.7.0`). The lock (34 files, about 7.5 GB)
  was approved by the owner on 2026-10-25. OCR profile
  `capture-workbench-ocr-7680a930bb89b381`.

## Published: 0.6.3 (patch, Route A then full route)

- Published on 2026-10-16 through Route A first: npm, Maven, PyPI, crates.io
  and GitHub release `v0.6.3` (runtime exe `3b96746c…`, OCR, rebuilt Whisper
  and diarization engine zips). The full publish below followed the same day.
- Fixes the two transcription defects the 0.6.2 consumer checks found
  (PR #96): Whisper's voice activity filter kept a click as speech, so a
  silent window yielded "You" and, with speakers, a word was timed at 0:00.
  The filter now ignores sounds shorter than 250 ms. Verified before release
  in a packaged Whisper engine installed through the runtime's install path.
- Compatible with 0.6.x clients. Contract-set SHA-256 unchanged
  (`fc8a994e…`). Model-source snapshot `d16effb` (annotated tag
  `capture-runtime-model-sources-v0.6.3`). OCR profile
  `capture-workbench-ocr-1f5dcb0f58337c71`. Source commit `2a117cc` (merge
  of PR #97).
- Runs: package candidate 38711240238, runtime candidate 38711539283
  (`model-enabled`), package promote 38830211377, runtime promote
  38830349779 (`registries`: crate, PyPI, tag and GitHub release). Consumer
  gates and the full publish were not run, for the reason given under 0.6.1.
- The runtime candidate artifact is about 620 MB; `gh run download` failed
  on dropped connections. A resumable download of the artifact's signed URL
  (fresh URL per resume) worked.
- Consumers moved: Cert Prep PR #43 and LAW PR #117. Each was checked against
  the published runtime (CUDA), and all runs passed:
  - Capture directly: the 40-minute phone interview 3 times (675 to 682
    segments, about 2 minutes each) and once with speakers (1033 seconds); no
    text before the first speech at 3:07, and the first word with speakers at
    4:42.93 with a speaker.
  - Cert Prep, through its backend Capture adapter: a PDF page, a JPEG and a
    short Chinese recording, 10 times each; then the interview 3 times.
  - LAW, through its engine and AI service: the PDF and JPEG 10 times each;
    the interview 3 times (83-84 lines from 3:07) and once with speakers
    (992 seconds).
  - No hallucination-like text ("You", "Thank you", subscribe or subtitle
    outros) in any saved output.
- Release candidate 38842806012 passed (candidate `792c521c…`, manifest
  `9feca0b1…`, contract impact `breaking` against 0.5.1), including the
  model-enabled runtime and Windows install verification. Both consumer
  gates passed a local full pre-run (2026-10-16): Cert Prep on `main`
  (`8ff4ef0`, 8 checks) and LAW on `feat/legal-ontology-hybrid` (`f4db1a7`,
  9 checks). LAW then merged `feat/legal-ontology-hybrid` into `main`
  (PR #118, `c3a7bdf`, tree identical to `f4db1a7`), so LAW `main` carries
  0.6.3. Consumer gates run 38846795348 passed (ledger verdict `passed`):
  Cert Prep run 38846826555 on `8ff4ef0` and LAW run 38847285881 on
  `c3a7bdf`.
- Full publish: release-promote run 38849532005 (`publication_scope=all`)
  passed every job: registries re-verified, tag, GitHub release with the
  desktop installer `Capture.Workbench_0.6.3_x64-setup.exe` (26 assets),
  stable pointer and promotion ledger. The pointer lives on the protected
  `release-index` branch, not `main`: `836ced2` points stable at `v0.6.3`
  with manifest `7154f54d…`, which matches the published
  `capture-release-manifest-v1.json`.

## Published through Route A: 0.6.2 (patch)

- Published on 2026-10-15 through Route A only, like 0.6.1: npm, Maven,
  PyPI, crates.io and GitHub release `v0.6.2` (runtime exe `82ea45a2…`, OCR,
  rebuilt Whisper and diarization engine zips). `release-index/stable.json`
  still points at `v0.5.1`, and no desktop installer is published for 0.6.x.
- Fixes recording transcription (PR #93):
  - The progressive decoder kept frame padding.
  - A silent first five minutes failed a capture.
  - Overlapping windows doubled sentences.
  - Speaker runs had a fixed 15-minute limit.
  - It also accepts any recording FFmpeg decodes, and Capture Workbench
    shows a transcript beside its recording.
  - The window merging and the checkpoint rule run in the Whisper worker,
    so the runtime candidate rebuilt `capture-engine-whisper`.
- Compatible with 0.6.x clients. Contract-set SHA-256 unchanged
  (`fc8a994e…`). Model-source snapshot `abe8b55` (annotated tag
  `capture-runtime-model-sources-v0.6.2`). OCR profile
  `capture-workbench-ocr-5b63d123f524e4b1`. Source commit `251cdb9` (merge
  of PR #94).
- Runs: package candidate 38684265560, runtime candidate 38684516941
  (`model-enabled`), package promote 38686114774, runtime promote
  38686311532 (`registries`: crate, PyPI, tag and GitHub release). Consumer
  gates and the full publish were not run, for the reason given under 0.6.1.
- Consumers moved: Cert Prep PR #43 and LAW PR #117 (LAW's recording
  transcription, on `feat/legal-ontology-hybrid`). Each was checked against
  the published runtime (CUDA), and all runs passed:
  - Cert Prep, through its backend Capture adapter: a PDF page, a JPEG and a
    short Chinese recording, 10 times each; then a 40-minute phone interview
    (M4A) 3 times, with 677 to 687 segments in 104 to 110 seconds.
  - LAW, through its engine and AI service: the PDF and JPEG 10 times each;
    the interview 3 times (82 lines, 115 to 124 seconds) and once with
    speakers (996 seconds; on 0.6.0 the whole interview with speakers failed
    at the 15-minute limit).
- Those checks found two transcription defects (a hallucinated "You" after a
  silent opening, a word with speakers timed at 0:00); 0.6.3 fixed both.

## Published through Route A: 0.6.1 (patch)

- Published on 2026-10-14 through Route A only, like 0.6.0: npm, Maven,
  PyPI, crates.io and GitHub release `v0.6.1` (runtime exe `6b9f33f4…`, OCR,
  Whisper and diarization engine zips). `release-index/stable.json` still
  points at `v0.5.1`, and no desktop installer is published for 0.6.x.
- One fix: each OCR model profiles under its own ONNX Runtime prefix, so GPU
  OCR no longer fails about half the time with `ocr_worker_failed` (PR #90).
- Clients still require the exact runtime version, so consumers move to 0.6.1
  clients; the contract-set SHA-256 is unchanged (`fc8a994e…`). Model-source
  source snapshot `10524f9` (annotated tag `capture-runtime-model-sources-v0.6.1`).
  OCR profile `capture-workbench-ocr-be5a35092b5cc3be`. Source commit
  `90b386f` (merge of PR #91).
- Runs: package candidate 38558758781, runtime candidate 38559118888 (both
  `model-enabled`), package promote 38561146766, runtime promote 38561502678
  (`github-release`) then 38562351390 (`registries`, which publishes PyPI and
  the crate; use `registries` the first time). Release candidate 38567018276
  passed; consumer gates and the full publish were not run.
- Consumers moved: Cert Prep `main` (PR #42) and LAW
  `feat/legal-ontology-hybrid` (PR #116). Before merging, each ran OCR (a PDF
  page and a JPEG) and ASR (a short Chinese recording) 10 times in a row
  against the published runtime, and all runs passed. Cert Prep went through
  its backend Capture adapter and LAW through its AI service OCR endpoint;
  LAW has no ASR path yet, so its ASR runs went straight to the runtime.
- Why the full route stopped: a release candidate's contract impact is
  measured against the stable pointer (0.5.1), so 0.6.x is `breaking` and the
  LAW gate is required. The gate runs on LAW `main`, which still pins 0.5.1;
  LAW's 0.6.x adoption lived on `feat/legal-ontology-hybrid` until 0.6.3.
- Observed: an audio capture's event stream reports `completed` about half a
  second before `GET /v2/captures/{id}` does, and `get_raw` answers
  `raw_unavailable` in between. Poll the operation before reading results.

## Published through Route A: 0.6.0

- Published on 2026-10-14 through Route A only (no consumer gates, desktop
  installer or stable pointer). The notes below describe how it was prepared.
- Incompatible with 0.5.x. Contract-set SHA-256
  `fc8a994e5a2a822376821da277e949eb203df9223977da4db4cdc7ab29724523`; the set no
  longer carries the release version, so the version bump did not change it.
- Model-source snapshot `99bfd21` (annotated tag
  `capture-runtime-model-sources-v0.6.0`). OCR profile
  `capture-workbench-ocr-09c2568f8a130abe`: the profile still carries the
  release version, so its id changes with every release.
- The lock has four units: the OCR unit, `speech-recognition` (until 0.6.3:
  `whisper-primary`), and the optional
  `speaker-diarization` (worker archive about 272 MB, models from
  `gx-capture/capture-model-sources`) and `vertical-japanese-reader` (models
  only, no worker archive).

## Workflow map

| Stage             | Workflow                                          | Produces                                                            |
| ----------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| Package candidate | `package-candidate.yml`                           | npm/PyPI/crate candidate bytes                                      |
| Runtime candidate | `runtime-candidate.yml`                           | runtime exe, engine zips, catalog                                   |
| Route A publish   | `package-promote.yml`, then `runtime-promote.yml` | registries, runtime seed GitHub release                             |
| Release candidate | `release-candidate.yml`                           | desktop installer + full candidate                                  |
| Consumer gates    | `consumer-gates.yml`                              | dispatches Cert/LAW gates, gate ledger                              |
| Full publish      | `release-promote.yml`                             | re-verified registries, tag, desktop assets, stable pointer, ledger |

Route A alone publishes the libraries and runtime. A runtime candidate built
from a source commit before this change cannot be published with the current
tooling; rebuild the runtime candidate. The full route reuses the Route A
candidate runs at the same source commit and is required for the desktop
installer and the stable pointer. Every publish step is idempotent:
npm and crates.io compare remote bytes, PyPI uses `skip-existing`, and
`tools/create-github-release.ts` keeps runtime seed assets and uploads only
missing ones.

- Contract impact: the release candidate classifies its contracts against the
  stable release (`tools/contract-impact.ts`): `no-impact`, `additive`,
  `breaking` or `manual-review`, the last for any change it cannot place.
  `.github/consumer-gates.json` lists the gates: Cert Prep is required always,
  LAW whenever the classification is not `no-impact`.
- `release-tag-audit.yml` audits every pushed `v*` tag against its candidate, release and
  registries. `release-supersede.yml` marks a defective tag superseded in
  `release-index/releases.json` and moves the stable pointer to a known-good
  replacement; its assets stay, and the defective release's notes get a
  warning footer.

## Manual runtime targets (not run by CI)

No workflow runs these `capture-runtime` targets. They are kept as tools for a
person:

- `verify-speech-recognition-worker` probes the locally built CUDA speech
  worker (`dist/workers/capture-engine-speech-recognition/`) with
  `scripts/probe_packaged_worker.py`. CI probes only the diarization and CPU
  speech workers. Run it after `build-speech-recognition-worker` when the CUDA
  worker's dependencies or its PyInstaller spec change.
- `generate-speech-recognition-preflight-catalog` and
  `verify-speech-recognition-preflight` are the way to freeze the private
  speech fixture again when the private recording or the speech model changes.
  They accept only a model-source lock whose approval is `blocked` with the
  single pending-freeze blocker (`PENDING_SPEECH_FREEZE_BLOCKER` in
  `scripts/model_source_lock.py`) and whose `speech-recognition` fixture has no expected
  model, device or output hash. On the approved lock they stop with an error;
  that is intended. Procedure: put the lock in that blocked state, run the
  preflight twice with the private recording (`--private-speech-fixture`),
  compare the two evidence files (they hold hashes, provenance and segment
  bounds, never the audio path or the transcript), then write the frozen
  model, device and normalized output hash into the lock and approve it.

## GitHub Release assets

From 0.10.0, a full release publishes 19 assets:

- Runtime: `capture-runtime-x86_64-pc-windows-msvc.exe`, `capture-runtime-manifest.json`, `capture-document-v2.schema.json`.
- Engines: `capture-engine-catalog.json`; each worker archive (the CUDA speech recognition worker is `capture-engine-speech-recognition-<version>-windows-x64.zip.001` and `.zip.002`, the CPU one is the single `capture-engine-speech-recognition-cpu-<version>-windows-x64.zip`); and the four `*-files.json` manifests (OCR, speech recognition, CPU speech recognition, diarization).
- Desktop: `Capture.Workbench_<version>_x64-setup.exe`.
- Evidence: `candidate-manifest.json`, `capture-runtime-candidate-manifest.json` (the Route A seed), `capture-contract-snapshot.json`, `capture-release-manifest-v2.json`, and `capture-release-manifest-v2.json.sha256`.

GitHub also attaches the source zip and tarball. A release keeps the assets it was published with. `tools/resolve-capture-release.ts` checks the release-manifest bytes against `release-index/stable.json` `manifestSha256` and the attestation. That check holds whether or not the release also carries per-asset `.sha256` files.

Check a new release like this:

- The executable and schema bytes match `capture-runtime-manifest.json` (`sha256`, `schemaSha256`).
- Each engine archive, split part, and `*-files.json` matches
  `capture-engine-catalog.json`, and a new model-enabled release's
  `speech-recognition` requirement must use `contents` with exactly `cuda` and
  `cpu`. Two checks verify this on the local release output, before
  publication; neither reads the published GitHub assets:
  - `capture-runtime:build-release-artifacts`
    (`packages/capture-runtime/src/capture_runtime/release.py`) validates the
    local engine directory: every delivery of every requirement is complete;
    each worker archive and part matches the catalog's size and sha256 and
    has exactly one matching `*-files.json`, equal to the archive's inner
    manifest; and the directory holds no uncatalogued archive or manifest.
  - `capture-runtime:local-release-consumer-smoke`
    (`tools/local-release-consumer-smoke.ts`, catalog shapes tested in
    `tools/release/engine-catalog-parts.test.ts`) verifies the local release
    directory and then a copy downloaded from a loopback mirror: each worker
    archive, its parts and its `*-files.json` manifest against the catalog
    digests. It also requires exactly the canonical asset names: a missing or
    extra file fails it.
  - Both, and the model-candidate verifier, reject a legacy or single-content
    speech requirement.
  - Re-checking a published legacy release (up to 0.9.0) still works, and each
    check that reads both shapes proves only its own part. The practical
    installed OCR rehearsal (`practical-installed-ocr.ts`), given a runtime
    release directory, checks its executable, manifest and schema and
    verifies the bytes of the OCR worker the installer selected, not every
    content's archive or manifest. The
    real-media smoke only requires each delivery of the embedded catalog to be
    complete (worker artifacts and model files listed, no unavailable reason);
    it reads no archive bytes. The tag audit (`audit-release-tag.ts`),
    `resolve-capture-release.ts` and `verify-release-candidate.ts` do not read
    the speech requirement's shape. The model-candidate verifier
    (`verify_release_model_candidate.py`) requires the two packs explicitly
    and installs both (below).
  - When the full local model check (`pnpm nx run
    capture-runtime:verify-release-model-candidate`) is required: whenever
    `release-model-source-lock.json`, an engine worker or a model delivery
    differs from the last published release (compare those files and the
    engine catalogue against the last release tag). 0.11.0 is such a release:
    the text recognition sources were re-committed and re-pinned. Otherwise
    the check is an optional diagnostic. Record its evidence file
    (`dist/candidate/model-probe-evidence.json`: hashes and counts only)
    beside the manual CPU transcription below.
  - `verify_release_model_candidate.py` compares model deliveries with the
    source lock: `cuda` must carry the lock's full speech files, and `cpu`
    exactly the subset that `cpu_speech_model_delivery` in `model_source_lock.py` derives,
    with the same bytes and sha256 and no `model/primary` path.
  - `verify_release_model_candidate.py` runs both packs. It installs `cuda`
    whatever the machine's driver and checks the frozen private fixture. It
    then installs the candidate's own `cpu` archive and model subset in a
    second install root, probes it and transcribes the same private audio,
    requiring `tea-asr-1.1-mini` / `cpu`, a non-empty transcript and ordered
    segments; no transcript is frozen for this pack, and the evidence keeps
    only hashes and counts. On the CPU this pass can take far longer than
    the CUDA one (its run timeout is 3 hours).
  - Run locally, the verifier and its speech preflight keep their work
    directory (the OCR, `cuda` and `cpu` installs and a copy of the private
    recording) as a fresh `model-candidate-<time>` / `model-preflight-<time>`
    tree under `.kept-run-trees` beside the checkout and print its path;
    remove it when the machine is idle with
    `corepack pnpm run kept-run-trees -- --remove <path>`. On a GitHub runner
    it is a temporary directory, deleted at the end.
  - Smokes whose oracle is `tea-asr-1.1` / `cuda` force that pack: the
    real-media smoke and the progressive audio oracle set
    `CAPTURE_SPEECH_RECOGNITION_VARIANT=cuda`. The ambient-environment
    check in `release-candidate.yml` rejects any
    `CAPTURE_SPEECH_RECOGNITION_*` variable.
- Every runtime, engine, and desktop asset matches `releaseAssets` in `capture-release-manifest-v2.json` (size and SHA-256). Published v1 releases keep their original asset list and bytes.
- That manifest's digest is recorded in `capture-release-manifest-v2.json.sha256` and `release-index/stable.json` `manifestSha256`.

For local checks, the application-level journeys with real engines run on the
dev server: `pnpm nx run capture-workbench-e2e:smoke-real-engines-installation` on an empty app data after a change to
installation, the engine catalog, a worker or a model delivery, and before a
release; `pnpm nx run capture-workbench-e2e:smoke-real-engines-execution` on the app data an installation journey of
the same build left, for every runtime or UI fix and before a release (it
checks that the installed engines match this build and never installs). A
change to code or data that a worker packages changes that worker's archive,
so the execution journey then needs a new installation journey first; other
runtime changes leave the archives byte-identical (#478). A
Desktop App run is only for WebView2 behaviour, native dialogs, drag and drop of
native paths, the installer, process cleanup on exit and pixel baselines.

The packaging budget still fails the release candidate when a measured size exceeds its budget. The size report is the CI artifact `capture-size-report-<version>-<run>`. It is not one of the 19 release assets.

Candidate checksums stay inside the candidate artifact and are not release assets: `checksums/*.sha256`, `candidate-manifest.json.sha256`, and the same files on the package and runtime candidates. They are the expected digests recorded before the release manifest exists.

## Procedure

1. Merge the release source to `main` and wait for **push** CI on that commit
   (`ci.yml`), whose `installer` job includes the release-mode installed smoke
   (`installed-nsis-smoke.ts --release`). To pre-flight a branch before
   merging, dispatch `ci.yml` (`workflow_dispatch`), which runs only
   `installer`. Release candidates verify the `push` run on `main` with
   `tools/verify-main-ci.ts` (never a `workflow_dispatch` run). `ci.yml` skips
   commits that change only Markdown or `.agents/`, so name the latest `main`
   commit that changed code.
2. Dispatch `package-candidate.yml` and `runtime-candidate.yml` for the exact
   commit. Record each run ID, `candidateId`, and the SHA-256 of its
   `candidate-manifest.json`. Download the small package artifact. The runtime
   candidate prints its `candidateId` ("Assembled runtime candidate") but not
   the manifest hash, and its artifact is about 3.8 GB with the CPU speech
   worker: read only
   `candidate-manifest.json` from the artifact zip with HTTP range requests
   (Python `zipfile` over a range-reading file object, on the blob URL that
   `GET /repos/{repo}/actions/artifacts/{id}/zip` redirects to). Then run the
   manual `cpu` speech pack transcription against this runtime candidate and
   record the runtime candidate ID and digest, installed `cpu` content, `tea-asr-1.1-mini` / `cpu` provenance, non-empty output, ordered segment count and elapsed time (see "Two speech recognition packs" under
   "Published through Route A: 0.10.0"). Record this manual evidence for every release that ships the CPU speech pack. When the full local model check is required, record its evidence as well.
3. Route A: dispatch `package-promote.yml`, then `runtime-promote.yml`. The
   runtime promotion requires a successful `workflow_dispatch` package promotion
   on `main` whose commit contains the candidate source.
4. Migrate consumers (pins, locks, generated clients), run their CI and a
   published-mode practical OCR check, and merge them to `main` (Cert Prep
   first, then LAW).
5. Dispatch `release-candidate.yml` with the Route A inputs and the
   `release_mode` recorded in the runtime candidate manifest
   (`model-enabled` for every release since 0.5.0). Record the run ID, `candidateId`, and the
   `candidate-manifest.json` hash from artifact
   `capture-candidate-<version>-<run>`. Dispatch it right after Route A while
   the head of `main` is still the release-source commit (the release
   promotion checks the candidate run's head commit), so `main` can take other
   changes while the consumers migrate; its artifacts are kept 14 days.
6. Pre-run both consumer gates locally against the downloaded release
   candidate before dispatching (see below), then dispatch
   `consumer-gates.yml`.
7. Dispatch `release-promote.yml` with `publication_scope=all`, the release
   candidate, Route A candidates, the consumer gate run ID, and the contract-set
   hash. Verify `gh release view v<version>` and `release-index/stable.json`.

## Consumer bump workflows: `resolve-capture-release`

Consumers find and verify the next release with the composite action
`.github/actions/resolve-capture-release` (implementation
`tools/resolve-capture-release.ts`). It fails closed on a digest mismatch, a
missing or wrong-signer attestation, a superseded release or a malformed
manifest.

- `mode: route-a` (bump PRs, step 4): the newest published release that
  `release-index/releases.json` does not mark superseded. It verifies
  `capture-runtime-candidate-manifest.json` against
  `_publish-runtime-github-release.yml`. Route A records no contract
  classification: the output is `no-impact` when `current-contract-set-sha256`
  matches, else `manual-review`.
- `mode: stable` (gate before an app release): the tag `stable.json` names. It
  checks the v1 or v2 full release manifest named by `stable.json`'s `manifestAssetName` against its
  `manifestSha256`, verifies it against `_publish-github-release.yml`, and takes
  `contract_classification` from the manifest's
  `contractClassification.classification` and `contract_set_sha256` from the
  digest-bound `candidate-manifest.json`.
- Outputs: `tag`, `version`, `manifest_sha256`, `contract_classification`,
  `contract_set_sha256`, `changed` (`false` when equal to `current-version`).

```yaml
- id: capture
  uses: gx-capture/capture-workbench/.github/actions/resolve-capture-release@<commit-sha>
  with:
    mode: route-a
    current-version: ${{ steps.pin.outputs.version }}
    current-contract-set-sha256: ${{ steps.pin.outputs.contract_set_sha256 }}
- if: steps.capture.outputs.changed == 'true'
  run: pnpm capture-version apply "${{ steps.capture.outputs.version }}"
```

Open a draft PR when `contract_classification` is `breaking` or
`manual-review`. Locally: `node tools/resolve-capture-release.ts --mode stable
--current-version 0.7.2` (needs `gh` signed in).

## Consumer gate pre-run

The gates run rarely and drift with toolchain upgrades; each CI round-trip
costs about 20 minutes. From each consumer checkout on `main`:

```sh
# Cert Prep (use a scratch worktree: the full check installs the candidate)
node tools/capture-candidate-gate.mts --candidate <rc-dir> --candidate-id <id> \
  --candidate-manifest-sha256 <sha> --source-commit <sha> --release-version <v> \
  --workflow-run-id 1 --output <out.json> --skip-checks
# LAW (Nx targets are the same ones LAW CI runs)
node tools/capture-contract-gate.mts --candidate <rc-dir> ... \
  --contract-classification <from rc contract-impact.json> --skip-checks
```

Drop `--skip-checks` for the full run. For Cert Prep, first install the
candidate with `node tools/install-capture-workbench-dependencies.mts
--candidate-package-dir <rc-dir>/package` and set
`CAPTURE_CANDIDATE_INSTALL=1`.

## Pitfalls already fixed (keep them fixed)

- Size budgets come from the tooling ref. Re-baseline
  `packages/capture-runtime/size-budgets/*` and the measurement evidence file
  (budget = measured bytes plus `headroomBasisPoints`) when the runtime grows.
- PyPI Trusted Publishing binds the top-level workflow: uploads stay inline in
  `package-promote.yml` and `release-promote.yml`. `_verify-pypi-publication.yml` only
  verifies and has no Trusted Publisher entry on pypi.org; do not re-add one.
- Consumer gate workflows pin `pnpm/action-setup@f40ffcd9…`; `b0f76dfb`
  installs a broken pnpm v11 shim. Gate check steps need GitHub Packages auth
  because pnpm 12 re-verifies `@gx-capture` lockfile entries.
- pnpm 12 rejects `pnpm install --lockfile=false`.
- GitHub Packages npm needs a token even for public packages.
- Launcher `cargo test` runs through `tools/cargo-test-retry-failed.ts`.
- Local practical OCR runs: keep `CAPTURE_APP_DATA_DIR` short (installed OCR
  worker paths beyond Windows MAX_PATH crash the worker) and set `CAPTURE_PORT`
  together with `--port`, or the allowed-host check rejects requests.
- PyPI's JSON API can lag an upload by minutes; the post-publish readback
  retries a 404 for about five minutes before failing. The simple index lags
  too: the clean-install check after the upload retries for about ten minutes
  (in 0.5.1 it failed three times within four minutes of the upload).
- Consumer migrations: bump only exact version tokens (never `10.4.2` or other
  packages' `0.4.2` in lock files), move tests that use the new version as a
  "wrong" value to `99.0.0` first, and let each package manager update its
  own lock. If `pnpm install` re-resolves unrelated peers (LAW), change only the
  `@gx-capture` lock entries and verify with `pnpm install --frozen-lockfile`.
  Regenerate consumer contract artifacts (LAW `law-contracts-generate`) and
  recompute pinned receipt digests from their canonical bytes.
- Cert Prep pins its `minimumReleaseAgeExclude` entries to exact
  `@gx-capture` versions. When the previous release is less than about a day
  old, `pnpm install` rejects the old lock entries before it can re-resolve;
  move only the two `@gx-capture` lock entries (integrity and tarball from
  GitHub Packages) and verify with `pnpm install --frozen-lockfile`.
- A version bump needs a new model-source snapshot before the lock can follow:
  first set the lock's `releaseVersion` and every requirement's
  `artifactVersion` to the new version by hand (`release-version-sync` never
  rewrites the lock, `repin-text-recognition` keeps both, and `validate`
  rejects any that differ from `release/version.json`), then
  run `scripts/generate_text_recognition_sources.py` after synchronizing the release version, then commit
  only `model-sources/text-recognition/` (source snapshot), push it with the annotated tag
  `capture-runtime-model-sources-v<version>`, then put its SHA in
  `TEXT_RECOGNITION_SOURCE_COMMIT`, then run `scripts/model_source_lock.py repin-text-recognition` to recompute the digests and byte counts of the
  first-party files from the committed bytes (`pipeline.json` and the
  provenance record the release version), and copy `text-recognition/model/pipeline.json` to
  `src/capture_runtime/assets/ocr-profile.json` (from 0.11.0 its profile id
  reads `ocr-<16 hex>`, e.g. `ocr-c3a409ecfd46b9ab`). The lock's approval record
  changes only with the owner's consent.
- Version management: preview with
  `pnpm nx run capture-tools:release-version-plan --args="--version <version>"`
  and apply with
  `pnpm nx run capture-tools:release-version-sync --args="--version <version>"`
  (`release/version.json` is the release intent). The updater never rewrites
  locks or approves model provenance and contract hashes. When the version
  changes, its `followUp` lists the steps that remain, in this order:
  1. Refresh the Python and Cargo locks with their package managers,
     keeping external dependency resolutions.
  2. Prepare and verify the model-source snapshot and lock through the
     existing model approval workflow (the snapshot bullet above); never
     rewrite approval or provenance.
  3. Run `pnpm nx run capture-runtime:generate-contracts` and the existing
     engine/profile generators for the selected source lock. The placeholder
     catalog `src/capture_runtime/assets/engine-catalog.json` comes from
     `uv run python scripts/generate_engine_catalog.py --development-stub
     --output src/capture_runtime/assets/engine-catalog.json` (in
     `packages/capture-runtime`).
  4. Recompute and review the contract and receipt identities from canonical
     bytes, then run `pnpm nx run capture-tools:release-version-check`.

  The check verifies the version owners and derived declarations, the
  generated versions and identities, the local Cargo and uv lock versions and
  the release inventory; it fails on a mismatch and otherwise prints one
  success line. Passing it is not candidate publication or installed
  acceptance. Keep negative versions and historical byte/digest evidence
  independent.
- Pull requests run only the quick `checks` job of `ci.yml` (lint, type
  checks, unit tests, and `capture-workbench:production-bundle-check` when the
  Workbench is affected); docs-only ones run nothing. Only `main` runs the full
  verification, so a build, packaging, or installer failure first shows on
  `main`'s push run: run the affected build targets locally before merging such
  a change, and fix `main` before dispatching a candidate. Tests never assert
  documentation prose, so docs edits alone cannot fail CI.
- Engine downloads are served from the machine-wide cache
  (`%LOCALAPPDATA%\gx-capture\engine-cache`) once any host has installed
  them. Set `CAPTURE_ENGINE_CACHE_DIR=off` to time or debug a cold download.
- A minor version bump also needs `CAPTURE_RUNTIME_MINOR` in
  `packages/capture-workbench-ui/src/lib/constants/runtime.ts`; the version sync
  and its check do not own it, and `capture-workbench-ui:test` is what fails.
- Lock refresh after a version bump: `cargo update -p <crate> --offline`
  changes only the first-party version lines. Once a project's version
  changes, uv re-resolves its whole lock (an implicit `uv run` does too) and
  can rewrite the environment markers of unrelated packages: keep only the
  first-party `version` line of each `uv.lock` and confirm with
  `uv lock --check --offline`. Once the lock passes that check, later
  `uv run` targets leave it alone; check `git diff --stat` before committing.
- Local `build-release-artifacts` after a version bump: delete the previous
  version's files from `packages/capture-runtime/dist/engines` and run with
  `--skip-nx-cache`, or the cache restores them and the catalog step rejects them.
  The ignored `src-tauri/resources/capture-runtime-manifest.json` is re-staged by
  `capture-workbench-desktop:stage-core-runtime`.
- Worker archives are built to be reproducible: the four worker builds run
  PyInstaller with a fixed `SOURCE_DATE_EPOCH` and `PYTHONHASHSEED`, UPX is off,
  and `scripts/worker_archive.py` writes explicit ZIP metadata and compression.
  To check it, build a worker twice with `--skip-nx-cache` from the same
  commit, compare the files manifests first, then the archive and part SHA-256
  values and lengths, then the catalog's worker descriptors (issue #478).
- Each worker build is cached on its own named input in
  `packages/capture-runtime/project.json` (its entry's import closure, data and
  notices, its spec and build script, and the shared archive inputs), so a
  runtime change outside that closure restores the archive from the Nx cache.
  The cache holds only the archive, its parts and its files manifest, not the
  onedir tree; a worker probe checks `dist/workers/<worker>` against the files
  manifest and re-extracts it from the archive when it differs. Use
  `--skip-nx-cache` to force a rebuild; in Nx 24 such a run also stores
  nothing in the cache, so the next run without the flag builds again. To
  probe without rebuilding the worker, add `--exclude-task-dependencies` to the
  `verify-*-worker` run. `test_worker_cache_inputs.py` fails when a module a
  worker imports is missing from its named input.
- Pin upstream model and configuration digests from git blobs or a real download,
  never from a checkout with `autocrlf`: text files there are CRLF copies.
- `capture-tools:promotion-registry-test` fails under Git Bash on Windows (its
  `tar` reads `C:` as a remote host). Run it where `tar` resolves to
  `C:\Windows\System32\tar.exe` (`Get-Command tar`): a PowerShell started from
  Git Bash inherits Git's `tar` first.
- Fresh worktrees, of this repository (the release-source branch) and of
  consumers: Nx can hang or pick the wrong workspace unless
  `NX_WORKSPACE_ROOT_PATH` is unset and `NX_DAEMON=false`.
  LAW's pre-commit runs `cargo check` (create the sidecar placeholder with
  `tauri:prepare-sidecar-placeholder` and `resources/.ci-placeholder` as CI
  does). GitHub Packages npm auth for a local `pnpm install`: a temporary
  `NPM_CONFIG_USERCONFIG` file, deleted afterwards.
- Consumer tests that quote the client's runtime minor (`runtime minor 4`) fail
  on a minor bump; LAW's `test_startup_timeout_waits_for_owner_cleanup` is
  timing-sensitive and failed once in CI on an unrelated change.
- The release-preparation pull request runs only the affected lint, type-check
  and unit-test targets. Before merging it, run
  `pnpm nx run capture-workbench-e2e:e2e` locally: the Web Component refuses a
  runtime of another minor, so a test double that reports a fixed runtime
  version fails the reference flow only after the bump (0.10.0: the OCR journey
  pinned `0.9.0`; it now reports `RELEASE_VERSION`). Push CI on `main` runs the
  reference flow, and a failure there means a new release-source commit.
- Dispatch the package, runtime and release candidates while the head of
  `main` is the release-source commit, and merge nothing to `main` between
  them. Each promotion requires the candidate run's `headSha` (the head of the
  dispatch ref) to equal `source_commit`; the candidate workflows themselves
  only require the commit to be reachable from `main`, so a candidate built for
  an older commit succeeds and is then refused by `package-promote.yml`
  ("not a successful exact-source package candidate") before anything is
  published. 0.10.0: the first candidates named `b890158` after `main` had
  moved to `b0924a8`; both were rebuilt for `b0924a8`.
- `ci.yml`'s `installer` job runs `installed-nsis-smoke.ts --release`
  on `main` pushes (and on `workflow_dispatch` as a branch pre-flight), in
  addition to `release-candidate.yml` (`verify-windows-install`). On a runner
  that has never started the product, the release build has no app-data
  redirect, so it creates the real product app-data and its library there. The
  real app-data guard (`installed-app-data-guard.ts`) therefore has two rules:
  the deterministic QA build must leave the real app-data untouched, and the
  release build may create the directory and its library folder, but nothing
  that existed may be removed and the library index must stay as it was. A
  release candidate built from a commit before this rule (0.10.0's `b0924a8`)
  fails `verify-windows-install` on every run; the checks run from the source
  commit, so the fix needs a new release-source commit.
- A pixel baseline must not contain values that depend on the build, such as
  download sizes, which differ between a local release build and the CI
  candidate (#497); check every compared screen for numbers that come from
  artifacts.
