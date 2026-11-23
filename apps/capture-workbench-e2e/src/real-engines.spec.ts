/**
 * Localhost real-engine installation and execution journeys (issue #475).
 * Run smoke-real-engines-installation on fresh, empty app data for delivery changes
 * and before a release. It proves downloads, verification, cancel/retry/re-attach,
 * model installation, first start and restart with unchanged versions/<v>/verified-files.json.
 * Run smoke-real-engines-execution for every runtime/UI fix on that installed app
 * data from the same build. It checks catalog-bound readiness before any capture,
 * and proves the execution stages below (including the owned Ollama CUDA UUID).
 * Digest-only evidence is under tmp/capture-workbench-e2e/real-engines-<journey>.
 * Playwright's per-run folder is outside the workspace and holds videos of private transcripts.
 * Delete that run folder after reading the result.
 *
 * Drives the real Workbench UI (`capture-workbench:serve`) against the real
 * headless host (`capture-workbench-dev-host`) and the staged product (or
 * specified) `capture-runtime` with real recognition engines and Ollama
 * structuring:
 * Installation
 *   1. First-run installation via UI (`/ocr` first-run card & `/settings/engines`),
 *      covering cancel + retry and reload re-attachment without duplicate installs, and checking the installed speech pack.
 *   2. Installing the structuring model.
 *   3. Starting and restarting with persistent verification records.
 * Execution
 *   0. Removing what an earlier run left stored waiting or in progress (a failed
 *      stage 8 leaves such rows, and a waiting one would start at the app's load
 *      and run beside this run's captures): cancelled, then deleted in History,
 *      as a user does.
 *   1. Checking catalog readiness, the installed speech pack and the active model.
 *   2. PDF and image OCR to `/history/:id/content`, verifying normalized text
 *      anchors, rendered source, the stored checkpoint (`awaiting_confirmation`
 *      at stage `awaiting_structuring`, no capture link, raw text, completed OCR
 *      evidence with the engine's provenance), `library_get` provenance (and
 *      exact OCR device when `CAPTURE_REAL_ENGINES_EXPECTED_OCR_DEVICE` is set),
 *      and `/settings/diagnostics`.
 *   3. Structuring model selection on `/settings/diagnostics`, audio transcription
 *      with speaker diarization and structuring on `/asr`, verifying the speech
 *      provenance of the installed pack (`tea-asr-1.1` on `cuda` by default with the NVIDIA
 *      driver, `tea-asr-1.1-mini` on `cpu` without) + Ollama structuring
 *      provenance with sha256 digests. With the progressive media pair set,
 *      a separate capture without speaker identification verifies the live
 *      checkpoint and the final transcript against the oracle.
 *   4. Viewing, editing with a synthetic marker, reload persistence, exporting to
 *      disk, and restoring edits.
 *   5. Stopping the launcher (host + runtime + workers) and restarting on the same
 *      `--app-data` directory, verifying features, model, all documents,
 *      restored PDF state, and active ASR edit persist without re-installing.
 *   6. Deleting the image document and the recordings from `/history`
 *      (`history-row-delete` -> `history-delete-dialog` /
 *      `history-delete-confirm`), verifying UI removal, absence from
 *      `library_list`, and `Capture library document was not found.` from
 *      `library_get`.
 *   7. Stopping and restarting the launcher once more on the same `--app-data`
 *      directory, verifying the PDF document still opens and all deleted
 *      document IDs remain absent from `library_list` and `library_get`.
 *   8. The capture lifecycle with real captures (real-engines-capture-lifecycle.ts):
 *      the recording and the PDF dropped together run one at a time; a reload
 *      while the recording's speech worker is at work leaves it 已中斷 with 重新開始 and
 *      deletes its capture once, and the worker ends; 重新開始, then Cancel while it works shows
 *      取消中 until the runtime's delete answers, the page sends no other command
 *      for that capture, it is stored cancelled and the waiting PDF (imported
 *      once more) starts; 重新開始 captures it to its end. At its end, also when
 *      it failed, it cancels what still runs or waits of its documents and
 *      deletes them all in History, so the app data keeps none of them.
 *
 * Explicit per-stage timeout placeholders (to be measured by the first real run):
 * Installation
 *   - 01-install-engines:         45 minutes (cold real downloads; much faster with cache)
 *   - 02-install-structuring-model: 40 minutes (measured 21.7)
 *   - 03-installed-first-start-and-restart: 10 minutes
 * Execution
 *   - 00-remove-unfinished-documents: 10 minutes
 *   - 01-check-installed-catalog: 10 minutes
 *   - 02-ocr-pdf-and-image:       10 minutes
 *   - 03-asr-and-structuring:     35 minutes
 *   - 03-progressive-partial:     scales with measured audio duration and device
 *   - 04-edit-restore-and-export:  3 minutes
 *   - 05-restart-persistence:      5 minutes
 *   - 06-delete-documents:         2 minutes
 *   - 07-restart-after-deletion:   5 minutes
 *   - 08-capture-lifecycle:       45 minutes (measured 2.0-2.5 with the cuda pack)
 *
 * Environment variables are validated before starting the host.
 *   Required media & expectations for execution:
 *   - CAPTURE_REAL_ENGINES_PDF (or CAPTURE_REAL_MEDIA_PDF / CAPTURE_REAL_DESKTOP_OCR_PDF)
 *   - CAPTURE_REAL_ENGINES_PDF_EXPECTATIONS (optional override; defaults to `<pdf>.expected.json`)
 *   - CAPTURE_REAL_ENGINES_IMAGE (or CAPTURE_REAL_MEDIA_IMAGE / CAPTURE_REAL_DESKTOP_OCR_INPUT)
 *   - CAPTURE_REAL_ENGINES_IMAGE_EXPECTATIONS (optional override; defaults to `<image>.expected.json`)
 *   - CAPTURE_REAL_ENGINES_AUDIO (or CAPTURE_REAL_MEDIA_AUDIO)
 *   - CAPTURE_REAL_ENGINES_AUDIO_EXPECTATIONS (defaults to `<audio>.expected.json`)
 *   Required runtime/storage directories & model selection:
 *   - CAPTURE_REAL_ENGINES_APP_DATA (or CAPTURE_REAL_MEDIA_APP_DATA): dedicated absolute directory (empty for installation, installed for execution) outside %APPDATA%/%LOCALAPPDATA%
 *   - CAPTURE_REAL_ENGINES_TEMP_DIR: absolute private temp directory for host/runtime/exports/browser artifacts
 *   - CAPTURE_REAL_ENGINES_MODEL_OPTION_ID: e.g. `qwen3.5-0.8b-v1`, `qwen3.5-2b-v1`, `qwen3.5-4b-v1`
 *   Optional overrides & checks:
 *   - CAPTURE_REAL_ENGINES_PROGRESSIVE_AUDIO and CAPTURE_REAL_ENGINES_PROGRESSIVE_AUDIO_ORACLE
 *     Optional pair for a private recording over five minutes and its digest-only oracle.
 *   - CAPTURE_REAL_ENGINES_EXPECTED_OCR_DEVICE (execution): `directml` or `cpu`; when set,
 *     both PDF and image extraction provenance and diagnostics must match exactly.
 *   - CAPTURE_REAL_ENGINES_RUNTIME_MANIFEST & CAPTURE_REAL_ENGINES_RUNTIME_EXECUTABLE (both or neither; default is staged product runtime)
 *   - CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN / CAPTURE_SMOKE_WORKER_MIRROR_URL
 *   - CAPTURE_SPEECH_RECOGNITION_VARIANT sets the expected pack (auto, cuda, or cpu).
 *   - CAPTURE_SPEECH_RECOGNITION_ALLOW_CPU_FALLBACK: explicit override.
 *     Defaults to false for this smoke so the installed pack's device is verified.
 *
 * Evidence `proven` records what this run actually proved (a passed stage alone
 * does not prove optional or reused capabilities):
 *   - `installation`: true when stage 1 installed the recognition units from scratch
 *   - `cancelAndRetry`: true when stage 1 cancelled and retried a real unit install
 *   - `modelInstallation`: true when the installation journey installed the Ollama structuring model
 *   - `ocrDevice`: true when `CAPTURE_REAL_ENGINES_EXPECTED_OCR_DEVICE` was set and matched
 *   - `progressivePartial`: true when the live and final oracle comparisons passed
 *   - `deletion`: true when all UI deletions and the post-restart absence check passed
 *   - `captureLifecycle`: true when stage 8 passed; `captureLifecycle` in the
 *     evidence holds its counts, statuses and delete durations, which criterion
 *     counted the speech worker as at work, and the documents it removed
 * `unfinishedDocumentsRemoved` counts what stage 0 found, cancelled and deleted.
 * `captureWindows` gives each capture's time span (no names), so samples taken
 * beside the journey (`capture-workbench-desktop:check-real-engine-devices`
 * with `--observe capture-workbench-dev-host.exe --observe-app-data <app data>`)
 * can be read per capture and per engine worker.
 *
 * The runtime runs as the product runs it. The host starts it with the product's
 * launch policy (`launch_policy.rs`, `constants/launch.rs`), which clears the
 * environment and forwards a fixed list. So, as in the Desktop App:
 *   - App data, temporary files and engine cache must resolve outside the workspace.
 *   - the speech model is the installed pack's default, not a development
 *     override: this smoke is on the release side of "Speech development tests"
 *     in AGENTS.md;
 *   - downloaded engines are cached in the runtime's default engine cache
 *     (`%LOCALAPPDATA%\gx-capture\engine-cache`), the one folder of the user's
 *     profile this run writes to. App data, runtime data, Ollama data and temp
 *     files are under the directories given above.
 *
 * Private material warning:
 *   Never commit private inputs or recognized text. This spec keeps input file
 *   names, recognized text, speaker names, and user-profile paths out of test
 *   titles, console logs, errors, and the evidence JSON.
 */
import { test } from '@playwright/test';
import { runJourney } from './real-engines-journey.ts';

for (const journey of ['installation', 'execution'] as const) {
  test(`runs real-engine ${journey} journey on localhost`, async ({ page }) => {
    await runJourney(page, journey);
  });
}
