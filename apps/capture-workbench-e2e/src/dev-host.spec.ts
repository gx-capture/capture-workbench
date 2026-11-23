// Dev-host preview (dev-host-preview-server.ts): the Workbench dev server
// proxied with the headless capture-workbench-dev-host and deterministic fixture
// runtime. Exercises proxy security rules, token hygiene, and the host-backed
// OCR library journey.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  canConnect,
  launcherReadyLine,
  reserveFreePort,
  stopSpawnedChild,
  waitForLauncherReady,
} from './dev-host-launcher.ts';

const workspaceRoot = resolve(import.meta.dirname, '..', '..', '..');
const fixturePdfPath = fileURLToPath(new URL('./fixtures/two-pages.pdf', import.meta.url));
const upstreamUrl = 'http://localhost:4200';

interface RawHttpResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly bodyText: string;
}

function sendRawHostRequest(
  baseUrl: string,
  options: {
    readonly method: string;
    readonly path: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string | Buffer;
  },
): Promise<RawHttpResult> {
  const parsed = new URL(baseUrl);
  const payload = options.body === undefined
    ? Buffer.alloc(0)
    : Buffer.isBuffer(options.body)
      ? options.body
      : Buffer.from(options.body, 'utf8');
  return new Promise((resolveDone, rejectDone) => {
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        method: options.method,
        path: options.path,
        headers: {
          host: parsed.host,
          ...options.headers,
          'content-length': String(payload.length),
          connection: 'close',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolveDone({
            status: res.statusCode ?? 0,
            headers: res.headers,
            bodyText: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', rejectDone);
      },
    );
    req.on('error', rejectDone);
    req.end(payload);
  });
}

function corsHeaderNames(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): string[] {
  return Object.keys(headers).filter((name) =>
    name.toLowerCase().startsWith('access-control-allow-'),
  );
}

/** The dev host's bearer token is 64 hexadecimal characters. */
const tokenShaped = /[0-9a-f]{64}/iu;

function expectedDeterministicPdfText(pdfBytes: Buffer): string {
  const marker = Buffer.from('CAPTURE_TEXT:', 'utf8');
  const markerIndex = pdfBytes.indexOf(marker);
  if (markerIndex >= 0) {
    const raw = pdfBytes
      .subarray(markerIndex + marker.length)
      .toString('utf8')
      .replace(/^[\0\r\n ]+|[\0\r\n ]+$/gu, '');
    if (raw.length > 0) {
      return raw.split('\f').map((part) => part.trim()).filter(Boolean).join('\n');
    }
  }
  const digest = createHash('sha256').update(pdfBytes).digest('hex');
  return `Deterministic pdf capture ${digest.slice(0, 12)}`;
}

test('refuses unauthorized proxy requests, omits CORS and tokens, and bridges errors cleanly', async ({ page, baseURL }) => {
  const originUrl = baseURL ?? 'http://127.0.0.1:4313';
  const validHeaders = {
    'content-type': 'application/json',
    'x-capture-preview': '1',
  };

  const statusBefore = await sendRawHostRequest(originUrl, {
    method: 'POST',
    path: '/__host/invoke/desktop_runtime_status',
    headers: validHeaders,
    body: '{}',
  });
  expect(statusBefore.status).toBe(200);
  expect(corsHeaderNames(statusBefore.headers)).toEqual([]);

  const refusals = [
    await sendRawHostRequest(originUrl, {
      method: 'POST',
      path: '/__host/invoke/desktop_runtime_status',
      headers: { ...validHeaders, origin: 'https://evil.example' },
      body: '{}',
    }),
    await sendRawHostRequest(originUrl, {
      method: 'POST',
      path: '/__host/invoke/desktop_runtime_status',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
    await sendRawHostRequest(originUrl, {
      method: 'POST',
      path: '/__host/invoke/desktop_runtime_status',
      headers: { ...validHeaders, host: 'evil.example' },
      body: '{}',
    }),
    await sendRawHostRequest(originUrl, {
      method: 'POST',
      path: '/__host/invoke/desktop_runtime_status',
      headers: { ...validHeaders, host: '127.0.0.1:1' },
      body: '{}',
    }),
    await sendRawHostRequest(originUrl, {
      method: 'POST',
      path: '/__host/invoke/desktop_runtime_status',
      headers: { ...validHeaders, 'sec-fetch-site': 'cross-site' },
      body: '{}',
    }),
    await sendRawHostRequest(originUrl, {
      method: 'GET',
      path: '/__host/invoke/desktop_runtime_status',
      headers: validHeaders,
    }),
    await sendRawHostRequest(originUrl, {
      method: 'OPTIONS',
      path: '/__host/invoke/desktop_runtime_status',
      headers: validHeaders,
    }),
    await sendRawHostRequest(originUrl, {
      method: 'POST',
      path: '/__host/dev/shutdown',
      headers: validHeaders,
      body: '{}',
    }),
    await sendRawHostRequest(originUrl, {
      method: 'POST',
      path: '/__host/__dev/shutdown',
      headers: validHeaders,
      body: '{}',
    }),
    await sendRawHostRequest(originUrl, {
      method: 'POST',
      path: '/__host/__dev/health',
      headers: validHeaders,
      body: '{}',
    }),
    await sendRawHostRequest(originUrl, {
      method: 'POST',
      path: '/__host/invoke/../__dev/shutdown',
      headers: validHeaders,
      body: '{}',
    }),
  ];
  for (const refused of refusals) {
    expect(refused.status).toBe(403);
    expect(corsHeaderNames(refused.headers)).toEqual([]);
  }

  const badContentType = await sendRawHostRequest(originUrl, {
    method: 'POST',
    path: '/__host/invoke/desktop_runtime_status',
    headers: { 'content-type': 'text/plain', 'x-capture-preview': '1' },
    body: '{}',
  });
  expect(badContentType.status).toBe(400);
  expect(corsHeaderNames(badContentType.headers)).toEqual([]);

  const oversized = await sendRawHostRequest(originUrl, {
    method: 'POST',
    path: '/__host/invoke/desktop_runtime_status',
    headers: validHeaders,
    body: Buffer.alloc(1024 * 1024 + 1, 97),
  });
  expect(oversized.status).toBe(400);
  expect(corsHeaderNames(oversized.headers)).toEqual([]);

  const statusAfter = await sendRawHostRequest(originUrl, {
    method: 'POST',
    path: '/__host/invoke/desktop_runtime_status',
    headers: validHeaders,
    body: '{}',
  });
  expect(statusAfter.status).toBe(200);

  await page.context().addCookies([
    {
      name: 'capture-preview-scenario',
      value: 'first-run',
      url: originUrl,
    },
  ]);

  const previewRes = await page.request.get('/__preview');
  expect(previewRes.status()).toBe(200);
  const previewHtml = await previewRes.text();
  expect(previewHtml).toContain('確定性測試 runtime');
  expect(previewHtml).not.toContain('Bearer');

  const homeRes = await page.request.get('/ocr');
  expect(homeRes.status()).toBe(200);
  const homeHtml = await homeRes.text();
  expect(homeHtml).toContain('__TAURI_INTERNALS__');
  expect(homeHtml).not.toContain('Bearer');

  await page.goto('/ocr');
  const bridgeChecks = await page.evaluate(async () => {
    const win = globalThis as unknown as {
      isTauri?: boolean;
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: string } };
        convertFileSrc: (path: string) => string;
        invoke: (command: string, args?: unknown) => Promise<unknown>;
      };
    };
    const watchResult = await win.__TAURI_INTERNALS__.invoke(
      'library_watch_native_sources',
      { onEvent: 'channel-placeholder' },
    );
    let unservedError = '';
    try {
      await win.__TAURI_INTERNALS__.invoke('desktop_close_window', {});
    } catch (error) {
      unservedError = String(error);
    }
    let commandError = '';
    try {
      await win.__TAURI_INTERNALS__.invoke('library_get', {
        request: { documentId: 'invalid' },
      });
    } catch (error) {
      commandError = String(error);
    }
    return {
      isTauri: win.isTauri,
      windowLabel: win.__TAURI_INTERNALS__.metadata.currentWindow.label,
      assetUrl: win.__TAURI_INTERNALS__.convertFileSrc('sample.pdf'),
      watchResult,
      unservedError,
      commandError,
    };
  });
  expect(bridgeChecks.isTauri).toBe(true);
  expect(bridgeChecks.windowLabel).toBe('main');
  expect(bridgeChecks.assetUrl).toContain('sample.pdf');
  expect(bridgeChecks.watchResult).toBeNull();
  expect(bridgeChecks.unservedError).toContain('desktop_close_window');
  expect(bridgeChecks.commandError).toBe('Capture library document identifier is invalid.');
});

