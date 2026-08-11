import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { basename, join, resolve } from 'node:path';

import { assertStagedRuntime } from './assert-staged-runtime.ts';
import { appRoot, stagedExecutable } from './stage-runtime.ts';

const workspaceRoot = resolve(appRoot, '..', '..');
const outputDirectory = join(workspaceRoot, 'tmp', 'capture-workbench-desktop', 'real-ollama-smoke');
const maxWaitMs = 10 * 60_000;
const maxInstallationWaitMs = 75 * 60_000;
const coreRequirementIds = [
  'windowsml-ocr',
  'ollama-runtime',
] as const;

interface CaptureOperation {
  readonly captureId: string;
  readonly ingestionId: string;
  readonly status: string;
  readonly progress: number;
  readonly error?: { readonly message?: string } | null;
}

interface IngestionRecord {
  readonly ingestionId: string;
}

interface TerminalResult {
  readonly operation: CaptureOperation;
  readonly raw: unknown;
  readonly result: Record<string, unknown>;
}

interface StreamingEvent {
  readonly sequence: number;
  readonly eventType: string;
  readonly stage: string;
}

interface RuntimeRequirement {
  readonly requirementId: string;
  readonly status: string;
  readonly detail?: string | null;
}

interface RuntimeInstallation {
  readonly installationId: string;
  readonly requirementId: string;
  readonly status: string;
  readonly error?: { readonly message?: string } | null;
}

