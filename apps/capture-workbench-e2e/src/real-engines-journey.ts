/** Shared stages for the localhost real-engine journeys; inputs and proof scope are in real-engines.spec.ts. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import {
  canConnect,
  startDevHostLauncher,
  type StartedDevHostLauncher,
} from './dev-host-launcher.ts';

import {
  PROGRESSIVE_AUDIO_ENV,
  PROGRESSIVE_AUDIO_ORACLE_ENV,
  progressiveAudioPaths,
  requirePrivateDirectory,
} from './real-engines-inputs.ts';

const workspaceRoot = resolve(import.meta.dirname, '..', '..', '..');
const upstreamUrl = 'http://localhost:4200';
type Journey = 'installation' | 'execution';

const defaultProductExecutable = join(
  workspaceRoot,
  'apps',
  'capture-workbench-desktop',
  'src-tauri',
  'binaries',
  'capture-runtime-x86_64-pc-windows-msvc.exe',
);
const defaultProductManifest = join(
  workspaceRoot,
  'apps',
  'capture-workbench-desktop',
  'src-tauri',
  'resources',
  'capture-runtime-manifest.json',
);

const INSTALL_STAGE_TIMEOUT_MS = 45 * 60_000; // measured by the first real run
const INSTALL_UNIT_TIMEOUT_MS = 20 * 60_000; // measured by the first real run
const OCR_STAGE_TIMEOUT_MS = 10 * 60_000; // measured by the first real run
const ASR_STAGE_TIMEOUT_MS = 35 * 60_000; // measured by the first real run
// Allow the same fixed completion overhead as the OCR stage for model startup,
// structuring and rendering, in addition to the duration-based extraction budget.
const PROGRESSIVE_COMPLETION_ALLOWANCE_MS = 10 * 60_000;
const MODEL_INSTALL_TIMEOUT_MS = 25 * 60_000; // measured by the first real run
const EDIT_EXPORT_STAGE_TIMEOUT_MS = 3 * 60_000; // measured by the first real run
const DELETE_STAGE_TIMEOUT_MS = 2 * 60_000;
const RESTART_STAGE_TIMEOUT_MS = 5 * 60_000; // measured by the first real run
const CANCEL_CLICK_TIMEOUT_MS = 10_000;
const ACTION_TIMEOUT_MS = 15_000;
// The application itself waits three minutes (DESKTOP_RUNTIME_READY_TIMEOUT_MS):
// with the features installed, readiness includes probing their workers.
const RUNTIME_READY_TIMEOUT_MS = 200_000;

const ALL_RECOGNITION_UNITS = [
  'text-recognition',
  'speech-recognition',
  'speaker-diarization',
] as const;

type ExpectedOcrDevice = 'directml' | 'cpu';

const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

/** The owned Ollama's last printed server config pins CUDA to one GPU UUID. */
function assertOllamaCudaUuidPin(log: string): void {
  const lastConfig = log.split(/\r?\n/u).filter((line) => line.includes('server config')).at(-1);
  assert.ok(lastConfig, 'Owned Ollama must print its server config.');
  assert.match(
    lastConfig,
    /(?:^|\s|\[|")CUDA_VISIBLE_DEVICES:GPU-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?=[\s\]"]|$)/iu,
    'Owned Ollama must pin CUDA_VISIBLE_DEVICES to a GPU UUID in its last server config.',
  );
}

function expectedSpeechProvenance(): { readonly model: string; readonly device: 'cuda' | 'cpu' } {
  const variant = readEnvFirst(['CAPTURE_SPEECH_RECOGNITION_VARIANT']) ?? 'auto';
  assert.ok(variant === 'auto' || variant === 'cuda' || variant === 'cpu',
    'CAPTURE_SPEECH_RECOGNITION_VARIANT must be auto, cuda or cpu.');
  const systemRoot = process.env['SystemRoot'] ?? process.env['WINDIR'] ?? 'C:\\Windows';
  const useCuda = variant === 'cuda'
    || (variant === 'auto' && existsSync(join(systemRoot, 'System32', 'nvcuda.dll')));
  return useCuda
    ? { model: 'tea-asr-1.1', device: 'cuda' }
    : { model: 'tea-asr-1.1-mini', device: 'cpu' };
}

interface RealTextExpectation {
  readonly schemaVersion: 1;
  readonly rawTextIncludes: readonly string[];
}

type SpeechPack = 'cuda' | 'cpu';

/** Fields used by the journey from the validated oracle CLI response. */
interface ProgressiveAudioOracle {
  readonly speechPack: SpeechPack;
  readonly durationMs: number;
  readonly input: { readonly sha256: string; readonly bytes: number };
  readonly firstCheckpoint: { readonly partialRevision: number; readonly coveredUntilMs: number };
  readonly finalOutput: { readonly segmentCount: number };
  readonly extraction: EngineProvenance;
}

interface ProgressiveAudioMedia {
  readonly audioPath: string;
  readonly oracle: ProgressiveAudioOracle;
  readonly partialBudgetMs: number;
}

interface ExecutionMedia {
  readonly pdfPath: string;
  readonly pdfExpectation: RealTextExpectation;
  readonly imagePath: string;
  readonly imageExpectation: RealTextExpectation;
  readonly audioPath: string;
  readonly audioExpectation: RealTextExpectation;
  readonly progressiveAudio?: ProgressiveAudioMedia;
  readonly expectedOcrDevice?: ExpectedOcrDevice;
}

interface SmokeConfig {
  readonly appDataDir: string;
  readonly tempDir: string;
  readonly modelOptionId: string;
  readonly runtimeManifestPath: string;
  readonly runtimeExecutablePath: string;
  readonly launcherEnv: Readonly<Record<string, string>>;
}

interface EngineProvenance {
  readonly engine: string;
  readonly model: string;
  readonly device?: string | null;
  readonly deviceName?: string | null;
  readonly digest: string;
}

interface RawSegmentRecord {
  readonly segmentId: string;
  readonly order: number;
  readonly locator: { readonly kind: string };
  readonly text: string;
  readonly speaker?: string | null;
}

interface DesktopLibrarySummaryRecord {
  readonly documentId: string;
  readonly fileName: string;
  readonly captureId?: string | null;
  readonly status: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly pageCount?: number;
  readonly durationMs?: number;
}

interface DesktopLibraryDetailRecord extends DesktopLibrarySummaryRecord {
  readonly edits?: {
    readonly ocrPages?: Readonly<Record<string, string>>;
    readonly transcriptLines?: Readonly<Record<string, string>>;
  };
  readonly raw?: {
    readonly sourceText?: string;
    readonly segments?: readonly RawSegmentRecord[];
    readonly extractionEngine?: EngineProvenance;
  };
  readonly result?: {
    readonly extractionEngine?: EngineProvenance;
    readonly structuringEngine?: EngineProvenance;
    readonly speakers?: readonly unknown[];
    readonly blocks?: readonly unknown[];
  };
}

interface StageRecord {
  readonly name: string;
  readonly status: 'passed' | 'failed';
  readonly durationMs: number;
}

/** What this run actually did. A passed stage does not by itself prove these. */
interface SmokeProven {
  installation: boolean;
  cancelAndRetry: boolean;
  modelInstallation: boolean;
  ocrDevice: boolean;
  deletion: boolean;
  progressivePartial: boolean;
}

interface ProvenanceSummary {
  readonly engine: string;
  readonly model: string;
  readonly device: string | null;
  readonly deviceName: string | null;
  readonly digest: string;
}

interface SmokeEvidence {
  readonly evidenceKind: 'real-engines-localhost-v1';
  readonly journey: Journey;
  readonly startedAt: string;
  finishedAt: string;
  passed: boolean;
  /** Page loads that needed a reload before the Workbench was ready (issue #425). */
  startupReloads: number;
  readonly stages: StageRecord[];
  /** Set from what this run did. A passed stage does not by itself prove installation. */
  readonly proven: SmokeProven;
  provenance: {
    progressiveAudio?: {
      readonly speechPack: SpeechPack;
      readonly extraction: ProvenanceSummary;
      readonly partialRevision: number;
      readonly coveredUntilMs: number;
    };
    pdf?: {
      readonly extraction: ProvenanceSummary;
      readonly pageCount: number;
      readonly segmentCount: number;
      readonly blockCount: number;
    };
    image?: {
      readonly extraction: ProvenanceSummary;
      readonly pageCount: number;
      readonly segmentCount: number;
      readonly blockCount: number;
    };
    audio?: {
      readonly extraction: ProvenanceSummary;
      readonly structuring: ProvenanceSummary;
      readonly segmentCount: number;
      readonly speakerCount: number;
      readonly blockCount: number;
    };
  };
  restart?: {
    readonly oldPortsClosed: boolean;
    readonly persistedDocumentCount: number;
    readonly featuresReadyWithoutReinstall: boolean;
  };
  restartAfterDeletion?: {
    readonly oldPortsClosed: boolean;
    readonly remainingDocumentCount: number;
    readonly deletedIdsAbsent: boolean;
  };
}

