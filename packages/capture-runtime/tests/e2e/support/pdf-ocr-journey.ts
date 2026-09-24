import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { request, reservePort, terminateOwnedTree } from './runtime-process.ts';
import { verifyRuntimeRelease } from './runtime-release.ts';
import {
  verifyRuntimePackageIdentity,
  type RuntimePackageIdentityReport,
  type RuntimeProbeIdentity,
} from './runtime-identity.ts';

const installationTimeoutMs = 30 * 60_000;
const captureTimeoutMs = 30 * 60_000;
const captureStallTimeoutMs = 5 * 60_000;
const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);

export type PdfOcrPackageKind = 'local-package' | 'online-package';

export type RunPdfOcrE2eOptions = {
  readonly packageKind: PdfOcrPackageKind;
  readonly identityMode: 'local-probe' | 'release';
  readonly releaseRoot: string;
  readonly runtimeVersion: string;
  readonly evidencePath: string;
};

type RuntimeRequirement = {
  readonly requirementId: string;
  readonly status: string;
  readonly detail?: string | null;
};

type RuntimeInstallation = {
  readonly installationId: string;
  readonly requirementId: string;
  readonly status: string;
  readonly error?: { readonly message?: string } | null;
};

type CaptureJob = {
  readonly captureId: string;
  readonly status: string;
  readonly progress: number | null;
  readonly partialRevision: number;
  readonly lastEventSequence: number;
  readonly updatedAt: string;
  readonly error?: { readonly message?: string } | null;
};

type RuntimeIngestion = {
  readonly ingestionId: string;
  readonly nextOffset: number;
  readonly nextChunkIndex: number;
};

type StreamingCapabilities = {
  readonly maxChunkBytes: number;
};

type RuntimeReady = {
  readonly ready: boolean;
  readonly apiVersion?: unknown;
  readonly runtimeVersion?: unknown;
};

type OcrProjectionIdentity = {
  readonly apiVersion?: unknown;
  readonly schemaVersion?: unknown;
  readonly contractSha256?: unknown;
};

type ContractIndexIdentity = {
  readonly sha256?: unknown;
};

export type PdfOcrRawCapture = {
  readonly sourceText: string;
  readonly segments: readonly {
    readonly locator: { readonly kind: string; readonly page?: number };
    readonly text: string;
  }[];
  readonly extractionEngine: {
    readonly engine: string;
    readonly model: string;
    readonly digest: string;
    readonly device?: string | null;
  };
};

export type PdfOcrExpectedAnchor = {
  readonly page: number;
  readonly text: string;
};

export type PdfOcrE2eEvidence = {
  readonly evidenceKind: 'real-runtime-pdf-ocr-e2e';
  readonly packageKind: PdfOcrPackageKind;
  readonly identityMode: 'local-probe' | 'release';
  readonly identity?: RuntimePackageIdentityReport;
  readonly workerTransport: 'test-local-exact-url' | 'catalog-https';
  readonly workerTransportE2eVerified: true;
  readonly runtimeVersion: string;
  readonly runtimeSha256: string;
  readonly sourceSha256: string;
  readonly sourceTextSha256: string;
  readonly expectedPages: number;
  readonly observedPages: number;
  readonly allPagesContainText: true;
  readonly matchedAnchorCount: number;
  readonly sampledPageCount: number;
  readonly matchedExpectedCharacterCount: number;
  readonly matchMode: 'nfkc-whitespace-insensitive-exact-substring';
  readonly extractionEngine: 'windowsml-ocr';
  readonly model: string;
  readonly engineDigest: string;
  readonly device: string;
  readonly watchdogContract: 'capture-operation-v2-progress';
  readonly watchdogCheckpointCount: number;
  readonly workerArtifactSha256?: string;
  readonly workerRequestCount?: 1;
  readonly workerBytesServed?: number;
  readonly captureDeleted: true;
  readonly ownedProcessCleanupVerified: true;
};

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '');
}

