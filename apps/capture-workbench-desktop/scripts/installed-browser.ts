import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';

import { chromium } from '@playwright/test';
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
  throwError,
  timer,
  toArray,
} from 'rxjs';

import { INSTALLED_FIXTURES } from './constants/installed.ts';

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

export function reserveLoopbackPort() {
  return new Observable((subscriber) => {
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
        else if (!port) subscriber.error(new Error('Dynamic CDP port was unavailable.'));
        else { subscriber.next(port); subscriber.complete(); }
      });
    });
    return () => { server.off('error', onError); server.close(); };
  });
}

export function parseInstalledWebViewCdpPort(contents) {
  const port = Number(contents.split(/\r?\n/u)[0]?.trim());
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Installed WebView2 DevToolsActivePort did not contain a valid CDP port.');
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
    return formatInstalledWebViewStartupDiagnostics({ ...defaults, ...observed });
  } catch {
    return formatInstalledWebViewStartupDiagnostics(defaults);
  }
}

export function connectToInstalledWebView(
  port,
  appProcess,
  webViewDataDirectory,
) {
  const deadline = Date.now() + installedWebViewCdpReadyTimeoutMs;
  const processTerminated = race(
    fromEvent(appProcess, 'error'),
    fromEvent(appProcess, 'exit'),
  ).pipe(
    take(1),
    switchMap(() => throwError(() => new Error('Installed Tauri app terminated before WebView2 CDP readiness.'))),
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
        ).pipe(map((browser) => ({ browser, port: resolvedPort }))),
      ),
    ),
    processTerminated,
  );
}

function resolveCdpPort(port, appProcess, webViewDataDirectory, deadline, lastError) {
  if (appProcess.exitCode !== null) {
    return throwError(() => new Error(`Installed Tauri app exited before WebView2 CDP readiness (${appProcess.exitCode}).`));
  }
  if (port !== dynamicWebViewCdpPort) return of(port);
  if (typeof webViewDataDirectory !== 'string' || webViewDataDirectory.length === 0) {
    return throwError(() => new Error('Dynamic WebView2 CDP requires an isolated user-data directory.'));
  }
  if (Date.now() >= deadline) {
    return throwError(() => new Error(`Installed WebView2 CDP port metadata was not ready: ${errorMessage(lastError)}.`));
  }
  const portFile = join(webViewDataDirectory, 'EBWebView', 'DevToolsActivePort');
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

export function installedPage(browser, appProcess) {
  const deadline = Date.now() + 30_000;
  function findPage() {
    if (appProcess.exitCode !== null) {
      return throwError(() => new Error('Installed Tauri app exited before its page was available.'));
    }
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => candidate.url() === 'http://tauri.localhost/');
    if (page) return defer(() => from(page.waitForLoadState('domcontentloaded'))).pipe(map(() => page));
    if (Date.now() >= deadline) return throwError(() => new Error('Installed WebView did not expose an application page.'));
    return timer(100).pipe(concatMap(() => findPage()));
  }
  return defer(findPage);
}

function connectAttempt(endpoint, appProcess, deadline, lastError) {
  if (appProcess.exitCode !== null) {
    return throwError(() => new Error(`Installed Tauri app exited before WebView2 CDP readiness (${appProcess.exitCode}).`));
  }
  if (Date.now() >= deadline) {
    return throwError(() => new Error(`Installed WebView2 CDP endpoint was not ready: ${errorMessage(lastError)}.`));
  }
  return defer(() => from(chromium.connectOverCDP(endpoint, { timeout: 2_000 }))).pipe(
    catchError((error) => timer(250).pipe(concatMap(() => connectAttempt(endpoint, appProcess, deadline, error)))),
  );
}

function captureFixture(page, fixture) {
  const filePicker = page.getByLabel('選擇檔案');
  return defer(() => from(filePicker.setInputFiles({
    name: fixture.fileName, mimeType: fixture.mimeType, buffer: fixture.buffer,
  }))).pipe(
    map(() => page.locator('.document-card').filter({ hasText: fixture.fileName }).last()),
    concatMap((card) => defer(() => from(card.waitFor({ state: 'visible', timeout: 15_000 }))).pipe(map(() => card))),
    concatMap((card) => waitUntil(
      () => defer(() => from(card.locator('.status').textContent())).pipe(map((status) => status === '已完成')),
      45_000,
      `Installed ${fixture.sourceKind} capture did not complete.`,
    ).pipe(map(() => card))),
    concatMap((card) => defer(() => from(card.click())).pipe(map(() => card))),
    concatMap(() => {
      const result = page.locator('.review-block.result pre');
      return defer(() => from(result.waitFor({ state: 'visible', timeout: 15_000 }))).pipe(
        concatMap(() => defer(() => from(result.textContent()))),
        map((text) => {
          assert.ok(text?.trim(), 'Installed result preview was empty.');
          return { sourceKind: fixture.sourceKind, fileName: fixture.fileName, targetTextVisible: true };
        }),
      );
    }),
  );
}

export function exerciseInstalledUi(page) {
  return defer(() => from(page.getByRole('heading', { name: '文件擷取工作台' }).waitFor({ state: 'visible', timeout: 30_000 }))).pipe(
    concatMap(() => prepareFirstRun(page)),
    concatMap(() =>
      defer(() =>
        from(page.getByRole('button', { name: '選擇檔案' }).isEnabled()),
      ),
    ),
    switchMap((enabled) => {
      if (!enabled) return throwError(() => new Error('Installed desktop workbench did not finish first-run requirements.'));
      return defer(() => from(page.locator('.model-chip').textContent())).pipe(
        map((model) => {
          assert.match(model ?? '', /qwen(?:3\.5:|\s+3\.5\s+)0\.8b/iu);
          return model;
        }),
      );
    }),
    concatMap((model) => from(fixtures).pipe(
      concatMap((fixture) => captureFixture(page, fixture)),
      toArray(),
      map((captures) => ({
        productTitle: 'Capture Workbench', model, captures,
      })),
    )),
  );
}

function prepareFirstRun(page) {
  const intake = page.getByRole('button', { name: '選擇檔案' });
  const install = page.getByRole('button', { name: '同意並安裝核心需求' });
  return waitUntil(
    () => forkJoin({
      enabled: defer(() => from(intake.isEnabled())),
      installVisible: defer(() => from(install.isVisible())),
    }).pipe(map(({ enabled, installVisible }) => enabled || installVisible)),
    75_000,
    'Installed desktop workbench did not reach its ready or first-run setup state.',
  ).pipe(
    concatMap(() => defer(() => from(intake.isEnabled()))),
    switchMap((enabled) => {
      if (enabled) return of(undefined);
      return defer(() => from(install.click())).pipe(
        concatMap(() => waitUntil(
          () => defer(() => from(intake.isEnabled())),
          45_000,
          'Installed desktop workbench did not complete first-run requirements.',
        )),
      );
    }),
  );
}

function waitUntil(check, timeout, message, deadline = Date.now() + timeout) {
  return defer(() => check()).pipe(
    switchMap((done) => {
      if (done) return of(undefined);
      if (Date.now() >= deadline) return throwError(() => new Error(message));
      return timer(100).pipe(concatMap(() => waitUntil(check, timeout, message, deadline)));
    }),
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
