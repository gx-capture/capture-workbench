import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { appendFileSync, createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium, type Page } from '@playwright/test';

// eslint-disable-next-line @nx/enforce-module-boundaries -- acceptance artifacts are a workspace-level test contract.
import {
  assertWebmArtifact,
  createAcceptanceRun,
  writeAcceptanceManifest,
  type AcceptanceRun,
} from '../../../tools/acceptance-contract.ts';
import { assertStagedRuntime } from './assert-staged-runtime.ts';
import {
  nativeClickWebViewElement,
  nativeOpenDialogUiAutomation,
} from './installed-browser.ts';
import { assertRedactedEvidence } from './package-qa.ts';
import {
  assertRealOcrResult,
  loadRealOcrExpectation,
  type RealOcrLocator,
  type RealOcrUiBlock,
  type RealOcrUiResult,
  type RealOcrUiSegment,
} from './real-ocr-result-assertions.ts';
import { appRoot } from './stage-runtime.ts';

const workspaceRoot = resolve(appRoot, '..', '..');
const outputDirectory = join(workspaceRoot, 'tmp', 'capture-workbench-desktop', 'real-desktop-ocr-smoke');
const evidencePath = join(outputDirectory, 'real-desktop-ocr-smoke.json');
const defaultDesktopExecutable = join(
  appRoot,
  'src-tauri',
  'target',
  'x86_64-pc-windows-msvc',
  'release',
  'capture-workbench-desktop.exe',
);
const productIdentifier = 'io.github.gx-capture.capture-workbench';
const maxSourceBytes = 50 * 1024 * 1024;
const acceptanceOcrWorkerArchive = join(
  workspaceRoot,
  'packages',
  'capture-runtime',
  'dist',
  'release',
  'capture-engine-ocr-0.4.1-windows-x64.zip',
);
const ownedSmokeDocumentPattern =
  /^standalone-real-ocr-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/iu;

function acceptanceStage(stage: string): void {
  if (process.env.E2E_ACCEPTANCE_DIAGNOSTICS === '1') {
    const line = `acceptance-stage=${stage}\n`;
    process.stderr.write(line);
    try {
      appendFileSync(
        join(process.env.E2E_ARTIFACT_ROOT || outputDirectory, 'acceptance-stage.log'),
        line,
        'utf8',
      );
    } catch {
      // The stage log is diagnostic-only; acceptance truth remains in the manifest.
    }
  }
}

export const realDesktopRuntimeReadyTimeoutMs = 3 * 60_000;
/** Dependency downloads and first-run engine probes are allowed a longer budget than readiness polling. */
export const realDesktopDependencyInstallTimeoutMs = 15 * 60_000;
type OcrDevice = 'windowsml-dml' | 'cpu';
type SourceKind = 'pdf' | 'image' | 'audio' | 'unknown';
type CdpBrowser = Awaited<ReturnType<typeof chromium.connectOverCDP>>;

interface RealDesktopSmokeEvidence {
  readonly evidenceKind: 'real-standalone-tauri-ui-ocr';
  readonly releaseGateSatisfied: true;
  readonly realEnginesExercised: true;
  readonly sourceKind: SourceKind;
  readonly rawOcrVisible: true;
  readonly ocrResultVerified: true;
  readonly rawOcrSegmentCount: number;
  readonly structuredBlockCount: number;
  readonly expectedAnchorCount: number;
  readonly matchedAnchorCount: number;
  readonly ocrDevice: OcrDevice;
  readonly structuringEngine: 'ollama';
  readonly model: string;
  readonly documentDeletedAfterVerification: true;
}

interface AcceptanceWorkerMirror {
  readonly baseUrl: string;
  readonly requests: number;
  close(): Promise<void>;
}

export function assertRealDesktopSmokeEvidence(value: unknown): asserts value is RealDesktopSmokeEvidence {
  const report = value as Partial<RealDesktopSmokeEvidence> | undefined;
  assert.equal(report?.evidenceKind, 'real-standalone-tauri-ui-ocr');
  assert.equal(report?.releaseGateSatisfied, true);
  assert.equal(report?.realEnginesExercised, true);
  assert.ok(report?.sourceKind === 'pdf' || report?.sourceKind === 'image' || report?.sourceKind === 'audio' || report?.sourceKind === 'unknown');
  assert.equal(report?.rawOcrVisible, true);
  assert.equal(report?.ocrResultVerified, true);
  assert.ok(Number.isInteger(report?.rawOcrSegmentCount) && Number(report?.rawOcrSegmentCount) > 0);
  assert.equal(report?.structuredBlockCount, report?.rawOcrSegmentCount);
  assert.ok(Number.isInteger(report?.expectedAnchorCount) && Number(report?.expectedAnchorCount) > 0);
  assert.equal(report?.matchedAnchorCount, report?.expectedAnchorCount);
  assert.ok(report?.ocrDevice === 'windowsml-dml' || report?.ocrDevice === 'cpu');
  assert.equal(report?.structuringEngine, 'ollama');
  assert.match(report?.model ?? '', /^capture-workbench-qwen3\.5-(?:0\.8b|2b|4b)-structure-v1$/u);
  assert.equal(report?.documentDeletedAfterVerification, true);

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /[A-Za-z]:[\\/]/u);
  assertRedactedEvidence(report);
}