interface RuntimeModelInstallation {
  readonly installationId: string;
  readonly optionId: string;
  readonly status: string;
  readonly error?: { readonly message?: string } | null;
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('Real Ollama smoke is Windows-only.');
  }
  const sourcePath = requiredPath('CAPTURE_REAL_SMOKE_PDF');
  const appData = requiredPath('CAPTURE_REAL_SMOKE_APP_DATA');
  if (!sourcePath.toLowerCase().endsWith('.pdf')) {
    throw new Error('CAPTURE_REAL_SMOKE_PDF must identify a PDF.');
  }
  await requireRegularFile(sourcePath, 'CAPTURE_REAL_SMOKE_PDF');
  await requireDirectory(appData, 'CAPTURE_REAL_SMOKE_APP_DATA');
  const sourceBytes = await readFile(sourcePath);
  if (sourceBytes.length === 0 || sourceBytes.length > 50 * 1024 * 1024) {
    throw new Error('CAPTURE_REAL_SMOKE_PDF must contain 1 through 52428800 bytes.');
  }

  await observe(assertStagedRuntime('release'));
  const runtimePort = await reservePort();
  const ollamaPort = await reservePort(runtimePort);
  const token = randomBytes(32).toString('hex');
  const host = `127.0.0.1:${runtimePort}`;
  const origin = 'http://tauri.localhost';
  const child = spawn(stagedExecutable, ['serve', '--host', '127.0.0.1', '--port', String(runtimePort)], {
    cwd: resolve(stagedExecutable, '..'),
    windowsHide: true,
    stdio: 'ignore',
    env: realRuntimeEnvironment({ appData, runtimePort, ollamaPort, token }),
  });
  let captureId: string | undefined;
  let ingestionId: string | undefined;
  try {
    await waitForReady(runtimePort, host, origin, token, child);
    await prepareCoreRequirements(runtimePort, host, origin, token);
    await prepareSelectedModel(runtimePort, host, origin, token);
    const form = new Map<string, string>();
    form.set('sourceKind', 'pdf');
    form.set('structuringMode', 'runtime');
    form.set('targetLanguage', 'zh-TW');
    const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
    const ingestion = await request<IngestionRecord>(
      runtimePort,
      host,
      origin,
      token,
      '/v2/ingestions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientRequestId: randomUUID(),
          kind: form.get('sourceKind'),
          mode: 'file',
          fileName: basename(sourcePath),
          mediaType: 'application/pdf',
          totalBytes: sourceBytes.length,
          sourceSha256,
        }),
      },
    );
    ingestionId = ingestion.ingestionId;
    await uploadChunks(runtimePort, host, origin, token, ingestionId, sourceBytes);
    await request(runtimePort, host, origin, token, `/v2/ingestions/${ingestionId}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ totalBytes: sourceBytes.length, sha256: sourceSha256 }),
    });
    const created = await request<CaptureOperation>(
      runtimePort,
      host,
      origin,
      token,
      '/v2/captures',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientRequestId: randomUUID(),
          ingestionId,
          structuringMode: form.get('structuringMode'),
          startPolicy: 'eager',
          targetLanguage: form.get('targetLanguage'),
        }),
      },
    );
    captureId = created.captureId;
    const terminal = await waitForTerminal(runtimePort, host, origin, token, captureId);
    if (terminal.status !== 'completed') {
      throw new Error(`Real capture ended as ${terminal.status}: ${terminal.error?.message ?? 'no detail'}`);
    }
    const events = await readStreamingEvents(runtimePort, host, origin, token, captureId);
    assertStreamingEventOrder(events);
    const replayCursor = events[events.length - 2]?.sequence;
    const terminalSequence = events[events.length - 1]?.sequence;
    assert.ok(replayCursor !== undefined && terminalSequence !== undefined);
    const replayed = await readStreamingEvents(
      runtimePort,
      host,
      origin,
      token,
      captureId,
      replayCursor,
    );
    assertStreamingEventOrder(replayed, replayCursor, false);
    const afterTerminal = await readStreamingEvents(
      runtimePort,
      host,
      origin,
      token,
      captureId,
      terminalSequence,
    );
    assert.equal(afterTerminal.length, 0, 'Last-Event-ID replay duplicated the terminal event.');
    const result = await request<TerminalResult>(
      runtimePort, host, origin, token, `/v2/captures/${captureId}/result`,
    );
    const structuring = result.result['structuringEngine'] as Record<string, unknown> | undefined;
    if (
      !structuring ||
      structuring['engine'] !== 'ollama' ||
      structuring['model'] !== 'capture-workbench-qwen3.5-0.8b-structure-v1' ||
      typeof structuring['digest'] !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/u.test(structuring['digest'])
    ) {
      throw new Error('Real capture result does not contain isolated Ollama profile provenance.');
    }
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, 'real-ollama-smoke.json'), `${JSON.stringify({
      evidenceKind: 'real-isolated-ollama-smoke',
      releaseGateSatisfied: true,
      sourceKind: 'pdf',
      schemaVersion: result.result['schemaVersion'],
      structuringEngine: { engine: structuring['engine'], model: structuring['model'], digest: structuring['digest'] },
    }, null, 2)}\n`, 'utf8');
    process.stdout.write(`Real Ollama smoke report: ${join(outputDirectory, 'real-ollama-smoke.json')}\n`);
  } finally {
    if (captureId) {
      await request<void>(runtimePort, host, origin, token, `/v2/captures/${captureId}`, { method: 'DELETE' }).catch(() => undefined);
    }
    if (ingestionId) {
      await request<void>(runtimePort, host, origin, token, `/v2/ingestions/${ingestionId}`, { method: 'DELETE' }).catch(() => undefined);
    }
    terminateOwnedTree(child.pid);
  }
}

async function prepareCoreRequirements(
  port: number,
  host: string,
  origin: string,
  token: string,
): Promise<void> {
  const listed = await request<{ readonly items: readonly RuntimeRequirement[] }>(
    port,
    host,
    origin,
    token,
    '/v1/runtime/requirements',
  );
  for (const requirementId of coreRequirementIds) {
    const requirement = listed.items.find((item) => item.requirementId === requirementId);
    if (!requirement) {
      throw new Error(`Real runtime did not expose required ${requirementId}.`);
    }
    if (requirement.status === 'ready') continue;
    if (requirement.status !== 'installable') {
      throw new Error(
        `Real runtime cannot prepare ${requirementId}: ${requirement.status}${requirement.detail ? ` (${requirement.detail})` : ''}.`,
      );
    }
    const started = await request<RuntimeInstallation>(
      port,
      host,
      origin,
      token,
      '/v1/runtime/installations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-idempotency-key': randomUUID(),
        },
        body: JSON.stringify({ requirementId, consent: true }),
      },
    );
    await waitForInstallation(port, host, origin, token, started);
  }
  const verified = await request<{ readonly items: readonly RuntimeRequirement[] }>(
    port,
    host,
    origin,
    token,
    '/v1/runtime/requirements',
  );
  for (const requirementId of coreRequirementIds) {
    const status = verified.items.find((item) => item.requirementId === requirementId)?.status;
    if (status !== 'ready') {
      throw new Error(`Real runtime did not finish preparing ${requirementId}.`);
    }
  }
}

async function prepareSelectedModel(
  port: number,
  host: string,
  origin: string,
  token: string,
): Promise<void> {
  const options = await request<{
    readonly items: readonly { readonly optionId: string; readonly status: string }[];
  }>(port, host, origin, token, '/v1/runtime/model-options');
  const option = options.items.find((item) => item.optionId === 'qwen3.5-0.8b-v1');
  if (!option) throw new Error('Real runtime did not expose the qwen3.5 0.8B model option.');
  if (option.status === 'active') return;
  const installation = await request<RuntimeModelInstallation>(
    port,
    host,
    origin,
    token,
    '/v1/runtime/model-installations',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ optionId: option.optionId, consent: true }),
    },
  );
  await waitForModelInstallation(port, host, origin, token, installation);
}

function realRuntimeEnvironment(input: { appData: string; runtimePort: number; ollamaPort: number; token: string }): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['COMSPEC', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'PROGRAMDATA', 'SYSTEMDRIVE', 'SYSTEMROOT', 'USERPROFILE', 'WINDIR']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return {
    ...environment,
    CAPTURE_HOST: '127.0.0.1', CAPTURE_PORT: String(input.runtimePort), CAPTURE_API_TOKEN: input.token,
    CAPTURE_ALLOWED_HOSTS: `127.0.0.1:${input.runtimePort}`, CAPTURE_ALLOWED_ORIGINS: 'http://tauri.localhost,tauri://localhost',
    CAPTURE_ENABLE_API_DOCS: 'false', CAPTURE_APP_DATA_DIR: join(input.appData, 'runtime'),
    CAPTURE_STRUCTURING_PROVIDER: 'ollama', CAPTURE_RETENTION_HOURS: '24', CAPTURE_MAX_UPLOAD_BYTES: String(50 * 1024 * 1024),
    CAPTURE_OLLAMA_HOST: `http://127.0.0.1:${input.ollamaPort}`, CAPTURE_OLLAMA_APP_DATA: join(input.appData, 'ollama'),
    CAPTURE_OLLAMA_PID_FILE: join(input.appData, 'ollama', 'ollama.pid'), OLLAMA_HOST: `127.0.0.1:${input.ollamaPort}`,
    OLLAMA_MODELS: join(input.appData, 'ollama', 'models'),
  };
}

