import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

import { firstValueFrom } from 'rxjs';

import {
  PROGRESSIVE_AUDIO_CHECKPOINT_MS,
  REAL_MODEL_AUDIO_SAMPLE_SECONDS,
} from './real-media-model-smoke.ts';
import {
  deriveProgressiveAudioOracleEvidence,
  type ProgressiveAudioSampleInput,
} from './progressive-audio-evidence.ts';
import { createTrackedProcessTreeTerminator } from './installed-process-cleanup.ts';
import { reserveLoopbackPort } from './installed-browser.ts';

const workspaceRoot = resolve(import.meta.dirname, '../..', '..');
const runtimeExecutable = resolve(
  process.env.CAPTURE_PROGRESSIVE_AUDIO_ORACLE_RUNTIME
    || join(
      workspaceRoot,
      'packages',
      'capture-runtime',
      'dist',
      'release',
      'capture-runtime-x86_64-pc-windows-msvc.exe',
    ),
);
const sourcePath = process.env.CAPTURE_PROGRESSIVE_AUDIO_ORACLE_SOURCE?.trim();
const outputPath = process.env.CAPTURE_PROGRESSIVE_AUDIO_ORACLE_OUTPUT?.trim();
// Keep the frozen worker extraction tree short. Windows can reject a valid
// catalog archive before the worker probe when the owned app-data root is
// deeply nested under the workspace.
const runRoot = resolve(workspaceRoot, '..', '.cwpa');
// Generate the process-local credential at launch. It is never written to an
// artifact or included in diagnostics.
const token = randomUUID().replaceAll('-', '');
const origin = 'http://127.0.0.1';

type JsonRecord = Record<string, unknown>;

interface CaptureState {
  readonly status?: string;
  readonly error?: JsonRecord | null;
}

interface IngestionRecord {
  readonly ingestionId: string;
}

interface CaptureRecord {
  readonly captureId: string;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    origin,
    ...extra,
  };
}

async function request(baseUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
  const requestHeaders = new Headers(init.headers);
  for (const [name, value] of Object.entries(headers())) requestHeaders.set(name, value);
  return fetch(`${baseUrl}${path}`, { ...init, headers: requestHeaders });
}

async function jsonRequest<T>(baseUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await request(baseUrl, path, init);
  if (!response.ok) throw new Error(`Progressive audio oracle runtime request failed: status=${response.status}; path=${path}.`);
  return await response.json() as T;
}

function parseSseEvents(value: string): { readonly sequence: number; readonly eventType: string }[] {
  const events: { sequence: number; eventType: string }[] = [];
  let sequence: number | undefined;
  let eventType: string | undefined;
  for (const line of value.split(/\r?\n/u)) {
    if (line.startsWith('id: ')) sequence = Number(line.slice(4));
    if (line.startsWith('event: ')) eventType = line.slice(7);
    if (line === '' && sequence !== undefined && eventType !== undefined) {
      if (Number.isSafeInteger(sequence) && sequence > 0) events.push({ sequence, eventType });
      sequence = undefined;
      eventType = undefined;
    }
  }
  return events;
}

function asRecord(value: unknown): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Progressive audio oracle returned an invalid object.');
  }
  return value as JsonRecord;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Progressive audio oracle returned an invalid string.');
  }
  return value;
}

function parsePartial(value: unknown, sourceSha256: string, sourceBytes: number): ProgressiveAudioSampleInput {
  const partial = asRecord(value);
  const source = asRecord(partial.source);
  const extraction = asRecord(partial.extractionEngine);
  const segmentsValue = partial.segments;
  if (!Array.isArray(segmentsValue)) throw new Error('Progressive audio oracle returned no segments.');
  const segments = segmentsValue.map((segmentValue) => {
    const segment = asRecord(segmentValue);
    const locator = asRecord(segment.locator);
    return {
      order: Number(segment.order),
      startMs: Number(locator.startMs),
      endMs: Number(locator.endMs),
      text: requiredString(segment.text),
    };
  });
  if (requiredString(source.sha256) !== sourceSha256 || Number(source.bytes) !== sourceBytes) {
    throw new Error('Progressive audio oracle source binding did not match.');
  }
  return {
    sourceSha256,
    sourceBytes,
    coveredUntilMs: Number(partial.coveredUntilMs),
    partialRevision: Number(partial.revision),
    segments,
    extraction: {
      engine: requiredString(extraction.engine),
      model: requiredString(extraction.model),
      device: requiredString(extraction.device) as 'cuda' | 'cpu',
      digest: requiredString(extraction.digest),
    },
  };
}

