import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from '@playwright/test';
import { firstValueFrom } from 'rxjs';
import {
  isPackagedWorkbenchUrl,
  navigatePackagedRoute,
} from './packaged-workbench-page.ts';

test('packaged page lookup accepts every route of the packaged app and nothing else', () => {
  assert.equal(isPackagedWorkbenchUrl('http://tauri.localhost/'), true);
  assert.equal(isPackagedWorkbenchUrl('http://tauri.localhost/ocr'), true);
  assert.equal(isPackagedWorkbenchUrl('http://tauri.localhost/history'), true);
  assert.equal(isPackagedWorkbenchUrl('about:blank'), false);
  assert.equal(isPackagedWorkbenchUrl('http://localhost:4200/history'), false);
  assert.equal(isPackagedWorkbenchUrl('not a url'), false);
});

test('route navigation pushes the path and dispatches popstate in the page', async () => {
  const pushed: string[] = [];
  const events: string[] = [];
  await firstValueFrom(
    navigatePackagedRoute(fakePage('http://tauri.localhost/ocr', pushed, events), '/asr'),
  );

  assert.deepEqual(pushed, ['/asr']);
  assert.deepEqual(events, ['popstate']);
});

test('route navigation leaves a page that is already on the route alone', async () => {
  const pushed: string[] = [];
  const events: string[] = [];
  await firstValueFrom(
    navigatePackagedRoute(fakePage('http://tauri.localhost/asr', pushed, events), '/asr'),
  );

  assert.deepEqual(pushed, []);
  assert.deepEqual(events, []);
});

test('route navigation rejects a path that is not absolute', () => {
  assert.throws(
    () => navigatePackagedRoute(fakePage('http://tauri.localhost/ocr', [], []), 'asr'),
    /must start with '\/'/u,
  );
});

// Runs the function the helper hands to `page.evaluate` against stand-ins for
// the page's globals, so the test covers what really executes in the WebView.
function fakePage(url: string, pushed: string[], events: string[]): Page {
  return {
    url: () => url,
    evaluate: async (pageFunction: (routePath: string) => void, routePath: string) => {
      const scope = globalThis as unknown as Record<string, unknown>;
      const previous = {
        location: Object.getOwnPropertyDescriptor(scope, 'location'),
        history: Object.getOwnPropertyDescriptor(scope, 'history'),
        dispatchEvent: Object.getOwnPropertyDescriptor(scope, 'dispatchEvent'),
      };
      const define = (name: string, value: unknown): void => {
        Object.defineProperty(scope, name, { value, configurable: true, writable: true });
      };
      define('location', { pathname: new URL(url).pathname });
      define('history', {
        pushState: (_state: unknown, _title: string, path: string) => pushed.push(path),
      });
      define('dispatchEvent', (event: Event) => {
        events.push(event.type);
        return true;
      });
      try {
        pageFunction(routePath);
      } finally {
        for (const [name, descriptor] of Object.entries(previous)) {
          if (descriptor) Object.defineProperty(scope, name, descriptor);
          else delete scope[name];
        }
      }
    },
  } as unknown as Page;
}
