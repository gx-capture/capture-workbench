import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeExecutable = join(
  repoRoot,
  'packages/capture-runtime/dist/executable/capture-runtime.exe',
);
const modelBundleRoot = join(
  repoRoot,
  'packages/capture-runtime/dist/windowsml',
);
const configuredModelDir = process.env.CAPTURE_USER_MODEL_DIR
  ? resolve(process.env.CAPTURE_USER_MODEL_DIR)
  : undefined;

const PROBE_ERROR_CODES = [
  'configuration',
  'runtime',
  'http',
  'invalid_response',
  'capture_failed',
  'timeout',
  'probe_failed',
] as const;
const PROBE_STAGES = [
  'input',
  'runtime',
  'model',
  'ingestion',
  'extraction',
  'capture',
] as const;
const SAFE_EVENT_TYPES = new Set([
  'accepted',
  'input_checkpoint',
  'heartbeat',
  'segment',
  'checkpoint',
  'resync_required',
  'completed',
  'failed',
  'cancelled',
]);
const SAFE_EVENT_STAGES = new Set([
  'queued',
  'extracting',
  'awaiting_structuring',
  'structuring',
  'completed',
  'failed',
  'cancelled',
]);

type ProbeErrorCode = (typeof PROBE_ERROR_CODES)[number];
type ProbeStage = (typeof PROBE_STAGES)[number];

export interface UserPdfOcrProbeErrorShape {
  readonly code: ProbeErrorCode;
  readonly status?: number;
  readonly stage?: ProbeStage;
}

const PROBE_ERROR_MESSAGES: Record<ProbeErrorCode, string> = {
  configuration: 'User PDF OCR probe configuration is invalid.',
  runtime: 'Capture Runtime is unavailable.',
  http: 'Capture Runtime rejected a probe request.',
  invalid_response: 'Capture Runtime returned an invalid probe response.',
  capture_failed: 'Capture extraction failed.',
  timeout: 'Capture extraction timed out.',
  probe_failed: 'User PDF OCR probe failed.',
};

function isProbeErrorCode(value: string): value is ProbeErrorCode {
  return (PROBE_ERROR_CODES as readonly string[]).includes(value);
}

function isProbeStage(value: string): value is ProbeStage {
  return (PROBE_STAGES as readonly string[]).includes(value);
}

export function formatProbeError(shape: UserPdfOcrProbeErrorShape): string {
  const code = isProbeErrorCode(shape.code) ? shape.code : 'probe_failed';
  const stage = shape.stage !== undefined && isProbeStage(shape.stage)
    ? ` stage=${shape.stage}`
    : '';
  const status = typeof shape.status === 'number'
    && Number.isInteger(shape.status)
    && shape.status >= 100
    && shape.status <= 599
    ? ` status=${shape.status}`
    : '';
  return `${PROBE_ERROR_MESSAGES[code]}${stage}${status}`;
}

export class UserPdfOcrProbeError extends Error {
  readonly shape: UserPdfOcrProbeErrorShape;

  constructor(shape: UserPdfOcrProbeErrorShape) {
    super(formatProbeError(shape));
    this.name = 'UserPdfOcrProbeError';
    this.shape = shape;
  }
}

export function sanitizeProbeError(error: unknown): string {
  return error instanceof UserPdfOcrProbeError
    ? error.message
    : PROBE_ERROR_MESSAGES.probe_failed;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function startRuntime(
  root: string,
  modelDir: string,
  dataDir: string,
  port: number,
  token: string,
): ChildProcess {
  return spawn(
    runtimeExecutable,
    ['serve', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CAPTURE_HOST: '127.0.0.1',
        CAPTURE_PORT: String(port),
        CAPTURE_API_TOKEN: token,
        CAPTURE_ALLOWED_HOSTS: `127.0.0.1:${port}`,
        CAPTURE_ALLOWED_ORIGINS: '',
        CAPTURE_ENABLE_API_DOCS: 'false',
        CAPTURE_APP_DATA_DIR: dataDir,
        CAPTURE_EXTRACTION_PROVIDER: 'runtime',
        CAPTURE_STRUCTURING_PROVIDER: 'host',
        CAPTURE_WINDOWSML_MODEL_DIR: modelDir,
      },
    },
  );
}

function stopRuntime(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: 10_000,
  });
}

