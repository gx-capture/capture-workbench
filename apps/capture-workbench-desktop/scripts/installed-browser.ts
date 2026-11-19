import { assertLargeRecordingRequests } from './installed-large-recording.ts';
import { generateLargeRecording, readLargeRecordingRequests } from './installed-large-recording-fixture.ts';
import { beginRendererBoundary, connectRendererBoundary, assertInstalledCapture, forbidRecordingSourceBytes, finishRendererBoundary, cancelRendererBoundary } from './installed-renderer-boundary.ts';
import { newDocumentId } from './installed-document-selection.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';

import type { Browser, Locator, Page } from '@playwright/test';
import {
  catchError,
  concatMap,
  defer,
  from,
  fromEvent,
  forkJoin,
  map,
  Observable,
  of,
  race,
  switchMap,
  take,
  tap,
  throwError,
  timer,
  toArray,
} from 'rxjs';

import { INSTALLED_FIXTURES } from './constants/installed.ts';
import {
  isPackagedWorkbenchUrl,
} from './packaged-workbench-page.ts';
import {
  nativeClickWebViewElement,
  nativeOpenDialogUiAutomation,
} from './installed-native-dialog.ts';

export {
  nativeClickWebViewElement,
  nativeOpenDialogUiAutomation,
} from './installed-native-dialog.ts';

import { trackSmokeStep } from './smoke-diagnostics.ts';
import type { SmokeStepEvent, SmokeCardDiagnostic } from './smoke-diagnostics.ts';

const fixtures = INSTALLED_FIXTURES;
export const installedWebViewCdpReadyTimeoutMs = 180_000;
export const dynamicWebViewCdpPort = 0;

const startupDiagnosticKeys = [
  'appRunning',
  'appOsProcess',
  'webViewRuntimeInstalled',
  'webViewProcessCount',
  'webViewRemoteDebuggingArgument',
  'webViewUserDataArgument',
  'requestedPortListening',
  'devToolsActivePortFile',
] as const;

export function reserveLoopbackPort(): Observable<number> {
  return new Observable<number>((subscriber) => {
    const server = net.createServer();
    server.unref();
    const onError = (error) => subscriber.error(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        server.off('error', onError);
        if (error) subscriber.error(error);
        else if (!port)
          subscriber.error(new Error('Dynamic CDP port was unavailable.'));
        else {
          subscriber.next(port);
          subscriber.complete();
        }
      });
    });
    return () => {
      server.off('error', onError);
      server.close();
    };
  });
}

export function parseInstalledWebViewCdpPort(contents) {
  const port = Number(contents.split(/\r?\n/u)[0]?.trim());
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      'Installed WebView2 DevToolsActivePort did not contain a valid CDP port.',
    );
  }
  return port;
}

export function formatInstalledWebViewStartupDiagnostics(diagnostics) {
  return `Installed WebView2 startup diagnostics: ${startupDiagnosticKeys
    .map((key) => `${key}=${String(diagnostics?.[key] ?? false)}`)
    .join(';')}.`;
}

