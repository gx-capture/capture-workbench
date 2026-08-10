import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import net from 'node:net';

import { assertStagedRuntime } from './assert-staged-runtime.ts';
import { appRoot, stagedExecutable } from './stage-runtime.ts';
import { pathToFileURL } from 'node:url';

const workspaceRoot = resolve(appRoot, '..', '..');
const outputDirectory = join(
  workspaceRoot,
  'tmp',
  'capture-workbench-desktop',
  'real-media-smoke',
);
const evidencePath = join(outputDirectory, 'real-media-smoke.json');
const maxInstallationWaitMs = 90 * 60_000;
const maxCaptureWaitMs = 20 * 60_000;
export const dependencyOrder = ['windowsml-ocr', 'whisper-primary'] as const;

const canonicalSourceLockPath = join(
  workspaceRoot,
  'packages',
  'capture-runtime',
  'model-sources',
  'release-model-source-lock.json',
);
const embeddedEngineCatalogPath = join(
  workspaceRoot,
  'packages',
  'capture-runtime',
  'src',
  'capture_runtime',
  'assets',
  'engine-catalog.json',
);

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

interface CaptureJob {
  readonly captureId: string;
  readonly status: string;
  readonly stage: string;
  readonly error?: { readonly message?: string } | null;
}

interface RawCapture {
  readonly source: Record<string, unknown>;
  readonly sourceText: string;
  readonly createdAt: string;
  readonly segments: readonly {
    readonly segmentId: string;
    readonly order: number;
    readonly locator: { readonly kind: string };
    readonly text: string;
  }[];
  readonly extractionEngine: {
    readonly engine: string;
    readonly model: string;
    readonly digest: string;
    readonly device?: string | null;
  };
}

interface CaptureResult {
  readonly extractionEngine: RawCapture['extractionEngine'];
  readonly structuringEngine: {
    readonly engine: string;
    readonly model: string;
    readonly digest: string;
  };
}

interface MediaEvidence {
  readonly evidenceKind: 'real-core-first-media-diagnostic';
  readonly releaseGateSatisfied: false;
  readonly consumerE2e: false;
  readonly dependencyOrder: readonly ['windowsml-ocr', 'whisper-primary'];
  readonly pdf: {
    readonly extractionEngine: string;
    readonly model: string;
    readonly device: string;
    readonly segmentCount: number;
    readonly pageLocators: number;
  };
  readonly image: {
    readonly extractionEngine: string;
    readonly model: string;
    readonly device: string;
    readonly segmentCount: number;
    readonly pageLocators: number;
  };
  readonly audio: {
    readonly extractionEngine: string;
    readonly model: string;
    readonly device: string;
    readonly segmentCount: number;
    readonly timeLocators: number;
  };
  readonly hostStructuring: true;
  readonly capturesDeletedAfterVerification: true;
  readonly ownedProcessCleanupVerified: true;
}

export interface ExpectedProvenance {
  readonly ocrModel: string;
  readonly whisperModel: string;
  readonly whisperDevice: string;
  readonly whisperPreferGpu: boolean;
}

export interface OwnedRuntimeEvidence {
  readonly pids: readonly number[];
  readonly listeners: readonly {
    readonly pid: number;
    readonly port: number;
  }[];
}

interface JsonObject {
  readonly [key: string]: unknown;
}