async function request<T>(port: number, host: string, origin: string, token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, origin, ...init.headers },
  });
  if (!response.ok) throw new Error(`Runtime request failed with ${response.status}.`);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function waitForReady(port: number, host: string, origin: string, token: string, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Real runtime exited before readiness.');
    try {
      const ready = await request<{ readonly ready: boolean }>(port, host, origin, token, '/v1/health/ready');
      if (ready.ready) return;
    } catch { /* Runtime is still starting. */ }
    await delay(500);
  }
  throw new Error('Real runtime did not become ready before the timeout.');
}

async function waitForTerminal(port: number, host: string, origin: string, token: string, captureId: string): Promise<CaptureOperation> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const operation = await request<CaptureOperation>(
      port,
      host,
      origin,
      token,
      `/v2/captures/${captureId}`,
    );
    if (isTerminalStatus(operation.status)) return operation;
    await delay(750);
  }
  throw new Error('Real capture did not reach a terminal state before the timeout.');
}

async function uploadChunks(
  port: number,
  host: string,
  origin: string,
  token: string,
  ingestionId: string,
  bytes: Uint8Array,
): Promise<void> {
  const chunkSize = 1024 * 1024;
  for (let offset = 0, index = 0; offset < bytes.length; offset += chunkSize, index += 1) {
    const end = Math.min(bytes.length, offset + chunkSize);
    const chunk = bytes.subarray(offset, end);
    const digest = createHash('sha256').update(chunk).digest('hex');
    await request(port, host, origin, token, `/v2/ingestions/${ingestionId}/chunks/${index}`, {
      method: 'PUT',
      headers: {
        'Content-Range': `bytes ${offset}-${end - 1}/${bytes.length}`,
        Digest: `sha-256=${digest}`,
        'X-Idempotency-Key': `real-ollama-${index}`,
      },
      body: chunk,
    });
  }
}

async function readStreamingEvents(
  port: number,
  host: string,
  origin: string,
  token: string,
  captureId: string,
  lastEventId?: number,
): Promise<StreamingEvent[]> {
  const response = await fetch(`http://127.0.0.1:${port}/v2/captures/${captureId}/events`, {
    headers: {
      authorization: `Bearer ${token}`,
      origin,
      ...(lastEventId === undefined ? {} : { 'Last-Event-ID': String(lastEventId) }),
    },
  });
  if (!response.ok) throw new Error(`Runtime events request failed with ${response.status}.`);
  assert.match(
    response.headers.get('content-type') ?? '',
    /^text\/event-stream(?:;|$)/iu,
  );
  const text = await response.text();
  return parseStreamingEvents(text);
}