export function collectInstalledWebViewStartupDiagnostics(
  appProcess,
  webViewDataDirectory,
  requestedPort,
) {
  const defaults = {
    appRunning: appProcess?.exitCode === null,
    appOsProcess: false,
    webViewRuntimeInstalled: false,
    webViewProcessCount: 0,
    webViewRemoteDebuggingArgument: false,
    webViewUserDataArgument: false,
    requestedPortListening: false,
    devToolsActivePortFile:
      typeof webViewDataDirectory === 'string' &&
      existsSync(join(webViewDataDirectory, 'EBWebView', 'DevToolsActivePort')),
  };
  if (!Number.isSafeInteger(appProcess?.pid) || appProcess.pid < 1) {
    return formatInstalledWebViewStartupDiagnostics(defaults);
  }
  const script = String.raw`
$app = Get-CimInstance Win32_Process -Filter "ProcessId=$env:CAPTURE_SMOKE_DIAGNOSTIC_PID"
$webViews = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'")
$runtimeKeys = @(
  'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
$runtimeInstalled = @($runtimeKeys | Where-Object { (Get-ItemProperty -LiteralPath $_ -Name 'pv' -ErrorAction SilentlyContinue).pv }).Count -gt 0
$arguments = @($webViews | ForEach-Object { [string]$_.CommandLine })
$listening = $false
try {
  if ([int]$env:CAPTURE_SMOKE_DIAGNOSTIC_PORT -gt 0) {
    $listening = @(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort ([int]$env:CAPTURE_SMOKE_DIAGNOSTIC_PORT) -ErrorAction Stop).Count -gt 0
  }
} catch {}
[ordered]@{
  appRunning = $null -ne $app
  appOsProcess = $null -ne $app
  webViewRuntimeInstalled = $runtimeInstalled
  webViewProcessCount = $webViews.Count
  webViewRemoteDebuggingArgument = @($arguments | Where-Object { $_ -match '--remote-debugging-(?:address|port)=' }).Count -gt 0
  webViewUserDataArgument = @($arguments | Where-Object { $_ -match '--user-data-dir=' }).Count -gt 0
  requestedPortListening = $listening
} | ConvertTo-Json -Compress
`;
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
        env: {
          ...process.env,
          CAPTURE_SMOKE_DIAGNOSTIC_PID: String(appProcess.pid),
          CAPTURE_SMOKE_DIAGNOSTIC_PORT: String(requestedPort),
        },
      },
    );
    const observed = JSON.parse(output.trim());
    return formatInstalledWebViewStartupDiagnostics({
      ...defaults,
      ...observed,
    });
  } catch {
    return formatInstalledWebViewStartupDiagnostics(defaults);
  }
}

export function connectToInstalledWebView(
  port: number,
  appProcess: ChildProcess,
  webViewDataDirectory: string,
  auditRenderer = false,
): Observable<{ browser: Browser; port: number }> {
  const deadline = Date.now() + installedWebViewCdpReadyTimeoutMs;
  const processTerminated = race(
    fromEvent(appProcess, 'error'),
    fromEvent(appProcess, 'exit'),
  ).pipe(
    take(1),
    switchMap(() =>
      throwError(
        () =>
          new Error(
            'Installed Tauri app terminated before WebView2 CDP readiness.',
          ),
      ),
    ),
  );
  return race(
    resolveCdpPort(
      port,
      appProcess,
      webViewDataDirectory,
      deadline,
      undefined,
    ).pipe(
      switchMap((resolvedPort) =>
        connectAttempt(
          `http://127.0.0.1:${resolvedPort}`,
          appProcess,
          deadline,
          undefined,
          auditRenderer,
        ).pipe(map((browser) => ({ browser, port: resolvedPort }))),
      ),
    ),
    processTerminated,
  ) as Observable<{ browser: Browser; port: number }>;
}

function resolveCdpPort(
  port,
  appProcess,
  webViewDataDirectory,
  deadline,
  lastError,
) {
  if (appProcess.exitCode !== null) {
    return throwError(
      () =>
        new Error(
          `Installed Tauri app exited before WebView2 CDP readiness (${appProcess.exitCode}).`,
        ),
    );
  }
  if (port !== dynamicWebViewCdpPort) return of(port);
  if (
    typeof webViewDataDirectory !== 'string' ||
    webViewDataDirectory.length === 0
  ) {
    return throwError(
      () =>
        new Error(
          'Dynamic WebView2 CDP requires an isolated user-data directory.',
        ),
    );
  }
  if (Date.now() >= deadline) {
    return throwError(
      () =>
        new Error(
          `Installed WebView2 CDP port metadata was not ready: ${errorMessage(lastError)}.`,
        ),
    );
  }
  const portFile = join(
    webViewDataDirectory,
    'EBWebView',
    'DevToolsActivePort',
  );
  return defer(() => from(readFile(portFile, 'utf8'))).pipe(
    map(parseInstalledWebViewCdpPort),
    catchError((error) =>
      timer(250).pipe(
        concatMap(() =>
          resolveCdpPort(
            port,
            appProcess,
            webViewDataDirectory,
            deadline,
            error,
          ),
        ),
      ),
    ),
  );
}

