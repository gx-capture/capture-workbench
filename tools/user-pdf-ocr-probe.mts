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
  'created',
  'waiting_input',
  'queued',
  'extracting',
  'extraction',
  'awaiting_structuring',
  'structuring',
  'persisting',
  'resync',
  'completed',
  'failed',
  'cancelled',
]);
const STREAMING_EVENT_FIELDS = new Set([
  'protocolVersion',
  'eventId',
  'sequence',
  'captureId',
  'kind',
  'eventType',
  'stage',
  'progress',
  'partialRevision',
  'coveredUntilMs',
  'segments',
  'error',
  'createdAt',
]);
const STREAMING_EVENT_TYPES = new Set(SAFE_EVENT_TYPES);
const STREAMING_CAPTURE_STATUSES = new Set([
  'created',
  'waiting_input',
  'extracting',
  'awaiting_structuring',
  'structuring',
  'completed',
  'failed',
  'cancelled',
]);
const RECONNECT_DELAY_MS = 100;

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

let activeProbeReadDeadlines = 0;

/** Returns the number of per-read probe deadline timers still pending. */
export function pendingProbeReadDeadlines(): number {
  return activeProbeReadDeadlines;
}

class ProbeReadDeadline {
  private timer: NodeJS.Timeout | undefined;

  wait(milliseconds: number): Promise<void> {
    this.clear();
    activeProbeReadDeadlines += 1;
    return new Promise((resolvePromise) => {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        activeProbeReadDeadlines -= 1;
        resolvePromise();
      }, Math.max(0, milliseconds));
    });
  }

  clear(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    activeProbeReadDeadlines -= 1;
  }
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
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchImplementation(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return readJsonObject(response, 'runtime');
}

type ProbeFetch = typeof globalThis.fetch;

interface ProbeSseFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
}

interface ProbeStreamEvent {
  readonly kind: 'event';
  readonly event: Record<string, unknown>;
  readonly sequence: number;
}

interface ProbeStreamClosed {
  readonly kind: 'closed' | 'disconnected';
  readonly sequence: number;
}

interface ProbeStreamTimedOut {
  readonly kind: 'timeout';
  readonly sequence: number;
}

type ProbeStreamResult = ProbeStreamEvent | ProbeStreamClosed | ProbeStreamTimedOut;

class ProbeDeadlineReached extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function validRfc3339Timestamp(value: string): boolean {
  const match = /^(?<date>\d{4}-\d{2}-\d{2})T(?<clock>\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?<zone>Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match?.groups) return false;
  const date = match.groups['date'];
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const [hours, minutes, seconds] = match.groups['clock'].split(':').map(Number);
  const days = month === 2
    ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (month < 1 || month > 12 || day < 1 || day > days) return false;
  if (hours > 23 || minutes > 59 || seconds > 60) return false;
  if (match.groups['zone'] !== 'Z') {
    const [offsetHours, offsetMinutes] = match.groups['zone'].slice(1).split(':').map(Number);
    if (offsetHours > 23 || offsetMinutes > 59) return false;
  }
  return true;
}

function safeStage(value: unknown): string {
  return typeof value === 'string' && SAFE_EVENT_STAGES.has(value)
    ? value
    : 'unknown';
}

function invalidProbeEvent(): UserPdfOcrProbeError {
  return new UserPdfOcrProbeError({ code: 'invalid_response', stage: 'extraction' });
}

function validateProbeLocator(value: unknown): void {
  if (!isRecord(value)) throw invalidProbeEvent();
  if (value['kind'] === 'page') {
    if (
      Object.keys(value).some((key) => !['kind', 'page', 'boundingBox'].includes(key))
      || !isSafeInteger(value['page'])
      || value['page'] < 1
      || (value['boundingBox'] !== undefined
        && value['boundingBox'] !== null
        && (!Array.isArray(value['boundingBox'])
          || value['boundingBox'].length !== 4
          || value['boundingBox'].some((item) => typeof item !== 'number' || !Number.isFinite(item))))
    ) {
      throw invalidProbeEvent();
    }
    return;
  }
  if (
    value['kind'] !== 'time'
    || Object.keys(value).some((key) => !['kind', 'startMs', 'endMs'].includes(key))
    || !isSafeInteger(value['startMs'])
    || value['startMs'] < 0
    || !isSafeInteger(value['endMs'])
    || value['endMs'] <= value['startMs']
  ) {
    throw invalidProbeEvent();
  }
}