interface RequirementFailure {
  readonly requirementId: (typeof dependencyOrder)[number];
  readonly reasons: readonly string[];
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function canonicalRequirementReasons(
  sourceLock: unknown,
  requirementId: (typeof dependencyOrder)[number],
): string[] {
  const lock = asObject(sourceLock);
  if (!lock) return ['canonical source lock is missing or malformed'];

  const rawRequirements = lock['requirements'];
  if (!Array.isArray(rawRequirements)) {
    return ['canonical source lock requirements is missing or malformed'];
  }

  const reasons: string[] = [];
  if (
    !rawRequirements.some(
      (item) => asObject(item)?.['requirementId'] === requirementId,
    )
  ) {
    reasons.push(
      rawRequirements.length === 0
        ? 'canonical source lock has no model-enabled requirements (requirements is empty)'
        : 'canonical source lock does not include it',
    );
  }

  const approval = asObject(lock['approval']);
  const status = approval?.['status'];
  const blockers = approval?.['blockers'];
  if (status !== 'approved') {
    reasons.push(
      `canonical source lock approval is ${typeof status === 'string' ? status : 'not approved'}`,
    );
  } else if (!Array.isArray(blockers)) {
    reasons.push('canonical source lock approval blockers are malformed');
  } else if (blockers.length > 0) {
    reasons.push(
      `canonical source lock approval retains ${blockers.length} blocker(s)`,
    );
  }
  return reasons;
}

function embeddedRequirementReason(
  embeddedCatalog: unknown,
  requirementId: (typeof dependencyOrder)[number],
): string {
  const catalog = asObject(embeddedCatalog);
  if (!catalog) return 'embedded engine catalog is missing or malformed';
  const rawRequirements = catalog['requirements'];
  if (!Array.isArray(rawRequirements)) {
    return 'embedded engine catalog requirements are missing or malformed';
  }
  const requirement = asObject(
    rawRequirements.find(
      (item) => asObject(item)?.['requirementId'] === requirementId,
    ),
  );
  if (!requirement) return 'embedded engine catalog does not expose it';
  const unavailableReason = requirement['unavailableReason'];
  if (typeof unavailableReason === 'string' && unavailableReason.trim()) {
    return `embedded engine catalog marks it unavailable: ${unavailableReason}`;
  }
  if (
    !Array.isArray(requirement['artifacts']) ||
    requirement['artifacts'].length === 0 ||
    !asObject(requirement['modelFiles'])
  ) {
    return 'embedded engine catalog does not contain a complete worker/model delivery';
  }
  return '';
}

function requirementFailures(
  sourceLock: unknown,
  embeddedCatalog: unknown,
): RequirementFailure[] {
  return dependencyOrder.flatMap((requirementId) => {
    const canonicalReasons = canonicalRequirementReasons(
      sourceLock,
      requirementId,
    );
    const embeddedReason = embeddedRequirementReason(
      embeddedCatalog,
      requirementId,
    );
    if (canonicalReasons.length === 0 && !embeddedReason) return [];
    return [
      {
        requirementId,
        reasons: [
          ...canonicalReasons,
          ...(embeddedReason ? [embeddedReason] : []),
        ],
      },
    ];
  });
}

export function assertRealMediaRequirementsAvailable(
  sourceLock: unknown,
  embeddedCatalog: unknown,
): void {
  const failures = requirementFailures(sourceLock, embeddedCatalog);
  if (failures.length === 0) {
    const sourceVersion = asObject(sourceLock)?.['releaseVersion'];
    const catalogVersion = asObject(embeddedCatalog)?.['runtimeVersion'];
    if (
      typeof sourceVersion !== 'string' ||
      !sourceVersion.trim() ||
      sourceVersion === '0.3.8'
    ) {
      throw new Error(
        'Real media diagnostic requires an explicitly selected unused successor version; v0.3.8 is immutable core-only.',
      );
    }
    if (catalogVersion !== sourceVersion) {
      throw new Error(
        `Real media diagnostic version mismatch: source lock ${sourceVersion}, embedded catalog ${String(catalogVersion)}.`,
      );
    }
    return;
  }
  throw new Error(
    `Real media smoke preflight failed before release-artifact build or app startup; unavailable requirements: ${failures
      .map(
        ({ requirementId, reasons }) =>
          `${requirementId} (${reasons.join('; ')})`,
      )
      .join(', ')}.`,
  );
}

async function readJsonOrUndefined(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function realMediaCandidateFromFiles(): Promise<ExpectedProvenance> {
  const [sourceLock, embeddedCatalog] = await Promise.all([
    readJsonOrUndefined(canonicalSourceLockPath),
    readJsonOrUndefined(embeddedEngineCatalogPath),
  ]);
  assertRealMediaRequirementsAvailable(sourceLock, embeddedCatalog);
  return expectedProvenanceFromSourceLock(sourceLock);
}

export function expectedProvenanceFromSourceLock(
  sourceLock: unknown,
): ExpectedProvenance {
  const fixtures = asObject(sourceLock)?.['fixtures'];
  if (!Array.isArray(fixtures)) {
    throw new Error('Canonical source lock fixtures are missing or malformed.');
  }
  const ocr = asObject(
    fixtures.find((fixture) => asObject(fixture)?.['kind'] === 'ocr'),
  );
  const whisper = asObject(
    fixtures.find((fixture) => asObject(fixture)?.['kind'] === 'whisper'),
  );
  if (
    ocr?.['expectedEngine'] !== 'windowsml-ocr' ||
    ocr['expectedDevice'] !== 'windowsml-dml' ||
    typeof ocr['expectedModel'] !== 'string'
  ) {
    throw new Error('Canonical OCR fixture does not pin DirectML provenance.');
  }
  const whisperRole = whisper?.['expectedModel'];
  const whisperDevice = whisper?.['expectedDevice'];
  const whisperPreferGpu = whisper?.['preferGpu'];
  if (
    whisper?.['expectedEngine'] !== 'whisper-primary' ||
    !['primary', 'fallback'].includes(String(whisperRole)) ||
    !['cuda', 'cpu'].includes(String(whisperDevice)) ||
    typeof whisperPreferGpu !== 'boolean'
  ) {
    throw new Error(
      'Canonical Whisper fixture does not pin execution provenance.',
    );
  }
  return {
    ocrModel: ocr['expectedModel'],
    whisperModel: String(whisperRole),
    whisperDevice: String(whisperDevice),
    whisperPreferGpu,
  };
}

export function assertRealMediaEvidence(
  value: unknown,
): asserts value is MediaEvidence {
  const report = value as Partial<MediaEvidence> | undefined;
  assert.equal(report?.evidenceKind, 'real-core-first-media-diagnostic');
  assert.equal(report?.releaseGateSatisfied, false);
  assert.equal(report?.consumerE2e, false);
  assert.deepEqual(report?.dependencyOrder, dependencyOrder);
  assert.equal(report?.hostStructuring, true);
  assert.equal(report?.capturesDeletedAfterVerification, true);
  assert.equal(report?.ownedProcessCleanupVerified, true);
  assert.equal(report?.pdf?.extractionEngine, 'windowsml-ocr');
  assert.equal(report?.pdf?.device, 'windowsml-dml');
  assert.ok((report?.pdf?.segmentCount ?? 0) > 0);
  assert.ok((report?.pdf?.pageLocators ?? 0) > 0);
  assert.equal(report?.image?.extractionEngine, 'windowsml-ocr');
  assert.equal(report?.image?.device, 'windowsml-dml');
  assert.ok((report?.image?.segmentCount ?? 0) > 0);
  assert.ok((report?.image?.pageLocators ?? 0) > 0);
  assert.equal(report?.audio?.extractionEngine, 'whisper-primary');
  assert.ok((report?.audio?.segmentCount ?? 0) > 0);
  assert.ok((report?.audio?.timeLocators ?? 0) > 0);
  assert.doesNotMatch(JSON.stringify(report), /[A-Za-z]:[\\/]/u);
}

async function main(): Promise<void> {
  const expectedProvenance = await realMediaCandidateFromFiles();
  if (process.argv.includes('--preflight')) return;
  if (process.platform !== 'win32')
    throw new Error('Real media smoke is Windows-only.');
  const pdfPath = requiredPath('CAPTURE_REAL_MEDIA_PDF');
  const imagePath = requiredPath('CAPTURE_REAL_MEDIA_IMAGE');
  const audioPath = requiredPath('CAPTURE_REAL_MEDIA_AUDIO');
  const appData = requiredPath('CAPTURE_REAL_MEDIA_APP_DATA');
  await requireRegularFile(pdfPath, 'CAPTURE_REAL_MEDIA_PDF');
  await requireRegularFile(imagePath, 'CAPTURE_REAL_MEDIA_IMAGE');
  await requireRegularFile(audioPath, 'CAPTURE_REAL_MEDIA_AUDIO');
  await requireDirectory(appData, 'CAPTURE_REAL_MEDIA_APP_DATA');
  const pdfBytes = await readFile(pdfPath);
  const imageBytes = await readFile(imagePath);
  const audioBytes = await readFile(audioPath);
  if (
    pdfBytes.length === 0 ||
    imageBytes.length === 0 ||
    audioBytes.length === 0
  ) {
    throw new Error('Real media fixtures must not be empty.');
  }

  await observe(assertStagedRuntime('release'));
  const runtimePort = await reservePort();
  const token = randomBytes(32).toString('hex');
  const child = spawn(
    stagedExecutable,
    ['serve', '--host', '127.0.0.1', '--port', String(runtimePort)],
    {
      cwd: resolve(stagedExecutable, '..'),
      windowsHide: true,
      stdio: 'ignore',
      env: runtimeEnvironment(appData, runtimePort, token, expectedProvenance),
    },
  );
  const captureIds: string[] = [];
  let pdf: Awaited<ReturnType<typeof captureAndVerify>> | undefined;
  let image: Awaited<ReturnType<typeof captureAndVerify>> | undefined;
  let audio: Awaited<ReturnType<typeof captureAndVerify>> | undefined;
  try {
    await waitForReady(runtimePort, token, child);
    await installDependencies(runtimePort, token);
    pdf = await captureAndVerify(
      runtimePort,
      token,
      pdfBytes,
      'pdf',
      basename(pdfPath),
      captureIds,
      expectedProvenance,
    );
    image = await captureAndVerify(
      runtimePort,
      token,
      imageBytes,
      'image',
      basename(imagePath),
      captureIds,
      expectedProvenance,
    );
    audio = await captureAndVerify(
      runtimePort,
      token,
      audioBytes,
      'audio',
      basename(audioPath),
      captureIds,
      expectedProvenance,
    );
    await deleteCapturesAndVerify(runtimePort, token, captureIds);
  } finally {
    for (const captureId of captureIds) {
      await request<void>(runtimePort, token, `/v1/captures/${captureId}`, {
        method: 'DELETE',
      }).catch(() => undefined);
    }
    await terminateOwnedTree(child);
  }
  assert.ok(pdf && image && audio);
  const report: MediaEvidence = {
    evidenceKind: 'real-core-first-media-diagnostic',
    releaseGateSatisfied: false,
    consumerE2e: false,
    dependencyOrder,
    pdf: mediaSummary(pdf.raw, 'page'),
    image: mediaSummary(image.raw, 'page'),
    audio: mediaSummary(audio.raw, 'time'),
    hostStructuring: true,
    capturesDeletedAfterVerification: true,
    ownedProcessCleanupVerified: true,
  };
  assertRealMediaEvidence(report);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`Real media diagnostic report: ${evidencePath}\n`);
}

async function installDependencies(port: number, token: string): Promise<void> {
  const listed = await request<{
    readonly items: readonly RuntimeRequirement[];
  }>(port, token, '/v1/runtime/requirements');
  for (const requirementId of dependencyOrder) {
    const requirement = listed.items.find(
      (item) => item.requirementId === requirementId,
    );
    if (!requirement) throw new Error(`Core did not expose ${requirementId}.`);
    if (requirement.status === 'ready') continue;
    if (requirement.status !== 'installable') {
      throw new Error(
        `Core cannot install ${requirementId}: ${requirement.status}${requirement.detail ? ` (${requirement.detail})` : ''}.`,
      );
    }
    const installation = await request<RuntimeInstallation>(
      port,
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
    await waitForInstallation(port, token, installation);
  }
}

async function captureAndVerify(
  port: number,
  token: string,
  bytes: Uint8Array,
  sourceKind: 'pdf' | 'image' | 'audio',
  fileName: string,
  captureIds: string[],
  expectedProvenance: ExpectedProvenance,
): Promise<{ readonly raw: RawCapture; readonly result: CaptureResult }> {
  const form = new FormData();
  form.set('sourceKind', sourceKind);
  form.set('structuringMode', 'host');
  form.set('targetLanguage', 'zh-TW');
  form.set(
    'file',
    new Blob([bytes], {
      type: fixtureMediaType(sourceKind, fileName),
    }),
    fileName,
  );
  const created = await request<CaptureJob>(port, token, '/v1/captures', {
    method: 'POST',
    headers: { 'x-idempotency-key': randomUUID() },
    body: form,
  });
  captureIds.push(created.captureId);
  const awaiting = await waitForAwaitingStructuring(
    port,
    token,
    created.captureId,
  );
  if (
    awaiting.status !== 'running' ||
    awaiting.stage !== 'awaiting_structuring'
  ) {
    throw new Error(
      `Real ${sourceKind} extraction ended as ${awaiting.status}/${awaiting.stage}.`,
    );
  }
  const raw = await request<RawCapture>(
    port,
    token,
    `/v1/captures/${created.captureId}/raw`,
  );
  if (raw.segments.length === 0 || !raw.sourceText.trim()) {
    throw new Error(`Real ${sourceKind} extraction returned no text.`);
  }
  if (sourceKind === 'pdf' || sourceKind === 'image') {
    assert.equal(raw.extractionEngine.engine, 'windowsml-ocr');
    assert.equal(raw.extractionEngine.model, expectedProvenance.ocrModel);
    assert.equal(raw.extractionEngine.device, 'windowsml-dml');
    assert.ok(raw.segments.some((segment) => segment.locator.kind === 'page'));
  } else {
    assert.equal(raw.extractionEngine.engine, 'whisper-primary');
    assert.equal(raw.extractionEngine.model, expectedProvenance.whisperModel);
    if (expectedProvenance.whisperPreferGpu) {
      assert.ok(['cuda', 'cpu'].includes(raw.extractionEngine.device));
    } else {
      assert.equal(raw.extractionEngine.device, expectedProvenance.whisperDevice);
    }
    assert.ok(raw.segments.some((segment) => segment.locator.kind === 'time'));
  }
  assert.match(raw.extractionEngine.digest, /^sha256:[a-f0-9]{64}$/u);
  const candidate = hostCandidate(raw);
  const committed = await request<CaptureJob>(
    port,
    token,
    `/v1/captures/${created.captureId}/structure`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': randomUUID(),
      },
      body: JSON.stringify(candidate),
    },
  );
  const completed = await waitForTerminal(port, token, committed.captureId);
  if (completed.status !== 'completed') {
    throw new Error(
      `Real ${sourceKind} capture ended as ${completed.status}: ${completed.error?.message ?? 'no detail'}.`,
    );
  }
  const result = await request<CaptureResult>(
    port,
    token,
    `/v1/captures/${created.captureId}/result`,
  );
  assert.equal(result.extractionEngine.engine, raw.extractionEngine.engine);
  assert.equal(result.structuringEngine.engine, 'host');
  assert.match(result.structuringEngine.digest, /^sha256:[a-f0-9]{64}$/u);
  return { raw, result };
}

