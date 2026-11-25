// Real speech recognition journey on the packaged Capture Workbench desktop
// app: what a user does with a recording, on the non-installed acceptance
// build (`build-acceptance`) with real engines. It launches the app with fresh
// app data in the run's own data root, connects over CDP, and walks the UI:
//
//   asr-ready          /asr after speech recognition was installed from the
//                      ASR page (worker archives from the loopback mirror,
//                      models from the catalog) and a structuring model from
//                      Settings › Diagnostics (a recording is structured
//                      before it is done)
//   asr-done-row       the recording, chosen with the native picker, done
//   asr-result         its transcript; Settings › Diagnostics then shows the
//                      installed pack's provenance, equal to the stored one
//   asr-cancelled-row  the recording chosen again and cancelled while it runs
//                      (取消中, then 已取消); Start again then captures it to
//                      its end
//   asr-restarted-row  the completed row after Start again (saved only)
//   engine-removed     Settings › Engines after removing speech recognition
//
// then deletes both documents in History and proves the app, its runtime, the
// CDP port and the run's data are gone. Cancel and Start again are proven with
// real engines at layer 1 (capture-workbench-e2e:smoke-real-engines-execution);
// here each runs once so that its screens can be approved, and the states the
// row shows are checked.
//
// It runs in acceptance (E2E_ACCEPTANCE_RUN_ID: the packaged runtime must be
// the runtime candidate's) or baseline review mode (E2E_BASELINE_REVIEW_RUN_ID:
// the local release runtime), see packaged-journey-run.ts, and writes
// asr-journey-evidence.json. Speech runs the installed pack's default, as the
// product does: `tea-asr-1.1` on `cuda` with the NVIDIA driver,
// `tea-asr-1.1-mini` on `cpu` without it (AGENTS.md, speech development tests).
//
// Inputs (one per line):
//   CAPTURE_REAL_DESKTOP_ASR_RECORDING: required; a short excerpt (one to three minutes) of a recording,
//     kept outside the repositories and never uploaded.
//   CAPTURE_REAL_DESKTOP_RUN_DATA_ROOT: required; a short parent like C:\cwr.
//     The app's unique data directory below it must fit in 40 characters and is removed after the run.
//   CAPTURE_REAL_DESKTOP_STRUCTURING_MODEL_OPTION_ID: optional structuring model option (default qwen3.5-0.8b-v1).
//   CAPTURE_REAL_DESKTOP_RELEASE_DIR: optional in review; the local release whose worker archives the run
//     serves (defaults to packages/capture-runtime/dist/release).
//   CAPTURE_REAL_DESKTOP_EXECUTABLE: optional path to capture-workbench-desktop.exe (defaults to the release target binary).
//   CAPTURE_REAL_DESKTOP_TEARDOWN: optional teardown mode (`window-close` default, or `terminate-process`).
//   CAPTURE_RUNTIME_CANDIDATE_ROOT, CAPTURE_RUNTIME_CANDIDATE_ID, CAPTURE_REAL_DESKTOP_INSTALLER_PROVENANCE:
//     required in acceptance mode, as for the OCR journey.
//   E2E_ACCEPTANCE_KEEP_APP_DATA: optional; `1` keeps the run's data root (its cleanup is then unproven).
//
// The recording's name, path, transcript and speaker names never reach logs or
// evidence; checkpoint screenshots mask them (checkpointScreenshotMasks).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { Locator, Page } from '@playwright/test';

import { nativeClickWebViewElement, nativeOpenDialogUiAutomation } from './installed-browser.ts';
import { readVerifiedLocalCandidateCatalog } from './local-candidate-worker-mirror.ts';
import { comparedCheckpointNames, type JourneyCheckpointComparison } from './packaged-checkpoint-comparison.ts';
import {
  checkpointNameOf,
  packagedJourneyVerdict,
  resolvePackagedJourneyRun,
  writePackagedJourneyEvidence,
  type PackagedJourneyProvenance,
} from './packaged-journey-run.ts';
// The packaged runtime's identity against a runtime candidate stays beside
// the OCR journey, whose acceptance introduced it.
import {
  readLocalInstalledRuntimeProvenance,
  resolveLocalInstalledRuntimeIdentity,
} from './real-desktop-ocr-smoke.ts';
import {
  attachToLaunchedDesktop,
  checkpointScreenshot,
  closeOwnedDesktopRoot,
  deleteCompletedDocument,
  desktopCdpArguments,
  establishOwnedDesktopLaunch,
  finishOwnedDesktopSession,
  injectCheckpointPrivacyStyle,
  invokeTauriCommand,
  isProcessAlive,
  pinViewportToWindow,
  prepareRunDataRoot,
  readDurableLibraryDetail,
  readLatestInstallation,
  readRequirementStatus,
  readRuntimeSidecarPid,
  reattachToPackagedPage,
  removeRunDataRoot,
  reservePort,
  resolveDesktopTeardownMode,
  runDataEnvironment,
  scrubLocalModelEnvironment,
  visibleRuntimeError,
  waitForPortClosed,
  waitUntil,
  type CdpBrowser,
  type DurableLibraryDetailRecord,
  type OwnedDesktopSessionCleanup,
  type RunDataRoot,
} from './packaged-workbench-session.ts';
import {
  readReviewRelease,
  resolveReviewReleaseDirectory,
  startReleaseWorkerMirror,
  type ReleaseWorkerMirror,
  type ReleaseWorkerMirrorOptions,
} from './release-worker-mirror.ts';
import { appRoot } from './stage-runtime.ts';