function readEnvFirst(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function isRegularFile(filePath: string): boolean {
  return existsSync(filePath) && statSync(filePath).isFile();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

async function loadTextExpectation(
  filePath: string,
  label: string,
): Promise<RealTextExpectation> {
  const rawJson = await readFile(filePath, 'utf8');
  const parsed: unknown = JSON.parse(rawJson);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} expectation file must be a JSON object.`);
  }
  const record = parsed as Record<string, unknown>;
  if (record['schemaVersion'] !== 1 || !Array.isArray(record['rawTextIncludes'])) {
    throw new Error(`${label} expectation file must have schemaVersion 1 and rawTextIncludes.`);
  }
  const normalized = record['rawTextIncludes'].map((item, idx) => {
    if (typeof item !== 'string' || !normalizeText(item)) {
      throw new Error(`${label} expectation rawTextIncludes[${idx}] must be non-empty text.`);
    }
    return normalizeText(item);
  });
  if (normalized.length === 0) {
    throw new Error(`${label} expectation rawTextIncludes must not be empty.`);
  }
  return { schemaVersion: 1, rawTextIncludes: normalized };
}

// Use the same evidence checks as the desktop oracle without importing a
// desktop project into the e2e project. Pass private text only through stdin.
function checkProgressiveEvidence(input: Readonly<Record<string, unknown>>): string {
  const script = join(workspaceRoot, 'apps/capture-workbench-desktop/scripts/progressive-audio-oracle.ts');
  const result = spawnSync(process.execPath, [script, '--verify-evidence'], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: ACTION_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'Progressive audio evidence command failed.');
  }
  return result.stdout;
}

async function loadProgressiveAudio(): Promise<ProgressiveAudioMedia | undefined> {
  const paths = progressiveAudioPaths(process.env);
  if (!paths) {
    console.log(`Skipping progressive partial check because ${PROGRESSIVE_AUDIO_ENV} and ${PROGRESSIVE_AUDIO_ORACLE_ENV} are unset.`);
    return undefined;
  }
  assert.ok(isRegularFile(paths.audioPath), `${PROGRESSIVE_AUDIO_ENV} must name a regular file.`);
  assert.ok(isRegularFile(paths.oraclePath), `${PROGRESSIVE_AUDIO_ORACLE_ENV} must name a regular file.`);
  const { oracle, partialBudgetMs } = JSON.parse(checkProgressiveEvidence({
    action: 'read', oraclePath: paths.oraclePath,
  })) as Pick<ProgressiveAudioMedia, 'oracle' | 'partialBudgetMs'>;
  assert.equal(statSync(paths.audioPath).size, oracle.input.bytes, 'Progressive recording size differs from the oracle.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(paths.audioPath)) hash.update(chunk);
  assert.equal(hash.digest('hex'), oracle.input.sha256, 'Progressive recording digest differs from the oracle.');
  return { audioPath: paths.audioPath, oracle, partialBudgetMs };
}

async function resolveExecutionMedia(): Promise<ExecutionMedia> {
  const missingOrInvalid: string[] = [];

  const pdfPath = readEnvFirst([
    'CAPTURE_REAL_ENGINES_PDF',
    'CAPTURE_REAL_MEDIA_PDF',
    'CAPTURE_REAL_DESKTOP_OCR_PDF',
  ]);
  if (!pdfPath) {
    missingOrInvalid.push(
      'CAPTURE_REAL_ENGINES_PDF (or CAPTURE_REAL_MEDIA_PDF / CAPTURE_REAL_DESKTOP_OCR_PDF)',
    );
  } else if (!isRegularFile(pdfPath)) {
    missingOrInvalid.push('CAPTURE_REAL_ENGINES_PDF must point to an existing regular file');
  }

  const imagePath = readEnvFirst([
    'CAPTURE_REAL_ENGINES_IMAGE',
    'CAPTURE_REAL_MEDIA_IMAGE',
    'CAPTURE_REAL_DESKTOP_OCR_INPUT',
  ]);
  if (!imagePath) {
    missingOrInvalid.push(
      'CAPTURE_REAL_ENGINES_IMAGE (or CAPTURE_REAL_MEDIA_IMAGE / CAPTURE_REAL_DESKTOP_OCR_INPUT)',
    );
  } else if (!isRegularFile(imagePath)) {
    missingOrInvalid.push('CAPTURE_REAL_ENGINES_IMAGE must point to an existing regular file');
  }

  const audioPath = readEnvFirst(['CAPTURE_REAL_ENGINES_AUDIO', 'CAPTURE_REAL_MEDIA_AUDIO']);
  if (!audioPath) {
    missingOrInvalid.push('CAPTURE_REAL_ENGINES_AUDIO (or CAPTURE_REAL_MEDIA_AUDIO)');
  } else if (!isRegularFile(audioPath)) {
    missingOrInvalid.push('CAPTURE_REAL_ENGINES_AUDIO must point to an existing regular file');
  }

  const pdfExpPath =
    readEnvFirst(['CAPTURE_REAL_ENGINES_PDF_EXPECTATIONS'])
    ?? (pdfPath ? `${pdfPath}.expected.json` : undefined);
  if (!pdfExpPath || !isRegularFile(pdfExpPath)) {
    missingOrInvalid.push(
      'CAPTURE_REAL_ENGINES_PDF_EXPECTATIONS (or <pdf>.expected.json beside the PDF)',
    );
  }

  const imageExpPath =
    readEnvFirst(['CAPTURE_REAL_ENGINES_IMAGE_EXPECTATIONS'])
    ?? (imagePath ? `${imagePath}.expected.json` : undefined);
  if (!imageExpPath || !isRegularFile(imageExpPath)) {
    missingOrInvalid.push(
      'CAPTURE_REAL_ENGINES_IMAGE_EXPECTATIONS (or <image>.expected.json beside the image)',
    );
  }

  const audioExpPath =
    readEnvFirst(['CAPTURE_REAL_ENGINES_AUDIO_EXPECTATIONS']) ?? (audioPath ? `${audioPath}.expected.json` : undefined);
  if (!audioExpPath || !isRegularFile(audioExpPath)) {
    missingOrInvalid.push(
      'CAPTURE_REAL_ENGINES_AUDIO_EXPECTATIONS (or <audio>.expected.json)',
    );
  }

  const expectedOcrDeviceRaw = readEnvFirst(['CAPTURE_REAL_ENGINES_EXPECTED_OCR_DEVICE']);
  let expectedOcrDevice: ExpectedOcrDevice | undefined;
  if (expectedOcrDeviceRaw !== undefined) {
    if (expectedOcrDeviceRaw === 'directml' || expectedOcrDeviceRaw === 'cpu') {
      expectedOcrDevice = expectedOcrDeviceRaw;
    } else {
      missingOrInvalid.push(
        'CAPTURE_REAL_ENGINES_EXPECTED_OCR_DEVICE must be "directml" or "cpu"',
      );
    }
  }

  if (missingOrInvalid.length > 0 || !pdfPath || !imagePath || !audioPath
    || !pdfExpPath || !imageExpPath || !audioExpPath) {
    throw new Error(
      `Missing or invalid real-engines configuration:\n- ${missingOrInvalid.join('\n- ')}`,
    );
  }

  const [pdfExpectation, imageExpectation, audioExpectation, progressiveAudio] = await Promise.all([
    loadTextExpectation(pdfExpPath, 'PDF'),
    loadTextExpectation(imageExpPath, 'Image'),
    loadTextExpectation(audioExpPath, 'Audio'),
    loadProgressiveAudio(),
  ]);

  return {
    pdfPath: pdfPath,
    pdfExpectation,
    imagePath: imagePath,
    imageExpectation,
    audioPath: audioPath,
    audioExpectation,
    ...(progressiveAudio ? { progressiveAudio } : {}),
    ...(expectedOcrDevice !== undefined ? { expectedOcrDevice } : {}),
  };
}

function resolveSmokeConfig(): SmokeConfig {
  const missingOrInvalid: string[] = [];
  const appDataDir = readEnvFirst([
    'CAPTURE_REAL_ENGINES_APP_DATA',
    'CAPTURE_REAL_MEDIA_APP_DATA',
  ]);
  if (!appDataDir) {
    missingOrInvalid.push('CAPTURE_REAL_ENGINES_APP_DATA (or CAPTURE_REAL_MEDIA_APP_DATA)');
  } else if (!isAbsolute(appDataDir)) {
    missingOrInvalid.push('CAPTURE_REAL_ENGINES_APP_DATA must be an absolute directory path');
  }

  const tempDir = readEnvFirst(['CAPTURE_REAL_ENGINES_TEMP_DIR']);
  if (!tempDir) {
    missingOrInvalid.push('CAPTURE_REAL_ENGINES_TEMP_DIR');
  } else if (!isAbsolute(tempDir)) {
    missingOrInvalid.push('CAPTURE_REAL_ENGINES_TEMP_DIR must be an absolute directory path');
  }

  const modelOptionId = readEnvFirst(['CAPTURE_REAL_ENGINES_MODEL_OPTION_ID']);
  if (!modelOptionId) {
    missingOrInvalid.push(
      'CAPTURE_REAL_ENGINES_MODEL_OPTION_ID (e.g. qwen3.5-0.8b-v1, qwen3.5-2b-v1, qwen3.5-4b-v1)',
    );
  }

  const explicitManifest = readEnvFirst(['CAPTURE_REAL_ENGINES_RUNTIME_MANIFEST']);
  const explicitExecutable = readEnvFirst(['CAPTURE_REAL_ENGINES_RUNTIME_EXECUTABLE']);
  if ((explicitManifest === undefined) !== (explicitExecutable === undefined)) {
    missingOrInvalid.push(
      'CAPTURE_REAL_ENGINES_RUNTIME_MANIFEST and CAPTURE_REAL_ENGINES_RUNTIME_EXECUTABLE must be set together',
    );
  }

  const runtimeManifestPath = explicitManifest
    ? resolve(explicitManifest)
    : defaultProductManifest;
  const runtimeExecutablePath = explicitExecutable
    ? resolve(explicitExecutable)
    : defaultProductExecutable;

  if (!isRegularFile(runtimeManifestPath)) {
    missingOrInvalid.push(
      explicitManifest
        ? 'CAPTURE_REAL_ENGINES_RUNTIME_MANIFEST must point to an existing file'
        : 'Staged product runtime manifest is missing (run capture-workbench-desktop:stage-product-runtime or set CAPTURE_REAL_ENGINES_RUNTIME_MANIFEST)',
    );
  }
  if (!isRegularFile(runtimeExecutablePath)) {
    missingOrInvalid.push(
      explicitExecutable
        ? 'CAPTURE_REAL_ENGINES_RUNTIME_EXECUTABLE must point to an existing file'
        : 'Staged product runtime executable is missing (run capture-workbench-desktop:stage-product-runtime or set CAPTURE_REAL_ENGINES_RUNTIME_EXECUTABLE)',
    );
  }

  if (missingOrInvalid.length > 0 || !appDataDir || !tempDir || !modelOptionId) {
    throw new Error(
      `Missing or invalid real-engines configuration:\n- ${missingOrInvalid.join('\n- ')}`,
    );
  }

  const privateAppData = requirePrivateDirectory(appDataDir, workspaceRoot, 'CAPTURE_REAL_ENGINES_APP_DATA');
  const privateTemp = requirePrivateDirectory(tempDir, workspaceRoot, 'CAPTURE_REAL_ENGINES_TEMP_DIR');
  for (const child of ['library', 'library/items', 'runtime', 'ollama', 'ollama/models']) {
    requirePrivateDirectory(join(privateAppData, child), workspaceRoot, `App data directory ${child}`);
  }
  // The desktop launcher inherits LOCALAPPDATA and USERPROFILE. The runtime
  // uses those to choose the download cache, so validate its effective default.
  const localAppData = readEnvFirst(['LOCALAPPDATA']);
  requirePrivateDirectory(
    localAppData ? join(localAppData, 'gx-capture', 'engine-cache')
      : join(homedir(), '.cache', 'gx-capture', 'engine-cache'),
    workspaceRoot,
    'Runtime engine cache',
  );
  const cacheOverride = readEnvFirst(['CAPTURE_ENGINE_CACHE_DIR']);
  if (cacheOverride && cacheOverride.toLowerCase() !== 'off') {
    requirePrivateDirectory(cacheOverride, workspaceRoot, 'CAPTURE_ENGINE_CACHE_DIR');
  }

  const launcherEnv: Record<string, string> = {
    TEMP: privateTemp,
    TMP: privateTemp,
    TMPDIR: privateTemp,
    CAPTURE_SPEECH_RECOGNITION_ALLOW_CPU_FALLBACK:
      readEnvFirst(['CAPTURE_SPEECH_RECOGNITION_ALLOW_CPU_FALLBACK']) ?? 'false',
  };
  const mirrorOptIn = readEnvFirst(['CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN']);
  const mirrorUrl = readEnvFirst(['CAPTURE_SMOKE_WORKER_MIRROR_URL']);
  if (mirrorOptIn) {
    launcherEnv['CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN'] = mirrorOptIn;
  }
  if (mirrorUrl) {
    launcherEnv['CAPTURE_SMOKE_WORKER_MIRROR_URL'] = mirrorUrl;
  }

  return {
    appDataDir: privateAppData,
    tempDir: privateTemp,
    modelOptionId: modelOptionId,
    runtimeManifestPath,
    runtimeExecutablePath,
    launcherEnv,
  };
}

function logStage(name: string, event: string): void {
  console.log(`[${new Date().toISOString()}] stage ${name}: ${event}`);
}

async function runStage<T>(
  stages: StageRecord[],
  name: string,
  timeoutMs: number,
  body: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  logStage(name, 'start');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Stage "${name}" timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([body(), timeoutPromise]);
    const durationMs = Date.now() - startedAt;
    stages.push({ name, status: 'passed', durationMs });
    logStage(name, `passed (${durationMs}ms)`);
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    stages.push({ name, status: 'failed', durationMs });
    logStage(name, `failed (${durationMs}ms)`);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function invokeHost<T>(
  page: Page,
  command: string,
  args: Readonly<Record<string, unknown>> = {},
): Promise<T> {
  return page.evaluate(
    ({ cmd, payload }) => {
      const win = window as unknown as {
        readonly __TAURI_INTERNALS__: {
          invoke: (name: string, input: unknown) => Promise<unknown>;
        };
      };
      return win.__TAURI_INTERNALS__.invoke(cmd, payload);
    },
    { cmd: command, payload: args },
  ) as Promise<T>;
}

/**
 * A document stops at the recognition checkpoint: the host starts documents
 * with host structuring and the product does not structure them. A document
 * record with a structured result means that changed, and this check with it.
 */
function assertDocumentCheckpoint(
  detail: { readonly status?: unknown; readonly result?: unknown },
  label: string,
): void {
  assert.ok(
    detail.status === 'awaiting_confirmation' || detail.status === 'awaiting_structuring',
    `${label} record must rest at the recognition checkpoint, not ${String(detail.status)}.`,
  );
  assert.ok(
    detail.result === null || detail.result === undefined,
    `${label} record must not carry a structured result.`,
  );
}

/** Page loads that ended in the error state before the Workbench was ready (issue #425). */
let startupReloads = 0;

/**
 * Waits for the Workbench to be ready. With every feature installed, the first
 * requirements query after a start can take longer than the host's 60-second
 * request limit, and the Workbench then stays in its error state (issue #425).
 * A reload asks again, by which time the runtime has answered once. The count
 * of such reloads goes into the evidence; when #425 is fixed it is zero and
 * this tolerance is removed.
 */
async function waitForRuntimeReady(page: Page): Promise<void> {
  const status = page
    .getByRole('navigation', { name: '主要功能' })
    .getByTestId('runtime-status');
  for (let reloads = 0; ; reloads += 1) {
    await expect(status).toHaveAttribute('data-state', /^(?:ready|error)$/u, {
      timeout: RUNTIME_READY_TIMEOUT_MS,
    });
    if ((await status.getAttribute('data-state')) === 'ready') return;
    assert.ok(reloads < 2, 'The Workbench was not ready after two reloads.');
    startupReloads += 1;
    console.log(
      `[${new Date().toISOString()}] the Workbench did not become ready (issue #425); reload ${startupReloads}`,
    );
    await page.reload();
  }
}