export function installedPage(browser: Browser, appProcess: ChildProcess): Observable<Page> {
  const deadline = Date.now() + 30_000;
  function findPage() {
    if (appProcess.exitCode !== null) {
      return throwError(
        () =>
          new Error(
            'Installed Tauri app exited before its page was available.',
          ),
      );
    }
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => isPackagedWorkbenchUrl(candidate.url()));
    if (page)
      return defer(() => from(page.waitForLoadState('domcontentloaded'))).pipe(
        concatMap(() => waitForShell(page)),
        map(() => page),
      );
    if (Date.now() >= deadline)
      return throwError(
        () =>
          new Error('Installed WebView did not expose an application page.'),
      );
    return timer(100).pipe(concatMap(() => findPage()));
  }
  return defer(findPage) as Observable<Page>;
}

function connectAttempt(endpoint, appProcess, deadline, lastError, auditRenderer = false) {
  if (appProcess.exitCode !== null) {
    return throwError(
      () =>
        new Error(
          `Installed Tauri app exited before WebView2 CDP readiness (${appProcess.exitCode}).`,
        ),
    );
  }
  if (Date.now() >= deadline) {
    return throwError(
      () =>
        new Error(
          `Installed WebView2 CDP endpoint was not ready: ${errorMessage(lastError)}.`,
        ),
    );
  }
  let recorderAttached = false;
  return defer(() => from(connectRendererBoundary(endpoint, auditRenderer, (attached) => {
    recorderAttached = attached;
  }))).pipe(
    catchError((error) => recorderAttached
      ? throwError(() => new Error('WebView connection failed after startup recording began; refusing to discard session evidence.', { cause: error }))
      : timer(250).pipe(
        concatMap(() => connectAttempt(endpoint, appProcess, deadline, error, auditRenderer)),
      ),
    ),
  );
}

function waitForShell(page: Page) {
  return forkJoin([
    defer(() => from(page.getByTestId('nav-ocr').waitFor({ state: 'visible', timeout: 30_000 }))),
    defer(() => from(page.getByTestId('page-ocr').waitFor({ state: 'visible', timeout: 30_000 }))),
  ]);
}

function checkIfVisibleAndUnchecked(checkbox: Locator) {
  return defer(() => from(checkbox.isVisible())).pipe(
    switchMap((visible) => (visible ? defer(() => from(checkbox.isChecked())) : of(true))),
    switchMap((checked) => (checked ? of(undefined) : defer(() => from(checkbox.check())))),
  );
}

function ensureQueuePageReady(page: Page, isAudio: boolean) {
  const pageTestId = isAudio ? 'page-asr' : 'page-ocr';
  const navTestId = isAudio ? 'nav-asr' : 'nav-ocr';
  const chooseTestId = isAudio ? 'asr-choose-files' : 'ocr-choose-files';
  return defer(() => from(page.getByTestId(pageTestId).isVisible())).pipe(
    switchMap((visible) =>
      visible ? of(undefined) : defer(() => from(page.getByTestId(navTestId).click())),
    ),
    concatMap(() =>
      defer(() => from(page.getByTestId(pageTestId).waitFor({ state: 'visible', timeout: 15_000 }))),
    ),
    concatMap(() =>
      waitUntil(
        () =>
          forkJoin({
            installPanelCount: isAudio
              ? defer(() => from(page.getByTestId('asr-install-panel').count()))
              : of(0),
            chooseVisible: defer(() => from(page.getByTestId(chooseTestId).isVisible())),
            chooseEnabled: defer(() => from(page.getByTestId(chooseTestId).isEnabled())),
          }).pipe(
            map(
              ({ installPanelCount, chooseVisible, chooseEnabled }) =>
                installPanelCount === 0 && chooseVisible && chooseEnabled,
            ),
          ),
        isAudio ? 45_000 : 15_000,
        `Installed ${isAudio ? 'ASR' : 'OCR'} page did not become ready.`,
      ),
    ),
  );
}