function fixtureMediaType(
  sourceKind: 'pdf' | 'image' | 'audio',
  fileName: string,
): string {
  const normalized = fileName.toLowerCase();
  if (sourceKind === 'pdf') return 'application/pdf';
  if (sourceKind === 'image') {
    if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) {
      return 'image/jpeg';
    }
    if (normalized.endsWith('.webp')) return 'image/webp';
    return 'image/png';
  }
  if (normalized.endsWith('.wav')) return 'audio/wav';
  if (normalized.endsWith('.m4a')) return 'audio/mp4';
  return 'audio/mpeg';
}

function mediaSummary(
  raw: RawCapture,
  locatorKind: 'page',
): MediaEvidence['pdf'];
function mediaSummary(
  raw: RawCapture,
  locatorKind: 'time',
): MediaEvidence['audio'];
function mediaSummary(
  raw: RawCapture,
  locatorKind: 'page' | 'time',
): MediaEvidence['pdf'] | MediaEvidence['audio'] {
  const device = raw.extractionEngine.device;
  if (typeof device !== 'string' || !device) {
    throw new Error('Real media extraction omitted device provenance.');
  }
  const locatorCount = raw.segments.filter(
    (segment) => segment.locator.kind === locatorKind,
  ).length;
  return {
    extractionEngine: raw.extractionEngine.engine,
    model: raw.extractionEngine.model,
    device,
    segmentCount: raw.segments.length,
    ...(locatorKind === 'page'
      ? { pageLocators: locatorCount }
      : { timeLocators: locatorCount }),
  } as MediaEvidence['pdf'] | MediaEvidence['audio'];
}