export async function main(options: {
  readonly checkpoint?: (page: Page, name: string) => Promise<void>;
} = {}): Promise<void> {
  const acceptance: AcceptanceRun | undefined = process.env.E2E_ACCEPTANCE_RUN_ID
    ? createAcceptanceRun(process.env, 'capture-workbench', workspaceRoot)
    : undefined;
  const acceptanceScreenshots: string[] = [];
  const acceptanceErrors: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let acceptanceStatus: 'completed' | 'failed' = 'failed';
  let acceptanceArtifactFailure: Error | undefined;
  let videoPath: string | undefined;
  let videoStarted = false;
  let appCleaned = false;
  let sidecarCleaned = false;
  let sidecarObserved = false;
  let cdpPortClosed = false;
  let temporaryAppDataCleaned = true;
  let workerMirror: AcceptanceWorkerMirror | undefined;
  let workerDownloadRequired = false;
  let runtimeSidecarPid: number | undefined;

  const observeOwnedSidecar = (): void => {
    if (!acceptance || sidecarObserved) return;
    const children = descendantProcessRecords(app?.pid);
    sidecarObserved = children?.some(isCaptureSidecarProcess) === true;
  };

  const observeOwnedSidecarFromExecutableSignal = async (runtimePage: Page): Promise<void> => {
    if (!acceptance || sidecarObserved) return;
    const probe = await invokeTauriCommand(runtimePage, 'desktop_runtime_process_probe', {});
    if (probe === null || typeof probe !== 'object' || Array.isArray(probe)) return;
    const processId = (probe as { processId?: unknown }).processId;
    if (!Number.isSafeInteger(processId) || Number(processId) <= 0) return;
    runtimeSidecarPid = Number(processId);
    sidecarObserved = isProcessAlive(runtimeSidecarPid);
  };

  if (process.platform !== 'win32') {
    throw new Error('Real standalone desktop OCR smoke requires Windows x64.');
  }

  const expectedOcrDevice = resolveExpectedOcrDevice(
    process.argv.slice(2),
    process.env.CAPTURE_REAL_DESKTOP_EXPECTED_OCR_DEVICE,
  );
  const sourceVariable = process.env.CAPTURE_REAL_DESKTOP_OCR_INPUT?.trim()
    ? 'CAPTURE_REAL_DESKTOP_OCR_INPUT'
    : 'CAPTURE_REAL_DESKTOP_OCR_PDF';
  const sourcePath = requiredPath(sourceVariable);
  const sourceFixtureName = basename(sourcePath);
  const sourceKind = resolveSourceKind(sourcePath);
  const appData = acceptance
    ? resolve(acceptance.artifactRoot, 'app-data')
    : requiredPath('CAPTURE_REAL_DESKTOP_APP_DATA');
  const desktopExecutable = resolve(
    process.env.CAPTURE_REAL_DESKTOP_EXECUTABLE?.trim() || defaultDesktopExecutable,
  );
  await requireRegularFile(sourcePath, sourceVariable);
  if (acceptance) {
    await mkdir(appData, { recursive: true });
  } else {
    await requireDirectory(appData, 'CAPTURE_REAL_DESKTOP_APP_DATA');
  }
  await requireRegularFile(desktopExecutable, 'CAPTURE_REAL_DESKTOP_EXECUTABLE');
  assertConfiguredHostAppData(appData, acceptance);

  const sourceBytes = await readFile(sourcePath);
  if (sourceBytes.length === 0 || sourceBytes.length > maxSourceBytes) {
    throw new Error(`${sourceVariable} must contain 1 through ${maxSourceBytes} bytes.`);
  }
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const ocrExpectation = await loadRealOcrExpectation(sourcePath);

  await observe(assertStagedRuntime('release'));
  await mkdir(outputDirectory, { recursive: true });
  if (acceptance) {
    await mkdir(acceptance.artifactRoot, { recursive: true });
  }

  const cdpPort = await reservePort();
  if (acceptance) {
    workerMirror = await startAcceptanceWorkerMirror();
  }
  const runId = randomUUID();
  const webViewData = join(outputDirectory, `webview2-${runId}`);
  const sourceName = `standalone-real-ocr-${runId}${extname(sourcePath) || '.bin'}`;
  const pickerFixturePath = join(outputDirectory, sourceName);
  await writeFile(pickerFixturePath, sourceBytes);
  const app = spawn(desktopExecutable, [], {
    cwd: resolve(desktopExecutable, '..'),
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: webViewData,
      ...(acceptance ? {
        APPDATA: resolve(acceptance.artifactRoot, 'app-data'),
        LOCALAPPDATA: resolve(acceptance.artifactRoot, 'local-app-data'),
        CAPTURE_REAL_DESKTOP_APP_DATA: appData,
        CAPTURE_ACCEPTANCE_APP_DATA_ROOT: appData,
        CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN: '1',
        CAPTURE_SMOKE_WORKER_MIRROR_URL: workerMirror?.baseUrl ?? '',
      } : {}),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort} --remote-allow-origins=*`,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  observeOwnedSidecar();

  let browser: CdpBrowser | undefined;
  const browserClients: CdpBrowser[] = [];
  let page: Page | undefined;
  try {
    browser = await waitUntil(
      () => chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 1_500 }).catch(() => undefined),
      60_000,
      'Standalone desktop WebView2 CDP was not ready.',
    );
    browserClients.push(browser);
    page = await waitUntil(
      () => Promise.resolve(
        browser.contexts().flatMap((context) => context.pages())
          .find((candidate) => candidate.url() === 'http://tauri.localhost/'),
      ),
      30_000,
      'Standalone desktop application page was unavailable.',
    );
    await page.waitForLoadState('domcontentloaded');
    await page.setViewportSize({ width: 1440, height: 900 });
    if (acceptance) {
      await page.addStyleTag({
        content: `
          .review-block pre,
          .provenance dd,
          [data-testid="document-result-block-source"],
          [data-testid="document-result-block-target"] {
            color: transparent !important;
            text-shadow: none !important;
          }
        `,
      });
    }
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    if (acceptance?.recordVideo) {
      videoPath = join(acceptance.artifactRoot, 'capture-workbench-golden-journey.webm');
      await page.screencast.start({
        path: videoPath,
        size: { width: 1440, height: 900 },
      });
      videoStarted = true;
    }

    const setup = page.getByTestId('runtime-setup');
    const intake = page.getByTestId('source-import');
    const initialState = await waitUntil<'ready' | 'setup'>(
      async () => {
        const runtimeError = await visibleRuntimeError(page);
        if (runtimeError) throw new Error(runtimeError);
        if (await intake.isEnabled()) return 'ready';
        if (await setup.isVisible()) return 'setup';
        return undefined;
      },
      realDesktopRuntimeReadyTimeoutMs,
      'Capture Workbench did not reach ready or needs-setup UI state.',
    );
    if (initialState === 'setup') {
      await acceptanceScreenshot(page, acceptance, acceptanceScreenshots, '01-consent-required', options.checkpoint);
      const install = setup.getByTestId('runtime-install');
      if (await install.isVisible()) {
        if (!(await install.isEnabled())) {
          throw new Error(`Capture Workbench core runtime consent button was unexpectedly disabled. ${await runtimeSetupDiagnostics(page)}`);
        }
        await install.click();
        observeOwnedSidecar();
        workerDownloadRequired = true;
        let coreInstallCompleted = false;
        await acceptanceScreenshot(page, acceptance, acceptanceScreenshots, '01-core-install-started', options.checkpoint);
        let filesystemRetryCount = 0;
        await waitUntil(
          async () => {
            const runtimeError = await visibleRuntimeError(page);
            if (runtimeError) throw new Error(runtimeError);
            const progress = page.getByTestId('runtime-install-progress');
            if (await progress.isVisible()) {
              const status = await progress.getAttribute('data-status');
              if (status === 'failed' || status === 'cancelled' || status === 'manual_action_required') {
                const detail = await progress.getByTestId('runtime-install-error').textContent().catch(() => undefined);
                if (status === 'failed' && detail?.trim().startsWith('installation_filesystem:') && filesystemRetryCount < 1) {
                  filesystemRetryCount += 1;
                  await waitUntil(
                    () => install.isEnabled().then((enabled) => enabled || undefined),
                    10_000,
                    'Capture Workbench did not re-enable core runtime consent after a filesystem failure.',
                  );
                  await install.click();
                  observeOwnedSidecar();
                  await acceptanceScreenshot(page, acceptance, acceptanceScreenshots, '01-core-install-retry', options.checkpoint);
                  return undefined;
                }
                throw new Error(`Capture Workbench core runtime installation ended ${status}: ${detail?.trim() || (await progress.textContent())?.trim() || 'no detail was rendered.'}`);
              }
              if (status === 'completed') {
                coreInstallCompleted = true;
                return true;
              }
            }
            if (filesystemRetryCount === 0) {
              const modelSelection = page.getByTestId('model-selection');
              const modelOption = modelSelection.locator('[data-testid="model-option"]').first();
              if (await modelSelection.isVisible() && await modelOption.isEnabled()) return true;
            }
            const runtimeState = await page.getByTestId('workbench-root').getAttribute('data-runtime-state').catch(() => undefined);
            const installVisible = await install.isVisible();
            if (coreInstallCompleted || (!installVisible && runtimeState === 'ready')) return true;
            if (runtimeState === 'error') {
              throw new Error(`Capture Workbench core runtime installation entered an error state. ${await runtimeSetupDiagnostics(page)}`);
            }
            if (filesystemRetryCount > 0) return undefined;
            return undefined;
          },
          realDesktopDependencyInstallTimeoutMs,
          `Capture Workbench core runtime installation did not reach model selection. ${await runtimeSetupDiagnostics(page)}`,
        );
      }
      const modelSelection = setup.getByTestId('model-selection');
      if (await modelSelection.isVisible()) {
        const option = modelSelection.locator('[data-testid="model-option"]').first();
        if (!(await option.count())) {
          throw new Error('Capture Workbench did not expose a selectable structuring model option.');
        }
        await option.check();
        if (!(await option.isChecked())) {
          throw new Error('Capture Workbench did not retain the selected structuring model option.');
        }
        const modelInstall = modelSelection.getByTestId('model-install');
        await waitUntil(
          () => modelInstall.isEnabled().then((enabled) => enabled || undefined),
          10_000,
          'Capture Workbench structuring model consent remained disabled after selecting an option.',
        );
        await modelInstall.click();
        observeOwnedSidecar();
        await waitUntil(
          () => waitForPackagedRuntimeReadySignal(cdpPort).then((ready) => ready || undefined),
          realDesktopDependencyInstallTimeoutMs,
          'Capture Workbench model installation did not publish a ready signal.',
        );
      }
    }
    try {
      await waitUntil(
        () => waitForPackagedRuntimeReadySignal(cdpPort).then((ready) => ready || undefined),
        realDesktopRuntimeReadyTimeoutMs,
        'Standalone desktop runtime did not publish a ready signal after the visible consent/install flow.',
      );
      const reattached = await reattachToPackagedPage(cdpPort);
      observeOwnedSidecar();
      browser = reattached.browser;
      browserClients.push(browser);
      page = reattached.page;
      await observeOwnedSidecarFromExecutableSignal(page);
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => pageErrors.push(error.message));
      if (acceptance) {
        await page.addStyleTag({
          content: `
            .review-block pre,
            .provenance dd,
            [data-testid="document-result-block-source"],
            [data-testid="document-result-block-target"] {
              color: transparent !important;
              text-shadow: none !important;
            }
          `,
        });
      }
    } catch (error) {
      const state = await queryPackagedUiState(cdpPort).then((value) => value?.runtimeState).catch(() => undefined);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} ` +
        `[runtime-state=${state ?? 'unknown'}]`,
        { cause: error },
      );
    }
    acceptanceStage('before-runtime-ready-screenshot');
    await acceptanceScreenshot(page, acceptance, acceptanceScreenshots, '01-runtime-ready', options.checkpoint);
    acceptanceStage('after-runtime-ready-screenshot');
    await acceptanceResponsiveLayout(page, acceptance);
    acceptanceStage('after-responsive-layout');
    await deleteCompletedOwnedSmokeDocuments(page);
    acceptanceStage('before-native-picker');
    await nativeOpenDialogUiAutomation(
      pickerFixturePath,
      app.pid ?? 0,
      () => nativeClickWebViewElement(intake, app.pid ?? 0),
    );
    observeOwnedSidecar();
    acceptanceStage('after-native-picker');
    // A Windows brokered picker temporarily owns the native input boundary.
    // The original Playwright CDP page can remain attached to the pre-picker
    // renderer state after that boundary closes, so reconnect to the live
    // packaged target and use the new page as the import acknowledgment.
    acceptanceStage('before-picker-page-reattach');
    const pickerReattached = await reattachToPackagedPage(cdpPort);
    browser = pickerReattached.browser;
    browserClients.push(browser);
    page = pickerReattached.page;
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    if (acceptance) {
      await page.addStyleTag({
        content: `
          .review-block pre,
          .provenance dd,
          [data-testid="document-result-block-source"],
          [data-testid="document-result-block-target"] {
            color: transparent !important;
            text-shadow: none !important;
          }
        `,
      });
    }
    acceptanceStage('after-picker-page-reattach');
    const libraryProbe = await waitUntil(async () => {
      const probe = await page.evaluate(async (expectedName) => {
        const internals = (globalThis as typeof globalThis & {
          __TAURI_INTERNALS__?: {
            invoke?: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
          };
        }).__TAURI_INTERNALS__;
        if (typeof internals?.invoke !== 'function') throw new Error('Packaged Tauri command bridge is unavailable after native picker.');
        const result = await internals.invoke('library_list', { request: { query: '', status: '' } });
        const records = Array.isArray(result) ? result : [];
        return {
          count: records.length,
          exact: records.some((record) => record && typeof record === 'object' && !Array.isArray(record)
            && (record as { fileName?: unknown }).fileName === expectedName),
        };
      }, sourceName);
      return probe.exact ? probe : undefined;
    }, 30_000, 'Native picker closed without an exact library import acknowledgement.');
    acceptanceStage(`after-picker-library-${libraryProbe.exact ? 'exact' : 'missing'}-count-${libraryProbe.count}`);
    const card = exactDocumentCard(page, sourceName);
    acceptanceStage('before-document-card-wait');
    await card.waitFor({ state: 'visible', timeout: 60_000 });
    acceptanceStage('after-document-card-wait');
    // Let the native picker close and the first durable processing state render
    // before asking WebView2 for a screenshot.
    await page.waitForTimeout(250);
    await acceptanceScreenshot(page, acceptance, acceptanceScreenshots, '02-document-processing', options.checkpoint);

    assert.equal(
      await card.count(),
      1,
      'Standalone desktop smoke filename must identify exactly one document.',
    );
    await waitUntil(
      () => card.locator('.status').textContent().then((status) => status?.trim() === '已完成' || undefined),
      10 * 60_000,
      'Standalone desktop OCR did not reach completion.',
    );
    await card.click();

    const raw = page.locator('.review-block').filter({ hasText: 'OCR 原始結果' }).locator('pre');
    const result = page.locator('.review-block.result pre');
    await raw.waitFor({ state: 'visible', timeout: 30_000 });
    await result.waitFor({ state: 'visible', timeout: 30_000 });
    const [rawText, resultText, provenance] = await Promise.all([
      raw.textContent(),
      result.textContent(),
      page.locator('.provenance dd').allTextContents(),
    ]);
    if (!rawText?.trim()) {
      throw new Error('Standalone desktop UI did not display OCR raw text.');
    }
    if (!resultText?.trim()) {
      throw new Error('Standalone desktop UI did not display structured result text.');
    }
    const uiResult: RealOcrUiResult = {
      rawText,
      rawSegments: await collectVisibleOcrSegments(page),
      structuredText: resultText,
      structuredBlocks: await collectVisibleStructuredBlocks(page),
    };
    const ocrVerification = assertRealOcrResult(
      uiResult,
      ocrExpectation,
      sourceFixtureName,
    );
    const structured = await readStructuredProvenance(page, provenance);
    const ocr = parseOcrProvenance(provenance);
    assertExpectedOcrDevice(ocr.device, expectedOcrDevice);
    if (
      structured.engine !== 'ollama' ||
      !/^capture-workbench-qwen3\.5-(?:0\.8b|2b|4b)-structure-v1$/u.test(structured.model) ||
      !structured.visibleText.includes(structured.model)
    ) {
      throw new Error('Standalone desktop UI did not display isolated Ollama provenance.');
    }
    await acceptanceScreenshot(page, acceptance, acceptanceScreenshots, '03-successful-result', options.checkpoint);

    if (!(await deleteCompletedDocument(page, sourceName))) {
      throw new Error('Standalone desktop smoke document was not deleted after verification.');
    }

    const report: RealDesktopSmokeEvidence = {
      evidenceKind: 'real-standalone-tauri-ui-ocr',
      releaseGateSatisfied: true,
      realEnginesExercised: true,
      sourceKind,
      rawOcrVisible: true,
      ocrResultVerified: true,
      rawOcrSegmentCount: ocrVerification.rawSegmentCount,
      structuredBlockCount: ocrVerification.structuredBlockCount,
      expectedAnchorCount: ocrVerification.expectedAnchorCount,
      matchedAnchorCount: ocrVerification.matchedAnchorCount,
      ocrDevice: ocr.device,
      structuringEngine: 'ollama',
      model: structured.model,
      documentDeletedAfterVerification: true,
    };
    assertRealDesktopSmokeEvidence(report);
    await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await acceptanceScreenshot(page, acceptance, acceptanceScreenshots, '04-review-complete', options.checkpoint);
    acceptanceStatus = 'completed';
    process.stdout.write(`Real standalone desktop OCR smoke report: ${evidencePath}\n`);
  } catch (error) {
    acceptanceErrors.push(error instanceof Error ? error.stack || error.message : String(error));
    throw error;
  } finally {
    if (page) {
      await deleteCompletedDocument(page, sourceName).catch((error: unknown) => {
        process.stderr.write(
          `Standalone desktop smoke cleanup warning: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      });
    }
    if (videoStarted && page) {
      await page.screencast.stop().catch((error: unknown) => {
        acceptanceErrors.push(`video stop failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    if (acceptance && videoPath && videoStarted) {
      try {
        await assertWebmArtifact(videoPath);
      } catch (error) {
        acceptanceErrors.push(error instanceof Error ? error.message : String(error));
        acceptanceStatus = 'failed';
      }
    }
    // This is an already-running packaged executable attached through CDP.
    // First terminate the owned executable, then close the Playwright
    // transport with a bounded budget. Closing a dead executable is safe, and
    // the bound prevents a native picker from blocking cleanup forever.
    const ownedChildren = descendantProcessRecords(app.pid);
    const ownedSidecars = ownedChildren?.filter(isCaptureSidecarProcess) ?? [];
    sidecarObserved = sidecarObserved || (ownedChildren !== undefined && ownedSidecars.length > 0);
    const ownedProcessIds = app.pid
      ? [app.pid, ...(ownedChildren ?? []).map((process_) => process_.pid), ...(runtimeSidecarPid ? [runtimeSidecarPid] : [])]
      : undefined;
    terminateOwnedTree(app.pid);
    await waitForOwnedTreeGone(app.pid, runtimeSidecarPid);
    for (const browserClient of [...browserClients].reverse()) {
      await withTimeout(browserClient.close(), 5_000, 'Playwright CDP disconnect timed out.').catch(() => undefined);
    }
    browser = undefined;
    // WebView2 can keep the packaged host alive until the CDP transport has
    // detached. Re-issue the exact owned-tree termination after that boundary,
    // then settle before taking the final liveness evidence.
    if (app.pid !== undefined && isProcessAlive(app.pid)) {
      terminateOwnedTree(app.pid);
    }
    if (runtimeSidecarPid !== undefined && isProcessAlive(runtimeSidecarPid)) {
      terminateOwnedTree(runtimeSidecarPid);
    }
    await waitForOwnedTreeGone(app.pid, runtimeSidecarPid);
    const rootProcessDead = app.pid === undefined || !isProcessAlive(app.pid);
    const ownedProcessesDead = ownedProcessIds !== undefined &&
      ownedProcessIds.every((pid) => !isProcessAlive(pid));
    appCleaned = rootProcessDead && ownedProcessesDead;
    const runtimeSidecarCleaned = runtimeSidecarPid !== undefined
      ? !isProcessAlive(runtimeSidecarPid)
      : sidecarObserved && rootProcessDead && ownedSidecars.every((process_) => !isProcessAlive(process_.pid));
    sidecarCleaned = sidecarObserved && runtimeSidecarCleaned && ownedSidecars.every((process_) => !isProcessAlive(process_.pid));
    if (workerMirror) {
      await workerMirror.close().catch((error: unknown) => {
        acceptanceErrors.push(`acceptance worker mirror cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (workerMirror.requests === 0 && workerDownloadRequired) {
        acceptanceErrors.push('Acceptance worker mirror did not receive the real OCR worker download request.');
      }
    }
    if (acceptance && !sidecarCleaned) {
      acceptanceErrors.push(
        sidecarObserved
          ? `Capture Workbench owned sidecar processes were not fully cleaned (root-dead=${rootProcessDead}; owned-pids-dead=${ownedProcessesDead}; runtime-pid-present=${runtimeSidecarPid !== undefined}; runtime-pid-dead=${runtimeSidecarCleaned}; known-sidecars=${ownedSidecars.length}).`
          : 'Capture Workbench acceptance did not observe an owned Capture Runtime/Ollama sidecar process.',
      );
    }
    cdpPortClosed = await waitForPortClosed(cdpPort);
    await rm(webViewData, { recursive: true, force: true }).catch((error: unknown) => {
      temporaryAppDataCleaned = false;
      acceptanceErrors.push(`temporary WebView2 data cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    await rm(pickerFixturePath, { force: true }).catch(() => { temporaryAppDataCleaned = false; });
    if (acceptance) {
      if (process.env.E2E_ACCEPTANCE_KEEP_APP_DATA !== '1') {
        await rm(resolve(acceptance.artifactRoot, 'app-data'), { recursive: true, force: true }).catch(() => { temporaryAppDataCleaned = false; });
        await rm(resolve(acceptance.artifactRoot, 'local-app-data'), { recursive: true, force: true }).catch(() => { temporaryAppDataCleaned = false; });
        if (await stat(resolve(acceptance.artifactRoot, 'app-data')).then(() => true).catch(() => false)) temporaryAppDataCleaned = false;
      } else {
        temporaryAppDataCleaned = false;
      }
    }
    // Windows can finish the job-object/taskkill transition while the final
    // artifact cleanup is still running. Re-read the exact PIDs at the point
    // the manifest is written so the evidence describes the final state.
    await delay(250);
    const finalRootProcessDead = app.pid === undefined || !isProcessAlive(app.pid);
    const finalOwnedProcessesDead = ownedProcessIds !== undefined &&
      ownedProcessIds.every((pid) => !isProcessAlive(pid));
    appCleaned = finalRootProcessDead && finalOwnedProcessesDead;
    const finalRuntimeSidecarCleaned = runtimeSidecarPid !== undefined
      ? !isProcessAlive(runtimeSidecarPid)
      : sidecarObserved && finalRootProcessDead && ownedSidecars.every((process_) => !isProcessAlive(process_.pid));
    sidecarCleaned = sidecarObserved && finalRuntimeSidecarCleaned &&
      ownedSidecars.every((process_) => !isProcessAlive(process_.pid));
    if (acceptance) {
      const artifacts = [
        ...acceptanceScreenshots.map((path) => ({ path, kind: 'screenshot' as const })),
        ...(videoPath && videoStarted ? [{ path: videoPath, kind: 'video' as const }] : []),
      ];
      await writeAcceptanceManifest(acceptance.artifactRoot, {
        project: acceptance.project,
        runId: acceptance.runId,
        status: acceptanceErrors.length === 0 ? acceptanceStatus : 'failed',
        recordVideo: acceptance.recordVideo,
        artifacts,
        errors: acceptanceErrors,
        consoleErrors,
        pageErrors,
        cleanup: {
          app: appCleaned,
          sidecar: sidecarCleaned,
          cdpPort: cdpPortClosed,
          temporaryAppData: temporaryAppDataCleaned,
        },
        fixture: {
          name: sourceFixtureName,
          sha256: sourceSha256,
        },
      });
      if (acceptanceErrors.length > 0) {
        acceptanceArtifactFailure = new Error(
          `Capture Workbench acceptance artifact validation failed: ${acceptanceErrors.join('; ')}`,
        );
      }
    }
  }
  if (acceptanceArtifactFailure) throw acceptanceArtifactFailure;
}

async function acceptanceScreenshot(
  page: Page,
  acceptance: AcceptanceRun | undefined,
  screenshots: string[],
  name: string,
  checkpoint?: (page: Page, name: string) => Promise<void>,
): Promise<void> {
  if (!acceptance) return;
  const file = join(acceptance.artifactRoot, `${name}.png`);
  await page.screenshot({
    path: file,
    animations: 'disabled',
    fullPage: false,
    mask: acceptanceScreenshotMasks(page),
    maskColor: '#000000',
  });
  screenshots.push(file);
  await checkpoint?.(page, name);
}

async function acceptanceResponsiveLayout(
  page: Page,
  acceptance: AcceptanceRun | undefined,
): Promise<void> {
  if (!acceptance) return;
  // A packaged Tauri WebView is not a Playwright-owned browser context:
  // setViewportSize() emulates a CSS viewport and can block WebView2 instead
  // of resizing the native window. Keep the acceptance proof programmatic and
  // run responsive-window coverage in the dedicated browser E2E project.
  const layout = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  assert.ok(
    layout.documentWidth <= layout.viewportWidth && layout.bodyWidth <= layout.viewportWidth,
    `Packaged desktop viewport overflowed at ${layout.viewportWidth}px.`,
  );
}

function acceptanceScreenshotMasks(page: Page) {
  return [
    page.locator('time'),
    page.locator('.dynamic-id'),
    page.locator('.document-copy strong'),
    page.locator('.detail-heading h2'),
    page.locator('.review-block pre'),
    page.locator('.provenance dd'),
    page.locator('[data-testid="document-result-block-source"]'),
    page.locator('[data-testid="document-result-block-target"]'),
  ];
}

async function readStructuredProvenance(
  page: Page,
  provenance: readonly string[],
): Promise<{ engine: string; model: string; visibleText: string }> {
  const element = page.getByTestId('document-structuring-provenance');
  await element.waitFor({ state: 'visible', timeout: 30_000 });
  const [engine, model, visibleText] = await Promise.all([
    element.getAttribute('data-engine'),
    element.getAttribute('data-model'),
    element.textContent(),
  ]);
  const fallback = provenance.find((entry) => entry.trim().startsWith('ollama')) ?? '';
  return {
    engine: engine?.trim() || fallback.split(' · ')[0]?.trim() || '',
    model: model?.trim() || fallback.split(' · ')[1]?.trim() || '',
    visibleText: visibleText?.trim() || fallback.trim(),
  };
}

export function parseOcrProvenance(
  provenance: readonly string[],
): {
  engine: 'windowsml-ocr' | 'pdf-embedded+windowsml-ocr';
  model: string;
  device: OcrDevice;
} {
  const value = provenance.find(
    (entry) =>
      entry.startsWith('windowsml-ocr · ') ||
      entry.startsWith('pdf-embedded+windowsml-ocr · '),
  ) ?? '';
  const [engine = '', model = '', device = ''] = value.split(' · ').map((entry) => entry.trim());
  if (
    (engine !== 'windowsml-ocr' && engine !== 'pdf-embedded+windowsml-ocr') ||
    !model ||
    (device !== 'windowsml-dml' && device !== 'cpu')
  ) {
    throw new Error('Standalone desktop UI did not display a recognized OCR device provenance.');
  }
  return { engine, model, device };
}

export function resolveExpectedOcrDevice(
  arguments_: readonly string[],
  environmentValue?: string,
): OcrDevice | undefined {
  const option = '--expected-ocr-device';
  const optionIndexes = arguments_
    .map((argument, index) => (argument === option ? index : -1))
    .filter((index) => index >= 0);
  if (optionIndexes.length > 1) {
    throw new Error(`${option} may be supplied only once.`);
  }
  const value =
    optionIndexes.length === 1
      ? arguments_[optionIndexes[0] + 1]?.trim()
      : environmentValue?.trim();
  if (value === undefined || value === '') return undefined;
  if (value !== 'windowsml-dml' && value !== 'cpu') {
    throw new Error(`${option} must be windowsml-dml or cpu.`);
  }
  return value;
}

export function assertExpectedOcrDevice(
  actual: OcrDevice,
  expected: OcrDevice | undefined,
): void {
  if (expected !== undefined && actual !== expected) {
    throw new Error(`Standalone desktop OCR used ${actual}; expected ${expected}.`);
  }
}

export function isOwnedSmokeDocumentName(value: string): boolean {
  return ownedSmokeDocumentPattern.test(value);
}

async function deleteCompletedOwnedSmokeDocuments(page: Page): Promise<void> {
  const names = await page.locator('.document-copy strong').allTextContents();
  for (const name of names.filter(isOwnedSmokeDocumentName)) {
    await deleteCompletedDocument(page, name);
  }
}

function exactDocumentCard(page: Page, fileName: string) {
  const exactName = page.getByText(fileName, { exact: true });
  return page.locator('button.document-card').filter({ has: exactName });
}

async function deleteCompletedDocument(page: Page, fileName: string): Promise<boolean> {
  const card = exactDocumentCard(page, fileName);
  if ((await card.count()) === 0) return false;
  assert.equal(
    await card.count(),
    1,
    'Standalone desktop cleanup filename must identify exactly one document.',
  );
  if ((await card.locator('.status').getAttribute('data-status')) !== 'completed') return false;
  await card.click();
  const detailPane = page.locator('.detail-pane');
  const selectedFileName = await detailPane.locator('.detail-heading h2').textContent();
  assert.equal(
    selectedFileName?.trim(),
    fileName,
    'Standalone desktop cleanup must verify the exact selected filename.',
  );
  // The Tauri WebView routes globalThis.confirm to plugin:dialog|confirm, which
  // is blocked by the packaged ACL and opens a native dialog Playwright cannot
  // accept. Override only the page-scoped confirm so cleanup stays deterministic.
  await page.evaluate(() => {
    Object.defineProperty(globalThis, 'confirm', {
      configurable: true,
      writable: true,
      value: () => true,
    });
  });
  await detailPane.getByRole('button', { name: '刪除', exact: true }).click();
  await card.waitFor({ state: 'hidden', timeout: 30_000 });
  return true;
}

function assertConfiguredHostAppData(appData: string, acceptance?: AcceptanceRun): void {
  if (acceptance) {
    const expected = resolve(acceptance.artifactRoot, 'app-data');
    if (resolve(appData).toLowerCase() !== expected.toLowerCase()) {
      throw new Error('Acceptance Capture app-data must be the run-owned product directory.');
    }
    return;
  }
  const roaming = process.env.APPDATA;
  if (!roaming) {
    throw new Error('APPDATA is required to verify the Tauri host-owned app-data location.');
  }
  if (resolve(appData).toLowerCase() !== resolve(roaming, productIdentifier).toLowerCase()) {
    throw new Error('CAPTURE_REAL_DESKTOP_APP_DATA must be the Tauri host-owned Capture Workbench app-data directory.');
  }
}

function requiredPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set explicitly for real standalone desktop OCR smoke.`);
  }
  return resolve(value);
}

async function requireRegularFile(path: string, name: string): Promise<void> {
  const metadata = await stat(path).catch(() => undefined);
  if (!metadata?.isFile()) {
    throw new Error(`${name} must be an existing regular file.`);
  }
}

async function startAcceptanceWorkerMirror(): Promise<AcceptanceWorkerMirror> {
  await requireRegularFile(acceptanceOcrWorkerArchive, 'acceptance OCR worker archive');
  const archiveBytes = (await stat(acceptanceOcrWorkerArchive)).size;
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes <= 0) {
    throw new Error('Acceptance OCR worker archive must have a positive safe byte length.');
  }
  const archiveName = basename(acceptanceOcrWorkerArchive);
  let requestCount = 0;
  const sockets = new Set<net.Socket>();
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || !request.url) {
      response.writeHead(405).end();
      return;
    }
    let pathname: string;
    try {
      const parsed = new URL(request.url, 'http://127.0.0.1');
      if (parsed.search || parsed.hash || parsed.pathname.split('/').filter(Boolean).length !== 1) {
        response.writeHead(404).end();
        return;
      }
      pathname = decodeURIComponent(parsed.pathname.slice(1));
    } catch {
      response.writeHead(404).end();
      return;
    }
    if (pathname !== archiveName) {
      response.writeHead(404).end();
      return;
    }
    requestCount += 1;
    response.writeHead(200, {
      'Content-Length': archiveBytes,
      'Content-Type': 'application/zip',
      Connection: 'close',
    });
    const stream = createReadStream(acceptanceOcrWorkerArchive);
    stream.once('error', () => response.destroy());
    stream.pipe(response);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  if (!port) {
    server.close();
    throw new Error('Acceptance OCR worker mirror did not expose a loopback port.');
  }
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get requests() {
      return requestCount;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.closeIdleConnections();
      server.closeAllConnections();
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      }).catch(() => undefined);
    },
  };
}

async function requireDirectory(path: string, name: string): Promise<void> {
  const metadata = await stat(path).catch(() => undefined);
  if (!metadata?.isDirectory()) {
    throw new Error(`${name} must be an existing directory.`);
  }
}

function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : port ? resolvePort(port) : reject(new Error('A WebView2 CDP port was unavailable.')));
    });
  });
}

async function waitUntil<T>(check: () => Promise<T | undefined>, timeoutMs: number, message: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probeBudget = Math.min(5_000, Math.max(1, deadline - Date.now()));
    const value = await withTimeout(check(), probeBudget, `${message} (single UI probe timed out)`);
    if (value !== undefined) {
      return value;
    }
    await delay(250);
  }
  throw new Error(message);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface PackagedUiState {
  readonly runtimeState: string | null;
  readonly sourceImportEnabled: boolean;
}

async function invokeTauriCommand(
  page: Page,
  command: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  return page.evaluate(async ({ commandName, commandArgs }) => {
    const internals = (globalThis as typeof globalThis & {
      __TAURI_INTERNALS__?: {
        invoke?: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
    }).__TAURI_INTERNALS__;
    if (typeof internals?.invoke !== 'function') {
      throw new Error('Packaged Tauri command bridge is unavailable.');
    }
    return internals.invoke(commandName, commandArgs);
  }, { commandName: command, commandArgs: args });
}

async function queryPackagedUiState(cdpPort: number): Promise<PackagedUiState | undefined> {
  const response = await withTimeout(
    fetch(`http://127.0.0.1:${cdpPort}/json/list`),
    3_000,
    'Packaged WebView2 CDP target listing timed out.',
  );
  if (!response.ok) throw new Error(`Packaged WebView2 CDP target listing returned ${response.status}.`);
  const targets = await response.json() as Array<{ type?: unknown; url?: unknown; webSocketDebuggerUrl?: unknown }>;
  const target = targets.find((candidate) => (
    candidate.type === 'page' &&
    candidate.url === 'http://tauri.localhost/' &&
    typeof candidate.webSocketDebuggerUrl === 'string'
  ));
  if (!target || typeof target.webSocketDebuggerUrl !== 'string') return undefined;

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let sequence = 0;
  try {
    await withTimeout(new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('Packaged WebView2 CDP socket failed to open.')), { once: true });
    }), 3_000, 'Packaged WebView2 CDP socket open timed out.');
    const responseMessage = await withTimeout(new Promise<unknown>((resolve, reject) => {
      const id = ++sequence;
      const listener = (event: MessageEvent): void => {
        try {
          const message = JSON.parse(String(event.data)) as { id?: unknown; result?: { result?: { value?: unknown } } };
          if (message.id !== id) return;
          socket.removeEventListener('message', listener);
          resolve(message);
        } catch (error) {
          socket.removeEventListener('message', listener);
          reject(error);
        }
      };
      socket.addEventListener('message', listener);
      socket.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: {
          returnByValue: true,
          expression: `JSON.stringify({
            runtimeState: document.querySelector('[data-testid="workbench-root"]')?.getAttribute('data-runtime-state') ?? null,
            sourceImportEnabled: (() => {
              const element = document.querySelector('[data-testid="source-import"]');
              return element instanceof HTMLButtonElement && !element.disabled;
            })(),
          })`,
        },
      }));
    }), 3_000, 'Packaged WebView2 UI state probe timed out.');
    const value = (responseMessage as { result?: { result?: { value?: unknown } } }).result?.result?.value;
    if (typeof value !== 'string') return undefined;
    const parsed = JSON.parse(value) as { runtimeState?: unknown; sourceImportEnabled?: unknown };
    return {
      runtimeState: typeof parsed.runtimeState === 'string' ? parsed.runtimeState : null,
      sourceImportEnabled: parsed.sourceImportEnabled === true,
    };
  } finally {
    socket.close();
  }
}