const workspaceRoot = resolve(appRoot, '..', '..');
const outputDirectory = join(workspaceRoot, 'tmp', 'capture-workbench-desktop', 'real-desktop-asr-journey');
const defaultDesktopExecutable = join(
  appRoot,
  'src-tauri',
  'target',
  'x86_64-pc-windows-msvc',
  'release',
  'capture-workbench-desktop.exe',
);
const defaultStructuringModelOptionId = 'qwen3.5-0.8b-v1';
const runtimeReadyTimeoutMs = 3 * 60_000;
// The cuda pack downloads about 10.5 GB of models on a cold cache.
const speechInstallTimeoutMs = 90 * 60_000;
// When the speech install activates, one requirements read can verify the
// whole engine inside the request (13.8 s measured, #501). The host's own HTTP
// timeout is 60 s, so a probe of this wait may take that long; a probe slower
// than the usual 5 s is printed.
const speechInstallProbeBudgetMs = 60_000;
const slowProbeMs = 5_000;
const structuringModelInstallTimeoutMs = 45 * 60_000;
const recordingTimeoutMs = 30 * 60_000;
const cancelTimeoutMs = 2 * 60_000;
const engineRemovalTimeoutMs = 5 * 60_000;
const retriedInstallationCodes: ReadonlySet<string> = new Set([
  'installation_io_failed',
  'installation_timeout',
]);
const safeErrorCodePattern = /^[a-z][a-z0-9_-]{1,63}$/u;
const rowStatusWatchKey = '__captureAsrRowStatusTexts';

/**
 * The ASR journey's screenshots, in order. The restarted row is saved for review.
 */
export const ASR_JOURNEY_CHECKPOINTS = [
  { name: 'asr-ready', compared: true },
  { name: 'asr-done-row', compared: true },
  { name: 'asr-result', compared: true },
  { name: 'asr-cancelled-row', compared: true },
  { name: 'asr-restarted-row', compared: false },
  { name: 'engine-removed', compared: true },
] as const;

export type AsrJourneyCheckpointName = (typeof ASR_JOURNEY_CHECKPOINTS)[number]['name'];

export interface ExpectedSpeechProvenance {
  readonly pack: 'cuda' | 'cpu';
  readonly model: 'tea-asr-1.1' | 'tea-asr-1.1-mini';
  readonly device: 'cuda' | 'cpu';
}

/**
 * The installed speech pack's default: the packaged host forwards no speech
 * model or pack setting, so the runtime installs the `cuda` pack where the
 * NVIDIA driver is present and the `cpu` pack elsewhere.
 */
export function expectedSpeechProvenance(nvidiaDriverPresent: boolean): ExpectedSpeechProvenance {
  return nvidiaDriverPresent
    ? { pack: 'cuda', model: 'tea-asr-1.1', device: 'cuda' }
    : { pack: 'cpu', model: 'tea-asr-1.1-mini', device: 'cpu' };
}

function nvidiaDriverPresent(): boolean {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return existsSync(join(systemRoot, 'System32', 'nvcuda.dll'));
}

/** One change a row showed: its user status and the text of its status chip. */
export interface RowStatusObservation {
  readonly status: string;
  readonly text: string;
}

/**
 * A Cancel of a running recording shows 取消中 while the runtime's delete is
 * pending and then 已取消, and the recording is never shown done between them.
 */
export function assertCancelSequence(observed: readonly RowStatusObservation[]): void {
  const cancelling = observed.findIndex((entry) => entry.status === 'processing' && entry.text === '取消中');
  const cancelled = observed.findIndex((entry) => entry.status === 'cancelled' && entry.text === '已取消');
  assert.ok(cancelling >= 0, 'The cancelled recording never showed 取消中.');
  assert.ok(cancelled > cancelling, 'The cancelled recording did not show 已取消 after 取消中.');
  assert.ok(
    observed.slice(cancelling, cancelled).every((entry) => entry.status === 'processing'),
    'The cancelled recording showed another state between 取消中 and 已取消.',
  );
}