/**
 * Clicks Cancel. The installation can finish first and remove the button;
 * that is not a failure and does not prove cancel-and-retry.
 */
async function clickCancelOrGone(button: Locator): Promise<boolean> {
  try {
    await button.click({ timeout: CANCEL_CLICK_TIMEOUT_MS });
    return true;
  } catch (error) {
    if ((await button.count()) === 0 || !(await button.isVisible())) return false;
    throw error;
  }
}

function assertOrderedAnchors(
  actualText: string,
  anchors: readonly string[],
  label: string,
): void {
  const normalizedActual = normalizeText(actualText);
  assert.ok(normalizedActual.length > 0, `${label} recognized text must not be empty.`);
  let cursor = 0;
  for (const [index, anchor] of anchors.entries()) {
    const matchAt = normalizedActual.indexOf(anchor, cursor);
    assert.ok(
      matchAt >= 0,
      `${label} text did not contain expected anchor #${index} in order.`,
    );
    cursor = matchAt + anchor.length;
  }
}

function assertAudioAgainstExpectation(
  detail: DesktopLibraryDetailRecord,
  expectation: RealTextExpectation,
): void {
  const segments = detail.raw?.segments ?? [];
  assert.ok(segments.length > 0, 'Audio capture must store raw segments.');
  assert.ok(
    segments.some((segment) => segment.locator.kind === 'time'),
    'Audio capture segments must include time locators.',
  );

  const combinedText =
    detail.raw?.sourceText ?? segments.map((segment) => segment.text).join('\n');
  assertOrderedAnchors(combinedText, expectation.rawTextIncludes, 'ASR');
}

function toProvenanceSummary(provenance: EngineProvenance): ProvenanceSummary {
  return {
    engine: provenance.engine,
    model: provenance.model,
    device: provenance.device ?? null,
    deviceName: provenance.deviceName ?? null,
    digest: provenance.digest,
  };
}

function assertOcrExtractionProvenance(
  detail: DesktopLibraryDetailRecord,
  label: string,
  expectedOcrDevice?: ExpectedOcrDevice,
): ProvenanceSummary {
  const extraction = detail.raw?.extractionEngine;
  assert.ok(extraction, `${label} record must include extractionEngine provenance.`);
  assert.equal(extraction.engine, 'text-recognition');
  assert.equal(extraction.model, 'pp-ocrv6-medium');
  assert.ok(
    extraction.device === 'directml' || extraction.device === 'cpu',
    `Unexpected OCR device: ${String(extraction.device)}`,
  );
  if (expectedOcrDevice !== undefined) {
    assert.equal(
      extraction.device,
      expectedOcrDevice,
      `${label} OCR device must be ${expectedOcrDevice}, got ${String(extraction.device)}.`,
    );
  }
  assert.match(extraction.digest, SHA256_DIGEST_PATTERN);
  return toProvenanceSummary(extraction);
}

async function queueFileAndAwaitCompletion(
  page: Page,
  options: {
    readonly filePath: string;
    readonly chooseButtonTestId: 'ocr-choose-files' | 'asr-choose-files';
    readonly queueRowTestId: 'ocr-queue-row' | 'asr-queue-row';
    readonly timeoutMs: number;
    readonly whileRunning?: (documentId: string, row: Locator) => Promise<void>;
  },
): Promise<string> {
  const beforeList = await invokeHost<readonly DesktopLibrarySummaryRecord[]>(
    page,
    'library_list',
    { request: { query: '', status: '' } },
  );
  const existingIds = new Set(beforeList.map((item) => item.documentId));

  const queueRes = await page.request.post(new URL('/__host/selection', page.url()).href, {
    headers: { 'x-capture-preview': '1' },
    data: { paths: [options.filePath] },
  });
  expect(queueRes.status()).toBe(200);
  expect(await queueRes.json()).toEqual({ queued: 1 });

  await page.getByTestId(options.chooseButtonTestId).click({ timeout: ACTION_TIMEOUT_MS });

  let newDocId: string | undefined;
  await expect
    .poll(
      async () => {
        const rows = page.getByTestId(options.queueRowTestId);
        const count = await rows.count();
        for (let i = 0; i < count; i += 1) {
          const docId = await rows.nth(i).getAttribute('data-document-id');
          if (docId && !existingIds.has(docId)) {
            newDocId = docId;
            return true;
          }
        }
        return false;
      },
      { timeout: 20_000, intervals: [200] },
    )
    .toBe(true);

  assert.ok(newDocId, `Expected new ${options.queueRowTestId} entry to appear.`);
  const row = page.locator(
    `[data-testid="${options.queueRowTestId}"][data-document-id="${newDocId}"]`,
  );

  if (options.whileRunning) await options.whileRunning(newDocId, row);

  await expect
    .poll(
      async () => {
        const status = await row.getAttribute('data-user-status');
        if (status === 'needs-attention' || status === 'cancelled') {
          const detail = await invokeHost<DesktopLibraryDetailRecord>(page, 'library_get', {
            request: { documentId: newDocId },
          });
          throw new Error(
            `Capture ended in "${status}": ${detail.errorCode ?? 'unknown'} (${detail.errorMessage ?? 'no detail'}).`,
          );
        }
        return status;
      },
      { timeout: options.timeoutMs, intervals: [1_000] },
    )
    .toBe('done');

  return newDocId;
}