function hostCandidate(raw: RawCapture): Record<string, unknown> {
  const blocks = raw.segments.map((segment, order) => ({
    blockId: `block-${order + 1}`,
    order: segment.order,
    type: segment.locator.kind === 'time' ? 'transcript' : 'paragraph',
    sourceSegmentId: segment.segmentId,
    locator: segment.locator,
    sourceText: segment.text,
    targetText: segment.text,
  }));
  return {
    schemaVersion: '1',
    source: raw.source,
    rawSegments: raw.segments,
    blocks,
    sourceText: raw.sourceText,
    targetText: blocks.map((block) => block.targetText).join('\n'),
    extractionEngine: raw.extractionEngine,
    structuringEngine: {
      engine: 'host',
      model: 'real-media-e2e-host-v1',
      digest: `sha256:${'1'.repeat(64)}`,
      device: 'local',
    },
    warnings: [],
    createdAt: raw.createdAt,
    completedAt: new Date().toISOString(),
  };
}

export function runtimeEnvironment(
  appData: string,
  port: number,
  token: string,
  expectedProvenance: ExpectedProvenance,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized = Object.fromEntries(
    Object.entries(inherited).filter(([name]) => {
      const upper = name.toUpperCase();
      return !upper.startsWith('CAPTURE_') && !upper.startsWith('OLLAMA_');
    }),
  );
  return {
    ...sanitized,
    CAPTURE_HOST: '127.0.0.1',
    CAPTURE_PORT: String(port),
    CAPTURE_API_TOKEN: token,
    CAPTURE_ALLOWED_HOSTS: `127.0.0.1:${port}`,
    CAPTURE_ALLOWED_ORIGINS: 'http://tauri.localhost,tauri://localhost',
    CAPTURE_ENABLE_API_DOCS: 'false',
    CAPTURE_APP_DATA_DIR: join(appData, 'runtime-media-smoke'),
    CAPTURE_STRUCTURING_PROVIDER: 'host',
    CAPTURE_EXTRACTION_PROVIDER: 'runtime',
    CAPTURE_RETENTION_HOURS: '24',
    CAPTURE_MAX_UPLOAD_BYTES: String(50 * 1024 * 1024),
    CAPTURE_WINDOWSML_DEVICE_ID: '0',
    CAPTURE_WHISPER_PRIMARY_MODEL: 'large-v3-turbo',
    CAPTURE_WHISPER_FALLBACK_MODEL: 'small',
    CAPTURE_WHISPER_PREFER_GPU: String(expectedProvenance.whisperPreferGpu),
  };
}