export function parseExpectedAnchors(
  value: string | undefined,
): PdfOcrExpectedAnchor[] {
  if (!value?.trim()) {
    throw new Error(
      'CAPTURE_PDF_OCR_E2E_EXPECTED_ANCHORS_JSON must be a JSON array with at least one page-bound semantic text anchor.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(
      'CAPTURE_PDF_OCR_E2E_EXPECTED_ANCHORS_JSON must contain valid JSON.',
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some(
      (item) =>
        item === null ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        !Number.isSafeInteger((item as Record<string, unknown>).page) ||
        Number((item as Record<string, unknown>).page) < 1 ||
        typeof (item as Record<string, unknown>).text !== 'string' ||
        !(item as Record<string, unknown>).text?.toString().trim(),
    )
  ) {
    throw new Error(
      'CAPTURE_PDF_OCR_E2E_EXPECTED_ANCHORS_JSON must contain objects with a positive page and non-empty text.',
    );
  }
  return parsed.map((item) => ({
    page: Number((item as Record<string, unknown>).page),
    text: String((item as Record<string, unknown>).text).trim(),
  }));
}

export function parseExpectedPages(value: string | undefined): number {
  const pages = Number(value);
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > 500) {
    throw new Error(
      'CAPTURE_PDF_OCR_E2E_EXPECTED_PAGES must be an integer from 1 through 500.',
    );
  }
  return pages;
}

export function assertPdfOcrRawCapture(
  raw: PdfOcrRawCapture,
  expectedPages: number,
  expectedAnchors: readonly PdfOcrExpectedAnchor[],
): Omit<
  PdfOcrE2eEvidence,
  | 'packageKind'
  | 'identityMode'
  | 'identity'
  | 'workerTransport'
  | 'workerTransportE2eVerified'
  | 'runtimeVersion'
  | 'runtimeSha256'
  | 'sourceSha256'
  | 'captureDeleted'
  | 'ownedProcessCleanupVerified'
  | 'watchdogContract'
  | 'watchdogCheckpointCount'