function validateProbeSegments(value: unknown): void {
  if (!Array.isArray(value)) throw invalidProbeEvent();
  for (const segment of value) {
    if (!isRecord(segment)
      || Object.keys(segment).some((key) => !['segmentId', 'order', 'locator', 'text'].includes(key))
      || typeof segment['segmentId'] !== 'string'
      || segment['segmentId'] === ''
      || !isSafeInteger(segment['order'])
      || segment['order'] < 0
      || typeof segment['text'] !== 'string'
      || segment['text'] === ''
      || [...segment['text']].length > 2_000_000
    ) {
      throw invalidProbeEvent();
    }
    validateProbeLocator(segment['locator']);
  }
}

function validateProbeFailure(value: unknown): void {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !['code', 'message', 'stage', 'retryable'].includes(key))
    || typeof value['code'] !== 'string'
    || !/^[a-z][a-z0-9_]{1,63}$/u.test(value['code'])
    || typeof value['message'] !== 'string'
    || value['message'] === ''
    || [...value['message']].length > 500
    || (value['stage'] !== undefined
      && value['stage'] !== null
      && (typeof value['stage'] !== 'string' || value['stage'] === ''))
    || (value['retryable'] !== undefined && typeof value['retryable'] !== 'boolean')
  ) {
    throw invalidProbeEvent();
  }
}

function normalizeProbeEvent(
  value: unknown,
  frame: ProbeSseFrame,
  captureId: string,
  previousSequence: number,
): Record<string, unknown> {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !STREAMING_EVENT_FIELDS.has(key))
    || value['protocolVersion'] !== '2'
    || typeof value['eventId'] !== 'string'
    || value['eventId'] === ''
    || !isSafeInteger(value['sequence'])
    || value['sequence'] < 0
    || value['sequence'] <= previousSequence
    || value['captureId'] !== captureId
    || value['eventId'] !== `${captureId}/${value['sequence']}`
    || !['pdf', 'image', 'audio'].includes(String(value['kind']))
    || typeof value['eventType'] !== 'string'
    || !STREAMING_EVENT_TYPES.has(value['eventType'])
    || typeof value['stage'] !== 'string'
    || value['stage'] === ''
    || typeof value['createdAt'] !== 'string'
    || !validRfc3339Timestamp(value['createdAt'])
  ) {
    throw invalidProbeEvent();
  }
  if (frame.id !== String(value['sequence'])) {
    throw invalidProbeEvent();
  }
  if (frame.event !== undefined && frame.event !== value['eventType']) {
    throw invalidProbeEvent();
  }
  const progress = value['progress'];
  if (
    progress !== undefined
    && progress !== null
    && (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1)
  ) {
    throw invalidProbeEvent();
  }
  for (const field of ['partialRevision', 'coveredUntilMs']) {
    const candidate = value[field];
    if (
      candidate !== undefined
      && candidate !== null
      && (!isSafeInteger(candidate) || candidate < 0)
    ) {
      throw invalidProbeEvent();
    }
  }
  const segments = value['segments'];
  if (segments !== undefined && segments !== null && !Array.isArray(segments)) {
    throw invalidProbeEvent();
  }
  if (value['eventType'] === 'segment' && (!Array.isArray(segments) || segments.length === 0)) {
    throw invalidProbeEvent();
  }
  if (Array.isArray(segments)) validateProbeSegments(segments);
  if (value['eventType'] === 'failed') {
    validateProbeFailure(value['error']);
  } else if (value['error'] !== undefined && value['error'] !== null) {
    throw invalidProbeEvent();
  }

  const safeEvent: Record<string, unknown> = {
    protocolVersion: '2',
    eventId: `${captureId}/${value['sequence']}`,
    sequence: value['sequence'],
    captureId,
    kind: value['kind'],
    eventType: value['eventType'],
    stage: safeStage(value['stage']),
    progress: progress ?? null,
  };
  if (value['eventType'] === 'failed') {
    const failure = value['error'] as Record<string, unknown>;
    safeEvent['error'] = {
      code: failure['code'],
      stage: safeStage(failure['stage']),
      retryable: failure['retryable'] === true,
    };
  }
  return safeEvent;
}

function parseProbeSseBlock(block: string): ProbeSseFrame | undefined {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? '' : line.slice(separator + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
    else if (field === 'event') event = value;
  }
  return data.length === 0 ? undefined : { id, event, data: data.join('\n') };
}

class ProbeSseParser {
  private line = '';
  private block: string[] = [];
  private pendingCarriageReturn = false;

