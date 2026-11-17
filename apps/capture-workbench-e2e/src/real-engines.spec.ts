/**
 * Real-engines localhost E2E smoke (Issue #418, Slice 3 Part A).
 *
 * Drives the real Workbench UI (`capture-workbench:serve`) against the real
 * headless host (`capture-workbench-dev-host`) and the staged product (or
 * specified) `capture-runtime` with real recognition engines and Ollama
 * structuring:
 *   1. First-run installation via UI (`/ocr` first-run card & `/settings/engines`),
 *      covering cancel + retry and reload re-attachment without duplicate installs.
 *   2. PDF and image OCR to `/history/:id/content`, verifying normalized text
 *      anchors, rendered source, `library_get` provenance, and `/settings/diagnostics`.
 *   3. Structuring model selection on `/settings/diagnostics`, audio transcription
 *      with speaker diarization and structuring on `/asr`, verifying the speech
 *      provenance of the installed pack (`tea-asr-1.1` on `cuda` with the NVIDIA
 *      driver, `tea-asr-1.1-mini` on `cpu` without) + Ollama structuring
 *      provenance with sha256 digests.
 *   4. Viewing, editing with a synthetic marker, reload persistence, exporting to
 *      disk, and restoring edits.
 *   5. Stopping the launcher (host + runtime + workers) and restarting on the same
 *      `--app-data` directory, verifying features, model, documents, restored
 *      state, and active edits persist without re-installing.
 *
 * Explicit per-stage timeout placeholders (to be measured by the first real run):
 *   - 01-install-engines:      45 minutes (cold real downloads; much faster with cache)
 *   - 02-ocr-pdf-and-image:    10 minutes
 *   - 03-asr-and-structuring:  35 minutes (includes Ollama structuring model pull + ASR + structuring)
 *   - 04-edit-restore-export:   3 minutes
 *   - 05-restart-persistence:   5 minutes
 *
 * Environment variables (missing/invalid entries are reported together upfront):
 *   Required media & expectations:
 *   - CAPTURE_REAL_ENGINES_PDF (or CAPTURE_REAL_MEDIA_PDF / CAPTURE_REAL_DESKTOP_OCR_PDF)
 *   - CAPTURE_REAL_ENGINES_PDF_EXPECTATIONS (optional override; defaults to `<pdf>.expected.json`)
 *   - CAPTURE_REAL_ENGINES_IMAGE (or CAPTURE_REAL_MEDIA_IMAGE / CAPTURE_REAL_DESKTOP_OCR_INPUT)
 *   - CAPTURE_REAL_ENGINES_IMAGE_EXPECTATIONS (optional override; defaults to `<image>.expected.json`)
 *   - CAPTURE_REAL_ENGINES_AUDIO (or CAPTURE_REAL_MEDIA_AUDIO)
 *   - CAPTURE_REAL_ENGINES_AUDIO_EXPECTATIONS (or CAPTURE_REAL_MEDIA_MODEL_AUDIO_ORACLE; defaults to `<audio>.expected.json`)
 *   Required runtime/storage directories & model selection:
 *   - CAPTURE_REAL_ENGINES_APP_DATA (or CAPTURE_REAL_MEDIA_APP_DATA): empty/dedicated absolute directory outside %APPDATA%/%LOCALAPPDATA%
 *   - CAPTURE_REAL_ENGINES_TEMP_DIR: explicit temp directory for host/runtime/exports
 *   - CAPTURE_REAL_ENGINES_MODEL_OPTION_ID: e.g. `qwen3.5-0.8b-v1`, `qwen3.5-2b-v1`, `qwen3.5-4b-v1`
 *   Optional overrides:
 *   - CAPTURE_REAL_ENGINES_REUSE_INSTALLED=1: the app-data directory already holds the
 *     recognition features from an earlier run; stage 1 only checks they are ready.
 *     A run with this set does not prove installation, cancel, retry or re-attachment.
 *   - CAPTURE_REAL_ENGINES_RUNTIME_MANIFEST & CAPTURE_REAL_ENGINES_RUNTIME_EXECUTABLE (both or neither; default is staged product runtime)
 *   - CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN / CAPTURE_SMOKE_WORKER_MIRROR_URL
 *
 * The runtime runs as the product runs it. The host starts it with the product's
 * launch policy (`launch_policy.rs`, `constants/launch.rs`), which clears the
 * environment and forwards a fixed list. So, as in the Desktop App:
 *   - the speech model is the installed pack's default, not a development
 *     override: this smoke is on the release side of "Speech development tests"
 *     in AGENTS.md, like the desktop model smoke it stands in for;
 *   - downloaded engines are cached in the runtime's default engine cache
 *     (`%LOCALAPPDATA%\gx-capture\engine-cache`), the one folder of the user's
 *     profile this run writes to. App data, runtime data, Ollama data and temp
 *     files are under the directories given above.
 *
 * Private material warning:
 *   Never commit private inputs or recognized text. This spec keeps input file
 *   names, recognized text, speaker names, and user-profile paths out of test
 *   titles, console logs, errors, and the evidence JSON.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  canConnect,
  startRealBackendLauncher,
  type StartedRealBackendLauncher,
} from './real-backend-launcher.ts';

const workspaceRoot = resolve(import.meta.dirname, '..', '..', '..');
const upstreamUrl = 'http://localhost:4200';
const evidenceDir = join(workspaceRoot, 'tmp', 'capture-workbench-e2e', 'real-engines');
const evidencePath = join(evidenceDir, 'real-engines-evidence.json');

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
const MODEL_INSTALL_TIMEOUT_MS = 25 * 60_000; // measured by the first real run
const EDIT_EXPORT_STAGE_TIMEOUT_MS = 3 * 60_000; // measured by the first real run
const RESTART_STAGE_TIMEOUT_MS = 5 * 60_000; // measured by the first real run
// The application itself waits three minutes (DESKTOP_RUNTIME_READY_TIMEOUT_MS):
// with the features installed, readiness includes probing their workers.
const RUNTIME_READY_TIMEOUT_MS = 200_000;

const ALL_RECOGNITION_UNITS = [
  'windowsml-ocr',
  'speech-recognition',
  'speaker-diarization',
] as const;

const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

/** What the installed speech pack records: the runtime picks the pack by the NVIDIA driver. */
function expectedSpeechProvenance(): { readonly model: string; readonly device: string } {
  const systemRoot = process.env['SystemRoot'] ?? process.env['WINDIR'] ?? 'C:\\Windows';
  return existsSync(join(systemRoot, 'System32', 'nvcuda.dll'))
    ? { model: 'tea-asr-1.1', device: 'cuda' }
    : { model: 'tea-asr-1.1-mini', device: 'cpu' };
}