function captureFixture(page, fixture, appPid, fixtureDirectory, diagnostics) {
  const isAudio = fixture.sourceKind === 'audio';
  const rowTestId = isAudio ? 'asr-queue-row' : 'ocr-queue-row';
  const statusTestId = isAudio ? 'asr-row-status' : 'ocr-row-status';
  const viewTestId = isAudio ? 'asr-row-view' : 'ocr-row-view';
  const filePath = join(fixtureDirectory, fixture.fileName);
  const chooseFiles = page.getByTestId(isAudio ? 'asr-choose-files' : 'ocr-choose-files');
  let diagnosticRow = page.locator(`[data-testid="${rowTestId}"][data-document-id=""]`);
  let beforeIds: string[] = [];
  let documentId: string;
  let requestLogOffset = 0;
  const documentIds = (rows: Locator) => rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-document-id')).filter(Boolean));
  return ensureQueuePageReady(page, isAudio).pipe(
    concatMap(() => (fixture.buffer ? defer(() => from(writeFile(filePath, fixture.buffer))) : of(undefined))),
    concatMap(() => fixture.bytes
      ? defer(() => from(readLargeRecordingRequests(join(fixtureDirectory, 'deterministic-requests.jsonl')))).pipe(
        tap((entries) => {
          requestLogOffset = entries.length;
        }),
      )
      : of(undefined)),
    concatMap(() => defer(() => from(documentIds(page.getByTestId(rowTestId)))).pipe(
      tap((ids: string[]) => { beforeIds = ids; }),
    )),
    concatMap(() =>
      trackSmokeStep(diagnostics.timeline, 'source picker', () => defer(() =>
        from(
          nativeOpenDialogUiAutomation(filePath, appPid, () =>
            nativeClickWebViewElement(chooseFiles, appPid),
          ),
        ),
      ).pipe(
        catchError((error) => {
          const diagnostics =
            typeof error?.diagnostics === 'string'
              ? error.diagnostics
              : undefined;
          return throwError(() =>
            diagnostics
              ? new Error(
                  `Native source picker automation failed: ${diagnostics}.`,
                  { cause: error },
                )
              : error,
          );
        }),
      )),
    ),
    concatMap(() =>
      trackSmokeStep(diagnostics.timeline, 'card visible', () => waitUntil(
        () => defer(() => from(documentIds(
          page.getByTestId(rowTestId).filter({ hasText: fixture.fileName }),
        ))).pipe(switchMap((ids: string[]) => {
          const id = newDocumentId(beforeIds, ids);
          if (!id) return of(false);
          if (!/^[a-zA-Z0-9_-]+$/u.test(id)) throw new Error('Invalid document row identifier.');
          documentId = id;
          if (fixture.bytes) forbidRecordingSourceBytes(page, id);
          diagnosticRow = page.locator(`[data-testid="${rowTestId}"][data-document-id="${id}"]`);
          return defer(() => from(diagnosticRow.isVisible()));
        })),
        15_000,
        `Installed ${fixture.sourceKind} import did not create a new queue row.`,
      )).pipe(map(() => diagnosticRow)),
    ),
    concatMap((row) => {
      const visibleStatus = isAudio
        ? row.getByTestId('asr-row-status').getByTestId('asr-row-chip')
        : row.getByTestId('ocr-row-status');
      return trackSmokeStep(diagnostics.timeline, 'completion wait', () => waitUntil(
        () =>
          forkJoin({
            userStatus: defer(() => from(row.getAttribute('data-user-status', { timeout: 1_000 }))),
            visibleText: defer(() => from(visibleStatus.textContent({ timeout: 1_000 }))),
          }).pipe(
            map(
              ({ userStatus, visibleText }) =>
                userStatus === 'done' && String(visibleText ?? '').trim() === '完成',
            ),
          ),
        fixture.completionTimeoutMs ?? 45_000,
        `Installed ${fixture.sourceKind} capture did not complete.`,
      )).pipe(
        concatMap(() => defer(() => from(visibleStatus.textContent({ timeout: 1_000 })))),
        tap((visibleText) => {
          assert.equal(String(visibleText ?? '').trim(), '完成');
        }),
        catchError((error) => incompleteCaptureError(page, row, statusTestId, error, fixture, diagnostics)),
        map(() => row),
      );
    }),
    concatMap((row) =>
      fixture.bytes
        ? defer(() => from(row.getByTestId('asr-row-playback-note').waitFor({ state: 'visible', timeout: 5_000 }))).pipe(
          concatMap(() => defer(() => from(row.getByTestId('asr-row-playback-note').textContent()))),
          tap((note) => {
            assert.ok(String(note ?? '').trim(), 'Large recording row playback note was empty.');
          }),
          map(() => row),
        )
        : of(row),
    ),
    concatMap((row) => defer(() => from(row.getByTestId(viewTestId).click()))),
    concatMap(() =>
      waitUntil(
        () => of(page.url().endsWith(`/history/${documentId}/content`)),
        15_000,
        `Installed ${fixture.sourceKind} result view did not navigate to /history/${documentId}/content.`,
      ),
    ),
    concatMap(() =>
      defer(() => from(page.getByTestId('page-result').waitFor({ state: 'visible', timeout: 15_000 }))),
    ),
    concatMap(() => {
      if (!isAudio) {
        const resultTextArea = page.getByTestId('result-page-text');
        return defer(() =>
          from(resultTextArea.waitFor({ state: 'visible', timeout: 15_000 })),
        ).pipe(
          concatMap(() => defer(() => from(resultTextArea.inputValue()))),
        );
      }
      const resultLines = page.getByTestId('result-line-text');
      return defer(() =>
        from(resultLines.first().waitFor({ state: 'visible', timeout: 15_000 })),
      ).pipe(
        concatMap(() => defer(() => from(resultLines.allTextContents()))),
      );
    }),
    concatMap((visibleResult) =>
      defer(() => from(assertInstalledCapture(page, documentId, fixture, visibleResult))).pipe(
        concatMap(() => fixture.bytes
          ? defer(() => from(readLargeRecordingRequests(join(fixtureDirectory, 'deterministic-requests.jsonl')))).pipe(
            tap((entries) => assertLargeRecordingRequests(entries.slice(requestLogOffset), fixture.bytes)),
          )
          : of(undefined)),
        concatMap(() => defer(() => from(page.getByTestId('result-back').click()))),
        concatMap(() =>
          defer(() =>
            from(
              page
                .getByTestId(isAudio ? 'page-asr' : 'page-ocr')
                .waitFor({ state: 'visible', timeout: 15_000 }),
            ),
          ),
        ),
        map(() => ({
          sourceKind: fixture.sourceKind,
          fileName: fixture.fileName,
          recognizedTextVisible: true,
        })),
      ),
    ),
    catchError((error) => defer(() => from(cancelRendererBoundary(page))).pipe(
      catchError(() => of(undefined)),
      switchMap(() => throwError(() => error)),
    )),
    catchError((error) => diagnostics.cards.some((card) => card.fileName === fixture.fileName)
      ? throwError(() => error)
      : incompleteCaptureError(page, diagnosticRow, statusTestId, error, fixture, diagnostics)),
  );
}