async function waitForReady(
  port: number,
  token: string,
  child: ReturnType<typeof spawn>,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error('Core exited before readiness.');
    try {
      const ready = await request<{ readonly ready: boolean }>(
        port,
        token,
        '/v1/health/ready',
      );
      if (ready.ready) return;
    } catch {
      // Core is still starting.
    }
    await delay(500);
  }
  throw new Error('Core did not become ready before the timeout.');
}

async function waitForInstallation(
  port: number,
  token: string,
  installation: RuntimeInstallation,
): Promise<void> {
  const deadline = Date.now() + maxInstallationWaitMs;
  while (Date.now() < deadline) {
    const current = await request<RuntimeInstallation>(
      port,
      token,
      `/v1/runtime/installations/${installation.installationId}`,
    );
    if (current.status === 'completed') return;
    if (!['queued', 'running'].includes(current.status)) {
      throw new Error(
        `Dependency ${current.requirementId} ended as ${current.status}: ${current.error?.message ?? 'no detail'}.`,
      );
    }
    await delay(1_000);
  }
  throw new Error(`Dependency ${installation.requirementId} timed out.`);
}

async function waitForAwaitingStructuring(
  port: number,
  token: string,
  captureId: string,
): Promise<CaptureJob> {
  const deadline = Date.now() + maxCaptureWaitMs;
  while (Date.now() < deadline) {
    const current = await request<CaptureJob>(
      port,
      token,
      `/v1/captures/${captureId}`,
    );
    if (
      current.stage === 'awaiting_structuring' ||
      !['queued', 'running'].includes(current.status)
    )
      return current;
    await delay(1_000);
  }
  throw new Error('Capture did not reach host structuring before the timeout.');
}