  push(chunk: string): readonly ProbeSseFrame[] {
    const frames: ProbeSseFrame[] = [];
    let index = 0;
    if (this.pendingCarriageReturn) {
      this.pendingCarriageReturn = false;
      if (chunk[index] === '\n') index += 1;
      this.emitLine(frames);
    }
    while (index < chunk.length) {
      const character = chunk[index];
      index += 1;
      if (character === '\r') {
        if (index === chunk.length) {
          this.pendingCarriageReturn = true;
        } else {
          if (chunk[index] === '\n') index += 1;
          this.emitLine(frames);
        }
      } else if (character === '\n') {
        this.emitLine(frames);
      } else {
        this.line += character;
      }
    }
    return frames;
  }

  finish(): readonly ProbeSseFrame[] {
    const pending = this.pendingCarriageReturn || this.line !== '' || this.block.length > 0;
    this.line = '';
    this.block = [];
    this.pendingCarriageReturn = false;
    if (pending) throw invalidProbeEvent();
    return [];
  }

  private emitLine(frames: ProbeSseFrame[]): void {
    if (this.line === '') {
      const frame = parseProbeSseBlock(this.block.join('\n'));
      if (frame) frames.push(frame);
      this.block = [];
    } else {
      this.block.push(this.line);
    }
    this.line = '';
  }
}

async function readProbeStream(
  response: Response,
  captureId: string,
  previousSequence: number,
  deadline: number,
): Promise<ProbeStreamResult> {
  if (!response.body) throw invalidProbeEvent();
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('text/event-stream')) throw invalidProbeEvent();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parser = new ProbeSseParser();
  const readDeadline = new ProbeReadDeadline();
  let sequence = previousSequence;
  const decodeChunk = (value?: Uint8Array, streaming = false): string => {
    try {
      return decoder.decode(value, streaming ? { stream: true } : undefined);
    } catch {
      throw invalidProbeEvent();
    }
  };
  try {
    const consume = (frames: readonly ProbeSseFrame[]): ProbeStreamEvent | undefined => {
      for (const frame of frames) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(frame.data);
        } catch {
          throw invalidProbeEvent();
        }
        const event = normalizeProbeEvent(parsed, frame, captureId, sequence);
        sequence = event['sequence'] as number;
        if (
          event['eventType'] === 'resync_required'
          || event['eventType'] === 'completed'
          || event['eventType'] === 'failed'
          || event['eventType'] === 'cancelled'
          || event['stage'] === 'awaiting_structuring'
        ) {
          return { kind: 'event', event, sequence };
        }
      }
      return undefined;
    };

    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        reader.read().then((value) => ({ kind: 'read' as const, value })),
        readDeadline.wait(remaining).then(() => ({ kind: 'timeout' as const })),
      ]);
      readDeadline.clear();
      if (result.kind === 'timeout') {
        await reader.cancel();
        return { kind: 'timeout', sequence };
      }
      if (result.value.done) {
        const event = consume([
          ...parser.push(decodeChunk()),
          ...parser.finish(),
        ]);
        return event ?? { kind: 'closed', sequence };
      }
      const event = consume(parser.push(decodeChunk(result.value.value, true)));
      if (event) {
        await reader.cancel();
        return event;
      }
    }
    await reader.cancel();
    return { kind: 'timeout', sequence };
  } catch (error) {
    if (error instanceof UserPdfOcrProbeError) throw error;
    return { kind: 'disconnected', sequence };
  } finally {
    readDeadline.clear();
    reader.releaseLock();
  }
}

function normalizeCaptureSnapshot(
  value: unknown,
  captureId: string,
): Record<string, unknown> {
  if (!isRecord(value)
    || value['captureId'] !== captureId
    || typeof value['status'] !== 'string'
    || !STREAMING_CAPTURE_STATUSES.has(value['status'])
    || !isSafeInteger(value['lastEventSequence'])
    || value['lastEventSequence'] < 0
  ) {
    throw invalidProbeEvent();
  }
  const progress = value['progress'];
  if (
    progress !== undefined
    && progress !== null
    && (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1)
  ) {
    throw invalidProbeEvent();
  }
  return {
    protocolVersion: '2',
    captureId,
    status: value['status'],
    stage: safeStage(value['status']),
    progress: progress ?? null,
    lastEventSequence: value['lastEventSequence'],
  };
}

function isRetryableProbeError(error: unknown): boolean {
  return error instanceof UserPdfOcrProbeError
    ? error.shape.code === 'http' && (error.shape.status ?? 0) >= 500
    : true;
}

async function retryBeforeReconnect(deadline: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  await delay(Math.min(RECONNECT_DELAY_MS, remaining));
}