async function checkProgressiveRecording(
  page: Page,
  media: ProgressiveAudioMedia,
): Promise<{
  readonly documentId: string;
  readonly checkpoint: NonNullable<SmokeEvidence['provenance']['progressiveAudio']>;
}> {
  const { oracle, partialBudgetMs } = media;
  const expected = oracle.firstCheckpoint;
  let checkpoint: SmokeEvidence['provenance']['progressiveAudio'];
  const documentId = await queueFileAndAwaitCompletion(page, {
    filePath: media.audioPath,
    chooseButtonTestId: 'asr-choose-files',
    queueRowTestId: 'asr-queue-row',
    timeoutMs: PROGRESSIVE_COMPLETION_ALLOWANCE_MS + partialBudgetMs,
    whileRunning: async (id, row) => {
      const detail = await invokeHost<DesktopLibraryDetailRecord>(page, 'library_get', {
        request: { documentId: id },
      });
      const visibleCard = page.getByTestId('asr-live-card').filter({
        has: page.getByRole('heading', { name: detail.fileName, exact: true }),
      });
      await expect.poll(async () => {
        const rowStatus = await row.getAttribute('data-user-status', { timeout: ACTION_TIMEOUT_MS });
        assert.equal(rowStatus === 'done' || rowStatus === 'needs-attention' || rowStatus === 'cancelled',
          false, 'Progressive recording stopped before the live checkpoint could be verified.');
        const visible = await visibleCard.getByTestId('streaming-partial').evaluateAll((cards) => {
          const card = cards.length === 1 ? cards[0] : undefined;
          if (!card || card.getClientRects().length === 0) return null;
          return {
            revision: Number(card.getAttribute('data-partial-revision')),
            coverage: Number(card.getAttribute('data-covered-until-ms')),
            text: Array.from(card.querySelectorAll('[data-testid="asr-live-line"] p'),
              (line) => line.textContent ?? ''),
          };
        });
        if (!visible || visible.revision < expected.partialRevision || visible.coverage < expected.coveredUntilMs) {
          return false;
        }
        assert.equal(rowStatus, 'processing');
        assert.equal(visible.revision, expected.partialRevision, 'Displayed partial revision differs from the oracle.');
        assert.equal(visible.coverage, expected.coveredUntilMs, 'Displayed partial coverage differs from the oracle.');

        // The live card exposes a filename, while the queue and library expose
        // document IDs. Require a unique active match before binding the card.
        const list = await invokeHost<readonly DesktopLibrarySummaryRecord[]>(page, 'library_list', {
          request: { query: '', status: '' },
        });
        const active = list.filter((item) => item.fileName === detail.fileName
          && (item.status === 'processing' || item.status === 'persisting'));
        assert.ok(active.length === 1 && active[0]?.documentId === id && active[0].captureId,
          'Live partial could not be bound to the queued recording.');
        const captureId = active[0].captureId;
        const snapshot = await invokeHost<unknown>(page, 'runtime_get_partial', { input: { id: captureId } });
        assert.ok(snapshot && typeof snapshot === 'object' && 'captureId' in snapshot
          && snapshot.captureId === captureId, 'Host partial belongs to another capture.');
        const operation = await invokeHost<{ readonly status: string; readonly durationMs?: number }>(
          page, 'runtime_get_capture', { input: { id: captureId } },
        );
        assert.equal(operation.status, 'extracting', 'Capture must still be extracting after the live snapshot is read.');
        assert.equal(operation.durationMs, oracle.durationMs, 'Live recording duration differs from the oracle.');
        checkProgressiveEvidence({ action: 'partial', oracle, snapshot, displayed: visible.text });
        assert.ok('extractionEngine' in snapshot, 'Host partial must include recognition provenance.');
        checkpoint = {
          speechPack: oracle.speechPack,
          extraction: toProvenanceSummary(snapshot.extractionEngine as EngineProvenance),
          partialRevision: expected.partialRevision,
          coveredUntilMs: expected.coveredUntilMs,
        };
        return true;
      }, { timeout: partialBudgetMs, intervals: [100], message: 'Observe the oracle checkpoint while extraction is active.' })
        .toBe(true);
    },
  });
  assert.ok(checkpoint, 'Missing live progressive checkpoint evidence.');

  const detail = await invokeHost<DesktopLibraryDetailRecord>(page, 'library_get', { request: { documentId } });
  assert.equal(detail.status, 'completed');
  const row = page.locator(`[data-testid="asr-queue-row"][data-document-id="${documentId}"]`);
  await row.getByTestId('asr-row-view').click({ timeout: ACTION_TIMEOUT_MS });
  await expect(page).toHaveURL(new RegExp(`/history/${documentId}/content$`, 'u'));
  const transcriptRows = page.getByTestId('result-transcript-row');
  await expect(transcriptRows).toHaveCount(oracle.finalOutput.segmentCount, { timeout: ACTION_TIMEOUT_MS });
  const rendered = await transcriptRows.evaluateAll((rows) => rows.map((item) => ({
    segmentId: item.getAttribute('data-segment-id'),
    text: item.querySelector('[data-testid="result-line-text"]')?.textContent ?? '',
  })));
  checkProgressiveEvidence({ action: 'final', oracle, raw: detail.raw, rendered });
  return { documentId, checkpoint };
}

async function assertDocumentAbsentFromHost(
  page: Page,
  documentId: string,
  label: string,
): Promise<void> {
  const list = await invokeHost<readonly DesktopLibrarySummaryRecord[]>(page, 'library_list', {
    request: { query: '', status: '' },
  });
  assert.ok(
    !list.some((item) => item.documentId === documentId),
    `library_list must not contain deleted ${label} document.`,
  );
  let rejectionMessage: string | undefined;
  try {
    await invokeHost(page, 'library_get', { request: { documentId } });
  } catch (error) {
    rejectionMessage = error instanceof Error ? error.message : String(error);
  }
  assert.ok(
    rejectionMessage !== undefined
      && rejectionMessage.includes('Capture library document was not found.'),
    `library_get must fail with "Capture library document was not found." for deleted ${label} document, got: ${String(rejectionMessage)}`,
  );
}

async function deleteDocumentFromHistoryList(
  page: Page,
  baseUrl: string,
  documentId: string,
  label: string,
): Promise<void> {
  await page.goto(`${baseUrl}/history`);
  await waitForRuntimeReady(page);

  const row = page.locator(
    `[data-testid="history-row"][data-document-id="${documentId}"]`,
  );
  await expect(row).toBeVisible({ timeout: 15_000 });
  const beforeDetail = await invokeHost<DesktopLibraryDetailRecord>(page, 'library_get', {
    request: { documentId },
  });
  assert.equal(
    beforeDetail.documentId,
    documentId,
    `library_get must succeed for ${label} document before deletion.`,
  );

  const deleteBtn = row.getByTestId('history-row-delete');
  await expect(deleteBtn).toBeEnabled({ timeout: 15_000 });
  await deleteBtn.click({ timeout: ACTION_TIMEOUT_MS });

  const dialog = page.getByTestId('history-delete-dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('history-delete-confirm').click({ timeout: ACTION_TIMEOUT_MS });

  await expect(dialog).toHaveCount(0, { timeout: 15_000 });
  await expect(row).toHaveCount(0, { timeout: 15_000 });
  await assertDocumentAbsentFromHost(page, documentId, label);
}

async function verifyDiagnosticsProvenance(
  page: Page,
  documentId: string,
  expectedExtraction: ProvenanceSummary,
  expectedStructuring?: ProvenanceSummary,
): Promise<void> {
  // The launcher's port is chosen per run, so there is no configured base URL.
  await page.goto(new URL(`/settings/diagnostics?document=${documentId}`, page.url()).href);
  await waitForRuntimeReady(page);

  const extractionEl = page.getByTestId('diagnostics-extraction-provenance');
  await expect(extractionEl).toBeVisible({ timeout: 15_000 });
  await expect(extractionEl).toHaveAttribute('data-engine', expectedExtraction.engine);
  await expect(extractionEl).toHaveAttribute('data-model', expectedExtraction.model);
  await expect(extractionEl).toHaveAttribute('data-digest', expectedExtraction.digest);
  if (expectedExtraction.device) {
    await expect(extractionEl).toHaveAttribute('data-device', expectedExtraction.device);
    await expect(extractionEl).toContainText(expectedExtraction.device);
  }

  if (expectedStructuring) {
    const structuringEl = page.getByTestId('diagnostics-structuring-provenance');
    await expect(structuringEl).toBeVisible({ timeout: 15_000 });
    await expect(structuringEl).toHaveAttribute('data-engine', expectedStructuring.engine);
    await expect(structuringEl).toHaveAttribute('data-model', expectedStructuring.model);
    await expect(structuringEl).toHaveAttribute('data-digest', expectedStructuring.digest);
    if (expectedStructuring.device) {
      await expect(structuringEl).toHaveAttribute('data-device', expectedStructuring.device);
      await expect(structuringEl).toContainText(expectedStructuring.device);
    }
    if (expectedStructuring.deviceName) {
      await expect(structuringEl).toContainText(expectedStructuring.deviceName);
    }
  }
}

const REINSTALL_MESSAGE = 'Installed engines or model do not match this build. A reinstall is needed: run capture-workbench-e2e:smoke-real-engines-installation with fresh app data, then rerun execution.';

/** The fields of the host's `runtime_requirements` response this check reads. */
interface RuntimeRequirementsResponse {
  readonly items: readonly { readonly requirementId: string; readonly status: string }[];
}

/** The fields of the host's `runtime_list_installations` response this check reads. */
interface RuntimeInstallationsResponse {
  readonly items: readonly { readonly installationId: string; readonly status: string }[];
}

/** Readiness validates active worker/model digests against the running runtime's catalog.
 * Installation history alone cannot prove this: it has no artifact digests.
 */
async function assertInstalledRequirements(page: Page): Promise<void> {
  const requirements = await invokeHost<RuntimeRequirementsResponse>(page, 'runtime_requirements');
  for (const requirementId of [...ALL_RECOGNITION_UNITS, 'structuring-runtime', 'structuring-model']) {
    const status = requirements.items.find((item) => item.requirementId === requirementId)?.status ?? 'missing';
    assert.equal(status, 'ready', `${requirementId}: ${status}. ${REINSTALL_MESSAGE}`);
  }
  const installations = await invokeHost<RuntimeInstallationsResponse>(page, 'runtime_list_installations');
  const blocking = installations.items.find((item) => item.status === 'queued' || item.status === 'running');
  if (blocking) {
    assert.fail(`${blocking.installationId}: ${blocking.status}. ${REINSTALL_MESSAGE}`);
  }
}

function assertInstalledSpeechPack(appDataDir: string, expectedPack: SpeechPack): SpeechPack {
  const activeStatePath = join(appDataDir, 'runtime', 'engines', 'speech-recognition', 'active.json');
  const state = existsSync(activeStatePath)
    ? JSON.parse(readFileSync(activeStatePath, 'utf8')) as { readonly contentId?: unknown }
    : undefined;
  const actualPack = state?.contentId === 'cuda' || state?.contentId === 'cpu'
    ? state.contentId
    : 'missing or invalid';
  assert.equal(actualPack, expectedPack, `speech-recognition pack: ${actualPack}, expected ${expectedPack}. ${REINSTALL_MESSAGE}`);
  return actualPack;
}

/** The API does not expose verification records. Read only these records under app data. */
function verificationRecords(appDataDir: string): Map<string, string> {
  const records = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === 'verified-files.json') {
        records.set(path, `${statSync(path).mtimeMs}:${sha256(readFileSync(path, 'utf8'))}`);
      }
    }
  };
  visit(join(appDataDir, 'runtime'));
  return records;
}

