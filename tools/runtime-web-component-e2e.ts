import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from 'node:http';
import { createServer as createNetServer } from 'node:net';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { resolveNode24Corepack } from './node24-corepack.ts';

declare global {
  interface Window {
    __captureE2eReady?: boolean;
    __captureE2eCompleted?: boolean;
    __captureE2eFailed?: unknown;
    __captureE2eDetail?: unknown;
    __captureE2eBubbles?: boolean;
    __captureE2eComposed?: boolean;
    __captureRuntimeBaseUrl: string;
    __captureRuntimeToken: string;
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeProjectRoot = join(repoRoot, 'packages', 'capture-runtime');
const runtimeExecutable = join(
  repoRoot,
  'packages',
  'capture-runtime',
  'dist',
  'release',
  'capture-runtime-x86_64-pc-windows-msvc.exe',
);
const ocrWorkerArchive = join(
  repoRoot,
  'packages',
  'capture-runtime',
  'dist',
  'release',
  'capture-engine-ocr-0.3.11-windows-x64.zip',
);
const defaultPdfPath = join(
  repoRoot,
  '..',
  'cert-prep',
  'pdfs',
  '【1】2025年07月N1 真题.pdf',
);
const embeddedTextPdfPath = join(
  repoRoot,
  '..',
  'cert-prep',
  'pdfs',
  '\\u30101\\u30112024\\u5e7412\\u6708\\u65e5\\u8a9eN1\\u771f\\u984c-\\u7248\\u672c1.pdf',
);
const packageManifest = JSON.parse(
  readFileSync(
    join(repoRoot, 'packages', 'capture-angular', 'package.json'),
    'utf8',
  ),
) as { name: string; version: string };
const contractsManifest = JSON.parse(
  readFileSync(
    join(repoRoot, 'packages', 'capture-contracts', 'package.json'),
    'utf8',
  ),
) as { name: string; version: string };
const packageArchive = join(
  repoRoot,
  'dist',
  'packs',
  `${archiveName(packageManifest.name)}-${packageManifest.version}.tgz`,
);
const contractsArchive = join(
  repoRoot,
  'dist',
  'packs',
  `${archiveName(contractsManifest.name)}-${contractsManifest.version}.tgz`,
);
const fixtureBase = resolve(repoRoot, '..', '.cw-phase15');
const corepackCli = resolveNode24Corepack();

function archiveName(packageName: string): string {
  return packageName.replace(/^@/u, '').replace('/', '-');
}

function fileSpec(path: string): string {
  return `file:${path.replaceAll('\\', '/')}`;
}

function writeFixture(
  root: string,
  relativePath: string,
  contents: string,
): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function stopProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    child.kill('SIGTERM');
  }
}

function configuredPdfPath(): string {
  const source = resolve(
    process.env['CAPTURE_PHASE15_E2E_PDF']?.trim() ||
      (readdirSync(join(repoRoot, '..', 'cert-prep', 'pdfs')).find(
        (name) =>
          name.includes('2024') &&
          name.includes('12') &&
          name.includes('N1') &&
          name.toLowerCase().endsWith('.pdf'),
      )
        ? join(
            repoRoot,
            '..',
            'cert-prep',
            'pdfs',
            readdirSync(join(repoRoot, '..', 'cert-prep', 'pdfs')).find(
              (name) =>
                name.includes('2024') &&
                name.includes('12') &&
                name.includes('N1') &&
                name.toLowerCase().endsWith('.pdf'),
            )!,
          )
        : defaultPdfPath),
  );
  if (!existsSync(source)) {
    throw new Error(
      `A real OCR PDF is required. Set CAPTURE_PHASE15_E2E_PDF to an existing PDF; default was ${source}.`,
    );
  }
  if (!source.toLowerCase().endsWith('.pdf')) {
    throw new Error('CAPTURE_PHASE15_E2E_PDF must identify a PDF.');
  }
  return source;
}

interface PdfEmbeddedPage {
  readonly page: number;
  readonly text: string;
}

interface PdfEvidence {
  readonly pageCount: number;
  readonly embeddedPages: readonly PdfEmbeddedPage[];
}

