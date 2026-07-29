import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium, type Page } from '@playwright/test';

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
const productIdentifier = 'io.github.gx-capture.capture-workbench';
const maxSourceBytes = 50 * 1024 * 1024;
const ownedSmokeDocumentPattern =
  /^standalone-real-ocr-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/u;
export const realDesktopRuntimeReadyTimeoutMs = 3 * 60_000;
type OcrDevice = 'windowsml-dml' | 'cpu';

interface RealDesktopSmokeEvidence {
  readonly evidenceKind: 'real-standalone-tauri-ui-ocr';
  readonly releaseGateSatisfied: true;
  readonly realEnginesExercised: true;
  readonly sourceKind: 'pdf';
  readonly rawOcrVisible: true;
  readonly ocrDevice: OcrDevice;
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
  assert.ok(report?.ocrDevice === 'windowsml-dml' || report?.ocrDevice === 'cpu');
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

  const expectedOcrDevice = resolveExpectedOcrDevice(
    process.argv.slice(2),
    process.env.CAPTURE_REAL_DESKTOP_EXPECTED_OCR_DEVICE,
  );
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
  let page: Page | undefined;
  try {
    browser = await waitUntil(
      () => chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 1_500 }).catch(() => undefined),
      60_000,
      'Standalone desktop WebView2 CDP was not ready.',
    );
    page = await waitUntil(
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
    await deleteCompletedOwnedSmokeDocuments(page);
    await intake.setInputFiles({
      name: sourceName,
      mimeType: 'application/pdf',
      buffer: sourceBytes,
    });

    const card = exactDocumentCard(page, sourceName);
    await card.waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(
      await card.count(),
      1,
      'Standalone desktop smoke filename must identify exactly one document.',
    );
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
    const ocr = parseOcrProvenance(provenance);
    assertExpectedOcrDevice(ocr.device, expectedOcrDevice);
    if (
      structured.engine !== 'ollama' ||
      structured.model !== 'capture-workbench-qwen3.5-4b-structure-v1' ||
      !/^sha256:[a-f0-9]{64}$/u.test(structured.digest) ||
      !provenance.join(' ').includes('capture-workbench-qwen3.5-4b-structure-v1')
    ) {
      throw new Error('Standalone desktop UI did not display isolated Ollama provenance.');
    }

    if (!(await deleteCompletedDocument(page, sourceName))) {
      throw new Error('Standalone desktop smoke document was not deleted after verification.');
    }

    const report: RealDesktopSmokeEvidence = {
      evidenceKind: 'real-standalone-tauri-ui-ocr',
      releaseGateSatisfied: true,
      realEnginesExercised: true,
      sourceKind: 'pdf',
      rawOcrVisible: true,
      ocrDevice: ocr.device,
      structuringEngine: 'ollama',
      model: 'capture-workbench-qwen3.5-4b-structure-v1',
      modelDigest: structured.digest,
      documentDeletedAfterVerification: true,
    };
    assertRealDesktopSmokeEvidence(report);
    await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`Real standalone desktop OCR smoke report: ${evidencePath}\n`);
  } finally {
    if (page) {
      await deleteCompletedDocument(page, sourceName).catch((error: unknown) => {
        process.stderr.write(
          `Standalone desktop smoke cleanup warning: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      });
    }
    await browser?.close().catch(() => undefined);
    terminateOwnedTree(app.pid);
  }
}

function parseStructuredProvenance(provenance: readonly string[]): { engine: string; model: string; digest: string } {
  const value = provenance.find((entry) => entry.includes('capture-workbench-qwen3.5-4b-structure-v1')) ?? '';
  const [engine = '', model = '', digest = ''] = value.split(' · ').map((entry) => entry.trim());
  return { engine, model, digest };
}

export function parseOcrProvenance(
  provenance: readonly string[],
): {
  engine: 'windowsml-ocr' | 'pdf-embedded+windowsml-ocr';
  model: string;
  device: OcrDevice;
} {
  const value = provenance.find(
    (entry) =>
      entry.startsWith('windowsml-ocr · ') ||
      entry.startsWith('pdf-embedded+windowsml-ocr · '),
  ) ?? '';
  const [engine = '', model = '', device = ''] = value.split(' · ').map((entry) => entry.trim());
  if (
    (engine !== 'windowsml-ocr' && engine !== 'pdf-embedded+windowsml-ocr') ||
    !model ||
    (device !== 'windowsml-dml' && device !== 'cpu')
  ) {
    throw new Error('Standalone desktop UI did not display a recognized OCR device provenance.');
  }
  return { engine, model, device };
}

export function resolveExpectedOcrDevice(
  arguments_: readonly string[],
  environmentValue?: string,
): OcrDevice | undefined {
  const option = '--expected-ocr-device';
  const optionIndexes = arguments_
    .map((argument, index) => (argument === option ? index : -1))
    .filter((index) => index >= 0);
  if (optionIndexes.length > 1) {
    throw new Error(`${option} may be supplied only once.`);
  }
  const value =
    optionIndexes.length === 1
      ? arguments_[optionIndexes[0] + 1]?.trim()
      : environmentValue?.trim();
  if (value === undefined || value === '') return undefined;
  if (value !== 'windowsml-dml' && value !== 'cpu') {
    throw new Error(`${option} must be windowsml-dml or cpu.`);
  }
  return value;
}

export function assertExpectedOcrDevice(
  actual: OcrDevice,
  expected: OcrDevice | undefined,
): void {
  if (expected !== undefined && actual !== expected) {
    throw new Error(`Standalone desktop OCR used ${actual}; expected ${expected}.`);
  }
}

export function isOwnedSmokeDocumentName(value: string): boolean {
  return ownedSmokeDocumentPattern.test(value);
}

async function deleteCompletedOwnedSmokeDocuments(page: Page): Promise<void> {
  const names = await page.locator('.document-copy strong').allTextContents();
  for (const name of names.filter(isOwnedSmokeDocumentName)) {
    await deleteCompletedDocument(page, name);
  }
}

function exactDocumentCard(page: Page, fileName: string) {
  const exactName = page.getByText(fileName, { exact: true });
  return page.locator('button.document-card').filter({ has: exactName });
}

async function deleteCompletedDocument(page: Page, fileName: string): Promise<boolean> {
  const card = exactDocumentCard(page, fileName);
  if ((await card.count()) === 0) return false;
  assert.equal(
    await card.count(),
    1,
    'Standalone desktop cleanup filename must identify exactly one document.',
  );
  if ((await card.locator('.status').getAttribute('data-status')) !== 'completed') return false;
  await card.click();
  const detailPane = page.locator('.detail-pane');
  const selectedFileName = await detailPane.locator('.detail-heading h2').textContent();
  assert.equal(
    selectedFileName?.trim(),
    fileName,
    'Standalone desktop cleanup must verify the exact selected filename.',
  );
  page.once('dialog', (dialog) => dialog.accept());
  await detailPane.getByRole('button', { name: '刪除', exact: true }).click();
  await card.waitFor({ state: 'hidden', timeout: 30_000 });
  return true;
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