> {
  assert.equal(
    raw.extractionEngine.engine,
    'windowsml-ocr',
    'Real PDF OCR E2E requires windowsml-ocr provenance.',
  );
  assert.match(raw.extractionEngine.model, /^pp-ocrv\d+/u);
  assert.match(raw.extractionEngine.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(
    typeof raw.extractionEngine.device === 'string' &&
      raw.extractionEngine.device.length > 0,
  );
  const pages = [
    ...new Set(
      raw.segments.flatMap((segment) =>
        segment.locator.kind === 'page' &&
        Number.isSafeInteger(segment.locator.page)
          ? [Number(segment.locator.page)]
          : [],
      ),
    ),
  ].sort((left, right) => left - right);
  assert.deepEqual(
    pages,
    Array.from({ length: expectedPages }, (_item, index) => index + 1),
  );
  const normalizedSource = normalizedText(raw.sourceText);
  const textByPage = new Map<number, string>();
  for (const segment of raw.segments) {
    const page = segment.locator.page;
    if (segment.locator.kind !== 'page' || !Number.isSafeInteger(page)) {
      continue;
    }
    textByPage.set(
      Number(page),
      `${textByPage.get(Number(page)) ?? ''}\n${segment.text}`,
    );
  }
  for (const page of pages) {
    assert.ok(
      normalizedText(textByPage.get(page) ?? '').length > 0,
      `Real PaddleOCR output on page ${page} was empty.`,
    );
  }
  for (const anchor of expectedAnchors) {
    assert.ok(
      normalizedText(textByPage.get(anchor.page) ?? '').includes(
        normalizedText(anchor.text),
      ),
      `Real PaddleOCR output on page ${anchor.page} did not contain its required semantic anchor.`,
    );
  }
  return {
    evidenceKind: 'real-runtime-pdf-ocr-e2e',
    sourceTextSha256: sha256(normalizedSource),
    expectedPages,
    observedPages: pages.length,
    allPagesContainText: true,
    matchedAnchorCount: expectedAnchors.length,
    sampledPageCount: new Set(expectedAnchors.map((anchor) => anchor.page)).size,
    matchedExpectedCharacterCount: expectedAnchors.reduce(
      (total, anchor) => total + normalizedText(anchor.text).length,
      0,
    ),
    matchMode: 'nfkc-whitespace-insensitive-exact-substring',
    extractionEngine: 'windowsml-ocr',
    model: raw.extractionEngine.model,
    engineDigest: raw.extractionEngine.digest,
    device: raw.extractionEngine.device,
  };
}

function requiredPdfPath(): string {
  const value = process.env.CAPTURE_PDF_OCR_E2E_PDF?.trim();
  if (!value) {
    throw new Error(
      'CAPTURE_PDF_OCR_E2E_PDF must name an existing real PDF.',
    );
  }
  return resolve(value);
}

export function isolatedEnvironment(
  appDataDirectory: string,
  port: number,
  token: string,
  localWorkerUrl: string | undefined,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  localModelRoot: string | undefined = undefined,
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(sourceEnvironment).filter(([name]) => {
      const upper = name.toUpperCase();
      return !upper.startsWith('CAPTURE_') && !upper.startsWith('OLLAMA_');
    }),
  );
  const workerEnvironment = localWorkerUrl
    ? {
        CAPTURE_PDF_OCR_E2E_LOCAL_WORKER_OPT_IN: '1',
        CAPTURE_PDF_OCR_E2E_LOCAL_WORKER_URL: localWorkerUrl,
      }
    : {};
  const localModelEnvironment = localModelRoot
    ? {
        CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_OPT_IN: '1',
        CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT: localModelRoot,
      }
    : {};
  return {
    ...inherited,
    CAPTURE_HOST: '127.0.0.1',
    CAPTURE_PORT: String(port),
    CAPTURE_API_TOKEN: token,
    CAPTURE_ALLOWED_HOSTS: `127.0.0.1:${port}`,
    CAPTURE_ALLOWED_ORIGINS: 'http://tauri.localhost',
    CAPTURE_ENABLE_API_DOCS: 'false',
    CAPTURE_APP_DATA_DIR: appDataDirectory,
    CAPTURE_STRUCTURING_PROVIDER: 'host',
    CAPTURE_EXTRACTION_PROVIDER: 'runtime',
    ...workerEnvironment,
    ...localModelEnvironment,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

type WorkerMirror = {
  readonly server: Server;
  readonly workerUrl: string;
  readonly observations: {
    readonly requestedPaths: string[];
    successfulDownloads: number;
    bytesServed: number;
  };
};

async function startWorkerMirror(
  archivePath: string,
): Promise<WorkerMirror> {
  const archiveName = archivePath.split(/[\\/]/u).at(-1);
  if (!archiveName) throw new Error('Local OCR worker archive name is invalid.');
  const metadata = await stat(archivePath);
  const observations = {
    requestedPaths: [] as string[],
    successfulDownloads: 0,
    bytesServed: 0,
  };
  const server = createServer((requestMessage, response) => {
    observations.requestedPaths.push(requestMessage.url ?? '');
    if (
      requestMessage.method !== 'GET' ||
      requestMessage.url !== `/${archiveName}`
    ) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Length': String(metadata.size),
      'Content-Type': 'application/zip',
    });
    const stream = createReadStream(archivePath);
    stream.once('error', () => response.destroy());
    response.once('finish', () => {
      observations.successfulDownloads += 1;
      observations.bytesServed += metadata.size;
    });
    stream.pipe(response);
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Local OCR worker mirror did not expose a port.'));
        return;
      }
      resolvePort(address.port);
    });
  });
  return {
    server,
    workerUrl: `http://127.0.0.1:${port}/${archiveName}`,
    observations,
  };
}

async function closeWorkerMirror(server: Server): Promise<void> {
  server.closeIdleConnections();
  server.closeAllConnections();
  await new Promise<void>((resolveClose) =>
    server.close(() => resolveClose()),
  );
}