async function waitForTerminal(
  port: number,
  token: string,
  captureId: string,
): Promise<CaptureJob> {
  const deadline = Date.now() + maxCaptureWaitMs;
  while (Date.now() < deadline) {
    const current = await request<CaptureJob>(
      port,
      token,
      `/v1/captures/${captureId}`,
    );
    if (!['queued', 'running'].includes(current.status)) return current;
    await delay(500);
  }
  throw new Error('Capture did not reach a terminal state before the timeout.');
}

async function deleteCapturesAndVerify(
  port: number,
  token: string,
  captureIds: string[],
): Promise<void> {
  for (const captureId of [...captureIds]) {
    await request<void>(port, token, `/v1/captures/${captureId}`, {
      method: 'DELETE',
    });
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/captures/${captureId}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          origin: 'http://tauri.localhost',
        },
      },
    );
    if (response.status !== 404) {
      throw new Error(
        `Capture ${captureId} remained readable after UUID-scoped deletion (HTTP ${response.status}).`,
      );
    }
    captureIds.splice(captureIds.indexOf(captureId), 1);
  }
}

async function request<T>(
  port: number,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      origin: 'http://tauri.localhost',
      ...init.headers,
    },
  });
  if (!response.ok)
    throw new Error(
      `Core request ${path} failed with HTTP ${response.status}.`,
    );
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function requiredPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} must be set explicitly for real media smoke.`);
  return resolve(value);
}

async function requireRegularFile(path: string, name: string): Promise<void> {
  const metadata = await stat(path).catch(() => undefined);
  if (!metadata?.isFile())
    throw new Error(`${name} must be an existing regular file.`);
}

async function requireDirectory(path: string, name: string): Promise<void> {
  const metadata = await stat(path).catch(() => undefined);
  if (!metadata?.isDirectory())
    throw new Error(`${name} must be an existing prepared app-data directory.`);
}

function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function terminateOwnedTree(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  const pid = child.pid;
  if (!pid) throw new Error('Owned Capture Runtime did not expose a PID.');
  const owned = observeOwnedRuntimeTree(pid);
  if (isProcessAlive(pid)) {
    const terminated = spawnSync(
      windowsSystemExecutable('System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    if (terminated.error && isProcessAlive(pid)) throw terminated.error;
  }
  const deadline = Date.now() + 10_000;
  let remaining = observeKnownRuntimeProcesses(owned.pids);
  while (
    Date.now() < deadline &&
    (remaining.pids.length > 0 || remaining.listeners.length > 0)
  ) {
    await delay(100);
    remaining = observeKnownRuntimeProcesses(owned.pids);
  }
  if (remaining.pids.length > 0 || remaining.listeners.length > 0) {
    throw new Error(
      `Owned Capture Runtime cleanup left ${remaining.pids.length} process(es) and ${remaining.listeners.length} listener(s).`,
    );
  }
}

export function observeOwnedRuntimeTree(rootPid: number): OwnedRuntimeEvidence {
  return runOwnedRuntimeObserver(`