export function exerciseInstalledUi(page, appPid, fixtureDirectory, diagnostics = {
  timeline: [] as SmokeStepEvent[], cards: [] as SmokeCardDiagnostic[],
}) {
  return waitForShell(page).pipe(
    concatMap(() => defer(() => from(beginRendererBoundary(page)))),
    concatMap(() => prepareFirstRun(page)),
    concatMap(() =>
      defer(() => from(page.getByTestId('ocr-choose-files').isEnabled())),
    ),
    switchMap((enabled) => {
      if (!enabled)
        return throwError(
          () =>
            new Error(
              'Installed desktop workbench did not finish first-run requirements.',
            ),
        );
      return of(undefined);
    }),
    concatMap(() =>
      defer(() => from(generateLargeRecording(join(fixtureDirectory, 'installed-large-recording.wav')))).pipe(
        map((largeFixture) => [...fixtures, largeFixture]),
        switchMap((allFixtures) => from(allFixtures)),
        concatMap((fixture) =>
          captureFixture(page, fixture, appPid, fixtureDirectory, diagnostics),
        ),
        toArray(),
        concatMap((captures) =>
          defer(() => from(finishRendererBoundary(page, fixtureDirectory))).pipe(
            map((rendererIpcCommands) => ({
              rendererIpcCommands,
              productTitle: 'Capture Workbench',
              captures,
            })),
          ),
        ),
      ),
    ),
  );
}