async function waitForReady(
  port: number,
  token: string,
  child: ReturnType<typeof spawn>,
): Promise<RuntimeReady> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Local-package Capture Runtime exited before readiness.');
    }
    try {
      const ready = await request<RuntimeReady>(
        port,
        token,
        '/v2/health/ready',
      );
      if (ready.ready) return ready;
    } catch {
      // The packaged runtime is still starting.
    }
    await delay(250);
  }
  throw new Error('Local-package Capture Runtime did not become ready.');
}

async function installOcr(port: number, token: string): Promise<void> {
  const requirements = await request<{
    readonly items: readonly RuntimeRequirement[];
  }>(port, token, '/v2/runtime/requirements');
  const ocr = requirements.items.find(
    (item) => item.requirementId === 'windowsml-ocr',
  );
  if (!ocr) throw new Error('Runtime did not expose windowsml-ocr.');
  if (ocr.status === 'ready') return;
  if (ocr.status !== 'installable') {
    throw new Error(
      `Runtime cannot install windowsml-ocr: ${ocr.status}${ocr.detail ? ` (${ocr.detail})` : ''}.`,
    );
  }
  const installation = await request<RuntimeInstallation>(
    port,
    token,
    '/v2/runtime/installations',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ requirementId: 'windowsml-ocr', consent: true }),
    },
  );
  const deadline = Date.now() + installationTimeoutMs;
  while (Date.now() < deadline) {
    const current = await request<RuntimeInstallation>(
      port,
      token,
      `/v2/runtime/installations/${installation.installationId}`,
    );
    if (current.status === 'completed') return;
    if (!['queued', 'running'].includes(current.status)) {
      throw new Error(
        `windowsml-ocr installation ended as ${current.status}: ${current.error?.message ?? 'no detail'}.`,
      );
    }
    await delay(1_000);
  }
  throw new Error('windowsml-ocr installation timed out.');
}

async function startPdfCapture(
  port: number,
  token: string,
  pdfBytes: Uint8Array,
): Promise<CaptureJob> {
  const clientRequestId = randomUUID();
  const sourceDigest = sha256(pdfBytes);
  const capabilities = await request<StreamingCapabilities>(
    port,
    token,
    '/v2/streaming/health/ready',
  );
  const chunkBytes = Math.max(
    1,
    Math.min(1024 * 1024, capabilities.maxChunkBytes),
  );
  let ingestion = await request<RuntimeIngestion>(
    port,
    token,
    '/v2/ingestions',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': `${clientRequestId}-ingestion`,
      },
      body: JSON.stringify({
        protocolVersion: '2',
        kind: 'pdf',
        mode: 'file',
        clientRequestId: `${clientRequestId}-ingestion`,
        fileName: 'semantic-ocr-fixture.pdf',
        mediaType: 'application/pdf',
        totalBytes: pdfBytes.byteLength,
        sourceSha256: sourceDigest,
      }),
    },
  );
  try {
    for (let offset = 0; offset < pdfBytes.byteLength; offset += chunkBytes) {
      const chunk = Uint8Array.from(
        pdfBytes.subarray(
          offset,
          Math.min(offset + chunkBytes, pdfBytes.byteLength),
        ),
      );
      ingestion = await request<RuntimeIngestion>(
        port,
        token,
        `/v2/ingestions/${encodeURIComponent(ingestion.ingestionId)}/chunks/${ingestion.nextChunkIndex}`,
        {
          method: 'PUT',
          headers: {
            'content-range': `bytes ${offset}-${offset + chunk.byteLength - 1}/${pdfBytes.byteLength}`,
            digest: `sha-256=${sha256(chunk)}`,
            'x-idempotency-key': `${ingestion.ingestionId}-${ingestion.nextChunkIndex}`,
          },
          body: chunk,
        },
      );
    }
    await request<RuntimeIngestion>(
      port,
      token,
      `/v2/ingestions/${encodeURIComponent(ingestion.ingestionId)}/finalize`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: '2',
          totalBytes: pdfBytes.byteLength,
          sha256: sourceDigest,
        }),
      },
    );
    return request<CaptureJob>(port, token, '/v2/captures', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': clientRequestId,
      },
      body: JSON.stringify({
        protocolVersion: '2',
        clientRequestId,
        ingestionId: ingestion.ingestionId,
        structuringMode: 'host',
        targetLanguage: 'zh-TW',
        startPolicy: 'eager',
      }),
    });
  } catch (error) {
    await request<void>(
      port,
      token,
      `/v2/ingestions/${encodeURIComponent(ingestion.ingestionId)}`,
      { method: 'DELETE' },
    ).catch(() => undefined);
    throw error;
  }
}