export interface RecordingOutcome {
  readonly extraction: PackagedJourneyProvenance & { readonly digest: string };
  readonly structuring: PackagedJourneyProvenance;
  readonly segmentCount: number;
}

/**
 * A recording captured to its end: stored completed without its capture link,
 * with raw segments, the speech provenance of the installed pack and the
 * provenance of the structuring that made it done.
 */
export function readRecordingOutcome(
  detail: DurableLibraryDetailRecord,
  expected: ExpectedSpeechProvenance,
  options: { readonly structuringDevice?: string } = {},
): RecordingOutcome {
  assert.equal(detail.status, 'completed', 'The recording was not stored completed.');
  assert.equal(detail.captureId ?? null, null, 'The completed recording kept its capture link.');
  const raw = jsonRecord(detail.raw, 'The completed recording omitted its raw capture.');
  assert.ok(Array.isArray(raw.segments) && raw.segments.length > 0, 'The completed recording has no transcript segments.');
  const result = jsonRecord(detail.result, 'The completed recording omitted its structured result.');
  const extraction = jsonRecord(
    result.extractionEngine,
    'The structured result omitted its speech provenance.',
  );
  assert.ok(extraction.engine === 'speech-recognition', 'The recording did not report speech recognition.');
  assert.ok(extraction.model === expected.model, 'The recording was not transcribed with the installed pack\'s model.');
  assert.ok(extraction.device === expected.device, 'The recording was not transcribed on the installed pack\'s device.');
  assert.ok(typeof extraction.digest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(extraction.digest), 'The speech provenance digest is invalid.');
  assert.ok(
    isDeepStrictEqual(extraction, raw.extractionEngine),
    'The structured result and raw capture disagree on speech provenance.',
  );
  const structuring = jsonRecord(result.structuringEngine, 'The completed recording omitted its structuring provenance.');
  assert.ok(structuring.engine === 'ollama', 'The recording did not report Ollama structuring.');
  assert.ok(typeof structuring.model === 'string' && structuring.model.trim(), 'The structuring model was not recorded.');
  if (options.structuringDevice !== undefined) {
    assert.ok(structuring.device === options.structuringDevice, 'The recording was not structured on the designed device.');
  }
  return {
    extraction: {
      engine: 'speech-recognition',
      model: String(extraction.model),
      device: String(extraction.device),
      digest: String(extraction.digest),
    },
    structuring: {
      engine: 'ollama',
      model: String(structuring.model),
      device: typeof structuring.device === 'string' ? structuring.device : 'unreported',
    },
    segmentCount: raw.segments.length,
  };
}