function extractPdfEvidence(path: string): PdfEvidence {
  const extractor = [
    'import json',
    'import sys',
    'from pypdf import PdfReader',
    'reader = PdfReader(sys.argv[1])',
    'embedded_pages = []',
    'for page_number, page in enumerate(reader.pages, start=1):',
    '    text = (page.extract_text() or "").strip()',
    '    if text:',
    '        embedded_pages.append({"page": page_number, "text": text})',
    'print(json.dumps({"pageCount": len(reader.pages), "embeddedPages": embedded_pages}, ensure_ascii=True))',
  ].join('\n');
  const result = spawnSync(
    'uv',
    ['run', '--no-sync', '--python', '3.12', 'python', '-c', extractor, path],
    {
      cwd: runtimeProjectRoot,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not extract embedded PDF text with pypdf: ${result.error?.message || result.stderr || `exit code ${result.status}`}`,
    );
  }
  let evidence: unknown;
  try {
    evidence = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error('pypdf did not return valid PDF evidence JSON.', {
      cause: error,
    });
  }
  if (
    !evidence ||
    typeof evidence !== 'object' ||
    !Number.isInteger((evidence as { pageCount?: unknown }).pageCount) ||
    !Array.isArray((evidence as { embeddedPages?: unknown }).embeddedPages)
  ) {
    throw new Error('pypdf returned an invalid PDF evidence shape.');
  }
  const pageCount = (evidence as { pageCount: number }).pageCount;
  const embeddedPages = (evidence as { embeddedPages: unknown[] })
    .embeddedPages;
  if (
    pageCount < 1 ||
    embeddedPages.some(
      (page): page is PdfEmbeddedPage =>
        !page ||
        typeof page !== 'object' ||
        !Number.isInteger((page as { page?: unknown }).page) ||
        typeof (page as { text?: unknown }).text !== 'string',
    )
  ) {
    throw new Error('pypdf returned invalid embedded PDF page evidence.');
  }
  return { pageCount, embeddedPages: embeddedPages as PdfEmbeddedPage[] };
}

function normalizeExtractedText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\r\n?/gu, '\n')
    .replace(/\s+/gu, ' ')
    .trim();
}

function requireRegularFile(path: string, description: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${description} must be an existing regular file: ${path}`);
  }
}

function assertTemporaryFixture(root: string): void {
  const resolvedRoot = resolve(root);
  const resolvedBase = resolve(fixtureBase);
  const relativeRoot = relative(resolvedBase, resolvedRoot);
  if (
    !relativeRoot ||
    relativeRoot === '..' ||
    relativeRoot.startsWith(`..${sep}`) ||
    isAbsolute(relativeRoot)
  ) {
    throw new Error(
      `Refusing to remove unexpected E2E fixture path: ${resolvedRoot}`,
    );
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to reserve a Phase 1.5 E2E port.'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

async function waitForHttp(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `HTTP server did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError ?? '')}`,
  );
}

async function startWorkerMirror(): Promise<{
  readonly server: HttpServer;
  readonly origin: string;
}> {
  const archiveFileName = basename(ocrWorkerArchive);
  const server = createHttpServer((request, response) => {
    if (request.method !== 'GET' || request.url !== `/${archiveFileName}`) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Length': String(statSync(ocrWorkerArchive).size),
      'Content-Type': 'application/zip',
    });
    const stream = readFileStream(ocrWorkerArchive);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to start the local OCR worker mirror.'));
        return;
      }
      resolvePort(address.port);
    });
  });
  return { server, origin: `http://127.0.0.1:${port}` };
}

function readFileStream(path: string) {
  return createReadStream(path);
}

function closeServer(server: HttpServer | undefined): Promise<void> {
  if (!server || !server.listening) return Promise.resolve();
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function runChecked(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], {
      cwd,
      env: { ...process.env, CI: 'true' },
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          `${command} ${args.join(' ')} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`,
        ),
      );
    });
  });
}