async function fetchProbeResponse(
  fetchImplementation: ProbeFetch,
  input: Parameters<ProbeFetch>[0],
  init: RequestInit,
  deadline: number,
): Promise<Response> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ProbeDeadlineReached();
  const controller = new AbortController();
  let deadlineReached = false;
  const timer = setTimeout(() => {
    deadlineReached = true;
    controller.abort();
  }, remaining);
  try {
    return await fetchImplementation(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (deadlineReached) throw new ProbeDeadlineReached();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function getJsonUntilDeadline(
  url: string,
  token: string,
  fetchImplementation: ProbeFetch,
  deadline: number,
): Promise<Record<string, unknown>> {
  const response = await fetchProbeResponse(
    fetchImplementation,
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    deadline,
  );
  return readJsonObject(response, 'runtime');
}

export async function waitForExtraction(
  baseUrl: string,
  captureId: string,
  token: string,
  timeoutMilliseconds = 300_000,
  fetchImplementation: ProbeFetch = globalThis.fetch,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastEventSequence = -1;
  while (Date.now() < deadline) {
    const headers = new Headers({
      Accept: 'text/event-stream',
      Authorization: `Bearer ${token}`,
    });
    if (lastEventSequence >= 0) headers.set('Last-Event-ID', String(lastEventSequence));
    let response: Response;
    try {
      response = await fetchProbeResponse(
        fetchImplementation,
        `${baseUrl}/v2/captures/${encodeURIComponent(captureId)}/events`,
        { headers },
        deadline,
      );
    } catch (error) {
      if (error instanceof ProbeDeadlineReached) {
        throw new UserPdfOcrProbeError({ code: 'timeout', stage: 'extraction' });
      }
      await retryBeforeReconnect(deadline);
      continue;
    }
    if (!response.ok) {
      if (response.status >= 500 && response.status <= 599) {
        await retryBeforeReconnect(deadline);
        continue;
      }
      throw new UserPdfOcrProbeError({
        code: 'http',
        stage: 'extraction',
        status: response.status,
      });
    }

    const stream = await readProbeStream(response, captureId, lastEventSequence, deadline);
    lastEventSequence = Math.max(lastEventSequence, stream.sequence);
    if (stream.kind === 'timeout') {
      throw new UserPdfOcrProbeError({ code: 'timeout', stage: 'extraction' });
    }
    if (stream.kind === 'event' && stream.event['eventType'] === 'resync_required') {
      let snapshot: Record<string, unknown>;
      try {
        snapshot = normalizeCaptureSnapshot(
          await getJsonUntilDeadline(
            `${baseUrl}/v2/captures/${encodeURIComponent(captureId)}`,
            token,
            fetchImplementation,
            deadline,
          ),
          captureId,
        );
      } catch (error) {
        if (!isRetryableProbeError(error)) throw error;
        await retryBeforeReconnect(deadline);
        continue;
      }
      lastEventSequence = Math.max(
        lastEventSequence,
        snapshot['lastEventSequence'] as number,
      );
      if (snapshot['status'] === 'failed' || snapshot['status'] === 'cancelled') {
        throw new UserPdfOcrProbeError({ code: 'capture_failed', stage: 'extraction' });
      }
      if (snapshot['status'] === 'completed' || snapshot['status'] === 'awaiting_structuring') {
        return snapshot;
      }
      await retryBeforeReconnect(deadline);
      continue;
    }
    if (stream.kind === 'event') {
      if (stream.event['eventType'] === 'failed' || stream.event['eventType'] === 'cancelled') {
        throw new UserPdfOcrProbeError({ code: 'capture_failed', stage: 'extraction' });
      }
      return stream.event;
    }

    let snapshot: Record<string, unknown>;
    try {
      snapshot = normalizeCaptureSnapshot(
        await getJsonUntilDeadline(
          `${baseUrl}/v2/captures/${encodeURIComponent(captureId)}`,
          token,
          fetchImplementation,
          deadline,
        ),
        captureId,
      );
    } catch (error) {
      if (!isRetryableProbeError(error)) throw error;
      await retryBeforeReconnect(deadline);
      continue;
    }
    lastEventSequence = Math.max(
      lastEventSequence,
      snapshot['lastEventSequence'] as number,
    );
    if (snapshot['status'] === 'failed' || snapshot['status'] === 'cancelled') {
      throw new UserPdfOcrProbeError({ code: 'capture_failed', stage: 'extraction' });
    }
    if (snapshot['status'] === 'completed' || snapshot['status'] === 'awaiting_structuring') {
      return snapshot;
    }
    await retryBeforeReconnect(deadline);
  }
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
      'X-Idempotency-Key': requestId,
    },
    body: JSON.stringify({
      protocolVersion: '2',
      clientRequestId: requestId,
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