async function waitForExtraction(
  port: number,
  token: string,
  captureId: string,
): Promise<number> {
  const deadline = Date.now() + captureTimeoutMs;
  let checkpointCount = 0;
  let lastSignature = '';
  let lastMovementAt = Date.now();
  while (Date.now() < deadline) {
    const current = await request<CaptureJob>(
      port,
      token,
      `/v2/captures/${captureId}`,
    );
    const signature = captureWatchdogSignature(current);
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastMovementAt = Date.now();
      checkpointCount += 1;
      process.stdout.write(`${formatCaptureWatchdogCheckpoint(current)}\n`);
    }
    if (current.status === 'awaiting_structuring') return checkpointCount;
    if (!['waiting_input', 'extracting', 'structuring'].includes(current.status)) {
      throw new Error(
        `Real PDF extraction ended as ${current.status}: ${current.error?.message ?? 'no detail'}.`,
      );
    }
    if (Date.now() - lastMovementAt >= captureStallTimeoutMs) {
      throw new Error(
        `Real PDF extraction watchdog stalled after ${captureStallTimeoutMs}ms: ${formatCaptureWatchdogCheckpoint(current)}.`,
      );
    }
    await delay(1_000);
  }
  throw new Error('Real PDF extraction timed out.');
}

export function captureWatchdogSignature(
  capture: Pick<
    CaptureJob,
    | 'status'
    | 'progress'
    | 'partialRevision'
    | 'lastEventSequence'
    | 'updatedAt'
  >,
): string {
  return JSON.stringify([
    capture.status,
    capture.progress,
    capture.partialRevision,
    capture.lastEventSequence,
    capture.updatedAt,
  ]);
}

export function formatCaptureWatchdogCheckpoint(
  capture: Pick<
    CaptureJob,
    | 'status'
    | 'progress'
    | 'partialRevision'
    | 'lastEventSequence'
    | 'updatedAt'
  >,
): string {
  const progress =
    capture.progress === null
      ? 'unknown'
      : `${Math.round(capture.progress * 100)}%`;
  return [
    '[pdf-ocr-v2-watchdog]',
    `status=${capture.status}`,
    `progress=${progress}`,
    `partialRevision=${capture.partialRevision}`,
    `lastEventSequence=${capture.lastEventSequence}`,
    `updatedAt=${capture.updatedAt}`,
  ].join(' ');
}

function assertTemporaryRoot(root: string): void {
  const resolvedRoot = resolve(root);
  const resolvedTemp = resolve(tmpdir());
  const relativeRoot = relative(resolvedTemp, resolvedRoot);
  if (
    !relativeRoot ||
    relativeRoot === '..' ||
    relativeRoot.startsWith(`..${sep}`) ||
    resolve(resolvedTemp, relativeRoot) !== resolvedRoot
  ) {
    throw new Error(`Refusing to remove unexpected temporary path: ${root}`);
  }
}