async function prepareModel(
  page: Page, baseUrl: string, modelOptionId: string, install: boolean, proven: SmokeProven,
): Promise<string> {
  await page.goto(`${baseUrl}/settings/diagnostics`);
  await waitForRuntimeReady(page);

  const modelOption = page.locator(
    `[data-testid="diagnostics-model-option"][data-model-option-id="${modelOptionId}"]`,
  );
  await expect(modelOption, install ? 'Model option must be available.' : REINSTALL_MESSAGE)
    .toBeVisible({ timeout: ACTION_TIMEOUT_MS });
  const expectedModelDisplayName = (
    await modelOption.locator('..').locator('strong').innerText()
  ).trim();
  assert.ok(expectedModelDisplayName.length > 0, 'Model option must expose a displayName.');
  await modelOption.click();

  const installModelBtn = page.getByTestId('diagnostics-model-install');
  let modelInstallClicked = false;
  if (install) {
    await expect(installModelBtn).toBeEnabled();
    await installModelBtn.click();
    modelInstallClicked = true;
  } else {
    assert.equal(await installModelBtn.isEnabled(), false, REINSTALL_MESSAGE);
  }

  const activeModelEl = page.getByTestId('diagnostics-active-model');
  await expect(activeModelEl, install ? 'Installed model must become active.' : REINSTALL_MESSAGE)
    .toHaveText(expectedModelDisplayName, {
      timeout: install ? MODEL_INSTALL_TIMEOUT_MS : ACTION_TIMEOUT_MS,
    });
  if (modelInstallClicked) {
    // diagnostics-model-progress stays mounted. Its data-status is the
    // runtime installation status, `completed` on success.
    const modelProgress = page.getByTestId('diagnostics-model-progress');
    await expect
      .poll(
        async () => {
          if ((await modelProgress.count()) === 0) return 'absent';
          return (await modelProgress.getAttribute('data-status')) ?? 'missing';
        },
        {
          timeout: MODEL_INSTALL_TIMEOUT_MS,
          intervals: [500],
          message: 'diagnostics-model-progress did not reach completed.',
        },
      )
      .toBe('completed');
    proven.modelInstallation = true;
  }
  return expectedModelDisplayName;
}