async function waitForPackagedRuntimeReadySignal(cdpPort: number): Promise<boolean> {
  try {
    const state = await queryPackagedUiState(cdpPort);
    return state?.runtimeState === 'ready' && state.sourceImportEnabled;
  } catch {
    return false;
  }
}

async function reattachToPackagedPage(cdpPort: number): Promise<{ browser: CdpBrowser; page: Page }> {
  const attached = await withTimeout(
    chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 1_500 }),
    10_000,
    'Packaged WebView2 CDP reattachment timed out.',
  );
  const page = attached.contexts().flatMap((context) => context.pages())
    .find((candidate) => candidate.url() === 'http://tauri.localhost/');
  if (!page) throw new Error('Packaged WebView2 CDP reattachment found no Tauri page.');
  return { browser: attached, page };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function terminateOwnedTree(pid: number | undefined): boolean {
  if (pid) {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    if (result.error) return false;
    return result.status === 0 || !isProcessAlive(pid);
  }
  return true;
}

async function waitForOwnedTreeGone(
  rootPid: number,
  runtimeSidecarPid: number | undefined,
): Promise<OwnedChildProcess[] | undefined> {
  try {
    return await waitUntil(async () => {
      const children = descendantProcessRecords(rootPid);
      if (isProcessAlive(rootPid)) return undefined;
      if (runtimeSidecarPid !== undefined && isProcessAlive(runtimeSidecarPid)) return undefined;
      if (children === undefined) return [];
      return children.length === 0 ? children : undefined;
    }, 30_000, 'Owned Capture Workbench process tree did not settle after termination.');
  } catch {
    return descendantProcessRecords(rootPid);
  }
}