async function waitForReady(baseUrl: string, token: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/v1/health/ready`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
    } catch {
      // The packaged sidecar is still starting.
    }
    await delay(250);
  }
  throw new UserPdfOcrProbeError({ code: 'runtime', stage: 'runtime' });
}

export async function readJsonObject(
  response: Response,
  stage: ProbeStage,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new UserPdfOcrProbeError({
      code: 'invalid_response',
      stage,
      status: response.status,
    });
  }
  if (!response.ok) {
    throw new UserPdfOcrProbeError({ code: 'http', stage, status: response.status });
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new UserPdfOcrProbeError({
      code: 'invalid_response',
      stage,
      status: response.status,
    });
  }
  return body as Record<string, unknown>;
}

async function getJson(
  url: string,
  token: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return readJsonObject(response, 'runtime');
}

async function waitForExtraction(
  baseUrl: string,
  captureId: string,
  token: string,
  timeoutMilliseconds = 300_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMilliseconds;
  const response = await fetch(
    `${baseUrl}/v2/captures/${encodeURIComponent(captureId)}/events`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    throw new UserPdfOcrProbeError({
      code: 'http',
      stage: 'extraction',
      status: response.status,
    });
  }
  if (!response.body) {
    throw new UserPdfOcrProbeError({ code: 'invalid_response', stage: 'extraction' });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventData: string[] = [];
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const result = await Promise.race([
      reader.read(),
      delay(remaining).then(() => ({ done: true, value: undefined })),
    ]);
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/u);
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      eventData = frame
        .split(/\r?\n/u)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());
      if (eventData.length === 0) continue;
      let event: Record<string, unknown>;
      try {
        const parsed = JSON.parse(eventData.join('\n')) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('invalid event');
        }
        event = parsed as Record<string, unknown>;
      } catch {
        throw new UserPdfOcrProbeError({ code: 'invalid_response', stage: 'extraction' });
      }
      const eventType = typeof event.eventType === 'string' && SAFE_EVENT_TYPES.has(event.eventType)
        ? event.eventType
        : 'unknown';
      const stage = typeof event.stage === 'string' && SAFE_EVENT_STAGES.has(event.stage)
        ? event.stage
        : 'unknown';
      const progress = typeof event.progress === 'number' && Number.isFinite(event.progress)
        ? String(event.progress)
        : '';
      console.log(`[capture-runtime] sse ${eventType}:${stage}:${progress}`);
      if (stage === 'awaiting_structuring') {
        await reader.cancel();
        return event;
      }
      if (event.eventType === 'failed' || event.eventType === 'cancelled') {
        throw new UserPdfOcrProbeError({ code: 'capture_failed', stage: 'extraction' });
      }
    }
  }
  await reader.cancel();
  throw new UserPdfOcrProbeError({ code: 'timeout', stage: 'extraction' });
}

async function startStreamingCapture(
  baseUrl: string,
  pdf: Buffer,
  fileName: string,
  token: string,
): Promise<Record<string, unknown>> {
  const requestId = randomUUID();
  const ingestionResponse = await fetch(`${baseUrl}/v2/ingestions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `${requestId}-ingestion`,
    },
    body: JSON.stringify({
      protocolVersion: '2',
      clientRequestId: `${requestId}-ingestion`,
      kind: 'pdf',
      mode: 'file',
      fileName,
      mediaType: 'application/pdf',
      totalBytes: pdf.byteLength,
    }),
  });
  const ingestion = await readJsonObject(ingestionResponse, 'ingestion');
  if (typeof ingestion.ingestionId !== 'string' || ingestion.ingestionId === '') {
    throw new UserPdfOcrProbeError({ code: 'invalid_response', stage: 'ingestion' });
  }
  const ingestionId = ingestion.ingestionId;
  const chunkSize = 1024 * 1024;
  for (let offset = 0, index = 0; offset < pdf.byteLength; offset += chunkSize, index += 1) {
    const chunk = pdf.subarray(offset, Math.min(offset + chunkSize, pdf.byteLength));
    const digest = createHash('sha256').update(chunk).digest('hex');
    const end = offset + chunk.byteLength - 1;
    const response = await fetch(
      `${baseUrl}/v2/ingestions/${encodeURIComponent(ingestionId)}/chunks/${index}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${offset}-${end}/${pdf.byteLength}`,
          Digest: `sha-256=${digest}`,
          'X-Idempotency-Key': `${requestId}-chunk-${index}`,
        },
        body: chunk,
      },
    );
    if (!response.ok) {
      throw new UserPdfOcrProbeError({ code: 'http', stage: 'ingestion', status: response.status });
    }
  }
  const digest = createHash('sha256').update(pdf).digest('hex');
  const finalize = await fetch(`${baseUrl}/v2/ingestions/${encodeURIComponent(ingestionId)}/finalize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `${requestId}-finalize`,
    },
    body: JSON.stringify({ protocolVersion: '2', totalBytes: pdf.byteLength, sha256: digest }),
  });
  if (!finalize.ok) {
    throw new UserPdfOcrProbeError({ code: 'http', stage: 'ingestion', status: finalize.status });
  }
  const captureResponse = await fetch(`${baseUrl}/v2/captures`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': requestId,
    },
    body: JSON.stringify({
      protocolVersion: '2',
      clientRequestId: requestId,
      ingestionId,
      structuringMode: 'host',
      startPolicy: 'eager',
    }),
  });
  return readJsonObject(captureResponse, 'capture');
}

async function main(): Promise<void> {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('This probe requires Windows x64.');
  }
  const configuredPdfPath = process.env.CAPTURE_USER_PDF;
  if (!configuredPdfPath) {
    throw new Error(
      'Set CAPTURE_USER_PDF to the PDF path before running this probe.',
    );
  }
  const pdfPath = resolve(configuredPdfPath);
  await stat(runtimeExecutable);
  const pdf = await readFile(pdfPath);
  if (pdf.byteLength === 0) {
    throw new UserPdfOcrProbeError({ code: 'configuration', stage: 'input' });
  }
  if (!configuredModelDir) {
    const bundles = (await readdir(modelBundleRoot)).filter((name) =>
      name.endsWith('.zip'),
    );
    if (bundles.length !== 1) {
      throw new UserPdfOcrProbeError({ code: 'configuration', stage: 'model' });
    }
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'capture-user-pdf-ocr-'));
  const modelDir = configuredModelDir ?? join(temporaryRoot, 'models');
  const dataDir = join(temporaryRoot, 'runtime-data');
  let runtime: ChildProcess | undefined;
  const relativeRoot = temporaryRoot
    .replace(resolve(tmpdir()), '')
    .replace(/^[/\\]+/u, '');
  if (
    !relativeRoot
    || relativeRoot === '..'
    || relativeRoot.startsWith(`..${sep}`)
  ) {
    throw new UserPdfOcrProbeError({ code: 'configuration', stage: 'runtime' });
  }
  try {
    if (!configuredModelDir) {
      await mkdir(join(modelDir, 'det'), { recursive: true });
      await mkdir(join(modelDir, 'rec'), { recursive: true });
      const bundle = (await readdir(modelBundleRoot)).find((name) =>
        name.endsWith('.zip'),
      );
      if (!bundle) {
        throw new UserPdfOcrProbeError({ code: 'configuration', stage: 'model' });
      }
      const extraction = spawnSync(
        'tar',
        ['-xf', join(modelBundleRoot, bundle), '-C', modelDir],
        { windowsHide: true, encoding: 'utf8' },
      );
      if (extraction.status !== 0) {
        throw new UserPdfOcrProbeError({ code: 'runtime', stage: 'model' });
      }
    }

    const port = 49173;
    const token = `capture-user-pdf-${randomUUID()}`;
    const baseUrl = `http://127.0.0.1:${port}`;
    runtime = startRuntime(temporaryRoot, modelDir, dataDir, port, token);
    await waitForReady(baseUrl, token);

    const created = await startStreamingCapture(baseUrl, pdf, basename(pdfPath), token);
    const captureId = String(created.captureId);
    const event = await waitForExtraction(baseUrl, captureId, token);
    const raw = await getJson(
      `${baseUrl}/v2/captures/${encodeURIComponent(captureId)}/partial`,
      token,
    );
    const segments = Array.isArray(raw.segments) ? raw.segments : [];
    const sourceText = String(raw.sourceText ?? '');
    console.log(
      JSON.stringify(
        {
          pdf: pdfPath,
          bytes: pdf.byteLength,
          captureId,
          stage: event.stage,
          extractionEngine: raw.extractionEngine,
          segments: segments.length,
          textCharacters: sourceText.length,
          textPreview: sourceText.slice(0, 500),
        },
        null,
        2,
      ),
    );
  } finally {
    stopRuntime(runtime);
    await rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(sanitizeProbeError(error));
    process.exitCode = 1;
  });
}
