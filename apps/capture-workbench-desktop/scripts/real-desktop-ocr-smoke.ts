import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium } from '@playwright/test';

import { assertStagedRuntime } from './assert-staged-runtime.ts';
import { assertRedactedEvidence } from './package-qa.ts';
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
const productIdentifier = 'io.github.wodenwang820118.capture-workbench';
const maxSourceBytes = 50 * 1024 * 1024;
export const realDesktopRuntimeReadyTimeoutMs = 3 * 60_000;

interface RealDesktopSmokeEvidence {
  readonly evidenceKind: 'real-standalone-tauri-ui-ocr';
  readonly releaseGateSatisfied: true;
  readonly realEnginesExercised: true;
  readonly sourceKind: 'pdf';
  readonly rawOcrVisible: true;
  readonly structuringEngine: 'ollama';
  readonly model: 'capture-workbench-qwen3.5-4b-structure-v1';
  readonly modelDigest: string;
  readonly documentDeletedAfterVerification: true;
}

export function assertRealDesktopSmokeEvidence(value: unknown): asserts value is RealDesktopSmokeEvidence {
  const report = value as Partial<RealDesktopSmokeEvidence> | undefined;
  assert.equal(report?.evidenceKind, 'real-standalone-tauri-ui-ocr');
  assert.equal(report?.releaseGateSatisfied, true);
  assert.equal(report?.realEnginesExercised, true);
  assert.equal(report?.sourceKind, 'pdf');
  assert.equal(report?.rawOcrVisible, true);
  assert.equal(report?.structuringEngine, 'ollama');
  assert.equal(report?.model, 'capture-workbench-qwen3.5-4b-structure-v1');
  assert.match(report?.modelDigest ?? '', /^sha256:[a-f0-9]{64}$/u);
  assert.equal(report?.documentDeletedAfterVerification, true);

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /[A-Za-z]:[\\/]/u);
  assertRedactedEvidence(report);
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('Real standalone desktop OCR smoke requires Windows x64.');
  }

  const sourcePath = requiredPath('CAPTURE_REAL_DESKTOP_OCR_PDF');
  const appData = requiredPath('CAPTURE_REAL_DESKTOP_APP_DATA');
  const desktopExecutable = resolve(
    process.env.CAPTURE_REAL_DESKTOP_EXECUTABLE?.trim() || defaultDesktopExecutable,
  );
  await requireRegularFile(sourcePath, 'CAPTURE_REAL_DESKTOP_OCR_PDF');
  await requireDirectory(appData, 'CAPTURE_REAL_DESKTOP_APP_DATA');
  await requireRegularFile(desktopExecutable, 'CAPTURE_REAL_DESKTOP_EXECUTABLE');
  assertConfiguredHostAppData(appData);

  const sourceBytes = await readFile(sourcePath);
  if (sourceBytes.length === 0 || sourceBytes.length > maxSourceBytes) {
    throw new Error(`CAPTURE_REAL_DESKTOP_OCR_PDF must contain 1 through ${maxSourceBytes} bytes.`);
  }

  await observe(assertStagedRuntime('release'));
  await mkdir(outputDirectory, { recursive: true });

  const cdpPort = await reservePort();
  const runId = randomUUID();
  const webViewData = join(outputDirectory, `webview2-${runId}`);
  const sourceName = `standalone-real-ocr-${runId}.pdf`;
  const app = spawn(desktopExecutable, [], {
    cwd: resolve(desktopExecutable, '..'),
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: webViewData,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort} --remote-allow-origins=*`,
    },
    stdio: 'ignore',
    windowsHide: true,
  });

  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    browser = await waitUntil(
      () => chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 1_500 }).catch(() => undefined),
      60_000,
      'Standalone desktop WebView2 CDP was not ready.',
    );
    const page = await waitUntil(
      () => Promise.resolve(
        browser.contexts().flatMap((context) => context.pages())
          .find((candidate) => candidate.url() === 'http://tauri.localhost/'),
      ),
      30_000,
      'Standalone desktop application page was unavailable.',
    );
    await page.waitForLoadState('domcontentloaded');

    const intake = page.getByLabel('選擇檔案');
    await waitUntil(
      () => intake.isEnabled().then((enabled) => enabled || undefined),
      realDesktopRuntimeReadyTimeoutMs,
      'Standalone desktop runtime did not become ready. Prepare the consented WindowsML and Ollama requirements in the configured app data first.',
    );
    await intake.setInputFiles({
      name: sourceName,
      mimeType: 'application/pdf',
      buffer: sourceBytes,
    });

    const card = page.locator('.document-card').filter({ hasText: sourceName }).last();
    await card.waitFor({ state: 'visible', timeout: 15_000 });
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
    const structured = parseStructuredProvenance(provenance);
    if (
      structured.engine !== 'ollama' ||
      structured.model !== 'capture-workbench-qwen3.5-4b-structure-v1' ||
      !/^sha256:[a-f0-9]{64}$/u.test(structured.digest) ||
      !provenance.join(' ').includes('capture-workbench-qwen3.5-4b-structure-v1')
    ) {
      throw new Error('Standalone desktop UI did not display isolated Ollama provenance.');
    }

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '刪除', exact: true }).click();
    await card.waitFor({ state: 'hidden', timeout: 30_000 });

    const report: RealDesktopSmokeEvidence = {
      evidenceKind: 'real-standalone-tauri-ui-ocr',
      releaseGateSatisfied: true,
      realEnginesExercised: true,
      sourceKind: 'pdf',
      rawOcrVisible: true,
      structuringEngine: 'ollama',
      model: 'capture-workbench-qwen3.5-4b-structure-v1',
      modelDigest: structured.digest,
      documentDeletedAfterVerification: true,
    };
    assertRealDesktopSmokeEvidence(report);
    await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`Real standalone desktop OCR smoke report: ${evidencePath}\n`);
  } finally {
    await browser?.close().catch(() => undefined);
    terminateOwnedTree(app.pid);
  }
}

function parseStructuredProvenance(provenance: readonly string[]): { engine: string; model: string; digest: string } {
  const value = provenance.find((entry) => entry.includes('capture-workbench-qwen3.5-4b-structure-v1')) ?? '';
  const [engine = '', model = '', digest = ''] = value.split(' · ').map((entry) => entry.trim());
  return { engine, model, digest };
}

function assertConfiguredHostAppData(appData: string): void {
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
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    await delay(250);
  }
  throw new Error(message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function terminateOwnedTree(pid: number | undefined): void {
  if (pid) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
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