interface RealTextExpectation {
  readonly schemaVersion: 1;
  readonly rawTextIncludes: readonly string[];
}

interface ProgressiveAudioOracle {
  readonly evidenceKind: 'progressive-audio-oracle-v1';
  readonly expectedOutput: {
    readonly normalizedSha256: string;
    readonly segmentCount: number;
  };
  readonly extraction: {
    readonly engine: string;
    readonly model: string;
    readonly device: string;
  };
}

type AudioExpectation = RealTextExpectation | ProgressiveAudioOracle;

interface SmokeConfig {
  readonly pdfPath: string;
  readonly pdfExpectation: RealTextExpectation;
  readonly imagePath: string;
  readonly imageExpectation: RealTextExpectation;
  readonly audioPath: string;
  readonly audioExpectation: AudioExpectation;
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

interface ProvenanceSummary {
  readonly engine: string;
  readonly model: string;
  readonly device: string | null;
  readonly digest: string;
}

interface SmokeEvidence {
  readonly evidenceKind: 'real-engines-localhost-v1';
  readonly startedAt: string;
  finishedAt: string;
  passed: boolean;
  /** Page loads that needed a reload before the Workbench was ready (issue #425). */
  startupReloads: number;
  readonly stages: StageRecord[];
  provenance: {
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

async function loadAudioExpectation(filePath: string): Promise<AudioExpectation> {
  const rawJson = await readFile(filePath, 'utf8');
  const parsed: unknown = JSON.parse(rawJson);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Audio expectation file must be a JSON object.');
  }
  const record = parsed as Record<string, unknown>;
  if (record['evidenceKind'] === 'progressive-audio-oracle-v1') {
    const expectedOutput = record['expectedOutput'] as Record<string, unknown> | undefined;
    const extraction = record['extraction'] as Record<string, unknown> | undefined;
    if (
      !expectedOutput
      || typeof expectedOutput['normalizedSha256'] !== 'string'
      || typeof expectedOutput['segmentCount'] !== 'number'
      || !extraction
      || typeof extraction['engine'] !== 'string'
      || typeof extraction['model'] !== 'string'
      || typeof extraction['device'] !== 'string'
    ) {
      throw new Error('Audio oracle file has an invalid progressive-audio-oracle-v1 structure.');
    }
    return {
      evidenceKind: 'progressive-audio-oracle-v1',
      expectedOutput: {
        normalizedSha256: expectedOutput['normalizedSha256'],
        segmentCount: expectedOutput['segmentCount'],
      },
      extraction: {
        engine: extraction['engine'],
        model: extraction['model'],
        device: extraction['device'],
      },
    };
  }
  return loadTextExpectation(filePath, 'Audio');
}

async function resolveSmokeConfig(): Promise<SmokeConfig> {
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
    readEnvFirst([
      'CAPTURE_REAL_ENGINES_AUDIO_EXPECTATIONS',
      'CAPTURE_REAL_MEDIA_MODEL_AUDIO_ORACLE',
    ]) ?? (audioPath ? `${audioPath}.expected.json` : undefined);
  if (!audioExpPath || !isRegularFile(audioExpPath)) {
    missingOrInvalid.push(
      'CAPTURE_REAL_ENGINES_AUDIO_EXPECTATIONS (or CAPTURE_REAL_MEDIA_MODEL_AUDIO_ORACLE / <audio>.expected.json)',
    );
  }

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

  if (missingOrInvalid.length > 0) {
    throw new Error(
      `Missing or invalid real-engines configuration:\n- ${missingOrInvalid.join('\n- ')}`,
    );
  }

  const [pdfExpectation, imageExpectation, audioExpectation] = await Promise.all([
    loadTextExpectation(pdfExpPath!, 'PDF'),
    loadTextExpectation(imageExpPath!, 'Image'),
    loadAudioExpectation(audioExpPath!),
  ]);

  const launcherEnv: Record<string, string> = {
    TEMP: tempDir!,
    TMP: tempDir!,
    TMPDIR: tempDir!,
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
    pdfPath: pdfPath!,
    pdfExpectation,
    imagePath: imagePath!,
    imageExpectation,
    audioPath: audioPath!,
    audioExpectation,
    appDataDir: appDataDir!,
    tempDir: tempDir!,
    modelOptionId: modelOptionId!,
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
  expectation: AudioExpectation,
): void {
  const segments = detail.raw?.segments ?? [];
  assert.ok(segments.length > 0, 'Audio capture must store raw segments.');
  assert.ok(
    segments.some((segment) => segment.locator.kind === 'time'),
    'Audio capture segments must include time locators.',
  );

  if ('evidenceKind' in expectation) {
    const fullText = segments.map((s) => s.text).join(' ').replace(/\s+/gu, ' ').trim();
    const digest = createHash('sha256').update(fullText, 'utf8').digest('hex');
    assert.equal(
      segments.length,
      expectation.expectedOutput.segmentCount,
      'Audio segment count must match progressive audio oracle.',
    );
    assert.equal(
      digest,
      expectation.expectedOutput.normalizedSha256,
      'Audio normalized transcript digest must match progressive audio oracle.',
    );
    return;
  }

  const combinedText =
    detail.raw?.sourceText ?? segments.map((segment) => segment.text).join('\n');
  assertOrderedAnchors(combinedText, expectation.rawTextIncludes, 'ASR');
}

function toProvenanceSummary(provenance: EngineProvenance): ProvenanceSummary {
  return {
    engine: provenance.engine,
    model: provenance.model,
    device: provenance.device ?? null,
    digest: provenance.digest,
  };
}

async function queueFileAndAwaitCompletion(
  page: Page,
  options: {
    readonly filePath: string;
    readonly chooseButtonTestId: 'ocr-choose-files' | 'asr-choose-files';
    readonly queueRowTestId: 'ocr-queue-row' | 'asr-queue-row';
    readonly timeoutMs: number;
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

  await page.getByTestId(options.chooseButtonTestId).click();

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
  }

  if (expectedStructuring) {
    const structuringEl = page.getByTestId('diagnostics-structuring-provenance');
    await expect(structuringEl).toBeVisible({ timeout: 15_000 });
    await expect(structuringEl).toHaveAttribute('data-engine', expectedStructuring.engine);
    await expect(structuringEl).toHaveAttribute('data-model', expectedStructuring.model);
    await expect(structuringEl).toHaveAttribute('data-digest', expectedStructuring.digest);
  }
}

test('runs full real-engine capture, editing, export, and restart journey on localhost', async ({
  page,
}) => {
  test.setTimeout(0);

  const config = await resolveSmokeConfig();
  mkdirSync(config.appDataDir, { recursive: true });
  mkdirSync(config.tempDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });

  const exportTempDir = join(config.tempDir, `exports-${randomBytes(4).toString('hex')}`);
  mkdirSync(exportTempDir, { recursive: true });

  const stages: StageRecord[] = [];
  const evidence: SmokeEvidence = {
    evidenceKind: 'real-engines-localhost-v1',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    passed: false,
    startupReloads: 0,
    stages,
    provenance: {},
  };

  let activeLauncher: StartedRealBackendLauncher | undefined;

  const startHostWithConfig = async (): Promise<StartedRealBackendLauncher> => {
    const started = await startRealBackendLauncher({
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
    await runStage(stages, '01-install-engines', INSTALL_STAGE_TIMEOUT_MS, async () => {
      if (process.env['CAPTURE_REAL_ENGINES_REUSE_INSTALLED'] === '1') {
        // A later run on an app-data directory that already holds the features:
        // installation, cancel, retry and re-attachment are not proven by it.
        await page.goto(`${launcher.baseUrl}/settings/engines`);
        await waitForRuntimeReady(page);
        for (const requirementId of ALL_RECOGNITION_UNITS) {
          await expect(
            page.locator(`[data-testid="engine-row"][data-requirement-id="${requirementId}"]`),
          ).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
        }
        console.log('stage 01-install-engines: reused an existing installation, not proven');
        return;
      }
      await page.goto(`${launcher.baseUrl}/ocr`);
      await waitForRuntimeReady(page);

      const firstRunCard = page.getByTestId('first-run-card');
      await expect(firstRunCard).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('first-run-checkbox-ocr')).toBeChecked();
      await page.getByTestId('first-run-install').click();

      let cancelAndRetryVerified = false;
      let reloadReattachVerified = false;

      const ocrProgress = page.getByTestId('ocr-install-progress');
      await expect(ocrProgress).toBeVisible({ timeout: 60_000 });
      const ocrCancel = page.getByTestId('ocr-install-cancel');
      if (await ocrCancel.isVisible()) {
        await ocrCancel.click();
      }

      await nav.getByRole('link', { name: '設定' }).click();
      await expect(page).toHaveURL(/\/settings\/engines$/u);
      await expect(page.getByTestId('engines-table')).toBeVisible({ timeout: 15_000 });

      const ocrRow = page.locator(
        '[data-testid="engine-row"][data-requirement-id="windowsml-ocr"]',
      );
      await expect(ocrRow).toBeVisible();
      await expect
        .poll(async () => ocrRow.getAttribute('data-status'), {
          timeout: INSTALL_UNIT_TIMEOUT_MS,
          intervals: [250],
        })
        .toMatch(/^(?:ready|cancelled|failed|installable)$/u);
      if (await ocrRow.getByTestId('engine-row-retry').isVisible()) {
        await ocrRow.getByTestId('engine-row-retry').click();
        cancelAndRetryVerified = true;
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

        if (!cancelAndRetryVerified && (await row.getByTestId('engine-row-install').isVisible())) {
          await row.getByTestId('engine-row-install').click();
          const cancelButton = row.getByTestId('engine-row-cancel');
          await expect(cancelButton).toBeVisible({ timeout: 60_000 });
          await cancelButton.click();
          const retryButton = row.getByTestId('engine-row-retry');
          await expect(retryButton).toBeVisible({ timeout: 60_000 });
          await retryButton.click();
          cancelAndRetryVerified = true;
        } else if (await row.getByTestId('engine-row-install').isVisible()) {
          await row.getByTestId('engine-row-install').click();
        } else if (await row.getByTestId('engine-row-retry').isVisible()) {
          await row.getByTestId('engine-row-retry').click();
        }

        if (!reloadReattachVerified) {
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
        cancelAndRetryVerified,
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
        filePath: config.pdfPath,
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
      while ((await nextPageBtn.count()) > 0 && (await nextPageBtn.isEnabled())) {
        await nextPageBtn.click();
        pageTexts.push(await pageTextArea.inputValue());
      }
      assertOrderedAnchors(pageTexts.join('\n'), config.pdfExpectation.rawTextIncludes, 'PDF OCR');

      const pdfDetail = await invokeHost<DesktopLibraryDetailRecord>(page, 'library_get', {
        request: { documentId: pdfDocId },
      });
      assertDocumentCheckpoint(pdfDetail, 'PDF');
      const pdfExtraction = pdfDetail.raw?.extractionEngine;
      assert.ok(pdfExtraction, 'PDF record must include extractionEngine provenance.');
      assert.equal(pdfExtraction.engine, 'windowsml-ocr');
      assert.ok(
        pdfExtraction.device === 'windowsml-dml' || pdfExtraction.device === 'cpu',
        `Unexpected OCR device: ${String(pdfExtraction.device)}`,
      );
      assert.match(pdfExtraction.digest, SHA256_DIGEST_PATTERN);
      const pdfSegments = pdfDetail.raw?.segments ?? [];
      assert.ok(pdfSegments.length > 0, 'PDF record must contain raw segments.');

      const pdfExtractionSummary = toProvenanceSummary(pdfExtraction);
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
        filePath: config.imagePath,
        chooseButtonTestId: 'ocr-choose-files',
        queueRowTestId: 'ocr-queue-row',
        timeoutMs: OCR_STAGE_TIMEOUT_MS,
      });

      const imageRow = page.locator(
        `[data-testid="ocr-queue-row"][data-document-id="${imageDocId}"]`,
      );
      await imageRow.getByTestId('ocr-row-view').click();
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
        config.imageExpectation.rawTextIncludes,
        'Image OCR',
      );

      const imageDetail = await invokeHost<DesktopLibraryDetailRecord>(page, 'library_get', {
        request: { documentId: imageDocId },
      });
      assertDocumentCheckpoint(imageDetail, 'Image');
      const imageExtraction = imageDetail.raw?.extractionEngine;
      assert.ok(imageExtraction, 'Image record must include extractionEngine provenance.');
      assert.equal(imageExtraction.engine, 'windowsml-ocr');
      assert.ok(
        imageExtraction.device === 'windowsml-dml' || imageExtraction.device === 'cpu',
        `Unexpected OCR device: ${String(imageExtraction.device)}`,
      );
      assert.match(imageExtraction.digest, SHA256_DIGEST_PATTERN);
      const imageSegments = imageDetail.raw?.segments ?? [];
      assert.ok(imageSegments.length > 0, 'Image record must contain raw segments.');

      const imageExtractionSummary = toProvenanceSummary(imageExtraction);
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
    });

    // -------------------------------------------------------------------------
    // Stage 3: Select structuring model, transcribe with speakers & structure
    // -------------------------------------------------------------------------
    let audioDocId = '';
    let activeModelLabel = '';
    let firstAsrSegmentId = '';
    let originalAsrLine0Text = '';

    await runStage(stages, '03-asr-and-structuring', ASR_STAGE_TIMEOUT_MS, async () => {
      await page.goto(`${launcher.baseUrl}/settings/diagnostics`);
      await waitForRuntimeReady(page);

      const modelOption = page.locator(
        `[data-testid="diagnostics-model-option"][data-model-option-id="${config.modelOptionId}"]`,
      );
      await expect(modelOption).toBeVisible({ timeout: 15_000 });
      const expectedModelDisplayName = (
        await modelOption.locator('..').locator('strong').innerText()
      ).trim();
      assert.ok(expectedModelDisplayName.length > 0, 'Model option must expose a displayName.');
      await modelOption.click();

      const installModelBtn = page.getByTestId('diagnostics-model-install');
      if (process.env['CAPTURE_REAL_ENGINES_REUSE_INSTALLED'] === '1') {
        // The model can be there from an earlier run; the button is then disabled.
        if (await installModelBtn.isEnabled()) {
          await installModelBtn.click();
        }
      } else {
        await expect(installModelBtn).toBeEnabled();
        await installModelBtn.click();
      }

      const activeModelEl = page.getByTestId('diagnostics-active-model');
      await expect(activeModelEl).toHaveText(expectedModelDisplayName, {
        timeout: MODEL_INSTALL_TIMEOUT_MS,
      });
      // The progress block stays on the page after the installation: it must
      // have reached a finished state, not be gone.
      const modelProgress = page.getByTestId('diagnostics-model-progress');
      await expect
        .poll(
          async () =>
            (await modelProgress.count()) === 0
              ? 'absent'
              : await modelProgress.getAttribute('data-status'),
          { timeout: MODEL_INSTALL_TIMEOUT_MS, intervals: [500] },
        )
        .toMatch(/^(?:absent|succeeded|completed|ready|installed)$/u);
      activeModelLabel = expectedModelDisplayName;

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
        filePath: config.audioPath,
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
      assertAudioAgainstExpectation(audioDetail, config.audioExpectation);

      const audioExtraction =
        audioDetail.result?.extractionEngine ?? audioDetail.raw?.extractionEngine;
      assert.ok(audioExtraction, 'Audio record must include extractionEngine provenance.');
      assert.equal(audioExtraction.engine, 'speech-recognition');
      const expectedSpeech = expectedSpeechProvenance();
      assert.equal(audioExtraction.model, expectedSpeech.model);
      assert.equal(audioExtraction.device, expectedSpeech.device);
      assert.match(audioExtraction.digest, SHA256_DIGEST_PATTERN);

      const audioStructuring = audioDetail.result?.structuringEngine;
      assert.ok(audioStructuring, 'Audio record must include structuringEngine provenance.');
      assert.equal(audioStructuring.engine, 'ollama');
      assert.ok(audioStructuring.model.trim().length > 0, 'Structuring model must be recorded.');
      assert.match(audioStructuring.digest, SHA256_DIGEST_PATTERN);

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
        await expect(pageTextArea).toHaveValue(`${originalPdfPage1Text}\n${ocrEditMarker}`, {
          timeout: 15_000,
        });
        await expect(page.getByTestId('result-page-edited')).toBeVisible();

        await page.getByTestId('result-nav-export').click();
        await expect(page).toHaveURL(new RegExp(`/history/${pdfDocId}/export$`));
        const [ocrDownload] = await Promise.all([
          page.waitForEvent('download', { timeout: 30_000 }),
          page.getByTestId('result-export-text').click(),
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

        await page.getByTestId('result-nav-content').click();
        await page.getByTestId('result-page-restore').click();
        await expect(page.getByTestId('result-page-edited')).toHaveCount(0, { timeout: 15_000 });
        await expect(pageTextArea).toHaveValue(originalPdfPage1Text, { timeout: 15_000 });
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
        await firstRow.getByTestId('result-line-edit').click();

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
        await expect(firstRow.getByTestId('result-line-text')).toContainText(asrEditMarker, {
          timeout: 15_000,
        });
        await expect(firstRow.getByTestId('result-line-edited')).toBeVisible();

        await page.getByTestId('result-nav-export').click();
        await expect(page).toHaveURL(new RegExp(`/history/${audioDocId}/export$`));
        const [asrDownload] = await Promise.all([
          page.waitForEvent('download', { timeout: 30_000 }),
          page.getByTestId('result-export-srt').click(),
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
      activeLauncher = undefined;

      await expect
        .poll(() => canConnect(previousDevHostPort), { timeout: 15_000, intervals: [250] })
        .toBe(false);
      await expect
        .poll(() => canConnect(previousPort), { timeout: 15_000, intervals: [250] })
        .toBe(false);

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
      for (const docId of [pdfDocId, imageDocId, audioDocId]) {
        const historyRow = page.locator(
          `[data-testid="history-row"][data-document-id="${docId}"]`,
        );
        await expect(historyRow).toBeVisible({ timeout: 15_000 });
        await expect(historyRow).toHaveAttribute('data-user-status', 'done');
      }

      // Restored PDF edit stays restored across restart
      await page.goto(`${launcher.baseUrl}/history/${pdfDocId}/content`);
      await waitForRuntimeReady(page);
      await expect(page.getByTestId('result-page-text')).toHaveValue(originalPdfPage1Text, {
        timeout: 15_000,
      });
      await expect(page.getByTestId('result-page-edited')).toHaveCount(0);

      // Un-restored ASR edit stays saved across restart
      await page.goto(`${launcher.baseUrl}/history/${audioDocId}/content`);
      await waitForRuntimeReady(page);
      const firstRowAfterRestart = page.locator(
        `[data-testid="result-transcript-row"][data-segment-id="${firstAsrSegmentId}"]`,
      );
      await expect(firstRowAfterRestart.getByTestId('result-line-text')).toContainText(
        asrEditMarker,
        { timeout: 15_000 },
      );
      await expect(firstRowAfterRestart.getByTestId('result-line-edited')).toBeVisible();

      evidence.restart = {
        oldPortsClosed: true,
        persistedDocumentCount: 3,
        featuresReadyWithoutReinstall: true,
      };
    });

    evidence.passed = true;
  } finally {
    if (activeLauncher) {
      const devHostPortToClose = activeLauncher.devHostPort;
      const proxyPortToClose = activeLauncher.port;
      await activeLauncher.stop();
      activeLauncher = undefined;
      await expect
        .poll(() => canConnect(devHostPortToClose), { timeout: 15_000, intervals: [250] })
        .toBe(false);
      await expect
        .poll(() => canConnect(proxyPortToClose), { timeout: 15_000, intervals: [250] })
        .toBe(false);
    }
    rmSync(exportTempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
});
