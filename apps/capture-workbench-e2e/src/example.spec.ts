import { expect, test, type Page } from '@playwright/test';

test('shows the deterministic runtime capability and requirements', async ({ page }) => {
  await openDeterministic(page);
  await expect(page.getByRole('heading', { name: 'Packaged workflow validation host' })).toBeVisible();
  await expect(page.locator('.client-mode')).toHaveAttribute(
    'data-client-mode',
    'deterministic-e2e',
  );
  await expect(page.getByRole('button', { name: 'Host provider interface' })).toBeVisible();
  await expect(page.getByText('Runtime is ready')).toBeVisible();
  await expect(page.getByLabel('Runtime requirements').getByRole('listitem')).toHaveCount(4);
});

test('does not offer host structuring in an unconfigured browser', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('.client-mode')).toHaveAttribute(
    'data-client-mode',
    'browser-unconfigured',
  );
  await expect(page.getByRole('button', { name: 'Host provider interface' })).toHaveCount(0);
});

test('completes a PDF through isolated runtime structuring', async ({ page }) => {
  await openDeterministic(page);
  await page.getByLabel('Choose files').setInputFiles({
    name: 'authorized-fixture.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('Authorized PDF fixture text'),
  });

  const task = page.getByRole('listitem').filter({ hasText: 'authorized-fixture.pdf' });
  await expect(task).toHaveAttribute('data-task-status', 'completed');
  await expect(task.getByText('Authorized PDF fixture text')).toBeVisible();
  await expect(page.getByText('Completed authorized-fixture.pdf')).toBeVisible();
});

test('commits a host-provider candidate before emitting completion', async ({ page }) => {
  await openDeterministic(page);
  await page.getByRole('button', { name: 'Host provider interface' }).click();
  await expect(page.getByText('Raw extraction uses Capture Runtime')).toBeVisible();

  await page.getByLabel('Choose files').setInputFiles({
    name: 'authorized-voice.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from('Authorized audio fixture transcript'),
  });

  const task = page.getByRole('listitem').filter({ hasText: 'authorized-voice.wav' });
  await expect(task).toHaveAttribute('data-task-status', 'completed');
  await expect(task.getByText('host-provider-fake')).toBeVisible();
  await expect(page.getByText('Completed authorized-voice.wav')).toBeVisible();
});

test('selects the HTTP client and ignores fixture queries in packaged Tauri', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    interface TauriTestGlobal {
      isTauri: boolean;
      __captureInvokedCommands: string[];
      __captureHttpCalls: Array<{ readonly url: string; readonly hadBearer: boolean }>;
      __TAURI_INTERNALS__: {
        invoke: (command: string) => Promise<unknown>;
      };
    }
    const target = globalThis as unknown as TauriTestGlobal;
    target.isTauri = true;
    target.__captureInvokedCommands = [];
    target.__captureHttpCalls = [];
    target.__TAURI_INTERNALS__ = {
      invoke: (command: string): Promise<unknown> => {
        target.__captureInvokedCommands.push(command);
        if (command === 'desktop_runtime_status') {
          return Promise.resolve({
            status: 'ready',
            detail: 'Capture runtime is ready.',
            baseUrl: 'http://127.0.0.1:43119',
            runtimeVersion: '0.3.0',
            apiVersion: '1.0',
            captureDocumentSchemaVersion: '1',
          });
        }
        if (command !== 'backend_config') return Promise.reject(new Error('Unexpected command'));
        return Promise.resolve({
          baseUrl: 'http://127.0.0.1:43119',
          token: 'memory-only-e2e-token',
          runtimeVersion: '0.3.0',
          apiVersion: '1.0',
          captureDocumentSchemaVersion: '1',
        });
      },
    };
    globalThis.fetch = (input, init): Promise<Response> => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      target.__captureHttpCalls.push({ url, hadBearer: headers.has('Authorization') });
      const path = new URL(url).pathname;
      if (path === '/v1/health/ready') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ready: true,
              service: 'capture-runtime',
              runtimeVersion: '0.3.0',
              apiVersion: '1.0',
              captureDocumentSchemaVersion: '1',
              capabilities: {
                captureKinds: ['pdf', 'image', 'audio'],
                structuringModes: ['runtime', 'host'],
                supportsCancellation: true,
                supportsRawDiagnostics: true,
                maxUploadBytes: 25_000_000,
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (path === '/v1/runtime/requirements') {
        return Promise.resolve(
          new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };
  });
  await page.goto('/');

  expect(pageErrors).toEqual([]);
  await expect(page.locator('.client-mode')).toHaveAttribute('data-client-mode', 'tauri-http');
  await expect(page.getByRole('button', { name: 'Host provider interface' })).toHaveCount(0);
  await expect(page.getByText('Runtime is ready')).toBeVisible();
  const evidence = await page.evaluate(() => {
    const target = globalThis as unknown as {
      readonly __captureInvokedCommands: readonly string[];
      readonly __captureHttpCalls: ReadonlyArray<{
        readonly url: string;
        readonly hadBearer: boolean;
      }>;
    };
    return {
      commands: target.__captureInvokedCommands,
      calls: target.__captureHttpCalls,
    };
  });
  expect(evidence.commands).toEqual(['desktop_runtime_status', 'backend_config']);
  expect(evidence.calls).toHaveLength(2);
  expect(evidence.calls.every((call) => call.url.startsWith('http://127.0.0.1:43119/v1/'))).toBe(
    true,
  );
  expect(evidence.calls.every((call) => call.hadBearer)).toBe(true);

  await page.goto('/?captureClient=deterministic-e2e');
  expect(pageErrors).toEqual([]);
  await expect(page.locator('.client-mode')).toHaveAttribute('data-client-mode', 'tauri-http');
  await expect(page.getByRole('button', { name: 'Host provider interface' })).toHaveCount(0);
  await expect(page.getByText('Runtime is ready')).toBeVisible();
  const adversarialCommands = await page.evaluate(
    () =>
      (
        globalThis as unknown as {
          readonly __captureInvokedCommands: readonly string[];
        }
      ).__captureInvokedCommands,
  );
  expect(adversarialCommands).toEqual(['desktop_runtime_status', 'backend_config']);
});

function openDeterministic(page: Page): Promise<unknown> {
  return page.goto('/?captureClient=deterministic-e2e');
}