async function collectVisibleOcrSegments(page: Page): Promise<readonly RealOcrUiSegment[]> {
  return page.getByTestId('document-raw-segment').evaluateAll((elements) => elements.map((element) => {
    const locatorKind = element.getAttribute('data-locator-kind');
    if (locatorKind !== 'page' && locatorKind !== 'time') {
      throw new Error('Visible OCR segment did not expose a supported locator kind.');
    }
    const locator: RealOcrLocator = locatorKind === 'page'
      ? { kind: locatorKind, page: Number(element.getAttribute('data-page')) }
      : {
        kind: locatorKind,
        startMs: Number(element.getAttribute('data-start-ms')),
        endMs: Number(element.getAttribute('data-end-ms')),
      };
    return {
      segmentId: element.getAttribute('data-segment-id') ?? '',
      order: Number(element.getAttribute('data-order')),
      locator,
      text: element.querySelector('span')?.textContent?.trim() ?? '',
    };
  }));
}

async function collectVisibleStructuredBlocks(page: Page): Promise<readonly RealOcrUiBlock[]> {
  return page.getByTestId('document-result-block').evaluateAll((elements) => elements.map((element) => {
    const locatorKind = element.getAttribute('data-locator-kind');
    if (locatorKind !== 'page' && locatorKind !== 'time') {
      throw new Error('Visible structured block did not expose a supported locator kind.');
    }
    const locator: RealOcrLocator = locatorKind === 'page'
      ? { kind: locatorKind, page: Number(element.getAttribute('data-page')) }
      : {
        kind: locatorKind,
        startMs: Number(element.getAttribute('data-start-ms')),
        endMs: Number(element.getAttribute('data-end-ms')),
      };
    return {
      blockId: element.getAttribute('data-block-id') ?? '',
      order: Number(element.getAttribute('data-order')),
      sourceSegmentId: element.getAttribute('data-source-segment-id') ?? '',
      locator,
      sourceText: element.querySelector('[data-testid="document-result-block-source"]')?.textContent?.trim() ?? '',
      targetText: element.querySelector('[data-testid="document-result-block-target"]')?.textContent?.trim() ?? '',
    };
  }));
}

