import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from '@playwright/test';
import { firstValueFrom } from 'rxjs';
import {
  isPackagedWorkbenchUrl,
  SHOW_HISTORY_WORKSPACE_EXPRESSION,
  showHistoryWorkspace,
} from './packaged-workbench-page.ts';

test('packaged page lookup accepts every route of the packaged app and nothing else', () => {
  assert.equal(isPackagedWorkbenchUrl('http://tauri.localhost/'), true);
  assert.equal(isPackagedWorkbenchUrl('http://tauri.localhost/ocr'), true);
  assert.equal(isPackagedWorkbenchUrl('http://tauri.localhost/history'), true);
  assert.equal(isPackagedWorkbenchUrl('about:blank'), false);
  assert.equal(isPackagedWorkbenchUrl('http://localhost:4200/history'), false);
  assert.equal(isPackagedWorkbenchUrl('not a url'), false);
});

test('history workspace navigates via pushState + popstate and waits for the workspace', async () => {
  const steps: string[] = [];
  await firstValueFrom(
    showHistoryWorkspace(fakePage('http://tauri.localhost/ocr', steps)),
  );

  assert.deepEqual(steps, [
    'evaluate /workspace',
    'wait workbench-root attached',
  ]);
});

test('history workspace is left alone when it is already shown', async () => {
  const steps: string[] = [];
  await firstValueFrom(
    showHistoryWorkspace(fakePage('http://tauri.localhost/workspace', steps)),
  );

  assert.deepEqual(steps, []);
});

test('CDP probe expression pushes /workspace and dispatches popstate only away from the legacy workspace', () => {
  const pushed: string[] = [];
  const events: string[] = [];
  const run = (pathname: string) =>
    new Function(
      'location',
      'history',
      'dispatchEvent',
      SHOW_HISTORY_WORKSPACE_EXPRESSION,
    )(
      { pathname },
      { pushState: (_s: unknown, _t: string, url: string) => pushed.push(url) },
      (event: Event) => events.push(event.type),
    );

  run('/workspace');
  assert.deepEqual(pushed, []);
  assert.deepEqual(events, []);
  run('/ocr');
  assert.deepEqual(pushed, ['/workspace']);
  assert.deepEqual(events, ['popstate']);
  run('/history');
  assert.deepEqual(pushed, ['/workspace', '/workspace']);
  assert.deepEqual(events, ['popstate', 'popstate']);
});

function fakePage(url: string, steps: string[]): Page {
  return {
    url: () => url,
    evaluate: async (_fn: unknown, path: string) => {
      steps.push(`evaluate ${path}`);
    },
    getByTestId: (testId: string) => ({
      waitFor: async (options: { state: string }) => {
        steps.push(`wait ${testId} ${options.state}`);
      },
    }),
  } as unknown as Page;
}