export async function main(options: {
  readonly comparison?: JourneyCheckpointComparison;
} = {}): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('The packaged ASR journey requires Windows x64.');
  }
  const journeyRun = resolvePackagedJourneyRun(process.env, workspaceRoot);
  if (!journeyRun) {
    throw new Error('The packaged ASR journey runs in acceptance (E2E_ACCEPTANCE_RUN_ID) or baseline review (E2E_BASELINE_REVIEW_RUN_ID) mode.');
  }
  const teardownMode = resolveDesktopTeardownMode(process.env.CAPTURE_REAL_DESKTOP_TEARDOWN);
  const recordingPath = requiredPath('CAPTURE_REAL_DESKTOP_ASR_RECORDING');
  await requireRegularFile(recordingPath, 'CAPTURE_REAL_DESKTOP_ASR_RECORDING');
  const recordingName = basename(recordingPath);
  const recordingSha256 = await sha256File(recordingPath);
  const desktopExecutable = resolve(
    process.env.CAPTURE_REAL_DESKTOP_EXECUTABLE?.trim() || defaultDesktopExecutable,
  );
  await requireRegularFile(desktopExecutable, 'CAPTURE_REAL_DESKTOP_EXECUTABLE');
  const modelOptionId = process.env.CAPTURE_REAL_DESKTOP_STRUCTURING_MODEL_OPTION_ID?.trim() || defaultStructuringModelOptionId;
  const nvidia = nvidiaDriverPresent();
  const expectedSpeech = expectedSpeechProvenance(nvidia);
  // The structuring model runs on CUDA where the NVIDIA driver is; elsewhere
  // its device depends on the adapters, and is only recorded.
  const structuringDevice = nvidia ? 'cuda' : undefined;

  let runtimeSha256: string;
  let candidateId: string | undefined;
  let mirrorOptions: ReleaseWorkerMirrorOptions;
  if (journeyRun.mode === 'acceptance') {
    const candidateRoot = requiredPath('CAPTURE_RUNTIME_CANDIDATE_ROOT');
    candidateId = requiredDigest('CAPTURE_RUNTIME_CANDIDATE_ID');
    const identity = await resolveLocalInstalledRuntimeIdentity({
      installedExecutablePath: desktopExecutable,
      candidateRoot,
      candidateId,
      installerProvenance: await readLocalInstalledRuntimeProvenance(
        requiredPath('CAPTURE_REAL_DESKTOP_INSTALLER_PROVENANCE'),
      ),
    });
    runtimeSha256 = identity.runtimeSha256;
    const catalog = await readVerifiedLocalCandidateCatalog({
      candidateRoot,
      candidateId,
      requirementId: 'text-recognition',
    });
    mirrorOptions = {
      releaseDirectory: join(candidateRoot, 'runtime'),
      requirementIds: ['speech-recognition'],
      catalogSha256: catalog.catalogSha256,
    };
  } else {
    const release = await readReviewRelease(
      desktopExecutable,
      resolveReviewReleaseDirectory(workspaceRoot, process.env),
    );
    runtimeSha256 = release.runtimeSha256;
    mirrorOptions = { releaseDirectory: release.directory, requirementIds: ['speech-recognition'] };
  }
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(journeyRun.artifactRoot, { recursive: true });

  const screenshots: string[] = [];
  const documentIds: string[] = [];
  let status: 'completed' | 'failed' = 'failed';
  let provenance: PackagedJourneyProvenance | undefined;
  let mirror: ReleaseWorkerMirror | undefined;
  let runData: RunDataRoot | undefined;
  let launchedApp: ReturnType<typeof spawn> | undefined;
  let sessionCleanup: OwnedDesktopSessionCleanup | undefined;
  let cdpPort = 0;
  let webViewData: string | undefined;
  let failure: unknown;

  const checkpoint = async (page: Page, name: AsrJourneyCheckpointName): Promise<void> => {
    await checkpointScreenshot(page, journeyRun.artifactRoot, screenshots, name, options.comparison?.capture);
  };

  try {
    mirror = await startReleaseWorkerMirror(mirrorOptions);
    runData = await prepareRunDataRoot(process.env.CAPTURE_REAL_DESKTOP_RUN_DATA_ROOT, 'CAPTURE_REAL_DESKTOP_RUN_DATA_ROOT');
    cdpPort = await reservePort();
    webViewData = join(outputDirectory, `webview2-${randomUUID()}`);
    const sessionData = runData;
    const sessionWebViewData = webViewData;
    const sessionMirror = mirror;
    launchedApp = await establishOwnedDesktopLaunch({
      onChildSpawned: (child) => {
        launchedApp = child;
      },
      spawnChild: () => spawn(desktopExecutable, [], {
        cwd: resolve(desktopExecutable, '..'),
        env: {
          ...scrubLocalModelEnvironment(process.env),
          WEBVIEW2_USER_DATA_FOLDER: sessionWebViewData,
          ...runDataEnvironment(sessionData),
          CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN: '1',
          CAPTURE_SMOKE_WORKER_MIRROR_URL: sessionMirror.baseUrl,
          // A GPU failure fails the capture instead of a slow CPU fallback
          // that the provenance check would refuse anyway.
          CAPTURE_SPEECH_RECOGNITION_ALLOW_CPU_FALLBACK: 'false',
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: desktopCdpArguments(cdpPort),
        },
        stdio: 'ignore',
        windowsHide: true,
      }),
    });
    const app = launchedApp;
    const browserClients: CdpBrowser[] = [];
    let page: Page | undefined;
    let runtimeSidecarPid: number | undefined;
    const attach = async (attached: { readonly browser: CdpBrowser; readonly page: Page }): Promise<Page> => {
      browserClients.push(attached.browser);
      page = attached.page;
      await injectCheckpointPrivacyStyle(page, true);
      return page;
    };
    try {
      let current = await attach(await attachToLaunchedDesktop(cdpPort));
      await current.waitForLoadState('domcontentloaded');
      await pinViewportToWindow(current);
      await waitForRuntimeReady(current);
      runtimeSidecarPid = await readRuntimeSidecarPid(current);

      // Speech recognition from the ASR page, then the structuring model.
      await navigateTo(current, 'nav-asr', 'page-asr');
      await installSpeechRecognition(current);
      assertInstalledSpeechPack(sessionData, expectedSpeech.pack);
      await installStructuringModel(current, modelOptionId);
      await navigateTo(current, 'nav-asr', 'page-asr');
      await current.getByTestId('asr-choose-files').waitFor({ state: 'visible', timeout: 30_000 });
      // The file button is enabled while the requirements reload after the
      // installs (the first review captured 尚未就緒), so the compared screen
      // waits for the ready status too. One locator wait, not waitUntil: a
      // single probe slower than 5 s would fail that (#501).
      await current.locator('[data-testid="runtime-status"][data-state="ready"]')
        .waitFor({ state: 'attached', timeout: runtimeReadyTimeoutMs });
      await checkpoint(current, 'asr-ready');

      // The recording, captured to its end.
      const first = await chooseRecording(current, app.pid ?? 0, cdpPort, recordingPath, recordingName, documentIds);
      current = await attach(first.attached);
      documentIds.push(first.documentId);
      await waitForRowStatus(asrRow(current, first.documentId), ['done'], recordingTimeoutMs);
      const outcome = readRecordingOutcome(
        await readDurableLibraryDetail(current, first.documentId),
        expectedSpeech,
        { structuringDevice },
      );
      provenance = { engine: outcome.extraction.engine, model: outcome.extraction.model, device: outcome.extraction.device };
      await checkpoint(current, 'asr-done-row');

      await asrRow(current, first.documentId).getByTestId('asr-row-view').click();
      await current.getByTestId('result-asr-content').waitFor({ state: 'visible', timeout: 30_000 });
      await current.getByTestId('result-transcript-row').first().waitFor({ state: 'visible', timeout: 30_000 });
      await checkpoint(current, 'asr-result');
      const shown = await readDiagnosticsExtractionProvenance(current, first.documentId);
      assert.ok(isDeepStrictEqual(shown, outcome.extraction), 'Settings › Diagnostics did not show the stored speech provenance.');

      // The same recording again: Cancel while it runs, then Start again.
      await navigateTo(current, 'nav-asr', 'page-asr');
      const second = await chooseRecording(current, app.pid ?? 0, cdpPort, recordingPath, recordingName, documentIds);
      current = await attach(second.attached);
      documentIds.push(second.documentId);
      const secondRow = asrRow(current, second.documentId);
      await waitForRowStatus(secondRow, ['processing'], recordingTimeoutMs);
      await watchRowStatus(current, second.documentId);
      await secondRow.getByTestId('asr-row-cancel').click();
      await waitForRowStatus(secondRow, ['cancelled'], cancelTimeoutMs);
      assertCancelSequence(await readWatchedRowStatus(current));
      await secondRow.getByTestId('asr-row-restart').waitFor({ state: 'visible', timeout: 15_000 });
      const cancelledDetail = await readDurableLibraryDetail(current, second.documentId);
      assert.equal(cancelledDetail.status, 'canceled', 'The cancelled recording was not stored cancelled.');
      assert.ok((cancelledDetail.raw ?? null) === null, 'The cancelled recording kept raw text.');
      await checkpoint(current, 'asr-cancelled-row');
      await secondRow.getByTestId('asr-row-restart').click();
      await waitUntil(
        async () => (await secondRow.getAttribute('data-user-status')) !== 'cancelled' || undefined,
        30_000,
        'Start again did not start the cancelled recording.',
      );
      await waitForRowStatus(secondRow, ['done'], recordingTimeoutMs);
      readRecordingOutcome(await readDurableLibraryDetail(current, second.documentId), expectedSpeech, { structuringDevice });
      await checkpoint(current, 'asr-restarted-row');

      await removeSpeechRecognition(current);
      await checkpoint(current, 'engine-removed');

      for (const documentId of documentIds) {
        assert.equal(
          await deleteCompletedDocument(current, recordingName, documentId, ['done']),
          true,
          'A recording of the journey was not deleted in History.',
        );
      }
      status = 'completed';
    } catch (error) {
      failure = error;
    } finally {
      if (page) {
        for (const documentId of documentIds) {
          await deleteCompletedDocument(page, recordingName, documentId, ['done', 'needs-attention', 'cancelled'])
            .catch(() => process.stderr.write('Packaged ASR journey cleanup warning.\n'));
        }
      }
      const keepRunData = process.env.E2E_ACCEPTANCE_KEEP_APP_DATA === '1';
      sessionCleanup = await finishOwnedDesktopSession({
        page,
        app,
        teardownMode,
        runtimeSidecarPid,
        sidecarObserved: runtimeSidecarPid !== undefined && isProcessAlive(runtimeSidecarPid),
        browserClients,
        cdpPort,
        webViewData: sessionWebViewData,
        workerMirror: sessionMirror,
        // Keeping the run's data is a diagnostic: its cleanup stays unproven.
        removeRunData: async () => keepRunData ? false : removeRunDataRoot(sessionData),
        report: (message) => process.stderr.write(`${message}\n`),
      });
    }
  } catch (error) {
    failure ??= error;
  } finally {
    const appClosed = launchedApp !== undefined && await closeOwnedDesktopRoot(launchedApp);
    if (launchedApp && !appClosed) {
      process.stderr.write('Exact packaged-app root close remained unproven after the outer retry.\n');
    }
    if (!sessionCleanup) {
      await mirror?.close().catch(() => undefined);
      if (webViewData) await rm(webViewData, { recursive: true, force: true }).catch(() => undefined);
      if (cdpPort) await waitForPortClosed(cdpPort).catch(() => undefined);
      // A run that failed before its session started still leaves nothing behind.
      if (runData && process.env.E2E_ACCEPTANCE_KEEP_APP_DATA !== '1') {
        await removeRunDataRoot(runData).catch(() => false);
      }
    }
    const cleanup = {
      app: appClosed && sessionCleanup?.app === true,
      sidecar: sessionCleanup?.sidecar === true,
      cdpPort: sessionCleanup?.cdpPort === true,
      runData: sessionCleanup?.runData === true,
      workerMirror: sessionCleanup?.workerMirrorReleased === true && mirror !== undefined && mirror.requests > 0,
    };
    const comparisons = options.comparison?.outcomes ?? [];
    const verdict = packagedJourneyVerdict(status, comparedCheckpointNames(ASR_JOURNEY_CHECKPOINTS), comparisons, cleanup);
    await writePackagedJourneyEvidence(journeyRun.artifactRoot, {
      evidenceKind: 'packaged-real-engine-journey',
      journey: 'asr',
      mode: journeyRun.mode,
      runId: journeyRun.runId,
      status: verdict,
      runtimeSha256,
      ...(candidateId === undefined ? {} : { candidateId }),
      sourceSha256: recordingSha256,
      screenshots: screenshots.map((path) => checkpointNameOf(journeyRun.artifactRoot, path)),
      comparisons,
      ...(provenance === undefined ? {} : { provenance }),
      cleanup,
    });
    if (verdict === 'failed' && failure === undefined) {
      failure = new Error('The packaged ASR journey did not prove all screenshot comparisons and cleanup.');
    }
  }
  if (failure !== undefined) throw failure;
  process.stdout.write('Packaged ASR journey completed.\n');
}

