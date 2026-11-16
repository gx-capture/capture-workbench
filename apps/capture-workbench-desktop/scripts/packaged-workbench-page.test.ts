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

test('history workspace opens through the status link and waits for the workspace', async () => {
  const steps: string[] = [];
  await firstValueFrom(
    showHistoryWorkspace(fakePage('http://tauri.localhost/ocr', steps)),
  );

  assert.deepEqual(steps, [
    'click runtime-status',
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

test('CDP probe expression clicks the status link only away from the legacy workspace', () => {
  const clicks: string[] = [];
  const run = (pathname: string) =>
    new Function('location', 'document', SHOW_HISTORY_WORKSPACE_EXPRESSION)(
      { pathname },
      {
        querySelector: (selector: string) => ({
          click: () => clicks.push(selector),
        }),
      },
    );

  run('/workspace');
  assert.deepEqual(clicks, []);
  run('/ocr');
  assert.deepEqual(clicks, ['[data-testid="runtime-status"]']);
  run('/history');
  assert.deepEqual(clicks, ['[data-testid="runtime-status"]', '[data-testid="runtime-status"]']);
});

function fakePage(url: string, steps: string[]): Page {
  return {
    url: () => url,
    getByTestId: (testId: string) => ({
      click: async () => {
        steps.push(`click ${testId}`);
      },
      waitFor: async (options: { state: string }) => {
        steps.push(`wait ${testId} ${options.state}`);
      },
    }),
  } as unknown as Page;
}
