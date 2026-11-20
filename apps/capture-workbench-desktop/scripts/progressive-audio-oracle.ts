// Manual oracle generator for progressive speech-recognition checks: runs a
// real progressive speech recognition capture of
// CAPTURE_PROGRESSIVE_AUDIO_ORACLE_SOURCE and writes the reference evidence to
// CAPTURE_PROGRESSIVE_AUDIO_ORACLE_OUTPUT (read by the localhost smoke via
// CAPTURE_REAL_ENGINES_PROGRESSIVE_AUDIO_ORACLE).
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';

import { setTimeout as delay } from 'node:timers/promises';

import { firstValueFrom } from 'rxjs';

import {
  FIRST_CHECKPOINT_MAX_COVERAGE_MS,
  deriveProgressiveAudioOracleEvidence,
  isCheckpointCoverage,
  progressiveAudioBudgetMs,
  readProgressiveAudioPartial,
  readProgressiveAudioSegments,
  summarizeCheckpoint,
  type SpeechPack,
} from './progressive-audio-evidence.ts';
import { runProgressiveEvidenceCommand } from './progressive-audio-evidence-cli.ts';
import { createTrackedProcessTreeTerminator } from './installed-process-cleanup.ts';
import { reserveLoopbackPort } from './installed-browser.ts';
import { catalogDeliveries } from './practical-installed.ts';

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
// The desktop's recording limit.
const ORACLE_MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
// Keep the frozen worker extraction tree short. Windows can reject a valid
// catalog archive before the worker probe when the owned app-data root is
// deeply nested under the workspace. A local run keeps its app data (the
// installed speech worker and model, gigabytes of small files) in a fresh
// kept run tree for the person to remove when the machine is idle; a GitHub
// runner uses this root and deletes it.
const deletedRunRoot = resolve(workspaceRoot, '..', '.cw-audio-oracle');
// Generate the process-local credential at launch. It is never written to an
// artifact or included in diagnostics.
const token = randomUUID().replaceAll('-', '');
// Local verify scripts set CI=true, so only GITHUB_ACTIONS marks a runner.
const keepAppData = process.env.GITHUB_ACTIONS !== 'true';
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