function asrRow(page: Page, documentId: string): Locator {
  return page.locator(`[data-testid="asr-queue-row"][data-document-id="${documentId}"]`);
}

async function navigateTo(page: Page, navTestId: string, pageTestId: string): Promise<void> {
  if (!(await page.getByTestId(pageTestId).isVisible().catch(() => false))) {
    await page.getByTestId(navTestId).click();
    await page.getByTestId(pageTestId).waitFor({ state: 'visible', timeout: 30_000 });
  }
}

async function waitForRuntimeReady(page: Page): Promise<void> {
  await waitUntil(
    async () => {
      const runtimeError = await visibleRuntimeError(page);
      if (runtimeError) throw new Error(runtimeError);
      const state = await page.getByTestId('runtime-status').getAttribute('data-state').catch(() => null);
      return state === 'ready' || undefined;
    },
    runtimeReadyTimeoutMs,
    'Capture Workbench runtime did not reach ready state.',
  );
}

/** Installs speech recognition from its card on the ASR page, retrying one transient failure. */
async function installSpeechRecognition(page: Page): Promise<void> {
  const card = page.locator('[data-testid="asr-install-panel"] [data-testid="engine-card"][data-requirement-id="speech-recognition"]');
  await card.waitFor({ state: 'visible', timeout: 30_000 });
  const install = card.getByTestId('engine-card-install');
  await waitUntil(
    () => install.isEnabled().then((enabled) => enabled || undefined),
    30_000,
    'The ASR page did not offer to install speech recognition.',
  );
  await install.click();
  let retried = false;
  await waitUntil(
    async () => {
      const runtimeError = await visibleRuntimeError(page);
      if (runtimeError) throw new Error(runtimeError);
      const readStarted = Date.now();
      const speechStatus = await readRequirementStatus(page, 'speech-recognition');
      const readMs = Date.now() - readStarted;
      if (readMs > slowProbeMs) {
        process.stdout.write(`Slow requirements read during the speech install: ${readMs} ms (status ${speechStatus ?? 'none'}).\n`);
      }
      if (speechStatus === 'ready'
        && (await page.getByTestId('asr-choose-files').isVisible().catch(() => false))) {
        return true;
      }
      const installation = await readLatestInstallation(page, 'speech-recognition').catch(() => undefined);
      if (installation?.status !== 'failed' && installation?.status !== 'cancelled') return undefined;
      const errorCode = installation.errorCode && safeErrorCodePattern.test(installation.errorCode)
        ? installation.errorCode
        : 'unknown';
      if (installation.status === 'failed' && retriedInstallationCodes.has(errorCode) && !retried) {
        retried = true;
        const retry = card.getByTestId('engine-card-retry');
        await waitUntil(
          () => retry.isEnabled().then((enabled) => enabled || undefined),
          10_000,
          'The ASR page did not offer to retry the speech recognition installation.',
        );
        await retry.click();
        return undefined;
      }
      throw new Error(`Speech recognition installation ended status=${installation.status}; errorCode=${errorCode}.`);
    },
    speechInstallTimeoutMs,
    'Speech recognition installation did not finish.',
    speechInstallProbeBudgetMs,
  );
}