export async function runJourney(page: Page, journey: Journey): Promise<void> {
  const evidenceDir = join(workspaceRoot, 'tmp', 'capture-workbench-e2e', `real-engines-${journey}`);
  const evidencePath = join(evidenceDir, 'real-engines-evidence.json');

  const config = resolveSmokeConfig();
  const media = journey === 'execution' ? await resolveExecutionMedia() : undefined;
  const expectedSpeech = expectedSpeechProvenance();
  if (journey === 'installation') {
    assert.ok(!existsSync(config.appDataDir) || readdirSync(config.appDataDir).length === 0,
      'Installation journey requires empty app data; choose a fresh directory.');
  } else {
    assert.ok(existsSync(config.appDataDir), REINSTALL_MESSAGE);
  }
  mkdirSync(config.appDataDir, { recursive: true });
  mkdirSync(config.tempDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });

  const exportTempDir = join(config.tempDir, `exports-${randomBytes(4).toString('hex')}`);
  if (media) mkdirSync(exportTempDir, { recursive: true });
  const removeExportDir = (): void => {
    if (!media) return;
    rmSync(exportTempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  process.once('exit', () => {
    try {
      removeExportDir();
    } catch {
      // Best effort: the process is already exiting.
    }
  });

  const stages: StageRecord[] = [];
  const proven: SmokeProven = {
    installation: false,
    cancelAndRetry: false,
    modelInstallation: false,
    ocrDevice: false,
    deletion: false,
    progressivePartial: false,
  };
  const evidence: SmokeEvidence = {
    evidenceKind: 'real-engines-localhost-v1',
    journey,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    passed: false,
    startupReloads: 0,
    stages,
    proven,
    provenance: {},
  };

  let activeLauncher: StartedDevHostLauncher | undefined;

  const startHostWithConfig = async (): Promise<StartedDevHostLauncher> => {
    const started = await startDevHostLauncher({
      upstreamUrl,
      appDataDir: config.appDataDir,
      runtimeManifestPath: config.runtimeManifestPath,
      runtimeExecutablePath: config.runtimeExecutablePath,
      env: config.launcherEnv,
      startupTimeoutMs: 30_000,
    });
    activeLauncher = started;
    return started;
  };

  try {
    let launcher = await startHostWithConfig();
    const nav = page.getByRole('navigation', { name: '主要功能' });

    // -------------------------------------------------------------------------
    // Stage 1: First-run installation, cancel/retry, and reload re-attachment
    // -------------------------------------------------------------------------
    if (journey === 'installation') {
      await runStage(stages, '01-install-engines', INSTALL_STAGE_TIMEOUT_MS, async () => {
        await page.goto(`${launcher.baseUrl}/ocr`);
        await waitForRuntimeReady(page);

        const firstRunCard = page.getByTestId('first-run-card');
        await expect(firstRunCard).toBeVisible({ timeout: 15_000 });
        await expect(page.getByTestId('first-run-checkbox-ocr')).toBeChecked();
        await page.getByTestId('first-run-install').click();

        let reloadReattachVerified = false;

        const ocrProgress = page.getByTestId('ocr-install-progress');
        await expect(ocrProgress).toBeVisible({ timeout: 60_000 });
        const ocrCancel = page.getByTestId('ocr-install-cancel');
        const ocrCancelClicked = (await ocrCancel.isVisible())
          ? await clickCancelOrGone(ocrCancel)
          : false;

        await nav.getByRole('link', { name: '設定' }).click();
        await expect(page).toHaveURL(/\/settings\/engines$/u);
        await expect(page.getByTestId('engines-table')).toBeVisible({ timeout: 15_000 });

        const ocrRow = page.locator(
          '[data-testid="engine-row"][data-requirement-id="text-recognition"]',
        );
        await expect(ocrRow).toBeVisible();
        await expect
          .poll(async () => ocrRow.getAttribute('data-status'), {
            timeout: INSTALL_UNIT_TIMEOUT_MS,
            intervals: [250],
          })
          .toMatch(/^(?:ready|cancelled|failed|installable)$/u);
        if (await ocrRow.getByTestId('engine-row-retry').isVisible()) {
          if (ocrCancelClicked) proven.cancelAndRetry = true;
          await ocrRow.getByTestId('engine-row-retry').click();
        } else if (await ocrRow.getByTestId('engine-row-install').isVisible()) {
          await ocrRow.getByTestId('engine-row-install').click();
        }
        await expect(ocrRow).toHaveAttribute('data-status', 'ready', {
          timeout: INSTALL_UNIT_TIMEOUT_MS,
        });

        for (const requirementId of [
          'speech-recognition',
          'speaker-diarization',
        ] as const) {
          const row = page.locator(
            `[data-testid="engine-row"][data-requirement-id="${requirementId}"]`,
          );
          await expect(row).toBeVisible();
          const statusBefore = await row.getAttribute('data-status');
          if (statusBefore === 'ready') continue;

          if (!proven.cancelAndRetry && (await row.getByTestId('engine-row-install').isVisible())) {
            await row.getByTestId('engine-row-install').click();
            const cancelButton = row.getByTestId('engine-row-cancel');
            await expect(cancelButton).toBeVisible({ timeout: 60_000 });
            const cancelClicked = await clickCancelOrGone(cancelButton);
            if (cancelClicked) {
              const retryButton = row.getByTestId('engine-row-retry');
              await expect(retryButton).toBeVisible({ timeout: 60_000 });
              proven.cancelAndRetry = true;
              await retryButton.click();
            }
          } else if (await row.getByTestId('engine-row-install').isVisible()) {
            await row.getByTestId('engine-row-install').click();
          } else if (await row.getByTestId('engine-row-retry').isVisible()) {
            await row.getByTestId('engine-row-retry').click();
          }

          if (!reloadReattachVerified && (await row.getAttribute('data-status')) !== 'ready') {
            await expect(row.getByTestId('engine-row-progress')).toBeVisible({ timeout: 60_000 });
            await page.reload();
            await waitForRuntimeReady(page);
            await expect(row).toBeVisible({ timeout: 15_000 });
            const afterReloadStatus = await row.getAttribute('data-status');
            assert.notEqual(
              afterReloadStatus,
              'installable',
              `${requirementId} returned to installable instead of re-attaching after reload.`,
            );
            if (afterReloadStatus !== 'ready') {
              await expect(row.getByTestId('engine-row-progress')).toBeVisible({ timeout: 30_000 });
            }
            reloadReattachVerified = true;
          }

          await expect(row).toHaveAttribute('data-status', 'ready', {
            timeout: INSTALL_UNIT_TIMEOUT_MS,
          });
        }

        assert.equal(
          proven.cancelAndRetry,
          true,
          'Stage 1 must observe install cancel and retry on a real unit.',
        );
        assert.equal(
          reloadReattachVerified,
          true,
          'Stage 1 must observe reload re-attachment during an active installation.',
        );

        for (const requirementId of ALL_RECOGNITION_UNITS) {
          await expect(
            page.locator(`[data-testid="engine-row"][data-requirement-id="${requirementId}"]`),
          ).toHaveAttribute('data-status', 'ready');
        }
        assertInstalledSpeechPack(config.appDataDir, expectedSpeech.device);
        proven.installation = true;
      });

      await runStage(stages, '02-install-structuring-model', MODEL_INSTALL_TIMEOUT_MS, async () => {
        await prepareModel(page, launcher.baseUrl, config.modelOptionId, true, proven);
      });
      await runStage(stages, '03-installed-first-start-and-restart', 2 * RESTART_STAGE_TIMEOUT_MS, async () => {
        await assertInstalledRequirements(page);
        const records = verificationRecords(config.appDataDir);
        for (const requirementId of ALL_RECOGNITION_UNITS) {
          assert.ok([...records.keys()].some((path) => {
            const record = JSON.parse(readFileSync(path, 'utf8')) as {
              readonly binding?: { readonly requirementId?: string };
            };
            return record.binding?.requirementId === requirementId;
          }), 'Each installed recognition engine must retain a verification record.');
        }
        for (const startup of ['first-start', 'restart']) {
          const previousPort = launcher.port;
          const previousDevHostPort = launcher.devHostPort;
          await launcher.stop();
          await expect.poll(() => canConnect(previousPort), { timeout: 15_000 }).toBe(false);
          await expect.poll(() => canConnect(previousDevHostPort), { timeout: 15_000 }).toBe(false);
          activeLauncher = undefined;
          launcher = await startHostWithConfig();
          await page.goto(`${launcher.baseUrl}/settings/engines`);
          await waitForRuntimeReady(page);
          await assertInstalledRequirements(page);
          await prepareModel(page, launcher.baseUrl, config.modelOptionId, false, proven);
          const afterStart = verificationRecords(config.appDataDir);
          assert.ok(afterStart.size === records.size
            && [...records].every(([path, snapshot]) => afterStart.get(path) === snapshot),
          'Restart must preserve verified-files.json bytes and modification times.');
          logStage(startup, 'verification records preserved');
        }
      });
      evidence.passed = true;
      return;
    }
    assert.ok(media);
    await runStage(stages, '01-check-installed-catalog', 2 * RESTART_STAGE_TIMEOUT_MS, async () => {
      await page.goto(`${launcher.baseUrl}/settings/engines`);
      await waitForRuntimeReady(page);
      await assertInstalledRequirements(page);
      assertInstalledSpeechPack(config.appDataDir, expectedSpeech.device);
      await prepareModel(page, launcher.baseUrl, config.modelOptionId, false, proven);
    });

    // -------------------------------------------------------------------------
    // Stage 2: PDF and image OCR + stored provenance + diagnostics
    // -------------------------------------------------------------------------
    let pdfDocId = '';
    let imageDocId = '';
    let originalPdfPage1Text = '';

    await runStage(stages, '02-ocr-pdf-and-image', OCR_STAGE_TIMEOUT_MS, async () => {
      await page.goto(`${launcher.baseUrl}/ocr`);
      await waitForRuntimeReady(page);
      await expect(page.getByTestId('first-run-card')).toHaveCount(0);
      await expect(page.getByTestId('ocr-choose-files')).toBeEnabled();

      // PDF OCR
      pdfDocId = await queueFileAndAwaitCompletion(page, {
        filePath: media.pdfPath,
        chooseButtonTestId: 'ocr-choose-files',
        queueRowTestId: 'ocr-queue-row',
        timeoutMs: OCR_STAGE_TIMEOUT_MS,
      });

      const pdfRow = page.locator(
        `[data-testid="ocr-queue-row"][data-document-id="${pdfDocId}"]`,
      );
      await pdfRow.getByTestId('ocr-row-view').click();
      await expect(page).toHaveURL(new RegExp(`/history/${pdfDocId}/content$`));

      const pdfCanvas = page.getByTestId('result-source-pdf-canvas');
      await expect(pdfCanvas).toHaveAttribute('data-rendered-page', '1', { timeout: 30_000 });
      const canvasWidth = await pdfCanvas.evaluate((el: HTMLCanvasElement) => el.width);
      assert.ok(canvasWidth > 0, 'PDF source canvas width must be positive.');

      const pageTextArea = page.getByTestId('result-page-text');
      await expect(pageTextArea).toBeVisible({ timeout: 15_000 });
      originalPdfPage1Text = await pageTextArea.inputValue();

      const pageTexts: string[] = [originalPdfPage1Text];
      const nextPageBtn = page.getByTestId('result-page-next');
      // Wait for each page to render before asking whether there is a next one:
      // the button is disabled only once the last page is shown, and a click on
      // a button that has just been disabled would wait for the whole stage.
      let shownPage = 1;
      while ((await nextPageBtn.count()) > 0 && (await nextPageBtn.isEnabled())) {
        await nextPageBtn.click();
        shownPage += 1;
        await expect(pdfCanvas).toHaveAttribute('data-rendered-page', String(shownPage), {
          timeout: 30_000,
        });
        pageTexts.push(await pageTextArea.inputValue());
      }
      assertOrderedAnchors(pageTexts.join('\n'), media.pdfExpectation.rawTextIncludes, 'PDF OCR');

      const pdfDetail = await invokeHost<DesktopLibraryDetailRecord>(page, 'library_get', {
        request: { documentId: pdfDocId },
      });
      assertDocumentCheckpoint(pdfDetail, 'PDF');
      const pdfExtractionSummary = assertOcrExtractionProvenance(
        pdfDetail,
        'PDF',
        media.expectedOcrDevice,
      );
      const pdfSegments = pdfDetail.raw?.segments ?? [];
      assert.ok(pdfSegments.length > 0, 'PDF record must contain raw segments.');

      await verifyDiagnosticsProvenance(page, pdfDocId, pdfExtractionSummary);

      evidence.provenance = {
        ...evidence.provenance,
        pdf: {
          extraction: pdfExtractionSummary,
          pageCount: pdfDetail.pageCount ?? pageTexts.length,
          segmentCount: pdfSegments.length,
          blockCount: pdfDetail.result?.blocks?.length ?? 0,
        },
      };

      // Image OCR
      await page.goto(`${launcher.baseUrl}/ocr`);
      await waitForRuntimeReady(page);
      await expect(page.getByTestId('ocr-choose-files')).toBeEnabled();

      imageDocId = await queueFileAndAwaitCompletion(page, {
        filePath: media.imagePath,
        chooseButtonTestId: 'ocr-choose-files',
        queueRowTestId: 'ocr-queue-row',
        timeoutMs: OCR_STAGE_TIMEOUT_MS,
      });

      const imageRow = page.locator(
        `[data-testid="ocr-queue-row"][data-document-id="${imageDocId}"]`,
      );
      await imageRow.getByTestId('ocr-row-view').click({ timeout: ACTION_TIMEOUT_MS });
      await expect(page).toHaveURL(new RegExp(`/history/${imageDocId}/content$`));

      const sourceImage = page.getByTestId('result-source-image');
      await expect(sourceImage).toBeVisible({ timeout: 30_000 });
      const imageNaturalWidth = await sourceImage.evaluate(
        (el: HTMLImageElement) => el.naturalWidth,
      );
      assert.ok(imageNaturalWidth > 0, 'Source image must finish loading.');

      await expect(pageTextArea).toBeVisible({ timeout: 15_000 });
      const imageVisibleText = await pageTextArea.inputValue();
      assertOrderedAnchors(
        imageVisibleText,
        media.imageExpectation.rawTextIncludes,
        'Image OCR',
      );

      const imageDetail = await invokeHost<DesktopLibraryDetailRecord>(page, 'library_get', {
        request: { documentId: imageDocId },
      });
      assertDocumentCheckpoint(imageDetail, 'Image');
      const imageExtractionSummary = assertOcrExtractionProvenance(
        imageDetail,
        'Image',
        media.expectedOcrDevice,
      );
      const imageSegments = imageDetail.raw?.segments ?? [];
      assert.ok(imageSegments.length > 0, 'Image record must contain raw segments.');

      await verifyDiagnosticsProvenance(page, imageDocId, imageExtractionSummary);

      evidence.provenance = {
        ...evidence.provenance,
        image: {
          extraction: imageExtractionSummary,
          pageCount: imageDetail.pageCount ?? 1,
          segmentCount: imageSegments.length,
          blockCount: imageDetail.result?.blocks?.length ?? 0,
        },
      };

      if (media.expectedOcrDevice !== undefined) {
        proven.ocrDevice = true;
      }
    });

    // -------------------------------------------------------------------------
    // Stage 3: Select structuring model, transcribe with speakers & structure
    // -------------------------------------------------------------------------
    let audioDocId = '';
    let activeModelLabel = '';
    let firstAsrSegmentId = '';
    let originalAsrLine0Text = '';

    await runStage(stages, '03-asr-and-structuring', ASR_STAGE_TIMEOUT_MS, async () => {
      activeModelLabel = await prepareModel(page, launcher.baseUrl, config.modelOptionId, false, proven);

      await page.goto(`${launcher.baseUrl}/settings/compute`);
      await waitForRuntimeReady(page);
      await expect(page.getByTestId('compute-prefer-gpu')).toBeChecked();

      await page.goto(`${launcher.baseUrl}/asr`);
      await waitForRuntimeReady(page);
      await expect(page.getByTestId('asr-choose-files')).toBeEnabled();

      const identifySpeakers = page.getByTestId('asr-identify-speakers');
      await expect(identifySpeakers).toBeVisible({ timeout: 15_000 });
      if (!(await identifySpeakers.isChecked())) {
        await identifySpeakers.check();
      }

      audioDocId = await queueFileAndAwaitCompletion(page, {
        filePath: media.audioPath,
        chooseButtonTestId: 'asr-choose-files',
        queueRowTestId: 'asr-queue-row',
        timeoutMs: ASR_STAGE_TIMEOUT_MS,
      });

      const asrRow = page.locator(
        `[data-testid="asr-queue-row"][data-document-id="${audioDocId}"]`,
      );
      await asrRow.getByTestId('asr-row-view').click();
      await expect(page).toHaveURL(new RegExp(`/history/${audioDocId}/content$`));

      const transcriptRows = page.getByTestId('result-transcript-row');
      await expect
        .poll(() => transcriptRows.count(), { timeout: 15_000 })
        .toBeGreaterThan(0);

      firstAsrSegmentId = (await transcriptRows.first().getAttribute('data-segment-id')) ?? '';
      assert.ok(firstAsrSegmentId.length > 0, 'First ASR row must have data-segment-id.');
      originalAsrLine0Text = await transcriptRows
        .first()
        .getByTestId('result-line-text')
        .innerText();

      await page.getByTestId('result-nav-speakers').click();
      await expect(page).toHaveURL(new RegExp(`/history/${audioDocId}/speakers$`));
      const speakerRows = page.getByTestId('result-speaker-row');
      const speakerCount = await speakerRows.count();
      assert.ok(speakerCount > 0, 'Speaker diarization must produce at least one speaker row.');

      const audioDetail = await invokeHost<DesktopLibraryDetailRecord>(page, 'library_get', {
        request: { documentId: audioDocId },
      });
      assert.equal(audioDetail.status, 'completed');
      assertAudioAgainstExpectation(audioDetail, media.audioExpectation);

      const audioExtraction =
        audioDetail.result?.extractionEngine ?? audioDetail.raw?.extractionEngine;
      assert.ok(audioExtraction, 'Audio record must include extractionEngine provenance.');
      assert.equal(audioExtraction.engine, 'speech-recognition');
      assert.equal(audioExtraction.model, expectedSpeech.model);
      assert.equal(audioExtraction.device, expectedSpeech.device);
      assert.match(audioExtraction.digest, SHA256_DIGEST_PATTERN);

      const audioStructuring = audioDetail.result?.structuringEngine;
      assert.ok(audioStructuring, 'Audio record must include structuringEngine provenance.');
      assert.equal(audioStructuring.engine, 'ollama');
      assert.ok(audioStructuring.model.trim().length > 0, 'Structuring model must be recorded.');
      assert.match(audioStructuring.digest, SHA256_DIGEST_PATTERN);
      const structuringDevice = audioStructuring.device ?? null;
      assert.ok([null, 'cuda', 'rocm', 'vulkan', 'cpu'].includes(structuringDevice));
      const nvidia = spawnSync('nvidia-smi', ['--list-gpus'], {
        encoding: 'utf8',
        timeout: 2_000,
        windowsHide: true,
      });
      if (nvidia.status === 0 && nvidia.stdout.trim() !== '') {
        assert.equal(structuringDevice, 'cuda', 'Owned Ollama must use the NVIDIA GPU.');
        assertOllamaCudaUuidPin(await readFile(join(config.appDataDir, 'ollama', 'ollama.log'), 'utf8'));
      }
      if (structuringDevice === null || structuringDevice === 'cpu') {
        assert.equal(audioStructuring.deviceName ?? null, null);
      }

      const audioExtractionSummary = toProvenanceSummary(audioExtraction);
      const audioStructuringSummary = toProvenanceSummary(audioStructuring);
      await verifyDiagnosticsProvenance(
        page,
        audioDocId,
        audioExtractionSummary,
        audioStructuringSummary,
      );

      evidence.provenance = {
        ...evidence.provenance,
        audio: {
          extraction: audioExtractionSummary,
          structuring: audioStructuringSummary,
          segmentCount: audioDetail.raw?.segments?.length ?? 0,
          speakerCount: audioDetail.result?.speakers?.length ?? speakerCount,
          blockCount: audioDetail.result?.blocks?.length ?? 0,
        },
      };
    });

    let progressiveDocId: string | undefined;
    if (media.progressiveAudio) {
      const progressive = media.progressiveAudio;
      const oracle = progressive.oracle;
      const installedPack = assertInstalledSpeechPack(config.appDataDir, expectedSpeech.device);
      const observed = evidence.provenance.audio?.extraction;
      if (oracle.speechPack !== installedPack || oracle.extraction.device !== observed?.device
        || oracle.extraction.model !== observed?.model) {
        throw new Error(
          `Progressive audio oracle uses ${oracle.speechPack} pack, ${oracle.extraction.device} device and ${oracle.extraction.model} model; `
          + `the installation uses ${installedPack} pack, ${observed?.device ?? 'unknown'} device and ${observed?.model ?? 'unknown'} model. Regenerate the oracle for this installation.`,
        );
      }
      const partialBudget = progressive.partialBudgetMs;
      await runStage(stages, '03-progressive-partial', partialBudget + PROGRESSIVE_COMPLETION_ALLOWANCE_MS, async () => {
        await page.goto(`${launcher.baseUrl}/asr`);
        await waitForRuntimeReady(page);
        await page.getByTestId('asr-language-select').selectOption('zh');
        // Speaker identification requires a whole-recording pass.
        await page.getByTestId('asr-identify-speakers').uncheck();
        const result = await checkProgressiveRecording(page, progressive);
        progressiveDocId = result.documentId;
        evidence.provenance.progressiveAudio = result.checkpoint;
        proven.progressivePartial = true;
      });
    }

    // -------------------------------------------------------------------------
    // Stage 4: Edit, reload, export, and restore
    // -------------------------------------------------------------------------
    const asrEditMarker = `CAPTURE_ASR_MARKER_${randomBytes(6).toString('hex')}`;

    await runStage(
      stages,
      '04-edit-restore-and-export',
      EDIT_EXPORT_STAGE_TIMEOUT_MS,
      async () => {
        // 4a. PDF edit -> reload -> export -> restore
        await page.goto(`${launcher.baseUrl}/history/${pdfDocId}/content`);
        await waitForRuntimeReady(page);

        const ocrEditMarker = `CAPTURE_OCR_MARKER_${randomBytes(6).toString('hex')}`;
        const pageTextArea = page.getByTestId('result-page-text');
        await expect(pageTextArea).toBeVisible({ timeout: 15_000 });
        await pageTextArea.fill(`${originalPdfPage1Text}\n${ocrEditMarker}`);

        await expect(page.getByTestId('result-page-edited')).toBeVisible({ timeout: 15_000 });
        await expect
          .poll(async () => {
            const detail = await invokeHost<DesktopLibraryDetailRecord>(page, 'library_get', {
              request: { documentId: pdfDocId },
            });
            return detail.edits?.ocrPages?.['1']?.includes(ocrEditMarker) ?? false;
          }, { timeout: 15_000 })
          .toBe(true);

        await page.reload();
        await waitForRuntimeReady(page);
        await expect
          .poll(async () => sha256(await pageTextArea.inputValue()), {
            timeout: 15_000,
            message: 'result-page-text must match the edited page after reload.',
          })
          .toBe(sha256(`${originalPdfPage1Text}\n${ocrEditMarker}`));
        await expect(page.getByTestId('result-page-edited')).toBeVisible();

        await page.getByTestId('result-nav-export').click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page).toHaveURL(new RegExp(`/history/${pdfDocId}/export$`));
        const [ocrDownload] = await Promise.all([
          page.waitForEvent('download', { timeout: 30_000 }),
          page.getByTestId('result-export-text').click({ timeout: ACTION_TIMEOUT_MS }),
        ]);
        const ocrExportPath = join(exportTempDir, 'ocr-edited.txt');
        await ocrDownload.saveAs(ocrExportPath);
        await expect(page.getByTestId('result-export-status')).toBeVisible({ timeout: 15_000 });
        const ocrExportContent = await readFile(ocrExportPath, 'utf8');
        assert.ok(ocrExportContent.length > 0, 'Exported OCR text file must not be empty.');
        assert.ok(
          ocrExportContent.includes(ocrEditMarker),
          'Exported OCR text file must reflect the edited marker.',
        );

        await page.getByTestId('result-nav-content').click({ timeout: ACTION_TIMEOUT_MS });
        await page.getByTestId('result-page-restore').click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByTestId('result-page-edited')).toHaveCount(0, { timeout: 15_000 });
        await expect
          .poll(async () => sha256(await pageTextArea.inputValue()), {
            timeout: 15_000,
            message: 'result-page-text must match the restored page.',
          })
          .toBe(sha256(originalPdfPage1Text));
        await expect
          .poll(async () => {
            const detail = await invokeHost<DesktopLibraryDetailRecord>(page, 'library_get', {
              request: { documentId: pdfDocId },
            });
            return detail.edits?.ocrPages?.['1'] === undefined;
          }, { timeout: 15_000 })
          .toBe(true);

        // 4b. ASR line edit -> reload -> SRT export (leave edit saved for restart check)
        await page.goto(`${launcher.baseUrl}/history/${audioDocId}/content`);
        await waitForRuntimeReady(page);

        const firstRow = page.locator(
          `[data-testid="result-transcript-row"][data-segment-id="${firstAsrSegmentId}"]`,
        );
        await expect(firstRow).toBeVisible({ timeout: 15_000 });
        await firstRow.hover();
        await firstRow.getByTestId('result-line-edit').click({ timeout: ACTION_TIMEOUT_MS });

        const lineInput = firstRow.getByTestId('result-line-input');
        await lineInput.fill(`${originalAsrLine0Text} ${asrEditMarker}`);
        await lineInput.press('Enter');

        await expect(firstRow.getByTestId('result-line-edited')).toBeVisible({ timeout: 15_000 });
        await expect
          .poll(async () => {
            const detail = await invokeHost<DesktopLibraryDetailRecord>(page, 'library_get', {
              request: { documentId: audioDocId },
            });
            return detail.edits?.transcriptLines?.[firstAsrSegmentId]?.includes(asrEditMarker) ?? false;
          }, { timeout: 15_000 })
          .toBe(true);

        await page.reload();
        await waitForRuntimeReady(page);
        await expect
          .poll(
            async () =>
              (await firstRow.getByTestId('result-line-text').innerText()).includes(asrEditMarker),
            {
              timeout: 15_000,
              message: 'result-line-text must contain the edited marker after reload.',
            },
          )
          .toBe(true);
        await expect(firstRow.getByTestId('result-line-edited')).toBeVisible();

        await page.getByTestId('result-nav-export').click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page).toHaveURL(new RegExp(`/history/${audioDocId}/export$`));
        const [asrDownload] = await Promise.all([
          page.waitForEvent('download', { timeout: 30_000 }),
          page.getByTestId('result-export-srt').click({ timeout: ACTION_TIMEOUT_MS }),
        ]);
        const asrExportPath = join(exportTempDir, 'asr-edited.srt');
        await asrDownload.saveAs(asrExportPath);
        await expect(page.getByTestId('result-export-status')).toBeVisible({ timeout: 15_000 });
        const asrExportContent = await readFile(asrExportPath, 'utf8');
        assert.ok(asrExportContent.length > 0, 'Exported SRT file must not be empty.');
        assert.ok(
          asrExportContent.includes(asrEditMarker),
          'Exported SRT file must reflect the edited marker.',
        );
      },
    );

    // -------------------------------------------------------------------------
    // Stage 5: Stop and restart launcher on the same --app-data
    // -------------------------------------------------------------------------
    await runStage(stages, '05-restart-persistence', RESTART_STAGE_TIMEOUT_MS, async () => {
      const previousPort = launcher.port;
      const previousDevHostPort = launcher.devHostPort;
      await launcher.stop();
      await expect
        .poll(() => canConnect(previousDevHostPort), { timeout: 15_000, intervals: [250] })
        .toBe(false);
      await expect
        .poll(() => canConnect(previousPort), { timeout: 15_000, intervals: [250] })
        .toBe(false);
      activeLauncher = undefined;

      launcher = await startHostWithConfig();

      await page.goto(`${launcher.baseUrl}/settings/engines`);
      await waitForRuntimeReady(page);
      for (const requirementId of ALL_RECOGNITION_UNITS) {
        await expect(
          page.locator(`[data-testid="engine-row"][data-requirement-id="${requirementId}"]`),
        ).toHaveAttribute('data-status', 'ready');
      }

      await page.goto(`${launcher.baseUrl}/settings/diagnostics`);
      await waitForRuntimeReady(page);
      await expect(page.getByTestId('diagnostics-active-model')).toHaveText(activeModelLabel, {
        timeout: 15_000,
      });

      await page.goto(`${launcher.baseUrl}/history`);
      await waitForRuntimeReady(page);
      const persistedIds = [pdfDocId, imageDocId, audioDocId];
      if (progressiveDocId) persistedIds.push(progressiveDocId);
      for (const docId of persistedIds) {
        const historyRow = page.locator(
          `[data-testid="history-row"][data-document-id="${docId}"]`,
        );
        await expect(historyRow).toBeVisible({ timeout: 15_000 });
        await expect(historyRow).toHaveAttribute('data-user-status', 'done');
      }

      // Restored PDF edit stays restored across restart
      await page.goto(`${launcher.baseUrl}/history/${pdfDocId}/content`);
      await waitForRuntimeReady(page);
      await expect
        .poll(async () => sha256(await page.getByTestId('result-page-text').inputValue()), {
          timeout: 15_000,
          message: 'result-page-text must match the restored page after restart.',
        })
        .toBe(sha256(originalPdfPage1Text));
      await expect(page.getByTestId('result-page-edited')).toHaveCount(0);

      // Un-restored ASR edit stays saved across restart
      await page.goto(`${launcher.baseUrl}/history/${audioDocId}/content`);
      await waitForRuntimeReady(page);
      const firstRowAfterRestart = page.locator(
        `[data-testid="result-transcript-row"][data-segment-id="${firstAsrSegmentId}"]`,
      );
      await expect
        .poll(
          async () =>
            (
              await firstRowAfterRestart.getByTestId('result-line-text').innerText()
            ).includes(asrEditMarker),
          {
            timeout: 15_000,
            message: 'result-line-text must contain the edited marker after restart.',
          },
        )
        .toBe(true);
      await expect(firstRowAfterRestart.getByTestId('result-line-edited')).toBeVisible();

      evidence.restart = {
        oldPortsClosed: true,
        persistedDocumentCount: persistedIds.length,
        featuresReadyWithoutReinstall: true,
      };
    });

    // -------------------------------------------------------------------------
    // Stage 6: Delete image and recording from /history
    // -------------------------------------------------------------------------
    await runStage(stages, '06-delete-documents', DELETE_STAGE_TIMEOUT_MS, async () => {
      await deleteDocumentFromHistoryList(page, launcher.baseUrl, imageDocId, 'image');
      await deleteDocumentFromHistoryList(page, launcher.baseUrl, audioDocId, 'recording');
      if (progressiveDocId) {
        await deleteDocumentFromHistoryList(page, launcher.baseUrl, progressiveDocId, 'progressive recording');
      }
    });

    // -------------------------------------------------------------------------
    // Stage 7: Stop and restart launcher once more after deletion
    // -------------------------------------------------------------------------
    await runStage(stages, '07-restart-after-deletion', RESTART_STAGE_TIMEOUT_MS, async () => {
      const previousPort = launcher.port;
      const previousDevHostPort = launcher.devHostPort;
      await launcher.stop();
      await expect
        .poll(() => canConnect(previousDevHostPort), { timeout: 15_000, intervals: [250] })
        .toBe(false);
      await expect
        .poll(() => canConnect(previousPort), { timeout: 15_000, intervals: [250] })
        .toBe(false);
      activeLauncher = undefined;

      launcher = await startHostWithConfig();

      await page.goto(`${launcher.baseUrl}/history`);
      await waitForRuntimeReady(page);
      const pdfRow = page.locator(
        `[data-testid="history-row"][data-document-id="${pdfDocId}"]`,
      );
      await expect(pdfRow).toBeVisible({ timeout: 15_000 });
      await expect(pdfRow).toHaveAttribute('data-user-status', 'done');

      for (const [deletedId, label] of [
        [imageDocId, 'image'],
        [audioDocId, 'recording'],
        ...(progressiveDocId ? [[progressiveDocId, 'progressive recording'] as const] : []),
      ] as const) {
        const deletedRow = page.locator(
          `[data-testid="history-row"][data-document-id="${deletedId}"]`,
        );
        await expect(deletedRow).toHaveCount(0);
        await assertDocumentAbsentFromHost(page, deletedId, `${label} (after restart)`);
      }

      const remainingList = await invokeHost<readonly DesktopLibrarySummaryRecord[]>(
        page,
        'library_list',
        { request: { query: '', status: '' } },
      );
      // The app data may be reused across runs, so only this run's documents count.
      const runDocumentIds = [pdfDocId, imageDocId, audioDocId, progressiveDocId];
      const remainingRunIds = remainingList
        .map((item) => item.documentId)
        .filter((documentId) => runDocumentIds.includes(documentId));
      assert.deepEqual(
        remainingRunIds,
        [pdfDocId],
        'Of this run\'s documents only the PDF must remain after deletion.',
      );

      // Kept PDF document still opens with its restored state
      await page.goto(`${launcher.baseUrl}/history/${pdfDocId}/content`);
      await waitForRuntimeReady(page);
      await expect
        .poll(async () => sha256(await page.getByTestId('result-page-text').inputValue()), {
          timeout: 15_000,
          message: 'result-page-text must match the restored page after post-deletion restart.',
        })
        .toBe(sha256(originalPdfPage1Text));
      await expect(page.getByTestId('result-page-edited')).toHaveCount(0);

      proven.deletion = true;
      evidence.restartAfterDeletion = {
        oldPortsClosed: true,
        remainingDocumentCount: remainingRunIds.length,
        deletedIdsAbsent: true,
      };
    });

    evidence.passed = true;
  } finally {
    // The export directory is removed in its own finally, before the port
    // checks. Those checks still run when removal throws, and the launcher
    // handle stays until both ports are confirmed closed.
    try {
      await Promise.resolve().finally(removeExportDir);
    } finally {
      if (activeLauncher) {
        const devHostPortToClose = activeLauncher.devHostPort;
        const proxyPortToClose = activeLauncher.port;
        await activeLauncher.stop();
        await expect
          .poll(() => canConnect(devHostPortToClose), { timeout: 15_000, intervals: [250] })
          .toBe(false);
        await expect
          .poll(() => canConnect(proxyPortToClose), { timeout: 15_000, intervals: [250] })
          .toBe(false);
        activeLauncher = undefined;
      }
      evidence.finishedAt = new Date().toISOString();
      evidence.startupReloads = startupReloads;
      const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
      assert.doesNotMatch(
        serialized,
        /[A-Za-z]:[\\/]/u,
        'Evidence JSON must not contain local file system paths.',
      );
      await writeFile(evidencePath, serialized, 'utf8');
    }
  }
}