async function waitForReady(baseUrl: string, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Progressive audio oracle runtime exited before readiness.');
    try {
      const response = await request(baseUrl, '/v2/health/ready');
      if (response.ok) return;
    } catch {
      // The production runtime may still be starting its packaged imports.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error('Progressive audio oracle runtime readiness timed out.');
}

async function startWorkerMirror(port: number): Promise<Server> {
  const archivePath = join(
    workspaceRoot,
    'packages',
    'capture-runtime',
    'dist',
    'release',
    'capture-engine-whisper-0.4.0-windows-x64.zip',
  );
  const archiveName = 'capture-engine-whisper-0.4.0-windows-x64.zip';
  const archiveMetadata = await stat(archivePath).catch(() => undefined);
  if (!archiveMetadata?.isFile()) throw new Error('Progressive audio oracle worker archive is missing.');
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== `/${archiveName}`) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-length': String(archiveMetadata.size),
      'content-type': 'application/zip',
    });
    createReadStream(archivePath).pipe(response);
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolvePromise());
  });
  return server;
}

async function installWhisper(
  baseUrl: string,
  child: ReturnType<typeof spawn>,
): Promise<void> {
  const started = await jsonRequest<JsonRecord>(baseUrl, '/v2/runtime/installations', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({ requirementId: 'whisper-primary', consent: true }),
  });
  const installationId = requiredString(started.installationId);
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Progressive audio oracle runtime exited during Whisper installation.');
    const current = await jsonRequest<JsonRecord>(baseUrl, `/v2/runtime/installations/${installationId}`);
    const status = requiredString(current.status);
    if (status === 'completed') return;
    if (status === 'failed' || status === 'cancelled' || status === 'manual_action_required') {
      const error = current.error && typeof current.error === 'object' && !Array.isArray(current.error)
        ? current.error as JsonRecord
        : undefined;
      const errorCode = typeof error?.code === 'string' ? error.code : 'unknown';
      const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
      const progress = typeof current.progress === 'number' ? current.progress : -1;
      const progressBand = progress >= 0.8 ? 'late' : progress >= 0.35 ? 'download' : 'early';
      const reason = message.includes('direct model download exhausted')
        ? 'direct-model-retries-exhausted'
        : message.includes('worker code probe')
          ? 'worker-code-probe'
          : message.includes('post-install probe')
            ? 'post-install-probe'
            : message.includes('archive')
              ? 'worker-archive'
              : 'unknown';
      throw new Error(`Progressive audio oracle Whisper installation failed: code=${errorCode}; progressBand=${progressBand}; reason=${reason}.`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error('Progressive audio oracle Whisper installation timed out.');
}

async function run(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Progressive audio oracle requires Windows x64.');
  if (!sourcePath || !outputPath) {
    throw new Error('Progressive audio oracle source and output are required.');
  }
  const sourceMetadata = await lstat(sourcePath).catch(() => undefined);
  if (!sourceMetadata?.isFile() || sourceMetadata.isSymbolicLink() || sourceMetadata.size < 1 || sourceMetadata.size > 50 * 1024 * 1024) {
    throw new Error('Progressive audio oracle source must be a regular file within the smoke limit.');
  }
  const source = await readFile(sourcePath);
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const port = await firstValueFrom(reserveLoopbackPort());
  const workerMirrorPort = await firstValueFrom(reserveLoopbackPort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const appData = join(runRoot, 'app-data');
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(appData, { recursive: true });
  const child = spawn(runtimeExecutable, ['serve', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: resolve(runtimeExecutable, '..'),
    env: {
      ...process.env,
      CAPTURE_HOST: '127.0.0.1',
      CAPTURE_PORT: String(port),
      CAPTURE_API_TOKEN: token,
      CAPTURE_ALLOWED_HOSTS: `127.0.0.1:${port}`,
      CAPTURE_ALLOWED_ORIGINS: origin,
      CAPTURE_APP_DATA_DIR: join(appData, 'runtime'),
      CAPTURE_STRUCTURING_PROVIDER: 'host',
      CAPTURE_WHISPER_PREFER_GPU: '1',
      CAPTURE_WHISPER_ALLOW_CPU_FALLBACK: '1',
      CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN: '1',
      CAPTURE_SMOKE_WORKER_MIRROR_URL: `http://127.0.0.1:${workerMirrorPort}`,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  let ingestionId: string | undefined;
  let captureId: string | undefined;
  let terminalStatus: string | undefined;
  let workerMirror: Server | undefined;
  try {
    workerMirror = await startWorkerMirror(workerMirrorPort);
    await waitForReady(baseUrl, child);
    await installWhisper(baseUrl, child);
    const ingestion = await jsonRequest<IngestionRecord>(baseUrl, '/v2/ingestions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientRequestId: randomUUID(),
        fileName: 'progressive-audio-oracle.wav',
        mediaType: 'audio/wav',
        totalBytes: source.byteLength,
        sourceSha256,
      }),
    });
    ingestionId = ingestion.ingestionId;
    const chunkSize = 1024 * 1024;
    for (let offset = 0, index = 0; offset < source.byteLength; offset += chunkSize, index += 1) {
      const chunk = source.subarray(offset, Math.min(source.byteLength, offset + chunkSize));
      const chunkSha256 = createHash('sha256').update(chunk).digest('hex');
      await jsonRequest(baseUrl, `/v2/ingestions/${ingestionId}/chunks/${index}`, {
        method: 'PUT',
        headers: {
          'Content-Range': `bytes ${offset}-${offset + chunk.byteLength - 1}/${source.byteLength}`,
          Digest: `sha-256=${chunkSha256}`,
          'X-Idempotency-Key': `oracle-${index}`,
        },
        body: chunk as unknown as BodyInit,
      });
    }
    await jsonRequest(baseUrl, `/v2/ingestions/${ingestionId}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ totalBytes: source.byteLength, sha256: sourceSha256 }),
    });
    const capture = await jsonRequest<CaptureRecord>(baseUrl, '/v2/captures', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientRequestId: randomUUID(),
        ingestionId,
        structuringMode: 'host',
        startPolicy: 'eager',
      }),
    });
    captureId = capture.captureId;
    let lastEventId = 0;
    let checkpointSeen = false;
    const deadline = Date.now() + 20 * 60_000;
    let partial: unknown;
    while (Date.now() < deadline) {
      const current = await jsonRequest<CaptureState>(baseUrl, `/v2/captures/${captureId}`);
      terminalStatus = current.status;
      const eventResponse = await request(baseUrl, `/v2/captures/${captureId}/events`, {
        headers: lastEventId > 0 ? { 'Last-Event-ID': String(lastEventId) } : {},
      });
      if (eventResponse.ok) {
        for (const event of parseSseEvents(await eventResponse.text())) {
          lastEventId = Math.max(lastEventId, event.sequence);
          if (event.eventType === 'checkpoint') checkpointSeen = true;
        }
      }
      const partialResponse = await request(baseUrl, `/v2/captures/${captureId}/partial`);
      if (partialResponse.ok) partial = await partialResponse.json();
      if (current.status === 'awaiting_structuring' || current.status === 'completed') break;
      if (current.status === 'failed' || current.status === 'cancelled') {
        const errorCode = current.error && typeof current.error.code === 'string'
          ? current.error.code
          : 'unknown';
        const errorStage = current.error && typeof current.error.stage === 'string'
          ? current.error.stage
          : 'unknown';
        throw new Error(`Progressive audio oracle capture failed: code=${errorCode}; stage=${errorStage}.`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    if (terminalStatus !== 'awaiting_structuring' && terminalStatus !== 'completed') {
      throw new Error('Progressive audio oracle capture timed out.');
    }
    if (!checkpointSeen) throw new Error('Progressive audio oracle did not observe the five-minute checkpoint.');
    const evidence = deriveProgressiveAudioOracleEvidence(
      parsePartial(partial, sourceSha256, source.byteLength),
    );
    if (evidence.firstCheckpoint.coveredUntilMs < PROGRESSIVE_AUDIO_CHECKPOINT_MS) {
      throw new Error('Progressive audio oracle coverage did not reach the five-minute checkpoint.');
    }
    if (evidence.firstCheckpoint.coveredUntilMs > REAL_MODEL_AUDIO_SAMPLE_SECONDS * 1000 + 30_000) {
      throw new Error('Progressive audio oracle coverage exceeded the bounded sample.');
    }
    await mkdir(resolve(outputPath, '..'), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  } finally {
    if (captureId) {
      await request(baseUrl, `/v2/captures/${captureId}/cancel`, { method: 'POST' }).catch(() => undefined);
      await request(baseUrl, `/v2/captures/${captureId}`, { method: 'DELETE' }).catch(() => undefined);
    }
    if (ingestionId) await request(baseUrl, `/v2/ingestions/${ingestionId}`, { method: 'DELETE' }).catch(() => undefined);
    await new Promise<void>((resolvePromise) => workerMirror?.close(() => resolvePromise()) ?? resolvePromise());
    if (child.pid) {
      const terminate = createTrackedProcessTreeTerminator({
        smokeRoot: runRoot,
        workspaceRoot,
        baseChildEnvironment: (sourceEnvironment: NodeJS.ProcessEnv) => ({ PATH: sourceEnvironment.PATH || '' }),
        windowsSystemExecutable: (...segments: string[]) => join(process.env.SystemRoot || 'C:\\Windows', ...segments),
      });
      await firstValueFrom(terminate(child, 'progressive audio oracle runtime')).catch(() => undefined);
    }
    await rm(runRoot, { recursive: true, force: true });
  }
  process.stdout.write('Progressive audio non-Tauri oracle completed.\n');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  run().catch((error: unknown) => {
    process.stderr.write(error instanceof Error ? error.message : 'Progressive audio oracle failed.');
    process.exitCode = 1;
  });
}