async function visibleRuntimeError(page: Page): Promise<string | undefined> {
  const error = page.getByTestId('runtime-error');
  if (!await error.isVisible().catch(() => false)) return undefined;
  const message = await error.getByTestId('runtime-error-message').textContent().catch(() => undefined);
  return `Capture Workbench runtime entered an error state: ${message?.trim() || 'no detail was rendered.'}`;
}

async function runtimeSetupDiagnostics(page: Page): Promise<string> {
  const setup = page.getByTestId('runtime-setup');
  if (!await setup.isVisible().catch(() => false)) return 'setup-visible=false';
  const message = await setup.locator('.setup-status').textContent().catch(() => undefined);
  const install = setup.getByTestId('runtime-install');
  const requirements = await setup.getByTestId('runtime-requirement').evaluateAll((elements) => elements.map((element) => ({
    id: element.getAttribute('data-requirement-id'),
    status: element.getAttribute('data-status'),
    text: element.textContent?.trim(),
  }))).catch(() => []);
  const modelSelectionVisible = await setup.getByTestId('model-selection').isVisible().catch(() => false);
  const modelInstall = setup.getByTestId('model-install');
  return JSON.stringify({
    setupVisible: true,
    message: message?.trim(),
    coreInstallVisible: await install.isVisible().catch(() => false),
    coreInstallEnabled: await install.isEnabled().catch(() => false),
    requirements,
    modelSelectionVisible,
    modelInstallVisible: await modelInstall.isVisible().catch(() => false),
    modelInstallEnabled: await modelInstall.isEnabled().catch(() => false),
  });
}