// The runtime emits one JSON data line per SSE frame.
export async function* captureEvents(response: Response, signal?: AbortSignal): AsyncGenerator<JsonRecord> {
  if (!response.ok || !response.body) {
    throw new Error(`Progressive audio oracle event stream failed: HTTP ${response.status}.`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) return;
      buffered += decoder.decode(chunk.value, { stream: true });
      let boundary = /\r?\n\r?\n/u.exec(buffered);
      while (boundary) {
        const frame = buffered.slice(0, boundary.index);
        buffered = buffered.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/u).find((line) => line.startsWith('data: '));
        if (data) yield asRecord(JSON.parse(data.slice(6)));
        boundary = /\r?\n\r?\n/u.exec(buffered);
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function readLiveCheckpoint(options: {
  readonly response: Promise<Response>;
  readonly signal: AbortSignal;
  readonly captureId: string;
  readonly readPartial: () => Promise<JsonRecord>;
  readonly readCapture: () => Promise<CaptureState>;
}): Promise<{ readonly snapshot: JsonRecord; readonly durationMs: number }> {
  try {
    for await (const event of captureEvents(await options.response, options.signal)) {
      const eventType = event['eventType'];
      if (eventType === 'failed' || eventType === 'cancelled') {
        throw new Error(`Progressive audio oracle extraction stopped: ${eventType}.`);
      }
      if (eventType === 'completed' || event['stage'] === 'awaiting_structuring') break;
      const coveredUntilMs = event['coveredUntilMs'];
      if (eventType !== 'checkpoint' || !isCheckpointCoverage(coveredUntilMs)) continue;
      const snapshot = await options.readPartial();
      const live = await options.readCapture();
      if (snapshot['captureId'] !== options.captureId || snapshot['revision'] !== event['partialRevision']
        || live.status !== 'extracting') {
        throw new Error('Progressive audio oracle missed the live checkpoint revision.');
      }
      const durationMs = event['durationMs'];
      if (typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs)
        || durationMs <= coveredUntilMs) {
        throw new Error('Progressive audio oracle checkpoint did not include a valid recording duration.');
      }
      return { snapshot, durationMs };
    }
  } catch (error) {
    if (options.signal.aborted) throw new Error('Progressive audio oracle live checkpoint deadline expired.');
    throw error;
  }
  throw new Error('Progressive audio oracle extraction finished before a live five-minute checkpoint was observed.');
}

// Match the runtime's source sniffer. A recording's extension can disagree with its container.
function recordingMediaType(bytes: Buffer): string | undefined {
  const header = bytes.subarray(0, 12).toString('latin1');
  const container = header.slice(8, 12);
  if (header.startsWith('RIFF')) {
    if (container === 'WAVE') return 'audio/wav';
    if (container === 'AVI ') return 'video/x-msvideo';
    return undefined;
  }
  if (header.startsWith('ID3')) return 'audio/mpeg';
  const secondByte = bytes[1];
  if (bytes[0] === 0xff && secondByte !== undefined && (secondByte & 0xe0) === 0xe0) {
    return (secondByte & 0x06) === 0 ? 'audio/aac' : 'audio/mpeg';
  }
  if (header.startsWith('fLaC')) return 'audio/flac';
  if (header.startsWith('OggS')) return 'audio/ogg';
  const box = header.slice(4, 8);
  if (header.length >= 12 && box === 'ftyp') return 'audio/mp4';
  if (['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(box)) return 'video/quicktime';
  if (bytes.subarray(0, 4).toString('hex') === '1a45dfa3') return 'video/x-matroska';
  if (bytes.subarray(0, 8).toString('hex') === '3026b2758e66cf11') return 'video/x-ms-asf';
  if (header.startsWith('#!AMR')) return 'audio/amr';
  if (header.startsWith('FORM') && (container === 'AIFF' || container === 'AIFC')) return 'audio/aiff';
  if (header.startsWith('caff')) return 'audio/x-caf';
  if (header.startsWith('FLV')) return 'video/x-flv';
  if (bytes.subarray(0, 4).toString('hex') === '000001ba') return 'video/mpeg';
  if (bytes[0] === 0x47 && bytes[188] === 0x47) return 'video/mp2t';
  return undefined;
}

export function recordingIngestionMetadata(path: string, bytes: Buffer): { fileName: string; mediaType: string } {
  const mediaType = recordingMediaType(bytes);
  if (!mediaType) throw new Error('Progressive audio oracle source has an unsupported recording signature.');
  return { fileName: basename(path), mediaType };
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

async function waitForReady(
  baseUrl: string,
  child: ReturnType<typeof spawn>,
  startupError: () => string,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
      throw new Error(`Progressive audio oracle runtime exited before readiness. ${startupError()}`.trim());
    }
    try {
      const response = await request(baseUrl, '/v2/health/ready');
      if (response.ok) return;
    } catch {
      // The production runtime may still be starting its packaged imports.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Progressive audio oracle runtime readiness timed out. ${startupError()}`.trim());
}

/** The selected pack's release archive or its published parts. */
export function speechWorkerFileNames(catalog: unknown, pack: SpeechPack): readonly string[] {
  const requirements = typeof catalog === 'object' && catalog !== null
    ? (catalog as { readonly requirements?: unknown }).requirements
    : undefined;
  const speech = Array.isArray(requirements)
    ? requirements.find((item: unknown) => typeof item === 'object' && item !== null
      && (item as { readonly requirementId?: unknown }).requirementId === 'speech-recognition')
    : undefined;
  if (!speech) throw new Error('Progressive audio oracle catalog has no speech recognition requirement.');
  const delivery = catalogDeliveries(speech as Record<string, unknown>)
    .find((item) => item.contentId === pack);
  const artifacts = delivery?.artifacts;
  const artifact = Array.isArray(artifacts) && artifacts.length > 0 ? asRecord(artifacts[0]) : undefined;
  if (!artifact) throw new Error(`Progressive audio oracle catalog has no ${pack} speech worker.`);
  const names = Array.isArray(artifact['parts'])
    ? artifact['parts'].map((part: unknown) => asRecord(part)['fileName'])
    : [artifact['fileName']];
  if (names.length === 0 || names.some((name) => typeof name !== 'string' || !/^[\w.-]+$/u.test(name))) {
    throw new Error('Progressive audio oracle catalog names an unsafe speech worker file.');
  }
  return names as string[];
}

async function startWorkerMirror(port: number, pack: SpeechPack): Promise<Server> {
  const releaseRoot = join(workspaceRoot, 'packages', 'capture-runtime', 'dist', 'release');
  const catalog: unknown = JSON.parse(await readFile(join(releaseRoot, 'capture-engine-catalog.json'), 'utf8'));
  const files = new Map<string, number>();
  for (const name of speechWorkerFileNames(catalog, pack)) {
    const metadata = await stat(join(releaseRoot, name)).catch(() => undefined);
    if (!metadata?.isFile()) throw new Error('Progressive audio oracle worker archive is missing.');
    files.set(`/${name}`, metadata.size);
  }
  const server = createServer((request, response) => {
    const size = request.method === 'GET' && request.url ? files.get(request.url) : undefined;
    if (size === undefined || !request.url) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-length': String(size),
      'content-type': 'application/zip',
    });
    createReadStream(join(releaseRoot, request.url.slice(1))).pipe(response);
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolvePromise());
  });
  return server;
}

async function installSpeechRecognition(
  baseUrl: string,
  child: ReturnType<typeof spawn>,
): Promise<void> {
  const started = await jsonRequest<JsonRecord>(baseUrl, '/v2/runtime/installations', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({ requirementId: 'speech-recognition', consent: true }),
  });
  const installationId = requiredString(started['installationId']);
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Progressive audio oracle runtime exited during speech recognition installation.');
    const current = await jsonRequest<JsonRecord>(baseUrl, `/v2/runtime/installations/${installationId}`);
    const status = requiredString(current['status']);
    if (status === 'completed') return;
    if (status === 'failed' || status === 'cancelled' || status === 'manual_action_required') {
      const error = current['error'] && typeof current['error'] === 'object' && !Array.isArray(current['error'])
        ? current['error'] as JsonRecord
        : undefined;
      const errorCode = typeof error?.['code'] === 'string' ? error['code'] : 'unknown';
      const message = typeof error?.['message'] === 'string' ? error['message'].toLowerCase() : '';
      const progress = typeof current['progress'] === 'number' ? current['progress'] : -1;
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
      throw new Error(`Progressive audio oracle speech recognition installation failed: code=${errorCode}; progressBand=${progressBand}; reason=${reason}.`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error('Progressive audio oracle speech recognition installation timed out.');
}

// Workspace tooling is another Nx project, so the oracle uses its command
// line rather than importing it.
function createKeptAppData(): string {
  const created = spawnSync(
    process.execPath,
    [join(workspaceRoot, 'tools', 'kept-run-trees.ts'), '--create', 'progressive-audio-oracle', 'audio-oracle'],
    { encoding: 'utf8', windowsHide: true },
  );
  const path = created.status === 0 ? created.stdout.trim() : '';
  if (!path) throw new Error(`Progressive audio oracle could not create its kept run tree: ${String(created.stderr || created.error || '').trim()}`);
  return path;
}

function selectedSpeechPack(): SpeechPack {
  const variant = process.env.CAPTURE_SPEECH_RECOGNITION_VARIANT?.trim() || 'auto';
  if (variant === 'cuda' || variant === 'cpu') return variant;
  if (variant !== 'auto') throw new Error('CAPTURE_SPEECH_RECOGNITION_VARIANT must be auto, cuda or cpu.');
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return existsSync(join(systemRoot, 'System32', 'nvcuda.dll')) ? 'cuda' : 'cpu';
}

function runtimeEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (!upper.startsWith('CAPTURE_WHISPER_')) continue;
    delete env[key];
    const replacement = upper === 'CAPTURE_WHISPER_PREFER_GPU'
      ? 'CAPTURE_SPEECH_PREFER_GPU'
      : upper === 'CAPTURE_WHISPER_ALLOW_CPU_FALLBACK'
        ? 'CAPTURE_SPEECH_RECOGNITION_ALLOW_CPU_FALLBACK'
        : 'CAPTURE_SPEECH_RECOGNITION_* settings';
    process.stderr.write(`Ignoring retired ${key}. Use ${replacement}.\n`);
  }
  return env;
}

