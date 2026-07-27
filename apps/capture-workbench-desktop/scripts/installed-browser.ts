import assert from 'node:assert/strict';
import net from 'node:net';

import { chromium } from '@playwright/test';
import {
  Observable,
  catchError,
  concatMap,
  defer,
  forkJoin,
  from,
  map,
  of,
  switchMap,
  tap,
  throwError,
  timer,
  toArray,
} from 'rxjs';

import { INSTALLED_FIXTURES } from './constants/installed.ts';
import { assertCaptureDocumentForFixture } from './installed-document-assertions.ts';

const fixtures = INSTALLED_FIXTURES;

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

function connectAttempt(endpoint, appProcess, deadline, lastError) {
  if (appProcess.exitCode !== null) {
    return throwError(
      () => new Error(`Installed Tauri app exited before WebView2 CDP readiness (${appProcess.exitCode}).`),
    );
  }
  if (Date.now() >= deadline) {
    return throwError(
      () => new Error(`Installed WebView2 CDP endpoint was not ready: ${errorMessage(lastError)}.`),
    );
  }
  return defer(() => from(chromium.connectOverCDP(endpoint, { timeout: 2_000 }))).pipe(
    catchError((error) =>
      timer(250).pipe(
        concatMap(() => connectAttempt(endpoint, appProcess, deadline, error)),
      ),
    ),
  );
}

export function connectToInstalledWebView(port, appProcess) {
  return connectAttempt(
    `http://127.0.0.1:${port}`,
    appProcess,
    Date.now() + 60_000,
    undefined,
  );
}

export function installedPage(browser, appProcess) {
  const deadline = Date.now() + 30_000;
  function findPage() {
    if (appProcess.exitCode !== null) {
      return throwError(() => new Error('Installed Tauri app exited before its page was available.'));
    }
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => candidate.url() === 'http://tauri.localhost/');
    if (page) {
      return defer(() => from(page.waitForLoadState('domcontentloaded'))).pipe(map(() => page));
    }
    if (Date.now() >= deadline) {
      return throwError(() => new Error('Installed WebView did not expose an application page.'));
    }
    return timer(100).pipe(concatMap(() => findPage()));
  }
  return defer(findPage);
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

function captureFixture(page, fixture) {
  const filePicker = page.getByLabel('Choose files');
  return defer(() =>
    from(
      filePicker.setInputFiles({
        name: fixture.fileName,
        mimeType: fixture.mimeType,
        buffer: fixture.buffer,
      }),
    ),
  ).pipe(
    map(() =>
      page.locator('.task-list > li').filter({ hasText: fixture.fileName }),
    ),
    concatMap((task) => defer(() => from(task.waitFor({ state: 'visible', timeout: 15_000 }))).pipe(map(() => task))),
    concatMap((task) =>
      waitUntil(
        () => defer(() => from(task.getAttribute('data-task-status'))).pipe(map((status) => status === 'completed')),
        45_000,
        `Installed ${fixture.sourceKind} capture did not complete.`,
      ).pipe(map(() => task)),
    ),
    concatMap((task) => {
      const preview = task.locator('pre.result-preview');
      return defer(() => from(preview.waitFor({ state: 'visible', timeout: 15_000 }))).pipe(
        concatMap(() => defer(() => from(preview.textContent()))),
        map((text) => {
          const document = JSON.parse(text ?? '');
          assertCaptureDocumentForFixture(document, fixture);
          return {
            sourceKind: fixture.sourceKind,
            fileName: fixture.fileName,
            locatorKind: fixture.locatorKind,
            segments: fixture.expectedSegments,
            jsonReparsed: true,
            textProjection: true,
          };
        }),
      );
    }),
  );
}

export function exerciseInstalledUi(page) {
  const mode = page.locator('.client-mode');
  const providerButton = page.getByRole('button', { name: 'Host provider interface' });
  const isolatedButton = page.getByRole('button', { name: 'Isolated runtime provider' });
  const requirements = page.getByLabel('Runtime requirements').getByRole('listitem');
  const readyRequirements = page.locator('.requirements .requirement-status[data-status="ready"]');

  return defer(() => from(mode.waitFor({ state: 'visible', timeout: 30_000 }))).pipe(
    concatMap(() => defer(() => from(mode.getAttribute('data-client-mode')))),
    map((clientMode) => {
      assert.equal(clientMode, 'tauri-http');
      return clientMode;
    }),
    concatMap((clientMode) =>
      defer(() => from(providerButton.count())).pipe(
        tap((count) => assert.equal(count, 0)),
        concatMap(() => defer(() => from(isolatedButton.waitFor({ state: 'visible' })))),
        concatMap(() => defer(() => from(page.getByText('Runtime is ready').waitFor({ state: 'visible', timeout: 45_000 })))),
        concatMap(() =>
          waitUntil(
            () => defer(() => from(requirements.count())).pipe(map((count) => count === 4)),
            20_000,
            'Installed runtime did not render exactly four requirements.',
          ),
        ),
        concatMap(() => defer(() => from(readyRequirements.count()))),
        tap((count) => assert.equal(count, 4)),
        concatMap(() => defer(() => from(requirements.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-requirement-id')))))),
        concatMap((requirementIds) =>
          forkJoin({
            requirementIds: of(requirementIds),
            displayNames: defer(() => from(requirements.locator('strong').allTextContents())),
            captures: from(fixtures).pipe(
              concatMap((fixture) => captureFixture(page, fixture)),
              toArray(),
            ),
          }).pipe(
            map(({ requirementIds: ids, displayNames, captures }) => ({
              clientMode,
              isolatedRuntimeMode: true,
              hostProviderButtonVisible: false,
              requirements: {
                requirementIds: ids,
                displayNames,
                allReady: true,
              },
              captures,
            })),
          ),
        ),
      ),
    ),
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