/** The pack the runtime installed, as it records it under app data. */
function assertInstalledSpeechPack(runData: RunDataRoot, expected: 'cuda' | 'cpu'): void {
  const activePath = join(runData.appData, 'runtime', 'engines', 'speech-recognition', 'active.json');
  let contentId: unknown;
  try {
    contentId = (JSON.parse(readFileSync(activePath, 'utf8')) as { readonly contentId?: unknown }).contentId;
  } catch {
    contentId = undefined;
  }
  assert.equal(contentId, expected, 'The runtime did not install the speech pack this machine needs.');
}

/** Selects and installs the structuring model on Settings › Diagnostics, unless it is already active. */
async function installStructuringModel(page: Page, optionId: string): Promise<void> {
  await navigateTo(page, 'nav-settings', 'page-settings');
  await page.getByTestId('settings-nav-diagnostics').click();
  await page.getByTestId('page-settings-diagnostics').waitFor({ state: 'visible', timeout: 30_000 });
  const option = page.locator(`[data-testid="diagnostics-model-option"][data-model-option-id="${optionId}"]`);
  await option.waitFor({ state: 'visible', timeout: 60_000 });
  if ((await option.getAttribute('data-status')) === 'active') return;
  await option.check();
  const install = page.getByTestId('diagnostics-model-install');
  await waitUntil(
    () => install.isEnabled().then((enabled) => enabled || undefined),
    30_000,
    'Settings › Diagnostics did not offer to install the structuring model.',
  );
  await install.click();
  await waitUntil(
    async () => {
      const runtimeError = await visibleRuntimeError(page);
      if (runtimeError) throw new Error(runtimeError);
      const progress = page.getByTestId('diagnostics-model-progress');
      const progressStatus = (await progress.count()) > 0 ? await progress.getAttribute('data-status') : null;
      if (progressStatus === 'failed' || progressStatus === 'cancelled') {
        throw new Error(`The structuring model installation ended status=${progressStatus}.`);
      }
      return (await option.getAttribute('data-status')) === 'active' || undefined;
    },
    structuringModelInstallTimeoutMs,
    'The structuring model installation did not finish.',
  );
}