function resolveSourceKind(sourcePath: string): SourceKind {
  const extension = extname(sourcePath).toLowerCase();
  if (extension === '.pdf') return 'pdf';
  if (['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff'].includes(extension)) return 'image';
  if (['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg'].includes(extension)) return 'audio';
  return 'unknown';
}

function isProcessAlive(pid: number): boolean {
  const result = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  // tasklist's localized "no tasks" line is emitted in the host code page,
  // while CSV process rows remain structurally stable. Match the exact PID
  // field instead of decoding or comparing localized text.
  return result.status === 0 && new RegExp(`^"[^"]+","${pid}",`, 'mu').test(String(result.stdout || ''));
}

interface OwnedChildProcess {
  readonly pid: number;
  readonly name: string;
  readonly commandLine: string;
}

function descendantProcessRecords(rootPid: number | undefined): OwnedChildProcess[] | undefined {
  if (!rootPid || process.platform !== 'win32') return rootPid ? [] : undefined;
  const script = [
    `$root = ${rootPid}`,
    '$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine)',
    '$pending = [System.Collections.Generic.Queue[int]]::new()',
    '$pending.Enqueue($root)',
    '$found = [System.Collections.Generic.List[object]]::new()',
    'while ($pending.Count -gt 0) {',
    '  $parent = $pending.Dequeue()',
    '  foreach ($child in @($all | Where-Object { $_.ParentProcessId -eq $parent })) {',
    '    $childPid = [int]$child.ProcessId',
    '    if (-not ($found | Where-Object { $_.ProcessId -eq $childPid })) { $found.Add($child); $pending.Enqueue($childPid) }',
    '  }',
    '}',
    '$found | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress',
  ].join('; ');
  for (const shell of ['pwsh.exe', 'powershell.exe']) {
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error || result.status !== 0) continue;
    try {
      const parsed = JSON.parse(String(result.stdout || 'null')) as unknown;
      const records = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : [];
      return records.flatMap((record) => {
        if (!record || typeof record !== 'object') return [];
        const value = record as { ProcessId?: unknown; Name?: unknown; CommandLine?: unknown };
        const pid = Number(value.ProcessId);
        return Number.isInteger(pid) && pid > 0
          ? [{ pid, name: String(value.Name ?? ''), commandLine: String(value.CommandLine ?? '') }]
          : [];
      });
    } catch {
      // Try the alternate PowerShell host below.
    }
  }
  return undefined;
}

function isCaptureSidecarProcess(process_: OwnedChildProcess): boolean {
  const name = process_.name.toLowerCase();
  const commandLine = process_.commandLine.toLowerCase();
  return name.includes('capture-runtime') ||
    name === 'ollama.exe' ||
    name === 'ollama_llama_server.exe' ||
    commandLine.includes('capture-runtime');
}

async function waitForPortClosed(port: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const closed = await new Promise<boolean>((resolveClosed) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolveClosed(false); });
      socket.once('error', () => resolveClosed(true));
      socket.setTimeout(250, () => { socket.destroy(); resolveClosed(true); });
    });
    if (closed) return true;
    await delay(100);
  }
  return false;
}

function observe<T>(observable: { subscribe: (observer: { next: (value: T) => void; error: (error: unknown) => void }) => unknown }): Promise<T> {
  return new Promise((resolveValue, reject) => observable.subscribe({ next: resolveValue, error: reject }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