$rootPid = ${String(rootPid)}
$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
$owned = [System.Collections.Generic.HashSet[int]]::new()
[void]$owned.Add($rootPid)
do {
  $changed = $false
  foreach ($process in $processes) {
    if ($owned.Contains([int]$process.ParentProcessId) -and $owned.Add([int]$process.ProcessId)) {
      $changed = $true
    }
  }
} while ($changed)
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $owned.Contains([int]$_.OwningProcess) } |
  ForEach-Object { [pscustomobject]@{ pid = [int]$_.OwningProcess; port = [int]$_.LocalPort } })
[pscustomobject]@{ pids = @($owned | Sort-Object); listeners = $listeners } | ConvertTo-Json -Compress
`);
}

export function observeKnownRuntimeProcesses(
  pids: readonly number[],
): OwnedRuntimeEvidence {
  if (pids.length === 0) return { pids: [], listeners: [] };
  const pidList = pids.join(',');
  return runOwnedRuntimeObserver(`
$known = @(${pidList})
$live = @(Get-Process -Id $known -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id })
$knownSet = [System.Collections.Generic.HashSet[int]]::new()
foreach ($processId in $known) { [void]$knownSet.Add([int]$processId) }
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $knownSet.Contains([int]$_.OwningProcess) } |
  ForEach-Object { [pscustomobject]@{ pid = [int]$_.OwningProcess; port = [int]$_.LocalPort } })