/**
 * Chooses the recording with the native picker from the ASR page and returns
 * the new document. The picker owns the native input boundary while it is
 * open, so the page is attached again afterwards.
 */
async function chooseRecording(
  page: Page,
  appPid: number,
  cdpPort: number,
  recordingPath: string,
  recordingName: string,
  knownDocumentIds: readonly string[],
): Promise<{ readonly attached: { readonly browser: CdpBrowser; readonly page: Page }; readonly documentId: string }> {
  const chooser = page.getByTestId('asr-choose-files');
  await chooser.waitFor({ state: 'visible', timeout: 30_000 });
  await nativeOpenDialogUiAutomation(recordingPath, appPid, () => nativeClickWebViewElement(chooser, appPid));
  const attached = await reattachToPackagedPage(cdpPort);
  const known = new Set(knownDocumentIds);
  const documentId = await waitUntil(
    async () => {
      const result = await invokeTauriCommand(attached.page, 'library_list', { request: { query: '', status: '' } });
      const matches = (Array.isArray(result) ? result : [])
        .filter((record): record is { readonly fileName?: unknown; readonly documentId?: unknown } => (
          record !== null && typeof record === 'object' && !Array.isArray(record)
        ))
        .filter((record) => record.fileName === recordingName
          && typeof record.documentId === 'string'
          && !known.has(record.documentId));
      if (matches.length > 1) throw new Error('One pick imported the recording more than once.');
      return typeof matches[0]?.documentId === 'string' ? matches[0].documentId : undefined;
    },
    30_000,
    'The native picker closed without importing the recording.',
  );
  await asrRow(attached.page, documentId).waitFor({ state: 'visible', timeout: 60_000 });
  return { attached, documentId };
}

async function waitForRowStatus(row: Locator, statuses: readonly string[], timeoutMs: number): Promise<string> {
  return waitUntil(
    async () => {
      const status = await row.getAttribute('data-user-status');
      if (status !== null && statuses.includes(status)) return status;
      // A row that ended otherwise never reaches the awaited state; a recording
      // done before it could be cancelled needs a longer excerpt.
      if (status === 'needs-attention' || status === 'cancelled' || status === 'done') {
        throw new Error(`The recording ended ${status} while the journey waited for ${statuses.join(' or ')}.`);
      }
      return undefined;
    },
    timeoutMs,
    `The recording did not reach ${statuses.join(' or ')}.`,
  );
}