test('launcher prints only its ready line and keeps tokens out of stdout/stderr', async () => {
  const port = await reserveFreePort();
  // Under the run's private temp root (tools/test-temp-root.ts, preloaded by
  // the e2e-dev-host target), which is removed when the run ends.
  const childTempRoot = join(tmpdir(), `launcher-check-${port}`);
  mkdirSync(childTempRoot, { recursive: true });

  const child = spawn(
    process.execPath,
    ['apps/capture-workbench-e2e/dev-host-preview-server.ts', String(port), upstreamUrl],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        TEMP: childTempRoot,
        TMP: childTempRoot,
        TMPDIR: childTempRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  try {
    const readyLine = await waitForLauncherReady(child, () => stdout, () => stderr);
    expect(readyLine.trimEnd()).toMatch(launcherReadyLine(port));

    const childOrigin = `http://127.0.0.1:${port}`;
    const pageHtml = await sendRawHostRequest(childOrigin, { method: 'GET', path: '/ocr' });
    expect(pageHtml.status).toBe(200);
    expect(pageHtml.bodyText).not.toContain('Bearer');
    expect(pageHtml.bodyText).not.toMatch(tokenShaped);

    const statusRes = await sendRawHostRequest(childOrigin, {
      method: 'POST',
      path: '/__host/invoke/desktop_runtime_status',
      headers: { 'content-type': 'application/json', 'x-capture-preview': '1' },
      body: '{}',
    });
    expect(statusRes.status).toBe(200);

    const refusedRes = await sendRawHostRequest(childOrigin, {
      method: 'GET',
      path: '/__host/dev/shutdown',
      headers: { 'content-type': 'application/json', 'x-capture-preview': '1' },
    });
    expect(refusedRes.status).toBe(403);

    const lines = stdout.trimEnd().split(/\r?\n/u);
    expect(lines).toHaveLength(1);
    expect(stdout).not.toContain('Bearer');
    expect(stdout).not.toMatch(tokenShaped);
    expect(stderr).toBe('');
  } finally {
    await stopSpawnedChild(child);
    rmSync(childTempRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

test('the dev host stops when the launcher is killed without a chance to clean up', async () => {
  const port = await reserveFreePort();
  const childTempRoot = join(tmpdir(), `launcher-kill-${port}`);
  mkdirSync(childTempRoot, { recursive: true });

  const child = spawn(
    process.execPath,
    ['apps/capture-workbench-e2e/dev-host-preview-server.ts', String(port), upstreamUrl],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        TEMP: childTempRoot,
        TMP: childTempRoot,
        TMPDIR: childTempRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  try {
    const readyLine = await waitForLauncherReady(child, () => stdout, () => stderr);
    const devHostPort = Number(launcherReadyLine(port).exec(readyLine.trimEnd())?.[1]);
    expect(Number.isInteger(devHostPort) && devHostPort > 0).toBe(true);
    expect(await canConnect(devHostPort)).toBe(true);

    // Ends the launcher alone, the way Task Manager does: no handler runs and
    // no other process is told.
    child.kill('SIGKILL');

    await expect
      .poll(() => canConnect(devHostPort), { timeout: 15_000, intervals: [250] })
      .toBe(false);
  } finally {
    await stopSpawnedChild(child);
    rmSync(childTempRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
});

test('runs the full OCR document journey against the real dev host and persists across reloads', async ({ page }) => {
  const pdfBytes = await readFile(fixturePdfPath);
  const expectedText = expectedDeterministicPdfText(pdfBytes);

  await page.goto('/ocr');
  const nav = page.getByRole('navigation', { name: '主要功能' });
  await expect(nav.getByTestId('runtime-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('first-run-card')).toHaveCount(0);
  await expect(page.getByTestId('ocr-choose-files')).toBeEnabled();

  const queueResponse = await page.request.post('/__host/selection', {
    headers: { 'x-capture-preview': '1' },
    data: { paths: [fixturePdfPath] },
  });
  expect(queueResponse.status()).toBe(200);
  expect(await queueResponse.json()).toEqual({ queued: 1 });

  await page.getByTestId('ocr-choose-files').click();

  const row = page.locator('[data-testid="ocr-queue-row"]', { hasText: 'two-pages.pdf' });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toHaveAttribute('data-user-status', 'done', { timeout: 30_000 });

  await row.getByTestId('ocr-row-view').click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f]{32}\/content$/u);

  const pageText = page.getByTestId('result-page-text');
  await expect(pageText).toHaveValue(expectedText, { timeout: 15_000 });

  const pdfCanvas = page.getByTestId('result-source-pdf-canvas');
  await expect(pdfCanvas).toHaveAttribute('data-rendered-page', '1', { timeout: 30_000 });
  const canvasWidth = await pdfCanvas.evaluate((el: HTMLCanvasElement) => el.width);
  expect(canvasWidth).toBeGreaterThan(0);

  await page.reload();
  await expect(nav.getByTestId('runtime-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 30_000,
  });
  await expect(pageText).toHaveValue(expectedText, { timeout: 15_000 });
  await expect(pdfCanvas).toHaveAttribute('data-rendered-page', '1', { timeout: 30_000 });

  await nav.getByRole('link', { name: '紀錄' }).click();
  await expect(page).toHaveURL(/\/history$/u);
  const historyRow = page.getByTestId('history-row').filter({ hasText: 'two-pages.pdf' });
  await expect(historyRow).toBeVisible();

  await historyRow.getByTestId('history-row-delete').click();
  await expect(page.getByTestId('history-delete-dialog')).toContainText('two-pages.pdf');
  await page.getByTestId('history-delete-confirm').click();
  await expect(historyRow).toHaveCount(0);

  await page.reload();
  await expect(nav.getByTestId('runtime-status')).toHaveAttribute('data-state', 'ready', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('history-empty')).toBeVisible();
  await expect(page.getByTestId('history-row').filter({ hasText: 'two-pages.pdf' })).toHaveCount(0);
});