[pscustomobject]@{ pids = $live; listeners = $listeners } | ConvertTo-Json -Compress
`);
}

function runOwnedRuntimeObserver(script: string): OwnedRuntimeEvidence {
  const result = spawnSync(
    windowsSystemExecutable(
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    },
  );
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    const code = result.error?.code ?? 'none';
    const status = Number.isInteger(result.status) ? String(result.status) : 'none';
    throw new Error(
      `Owned Capture Runtime process observer failed (code=${code}; status=${status}).`,
    );
  }
  return parseOwnedRuntimeEvidence(JSON.parse(result.stdout) as unknown);
}

function windowsSystemExecutable(...segments: string[]): string {
  const systemRoot = Object.entries(process.env).find(
    ([name]) => name.toUpperCase() === 'SYSTEMROOT',
  )?.[1];
  if (!systemRoot) {
    throw new Error('Windows SystemRoot is unavailable.');
  }
  return join(systemRoot, ...segments);
}

export function parseOwnedRuntimeEvidence(
  value: unknown,
): OwnedRuntimeEvidence {
  const payload = asObject(value);
  const pids = payload?.['pids'];
  const listeners = payload?.['listeners'];
  if (!Array.isArray(pids) || !Array.isArray(listeners)) {
    throw new Error('Owned Capture Runtime process evidence was malformed.');
  }
  const normalizedPids = pids.map((pid) => requiredProcessInteger(pid, 'PID'));
  const normalizedListeners = listeners.map((listener) => {
    const item = asObject(listener);
    return {
      pid: requiredProcessInteger(item?.['pid'], 'listener PID'),
      port: requiredPort(item?.['port']),
    };
  });
  return { pids: normalizedPids, listeners: normalizedListeners };
}

function requiredProcessInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`Owned Capture Runtime ${label} was invalid.`);
  }
  return Number(value);
}

function requiredPort(value: unknown): number {
  const port = requiredProcessInteger(value, 'listener port');
  if (port > 65_535) {
    throw new Error('Owned Capture Runtime listener port was invalid.');
  }
  return port;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function observe<T>(observable: {
  subscribe: (observer: {
    next: (value: T) => void;
    error: (error: unknown) => void;
  }) => unknown;
}): Promise<T> {
  return new Promise((resolveValue, reject) =>
    observable.subscribe({ next: resolveValue, error: reject }),
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