function prepareFirstRun(page: Page) {
  const runtimeStatus = page.getByTestId('runtime-status');
  const firstRunCard = page.getByTestId('first-run-card');
  const chooseFiles = page.getByTestId('ocr-choose-files');
  const installProgress = page.getByTestId('ocr-install-progress');
  const installButton = page.getByTestId('first-run-install');
  const requiredUnits = ['text-recognition', 'speech-recognition'] as const;
  const terminalErrorStatuses = new Set([
    'failed',
    'cancelled',
    'unavailable',
    'manual_action_required',
  ]);
  return waitUntil(
    () =>
      forkJoin({
        runtimeState: defer(() => from(runtimeStatus.getAttribute('data-state'))),
        cardVisible: defer(() => from(firstRunCard.isVisible())),
        chooseVisible: defer(() => from(chooseFiles.isVisible())),
        chooseEnabled: defer(() => from(chooseFiles.isEnabled())),
        progressVisible: defer(() => from(installProgress.isVisible())),
      }).pipe(
        map(
          ({ runtimeState, cardVisible, chooseVisible, chooseEnabled, progressVisible }) =>
            runtimeState === 'ready' &&
            (cardVisible || (chooseVisible && chooseEnabled && !progressVisible)),
        ),
      ),
    75_000,
    'Installed desktop workbench did not reach its ready or first-run setup state.',
  ).pipe(
    concatMap(() => defer(() => from(firstRunCard.isVisible()))),
    switchMap((cardVisible) => {
      if (!cardVisible) return of(undefined);
      return checkIfVisibleAndUnchecked(page.getByTestId('first-run-checkbox-ocr')).pipe(
        concatMap(() => checkIfVisibleAndUnchecked(page.getByTestId('first-run-checkbox-asr'))),
        concatMap(() =>
          waitUntil(
            () => defer(() => from(installButton.isEnabled())),
            5_000,
            'First-run install button remained disabled after selecting OCR and ASR.',
          ),
        ),
        concatMap(() => defer(() => from(installButton.click()))),
      );
    }),
    concatMap(() => defer(() => from(page.getByTestId('nav-settings').click()))),
    concatMap(() =>
      defer(() =>
        from(page.getByTestId('page-settings-engines').waitFor({ state: 'visible', timeout: 15_000 })),
      ),
    ),
    concatMap(() =>
      waitUntil(
        () =>
          forkJoin(
            requiredUnits.map((unitId) =>
              defer(() =>
                from(
                  page
                    .locator(`[data-testid="engine-row"][data-requirement-id="${unitId}"]`)
                    .getAttribute('data-status'),
                ),
              ).pipe(map((status) => ({ unitId, status }))),
            ),
          ).pipe(
            switchMap((entries) => {
              const failure = entries.find(
                ({ status }) => status !== null && terminalErrorStatuses.has(status),
              );
              if (failure) {
                return throwError(
                  () =>
                    new Error(
                      `Required recognition unit ${failure.unitId} installation ended with status ${failure.status}.`,
                    ),
                );
              }
              return of(entries.every(({ status }) => status === 'ready'));
            }),
          ),
        45_000,
        'Installed desktop workbench did not complete first-run requirements.',
      ),
    ),
    concatMap(() => defer(() => from(page.getByTestId('nav-ocr').click()))),
    concatMap(() =>
      defer(() => from(page.getByTestId('page-ocr').waitFor({ state: 'visible', timeout: 15_000 }))),
    ),
  );
}

// A stuck capture is only diagnosable from what the row and any page alert show,
// so the failure carries both.
function incompleteCaptureError(
  page: Page,
  row: Locator,
  statusTestId: string,
  error: unknown,
  fixture: { readonly fileName: string },
  diagnostics: { cards: SmokeCardDiagnostic[] },
) {
  return forkJoin({
    status: defer(() => from(row.getByTestId(statusTestId).textContent({ timeout: 1_000 }).catch(() => null))),
    detailErrors: defer(() => from(page.locator('[role="alert"]').allTextContents().catch(() => []))),
  }).pipe(
    concatMap(({ status, detailErrors }: { status: string | null; detailErrors: string[] }) => {
      diagnostics.cards.push({ fileName: fixture.fileName, status, detailErrors });
      return throwError(() => new Error(
        `${errorMessage(error)} Last status: ${status ?? 'unavailable'}; alerts: ${
          detailErrors.length > 0 ? detailErrors.join(' | ') : 'none'
        }.`, { cause: error },
      ));
    }),
  );
}

function waitUntil(check, timeout, message, deadline = Date.now() + timeout) {
  return defer(() => check()).pipe(
    switchMap((done) => {
      if (done) return of(undefined);
      if (Date.now() >= deadline) return throwError(() => new Error(message));
      return timer(100).pipe(
        concatMap(() => waitUntil(check, timeout, message, deadline)),
      );
    }),
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