export async function runPdfOcrE2e(
  options: RunPdfOcrE2eOptions,
): Promise<void> {
  if (
    (options.packageKind === 'local-package' &&
      options.identityMode !== 'local-probe') ||
    (options.packageKind === 'online-package' &&
      options.identityMode !== 'release')
  ) {
    throw new Error(
      'PDF OCR E2E package kind and runtime identity mode must agree.',
    );
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Real runtime PDF OCR E2E requires Windows x64.');
  }
  const pdfPath = requiredPdfPath();
  const expectedPages = parseExpectedPages(
    process.env.CAPTURE_PDF_OCR_E2E_EXPECTED_PAGES,
  );
  const anchors = parseExpectedAnchors(
    process.env.CAPTURE_PDF_OCR_E2E_EXPECTED_ANCHORS_JSON,
  );
  const pdfMetadata = await stat(pdfPath).catch(() => undefined);
  if (!pdfMetadata?.isFile()) {
    throw new Error('CAPTURE_PDF_OCR_E2E_PDF must be an existing regular file.');
  }
  const pdfBytes = await readFile(pdfPath);
  if (pdfBytes.length === 0) throw new Error('Real PDF fixture is empty.');

  const releaseRoot = resolve(options.releaseRoot);
  const manifest = await verifyRuntimeRelease(
    releaseRoot,
    options.runtimeVersion,
    options.identityMode,
  );
  const ocrWorkerArchives = (await readdir(releaseRoot)).filter(
    (name) =>
      name.startsWith('capture-engine-ocr-') && name.endsWith('.zip'),
  );
  if (
    options.packageKind === 'local-package' &&
    ocrWorkerArchives.length !== 1
  ) {
    throw new Error('Local release must contain exactly one OCR worker archive.');
  }
  if (
    options.packageKind === 'online-package' &&
    ocrWorkerArchives.length !== 0
  ) {
    throw new Error(
      'Online-package E2E download directory must not provide a local OCR worker override.',
    );
  }
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'capture-runtime-pdf-ocr-e2e-'),
  );
  const workerArchivePath =
    options.packageKind === 'local-package'
      ? join(releaseRoot, ocrWorkerArchives[0])
      : undefined;
  const localModelRoot =
    options.packageKind === 'local-package'
      ? resolve(
          process.env.CAPTURE_PDF_OCR_E2E_LOCAL_MODEL_ROOT?.trim() ||
            join(releaseRoot, '..', '..', 'model-sources', 'commit-a'),
        )
      : undefined;
  const token = randomBytes(32).toString('hex');
  let workerMirror: WorkerMirror | undefined;
  let workerArchiveBytes: Uint8Array | undefined;
  let port: number | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let captureId: string | undefined;
  let cleanupVerified = false;
  let identity: RuntimePackageIdentityReport | undefined;
  try {
    workerArchiveBytes = workerArchivePath
      ? await readFile(workerArchivePath)
      : undefined;
    workerMirror = workerArchivePath
      ? await startWorkerMirror(workerArchivePath)
      : undefined;
    port = await reservePort();
    const executable = join(releaseRoot, manifest.fileName);
    const executableBytes = await readFile(executable);
    const probe: RuntimeProbeIdentity = {
      runtimeExecutableSha256: sha256(executableBytes),
      ...(workerArchiveBytes
        ? { ocrWorkerSha256: sha256(workerArchiveBytes) }
        : {}),
    };
    const expectedContractSha256 = (
      await readFile(
        join(
          workspaceRoot,
          'packages/capture-runtime/src/capture_runtime/assets/contract-set.sha256',
        ),
        'utf8',
      )
    ).trim();
    child = spawn(
      executable,
      ['serve', '--host', '127.0.0.1', '--port', String(port)],
      {
        cwd: releaseRoot,
        windowsHide: true,
        stdio: 'ignore',
        env: isolatedEnvironment(
          join(temporaryRoot, 'app-data'),
          port,
          token,
          workerMirror?.workerUrl,
          process.env,
          localModelRoot,
        ),
      },
    );
    const readiness = await waitForReady(port, token, child);
    await installOcr(port, token);
    if (options.packageKind === 'local-package') {
      assert.ok(workerMirror);
      assert.ok(workerArchiveBytes);
      assert.deepEqual(workerMirror.observations.requestedPaths, [
        `/${ocrWorkerArchives[0]}`,
      ]);
      assert.equal(workerMirror.observations.successfulDownloads, 1);
      assert.equal(
        workerMirror.observations.bytesServed,
        workerArchiveBytes.length,
      );
    }
    const created = await startPdfCapture(port, token, pdfBytes);
    captureId = created.captureId;
    const watchdogCheckpointCount = await waitForExtraction(
      port,
      token,
      captureId,
    );
    const raw = await request<PdfOcrRawCapture>(
      port,
      token,
      `/v2/captures/${captureId}/raw`,
    );
    const ocrProjection = await request<OcrProjectionIdentity>(
      port,
      token,
      `/v2/captures/${captureId}/ocr`,
    );
    const contractIndex = await request<ContractIndexIdentity>(
      port,
      token,
      '/meta/v2/contracts',
    );
    if (contractIndex.sha256 !== ocrProjection.contractSha256) {
      throw new Error('Runtime contract index and OCR projection hashes differ.');
    }
    if (options.identityMode === 'local-probe') {
      identity = await verifyRuntimePackageIdentity({
        mode: options.identityMode,
        packageRoot: releaseRoot,
        runtimeExecutablePath: executable,
        ocrWorkerArchivePath: workerArchivePath,
        expectedContractSha256,
        probe,
        observed: {
          apiVersion: ocrProjection.apiVersion ?? readiness.apiVersion,
          ocrSchemaVersion: ocrProjection.schemaVersion,
          contractSha256: ocrProjection.contractSha256,
          loadedRuntimeSha256: sha256(executableBytes),
          loadedOcrWorkerSha256:
            workerMirror?.observations.successfulDownloads === 1 &&
            workerArchiveBytes
              ? sha256(workerArchiveBytes)
              : undefined,
          runtimeVersion: readiness.runtimeVersion ?? manifest.runtimeVersion,
        },
        expectedRuntimeVersion: options.runtimeVersion,
        sourceTreeRoots: [
          join(workspaceRoot, 'packages/capture-runtime/src'),
        ],
      });
    }
    const semanticEvidence = assertPdfOcrRawCapture(
      raw,
      expectedPages,
      anchors,
    );
    await request<void>(port, token, `/v2/captures/${captureId}`, {
      method: 'DELETE',
    });
    const deleted = await fetch(
      `http://127.0.0.1:${port}/v2/captures/${captureId}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          origin: 'http://tauri.localhost',
        },
      },
    );
    assert.equal(deleted.status, 404);
    captureId = undefined;
    await terminateOwnedTree(child);
    cleanupVerified = true;
    const evidence: PdfOcrE2eEvidence = {
      ...semanticEvidence,
      packageKind: options.packageKind,
      identityMode: options.identityMode,
      ...(identity ? { identity } : {}),
      workerTransport:
        options.packageKind === 'local-package'
          ? 'test-local-exact-url'
          : 'catalog-https',
      workerTransportE2eVerified: true,
      runtimeVersion: manifest.runtimeVersion,
      runtimeSha256: manifest.sha256,
      sourceSha256: sha256(pdfBytes),
      watchdogContract: 'capture-operation-v2-progress',
      watchdogCheckpointCount,
      ...(workerArchiveBytes && workerMirror
        ? {
            workerArtifactSha256: sha256(workerArchiveBytes),
            workerRequestCount: 1 as const,
            workerBytesServed: workerMirror.observations.bytesServed,
          }
        : {}),
      captureDeleted: true,
      ownedProcessCleanupVerified: true,
    };
    await mkdir(dirname(options.evidencePath), { recursive: true });
    await writeFile(
      options.evidencePath,
      `${JSON.stringify(evidence, null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(
      `Real runtime PDF OCR E2E evidence: ${options.evidencePath}\n`,
    );
  } finally {
    try {
      if (captureId && port !== undefined) {
        await request<void>(port, token, `/v2/captures/${captureId}`, {
          method: 'DELETE',
        }).catch(() => undefined);
      }
      if (!cleanupVerified && child) await terminateOwnedTree(child);
    } finally {
      try {
        if (workerMirror) await closeWorkerMirror(workerMirror.server);
      } finally {
        assertTemporaryRoot(temporaryRoot);
        await rm(temporaryRoot, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 250,
        });
      }
    }
  }
}