export function parseStreamingEvents(text: string): StreamingEvent[] {
  const normalized = text.replace(/\r\n?/gu, '\n');
  if (normalized && !normalized.endsWith('\n\n')) {
    throw new Error('Real Ollama SSE response ended with an incomplete event frame.');
  }
  const events: StreamingEvent[] = [];
  let id: string | undefined;
  let event: string | undefined;
  let data: string[] = [];
  const dispatch = (): void => {
    if (id === undefined && event === undefined && data.length === 0) return;
    if (id === undefined || event === undefined || data.length === 0) {
      throw new Error('Real Ollama SSE response contained an incomplete event frame.');
    }
    const sequence = Number(id);
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      throw new Error('Real Ollama SSE event id was not a positive safe integer.');
    }
    const payload = JSON.parse(data.join('\n')) as {
      readonly eventType?: unknown;
      readonly sequence?: unknown;
      readonly stage?: unknown;
    };
    if (
      payload.sequence !== sequence ||
      payload.eventType !== event ||
      typeof payload.stage !== 'string'
    ) {
      throw new Error('Real Ollama SSE event metadata did not match its frame.');
    }
    events.push({ sequence, eventType: event, stage: payload.stage });
    id = undefined;
    event = undefined;
    data = [];
  };
  for (const line of normalized.split('\n')) {
    if (line === '') {
      dispatch();
      continue;
    }
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return events;
}

export function assertStreamingEventOrder(
  events: readonly StreamingEvent[],
  afterSequence = 0,
  requireAccepted = true,
): void {
  if (events.length === 0) {
    throw new Error('Real Ollama event stream did not contain any events.');
  }
  const types = events.map((event) => event.eventType);
  const sequences = events.map((event) => event.sequence);
  if (new Set(sequences).size !== sequences.length) {
    throw new Error('Real Ollama event stream contained duplicate sequences.');
  }
  if (sequences.some((sequence, index) => index > 0 && sequence <= sequences[index - 1])) {
    throw new Error('Real Ollama event stream sequences were not strictly increasing.');
  }
  if (sequences[0] <= afterSequence) {
    throw new Error('Real Ollama Last-Event-ID replay returned a duplicate cursor event.');
  }
  const terminalIndexes = types
    .map((type, index) => (isTerminalStatus(type) ? index : -1))
    .filter((index) => index >= 0);
  const acceptedIndex = types.indexOf('accepted');
  if (
    terminalIndexes.length !== 1 ||
    terminalIndexes[0] !== events.length - 1 ||
    (requireAccepted && acceptedIndex < 0) ||
    (acceptedIndex >= 0 && acceptedIndex >= terminalIndexes[0])
  ) {
    throw new Error(
      'Real Ollama event stream must place accepted before exactly one terminal event, last.',
    );
  }
}

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

async function waitForInstallation(
  port: number,
  host: string,
  origin: string,
  token: string,
  installation: RuntimeInstallation,
): Promise<void> {
  const deadline = Date.now() + maxInstallationWaitMs;
  while (Date.now() < deadline) {
    const current = await request<RuntimeInstallation>(
      port,
      host,
      origin,
      token,
      `/v1/runtime/installations/${installation.installationId}`,
    );
    if (current.status === 'completed') return;
    if (!['queued', 'running'].includes(current.status)) {
      throw new Error(
        `Real ${current.requirementId} installation ended as ${current.status}: ${current.error?.message ?? 'no detail'}.`,
      );
    }
    await delay(1_000);
  }
  throw new Error(`Real ${installation.requirementId} installation timed out.`);
}

async function waitForModelInstallation(
  port: number,
  host: string,
  origin: string,
  token: string,
  installation: RuntimeModelInstallation,
): Promise<void> {
  const deadline = Date.now() + maxInstallationWaitMs;
  while (Date.now() < deadline) {
    const current = await request<RuntimeModelInstallation>(
      port,
      host,
      origin,
      token,
      `/v1/runtime/model-installations/${installation.installationId}`,
    );
    if (current.status === 'completed') return;
    if (!['queued', 'running'].includes(current.status)) {
      throw new Error(
        `Real ${current.optionId} model installation ended as ${current.status}: ${current.error?.message ?? 'no detail'}.`,
      );
    }
    await delay(1_000);
  }
  throw new Error(`Real ${installation.optionId} model installation timed out.`);
}

function requiredPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set explicitly for real Ollama smoke.`);
  return resolve(value);
}

async function requireRegularFile(path: string, name: string): Promise<void> {
  const metadata = await stat(path).catch(() => undefined);
  if (!metadata?.isFile()) throw new Error(`${name} must be an existing regular file.`);
}

async function requireDirectory(path: string, name: string): Promise<void> {
  const metadata = await stat(path).catch(() => undefined);
  if (!metadata?.isDirectory()) throw new Error(`${name} must be an existing prepared app-data directory.`);
}

function reservePort(excluded?: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : port && port !== excluded ? resolvePort(port) : reservePort(excluded).then(resolvePort, reject));
    });
  });
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)); }

function terminateOwnedTree(pid: number | undefined): void {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

function observe<T>(observable: { subscribe: (observer: { next: (value: T) => void; error: (error: unknown) => void }) => unknown }): Promise<T> {
  return new Promise((resolveValue, reject) => observable.subscribe({ next: resolveValue, error: reject }));
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