async function run(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Progressive audio oracle requires Windows x64.');
  if (!sourcePath || !outputPath) {
    throw new Error('Progressive audio oracle source and output are required.');
  }
  const sourceMetadata = await lstat(sourcePath).catch(() => undefined);
  if (!sourceMetadata?.isFile() || sourceMetadata.isSymbolicLink() || sourceMetadata.size < 1 || sourceMetadata.size > ORACLE_MAX_SOURCE_BYTES) {
    throw new Error('Progressive audio oracle source must be a regular file within the smoke limit.');
  }
  const source = await readFile(sourcePath);
  const ingestionMetadata = recordingIngestionMetadata(sourcePath, source);
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const port = await firstValueFrom(reserveLoopbackPort());
  const workerMirrorPort = await firstValueFrom(reserveLoopbackPort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const pack = selectedSpeechPack();
  const model = pack === 'cuda' ? 'tea-asr-1.1' : 'tea-asr-1.1-mini';
  const runRoot = keepAppData ? createKeptAppData() : deletedRunRoot;
  const appData = keepAppData ? runRoot : join(runRoot, 'app-data');
  if (!keepAppData) await rm(runRoot, { recursive: true, force: true });
  await mkdir(appData, { recursive: true });
  const child = spawn(runtimeExecutable, ['serve', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: resolve(runtimeExecutable, '..'),
    env: {
      ...runtimeEnvironment(),
      CAPTURE_HOST: '127.0.0.1',
      CAPTURE_PORT: String(port),
      CAPTURE_API_TOKEN: token,
      CAPTURE_ALLOWED_HOSTS: `127.0.0.1:${port}`,
      CAPTURE_ALLOWED_ORIGINS: origin,
      CAPTURE_APP_DATA_DIR: join(appData, 'runtime'),
      CAPTURE_STRUCTURING_PROVIDER: 'host',
      // The runtime's default upload limit is lower than the recordings the
      // oracle admits.
      CAPTURE_MAX_UPLOAD_BYTES: String(ORACLE_MAX_SOURCE_BYTES),
      CAPTURE_SPEECH_PREFER_GPU: String(pack === 'cuda'),
      CAPTURE_SPEECH_RECOGNITION_ALLOW_CPU_FALLBACK: 'false',
      CAPTURE_SPEECH_RECOGNITION_MODEL: model,
      CAPTURE_SPEECH_RECOGNITION_VARIANT: pack,
      CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN: '1',
      CAPTURE_SMOKE_WORKER_MIRROR_URL: `http://127.0.0.1:${workerMirrorPort}`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let startupDiagnostics = '';
  let starting = true;
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    if (starting) startupDiagnostics = (startupDiagnostics + chunk).slice(-16_384);
  });
  child.on('error', (error) => { startupDiagnostics = error.message; });
  let ingestionId: string | undefined;
  let captureId: string | undefined;
  let workerMirror: Server | undefined;
  try {
    workerMirror = await startWorkerMirror(workerMirrorPort, pack);
    await waitForReady(baseUrl, child, () => startupDiagnostics.trim().replaceAll(token, '[redacted]'));
    starting = false;
    await installSpeechRecognition(baseUrl, child);
    const installed = asRecord(JSON.parse(await readFile(
      join(appData, 'runtime', 'engines', 'speech-recognition', 'active.json'), 'utf8',
    )));
    if (installed['contentId'] !== pack) throw new Error('Progressive audio oracle installed the wrong speech pack.');
    const ingestionRequestId = randomUUID();
    const ingestion = await jsonRequest<IngestionRecord>(baseUrl, '/v2/ingestions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Idempotency-Key': ingestionRequestId },
      body: JSON.stringify({
        clientRequestId: ingestionRequestId,
        kind: 'recording',
        ...ingestionMetadata,
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
    const captureRequestId = randomUUID();
    const checkpointSignal = AbortSignal.timeout(
      progressiveAudioBudgetMs(FIRST_CHECKPOINT_MAX_COVERAGE_MS, pack),
    );
    const capture = await jsonRequest<CaptureRecord>(baseUrl, '/v2/captures', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Idempotency-Key': captureRequestId },
      signal: checkpointSignal,
      body: JSON.stringify({
        clientRequestId: captureRequestId,
        ingestionId,
        structuringMode: 'host',
        startPolicy: 'eager',
      }),
    });
    captureId = capture.captureId;
    const capturePath = `/v2/captures/${captureId}`;
    const { snapshot, durationMs } = await readLiveCheckpoint({
      response: request(baseUrl, `${capturePath}/events`, { signal: checkpointSignal }),
      signal: checkpointSignal,
      captureId,
      readPartial: () => jsonRequest<JsonRecord>(baseUrl, `${capturePath}/partial`, { signal: checkpointSignal }),
      readCapture: () => jsonRequest<CaptureState>(baseUrl, capturePath, { signal: checkpointSignal }),
    });
    const checkpoint = readProgressiveAudioPartial(snapshot, { sha256: sourceSha256, bytes: source.byteLength });
    summarizeCheckpoint(checkpoint);
    if (checkpoint.extraction.model !== model || checkpoint.extraction.device !== pack) {
      throw new Error(`Progressive audio oracle expected ${pack} pack on ${pack} with ${model}, observed ${checkpoint.extraction.device} with ${checkpoint.extraction.model}.`);
    }

    const signal = AbortSignal.timeout(progressiveAudioBudgetMs(durationMs, pack));
    for (;;) {
      const current = await jsonRequest<CaptureState>(baseUrl, capturePath, { signal });
      if (current.status === 'awaiting_structuring') break;
      if (current.status !== 'extracting') {
        throw new Error(`Progressive audio oracle extraction stopped: status=${current.status}; code=${current.error?.['code'] ?? 'unknown'}.`);
      }
      await delay(250, undefined, { signal });
    }
    const raw = await jsonRequest<JsonRecord>(baseUrl, `${capturePath}/raw`, { signal });
    const finalEngine = asRecord(raw['extractionEngine']);
    if (finalEngine['engine'] !== checkpoint.extraction.engine || finalEngine['model'] !== checkpoint.extraction.model
      || finalEngine['device'] !== checkpoint.extraction.device || finalEngine['digest'] !== checkpoint.extraction.digest) {
      throw new Error('Progressive audio oracle final recognition provenance differs from the checkpoint.');
    }
    const evidence = deriveProgressiveAudioOracleEvidence(
      checkpoint, pack, durationMs, readProgressiveAudioSegments(raw['segments']),
    );
    await mkdir(resolve(outputPath, '..'), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  } finally {
    const signal = AbortSignal.timeout(5_000);
    if (captureId) {
      await request(baseUrl, `/v2/captures/${captureId}/cancel`, { method: 'POST', signal }).catch(() => undefined);
      await request(baseUrl, `/v2/captures/${captureId}`, { method: 'DELETE', signal }).catch(() => undefined);
    }
    if (ingestionId) await request(baseUrl, `/v2/ingestions/${ingestionId}`, { method: 'DELETE', signal }).catch(() => undefined);
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
    if (keepAppData) {
      process.stdout.write(
        `Kept the oracle app data at ${runRoot}; remove it with pnpm run kept-run-trees -- --remove ${runRoot}\n`,
      );
    } else {
      await rm(runRoot, { recursive: true, force: true });
    }
  }
  process.stdout.write('Progressive audio non-Tauri oracle completed.\n');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (process.argv[2] === '--verify-evidence') {
    runProgressiveEvidenceCommand();
  } else {
    run().catch((error: unknown) => {
      process.stderr.write(error instanceof Error ? error.message : 'Progressive audio oracle failed.');
      process.exitCode = 1;
    });
  }
}