async function startRuntime(
  port: number,
  browserOrigin: string,
  dataDirectory: string,
  workerMirrorOrigin: string,
  installOcrRequired: boolean,
): Promise<{ child: ReturnType<typeof spawn>; token: string }> {
  const token = `capture-runtime-phase-1-5-${randomUUID()}-${randomUUID()}`;
  const child = spawn(runtimeExecutable, ['serve', '--port', String(port)], {
    cwd: dirname(runtimeExecutable),
    env: {
      ...process.env,
      CAPTURE_API_TOKEN: token,
      CAPTURE_STRUCTURING_PROVIDER: 'host',
      CAPTURE_EXTRACTION_PROVIDER: 'runtime',
      CAPTURE_APP_DATA_DIR: dataDirectory,
      CAPTURE_HOST: '127.0.0.1',
      CAPTURE_PORT: String(port),
      CAPTURE_ALLOWED_HOSTS: `127.0.0.1:${port}`,
      CAPTURE_ALLOWED_ORIGINS: browserOrigin,
      CAPTURE_ENABLE_API_DOCS: 'false',
      CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN: '1',
      CAPTURE_SMOKE_WORKER_MIRROR_URL: workerMirrorOrigin,
    },
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.resume();
  try {
    await waitForRuntimeReady(child, port, token);
    if (installOcrRequired) await installOcr(port, token);
    return { child, token };
  } catch (error) {
    stopProcessTree(child);
    throw error;
  }
}

async function waitForRuntimeReady(
  child: ReturnType<typeof spawn>,
  port: number,
  token: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Capture Runtime exited before Phase 1.5 E2E readiness.');
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/health/ready`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const health = (await response.json()) as { service?: unknown };
        if (health.service !== 'capture-runtime') {
          throw new Error('Loopback service is not Capture Runtime.');
        }
        return;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Loopback service is not Capture Runtime.'
      ) {
        throw error;
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error('Capture Runtime did not become ready for Phase 1.5 E2E.');
}

async function installOcr(port: number, token: string): Promise<void> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${token}` };
  const requirementsResponse = await fetch(
    `${baseUrl}/v1/runtime/requirements`,
    {
      headers,
    },
  );
  if (!requirementsResponse.ok) {
    throw new Error(
      `Runtime requirements request failed: ${requirementsResponse.status}`,
    );
  }
  const requirements = (await requirementsResponse.json()) as {
    items?: readonly {
      requirementId?: string;
      status?: string;
      detail?: string;
    }[];
  };
  const ocr = requirements.items?.find(
    (item) => item.requirementId === 'windowsml-ocr',
  );
  if (!ocr || !ocr.status) {
    throw new Error(
      'Packaged runtime did not expose the windowsml-ocr requirement.',
    );
  }
  if (ocr.status === 'ready') return;
  if (ocr.status !== 'installable') {
    throw new Error(
      `Packaged runtime cannot install windowsml-ocr: ${ocr.status}${ocr.detail ? ` (${ocr.detail})` : ''}.`,
    );
  }
  const installationResponse = await fetch(
    `${baseUrl}/v1/runtime/installations`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ requirementId: 'windowsml-ocr', consent: true }),
    },
  );
  if (!installationResponse.ok) {
    throw new Error(
      `OCR installation request failed: ${installationResponse.status}`,
    );
  }
  const installation = (await installationResponse.json()) as {
    installationId?: string;
  };
  if (!installation.installationId) {
    throw new Error(
      'OCR installation response did not contain an installation ID.',
    );
  }
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const statusResponse = await fetch(
      `${baseUrl}/v1/runtime/installations/${encodeURIComponent(installation.installationId)}`,
      { headers },
    );
    if (!statusResponse.ok) {
      throw new Error(
        `OCR installation status request failed: ${statusResponse.status}`,
      );
    }
    const status = (await statusResponse.json()) as {
      status?: string;
      detail?: string;
      error?: { message?: string };
    };
    if (status.status === 'completed') return;
    if (status.status === 'failed' || status.status === 'cancelled') {
      throw new Error(
        `OCR installation ended as ${status.status}: ${status.detail || status.error?.message || 'unknown error'}.`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error('OCR installation did not complete within 15 minutes.');
}

async function startPreview(
  fixtureRoot: string,
  port: number,
): Promise<ReturnType<typeof spawn>> {
  const viteCli = join(fixtureRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(
    process.execPath,
    [viteCli, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: fixtureRoot,
      env: { ...process.env, CI: 'true' },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  child.stderr?.resume();
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`);
    return child;
  } catch (error) {
    stopProcessTree(child);
    throw error;
  }
}

async function main(): Promise<void> {
  if (!existsSync(packageArchive) || !existsSync(contractsArchive)) {
    throw new Error(
      'Packed Capture Workbench and Capture Contracts archives are required. Run capture-angular:pack first.',
    );
  }
  if (!corepackCli) {
    throw new Error(
      'Node Corepack is required to install the isolated E2E consumer.',
    );
  }
  requireRegularFile(
    runtimeExecutable,
    'The packaged Capture Runtime executable',
  );
  requireRegularFile(ocrWorkerArchive, 'The packaged OCR worker archive');
  const sourcePath = configuredPdfPath();
  const sourceBytes = readFileSync(sourcePath);
  if (sourceBytes.length === 0 || sourceBytes.length > 50 * 1024 * 1024) {
    throw new Error(
      'CAPTURE_PHASE15_E2E_PDF must contain 1 through 52428800 bytes.',
    );
  }
  const sourceName = basename(sourcePath);
  const pdfEvidence = extractPdfEvidence(sourcePath);
  const ocrPageCount = pdfEvidence.pageCount - pdfEvidence.embeddedPages.length;
  if (ocrPageCount < 0) {
    throw new Error('PDF embedded text evidence contained too many pages.');
  }

  mkdirSync(fixtureBase, { recursive: true });
  const fixtureRoot = mkdtempSync(join(fixtureBase, 'runtime-web-component-'));
  const dataDirectory = mkdtempSync(join(fixtureBase, 'runtime-data-'));
  let runtime: { child: ReturnType<typeof spawn>; token: string } | undefined;
  let preview: ReturnType<typeof spawn> | undefined;
  let workerMirror: Awaited<ReturnType<typeof startWorkerMirror>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    writeFixture(
      fixtureRoot,
      'package.json',
      `${JSON.stringify(
        {
          name: 'capture-workbench-phase-1-5-consumer',
          version: '0.0.0',
          private: true,
          packageManager: 'pnpm@11.15.1',
          engines: { node: '>=24.0.0', pnpm: '>=11.0.0' },
          dependencies: {
            '@angular/compiler': '22.0.7',
            '@angular/core': '22.0.7',
            '@angular/elements': '22.0.7',
            '@angular/forms': '22.0.7',
            '@angular/platform-browser': '22.0.7',
            '@gx-capture/capture-contracts': fileSpec(contractsArchive),
            '@gx-capture/capture-workbench': fileSpec(packageArchive),
            rxjs: '7.8.2',
            tslib: '2.8.1',
          },
          devDependencies: { vite: '7.3.6' },
        },
        null,
        2,
      )}\n`,
    );
    writeFixture(
      fixtureRoot,
      'pnpm-workspace.yaml',
      `engineStrict: true
allowBuilds:
  esbuild: true
overrides:
  '@gx-capture/capture-contracts': '${fileSpec(contractsArchive)}'
`,
    );
    writeFixture(
      fixtureRoot,
      'index.html',
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Phase 1.5 Runtime Web Component E2E</title></head><body><capture-workbench></capture-workbench><script type="module" src="/src/main.ts"></script></body></html>\n',
    );
    writeFixture(
      fixtureRoot,
      'src/main.ts',
      `import { firstValueFrom, of } from 'rxjs';
import {
  HttpCaptureClient,
  defineCaptureWorkbenchElement,
  type CaptureWorkbenchElement,
  type CaptureStructuringProvider,
} from '@gx-capture/capture-workbench';

declare global {
  interface Window {
    __captureE2eReady?: boolean;
    __captureE2eCompleted?: boolean;
    __captureE2eFailed?: unknown;
    __captureE2eDetail?: unknown;
    __captureE2eBubbles?: boolean;
    __captureE2eComposed?: boolean;
    __captureRuntimeBaseUrl: string;
    __captureRuntimeToken: string;
  }
}

const element = document.querySelector('capture-workbench') as CaptureWorkbenchElement;
const client = new HttpCaptureClient({
  baseUrl: () => window.__captureRuntimeBaseUrl,
  bearerToken: () => window.__captureRuntimeToken,
});

const hostNormalizer: CaptureStructuringProvider = {
  structure: ({ raw, reportProgress }) => {
    reportProgress(100);
    const blocks = raw.segments.map((segment) => ({
      blockId: segment.segmentId,
      order: segment.order,
      sourceSegmentId: segment.segmentId,
      type: 'paragraph' as const,
      locator: segment.locator,
      sourceText: segment.text,
      targetText: segment.text,
    }));
    return of({
      schemaVersion: '1' as const,
      source: raw.source,
      rawSegments: raw.segments,
      blocks,
      sourceText: raw.sourceText,
      targetText: blocks.map((block) => block.targetText).join('\\n'),
      extractionEngine: raw.extractionEngine,
      structuringEngine: {
        engine: 'host-normalizer',
        model: 'capture-workbench-e2e-host-normalizer-v1',
        digest: 'sha256:' + '0'.repeat(64),
      },
      warnings: raw.warnings,
      createdAt: raw.createdAt,
      completedAt: new Date().toISOString(),
    });
  },
};

const ready = await firstValueFrom(client.getReady());
await firstValueFrom(client.getRequirements());
if (!ready.ready || ready.service !== 'capture-runtime') {
  throw new Error('Capture Runtime host handshake was not ready.');
}

await firstValueFrom(defineCaptureWorkbenchElement());
element.config = {
  enabledSources: ['pdf'],
  structuringMode: 'host',
  hostStructuringOwner: 'component',
  hostManagedHandshake: true,
  multiple: false,
  outputMode: 'json',
  pollIntervalMs: 25,
  showRuntimeSetup: false,
};
element.client = client;
element.structuringProvider = hostNormalizer;
element.addEventListener('capture-completed', (event) => {
  const customEvent = event as CustomEvent;
  window.__captureE2eDetail = customEvent.detail;
  window.__captureE2eBubbles = customEvent.bubbles;
  window.__captureE2eComposed = customEvent.composed;
  window.__captureE2eCompleted = true;
});
element.addEventListener('capture-failed', (event) => {
  window.__captureE2eFailed = (event as CustomEvent).detail;
});
window.__captureE2eReady = true;
`,
    );

    await runChecked(
      process.execPath,
      [corepackCli, 'pnpm', 'install', '--no-frozen-lockfile'],
      fixtureRoot,
    );

    const browserPort = await freePort();
    const runtimePort = await freePort();
    const browserOrigin = `http://127.0.0.1:${browserPort}`;
    workerMirror = await startWorkerMirror();
    runtime = await startRuntime(
      runtimePort,
      browserOrigin,
      dataDirectory,
      workerMirror.origin,
      ocrPageCount > 0,
    );
    preview = await startPreview(fixtureRoot, browserPort);
    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const requestPaths: string[] = [];
    const responseStatuses: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.hostname === '127.0.0.1' && url.port === String(runtimePort)) {
        requestPaths.push(url.pathname);
      }
    });
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.hostname === '127.0.0.1' && url.port === String(runtimePort)) {
        responseStatuses.push(`${response.status()} ${url.pathname}`);
      }
    });
    await page.addInitScript(
      ({ baseUrl, token }) => {
        window.__captureRuntimeBaseUrl = baseUrl;
        window.__captureRuntimeToken = token;
      },
      { baseUrl: `http://127.0.0.1:${runtimePort}`, token: runtime.token },
    );
    await page.goto(`${browserOrigin}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__captureE2eReady === true);
    const fileInput = page.locator('capture-workbench input[type=file]');
    await fileInput.waitFor({ state: 'attached', timeout: 30_000 });
    try {
      await expect(fileInput).toBeEnabled({ timeout: 30_000 });
    } catch (error) {
      throw new Error(
        `Runtime handshake did not enable the Web Component input: ${error instanceof Error ? error.message : String(error)}; requests=${JSON.stringify(requestPaths)}; responses=${JSON.stringify(responseStatuses)}; pageErrors=${JSON.stringify(pageErrors)}; consoleErrors=${JSON.stringify(consoleErrors)}`,
        { cause: error },
      );
    }
    await fileInput.setInputFiles({
      name: sourceName,
      mimeType: 'application/pdf',
      buffer: sourceBytes,
    });
    await page.waitForFunction(
      () => window.__captureE2eCompleted === true,
      undefined,
      {
        timeout: 15 * 60_000,
      },
    );
    const state = await page.evaluate(() => ({
      defined: customElements.get('capture-workbench') !== undefined,
      shadow:
        document
          .querySelector('capture-workbench')
          ?.querySelector('gx-capture-workbench')?.shadowRoot !== null,
      detail: window.__captureE2eDetail as
        | {
            document?: {
              sourceText?: string;
              targetText?: string;
              rawSegments?: readonly {
                locator?: { kind?: string; page?: number };
                text?: string;
              }[];
              source?: { fileName?: string };
              extractionEngine?: {
                engine?: string;
                device?: string;
              };
            };
          }
        | undefined,
      failed: window.__captureE2eFailed,
      bubbles: window.__captureE2eBubbles,
      composed: window.__captureE2eComposed,
    }));
    const expectedExtractionEngine =
      ocrPageCount > 0
        ? pdfEvidence.embeddedPages.length > 0
          ? 'pdf-embedded+windowsml-ocr'
          : 'windowsml-ocr'
        : 'pdf-embedded-text';
    const expectedExtractionDevice = ocrPageCount > 0 ? 'windowsml-dml' : 'cpu';
    const rawSegments = state.detail?.document?.rawSegments ?? [];
    const embeddedTextMismatches = pdfEvidence.embeddedPages
      .filter(({ page, text }) => {
        const segment = rawSegments.find(
          (candidate) =>
            candidate.locator?.kind === 'page' &&
            candidate.locator.page === page,
        );
        return (
          !segment ||
          normalizeExtractedText(segment.text || '') !==
            normalizeExtractedText(text)
        );
      })
      .map(({ page, text }) => ({
        page,
        expectedChars: normalizeExtractedText(text).length,
        actualChars:
          rawSegments.find(
            (candidate) =>
              candidate.locator?.kind === 'page' &&
              candidate.locator.page === page,
          )?.text?.length ?? 0,
      }));
    if (
      !state.defined ||
      !state.shadow ||
      state.failed !== undefined ||
      state.bubbles !== true ||
      state.composed !== true ||
      !state.detail?.document?.sourceText?.trim() ||
      state.detail.document.targetText !== state.detail.document.sourceText ||
      (state.detail.document.rawSegments?.length ?? 0) === 0 ||
      state.detail.document.extractionEngine?.engine !==
        expectedExtractionEngine ||
      state.detail.document.extractionEngine.device !==
        expectedExtractionDevice ||
      state.detail.document.source?.fileName !== sourceName
    ) {
      throw new Error(
        `Runtime and packed Web Component lifecycle failed: ${JSON.stringify({ state, pageErrors, consoleErrors, requestPaths })}`,
      );
    }
    if (embeddedTextMismatches.length > 0) {
      throw new Error(
        `Embedded PDF text did not conform on page(s): ${JSON.stringify(embeddedTextMismatches)}`,
      );
    }
    const expectedPaths = [
      '/v1/health/ready',
      '/v1/runtime/requirements',
      '/v1/captures',
    ];
    if (
      !expectedPaths.every((path) => requestPaths.includes(path)) ||
      !requestPaths.some((path) => /^\/v1\/captures\/[^/]+$/u.test(path)) ||
      !requestPaths.some((path) =>
        /^\/v1\/captures\/[^/]+\/result$/u.test(path),
      )
    ) {
      throw new Error(
        `Runtime HTTP lifecycle was incomplete: ${JSON.stringify(requestPaths)}`,
      );
    }
    const visualCheckPath =
      process.env['CAPTURE_PHASE15_E2E_SCREENSHOT']?.trim();
    if (visualCheckPath) {
      const resolvedVisualCheckPath = resolve(visualCheckPath);
      mkdirSync(dirname(resolvedVisualCheckPath), { recursive: true });
      await page.screenshot({ path: resolvedVisualCheckPath, fullPage: true });
      process.stdout.write(
        `Phase 1.5 visual spot-check screenshot saved to ${resolvedVisualCheckPath}.\n`,
      );
    }
    process.stdout.write(
      `Phase 1.5 runtime and packed Web Component E2E passed for ${packageManifest.name}@${packageManifest.version}: ${sourceName}; embeddedTextPages=${pdfEvidence.embeddedPages.length}; ocrPages=${ocrPageCount}; engine=${expectedExtractionEngine}; device=${expectedExtractionDevice}.\n`,
    );
  } finally {
    await browser?.close();
    if (preview) stopProcessTree(preview);
    if (runtime) stopProcessTree(runtime.child);
    await closeServer(workerMirror?.server);
    assertTemporaryFixture(fixtureRoot);
    assertTemporaryFixture(dataDirectory);
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(dataDirectory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
