import assert from 'node:assert/strict';
import net from 'node:net';

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

export function connectToInstalledWebView(port, appProcess) {
  const endpoint = `http://127.0.0.1:${port}`;
  const processTerminated = race(
    fromEvent(appProcess, 'error'),
    fromEvent(appProcess, 'exit'),
  ).pipe(
    take(1),
    switchMap(() => throwError(() => new Error('Installed Tauri app terminated before WebView2 CDP readiness.'))),
  );
  return race(
    connectAttempt(
      endpoint,
      appProcess,
      Date.now() + installedWebViewCdpReadyTimeoutMs,
      undefined,
    ),
    processTerminated,
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
  const filePicker = page.getByRole('button', { name: '選擇檔案' });
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
          assert.match(model ?? '', /qwen3\.5:4b/u);
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