/** Records every status and chip text one ASR row shows, however briefly. */
async function watchRowStatus(page: Page, documentId: string): Promise<void> {
  await page.evaluate(({ id, key }) => {
    const seen: Array<{ status: string; text: string }> = [];
    (globalThis as unknown as Record<string, unknown>)[key] = seen;
    const read = (): void => {
      const row = document.querySelector(`[data-testid="asr-queue-row"][data-document-id="${id}"]`);
      const status = row?.getAttribute('data-user-status') ?? '';
      const text = row?.querySelector('[data-testid="asr-row-chip"]')?.textContent?.trim() ?? '';
      const last = seen[seen.length - 1];
      if (last?.status !== status || last.text !== text) seen.push({ status, text });
    };
    read();
    new MutationObserver(read).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-user-status'],
    });
  }, { id: documentId, key: rowStatusWatchKey });
}

async function readWatchedRowStatus(page: Page): Promise<readonly RowStatusObservation[]> {
  return page.evaluate((key) => {
    const seen = (globalThis as unknown as Record<string, unknown>)[key];
    return Array.isArray(seen) ? seen as Array<{ status: string; text: string }> : [];
  }, rowStatusWatchKey);
}

/** The extraction provenance Settings › Diagnostics shows for one document, reached from its result. */
async function readDiagnosticsExtractionProvenance(
  page: Page,
  documentId: string,
): Promise<RecordingOutcome['extraction']> {
  await page.getByTestId('result-nav-details').click();
  const diagnosticsLink = page.getByTestId('result-detail-diagnostics');
  await diagnosticsLink.waitFor({ state: 'visible', timeout: 30_000 });
  await diagnosticsLink.click();
  await page.getByTestId('page-settings-diagnostics').waitFor({ state: 'visible', timeout: 30_000 });
  const documentSection = page.getByTestId('diagnostics-document');
  await documentSection.waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal(
    await documentSection.getAttribute('data-document-id'),
    documentId,
    'Settings › Diagnostics did not show the recording.',
  );
  const element = page.getByTestId('diagnostics-extraction-provenance');
  await element.waitFor({ state: 'visible', timeout: 30_000 });
  return {
    engine: (await element.getAttribute('data-engine'))?.trim() ?? '',
    model: (await element.getAttribute('data-model'))?.trim() ?? '',
    device: (await element.getAttribute('data-device'))?.trim() ?? '',
    digest: (await element.getAttribute('data-digest'))?.trim() ?? '',
  };
}

/** Removes speech recognition on Settings › Engines and waits until it can be installed again. */
async function removeSpeechRecognition(page: Page): Promise<void> {
  await navigateTo(page, 'nav-settings', 'page-settings');
  await page.getByTestId('settings-nav-engines').click();
  await page.getByTestId('page-settings-engines').waitFor({ state: 'visible', timeout: 30_000 });
  const row = page.locator('[data-testid="engine-row"][data-requirement-id="speech-recognition"]');
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  const remove = row.getByTestId('engine-row-remove');
  await waitUntil(
    () => remove.isEnabled().then((enabled) => enabled || undefined),
    60_000,
    'Settings › Engines did not offer to remove speech recognition.',
  );
  await remove.click();
  await page.getByTestId('engine-remove-dialog').waitFor({ state: 'visible', timeout: 15_000 });
  await page.getByTestId('engine-remove-confirm').click();
  await waitUntil(
    async () => {
      const removeError = await row.getByTestId('engine-row-remove-error').isVisible();
      if (removeError) throw new Error('Settings › Engines could not remove speech recognition.');
      return (await row.getAttribute('data-status')) === 'installable'
        && (await readRequirementStatus(page, 'speech-recognition')) === 'installable'
        ? true
        : undefined;
    },
    engineRemovalTimeoutMs,
    'Speech recognition was not removed.',
  );
  await page.getByTestId('engine-remove-dialog').waitFor({ state: 'hidden', timeout: 15_000 });
}

function jsonRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function requiredPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set for the packaged ASR journey.`);
  return resolve(value);
}

function requiredDigest(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${name} must be a 64-character lowercase SHA-256 digest.`);
  }
  return value;
}

async function requireRegularFile(path: string, name: string): Promise<void> {
  const metadata = await stat(path).catch(() => undefined);
  if (!metadata?.isFile()) throw new Error(`${name} must be an existing regular file.`);
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', () => reject(new Error('The recording could not be read.')));
    stream.once('end', () => resolveDigest(hash.digest('hex')));
  });
}
